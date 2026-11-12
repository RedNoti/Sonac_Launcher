'use strict';

const { createHash, createPublicKey } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { createWriteStream, constants } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const os = require('node:os');
const { compareVersions, readManifest, sha256 } = require('./update-manifest');

const period = 60 * 60 * 1000;

const macInstaller = [
  'set -eu',
  'parent=$1; image=$2; bundle=$3; restart=$4; work=$5',
  'mount="$work/mount"; stage=""; mounted=0',
  'cleanup() {',
  '  if [ "$mounted" = 1 ]; then /usr/bin/hdiutil detach "$mount" >/dev/null 2>&1 || true; fi',
  '  if [ -n "$stage" ]; then',
  '    if [ ! -e "$bundle" ] && [ -e "$stage/backup.app" ]; then',
  '      /bin/mv "$stage/backup.app" "$bundle" || return',
  '    fi',
  '    /bin/rm -rf "$stage"',
  '  fi',
  '  /bin/rm -rf "$work"',
  '}',
  'trap cleanup EXIT',
  'for attempt in $(/usr/bin/jot 120); do if ! kill -0 "$parent" 2>/dev/null; then break; fi; sleep 1; done',
  'if kill -0 "$parent" 2>/dev/null; then exit 1; fi',
  '/bin/mkdir "$mount"',
  '/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$image" >/dev/null',
  'mounted=1',
  'incoming="$mount/sonac launcher.app"',
  '/usr/bin/codesign --verify --strict --deep "$incoming"',
  'stage=$(/usr/bin/mktemp -d "$(/usr/bin/dirname "$bundle")/.sonac-update.XXXXXX")',
  '/usr/bin/ditto "$incoming" "$stage/incoming.app"',
  '/bin/mv "$bundle" "$stage/backup.app"',
  '/bin/mv "$stage/incoming.app" "$bundle"',
  'if [ "$restart" = 1 ]; then /usr/bin/open -a "$bundle"; fi'
].join('\n');

const windowsInstaller = [
  'param([int]$ParentPid, [string]$Installer, [string]$Application, [int]$Restart, [string]$Work)',
  '$ErrorActionPreference = "Stop"',
  'try {',
  '  $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue',
  '  if ($parent) { $parent | Wait-Process -Timeout 120 }',
  '  $directory = Split-Path -Parent $Application',
  '  $setup = Start-Process -FilePath $Installer -ArgumentList ("/S /D=" + $directory) -Wait -PassThru',
  '  if ($setup.ExitCode -ne 0) { throw "Installer failed" }',
  '  if ($Restart -eq 1) { Start-Process -FilePath $Application }',
  '} finally {',
  '  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue',
  '}'
].join('\r\n');

async function request(baseURL, name, signal, timeout) {
  return fetch(new URL(name, baseURL), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    redirect: 'error', cache: 'no-store'
  });
}

async function download(baseURL, record, directory, signal) {
  const response = await request(baseURL, record.filename, signal, 60 * 60 * 1000);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('업데이트 설치 파일을 받을 수 없습니다.');
  }
  const filename = path.join(directory, record.filename);
  const hash = createHash('sha256');
  let size = 0;
  const validate = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > record.size) return callback(new Error('업데이트 파일 크기가 목록과 다릅니다.'));
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(response.body, validate, createWriteStream(filename, { flags: 'wx', mode: 0o600 }), { signal });
  if (size !== record.size || hash.digest('hex') !== record.sha256) {
    throw new Error('업데이트 설치 파일의 무결성을 확인할 수 없습니다.');
  }
  return filename;
}

function launch(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function createUpdater({ version, publicKey, baseURL, publish, executable = process.execPath }) {
  const target = process.platform === 'darwin' && process.arch === 'arm64' ? 'mac-arm64' :
    process.platform === 'win32' && process.arch === 'x64' ? 'win-x64' : null;
  const key = publicKey && baseURL && target ?
    createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }) : null;
  let timer;
  let checking;
  let available;
  let downloading;
  let ready;
  let stopped = false;
  const controller = new AbortController();

  function check() {
    if (!key || stopped || checking || downloading || ready) return;
    checking = (async () => {
      try {
        const response = await request(baseURL, 'latest-' + target + '.json', controller.signal, 15000);
        if (response.status === 404) {
          await response.body?.cancel();
          available = null;
          if (!stopped) publish(null);
          return;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('업데이트 목록을 확인할 수 없습니다.');
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 8192) throw new Error('업데이트 목록이 올바르지 않습니다.');
          chunks.push(Buffer.from(chunk));
        }
        const record = readManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')), target, key);
        if (stopped) return;
        available = compareVersions(record.version, version) > 0 ? record : null;
        publish(available ? { phase: 'available', version: available.version } : null);
      } catch {
        if (!stopped && !available) publish({ phase: 'error' });
      } finally {
        checking = null;
      }
    })();
  }

  async function prepare() {
    if (ready) return;
    if (checking) await checking;
    if (downloading) return downloading;
    if (stopped || !available) throw new Error('설치할 업데이트가 없습니다.');
    const record = available;
    downloading = (async () => {
      let directory;
      try {
        publish({ phase: 'downloading', version: record.version });
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-update-'));
        const filename = await download(baseURL, record, directory, controller.signal);
        controller.signal.throwIfAborted();
        ready = { directory, filename, record };
        publish({ phase: 'ready', version: record.version });
      } catch {
        if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        if (!stopped) publish({ phase: 'available', version: record.version });
        throw new Error('업데이트를 내려받거나 검증할 수 없습니다. 다시 시도하세요.');
      }
    })();
    try {
      await downloading;
    } finally {
      downloading = null;
    }
  }

  return {
    start() {
      if (!key) return;
      timer = setInterval(check, period);
      check();
    },
    check,
    prepare,
    async install(restart) {
      if (!ready) return;
      const { directory, filename, record } = ready;
      if (await sha256(filename) !== record.sha256) throw new Error('업데이트 설치 파일이 변경됐습니다.');
      const parent = String(process.pid);
      const relaunch = restart ? '1' : '0';
      if (target === 'mac-arm64') {
        const bundle = path.resolve(executable, '../../..');
        if (!bundle.endsWith('.app')) throw new Error('응용 프로그램 폴더에 설치한 앱에서 업데이트하세요.');
        await fs.access(path.dirname(bundle), constants.W_OK);
        const script = path.join(directory, 'install.sh');
        await fs.writeFile(script, macInstaller, { mode: 0o600 });
        await launch('/bin/sh', [script, parent, filename, bundle, relaunch, directory]);
      } else {
        const script = path.join(directory, 'install.ps1');
        await fs.writeFile(script, windowsInstaller, { mode: 0o600 });
        await launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
          script, parent, filename, executable, relaunch, directory]);
      }
      ready = null;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      controller.abort();
      if (ready) {
        const { directory } = ready;
        ready = null;
        void fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }
  };
}

module.exports = { createUpdater };
