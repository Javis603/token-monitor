#!/usr/bin/env node
'use strict';

// Synthetic main/renderer pipeline benchmark; not a live Electron frame-time
// measurement. Run: node --expose-gc scripts/benchmark-grok-bot-grouping.js
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { composeLocalSyncSummary, completeLocalSyncStats } = require('../src/electron/syncDisplayStats');
const { rendererStats } = require('../src/electron/statsPublisher');
const { isGrokBotSession, sessionRowsForPeriod, groupSessionRows } = require('../src/electron/renderer/sessionRows');

function fixture(count) {
  const history = {};
  const current = {};
  for (let index = 0; index < count; index += 1) {
    const id = `conversation-${index}`;
    const session = { client: 'cursor', sessionId: id, totalTokens: 100, costUsd: 0.01,
      lastUsedAt: '2026-09-01T10:00:00Z', models: { [index % 2 ? 'claude-opus-5-5-medium' : 'grok-bot-default']: 100 } };
    history[`cursor:${id}`] = session;
    if (index < 200) current[`cursor:${id}`] = { ...session, totalTokens: 10,
      lastUsedAt: '2026-10-10T10:00:00Z', models: { 'claude-opus-5-5-medium': 10 } };
  }
  return { deviceId: 'benchmark', today: { sessions: current }, month: { sessions: current },
    allTime: { sessions: history } };
}

function run(local, legacy) {
  // Real collections replace the record; do not accidentally benchmark a
  // previously cached full normalization/completion on later iterations.
  const start = performance.now();
  const summary = composeLocalSyncSummary(null, { ...local });
  const visible = structuredClone(rendererStats(summary));
  let extraBytes;
  if (legacy) {
    // Reproduce #987's old DAY/MONTH path: pull and clone full history, then
    // enumerate every period to build the renderer's bot-id set.
    const allTime = completeLocalSyncStats(summary).periods.allTime.sessions;
    visible.periods.allTime.sessions = structuredClone(allTime);
    const ids = new Set();
    for (const period of Object.values(visible.periods)) {
      for (const [key, session] of Object.entries(period.sessions || {})) {
        if (isGrokBotSession(session, key)) ids.add(session.sessionId || key.replace(/^cursor:/, ''));
      }
    }
    visible.grokBotSessionIds = [...ids];
  }
  const rows = groupSessionRows(sessionRowsForPeriod(visible.periods.today, visible));
  const ms = performance.now() - start;
  // Measure transferred detail outside the timed path (IPC uses clone, not JSON).
  extraBytes = Buffer.byteLength(JSON.stringify(legacy ? visible.periods.allTime.sessions : visible.grokBotSessionIds));
  assert.equal(rows.find(row => row.sessionGroup === 'cursor-grok-bot').groupRows.length, 100);
  assert.equal(rows.reduce((sum, row) => sum + row.value, 0), 2000);
  assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.cost, 0) - 2) < 1e-10);
  return { ms, extraBytes };
}

const results = [];
for (const count of [10_000, 100_000]) {
  const local = fixture(count);
  const samples = { legacy: [], compact: [] };
  for (let index = 0; index < 4; index += 1) {
    for (const [name, legacy] of [['legacy', true], ['compact', false]]) {
      global.gc?.();
      const result = run(local, legacy);
      if (index > 0) samples[name].push(result); // discard warm-up
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  results.push({ historicalSessions: count, currentSessions: 200,
    legacyMedianMs: +median(samples.legacy.map(value => value.ms)).toFixed(2),
    compactMedianMs: +median(samples.compact.map(value => value.ms)).toFixed(2),
    legacyDetailBytes: samples.legacy[0].extraBytes, compactIdentityBytes: samples.compact[0].extraBytes });
}
console.table(results);
