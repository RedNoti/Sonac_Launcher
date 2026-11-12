'use strict';

const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const test = require('node:test');
const { compareVersions, installerName, manifestBytes, readManifest } = require('../src/update-manifest');

test('updates accept only a signed record for the expected platform and bytes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const version = '0.1.10';
  const target = 'mac-arm64';
  const record = { version, target, filename: installerName(version, target), size: 123, sha256: 'a'.repeat(64) };
  const manifest = { ...record, signature: sign(null, manifestBytes(record), privateKey).toString('base64') };
  assert.deepEqual(readManifest(manifest, target, publicKey), manifest);
  assert.throws(() => readManifest({ ...manifest, sha256: 'b'.repeat(64) }, target, publicKey), /서명/u);
  assert.throws(() => readManifest(manifest, 'win-x64', publicKey), /서명/u);
  assert.throws(() => readManifest({ ...manifest, filename: '../installer.dmg' }, target, publicKey), /서명/u);
  assert.ok(compareVersions(version, '0.1.9') > 0);
  assert.ok(compareVersions('0.9.99', '1.0.0') < 0);
});
