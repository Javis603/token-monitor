'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const filename = path.resolve(__dirname, '../../src/agent/agent.js');
const source = fs.readFileSync(filename, 'utf8');
const agentRequire = createRequire(filename);

for (const scenario of [
  { flags: [], env: {}, short: 120000, full: undefined },
  { flags: ['--timeoutMs=5000'], env: {}, short: 5000, full: 5000 },
  { flags: [], env: { TOKEN_MONITOR_TOKSCALE_TIMEOUT_MS: '9000' }, short: 9000, full: 9000 },
  { flags: ['--timeoutMs=5000'], env: { TOKEN_MONITOR_ALL_TIME_TIMEOUT_MS: '' }, short: 5000, full: 5000 },
  { flags: ['--timeoutMs=5000'], env: { TOKEN_MONITOR_ALL_TIME_TIMEOUT_MS: '7200000' }, short: 5000, full: '7200000' },
  { flags: ['--allTimeTimeoutMs=3600000'], env: { TOKEN_MONITOR_ALL_TIME_TIMEOUT_MS: '7200000' }, short: 120000, full: '3600000' }
]) {
  test(`agent timeout precedence: ${JSON.stringify(scenario.flags)} ${JSON.stringify(scenario.env)}`, () => {
    let usageOptions;
    vm.runInNewContext(source, {
      require(id) {
        if (id === '../shared/config') return { ...agentRequire(id), loadDotEnv() {} };
        if (id === './seedClients') return { seedAgentClients: clients => clients };
        if (id === './runtime') return { runAgentOnce(options) { usageOptions = options.usageOptions; } };
        return agentRequire(id);
      },
      fetch() { throw new Error('configuration test must not make requests'); },
      process: { argv: ['node', filename, '--once', '--dry-run', ...scenario.flags], env: scenario.env },
      console: { log() {}, warn() {}, error() {} }
    }, { filename });
    assert.equal(usageOptions.commandTimeoutMs, scenario.short);
    assert.equal(usageOptions.allTimeTimeoutMs, scenario.full);
  });
}
