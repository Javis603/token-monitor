'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { normalizeCustomScanPaths } = require('../../src/shared/customScanPaths');

test('Session Detail IPC supplies trusted normalized Senpi settings to the worker', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('session:getDetail',");
  const end = main.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start >= 0 && end > start);
  const custom = path.join(path.resolve('fixture'), 'custom-senpi');
  let handler;
  let received;
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    settings: { customScanPaths: { senpi: [custom, custom, 'relative/invalid'] } },
    normalizeCustomScanPaths,
    readSessionDetailForPlatform: args => { received = args; return { found: false }; },
    lookupModelPricing: () => {}
  });
  handler({}, { client: 'senpi', sessionId: 's1', customScanPaths: { senpi: ['/renderer/injected'] } });
  assert.deepEqual(received.customScanPaths.senpi, [custom]);
  assert.equal(received.sessionId, 's1');
  handler({}, { client: 'claude', sessionId: 's1' });
  assert.equal(Object.hasOwn(received, 'customScanPaths'), false);
});
