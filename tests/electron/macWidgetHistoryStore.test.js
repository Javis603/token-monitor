'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_MAC_WIDGET_HISTORY_CACHE_BYTES,
  macWidgetHistoryCachePath,
  readMacWidgetHistoryCache,
  writeMacWidgetHistoryCache
} = require('../../src/electron/macWidgetHistoryStore');

function history(label) {
  return { daily: [{ date: '2026-08-09', totalTokens: 1, label }], monthly: [], summary: { label } };
}

function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-widget-history-'));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('history cache round-trips atomically with private permissions', () => {
  withTempRoot((root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    const value = history('saved');

    writeMacWidgetHistoryCache(cachePath, 'hub-a', value);

    assert.deepEqual(readMacWidgetHistoryCache(cachePath, 'hub-a'), value);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(cachePath)).mode & 0o777, 0o700);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(cachePath)), [path.basename(cachePath)]);
  });
});

test('history cache rejects a different source and schema version', () => {
  withTempRoot((root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    writeMacWidgetHistoryCache(cachePath, 'hub-a', history('saved'));
    assert.equal(readMacWidgetHistoryCache(cachePath, 'hub-b'), null);

    fs.writeFileSync(cachePath, JSON.stringify({
      version: 999,
      source: 'anything',
      history: history('wrong-version')
    }));
    assert.equal(readMacWidgetHistoryCache(cachePath, 'hub-a'), null);
  });
});

test('history cache ignores malformed JSON', () => {
  withTempRoot((root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, '{broken');
    assert.equal(readMacWidgetHistoryCache(cachePath, 'hub-a'), null);
  });
});

test('history cache bounds reads before parsing', () => {
  withTempRoot((root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    const warnings = [];
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, 'x'.repeat(MAX_MAC_WIDGET_HISTORY_CACHE_BYTES + 1));

    assert.equal(readMacWidgetHistoryCache(cachePath, 'hub-a', {
      logger: (message) => warnings.push(message)
    }), null);
    assert.ok(warnings.some((message) => /exceeds/.test(message)));
  });
});

test('history cache refuses an oversized write before creating a file', () => {
  withTempRoot((root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    assert.throws(
      () => writeMacWidgetHistoryCache(cachePath, 'hub-a', history('too-large'), { maxBytes: 32 }),
      /exceeds 32 bytes/
    );
    assert.equal(fs.existsSync(cachePath), false);
  });
});

test('history cache rejects non-regular files', () => {
  withTempRoot((root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    fs.mkdirSync(cachePath, { recursive: true });
    assert.equal(readMacWidgetHistoryCache(cachePath, 'hub-a'), null);
  });
});

test('history cache rejects symlinks', { skip: process.platform === 'win32' }, () => {
  withTempRoot((root) => {
    const realPath = macWidgetHistoryCachePath(root, 'real');
    const linkPath = macWidgetHistoryCachePath(root, 'hub-a');
    writeMacWidgetHistoryCache(realPath, 'real', history('real'));
    fs.symlinkSync(realPath, linkPath);
    assert.equal(readMacWidgetHistoryCache(linkPath, 'hub-a'), null);
  });
});
