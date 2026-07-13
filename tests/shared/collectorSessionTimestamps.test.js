'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { applySessionTimestamps } = require('../../src/shared/collector');

test('applySessionTimestamps fills OpenCode session start/last from injected DB meta', () => {
  const periods = {
    today: {
      sessions: {
        'opencode:ses_abc': { client: 'opencode', sessionId: 'ses_abc', startedAt: '', lastUsedAt: '' }
      }
    }
  };
  const readOpencodeMeta = (ids) => {
    assert.ok(ids.has('ses_abc'));
    return new Map([['ses_abc', {
      startedAt: '2026-06-04T10:00:00.000Z',
      lastUsedAt: '2026-06-04T10:05:00.000Z',
      title: 'Greeting'
    }]]);
  };

  applySessionTimestamps(periods, '/no/such/home', { readOpencodeMeta });

  const s = periods.today.sessions['opencode:ses_abc'];
  assert.strictEqual(s.startedAt, '2026-06-04T10:00:00.000Z');
  assert.strictEqual(s.lastUsedAt, '2026-06-04T10:05:00.000Z');
});

test('applySessionTimestamps leaves non-opencode sessions to the file path (no DB reader call)', () => {
  const periods = {
    today: {
      sessions: {
        'claude:abc-123': { client: 'claude', sessionId: 'abc-123', startedAt: '', lastUsedAt: '' }
      }
    }
  };
  let called = false;
  const readOpencodeMeta = () => { called = true; return new Map(); };

  applySessionTimestamps(periods, '/no/such/home', { readOpencodeMeta });

  assert.strictEqual(called, false, 'opencode reader must not run when there are no opencode sessions');
});

test('applySessionTimestamps reuses resolved metadata across progressive periods', () => {
  const cache = { metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set() };
  const calls = [];
  const readOpencodeMeta = (ids) => {
    calls.push([...ids]);
    return new Map([...ids].map((id) => [id, { projectPath: `/work/${id}` }]));
  };
  const today = { sessions: {
    'opencode:s1': { client: 'opencode', sessionId: 's1' }
  } };
  const month = { sessions: {
    'opencode:s1': { client: 'opencode', sessionId: 's1' },
    'opencode:s2': { client: 'opencode', sessionId: 's2' }
  } };

  applySessionTimestamps({ today }, '/home/test', { ...cache, readOpencodeMeta });
  applySessionTimestamps({ today, month }, '/home/test', { ...cache, readOpencodeMeta });
  applySessionTimestamps({ today, month }, '/home/test', { ...cache, readOpencodeMeta });

  assert.deepEqual(calls, [['s1'], ['s2']]);
  assert.equal(month.sessions['opencode:s1'].projectLabel, 's1');
  assert.equal(month.sessions['opencode:s2'].projectLabel, 's2');
});

test('applySessionTimestamps retries a progressive miss in the final pass', () => {
  const cache = { metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set() };
  const periods = { today: { sessions: {
    'opencode:s1': { client: 'opencode', sessionId: 's1' }
  } } };
  let reads = 0;
  const readOpencodeMeta = () => {
    reads += 1;
    return reads === 1 ? new Map() : new Map([['s1', { projectPath: '/work/project' }]]);
  };

  applySessionTimestamps(periods, '/home/test', { ...cache, readOpencodeMeta });
  applySessionTimestamps(periods, '/home/test', { ...cache, readOpencodeMeta });
  assert.equal(reads, 1, 'intermediate periods should not repeat a known miss');
  assert.equal(periods.today.sessions['opencode:s1'].projectId, undefined);

  applySessionTimestamps(periods, '/home/test', { ...cache, readOpencodeMeta, retryMisses: true });
  assert.equal(reads, 2, 'the final pass should retry a prior miss once');
  assert.equal(periods.today.sessions['opencode:s1'].projectLabel, 'project');
});
