'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('public stats periods strip every project identity field', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const periods = worker.publicPeriods({ today: { sessions: { 'codex:s1': {
    client: 'codex', sessionId: 's1', totalTokens: 1,
    projectId: 'sha256:secret', projectLabel: 'private-client', projectPath: '/Users/alice/private-client'
  } } } });
  assert.deepEqual(periods.today.sessions['codex:s1'], { client: 'codex', sessionId: 's1', totalTokens: 1 });
});
