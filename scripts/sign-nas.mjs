import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFile, readdir, realpath, stat, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import integrity from '../src/nas-integrity.js';
import updateManifest from '../src/update-manifest.js';

const [directory, keyFile] = process.argv.slice(2);
if (directory === '--generate-key' && keyFile) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  await writeFile(keyFile, privateKey, { flag: 'wx', mode: 0o600 });
  try {
    await writeFile(keyFile + '.pub', publicKey, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    await rm(keyFile, { force: true });
    throw error;
  }
  console.log('NAS 서명 키와 공개 키를 만들었습니다.');
  process.exit(0);
}
if (!directory || !keyFile) throw new Error('사용법: node scripts/sign-nas.mjs <배포할 로컬 폴더> <Ed25519 개인 키>');
const root = await realpath(directory);
const keyPath = await realpath(keyFile);
const relation = path.relative(root, keyPath);
if (relation === '' || (!path.isAbsolute(relation) && relation !== '..' && !relation.startsWith('..' + path.sep))) {
  throw new Error('서명 개인 키는 배포 폴더 밖에 보관하세요.');
}
const key = createPrivateKey(await readFile(keyPath));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 개인 키가 필요합니다.');
const files = [];
async function visit(relative) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || (!relative && entry.name === integrity.manifestName)) continue;
    integrity.safeName(entry.name);
    const name = relative ? relative + '/' + entry.name : entry.name;
    const filename = path.join(root, name);
    if (entry.isDirectory()) await visit(name);
    else if (entry.isFile()) files.push({ name, size: (await stat(filename)).size, sha256: await updateManifest.sha256(filename) });
    else throw new Error('심볼릭 링크나 일반 파일이 아닌 항목이 있습니다. · ' + name);
  }
}
await visit('');
files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
integrity.checkEntries(files);
const record = { version: 1, createdAt: Date.now(), files };
record.signature = sign(null, integrity.payload(record), key).toString('base64');
const bytes = JSON.stringify(record) + '\n';
if (Buffer.byteLength(bytes) > integrity.maxManifest) throw new Error('서명 파일 목록이 너무 큽니다.');
const temp = path.join(root, '.sonac-' + randomUUID() + '.part');
try {
  await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temp, path.join(root, integrity.manifestName));
} finally {
  await rm(temp, { force: true });
}
console.log(files.length + '개 파일의 .sonac-files.json을 만들었습니다.');
