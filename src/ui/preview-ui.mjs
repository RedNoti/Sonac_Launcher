async function read(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('미리보기 데이터를 읽을 수 없습니다.');
  return response;
}

async function renderPDF(url, body, controls, status, signal) {
  const pdf = await import('./vendor/pdfjs/build/pdf.min.mjs');
  const data = new Uint8Array(await (await read(url, signal)).arrayBuffer());
  const resources = new URL('./vendor/pdfjs/', location.href).href;
  signal.throwIfAborted();
  const port = new Worker(resources + 'build/pdf.worker.min.mjs', { type: 'module' });
  const worker = new pdf.PDFWorker({ port });
  const task = pdf.getDocument({
    data, worker, isEvalSupported: false, useWorkerFetch: false,
    cMapUrl: resources + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: resources + 'standard_fonts/',
    wasmUrl: resources + 'wasm/', iccUrl: resources + 'iccs/'
  });
  signal.addEventListener('abort', () => {
    void task.destroy().catch(() => {}).finally(() => { worker.destroy(); port.terminate(); });
  }, { once: true });

  const documentPDF = await task.promise;
  signal.throwIfAborted();
  const canvas = document.createElement('canvas');
  canvas.className = 'preview-pdf';
  body.replaceChildren(canvas);
  const previous = document.createElement('button');
  previous.textContent = '이전';
  const next = document.createElement('button');
  next.textContent = '다음';
  const pages = document.createElement('span');
  controls.replaceChildren(previous, pages, next);
  let number = 1;

  async function render() {
    previous.disabled = next.disabled = true;
    const page = await documentPDF.getPage(number);
    signal.throwIfAborted();
    const original = page.getViewport({ scale: 1 });
    const scale = Math.min(2, (body.clientWidth - 32) * devicePixelRatio / original.width);
    const viewport = page.getViewport({ scale: Math.max(0.1, scale) });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    signal.throwIfAborted();
    pages.textContent = number + ' / ' + documentPDF.numPages;
    previous.disabled = number === 1;
    next.disabled = number === documentPDF.numPages;
    body.scrollTop = 0;
  }

  function turn(delta) {
    number += delta;
    void render().catch(() => {
      if (!signal.aborted) status('이 페이지를 표시할 수 없습니다.');
    });
  }

  previous.addEventListener('click', () => turn(-1));
  next.addEventListener('click', () => turn(1));
  await render();
}

async function renderWord(url, body, signal) {
  const { unzipSync } = await import('./vendor/fflate.mjs');
  const data = new Uint8Array(await (await read(url, signal)).arrayBuffer());
  signal.throwIfAborted();
  const xml = unzipSync(data, {
    filter: file => file.name === 'word/document.xml' && file.originalSize <= 4 * 1024 ** 2
  })['word/document.xml'];
  if (!xml) throw new Error('Word 문서의 본문을 읽을 수 없습니다.');
  const raw = new TextDecoder().decode(xml);
  if (/<!DOCTYPE/iu.test(raw)) throw new Error('Word 문서의 본문을 읽을 수 없습니다.');
  const documentWord = new DOMParser().parseFromString(raw, 'application/xml');
  const article = document.createElement('article');
  article.className = 'preview-word';
  const paragraphs = documentWord.getElementsByTagNameNS('*', 'p');
  for (const paragraph of paragraphs) {
    const line = document.createElement('p');
    line.textContent = [...paragraph.getElementsByTagNameNS('*', 't')].map(text => text.textContent).join('');
    if (line.textContent) article.append(line);
  }
  if (!article.childElementCount) throw new Error('표시할 텍스트가 없습니다.');
  body.replaceChildren(article);
}

export async function renderPreview(item, filename, body, controls, status, signal) {
  if (item.kind === 'pdf') return renderPDF(item.url, body, controls, status, signal);
  if (item.kind === 'word') return renderWord(item.url, body, signal);
  if (item.kind === 'text') {
    const text = document.createElement('pre');
    text.className = 'preview-text';
    text.textContent = await (await read(item.url, signal)).text();
    signal.throwIfAborted();
    body.replaceChildren(text);
    return;
  }
  const media = document.createElement(item.kind === 'image' ? 'img' : item.kind);
  media.className = 'preview-media';
  if (item.kind === 'image') media.alt = filename;
  else {
    media.controls = true;
    media.preload = 'metadata';
  }
  media.addEventListener('error', () => {
    if (!signal.aborted) status('이 파일을 재생하거나 표시할 수 없습니다.');
  });
  signal.addEventListener('abort', () => {
    media.removeAttribute('src');
    if (item.kind !== 'image') media.load();
  }, { once: true });
  media.src = item.url;
  body.replaceChildren(media);
}
