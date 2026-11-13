'use strict';

const { createPublicKey, verify } = require('node:crypto');

const manifestName = '.sonac-files.json';
const maxEntries = 50000;
const maxManifest = 12 * 1024 * 1024;

function safeName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
      /[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]|[. ]$/u.test(name) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/iu.test(name) ||
      /^(?:\.git|\.ssh|\.gnupg|\.sonac-stage-.*|\.sonac-.*\.part|autorun\.inf)$/iu.test(name)) {
    throw new Error('동기화할 수 없는 파일 또는 폴더 이름입니다.');
  }
  return name;
}

function publicKey(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 512 || !value.trim().startsWith('-----BEGIN PUBLIC KEY-----')) {
    throw new Error('Ed25519 공개 키를 입력하세요.');
  }
  try {
    const key = createPublicKey(value.trim());
    if (key.asymmetricKeyType === 'ed25519') return key.export({ type: 'spki', format: 'pem' });
  } catch { /* Use the same error for unsupported keys. */ }
  throw new Error('Ed25519 공개 키를 입력하세요.');
}

function payload({ version, createdAt, files }) {
  return Buffer.from(JSON.stringify({ version, createdAt, files }));
}

function checkEntries(entries) {
  if (!Array.isArray(entries) || entries.length > maxEntries) throw new Error('서명 목록의 파일 수를 확인하세요.');
  const paths = new Map();
  for (const entry of entries) {
    const { name, size, sha256 } = entry || {};
    if (typeof name !== 'string' || name.length > 1024 || !Number.isSafeInteger(size) || size < 0 ||
        !/^[\da-f]{64}$/u.test(sha256 || '')) throw new Error('서명 목록의 파일 항목이 올바르지 않습니다.');
    const parts = name.split('/');
    if (parts.length > 40) throw new Error('동기화 폴더의 깊이가 너무 큽니다.');
    let parent = '';
    for (const [index, segment] of parts.entries()) {
      safeName(segment);
      parent += (parent ? '/' : '') + segment;
      if (segment.toLowerCase() === manifestName) throw new Error('예약된 동기화 파일 이름입니다.');
      const key = parent.normalize('NFC').toLowerCase();
      const directory = index < parts.length - 1;
      const existing = paths.get(key);
      if (existing && (!directory || !existing.directory || existing.name !== parent)) {
        throw new Error('서명 목록에 중복되거나 충돌하는 경로가 있습니다.');
      }
      paths.set(key, { name: parent, directory });
    }
  }
}

async function readSignedFiles(store, remote, key, minimum, signal) {
  const response = await store.download(remote.replace(/\/$/u, '') + '/' + manifestName, signal);
  if (!response.body) throw new Error('NAS에서 서명 파일 목록을 읽을 수 없습니다.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxManifest) throw new Error('NAS 서명 파일 목록이 너무 큽니다.');
    chunks.push(Buffer.from(chunk));
  }
  let record;
  try {
    record = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (record.version !== 1 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 1 ||
        record.createdAt > Date.now() + 300000 ||
        typeof record.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(record.signature) ||
        !verify(null, payload(record), key, Buffer.from(record.signature, 'base64'))) throw new Error();
  } catch {
    throw new Error('NAS 서명 파일 목록의 서명이 올바르지 않습니다.');
  }
  if (minimum && (record.createdAt < minimum.createdAt ||
      record.createdAt === minimum.createdAt && record.signature !== minimum.signature)) {
    throw new Error('이미 확인한 서명 목록보다 오래되었거나 충돌하는 목록입니다.');
  }
  checkEntries(record.files);
  return record;
}

module.exports = { manifestName, maxManifest, safeName, publicKey, payload, checkEntries, readSignedFiles };
