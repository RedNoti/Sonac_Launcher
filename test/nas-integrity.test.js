'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const test = require('node:test');
const { payload, manifestName, checkEntries } = require('../src/nas-integrity');
const { pullFiles } = require('../src/sync');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('signed NAS sync rejects tampering, replay, and symlink destinations', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-integrity-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const local = await fs.realpath(await fs.mkdir(path.join(directory, 'sync'), { recursive: true }));
  const outside = await fs.mkdir(path.join(directory, 'outside'), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = Date.now();
  const settings = { local, remote: '/Shared', integrityKey: publicKey.export({ type: 'spki', format: 'pem' }) };
  const options = { signal: new AbortController().signal, progress() {} };
  const makeRecord = (name, createdAt = now) => {
    const record = { version: 1, createdAt, files: [{ name, size: 4, sha256: sha256('good') }] };
    return { ...record, signature: sign(null, payload(record), privateKey).toString('base64') };
  };
  let record = makeRecord('file.txt');
  let content = 'evil';
  const requests = [];
  const store = {
    async download(location) {
      requests.push(location);
      return location.endsWith('/' + manifestName) ? Response.json(record) : new Response(content);
    }
  };
  const modified = await pullFiles(store, settings, options);
  assert.match(modified.message, /SHA-256/u);
  assert.deepEqual(await fs.readdir(local), []);

  content = 'good';
  assert.equal((await pullFiles(store, settings, options)).downloaded, 1);
  assert.equal(await fs.readFile(path.join(local, 'file.txt'), 'utf8'), 'good');
  await fs.writeFile(path.join(local, 'file.txt'), 'edit');
  assert.equal((await pullFiles(store, settings, options)).errors, 1);
  assert.equal(await fs.readFile(path.join(local, 'file.txt'), 'utf8'), 'edit');

  record = makeRecord('other.txt', now - 1000);
  await assert.rejects(pullFiles(store, settings, options), /오래되었거나/u);
  assert.ok(!requests.includes('/Shared/other.txt'));
  record = { ...makeRecord('other.txt', now + 1), files: makeRecord('modified.txt').files };
  await assert.rejects(pullFiles(store, settings, options), /서명/u);

  record = makeRecord('linked/target.txt', now + 2);
  await fs.symlink(outside, path.join(local, 'linked'), 'junction');
  await assert.rejects(pullFiles(store, settings, options), /심볼릭 링크/u);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('signed path list rejects traversal and portable filename collisions', () => {
  const entry = name => ({ name, size: 0, sha256: sha256('') });
  for (const name of ['../outside', 'f\\escape', 'NUL.txt', 'nested/.git/config', 'file.txt:stream']) {
    assert.throws(() => checkEntries([entry(name)]));
  }
  assert.throws(() => checkEntries([entry('README.txt'), entry('readme.txt')]), /충돌/u);
  assert.throws(() => checkEntries([entry('files/a.txt'), entry('files')]), /충돌/u);
});

test('HTTPS sync preserves an existing file when the received bytes fail the configured SHA-256', async t => {
  const { syncExternal } = require('../src/areas');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-link-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = await fs.realpath(directory);
  const filename = 'download.txt';
  const target = path.join(root, filename);
  await fs.writeFile(target, 'previous');
  let content = 'tampered';
  t.mock.method(require('undici'), 'fetch', async () => new Response(content));
  const area = { source: 'link', url: 'https://example.test/download.txt', filename, sha256: sha256('approved') };
  const options = { signal: new AbortController().signal };
  await assert.rejects(syncExternal(area, root, options), /SHA-256/u);
  assert.equal(await fs.readFile(target, 'utf8'), 'previous');
  assert.deepEqual(await fs.readdir(root), [filename]);
  content = 'approved';
  assert.equal((await syncExternal(area, root, options)).downloaded, 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'approved');
});
