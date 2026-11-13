'use strict';

function profileBinding(profile) {
  return JSON.stringify([profile.provider, profile.url, profile.user, profile.pin || '']);
}

function wrapped(record) {
  return record?.version === 2 && typeof record.ciphertext === 'string' && record.ciphertext.length <= 32768;
}

async function seal(safeStorage, binding, value) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('운영체제에서 로그인 정보를 보호할 수 없습니다.');
  }
  const ciphertext = await safeStorage.encryptStringAsync(JSON.stringify({ binding, value }));
  return { version: 2, ciphertext: ciphertext.toString('base64') };
}

async function unseal(safeStorage, record, binding) {
  if (!wrapped(record)) throw new Error('보안 설정이 변경되었습니다. 다시 로그인하세요.');
  const { result } = await safeStorage.decryptStringAsync(Buffer.from(record.ciphertext, 'base64'));
  const saved = JSON.parse(result);
  if (saved.binding !== binding) throw new Error('저장된 로그인 정보가 이 계정 또는 서버와 일치하지 않습니다.');
  return saved.value;
}

module.exports = { profileBinding, wrapped, seal, unseal };
