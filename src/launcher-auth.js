'use strict';

const { initializeApp, deleteApp } = require('firebase/app');
const { initializeAuth, inMemoryPersistence, signInWithEmailAndPassword } = require('firebase/auth');
const { httpsFetch } = require('./transport');

async function signInWithEmail({ firebaseConfig, email, password, signal }) {
  signal.throwIfAborted();
  const app = initializeApp(firebaseConfig, 'sonac-launcher');
  try {
    const auth = initializeAuth(app, { persistence: inMemoryPersistence });
    const { user } = await signInWithEmailAndPassword(auth, email, password);
    signal.throwIfAborted();
    if (!user.email) {
      throw new Error('확인된 계정 이메일을 받지 못했습니다.');
    }
    const token = await user.getIdTokenResult();
    signal.throwIfAborted();
    const expiresAt = Date.parse(token.expirationTime);
    if (!(expiresAt > Date.now())) throw new Error('Firebase 로그인 세션이 만료됐습니다.');
    return { uid: user.uid, email: user.email, idToken: token.token, expiresAt, refreshToken: user.refreshToken };
  } catch (error) {
    signal.throwIfAborted();
    const messages = {
      'auth/invalid-credential': '이메일 또는 비밀번호를 확인하세요.',
      'auth/invalid-email': '이메일 주소를 확인하세요.',
      'auth/wrong-password': '이메일 또는 비밀번호를 확인하세요.',
      'auth/user-not-found': '이메일 또는 비밀번호를 확인하세요.',
      'auth/user-disabled': '사용할 수 없는 계정입니다.',
      'auth/too-many-requests': '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
      'auth/network-request-failed': 'Firebase에 연결할 수 없습니다. 네트워크를 확인하세요.'
    };
    if (!error.code?.startsWith('auth/')) throw error;
    throw new Error(messages[error.code] || 'Firebase 로그인 설정을 확인하세요. (' + error.code + ')');
  } finally {
    await deleteApp(app);
  }
}

async function refreshLauncherSession(firebaseConfig, { uid, email, refreshToken }, signal) {
  const expired = () => new Error('저장된 로그인이 만료됐습니다. 다시 로그인하세요.', { cause: 'invalid-session' });
  if (typeof uid !== 'string' || !uid || typeof email !== 'string' || !email ||
      typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 8192) throw expired();
  const url = new URL('https://securetoken.googleapis.com/v1/token');
  url.searchParams.set('key', firebaseConfig.apiKey);
  const unavailable = () => Object.assign(new Error('Firebase에 연결할 수 없습니다. 네트워크를 확인하세요.'),
    { code: 'auth/network-request-failed' });
  let response, data;
  try {
    response = await httpsFetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
    });
    data = await response.json();
  } catch {
    signal.throwIfAborted();
    throw unavailable();
  }
  if (response.status === 429 || response.status >= 500) throw unavailable();
  if (!response.ok) {
    if (['TOKEN_EXPIRED', 'INVALID_REFRESH_TOKEN', 'USER_DISABLED', 'USER_NOT_FOUND',
      'PROJECT_NUMBER_MISMATCH', 'INVALID_GRANT'].includes(data?.error?.message)) throw expired();
    throw new Error('Firebase 세션을 갱신할 수 없습니다. 다시 로그인하세요.');
  }
  const lifetime = Number(data?.expires_in);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url'));
  } catch {
    throw expired();
  }
  if (data?.user_id !== uid || claims?.sub !== uid ||
      (firebaseConfig.projectId && claims.aud !== firebaseConfig.projectId) ||
      typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 8192 ||
      !Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > 86400) throw expired();
  return { uid, email: typeof claims.email === 'string' && claims.email ? claims.email : email,
    idToken: data.id_token, refreshToken: data.refresh_token, expiresAt: Date.now() + lifetime * 1000 };
}

module.exports = { signInWithEmail, refreshLauncherSession };
