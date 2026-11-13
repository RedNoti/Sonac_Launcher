import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeExecutableIcon(executable, icon) {
  const { NtExecutable, NtExecutableResource, Data, Resource } = await import('resedit');
  const exe = NtExecutable.from(await readFile(executable), { ignoreCert: true });
  const resources = NtExecutableResource.from(exe);
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  const images = Data.IconFile.from(await readFile(icon)).icons.map(entry => entry.data);
  if (!groups.length || !images.length) throw new Error('Windows 실행 파일 또는 앱 아이콘의 리소스를 찾을 수 없습니다.');
  for (const { id, lang } of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, id, lang, images);
  }
  resources.outputResource(exe);
  await writeFile(executable, Buffer.from(exe.generate()));
}

export async function writeShortcutProperties(filename, appId) {
  await writeFile(filename, [
    'MsiShortcutProperty\tShortcut_\tPropertyKey\tPropVariantValue',
    's72\ts72\tl255\tl255',
    'MsiShortcutProperty\tMsiShortcutProperty',
    'LauncherAppId\tLauncherShortcut\tSystem.AppUserModel.ID\t' + appId,
    ''
  ].join('\r\n'));
}

const xml = value => value.replace(/[&<>"']/gu, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
})[char]);
const id = (prefix, value) => prefix + createHash('sha256').update(value).digest('hex').slice(0, 32);

function guid(value) {
  const hash = id('', 'sonac-launcher-msi:' + value);
  return [hash.slice(0, 8), hash.slice(8, 12), '5' + hash.slice(13, 16),
    'a' + hash.slice(17, 20), hash.slice(20)].join('-').toUpperCase();
}

export async function writeMsiSource(source, output, { name, version }) {
  const [major, minor, build] = version.split('.').map(Number);
  if (!/^\d+\.\d+\.\d+$/u.test(version) || major > 255 || minor > 255 || build > 65535) {
    throw new Error('MSI 버전은 255.255.65535 이하의 숫자 세 부분이어야 합니다.');
  }
  const components = ['StartMenuShortcut'];
  async function tree(relative, directoryId, directoryName) {
    const entries = (await readdir(path.join(source, relative), { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const component = id('C', relative);
    components.push(component);
    const files = [];
    const directories = [];
    for (const entry of entries) {
      const file = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) directories.push(await tree(file, id('D', file), entry.name));
      else if (entry.isFile()) files.push('<File Id="' + id('F', file) + '" Source="' + xml(file) + '"/>');
      else throw new Error('MSI 소스에 파일이나 폴더가 아닌 항목이 있습니다.');
    }
    return `<Directory Id="${directoryId}" Name="${xml(directoryName)}">
      <Component Id="${component}" Guid="${guid('directory:' + relative)}" Win64="yes">
        ${files.join('\n')}
        <RemoveFolder Id="${id('R', relative)}" On="uninstall"/>
        <RegistryValue Root="HKCU" Key="Software\\Sonac\\Launcher\\Components" Name="${component}"
          Value="1" Type="integer" KeyPath="yes"/>
      </Component>
      ${directories.join('\n')}
    </Directory>`;
  }

  const payload = await tree('', 'INSTALLFOLDER', 'SonacLauncher');
  await writeFile(output, `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="${guid('version:' + version)}" UpgradeCode="${guid('product')}"
    Name="${xml(name)}" Language="1033" Version="${xml(version)}" Manufacturer="Sonac Studio">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perUser"/>
    <Upgrade Id="${guid('product')}">
      <UpgradeVersion Maximum="${version}" IncludeMaximum="no" Property="SONAC_OLD_VERSION"/>
      <UpgradeVersion Minimum="${version}" IncludeMinimum="no" OnlyDetect="yes" Property="SONAC_NEW_VERSION"/>
    </Upgrade>
    <Condition Message="A newer sonac launcher is already installed.">Installed OR NOT SONAC_NEW_VERSION</Condition>
    <InstallExecuteSequence>
      <RemoveExistingProducts After="InstallInitialize"/>
    </InstallExecuteSequence>
    <Media Id="1" Cabinet="sonac.cab" EmbedCab="yes"/>
    <Icon Id="LauncherIcon" SourceFile="SonacLauncher.ico"/>
    <Property Id="ARPPRODUCTICON" Value="LauncherIcon"/>
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="ProgramsFolder" Name="Programs">
          ${payload}
        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder">
        <Component Id="StartMenuShortcut" Guid="${guid('shortcut')}" Win64="yes">
          <Shortcut Id="LauncherShortcut" Name="${xml(name)}" Target="[INSTALLFOLDER]${xml(name)}.exe"
            WorkingDirectory="INSTALLFOLDER" Icon="LauncherIcon"/>
          <RegistryValue Root="HKCU" Key="Software\\Sonac\\Launcher" Name="Installed"
            Value="1" Type="integer" KeyPath="yes"/>
        </Component>
      </Directory>
    </Directory>
    <Feature Id="Launcher" Title="${xml(name)}" Level="1">
      ${components.map(component => '<ComponentRef Id="' + component + '"/>').join('\n')}
    </Feature>
  </Product>
</Wix>
`);
}
