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
