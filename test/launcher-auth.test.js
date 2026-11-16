'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const undici = require('undici');
const { refreshLauncherSession } = require('../src/launcher-auth');

const config = { apiKey: 'test-web-key', projectId: 'test-project' };
const saved = { uid: 'uid-a', email: 'before@example.test', refreshToken: 'existing-session' };

test('launcher refresh exchanges the saved token and accepts token rotation for the same account', async t => {
  t.mock.method(Date, 'now', () => 10000);
  t.mock.method(undici, 'fetch', async (url, options) => {
    assert.equal(url.origin + url.pathname, 'https://securetoken.googleapis.com/v1/token');
    assert.equal(url.searchParams.get('key'), config.apiKey);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(Object.fromEntries(options.body), { grant_type: 'refresh_token', refresh_token: saved.refreshToken });
    const payload = { sub: saved.uid, aud: config.projectId, email: 'after@example.test' };
    return Response.json({
      user_id: saved.uid, project_id: '123456789', refresh_token: 'rotated-session', expires_in: '3600',
      id_token: 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature'
    });
  });
  const session = await refreshLauncherSession(config, saved, new AbortController().signal);
  assert.deepEqual(session, {
    uid: saved.uid, email: 'after@example.test', refreshToken: 'rotated-session', expiresAt: 3610000,
    idToken: 'header.' + Buffer.from(JSON.stringify({ sub: saved.uid, aud: config.projectId, email: 'after@example.test' }))
      .toString('base64url') + '.signature'
  });
});

test('launcher refresh distinguishes revocation from a transient failure', async t => {
  const refresh = () => refreshLauncherSession(config, saved, new AbortController().signal);
  const fetch = t.mock.method(undici, 'fetch', async () => Response.json({ error: { message: 'USER_DISABLED' } }, { status: 400 }));
  await assert.rejects(refresh, { cause: 'invalid-session' });
  fetch.mock.mockImplementation(async () => Response.json({}, { status: 503 }));
  await assert.rejects(refresh, { code: 'auth/network-request-failed' });
  fetch.mock.mockImplementation(async () => {
    const claims = { sub: saved.uid, aud: 'different-project' };
    return Response.json({
      user_id: saved.uid, refresh_token: 'rotated-session', expires_in: 3600,
      id_token: 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature'
    });
  });
  await assert.rejects(refresh, { cause: 'invalid-session' });
});
