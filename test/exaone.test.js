'use strict';

const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const test = require('node:test');
const undici = require('undici');
const { chat, queuedChat, summarizeTitle, relayEndpoint } = require('../src/exaone');

const messages = [{ role: 'user', content: 'Hello' }];

test('the launcher streams through the configured relay without an EXAONE key', async t => {
  assert.throws(() => relayEndpoint('http://relay.example.test'), /HTTPS/);
  assert.throws(() => relayEndpoint('https://relay.example.test/?token=secret'), /HTTPS/);
  t.mock.method(undici, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://relay.example.test/v1/chat/completions');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  });
  const reply = await chat(relayEndpoint('https://relay.example.test'), messages, 'low', new AbortController().signal,
    () => {}, () => {});
  assert.equal(reply.answer, 'Hi');
});

test('an authenticated relay request sends only the Firebase ID token to the configured HTTPS endpoint', async t => {
  t.mock.method(undici, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://relay.example.test/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer firebase-fixture');
    assert.equal(options.redirect, 'error');
    return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  });
  const connection = relayEndpoint('https://relay.example.test', 'firebase-fixture');
  assert.equal((await chat(connection, messages, 'low', new AbortController().signal, () => {}, () => {})).answer, 'Hi');
});

test('EXAONE returns a short plain-text title from the conversation rather than exposing streamed reasoning', async t => {
  const conversation = [{ role: 'user', content: '문서랑 코드 수정도 가능하니?' }];
  t.mock.method(undici, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.max_tokens, 512);
    assert.deepEqual(JSON.parse(body.messages[1].content), conversation);
    const data = JSON.stringify({ choices: [{ delta: { content: '### 제목: “문서와 코드 편집 범위”\n설명' } }] });
    return new Response('data: ' + data + '\n\ndata: [DONE]\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  assert.equal(await summarizeTitle('test-key', conversation, new AbortController().signal, () => {}),
    '문서와 코드 편집 범위');
});

test('EXAONE reports rate limits and token usage alongside the streamed answer', async t => {
  t.mock.method(undici, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://api.exaone.ai/v1/chat/completions');
    assert.deepEqual(JSON.parse(options.body), {
      model: 'k-exaone_v2.5', messages, reasoning_effort: 'high', temperature: 1, top_p: 0.95,
      max_tokens: 4096, stream: true, stream_options: { include_usage: true }
    });
    return new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"reasoning"}}]}',
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"total_tokens":9,"reasoning_tokens":4}}',
      'data: [DONE]'
    ].join('\n\n'), { headers: {
      'content-type': 'text/event-stream',
      'x-second-rate-limit': '1', 'x-second-rate-limit-remaining': '0',
      'x-minute-rate-limit': '60', 'x-minute-rate-limit-remaining': '59',
      'x-day-rate-limit': '86400'
    } });
  });
  const text = [];
  const rates = [];
  const phases = [];
  const result = await chat('test-key', messages, 'high', new AbortController().signal,
    value => text.push(value), value => rates.push(value), { onPhase: phase => phases.push(phase) });
  assert.deepEqual(text, ['Hi']);
  assert.deepEqual(phases, ['connected', 'reasoning']);
  assert.deepEqual(result, { answer: 'Hi', tokens: 9 });
  assert.deepEqual(rates, [{ retryAt: 0, limits: [
    { window: 'second', limit: 1, remaining: 0 },
    { window: 'minute', limit: 60, remaining: 59 }
  ] }]);
});

test('EXAONE reports a retry deadline even when a 429 rejects the chat request', async t => {
  t.mock.method(Date, 'now', () => 1730000000000);
  t.mock.method(undici, 'fetch', async () => new Response(null, { status: 429, headers: {
    'retry-after': '1', 'retry-after-ms': '630',
    'x-second-rate-limit': '1', 'x-second-rate-limit-remaining': '0',
    'x-day-rate-limit': '86400', 'x-day-rate-limit-remaining': '86300'
  } }));
  const rates = [];
  await assert.rejects(chat('test-key', messages, 'low', new AbortController().signal,
    () => assert.fail('429 must not emit answer text'), value => rates.push(value)), /요청 한도/);
  assert.deepEqual(rates, [{ retryAt: 1730000001000, limits: [
    { window: 'second', limit: 1, remaining: 0 },
    { window: 'day', limit: 86400, remaining: 86300 }
  ] }]);
});

test('a queued message retries a 429 once and delivers one answer', async t => {
  let calls = 0;
  t.mock.method(undici, 'fetch', async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).messages, messages);
    if (++calls === 1) return new Response(null, { status: 429, headers: { 'retry-after-ms': '10' } });
    return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  });
  const phases = [];
  const text = [];
  const result = await queuedChat(() => 'test-key', messages, 'low', new AbortController().signal,
    value => text.push(value), () => {}, { onPhase: phase => phases.push(phase) });
  assert.equal(result.answer, 'Hi');
  assert.deepEqual(text, ['Hi']);
  assert.deepEqual(phases.slice(0, 3), ['waiting', 'queued', 'waiting']);
  assert.equal(calls, 2);
});

test('a queued message can be cancelled before contacting EXAONE', async () => {
  const controller = new AbortController();
  const result = queuedChat(() => assert.fail('cancelled message must not connect'), messages, 'low',
    controller.signal, () => {}, () => {}, {
      retryAt: Date.now() + 5000,
      onPhase(phase) { if (phase === 'queued') controller.abort(); }
    });
  await assert.rejects(result, { name: 'AbortError' });
});

test('EXAONE lets a stream run past the original deadline while reasoning arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stream;
  t.mock.method(undici, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { stream = controller; }
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const text = [];
  const phases = [];
  const request = chat('test-key', messages, 'max', new AbortController().signal,
    value => text.push(value), () => {}, { onPhase: phase => phases.push(phase) });
  await nextTurn();
  const encoder = new TextEncoder();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(90_000);
    stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n'));
    await nextTurn();
  }
  assert.deepEqual(text, []);
  stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n'));
  stream.close();
  assert.deepEqual(await request, { answer: 'Hi', tokens: undefined });
  assert.deepEqual(text, ['Hi']);
  assert.deepEqual(phases, ['connected', 'reasoning']);
});

test('EXAONE reports when the initial response never arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(undici, 'fetch', (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const request = chat('test-key', messages, 'max', new AbortController().signal, () => {}, () => {});
  const rejection = assert.rejects(request, /응답이 시작되지 않아 시간이 초과/);
  t.mock.timers.tick(240_000);
  await rejection;
});

test('EXAONE reports a stalled stream and preserves the reason for explicit cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(undici, 'fetch', async () => new Response(new ReadableStream(), {
    headers: { 'content-type': 'text/event-stream' }
  }));
  const controller = new AbortController();
  const request = chat('test-key', messages, 'max', controller.signal, () => {}, () => {});
  const rejection = assert.rejects(request, /응답이 도중에 멈춰 시간이 초과/);
  await nextTurn();
  t.mock.timers.tick(120_000);
  await rejection;

  const cancelled = chat('test-key', messages, 'max', controller.signal, () => {}, () => {});
  await nextTurn();
  controller.abort();
  await assert.rejects(cancelled, error => error === controller.signal.reason);
});
