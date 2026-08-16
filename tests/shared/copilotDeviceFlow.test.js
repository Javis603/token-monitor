'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  requestDeviceCode,
  pollForAccessToken,
  runCopilotDeviceFlowLogin,
  copilotLoginErrorMessage,
  isAllowedVerificationUrl
} = require('../../src/shared/copilotDeviceFlow');

test('isAllowedVerificationUrl accepts GitHub device-flow URLs only', () => {
  assert.equal(isAllowedVerificationUrl('https://github.com/login/device?user_code=ABCD-1234'), true);
  assert.equal(isAllowedVerificationUrl('https://github.com/login/oauth/authorize'), true);
  assert.equal(isAllowedVerificationUrl('https://evil.example/login/device'), false);
  assert.equal(isAllowedVerificationUrl('http://github.com/login/device'), false);
});

test('isAllowedVerificationUrl accepts enterprise hosts including explicit ports', () => {
  const host = 'ghe.example.com:8443';
  assert.equal(
    isAllowedVerificationUrl(`https://${host}/login/device?user_code=ABCD-1234`, host),
    true
  );
  assert.equal(
    isAllowedVerificationUrl('https://ghe.example.com/login/device', 'ghe.example.com'),
    true
  );
  assert.equal(
    isAllowedVerificationUrl('https://ghe.example.com/login/device', 'github.com'),
    false
  );
});

test('requestDeviceCode posts the VS Code client id and read:user scope', async () => {
  let capturedUrl = '';
  let capturedBody = '';
  const device = await requestDeviceCode('', {
    fetch: async (url, init) => {
      capturedUrl = url;
      capturedBody = init.body;
      return {
        ok: true,
        json: async () => ({
          device_code: 'device-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
          expires_in: 900,
          interval: 5
        })
      };
    }
  });

  assert.equal(capturedUrl, 'https://github.com/login/device/code');
  assert.match(capturedBody, /client_id=Iv1\.b507a08c87ecfe98/);
  assert.match(capturedBody, /scope=read%3Auser/);
  assert.equal(device.userCode, 'ABCD-1234');
  assert.equal(device.verificationUrl, 'https://github.com/login/device?user_code=ABCD-1234');
});

test('pollForAccessToken waits through authorization_pending then returns the token', async () => {
  let calls = 0;
  const token = await pollForAccessToken({
    deviceCode: 'device-1',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    verificationUriComplete: '',
    verificationUrl: 'https://github.com/login/device',
    expiresIn: 60,
    interval: 0
  }, '', {
    now: () => Date.parse('2026-06-25T00:00:00.000Z'),
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return { json: async () => ({ error: 'authorization_pending' }) };
      }
      return { json: async () => ({ access_token: 'gho_test_token' }) };
    }
  });

  assert.equal(token, 'gho_test_token');
  assert.equal(calls, 2);
});

test('requestDeviceCode reports internal request timeout separately from user cancellation', async () => {
  await assert.rejects(
    () => requestDeviceCode('', {
      fetchTimeoutMs: 1,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    }),
    (error) => error?.status === 'timedOut'
  );
});

test('requestDeviceCode still reports external abort as cancellation', async () => {
  const controller = new AbortController();
  await assert.rejects(
    () => requestDeviceCode('', {
      signal: controller.signal,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
        setTimeout(() => controller.abort(), 0);
      })
    }),
    (error) => error?.status === 'cancelled'
  );
});

test('pollForAccessToken reports internal request timeout separately from cancellation', async () => {
  await assert.rejects(
    () => pollForAccessToken({
      deviceCode: 'device-1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: '',
      verificationUrl: 'https://github.com/login/device',
      expiresIn: 60,
      interval: 0
    }, '', {
      fetchTimeoutMs: 1,
      now: () => Date.parse('2026-06-25T00:00:00.000Z'),
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    }),
    (error) => error?.status === 'timedOut'
  );
});

test('runCopilotDeviceFlowLogin opens the browser and reports status phases', async () => {
  const statuses = [];
  const opened = [];
  const copied = [];
  let pollCalls = 0;

  const result = await runCopilotDeviceFlowLogin({
    onStatus: (status) => statuses.push(status)
  }, {
    fetch: async (url) => {
      if (String(url).endsWith('/login/device/code')) {
        return {
          ok: true,
          json: async () => ({
            device_code: 'device-1',
            user_code: 'WXYZ-5678',
            verification_uri: 'https://github.com/login/device',
            verification_uri_complete: 'https://github.com/login/device?user_code=WXYZ-5678',
            expires_in: 60,
            interval: 0
          })
        };
      }
      pollCalls += 1;
      return {
        ok: true,
        json: async () => (pollCalls === 1
          ? { error: 'authorization_pending' }
          : { access_token: 'gho_signed_in' })
      };
    },
    openExternal: async (url) => { opened.push(url); },
    copyToClipboard: async (text) => { copied.push(text); }
  });

  assert.deepEqual(result, { ok: true, accessToken: 'gho_signed_in' });
  assert.deepEqual(statuses.map((entry) => entry.phase), ['requesting', 'authorize', 'polling', 'success']);
  assert.equal(statuses[1].userCode, 'WXYZ-5678');
  assert.equal(statuses[1].copiedToClipboard, true);
  assert.deepEqual(copied, ['WXYZ-5678']);
  assert.equal(opened[0], 'https://github.com/login/device?user_code=WXYZ-5678');
});

test('runCopilotDeviceFlowLogin rejects unexpected verification URLs', async () => {
  const opened = [];
  await assert.rejects(
    () => runCopilotDeviceFlowLogin({}, {
      fetch: async (url) => {
        if (String(url).endsWith('/login/device/code')) {
          return {
            ok: true,
            json: async () => ({
              device_code: 'device-1',
              user_code: 'ABCD-1234',
              verification_uri: 'https://evil.example/login/device',
              verification_uri_complete: 'https://evil.example/login/device?user_code=ABCD-1234',
              expires_in: 60,
              interval: 0
            })
          };
        }
        throw new Error(`unexpected fetch url: ${url}`);
      },
      openExternal: async (url) => { opened.push(url); }
    }),
    /unexpected verification URL/i
  );
  assert.deepEqual(opened, []);
});

test('copilotLoginErrorMessage maps common device-flow failures', () => {
  assert.match(copilotLoginErrorMessage({ status: 'timedOut' }), /timed out/i);
  assert.match(copilotLoginErrorMessage({ status: 'denied' }), /denied/i);
  assert.match(copilotLoginErrorMessage({ status: 'cancelled' }), /cancelled/i);
});

test('main process external URL allowlist delegates enterprise device-flow to shared guard', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  assert.match(main, /if \(isAllowedVerificationUrl\(value, enterpriseHost\)\) return true;/);
});

test('main process Copilot sign-in owns controller cleanup per flow', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const signInHandler = main.slice(
    main.indexOf("ipcMain.handle('copilot:signIn'"),
    main.indexOf("ipcMain.handle('copilot:cancelSignIn'")
  );
  const cancelHandler = main.slice(
    main.indexOf("ipcMain.handle('copilot:cancelSignIn'"),
    main.indexOf("ipcMain.on('window:minimize'")
  );

  assert.match(main, /let copilotLoginFlowId = '';/);
  assert.match(signInHandler, /const controller = new AbortController\(\);/);
  assert.match(signInHandler, /const flowId = String\(request\?\.flowId \|\| ''\)\.trim\(\);/);
  assert.match(signInHandler, /copilotLoginController = controller;/);
  assert.match(signInHandler, /copilotLoginFlowId = flowId;/);
  assert.match(signInHandler, /if \(copilotLoginController !== controller\) return;/);
  assert.match(signInHandler, /event\.sender\.send\('copilot:loginStatus', \{ \.\.\.payload, flowId \}\)/);
  assert.match(signInHandler, /if \(copilotLoginController !== controller\) \{[\s\S]*return \{ ok: false, error: copilotLoginErrorMessage\(\{ status: 'cancelled' \}\), flowId \};[\s\S]*\}/);
  assert.match(signInHandler, /if \(copilotLoginController === controller\) \{[\s\S]*copilotLoginController = null;[\s\S]*copilotLoginFlowId = '';/);
  assert.match(cancelHandler, /if \(flowId && copilotLoginFlowId && flowId !== copilotLoginFlowId\) return \{ ok: true \};/);
  assert.match(cancelHandler, /const controller = copilotLoginController;/);
  assert.match(cancelHandler, /if \(copilotLoginController === controller\) \{/);
});

// Same bound applies once the head has arrived. Without it a stalled body leaves the
// sign-in hanging with no way back to the timedOut/cancelled mapping below.
test('requestDeviceCode bounds a body that stalls after the headers', { timeout: 5000 }, async () => {
  await assert.rejects(
    () => requestDeviceCode('', {
      fetchTimeoutMs: 1,
      fetch: async (_url, init) => ({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        })
      })
    }),
    (error) => error?.status === 'timedOut'
  );
});
