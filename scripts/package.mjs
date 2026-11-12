import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = require('../package.json');
const electronVersion = require('electron/package.json').version;
const checksums = require('electron/checksums.json');
const { manifestBytes, sha256 } = require('../src/update-manifest');
const [target, requestedArch] = process.argv.slice(2);
const arch = requestedArch || (target === 'win' ? 'x64' : process.arch);
const appName = manifest.productName;
const appId = 'kr.sonac.launcher';

if (!['mac', 'win'].includes(target) || !['arm64', 'x64'].includes(arch) ||
    (target === 'win' && arch !== 'x64') || (target === 'mac' && process.platform !== 'darwin')) {
  throw new Error('사용법: node scripts/package.mjs mac [arm64|x64] 또는 win [x64]');
}

const dist = path.join(root, 'dist');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-package-'));
const installerPrefix = manifest.name + '-';
const installerSuffix = target === 'mac' ? '-mac-' + arch + '.dmg' : '-win-x64-setup.exe';
const installerName = installerPrefix + manifest.version + installerSuffix;
const releaseVersion = /^\d+\.\d+\.\d+$/u;
const updateTarget = target === 'mac' && arch !== 'arm64' ? null : target + '-' + arch;

function command(executable, args, opts = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', encoding: 'utf8', ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(executable + ' failed (' + result.status + ')');
  return result.stdout?.trim();
}

async function electronZip() {
  const platform = target === 'mac' ? 'darwin' : 'win32';
  const name = ['electron', 'v' + electronVersion, platform, arch].join('-') + '.zip';
  let filename = process.env.SONAC_ELECTRON_ZIP;
  if (!filename) {
    filename = path.join(work, name);
    command('curl', ['-fL', '--retry', '2', '-o', filename,
      'https://github.com/electron/electron/releases/download/v' + electronVersion + '/' + name]);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  if (hash.digest('hex') !== checksums[name]) throw new Error('Electron 런타임 SHA-256 검증에 실패했습니다.');
  return path.resolve(filename);
}

async function releaseKey() {
  const filename = path.join(root, '.sonac-update-key.pem');
  try {
    return createPrivateKey(await fs.readFile(filename));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const directory = await fs.mkdtemp(path.join(root, '.sonac-key-'));
  try {
    const candidate = path.join(directory, 'key.pem');
    await fs.writeFile(candidate, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    await fs.link(candidate, filename).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    return createPrivateKey(await fs.readFile(filename));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function updateFeed() {
  const configured = process.env.SONAC_UPDATE_URL ?? await fs.readFile(path.join(root, '.sonac-update-url'), 'utf8')
    .catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
  if (!configured.trim()) return undefined;
  const url = new URL(configured.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('업데이트 서버에는 계정 정보가 없는 HTTPS 폴더 주소를 사용하세요.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

async function applicationArchive(key, updateURL) {
  const source = path.join(work, 'source');
  await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(source, 'src'), { recursive: true });
  await fs.rm(path.join(source, 'src', 'ui', 'app.ico'));
  for (const name of ['saxes', 'xmlchars']) {
    await fs.cp(path.join(root, 'node_modules', name), path.join(source, 'node_modules', name), { recursive: true });
  }
  const vendor = path.join(source, 'node_modules');
  const pdfTarget = path.join(vendor, 'pdfjs-dist');
  await fs.mkdir(path.join(pdfTarget, 'build'), { recursive: true });
  for (const filename of ['LICENSE', 'build/pdf.min.mjs', 'build/pdf.worker.min.mjs']) {
    await fs.copyFile(path.join(root, 'node_modules', 'pdfjs-dist', filename), path.join(pdfTarget, filename));
  }
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    await fs.cp(path.join(root, 'node_modules', 'pdfjs-dist', directory), path.join(pdfTarget, directory), { recursive: true });
  }
  for (const [name, files] of [
    ['fflate', ['LICENSE', 'package.json', 'lib/browser.cjs', 'esm/browser.js']],
    ['@xterm/xterm', ['LICENSE', 'lib/xterm.mjs', 'css/xterm.css']],
    ['@xterm/addon-fit', ['LICENSE', 'lib/addon-fit.mjs']]
  ]) {
    for (const filename of files) {
      const destination = path.join(vendor, name, filename);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(root, 'node_modules', name, filename), destination);
    }
  }
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: manifest.name, productName: appName, version: manifest.version, main: manifest.main, updateURL,
    updatePublicKey: key ? createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') : undefined
  }));
  const filename = path.join(work, 'app.asar');
  await asar.createPackage(source, filename);
  return filename;
}

function plist(file, key, value) {
  command('/usr/bin/plutil', ['-replace', key, '-string', value, file]);
}

async function stageTerminal(resources) {
  const source = path.join(root, 'node_modules', 'node-pty');
  const destination = path.join(resources, 'node_modules', 'node-pty');
  const platform = (target === 'mac' ? 'darwin-' : 'win32-') + arch;
  const native = path.join(destination, 'prebuilds', platform);
  await fs.mkdir(native, { recursive: true });
  for (const file of ['package.json', 'LICENSE', 'lib']) {
    await fs.cp(path.join(source, file), path.join(destination, file), { recursive: true });
  }
  await fs.cp(path.join(source, 'prebuilds', platform), native, {
    recursive: true, filter: entry => !entry.endsWith('.pdb')
  });
  if (target === 'mac') {
    const helper = path.join(native, 'spawn-helper');
    await fs.chmod(helper, 0o755);
    for (const binary of [helper, path.join(native, 'pty.node')]) {
      command('/usr/bin/codesign', ['--force', '--sign', '-', binary]);
    }
  }
}

async function packageMac(extracted, archive, output) {
  const stage = path.join(work, 'image');
  await fs.mkdir(stage);
  const bundle = path.join(stage, appName + '.app');
  await fs.rename(path.join(extracted, 'Electron.app'), bundle);
  const contents = path.join(bundle, 'Contents');
  const resources = path.join(contents, 'Resources');
  const info = path.join(contents, 'Info.plist');
  plist(info, 'CFBundleIdentifier', appId);
  plist(info, 'CFBundleName', appName);
  plist(info, 'CFBundleDisplayName', appName);
  plist(info, 'CFBundleExecutable', appName);
  plist(info, 'CFBundleShortVersionString', manifest.version);
  plist(info, 'CFBundleVersion', manifest.version);
  await fs.rename(path.join(contents, 'MacOS', 'Electron'), path.join(contents, 'MacOS', appName));
  const frameworks = path.join(contents, 'Frameworks');
  for (const name of await fs.readdir(frameworks)) {
    if (!/^Electron Helper.*\.app$/u.test(name)) continue;
    const executable = name.slice(0, -4);
    const renamed = appName + executable.slice('Electron'.length);
    const helper = path.join(frameworks, name, 'Contents');
    const helperInfo = path.join(helper, 'Info.plist');
    const role = /\(([^)]+)\)/u.exec(name)?.[1].toLowerCase();
    plist(helperInfo, 'CFBundleIdentifier', appId + '.helper' + (role ? '.' + role : ''));
    plist(helperInfo, 'CFBundleExecutable', renamed);
    plist(helperInfo, 'CFBundleDisplayName', renamed);
    plist(helperInfo, 'CFBundleName', renamed);
    await fs.rename(path.join(helper, 'MacOS', executable), path.join(helper, 'MacOS', renamed));
    await fs.rename(path.join(frameworks, name), path.join(frameworks, renamed + '.app'));
  }
  await fs.copyFile(archive, path.join(resources, 'app.asar'));
  await stageTerminal(resources);
  await fs.rm(path.join(resources, 'default_app.asar'), { force: true });
  command('/usr/bin/sips', ['-s', 'format', 'icns', path.join(root, 'src', 'ui', 'app.png'),
    '--out', path.join(resources, 'electron.icns')]);
  command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  await fs.symlink('/Applications', path.join(stage, 'Applications'));
  command('/usr/bin/hdiutil', ['create', '-ov', '-volname', appName, '-srcfolder', stage, '-format', 'UDZO', output]);
  command('/usr/bin/hdiutil', ['verify', output]);
}

async function uninstallEntries(directory, prefix = '') {
  const lines = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = prefix + '\\' + entry.name;
    if (/["$\r\n]/u.test(filename)) throw new Error('NSIS 파일 경로가 올바르지 않습니다.');
    if (entry.isDirectory()) {
      lines.push(...await uninstallEntries(path.join(directory, entry.name), filename));
      lines.push('RMDir "$INSTDIR' + filename + '"');
    } else {
      lines.push('Delete "$INSTDIR' + filename + '"');
    }
  }
  return lines;
}

async function packageWindows(extracted, archive, output) {
  const resources = path.join(extracted, 'resources');
  await fs.copyFile(archive, path.join(resources, 'app.asar'));
  await stageTerminal(resources);
  await fs.rm(path.join(resources, 'default_app.asar'), { force: true });
  await fs.rename(path.join(extracted, 'electron.exe'), path.join(extracted, appName + '.exe'));
  const icon = path.join(root, 'src', 'ui', 'app.ico');
  await fs.copyFile(icon, path.join(extracted, 'SonacLauncher.ico'));
  const uninstall = path.join(work, 'uninstall.nsh');
  await fs.writeFile(uninstall, (await uninstallEntries(extracted)).join('\n') + '\n');
  const define = process.platform === 'win32' ? '/D' : '-D';
  command(process.env.MAKENSIS || 'makensis', [
    define + 'SOURCE=' + extracted, define + 'OUTPUT=' + output, define + 'APPICON=' + icon,
    define + 'APPVERSION=' + manifest.version, define + 'UNINSTALL_FILES=' + uninstall,
    path.join(root, 'scripts', 'installer.nsi')
  ]);
}

async function retainLatestInstaller() {
  if (!releaseVersion.test(manifest.version)) return path.join(dist, installerName);
  const installers = (await fs.readdir(dist, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.startsWith(installerPrefix) &&
      entry.name.endsWith(installerSuffix) &&
      releaseVersion.test(entry.name.slice(installerPrefix.length, -installerSuffix.length)))
    .map(entry => entry.name)
    .sort((first, second) => second.localeCompare(first, 'en', { numeric: true }));
  const [latest, ...previous] = installers;
  for (const filename of previous) await fs.rm(path.join(dist, filename), { force: true });
  return path.join(dist, latest || installerName);
}

async function publishUpdate(installer, key, staging) {
  const record = {
    version: manifest.version, target: updateTarget, filename: installerName,
    size: (await fs.stat(installer)).size, sha256: await sha256(installer)
  };
  const signature = sign(null, manifestBytes(record), key).toString('base64');
  const name = 'latest-' + updateTarget + '.json';
  const filename = path.join(staging, name);
  await fs.writeFile(filename, JSON.stringify({ ...record, signature }, null, 2) + '\n');
  await fs.rename(filename, path.join(dist, name));
}

let staging;
try {
  await fs.mkdir(dist, { recursive: true });
  const zip = await electronZip();
  const extracted = path.join(work, 'runtime');
  await fs.mkdir(extracted);
  if (target === 'mac') command('/usr/bin/ditto', ['-x', '-k', zip, extracted]);
  else if (process.platform === 'win32') command('tar', ['-xf', zip, '-C', extracted]);
  else command('unzip', ['-q', zip, '-d', extracted]);
  const updateURL = updateTarget && releaseVersion.test(manifest.version) ? await updateFeed() : undefined;
  const key = updateURL ? await releaseKey() : null;
  const archive = await applicationArchive(key, updateURL);
  staging = await fs.mkdtemp(path.join(dist, '.package-'));
  const output = path.join(staging, installerName);
  if (target === 'mac') await packageMac(extracted, archive, output);
  else await packageWindows(extracted, archive, output);
  const installer = path.join(dist, installerName);
  await fs.rename(output, installer);
  const latest = await retainLatestInstaller();
  if (updateTarget && latest === installer) {
    if (key) await publishUpdate(installer, key, staging);
    else await fs.rm(path.join(dist, 'latest-' + updateTarget + '.json'), { force: true });
  }
  console.log(latest);
} finally {
  if (staging) await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
}
