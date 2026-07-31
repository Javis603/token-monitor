'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readSessionDetailForPlatform } = require('../../src/shared/sessionDetailResolver');

function missing(args) {
  return { found: false, client: args.client, sessionId: args.sessionId, exchanges: [] };
}

test('reads a Claude transcript from a discovered WSL home', (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-detail-'));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-detail-'));
  t.after(() => fs.rmSync(nativeHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(wslHome, { recursive: true, force: true }));
  const sessionId = 'wsl-session';
  const transcriptDir = path.join(wslHome, '.claude', 'projects', '-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: '2026-07-31T00:00:00.000Z', message: { content: 'from WSL' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-31T00:00:01.000Z',
      message: {
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
        content: []
      }
    })
  ].join('\n'));

  const detail = readSessionDetailForPlatform(
    { client: 'claude', sessionId, period: 'total', sessionCost: 0.25 },
    {
      platform: 'win32',
      homedir: () => nativeHome,
      wslUsageHomes: () => [wslHome]
    }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.exchanges[0].promptPreview, 'from WSL');
  assert.equal(detail.totals.totalTokens, 18);
  assert.equal(detail.totals.costUsd, 0.25);
});

test('returns a native Claude detail without enumerating WSL homes', () => {
  let enumerated = false;
  const detail = readSessionDetailForPlatform(
    { client: 'claude', sessionId: 'native' },
    {
      platform: 'win32',
      homedir: () => 'C:\\Users\\me',
      readSessionDetail: (args) => ({ ...missing(args), found: true, home: args.home }),
      wslUsageHomes: () => { enumerated = true; return []; }
    }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.home, 'C:\\Users\\me');
  assert.equal(enumerated, false);
});

for (const client of ['claude', 'codex']) {
  test(`falls back to running WSL homes for ${client} JSONL details on Windows`, () => {
    const homes = [];
    const detail = readSessionDetailForPlatform(
      { client, sessionId: 'wsl-session' },
      {
        platform: 'win32',
        homedir: () => 'C:\\Users\\me',
        readSessionDetail: (args) => {
          homes.push(args.home);
          return args.home.endsWith('\\ubuntu') ? { ...missing(args), found: true, home: args.home } : missing(args);
        },
        wslUsageHomes: () => ['\\\\wsl$\\Ubuntu\\home\\first', '\\\\wsl$\\Ubuntu\\home\\ubuntu']
      }
    );

    assert.equal(detail.found, true);
    assert.equal(detail.home, '\\\\wsl$\\Ubuntu\\home\\ubuntu');
    assert.deepEqual(homes, [
      'C:\\Users\\me',
      '\\\\wsl$\\Ubuntu\\home\\first',
      '\\\\wsl$\\Ubuntu\\home\\ubuntu'
    ]);
  });
}

test('does not inspect WSL homes for non-Windows or SQLite-backed clients', () => {
  for (const [platform, client] of [['linux', 'claude'], ['win32', 'opencode']]) {
    let enumerated = false;
    const detail = readSessionDetailForPlatform(
      { client, sessionId: 'missing' },
      {
        platform,
        homedir: () => '/native',
        readSessionDetail: missing,
        wslUsageHomes: () => { enumerated = true; return ['should-not-run']; }
      }
    );

    assert.equal(detail.found, false);
    assert.equal(enumerated, false);
  }
});

test('returns the native not-found result when WSL discovery fails', () => {
  const nativeDetail = { found: false, client: 'claude', sessionId: 'missing', exchanges: [], marker: 'native' };
  const detail = readSessionDetailForPlatform(
    { client: 'claude', sessionId: 'missing' },
    {
      platform: 'win32',
      homedir: () => 'C:\\Users\\me',
      readSessionDetail: () => nativeDetail,
      wslUsageHomes: () => { throw new Error('WSL unavailable'); }
    }
  );

  assert.equal(detail, nativeDetail);
});
