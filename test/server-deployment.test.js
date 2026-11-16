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
  const archive = zipSync({ 'app/server.cjs': strToU8("console.log('PORT=' + process.env.PORT); console.error('stderr'); setInterval(() => {}, 1000);") });
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
  const spec = await launchSpec(stage);
  assert.equal(spec.cwd, path.join(stage, 'app'));
  await startProcess(spec, data, runtime, () => {});
  assert.match(runtime.log, /PORT=9876/u);
  assert.match(runtime.log, /stderr/u);
  await stopProcess(runtime);
  assert.equal(runtime.child, null);
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
