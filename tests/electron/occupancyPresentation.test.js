'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeAccount,
  normalizeSnapshot,
  occupancySummary,
  viewKind
} = require('../../src/electron/renderer/occupancyPresentation');

test('normalizes advisory account fields without calling them enforced capacity', () => {
  const account = normalizeAccount({
    id: 'claude-work',
    provider: 'claude',
    alias: 'Work',
    advisoryThreshold: 2,
    activeCount: 3,
    tasks: [{ id: 'task-1', deviceName: 'Laptop', source: 'wrapper' }]
  }, 0);
  assert.equal(account.threshold, 2);
  assert.equal(account.activeCount, 3);
  assert.equal(account.light, 'red');
  assert.equal(account.reliability, 'estimated');
});

test('summarizes snapshots and distinguishes local, unavailable, and empty views', () => {
  const snapshot = normalizeSnapshot({
    generatedAt: '2026-07-16T00:00:00.000Z',
    accounts: [
      { id: 'one', provider: 'openai', alias: 'One', capacity: 1, activeCount: 1 },
      { id: 'two', provider: 'claude', alias: 'Two', capacity: 2, activeCount: 0 }
    ]
  });
  assert.deepEqual(occupancySummary(snapshot), { accounts: 2, activeTasks: 1, advisory: 1 });
  assert.equal(viewKind('local', snapshot), 'local');
  assert.equal(viewKind('client', null), 'unavailable');
  assert.equal(viewKind('host', { accounts: [] }), 'empty');
  assert.equal(viewKind('host', snapshot), 'accounts');
});

test('normalizes linked quota separately from the advisory occupancy light', () => {
  const account = normalizeAccount({
    id: 'gpt-pro',
    provider: 'chatgpt',
    alias: 'GPT Pro',
    advisoryThreshold: 2,
    activeCount: 1,
    light: 'yellow',
    quota: {
      linkState: 'linked',
      provider: 'codex',
      minimumRemainingPercent: 8,
      light: 'yellow',
      sourceDeviceId: 'mac-mini'
    }
  }, 0);
  assert.equal(account.light, 'yellow');
  assert.equal(account.quota.linkState, 'linked');
  assert.equal(account.quota.minimumRemainingPercent, 8);
  assert.equal(account.quota.sourceDeviceId, 'mac-mini');
});

test('renderer ships the occupancy panel and explains advisory-only semantics', () => {
  const rendererDir = path.join(__dirname, '../../src/electron/renderer');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.match(html, /id="occupancyPanel"/);
  assert.match(html, /occupancyPresentation\.js/);
  assert.match(app, /function renderOccupancy\(/);
  assert.match(app, /'occupancy\.advisoryOnly'/);
  assert.match(css, /\.occupancy-card/);
});
