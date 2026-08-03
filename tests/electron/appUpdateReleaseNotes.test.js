'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  releaseNoteGroupsForLocale
} = require('../../src/electron/renderer/appUpdatePresentation');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function read(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

test('App Updates includes an inline release-note disclosure and full-release action', () => {
  const html = read('index.html');
  assert.match(html, /<div id="appUpdateNotes" class="app-update-notes hidden">/);
  assert.match(html, /id="appUpdateNotesToggle"[^>]*aria-expanded="false"[^>]*aria-controls="appUpdateNotesDetails"/);
  assert.match(html, /id="appUpdateNotesDetails" class="app-update-notes-details hidden" inert/);
  assert.match(html, /id="appUpdateNotesTitle"/);
  assert.match(html, /id="appUpdateReleaseNotesButton"[\s\S]*data-i18n="settings\.appUpdate\.viewFullRelease"/);
});

test('footer update pill opens an accessible release-note popover', () => {
  const html = read('index.html');
  assert.match(html, /id="appUpdatePillAction"[^>]*class="update-pill-action"/);
  assert.match(html, /id="appUpdatePillRestart"[^>]*class="update-pill-restart hidden"[\s\S]*id="appUpdatePillRestartLabel"/);
  assert.doesNotMatch(html, /id="appUpdatePillAction"[^>]*aria-haspopup/);
  assert.match(html, /id="appUpdatePopover"[^>]*popover="auto"[^>]*role="dialog"/);
  assert.match(html, /id="appUpdatePopoverAction"/);
  assert.match(html, /id="appUpdatePopoverRelease"[\s\S]*settings\.appUpdate\.viewFullRelease/);
});

test('footer update pill yields its space while utility actions are disclosed', () => {
  const css = read('styles.css');
  const start = css.indexOf('.footer:has(.utility-actions:hover) .update-pill,');
  const end = css.indexOf('}', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const hiddenDuringDisclosure = css.slice(start, end);

  assert.match(hiddenDuringDisclosure, /\.footer:has\(\.utility-actions :focus-visible\) \.update-pill/);
  assert.match(hiddenDuringDisclosure, /\.refresh-button:is\(\.is-refreshing, \.is-refreshed, \.is-refresh-error\)/);
  assert.match(hiddenDuringDisclosure, /\.shell\.settings-open \.footer \.update-pill/);
  assert.match(hiddenDuringDisclosure, /opacity:\s*0/);
  assert.match(hiddenDuringDisclosure, /pointer-events:\s*none/);
  assert.doesNotMatch(hiddenDuringDisclosure, /display:\s*none/, 'the pill keeps its layout width so hover causes no movement');
});

test('release notes render as text nodes and auto-open once for a new version', () => {
  const app = read('app.js');
  const renderer = app.slice(
    app.indexOf('function buildAppUpdateNoteGroupNodes'),
    app.indexOf('function renderSettingsAppUpdateRow')
  );

  assert.match(renderer, /title\.textContent = String\(group\?\.title \|\| ''\)/);
  assert.match(renderer, /row\.textContent = String\(item \|\| ''\)/);
  assert.match(renderer, /appUpdateNotesBody\.replaceChildren\(\.\.\.buildAppUpdateNoteGroupNodes\(groups\)\)/);
  assert.doesNotMatch(renderer, /innerHTML/);
  assert.match(renderer, /s\.hasUpdate && state\.appUpdateNotesPresentedVersion !== version/);
  assert.match(renderer, /appUpdateNotesDetails\.getBoundingClientRect\(\)/);
  assert.match(renderer, /setSettingsAccordionExpanded\(els\.appUpdateNotes, els\.appUpdateNotesToggle, els\.appUpdateNotesDetails, true\)/);
});

test('ready footer pill keeps release notes and restart as separate actions', () => {
  const app = read('app.js');
  const notesHandler = app.slice(
    app.indexOf("els.appUpdatePillAction.addEventListener"),
    app.indexOf("els.appUpdatePillRestart.addEventListener")
  );
  const restartHandler = app.slice(
    app.indexOf("els.appUpdatePillRestart.addEventListener"),
    app.indexOf("els.appUpdatePillDismiss.addEventListener")
  );
  assert.match(notesHandler, /renderAppUpdatePopover\(state\.appUpdate\)/);
  assert.match(notesHandler, /positionAppUpdatePopover\(\)/);
  assert.match(notesHandler, /showPopover\(\)/);
  assert.match(notesHandler, /appUpdatePopoverAction\.focus\(\)/);
  assert.match(restartHandler, /await runAppUpdateAction\(\)/);
});

test('footer pill separates dismissed notices from available settings actions', () => {
  const app = read('app.js');
  const renderer = app.slice(
    app.indexOf('function renderAppUpdatePill'),
    app.indexOf('function releaseNoteGroupsForCurrentLocale')
  );
  assert.match(renderer, /!s\.showUpdateNotice/);
  assert.match(renderer, /mode === 'install' \|\| s\.installBusy/);
  assert.match(renderer, /appUpdatePillRestart\.classList\.toggle\('hidden', mode !== 'install'\)/);
  assert.match(renderer, /appUpdatePillLabel\.textContent = mode === 'install'[\s\S]*`v\$\{version\}`/);
  assert.match(renderer, /t\('settings\.appUpdate\.restartShort'\)/);
});

test('ready footer pill collapses only the restart text at minimum width', () => {
  const css = read('styles.css');
  assert.match(css, /@media \(max-width: 300px\)[\s\S]*\.update-pill-restart-label \{ display: none; \}/);
});

test('footer pill only exposes dialog semantics when release notes are available', () => {
  const app = read('app.js');
  const renderer = app.slice(
    app.indexOf('function setAppUpdatePillDisclosure'),
    app.indexOf('function releaseNoteGroupsForCurrentLocale')
  );
  assert.match(renderer, /setAttribute\('aria-haspopup', 'dialog'\)/);
  assert.match(renderer, /setAttribute\('aria-controls', 'appUpdatePopover'\)/);
  assert.match(renderer, /removeAttribute\('aria-haspopup'\)/);
  assert.match(renderer, /releaseNoteGroupsForCurrentLocale\(s\.latest\)\.length > 0/);
  assert.doesNotMatch(renderer, /mode !== 'install' && releaseNoteGroupsForCurrentLocale/);
});

test('renderer delegates release-note locale selection to the shared presentation helper', () => {
  const app = read('app.js');
  const renderer = app.slice(
    app.indexOf('function releaseNoteGroupsForCurrentLocale'),
    app.indexOf('function buildAppUpdateNoteGroupNodes')
  );
  assert.match(renderer, /return appUpdatePresentationApi\.releaseNoteGroupsForLocale\(latest\?\.releaseNotes, currentLocale\(\)\)/);
});

test('release-note locale selection follows the complete fallback matrix', () => {
  const groups = {
    en: [{ title: 'English', items: ['en'] }],
    zh: [{ title: '简体中文', items: ['zh'] }],
    traditional: [{ title: '繁體中文', items: ['zh-TW'] }],
    ko: [{ title: '한국어', items: ['ko'] }],
    ja: [{ title: '日本語', items: ['ja'] }]
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
  assert.match(css, /\.app-update-notes\.hidden \{ display: none; \}/);
  assert.match(app, /'\.app-update-notes-details'/);
  assert.match(app, /setupSettingsAccordion\(els\.appUpdateNotes, els\.appUpdateNotesToggle, els\.appUpdateNotesDetails\)/);
  assert.match(css, /\.app-update-popover:popover-open/);
  assert.match(css, /\.app-update-popover button:focus-visible[\s\S]*outline:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.app-update-popover/);
});

test('release-note popover uses the view switcher glass surface', () => {
  const css = read('styles.css');
  const start = css.indexOf('.app-update-popover {');
  const end = css.indexOf('}', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const popover = css.slice(start, end);
  assert.match(popover, /rgba\(var\(--glass-rgb\), 0\.76\)/);
  assert.match(popover, /backdrop-filter: blur\(28px\) saturate\(115%\)/);
  assert.doesNotMatch(popover, /var\(--bg\)/);
});

test('Japanese release-note heading describes updates rather than only new features', () => {
  const i18n = read('i18n.js');
  assert.match(i18n, /'settings\.appUpdate\.whatsNew': 'v\{version\} の更新内容'/);
});
