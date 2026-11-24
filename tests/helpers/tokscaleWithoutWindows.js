'use strict';

const { EventEmitter } = require('node:events');

// Spawn fakes that model the pinned fork binary, which predates the windowed
// full-tick scan: it rejects `--window` the way clap does, so the collector
// falls back to the serial scans those tests describe. The rejection never
// reaches the wrapped fake, so its recorded calls are unchanged.
function withoutWindowedScan(spawn) {
  return (bin, args, ...rest) => {
    if (!Array.isArray(args) || !args.includes('--window')) return spawn(bin, args, ...rest);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => true;
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from("error: unexpected argument '--window' found\n"));
      child.emit('close', 2);
    });
    return child;
  };
}

module.exports = { withoutWindowedScan };
