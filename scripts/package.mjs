import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

async function applicationArchive() {
  const source = path.join(work, 'source');
  await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(source, 'src'), { recursive: true });
  await fs.rm(path.join(source, 'src', 'ui', 'app.ico'));
  for (const name of ['saxes', 'xmlchars']) {
    await fs.cp(path.join(root, 'node_modules', name), path.join(source, 'node_modules', name), { recursive: true });
  }
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: manifest.name, productName: appName, version: manifest.version, main: manifest.main
  }));
  const filename = path.join(work, 'app.asar');
  await asar.createPackage(source, filename);
  return filename;
}

function plist(file, key, value) {
  command('/usr/bin/plutil', ['-replace', key, '-string', value, file]);
}

async function packageMac(extracted, archive) {
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
  await fs.rm(path.join(resources, 'default_app.asar'), { force: true });
  command('/usr/bin/sips', ['-s', 'format', 'icns', path.join(root, 'src', 'ui', 'app.png'),
    '--out', path.join(resources, 'electron.icns')]);
  command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  await fs.symlink('/Applications', path.join(stage, 'Applications'));
  const output = path.join(dist, manifest.name + '-' + manifest.version + '-mac-' + arch + '.dmg');
  command('/usr/bin/hdiutil', ['create', '-ov', '-volname', appName, '-srcfolder', stage, '-format', 'UDZO', output]);
  command('/usr/bin/hdiutil', ['verify', output]);
  return output;
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

async function packageWindows(extracted, archive) {
  const resources = path.join(extracted, 'resources');
  await fs.copyFile(archive, path.join(resources, 'app.asar'));
  await fs.rm(path.join(resources, 'default_app.asar'), { force: true });
  await fs.rename(path.join(extracted, 'electron.exe'), path.join(extracted, appName + '.exe'));
  const icon = path.join(root, 'src', 'ui', 'app.ico');
  await fs.copyFile(icon, path.join(extracted, 'SonacLauncher.ico'));
  const uninstall = path.join(work, 'uninstall.nsh');
  await fs.writeFile(uninstall, (await uninstallEntries(extracted)).join('\n') + '\n');
  const output = path.join(dist, manifest.name + '-' + manifest.version + '-win-x64-setup.exe');
  const define = process.platform === 'win32' ? '/D' : '-D';
  command(process.env.MAKENSIS || 'makensis', [
    define + 'SOURCE=' + extracted, define + 'OUTPUT=' + output, define + 'APPICON=' + icon,
    define + 'APPVERSION=' + manifest.version, define + 'UNINSTALL_FILES=' + uninstall,
    path.join(root, 'scripts', 'installer.nsi')
  ]);
  return output;
}

try {
  await fs.mkdir(dist, { recursive: true });
  const zip = await electronZip();
  const extracted = path.join(work, 'runtime');
  await fs.mkdir(extracted);
  if (target === 'mac') command('/usr/bin/ditto', ['-x', '-k', zip, extracted]);
  else if (process.platform === 'win32') command('tar', ['-xf', zip, '-C', extracted]);
  else command('unzip', ['-q', zip, '-d', extracted]);
  const archive = await applicationArchive();
  const output = target === 'mac' ? await packageMac(extracted, archive) : await packageWindows(extracted, archive);
  console.log(output);
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
