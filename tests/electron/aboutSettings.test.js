'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function read(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

test('General settings ends with an About card led by the GitHub star button', () => {
  const html = read('index.html');
  const general = html.match(/<div id="generalSettingsDetails"[\s\S]*?<div id="mainSettingsDetails"/)?.[0] || '';
  const about = general.slice(general.indexOf('<div class="settings-subgroup settings-page-card about-settings"'));

  assert.match(about, /^<div class="settings-subgroup settings-page-card about-settings" role="group" aria-labelledby="aboutTitle">/);
  assert.match(about, /<img class="about-settings-icon" src="icons\/app-icon\.png" alt=""/);
  assert.match(about, /id="aboutTitle">Token Monitor<\/strong>\s*<span id="aboutVersion">—<\/span>/);
  assert.match(about, /<button id="openRepositoryButton" type="button" class="about-settings-star">\s*<span class="about-settings-star-label"><span class="about-settings-github-mark" aria-hidden="true"><\/span><span data-i18n="settings\.about\.star">/);
  assert.match(about, /<span id="aboutStarCount" class="about-settings-star-count" hidden>\s*<svg class="about-settings-star-icon"[^>]*aria-hidden="true">[\s\S]*?<span id="aboutStarCountValue" class="about-settings-star-value"><\/span>/);
  assert.match(about, /id="openWebsiteButton" type="button" class="inline-link about-settings-link about-settings-link-website"[\s\S]*settings\.about\.website/);
  assert.match(about, /id="reportIssueButton" type="button" class="inline-link about-settings-link about-settings-link-issue"[\s\S]*settings\.about\.reportIssue/);
  assert.match(about, /id="diagnosticToggleButton" type="button" class="inline-link about-settings-link about-settings-link-diagnostics"/);
  const css = read('styles.css');
  for (const [modifier, icon] of [['website', 'sources/globe.svg'], ['issue', 'actions/bug.svg'], ['diagnostics', 'actions/stethoscope.svg']]) {
    assert.match(css, new RegExp(`\\.about-settings-link-${modifier} \\{ --about-link-icon: url\\("icons/${icon.replace('.', '\\.')}"\\); \\}`));
    assert.ok(fs.existsSync(path.join(rendererDir, 'icons', icon)), icon);
  }
  assert.match(css, /\.about-settings-github-mark \{[\s\S]*mask: url\("icons\/brands\/github\.svg"\)/);
  const notices = read('icons/THIRD_PARTY_NOTICES.md');
  assert.match(notices, /actions\/bug\.svg: bug[\s\S]*actions\/stethoscope\.svg: stethoscope/);
  assert.match(notices, /brands\/github\.svg: mark-github[\s\S]*GitHub Octicons license:/);
  assert.ok(general.indexOf('settings.advanced.title') < general.indexOf('about-settings'));
  assert.ok(fs.statSync(path.join(rendererDir, 'icons', 'app-icon.png')).size < 32 * 1024, 'About uses a small icon, not the 1024px app icon');
});

test('General settings groups its controls into cards', () => {
  const html = read('index.html');
  const general = html.match(/<div id="generalSettingsDetails"[\s\S]*?<div id="mainSettingsDetails"/)?.[0] || '';
  const cards = [...general.matchAll(/<div (?:id="\w+" )?class="settings-subgroup settings-page-card ?([^"]*)"/g)].map((match) => match[1]);

  assert.deepEqual(cards, [
    'settings-general-preferences',
    'maintenance-section app-update-settings',
    '',
    'advanced-settings',
    'about-settings'
  ]);
  assert.match(general, /settings\.general\.preferences[\s\S]*id="languageInput"[\s\S]*id="startupGroup"/);
  // A card opening a section keeps its top edge despite the flat first-subgroup reset.
  const css = read('styles.css');
  const reset = css.indexOf('.settings-section-details-inner > .settings-subgroup:first-child {');
  const cardRule = css.indexOf('.settings-section-details-inner > .settings-page-card:first-child {');
  assert.ok(reset >= 0 && cardRule > reset);
  assert.match(css.slice(cardRule, css.indexOf('}', cardRule)), /padding-top: 8px;[\s\S]*border-top: 1px solid var\(--line\);/);
});

test('App Updates puts the installed version, its status and the actions on one row', () => {
  const html = read('index.html');
  const row = html.match(/<div class="settings-item app-update-version-row">[\s\S]*?<\/span>\s*<\/span>\s*<\/div>/)?.[0] || '';

  assert.match(row, /<strong id="appUpdateInstalled" class="app-update-installed">—<\/strong>/);
  assert.match(row, /<span id="appUpdateLatest" class="cursor-status-pill app-update-status-pill"/);
  assert.match(row, /<span id="appUpdateCheckedAt" class="settings-item-desc"><\/span>/);
  assert.match(row, /<span class="settings-actions app-update-actions">[\s\S]*id="appUpdateCheckButton"[\s\S]*id="appUpdateViewReleaseButton"/);
  assert.ok(html.indexOf('app-update-version-row') < html.indexOf('id="automaticAppUpdatesRow"'));
  assert.doesNotMatch(html, /app-update-version-grid|settings\.appUpdate\.installed/);
});

test('General settings keeps Tokscale inside a collapsed Advanced disclosure', () => {
  const html = read('index.html');
  const general = html.match(/<div id="generalSettingsDetails"[\s\S]*?<div id="mainSettingsDetails"/)?.[0] || '';
  const start = general.indexOf('<div id="advancedSettingsGroup"');
  const end = general.indexOf('<div class="settings-subgroup settings-page-card about-settings"', start);
  const advanced = start >= 0 && end >= 0 ? general.slice(start, end) : '';

  assert.match(advanced, /^<div id="advancedSettingsGroup" class="settings-subgroup settings-page-card advanced-settings">/);
  assert.match(advanced, /<button id="advancedSettingsToggle"[\s\S]*aria-expanded="false" aria-controls="advancedSettingsDetails">[\s\S]*settings\.advanced\.title/);
  assert.match(advanced, /<div id="advancedSettingsDetails" class="advanced-settings-details hidden" inert>/);
  assert.match(advanced, /id="advancedSettingsSummary"[\s\S]*settings\.advanced\.summary/);
  assert.ok(advanced.indexOf('id="networkProxyGroup"') < advanced.indexOf('id="tokscaleGroup"'));
  assert.ok(advanced.indexOf('id="tokscaleGroup"') < advanced.indexOf('id="openConfigButton"'));
  assert.ok(general.indexOf('settings.appUpdate.title') < start);
  assert.ok(end > start);
});

test('General settings explains Discord presence and identifies Tokscale as a bundled CLI dependency', () => {
  const html = read('index.html');
  const i18n = read('i18n.js');

  assert.match(html, /id="discordRpcInput"[^>]*aria-describedby="discordRpcDescription"[\s\S]*id="discordRpcDescription" class="settings-item-desc"[^>]*settings\.integrations\.discordDescription/);
  assert.equal((i18n.match(/'settings\.integrations\.discordDescription':/g) || []).length, 6);
  assert.match(i18n, /'settings\.tokscale\.source': '內建的 CLI 依賴'/);
  assert.doesNotMatch(i18n, /'settings\.tokscale\.source': '[^']*(?:Data engine|資料引擎|数据引擎|데이터 엔진|データエンジン)/);
});

test('Tokscale separates installed version from declared bundled build', () => {
  const source = read('app.js');
  const body = source.slice(source.indexOf('function renderTokscaleStatus()'), source.indexOf('async function refreshTokscaleStatus('));
  let buildHidden;
  const els = {
    tokscaleGroup: { classList: { add() {}, remove() {} } },
    tokscaleInstalled: { textContent: '' },
    tokscaleBundledBuild: { textContent: '' },
    tokscaleBundledBuildRow: { classList: { toggle: (_, hidden) => { buildHidden = hidden; } } }
  };
  const state = { tokscaleStatus: { supported: true, current: { source: 'bundled', version: '4.17.0' }, bundledBuild: { commit: 'a'.repeat(40) } } };
  const context = { els, state, t: (key) => key, versionText: (version) => `v${version}` };
  vm.runInNewContext(`${body}\nrenderTokscaleStatus()`, context);
  assert.equal(els.tokscaleInstalled.textContent, 'v4.17.0');
  assert.equal(els.tokscaleBundledBuild.textContent, 'fork aaaaaaaa');
  assert.equal(buildHidden, false);
  state.tokscaleStatus = { supported: true, current: { source: 'shim', version: null }, bundledBuild: null };
  vm.runInNewContext(`${body}\nrenderTokscaleStatus()`, context);
  assert.equal(els.tokscaleInstalled.textContent, 'settings.tokscale.versionUnknown');
  assert.equal(buildHidden, true);
  state.tokscaleStatus = {};
  vm.runInNewContext(`${body}\nrenderTokscaleStatus()`, context);
  assert.equal(els.tokscaleInstalled.textContent, 'settings.tokscale.versionUnknown');
  assert.equal((read('i18n.js').match(/'settings\.tokscale\.bundledBuild':/g) || []).length, 6);
  const pkg = JSON.parse(fs.readFileSync(path.join(rendererDir, '../../../package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('scripts/vendor/tokscale.json'));
});

test('General settings places integrations after the complete App Updates group', () => {
  const html = read('index.html');
  const general = html.match(/<div id="generalSettingsDetails"[\s\S]*?<div id="mainSettingsDetails"/)?.[0] || '';

  assert.ok(general.indexOf('id="startupGroup"') < general.indexOf('id="automaticAppUpdatesRow"'));
  assert.ok(general.indexOf('id="appUpdateMessage"') < general.indexOf('id="discordRpcInput"'));
  assert.ok(general.indexOf('id="discordRpcInput"') < general.indexOf('id="advancedSettingsGroup"'));
});

test('Advanced disclosure uses the shared animated accordion with accessible state', () => {
  const css = read('styles.css');
  const app = read('app.js');

  assert.match(css, /\.advanced-settings-toggle:focus-visible \{[\s\S]*outline:/);
  assert.match(css, /\.advanced-settings\.expanded > \.advanced-settings-toggle \.settings-section-disclosure \{[\s\S]*transform: rotate\(180deg\)/);
  assert.match(app, /'\.advanced-settings-details'/);
  assert.match(app, /function setSettingsAccordionExpanded\(group, toggle, details, expanded\)[\s\S]*details\.inert = !open/);
  assert.match(app, /setupSettingsAccordion\(els\.advancedSettingsGroup, els\.advancedSettingsToggle, els\.advancedSettingsDetails\)/);
});

test('maintenance versions stay as compact flat rows instead of nested cards', () => {
  const css = read('styles.css');
  const gridStart = css.indexOf('.maintenance-version-grid {');
  const gridEnd = css.indexOf('}', gridStart);
  const grid = css.slice(gridStart, gridEnd);

  assert.match(grid, /display: grid/);
  assert.match(grid, /gap: 6px/);
  assert.doesNotMatch(grid, /background|border-radius|grid-template-columns/);
  assert.match(css, /\.maintenance-version-item \{[\s\S]*display: flex;[\s\S]*justify-content: space-between/);
});

test('About uses runtime version and allowlisted Token Monitor links', () => {
  const app = read('app.js');

  assert.match(app, /aboutVersion\.textContent = state\.appInfo\?\.version \? `v\$\{state\.appInfo\.version\}` : '—'/);
  assert.match(app, /TOKEN_MONITOR_REPOSITORY_URL = 'https:\/\/github\.com\/Javis603\/token-monitor'/);
  assert.match(app, /TOKEN_MONITOR_ISSUES_URL = `\$\{TOKEN_MONITOR_REPOSITORY_URL\}\/issues\/new\/choose`/);
  assert.match(app, /TOKEN_MONITOR_WEBSITE_URL = 'https:\/\/javis-ai\.com\/token-monitor\/'/);
  assert.match(app, /openRepositoryButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_REPOSITORY_URL/);
  assert.match(app, /openWebsiteButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_WEBSITE_URL/);
  assert.match(app, /reportIssueButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_ISSUES_URL/);

  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  assert.match(main, /parsed\.hostname === 'javis-ai\.com'[\s\S]*parsed\.pathname === '\/token-monitor'/);
});

test('About links stay visually secondary and wrap in narrow settings', () => {
  const css = read('styles.css');

  assert.match(css, /\.about-settings-links \{[\s\S]*flex-wrap: wrap;/);
  assert.match(css, /\.about-settings-links \.inline-link \{ font-size: 0\.625rem; \}/);
});

test('About diagnostics open from the support links and separate generate, view and copy actions', () => {
  const html = read('index.html');
  const about = html.match(/<div class="settings-subgroup settings-page-card about-settings"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)?.[0] || '';

  assert.match(about, /id="diagnosticToggleButton"[\s\S]*settings\.about\.diagnostics\.toggle[\s\S]*aria-controls="diagnosticDetails"/);
  assert.match(about, /id="diagnosticDetails" class="about-settings-diagnostics accordion-animated-container hidden"[^>]*inert/);
  assert.match(about, /class="accordion-animation-inner about-settings-diagnostics-inner"/);
  assert.match(about, /id="generateDiagnosticButton"[\s\S]*settings\.about\.diagnostics\.generate/);
  assert.match(about, /id="copyDiagnosticButton"[^>]*class="hidden"[\s\S]*settings\.about\.diagnostics\.copy/);
  assert.match(about, /id="previewDiagnosticButton"[^>]*class="inline-link hidden"[\s\S]*settings\.about\.diagnostics\.preview/);
  assert.doesNotMatch(about, /id="closeDiagnosticPreviewButton"/);
  assert.doesNotMatch(about, /id="diagnosticGeneratedAt"/);
  assert.match(about, /id="diagnosticPreview" class="diagnostic-preview hidden"[^>]*aria-hidden="true"[^>]*inert/);
  assert.ok(about.indexOf('id="reportIssueButton"') < about.indexOf('id="diagnosticToggleButton"'));
  assert.match(about, /data-i18n="settings\.about\.diagnostics\.privacy"/);
  assert.ok(html.indexOf('src="diagnosticsPanel.js"') < html.indexOf('src="app.js"'));

  const app = read('app.js');
  const panel = read('diagnosticsPanel.js');
  assert.match(app, /const diagnosticsPanel = window\.TokenMonitorDiagnosticsPanel\?\.createDiagnosticsPanel\(/);
  assert.match(app, /diagnosticsPanel\?\.render\(\)/);
  assert.doesNotMatch(app, /state\.diagnostics(?:Busy|DetailsOpen|Text|GeneratedAt|PreviewOpen|StatusKey|StatusTone)/);
  assert.match(panel, /async function requestReport\([\s\S]*generateDiagnosticReport/);
  assert.match(panel, /async function ensureReport\([\s\S]*state\.busy/);
  assert.match(panel, /function toggleDetails\([\s\S]*state\.detailsOpen/);
  assert.match(panel, /state\.busy = true[\s\S]*render\(\)/);
  assert.match(panel, /generate: \(\) => ensureReport\(\{ openPreview: true \}\)/);
  assert.match(panel, /regenerate: \(\) => ensureReport\(\{ force: true, openPreview: true \}\)/);
  assert.match(panel, /previewButton\.textContent = state\.previewOpen[\s\S]*settings\.about\.diagnostics\.hidePreview/);
  assert.match(panel, /function togglePreview\([\s\S]*state\.previewOpen = !state\.previewOpen/);
  assert.match(panel, /elements\.generate\?\.addEventListener\('click'/);
  assert.match(panel, /elements\.copy\?\.addEventListener\('click'/);
  assert.doesNotMatch(app, /closeDiagnosticPreviewButton|function closeDiagnosticPreview/);
  assert.doesNotMatch(panel, /diagnosticGeneratedAt/);
});

test('Diagnostic disclosure uses the shared accordion transition and compact preview styling', () => {
  const css = read('styles.css');

  assert.match(css, /\.about-settings-diagnostics \{[\s\S]*transition: grid-template-rows 250ms cubic-bezier/);
  assert.match(css, /\.about-settings-diagnostics\.hidden \{[\s\S]*padding-top: 0;[\s\S]*border-top-color: transparent;/);
  assert.doesNotMatch(css, /\.about-settings-diagnostics\.hidden,\s*\.diagnostic-preview\.hidden \{ display: none; \}/);
  assert.match(css, /#diagnosticReportText \{[\s\S]*max-height: 260px;[\s\S]*overflow: auto;/);
  assert.match(css, /\.diagnostic-actions button:disabled[\s\S]*opacity: 0\.45/);
});

test('About shows the repository star count only once main has fetched it', async () => {
  const app = read('app.js');
  const body = app.slice(app.indexOf('let aboutStarsRequest = null;'), app.indexOf('// Feedback for the click that opens the repository'));
  let calls = 0;
  let reply = 3760;
  const els = {
    aboutStarCount: { hidden: true },
    aboutStarCountValue: { dataset: {}, textContent: '' },
    openRepositoryButton: { classList: { add() {} }, addEventListener() {} }
  };
  const context = {
    els,
    state: { repositoryStars: null },
    currentLocale: () => 'en',
    prefersReducedMotion: () => true,
    Intl,
    Promise,
    Number,
    window: { tokenMonitor: { getRepositoryStars: async () => { calls++; return reply; } } }
  };
  vm.runInNewContext(`${body}\nthis.renderAboutStars = renderAboutStars; this.refreshAboutStars = refreshAboutStars; this.formatAboutStars = formatAboutStars;`, context);

  context.renderAboutStars();
  assert.equal(els.aboutStarCount.hidden, true);
  await Promise.all([context.refreshAboutStars(), context.refreshAboutStars()]);
  assert.equal(calls, 1, 'concurrent opens share one request');
  assert.equal(els.aboutStarCount.hidden, false);
  assert.equal(els.aboutStarCountValue.textContent, '3,760', 'counts below 10,000 keep every digit');
  reply = null;
  await context.refreshAboutStars();
  assert.equal(els.aboutStarCountValue.textContent, '3,760', 'a failed refresh keeps the last count');
  assert.equal(context.formatAboutStars(12_345), '12.3K');
  assert.match(app, /if \(id === 'general' && next\) void refreshAboutStars\(\);/);
  assert.match(read('../preload.js'), /getRepositoryStars: \(\) => ipcRenderer\.invoke\('app:repositoryStars'\)/);
});

test('the intro plays once, when the star button first comes into view, unless motion is reduced', async () => {
  const app = read('app.js');
  const body = app.slice(app.indexOf('let aboutStarsRequest = null;'), app.indexOf('// Feedback for the click that opens the repository'));
  const element = () => ({
    children: [], style: {}, attributes: {}, className: '', textContent: '', listeners: {},
    append(...items) { this.children.push(...items); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    removeEventListener(type) { delete this.listeners[type]; }
  });
  function harness({ reduced, replies = [3760] }) {
    const added = [];
    const observers = [];
    class FakeIntersectionObserver {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.disconnected = true; }
      fire(isIntersecting, intersectionRatio = isIntersecting ? 1 : 0) { this.callback([{ isIntersecting, intersectionRatio }]); }
    }
    const els = {
      aboutStarCount: { hidden: true },
      aboutStarCountValue: { dataset: {}, textContent: '', replaceChildren(...items) { this.children = items; }, contains(item) { return this.children?.includes(item); } },
      openRepositoryButton: { classList: { add: (name) => added.push(name) }, addEventListener() {} }
    };
    const context = {
      els,
      state: { repositoryStars: null },
      currentLocale: () => 'en',
      prefersReducedMotion: () => reduced,
      requestAnimationFrame: (callback) => callback(),
      document: { createElement: element },
      IntersectionObserver: FakeIntersectionObserver,
      Intl,
      Promise,
      Number,
      String,
      window: { tokenMonitor: { getRepositoryStars: async () => (replies.length > 1 ? replies.shift() : replies[0]) } }
    };
    vm.runInNewContext(`${body}\nthis.refreshAboutStars = refreshAboutStars;`, context);
    return { added, observers, els, refresh: () => context.refreshAboutStars() };
  }

  const motion = harness({ reduced: false });
  await motion.refresh();
  assert.equal(motion.els.aboutStarCountValue.textContent, '3,760', 'the count shows at once');
  assert.deepEqual(motion.added, [], 'nothing plays while the button is off screen');
  assert.equal(motion.observers.length, 1);
  motion.observers[0].fire(false);
  motion.observers[0].fire(true, 0.4);
  assert.deepEqual(motion.added, [], 'a partly visible button does not spend the intro');
  assert.equal(motion.observers[0].disconnected, false);
  motion.observers[0].fire(true);
  assert.deepEqual(motion.added, ['is-arriving']);
  assert.equal(motion.observers[0].disconnected, true);
  const [reel, label] = motion.els.aboutStarCountValue.children;
  assert.equal(reel.attributes['aria-hidden'], 'true');
  assert.equal(label.textContent, '3,760', 'assistive technology reads the plain number');
  const digits = reel.children.filter((child) => typeof child !== 'string');
  assert.deepEqual(digits.map((column) => column.style.transform), ['translateY(calc(-3 * 1.2em))', 'translateY(calc(-7 * 1.2em))', 'translateY(calc(-6 * 1.2em))', 'translateY(calc(0 * 1.2em))']);
  const lastColumn = digits.at(-1);
  digits[0].listeners.transitionend?.({ target: digits[0], propertyName: 'transform' });
  lastColumn.listeners.transitionend({ target: lastColumn, propertyName: 'opacity' });
  assert.equal(motion.els.aboutStarCountValue.children[0], reel, 'the reel stays until the last column stops');
  lastColumn.listeners.transitionend({ target: lastColumn, propertyName: 'transform' });
  assert.equal(motion.els.aboutStarCountValue.textContent, '3,760', 'the stopped reel becomes plain text, free of fractional transforms');
  motion.els.aboutStarCountValue.children = [];
  await motion.refresh();
  assert.equal(motion.observers.length, 1, 'the intro is spent for this launch');

  const retry = harness({ reduced: false, replies: [null, 3760] });
  await retry.refresh();
  assert.equal(retry.observers.length, 0, 'a failed lookup does not spend the intro');
  await retry.refresh();
  assert.equal(retry.observers.length, 1);
  retry.observers[0].fire(true);
  assert.deepEqual(retry.added, ['is-arriving']);
  assert.equal(retry.els.aboutStarCountValue.children[1].textContent, '3,760', 'the retry still rolls the count');

  const quiet = harness({ reduced: true });
  await quiet.refresh();
  quiet.observers[0].fire(true);
  assert.deepEqual(quiet.added, []);
  assert.equal(quiet.els.aboutStarCountValue.textContent, '3,760');
});

test('reopening Settings with General already expanded refreshes the star count from the tray and the gear', () => {
  const app = read('app.js');
  const tray = app.slice(app.indexOf('function openSettingsPanel('), app.indexOf('function openViewFromTray('));
  const gear = app.slice(app.indexOf("els.settingsButton.addEventListener('click'"), app.indexOf("els.saveSettingsButton.addEventListener('click'"));
  assert.match(tray, /if \(state\.settingsSections\?\.general\) void refreshAboutStars\(\);/);
  assert.match(gear, /if \(settingsOpen && state\.settingsSections\?\.general\) void refreshAboutStars\(\);/, 'only when the gear opens the panel');
});

test('About star button honours the app motion setting', () => {
  const css = read('styles.css');
  assert.match(css, /:root\[data-reduce-motion="on"\] \.settings-panel button\.about-settings-star::before,/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*:root:not\(\[data-reduce-motion="off"\]\) \.settings-panel button\.about-settings-star,/);
  const app = read('app.js');
  const celebrate = app.slice(app.indexOf('function celebrateAboutStar('), app.indexOf('function compactAge('));
  assert.match(celebrate, /if \(prefersReducedMotion\(\) \|\| els\.aboutStarCount\.hidden\) return;/);
  assert.match(app, /openRepositoryButton\?\.addEventListener\('click', \(\) => \{\s*celebrateAboutStar\(\);\s*window\.tokenMonitor\.openExternal\?\.\(TOKEN_MONITOR_REPOSITORY_URL\);/);
});

test('About describes the app with the README tagline in every locale that has a README', () => {
  const { translate } = require('../../src/electron/renderer/i18n.js');
  const root = path.join(rendererDir, '..', '..', '..');
  const readmes = { en: 'README.md', 'zh-TW': 'README.zh-TW.md', 'zh-CN': 'README.zh-CN.md', ko: 'README.ko.md', ja: 'README.ja.md', 'pt-BR': 'README.pt-BR.md' };
  for (const [locale, file] of Object.entries(readmes)) {
    const tagline = fs.readFileSync(path.join(root, file), 'utf8').match(/<em>([^<]*)<\/em>/)?.[1];
    assert.equal(translate(locale, 'settings.about.description'), tagline, locale);
  }
  assert.match(read('index.html'), new RegExp(`data-i18n="settings\\.about\\.description">${translate('en', 'settings.about.description')}</p>`));
});

test('changing the interface language reformats the star count without another lookup', () => {
  const app = read('app.js');
  const apply = app.slice(app.indexOf('function applySettingsTranslations('), app.indexOf('let displaySettings = null;'));
  assert.match(apply, /renderAboutStars\(\);/);
  assert.doesNotMatch(apply, /refreshAboutStars/);
});

test('the star count uses the display font so its comma does not split the number', () => {
  const css = read('styles.css');
  const start = css.indexOf('.about-settings-star-count {');
  const rule = css.slice(start, css.indexOf('}', start));
  assert.match(rule, /font-family: var\(--display-font,/);
  // Regular weight at the button's own size, so the digits match the star's outline.
  assert.match(rule, /font-weight: 400;/);
  assert.doesNotMatch(rule, /font-size/);
});
