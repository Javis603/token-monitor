'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createWorkbuddyCredentialDecoder,
  isEncryptedAccessToken,
  resolveWorkbuddyExecutable
} = require('../../src/electron/providers/workbuddy/credentialDecoder');

test('WorkBuddy decoder accepts only the exact encrypted wrapper shape', () => {
  assert.equal(isEncryptedAccessToken({ $wbEncrypted: 1, envelope: 'fixture' }), true);
  assert.equal(isEncryptedAccessToken({ $wbEncrypted: 1, envelope: 'fixture', extra: true }), false);
  assert.equal(isEncryptedAccessToken({ $wbEncrypted: 2, envelope: 'fixture' }), false);
  assert.equal(isEncryptedAccessToken({ $wbEncrypted: 1, envelope: 7 }), false);
  assert.equal(isEncryptedAccessToken('fixture'), false);
});

test('WorkBuddy decoder uses an injected executable and anonymous stdin/stdout pipe', () => {
  const calls = [];
  const decode = createWorkbuddyCredentialDecoder({
    platform: 'win32',
    resolveExecutable: () => ({ exe: 'C:/WorkBuddy/WorkBuddy.exe', asar: 'C:/WorkBuddy/resources/app.asar' }),
    execFileSync: (exe, args, options) => {
      calls.push({ exe, args, options });
      return 'fixture-decrypted-token';
    }
  });
  assert.equal(decode({ $wbEncrypted: 1, envelope: 'fixture-envelope' }), 'fixture-decrypted-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'C:/WorkBuddy/WorkBuddy.exe');
  assert.equal(calls[0].args[0], '-e');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.input, JSON.stringify({ $wbEncrypted: 1, envelope: 'fixture-envelope' }));
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(calls[0].options.env.WORKBUDDY_APP_ASAR, 'C:/WorkBuddy/resources/app.asar');
});

test('WorkBuddy decoder fails closed on codec errors or unsafe output', () => {
  const base = {
    platform: 'win32',
    resolveExecutable: () => ({ exe: 'C:/WorkBuddy/WorkBuddy.exe', asar: 'C:/WorkBuddy/resources/app.asar' })
  };
  assert.equal(createWorkbuddyCredentialDecoder({ ...base, execFileSync: () => { throw new Error('codec failure'); } })({ $wbEncrypted: 1, envelope: 'x' }), null);
  assert.equal(createWorkbuddyCredentialDecoder({ ...base, execFileSync: () => 'token\nlog' })({ $wbEncrypted: 1, envelope: 'x' }), null);
  assert.equal(createWorkbuddyCredentialDecoder({ ...base, execFileSync: () => 'token\u0000log' })({ $wbEncrypted: 1, envelope: 'x' }), null);
});

test('WorkBuddy decoder rejects oversized input and encrypted auth on macOS', () => {
  let calls = 0;
  const wrapper = { $wbEncrypted: 1, envelope: 'x'.repeat(64) };
  const decode = createWorkbuddyCredentialDecoder({
    platform: 'win32', maxInputBytes: 16,
    resolveExecutable: () => ({ exe: 'C:/WorkBuddy/WorkBuddy.exe', asar: 'C:/WorkBuddy/resources/app.asar' }),
    execFileSync: () => { calls += 1; return 'token'; }
  });
  assert.equal(decode(wrapper), null);
  assert.equal(calls, 0);
  assert.equal(createWorkbuddyCredentialDecoder({ platform: 'darwin', execFileSync: () => { calls += 1; return 'token'; } })(wrapper), null);
  assert.equal(calls, 0);
});

test('WorkBuddy registry discovery continues when an earlier uninstall root fails', () => {
  for (const displayIcon of [
    'C:\\WorkBuddy\\WorkBuddy.exe,0',
    '"C:\\WorkBuddy\\WorkBuddy.exe",0',
    '"C:\\WorkBuddy\\WorkBuddy.exe,0"'
  ]) {
    let queries = 0;
    const fakeFs = { lstatSync: (file) => {
      if (file !== 'C:\\WorkBuddy\\WorkBuddy.exe' && file !== 'C:\\WorkBuddy\\resources\\app.asar') throw new Error('missing');
      return { isFile: () => true, isSymbolicLink: () => false };
    } };
    const result = resolveWorkbuddyExecutable({
      platform: 'win32', fs: fakeFs,
      regExecFileSync: () => {
        queries += 1;
        if (queries === 1) throw new Error('root unavailable');
        return `HKEY_LOCAL_MACHINE\\Software\\WorkBuddy\n    DisplayName    REG_SZ    WorkBuddy 5.6.2\n    DisplayIcon    REG_SZ    ${displayIcon}\n`;
      }
    });
    assert.equal(queries, 2);
    assert.deepEqual(result, { exe: 'C:\\WorkBuddy\\WorkBuddy.exe', asar: 'C:\\WorkBuddy\\resources\\app.asar' });
  }
});
