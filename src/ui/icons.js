'use strict';

const outlines = {
  home: 'M7 22 24 8l17 14M11 19v21h10V28h6v12h10V19',
  up: 'M24 38V10m-10 10 10-10 10 10',
  grid: 'M8 8h12v12H8ZM28 8h12v12H28ZM8 28h12v12H8ZM28 28h12v12H28Z',
  list: 'M16 12h24M16 24h24M16 36h24M8 12h.01M8 24h.01M8 36h.01',
  pencil: 'M9 32 31 10l7 7-22 22-9 2Zm18-18 7 7',
  dsm: 'M11 9h26a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3Zm0 18h26a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3Zm3-12h.01M14 33h.01M22 15h12M22 33h12',
  files: 'M6 14a3 3 0 0 1 3-3h10l4 5h16a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3Z',
  eye: 'M5 24c4-7 11-12 19-12s15 5 19 12c-4 7-11 12-19 12S9 31 5 24Zm25 0a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  trash: 'M9 13h30M18 13V8h12v5M13 13l2 27h18l2-27M21 20v13M27 20v13',
  clear: 'M10 19v-9h9m10 0h9v9m0 10v9h-9m-10 0h-9v-9m9-10 10 10m0-10L19 29',
  downloads: 'M24 8v22m-8-8 8 8 8-8M9 34v3a3 3 0 0 0 3 3h24a3 3 0 0 0 3-3v-3',
  sync: 'M8 24a16 16 0 0 1 28-10.5M40 24a16 16 0 0 1-28 10.5M37 6v8h-8M11 42v-8h8',
  github: 'M18 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm0 28a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm20-20a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM14 14v20M34 22c0 8-10 6-20 12',
  terminal: 'M11 9h26a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5V14a5 5 0 0 1 5-5Zm4 11 6 5-6 5m10 1h8',
  account: 'M31 17a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM12 36c1-11 23-11 24 0',
  image: 'M8 10h32v28H8ZM9 32l10-9 8 7 5-5 7 6M30 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  audio: 'M20 34V13l17-4v20M20 34c0 4-10 7-10 2 0-4 10-7 10-2Zm17-5c0 4-10 7-10 2 0-4 10-7 10-2Z',
  video: 'M7 11h34v26H7ZM20 17v14l12-7Z',
  file: 'M13 7h14l9 9v25H13ZM27 7v10h9m-17 9h11m-11 6h11'
};

function icon(name, color = '#fff') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 144;
  canvas.setAttribute('aria-hidden', 'true');
  const draw = canvas.getContext('2d');
  draw.scale(3, 3);
  draw.strokeStyle = color;
  draw.lineWidth = 1.8;
  draw.lineCap = 'round';
  draw.lineJoin = 'round';
  draw.stroke(new Path2D(outlines[name]));
  return canvas;
}
