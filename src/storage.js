'use strict';

const { randomUUID } = require('node:crypto');
const { openAsBlob } = require('node:fs');
const { SaxesParser } = require('saxes');

const APIS = {
  auth: 'SYNO.API.Auth',
  list: 'SYNO.FileStation.List',
  download: 'SYNO.FileStation.Download',
  upload: 'SYNO.FileStation.Upload'
};
const DSM_ERRORS = {
  105: '이 계정에는 File Station 사용 권한이 없습니다.',
  106: '로그인 세션이 만료됐습니다.',
  107: '로그인 세션이 종료됐습니다.',
  119: '로그인 세션이 만료됐습니다.',
  400: 'DSM 사용자 이름 또는 비밀번호를 확인하세요.',
  401: 'DSM 계정이 비활성화됐거나 이 작업에 필요한 권한이 없습니다.',
  402: 'DSM 계정 또는 파일에 대한 접근이 거부됐습니다.',
  403: '인증 앱에서 생성한 6자리 OTP를 입력하세요.',
  404: 'DSM이 OTP를 확인하지 못했습니다.',
  407: 'DSM에서 이 IP의 로그인을 차단했습니다.',
  408: 'DSM 비밀번호를 변경한 후 다시 로그인하세요.',
  409: 'DSM 계정의 비밀번호가 만료됐습니다.',
  414: 'DSM 계정 보안 설정에서 이 로그인을 허용하는지 확인하세요.',
  416: 'DSM에서 이 계정의 2단계 인증을 설정해야 합니다.',
  417: 'DSM에서 이 계정의 로그인을 일시적으로 차단했습니다.',
  418: 'DSM 계정이 비활성화됐습니다.',
  1805: 'NAS에 같은 이름의 파일이 이미 있습니다.'
};

function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('저장소 경로가 올바르지 않습니다.');
  }
  const segments = value.replace(/\/$/u, '').split('/').slice(1);
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('저장소 경로가 올바르지 않습니다.');
  }
  return segments.length ? '/' + segments.join('/') : '/';
}

function childPath(parent, name) {
  if (typeof name !== 'string' || !name || name.includes('/')) {
    throw new Error('저장소 파일 이름이 올바르지 않습니다.');
  }
  return remotePath(parent === '/' ? '/' + name : parent + '/' + name);
}

function endpoint(value, provider) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('https://로 시작하는 저장소 주소를 입력하세요.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('계정 정보, 쿼리, 해시를 제외한 HTTPS 주소를 입력하세요.');
  }
  if (provider === 'synology' && url.pathname !== '/') {
    throw new Error('DSM 주소에서 경로를 빼고 호스트와 포트만 입력하세요.');
  }
  return provider === 'synology' ? url.origin : url.href.replace(/\/$/u, '') + '/';
}

async function request(url, options = {}, signal, timeout = 30000) {
  const limit = AbortSignal.timeout(timeout);
  try {
    const response = await fetch(url, {
      ...options, redirect: 'manual', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, limit]) : limit
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('서버가 다른 주소로 이동시켰습니다. 최종 HTTPS 주소를 입력하세요.');
    }
    return response;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (limit.aborted) throw new Error('저장소 응답 시간이 초과됐습니다.');
    const code = error.cause?.code;
    if (code?.includes('CERT') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      throw new Error('서버의 TLS 인증서를 확인할 수 없습니다. 인증서에 등록된 도메인과 신뢰 체인을 확인하세요.');
    }
    if (error instanceof TypeError) throw new Error('저장소에 연결할 수 없습니다. 주소, 포트, 네트워크를 확인하세요.');
    throw error;
  }
}

async function checked(response) {
  if (response.ok) return response;
  await response.body?.cancel();
  const errors = {
    401: '사용자 이름과 비밀번호를 확인하세요.',
    403: '이 작업에 필요한 저장소 권한을 확인하세요.',
    404: '저장소 주소 또는 파일 경로를 찾을 수 없습니다.',
    405: '이 주소에서 요청한 저장소 기능을 사용할 수 없습니다.',
    412: '서버에 같은 이름의 파일이 이미 있습니다.',
    413: '서버의 업로드 크기 제한을 초과했습니다.',
    507: '저장소 공간이 부족합니다.'
  };
  throw new Error(`${errors[response.status] || '저장소 요청에 실패했습니다.'} (HTTP ${response.status})`);
}

async function dsmJSON(response) {
  await checked(response);
  const payload = await response.json().catch(() => {
    throw new Error('DSM API 응답을 읽을 수 없습니다. DSM 직접 접속 주소를 확인하세요.');
  });
  if (payload?.success === true) return payload.data;
  const code = Number(payload?.error?.code);
  const error = new Error(Number.isInteger(code)
    ? `${DSM_ERRORS[code] || 'DSM 요청이 실패했습니다.'} (DSM ${code})`
    : 'DSM API 응답 형식이 올바르지 않습니다.');
  error.dsmCode = code;
  throw error;
}

class Synology {
  constructor(profile) {
    this.profile = profile;
    this.methods = {};
    this.session = null;
  }

  async connect(secret, otp, remember, signal) {
    const infoURL = new URL('/webapi/query.cgi', this.profile.url);
    infoURL.search = new URLSearchParams({
      api: 'SYNO.API.Info', version: '1', method: 'query', query: Object.values(APIS).join(',')
    });
    const info = await dsmJSON(await request(infoURL, {}, signal));
    const supported = { auth: 6, list: 2, download: 2, upload: 2 };
    for (const [type, api] of Object.entries(APIS)) {
      const entry = info?.[api];
      const version = Math.max(Number(entry?.minVersion), Math.min(supported[type], Number(entry?.maxVersion)));
      if (!/^(?:[\w-]+\/)*[\w.-]+\.cgi$/u.test(entry?.path || '') || !Number.isInteger(version) ||
          version > Number(entry.maxVersion) || (type !== 'auth' && version < 2)) {
        throw new Error('DSM File Station API를 찾을 수 없습니다. NAS에서 File Station 패키지 상태를 확인하세요.');
      }
      this.methods[type] = { api, version: String(version), url: new URL('/webapi/' + entry.path, this.profile.url) };
    }
    const auth = {
      account: this.profile.user, passwd: secret.password, session: 'FileStation',
      format: 'sid', enable_syno_token: 'yes'
    };
    if (otp) auth.otp_code = otp;
    if (secret.deviceId) auth.device_id = secret.deviceId;
    if (remember && (otp || secret.deviceId)) {
      auth.enable_device_token = 'yes';
      auth.device_name = 'sonac launcher';
    }
    const data = await dsmJSON(await this.post('auth', 'login', auth, signal));
    if (typeof data?.sid !== 'string' || !data.sid) throw new Error('DSM 로그인 세션을 받을 수 없습니다.');
    this.session = { _sid: data.sid };
    if (typeof data.synotoken === 'string' && data.synotoken) this.session.SynoToken = data.synotoken;
    try {
      await this.list('/', signal);
    } catch (error) {
      await this.logout();
      throw error;
    }
    return { password: secret.password, deviceId: data.did || secret.deviceId };
  }

  parameters(type, method, values) {
    const { api, version } = this.methods[type];
    const session = type === 'auth' && method === 'login' ? null : this.session;
    return { api, version, method, ...session, ...values };
  }

  post(type, method, values, signal, timeout) {
    return request(this.methods[type].url, {
      method: 'POST', body: new URLSearchParams(this.parameters(type, method, values))
    }, signal, timeout);
  }

  async list(folder, signal) {
    folder = remotePath(folder);
    const root = folder === '/';
    const entries = [];
    const fields = root ? {} : { additional: '["size","time"]', folder_path: JSON.stringify(folder) };
    let offset = 0;
    do {
      const data = await dsmJSON(await this.post('list', root ? 'list_share' : 'list', {
        ...fields, offset: String(offset), limit: '250'
      }, signal));
      const rows = root ? data?.shares : data?.files;
      if (!Array.isArray(rows)) throw new Error('DSM 파일 목록 응답이 올바르지 않습니다.');
      for (const row of rows) {
        const path = childPath(folder, row.name);
        if (row.path !== path) throw new Error('DSM에서 예상과 다른 파일 경로를 반환했습니다.');
        entries.push({
          name: row.name, path, directory: root || row.isdir === true,
          size: typeof row.additional?.size === 'number' ? row.additional.size : null,
          modified: typeof row.additional?.time?.mtime === 'number' ? row.additional.time.mtime * 1000 : null
        });
      }
      offset += rows.length;
      if (!rows.length || offset >= Number(data.total ?? offset)) break;
      if (offset > 1000000) throw new Error('DSM 파일 목록이 너무 큽니다.');
    } while (true);
    return entries;
  }

  async download(path, signal) {
    const response = await checked(await this.post('download', 'download', {
      path: JSON.stringify([remotePath(path)]), mode: 'download'
    }, signal, 3600000));
    if (!response.headers.has('content-disposition') &&
        /^(?:application\/json|text\/html)/iu.test(response.headers.get('content-type') || '')) {
      await dsmJSON(response);
      throw new Error('DSM이 파일 대신 상태 응답을 반환했습니다.');
    }
    return response;
  }

  async upload(folder, name, content, { overwrite = false, signal } = {}) {
    childPath(folder, name);
    if (/["\\\r\n]/u.test(name)) throw new Error('DSM에 업로드할 수 없는 파일 이름입니다.');
    const fields = this.parameters('upload', 'upload', {
      path: remotePath(folder), create_parents: 'false'
    });
    if (overwrite) fields.overwrite = fields.version === '2' ? 'true' : 'overwrite';
    const boundary = randomUUID();
    const preamble = Buffer.from(Object.entries(fields).map(([key, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    ).join('') + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
    async function* parts() {
      yield preamble;
      yield* content.stream();
      yield ending;
    }
    await dsmJSON(await request(this.methods.upload.url, {
      method: 'POST', duplex: 'half', body: parts(),
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': String(preamble.length + content.size + ending.length)
      }
    }, signal, 3600000));
  }

  async logout() {
    if (!this.session) return;
    try {
      const response = await this.post('auth', 'logout', { session: 'FileStation' }, undefined, 5000);
      await response.body?.cancel();
    } catch {
      // Local logout still completes when the NAS is offline.
    } finally {
      this.session = null;
    }
  }
}

const PROPFIND = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

function davResponses(xml) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const rows = [];
  let row;
  let prop;
  let text = '';
  let multistatus = false;
  parser.on('doctype', () => { throw new Error('지원하지 않는 WebDAV 응답입니다.'); });
  parser.on('opentag', tag => {
    const name = tag.uri === 'DAV:' ? tag.local : '';
    stack.push(name);
    text = '';
    if (stack.length === 1) multistatus = name === 'multistatus';
    if (name === 'response' && stack.length === 2) row = { properties: {} };
    if (row && name === 'propstat') prop = {};
    if (prop && name === 'collection' && stack.at(-2) === 'resourcetype') prop.directory = true;
    if (prop && name === 'resourcetype') prop.hasType = true;
  });
  parser.on('text', value => { text += value; });
  parser.on('closetag', () => {
    const name = stack.pop();
    if (row && name === 'href' && stack.at(-1) === 'response') row.href = text.trim();
    if (prop && ['status', 'getcontentlength', 'getlastmodified'].includes(name)) prop[name] = text.trim();
    if (row && prop && name === 'propstat') {
      if (/^HTTP\/\S+ 200(?: |$)/u.test(prop.status || '')) Object.assign(row.properties, prop);
      prop = undefined;
    }
    if (row && name === 'response' && stack.length === 1) {
      rows.push(row);
      row = undefined;
    }
    text = '';
  });
  try {
    parser.write(xml).close();
    if (!multistatus) throw new Error();
    return rows;
  } catch {
    throw new Error('WebDAV 파일 목록을 읽을 수 없습니다.');
  }
}

class WebDAV {
  constructor(profile) {
    this.profile = profile;
    this.base = new URL(profile.url);
  }

  async connect(secret, _otp, _remember, signal) {
    if (this.profile.user.includes(':')) throw new Error('WebDAV 사용자 이름에 콜론을 사용할 수 없습니다.');
    this.authorization = 'Basic ' + Buffer.from(this.profile.user + ':' + secret.password).toString('base64');
    await this.list('/', signal);
    return { password: secret.password };
  }

  url(path, directory = false) {
    const suffix = remotePath(path).split('/').slice(1).map(encodeURIComponent).join('/');
    return new URL(this.base.href + suffix + (suffix && directory ? '/' : ''));
  }

  send(url, options, signal, timeout) {
    return request(url, {
      ...options, headers: { Authorization: this.authorization, ...options.headers }
    }, signal, timeout).then(checked);
  }

  async list(folder, signal) {
    folder = remotePath(folder);
    const url = this.url(folder, true);
    const response = await this.send(url, {
      method: 'PROPFIND', body: PROPFIND,
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }
    }, signal);
    if (response.status !== 207) {
      await response.body?.cancel();
      throw new Error('서버가 WebDAV 파일 목록을 반환하지 않았습니다.');
    }
    const files = [];
    let collection = false;
    const parent = decodeURIComponent(url.pathname);
    for (const row of davResponses(await response.text())) {
      if (!row.href || !row.properties.hasType) continue;
      const href = new URL(row.href, url);
      if (href.origin !== url.origin || href.search || href.hash) continue;
      const path = decodeURIComponent(href.pathname).replace(/\/$/u, '');
      if (path === parent.slice(0, -1)) {
        collection = row.properties.directory === true;
        continue;
      }
      if (!path.startsWith(parent)) continue;
      const name = path.slice(parent.length);
      if (!name || name.includes('/')) continue;
      const { directory, getcontentlength, getlastmodified } = row.properties;
      files.push({
        name, path: childPath(folder, name), directory: directory === true,
        size: /^\d+$/u.test(getcontentlength) ? Number(getcontentlength) : null,
        modified: Date.parse(getlastmodified) || null
      });
    }
    if (!collection) throw new Error('WebDAV에서 공유 폴더를 확인할 수 없습니다.');
    return files;
  }

  download(path, signal) {
    return this.send(this.url(path), { method: 'GET' }, signal, 3600000);
  }

  async upload(folder, name, content, { overwrite = false, signal } = {}) {
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(content.size) };
    if (!overwrite) headers['If-None-Match'] = '*';
    const response = await this.send(this.url(childPath(folder, name)), {
      method: 'PUT', body: content, headers
    }, signal, 3600000);
    await response.body?.cancel();
  }

  async logout() {
    this.authorization = undefined;
  }
}

function storage(profile) {
  return profile.provider === 'synology' ? new Synology(profile) : new WebDAV(profile);
}

module.exports = { storage, endpoint, remotePath, childPath, openAsBlob };
