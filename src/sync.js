'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { childPath, networkFailure } = require('./storage');
const { manifestName, safeName, readSignedFiles } = require('./nas-integrity');
const { sha256 } = require('./update-manifest');

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
  const bytes = Buffer.concat(chunks, size);
  if (bytes.length !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
    throw new Error('NAS의 런처 구성 파일이 서명 목록과 다릅니다.');
  }
  try {
    return cleanLayout(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new Error('클라우드의 런처 구성 파일을 읽을 수 없습니다.');
  }
}

function localName(name) {
  return safeName(name);
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

async function guardedFolder(root, folder, create = false) {
  if (await fs.realpath(root) !== root || !(await fs.lstat(root)).isDirectory()) {
    throw new Error('저장 폴더의 경로가 바뀌었습니다. 다시 선택하세요.');
  }
  const relative = path.relative(root, folder);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    throw new Error('저장 폴더 외부에는 파일을 쓸 수 없습니다.');
  }
  let parent = root;
  for (const part of relative ? relative.split(path.sep) : []) {
    parent = path.join(parent, localName(part));
    if (create) await safeDirectory(parent);
    const info = await getStat(parent);
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (await fs.realpath(parent)).normalize('NFC') !== parent.normalize('NFC')) {
      throw new Error('저장 경로에 심볼릭 링크 또는 다른 위치를 가리키는 폴더가 있습니다.');
    }
  }
  return true;
}

async function downloadFile(store, row, destination, { signal, replace = false, root, transfer } = {}) {
  const folder = path.dirname(destination);
  if (root && !await guardedFolder(root, folder)) throw new Error('저장 폴더를 찾을 수 없습니다.');
  const existing = await getStat(destination);
  if (existing && !existing.isFile()) throw new Error('저장 위치에 같은 이름의 폴더 또는 링크가 있습니다.');
  if (existing && !replace) {
    if (row.sha256 && (existing.size !== row.size || await sha256(destination) !== row.sha256)) {
      throw new Error('기존 로컬 파일이 NAS 서명 목록과 다릅니다. 기존 파일을 보존했습니다.');
    }
    return false;
  }
  const temp = path.join(folder, '.sonac-' + randomUUID() + '.part');
  const response = await store.download(row.path, signal);
  try {
    if (!response.body) throw new Error('서버가 파일 내용을 반환하지 않았습니다.');
    if (root && !await guardedFolder(root, folder)) throw new Error('저장 폴더를 찾을 수 없습니다.');
    const knownSize = Number.isSafeInteger(row.size) && row.size >= 0;
    const unsignedLimit = 64 * 1024 ** 3;
    const limit = row.sha256 ? row.size : knownSize ? Math.min(row.size, unsignedLimit) : unsignedLimit;
    const hash = row.sha256 ? createHash('sha256') : null;
    let received = 0;
    const total = knownSize ? row.size : null;
    transfer?.(row.name, received, total);
    const validate = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > limit) return callback(new Error('다운로드가 예상 파일 크기를 초과했습니다.'));
        hash?.update(chunk);
        transfer?.(row.name, received, total);
        callback(null, chunk);
      }
    });
    await pipeline(response.body, validate, createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
    if (knownSize && received !== row.size) {
      throw new Error('다운로드한 크기가 파일 목록과 다릅니다. 새로고침 후 다시 시도하세요.');
    }
    if (hash && hash.digest('hex') !== row.sha256) throw new Error('NAS 파일의 SHA-256이 서명 목록과 다릅니다.');
    signal?.throwIfAborted();
    if (root && !await guardedFolder(root, folder)) throw new Error('저장 폴더를 찾을 수 없습니다.');
    if (replace) {
      await fs.rename(temp, destination);
    } else {
      try {
        await fs.link(temp, destination);
      } catch (error) {
        if (error.code === 'EEXIST') return false;
        if (!row.sha256 && ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM'].includes(error.code)) {
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
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
    await fs.rm(temp, { force: true });
  }
}

async function signedSync(store, settings, { signal, file, layout, scan = false }) {
  const root = path.resolve(settings.local);
  await guardedFolder(root, root);
  const record = await readSignedFiles(store, settings.remote, settings.integrityKey, settings.integrityRevision, signal);
  settings.integrityRevision = { createdAt: record.createdAt, signature: record.signature };
  const counts = { pending: false, downloaded: 0, skipped: 0, errors: 0, message: '' };
  const remote = settings.remote.replace(/\/$/u, '');
  for (const item of record.files) {
    signal.throwIfAborted();
    const row = { ...item, path: remote + '/' + item.name };
    if (item.name === LAYOUT_FILE && layout) {
      const value = await readLayout(store, row, signal);
      if (scan && JSON.stringify(value) !== JSON.stringify(cleanLayout(settings.layout))) counts.pending = true;
      if (!scan) await layout(value);
      continue;
    }
    const destination = path.join(root, ...item.name.split('/'));
    const present = await guardedFolder(root, path.dirname(destination), !scan);
    if (scan) {
      const info = present && await getStat(destination);
      if (!info) {
        counts.pending = true;
        continue;
      }
      if (!info.isFile() || info.size !== row.size || await sha256(destination) !== row.sha256) {
        counts.errors++;
        counts.message ||= '기존 로컬 파일이 NAS 서명 목록과 다릅니다. · ' + item.name;
        continue;
      }
      counts.skipped++;
    } else {
      try {
        if (await downloadFile(store, row, destination, { signal, root })) counts.downloaded++;
        else counts.skipped++;
      } catch (error) {
        if (signal.aborted || networkFailure(error) || [106, 107, 119].includes(error.dsmCode)) throw error;
        counts.errors++;
        counts.message ||= error.message + ' · ' + item.name;
        continue;
      }
    }
    file?.(item.name);
  }
  return counts;
}

async function pullFiles(store, settings, { signal, progress, layout, file, transfer }) {
  if (settings.integrityKey) return signedSync(store, settings, { signal, file, layout });
  const root = path.resolve(settings.local);
  await guardedFolder(root, root);
  const pending = [{ remote: settings.remote, local: root, depth: 0 }];
  const counts = { downloaded: 0, skipped: 0, errors: 0, message: '' };
  let visited = 0;

  function record(error, label) {
    if (signal?.aborted || networkFailure(error) || [106, 107, 119].includes(error.dsmCode)) throw error;
    counts.errors++;
    counts.message ||= label + ' · ' + (error.code ? '로컬 파일에 접근할 수 없습니다. (' + error.code + ')' : error.message);
  }

  while (pending.length) {
    signal?.throwIfAborted();
    const folder = pending.pop();
    let entries;
    try {
      await guardedFolder(root, folder.local, true);
      entries = await store.list(folder.remote, signal);
    } catch (error) {
      if (folder.depth === 0) throw error;
      record(error, folder.remote);
      continue;
    }
    for (const row of entries) {
      signal?.throwIfAborted();
      if (++visited > 50000) throw new Error('동기화할 폴더에 항목이 너무 많습니다.');
      try {
        if (row.path !== childPath(folder.remote, row.name)) throw new Error('파일 경로를 확인할 수 없습니다.');
        if (row.name.toLowerCase() === manifestName || folder.depth === 0 && row.name === LAYOUT_FILE) continue;
        const destination = path.join(folder.local, localName(row.name));
        if (row.directory) {
          if (folder.depth >= 39) throw new Error('동기화 폴더의 깊이가 너무 큽니다.');
          pending.push({ remote: row.path, local: destination, depth: folder.depth + 1 });
        } else {
          const downloaded = await downloadFile(store, row, destination, { signal, root, transfer });
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
  if (settings.integrityKey) return signedSync(store, settings, { signal, file, scan: true, layout() {} });
  const root = path.resolve(settings.local);
  await guardedFolder(root, root);
  const folders = [{ remote: settings.remote, local: root, depth: 0 }];
  const result = { pending: false, downloaded: 0, skipped: 0, errors: 0, message: '' };
  let visited = 0;
  while (folders.length) {
    signal.throwIfAborted();
    const folder = folders.pop();
    await guardedFolder(root, folder.local);
    for (const entry of await store.list(folder.remote, signal)) {
      signal.throwIfAborted();
      if (++visited > 50000) throw new Error('동기화할 폴더에 항목이 너무 많습니다.');
      if (entry.path !== childPath(folder.remote, entry.name)) throw new Error('파일 경로를 확인할 수 없습니다.');
      if (entry.name.toLowerCase() === manifestName || folder.depth === 0 && entry.name === LAYOUT_FILE) continue;
      const destination = path.join(folder.local, localName(entry.name));
      const info = await getStat(destination);
      if (!info) return { ...result, pending: true };
      if (entry.directory) {
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('같은 이름의 로컬 파일 또는 심볼릭 링크가 있습니다.');
        if (folder.depth >= 39) throw new Error('동기화 폴더의 깊이가 너무 큽니다.');
        folders.push({ remote: entry.path, local: destination, depth: folder.depth + 1 });
      } else {
        if (!info.isFile()) throw new Error('저장 위치에 같은 이름의 폴더 또는 링크가 있습니다.');
        result.skipped++;
        if (info.isFile()) file?.(path.relative(root, destination).split(path.sep).join('/'));
      }
    }
  }
  return result;
}

async function downloadSelection(store, entries, directory, signal, transfer) {
  const result = { downloaded: 0, skipped: 0, errors: 0, message: '' };
  for (const entry of entries) {
    signal.throwIfAborted();
    try {
      const destination = path.join(directory, localName(entry.name));
      if (!entry.directory) {
        if (await downloadFile(store, entry, destination, { signal, root: directory, transfer })) result.downloaded++;
        else result.skipped++;
        continue;
      }
      await safeDirectory(destination);
      const nested = await pullFiles(store, { local: destination, remote: entry.path }, {
        signal, progress() {}, layout() {}, transfer
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

module.exports = { LAYOUT_FILE, cleanLayout, webLink, pullFiles, scanMissing, downloadFile, downloadSelection,
  getStat, guardedFolder };
