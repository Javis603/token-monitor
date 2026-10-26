'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
exports.activate = async context => {
  let timer;
  let counter = 0;
  return {
    async call(method, value) {
      if (method === 'echo') return { value, pid: process.pid };
      if (method === 'file') {
        const file = path.join(context.dataDirectory, 'fixture.txt');
        await fs.writeFile(file, value);
        return fs.readFile(file, 'utf8');
      }
      if (method === 'fetch') return (await fetch(value)).text();
      if (method === 'host') return context.host.call('fixture', value);
      if (method === 'start') { timer ??= setInterval(() => context.publish(++counter), 50); return process.pid; }
      if (method === 'fail') throw new Error('Intentional fixture failure');
      throw new Error('Unknown fixture method');
    },
    dispose() { clearInterval(timer); }
  };
};
