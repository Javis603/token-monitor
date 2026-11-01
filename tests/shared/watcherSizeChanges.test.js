'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

// Windows can keep mtime unchanged while a writer holds its handle open. Once
// atime is newer than mtime, chokidar 4.0.3 mistakes subsequent appends for reads.
// Exercise the installed dependency, not a copy of its change predicate, so a
// missing install-time patch also fails CI. Both published module formats and
// both native (fresh stat) / polling (supplied stat) paths need the same fix.
const chokidarDir = path.dirname(require.resolve('chokidar'));

async function fileWatcher(t, format, supplied) {
  const { NodeFsHandler } = format === 'CommonJS'
    ? require(path.join(chokidarDir, 'handler.js'))
    : await import(pathToFileURL(path.join(chokidarDir, 'esm', 'handler.js')).href);
  const file = path.resolve('session.jsonl');
  const initial = { size: 100, mtimeMs: 1000, atimeMs: 2000, ino: 1 };
  let nextStats = initial;
  const stat = t.mock.method(fs, 'stat', async (filePath) => {
    assert.equal(filePath, file);
    return nextStats;
  });
  syncBuiltinESMExports();
  t.after(() => {
    stat.mock.restore();
    syncBuiltinESMExports();
  });

  const events = [];
  const members = new Set();
  const watcher = {
    closed: false,
    options: { ignoreInitial: true },
    _handleError(error) { throw error; },
    _getWatchedDir: () => ({ has: (name) => members.has(name) }),
    _throttle: () => true,
    _emit: (event, filePath, stats) => events.push({ event, filePath, stats }),
    _remove: () => assert.fail('an existing file must not be removed')
  };
  const handler = new NodeFsHandler(watcher);
  let listener;
  handler._watchWithNodeFs = (_file, callback) => {
    listener = callback;
    members.add(path.basename(file));
    return () => {};
  };
  handler._handleFile(file, initial, true);

  return {
    events,
    async change(stats) {
      nextStats = { ...initial, ...stats };
      await listener(file, supplied ? nextStats : undefined);
    }
  };
}

for (const format of ['CommonJS', 'ESM']) {
  for (const supplied of [false, true]) {
    const lane = `${format}, ${supplied ? 'supplied stat' : 'native event'}`;
    test(`${lane}: fixed mtime with growing size emits each append`, async (t) => {
      const watcher = await fileWatcher(t, format, supplied);
      await watcher.change({ size: 150 });
      await watcher.change({ size: 200 });
      assert.deepEqual(watcher.events.map(({ event, stats }) => [event, stats.size]), [
        ['change', 150], ['change', 200]
      ]);
    });

    test(`${lane}: fixed mtime with shrinking size emits truncation`, async (t) => {
      const watcher = await fileWatcher(t, format, supplied);
      await watcher.change({ size: 50 });
      assert.deepEqual(watcher.events.map(({ event, stats }) => [event, stats.size]), [
        ['change', 50]
      ]);
    });

    test(`${lane}: atime-only changes stay suppressed`, async (t) => {
      const watcher = await fileWatcher(t, format, supplied);
      await watcher.change({ atimeMs: 3000 });
      await watcher.change({ atimeMs: 4000 });
      assert.deepEqual(watcher.events, []);
    });

    test(`${lane}: duplicate notifications after an append stay suppressed`, async (t) => {
      const watcher = await fileWatcher(t, format, supplied);
      await watcher.change({ size: 150 });
      await watcher.change({ size: 150, atimeMs: 4000 });
      assert.equal(watcher.events.length, 1);
    });

    test(`${lane}: normal mtime changes still emit`, async (t) => {
      const watcher = await fileWatcher(t, format, supplied);
      await watcher.change({ mtimeMs: 1500, atimeMs: 3000 });
      assert.deepEqual(watcher.events.map(({ event, stats }) => [event, stats.mtimeMs]), [
        ['change', 1500]
      ]);
    });
  }
}
