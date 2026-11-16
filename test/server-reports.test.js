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
  const incident = reports.recordObservation(target, observation);
  assert.equal(incident.event.kind, 'incident');
  assert.equal(reports.recordObservation(target, observation), null);
  assert.equal(reports.summarizeDay(target.days['2026-11-16']).checks, 2);
});

test('an HTTP outage is reported after two failures and can trigger again after recovery', () => {
  const target = { name: 'web' };
  const at = Date.parse('2026-11-16T10:00:00+09:00');
  const down = { status: 'down', at, httpStatus: 503 };
  assert.equal(reports.recordObservation(target, down), null);
  assert.equal(reports.recordObservation(target, down).consecutive, 2);
  assert.equal(reports.recordObservation(target, down), null);
  assert.equal(reports.recordObservation(target, { status: 'healthy', at, latencyMs: 10 }), null);
  assert.equal(reports.recordObservation(target, down), null);
  assert.equal(reports.recordObservation(target, down).consecutive, 2);
  assert.equal(reports.summarizeDay(target.days['2026-11-16']).averageLatencyMs, 10);
  assert.equal(reports.dailyReportWindow(at, '10:01'), null);
  assert.deepEqual(reports.dailyReportWindow(at, '10:00'), { day: '2026-11-15', comparison: '2026-11-14' });
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
