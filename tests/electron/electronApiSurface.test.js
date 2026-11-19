'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const electronDir = path.join(repoRoot, 'src', 'electron');
const typingsPath = path.join(repoRoot, 'node_modules', 'electron', 'electron.d.ts');

// BrowserWindow inherits these; electron.d.ts declares them on the base class.
const INHERITED_METHODS = new Set([
  'addListener', 'emit', 'eventNames', 'getMaxListeners', 'listenerCount', 'listeners',
  'off', 'on', 'once', 'prependListener', 'prependOnceListener', 'rawListeners',
  'removeAllListeners', 'removeListener', 'setMaxListeners'
]);

// Locals that hold a BrowserWindow. A `foo.webContents.send()` chain does not match,
// because `webContents` is not followed by a call.
const WINDOW_CALL = /\b(?:mainWindow|dashboardWindow|win|target)\.([a-zA-Z][A-Za-z0-9]*)\s*\??\.?\(/g;

function browserWindowMethods() {
  const typings = fs.readFileSync(typingsPath, 'utf8');
  const body = typings.match(/\n {2}class BrowserWindow extends .*?\{\n([\s\S]*?)\n {2}\}\n/);
  assert.ok(body, 'could not locate the BrowserWindow class in electron.d.ts');
  const declared = body[1].matchAll(/^ {4}([a-zA-Z][A-Za-z0-9]*)\s*\(/gm);
  const methods = new Set([...declared].map((match) => match[1]));
  assert.ok(methods.has('setVibrancy'), 'BrowserWindow method extraction produced nothing usable');
  return new Set([...methods, ...INHERITED_METHODS]);
}

// `win.setVisualEffectState?.('active')` read as if it managed the material's active
// state. The method has never existed on BrowserWindow, and the optional call swallowed
// that without a crash, a warning or a lint error, so only the constructor option was
// ever doing the work — deleting it greyed the glass out on every unfocused window, and
// the unit test passed anyway because its fake window supplied the missing method.
test('every BrowserWindow method the window lifecycle calls exists in Electron', () => {
  const known = browserWindowMethods();
  const offenders = [];
  let scanned = 0;

  for (const entry of fs.readdirSync(electronDir).filter((name) => name.endsWith('.js')).sort()) {
    const lines = fs.readFileSync(path.join(electronDir, entry), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const [, method] of line.matchAll(WINDOW_CALL)) {
        scanned += 1;
        if (!known.has(method)) offenders.push(`${entry}:${index + 1} calls win.${method}()`);
      }
    });
  }

  assert.ok(scanned > 20, `expected to scan real BrowserWindow calls, saw ${scanned}`);
  assert.deepEqual(offenders, [], `not a BrowserWindow method:\n  ${offenders.join('\n  ')}`);
});
