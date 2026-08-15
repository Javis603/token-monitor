'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  annotateCodexQuotaCosts,
  fastCreditMultiplier,
  parseCodexQuotaProfile
} = require('../../src/shared/codexQuotaCost');

function writeSession(home, sessionId, events) {
  const match = sessionId.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  const dir = path.join(home, '.codex', 'sessions', match[1], match[2], match[3]);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return filePath;
}

function settings(model, serviceTier) {
  return {
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_settings: { model, service_tier: serviceTier } }
  };
}

function usage(inputTokens) {
  return {
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: {
      input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 0
    } } }
  };
}

test('Fast credit multipliers follow supported Codex model families', () => {
  assert.equal(fastCreditMultiplier('gpt-5.6-sol'), 2.5);
  assert.equal(fastCreditMultiplier('gpt-5.5'), 2.5);
  assert.equal(fastCreditMultiplier('gpt-5.4'), 2);
  assert.equal(fastCreditMultiplier('gpt-5.3-codex'), 1);
});

test('session profiles separate standard and Fast token usage', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-fast-profile-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessionId = 'rollout-2026-08-13T00-00-00-profile';
  const filePath = writeSession(home, sessionId, [
    settings('gpt-5.6-sol', 'default'), usage(100),
    settings('gpt-5.6-sol', 'priority'), usage(100)
  ]);
  const profile = parseCodexQuotaProfile(filePath);
  assert.equal(profile.incomplete, false);
  assert.equal(profile.byModel['gpt-5.6-sol'].standard.input, 100);
  assert.equal(profile.byModel['gpt-5.6-sol'].fast.input, 100);
});

test('quota cost leaves API cost intact and weights only the Fast share', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-fast-cost-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessionId = 'rollout-2026-08-13T00-00-00-cost';
  writeSession(home, sessionId, [
    settings('gpt-5.6-sol', 'default'), usage(100),
    settings('gpt-5.6-sol', 'priority'), usage(100)
  ]);
  const json = { entries: [{
    client: 'codex', provider: 'openai', sessionId, model: 'gpt-5.6-sol', cost: 2
  }] };
  annotateCodexQuotaCosts(json, {
    homeDir: home,
    pricingByModel: { 'gpt-5.6-sol': { inputCostPerToken: 0.01 } }
  });
  assert.equal(json.entries[0].cost, 2);
  assert.equal(json.entries[0].fastCostShare, 0.5);
  assert.equal(json.entries[0].quotaCostUsd, 3.5);
});
