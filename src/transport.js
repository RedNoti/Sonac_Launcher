'use strict';

const { createHash, X509Certificate } = require('node:crypto');
const { checkServerIdentity } = require('node:tls');
const undici = require('undici');
const { Agent } = undici;

const secure = new Agent({ connect: { rejectUnauthorized: true, minVersion: 'TLSv1.2' } });

function certificatePin(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new Error('NAS 인증서 공개 키 지문을 확인하세요.');
  const pin = value.trim();
  if (!pin) return '';
  if (!/^sha256\/[A-Za-z0-9+/]{43}=$/u.test(pin) ||
      Buffer.from(pin.slice(7), 'base64').toString('base64') !== pin.slice(7)) {
    throw new Error('NAS 인증서 공개 키 지문을 sha256/Base64 형식으로 입력하세요.');
  }
  return pin;
}

function verifyPeer(host, cert, pin) {
  const error = checkServerIdentity(host, cert);
  if (error) return error;
  const key = new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
  if ('sha256/' + createHash('sha256').update(key).digest('base64') !== pin) {
    return Object.assign(new Error('NAS 인증서 공개 키가 등록한 값과 다릅니다.'), { code: 'SONAC_CERT_PIN' });
  }
}

function pinnedDispatcher(pin) {
  if (!pin) return undefined;
  return new Agent({ connect: {
    rejectUnauthorized: true, minVersion: 'TLSv1.2',
    checkServerIdentity: (host, cert) => verifyPeer(host, cert, pin)
  } });
}

function httpsFetch(url, { dispatcher = secure, ...options } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('HTTPS 연결만 허용됩니다.');
  return undici.fetch(target, { ...options, dispatcher });
}

module.exports = { certificatePin, verifyPeer, pinnedDispatcher, httpsFetch };
