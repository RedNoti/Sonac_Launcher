'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { zipSync } = require('fflate');
const { utils, write } = require('cfb');
const { deflateRawSync } = require('node:zlib');
const { extractAttachment, withAttachments } = require('../src/ai-attachments');

const archive = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files)
  .map(([name, xml]) => [name, Buffer.from(xml)]))));

test('attachment extraction reads documents, shared spreadsheet strings and slide text', () => {
  assert.equal(extractAttachment('report.docx', archive({
    'word/document.xml': '<document><p><r><t>Word 본문</t></r></p></document>'
  })).text, 'Word 본문');
  assert.equal(extractAttachment('slides.pptx', archive({
    'ppt/slides/slide2.xml': '<slide><p><t>둘째</t></p></slide>',
    'ppt/slides/slide1.xml': '<slide><p><t>첫째</t></p></slide>'
  })).text, '첫째\n\n둘째');
  assert.match(extractAttachment('sheet.xlsx', archive({
    'xl/sharedStrings.xml': '<sst><si><t>이름</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><row><c t="s"><v>0</v></c><c><v>5</v></c></row></worksheet>'
  })).text, /이름\t5/u);
  assert.equal(extractAttachment('한글.hwpx', archive({
    'Contents/section0.xml': '<section><p><t>한글 본문</t></p></section>'
  })).text, '한글 본문');
});

test('HWP attachments extract compressed paragraph records', () => {
  const header = Buffer.alloc(256);
  header.write('HWP Document File');
  header.writeUInt32LE(1, 36);
  const text = Buffer.from('한글 5 본문\r', 'utf16le');
  const record = Buffer.alloc(4);
  record.writeUInt32LE((text.length << 20) | 67);
  const file = utils.cfb_new();
  utils.cfb_add(file, 'FileHeader', header);
  utils.cfb_add(file, 'BodyText/Section0', deflateRawSync(Buffer.concat([record, text])));
  assert.equal(extractAttachment('한글.hwp', write(file, { type: 'buffer' })).text, '한글 5 본문');
});

test('attachment extraction rejects binaries and labels omitted text', () => {
  assert.throws(() => extractAttachment('image.png', Buffer.from('text')), /문서/u);
  assert.throws(() => extractAttachment('file.js', Buffer.from([0, 1, 4])), /바이너리/u);
  const entry = extractAttachment('app.ts', Buffer.from('let value = 1;\n'.repeat(3000)));
  assert.equal(entry.text.length, 12000);
  assert.equal(entry.truncated, true);
  assert.match(withAttachments({ content: '설명해 줘', attachments: [entry] }), /"file":"app\.ts"/u);
});
