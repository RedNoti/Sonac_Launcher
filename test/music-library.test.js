'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanMediaFolders, musicTags } = require('../src/music-library');

test('NAS music groups tracks by their actual folders and discovers cover images', async () => {
  const lists = {
    '/음악': [{ name: '가수', path: '/음악/가수', directory: true }, { name: '파일.mp3', path: '/음악/파일.mp3' }],
    '/음악/가수': [{ name: '앨범', path: '/음악/가수/앨범', directory: true }],
    '/음악/가수/앨범': [
      { name: '노래.flac', path: '/음악/가수/앨범/노래.flac' },
      { name: 'cover.jpg', path: '/음악/가수/앨범/cover.jpg' },
      { name: '뮤비.mp4', path: '/음악/가수/앨범/뮤비.mp4' }
    ]
  };
  const library = await scanMediaFolders('/음악', async folder => lists[folder]);
  assert.deepEqual(library.entries.map(({ name, album, cover }) => ({ name, album, cover })), [
    { name: '파일.mp3', album: '음악', cover: undefined },
    { name: '노래.flac', album: '앨범', cover: '/음악/가수/앨범/cover.jpg' }
  ]);
});

test('music tags decode the embedded front cover and artist from a cached file with no extension', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-artwork-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'preview');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=', 'base64');
  const frame = (id, value) => {
    const header = Buffer.alloc(10);
    header.write(id);
    header.writeUInt32BE(value.length, 4);
    return Buffer.concat([header, value]);
  };
  const id3 = Buffer.concat([
    frame('TIT2', Buffer.from('\0Example track')),
    frame('TPE1', Buffer.from('\0Example artist')),
    frame('APIC', Buffer.concat([Buffer.from('\0image/png\0\x03\0'), png]))
  ]);
  const tag = Buffer.concat([Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, id3.length >> 7, id3.length & 127]), id3]);
  const chunk = (id, data) => {
    const header = Buffer.alloc(8);
    header.write(id);
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
  };
  const pcm = Buffer.from('01000100401f0000803e000002001000', 'hex');
  const riff = chunk('RIFF', Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', pcm), chunk('id3 ', tag), chunk('data', Buffer.alloc(16000))]));
  await fs.writeFile(file, riff);
  const result = await musicTags(file);
  assert.equal(result.title, 'Example track');
  assert.equal(result.artist, 'Example artist');
  assert.equal(result.cover.type, 'image/png');
  assert.deepEqual(Buffer.from(result.cover.bytes), png);
});

test('video libraries find nested Matroska files and sidecar subtitles', async () => {
  const listings = {
    '/video': [{ name: 'Movie', path: '/video/Movie', directory: true }],
    '/video/Movie': [{ name: 'film.mkv', path: '/video/Movie/film.mkv' },
      { name: 'Subtitles', path: '/video/Movie/Subtitles', directory: true }],
    '/video/Movie/Subtitles': [{ name: 'film.ko.smi', path: '/video/Movie/Subtitles/film.ko.smi' }]
  };
  const library = await scanMediaFolders('/video', async folder => listings[folder], undefined, 'video');
  assert.equal(library.entries[0].folder, '/video/Movie');
  assert.equal(library.subtitles[0].name, 'film.ko.smi');
});
