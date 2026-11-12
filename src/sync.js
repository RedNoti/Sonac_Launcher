'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createWriteStream } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { childPath } = require('./storage');

const LAYOUT_FILE = 'sonac-launcher.config.json';
const LAYOUT_LIMIT = 65536;
const LINK_IDS = new Set(['dsm', 'drive', 'photos', 'containers', 'github', 'nas-git']);
const GROUPS = new Set(['synology', 'files', 'git']);

function webLink(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('바로가기 주소를 확인하세요.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('바로가기에는 http:// 또는 https:// 주소를 입력하세요.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('계정 정보가 없는 HTTP 또는 HTTPS 주소를 입력하세요.');
  }
  return url.href;
}

function cleanLayout(layout) {
  if (layout?.version !== 1 || !Array.isArray(layout.shortcuts) || layout.shortcuts.length > 30) {
    throw new Error('런처 구성 파일의 형식이 올바르지 않습니다.');
  }
  const links = {};
  for (const id of LINK_IDS) {
    if (layout.links?.[id]) links[id] = webLink(layout.links[id]);
  }
  const ids = new Set();
  const shortcuts = layout.shortcuts.map(item => {
    if (!item || !GROUPS.has(item.group) || !/^[a-z0-9-]{1,48}$/u.test(item.id) || ids.has(item.id) ||
        typeof item.name !== 'string' || !item.name.trim() || item.name.length > 40) {
      throw new Error('바로가기 이름 또는 그룹을 확인하세요.');
    }
    ids.add(item.id);
    return { id: item.id, group: item.group, name: item.name.trim(), url: webLink(item.url) };
  });
  return { version: 1, links, shortcuts };
}

async function readLayout(store, row, signal) {
  if (row.size > LAYOUT_LIMIT) throw new Error('런처 구성 파일이 너무 큽니다.');
  const response = await store.download(row.path, signal);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > LAYOUT_LIMIT) throw new Error('런처 구성 파일이 너무 큽니다.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return cleanLayout(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    throw new Error('클라우드의 런처 구성 파일을 읽을 수 없습니다.');
  }
}

function localName(name) {
  if (/[/\\\u0000-\u001f]/u.test(name) || name === '.' || name === '..') {
    throw new Error('이 PC에 저장할 수 없는 파일 이름입니다.');
  }
  if (process.platform === 'win32' &&
      (/[<>:"|?*]|[. ]$/u.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name))) {
    throw new Error('Windows에서 사용할 수 없는 파일 이름입니다.');
  }
  return name;
}

async function getStat(target) {
  return fs.lstat(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

async function safeDirectory(target) {
  const stat = await getStat(target);
  if (!stat) await fs.mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const current = stat || await fs.lstat(target);
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error('같은 이름의 로컬 파일 또는 심볼릭 링크가 있습니다.');
  }
}

async function downloadFile(store, row, destination, { signal, replace = false } = {}) {
  if (!replace && await getStat(destination)) return false;
  const folder = path.dirname(destination);
  const temp = path.join(folder, '.sonac-' + randomUUID() + '.part');
  const response = await store.download(row.path, signal);
  try {
    if (!response.body) throw new Error('서버가 파일 내용을 반환하지 않았습니다.');
    await pipeline(response.body, createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
    const received = (await fs.stat(temp)).size;
    if (Number.isSafeInteger(row.size) && received !== row.size) {
      throw new Error('다운로드한 크기가 파일 목록과 다릅니다. 새로고침 후 다시 시도하세요.');
    }
    signal?.throwIfAborted();
    if (replace) {
      await fs.rename(temp, destination);
    } else {
      try {
        await fs.link(temp, destination);
      } catch (error) {
        if (error.code === 'EEXIST') return false;
        if (['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM'].includes(error.code)) {
          try {
            await fs.copyFile(temp, destination, require('node:fs').constants.COPYFILE_EXCL);
          } catch (copyError) {
            if (copyError.code === 'EEXIST') return false;
            throw copyError;
          }
        } else {
          throw error;
        }
      }
    }
    return true;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function pullFiles(store, settings, { signal, progress, layout, file }) {
  const root = await fs.realpath(settings.local);
  const pending = [{ remote: settings.remote, local: root, root: true }];
  const counts = { downloaded: 0, skipped: 0, errors: 0, message: '' };

  function record(error, label) {
    if (signal?.aborted || [106, 107, 119].includes(error.dsmCode)) throw error;
    counts.errors++;
    counts.message ||= label + ' · ' + (error.code ? '로컬 파일에 접근할 수 없습니다. (' + error.code + ')' : error.message);
  }

  while (pending.length) {
    signal?.throwIfAborted();
    const folder = pending.pop();
    let entries;
    try {
      await safeDirectory(folder.local);
      entries = await store.list(folder.remote, signal);
    } catch (error) {
      if (folder.root) throw error;
      record(error, folder.remote);
      continue;
    }
    for (const row of entries) {
      signal?.throwIfAborted();
      try {
        if (row.path !== childPath(folder.remote, row.name)) throw new Error('파일 경로를 확인할 수 없습니다.');
        if (folder.root && row.name === LAYOUT_FILE && layout) {
          if (!row.directory) await layout(await readLayout(store, row, signal));
          continue;
        }
        const destination = path.join(folder.local, localName(row.name));
        if (row.directory) {
          pending.push({ remote: row.path, local: destination, root: false });
        } else {
          const downloaded = await downloadFile(store, row, destination, { signal });
          if (downloaded) counts.downloaded++;
          else counts.skipped++;
          if (file && (downloaded || (await getStat(destination))?.isFile())) {
            file(path.relative(root, destination).split(path.sep).join('/'));
          }
        }
      } catch (error) {
        record(error, row.name);
      }
      progress(counts);
    }
  }
  return counts;
}

async function scanMissing(store, settings, signal, file) {
  const root = await fs.realpath(settings.local);
  const folders = [{ remote: settings.remote, local: root, root: true }];
  const result = { pending: false, downloaded: 0, skipped: 0, errors: 0, message: '' };
  while (folders.length) {
    signal.throwIfAborted();
    const folder = folders.pop();
    for (const entry of await store.list(folder.remote, signal)) {
      signal.throwIfAborted();
      if (entry.path !== childPath(folder.remote, entry.name)) throw new Error('파일 경로를 확인할 수 없습니다.');
      if (folder.root && entry.name === LAYOUT_FILE) {
        if (entry.directory) continue;
        const layout = await readLayout(store, entry, signal);
        if (JSON.stringify(layout) !== JSON.stringify(cleanLayout(settings.layout))) return { ...result, pending: true };
        continue;
      }
      const destination = path.join(folder.local, localName(entry.name));
      const info = await getStat(destination);
      if (!info) return { ...result, pending: true };
      if (entry.directory) {
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('같은 이름의 로컬 파일 또는 심볼릭 링크가 있습니다.');
        folders.push({ remote: entry.path, local: destination, root: false });
      } else {
        result.skipped++;
        if (info.isFile()) file?.(path.relative(root, destination).split(path.sep).join('/'));
      }
    }
  }
  return result;
}

async function downloadSelection(store, entries, directory, signal) {
  const result = { downloaded: 0, skipped: 0, errors: 0, message: '' };
  for (const entry of entries) {
    signal.throwIfAborted();
    try {
      const destination = path.join(directory, localName(entry.name));
      if (!entry.directory) {
        if (await downloadFile(store, entry, destination, { signal })) result.downloaded++;
        else result.skipped++;
        continue;
      }
      await safeDirectory(destination);
      const nested = await pullFiles(store, { local: destination, remote: entry.path }, {
        signal, progress() {}, layout() {}
      });
      result.downloaded += nested.downloaded;
      result.skipped += nested.skipped;
      result.errors += nested.errors;
      result.message ||= nested.message;
    } catch (error) {
      signal.throwIfAborted();
      result.errors++;
      result.message ||= entry.name + ' · ' + (error.code ? '로컬 파일에 접근할 수 없습니다. (' + error.code + ')' : error.message);
    }
  }
  return result;
}

module.exports = { LAYOUT_FILE, cleanLayout, webLink, pullFiles, scanMissing, downloadFile, downloadSelection, getStat, safeDirectory };
