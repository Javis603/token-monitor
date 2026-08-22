'use strict';

// The collector's default watch host is a worker thread, because chokidar's
// close() is synchronous and superlinear in watched-directory count and would
// otherwise freeze the UI thread on every tracked-client change.
//
// A worker has its own module registry, so the `chokidar.watch` stubs these
// tests install cannot reach it — an unpinned test would silently watch the
// real filesystem and hold the process open. What those tests actually cover is
// the collector's reaction to watch events (debounce, targeted scope, self-sync
// throttling), and that logic is identical on both hosts, so pinning them to
// the in-process host keeps the coverage exact.
//
// Applied per file rather than per case for the same reason as the source-env
// guard: a test added later should be hermetic by default, not by remembering.
// Worker transport itself is covered separately, in watcherHost.test.js.
const WATCH_HOST_ENV = 'TOKEN_MONITOR_WATCH_IN_PROCESS';

function installInProcessWatchHost(test) {
  let saved = null;
  test.beforeEach(() => {
    saved = process.env[WATCH_HOST_ENV];
    process.env[WATCH_HOST_ENV] = '1';
  });
  test.afterEach(() => {
    if (saved === undefined) delete process.env[WATCH_HOST_ENV];
    else process.env[WATCH_HOST_ENV] = saved;
  });
}

module.exports = { WATCH_HOST_ENV, installInProcessWatchHost };
