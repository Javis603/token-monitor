'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  releaseNoteGroupsForLocale,
  releaseNoteHistoryForLocale,
  splitReleaseNoteLead
} = require('../../src/electron/renderer/appUpdatePresentation');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function read(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

test('App Updates includes an inline release-note disclosure without a duplicate full-release action', () => {
  const html = read('index.html');
  assert.match(html, /<div id="appUpdateNotes" class="app-update-notes hidden">/);
  assert.match(html, /id="appUpdateNotesToggle"[^>]*aria-expanded="false"[^>]*aria-controls="appUpdateNotesDetails"/);
  assert.match(html, /id="appUpdateNotesDetails" class="app-update-notes-details hidden" inert/);
  assert.match(html, /id="appUpdateNotesTitle"/);
  assert.doesNotMatch(html, /id="appUpdateReleaseNotesButton"/);
});

test('footer update control is one icon button with a hover release-note card', () => {
  const html = read('index.html');
  assert.match(html, /id="appUpdatePillAction"[^>]*class="update-pill-action"[^>]*data-status="available"/);
  assert.match(html, /id="appUpdatePillProgress"[^>]*pathLength="100"/);
  assert.match(html, /class="update-pill-icon" aria-hidden="true"/);
  assert.doesNotMatch(html, /appUpdatePillLabel|appUpdatePillRestart|appUpdatePillDismiss/, 'no version text or inline restart/dismiss on the button');
  assert.doesNotMatch(html, /id="appUpdatePillAction"[^>]*aria-haspopup/);
  // Manual, so pressing the button is the update action rather than a light dismiss.
  assert.match(html, /id="appUpdatePopover"[^>]*popover="manual"[^>]*role="dialog"/);
  assert.match(html, /id="appUpdatePopoverSubtitle"/);
  // The button under the card is the action; the card only explains.
  assert.doesNotMatch(html, /appUpdatePopoverAction|app-update-popover-actions/);
  assert.match(html, /class="app-update-popover-header">[\s\S]*id="appUpdatePopoverDismiss"[^>]*data-i18n="settings\.appUpdate\.dismiss"/);
});

test('footer update pill moves left of the disclosed action while the primary stays at the edge', () => {
  const html = read('index.html');
  const css = read('styles.css');

  const footer = html.match(/<footer class="footer">[\s\S]*?<\/footer>/)?.[0] || '';
  assert.ok(footer, 'footer markup exists');
  assert.ok(
    footer.indexOf('id="appUpdatePill"') < footer.indexOf('id="footerActionSlot"'),
    'the update stays left of the utility slot, preserving the primary action at the right edge',
  );
  assert.match(footer, /class="footer-update-actions">[\s\S]*id="appUpdatePill"[\s\S]*id="utilityActions"/, 'one hover boundary spans the update, disclosure and primary action');

  // Disclosure moves the update by one button plus the 6px utility gap. It
  // remains visible and interactive rather than yielding its position to Refresh.
  assert.doesNotMatch(css, /\.footer:has\(\.utility-actions:hover\) \.update-pill/);
  assert.doesNotMatch(css, /\.footer:has\(\.utility-actions :focus-visible\) \.update-pill/);
  assert.doesNotMatch(css, /\.refresh-button:is\(\.is-refreshing, \.is-refreshed, \.is-refresh-error\)\) \.update-pill/);
  assert.match(css, /\.view-switcher \{[\s\S]*?margin-right: auto;/, 'the disclosure relies on the switcher auto margin staying free');
  assert.match(css, /\.utility-actions \.refresh-button \{[\s\S]*?right: calc\(100% \+ 6px\);/, 'Refresh still discloses to the left of Settings');
  assert.match(css, /\.footer-update-actions \{[\s\S]*?--footer-disclosure-width: 0px;/);
  assert.match(css, /\.footer-update-actions\.is-disclosed,[\s\S]*?--footer-disclosure-width: 40px;/);
  assert.match(css, /\.footer-update-actions:has\(\.utility-actions:not\(\.is-swapped\) \.refresh-button:is\(\.is-refreshing, \.is-refreshed, \.is-refresh-error\)\)/, 'refresh feedback reserves the same space without pointer hover');
  assert.match(css, /\.update-pill \{[\s\S]*?margin-right: var\(--footer-disclosure-width, 0px\);/);
  assert.match(css, /clip-path 0s var\(--footer-secondary-reveal-delay, 0ms\)/, 'secondary stays clipped from pointer hit-testing until the update clears its space');
  assert.match(css, /--footer-secondary-reveal-delay: 180ms;/, 'the update finishes its 180ms move before the secondary accepts clicks');
  assert.match(css, /\.footer:has\(\.footer-update-actions \.update-pill:not\(\.hidden\)\) \.tool-detail-footer \{\s*min-width: 0;\s*flex-shrink: 1;/, 'detail options yield space at the minimum window width');

  assert.doesNotMatch(css, /\.shell\.settings-open \.footer \.update-pill/, 'opening Settings keeps the footer update visible and interactive alongside Refresh');
});

test('release notes render as text nodes and auto-open once for a new version', () => {
  const app = read('app.js');
  const renderer = app.slice(
    app.indexOf('function buildAppUpdateNoteItemNode'),
    app.indexOf('function renderSettingsAppUpdateRow')
  );

  assert.match(renderer, /title\.textContent = String\(group\?\.title \|\| ''\)/);
  assert.match(renderer, /strong\.textContent = lead/);
  assert.match(renderer, /document\.createTextNode\(/);
  assert.match(renderer, /row\.textContent = body/);
  assert.match(renderer, /appUpdateNotesBody\.replaceChildren\(\.\.\.nodes\)/);
  assert.doesNotMatch(renderer, /innerHTML/);
  assert.match(renderer, /s\.hasUpdate && state\.appUpdateNotesPresentedVersion !== version/);
  assert.match(renderer, /appUpdateNotesDetails\.getBoundingClientRect\(\)/);
  assert.match(renderer, /setSettingsAccordionExpanded\(els\.appUpdateNotes, els\.appUpdateNotesToggle, els\.appUpdateNotesDetails, true\)/);
});

test('release notes show every item of every release in the history', () => {
  const app = read('app.js');
  const renderer = app.slice(
    app.indexOf('function buildAppUpdateReleaseNodes'),
    app.indexOf('function appUpdateNotesContentKey')
  );
  assert.match(renderer, /buildAppUpdateNoteGroupNodes\(entry\.groups\)/);
  assert.doesNotMatch(renderer, /slice\(|limit/i, 'written summaries are not cut short');
  assert.match(renderer, /releaseHistoryTruncated && s\.releasesUrl/);
  assert.match(renderer, /settings\.appUpdate\.olderReleases/);
});

test('a single-release card links to the full release', () => {
  const app = read('app.js');
  const renderer = app.slice(
    app.indexOf('function buildAppUpdateReleaseHistoryNodes'),
    app.indexOf('function appUpdateNotesContentKey')
  );
  // The link is built from the unfiltered history, so it also appears when the
  // single release has no groups for the current locale — then it is the body's
  // only node and keeps the body visible.
  assert.match(renderer, /const history = releaseNoteHistoryForCurrentLocale\(s\?\.latest\)/);
  assert.match(renderer, /history\.length === 1 && history\[0\]\?\.htmlUrl/);
  assert.match(renderer, /nodes\.push\(buildAppUpdateReleaseLink\('app-update-release-full', t\('settings\.appUpdate\.viewFullRelease'\), history\[0\]\.htmlUrl\)\)/);
  // After the note sections, before the unchanged "older releases" link — and a
  // lone link still counts, so the body is not hidden.
  assert.match(renderer, /buildAppUpdateReleaseNodes\(entries\)[\s\S]*app-update-release-full[\s\S]*app-update-release-older/);
  const popover = app.slice(app.indexOf('function renderAppUpdatePopover'), app.indexOf('function positionAppUpdatePopover'));
  assert.match(popover, /appUpdatePopoverBody\.classList\.toggle\('hidden', nodes\.length === 0\)/);
});

test('multi-release cards link each release by its version heading instead', () => {
  const app = read('app.js');
  const history = app.slice(
    app.indexOf('function buildAppUpdateReleaseHistoryNodes'),
    app.indexOf('function appUpdateNotesContentKey')
  );
  assert.match(history, /history\.length === 1 && history\[0\]\?\.htmlUrl[\s\S]*app-update-release-full/);
  const versions = app.slice(
    app.indexOf('function buildAppUpdateReleaseNodes'),
    app.indexOf('function buildAppUpdateReleaseHistoryNodes')
  );
  assert.match(versions, /entries\.length > 1[\s\S]*buildAppUpdateReleaseLink\('app-update-release-version', label, entry\.htmlUrl\)/);
});

test('download progress pushes do not rebuild the notes being read', () => {
  const app = read('app.js');
  const popover = app.slice(app.indexOf('function renderAppUpdatePopover'), app.indexOf('function positionAppUpdatePopover'));
  assert.match(popover, /appUpdatePopoverBody\.dataset\.contentKey !== contentKey/);
  const key = app.slice(app.indexOf('function appUpdateNotesContentKey'), app.indexOf('function renderAppUpdatePopover'));
  assert.doesNotMatch(key, /installProgress|installPhase/);
});

test('footer update button runs the update action and opens the card on hover or keyboard focus', () => {
  const app = read('app.js');
  const handlers = app.slice(
    app.indexOf("els.appUpdatePillAction.addEventListener('click'"),
    app.indexOf("els.appUpdateCheckButton.addEventListener")
  );
  const click = handlers.slice(0, handlers.indexOf('\n});') + 4);
  assert.match(click, /await runAppUpdateAction\(\)/);
  assert.match(click, /aria-disabled'\) === 'true'[\s\S]*showAppUpdatePopover\(\)/);
  assert.match(handlers, /addEventListener\('pointerenter'[\s\S]*scheduleAppUpdatePopoverOpen\(\)/);
  assert.match(handlers, /addEventListener\('pointerleave'[\s\S]*scheduleAppUpdatePopoverClose\(\)/);
  assert.match(handlers, /matches\(':focus-visible'\)\) showAppUpdatePopover\(\)/);
  assert.match(handlers, /event\.key !== 'Escape'[\s\S]*hideAppUpdatePopover\(\)/);
  assert.match(handlers, /appUpdatePopoverDismiss\.addEventListener[\s\S]*dismissAppUpdate\(version\)/);
});

test('Tab into the card prefers dismiss, then the focusable notes scroller', () => {
  const html = read('index.html');
  assert.match(html, /id="appUpdatePopoverBody"[^>]*tabindex="0"/);
  const app = read('app.js');
  const handlerStart = app.indexOf("els.appUpdatePillAction.addEventListener('keydown'");
  const handler = app.slice(
    handlerStart,
    // The same for-target loop shape also binds pointerenter earlier, so the end
    // marker is searched after the handler itself.
    app.indexOf("for (const target of [els.appUpdatePillAction, els.appUpdatePopover])", handlerStart)
  );
  assert.match(handler, /event\.key !== 'Tab' \|\| event\.shiftKey \|\| !els\.appUpdatePopover\.matches\(':popover-open'\)/);
  // Dismiss hides while an install runs; the notes body is the fallback target
  // and stays scrollable from the keyboard.
  assert.match(handler, /appUpdatePopoverDismiss\.classList\.contains\('hidden'\) \|\| els\.appUpdatePopoverDismiss\.disabled/);
  assert.match(handler, /appUpdatePopoverBody\.classList\.contains\('hidden'\) \? null : els\.appUpdatePopoverBody/);
  assert.doesNotMatch(handler, /querySelector\('button:not\(:disabled\):not\(\.hidden\)'\)/);
});

test('a card closed by the pointer leaving does not pull focus to the button', () => {
  const app = read('app.js');
  const hide = app.slice(app.indexOf('function hideAppUpdatePopover'), app.indexOf('function scheduleAppUpdatePopoverOpen'));
  assert.match(hide, /const focusWasInside = els\.appUpdatePopover\.contains\(document\.activeElement\)/);
  assert.match(hide, /if \(focusWasInside[\s\S]*appUpdatePillAction\.focus\(\)/);
});

test('footer button hides for dismissed notices and the card offers dismissal only before install', () => {
  const app = read('app.js');
  const pill = app.slice(app.indexOf('function renderAppUpdatePill'), app.indexOf('function releaseNoteHistoryForCurrentLocale'));
  assert.match(pill, /!s\.showUpdateNotice/);
  assert.match(pill, /action\.dataset\.status = status/);
  assert.match(pill, /strokeDashoffset = String\(100 - percent\)/);
  assert.doesNotMatch(pill, /`v\$\{version\}`/, 'the button carries no version text');
  const popover = app.slice(app.indexOf('function renderAppUpdatePopover'), app.indexOf('function positionAppUpdatePopover'));
  assert.match(popover, /appUpdatePopoverDismiss\.classList\.toggle\('hidden', mode === 'install' \|\| Boolean\(s\.installBusy\)\)/);
});

test('footer button states use the vendored Lucide icons', () => {
  const css = read('styles.css');
  for (const icon of ['download', 'rotate-cw', 'check', 'external-link']) {
    assert.ok(fs.existsSync(path.join(rendererDir, 'icons', 'actions', `${icon}.svg`)), icon);
    assert.match(css, new RegExp(`url\\("icons/actions/${icon}\\.svg"\\)`), icon);
  }
  assert.match(read('icons/THIRD_PARTY_NOTICES.md'), /actions\/download\.svg: download[\s\S]*actions\/rotate-cw\.svg: rotate-cw/);
  assert.match(css, /\.update-pill-action\[data-status="downloading"\] \.update-pill-progress \{ display: block; \}/);
  assert.match(css, /\.update-pill-action:is\(\[data-status="downloaded"\], \[data-status="installing"\]\) \.update-pill-icon/);
});

test('footer button exposes dialog semantics whenever it is shown', () => {
  const app = read('app.js');
  const renderer = app.slice(
    app.indexOf('function setAppUpdatePillDisclosure'),
    app.indexOf('function releaseNoteHistoryForCurrentLocale')
  );
  assert.match(renderer, /setAttribute\('aria-haspopup', 'dialog'\)/);
  assert.match(renderer, /setAttribute\('aria-controls', 'appUpdatePopover'\)/);
  assert.match(renderer, /removeAttribute\('aria-haspopup'\)/);
  assert.match(renderer, /setAppUpdatePillDisclosure\(true\)/);
  assert.match(renderer, /setAppUpdatePillDisclosure\(false\)/);
});

test('renderer delegates release-note history and locale selection to the shared presentation helper', () => {
  const app = read('app.js');
  const renderer = app.slice(
    app.indexOf('function releaseNoteHistoryForCurrentLocale'),
    app.indexOf('function buildAppUpdateNoteItemNode')
  );
  assert.match(renderer, /return appUpdatePresentationApi\.releaseNoteHistoryForLocale\(latest, currentLocale\(\)\)/);
});

test('release-note history falls back to the latest release and selects each locale', () => {
  const zh = [{ title: '修復', items: ['zh'] }];
  const en = [{ title: 'Fixed', items: ['en'] }];
  assert.deepEqual(releaseNoteHistoryForLocale({
    version: '0.71.0',
    htmlUrl: 'https://example.test/v0.71.0',
    releaseNotes: { en },
    releaseNoteHistory: [
      { version: '0.71.0', htmlUrl: 'https://example.test/v0.71.0', releaseNotes: { 'zh-TW': zh, en } },
      { version: '0.70.0', releaseNotes: { en } },
      { version: '' }
    ]
  }, 'zh-TW'), [
    { version: '0.71.0', htmlUrl: 'https://example.test/v0.71.0', groups: zh },
    { version: '0.70.0', htmlUrl: '', groups: en }
  ]);
  assert.deepEqual(releaseNoteHistoryForLocale({ version: '0.71.0', htmlUrl: 'u', releaseNotes: { en } }, 'en'), [
    { version: '0.71.0', htmlUrl: 'u', groups: en }
  ]);
  assert.deepEqual(releaseNoteHistoryForLocale(null, 'en'), []);
});

test('release-note items recover the bold topic their Markdown led with', () => {
  assert.deepEqual(splitReleaseNoteLead('Goose 用量：支援 macOS 與 Linux。'), { lead: 'Goose 用量：', body: '支援 macOS 與 Linux。' });
  assert.deepEqual(splitReleaseNoteLead('Goose usage: Supports local tracking.'), { lead: 'Goose usage:', body: 'Supports local tracking.' });
  assert.deepEqual(splitReleaseNoteLead('トレイ: 再表示を修正しました。'), { lead: 'トレイ:', body: '再表示を修正しました。' });
  assert.deepEqual(splitReleaseNoteLead('Fixes the tray. Then: more'), { lead: '', body: 'Fixes the tray. Then: more' });
  assert.deepEqual(splitReleaseNoteLead('No topic here'), { lead: '', body: 'No topic here' });
});

test('release-note locale selection follows the complete fallback matrix', () => {
  const groups = {
    en: [{ title: 'English', items: ['en'] }],
    zh: [{ title: '简体中文', items: ['zh'] }],
    traditional: [{ title: '繁體中文', items: ['zh-TW'] }],
    ko: [{ title: '한국어', items: ['ko'] }],
    ja: [{ title: '日本語', items: ['ja'] }],
    pt: [{ title: 'Português (Brasil)', items: ['pt-BR'] }]
  };
  const cases = [
    ['zh-TW prefers Traditional Chinese', 'zh-TW', { 'zh-TW': groups.traditional, zh: groups.zh, en: groups.en }, groups.traditional],
    ['zh-TW falls back to Simplified Chinese', 'zh-TW', { 'zh-TW': [], zh: groups.zh, en: groups.en }, groups.zh],
    ['zh-TW skips invalid and empty sections before English', 'zh-TW', { 'zh-TW': 'invalid', zh: null, en: groups.en }, groups.en],
    ['zh-CN prefers Simplified Chinese', 'zh-CN', { zh: groups.zh, en: groups.en }, groups.zh],
    ['zh-CN falls back to English', 'zh-CN', { zh: [], en: groups.en }, groups.en],
    ['Korean prefers Korean', 'ko', { ko: groups.ko, en: groups.en, zh: groups.zh }, groups.ko],
    ['Korean falls back through English', 'ko', { ko: [], en: groups.en, zh: groups.zh }, groups.en],
    ['Korean falls back to Simplified Chinese', 'ko', { ko: [], en: [], zh: groups.zh }, groups.zh],
    ['Japanese prefers Japanese', 'ja', { ja: groups.ja, en: groups.en, zh: groups.zh }, groups.ja],
    ['Japanese falls back through English', 'ja', { ja: {}, en: groups.en, zh: groups.zh }, groups.en],
    ['Japanese falls back to Simplified Chinese', 'ja', { ja: [], en: [], zh: groups.zh }, groups.zh],
    ['Portuguese uses English even when Portuguese notes are supplied', 'pt-BR', { 'pt-BR': groups.pt, en: groups.en, zh: groups.zh }, groups.en],
    ['Portuguese uses English release notes', 'pt-BR', { en: groups.en, zh: groups.zh }, groups.en],
    ['Portuguese uses English with invalid Portuguese notes', 'pt-BR', { 'pt-BR': {}, en: groups.en }, groups.en],
    ['Portuguese falls back to Simplified Chinese', 'pt-BR', { 'pt-BR': [], en: [], zh: groups.zh }, groups.zh],
    ['Portuguese returns no groups when all fallbacks are empty', 'pt-BR', { 'pt-BR': [], en: [], zh: [] }, []],
    ['English and unknown locales prefer English', 'en', { en: groups.en, zh: groups.zh }, groups.en],
    ['Unknown locales fall back to Simplified Chinese', 'fr', { en: [], zh: groups.zh }, groups.zh],
    ['invalid release metadata returns no groups', 'ja', null, []]
  ];

  for (const [name, locale, notes, expected] of cases) {
    assert.deepEqual(releaseNoteGroupsForLocale(notes, locale), expected, name);
  }
});

test('release-note disclosure has keyboard focus and compact reading styles', () => {
  const html = read('index.html');
  const css = read('styles.css');
  const app = read('app.js');
  assert.match(html, /id="appUpdateNotesToggle"[\s\S]*settings-section-disclosure[\s\S]*id="appUpdateNotesTitle"/);
  assert.match(css, /\.app-update-notes-toggle \{[\s\S]*justify-content: flex-start;[\s\S]*gap: 5px;/);
  assert.match(css, /\.app-update-notes-disclosure::before \{[\s\S]*border-left: 5px solid currentColor;[\s\S]*transform: none;/);
  assert.match(css, /\.app-update-notes\.expanded \.app-update-notes-disclosure \{[\s\S]*transform: rotate\(90deg\)/);
  assert.match(css, /\.app-update-notes-toggle:focus-visible/);
  assert.match(css, /\.app-update-note-group ul[\s\S]*line-height: 1\.45/);
  assert.match(html, /id="appUpdateNotes" class="app-update-notes hidden"/);
  assert.match(app, /'\.app-update-notes-details'/);
  assert.match(app, /setupSettingsAccordion\(els\.appUpdateNotes, els\.appUpdateNotesToggle, els\.appUpdateNotesDetails\)/);
  assert.match(css, /\.app-update-popover:popover-open/);
  assert.match(css, /\.app-update-popover button:focus-visible[\s\S]*outline:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.app-update-popover/);
});

test('release-note card uses the shared popup surface, denser for long text', () => {
  const css = read('styles.css');
  assert.match(css, /\.settings-help-popover,\n\.app-update-popover \{\n {2}border: 1px solid/);
  const start = css.indexOf('\n.app-update-popover {\n  inset: auto;');
  const end = css.indexOf('}', start);
  assert.notEqual(start, -1);
  const popover = css.slice(start, end);
  // Only the density differs from the shared surface; nothing else is restated.
  assert.match(popover, /rgba\(var\(--glass-rgb\), 0\.9\)/);
  assert.doesNotMatch(popover, /border-radius:|box-shadow:|backdrop-filter:|border:/);
  assert.doesNotMatch(popover, /display:/, 'display on the base rule would show a closed popover');
  assert.match(css, /\.app-update-popover:popover-open \{ display: flex;/);
});

test('Japanese release-note heading describes updates rather than only new features', () => {
  const i18n = read('i18n.js');
  assert.match(i18n, /'settings\.appUpdate\.whatsNew': 'v\{version\} の更新内容'/);
});

test('the update button follows the Liquid Glass capsule, outline progress included', () => {
  const css = read('styles.css');
  // Shared with the other footer controls, not a copied radius and shadow.
  assert.match(css, /html\.native-liquid-glass :is\([^)]*#utilityActions button, \.update-pill-action\) \{\n {2}border-radius: 999px;/);
  assert.match(css, /html\.native-liquid-glass :is\([^{]*\.update-pill-action, \.view-switcher-current, \.view-switcher-disclosure\) \{\n {2}box-shadow: var\(--liquid-glass-specular\);/);
  assert.doesNotMatch(css, /html\.native-liquid-glass \.update-pill-action \{/);
  assert.match(css, /html\.native-liquid-glass \.update-pill-progress-bar \{[^}]*d: path\("M17 \.5H19A14\.5 14\.5 0 0 1 19 29\.5H15A14\.5 14\.5 0 0 1 15 \.5Z"\);/);
});

test('the release-note card is one of the Liquid Glass floating plates', () => {
  const css = read('styles.css');
  assert.match(css, /html\.native-liquid-glass \.settings-help-popover,\nhtml\.native-liquid-glass \.app-update-popover \{[^}]*border-radius: 14px;/);
});
