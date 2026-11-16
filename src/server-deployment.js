'use strict';

const { spawn, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { parseEnv, promisify, stripVTControlCharacters } = require('node:util');
const { unzipSync } = require('fflate');
const { httpsFetch } = require('./transport');

const zipLimit = 128 * 1024 ** 2;
const extractedLimit = 384 * 1024 ** 2;
const gitApi = 'https://api.github.com';
const cdns = new Set(['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com']);

function githubHeaders(url, accept, token) {
  const headers = { Accept: accept, 'User-Agent': 'sonac-launcher' };
  if (new URL(url).origin === gitApi && token) {
    headers.Authorization = 'Bearer ' + token;
  }
  return headers;
}

async function readBody(response, limit) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (response.status === 401) throw new Error('GitHub 토큰이 만료되었거나 올바르지 않습니다. 다시 연결하세요.');
    if (response.status === 403 || response.status === 404) {
      throw new Error('GitHub 릴리스를 읽을 수 없습니다. 토큰의 저장소 읽기 권한과 릴리스 주소를 확인하세요. (HTTP ' + response.status + ')');
    }
    throw new Error('GitHub에서 릴리스 파일을 읽을 수 없습니다. (HTTP ' + response.status + ')');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('GitHub 응답이 최대 크기를 초과했습니다.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function releaseAssets(source, signal, token = process.env.SONAC_RELEASE_GITHUB_TOKEN) {
  const [owner, repository, , kind, value, directName] = new URL(source).pathname.slice(1).replace(/\/$/u, '').split('/');
  const repo = gitApi + '/repos/' + owner + '/' + repository;
  const tag = ['tag', 'download'].includes(kind) ? decodeURIComponent(value) : null;
  const endpoint = tag ? '/releases/tags/' + encodeURIComponent(tag)
    : kind === 'latest' ? '/releases/latest' : '/releases?per_page=30';
  const options = { redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) };
  const url = repo + endpoint;
  const response = await httpsFetch(url, { ...options, headers: githubHeaders(url, 'application/vnd.github+json', token) });
  const result = JSON.parse(await readBody(response, 4 * 1024 ** 2));
  const releases = Array.isArray(result)
    ? result.filter(release => !release.draft).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    : [result];
  const name = kind === 'download' ? directName : value === 'download' ? directName : null;
  const assets = releases.flatMap(release => release.assets
    .filter(asset => asset.state === 'uploaded' && /\.zip$/iu.test(asset.name) &&
      (!name || asset.name === decodeURIComponent(name)))
    .map(asset => ({
      id: asset.id, name: asset.name, size: asset.size, tag: release.tag_name, digest: asset.digest,
      url: repo + '/releases/assets/' + asset.id
    })));
  if (!assets.length) throw new Error('GitHub 릴리스의 Assets에 배포용 ZIP 파일을 올려주세요.');
  return assets;
}

async function downloadAsset(asset, signal, token = process.env.SONAC_RELEASE_GITHUB_TOKEN) {
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > zipLimit) {
    throw new Error('배포 ZIP은 128 MiB 이하로 올려주세요.');
  }
  const options = { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]) };
  let url = new URL(asset.url);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await httpsFetch(url, { ...options, headers: githubHeaders(url, 'application/octet-stream', token) });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      const data = await readBody(response, asset.size);
      if (data.length !== asset.size || (asset.digest &&
          'sha256:' + createHash('sha256').update(data).digest('hex') !== asset.digest)) {
        throw new Error('배포 ZIP 검증에 실패했습니다.');
      }
      return data;
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) break;
    url = new URL(location, url);
    if (!cdns.has(url.origin) || url.username || url.password) break;
  }
  throw new Error('GitHub 릴리스 다운로드 주소를 확인할 수 없습니다.');
}

async function extractZip(bytes, directory, signal) {
  const paths = new Set();
  let bytesExpected = 0;
  const files = unzipSync(bytes, { filter({ name, size, originalSize, compression }) {
    const parts = name.replace(/\/$/u, '').split('/');
    if (name.length > 4096 || parts.some(part => !part || part === '.' || part === '..' ||
        /^[. ]*$/u.test(part) || /[. ]$/u.test(part) || /[<>:"\\|?*\x00-\x1f]/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part) || part === '__proto__')) {
      throw new Error('ZIP에 사용할 수 없는 파일 경로가 있습니다.');
    }
    const key = parts.join('/').normalize('NFC').toLowerCase();
    if (paths.has(key)) throw new Error('ZIP에 중복된 파일 경로가 있습니다.');
    paths.add(key);
    bytesExpected += compression === 0 ? size : originalSize;
    if (paths.size > 20000 || bytesExpected > extractedLimit) throw new Error('ZIP 압축 해제 크기 한도를 초과했습니다.');
    return !name.endsWith('/');
  } });
  if (!Object.keys(files).length) throw new Error('ZIP에 배포 파일이 없습니다.');
  for (const [name, data] of Object.entries(files)) {
    signal.throwIfAborted();
    const target = path.join(directory, ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 });
  }
}

async function deploymentFolder(directory) {
  const items = await fs.readdir(directory, { withFileTypes: true });
  const roots = items.filter(item => !['__MACOSX', '.DS_Store'].includes(item.name));
  return roots.length === 1 && roots[0].isDirectory() ? path.join(directory, roots[0].name) : directory;
}

async function launchSpec(directory) {
  const windows = process.platform === 'win32';
  const cwd = await deploymentFolder(directory);
  const items = await fs.readdir(cwd, { withFileTypes: true });
  const names = new Set(items.filter(item => item.isFile()).map(item => item.name));
  const shell = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh';
  const script = windows ? 'start.cmd' : 'start.sh';
  if (names.has(script)) {
    return { cwd, command: shell, args: windows ? ['/d', '/c', script] : [script] };
  }
  if (names.has('package.json')) {
    const { scripts } = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    if (typeof scripts?.start === 'string' && scripts.start.trim()) {
      return { cwd, command: windows ? shell : 'npm', args: windows ? ['/d', '/c', 'npm.cmd', 'start'] : ['start'] };
    }
  }
  const entry = ['server.cjs', 'server.js', 'server.mjs'].find(name => names.has(name));
  if (entry) return { cwd, command: 'node', args: [entry] };
  throw new Error('ZIP에 ' + script + ', package.json의 start 스크립트 또는 server.cjs/server.js/server.mjs를 넣어주세요.');
}

async function startProcess({ cwd, command, args }, dataDirectory, runtime, onExit) {
  const config = await fs.readFile(path.join(dataDirectory, '.env'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|programfiles(?:\(x86\))?|programdata|lang|lc_\w+)$/iu.test(name)));
  const child = spawn(command, args, { cwd, env: { ...env, ...parseEnv(config), SONAC_DATA_DIR: dataDirectory },
    detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  runtime.child = child;
  const append = text => appendLog(runtime, text);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', append);
  }
  return new Promise((resolve, reject) => {
    let startup;
    child.once('spawn', () => {
      append('\n[런처] 프로세스 시작\n');
      startup = setTimeout(resolve, 850);
    });
    child.once('error', error => {
      append('\n[런처] ' + error.message + '\n');
      if (!child.pid) reject(new Error('서버 실행에 실패했습니다. Node.js 또는 시작 스크립트를 확인하세요.'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(startup);
      append('\n[런처] 프로세스 종료 (' + (signal ?? code ?? '알 수 없음') + ')\n');
      if (runtime.child === child) runtime.child = null;
      reject(new Error('서버가 시작 직후 종료되었습니다. 로그를 확인하세요.'));
      onExit(code, signal);
    });
  });
}

function appendLog(runtime, text) {
  runtime.log = (runtime.log + stripVTControlCharacters(text)).slice(-96000);
}

async function stopProcess(runtime) {
  const child = runtime.child;
  if (!child?.pid) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    await promisify(execFile)(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 8000 })
      .catch(error => { if (runtime.child === child && child.exitCode === null) throw error; });
  } else {
    const kill = signal => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    kill('SIGTERM');
    await Promise.race([closed, delay(2500, undefined, { ref: false })]);
    kill('SIGKILL');
  }
  await Promise.race([closed, delay(4000, undefined, { ref: false })]);
  if (runtime.child === child) throw new Error('서버 프로세스 종료를 확인할 수 없습니다.');
}

module.exports = { releaseAssets, downloadAsset, extractZip, deploymentFolder, launchSpec, startProcess, stopProcess, appendLog };
