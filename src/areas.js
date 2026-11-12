'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { unzipSync } = require('fflate/browser');
const { sha256 } = require('./update-manifest');
const { getStat, safeDirectory } = require('./sync');
const github = require('./github');

const maxZip = 64 * 1024 * 1024;
const maxExpanded = 256 * 1024 * 1024;
class RestoreError extends Error {}

function httpsLink(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('HTTPS 파일 주소를 입력하세요.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('HTTPS 파일 주소를 입력하세요.');
  }
  return url;
}

function fileName(name) {
  if (typeof name !== 'string' || !name || ['.', '..', '.git'].includes(name.toLowerCase()) ||
      /[<>:"/\\|?*\u0000-\u001f]|[. ]$/u.test(name) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name)) {
    throw new Error('저장할 수 없는 파일 이름이 있습니다.');
  }
  return name;
}

async function linkResponse(value, signal) {
  let url = httpsLink(value);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]);
  for (let redirect = 0; redirect < 6; redirect++) {
    const response = await fetch(url, { redirect: 'manual', cache: 'no-store', signal: timeout });
    if (response.ok && response.status === 200 && response.body) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      throw new Error('링크에서 파일을 받을 수 없습니다. (HTTP ' + response.status + ')');
    }
    url = httpsLink(new URL(location, url));
  }
  throw new Error('파일 주소의 리디렉션이 너무 많습니다.');
}

async function stageArchive(response, directory, signal) {
  const chunks = [];
  let size = 0;
  if (!response.body) throw new Error('GitHub 압축 파일을 받을 수 없습니다.');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxZip) throw new Error('GitHub 압축 파일은 64 MiB까지 받을 수 있습니다.');
    chunks.push(Buffer.from(chunk));
  }
  let expanded = 0;
  let root;
  const names = new Set();
  const entries = unzipSync(Buffer.concat(chunks, size), { filter(entry) {
    const [prefix, ...parts] = entry.name.split('/');
    root ??= prefix;
    if (!prefix || root !== prefix || !parts.length) throw new Error('GitHub 압축 파일의 경로가 올바르지 않습니다.');
    if (parts.at(-1) === '') {
      parts.pop();
      parts.forEach(fileName);
      return false;
    }
    const name = parts.map(fileName).join('/').normalize('NFC').toLowerCase();
    expanded += entry.originalSize;
    if (names.has(name) || names.size >= 10000 || expanded > maxExpanded) {
      throw new Error('압축 파일에 중복 경로가 있거나 풀 수 있는 용량을 초과했습니다.');
    }
    names.add(name);
    return true;
  } });
  const files = Object.entries(entries);
  if (!files.length) throw new Error('GitHub 압축 파일에 저장할 파일이 없습니다.');
  const plan = [];
  for (const [entry, bytes] of files) {
    signal.throwIfAborted();
    const staged = path.join(directory, 'file-' + plan.length);
    await fs.writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
    plan.push({ name: entry.slice(entry.indexOf('/') + 1), staged });
  }
  return plan;
}

async function destinationFor(root, name) {
  const parts = name.split('/');
  const leaf = parts.pop();
  let folder = root;
  for (const part of parts) {
    folder = path.join(folder, part);
    await safeDirectory(folder);
  }
  const destination = path.join(folder, leaf);
  const info = await getStat(destination);
  if (info && !info.isFile()) throw new Error('파일 위치에 같은 이름의 폴더 또는 링크가 있습니다. · ' + name);
  return { destination, info };
}

async function applyFiles(root, directory, plan, signal) {
  const changes = [];
  for (const item of plan) {
    signal.throwIfAborted();
    const { destination, info } = await destinationFor(root, item.name);
    if (info && info.size === (await fs.stat(item.staged)).size &&
        await sha256(destination) === await sha256(item.staged)) continue;
    changes.push({ ...item, destination, mode: info?.mode, backup: path.join(directory, 'backup-' + changes.length) });
  }

  const applied = [];
  try {
    for (const item of changes) {
      signal.throwIfAborted();
      const { info } = await destinationFor(root, item.name);
      if (item.mode !== undefined) await fs.chmod(item.staged, item.mode & 0o777);
      if (info) await fs.copyFile(item.destination, item.backup);
      await fs.rename(item.staged, item.destination);
      applied.push({ ...item, hadFile: !!info });
    }
  } catch (error) {
    let restoreFailed = false;
    for (const item of applied.reverse()) {
      try {
        await destinationFor(root, item.name);
        if (item.hadFile) await fs.rename(item.backup, item.destination);
        else await fs.rm(item.destination);
      } catch {
        restoreFailed = true;
      }
    }
    if (restoreFailed) throw new RestoreError('일부 파일을 복원할 수 없습니다. 백업 폴더를 확인하세요. · ' + directory, { cause: error });
    throw error;
  }
  return changes.length;
}

async function syncExternal(area, root, { token, signal }) {
  const directory = await fs.mkdtemp(path.join(root, '.sonac-stage-'));
  let keepBackup = false;
  try {
    let commit;
    let plan;
    if (area.source === 'github') {
      commit = await github.latestCommit(area.repository, area.branch, token, signal);
      const response = await github.archive(area.repository, commit.sha, token,
        AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]));
      plan = await stageArchive(response, directory, signal);
    } else {
      const response = await linkResponse(area.url, signal);
      const staged = path.join(directory, 'file-0');
      await pipeline(response.body, createWriteStream(staged, { flags: 'wx', mode: 0o600 }), { signal });
      plan = [{ name: area.filename, staged }];
    }
    const downloaded = await applyFiles(root, directory, plan, signal);
    return { files: plan.map(file => file.name), downloaded, skipped: plan.length - downloaded, errors: 0, commit };
  } catch (error) {
    keepBackup = error instanceof RestoreError;
    throw error;
  } finally {
    if (!keepBackup) await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { httpsLink, fileName, syncExternal };
