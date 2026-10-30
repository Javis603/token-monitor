'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const providerDocsDir = path.join(rootDir, 'docs', 'providers');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

function routingFrontmatter(text, file) {
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  assert.ok(match, `${file}: missing YAML front matter`);

  const lines = match[1].split('\n');
  const summaryLines = lines.filter((line) => /^summary:\s*/.test(line));
  assert.equal(summaryLines.length, 1, `${file}: expected one summary field`);
  assert.match(summaryLines[0], /^summary:\s*(?:"[^"]+"|'[^']+'|\S.*)$/, `${file}: summary must be non-empty`);

  const readWhenIndexes = lines
    .map((line, index) => (/^read_when:\s*$/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(readWhenIndexes.length, 1, `${file}: expected one read_when field`);

  const start = readWhenIndexes[0] + 1;
  const entries = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Za-z0-9_-]+:/.test(line)) break;
    if (/^\s+-\s+\S/.test(line)) entries.push(line);
    else if (line.trim()) assert.fail(`${file}: malformed read_when entry: ${line}`);
  }
  assert.ok(entries.length > 0, `${file}: read_when must contain at least one entry`);
}

test('provider notes expose routing metadata', () => {
  const files = fs.readdirSync(providerDocsDir)
    .filter((name) => name.endsWith('.md'))
    .sort();

  assert.ok(files.length > 0, 'no provider notes found');
  for (const file of files) {
    routingFrontmatter(read(path.join('docs', 'providers', file)), file);
  }
});

test('provider notes route by catalog ids', () => {
  const { CLIENT_IDS } = require('../../src/shared/clientCatalog.js');
  const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers.js');
  const catalogIds = new Set([...CLIENT_IDS, ...LIMIT_PROVIDER_IDS]);
  const owners = new Map();

  const notes = fs.readdirSync(providerDocsDir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort();
  for (const file of notes) {
    const text = read(path.join('docs', 'providers', file));
    const lines = text.match(/^---\n([\s\S]*?)\n---/)[1].split('\n');
    const idLines = lines.filter((line) => /^ids:/.test(line));
    assert.equal(idLines.length, 1, `${file}: expected one ids field`);
    const match = idLines[0].match(/^ids:\s*\[([^\]]*)\]\s*$/);
    assert.ok(match, `${file}: ids must be an inline list such as [droid, factory]`);
    const ids = match[1].split(',').map((id) => id.trim()).filter(Boolean);
    assert.ok(ids.length > 0, `${file}: ids must not be empty`);
    assert.ok(ids.includes(path.basename(file, '.md')), `${file}: filename must be one of its own ids`);

    for (const id of ids) {
      assert.ok(catalogIds.has(id), `${file}: ${id} is in neither CLIENT_CATALOG nor LIMIT_PROVIDER_CATALOG`);
      assert.ok(!owners.has(id), `${id}: claimed by both ${owners.get(id)} and ${file}`);
      owners.set(id, file);
    }
  }
});

test('root guidance links only existing core documents and sections', () => {
  const agents = read('AGENTS.md');
  const links = [...agents.matchAll(/(?:`|\]\()(docs\/[A-Za-z0-9_./-]+\.md(?:#[a-z0-9-]+)?)(?:`|\))/g)]
    .map((match) => match[1]);
  assert.ok(links.length > 0, 'AGENTS.md contains no routed documentation links');

  for (const link of new Set(links)) {
    const [file, anchor] = link.split('#');
    assert.ok(fs.existsSync(path.join(rootDir, file)), `AGENTS.md references missing ${file}`);
    if (!anchor) continue;
    const headings = [...read(file).matchAll(/^#{1,6} (.+)$/gm)]
      .map((match) => match[1].toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s/g, '-'));
    assert.ok(headings.includes(anchor), `AGENTS.md references missing section ${link}`);
  }
});

test('root guidance separates registration routes and links watch contracts', () => {
  const routes = read('AGENTS.md').split('## Where guidance lives\n')[1].split('\n## ')[0]
    .split('\n').filter((line) => line.startsWith('|'));
  const clientChecklist = 'docs/providers/README.md#adding-a-tracked-client';
  const limitsChecklist = 'docs/providers/README.md#adding-a-limits-provider';

  for (const [target, unrelated] of [[clientChecklist, limitsChecklist], [limitsChecklist, clientChecklist]]) {
    const route = routes.find((line) => line.includes(target));
    assert.ok(route, `missing section-level route to ${target}`);
    assert.ok(!route.includes(unrelated), `${target} must not require the other registration checklist`);
  }

  const watchRoute = routes.find((line) => line.includes('docs/architecture.md#watching'));
  assert.ok(watchRoute, 'missing section-level watch route');
  assert.ok(watchRoute.includes('docs/providers/README.md#partition-invariants'),
    'watch changes must also route to partition invariants');
});
