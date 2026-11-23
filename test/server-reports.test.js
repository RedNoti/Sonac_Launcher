'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const undici = require('undici');
const exaone = require('../src/exaone');
const reports = require('../src/server-reports');

test('monitoring extracts approved telemetry without retaining log text or arbitrary response fields', async t => {
  const target = reports.monitoringTarget({ name: '웹 서버', url: 'https://example.test/health' });
  const now = Date.parse('2026-11-16T01:00:00+09:00');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(undici, 'fetch', async (url, options) => {
    assert.equal(url.href, target.url);
    assert.equal(options.redirect, 'manual');
    return Response.json({ schema: 'sonac-monitoring-v1', status: 'degraded',
      metrics: { cpuPercent: 70, memoryPercent: 300, arbitrary: 5 },
      logs: { errors: 4, warnings: 'secret', raw: 'token=example' },
      events: [{ kind: 'incident', at: new Date(now).toISOString(), message: 'secret' }] });
  });
  const observation = await reports.probeTarget(target, new AbortController().signal);
  assert.deepEqual(observation, { status: 'degraded', httpStatus: 200, latencyMs: 0, at: now,
    details: { status: 'degraded', metrics: { cpuPercent: 70 }, logs: { errors: 4 },
      events: [{ kind: 'incident', at: new Date(now).toISOString() }] } });
  assert.equal(reports.recordObservation(target, observation), null);
  assert.equal(reports.recordObservation(target, observation), null);
  assert.equal(reports.summarizeDay(target.days['2026-11-16']).checks, 2);
});

test('an outage is confirmed after five minutes, deduplicated and rearmed after recovery', () => {
  const target = { id: 'web', name: 'web' };
  const at = Date.parse('2026-11-16T10:00:00+09:00');
  const down = { status: 'down', at, httpStatus: 503 };
  assert.equal(reports.recordObservation(target, down), null);
  assert.equal(reports.shouldProbeTarget(target, at + 299999), false);
  assert.equal(reports.shouldProbeTarget(target, at + 300000), true);
  assert.equal(reports.recordObservation(target, { ...down, at: at + 60000 }), null, 'manual early checks must not send alerts');
  const incident = reports.recordObservation(target, { ...down, at: at + 360000 });
  assert.equal(incident.confirmedAt, at + 360000);
  assert.equal(reports.recordObservation(target, { ...down, at: at + 660000 }), null);
  assert.equal(reports.confirmedIncidents([incident, incident], [target]).length, 1);
  assert.equal(reports.recordObservation(target, { status: 'healthy', at: at + 700000, latencyMs: 10 }), null);
  assert.equal(reports.confirmedIncidents([incident], [target]).length, 0, 'recovered incidents must not be sent from an old queue');
  assert.equal(reports.shouldProbeTarget(target, at + 700001), true);
  assert.equal(reports.recordObservation(target, { ...down, at: at + 710000 }), null);
  assert(reports.recordObservation(target, { ...down, at: at + 1010000 }));
  assert.equal(reports.summarizeDay(target.days['2026-11-16']).averageLatencyMs, 10);
  assert.equal(reports.dailyReportWindow(at, '10:01'), null);
  assert.deepEqual(reports.dailyReportWindow(at, '10:00'), { day: '2026-11-15', comparison: '2026-11-14' });
});

test('a transient failure that recovers at the recheck never creates an incident', () => {
  const target = { id: 'a', name: '버터드' };
  assert.equal(reports.recordObservation(target, { status: 'down', issue: 'timeout', at: 1000000 }), null);
  assert.equal(reports.recordObservation(target, { status: 'healthy', latencyMs: 750, at: 1300000 }), null);
  assert.equal(target.incident, false);
  assert.equal(target.nextCheckAt, undefined);
});

test('five-minute state survives restart and obsolete queued incidents are ignored', () => {
  let target = { id: 'a', name: '버터드', incident: true, consecutive: 2 };
  reports.recordObservation(target, { status: 'down', issue: 'timeout', at: 1000000 });
  target = JSON.parse(JSON.stringify(target));
  assert.equal(reports.shouldProbeTarget(target, 1299999), false);
  const incident = reports.recordObservation(target, { status: 'down', issue: 'timeout', at: 1300000 });
  assert(incident);
  assert.equal(reports.confirmedIncidents([{service:'old',observation:{status:'down'}}], [target]).length, 0);
  assert.equal(reports.confirmedIncidents([incident], []).length, 0);
});

test('daily reports use separate named sections and concise observed facts', () => {
  const report = reports.formatDailyReport([
    { service: '버터드', day: { checks: 1440, down: 0, degraded: 0, averageLatencyMs: 750 } },
    { service: 'vuza', day: { checks: 1440, down: 2, degraded: 0, averageLatencyMs: 683 } },
    { service: '느릿', day: null }
  ]);
  assert.equal(report.summary, '정상 1개 · 이상 1개 · 관측 없음 1개');
  assert.deepEqual(report.sections[0], { name: '버터드', text: '정상 · 평균 750ms', tone: 'good' });
  assert.equal(report.sections[1].text, '응답 실패 2회 · 평균 683ms');
  assert.equal(report.sections[2].tone, 'idle');
  assert(!report.text.includes('원인 후보'));
});

test('incident reports name the actual failure without guessing its cause', () => {
  const report = reports.formatIncidentReport([
    {service:'버터드',observation:{status:'down',issue:'timeout'}},
    {service:'조이',observation:{status:'down',httpStatus:503}}
  ]);
  assert.equal(report.sections[0].text, '응답 시간 초과');
  assert.equal(report.sections[1].text, 'HTTP 503 응답');
  assert.equal(report.sections.length, 2);
  assert.match(report.summary, /5분 뒤 재확인/);
});

test('Discord delivery requires a trusted webhook and suppresses message mentions', async t => {
  const suffix = '/api/webhooks/123456789012345678/' + 'a'.repeat(40);
  assert.throws(() => reports.discordWebhook('https://example.test' + suffix), /Discord/);
  assert.throws(() => reports.monitoringTarget({ name: 'web', url: 'https://example.test/health?token=secret' }), /HTTPS/);
  t.mock.method(undici, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://discord.com' + suffix + '?wait=true');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { content: '일일보고\n@everyone 테스트', allowed_mentions: { parse: [] }, flags: 4 });
    return new Response(null, { status: 204 });
  });
  await reports.sendDiscord('https://discord.com' + suffix, '일일보고', '@everyone 테스트', new AbortController().signal);
});

test('server reports reuse the configured EXAONE chat adapter with structured facts', async t => {
  const facts = { httpStatus: 503, consecutive: 2 };
  const signal = new AbortController().signal;
  t.mock.method(exaone, 'chat', async (key, messages, effort, receivedSignal) => {
    assert.equal(key, 'fixture');
    assert.equal(effort, 'low');
    assert.equal(receivedSignal, signal);
    assert.match(messages[0].content, /관측 데이터/);
    assert.deepEqual(JSON.parse(messages[1].content), facts);
    return { answer: ' 서버 응답 503을 확인했습니다. ' };
  });
  assert.equal(await reports.analyzeReport('fixture', '장애를 요약하세요.', facts, signal), '서버 응답 503을 확인했습니다.');
});

test('structured Discord reports keep each registered name in a separate card', async t => {
  t.mock.method(undici, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.content, '서비스 이상 감지\n이상 2개');
    assert.deepEqual(payload.allowed_mentions, {parse:[]});
    assert.equal(payload.flags, undefined, 'explicit cards must not be suppressed');
    assert.deepEqual(payload.embeds.map(embed => embed.title), ['버터드','vuza']);
    assert.equal(payload.embeds[0].description, '응답 시간 초과');
    return new Response(null,{status:204});
  });
  await reports.sendDiscord('https://discord.com/api/webhooks/123456789012345678/'+'a'.repeat(40),
    '서비스 이상 감지','이상 2개',new AbortController().signal,[
      {name:'버터드',text:'응답 시간 초과',tone:'bad'}, {name:'vuza',text:'HTTP 503 응답',tone:'bad'}
    ]);
});
