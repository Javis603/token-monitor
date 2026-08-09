'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const PAGE_SIZE = 100;
const MAX_PAGES = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_API_VERSION = '2026-03-10';

const fail = (message) => {
  throw new Error(`Star History stargazer fetch failed: ${message}`);
};

const assertRepository = (repository) => {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]+$/i.test(repository)) {
    fail(`invalid repository name: ${repository}`);
  }
};

const apiEndpoint = (apiUrl, pathname) => {
  const base = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) fail(`invalid GITHUB_API_URL: ${apiUrl}`);
  return `${base}${pathname}`;
};

const responseHeader = (headers, name) => {
  if (headers?.get) return headers.get(name) || headers.get(name.toLowerCase()) || '';
  return headers?.[name] || headers?.[name.toLowerCase()] || '';
};

const requestHeaders = (token) => ({
  Accept: 'application/vnd.github.star+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': GITHUB_API_VERSION,
  'User-Agent': 'token-monitor-star-history',
});

const fetchJson = async (url, token, fetchImpl) => {
  const response = await fetchImpl(url, {
    headers: requestHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    const accepted = responseHeader(response.headers, 'x-accepted-github-permissions');
    const hint = accepted ? `; accepted permissions: ${accepted}` : '';
    fail(`GitHub API returned ${response.status} ${response.statusText || 'unknown status'}${hint}`);
  }
  try {
    return { data: JSON.parse(body), headers: response.headers };
  } catch {
    fail('GitHub API returned invalid JSON');
  }
};

const parseNextPage = (linkHeader) => {
  if (!linkHeader) return null;
  const next = linkHeader
    .split(',')
    .map((part) => part.trim())
    .find((part) => /;\s*rel="next"(?:\s|$)/i.test(part));
  if (!next) return null;
  const match = next.match(/<([^>]+)>/);
  const page = match ? new URL(match[1]).searchParams.get('page') : '';
  if (!/^\d+$/.test(page) || Number(page) < 1) fail('GitHub returned an invalid next-page link');
  return Number(page);
};

const normalizePage = (entries, offset) => {
  if (!Array.isArray(entries)) fail('GitHub stargazer response was not an array');
  return entries.map((entry, index) => {
    const parsed = new Date(entry?.starred_at);
    if (typeof entry?.starred_at !== 'string' || !Number.isFinite(parsed.getTime())) {
      fail(`stargazer entry ${offset + index + 1} has no valid starred_at timestamp`);
    }
    return { starredAt: parsed.toISOString(), sourceIndex: offset + index };
  });
};

const fetchSanitizedStargazers = async ({
  repository,
  token,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = globalThis.fetch,
} = {}) => {
  assertRepository(repository);
  if (!token) fail('GITHUB_TOKEN is required');
  if (typeof fetchImpl !== 'function') fail('this Node runtime does not provide fetch');

  const stars = [];
  let page = 1;
  for (;;) {
    if (page > MAX_PAGES) fail(`pagination exceeded ${MAX_PAGES} pages`);
    const url = new URL(apiEndpoint(apiUrl, `/repos/${repository}/stargazers`));
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const response = await fetchJson(url, token, fetchImpl);
    if (response.data.length === 0) {
      if (page === 1) fail('GitHub returned no timestamped stargazers');
      break;
    }
    stars.push(...normalizePage(response.data, stars.length));

    const nextPage = parseNextPage(responseHeader(response.headers, 'link'));
    if (nextPage !== null) {
      if (nextPage <= page) fail(`pagination moved backwards from page ${page}`);
      page = nextPage;
    } else if (response.data.length === PAGE_SIZE) {
      page += 1;
    } else {
      break;
    }
  }

  const metadata = await fetchJson(apiEndpoint(apiUrl, `/repos/${repository}`), token, fetchImpl);
  const expectedCount = metadata.data?.stargazers_count;
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    fail('repository metadata has no positive stargazers_count');
  }
  if (stars.length !== expectedCount) {
    fail(`fetched ${stars.length} timestamps but repository metadata reports ${expectedCount}`);
  }

  stars.sort((left, right) => {
    const delta = Date.parse(left.starredAt) - Date.parse(right.starredAt);
    return delta || left.sourceIndex - right.sourceIndex;
  });
  return stars.map(({ starredAt }) => ({ starredAt }));
};

const parseCli = (args) => {
  const options = { repository: '', output: '' };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail(`${name || 'argument'} requires a value`);
    if (name === '--repository') options.repository = value;
    else if (name === '--output') options.output = value;
    else fail(`unknown argument ${name}`);
  }
  if (!options.repository || !options.output) fail('required arguments are --repository and --output');
  return options;
};

const main = async () => {
  const options = parseCli(process.argv.slice(2));
  const stars = await fetchSanitizedStargazers({
    repository: options.repository,
    token: process.env.GITHUB_TOKEN,
  });
  const output = path.resolve(options.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(stars, null, 2)}\n`, { mode: 0o600 });
  console.log(`Prepared ${stars.length} identity-free stargazer timestamps.`);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchSanitizedStargazers,
  parseNextPage,
};
