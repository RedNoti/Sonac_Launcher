'use strict';

const outlines = {
  dsm: 'M11 9h26a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3Zm0 18h26a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3Zm3-12h.01M14 33h.01M22 15h12M22 33h12',
  drive: 'M14 36a9 9 0 0 1-1-17.9A11 11 0 0 1 34 16a10 10 0 0 1 1 20ZM24 31V21m-4 4 4-4 4 4',
  photos: 'M12 9h24a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H12a5 5 0 0 1-5-5V14a5 5 0 0 1 5-5Zm8 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM8 34l10-9 8 7 6-5 9 8',
  containers: 'M24 6l15 8v20l-15 8-15-8V14Zm-15 8 15 8 15-8M24 22v20',
  files: 'M6 14a3 3 0 0 1 3-3h10l4 5h16a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3Z',
  downloads: 'M24 8v22m-8-8 8 8 8-8M9 34v3a3 3 0 0 0 3 3h24a3 3 0 0 0 3-3v-3',
  sync: 'M8 24a16 16 0 0 1 28-10.5M40 24a16 16 0 0 1-28 10.5M37 6v8h-8M11 42v-8h8',
  github: 'M18 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm0 28a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm20-20a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM14 14v20M34 22c0 8-10 6-20 12',
  'nas-git': 'M8 14l16-8 16 8v14c0 8-7 12-16 15-9-3-16-7-16-15Zm11 8-4 4 4 4m10-8 4 4-4 4',
  terminal: 'M11 9h26a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5V14a5 5 0 0 1 5-5Zm4 11 6 5-6 5m10 1h8',
  link: 'M21 15l5-5a8 8 0 0 1 11 11l-6 6a8 8 0 0 1-11 0m7 6-5 5a8 8 0 0 1-11-11l6-6a8 8 0 0 1 11 0',
  add: 'M24 12v24M12 24h24',
  account: 'M31 17a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM12 36c1-11 23-11 24 0',
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
