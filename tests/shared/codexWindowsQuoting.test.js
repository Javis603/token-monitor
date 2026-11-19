'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { quoteWindowsCmdArg } = require('../../src/shared/providers/codex/limits');

// Windows CRT rule: a run of backslashes is literal unless it precedes a quote,
// where the run is doubled and the quote escaped. `cmd.exe /c` receives one
// joined string, so an argument that closes its own quote early would be read
// as several arguments.

test('a path made only of safe characters is passed through unquoted', () => {
  assert.equal(
    quoteWindowsCmdArg('C:\\Users\\me\\AppData\\npm\\codex.cmd'),
    'C:\\Users\\me\\AppData\\npm\\codex.cmd'
  );
});

test('a path with a space is quoted, and its inner backslashes stay literal', () => {
  assert.equal(
    quoteWindowsCmdArg('C:\\Program Files\\Codex\\resources\\codex.cmd'),
    '"C:\\Program Files\\Codex\\resources\\codex.cmd"'
  );
});

test('a trailing backslash is doubled so it cannot escape the closing quote', () => {
  assert.equal(quoteWindowsCmdArg('C:\\Program Files\\Codex\\'), '"C:\\Program Files\\Codex\\\\"');
});

test('a backslash run before a quote is doubled and the quote escaped', () => {
  assert.equal(quoteWindowsCmdArg('a\\"b c'), '"a\\\\\\"b c"');
});

test('a bare quote is escaped without gaining a backslash run', () => {
  assert.equal(quoteWindowsCmdArg('a"b c'), '"a\\"b c"');
});
