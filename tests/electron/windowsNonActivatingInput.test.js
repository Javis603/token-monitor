'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { buildWindowsInput, compileWindowsDock } = require('../../scripts/build-windows-dock');
const { createWindowsNonActivatingInput, installWindowsNonActivatingInput, windowsInputLibraryPath } = require('../../src/electron/windowsNonActivatingInput');

function fixture({ installResult = 1, installError = null } = {}) {
  const calls = [];
  const koffi = {
    load(file) {
      assert.equal(file, '/native/WindowInput.dll');
      return {
        func(signature) {
          assert.equal(signature, 'int32_t __stdcall TokenMonitorInstallNonActivatingInput(uintptr_t hwnd)');
          return hwnd => {
            calls.push(hwnd);
            if (installError) throw installError;
            return installResult;
          };
        }
      };
    }
  };
  const win = {
    isDestroyed: () => false,
    getNativeWindowHandle() {
      const handle = Buffer.alloc(8);
      handle.writeBigUInt64LE(0x123456789n);
      return handle;
    }
  };
  return { calls, win, install: createWindowsNonActivatingInput(koffi, '/native/WindowInput.dll') };
}

test('native input installation preserves HWND width without registering JavaScript callbacks', () => {
  const f = fixture();
  assert.equal(f.install(f.win), true);
  assert.deepEqual(f.calls, [0x123456789n]);
  assert.equal(f.install(f.win), true);
  assert.equal(f.calls.length, 1, 'repeat installation does not stack native hooks');
});

test('native Win32 BOOL results use all 32 bits', () => {
  for (const installResult of [0x100, -1]) {
    const f = fixture({ installResult });
    assert.equal(f.install(f.win), true);
  }
});

for (const options of [{ installResult: 0 }, { installError: new Error('native install failed') }]) {
  test(`failed native installation can be retried (${options.installError ? 'throw' : 'FALSE'})`, () => {
    const f = fixture(options);
    assert.throws(() => f.install(f.win), /SetWindowSubclass returned FALSE|native install failed/);
    assert.throws(() => f.install(f.win), /SetWindowSubclass returned FALSE|native install failed/);
    assert.equal(f.calls.length, 2);
  });
}

test('non-Windows platforms and destroyed windows do not install input hooks', () => {
  assert.equal(installWindowsNonActivatingInput(null, { platform: 'darwin' }), false);
  const f = fixture();
  f.win.isDestroyed = () => true;
  assert.equal(f.install(f.win), false);
  assert.equal(f.install(null), false);
  assert.deepEqual(f.calls, []);
});

test('input DLL is loaded from build output in development and resources in packaged apps', () => {
  assert.equal(windowsInputLibraryPath({ isPackaged: false }), path.resolve(__dirname, '../../build/windows-dock/TokenMonitor.WindowInput.dll'));
  assert.equal(windowsInputLibraryPath({ isPackaged: true }, '/resources'), path.join('/resources', 'windows-dock', 'TokenMonitor.WindowInput.dll'));
});

test('native subclass retains activation input and the original window message chain', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-input-checks-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dll = buildWindowsInput({ output: path.join(directory, 'TokenMonitor.WindowInput.dll') });
  const executable = compileWindowsDock({ output: path.join(directory, 'checks.exe'), target: 'exe', sources: [path.resolve(__dirname, '../windows-dock/NativeInputChecks.cs')] });
  const output = execFileSync(executable, [dll], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.match(output, /^10 native windows: activation, chaining, repeated installation and destruction passed/);
});
