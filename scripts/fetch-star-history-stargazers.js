'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const PAGE_SIZE = 30;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const SECONDS_PER_DAY = 86_400;
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
  Accept: 'application/vnd.github+json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

// GitHub does not guarantee that calendar weeks align with UTC. A Sunday in a
// positive-offset timezone can arrive as Saturday in UTC, so move those weeks
// forward and normalize every week to midnight on its Sunday UTC date.
const normalizeWeekStart = (week) => {
  const sunday = new Date(week * 1000).getUTCDay() === 6 ? week + SECONDS_PER_DAY : week;
  return Math.floor(sunday / SECONDS_PER_DAY) * SECONDS_PER_DAY;
};

const weekStartForTimestamp = (timestampSeconds) => {
  const day = new Date(timestampSeconds * 1000).getUTCDay();
  return Math.floor((timestampSeconds - day * SECONDS_PER_DAY) / SECONDS_PER_DAY) * SECONDS_PER_DAY;
};

const normalizeHistoryPage = (entries, offset) => {
  if (!Array.isArray(entries)) fail('GitHub star history response was not an array');
  return entries.map((entry, index) => {
    const week = entry?.week;
    const total = entry?.total;
    const days = entry?.days;
    if (!Number.isInteger(week) || week < 0) {
      fail(`star history entry ${offset + index + 1} has an invalid week timestamp`);
    }
    if (!Array.isArray(days) || days.length !== 7 || days.some((day) => !Number.isInteger(day) || day < 0)) {
      fail(`star history entry ${offset + index + 1} has invalid daily counts`);
    }
    const counted = days.reduce((sum, day) => sum + day, 0);
    if (!Number.isInteger(total) || total < 0 || total !== counted) {
      fail(`star history entry ${offset + index + 1} has inconsistent totals`);
    }
    return { week: normalizeWeekStart(week), total, days };
  });
};

const fetchRepositoryMetadata = async ({ repository, token, apiUrl, fetchImpl }) => {
  const response = await fetchJson(apiEndpoint(apiUrl, `/repos/${repository}`), token, fetchImpl);
  const stargazersCount = response.data?.stargazers_count;
  const createdAt = Date.parse(response.data?.created_at);
  if (!Number.isInteger(stargazersCount) || stargazersCount < 0) {
    fail('repository metadata has an invalid stargazers_count');
  }
  if (!Number.isFinite(createdAt)) {
    fail('repository metadata has an invalid created_at');
  }
  return { stargazersCount, createdAt };
};

const fetchHistoryWeeks = async ({ repository, token, apiUrl, fetchImpl }) => {
  const weeks = [];
  const seenWeeks = new Set();
  let page = 1;
  for (;;) {
    if (page > MAX_PAGES) fail(`pagination exceeded ${MAX_PAGES} pages`);
    const url = new URL(apiEndpoint(apiUrl, `/repos/${repository}/stargazers/history`));
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const response = await fetchJson(url, token, fetchImpl);
    if (!Array.isArray(response.data)) fail('GitHub star history response was not an array');
    if (response.data.length === 0) break;

    const normalized = normalizeHistoryPage(response.data, weeks.length);
    for (const entry of normalized) {
      if (seenWeeks.has(entry.week)) fail(`GitHub returned duplicate star history week ${entry.week}`);
      seenWeeks.add(entry.week);
      weeks.push(entry);
    }

    const nextPage = parseNextPage(responseHeader(response.headers, 'link'));
    if (nextPage !== null) {
      if (nextPage <= page) fail(`pagination moved backwards from page ${page}`);
      page = nextPage;
    } else if (response.data.length === PAGE_SIZE && page < MAX_PAGES) {
      page += 1;
    } else {
      break;
    }
  }

  const ordered = [...weeks].sort((left, right) => left.week - right.week);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].week - ordered[index - 1].week !== 7 * SECONDS_PER_DAY) {
      fail(`GitHub star history is not contiguous between weeks ${ordered[index - 1].week} and ${ordered[index].week}`);
    }
  }
  return ordered;
};

// The aggregate endpoint exposes daily star counts without identities. Expand
// each day back into one synthetic timestamp per star so the existing renderer,
// which expects per-star timestamps, can chart the same daily curve.
const expandHistoryWeeks = (weeks) => {
  const stars = [];
  const ordered = [...weeks].sort((left, right) => left.week - right.week);
  for (const { week, days } of ordered) {
    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      const count = days[dayIndex];
      if (count === 0) continue;
      const starredAt = new Date((week + dayIndex * SECONDS_PER_DAY) * 1000).toISOString();
      for (let index = 0; index < count; index += 1) {
        stars.push({ starredAt });
      }
    }
  }
  return stars;
};

const fetchSanitizedStargazers = async ({
  repository,
  token,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = globalThis.fetch,
} = {}) => {
  assertRepository(repository);
  if (typeof fetchImpl !== 'function') fail('this Node runtime does not provide fetch');

  const { stargazersCount, createdAt } = await fetchRepositoryMetadata({ repository, token, apiUrl, fetchImpl });
  if (stargazersCount === 0) return [];

  const weeks = await fetchHistoryWeeks({ repository, token, apiUrl, fetchImpl });
  const stars = expandHistoryWeeks(weeks);
  if (stars.length === 0) {
    fail('GitHub returned no star history for a repository with stargazers');
  }

  // Contiguous weeks plus the creation-week check above prove the history is
  // complete. Any remaining count difference is a live star change during the
  // fetch, so keep the fetched total instead of failing the scheduled run.
  const creationWeek = weekStartForTimestamp(Math.floor(createdAt / 1000));
  if (weeks[0].week > creationWeek) {
    fail(`star history starts at week ${weeks[0].week}, after repository creation week ${creationWeek}`);
  }
  if (stars.length !== stargazersCount) {
    console.warn(`Star History stargazer count changed by ${Math.abs(stars.length - stargazersCount)} during fetch; using the fetched history total.`);
  }
  return stars;
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
  expandHistoryWeeks,
  fetchSanitizedStargazers,
  normalizeHistoryPage,
  parseNextPage,
};
