'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function read(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

test('App Updates includes an inline release-note disclosure and full-release action', () => {
  const html = read('index.html');
  assert.match(html, /<details id="appUpdateNotes" class="app-update-notes hidden">/);
  assert.match(html, /<summary id="appUpdateNotesTitle">/);
  assert.match(html, /id="appUpdateReleaseNotesButton"[\s\S]*data-i18n="settings\.appUpdate\.viewFullRelease"/);
});

test('footer update pill opens an accessible release-note popover', () => {
  const html = read('index.html');
  assert.match(html, /id="appUpdatePillAction"[^>]*class="update-pill-action"/);
  assert.doesNotMatch(html, /id="appUpdatePillAction"[^>]*aria-haspopup/);
  assert.match(html, /id="appUpdatePopover"[^>]*popover="auto"[^>]*role="dialog"/);
  assert.match(html, /id="appUpdatePopoverAction"/);
  assert.match(html, /id="appUpdatePopoverRelease"[\s\S]*settings\.appUpdate\.viewFullRelease/);
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
});

test('footer pill progressively discloses notes before download but installs directly once ready', () => {
  const app = read('app.js');
  const handler = app.slice(
    app.indexOf("els.appUpdatePillAction.addEventListener"),
    app.indexOf("els.appUpdatePillDismiss.addEventListener")
  );
  assert.match(handler, /appUpdateActionMode\(state\.appUpdate\) === 'install'/);
  assert.match(handler, /await runAppUpdateAction\(\);\s*return;/);
  assert.match(handler, /renderAppUpdatePopover\(state\.appUpdate\)/);
  assert.match(handler, /positionAppUpdatePopover\(\)/);
  assert.match(handler, /showPopover\(\)/);
  assert.match(handler, /appUpdatePopoverAction\.focus\(\)/);
  assert.match(handler, /await runAppUpdateAction\(\)/);
});

test('footer pill separates dismissed notices from available settings actions', () => {
  const app = read('app.js');
  const renderer = app.slice(
    app.indexOf('function renderAppUpdatePill'),
    app.indexOf('function releaseNoteGroupsForCurrentLocale')
  );
  assert.match(renderer, /!s\.showUpdateNotice/);
  assert.match(renderer, /mode === 'install' \|\| s\.installBusy/);
  assert.match(renderer, /t\('settings\.appUpdate\.restart'\)/);
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
});

test('release-note disclosure has keyboard focus and compact reading styles', () => {
  const css = read('styles.css');
  assert.match(css, /\.app-update-notes summary:focus-visible/);
  assert.match(css, /\.app-update-note-group ul[\s\S]*line-height: 1\.45/);
  assert.match(css, /\.app-update-notes\.hidden \{ display: none; \}/);
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
