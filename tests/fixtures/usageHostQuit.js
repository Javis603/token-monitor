'use strict';

// The quit path in its own process: a worker with a running subprocess is
// stopped, and the process exits at once, as performQuit() does. Prints the
// subprocess PID so the test can check it did not outlive this process.

const path = require('node:path');

const { createUsageHostCoordinator } = require('../../src/shared/usage/usageHost');

const coordinator = createUsageHostCoordinator({
  workerPath: path.join(__dirname, 'usageWorkerScriptedCollector.js')
});
let pid = null;
const runtime = coordinator.create({
  clients: 'codex',
  onUpdate() {},
  logger(message) {
    const spawned = /^child (\d+) spawned$/.exec(message);
    if (spawned) pid = Number(spawned[1]);
  }
}, { agentPidPath: path.join(process.env.TOKEN_MONITOR_SHARED_DIR, 'no-agent.pid') });

// The worker is unref'd, so something has to hold this process open until then.
const keepAlive = setInterval(() => {}, 1000);
runtime.tick('spawn').then(() => {
  clearInterval(keepAlive);
  process.stdout.write(`${pid}\n`);
  // Keeps the worker's thread busy past the exit, so the stop that follows is
  // certainly not handled in time.
  void runtime.tick('busy');
  runtime.stop({ skipCloseWatchers: true });
  if (process.argv[2] !== 'without-terminate') coordinator.terminateSubprocesses();
  process.exit(0);
});
