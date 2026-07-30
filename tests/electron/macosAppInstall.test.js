'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  offerMacAppInstall,
  replaceExistingApp,
  shouldOfferMacAppInstall
} = require('../../src/electron/macosAppInstall');

function testApp({ packaged = true, inApplications = false, move = () => true } = {}) {
  return {
    isPackaged: packaged,
    isInApplicationsFolder: () => inApplications,
    moveToApplicationsFolder: move
  };
}

function testDialog({ response = 0 } = {}) {
  return {
    showMessageBox: async () => ({ response }),
    showMessageBoxSync: () => response
  };
}

test('shouldOfferMacAppInstall only targets packaged apps outside Applications on macOS', () => {
  assert.equal(shouldOfferMacAppInstall({ app: testApp(), platform: 'darwin' }), true);
  assert.equal(shouldOfferMacAppInstall({ app: testApp({ inApplications: true }), platform: 'darwin' }), false);
  assert.equal(shouldOfferMacAppInstall({ app: testApp({ packaged: false }), platform: 'darwin' }), false);
  assert.equal(shouldOfferMacAppInstall({ app: testApp(), platform: 'win32' }), false);
});

test('offerMacAppInstall moves the app only after confirmation', async () => {
  let moveOptions;
  const moved = await offerMacAppInstall({
    app: testApp({ move: (options) => { moveOptions = options; return true; } }),
    dialog: testDialog(),
    appName: 'Token Monitor',
    platform: 'darwin'
  });

  assert.equal(moved, true);
  assert.equal(typeof moveOptions.conflictHandler, 'function');
});

test('offerMacAppInstall leaves the app in place when the user declines', async () => {
  let moveCalls = 0;
  const moved = await offerMacAppInstall({
    app: testApp({ move: () => { moveCalls += 1; return true; } }),
    dialog: testDialog({ response: 1 }),
    appName: 'Token Monitor',
    platform: 'darwin'
  });

  assert.equal(moved, false);
  assert.equal(moveCalls, 0);
});

test('replaceExistingApp only allows replacing a closed installed app after confirmation', () => {
  assert.equal(replaceExistingApp(testDialog({ response: 0 }), 'Token Monitor', 'exists'), true);
  assert.equal(replaceExistingApp(testDialog({ response: 1 }), 'Token Monitor', 'exists'), false);
  assert.equal(replaceExistingApp(testDialog({ response: 0 }), 'Token Monitor', 'existsAndRunning'), false);
});

test('offerMacAppInstall reports a move error and continues running', async () => {
  const messages = [];
  const dialog = {
    showMessageBox: async (options) => {
      messages.push(options);
      return { response: 0 };
    },
    showMessageBoxSync: () => 1
  };
  const moved = await offerMacAppInstall({
    app: testApp({ move: () => { throw new Error('copy failed'); } }),
    dialog,
    appName: 'Token Monitor',
    platform: 'darwin'
  });

  assert.equal(moved, false);
  assert.equal(messages.length, 2);
  assert.match(messages[1].message, /Could not move/);
  assert.equal(messages[1].detail, 'copy failed');
});
