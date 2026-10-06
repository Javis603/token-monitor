'use strict';

// The real usage worker with a scripted collector in place of tokscale scans.
// A worker has its own module registry, so the stub has to be installed inside
// the thread, before usageWorker.js takes its reference to startCollector.
// Everything past the collector — the transform, the session archive store and
// the message protocol — is the production code.

const { spawn } = require('node:child_process');

const collector = require('../../src/shared/collector');
const { createSubprocessTermination } = require('../../src/shared/subprocessTermination');
const { normalizePeriod } = require('../../src/shared/usage');

collector.startCollector = (options) => {
  let stopped = false;
  let ticks = 0;
  let tokens = 100;
  const sessionId = options.scriptedSessionId || 'c1';
  const summary = () => {
    // Normalized like real collector output, which the transform relies on.
    const period = normalizePeriod({
      totalTokens: tokens,
      clients: { codex: tokens },
      sessions: { [`codex:${sessionId}`]: { client: 'codex', sessionId, totalTokens: tokens } }
    });
    return {
      deviceId: 'scripted',
      updatedAt: '2026-07-09T08:15:00.000Z',
      today: period,
      month: period,
      allTime: period
    };
  };
  return {
    async tick(reason) {
      ticks += 1;
      if (reason === 'crash') {
        setImmediate(() => { throw new Error('scripted crash'); });
        return new Promise(() => {});
      }
      if (reason === 'fail') {
        options.onError?.(new Error('scripted failure'), reason);
        return false;
      }
      if (reason === 'spawn') {
        // A subprocess that outlives the tick, registered the way the
        // collector's tokscale spawns are. Its end is reported as a log.
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        const termination = createSubprocessTermination(child);
        child.on('close', () => {
          termination.confirmClosed();
          options.logger?.(`child ${child.pid} closed`);
        });
        options.logger?.(`child ${child.pid} spawned`);
        return true;
      }
      if (reason === 'preview') options.onPreview?.(summary(), 'progress');
      if (reason === 'busy') {
        // Synchronous post-scan work: this thread handles no message meanwhile.
        const until = Date.now() + 200;
        while (Date.now() < until) { /* spin */ }
      }
      tokens += 10;
      options.logger?.(`tick ${reason}`);
      options.onDiagnosticEvent?.({ subsystem: 'collector', code: 'scripted-tick' });
      await options.onUpdate(summary(), reason);
      return true;
    },
    refreshClient(clientId) {
      if (clientId !== 'codex') throw new TypeError(`Unsupported targeted usage client: ${clientId}`);
      return Promise.resolve(true);
    },
    stop() { stopped = true; },
    whenIdle: () => Promise.resolve(),
    getDiagnostics() {
      const writeEnabled = options.dailyHistoryArchiveWriteEnabled;
      return {
        state: stopped ? 'stopped' : 'idle',
        ticks,
        clients: options.clients,
        archiveWriteEnabled: typeof writeEnabled === 'function' ? writeEnabled() : writeEnabled ?? null
      };
    }
  };
};

require('../../src/shared/usage/usageWorker');
