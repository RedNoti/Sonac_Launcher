'use strict';

const outlines = {
  activity: 'M7 24h8l5-11 8 22 5-11h8',
  sparkles: 'M21 9c1.5 8 4.5 11 12.5 12.5C25.5 23 22.5 26 21 34c-1.5-8-4.5-11-12.5-12.5C16.5 20 19.5 17 21 9ZM36 6v8m-4-4h8M36 29v10m-5-5h10',
  star: 'M24 6l5.6 11.4 12.6 1.8-9.1 8.9 2.2 12.5L24 34.7l-11.3 5.9 2.2-12.5-9.1-8.9 12.6-1.8Z',
  add: 'M24 9v30M9 24h30',
  check: 'M10 24l9 9 19-19',
  extract: 'M8 20h32v17H8ZM9 20l4-9h22l4 9M24 13V5m-5 4 5 4 5-4M20 28h8',
  folderAdd: 'M6 14a3 3 0 0 1 3-3h10l4 5h16a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3ZM24 22v12m-6-6h12',
  home: 'M7 22 24 8l17 14M11 19v21h10V28h6v12h10V19',
  up: 'M24 38V10m-10 10 10-10 10 10',
  play: 'M17 10 37 24 17 38Z',
  more: 'M10 24a2 2 0 1 0 4 0 2 2 0 1 0-4 0Zm12 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0Zm12 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0Z',
  stop: 'M14 14h20v20H14Z',
  fullscreen: 'M6 19V6h13M29 6h13v13M42 29v13H29M19 42H6V29',
  sidebar: 'M9 10h30a3 3 0 0 1 3 3v22a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3Zm21 0v28',
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
  switch: 'M7 15h33m-8-8 8 8-8 8M41 33H8m8-8-8 8 8 8',
  logout: 'M22 8H10a3 3 0 0 0-3 3v26a3 3 0 0 0 3 3h12m-5-16h24m-9-9 9 9-9 9',
  image: 'M8 10h32v28H8ZM9 32l10-9 8 7 5-5 7 6M30 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  audio: 'M20 34V13l17-4v20M20 34c0 4-10 7-10 2 0-4 10-7 10-2Zm17-5c0 4-10 7-10 2 0-4 10-7 10-2Z',
  video: 'M7 11h34v26H7ZM20 17v14l12-7Z',
  file: 'M13 7h14l9 9v25H13ZM27 7v10h9m-17 9h11m-11 6h11'
};

const referenceOutlines = {
  dsm: { path: 'M12 7h5.5M12 17h5.5', rects: [[3.5,3.5,17,7,2.2],[3.5,13.5,17,7,2.2]], dots: [[7,7,.9],[7,17,.9]] },
  video: { path: 'M10 9l5 3-5 3z', rects: [[3.5,4.5,17,15,1.2]] },
  audio: { path: 'M9.5 17.5V6.5l8-2v10.5', ellipses: [[7,17.8,2.6,1.9],[15.5,15.2,2.6,1.9]] },
  github: { path: 'M6.5 7v10M17.5 11c0 3.5-4 4-11 6', circles: [[6.5,5,2],[6.5,19,2],[17.5,9,2]] },
  terminal: { path: 'M7 10l3 2.2L7 14.4M12.5 15.5h4', rects: [[3,4,18,16,3.2]] },
  sparkles: { path: 'M9 7.5c.6 3.6 1.9 4.9 5.5 5.5-3.6.6-4.9 1.9-5.5 5.5-.6-3.6-1.9-4.9-5.5-5.5C7.1 12.4 8.4 11.1 9 7.5zM17.5 3v5M15 5.5h5M17.5 15v5M15 17.5h5' },
  sync: { path: 'M20 11a8 8 0 0 0-14.5-4M4 4v3.5h3.5M4 13a8 8 0 0 0 14.5 4M20 20v-3.5h-3.5' },
  pencil: { path: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4' },
  account: { path: 'M5 20c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5', circles: [[12,8,3.5]] },
  add: { path: 'M12 5v14M5 12h14' },
  pause: { path: 'M9 5v14m6-14v14' },
  previous: { path: 'M19 5v14L9 12zM5 5v14' },
  next: { path: 'M5 5v14l10-7zM19 5v14' }
};

function icon(name, color = '#fff') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 144;
  canvas.setAttribute('aria-hidden', 'true');
  const draw = canvas.getContext('2d');
  const reference = referenceOutlines[name];
  draw.scale(reference ? 6 : 3, reference ? 6 : 3);
  draw.strokeStyle = color;
  draw.lineWidth = reference ? 1.6 : 1.8;
  draw.lineCap = 'round';
  draw.lineJoin = 'round';
  if (!reference) draw.stroke(new Path2D(outlines[name]));
  else {
    draw.stroke(new Path2D(reference.path));
    for (const rect of reference.rects ?? []) {
      draw.beginPath();
      draw.roundRect(...rect);
      draw.stroke();
    }
    for (const circle of reference.circles ?? []) {
      draw.beginPath();
      draw.arc(...circle, 0, 2 * Math.PI);
      draw.stroke();
    }
    for (const ellipse of reference.ellipses ?? []) {
      draw.beginPath();
      draw.ellipse(...ellipse, -Math.PI / 9, 0, 2 * Math.PI);
      draw.stroke();
    }
    draw.fillStyle = color;
    for (const dot of reference.dots ?? []) {
      draw.beginPath();
      draw.arc(...dot, 0, 2 * Math.PI);
      draw.fill();
    }
  }
  return canvas;
}
