'use strict';

const fs = require('node:fs/promises');

const GENERATED_NOTES_MARKER = '<!-- github-generated-release-notes -->';

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
  const matches = [...template.matchAll(/^<summary><strong>Full Changelog:<\/strong> <a href="https:\/\/github\.com\/Javis603\/token-monitor\/compare\/(v[^.\s"]+(?:\.[^.\s"]+){2})\.\.\.(v[^.\s"]+(?:\.[^.\s"]+){2})">\1\.\.\.\2<\/a><\/summary>$/gm)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one versioned Full Changelog link, found ${matches.length}`);
  }
  return { previousTag: matches[0][1], currentTag: matches[0][2] };
}

async function fetchGeneratedNotes({ repository, tag, previousTag, token, fetchImpl = fetch }) {
  if (!repository || !tag || !previousTag || !token) {
    throw new Error('repository, current tag, previous tag, and token are required');
  }

  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/generate-notes`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'token-monitor-release-workflow'
    },
    body: JSON.stringify({ tag_name: tag, previous_tag_name: previousTag })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub release-notes generation failed (${response.status}): ${detail}`);
  }

  const payload = await response.json();
  if (typeof payload.body !== 'string') {
    throw new Error('GitHub release-notes response did not contain a body');
  }
  return payload.body;
}

async function githubJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'token-monitor-release-workflow'
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub changelog lookup failed (${response.status}): ${detail}`);
  }
  return response.json();
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

async function fetchDirectCommits({ repository, tag, previousTag, token, fetchImpl = fetch }) {
  if (!repository || !tag || !previousTag || !token) {
    throw new Error('repository, current tag, previous tag, and token are required');
  }

  const baseUrl = `https://api.github.com/repos/${repository}`;
  const commits = [];
  for (let page = 1; ; page += 1) {
    const comparison = await githubJson(
      `${baseUrl}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(tag)}?per_page=100&page=${page}`,
      token,
      fetchImpl
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

    const pulls = await githubJson(`${baseUrl}/commits/${sha}/pulls`, token, fetchImpl);
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
  composeReleaseNotes,
  fetchDirectCommits,
  fetchGeneratedNotes,
  fullChangelogRange,
  generatedChangelogDetails,
  generatedNotesWithoutFullChangelog,
  isReleaseCommit,
  notesWithDirectCommits
};
