'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');

test('Codex panel renders the endpoint-net weekly estimate directly', () => {
  const renderer = fs.readFileSync(path.join(root, 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'src', 'electron', 'renderer', 'i18n.js'), 'utf8');
  assert.match(renderer, /provider\.weeklyQuotaValueEstimate/);
  assert.match(renderer, /weeklyValueEstimate/);
  assert.doesNotMatch(renderer, /currentDeviceUsage/);
  assert.doesNotMatch(renderer, /codex-quota-details/);
  assert.doesNotMatch(renderer, /codexQuotaDetailsExpanded/);
  const collectingHelp = i18n.split('\n').filter((line) => line.includes("'limits.codex.weeklyValueCollectingHelp'"));
  assert.equal(collectingHelp.length, 5);
  assert.ok(collectingHelp.every((line) => line.includes('{required}')));
  assert.ok(collectingHelp.every((line) => line.includes('{span}')));
});

test('active local Codex usage triggers a throttled boundary refresh', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'electron', 'main.js'), 'utf8');
  assert.match(main, /CODEX_QUOTA_ACTIVE_PROBE_MS = 15 \* 1000/);
  assert.match(main, /refreshLimits\(\{ provider: 'codex' \}, 'quota-boundary-probe'\)/);
});
