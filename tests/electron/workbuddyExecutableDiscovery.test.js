'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWorkbuddyCredentialDecoder, resolveWorkbuddyExecutable } = require('../../src/electron/providers/workbuddy/credentialDecoder');

const exe = 'C:\\Custom\\WorkBuddy.exe';
const asar = 'C:\\Custom\\resources\\app.asar';
const wrapper = { $wbEncrypted: 1, envelope: 'synthetic-wrapper' };
const record = `HKEY_LOCAL_MACHINE\\Software\\WorkBuddy\n    DisplayName    REG_SZ    WorkBuddy 5.7.6\n    InstallLocation    REG_SZ    C:\\Custom\n`;

function filesystem(files = new Set([exe, asar]), symlinks = new Set()) {
  return { lstatSync(file) {
    if (!files.has(file)) throw new Error('missing');
    return { isFile: () => true, isSymbolicLink: () => symlinks.has(file) };
  } };
}

test('Custom install discovery tolerates uninstall output larger than the old 128 KiB buffer', () => {
  const output = `HKEY_LOCAL_MACHINE\\Software\\Other\n    DisplayName    REG_SZ    Other\n${' '.repeat(256 * 1024)}\n${record}`;
  const result = resolveWorkbuddyExecutable({ platform: 'win32', fs: filesystem(),
    regExecFileSync(_command, args, options) {
      assert.deepEqual(args.slice(-1), ['/s']);
      assert.equal(options.timeout, 1500);
      assert.ok(options.maxBuffer >= Buffer.byteLength(output));
      assert.ok(options.maxBuffer <= 4 * 1024 * 1024);
      return output;
    } });
  assert.deepEqual(result, { exe, asar });
});

test('Discovery rejects executable and ASAR symlinks and incomplete installs', () => {
  for (const fs of [filesystem(new Set([exe])), filesystem(new Set([asar])),
    filesystem(undefined, new Set([exe])), filesystem(undefined, new Set([asar]))]) {
    assert.equal(resolveWorkbuddyExecutable({ platform: 'win32', fs, regExecFileSync: () => record }), null);
  }
});

test('Registry discovery parses a quoted uninstaller when no icon or install location exists', () => {
  const output = 'HKEY_LOCAL_MACHINE\\Software\\WorkBuddy\n    DisplayName    REG_SZ    WorkBuddy\n    UninstallString    REG_SZ    "C:\\Custom\\Uninstall WorkBuddy.exe" /S\n';
  assert.deepEqual(resolveWorkbuddyExecutable({ platform: 'win32', fs: filesystem(), regExecFileSync: () => output }), { exe, asar });
});

test('Successful installation discovery is cached while each billing call decodes anew', () => {
  let queries = 0, decodes = 0, at = 1000;
  const decode = createWorkbuddyCredentialDecoder({ platform: 'win32', fs: filesystem(), now: () => at,
    regExecFileSync: () => { queries += 1; return record; },
    execFileSync: () => `synthetic-token-${++decodes}` });
  assert.equal(decode(wrapper), 'synthetic-token-1');
  assert.equal(decode(wrapper), 'synthetic-token-2');
  assert.equal(queries, 1);
  at += 60000;
  assert.equal(decode(wrapper), 'synthetic-token-3');
  assert.equal(queries, 2);
});

test('A cached missing installation avoids repeated registry timeouts and retries after short TTL', () => {
  let queries = 0, at = 1000, installed = false;
  const files = new Set();
  const decode = createWorkbuddyCredentialDecoder({ platform: 'win32', fs: filesystem(files), now: () => at,
    regExecFileSync: () => { queries += 1; if (!installed) throw new Error('ETIMEDOUT'); return record; },
    execFileSync: () => 'synthetic-token' });
  assert.equal(decode(wrapper), null);
  assert.equal(queries, 3);
  installed = true; files.add(exe); files.add(asar);
  at += 29999;
  assert.equal(decode(wrapper), null);
  assert.equal(queries, 3);
  at += 1;
  assert.equal(decode(wrapper), 'synthetic-token');
  assert.equal(queries, 4);
});

test('Removed or unsafe cached installation is rediscovered before another decoder spawn', () => {
  for (const removed of [exe, asar]) {
    const files = new Set([exe, asar]);
    let queries = 0, decodes = 0;
    const decode = createWorkbuddyCredentialDecoder({ platform: 'win32', fs: filesystem(files),
      regExecFileSync: () => { queries += 1; return record; },
      execFileSync: () => { decodes += 1; return 'synthetic-token'; } });
    assert.equal(decode(wrapper), 'synthetic-token');
    files.delete(removed);
    assert.equal(decode(wrapper), null);
    assert.equal(queries, 4);
    assert.equal(decodes, 1);
  }
  const symlinks = new Set();
  let decodes = 0;
  const decode = createWorkbuddyCredentialDecoder({ platform: 'win32', fs: filesystem(undefined, symlinks),
    regExecFileSync: () => record, execFileSync: () => { decodes += 1; return 'synthetic-token'; } });
  assert.equal(decode(wrapper), 'synthetic-token');
  symlinks.add(exe);
  assert.equal(decode(wrapper), null);
  assert.equal(decodes, 1);
});
