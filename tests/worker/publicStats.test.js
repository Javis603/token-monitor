'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('public stats periods strip every project identity field', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const periods = worker.publicPeriods({ today: {
    projects: {
      'private-client': { label: 'Private-Client', tokens: 1, clients: { codex: 1 } }
    },
    sessions: { 'codex:s1': {
      client: 'codex', sessionId: 's1', totalTokens: 1,
      projectId: 'sha256:secret', projectLabel: 'Private-Client', projectPath: '/Users/alice/Private-Client'
    } }
  } });
  assert.deepEqual(periods.today.sessions['codex:s1'], { client: 'codex', sessionId: 's1', totalTokens: 1 });
  assert.equal(Object.hasOwn(periods.today, 'projects'), false);
  const json = JSON.stringify(periods);
  assert.doesNotMatch(json, /Private-Client/);
  assert.doesNotMatch(json, /private-client/);
});
