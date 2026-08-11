'use strict';

const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MAC_WIDGET_ACTIVITY_DAYS } = require('../../src/shared/macWidgetSnapshot');
const {
  MAC_WIDGET_HISTORY_CACHE_VERSION,
  MAX_MAC_WIDGET_HISTORY_CACHE_BYTES,
  MAX_MAC_WIDGET_HISTORY_CACHE_ENTRIES,
  macWidgetHistoryCachePath,
  projectMacWidgetHistory,
  readMacWidgetHistoryCache,
  writeMacWidgetHistoryCache
} = require('../../src/electron/macWidgetHistoryStore');

function history(label = 'saved', daily = null) {
  return {
    daily: daily || [{
      date: '2026-08-09',
      tokens: 123,
      cost: 0.25,
      messages: 4,
      perClient: { codex: { tokens: 123, cost: 0.25 } },
      perModel: { sensitiveModel: { tokens: 123, cost: 0.25 } },
      label
    }],
    monthly: [{ month: '2026-08', tokens: 123, perClient: { codex: { tokens: 123 } } }],
    summary: { favoriteModel: 'sensitiveModel', label }
  };
}

async function withTempRoot(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-monitor-widget-history-'));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('production history cache storage uses only asynchronous filesystem I/O', () => {
  const source = fsSync.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'electron', 'macWidgetHistoryStore.js'),
    'utf8'
  );
  assert.match(source, /require\('node:fs\/promises'\)/);
  assert.doesNotMatch(source, /readRegularFileNoFollow|writePrivateJsonAtomic/);
  assert.doesNotMatch(
    source,
    /\b(?:lstat|open|fstat|fchmod|read|readFile|write|writeFile|fsync|rename|mkdir|rm|close)Sync\b/
  );
});

test('history cache round-trips a private Widget-only projection atomically', async () => {
  await withTempRoot(async (root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    const value = history();

    const writePromise = writeMacWidgetHistoryCache(cachePath, 'hub-a', value);
    assert.equal(typeof writePromise?.then, 'function');
    await writePromise;

    const readPromise = readMacWidgetHistoryCache(cachePath, 'hub-a');
    assert.equal(typeof readPromise?.then, 'function');
    assert.deepEqual(await readPromise, {
      daily: [{ date: '2026-08-09', tokens: 123, cost: 0.25 }],
      monthly: [],
      summary: {}
    });
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(cachePath)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(cachePath))).mode & 0o777, 0o700);
    }
    assert.deepEqual(await fs.readdir(path.dirname(cachePath)), [path.basename(cachePath)]);

    const raw = await fs.readFile(cachePath, 'utf8');
    assert.doesNotMatch(raw, /sensitiveModel|perClient|perModel|monthly|summary|messages|label/);
  });
});

test('Widget history projection keeps only the latest Activity window', () => {
  const start = Date.UTC(2025, 0, 1);
  const daily = Array.from({ length: MAC_WIDGET_ACTIVITY_DAYS + 18 }, (_value, index) => ({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    tokens: index + 0.6,
    cost: index / 10,
    perClient: { privateClient: { tokens: index } }
  }));

  const projected = projectMacWidgetHistory(history('full', daily));
  assert.equal(projected.daily.length, MAC_WIDGET_ACTIVITY_DAYS);
  assert.equal(projected.daily[0].date, daily[18].date);
  assert.deepEqual(Object.keys(projected.daily[0]), ['date', 'tokens', 'cost']);
  assert.equal(projected.daily[0].tokens, Math.round(daily[18].tokens));
  assert.deepEqual(projected.monthly, []);
  assert.deepEqual(projected.summary, {});
});

test('history cache serializes once and writes the same serialized payload', async () => {
  await withTempRoot(async (root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    let calls = 0;
    let expected = '';
    await writeMacWidgetHistoryCache(cachePath, 'hub-a', history(), {
      stringify: (document) => {
        calls += 1;
        expected = JSON.stringify(document);
        return expected;
      }
    });

    assert.equal(calls, 1);
    assert.equal(await fs.readFile(cachePath, 'utf8'), `${expected}\n`);
  });
});

test('history cache rejects a different source and schema version', async () => {
  await withTempRoot(async (root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    await writeMacWidgetHistoryCache(cachePath, 'hub-a', history());
    assert.equal(await readMacWidgetHistoryCache(cachePath, 'hub-b'), null);

    await fs.writeFile(cachePath, JSON.stringify({
      version: 999,
      source: 'anything',
      daily: []
    }));
    assert.equal(await readMacWidgetHistoryCache(cachePath, 'hub-a'), null);
  });
});

test('history cache ignores malformed or overlong projected documents', async () => {
  await withTempRoot(async (root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, '{broken');
    assert.equal(await readMacWidgetHistoryCache(cachePath, 'hub-a'), null);

    const source = path.basename(cachePath, '.json');
    await fs.writeFile(cachePath, JSON.stringify({
      version: MAC_WIDGET_HISTORY_CACHE_VERSION,
      source,
      daily: Array.from({ length: MAC_WIDGET_ACTIVITY_DAYS + 1 }, (_value, index) => ({
        date: `2026-01-${String(index + 1).padStart(2, '0')}`,
        tokens: 1,
        cost: 0
      }))
    }));
    assert.equal(await readMacWidgetHistoryCache(cachePath, 'hub-a'), null);
  });
});

test('history cache bounds reads before parsing', async () => {
  await withTempRoot(async (root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    const warnings = [];
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, 'x'.repeat(MAX_MAC_WIDGET_HISTORY_CACHE_BYTES + 1));

    assert.equal(await readMacWidgetHistoryCache(cachePath, 'hub-a', {
      logger: (message) => warnings.push(message)
    }), null);
    assert.ok(warnings.some((message) => /exceeds/.test(message)));
  });
});

test('history cache refuses an oversized write before creating a file', async () => {
  await withTempRoot(async (root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    await assert.rejects(
      writeMacWidgetHistoryCache(cachePath, 'hub-a', history(), { maxBytes: 32 }),
      /exceeds 32 bytes/
    );
    assert.equal(fsSync.existsSync(cachePath), false);
  });
});

test('history cache rejects non-regular files', async () => {
  await withTempRoot(async (root) => {
    const cachePath = macWidgetHistoryCachePath(root, 'hub-a');
    await fs.mkdir(cachePath, { recursive: true });
    assert.equal(await readMacWidgetHistoryCache(cachePath, 'hub-a'), null);
  });
});

test('history cache rejects symlinks', { skip: process.platform === 'win32' }, async () => {
  await withTempRoot(async (root) => {
    const realPath = macWidgetHistoryCachePath(root, 'real');
    const linkPath = macWidgetHistoryCachePath(root, 'hub-a');
    await writeMacWidgetHistoryCache(realPath, 'real', history());
    await fs.symlink(realPath, linkPath);
    assert.equal(await readMacWidgetHistoryCache(linkPath, 'hub-a'), null);
  });
});

test('history cache retains only the newest bounded source entries', async () => {
  await withTempRoot(async (root) => {
    const paths = [];
    for (let index = 0; index < MAX_MAC_WIDGET_HISTORY_CACHE_ENTRIES; index += 1) {
      const sourceKey = `hub-${index}`;
      const cachePath = macWidgetHistoryCachePath(root, sourceKey);
      paths.push(cachePath);
      await writeMacWidgetHistoryCache(cachePath, sourceKey, history(String(index)));
      const timestamp = new Date(1_000_000 + index * 1_000);
      await fs.utimes(cachePath, timestamp, timestamp);
    }

    for (let index = MAX_MAC_WIDGET_HISTORY_CACHE_ENTRIES; index < MAX_MAC_WIDGET_HISTORY_CACHE_ENTRIES + 2; index += 1) {
      const sourceKey = `hub-${index}`;
      const cachePath = macWidgetHistoryCachePath(root, sourceKey);
      paths.push(cachePath);
      await writeMacWidgetHistoryCache(cachePath, sourceKey, history(String(index)));
    }

    const names = await fs.readdir(path.dirname(paths.at(-1)));
    assert.equal(names.length, MAX_MAC_WIDGET_HISTORY_CACHE_ENTRIES);
    assert.equal(fsSync.existsSync(paths[0]), false);
    assert.equal(fsSync.existsSync(paths[1]), false);
    assert.equal(fsSync.existsSync(paths.at(-1)), true);
  });
});
