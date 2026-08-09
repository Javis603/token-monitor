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
  const generate = workflow.slice(workflow.indexOf('  generate:'), workflow.indexOf('  validate:'));
  assert.match(generate, /permissions:\s+contents: read/);
  assert.doesNotMatch(generate, /contents: write/);
  assert.match(generate, /artifact-id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
  assert.match(generate, /retention-days: 1/);
  assert.doesNotMatch(workflow, /metadata: read/);
});

test('validation parses artifacts without write permission', () => {
  const validation = workflow.slice(workflow.indexOf('  validate:'), workflow.indexOf('  publish:'));
  assert.match(validation, /permissions:\s+contents: read/);
  assert.doesNotMatch(validation, /contents: write/);
  assert.match(validation, /artifact-ids: \$\{\{ needs\.generate\.outputs\.artifact-id \}\}/);
  assert.match(validation, /merge-multiple: true/);
  assert.match(validation, /digest-mismatch: error/);
  assert.match(validation, /libxml2-utils/);
  assert.match(validation, /validate-star-history-artifact\.js/);
  assert.match(validation, /light-sha256=/);
  assert.match(validation, /dark-sha256=/);
  assert.match(validation, /snapshot-sha256=/);
});

test('only the caller-owned publish job can write without parsing artifacts', () => {
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(publish, /permissions:\s+contents: write/);
  assert.match(publish, /needs: \[generate, validate\]/);
  assert.match(publish, /artifact-ids: \$\{\{ needs\.generate\.outputs\.artifact-id \}\}/);
  assert.match(publish, /merge-multiple: true/);
  assert.match(publish, /digest-mismatch: error/);
  assert.match(publish, /sha256sum --check --strict/);
  assert.doesNotMatch(publish, /validate-star-history-artifact\.js|xmllint|JSON\.parse/);
  assert.doesNotMatch(publish, /actions\/checkout/);
  assert.match(publish, /install -m 0644 .*star-history\.svg/);
  assert.match(publish, /install -m 0644 .*star-history-dark\.svg/);
  assert.match(publish, /install -m 0644 .*stars\.json/);
  assert.doesNotMatch(publish, /x-access-token:\$\{GITHUB_TOKEN\}@/);
});
