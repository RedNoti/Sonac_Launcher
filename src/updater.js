'use strict';

const { httpsFetch } = require('./transport');

const { createHash, createPublicKey } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { createWriteStream, constants } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const os = require('node:os');
const { compareVersions, installerName, readManifest, sha256, parseTag, releaseChannels } = require('./update-manifest');

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
  'team=$(/usr/bin/codesign -dv "$bundle" 2>&1 | /usr/bin/sed -n "s/^TeamIdentifier=//p")',
  'if [ -n "$team" ] && [ "$team" != "not set" ]; then',
  '  /usr/bin/codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \\"$team\\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists" "$incoming"',
  'fi',
  'stage=$(/usr/bin/mktemp -d "$(/usr/bin/dirname "$bundle")/.sonac-update.XXXXXX")',
  '/usr/bin/ditto "$incoming" "$stage/incoming.app"',
  '/bin/mv "$bundle" "$stage/backup.app"',
  '/bin/mv "$stage/incoming.app" "$bundle"',
  'if [ "$restart" = 1 ]; then /usr/bin/open -a "$bundle"; fi'
].join('\n');

const windowsInstaller = [
  'param([int]$ParentPid, [string]$Installer, [int]$Restart, [string]$Work, [string]$Logs, [string]$Expected)',
  '$ErrorActionPreference = "Stop"',
  '$result = Join-Path $Logs "install-result.txt"',
  '$msiLog = Join-Path $Logs "msi.log"',
  '$status = "helper"',
  '$installed = Join-Path $env:LOCALAPPDATA "Programs\\SonacLauncher\\sonac launcher.exe"',
  '$ready = Join-Path $Work "helper-ready"',
  'try {',
  '  $parent = Get-Process -Id $ParentPid',
  '  $null = $parent.Handle',
  '  if (!(Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "Downloaded MSI is missing." }',
  '  [Console]::WriteLine("Waiting for SONAC Launcher to exit (PID $ParentPid).")',
  '  Set-Content -LiteralPath $ready -Value "ready" -Encoding Ascii',
  '  if (!$parent.WaitForExit(120000)) { throw "SONAC Launcher did not exit within 120 seconds." }',
  '  [Console]::WriteLine("Starting Windows Installer for $Expected.")',
  "  $arguments = '/i \"{0}\" /passive /norestart /L*v \"{1}\"' -f $Installer, $msiLog",
  '  for ($attempt = 0; $attempt -lt 4; $attempt++) {',
  '    if ($attempt -gt 0) { Start-Sleep -Seconds 5 }',
  '    $setup = Start-Process -FilePath (Join-Path $env:SystemRoot "System32\\msiexec.exe") -WorkingDirectory $Logs -ArgumentList $arguments -PassThru',
  '    $setup.WaitForExit()',
  '    $status = [string]$setup.ExitCode',
  '    [Console]::WriteLine("Windows Installer exit code: $status")',
  '    if ($status -ne "1618") { break }',
  '  }',
  '  if ($status -eq "0") {',
  '    $marker = Join-Path (Split-Path -Parent $installed) "resources\\sonac-release.txt"',
  '    $actual = if (Test-Path -LiteralPath $marker -PathType Leaf) { (Get-Content -LiteralPath $marker -Raw).Trim() }',
  '    if (!(Test-Path -LiteralPath $installed -PathType Leaf) -or $actual -cne $Expected) {',
  '      $status = "version"',
  '      [Console]::WriteLine("Expected release: $Expected. Installed release: $actual")',
  '    }',
  '  }',
  '} catch {',
  '  $status = "helper"',
  '  [Console]::WriteLine($_.Exception.Message)',
  '} finally {',
  '  if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }',
  '}',
  'Set-Content -LiteralPath "$result.tmp" -Value $status -Encoding Ascii',
  'Move-Item -LiteralPath "$result.tmp" -Destination $result -Force',
  'if ($status -eq "0" -and $Restart -eq 1) {',
  '  try { Start-Process -FilePath $installed -WorkingDirectory (Split-Path -Parent $installed) } catch {',
  '    $status = "relaunch"',
  '    [Console]::WriteLine($_.Exception.Message)',
  '    Set-Content -LiteralPath $result -Value $status -Encoding Ascii',
  '  }',
  '}',
  'if ($status -ne "0") {',
  '  try {',
  '    $message = "SONAC Launcher update result: $status. See the update logs in $Logs."',
  '    $popup = New-Object -ComObject WScript.Shell',
  '    [void]$popup.Popup($message, 20, "SONAC Launcher", 48)',
  '  } catch { [Console]::WriteLine($_.Exception.Message) }',
  '}'
].join('\r\n');

async function windowsInstallNotice(dataDirectory) {
  const logs = path.join(dataDirectory, 'update-logs');
  const result = path.join(logs, 'install-result.txt');
  const code = (await fs.readFile(result, 'utf8').catch(() => '')).trim();
  if (!/^(?:helper|version|relaunch|\d{1,10})$/u.test(code)) return null;
  await fs.rm(result, { force: true });
  if (code === '0') return null;
  if (code === '3010' || code === '1641') return { title: 'Windows를 다시 시작해 주세요',
    message: 'Windows를 다시 시작하면 런처 업데이트 적용이 완료됩니다.' };
  if (code === 'version') return { title: '설치된 버전을 확인할 수 없습니다',
    message: 'GitHub 릴리스의 MSI를 내려받아 설치해 주세요.', detail: path.join(logs, 'helper.log') };
  if (code === 'relaunch') return { title: '런처를 다시 열 수 없습니다',
    message: '설치는 완료되었습니다. 시작 메뉴에서 런처를 열어 주세요.', detail: path.join(logs, 'helper.log') };
  return { title: '런처 업데이트를 적용하지 못했습니다',
    message: code === 'helper' ? 'Windows 설치 프로그램을 실행하지 못했습니다.' : 'Windows Installer 오류 코드 ' + code,
    detail: path.join(logs, code === 'helper' ? 'helper.log' : 'msi.log') };
}

const manifestName = target => 'latest-' + target + '.json';

function selectRelease(releases, version, channel, target) {
  const stage = releaseChannels.indexOf(channel);
  const eligible = [];
  let missingAssets = false;
  for (const release of releases) {
    const parsed = parseTag(release?.tag_name);
    if (!parsed || release.draft || parsed.channel === 'R' && release.prerelease) continue;
    const rank = releaseChannels.indexOf(parsed.channel);
    const order = compareVersions(parsed.version, version);
    if (rank < stage || order < 0 || order === 0 && rank === stage) continue;
    const assets = new Set(Array.isArray(release.assets) ?
      release.assets.filter(asset => asset?.state === 'uploaded').map(asset => asset.name) : []);
    if (!assets.has(manifestName(target)) || !assets.has(installerName(parsed.version, target))) {
      missingAssets = true;
      continue;
    }
    eligible.push(parsed);
  }
  eligible.sort((a, b) => compareVersions(b.version, a.version) ||
    releaseChannels.indexOf(b.channel) - releaseChannels.indexOf(a.channel));
  return { release: eligible[0], missingAssets };
}

async function releaseJSON(response, limit) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      const retryAfter = Number(response.headers.get('retry-after'));
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const retryAt = Math.max(retryAfter > 0 ? Date.now() + retryAfter * 1000 : 0,
        response.headers.get('x-ratelimit-remaining') === '0' ? reset : 0);
      throw Object.assign(new Error('GitHub 호출 한도를 초과했습니다.'), { code: 'SONAC_GITHUB_RATE_LIMIT', retryAt });
    }
    throw Object.assign(new Error('GitHub 업데이트 목록을 확인할 수 없습니다. (HTTP ' + response.status + ')'),
      { status: response.status });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('GitHub 업데이트 응답이 너무 큽니다.');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function listReleases(repository, signal, token) {
  const releases = [];
  const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    redirect: 'error', cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } };
  if (token) options.headers.Authorization = 'Bearer ' + token;
  for (let page = 1; page <= 5; page++) {
    const url = 'https://api.github.com/repos/' + repository + '/releases?per_page=50&page=' + page;
    const response = await httpsFetch(url, options);
    const rows = await releaseJSON(response, 4 * 1024 ** 2);
    if (!Array.isArray(rows)) throw new Error('GitHub 릴리스 목록을 읽을 수 없습니다.');
    releases.push(...rows);
    if (!response.headers.get('link')?.includes('rel="next"')) break;
  }
  return releases;
}

async function releaseAsset(repository, tag, name, signal, timeout) {
  if (!parseTag(tag)) throw new Error('GitHub 릴리스 태그를 확인할 수 없습니다.');
  const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]), redirect: 'manual', cache: 'no-store' };
  let url = new URL('/' + repository + '/releases/download/' + tag + '/' + name, 'https://github.com');
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await httpsFetch(url, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) break;
    url = new URL(location, url);
    const cdn = ['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com'].includes(url.origin);
    if (url.username || url.password || !cdn) break;
  }
  throw new Error('GitHub 릴리스 다운로드 주소를 확인할 수 없습니다.');
}

async function download(repository, tag, record, directory, signal, progress) {
  const response = await releaseAsset(repository, tag, record.filename, signal, 60 * 60 * 1000);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('업데이트 설치 파일을 받을 수 없습니다.');
  }
  const filename = path.join(directory, record.filename);
  const hash = createHash('sha256');
  let size = 0;
  let lastPercent = 0;
  const validate = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > record.size) return callback(new Error('업데이트 파일 크기가 목록과 다릅니다.'));
      hash.update(chunk);
      const percent = Math.min(99, Math.floor(size / record.size * 100));
      if (percent !== lastPercent) {
        lastPercent = percent;
        progress(percent);
      }
      callback(null, chunk);
    }
  });
  await pipeline(response.body, validate, createWriteStream(filename, { flags: 'wx', mode: 0o600 }), { signal });
  if (size !== record.size || hash.digest('hex') !== record.sha256) {
    throw new Error('업데이트 설치 파일의 무결성을 확인할 수 없습니다.');
  }
  return filename;
}

async function launch(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
}

async function launchWindowsHelper(script, args, logs, readyMarker) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const flags = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const argumentsLine = [...flags, '-File', ...[script, ...args].map(value => '"' + value + '"')].join(' ');
  const log = path.join(logs, 'helper.log');
  const errorLog = path.join(logs, 'helper-error.log');
  const startupLog = path.join(logs, 'helper-startup.log');
  // Start-Process lets the hidden helper outlive the Node process that starts it.
  const bootstrap = [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    '$helper = Start-Process -FilePath ' + quote(powershell) + ' -ArgumentList ' + quote(argumentsLine) +
      ' -WorkingDirectory ' + quote(logs) + ' -WindowStyle Hidden -PassThru' +
      ' -RedirectStandardOutput ' + quote(log) + ' -RedirectStandardError ' + quote(errorLog),
    '$deadline = [DateTime]::UtcNow.AddSeconds(10)',
    'while ([DateTime]::UtcNow -lt $deadline) {',
    '  if (Test-Path -LiteralPath ' + quote(readyMarker) + ' -PathType Leaf) { exit 0 }',
    '  if ($helper.HasExited) { break }',
    '  Start-Sleep -Milliseconds 100',
    '}',
    'if (!$helper.HasExited) { Stop-Process -InputObject $helper -ErrorAction SilentlyContinue }',
    'exit 1'
  ].join('\r\n');
  const output = await fs.open(startupLog, 'w');
  try {
    const child = spawn(powershell, [...flags, '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')],
      { cwd: logs, windowsHide: true, timeout: 15000, stdio: ['ignore', output.fd, output.fd] });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0) throw new Error('PowerShell startup exit code: ' + code);
  } catch (error) {
    await fs.rm(readyMarker, { force: true }).catch(() => {});
    throw new Error('Windows 설치 도우미가 시작되지 않았습니다. ' + log + '\n' + errorLog + '\n' + startupLog, { cause: error });
  } finally {
    await output.close().catch(() => {});
  }
}

async function discoverReleases(repository, signal, getToken) {
  const token = await getToken().catch(() => undefined);
  try {
    return await listReleases(repository, signal, token);
  } catch (error) {
    if (!token || ![401, 403, 404].includes(error.status)) throw error;
    return listReleases(repository, signal);
  }
}

function createUpdater({ version, channel = 'R', publicKey, repository, publish, getToken = async () => undefined,
  executable = process.execPath, dataDirectory }) {
  const target = process.platform === 'darwin' && process.arch === 'arm64' ? 'mac-arm64' :
    process.platform === 'win32' && process.arch === 'x64' ? 'win-x64' : null;
  const key = publicKey && /^[\w.-]+\/[\w.-]+$/u.test(repository || '') && target ?
    createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }) : null;
  let timer;
  let checking;
  let available;
  let downloading;
  let ready;
  let stopped = false;
  const controller = new AbortController();

  function check() {
    if (stopped || downloading || ready) return;
    if (checking) return checking;
    if (!key) {
      publish({ phase: 'unsupported' });
      return;
    }
    if (!available) publish({ phase: 'checking' });
    checking = (async () => {
      let issue = 'connection';
      try {
        const releases = await discoverReleases(repository, controller.signal, getToken);
        const { release, missingAssets } = selectRelease(releases, version, channel, target);
        if (!release) {
          available = null;
          if (!stopped) publish({ phase: missingAssets ? 'missing' : 'current' });
          return;
        }
        const response = await releaseAsset(repository, release.tag, manifestName(target), controller.signal, 15000);
        const data = await releaseJSON(response, 8192);
        issue = 'signature';
        const record = readManifest(data, target, key);
        // Alpha is the only channel with previously published manifests lacking a channel.
        if (record.version !== release.version || (record.channel ?? 'a') !== release.channel) {
          throw new Error('서명된 업데이트 버전 또는 채널이 GitHub 태그와 다릅니다.');
        }
        if (stopped) return;
        available = { record, tag: release.tag };
        publish({ phase: 'available', version: record.version, tag: release.tag });
      } catch (error) {
        if (!stopped && !available) {
          publish({ phase: 'error', issue: error.code === 'SONAC_GITHUB_RATE_LIMIT' ? 'rateLimit' : issue,
            retryAt: error.retryAt });
        }
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  async function prepare() {
    if (ready) return;
    if (checking) await checking;
    if (downloading) return downloading;
    if (stopped || !available) throw new Error('설치할 업데이트가 없습니다.');
    const { record, tag } = available;
    downloading = (async () => {
      let directory;
      try {
        const showProgress = percent => publish({ phase: 'downloading', version: record.version, tag, percent });
        showProgress(0);
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-update-'));
        const filename = await download(repository, tag, record, directory, controller.signal, showProgress);
        controller.signal.throwIfAborted();
        ready = { directory, filename, record };
        publish({ phase: 'ready', version: record.version, tag });
      } catch {
        if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        if (!stopped) publish({ phase: 'available', version: record.version, tag });
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
        const logs = path.join(dataDirectory, 'update-logs');
        await fs.mkdir(logs, { recursive: true });
        await fs.rm(path.join(logs, 'msi.log'), { force: true });
        await launchWindowsHelper(script, [parent, filename, relaunch, directory, logs, (record.channel ?? 'a') + record.version],
          logs, path.join(directory, 'helper-ready'));
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

module.exports = { createUpdater, discoverReleases, launchWindowsHelper, releaseAsset, selectRelease, windowsInstallNotice };
