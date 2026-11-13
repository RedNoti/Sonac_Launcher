'use strict';

const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const test = require('node:test');
const { compareVersions, installerName, manifestBytes, parseTag, readManifest } = require('../src/update-manifest');

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

test('GitHub release assets accept GitHub redirects and reject another repository or host', async t => {
  const { releaseAsset } = require('../src/updater');
  const repository = 'test/launcher';
  const name = 'latest-win-x64.json';
  const signal = new AbortController().signal;
  const replies = [
    new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/asset' } }),
    new Response('signed asset')
  ];
  const fetch = t.mock.method(require('undici'), 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return replies.shift();
  });
  assert.equal(await (await releaseAsset(repository, 'a0.2.0', name, signal, 1000)).text(), 'signed asset');
  assert.equal(String(fetch.mock.calls[0].arguments[0]), 'https://github.com/test/launcher/releases/download/a0.2.0/' + name);
  assert.equal(installerName('0.2.0', 'win-x64'), 'sonac_launcher-0.2.0-win-x64.msi');
  for (const location of ['/other/launcher/releases/download/a0.2.0/' + name, 'http://github.com/', 'https://example.test/']) {
    replies.push(new Response(null, { status: 302, headers: { Location: location } }));
    await assert.rejects(releaseAsset(repository, 'a0.2.0', name, signal, 1000), /릴리스 다운로드 주소/u);
  }
});

test('release channels include compatible prereleases and support same-version promotion', () => {
  const { selectRelease } = require('../src/updater');
  const target = 'win-x64';
  const record = (tag, options = {}) => ({
    tag_name: tag, prerelease: tag[0] !== 'R', assets: ['latest-win-x64.json', installerName(tag.slice(1), target)]
      .map(name => ({ name, state: 'uploaded' })), ...options
  });
  const releases = [record('a0.3.0'), record('b0.2.2'), record('R0.2.2'), record('R0.4.0', { draft: true }),
    record('R0.9.0', { prerelease: true }), record('a0.4.0', { assets: [] }), record('v0.8.0')];
  assert.equal(selectRelease(releases, '0.2.2', 'a', target).release.tag, 'a0.3.0');
  assert.equal(selectRelease(releases, '0.2.2', 'b', target).release.tag, 'R0.2.2');
  assert.equal(selectRelease(releases, '0.2.2', 'R', target).release, undefined);
  assert.equal(selectRelease(releases, '0.3.0', 'a', target).missingAssets, true);
});

test('the release channel is covered by the manifest signature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const target = 'win-x64';
  const record = { version: '0.2.3', target, filename: installerName('0.2.3', target),
    size: 20, sha256: 'a'.repeat(64), channel: 'b' };
  const manifest = { ...record, signature: sign(null, manifestBytes(record), privateKey).toString('base64') };
  assert.equal(readManifest(manifest, target, publicKey).channel, 'b');
  assert.throws(() => readManifest({ ...manifest, channel: 'R' }, target, publicKey), /서명/u);
});

test('release tags, version ordering and signed manifests support up to five numeric components', () => {
  const { selectRelease } = require('../src/updater');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const target = 'mac-arm64';
  const version = '0.2.10.0.1';
  const tag = 'a' + version;
  const record = { version, target, filename: installerName(version, target),
    size: 20, sha256: 'a'.repeat(64), channel: 'a' };
  const manifest = { ...record, signature: sign(null, manifestBytes(record), privateKey).toString('base64') };
  const release = { tag_name: tag, prerelease: true, assets: ['latest-mac-arm64.json', record.filename]
    .map(name => ({ name, state: 'uploaded' })) };
  assert.deepEqual(parseTag(tag), { tag, channel: 'a', version });
  assert.equal(parseTag('a0.2.10.0.0.1'), null);
  assert.equal(parseTag('a0.2.10.01'), null);
  assert.equal(compareVersions('0.2.10', '0.2.10.0.0'), 0);
  assert.ok(compareVersions('0.2.10.1', version) > 0);
  assert.ok(compareVersions('0.2.11', '0.2.10.9.9') > 0);
  assert.equal(selectRelease([release], '0.2.10', 'a', target).release.tag, tag);
  assert.equal(selectRelease([release], version, 'a', target).release, undefined);
  assert.deepEqual(readManifest(manifest, target, publicKey), manifest);
});
