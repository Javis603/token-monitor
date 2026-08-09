'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'star-history.yml'),
  'utf8',
);

test('Star History runs daily and manually without per-star automation', () => {
  assert.match(workflow, /cron: '17 19 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bwatch:/);
  assert.doesNotMatch(workflow, /\*\/6/);
});

test('external generation is SHA-pinned and read-only', () => {
  assert.match(
    workflow,
    /uses: Javis603\/star-history-action@[0-9a-f]{40}/,
  );
  const generate = workflow.slice(workflow.indexOf('  generate:'), workflow.indexOf('  publish:'));
  assert.match(generate, /permissions:\s+contents: read/);
  assert.doesNotMatch(generate, /contents: write/);
  assert.match(generate, /retention-days: 1/);
  assert.doesNotMatch(workflow, /metadata: read/);
});

test('only the caller-owned publish job can write after validation', () => {
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(publish, /permissions:\s+contents: write/);
  assert.ok(
    publish.indexOf('validate-star-history-artifact.js') < publish.indexOf('push origin HEAD:star-history'),
    'artifact validation must precede the push',
  );
  assert.match(publish, /install -m 0644 .*star-history\.svg/);
  assert.match(publish, /install -m 0644 .*star-history-dark\.svg/);
  assert.match(publish, /install -m 0644 .*stars\.json/);
  assert.doesNotMatch(publish, /x-access-token:\$\{GITHUB_TOKEN\}@/);
});
