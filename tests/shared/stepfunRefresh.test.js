'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { REFRESH_URL, combineStepfunToken, isStepfunAuthFailure, refreshStepfunToken } = require('../../src/shared/providers/stepfun/refresh');

test('combineStepfunToken rebuilds the browser cookie pair from a refresh response', () => {
  assert.equal(combineStepfunToken('access', 'refresh', 'old-access...old-refresh'), 'access...refresh');
  // The live server does not rotate the refresh half, but the protocol does
  // not promise one back; a missing half falls back to the previous one.
  assert.equal(combineStepfunToken('access', '', 'old-access...old-refresh'), 'access...old-refresh');
  assert.equal(combineStepfunToken('access', undefined, 'old-access...old-refresh'), 'access...old-refresh');
  // With no previous half to reuse, the access half stands alone.
  assert.equal(combineStepfunToken('access', '', ''), 'access');
  // An empty access half or one carrying a cookie separator cannot come from
  // a legitimate response; refuse the rotation rather than store it.
  assert.equal(combineStepfunToken('', 'refresh', 'old'), '');
  assert.equal(combineStepfunToken('access;evil', 'refresh', 'old'), '');
});

test('only unauthorized verdicts trigger a refresh attempt', () => {
  assert.equal(isStepfunAuthFailure({ status: 'unauthorized' }), true);
  assert.equal(isStepfunAuthFailure({ status: 'unavailable' }), false);
  assert.equal(isStepfunAuthFailure({ status: 'sourceRateLimited' }), false);
  assert.equal(isStepfunAuthFailure(null), false);
});

test('refreshStepfunToken posts to the passport endpoint with the cookie pair', async () => {
  const requests = [];
  const token = await refreshStepfunToken('access-half...refresh-half', 'device-id', {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ accessToken: { raw: 'new-access' }, refreshToken: { raw: 'refresh-half' } }) };
    }
  });
  assert.equal(token, 'new-access...refresh-half');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, REFRESH_URL);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.body, '{}');
  assert.equal(requests[0].init.headers.Cookie, 'Oasis-Token=access-half...refresh-half; Oasis-Webid=device-id');
  assert.equal(requests[0].init.credentials, 'omit');
});

test('refreshStepfunToken reserves null for authentication rejection', async () => {
  for (const status of [401, 403]) {
    assert.equal(await refreshStepfunToken('a...b', 'device-id', {
      fetch: async () => ({ ok: false, status })
    }), null);
  }
});

test('refreshStepfunToken preserves retryable transport and HTTP failures', async () => {
  await assert.rejects(refreshStepfunToken('a...b', 'device-id', {
    fetch: async () => { throw new Error('offline'); }
  }), { status: 'unavailable' });
  for (const [httpStatus, status] of [[429, 'sourceRateLimited'], [500, 'unavailable'], [503, 'unavailable']]) {
    await assert.rejects(refreshStepfunToken('a...b', 'device-id', {
      fetch: async () => ({ ok: false, status: httpStatus })
    }), { status });
  }
});

test('an invalid successful refresh response is unavailable rather than an auth rejection', async () => {
  for (const json of [async () => { throw new Error('invalid JSON'); }, async () => ({}),
    async () => ({ accessToken: { raw: 'invalid;access' } })]) {
    await assert.rejects(refreshStepfunToken('a...b', 'device-id', {
      fetch: async () => ({ ok: true, json })
    }), { status: 'unavailable' });
  }
});

test('refreshStepfunToken propagates cancellation', async () => {
  const controller = new AbortController();
  const reason = new Error('superseded');
  await assert.rejects(refreshStepfunToken('a...b', 'device-id', {
    signal: controller.signal,
    fetch: async (_url, { signal }) => {
      controller.abort(reason);
      throw signal.reason;
    }
  }), error => error === reason);
});

test('refreshStepfunToken propagates cancellation raised during the body read', async () => {
  const controller = new AbortController();
  const reason = new Error('superseded');
  // Use a different error from signal.reason to verify the body rejection's identity is preserved.
  const bodyError = new Error('body read aborted');
  assert.notEqual(bodyError, reason);
  await assert.rejects(refreshStepfunToken('a...b', 'device-id', {
    signal: controller.signal,
    fetch: async () => ({
      ok: true,
      json: async () => {
        controller.abort(reason);
        throw bodyError;
      }
    })
  }), error => error === bodyError);
});
