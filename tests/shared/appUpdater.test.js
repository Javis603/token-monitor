'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  appUpdateInstallSupport,
  checkLatestRelease,
  classifyAppUpdateError,
  deriveAppUpdateAvailability,
  downloadedAppUpdateMatchesLatest,
  extractReleaseNotes,
  extractUpdaterReleaseHistory,
  extractUpdaterReleaseNotes,
  latestForCurrentVersion,
  latestFromUpdaterInfo,
  MAX_RELEASE_NOTE_HISTORY,
  mergeLatestReleaseMetadata,
  parseLatestReleasePayload,
  parseTag,
  providerUpdateCheckAvailability,
  RELEASES_LATEST_URL,
  resolveAppUpdateCheckError,
  shouldDownloadAutomaticAppUpdate,
  shouldSkipAppUpdateCheck,
  APP_UPDATE_BACKGROUND_COOLDOWN_MS,
  APP_UPDATE_STARTUP_DELAY_MS
} = require('../../src/shared/appUpdater');

const trailingPullRequestReference = /(?:\(\s*#\d+(?:\s*,\s*#\d+)*\s*\)|（\s*#\d+(?:\s*[、，,]\s*#\d+)*\s*）)$/;

test('the automatic downloader stands down once an attempt is spent', () => {
  const base = {
    automaticAppUpdates: true,
    updateState: {
      hasUpdate: true,
      installSupported: true,
      dismissedVersion: null,
      latest: { version: '0.43.0' },
      downloaded: false,
      installBusy: false,
      installRetryBlocked: false
    }
  };
  assert.equal(shouldDownloadAutomaticAppUpdate(base), true);
  // Otherwise every background check re-downloads an artifact this process can
  // never install, on a timer, for the rest of the session.
  assert.equal(shouldDownloadAutomaticAppUpdate({
    ...base,
    updateState: { ...base.updateState, installRetryBlocked: true }
  }), false);
});

test('source-mode release checks use the public GitHub page instead of the REST API', () => {
  assert.equal(RELEASES_LATEST_URL, 'https://github.com/Javis603/token-monitor/releases/latest');
});

test('source-mode release checks negotiate public release JSON without authentication', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, RELEASES_LATEST_URL);
    assert.equal(options.headers.accept, 'application/json');
    assert.equal(Object.hasOwn(options.headers, 'authorization'), false);
    return { ok: true, json: async () => ({ tag_name: 'v0.40.0' }) };
  };
  try {
    const result = await checkLatestRelease('0.39.0');
    assert.equal(result.ok, true);
    assert.equal(result.newer, true);
    assert.equal(result.latest.version, '0.40.0');
  } finally {
    global.fetch = originalFetch;
  }
});

test('source-mode release checks classify public endpoint throttling', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429 });
  try {
    const result = await checkLatestRelease('0.39.0');
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'rateLimited');
  } finally {
    global.fetch = originalFetch;
  }
});

test('parseTag strips a leading v from valid semver tags', () => {
  assert.equal(parseTag('v1.2.3'), '1.2.3');
  assert.equal(parseTag('V0.1.0'), '0.1.0');
});

test('parseTag accepts tags without a v prefix', () => {
  assert.equal(parseTag('1.2.3'), '1.2.3');
});

test('parseTag returns null for invalid or empty input', () => {
  assert.equal(parseTag(''), null);
  assert.equal(parseTag(null), null);
  assert.equal(parseTag(undefined), null);
  assert.equal(parseTag('release-foo'), null);
  assert.equal(parseTag('v1.2'), null);
  assert.equal(parseTag(123), null);
});

test('appUpdateInstallSupport only enables packaged auto-updatable targets', () => {
  assert.deepEqual(appUpdateInstallSupport({ isPackaged: false, platform: 'darwin' }), { supported: false, reason: 'unpackaged' });
  assert.deepEqual(appUpdateInstallSupport({ isPackaged: true, platform: 'darwin' }), { supported: true, reason: '' });
  assert.deepEqual(appUpdateInstallSupport({ isPackaged: true, platform: 'win32', env: {} }), { supported: true, reason: '' });
  assert.deepEqual(appUpdateInstallSupport({
    isPackaged: true,
    platform: 'win32',
    env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Downloads\\Token-Monitor.exe' }
  }), { supported: false, reason: 'windows-portable' });
  assert.deepEqual(appUpdateInstallSupport({ isPackaged: true, platform: 'linux', env: {} }), { supported: false, reason: 'linux-not-appimage' });
  assert.deepEqual(appUpdateInstallSupport({ isPackaged: true, platform: 'linux', env: { APPIMAGE: '/tmp/Token Monitor.AppImage' } }), { supported: true, reason: '' });
});

test('shouldSkipAppUpdateCheck refreshes cached update prompts sooner than the normal cooldown', () => {
  const nowMs = Date.parse('2026-07-02T18:30:00Z');
  const twoHoursAgo = '2026-07-02T16:30:00Z';
  const tenMinutesAgo = '2026-07-02T18:20:00Z';
  const latest = { version: '0.18.0' };

  assert.equal(shouldSkipAppUpdateCheck({
    currentVersion: '0.17.0',
    latest,
    lastCheckedAt: twoHoursAgo,
    nowMs
  }), false);

  assert.equal(shouldSkipAppUpdateCheck({
    currentVersion: '0.17.0',
    latest,
    lastCheckedAt: tenMinutesAgo,
    nowMs
  }), true);
});

test('shouldSkipAppUpdateCheck uses normal cooldown for dismissed cached updates', () => {
  const nowMs = Date.parse('2026-07-02T18:30:00Z');
  const oneHourAgo = '2026-07-02T17:30:00Z';
  const threeHoursAgo = '2026-07-02T15:30:00Z';

  assert.equal(shouldSkipAppUpdateCheck({
    currentVersion: '0.17.0',
    latest: { version: '0.18.0' },
    dismissedVersion: '0.18.0',
    lastCheckedAt: oneHourAgo,
    nowMs
  }), true);

  assert.equal(shouldSkipAppUpdateCheck({
    currentVersion: '0.17.0',
    latest: { version: '0.18.0' },
    dismissedVersion: '0.18.0',
    lastCheckedAt: threeHoursAgo,
    nowMs
  }), false);
});

test('background cooldown lets the tick a cooldown later run', () => {
  const nowMs = Date.parse('2026-07-02T18:30:00Z');
  const ago = (ms) => new Date(nowMs - ms).toISOString();
  const noUpdate = {
    currentVersion: '0.17.0',
    latest: { version: '0.17.0' },
    dismissedVersion: null,
    nowMs
  };
  // The launch check stamps 15 s into the hourly timer, so the tick two hours
  // after it lands a few seconds short of the cooldown and must still run.
  assert.equal(shouldSkipAppUpdateCheck({ ...noUpdate, lastCheckedAt: ago(2 * 60 * 60 * 1000 - 15 * 1000) }), false);
  assert.equal(shouldSkipAppUpdateCheck({ ...noUpdate, lastCheckedAt: ago(2 * 60 * 60 * 1000 - 5) }), false);
  assert.equal(shouldSkipAppUpdateCheck({ ...noUpdate, lastCheckedAt: ago(2 * 60 * 60 * 1000 - 2 * 60 * 1000) }), true);
  assert.equal(shouldSkipAppUpdateCheck({ ...noUpdate, lastCheckedAt: ago(60 * 60 * 1000) }), true);

  const outdated = {
    currentVersion: '0.17.0',
    latest: { version: '0.18.0' },
    dismissedVersion: null,
    nowMs
  };
  assert.equal(shouldSkipAppUpdateCheck({ ...outdated, lastCheckedAt: ago(60 * 60 * 1000 - 15 * 1000) }), false);
  assert.equal(shouldSkipAppUpdateCheck({ ...outdated, lastCheckedAt: ago(50 * 60 * 1000) }), true);
});

test('downloadedAppUpdateMatchesLatest only trusts the downloaded latest version', () => {
  assert.equal(downloadedAppUpdateMatchesLatest({
    phase: 'downloaded',
    downloadedVersion: '0.19.0',
    latest: { version: '0.19.0' }
  }), true);

  assert.equal(downloadedAppUpdateMatchesLatest({
    phase: 'downloaded',
    downloadedVersion: '0.18.0',
    latest: { version: '0.19.0' }
  }), false);

  assert.equal(downloadedAppUpdateMatchesLatest({
    phase: 'downloading',
    downloadedVersion: '0.19.0',
    latest: { version: '0.19.0' }
  }), false);

  assert.equal(downloadedAppUpdateMatchesLatest({
    phase: 'downloaded',
    downloadedVersion: '0.19.0',
    latest: null
  }), false);
});

test('shouldDownloadAutomaticAppUpdate covers the automatic-download state matrix', () => {
  const ready = {
    hasUpdate: true,
    installSupported: true,
    latest: { version: '0.28.1' },
    dismissedVersion: null,
    downloaded: false,
    installBusy: false
  };
  const cases = [
    ['enabled and ready', true, ready, true],
    ['preference disabled', false, ready, false],
    ['no update', true, { ...ready, hasUpdate: false }, false],
    ['unsupported build', true, { ...ready, installSupported: false }, false],
    ['latest version dismissed', true, { ...ready, dismissedVersion: '0.28.1' }, false],
    ['older version dismissed', true, { ...ready, dismissedVersion: '0.28.0' }, true],
    ['already downloaded', true, { ...ready, downloaded: true }, false],
    ['check or download already in flight', true, { ...ready, installBusy: true }, false],
    ['missing update state', true, null, false]
  ];

  for (const [name, automaticAppUpdates, updateState, expected] of cases) {
    assert.equal(
      shouldDownloadAutomaticAppUpdate({ automaticAppUpdates, updateState }),
      expected,
      name
    );
  }
});

test('deriveAppUpdateAvailability keeps availability separate from notification dismissal', () => {
  assert.deepEqual(deriveAppUpdateAvailability({
    currentVersion: '0.28.0',
    latest: { version: '0.28.1' },
    dismissedVersion: '0.28.1',
    phase: 'idle'
  }), {
    hasUpdate: true,
    dismissed: true,
    downloaded: false,
    showUpdateNotice: false
  });
});

test('deriveAppUpdateAvailability always surfaces a downloaded matching update', () => {
  assert.deepEqual(deriveAppUpdateAvailability({
    currentVersion: '0.28.0',
    latest: { version: '0.28.1' },
    dismissedVersion: '0.28.1',
    phase: 'downloaded',
    downloadedVersion: '0.28.1'
  }), {
    hasUpdate: true,
    dismissed: true,
    downloaded: true,
    showUpdateNotice: true
  });
});

test('extractReleaseNotes reads marked localized summaries as plain text', () => {
  const body = `
## What's changed
<!-- app-update-notes:en:start -->
### Added
- **Projects view:** Track usage by \`workspace\` with [setup notes](https://example.com).
### Fixed
- <strong>Updater:</strong> Keeps the action available.
<!-- app-update-notes:en:end -->

## 更新内容
<!-- app-update-notes:zh:start -->
### 新增
- **项目视图：** 按工作区追踪用量。
<!-- app-update-notes:zh:end -->

<!-- app-update-notes:zh-TW:start -->
### 新增
- **專案檢視：** 按工作區追蹤用量。
<!-- app-update-notes:zh-TW:end -->

<!-- app-update-notes:ko:start -->
### 추가
- **프로젝트 보기:** 작업 공간별 사용량을 추적합니다.
<!-- app-update-notes:ko:end -->

<!-- app-update-notes:ja:start -->
### 追加
- **プロジェクトビュー：** ワークスペース別に使用量を追跡します。
<!-- app-update-notes:ja:end -->
`;

  assert.deepEqual(extractReleaseNotes(body), {
    en: [
      { title: 'Added', items: ['Projects view: Track usage by workspace with setup notes.'] },
      { title: 'Fixed', items: ['Updater: Keeps the action available.'] }
    ],
    zh: [
      { title: '新增', items: ['项目视图：按工作区追踪用量。'] }
    ],
    'zh-TW': [
      { title: '新增', items: ['專案檢視：按工作區追蹤用量。'] }
    ],
    ko: [
      { title: '추가', items: ['프로젝트 보기: 작업 공간별 사용량을 추적합니다.'] }
    ],
    ja: [
      { title: '追加', items: ['プロジェクトビュー：ワークスペース別に使用量を追跡します。'] }
    ]
  });
});

test('extractReleaseNotes hides trailing PR references from App summaries', () => {
  const body = `
<!-- app-update-notes:en:start -->
### Added
- Projects view tracks workspace usage. (#122, #138, #144)
- Issue #150 remains visible when it is part of the sentence.
<!-- app-update-notes:en:end -->
<!-- app-update-notes:zh:start -->
### 新增
- 项目视图可按工作区追踪用量。（#122、#138、#144）
- 问题 #150 是句子内容的一部分，应该保留。
<!-- app-update-notes:zh:end -->
<!-- app-update-notes:zh-TW:start -->
### 新增
- 專案檢視可按工作區追蹤用量。（#122、#138、#144）
- 問題 #150 是句子內容的一部分，應該保留。
<!-- app-update-notes:zh-TW:end -->
<!-- app-update-notes:ko:start -->
### 추가
- 프로젝트 보기에서 작업 공간별 사용량을 추적합니다. (#122, #138, #144)
- 문장 안의 Issue #150은 그대로 보존해야 합니다.
<!-- app-update-notes:ko:end -->
<!-- app-update-notes:ja:start -->
### 追加
- プロジェクトビューでワークスペース別に使用量を追跡します。（#122、#138、#144）
- 文中の Issue #150 はそのまま残す必要があります。
<!-- app-update-notes:ja:end -->
`;

  assert.deepEqual(extractReleaseNotes(body), {
    en: [{
      title: 'Added',
      items: [
        'Projects view tracks workspace usage.',
        'Issue #150 remains visible when it is part of the sentence.'
      ]
    }],
    zh: [{
      title: '新增',
      items: [
        '项目视图可按工作区追踪用量。',
        '问题 #150 是句子内容的一部分，应该保留。'
      ]
    }],
    'zh-TW': [{
      title: '新增',
      items: [
        '專案檢視可按工作區追蹤用量。',
        '問題 #150 是句子內容的一部分，應該保留。'
      ]
    }],
    ko: [{
      title: '추가',
      items: [
        '프로젝트 보기에서 작업 공간별 사용량을 추적합니다.',
        '문장 안의 Issue #150은 그대로 보존해야 합니다.'
      ]
    }],
    ja: [{
      title: '追加',
      items: [
        'プロジェクトビューでワークスペース別に使用量を追跡します。',
        '文中の Issue #150 はそのまま残す必要があります。'
      ]
    }]
  });
});

test('extractReleaseNotes ignores unmarked release sections', () => {
  const body = `
## What's changed

### Improved
- Clearer update status.

## Download
- Installer

## 更新内容

### 改进
- 更新状态更清楚。

## 下载
- 安装包
`;

  assert.deepEqual(extractReleaseNotes(body), {});
});

test('extractReleaseNotes bounds groups, items, and item length', () => {
  const added = Array.from({ length: 5 }, (_, index) => (
    `- Added ${index + 1}${index === 0 ? ` ${'😀'.repeat(700)}` : ''}`
  )).join('\n');
  const notes = extractReleaseNotes(`
<!-- app-update-notes:en:start -->
### Added
${added}
### Changed
- Changed 1
- Changed 2
- Changed 3
### Improved
- Improved 1
- Improved 2
- Improved 3
### Fixed
${Array.from({ length: 30 }, (_, index) => `- Fixed ${index + 1}`).join('\n')}
### Extra
- Extra
<!-- app-update-notes:en:end -->
`);

  assert.deepEqual(notes.en.map((group) => group.title), ['Added', 'Changed', 'Improved', 'Fixed']);
  assert.deepEqual(notes.en.map((group) => group.items.length), [5, 3, 3, 29]);
  assert.equal(notes.en.reduce((total, group) => total + group.items.length, 0), 40);
  assert.equal(Array.from(notes.en[0].items[0]).length, 600);
  assert.match(notes.en[0].items[0], /…$/);
});

test('extractUpdaterReleaseNotes reads the locale sections present in GitHub Atom HTML', () => {
  const html = `
<h1>English</h1><h2>What's changed</h2><h3>Security</h3><ul><li>Uses the public provider. (<a href="https://example.com">#183</a>)</li></ul><h2>Download</h2><ul><li>Installer</li></ul>
<h1>中文</h1><h2>更新内容</h2><h3>修复</h3><ul><li>使用公开 provider。（<a href="https://example.com">#183</a>）</li></ul><h2>下载</h2><ul><li>安装包</li></ul>
`;

  assert.deepEqual(extractUpdaterReleaseNotes(html, '0.40.0'), {
    en: [{ title: 'Security', items: ['Uses the public provider.'] }],
    zh: [{ title: '修复', items: ['使用公开 provider。'] }]
  });
});

test('extractUpdaterReleaseNotes cannot emit nested HTML or comment markup', () => {
  const notes = extractUpdaterReleaseNotes([
    '<h1>English</h1>',
    '<h2>Changes</h2>',
    '<h3>Fixed</h3>',
    '<ul><li>Safe <scr<script>ipt>alert(1)</script> text <!-- <script>hidden()</script> --></li></ul>',
    '<h2>Download</h2>'
  ].join(''), '0.40.0');

  assert.equal(notes.en[0].title, 'Fixed');
  assert.doesNotMatch(notes.en[0].items[0], /</);
  assert.doesNotMatch(notes.en[0].items[0], /hidden/);
});

test('extractUpdaterReleaseNotes preserves literal and encoded greater-than signs', () => {
  const notes = extractUpdaterReleaseNotes([
    '<h1>English</h1>',
    '<h2>Changes</h2>',
    '<h3>Fixed</h3>',
    '<ul><li>Cost comparison 5 &gt; 2 remains stable -> ready.</li></ul>',
    '<h2>Download</h2>'
  ].join(''), '0.40.0');

  assert.equal(notes.en[0].items[0], 'Cost comparison 5 > 2 remains stable -> ready.');
});

test('extractUpdaterReleaseNotes recognizes closing tags with ASCII whitespace', () => {
  const notes = extractUpdaterReleaseNotes([
    '<h1>English</h1>',
    '<h2>Changes</h2>',
    '<h3>Fixed</h3>',
    '<ul>',
    '<li>Adjacent<strong>space</strong > remains.</li>',
    '<li>Adjacent<strong>tab</strong\t> remains.</li>',
    '<li>Adjacent<strong>newline</strong\n> remains.</li>',
    '</ul>',
    '<h2>Download</h2>'
  ].join(''), '0.40.0');

  assert.deepEqual(notes.en[0].items, [
    'Adjacentspace remains.',
    'Adjacenttab remains.',
    'Adjacentnewline remains.'
  ]);
});

test('release-note text preserves literal, encoded, unclosed, and inline-code less-than signs', () => {
  const notes = extractReleaseNotes(`
<!-- app-update-notes:en:start -->
### Fixed
- Cost comparison 5 < 10 remains correct.
- Supports <5 requests without truncation.
- Works when value<limit and no space is used.
- Match a<b has later > here.
- 值<limit 時仍保留完整內容。
- 値<limit の場合も保持します。
- 값이 value<limit인 경우도 유지합니다.
- 值<a has later > 的比較內容仍保留。
- Generic <limit> placeholder remains.
- Adjacent<strong>markup</strong> is still stripped.
- Encoded &lt; text remains visible.
- Inline \`x < y\` comparison remains visible.
<!-- app-update-notes:en:end -->
`);

  assert.deepEqual(notes.en[0].items, [
    'Cost comparison 5 < 10 remains correct.',
    'Supports <5 requests without truncation.',
    'Works when value<limit and no space is used.',
    'Match a<b has later > here.',
    '值<limit 時仍保留完整內容。',
    '値<limit の場合も保持します。',
    '값이 value<limit인 경우도 유지합니다.',
    '值<a has later > 的比較內容仍保留。',
    'Generic <limit> placeholder remains.',
    'Adjacentmarkup is still stripped.',
    'Encoded < text remains visible.',
    'Inline x < y comparison remains visible.'
  ]);
});

test('release-note text ignores false closing tags in comments and quoted markup', () => {
  const notes = extractReleaseNotes(`
<!-- app-update-notes:en:start -->
### Fixed
- Compare x <a and later > here.
- Compare x<a and later > here <!-- </a> -->
- Compare x<a and later > here <span title="</a>">label</span>.
<!-- app-update-notes:en:end -->
`);

  assert.deepEqual(notes.en[0].items, [
    'Compare x <a and later > here.',
    'Compare x<a and later > here',
    'Compare x<a and later > here label.'
  ]);
});

test('extractReleaseNotes keeps every item of a busy release', () => {
  // v0.65.0 shipped 18 items; the old bound of 12 dropped its whole Fixed group.
  const notes = extractReleaseNotes(`
<!-- app-update-notes:en:start -->
### Added
${Array.from({ length: 7 }, (_, index) => `- Added ${index + 1}`).join('\n')}
### Improved
${Array.from({ length: 5 }, (_, index) => `- Improved ${index + 1}`).join('\n')}
### Fixed
${Array.from({ length: 6 }, (_, index) => `- Fixed ${index + 1}`).join('\n')}
<!-- app-update-notes:en:end -->
`);
  assert.deepEqual(notes.en.map((group) => [group.title, group.items.length]), [['Added', 7], ['Improved', 5], ['Fixed', 6]]);
});

test('extractUpdaterReleaseNotes reads locales collapsed under h2 headings in the Atom feed', () => {
  // The release body keeps Traditional Chinese, Korean and Japanese in <details>
  // blocks under an h2 of the locale name. The feed carries them; only h1 used to count.
  const html = `
<h1>English</h1><h2>What's changed</h2><h3>Fixed</h3><ul><li><strong>Tray:</strong> Fixes a reopen.</li></ul><h2>Download</h2><ul><li>Installer</li></ul>
<details><summary>繁體中文 · 日本語</summary>
<details><summary><strong>繁體中文</strong></summary>
<h2>繁體中文</h2><h2>更新內容</h2><h3>修復</h3><ul><li><strong>托盤：</strong> 修復重新開啟的問題。 （<a href="https://example.com">#1037</a>）</li></ul><h2>下載</h2><ul><li>安裝程式</li></ul>
</details>
<details><summary><strong>日本語</strong></summary>
<h2>日本語</h2><h2>更新内容</h2><h3>修正</h3><ul><li><strong>トレイ:</strong> 再表示を修正しました。</li></ul><h2>ダウンロード</h2>
</details>
</details>
`;

  assert.deepEqual(extractUpdaterReleaseNotes(html, '0.71.0'), {
    en: [{ title: 'Fixed', items: ['Tray: Fixes a reopen.'] }],
    'zh-TW': [{ title: '修復', items: ['托盤：修復重新開啟的問題。'] }],
    ja: [{ title: '修正', items: ['トレイ: 再表示を修正しました。'] }]
  });
});

test('extractUpdaterReleaseHistory keeps every release up to the latest, newest first', () => {
  const note = (text) => `<h1>English</h1><h2>Changes</h2><h3>Fixed</h3><ul><li>${text}</li></ul>`;
  const history = extractUpdaterReleaseHistory([
    { version: '0.69.0', note: note('Sixty-nine.') },
    { version: 'v0.71.0', note: note('Seventy-one.') },
    { version: '0.72.0-beta.1', note: note('Ahead of the offered version.') },
    { version: '0.70.0', note: 'No content' },
    { version: '0.71.0', note: note('Duplicate tag.') },
    { version: 'not-a-version', note: note('Ignored.') }
  ], '0.71.0');

  assert.deepEqual(history, {
    releaseNoteHistory: [
      {
        version: '0.71.0',
        htmlUrl: 'https://github.com/Javis603/token-monitor/releases/tag/v0.71.0',
        releaseNotes: { en: [{ title: 'Fixed', items: ['Seventy-one.'] }] }
      },
      { version: '0.70.0', htmlUrl: 'https://github.com/Javis603/token-monitor/releases/tag/v0.70.0' },
      {
        version: '0.69.0',
        htmlUrl: 'https://github.com/Javis603/token-monitor/releases/tag/v0.69.0',
        releaseNotes: { en: [{ title: 'Fixed', items: ['Sixty-nine.'] }] }
      }
    ],
    releaseHistoryTruncated: false
  });
  assert.equal(extractUpdaterReleaseHistory('<p>Single note.</p>', '0.71.0'), null);
  assert.equal(extractUpdaterReleaseHistory([], '0.71.0'), null);
});

test('extractUpdaterReleaseHistory bounds the history and says when it did', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ version: `0.${71 - index}.0`, note: '' }));
  const history = extractUpdaterReleaseHistory(entries, '0.71.0');
  assert.equal(history.releaseNoteHistory.length, MAX_RELEASE_NOTE_HISTORY);
  assert.equal(history.releaseNoteHistory[0].version, '0.71.0');
  assert.equal(history.releaseHistoryTruncated, true);
});

test('latestFromUpdaterInfo carries the full changelog alongside the latest notes', () => {
  const note = (text) => `<h1>English</h1><h2>Changes</h2><h3>Fixed</h3><ul><li>${text}</li></ul>`;
  const latest = latestFromUpdaterInfo({
    version: '0.71.0',
    releaseNotes: [
      { version: '0.71.0', note: note('Latest.') },
      { version: '0.70.0', note: note('Previous.') }
    ]
  });
  assert.deepEqual(latest.releaseNotes, { en: [{ title: 'Fixed', items: ['Latest.'] }] });
  assert.deepEqual(latest.releaseNoteHistory.map((entry) => entry.version), ['0.71.0', '0.70.0']);
  assert.equal(latest.releaseHistoryTruncated, false);
});

test('latestFromUpdaterInfo reads every locale from the Atom feed\'s full changelog', () => {
  // electron-updater's fullChangelog hands over each release body through the
  // releases Atom feed as escaped HTML. Comments are stripped there, so the
  // locales are found by heading: English and 中文 are h1 sections while
  // 繁體中文, 한국어 and 日本語 sit in nested <details> blocks under an h2 of
  // the language name. Each locale's notes are the section between its first
  // two h2 headings (the update heading and the download heading).
  const atomFeedNote = (version, { en, zh, zhTW, ko, ja }) => `
<h1>English</h1>
<h2>What's changed</h2>
<h3>Added</h3>
<ul>
<li><strong>Widget:</strong> ${en[0]} (<a class="issue-link js-issue-link" data-hovercard-type="pull_request" href="https://github.com/Javis603/token-monitor/pull/1050">#1050</a>)</li>
</ul>
<h3>Fixed</h3>
<ul>
<li><strong>Updater:</strong> ${en[1]} (<a class="issue-link js-issue-link" data-hovercard-type="pull_request" href="https://github.com/Javis603/token-monitor/pull/1047">#1047</a>)</li>
</ul>
<h2>Download</h2>
<ul>
<li><strong>macOS Apple Silicon</strong> — <a href="https://github.com/Javis603/token-monitor/releases/download/v${version}/Token-Monitor-${version}-arm64.dmg">Token-Monitor-${version}-arm64.dmg</a></li>
</ul>
<details>
<summary><strong>First launch and other notes</strong></summary>
<h3>First launch</h3>
<p><strong>macOS:</strong> open the <code>.dmg</code>, then drag the app to Applications.</p>
</details>
<h1>中文</h1>
<h2>更新内容</h2>
<h3>新增</h3>
<ul>
<li><strong>小部件：</strong> ${zh[0]} （<a class="issue-link js-issue-link" href="https://github.com/Javis603/token-monitor/pull/1050">#1050</a>）</li>
</ul>
<h3>修复</h3>
<ul>
<li><strong>更新器：</strong> ${zh[1]} （<a class="issue-link js-issue-link" href="https://github.com/Javis603/token-monitor/pull/1047">#1047</a>）</li>
</ul>
<h2>下载</h2>
<ul>
<li><strong>macOS Apple Silicon</strong> — <a href="https://github.com/Javis603/token-monitor/releases/download/v${version}/Token-Monitor-${version}-arm64.dmg">Token-Monitor-${version}-arm64.dmg</a></li>
</ul>
<details>
<summary><strong>首次启动与其他说明</strong></summary>
<h3>首次启动</h3>
<p><strong>macOS:</strong> 打开 <code>.dmg</code>，然后将应用拖入“应用程序”。</p>
</details>
<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v${version}-prev...v${version}">v${version}-prev...v${version}</a></summary>
<h2>What's Changed</h2>
<ul><li>* chore: generated pull-request list by @ghost in <a href="https://github.com/Javis603/token-monitor/pull/9999">Javis603/token-monitor#9999</a></li></ul>
<h2>New Contributors</h2>
<ul><li>* @ghost made their first contribution in <a href="https://github.com/Javis603/token-monitor/pull/9999">Javis603/token-monitor#9999</a></li></ul>
</details>
<details>
<summary>繁體中文 · 한국어 · 日本語</summary>
<details>
<summary><strong>繁體中文</strong></summary>
<h2>繁體中文</h2>
<h2>更新內容</h2>
<h3>新增</h3>
<ul><li><strong>小工具：</strong> ${zhTW[0]} （<a class="issue-link js-issue-link" href="https://github.com/Javis603/token-monitor/pull/1050">#1050</a>）</li></ul>
<h3>修復</h3>
<ul><li><strong>更新器：</strong> ${zhTW[1]} （<a class="issue-link js-issue-link" href="https://github.com/Javis603/token-monitor/pull/1047">#1047</a>）</li></ul>
<h2>下載</h2>
<ul><li>安裝程式</li></ul>
</details>
<details>
<summary><strong>한국어</strong></summary>
<h2>한국어</h2>
<h2>업데이트 내용</h2>
<h3>추가</h3>
<ul><li><strong>위젯:</strong> ${ko[0]} (<a class="issue-link js-issue-link" href="https://github.com/Javis603/token-monitor/pull/1050">#1050</a>)</li></ul>
<h3>수정</h3>
<ul><li><strong>업데이터:</strong> ${ko[1]} (<a class="issue-link js-issue-link" href="https://github.com/Javis603/token-monitor/pull/1047">#1047</a>)</li></ul>
<h2>다운로드</h2>
<ul><li>설치 프로그램</li></ul>
</details>
<details>
<summary><strong>日本語</strong></summary>
<h2>日本語</h2>
<h2>更新内容</h2>
<h3>追加</h3>
<ul><li><strong>ウィジェット:</strong> ${ja[0]} (<a class="issue-link js-issue-link" href="https://github.com/Javis603/token-monitor/pull/1050">#1050</a>)</li></ul>
<h3>修正</h3>
<ul><li><strong>アップデーター:</strong> ${ja[1]} (<a class="issue-link js-issue-link" href="https://github.com/Javis603/token-monitor/pull/1047">#1047</a>)</li></ul>
<h2>ダウンロード</h2>
<ul><li>インストーラー</li></ul>
</details>
</details>
`;

  const latest = latestFromUpdaterInfo({
    version: '0.71.0',
    releaseNotes: [
      {
        version: '0.71.0',
        note: atomFeedNote('0.71.0', {
          en: ['Adds Goose usage tracking.', 'Fixes the tray popover reopening.'],
          zh: ['新增 Goose 用量追踪。', '修复托盘弹窗重新打开的问题。'],
          zhTW: ['新增 Goose 用量追蹤。', '修復托盤彈窗重新開啟的問題。'],
          ko: ['Goose 사용량 추적을 추가합니다.', '트레이 팝오버가 다시 열리는 문제를 수정합니다.'],
          ja: ['Goose 使用量トラッキングを追加します。', 'トレイポップオーバーが再び開く問題を修正しました。']
        })
      },
      {
        version: '0.70.0',
        note: atomFeedNote('0.70.0', {
          en: ['Adds a session details view.', 'Fixes stale limits after sign-in.'],
          zh: ['新增会话详情视图。', '修复登录后额度未更新的问题。'],
          zhTW: ['新增工作階段詳細資料檢視。', '修復登入後額度未更新的問題。'],
          ko: ['세션 세부 정보 보기를 추가합니다.', '로그인 후 한도가 갱신되지 않던 문제를 수정합니다.'],
          ja: ['セッション詳細ビューを追加します。', 'サインイン後に上限が更新されない問題を修正しました。']
        })
      }
    ]
  });

  assert.deepEqual(latest.releaseNoteHistory.map((entry) => entry.version), ['0.71.0', '0.70.0']);
  assert.deepEqual(latest.releaseNoteHistory[0].releaseNotes, {
    en: [
      { title: 'Added', items: ['Widget: Adds Goose usage tracking.'] },
      { title: 'Fixed', items: ['Updater: Fixes the tray popover reopening.'] }
    ],
    zh: [
      { title: '新增', items: ['小部件：新增 Goose 用量追踪。'] },
      { title: '修复', items: ['更新器：修复托盘弹窗重新打开的问题。'] }
    ],
    'zh-TW': [
      { title: '新增', items: ['小工具：新增 Goose 用量追蹤。'] },
      { title: '修復', items: ['更新器：修復托盤彈窗重新開啟的問題。'] }
    ],
    ko: [
      { title: '추가', items: ['위젯: Goose 사용량 추적을 추가합니다.'] },
      { title: '수정', items: ['업데이터: 트레이 팝오버가 다시 열리는 문제를 수정합니다.'] }
    ],
    ja: [
      { title: '追加', items: ['ウィジェット: Goose 使用量トラッキングを追加します。'] },
      { title: '修正', items: ['アップデーター: トレイポップオーバーが再び開く問題を修正しました。'] }
    ]
  });
  assert.deepEqual(latest.releaseNoteHistory[1].releaseNotes, {
    en: [
      { title: 'Added', items: ['Widget: Adds a session details view.'] },
      { title: 'Fixed', items: ['Updater: Fixes stale limits after sign-in.'] }
    ],
    zh: [
      { title: '新增', items: ['小部件：新增会话详情视图。'] },
      { title: '修复', items: ['更新器：修复登录后额度未更新的问题。'] }
    ],
    'zh-TW': [
      { title: '新增', items: ['小工具：新增工作階段詳細資料檢視。'] },
      { title: '修復', items: ['更新器：修復登入後額度未更新的問題。'] }
    ],
    ko: [
      { title: '추가', items: ['위젯: 세션 세부 정보 보기를 추가합니다.'] },
      { title: '수정', items: ['업데이터: 로그인 후 한도가 갱신되지 않던 문제를 수정합니다.'] }
    ],
    ja: [
      { title: '追加', items: ['ウィジェット: セッション詳細ビューを追加します。'] },
      { title: '修正', items: ['アップデーター: サインイン後に上限が更新されない問題を修正しました。'] }
    ]
  });

  const generatedLeak = latest.releaseNoteHistory
    .flatMap((entry) => Object.values(entry.releaseNotes).flatMap((group) => group.items))
    .filter((item) => /generated pull-request list|first contribution/.test(item));
  assert.deepEqual(generatedLeak, [], 'GitHub\'s generated What\'s Changed and New Contributors sections must not leak into locale notes');
});

test('package build config leaves release notes out of the updater metadata', () => {
  const { build } = require('../../package.json');
  assert.equal(
    build.releaseInfo?.releaseNotes,
    undefined,
    'release notes in latest*.yml make electron-updater skip the fullChangelog Atom read'
  );
  assert.equal(
    build.releaseInfo?.releaseNotesFile,
    undefined,
    'release notes in latest*.yml make electron-updater skip the fullChangelog Atom read'
  );
});

test('latestForCurrentVersion drops remembered releases the running version already has', () => {
  const latest = {
    version: '0.71.0',
    releaseNoteHistory: [{ version: '0.71.0' }, { version: '0.70.0' }, { version: '0.69.0' }]
  };
  assert.deepEqual(latestForCurrentVersion(latest, '0.69.0').releaseNoteHistory.map((entry) => entry.version), ['0.71.0', '0.70.0']);
  assert.equal(latestForCurrentVersion(latest, '0.68.0'), latest);
  assert.equal(latestForCurrentVersion({ version: '0.71.0' }, '0.69.0').releaseNoteHistory, undefined);
  assert.equal(latestForCurrentVersion(null, '0.69.0'), null);
});

test('mergeLatestReleaseMetadata keeps a remembered history the incoming metadata lacks', () => {
  const releaseNoteHistory = [{ version: '0.71.0' }, { version: '0.70.0' }];
  assert.deepEqual(
    mergeLatestReleaseMetadata(
      { version: '0.71.0', releaseNoteHistory, releaseHistoryTruncated: true },
      { version: '0.71.0', name: 'From the release API' }
    ),
    { version: '0.71.0', name: 'From the release API', releaseNoteHistory, releaseHistoryTruncated: true }
  );
  const fresh = [{ version: '0.71.0' }];
  assert.deepEqual(
    mergeLatestReleaseMetadata(
      { version: '0.71.0', releaseNoteHistory, releaseHistoryTruncated: true },
      { version: '0.71.0', releaseNoteHistory: fresh, releaseHistoryTruncated: false }
    ).releaseNoteHistory,
    fresh
  );
});

test('background update checks run every couple of hours', () => {
  assert.equal(APP_UPDATE_BACKGROUND_COOLDOWN_MS, 2 * 60 * 60 * 1000);
  assert.equal(APP_UPDATE_STARTUP_DELAY_MS, 15 * 1000);
});

test('extractUpdaterReleaseNotes selects the matching full-changelog entry', () => {
  const matching = '<h1>English</h1><h2>Changes</h2><h3>Fixed</h3><ul><li>Matching release.</li></ul>';
  const older = '<h1>English</h1><h2>Changes</h2><h3>Fixed</h3><ul><li>Older release.</li></ul>';
  assert.deepEqual(extractUpdaterReleaseNotes([
    { version: '0.39.0', note: older },
    { version: 'v0.40.0', note: matching }
  ], '0.40.0'), {
    en: [{ title: 'Fixed', items: ['Matching release.'] }]
  });
});

test('release template exposes marked summaries for every bundled locale', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'RELEASE_TEMPLATE.md'), 'utf8');
  const notes = extractReleaseNotes(template);
  const categoryPairs = new Map([
    ['Added', '新增'],
    ['Changed', '变更'],
    ['Improved', '改进'],
    ['Fixed', '修复']
  ]);
  const traditionalCategoryPairs = new Map([
    ['Added', '新增'],
    ['Changed', '變更'],
    ['Improved', '改進'],
    ['Fixed', '修復']
  ]);
  const koreanCategoryPairs = new Map([
    ['Added', '추가'],
    ['Changed', '변경'],
    ['Improved', '개선'],
    ['Fixed', '수정']
  ]);
  const japaneseCategoryPairs = new Map([
    ['Added', '追加'],
    ['Changed', '変更'],
    ['Improved', '改善'],
    ['Fixed', '修正']
  ]);
  assert.ok(notes.en.length > 0);
  assert.deepEqual(
    notes.zh.map((group) => group.title),
    notes.en.map((group) => categoryPairs.get(group.title))
  );
  assert.deepEqual(
    notes['zh-TW'].map((group) => group.title),
    notes.en.map((group) => traditionalCategoryPairs.get(group.title))
  );
  assert.deepEqual(
    notes.ko.map((group) => group.title),
    notes.en.map((group) => koreanCategoryPairs.get(group.title))
  );
  assert.deepEqual(
    notes.ja.map((group) => group.title),
    notes.en.map((group) => japaneseCategoryPairs.get(group.title))
  );
  for (const locale of ['zh', 'zh-TW', 'ko', 'ja']) {
    assert.deepEqual(
      notes[locale].map((group) => group.items.length),
      notes.en.map((group) => group.items.length),
      `${locale} notes should keep the English item counts per category`
    );
  }
  assert.ok(notes.en.every((group) => categoryPairs.has(group.title)));
  assert.ok(notes.en.every((group) => group.items.length > 0));
  assert.ok(notes.zh.every((group) => group.items.length > 0));
  assert.ok(notes['zh-TW'].every((group) => group.items.length > 0));
  assert.ok(notes.ko.every((group) => group.items.length > 0));
  assert.ok(notes.ja.every((group) => group.items.length > 0));
  for (const locale of ['en', 'zh', 'zh-TW', 'ko', 'ja']) {
    assert.ok(
      notes[locale].every((group) => group.items.every((item) => !trailingPullRequestReference.test(item))),
      `${locale} notes should not end with a PR reference`
    );
  }
  assert.match(
    template,
    /<details>\s*<summary><strong>繁體中文<\/strong><\/summary>\s*## 繁體中文[\s\S]*<!-- app-update-notes:zh-TW:start -->[\s\S]*<!-- app-update-notes:zh-TW:end -->[\s\S]*<\/details>/
  );
  assert.match(
    template,
    /<details>\s*<summary><strong>한국어<\/strong><\/summary>\s*## 한국어[\s\S]*<!-- app-update-notes:ko:start -->[\s\S]*<!-- app-update-notes:ko:end -->[\s\S]*<\/details>/
  );
  assert.match(
    template,
    /<details>\s*<summary><strong>日本語<\/strong><\/summary>\s*## 日本語[\s\S]*<!-- app-update-notes:ja:start -->[\s\S]*<!-- app-update-notes:ja:end -->[\s\S]*<\/details>/
  );
  assert.match(
    template,
    /<details>\s*<summary>繁體中文 · 한국어 · 日本語<\/summary>[\s\S]*<details>\s*<summary><strong>繁體中文<\/strong><\/summary>[\s\S]*<details>\s*<summary><strong>한국어<\/strong><\/summary>[\s\S]*<details>\s*<summary><strong>日本語<\/strong><\/summary>/
  );
  assert.doesNotMatch(template, /其他語言|user-content-release-notes-/);
  assert.doesNotMatch(
    template,
    /^- \*\*[^*\n]+\*\*\S/gm,
    'bold release-note labels should be separated from their body text'
  );
  assert.match(template, /## 繁體中文[\s\S]*## 下載/);
  assert.match(template, /## 한국어[\s\S]*## 다운로드/);
  assert.match(template, /## 日本語[\s\S]*## ダウンロード/);
  assert.match(template, /\(#\d+(?:, #\d+)*\)/);
  assert.match(template, /（#\d+(?:、#\d+)*）/);
});

test('mergeLatestReleaseMetadata preserves notes when native updater metadata omits them', () => {
  const releaseNotes = { en: [{ title: 'Fixed', items: ['An updater fix.'] }] };
  assert.deepEqual(
    mergeLatestReleaseMetadata(
      { version: '0.28.0', name: 'GitHub release', releaseNotes },
      { version: '0.28.0', name: 'Native updater' }
    ),
    { version: '0.28.0', name: 'Native updater', releaseNotes }
  );
  assert.deepEqual(
    mergeLatestReleaseMetadata(
      { version: '0.28.0', releaseNotes },
      { version: '0.29.0', name: 'Next release' }
    ),
    { version: '0.29.0', name: 'Next release' }
  );
});

test('parseLatestReleasePayload returns normalized object for valid payload', () => {
  const result = parseLatestReleasePayload({
    tag_name: 'v0.1.3',
    name: 'Token Monitor 0.1.3',
    html_url: 'https://github.com/Javis603/token-monitor/releases/tag/v0.1.3',
    published_at: '2026-05-26T12:00:00Z',
    body: `
## What's changed
<!-- app-update-notes:en:start -->
### Added
- Release summaries in the app.
<!-- app-update-notes:en:end -->
## Download
`
  });
  assert.deepEqual(result, {
    version: '0.1.3',
    tag: 'v0.1.3',
    name: 'Token Monitor 0.1.3',
    htmlUrl: 'https://github.com/Javis603/token-monitor/releases/tag/v0.1.3',
    publishedAt: '2026-05-26T12:00:00Z',
    releaseNotes: {
      en: [{ title: 'Added', items: ['Release summaries in the app.'] }]
    }
  });
});

test('parseLatestReleasePayload falls back to tag when name is missing', () => {
  const result = parseLatestReleasePayload({
    tag_name: 'v0.1.3',
    html_url: 'https://github.com/Javis603/token-monitor/releases/tag/v0.1.3'
  });
  assert.equal(result.name, 'v0.1.3');
  assert.equal(result.publishedAt, '');
});

test('parseLatestReleasePayload returns null for invalid or missing tag', () => {
  assert.equal(parseLatestReleasePayload({}), null);
  assert.equal(parseLatestReleasePayload({ tag_name: 'release-foo' }), null);
  assert.equal(parseLatestReleasePayload({ tag_name: '' }), null);
  assert.equal(parseLatestReleasePayload(null), null);
  assert.equal(parseLatestReleasePayload('not an object'), null);
});

test('parseLatestReleasePayload builds a trusted release URL from the validated tag', () => {
  assert.equal(parseLatestReleasePayload({
    tag_name: 'v0.1.3',
    html_url: 'http://example.com'
  }).htmlUrl, 'https://github.com/Javis603/token-monitor/releases/tag/v0.1.3');
  assert.equal(parseLatestReleasePayload({
    tag_name: 'v0.1.3'
  }).htmlUrl, 'https://github.com/Javis603/token-monitor/releases/tag/v0.1.3');
});

test('latestFromUpdaterInfo normalizes provider metadata and release notes', () => {
  assert.deepEqual(latestFromUpdaterInfo({
    version: '0.40.0',
    tag: 'v0.40.0',
    releaseName: 'Token Monitor 0.40.0',
    releaseDate: '2026-08-03T08:00:00Z',
    releaseNotes: '<h1>English</h1><h2>Changes</h2><h3>Fixed</h3><ul><li>Updater fix. (<a href="https://example.com">#183</a>)</li></ul>'
  }), {
    version: '0.40.0',
    tag: 'v0.40.0',
    name: 'Token Monitor 0.40.0',
    htmlUrl: 'https://github.com/Javis603/token-monitor/releases/tag/v0.40.0',
    publishedAt: '2026-08-03T08:00:00Z',
    releaseNotes: { en: [{ title: 'Fixed', items: ['Updater fix.'] }] }
  });
});

test('providerUpdateCheckAvailability rejects newer versions excluded by the provider', () => {
  const result = providerUpdateCheckAvailability({
    isUpdateAvailable: false,
    updateInfo: {
      version: '0.40.0',
      releaseName: 'Rollout release'
    }
  }, '0.39.0');

  assert.deepEqual(result, {
    valid: true,
    newer: false,
    latest: null,
    clearLatest: true
  });
});

test('providerUpdateCheckAvailability accepts eligible updates and current metadata', () => {
  const eligible = providerUpdateCheckAvailability({
    isUpdateAvailable: true,
    updateInfo: { version: '0.40.0' }
  }, '0.39.0');
  const current = providerUpdateCheckAvailability({
    isUpdateAvailable: false,
    updateInfo: { version: '0.39.0' }
  }, '0.39.0');

  assert.equal(eligible.valid, true);
  assert.equal(eligible.newer, true);
  assert.equal(eligible.latest.version, '0.40.0');
  assert.equal(eligible.clearLatest, false);
  assert.equal(current.valid, true);
  assert.equal(current.newer, false);
  assert.equal(current.latest.version, '0.39.0');
  assert.equal(current.clearLatest, false);
});

test('classifyAppUpdateError separates actionable failures including nested causes', () => {
  assert.equal(classifyAppUpdateError(Object.assign(new Error('rate limit exceeded'), { status: 429 })).kind, 'rateLimited');
  assert.equal(classifyAppUpdateError(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind, 'timeout');
  assert.equal(classifyAppUpdateError(new Error('net::ERR_TIMED_OUT')).kind, 'timeout');
  assert.equal(classifyAppUpdateError(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })).kind, 'network');
  assert.equal(classifyAppUpdateError(new Error('net::ERR_PROXY_CONNECTION_FAILED')).kind, 'network');
  assert.equal(classifyAppUpdateError(Object.assign(new Error('GitHub responded 503'), { status: 503 })).kind, 'githubUnavailable');
  assert.equal(classifyAppUpdateError(new SyntaxError('Unexpected token < in JSON')).kind, 'metadata');
  assert.equal(classifyAppUpdateError(Object.assign(new Error('Cannot find latest.yml'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })).kind, 'metadata');
  assert.equal(classifyAppUpdateError(Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })
  })).kind, 'network');
  assert.equal(classifyAppUpdateError(new Error('unexpected')).kind, 'unknown');
});

test('background update failures preserve a visible manual error until a success', () => {
  const manualFailure = {
    ok: false,
    error: 'Unable to connect',
    errorKind: 'network'
  };
  const backgroundFailure = {
    ok: false,
    error: 'Timed out',
    errorKind: 'timeout'
  };

  let visibleError = resolveAppUpdateCheckError(null, manualFailure, { force: true });
  assert.deepEqual(visibleError, { kind: 'network', message: 'Unable to connect' });
  visibleError = resolveAppUpdateCheckError(visibleError, backgroundFailure, { force: false });
  assert.deepEqual(visibleError, { kind: 'network', message: 'Unable to connect' });
  visibleError = resolveAppUpdateCheckError(visibleError, { ok: true }, { force: false });
  assert.equal(visibleError, null);
});
