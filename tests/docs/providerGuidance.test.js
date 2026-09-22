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

test('provider aliases resolve without shadowing direct notes', () => {
  const index = read('docs/providers/README.md');
  const aliases = [...index.matchAll(/^\| `([^`]+)` \| `([^`]+\.md)` \|$/gm)];
  assert.ok(aliases.length > 0, 'provider alias table is empty or malformed');

  for (const [, id, target] of aliases) {
    assert.ok(fs.existsSync(path.join(providerDocsDir, target)), `${id}: alias target ${target} does not exist`);
    assert.ok(!fs.existsSync(path.join(providerDocsDir, `${id}.md`)), `${id}: direct note conflicts with alias target ${target}`);
  }
});

test('root guidance links only existing core documents', () => {
  const agents = read('AGENTS.md');
  const links = [...agents.matchAll(/`(docs\/[A-Za-z0-9_./-]+\.md)`/g)].map((match) => match[1]);
  assert.ok(links.length > 0, 'AGENTS.md contains no routed documentation links');

  for (const file of new Set(links)) {
    assert.ok(fs.existsSync(path.join(rootDir, file)), `AGENTS.md references missing ${file}`);
  }
});
