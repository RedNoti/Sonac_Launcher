'use strict';

const fs = require('node:fs/promises');
const { constants, createWriteStream } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const os = require('node:os');
const path = require('node:path');

const origin = 'sonac://app';
const ui = path.join(__dirname, 'ui');
const dependencies = path.join(__dirname, '..', 'node_modules');
const files = {
  'index.html': 'text/html; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'workspace-ui.js': 'text/javascript; charset=utf-8',
  'icons.js': 'text/javascript; charset=utf-8',
  'preview-ui.mjs': 'text/javascript; charset=utf-8',
  'terminal-ui.mjs': 'text/javascript; charset=utf-8',
  'terminal.html': 'text/html; charset=utf-8',
  'prompt.html': 'text/html; charset=utf-8',
  'prompt.js': 'text/javascript; charset=utf-8',
  'app.png': 'image/png',
  'brand-dark.png': 'image/png',
  'brand-light.png': 'image/png'
};
const vendorFiles = {
  'fflate.mjs': ['fflate/esm/browser.js', 'text/javascript'],
  'xterm.mjs': ['@xterm/xterm/lib/xterm.mjs', 'text/javascript'],
  'fit.mjs': ['@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript'],
  'xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css']
};
const formats = new Map();
for (const [kind, limit, types] of [
  ['image', 64, { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon' }],
  ['audio', 512, { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4',
    aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg' }],
  ['video', 512, { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }],
  ['pdf', 64, { pdf: 'application/pdf' }],
  ['word', 24, { docx: 'application/octet-stream' }],
  ['text', 4, Object.fromEntries(['txt', 'md', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml']
    .map(extension => [extension, 'text/plain; charset=utf-8']))]
]) {
  for (const [extension, mime] of Object.entries(types)) formats.set(extension, { kind, mime, limit: limit * 1024 ** 2 });
}

function asset(pathname) {
  const name = pathname.slice(1);
  if (Object.hasOwn(files, name)) return { filename: path.join(ui, name), mime: files[name] };
  const vendor = name.startsWith('vendor/') && name.slice(7);
  if (vendor && Object.hasOwn(vendorFiles, vendor)) {
    const [filename, mime] = vendorFiles[vendor];
    return { filename: path.join(dependencies, filename), mime };
  }
  const library = /^vendor\/pdfjs\/(build\/pdf(?:\.worker)?\.min\.mjs|(?:cmaps|standard_fonts|wasm|iccs)\/[\w.-]+\.(?:bcmap|ttf|pfb|wasm|js|icc))$/u.exec(name);
  if (library) {
    const filename = path.join(dependencies, 'pdfjs-dist', library[1]);
    const extension = path.extname(filename);
    const mime = ['.mjs', '.js'].includes(extension) ? 'text/javascript' :
      extension === '.wasm' ? 'application/wasm' : 'application/octet-stream';
    return { filename, mime };
  }
  return null;
}

function checkSize(size, limit) {
  if (Number.isFinite(size) && size > limit) {
    throw new Error('이 파일은 미리보기 크기 제한을 초과했습니다.');
  }
}

function byteRange(value, size) {
  const parts = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!parts || (!parts[1] && !parts[2]) || size === 0) return null;
  const start = parts[1] ? Number(parts[1]) : Math.max(0, size - Number(parts[2]));
  const end = parts[1] && parts[2] ? Math.min(Number(parts[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end ? { start, end } : null;
}

let active;

async function dispose(job) {
  if (!job) return;
  job.controller.abort();
  try { await job.preparing; } catch { /* canceled or failed */ }
  await job.handle?.close().catch(() => {});
  if (job.temp) await fs.rm(job.temp, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
}

async function clearPreview(id) {
  if (!active || (id && active.id !== id)) return;
  const job = active;
  active = undefined;
  await dispose(job);
}

async function createPreview(id, entry, { filename, download, signal }) {
  const type = formats.get(path.extname(entry.name).slice(1).toLowerCase());
  if (!type || entry.directory) throw new Error('이 형식의 파일은 앱에서 미리 볼 수 없습니다.');
  checkSize(entry.size, type.limit);
  void clearPreview();
  const job = { id, controller: new AbortController(), filename, type };
  active = job;
  const abort = AbortSignal.any([signal, job.controller.signal]);
  job.preparing = (async () => {
    abort.throwIfAborted();
    if (download) {
      job.temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-preview-'));
      job.filename = path.join(job.temp, 'preview');
      const response = await download(abort);
      let size = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          try {
            checkSize(size, type.limit);
            callback(null, chunk);
          } catch (error) {
            callback(error);
          }
        }
      });
      if (!response.body) throw new Error('저장소가 파일 내용을 반환하지 않았습니다.');
      await pipeline(response.body, limit, createWriteStream(job.filename, { flags: 'wx', mode: 0o600 }), { signal: abort });
    }
    if (!(await fs.lstat(job.filename)).isFile()) throw new Error('미리 볼 수 있는 파일을 선택하세요.');
    job.handle = await fs.open(job.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await job.handle.stat();
    if (!info.isFile()) throw new Error('미리 볼 수 있는 파일을 선택하세요.');
    checkSize(info.size, type.limit);
    abort.throwIfAborted();
    job.size = info.size;
  })();
  try {
    await job.preparing;
    return { kind: type.kind, url: origin + '/preview/' + id, mime: type.mime };
  } catch (error) {
    if (active === job) await clearPreview(id);
    throw error;
  }
}

async function serve(request, hostname = 'app') {
  const url = new URL(request.url);
  const terminal = new Set(['/terminal.html', '/terminal-ui.mjs', '/style.css', '/vendor/xterm.css',
    '/vendor/xterm.mjs', '/vendor/fit.mjs']);
  const prompt = new Set(['/prompt.html', '/prompt.js', '/style.css']);
  const allowed = hostname === 'terminal' ? terminal.has(url.pathname) || url.pathname === '/icons.js' :
    hostname === 'prompt' ? prompt.has(url.pathname) || url.pathname === '/icons.js' :
      url.pathname === '/style.css' || (!terminal.has(url.pathname) && !prompt.has(url.pathname));
  if (url.protocol !== 'sonac:' || url.host !== hostname || !['GET', 'HEAD'].includes(request.method) || !allowed) {
    return new Response(null, { status: 404 });
  }
  const source = asset(url.pathname);
  if (source) {
    try {
      return new Response(request.method === 'HEAD' ? null : await fs.readFile(source.filename), {
        headers: { 'Content-Type': source.mime, 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; frame-src 'none'" }
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  const job = active;
  if (url.pathname !== '/preview/' + job?.id || !Number.isSafeInteger(job?.size)) {
    return new Response(null, { status: 404 });
  }
  const headers = {
    'Content-Type': job.type.mime, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox"
  };
  const range = request.headers.get('range');
  const bounds = range ? byteRange(range, job.size) : null;
  if (range && !bounds) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + job.size } });
  }
  headers['Content-Length'] = String(bounds ? bounds.end - bounds.start + 1 : job.size);
  if (bounds) headers['Content-Range'] = 'bytes ' + bounds.start + '-' + bounds.end + '/' + job.size;
  const stream = request.method === 'HEAD' || job.size === 0 ? null :
    Readable.toWeb(job.handle.createReadStream({ start: 0, ...bounds, autoClose: false, signal: job.controller.signal }));
  return new Response(stream, { headers, status: bounds ? 206 : 200 });
}

module.exports = { origin, createPreview, clearPreview, serve };
