'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { profileBinding, seal, unseal } = require('../src/credentials');
const { httpsFetch, certificatePin } = require('../src/transport');
const { createPreview, clearPreview, serve } = require('../src/preview');

test('saved credentials cannot be restored for another server, user or public-key pin', async () => {
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return Buffer.from(value); },
    async decryptStringAsync(value) { return { result: value.toString() }; }
  };
  const profile = { provider: 'synology', url: 'https://nas.example.test', user: 'test' };
  const value = { password: 'fixture-only', deviceId: 'test-device' };
  const stored = await seal(safeStorage, profileBinding(profile), value);
  assert.deepEqual(await unseal(safeStorage, stored, profileBinding(profile)), value);
  for (const other of [{ url: 'https://other.example.test' }, { user: 'another' }, { pin: 'different' }]) {
    await assert.rejects(unseal(safeStorage, stored, profileBinding({ ...profile, ...other })), /일치하지/u);
  }
  await assert.rejects(unseal(safeStorage, stored.ciphertext, profileBinding(profile)), /다시 로그인/u);
});

test('trusted transport rejects HTTP and embedded URL credentials before any request', async t => {
  const fetch = t.mock.method(require('undici'), 'fetch', async () => new Response('ok'));
  for (const url of ['http://nas.example.test/', 'https://user:password@nas.example.test/']) {
    assert.throws(() => httpsFetch(url), /HTTPS/u);
  }
  assert.equal(fetch.mock.calls.length, 0);
  assert.equal(await (await httpsFetch('https://nas.example.test/')).text(), 'ok');
  assert.ok(fetch.mock.calls[0].arguments[1].dispatcher);
  assert.throws(() => certificatePin('sha256/not-a-fingerprint'), /지문/u);
});

test('preview serves the approved open file even when the original pathname is replaced', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-preview-test-'));
  t.after(async () => { await clearPreview(); await fs.rm(dir, { recursive: true, force: true }); });
  const name = 'report.txt';
  const filename = path.join(dir, name);
  await fs.writeFile(filename, 'selected file');
  const { url } = await createPreview('fixture', { name }, { filename, signal: new AbortController().signal });
  await fs.rename(filename, filename + '.old');
  await fs.writeFile(filename, 'different file');
  const first = await serve(new Request(url, { headers: { range: 'bytes=0-7' } }));
  assert.equal(first.status, 206);
  assert.equal(await first.text(), 'selected');
  assert.equal(await (await serve(new Request(url))).text(), 'selected file');
  assert.equal((await serve(new Request('sonac://terminal/terminal.html'))).status, 404);
  assert.equal((await serve(new Request('sonac://app/index.html'), 'terminal')).status, 404);
});
