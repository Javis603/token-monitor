'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  REPOSITORY_API_URL,
  SUCCESS_TTL_MS,
  FAILURE_TTL_MS,
  createRepositoryStars,
  starsFromPayload
} = require('../../src/electron/repositoryStars');

function response(body, ok = true) {
  return { ok, json: async () => body };
}

test('reads only a non-negative integer star count', () => {
  assert.equal(starsFromPayload({ stargazers_count: 3760 }), 3760);
  assert.equal(starsFromPayload({ stargazers_count: 0 }), 0);
  assert.equal(starsFromPayload({ stargazers_count: -1 }), null);
  assert.equal(starsFromPayload({ stargazers_count: '3760' }), null);
  assert.equal(starsFromPayload({ stargazers_count: 1.5 }), null);
  assert.equal(starsFromPayload(null), null);
});

test('asks the repository endpoint once per cache window and shares concurrent requests', async () => {
  let clock = 1_000;
  const requests = [];
  const stars = createRepositoryStars({
    userAgent: 'token-monitor/1.2.3',
    now: () => clock,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response({ stargazers_count: 3760 });
    }
  });

  assert.deepEqual(await Promise.all([stars.get(), stars.get()]), [3760, 3760]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, REPOSITORY_API_URL);
  assert.equal(requests[0].options.headers['user-agent'], 'token-monitor/1.2.3');

  clock += SUCCESS_TTL_MS - 1;
  assert.equal(await stars.get(), 3760);
  assert.equal(requests.length, 1);
  clock += 1;
  await stars.get();
  assert.equal(requests.length, 2);
});

test('a failed refresh keeps the last count and retries sooner', async () => {
  let clock = 0;
  let reply = () => response({ stargazers_count: 10 });
  let requests = 0;
  const stars = createRepositoryStars({
    userAgent: 'token-monitor/test',
    now: () => clock,
    fetchImpl: async () => { requests++; return reply(); }
  });

  assert.equal(await stars.get(), 10);
  clock += SUCCESS_TTL_MS;
  reply = () => response({ message: 'API rate limit exceeded' }, false);
  assert.equal(await stars.get(), 10);
  clock += FAILURE_TTL_MS;
  reply = () => { throw new Error('offline'); };
  assert.equal(await stars.get(), 10);
  assert.equal(requests, 3);
});

test('reports no count when nothing has ever been fetched', async () => {
  const stars = createRepositoryStars({ userAgent: 'token-monitor/test', fetchImpl: async () => response({}, false) });
  assert.equal(await stars.get(), null);
});
