import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function macSigningConfiguration() {
  const identity = process.env.SONAC_MAC_SIGN_IDENTITY;
  const profile = process.env.SONAC_MAC_NOTARY_PROFILE;
  if (!identity && !profile) return null;
  if (!identity?.startsWith('Developer ID Application: ') || !profile) {
    throw new Error('Developer ID Application 인증서 이름과 SONAC_MAC_NOTARY_PROFILE을 함께 설정하세요.');
  }
  return { identity, profile };
}

export async function signMacBundle(bundle, work, architecture, configuration, command) {
  if (!configuration) {
    command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
    return;
  }
  const entitlements = path.join(work, 'electron-entitlements.plist');
  await writeFile(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>`);
  const common = ['--force', '--timestamp', '--options', 'runtime', '--sign', configuration.identity];
  const sign = (item, executable = false) => command('/usr/bin/codesign',
    [...common, ...(executable ? ['--entitlements', entitlements] : []), item]);
  const contents = path.join(bundle, 'Contents');
  const frameworks = path.join(contents, 'Frameworks');
  const libraries = path.join(frameworks, 'Electron Framework.framework', 'Versions', 'A', 'Libraries');
  for (const entry of await readdir(libraries)) {
    if (entry.endsWith('.dylib')) sign(path.join(libraries, entry));
  }
  for (const entry of await readdir(frameworks)) {
    if (entry.endsWith('.framework')) sign(path.join(frameworks, entry));
    if (entry.endsWith('.app')) sign(path.join(frameworks, entry), true);
  }
  const terminal = path.join(contents, 'Resources', 'node_modules', 'node-pty', 'prebuilds', 'darwin-' + architecture);
  for (const entry of ['spawn-helper', 'pty.node']) sign(path.join(terminal, entry));
  sign(bundle, true);
}

export function notarizeMacImage(image, configuration, command) {
  if (!configuration) return;
  command('/usr/bin/codesign', ['--force', '--timestamp', '--sign', configuration.identity, image]);
  command('/usr/bin/xcrun', ['notarytool', 'submit', image, '--keychain-profile', configuration.profile, '--wait']);
  command('/usr/bin/xcrun', ['stapler', 'staple', image]);
  command('/usr/bin/xcrun', ['stapler', 'validate', image]);
}
