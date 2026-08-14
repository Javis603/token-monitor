'use strict';

const fs = require('node:fs/promises');

const GENERATED_NOTES_MARKER = '<!-- github-generated-release-notes -->';
const GITHUB_API_VERSION = '2026-03-10';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_COMPARE_PAGES = 10_000;

function apiEndpoint(apiUrl, pathname) {
  const base = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`invalid GITHUB_API_URL: ${apiUrl}`);
  }
  return `${base}${pathname}`;
}

function requestHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'token-monitor-release-workflow'
  };
}

function requestSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function githubFetch(url, options, fetchImpl, context) {
  try {
    return await fetchImpl(url, options);
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error(`${context} timed out`, { cause: error });
    }
    throw new Error(`${context} request failed: ${error?.message || error}`, { cause: error });
  }
}

function generatedNotesWithoutFullChangelog(notes) {
  return String(notes || '')
    .replace(/^\*\*Full Changelog(?:\*\*:|:\*\*)[^\r\n]*(?:\r?\n)?/gim, '')
    .trim();
}

function directCommitLine(repository, commit) {
  const subject = String(commit.subject || '').trim();
  const author = commit.authorLogin ? `@${commit.authorLogin}` : commit.authorName;
  const shortSha = commit.sha.slice(0, 7);
  return `* ${subject} by ${author} ([${shortSha}](https://github.com/${repository}/commit/${commit.sha}))`;
}

function notesWithDirectCommits(notes, repository, directCommits) {
  const body = generatedNotesWithoutFullChangelog(notes);
  if (directCommits.length === 0) return body;

  const lines = directCommits.map((commit) => directCommitLine(repository, commit)).join('\n');
  const heading = /^## What's Changed\s*$/m;
  const headingMatch = heading.exec(body);
  if (!headingMatch) return `## What's Changed\n${lines}\n\n${body}`.trim();

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const followingHeading = /^## /m.exec(body.slice(sectionStart));
  const insertionPoint = followingHeading
    ? sectionStart + followingHeading.index
    : body.length;
  const before = body.slice(0, insertionPoint).trimEnd();
  const after = body.slice(insertionPoint).trimStart();
  return after ? `${before}\n${lines}\n\n${after}` : `${before}\n${lines}`;
}

function generatedChangelogDetails(notes, repository = '', directCommits = []) {
  return notesWithDirectCommits(notes, repository, directCommits);
}

function composeReleaseNotes(template, generatedNotes, { repository = '', directCommits = [] } = {}) {
  const markerCount = template.split(GENERATED_NOTES_MARKER).length - 1;
  if (markerCount !== 1) {
    throw new Error(`expected exactly one ${GENERATED_NOTES_MARKER} marker, found ${markerCount}`);
  }

  const notes = generatedChangelogDetails(generatedNotes, repository, directCommits);
  return template.replace(GENERATED_NOTES_MARKER, notes);
}

function fullChangelogRange(template) {
  const matches = [...template.matchAll(/^<summary><strong>Full Changelog:<\/strong> <a href="https:\/\/github\.com\/Javis603\/token-monitor\/compare\/([^"\s]+)">([^<]+)<\/a><\/summary>$/gm)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one versioned Full Changelog link, found ${matches.length}`);
  }
  const hrefRange = matches[0][1];
  const linkText = matches[0][2];
  const tags = hrefRange.split('...');
  if (tags.length !== 2 || tags.some((tag) => !tag.startsWith('v') || tag.length === 1)) {
    throw new Error(`invalid Full Changelog range: ${hrefRange}`);
  }
  if (linkText !== hrefRange) {
    throw new Error(`Full Changelog text ${linkText} does not match href range ${hrefRange}`);
  }
  return { previousTag: tags[0], currentTag: tags[1] };
}

async function fetchGeneratedNotes({
  repository,
  tag,
  previousTag,
  token,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = fetch,
  signalFactory = requestSignal
}) {
  if (!repository || !tag || !previousTag || !token) {
    throw new Error('repository, current tag, previous tag, and token are required');
  }

  const response = await githubFetch(apiEndpoint(apiUrl, `/repos/${repository}/releases/generate-notes`), {
    method: 'POST',
    headers: requestHeaders(token),
    body: JSON.stringify({ tag_name: tag, previous_tag_name: previousTag }),
    signal: signalFactory()
  }, fetchImpl, 'GitHub release-notes generation');

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub release-notes generation failed (${response.status}): ${detail}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('GitHub release-notes response was not valid JSON');
  }
  if (typeof payload.body !== 'string') {
    throw new Error('GitHub release-notes response did not contain a body');
  }
  return payload.body;
}

async function githubJson(url, token, fetchImpl, signalFactory) {
  const response = await githubFetch(url, {
    headers: requestHeaders(token),
    signal: signalFactory()
  }, fetchImpl, 'GitHub changelog lookup');
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub changelog lookup failed (${response.status}): ${detail}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('GitHub changelog response was not valid JSON');
  }
}

function isReleaseCommit(subject, currentTag) {
  const version = currentTag.replace(/^v/, '');
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^chore(?:\\([^)]*\\))?: release v?${escapedVersion}$`, 'i')
    .test(subject.trim());
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function fetchDirectCommits({
  repository,
  tag,
  previousTag,
  token,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = fetch,
  signalFactory = requestSignal
}) {
  if (!repository || !tag || !previousTag || !token) {
    throw new Error('repository, current tag, previous tag, and token are required');
  }

  const baseUrl = apiEndpoint(apiUrl, `/repos/${repository}`);
  const commits = [];
  for (let page = 1; ; page += 1) {
    if (page > MAX_COMPARE_PAGES) {
      throw new Error(`GitHub compare pagination exceeded ${MAX_COMPARE_PAGES} pages`);
    }
    const comparison = await githubJson(
      `${baseUrl}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(tag)}?per_page=100&page=${page}`,
      token,
      fetchImpl,
      signalFactory
    );
    if (!Array.isArray(comparison.commits)) {
      throw new Error('GitHub compare response did not contain commits');
    }
    commits.push(...comparison.commits);
    if (comparison.commits.length < 100) break;
  }

  const direct = await mapConcurrent(commits, 8, async (commit) => {
    const sha = commit?.sha;
    const subject = commit?.commit?.message?.split('\n')[0]?.trim();
    if (!sha || !subject || isReleaseCommit(subject, tag)) return null;

    const pulls = await githubJson(`${baseUrl}/commits/${sha}/pulls`, token, fetchImpl, signalFactory);
    if (!Array.isArray(pulls)) {
      throw new Error(`GitHub pull-request lookup for ${sha} did not return an array`);
    }
    if (pulls.some((pull) => pull?.merged_at)) return null;

    return {
      sha,
      subject,
      authorLogin: commit.author?.login || null,
      authorName: commit.commit?.author?.name || 'Unknown contributor'
    };
  });
  return direct.filter(Boolean);
}

async function main() {
  const [templatePath, outputPath] = process.argv.slice(2);
  if (!templatePath || !outputPath) {
    throw new Error('usage: node scripts/prepare-github-release-notes.js <template> <output>');
  }

  const template = await fs.readFile(templatePath, 'utf8');
  const { previousTag, currentTag } = fullChangelogRange(template);
  if (currentTag !== process.env.GITHUB_REF_NAME) {
    throw new Error(`Full Changelog ends at ${currentTag}, expected ${process.env.GITHUB_REF_NAME}`);
  }
  const generatedNotes = await fetchGeneratedNotes({
    repository: process.env.GITHUB_REPOSITORY,
    tag: currentTag,
    previousTag,
    token: process.env.GITHUB_TOKEN
  });
  const directCommits = await fetchDirectCommits({
    repository: process.env.GITHUB_REPOSITORY,
    tag: currentTag,
    previousTag,
    token: process.env.GITHUB_TOKEN
  });

  await fs.writeFile(outputPath, composeReleaseNotes(template, generatedNotes, {
    repository: process.env.GITHUB_REPOSITORY,
    directCommits
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  GENERATED_NOTES_MARKER,
  apiEndpoint,
  composeReleaseNotes,
  fetchDirectCommits,
  fetchGeneratedNotes,
  fullChangelogRange,
  generatedChangelogDetails,
  generatedNotesWithoutFullChangelog,
  isReleaseCommit,
  notesWithDirectCommits
};
