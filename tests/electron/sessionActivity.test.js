'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const projection = require('../../src/shared/sessionActivityProjection');
const titles = require('../../src/electron/sessionTitleDisplay');

test('renderer activity survives late detail loads on the same accounting snapshot and respects title policy and source changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('let localSessionActivity = null;');
  const end = source.indexOf('\nfunction setRendererSettings(', start);
  const context = { state: { settings: { sessionTitlesEnabled: false } }, window: {
    TokenMonitorSessionActivityProjection: projection, TokenMonitorSessionTitleDisplay: titles
  } };
  vm.runInNewContext(source.slice(start, end), context);
  const native = { client: 'claude', sessionId: 'zero', title: 'PRIVATE', native: true };
  context.incoming = { snapshot: { id: 1, source: 'local' }, patch: { observations: [{ client: 'claude', sessionId: 'old',
    liveActivity: { state: 'waiting', observedAt: '2026-10-09T00:01:00Z' } }], nativeSessions: { today: { zero: native } } } };
  vm.runInNewContext('localSessionActivity = incoming;', context);
  const lateDetail = { snapshot: { id: 1, source: 'local' }, periods: { allTime: { sessions: {
    old: { client: 'claude', sessionId: 'old', title: 'PRIVATE', totalTokens: 500 }
  } } } };
  const shown = context.sessionStatsForDisplay(lateDetail);
  assert.equal(require('../../src/shared/sessionLive').sessionWithActivity(shown.periods.allTime, 'old').liveActivity.state, 'waiting');
  assert.equal(shown.periods.allTime.sessions.old.title, undefined);
  assert.equal(shown.nativeSessions.today.zero.title, undefined);
  assert.equal(lateDetail.periods.allTime.sessions.old.liveActivity, undefined);
  for (const snapshot of [{ id: 2, source: 'local' }, { id: 1, source: 'new-hub' }]) {
    const next = { ...lateDetail, snapshot };
    assert.equal(context.applyLocalSessionActivity(next), next);
  }
});
