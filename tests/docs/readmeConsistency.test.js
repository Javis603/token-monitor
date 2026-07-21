'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

test('localized README env summaries stay aligned', () => {
  const files = ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md'];
  const envKeys = (file) => {
    const block = read(file).match(/```env\n([\s\S]*?)```/)?.[1] || '';
    return [...block.matchAll(/^(TOKEN_MONITOR_[A-Z0-9_]+)=/gm)].map((match) => match[1]);
  };
  const expected = envKeys(files[0]);

  for (const file of files.slice(1)) assert.deepEqual(envKeys(file), expected, file);
});

test('localized README WSL claims disclose the SQLite agent boundary', () => {
  const files = ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md'];

  for (const file of files) {
    const line = read(file).split('\n').find((value) => value.includes('**WSL')) || '';
    assert.match(line, /SQLite/, file);
    assert.match(line, /docs\/wsl-sqlite-setup(?:\.zh-CN)?\.md/, file);
  }
});

test('WSL SQLite guides keep English and Chinese entry points connected', () => {
  assert.match(read('docs/wsl-sqlite-setup.md'), /\[简体中文\]\(wsl-sqlite-setup\.zh-CN\.md\)/);
  assert.match(read('docs/wsl-sqlite-setup.zh-CN.md'), /\[English\]\(wsl-sqlite-setup\.md\)/);
});

test('WSL SQLite guides state and verify the Node.js prerequisite', () => {
  for (const file of ['docs/wsl-sqlite-setup.md', 'docs/wsl-sqlite-setup.zh-CN.md']) {
    const guide = read(file);
    assert.match(guide, /Node\.js 22\.13\.0/, file);
    assert.match(guide, /node --version\nnpm --version\n/, file);
  }
});

test('legacy Hermes guide keeps published links working', () => {
  assert.match(read('docs/hermes-wsl-setup.md'), /\(wsl-sqlite-setup\.zh-CN\.md\)/);
});
