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

test('music playback retains its seekable file while video and ordinary previews open and close', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-media-test-'));
  t.after(async () => { await clearPreview(); await fs.rm(dir, { recursive: true, force: true }); });
  const signal = new AbortController().signal;
  const download = bytes => async () => new Response(bytes);
  const { url: music } = await createPreview('music', { name: 'track.mp3' }, { player: 'audio', signal, download: download('music bytes') });
  const { url: video } = await createPreview('video', { name: 'film.mp4' }, { player: 'video', signal, download: download('video bytes') });
  const filename = path.join(dir, 'notes.txt');
  await fs.writeFile(filename, 'preview bytes');
  const { url: preview } = await createPreview('text', { name: 'notes.txt' }, { filename, signal });
  assert.equal(await (await serve(new Request(preview))).text(), 'preview bytes');
  await clearPreview('video');
  assert.equal((await serve(new Request(video))).status, 404);
  const range = await serve(new Request(music, { headers: { range: 'bytes=6-10' } }));
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await range.text(), 'bytes');
});

test('cancelled playback ranges leave the file available for later seeks', async t => {
  const data = Buffer.alloc(512 * 1024, 1);
  data.fill(2, 350000);
  t.after(() => clearPreview());
  const { url } = await createPreview('seekable', { name: 'clip.mkv' }, {
    player: 'video', signal: new AbortController().signal, download: async () => new Response(data)
  });
  const stream = await serve(new Request(url, { headers: { range: 'bytes=0-' } }));
  const reader = stream.body.getReader();
  assert.equal((await reader.read()).value[0], 1);
  await reader.cancel();
  const seek = await serve(new Request(url, { headers: { range: 'bytes=350000-350009' } }));
  assert.equal(seek.headers.get('content-type'), 'video/x-matroska');
  assert.equal(seek.status, 206);
  assert.deepEqual(Buffer.from(await seek.arrayBuffer()), Buffer.alloc(10, 2));
});

test('large NAS video serves downloaded bytes before the rest arrives and can cancel pending seeks', async t => {
  const size = 12 * 1024 ** 3;
  let upstream;
  t.after(() => clearPreview('large-video'));
  const { url } = await createPreview('large-video', { name: 'concert.mkv', size }, {
    player: 'video',
    signal: new AbortController().signal,
    download: async signal => new Response(new ReadableStream({
      start(controller) {
        upstream = controller;
        controller.enqueue(Buffer.from('video start'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      }
    }))
  });
  const initial = await serve(new Request(url, { headers: { Range: 'bytes=0-10' } }));
  assert.equal(initial.headers.get('content-range'), 'bytes 0-10/' + size);
  assert.equal(await initial.text(), 'video start');

  const pending = await serve(new Request(url, { headers: { Range: 'bytes=1000-1010' } }));
  await pending.body.cancel();
  upstream.enqueue(Buffer.from('second chunk'));
  const next = await serve(new Request(url, { headers: { Range: 'bytes=11-22' } }));
  assert.equal(await next.text(), 'second chunk');
});

test('GitHub lists collaborator repositories and checks access without requiring ownership', async t => {
  const { repositories, requireRepositoryAccess } = require('../src/github');
  const signal = new AbortController().signal;
  const token = 'fixture-token';
  t.mock.method(require('undici'), 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + token);
    if (url.pathname === '/user/repos') {
      assert.equal(url.searchParams.get('affiliation'), 'owner,collaborator,organization_member');
      if (url.searchParams.get('page') === '1') {
        return Response.json([{ full_name: 'owner/own', default_branch: 'main', private: true }],
          { headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } });
      }
      return Response.json([{ full_name: 'partner/shared', default_branch: 'main', private: true }]);
    }
    if (url.pathname === '/repos/partner/shared') return Response.json({});
    assert.equal(url.pathname, '/repos/partner/restricted');
    return new Response(null, { status: 404 });
  });
  assert.deepEqual((await repositories(token, signal)).map(repo => repo.name), ['owner/own', 'partner/shared']);
  await requireRepositoryAccess('partner/shared', token, signal);
  await assert.rejects(requireRepositoryAccess('partner/restricted', token, signal), /접근 권한/u);
});
