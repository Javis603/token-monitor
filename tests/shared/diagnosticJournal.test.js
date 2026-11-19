'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDiagnosticJournal, normalizeDiagnosticEvent } = require('../../src/shared/diagnosticJournal');

test('diagnostic journal keeps a bounded, memory-only state transition history', () => {
  const journal = createDiagnosticJournal({
    capacity: 2,
    now: () => Date.parse('2026-08-05T10:00:00.000Z')
  });

  assert.equal(journal.record({ subsystem: 'collector', code: 'collector-tick-failed', scope: 'full' }), true);
  assert.equal(journal.record({ subsystem: 'stream', code: 'stream-disconnected', detailCode: 'connection-reset' }), true);
  assert.equal(journal.record({ subsystem: 'watcher', code: 'watcher-polling-fallback', detailCode: 'ENOSPC' }), true);

  assert.deepEqual(journal.getSnapshot(), {
    capacity: 2,
    startedAt: '2026-08-05T10:00:00.000Z',
    omittedCount: 1,
    events: [
      {
        at: '2026-08-05T10:00:00.000Z',
        subsystem: 'stream',
        code: 'stream-disconnected',
        detailCode: 'connection-reset'
      },
      {
        at: '2026-08-05T10:00:00.000Z',
        subsystem: 'watcher',
        code: 'watcher-polling-fallback',
        detailCode: 'ENOSPC'
      }
    ]
  });
});

test('diagnostic journal drops raw messages, paths, and unallowlisted events', () => {
  const event = normalizeDiagnosticEvent({
    subsystem: 'collector',
    code: 'collector-tick-failed',
    scope: 'full',
    detailCode: '/Users/javis/private/session.json',
    error: 'secret cookie /Users/javis/private/session.json'
  }, () => Date.parse('2026-08-05T10:00:00.000Z'));

  assert.deepEqual(event, {
    at: '2026-08-05T10:00:00.000Z',
    subsystem: 'collector',
    code: 'collector-tick-failed',
    scope: 'full'
  });
  assert.equal(normalizeDiagnosticEvent({ subsystem: 'collector', code: 'raw-error-message' }), null);
});

test('diagnostic journal keeps the hub mode attached to a transition', () => {
  const event = normalizeDiagnosticEvent({
    subsystem: 'stream',
    code: 'stream-reconnected',
    modeAtEvent: 'client'
  }, () => Date.parse('2026-08-05T10:00:00.000Z'));

  assert.equal(event.modeAtEvent, 'client');
  assert.equal(normalizeDiagnosticEvent({
    subsystem: 'stream',
    code: 'stream-reconnected',
    modeAtEvent: 'private-mode'
  }).modeAtEvent, undefined);
});

test('diagnostic journal rejects event codes without current emitters', () => {
  for (const [subsystem, code] of [
    ['agent', 'agent-became-active'],
    ['agent', 'agent-became-inactive'],
    ['client', 'client-sync-failed'],
    ['client', 'client-sync-recovered'],
    ['limits', 'limits-provider-failed'],
    ['limits', 'limits-recovered']
  ]) {
    assert.equal(normalizeDiagnosticEvent({ subsystem, code }), null);
  }
});
