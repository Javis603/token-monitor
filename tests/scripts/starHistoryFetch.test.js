'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchSanitizedStargazers } = require('../../scripts/fetch-star-history-stargazers');

const response = (data, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Forbidden',
  headers: new Headers(headers),
  text: async () => JSON.stringify(data),
});

test('fetches timestamped stargazers and strips every identity field', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/repos/Javis603/token-monitor')) {
      return response({ stargazers_count: 2, owner: { login: 'Javis603' } });
    }
    return response([
      { starred_at: '2026-08-03T12:00:00Z', user: { login: 'newest-user' } },
      { starred_at: '2026-08-01T12:00:00Z', user: { login: 'oldest-user' } },
    ]);
  };

  const stars = await fetchSanitizedStargazers({
    repository: 'Javis603/token-monitor',
    token: 'secret-token',
    fetchImpl,
  });

  assert.deepEqual(stars, [
    { starredAt: '2026-08-01T12:00:00.000Z' },
    { starredAt: '2026-08-03T12:00:00.000Z' },
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(requests[0].options.headers.Accept, 'application/vnd.github.star+json');
  assert.doesNotMatch(JSON.stringify(stars), /login|user|Javis603/);
});

test('rejects incomplete pagination instead of publishing a partial chart', async () => {
  const fetchImpl = async (url) => String(url).endsWith('/repos/Javis603/token-monitor')
    ? response({ stargazers_count: 2 })
    : response([{ starred_at: '2026-08-01T12:00:00Z' }]);

  await assert.rejects(
    fetchSanitizedStargazers({
      repository: 'Javis603/token-monitor',
      token: 'secret-token',
      fetchImpl,
    }),
    /fetched 1 timestamps.*reports 2/,
  );
});

test('reports the GitHub accepted-permissions hint without response data', async () => {
  const fetchImpl = async () => response(
    { message: 'Resource not accessible by integration', private: 'do not echo me' },
    { status: 403, headers: { 'x-accepted-github-permissions': 'metadata=read; contents=write' } },
  );

  await assert.rejects(
    fetchSanitizedStargazers({
      repository: 'Javis603/token-monitor',
      token: 'secret-token',
      fetchImpl,
    }),
    (error) => {
      assert.match(error.message, /403 Forbidden; accepted permissions: metadata=read; contents=write/);
      assert.doesNotMatch(error.message, /do not echo me|secret-token/);
      return true;
    },
  );
});
