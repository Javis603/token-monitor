'use strict';

const { withCursorLifecycle } = require('../../src/shared/cursorLifecycle');

const home = process.argv[2];

withCursorLifecycle(() => new Promise((resolve) => {
  process.stdout.write('locked\n');
  process.stdin.once('data', resolve);
  process.stdin.resume();
}), { home }).then(
  () => process.stdout.write('released\n'),
  (error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
);
