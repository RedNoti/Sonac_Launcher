'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { confirmOperation } = require('../src/file-confirmations');

test('opting out after accepting a file operation skips subsequent ordinary confirmations', async () => {
  let saved = {};
  let prompts = 0;
  const options = {
    ask: async details => { prompts++; assert.equal(details.allowSkipFileConfirmation, true); return { accepted: true, skipNext: true }; },
    remember: async () => { saved.skipFileConfirmations = true; }
  };
  assert.equal(await confirmOperation({ fileOperation: true }, options), true);
  // The stored value can be reused after restarting the app.
  const restored = JSON.parse(JSON.stringify(saved));
  assert.equal(await confirmOperation({ fileOperation: true }, { ...options, ...restored }), true);
  assert.equal(prompts, 1);
});

test('mandatory security confirmations always ask and cannot record an opt-out', async () => {
  let asked = 0;
  const accepted = await confirmOperation({ fileOperation: true, requiredConfirmation: true }, {
    skipFileConfirmations: true,
    ask: async details => { asked++; assert.equal(details.allowSkipFileConfirmation, false); return { accepted: true, skipNext: true }; },
    remember: () => assert.fail('mandatory confirmations cannot change the preference')
  });
  assert.equal(accepted, true);
  assert.equal(asked, 1);
});

test('unclassified prompts remain mandatory even when file confirmation is disabled', async () => {
  assert.equal(await confirmOperation({ title: 'Security prompt' }, {
    skipFileConfirmations: true,
    ask: async details => { assert.equal(details.allowSkipFileConfirmation, false); return false; },
    remember: () => assert.fail('must not remember')
  }), false);
});

test('cancel, close and unchecked acceptance never save a preference', async () => {
  for (const response of [false, undefined, { accepted: false, skipNext: true }, true, { accepted: true, skipNext: false }]) {
    const accepted = await confirmOperation({ fileOperation: true }, {
      ask: async () => response, remember: () => assert.fail('must not remember')
    });
    assert.equal(accepted, response === true || response?.accepted === true);
  }
});

test('a failed preference save stops the operation instead of silently pretending to remember', async () => {
  await assert.rejects(confirmOperation({ fileOperation: true }, {
    ask: async () => ({ accepted: true, skipNext: true }),
    remember: async () => { throw new Error('disk full'); }
  }), /disk full/);
});
