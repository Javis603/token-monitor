'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchSanitizedStargazers } = require('../../scripts/fetch-star-history-stargazers');

const WEEK = Date.parse('2026-08-02T00:00:00Z') / 1000;
const DAY = 86_400;

const response = (data, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Forbidden',
  headers: new Headers(headers),
  text: async () => JSON.stringify(data),
});

test('fetches aggregate star history and strips every identity field', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const target = String(url);
    requests.push({ url: target, options });
    if (target.endsWith('/repos/Javis603/token-monitor')) {
      return response({ stargazers_count: 3, owner: { login: 'Javis603' } });
    }
    assert.match(target, /\/stargazers\/history\?/);
    assert.match(target, /per_page=30/);
    assert.match(target, /page=1/);
    return response([
      { week: WEEK, total: 3, days: [1, 0, 0, 2, 0, 0, 0] },
    ]);
  };

  const stars = await fetchSanitizedStargazers({
    repository: 'Javis603/token-monitor',
    token: 'secret-token',
    fetchImpl,
  });

  assert.deepEqual(stars, [
    { starredAt: new Date(WEEK * 1000).toISOString() },
    { starredAt: new Date((WEEK + 3 * DAY) * 1000).toISOString() },
    { starredAt: new Date((WEEK + 3 * DAY) * 1000).toISOString() },
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(requests[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(requests[0].options.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.doesNotMatch(JSON.stringify(stars), /login|user|owner|Javis603/);
});

test('returns no timestamps for a repository with no stargazers', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    requests.push(target);
    if (target.endsWith('/repos/Javis603/token-monitor')) {
      return response({ stargazers_count: 0 });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const stars = await fetchSanitizedStargazers({
    repository: 'Javis603/token-monitor',
    token: 'secret-token',
    fetchImpl,
  });

  assert.deepEqual(stars, []);
  assert.equal(requests.length, 1);
});

test('follows star history pagination', async () => {
  const requests = [];
  const olderWeek = WEEK - 7 * DAY;
  const fetchImpl = async (url) => {
    const target = String(url);
    requests.push(target);
    if (target.endsWith('/repos/Javis603/token-monitor')) {
      return response({ stargazers_count: 2 });
    }
    if (target.includes('page=1')) {
      return response(
        [{ week: WEEK, total: 1, days: [1, 0, 0, 0, 0, 0, 0] }],
        {
          headers: {
            link: '<https://api.github.com/repos/Javis603/token-monitor/stargazers/history?per_page=30&page=2>; rel="next"',
          },
        },
      );
    }
    if (target.includes('page=2')) {
      return response([{ week: olderWeek, total: 1, days: [0, 0, 0, 0, 0, 0, 1] }]);
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const stars = await fetchSanitizedStargazers({
    repository: 'Javis603/token-monitor',
    token: 'secret-token',
    fetchImpl,
  });

  assert.deepEqual(stars, [
    { starredAt: new Date((olderWeek + 6 * DAY) * 1000).toISOString() },
    { starredAt: new Date(WEEK * 1000).toISOString() },
  ]);
  assert.equal(requests.length, 3);
});

test('rejects incomplete history instead of publishing a partial chart', async () => {
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.endsWith('/repos/Javis603/token-monitor')) {
      return response({ stargazers_count: 2 });
    }
    return response([{ week: WEEK, total: 1, days: [1, 0, 0, 0, 0, 0, 0] }]);
  };

  await assert.rejects(
    fetchSanitizedStargazers({
      repository: 'Javis603/token-monitor',
      token: 'secret-token',
      fetchImpl,
    }),
    /fetched 1 timestamps.*reports 2/,
  );
});

test('rejects inconsistent weekly totals', async () => {
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.endsWith('/repos/Javis603/token-monitor')) {
      return response({ stargazers_count: 2 });
    }
    return response([{ week: WEEK, total: 1, days: [1, 1, 0, 0, 0, 0, 0] }]);
  };

  await assert.rejects(
    fetchSanitizedStargazers({
      repository: 'Javis603/token-monitor',
      token: 'secret-token',
      fetchImpl,
    }),
    /inconsistent totals/,
  );
});

test('allows anonymous reads for public repositories', async () => {
  let headers;
  const fetchImpl = async (url, options) => {
    assert.match(String(url), /\/repos\/Javis603\/token-monitor$/);
    headers = options.headers;
    return response({ stargazers_count: 0 });
  };

  const stars = await fetchSanitizedStargazers({
    repository: 'Javis603/token-monitor',
    fetchImpl,
  });

  assert.deepEqual(stars, []);
  assert.equal(headers.Authorization, undefined);
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
