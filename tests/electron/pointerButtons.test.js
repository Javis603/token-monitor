'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWindowsReader } = require('../../src/electron/edgeDock/pointerButtons');

function windowsReaderFixture({ swapped, downKey }) {
  const calls = [];
  const koffi = {
    load: () => ({
      func(signature) {
        if (signature.includes('GetSystemMetrics')) {
          return (index) => {
            calls.push(['metric', index]);
            return swapped ? 1 : 0;
          };
        }
        if (signature.includes('GetAsyncKeyState')) {
          return (key) => {
            calls.push(['key', key]);
            return key === downKey ? 0x8000 : 0;
          };
        }
        throw new Error(`Unexpected signature: ${signature}`);
      }
    })
  };
  return { calls, read: createWindowsReader(koffi) };
}

test('Windows primary-button polling follows the live swapped-button preference', () => {
  const ordinary = windowsReaderFixture({ swapped: false, downKey: 0x01 });
  assert.equal(ordinary.read(), true);
  assert.deepEqual(ordinary.calls, [['metric', 23], ['key', 0x01]]);

  const swapped = windowsReaderFixture({ swapped: true, downKey: 0x02 });
  assert.equal(swapped.read(), true);
  assert.deepEqual(swapped.calls, [['metric', 23], ['key', 0x02]]);
});
