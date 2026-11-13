'use strict';

const { createHash, verify } = require('node:crypto');
const { createReadStream } = require('node:fs');

const releaseVersion = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2,4}$/u;
const suffixes = { 'mac-arm64': '-mac-arm64.dmg', 'win-x64': '-win-x64.msi' };
const releaseChannels = ['a', 'b', 'R'];

function parseTag(tag) {
  if (typeof tag !== 'string' || !releaseChannels.includes(tag[0]) || !releaseVersion.test(tag.slice(1))) return null;
  return { tag, channel: tag[0], version: tag.slice(1) };
}

function compareVersions(first, second) {
  const left = first.split('.').map(Number);
  const right = second.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function installerName(version, target) {
  return 'sonac_launcher-' + version + suffixes[target];
}

function manifestBytes(record) {
  const { version, target, filename, size, sha256, channel } = record;
  return Buffer.from(JSON.stringify({ version, target, filename, size, sha256, channel }));
}

function readManifest(value, target, publicKey) {
  if (!value || typeof value.version !== 'string' || !releaseVersion.test(value.version) || value.target !== target ||
      (value.channel !== undefined && !releaseChannels.includes(value.channel)) ||
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

module.exports = { compareVersions, installerName, manifestBytes, readManifest, sha256, parseTag, releaseChannels, releaseVersion };
