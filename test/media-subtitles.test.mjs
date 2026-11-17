import assert from 'node:assert/strict';
import test from 'node:test';
import { subtitleVtt } from '../src/ui/media-subtitles.mjs';

test('SRT converts cue timings and preserves text, including Korean', () => {
  const bytes = Buffer.from('\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\n안녕하세요\r\n두 번째 줄\r\n');
  assert.equal(subtitleVtt(bytes), 'WEBVTT\n\n00:00:01.250 --> 00:00:03.500\n안녕하세요\n두 번째 줄\n');
  const vtt = 'WEBVTT\n\n00:01.250 --> 00:03.500\n안녕하세요\n';
  assert.equal(subtitleVtt(Buffer.from(vtt)), vtt);
  assert.throws(() => subtitleVtt(Buffer.from('broken')), /자막 형식/u);
});

test('ASS and SMI subtitles keep their time boundaries and readable text', () => {
  const ass = '[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.20,0:00:02.30,Default,{\\i1}안녕, 세계';
  assert.match(subtitleVtt(Buffer.from(ass)), /00:00:01\.200 --> 00:00:02\.300\n안녕, 세계/u);
  const smi = '<SAMI><BODY><SYNC Start=750><P Class=KRCC>안녕<br>세계<SYNC Start=2880>&nbsp;</BODY></SAMI>';
  assert.match(subtitleVtt(Buffer.from(smi)), /00:00:00\.750 --> 00:00:02\.880\n안녕\n세계/u);
});
