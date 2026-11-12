'use strict';

const { createHash, verify } = require('node:crypto');
const { createReadStream } = require('node:fs');

const releaseVersion = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/u;
const suffixes = { 'mac-arm64': '-mac-arm64.dmg', 'win-x64': '-win-x64-setup.exe' };

function compareVersions(first, second) {
  const left = first.split('.').map(Number);
  const right = second.split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function installerName(version, target) {
  return 'sonac_launcher-' + version + suffixes[target];
}

function manifestBytes(record) {
  const { version, target, filename, size, sha256 } = record;
  return Buffer.from(JSON.stringify({ version, target, filename, size, sha256 }));
}

function readManifest(value, target, publicKey) {
  if (!value || typeof value.version !== 'string' || !releaseVersion.test(value.version) || value.target !== target ||
      value.filename !== installerName(value.version, target) ||
      !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 1024 ** 3 ||
      !/^[\da-f]{64}$/u.test(value.sha256) || typeof value.signature !== 'string' ||
      !verify(null, manifestBytes(value), publicKey, Buffer.from(value.signature, 'base64'))) {
    throw new Error('업데이트 목록의 서명을 확인할 수 없습니다.');
  }
  return value;
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

module.exports = { compareVersions, installerName, manifestBytes, readManifest, sha256 };
