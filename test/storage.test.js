'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { endpoint, storage } = require('../src/storage');

test('DSM accepts a bare host or host and port and keeps HTTPS restrictions', () => {
  assert.equal(endpoint(' sonaccloud.com ', 'synology'), 'https://sonaccloud.com');
  assert.equal(endpoint('nas.example.test:5001', 'synology'), 'https://nas.example.test:5001');
  assert.equal(endpoint('[::1]:5001', 'synology'), 'https://[::1]:5001');
  assert.equal(endpoint('https://nas.example.test/', 'synology'), 'https://nas.example.test');
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
