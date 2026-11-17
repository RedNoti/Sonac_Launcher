function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  if (bytes[0] && bytes[1] === 0 && bytes[2] && bytes[3] === 0) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0 && bytes[1] && bytes[2] === 0 && bytes[3]) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('euc-kr').decode(bytes); }
}

function stamp(ms) {
  const parts = [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60];
  return parts.map(part => String(part).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
}

function smiCues(text) {
  const events = [...text.matchAll(/<sync\s+[^>]*\bstart\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<sync\b|<\/body>|$)/giu)];
  return events.flatMap((event, index) => {
    const start = Number(event[1]);
    const end = events[index + 1] ? Number(events[index + 1][1]) : start + 3000;
    const content = event[2].replace(/<br\s*\/?\s*>/giu, '\n').replace(/<[^>]*>/gu, '').replace(/&nbsp;/giu, ' ').trim();
    return content && Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start
      ? [stamp(start) + ' --> ' + stamp(end) + '\n' + content] : [];
  });
}

function assCues(text) {
  const timestamp = /^\d+:\d{2}:\d{2}\.\d{2}$/u;
  const convert = value => '0'.repeat(Math.max(0, 11 - value.length)) + value + '0';
  let columns = [];
  let events = false;
  const cues = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) events = /^\[events\]$/iu.test(line.trim());
    if (!events) continue;
    if (/^Format:/iu.test(line)) columns = line.slice(7).split(',').map(column => column.trim().toLowerCase());
    if (!/^Dialogue:/iu.test(line) || columns.at(-1) !== 'text') continue;
    const startIndex = columns.indexOf('start');
    const endIndex = columns.indexOf('end');
    const fields = line.slice(9).split(',');
    const start = fields[startIndex]?.trim() ?? '';
    const end = fields[endIndex]?.trim() ?? '';
    if (!timestamp.test(start) || !timestamp.test(end)) continue;
    const content = fields.slice(columns.length - 1).join(',').replace(/\{[^}]*\}/gu, '').replace(/\\[Nn]/gu, '\n').replace(/\\h/gu, ' ').trim();
    if (content) cues.push(convert(start) + ' --> ' + convert(end) + '\n' + content);
  }
  return cues;
}

export function subtitleVtt(bytes) {
  const text = decode(bytes).replace(/\r\n?/gu, '\n').trim();
  if (/^WEBVTT(?:\s|$)/u.test(text)) return text + '\n';
  let cues;
  if (/<sync\b/iu.test(text)) cues = smiCues(text);
  else if (/^\[events\]/imu.test(text)) cues = assCues(text);
  else {
    cues = text.split(/\n[ \t]*\n/gu).flatMap(block => {
      const lines = block.split('\n');
      if (/^\d+$/u.test(lines[0].trim())) lines.shift();
      const timing = /^(\d+:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d+:\d{2}:\d{2})[,.](\d{3})(?:\s|$)/u.exec(lines.shift()?.trim() ?? '');
      if (!timing || !lines.length) return [];
      const [, start, startMs, end, endMs] = timing;
      return [start.padStart(8, '0') + '.' + startMs + ' --> ' + end.padStart(8, '0') + '.' + endMs + '\n' + lines.join('\n')];
    });
  }
  if (!cues.length) throw new Error('자막 형식을 확인하세요.');
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}
