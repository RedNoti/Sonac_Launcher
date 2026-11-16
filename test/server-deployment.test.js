'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { strToU8, zipSync } = require('fflate');
const undici = require('undici');
const { releaseAssets, downloadAsset, extractZip, launchSpec, startProcess, stopProcess } = require('../src/server-deployment');

test('a tagged GitHub ZIP can be downloaded, extracted, launched with local configuration and stopped', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-deploy-test-'));
  const stage = path.join(root, 'release');
  const data = path.join(root, 'data');
  const runtime = { log: '' };
  t.after(async () => {
    await stopProcess(runtime);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, '.env'), 'PORT=9876\n');
  await fs.writeFile(path.join(data, 'firebase-token.cjs'), 'module.exports = "local";');
  const archive = zipSync({
    'app/server.cjs': strToU8("console.log('bundled=' + require('./firebase-token.cjs')); console.log('PORT=' + process.env.PORT); console.error('stderr'); setInterval(() => {}, 1000);"),
    'app/.env': strToU8('PORT=1234\n'),
    'app/firebase-token.cjs': strToU8('module.exports = "bundled";')
  });
  const digest = 'sha256:' + createHash('sha256').update(archive).digest('hex');
  const token = 'example-private-release-token';
  t.mock.method(undici, 'fetch', async (url, { headers, redirect }) => {
    if (url.pathname === '/repos/demo/project/releases/tags/a1.0.0') {
      assert.equal(headers.Authorization, 'Bearer ' + token);
      return Response.json({ tag_name: 'a1.0.0', assets: [
        { id: 1, name: 'server.zip', state: 'uploaded', size: archive.length, digest },
        { id: 2, name: 'server.tar.gz', state: 'uploaded' }
      ] });
    }
    if (url.pathname === '/repos/demo/project/releases/assets/1') {
      assert.equal(headers.Authorization, 'Bearer ' + token);
      assert.equal(headers.Accept, 'application/octet-stream');
      assert.equal(redirect, 'manual');
      return Response.redirect('https://release-assets.githubusercontent.com/test', 302);
    }
    assert.equal(url.origin, 'https://release-assets.githubusercontent.com');
    assert.equal(headers.Authorization, undefined);
    return new Response(archive);
  });
  const signal = new AbortController().signal;
  const assets = await releaseAssets('https://github.com/demo/project/releases/tag/a1.0.0', signal, token);
  assert.deepEqual(assets.map(item => item.name), ['server.zip']);
  await assert.rejects(downloadAsset({ ...assets[0], digest: 'sha256:bad' }, signal, token), /검증/u);
  const bytes = await downloadAsset(assets[0], signal, token);
  await extractZip(bytes, stage, signal);
  assert.equal(await fs.readFile(path.join(stage, 'app', 'firebase-token.cjs'), 'utf8'), 'module.exports = "bundled";');
  const spec = await launchSpec(stage);
  assert.equal(spec.cwd, path.join(stage, 'app'));
  await startProcess(spec, data, runtime, () => {});
  assert.match(runtime.log, /bundled=bundled/u);
  assert.match(runtime.log, /PORT=9876/u);
  assert.match(runtime.log, /stderr/u);
  assert.equal(await fs.readFile(path.join(spec.cwd, '.env'), 'utf8'), 'PORT=1234\n');
  assert.equal(await fs.readFile(path.join(data, '.env'), 'utf8'), 'PORT=9876\n');
  assert.equal(await fs.readFile(path.join(data, 'firebase-token.cjs'), 'utf8'), 'module.exports = "local";');
  await stopProcess(runtime);
  assert.equal(runtime.child, null);
});

test('a release list includes newer prerelease ZIPs and a latest URL retains the stable lookup', async t => {
  const published = (tag, day, assetId) => ({
    tag_name: tag, published_at: day, assets: [{ id: assetId, state: 'uploaded', name: 'relay.zip' }]
  });
  const stable = published('a1.1.0', '2026-11-15', 1);
  const preview = { ...published('a1.2.0', '2026-11-16', 2), prerelease: true };
  const draft = { ...published('a1.3.0', '2026-11-17', 3), draft: true };
  const requests = [];
  t.mock.method(undici, 'fetch', async (url, options) => {
    assert.equal(options.cache, 'no-store');
    requests.push(url.pathname + url.search);
    return Response.json(url.pathname.endsWith('/latest') ? stable : [stable, draft, preview]);
  });
  const source = 'https://github.com/demo/project/releases';
  const signal = new AbortController().signal;
  assert.deepEqual((await releaseAssets(source, signal, '')).map(asset => asset.tag), ['a1.2.0', 'a1.1.0']);
  assert.deepEqual((await releaseAssets(source + '/latest', signal, '')).map(asset => asset.tag), ['a1.1.0']);
  assert.deepEqual(requests, ['/repos/demo/project/releases?per_page=30', '/repos/demo/project/releases/latest']);
});

test('ZIP extraction rejects traversal and portable filename collisions before writing files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-deploy-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  const contents = strToU8('not written');
  await assert.rejects(extractZip(zipSync({ '../outside.txt': contents }), root, signal), /파일 경로/u);
  await assert.rejects(extractZip(zipSync({ 'Server.js': contents, 'server.js': contents }), root, signal), /중복/u);
  await assert.rejects(extractZip(zipSync({ 'nul.txt': contents }), root, signal), /파일 경로/u);
  assert.deepEqual(await fs.readdir(root), []);
});

test('redeploying extracts new bytes for same-named files in the new release directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-redeploy-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = path.join(root, 'previous');
  const next = path.join(root, 'next');
  const signal = new AbortController().signal;
  await extractZip(zipSync({ 'server.cjs': strToU8('old'), 'obsolete.txt': strToU8('old only') }), previous, signal);
  await extractZip(zipSync({ 'server.cjs': strToU8('new'), 'firebase-token.cjs': strToU8('new module') }), next, signal);
  assert.equal(await fs.readFile(path.join(next, 'server.cjs'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(next, 'firebase-token.cjs'), 'utf8'), 'new module');
  assert.equal(await fs.readFile(path.join(previous, 'server.cjs'), 'utf8'), 'old');
  await assert.rejects(fs.access(path.join(next, 'obsolete.txt')), { code: 'ENOENT' });
});
