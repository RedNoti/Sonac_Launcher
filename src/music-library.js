'use strict';

const { mediaKind } = require('./preview');

const folderLimit = 160;
const depthLimit = 6;
const trackLimit = 5000;
const imageLimit = 4 * 1024 ** 2;

function coverFile(entry) {
  return !entry.directory && /^(?:cover|folder|front|albumart)\.(?:jpe?g|png|webp)$/iu.test(entry.name) &&
    !(entry.size > imageLimit);
}

function artwork(data) {
  if (!data?.length || data.length > imageLimit) return undefined;
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let type;
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) type = 'image/jpeg';
  else if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) type = 'image/png';
  else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') type = 'image/webp';
  return type && { type, bytes: Uint8Array.from(bytes) };
}

async function readArtwork(response) {
  if (!response.body) return undefined;
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > imageLimit) return undefined;
    chunks.push(chunk);
  }
  return artwork(Buffer.concat(chunks, length));
}

async function musicTags(filename) {
  try {
    const { parseFile, selectCover } = await import('music-metadata');
    const { common, format } = await parseFile(filename, { maxMemoryAllocation: 8 * 1024 ** 2 });
    const cover = selectCover(common.picture);
    return {
      title: common.title?.slice(0, 300), artist: common.artist?.slice(0, 300),
      album: common.album?.slice(0, 300), duration: format.duration,
      cover: artwork(cover?.data)
    };
  } catch {
    return {};
  }
}

async function scanMediaFolders(root, list, signal, kind = 'audio') {
  const folders = [{ path: root, name: root.split('/').at(-1) || '선택한 폴더', depth: 0 }];
  const seen = new Set([root]);
  const entries = [];
  const subtitles = [];
  let truncated = false;
  let skipped = 0;
  for (const folder of folders) {
    signal?.throwIfAborted();
    let items;
    try { items = await list(folder.path); }
    catch (error) {
      signal?.throwIfAborted();
      if (!folder.depth || error.name === 'AbortError') throw error;
      skipped++;
      continue;
    }
    const cover = kind === 'audio' ? items.find(coverFile) : undefined;
    for (const item of items) {
      if (item.directory && !seen.has(item.path) && item.path.startsWith(folder.path === '/' ? '/' : folder.path + '/')) {
        if (folder.depth >= depthLimit || folders.length >= folderLimit) {
          truncated = true;
          continue;
        }
        seen.add(item.path);
        folders.push({ path: item.path, name: item.name, depth: folder.depth + 1 });
      }
      if (kind === 'video' && !item.directory && /\.(?:srt|vtt|ass|ssa|smi)$/iu.test(item.name) && subtitles.length < trackLimit) {
        subtitles.push({ ...item, folder: folder.path });
      }
      if (mediaKind(item) !== kind) continue;
      if (entries.length >= trackLimit) return { entries, subtitles, truncated: true, skipped };
      entries.push({ ...item, folder: folder.path, album: kind === 'audio' ? folder.name : undefined, cover: cover?.path });
    }
  }
  return { entries, subtitles, truncated, skipped };
}

module.exports = { scanMediaFolders, musicTags, coverFile, readArtwork };
