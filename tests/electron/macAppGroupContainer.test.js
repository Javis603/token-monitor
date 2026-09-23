'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMacAppGroupApi,
  resolveMacAppGroupContainerPath
} = require('../../src/electron/macWidget/macAppGroupContainer');

function fakeKoffi({ containerUrl = 31n, containerPath = '/Users/example/Library/Group Containers/group.com.example.tokenmonitor' } = {}) {
  const selectors = new Map([
    ['defaultManager', 11n],
    ['stringWithUTF8String:', 12n],
    ['containerURLForSecurityApplicationGroupIdentifier:', 13n],
    ['fileSystemRepresentation', 14n]
  ]);
  const calls = [];
  return {
    calls,
    load(library) {
      if (library.includes('Foundation.framework')) return { library };
      return {
        func(name, returnType, argumentTypes) {
          if (name === 'objc_getClass') {
            return (className) => className === 'NSFileManager' ? 21n : 22n;
          }
          if (name === 'sel_registerName') return (selector) => selectors.get(selector);
          if (name === 'objc_msgSend' && returnType === 'str') {
            return (receiver, selector) => {
              calls.push({ receiver, selector });
              return containerPath;
            };
          }
          if (name === 'objc_msgSend' && argumentTypes.length === 2) {
            return (receiver, selector) => {
              calls.push({ receiver, selector });
              return 23n;
            };
          }
          if (name === 'objc_msgSend' && argumentTypes[2] === 'str') {
            return (receiver, selector, value) => {
              calls.push({ receiver, selector, value });
              return 24n;
            };
          }
          if (name === 'objc_msgSend' && argumentTypes[2] === 'uintptr_t') {
            return (receiver, selector, value) => {
              calls.push({ receiver, selector, value });
              return containerUrl;
            };
          }
          throw new Error(`Unexpected native function: ${name}`);
        }
      };
    }
  };
}

test('Foundation bridge resolves an App Group through NSFileManager', () => {
  const koffi = fakeKoffi();
  const api = createMacAppGroupApi(koffi);
  assert.equal(
    api.containerPath('group.com.example.tokenmonitor'),
    '/Users/example/Library/Group Containers/group.com.example.tokenmonitor'
  );
  assert.deepEqual(koffi.calls, [
    { receiver: 21n, selector: 11n },
    { receiver: 22n, selector: 12n, value: 'group.com.example.tokenmonitor' },
    { receiver: 23n, selector: 13n, value: 24n },
    { receiver: 31n, selector: 14n }
  ]);
});

test('Foundation bridge returns null when macOS denies the App Group container', () => {
  assert.equal(createMacAppGroupApi(fakeKoffi({ containerUrl: 0n })).containerPath('group.com.example'), null);
});

test('container lookup is macOS-only and fails closed', () => {
  const explodingApi = {
    containerPath() {
      throw new Error('not authorized');
    }
  };
  assert.equal(resolveMacAppGroupContainerPath('group.com.example', {
    platform: 'linux',
    api: explodingApi
  }), null);
  assert.equal(resolveMacAppGroupContainerPath('group.com.example', {
    platform: 'darwin',
    api: explodingApi
  }), null);
});
