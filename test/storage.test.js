'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { endpoint, storage } = require('../src/storage');

test('DSM accepts a bare host or host and port and keeps HTTPS restrictions', () => {
  assert.equal(endpoint(' sonaccloud.com ', 'synology'), 'https://sonaccloud.com');
  assert.equal(endpoint('nas.example.test:5001', 'synology'), 'https://nas.example.test:5001');
  assert.equal(endpoint('[::1]:5001', 'synology'), 'https://[::1]:5001');
  assert.equal(endpoint('https://nas.example.test/', 'synology'), 'https://nas.example.test');
  assert.equal(endpoint('https://quickconnect.to/MyNas', 'synology'), 'https://mynas.quickconnect.to');
  for (const invalid of ['http://nas.example.test', 'nas.example.test/webapi', 'https://user@nas.example.test',
    'https://nas.example.test/?query', 'nas.example.test#fragment']) {
    assert.throws(() => endpoint(invalid, 'synology'));
  }
});

const profile = { provider: 'synology', url: 'https://nas.example.test', user: 'tester' };
const methods = {
  'SYNO.API.Auth': { path: 'auth.cgi', minVersion: 3, maxVersion: 7 },
  'SYNO.FileStation.List': { path: 'entry.cgi', minVersion: 2, maxVersion: 2 },
  'SYNO.FileStation.Download': { path: 'entry.cgi', minVersion: 2, maxVersion: 2 },
  'SYNO.FileStation.Upload': { path: 'entry.cgi', minVersion: 2, maxVersion: 3 }
};

test('QuickConnect discovers HTTPS relay before sending DSM credentials', async t => {
  const relay = 'https://mynas.sg3.quickconnect.to';
  const fetch = t.mock.method(require('undici'), 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url.hostname === 'global.quickconnect.to') {
      const [query] = JSON.parse(options.body);
      assert.equal(query.serverID, 'mynas');
      assert.equal(query.id, 'mainapp_https');
      assert.equal(query.command, 'get_server_info');
      assert.equal(Object.hasOwn(query, 'passwd'), false);
      return Response.json([{ errno: 0, service: { relay_dn: 'relay' }, env: { relay_region: 'sg3' } }]);
    }
    assert.equal(url.origin, relay);
    if (url.pathname === '/webapi/query.cgi') return Response.json({ success: true, data: methods });
    if (options.body.get('method') === 'login') {
      assert.equal(options.body.get('passwd'), 'fixture-password');
      return Response.json({ success: true, data: { sid: 'fixture-sid' } });
    }
    return Response.json({ success: true, data: { shares: [] } });
  });
  const nas = storage({ ...profile, url: 'https://mynas.quickconnect.to' });
  await nas.connect({ password: 'fixture-password' }, '', false);
  assert.equal(fetch.mock.callCount(), 4);
});

test('QuickConnect rejects an unsafe discovery response before DSM login', async t => {
  const fetch = t.mock.method(require('undici'), 'fetch', async () =>
    Response.json([{ errno: 0, service: { relay_dn: 'relay' }, env: { relay_region: 'sg3.attacker.example' } }]));
  const nas = storage({ ...profile, url: 'https://mynas.quickconnect.to' });
  await assert.rejects(nas.connect({ password: 'fixture-password' }, '', false), /중계 주소/u);
  assert.equal(fetch.mock.callCount(), 1);
});

test('DSM accepts a session ID starting like a number when carried in its id cookie', async t => {
  const sid = '6E5h-test-session';
  const token = 'csrf-token';
  const operations = [];
  const success = (data, headers) => Response.json({ success: true, data }, { headers });

  t.mock.method(require('undici'), 'fetch', async (url, options) => {
    if (url.pathname === '/webapi/query.cgi') return success(methods);
    const form = options.body instanceof URLSearchParams ? options.body : null;
    if (form?.get('method') === 'login') {
      assert.equal(form.get('session'), 'FileStation');
      assert.equal(new Headers(options.headers).has('Cookie'), false);
      const headers = new Headers();
      if (form.get('format') === 'cookie') {
        headers.append('Set-Cookie', 'unrelated=ignore; Path=/');
        headers.append('Set-Cookie', 'id=' + sid + '; Path=/; Secure; HttpOnly');
      }
      return success({ sid, synotoken: token }, headers);
    }
    const headers = new Headers(options.headers);
    if (headers.get('Cookie') !== 'id=' + sid) {
      return Response.json({ success: false, error: { code: 119 } });
    }
    if (form) {
      assert.equal(form.has('_sid'), false);
      assert.equal(form.get('SynoToken'), token);
      const method = form.get('method');
      operations.push(method);
      if (method === 'list_share') return success({ shares: [{ name: 'Shared', path: '/Shared' }], total: 1 });
      if (method === 'download') return new Response('example', { headers: { 'Content-Disposition': 'attachment' } });
      assert.equal(method, 'logout');
      return success();
    }
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    const upload = Buffer.concat(chunks).toString('utf8');
    assert.match(upload, /name="SynoToken"\r\n\r\ncsrf-token\r\n/u);
    assert.match(upload, /name="file"; filename="sample.txt"/u);
    assert.doesNotMatch(upload, /name="_sid"/u);
    operations.push('upload');
    return success();
  });

  const nas = storage(profile);
  await nas.connect({ password: 'password' }, '', false);
  assert.equal(await (await nas.download('/Shared/sample.txt')).text(), 'example');
  await nas.upload('/Shared', 'sample.txt', new Blob(['example']));
  await nas.logout();
  assert.deepEqual(operations, ['list_share', 'download', 'upload', 'logout']);
});

test('DSM renames a file using the discovered File Station API version', async t => {
  for (const version of [1, 2]) {
    const fetch = t.mock.method(require('undici'), 'fetch', async (url, { body }) => {
      const data = url.pathname === '/webapi/query.cgi' ? {
        ...methods, 'SYNO.FileStation.Rename': { path: 'entry.cgi', minVersion: 1, maxVersion: version }
      } : body.get('method') === 'login' ? { sid: 'fixture-sid' } :
        body.get('method') === 'list_share' ? { shares: [], total: 0 } : {};
      if (body?.get('method') === 'rename') {
        assert.equal(body.get('api'), 'SYNO.FileStation.Rename');
        assert.equal(body.get('version'), String(version));
        assert.equal(body.get('path'), version === 1 ? '/Shared/a.zip' : '["/Shared/a.zip"]');
        assert.equal(body.get('name'), version === 1 ? '새 이름.zip' : '["새 이름.zip"]');
      }
      return Response.json({ success: true, data });
    });
    const nas = storage(profile);
    await nas.connect({ password: 'fixture-password' }, '', false);
    await nas.rename('/Shared', { path: '/Shared/a.zip', directory: false }, '새 이름.zip');
    assert.equal(fetch.mock.callCount(), 4);
    fetch.mock.restore();
  }
});

test('DSM starts and polls ZIP extraction without transferring the archive', async t => {
  const operations = [];
  t.mock.method(require('undici'), 'fetch', async (url, { body }) => {
    if (url.pathname === '/webapi/query.cgi') {
      assert.match(url.searchParams.get('query'), /SYNO\.FileStation\.Extract/u);
      return Response.json({ success: true, data: {
        ...methods, 'SYNO.FileStation.Extract': { path: 'entry.cgi', minVersion: 2, maxVersion: 2 }
      } });
    }
    const method = body.get('method');
    if (method === 'login') return Response.json({ success: true, data: { sid: 'fixture-sid' } });
    if (method === 'list_share') return Response.json({ success: true, data: { shares: [], total: 0 } });
    operations.push(method);
    assert.equal(body.get('api'), 'SYNO.FileStation.Extract');
    assert.equal(body.get('version'), '2');
    if (method === 'start') {
      assert.equal(JSON.parse(body.get('file_path')), '/web/대용량.zip');
      assert.equal(JSON.parse(body.get('dest_folder_path')), '/web/staging');
      assert.equal(body.get('keep_dir'), 'true');
      assert.equal(body.get('create_subfolder'), 'false');
      assert.equal(body.get('overwrite'), 'false');
      return Response.json({ success: true, data: { taskid: 'FileStation_extract123' } });
    }
    assert.equal(JSON.parse(body.get('taskid')), 'FileStation_extract123');
    return Response.json({ success: true, data: method === 'status' ? { finished: false, progress: 0.45 } : {} });
  });
  const nas = storage(profile);
  await nas.connect({ password: 'fixture-password' }, '', false);
  const task = await nas.startExtract('/web/대용량.zip', '/web/staging');
  assert.deepEqual(await nas.extractStatus(task), { finished: false, progress: 0.45 });
  await nas.stopExtract(task);
  assert.deepEqual(operations, ['start', 'status', 'stop']);
});
