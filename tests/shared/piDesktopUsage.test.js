'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const {
  buildPiDesktopHistoryGraph,
  buildPiDesktopPeriods,
  buildTokscaleJson,
  collectPiDesktopRows,
  normalizedModelId,
  piDesktopDataPaths,
  piDesktopSessionsDir,
  timestampMs
} = require('../../src/shared/providers/pi/desktopUsage');
const { extractUsageFromTokscale, mergePeriods } = require('../../src/shared/usage');
const { localIso, localMs } = require('../helpers/localTime');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-desktop-usage-'));
  fs.mkdirSync(path.join(home, '.pi-desktop'), { recursive: true });
  return home;
}

function writeDb(home, turns) {
  const dbPath = path.join(home, '.pi-desktop', 'pi.sqlite');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    status TEXT,
    model_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    usage_json TEXT,
    started_at INTEGER,
    ended_at INTEGER
  )`);
  const insert = db.prepare(
    'INSERT INTO turns (id, session_id, status, model_id, input_tokens, output_tokens, usage_json, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const turn of turns) {
    insert.run(
      turn.id,
      turn.sessionId,
      turn.status || 'completed',
      turn.modelId,
      turn.inputTokens ?? null,
      turn.outputTokens ?? null,
      turn.usageJson ? JSON.stringify(turn.usageJson) : null,
      turn.startedAt,
      turn.endedAt ?? turn.startedAt
    );
  }
  db.close();
  return dbPath;
}

// The transcript is attributed through messages.id -> messages.turn_id, which is
// the only link Pi Desktop writes between the two stores.
function writeMessages(home, messages) {
  const db = new sqlite.DatabaseSync(path.join(home, '.pi-desktop', 'pi.sqlite'));
  db.exec('CREATE TABLE messages (id TEXT, session_id TEXT, turn_id TEXT, seq INTEGER, role TEXT, tool_name TEXT, is_error INTEGER, text TEXT, created_at INTEGER)');
  const insert = db.prepare('INSERT INTO messages (id, session_id, turn_id, seq, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let seq = 0;
  for (const message of messages) {
    insert.run(message.id, message.sessionId, message.turnId, seq++, message.role || 'assistant', message.text || '', message.createdAt ?? 0);
  }
  db.close();
}

function writeTranscript(home, sessionId, entries) {
  const dir = piDesktopSessionsDir(path.join(home, '.pi-desktop', 'pi.sqlite'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')}\n`);
  return dir;
}

function assistantMessage(id, modelId, usage, createdAt) {
  return { type: 'message', id, role: 'assistant', createdAt, meta: { modelId, status: 'complete', usage } };
}

test('Pi Desktop reads turns, cache buckets from usage_json, and the completed timestamp', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [
    { id: 'empty', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 0, outputTokens: 0, startedAt: localMs(2026, 7, 8, 9) },
    {
      id: 'turn-1',
      sessionId: 'session-1',
      modelId: '[free]gpt-5.6-sol',
      inputTokens: 324136,
      outputTokens: 20258,
      usageJson: { cacheReadTokens: 722432, cacheCreationTokens: 0, reasoningTokens: 7387 },
      startedAt: localMs(2026, 7, 9, 10),
      endedAt: localMs(2026, 7, 9, 11)
    }
  ]);

  const rows = collectPiDesktopRows({ homeDir: home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'gpt-5.6-sol');
  assert.equal(rows[0].input, 324136);
  assert.equal(rows[0].output, 20258);
  assert.equal(rows[0].cacheRead, 722432);
  assert.equal(rows[0].createdAt, localMs(2026, 7, 9, 11));
  assert.equal(rows[0].sessionId, 'pi-desktop:session-1');
  assert.equal(rows[0].messageId, 'pi-desktop:turn-1');
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop falls back to usage_json counts when the columns are null', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [
    {
      id: 'turn-1',
      sessionId: 'session-1',
      modelId: null,
      usageJson: { model: 'glm-5.3', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 },
      startedAt: localMs(2026, 7, 9, 10)
    }
  ]);

  const rows = collectPiDesktopRows({ homeDir: home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'glm-5.3');
  assert.equal(rows[0].input, 100);
  assert.equal(rows[0].output, 20);
  assert.equal(rows[0].cacheRead, 5);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop periods and history are emitted under the merged pi client', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [
    { id: 'first', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 10, outputTokens: 2, startedAt: localMs(2026, 7, 8, 12) },
    { id: 'second', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 20, startedAt: localMs(2026, 7, 9, 12) }
  ]);

  const periods = buildPiDesktopPeriods({ homeDir: home, now: localIso(2026, 7, 9, 13), allTimeSince: '2026-01-01' });
  assert.equal(periods.today.entries[0].client, 'pi');
  assert.equal(extractUsageFromTokscale(periods.today).clients.pi, 20);
  assert.equal(extractUsageFromTokscale(periods.allTime).clients.pi, 32);

  // The desktop turns must merge, not replace, a pi agent scan period.
  const agentPeriod = { groupBy: 'client,session,model', entries: [{ client: 'pi', mergedClients: null, sessionId: 'agent-session', model: 'glm-5.3', provider: 'pi', input: 5, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 1, cost: 0, startedAt: '', lastUsedAt: '', performance: null }], totalInput: 5, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: 1, totalCost: 0, processingTimeMs: 0 };
  const merged = mergePeriods(extractUsageFromTokscale(agentPeriod), extractUsageFromTokscale(periods.today));
  assert.equal(merged.clients.pi, 25);
  assert.equal(Object.keys(merged.sessions).length, 2);

  const graph = buildPiDesktopHistoryGraph({ homeDir: home });
  assert.deepEqual(graph.contributions, [
    { date: '2026-07-08', clients: [{ client: 'pi', modelId: 'glm-5.3', tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 1 }] },
    { date: '2026-07-09', clients: [{ client: 'pi', modelId: 'glm-5.3', tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 1 }] }
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop windows cut at local midnight and keep undated rows only in all-time', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [
    { id: 'yesterday', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 40, startedAt: localMs(2026, 7, 8, 23, 59) },
    { id: 'today', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 10, startedAt: localMs(2026, 7, 9, 0, 1) },
    { id: 'undated', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 7, startedAt: 0 }
  ]);

  const periods = buildPiDesktopPeriods({ homeDir: home, now: localIso(2026, 7, 9, 12), allTimeSince: '2026-01-01' });
  assert.equal(extractUsageFromTokscale(periods.today).totalTokens, 10);
  assert.equal(extractUsageFromTokscale(periods.month).totalTokens, 50);
  assert.equal(extractUsageFromTokscale(periods.allTime).totalTokens, 57);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop normalizes model prefixes and estimates cost from pricing', () => {
  assert.equal(normalizedModelId('[次]GLM-5.3'), 'glm-5.3');
  assert.equal(normalizedModelId(''), 'unknown');

  const rows = [{
    sessionId: 'pi-desktop:session-1',
    messageId: 'pi-desktop:turn-1',
    model: 'glm-5.3',
    input: 10,
    output: 2,
    cacheRead: 4,
    cacheWrite: 3,
    createdAt: localMs(2026, 7, 9, 12),
    messages: 1
  }];
  const pricingByModel = {
    'glm-5.3': {
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      cacheReadInputTokenCost: 0.0000003,
      cacheCreationInputTokenCost: 0.00000375
    }
  };
  const json = buildTokscaleJson(0, rows, pricingByModel);
  assert.equal(json.entries[0].client, 'pi');
  assert.ok(Math.abs(json.totalCost - 0.00007245) < 1e-12);
});

test('piDesktopDataPaths honors TOKEN_MONITOR_PI_DESKTOP_DB_PATH and falls back to the home root', () => {
  const home = 'C:/fixture-home';
  assert.deepEqual(
    piDesktopDataPaths({ homeDir: home, env: {} }).dbPaths,
    [path.join(home, '.pi-desktop', 'pi.sqlite')]
  );
  assert.deepEqual(
    piDesktopDataPaths({ homeDir: home, env: { TOKEN_MONITOR_PI_DESKTOP_DB_PATH: 'C:/custom/pi.sqlite' } }).dbPaths,
    [path.resolve('C:/custom/pi.sqlite')]
  );
  // The transcripts sit next to whichever database is in play.
  assert.equal(
    piDesktopSessionsDir(path.join(home, '.pi-desktop', 'pi.sqlite')),
    path.join(home, '.pi-desktop', 'sessions')
  );
  assert.equal(piDesktopSessionsDir('C:/custom/pi.sqlite'), path.join('C:/custom', 'sessions'));
});

test('timestampMs parses date strings and keeps numeric seconds/milliseconds handling', () => {
  assert.equal(timestampMs('2024-01-01'), Date.parse('2024-01-01'));
  assert.equal(timestampMs(' 2024-01-01T00:00:00Z '), Date.parse('2024-01-01T00:00:00Z'));
  assert.equal(timestampMs('not-a-date'), 0);
  assert.equal(timestampMs(''), 0);
  assert.equal(timestampMs(null), 0);
  // Numeric strings keep the numeric path: sub-trillion values are seconds.
  assert.equal(timestampMs('1754611200'), 1754611200000);
  assert.equal(timestampMs('1754611200000'), 1754611200000);
  assert.equal(timestampMs(1754611200), 1754611200000);
  assert.equal(timestampMs(1754611200000), 1754611200000);
  assert.equal(timestampMs(new Date(1754611200000)), 1754611200000);
});

test('buildPiDesktopPeriods honors date-string allTimeSince boundaries', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  // The 2023 row must be dropped by a real boundary in every UTC offset; the
  // 2026 row must survive. A naive "boundary degenerates to 0" would keep both.
  writeDb(home, [
    { id: 'old', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 999, startedAt: localMs(2023, 7, 1, 12) },
    { id: 'new', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 30, startedAt: localMs(2026, 7, 9, 12) }
  ]);
  const periods = buildPiDesktopPeriods({ homeDir: home, allTimeSince: '2024-01-01' });
  assert.equal(extractUsageFromTokscale(periods.allTime).totalTokens, 30, 'a date-string allTimeSince must become a real boundary that drops pre-2024 rows');
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop treats a missing database as empty instead of throwing', () => {
  const home = makeHome();
  assert.deepEqual(collectPiDesktopRows({ homeDir: home }), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop fills a still-running turn from the session transcript', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  // A turn in flight: the row exists, but its counters are not flushed yet, so
  // the transcript is the only place its usage can be seen before the turn ends.
  writeDb(home, [
    { id: 'done', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 100, outputTokens: 10, startedAt: localMs(2026, 7, 9, 9) },
    { id: 'live', sessionId: 'session-1', status: 'running', modelId: '[free]kimi-k3', inputTokens: 0, outputTokens: 0, startedAt: localMs(2026, 7, 9, 12) }
  ]);
  writeMessages(home, [
    { id: 'm-1', sessionId: 'session-1', turnId: 'live' },
    { id: 'm-2', sessionId: 'session-1', turnId: 'live' }
  ]);
  writeTranscript(home, 'session-1', [
    { type: 'session', createdAt: localIso(2026, 7, 9, 12), sessionId: 'session-1' },
    assistantMessage('m-1', '[free]kimi-k3', { inputTokens: 8930, outputTokens: 154, cacheReadTokens: 8192 }, localIso(2026, 7, 9, 12, 1)),
    assistantMessage('m-2', '[free]kimi-k3', { inputTokens: 1000, outputTokens: 20, cacheReadTokens: null }, localIso(2026, 7, 9, 12, 2))
  ]);

  const rows = collectPiDesktopRows({ homeDir: home });
  assert.equal(rows.length, 2);
  const live = rows.find((row) => row.messageId === 'pi-desktop:live');
  assert.ok(live, 'the running turn must be filled from the transcript');
  assert.equal(live.sessionId, 'pi-desktop:session-1');
  assert.equal(live.model, 'kimi-k3');
  assert.equal(live.input, 9930);
  assert.equal(live.output, 174);
  assert.equal(live.cacheRead, 8192);
  assert.equal(live.messages, 1);
  assert.equal(live.createdAt, localMs(2026, 7, 9, 12, 2));
  assert.equal(live.startedAt, localMs(2026, 7, 9, 12, 1));
  assert.equal(live.endedAt, null);

  // The fill must land on the pi partition, never on a client of its own.
  const periods = buildPiDesktopPeriods({ homeDir: home, now: localIso(2026, 7, 9, 13), allTimeSince: '2026-01-01' });
  const today = extractUsageFromTokscale(periods.today);
  // Flushed turn (100+10) plus the filled running turn (8930+1000 input, 154+20 output, 8192 cache read).
  assert.equal(today.clients.pi, 100 + 10 + 9930 + 174 + 8192);
  assert.equal(today.clientCacheReads.pi, 8192);
  assert.equal(today.clientOutputs.pi, 184);
  assert.equal(today.models['kimi-k3'], 9930 + 174 + 8192);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop never counts a flushed turn twice', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [
    { id: 'turn-1', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 500, outputTokens: 50, startedAt: localMs(2026, 7, 9, 10) }
  ]);
  writeMessages(home, [{ id: 'm-1', sessionId: 'session-1', turnId: 'turn-1' }]);
  writeTranscript(home, 'session-1', [
    assistantMessage('m-1', 'glm-5.3', { inputTokens: 500, outputTokens: 50 }, localIso(2026, 7, 9, 10))
  ]);

  const rows = collectPiDesktopRows({ homeDir: home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, 'pi-desktop:turn-1');
  assert.equal(rows[0].input, 500);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop only reads transcripts for sessions with an unflushed turn', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [
    { id: 'flushed', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 500, outputTokens: 50, startedAt: localMs(2026, 7, 9, 10) },
    { id: 'live', sessionId: 'session-2', status: 'running', modelId: 'glm-5.3', inputTokens: 0, outputTokens: 0, startedAt: localMs(2026, 7, 9, 12) }
  ]);
  writeMessages(home, [
    { id: 'm-1', sessionId: 'session-1', turnId: 'flushed' },
    { id: 'm-2', sessionId: 'session-2', turnId: 'live' }
  ]);
  writeTranscript(home, 'session-1', [assistantMessage('m-1', 'glm-5.3', { inputTokens: 500 }, localIso(2026, 7, 9, 10))]);
  writeTranscript(home, 'session-2', [assistantMessage('m-2', 'glm-5.3', { inputTokens: 9 }, localIso(2026, 7, 9, 12))]);
  // A transcript with no store rows at all must never be attributed to a turn.
  writeTranscript(home, 'orphan-session', [assistantMessage('m-3', 'glm-5.3', { inputTokens: 777777 }, localIso(2026, 7, 9, 12))]);

  const rows = collectPiDesktopRows({ homeDir: home });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.messageId === 'pi-desktop:flushed').input, 500);
  assert.equal(rows.find((row) => row.messageId === 'pi-desktop:live').input, 9);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop keeps the turns-table count when the transcript was compacted', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [
    { id: 'turn-1', sessionId: 'session-1', modelId: 'glm-5.3', inputTokens: 567498, outputTokens: 13646, startedAt: localMs(2026, 7, 9, 10) }
  ]);
  writeMessages(home, [{ id: 'tail', sessionId: 'session-1', turnId: 'turn-1' }]);
  // Compaction drops the head of a conversation, so the transcript only still
  // holds the tail of this turn — far less than the turn actually consumed.
  writeTranscript(home, 'session-1', [
    { type: 'compaction', createdAt: localIso(2026, 7, 9, 10) },
    assistantMessage('tail', 'glm-5.3', { inputTokens: 32094, outputTokens: 931 }, localIso(2026, 7, 9, 10, 5))
  ]);

  const rows = collectPiDesktopRows({ homeDir: home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 567498, 'a compacted transcript must never replace the flushed turn count');
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop ignores revision sidecars and transcript messages with no turn link', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [
    { id: 'live', sessionId: 'session-1', status: 'running', modelId: 'glm-5.3', inputTokens: 0, outputTokens: 0, startedAt: localMs(2026, 7, 9, 12) }
  ]);
  writeMessages(home, [{ id: 'linked', sessionId: 'session-1', turnId: 'live' }]);
  const dir = writeTranscript(home, 'session-1', [
    assistantMessage('linked', 'glm-5.3', { inputTokens: 7 }, localIso(2026, 7, 9, 12, 1))
  ]);
  // Sidecars carry revision markers, never usage.
  fs.writeFileSync(path.join(dir, 'session-1.revisions.jsonl'), `${JSON.stringify({ type: 'revision', createdAt: localIso(2026, 7, 9, 12) })}\n`);
  // A message with no messages-table row cannot be attributed to any turn.
  fs.appendFileSync(path.join(dir, 'session-1.jsonl'), `${JSON.stringify(assistantMessage('orphan', 'glm-5.3', { inputTokens: 999999 }, localIso(2026, 7, 9, 12, 2)))}\n`);

  const rows = collectPiDesktopRows({ homeDir: home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 7);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop tolerates a partially written transcript tail', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [
    { id: 'live', sessionId: 'session-1', status: 'running', modelId: 'glm-5.3', inputTokens: 0, outputTokens: 0, startedAt: localMs(2026, 7, 9, 12) }
  ]);
  writeMessages(home, [{ id: 'a', sessionId: 'session-1', turnId: 'live' }]);
  const dir = writeTranscript(home, 'session-1', [
    assistantMessage('a', 'glm-5.3', { inputTokens: 11, outputTokens: 1 }, localIso(2026, 7, 9, 12, 1))
  ]);
  // A live turn leaves a half-written line behind; it must be skipped, not fatal.
  fs.appendFileSync(path.join(dir, 'session-1.jsonl'), '{"type":"message","id":"b","meta":{"usa');

  const rows = collectPiDesktopRows({ homeDir: home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 11);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi Desktop keeps the turns table when the store has no messages table', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [
    { id: 'live', sessionId: 'session-1', status: 'running', modelId: 'glm-5.3', inputTokens: 0, outputTokens: 0, startedAt: localMs(2026, 7, 9, 12) }
  ]);
  writeTranscript(home, 'session-1', [
    assistantMessage('a', 'glm-5.3', { inputTokens: 11 }, localIso(2026, 7, 9, 12, 1))
  ]);

  // Without the link table the transcript is unusable, and that is not an error.
  assert.deepEqual(collectPiDesktopRows({ homeDir: home }), []);
  fs.rmSync(home, { recursive: true, force: true });
});