'use strict';

const outlines = {
  search: 'M30 30l10 10M34 21a13 13 0 1 1-26 0 13 13 0 0 1 26 0Z',
  copy: 'M15 15h24v24H15ZM31 9H9v22',
  sliders: 'M8 12h20m8 0h4M8 24h8m8 0h16M8 36h24m8 0h0M28 12a4 4 0 1 1 8 0 4 4 0 1 1-8 0M16 24a4 4 0 1 1 8 0 4 4 0 1 1-8 0M32 36a4 4 0 1 1 8 0 4 4 0 1 1-8 0',
  chevron: 'm13 19 11 11 11-11',
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
  fsNew: { path: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 11v5M9.5 13.5h5' },
  fsEye: { path: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 1 1 6 0' },
  fsOpen: { path: 'M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1 M3.5 11h18.5l-2 7a2 2 0 0 1-2 1.5H6a2 2 0 0 1-2-1.5z' },
  fsStar: { path: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z' },
  fsDownload: { path: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14' },
  fsRename: { path: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z M13 7l4 4' },
  fsExtract: { path: 'M4.5 4h15A1.5 1.5 0 0 1 21 5.5v2A1.5 1.5 0 0 1 19.5 9h-15A1.5 1.5 0 0 1 3 7.5v-2A1.5 1.5 0 0 1 4.5 4z M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9 M12 17v-5m0 0l-2.5 2.5M12 12l2.5 2.5' },
  fsDelete: { path: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' },
  fsAll: { path: 'M7.5 3.5h9a4 4 0 0 1 4 4v9a4 4 0 0 1-4 4h-9a4 4 0 0 1-4-4v-9a4 4 0 0 1 4-4z M8 12.5l3 3 5-6' },
  fsNone: { path: 'M9 9l6 6M15 9l-6 6', rects: [[3.5,3.5,17,17,4]], dashed: true },
  dsm: { path: 'M12 7h5.5M12 17h5.5', rects: [[3.5,3.5,17,7,2.2],[3.5,13.5,17,7,2.2]], dots: [[7,7,.9],[7,17,.9]] },
  video: { path: 'M10 9l5 3-5 3z', rects: [[3.5,4.5,17,15,1.2]] },
  audio: { path: 'M9 18V5l11-2v13', circles: [[6,18,3],[17,16,3]] },
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

const svgNamespace = 'http://www.w3.org/2000/svg';

function iconElement(tag, attributes) {
  const element = document.createElementNS(svgNamespace, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function icon(name, color = '#fff') {
  const reference = referenceOutlines[name];
  const size = reference ? 24 : 48;
  const svg = iconElement('svg', {
    class: 'ui-icon', viewBox: '0 0 ' + size + ' ' + size, width: 20, height: 20,
    'aria-hidden': 'true', focusable: 'false',
    fill: 'none', stroke: color, 'stroke-width': reference ? 1.6 : 1.8,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round'
  });
  const path = reference?.path ?? outlines[name];
  if (path) svg.append(iconElement('path', { d: path }));
  for (const [x, y, width, height, rx] of reference?.rects ?? []) {
    svg.append(iconElement('rect', { x, y, width, height, rx }));
  }
  for (const [cx, cy, r] of reference?.circles ?? []) {
    svg.append(iconElement('circle', { cx, cy, r }));
  }
  for (const [cx, cy, rx, ry] of reference?.ellipses ?? []) {
    svg.append(iconElement('ellipse', { cx, cy, rx, ry, transform: `rotate(-20 ${cx} ${cy})` }));
  }
  for (const [cx, cy, r] of reference?.dots ?? []) {
    svg.append(iconElement('circle', { cx, cy, r, fill: color, stroke: 'none' }));
  }
  if (reference?.dashed) svg.querySelector('rect')?.setAttribute('stroke-dasharray', '3.2 3.2');
  return svg;
}
