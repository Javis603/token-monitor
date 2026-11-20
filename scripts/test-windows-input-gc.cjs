'use strict';

// Manual Electron regression: build with npm run build:windows-dock, then run
// node_modules/.bin/electron scripts/test-windows-input-gc.cjs on Windows.
// The old JavaScript subclass aborts on the first move when its listener GCs.
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const vm = require('node:vm');
const { app, BrowserWindow } = require('electron');
const { installWindowsNonActivatingInput } = require('../src/electron/windowsNonActivatingInput');

v8.setFlagsFromString('--expose_gc');
const collectGarbage = vm.runInNewContext('gc');
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  assert.equal(process.platform, 'win32', 'This regression requires Windows');
  let totalMoves = 0;
  for (let generation = 0; generation < 3; generation++) {
    const win = new BrowserWindow({ width: 100, height: 100, frame: false, focusable: false, show: false });
    assert.equal(installWindowsNonActivatingInput(win), true, 'native DLL must be available');
    win.on('move', () => { totalMoves++; collectGarbage(); });
    for (let i = 0; i < 12; i++) win.setBounds({ x: 400 + i, y: 300 + i, width: 100, height: 100 });
    win.destroy();
    collectGarbage();
  }
  assert.ok(totalMoves >= 36, `expected all move events, got ${totalMoves}`);
  console.log(`PASS: ${totalMoves} native move events with forced GC across three window lifetimes`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
