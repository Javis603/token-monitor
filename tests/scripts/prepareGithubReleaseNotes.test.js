'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GENERATED_NOTES_MARKER,
  composeReleaseNotes,
  fetchDirectCommits,
  fetchGeneratedNotes,
  fullChangelogRange,
  isReleaseCommit
} = require('../../scripts/prepare-github-release-notes');

test('composeReleaseNotes inserts GitHub notes below the single summary link', () => {
  const template = [
    '# User-facing notes',
    '<details>',
    '<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v1.0.0...v1.1.0">v1.0.0...v1.1.0</a></summary>',
    '',
    GENERATED_NOTES_MARKER,
    '</details>'
  ].join('\n');
  const generated = [
    '## What\'s Changed',
    '* fix: preserve manual notes by @contributor in #123',
    '',
    '## New Contributors',
    '* @contributor made their first contribution in #123',
    '',
    '**Full Changelog**: https://example.test/generated-compare'
  ].join('\n');

  const result = composeReleaseNotes(template, generated);

  assert.match(result, /## What's Changed/);
  assert.match(result, /@contributor in #123/);
  assert.match(result, /## New Contributors/);
  assert.doesNotMatch(result, /## Contributors/);
  assert.doesNotMatch(result, /generated-compare/);
  assert.equal(result.match(/Full Changelog:/g)?.length, 1);
  assert.ok(result.indexOf('Full Changelog:') < result.indexOf("## What's Changed"));
});

test('composeReleaseNotes adds direct commits to What\'s Changed before New Contributors', () => {
  const template = `before\n${GENERATED_NOTES_MARKER}\nafter`;
  const generated = [
    '## What\'s Changed',
    '* fix: merged change by @pull-author in #123',
    '',
    '## New Contributors',
    '* @pull-author made their first contribution in #123',
    '',
    '**Full Changelog**: https://example.test/compare'
  ].join('\n');

  const result = composeReleaseNotes(template, generated, {
    repository: 'Javis603/token-monitor',
    directCommits: [{
      sha: 'abcdef1234567890abcdef1234567890abcdef12',
      subject: 'fix(widget): preserve direct changes',
      authorLogin: 'direct-author',
      authorName: 'Direct Author'
    }]
  });

  assert.match(result, /fix\(widget\).*by @direct-author \(\[abcdef1\]\(https:\/\/github\.com\/Javis603\/token-monitor\/commit\/abcdef1234567890abcdef1234567890abcdef12\)\)/);
  assert.ok(result.indexOf('fix(widget)') < result.indexOf('## New Contributors'));
  assert.doesNotMatch(result, /## Contributors/);
});

test('composeReleaseNotes rejects a missing or duplicated insertion marker', () => {
  assert.throws(() => composeReleaseNotes('no marker', 'notes'), /expected exactly one/);
  assert.throws(
    () => composeReleaseNotes(`${GENERATED_NOTES_MARKER}\n${GENERATED_NOTES_MARKER}`, 'notes'),
    /found 2/
  );
});

test('fullChangelogRange locks generated notes to the curated compare range', () => {
  assert.deepEqual(
    fullChangelogRange(
      '<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.42.1...v0.43.0">v0.42.1...v0.43.0</a></summary>'
    ),
    { previousTag: 'v0.42.1', currentTag: 'v0.43.0' }
  );
  assert.deepEqual(
    fullChangelogRange(
      '<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v1.0.0...v1.1.0-beta.1+build.2">v1.0.0...v1.1.0-beta.1+build.2</a></summary>'
    ),
    { previousTag: 'v1.0.0', currentTag: 'v1.1.0-beta.1+build.2' }
  );
  assert.throws(
    () => fullChangelogRange(
      '<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v1.0.0...v1.1.0">v1.0.0...v1.2.0</a></summary>'
    ),
    /does not match href range/
  );
  assert.throws(() => fullChangelogRange('missing'), /found 0/);
});

test('fetchGeneratedNotes requests GitHub generated notes for the pushed tag', async () => {
  let request;
  const body = await fetchGeneratedNotes({
    repository: 'Javis603/token-monitor',
    tag: 'v1.1.0',
    previousTag: 'v1.0.0',
    token: 'test-token',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { body: 'generated notes' };
        }
      };
    }
  });

  assert.equal(body, 'generated notes');
  assert.equal(request.url, 'https://api.github.com/repos/Javis603/token-monitor/releases/generate-notes');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  assert.equal(request.options.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.options.body), {
    tag_name: 'v1.1.0',
    previous_tag_name: 'v1.0.0'
  });
});

test('fetchGeneratedNotes honors GITHUB_API_URL and fails when its timeout signal fires', async () => {
  await assert.rejects(
    fetchGeneratedNotes({
      repository: 'Javis603/token-monitor',
      tag: 'v1.1.0',
      previousTag: 'v1.0.0',
      token: 'test-token',
      apiUrl: 'https://github.example/api/v3/',
      signalFactory: () => AbortSignal.timeout(1),
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://github.example/api/v3/repos/Javis603/token-monitor/releases/generate-notes');
        await new Promise((resolve, reject) => {
          const guard = setTimeout(() => reject(new Error('timeout signal did not fire')), 250);
          options.signal.addEventListener('abort', () => {
            clearTimeout(guard);
            reject(options.signal.reason);
          }, { once: true });
        });
      }
    }),
    /GitHub release-notes generation timed out/
  );
});

test('fetchGeneratedNotes rejects GitHub API errors and invalid JSON', async () => {
  const input = {
    repository: 'Javis603/token-monitor',
    tag: 'v1.1.0',
    previousTag: 'v1.0.0',
    token: 'test-token'
  };
  await assert.rejects(
    fetchGeneratedNotes({
      ...input,
      fetchImpl: async () => ({ ok: false, status: 502, async text() { return 'bad gateway'; } })
    }),
    /failed \(502\): bad gateway/
  );
  await assert.rejects(
    fetchGeneratedNotes({
      ...input,
      fetchImpl: async () => ({ ok: true, async json() { throw new SyntaxError('bad JSON'); } })
    }),
    /was not valid JSON/
  );
});

test('fetchDirectCommits keeps only commits without an associated merged PR', async () => {
  const requests = [];
  const responses = new Map([
    ['compare', {
      commits: [
        {
          sha: '1111111111111111111111111111111111111111',
          commit: { message: 'fix: direct change\n\nbody', author: { name: 'Direct Author' } },
          author: { login: 'direct-author' }
        },
        {
          sha: '2222222222222222222222222222222222222222',
          commit: { message: 'feat: merged change', author: { name: 'PR Author' } },
          author: { login: 'pr-author' }
        },
        {
          sha: '3333333333333333333333333333333333333333',
          commit: { message: 'chore: release v1.1.0', author: { name: 'Maintainer' } },
          author: { login: 'maintainer' }
        }
      ]
    }],
    ['1111111', []],
    ['2222222', [{ number: 42, merged_at: '2026-08-13T00:00:00Z' }]]
  ]);

  const direct = await fetchDirectCommits({
    repository: 'Javis603/token-monitor',
    tag: 'v1.1.0',
    previousTag: 'v1.0.0',
    token: 'test-token',
    apiUrl: 'https://github.example/api/v3/',
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
      assert.ok(options.signal instanceof AbortSignal);
      const key = url.includes('/compare/')
        ? 'compare'
        : url.includes('111111111111') ? '1111111' : '2222222';
      return {
        ok: true,
        async json() { return responses.get(key); }
      };
    }
  });

  assert.deepEqual(direct, [{
    sha: '1111111111111111111111111111111111111111',
    subject: 'fix: direct change',
    authorLogin: 'direct-author',
    authorName: 'Direct Author'
  }]);
  assert.equal(requests.filter((url) => url.includes('/commits/')).length, 2);
  assert.equal(
    requests[0],
    'https://github.example/api/v3/repos/Javis603/token-monitor/compare/v1.0.0...v1.1.0?per_page=100&page=1'
  );
});

test('release commit filtering accepts scoped and unscoped release subjects only', () => {
  assert.equal(isReleaseCommit('chore: release v1.1.0', 'v1.1.0'), true);
  assert.equal(isReleaseCommit('chore(release): release 1.1.0', 'v1.1.0'), true);
  assert.equal(isReleaseCommit('chore: release v1.1.0-beta.1+build.2', 'v1.1.0-beta.1+build.2'), true);
  assert.equal(isReleaseCommit('fix: mention release v1.1.0', 'v1.1.0'), false);
  assert.equal(isReleaseCommit('chore: release v1.0.0', 'v1.1.0'), false);
});
