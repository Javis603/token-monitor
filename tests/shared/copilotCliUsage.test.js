'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectCopilotCliPeriods, readLastShutdownSession } = require('../../src/shared/copilotCliUsage');
const { collectUsageOnce } = require('../../src/shared/collector');

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cli-home-'));
}

function writeEvents(home, sessionId, events) {
  const dir = path.join(home, '.copilot', 'session-state', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'events.jsonl');
  fs.writeFileSync(filePath, events.map((event) => JSON.stringify(event)).join('\n'));
  return filePath;
}

function shutdownEvent(timestamp = '2026-06-28T07:17:32.209Z') {
  return {
    type: 'session.shutdown',
    timestamp,
    data: {
      sessionStartTime: Date.parse('2026-06-28T07:15:28.487Z'),
      modelMetrics: {
        'gpt-5-mini': {
          requests: { count: 10, cost: 0 },
          usage: {
            inputTokens: 152728,
            outputTokens: 4097,
            cacheReadTokens: 114560,
            cacheWriteTokens: 0,
            reasoningTokens: 2432
          }
        }
      }
    }
  };
}

test('readLastShutdownSession converts Copilot CLI shutdown metrics into a session', () => {
  const home = makeHome();
  try {
    const filePath = writeEvents(home, 's1', [
      { type: 'session.start', timestamp: '2026-06-28T07:15:29.000Z', data: {} },
      shutdownEvent()
    ]);

    const session = readLastShutdownSession(filePath, 's1');
    assert.equal(session.client, 'copilot');
    assert.equal(session.sessionId, 's1');
    assert.equal(session.totalTokens, 271385);
    assert.equal(session.inputTokens, 152728);
    assert.equal(session.outputTokens, 4097);
    assert.equal(session.cacheReadTokens, 114560);
    assert.equal(session.reasoningTokens, 2432);
    assert.equal(session.messageCount, 10);
    assert.equal(session.models['gpt-5-mini'], 271385);
    assert.equal(session.providers.github, 271385);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collectCopilotCliPeriods buckets Copilot CLI sessions into local periods', () => {
  const home = makeHome();
  try {
    writeEvents(home, 'today-session', [shutdownEvent('2026-06-28T07:17:32.209Z')]);
    writeEvents(home, 'old-session', [shutdownEvent('2026-05-01T07:17:32.209Z')]);

    const periods = collectCopilotCliPeriods({
      homeDir: home,
      now: '2026-06-28T08:00:00.000Z',
      allTimeSince: '2026-01-01'
    });

    assert.equal(periods.today.clients.copilot, 271385);
    assert.equal(periods.month.clients.copilot, 271385);
    assert.equal(periods.allTime.clients.copilot, 542770);
    assert.equal(periods.today.sessions['copilot:today-session'].models['gpt-5-mini'], 271385);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collectUsageOnce supplements tokscale with Copilot CLI session-state usage', async () => {
  const home = makeHome();
  try {
    writeEvents(home, 's1', [shutdownEvent()]);
    const emptyTokscale = async () => ({ entries: [] });

    const summary = await collectUsageOnce({
      clients: 'copilot',
      allTimeSince: '2026-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      homeDir: home,
      now: '2026-06-28T08:00:00.000Z',
      runTokscale: emptyTokscale,
      historyEnabled: false,
      limitsEnabled: false,
      wslScanEnabled: false
    });

    assert.equal(summary.today.clients.copilot, 271385);
    assert.equal(summary.month.clients.copilot, 271385);
    assert.equal(summary.allTime.clients.copilot, 271385);
    assert.equal(summary.clientStatus.copilot, 'active');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
