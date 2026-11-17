'use strict';

const fs = require('node:fs/promises');
const { constants, createWriteStream } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Transform } = require('node:stream');
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
  'media-subtitles.mjs': 'text/javascript; charset=utf-8',
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
  ['video', 512, { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska' }],
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

const active = new Map();

function fileFormat(entry) {
  return entry.directory ? undefined : formats.get(path.extname(entry.name).slice(1).toLowerCase());
}

function mediaKind(entry) {
  return fileFormat(entry)?.kind;
}

async function dispose(job) {
  if (!job) return;
  job.controller.abort();
  await Promise.allSettled([job.preparing, job.converting]);
  await job.caching;
  await job.handle?.close().catch(() => {});
  if (job.temp) await fs.rm(job.temp, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
}

async function clearPreview(id) {
  const closing = [];
  for (const [channel, job] of active) {
    if (id && job.id !== id) continue;
    active.delete(channel);
    closing.push(dispose(job));
  }
  await Promise.all(closing);
}

async function cacheVideo(job, download, signal) {
  const response = await download(signal);
  if (!response.body) throw new Error('NAS가 영상 데이터를 반환하지 않았습니다.');
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    if (job.available + chunk.length > job.size) {
      throw new Error('NAS의 영상 크기가 변경됐습니다. 영상을 다시 선택하세요.');
    }
    await job.handle.writeFile(chunk);
    job.available += chunk.length;
  }
  if (job.available !== job.size) throw new Error('NAS에서 영상 데이터를 끝까지 읽지 못했습니다.');
}

async function createPreview(id, entry, { filename, download, signal, player, slot = player, metadata }) {
  const format = fileFormat(entry);
  if (!format || (player && format.kind !== player)) throw new Error('이 형식의 파일은 앱에서 재생하거나 미리 볼 수 없습니다.');
  const type = player === 'video' ? { ...format, limit: Infinity } : format;
  checkSize(entry.size, type.limit);
  const channel = slot || 'preview';
  const previous = active.get(channel);
  if (previous) void dispose(previous);
  const job = { id, controller: new AbortController(), filename, type };
  active.set(channel, job);
  const abort = AbortSignal.any([signal, job.controller.signal]);
  const progressive = player === 'video' && download && Number.isSafeInteger(entry.size) && entry.size > 0;
  job.preparing = (async () => {
    abort.throwIfAborted();
    if (download) {
      job.temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-preview-'));
      job.filename = path.join(job.temp, 'preview');
      if (progressive) {
        job.handle = await fs.open(job.filename, 'wx+', 0o600);
        abort.throwIfAborted();
        job.size = entry.size;
        job.available = 0;
        job.caching = cacheVideo(job, download, abort).catch(error => { job.cacheError = error; });
        return;
      }
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
    const tags = metadata ? await metadata(job.filename) : undefined;
    abort.throwIfAborted();
    return { kind: type.kind, url: origin + '/preview/' + id, mime: type.mime, metadata: tags };
  } catch (error) {
    if (active.get(channel) === job) await clearPreview(id);
    throw error;
  }
}

async function ffmpegVideo(input, output, signal) {
  const executables = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']
    : process.platform === 'win32' ? ['ffmpeg.exe', 'C:/ffmpeg/bin/ffmpeg.exe'] : ['ffmpeg'];
  const args = ['-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file', '-f', 'matroska', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-vf', 'scale=min(1920\\,iw):-2',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '7', '-b:v', '0', '-crf', '32',
    '-c:a', 'libopus', '-f', 'webm', output];
  for (const executable of executables) {
    signal.throwIfAborted();
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { signal, windowsHide: true, stdio: 'ignore' });
        let launchError;
        child.once('error', error => { launchError = error; });
        child.once('close', code => {
          if (launchError) reject(launchError);
          else if (code === 0) resolve();
          else reject(new Error('MKV를 호환 영상으로 변환하지 못했습니다.'));
        });
      });
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('이 MKV의 코덱을 직접 재생할 수 없습니다. 호환 재생을 사용하려면 이 PC에 FFmpeg를 설치하세요.');
}

async function compatibleVideo(id, signal) {
  const job = active.get('video');
  if (!job || job.id !== id || job.type.mime !== 'video/x-matroska' || !job.temp) {
    throw new Error('다시 열 수 있는 MKV 파일을 선택하세요.');
  }
  if (job.converting) throw new Error('이미 영상을 변환 중입니다.');
  const abort = AbortSignal.any([signal, job.controller.signal, AbortSignal.timeout(60 * 60 * 1000)]);
  const output = path.join(job.temp, 'compatible.webm');
  job.converting = (async () => {
    await job.caching;
    abort.throwIfAborted();
    if (job.cacheError) throw job.cacheError;
    await ffmpegVideo(job.filename, output, abort);
    abort.throwIfAborted();
    const handle = await fs.open(output, 'r');
    try {
      const info = await handle.stat();
      abort.throwIfAborted();
      if (!info.size) throw new Error('변환한 영상이 비어 있습니다.');
      const original = job.handle;
      job.handle = handle;
      job.size = info.size;
      job.available = undefined;
      await original?.close();
      job.type = { ...job.type, mime: 'video/webm' };
      return { url: origin + '/preview/' + id + '?compatible=1' };
    } catch (error) {
      if (job.handle !== handle) await handle.close();
      throw error;
    }
  })();
  try { return await job.converting; }
  finally { job.converting = undefined; }
}

// A cancelled HTTP range must not close the shared file handle used by the next seek.
async function* fileBytes(job, start, end, signal) {
  const handle = job.handle;
  const growing = job.available !== undefined;
  while (start <= end && handle === job.handle && !signal.aborted && !job.controller.signal.aborted) {
    const available = growing ? job.available : end + 1;
    if (start >= available) {
      if (job.cacheError) throw job.cacheError;
      await delay(100);
      continue;
    }
    const buffer = Buffer.allocUnsafe(Math.min(available - start, end - start + 1, 128 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (!bytesRead) throw new Error('영상 파일을 읽지 못했습니다.');
    yield buffer.subarray(0, bytesRead);
    start += bytesRead;
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
  const job = [...active.values()].find(item => url.pathname === '/preview/' + item.id);
  if (!job || !Number.isSafeInteger(job?.size)) {
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
  let stream = null;
  if (request.method !== 'HEAD' && job.size > 0) {
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const bytes = fileBytes(job, bounds?.start ?? 0, bounds?.end ?? job.size - 1, signal);
    stream = new ReadableStream({
      async pull(output) {
        const { value, done } = await bytes.next();
        if (controller.signal.aborted) return;
        if (done || signal.aborted) output.close();
        else output.enqueue(value);
      },
      cancel() {
        controller.abort();
        return bytes.return();
      }
    });
  }
  return new Response(stream, { headers, status: bounds ? 206 : 200 });
}

module.exports = { origin, createPreview, clearPreview, compatibleVideo, mediaKind, serve };
