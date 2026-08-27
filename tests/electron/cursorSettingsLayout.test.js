'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule should exist`);
  return match[1];
}

function cssRulesForSelector(source, selector) {
  const rules = [];
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(candidate => candidate.trim());
    if (selectors.includes(selector)) rules.push(match[2]);
  }
  assert.ok(rules.length > 0, `${selector} rule should exist`);
  return rules;
}

function declaration(rule, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = rule.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  return match?.[1].trim() || '';
}

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  return source.slice(start, end);
}

function functionBodyBeforeMarker(source, name, marker) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(marker, start);
  assert.notEqual(end, -1, `${marker} marker should follow ${name}`);
  return source.slice(start, end);
}

function runMainFunction(source, name, nextName, expression, context = {}) {
  const body = functionBody(source, name, nextName);
  return vm.runInNewContext(`${body}\n${expression}`, context);
}

function runRendererFunctions(source, names, expression, context = {}) {
  const snippets = names.map((name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} function should exist`);
    let depth = 0;
    let end = -1;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    assert.notEqual(end, -1, `${name} function should close`);
    return source.slice(start, end);
  }).join('\n');
  return vm.runInNewContext(`${snippets}\n${expression}`, context);
}

test('Cursor account status stays inline with the linked-account summary', () => {
  const html = readRendererFile('index.html');
  const toggle = html.match(/<button id="cursorSettingsToggle"[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(
    toggle,
    /<span data-i18n="settings\.cursor\.title"[\s\S]*?<\/span>\s*<span class="cursor-settings-summary">[\s\S]*?<span id="cursorAccountStatus"[\s\S]*?<\/span>\s*<span class="cursor-disclosure-icon"/,
    'status pill and disclosure icon should stay on the title row'
  );
  assert.match(
    toggle,
    /<span class="cursor-disclosure-icon" aria-hidden="true"><\/span>/,
    'CSS chevron should not render on top of a text arrow'
  );

  const css = readRendererFile('styles.css');
  const toggleRule = cssRule(css, '.cursor-settings-toggle');
  assert.equal(declaration(toggleRule, 'flex-wrap'), '');

  const summaryRule = cssRule(css, '.settings-group-header .cursor-settings-summary');
  assert.equal(declaration(summaryRule, 'max-width'), '58%');

  const pillRule = cssRule(css, '.cursor-status-pill');
  assert.equal(declaration(pillRule, 'white-space'), 'nowrap');
  assert.equal(declaration(pillRule, 'overflow-wrap'), '');

  const iconRule = cssRule(css, '.cursor-disclosure-icon');
  assert.equal(declaration(iconRule, 'display'), 'inline-grid');
  assert.equal(declaration(iconRule, 'place-items'), 'center');
  assert.equal(declaration(iconRule, 'height'), '12px');
  assert.equal(declaration(iconRule, 'transform-origin'), 'center');
  assert.equal(declaration(iconRule, 'transform'), '');

  const expandedRule = cssRule(css, '.cursor-account-group.expanded .cursor-disclosure-icon');
  assert.equal(declaration(expandedRule, 'transform'), 'rotate(180deg)');
});

test('Hub secret input stays masked and exposes an accessible paste button', () => {
  const html = readRendererFile('index.html');
  const secretFieldMatch = html.match(/<div class="settings-field hub-secret-field">[\s\S]*?<\/div>\s*<div/);
  const secretField = secretFieldMatch?.[0]?.replace(/<div$/, '') || '';
  const secretLabel = secretField.match(/<label for="secretInput" data-i18n="settings\.sync\.secret">Secret<\/label>/)?.[0] || '';
  const secretRow = secretField.match(/<div class="hub-secret-row">[\s\S]*?<\/div>/)?.[0] || '';
  // Outer container must carry settings-field so it inherits font-size 11px
  assert.match(secretField, /<div class="settings-field hub-secret-field">[\s\S]*?<label for="secretInput" data-i18n="settings\.sync\.secret">Secret<\/label>[\s\S]*?<div class="hub-secret-row">/);
  assert.match(secretLabel, /<label for="secretInput" data-i18n="settings\.sync\.secret">Secret<\/label>/);
  assert.doesNotMatch(secretLabel, /secretPasteButton/);
  assert.match(secretRow, /<input id="secretInput" type="password"[\s\S]*data-i18n-placeholder="settings\.sync\.secretPlaceholder"/);
  assert.match(secretRow, /<button id="secretPasteButton" type="button" class="icon-button" title="Paste secret" data-i18n-title="settings\.sync\.pasteSecret" aria-label="Paste secret" data-i18n-aria-label="settings\.sync\.pasteSecret">/);

  const css = readRendererFile('styles.css');
  // No standalone .hub-secret-field layout rule — settings-field handles it
  assert.doesNotMatch(css, /\.hub-secret-field\s*\{/);

  const sharedInputRule = cssRulesForSelector(css, '.settings-panel input').find(rule => (
    declaration(rule, 'width') === '100%'
      && declaration(rule, 'min-width') === '0'
      && declaration(rule, 'padding') === '7px 8px'
      && declaration(rule, 'border') === '1px solid var(--line)'
      && declaration(rule, 'border-radius') === '6px'
      && declaration(rule, 'background') === 'rgba(var(--sunken-rgb), 0.48)'
  ));
  assert.ok(sharedInputRule, 'settings inputs should use the shared control styling');
  assert.equal(declaration(sharedInputRule, 'width'), '100%');
  assert.equal(declaration(sharedInputRule, 'min-width'), '0');
  assert.equal(declaration(sharedInputRule, 'padding'), '7px 8px');
  assert.equal(declaration(sharedInputRule, 'border'), '1px solid var(--line)');
  assert.equal(declaration(sharedInputRule, 'border-radius'), '6px');
  assert.equal(declaration(sharedInputRule, 'background'), 'rgba(var(--sunken-rgb), 0.48)');

  const secretRowRule = cssRule(css, '.settings-panel .hub-secret-row input');
  assert.equal(declaration(secretRowRule, 'flex'), '1 1 0');
  assert.equal(declaration(secretRowRule, 'width'), '0');
  assert.equal(declaration(secretRowRule, 'min-width'), '0');
  assert.equal(declaration(secretRowRule, 'padding'), '');
  assert.equal(declaration(secretRowRule, 'font-size'), '');

  const app = readRendererFile('app.js');
  const start = app.indexOf("els.secretPasteButton?.addEventListener('click', async () => {");
  const end = app.indexOf("els.limitsRefreshInput.addEventListener('change', async () => {", start);
  assert.notEqual(start, -1, 'secret paste handler should exist');
  assert.notEqual(end, -1, 'secret paste handler should end before limits refresh handler');
  const pasteBody = app.slice(start, end);
  assert.match(pasteBody, /const text = await navigator\.clipboard\.readText\(\);/);
  assert.match(pasteBody, /els\.secretInput\.value = text\.trim\(\);/);
  assert.match(pasteBody, /markHubDraftDirty\('secret'\);/);
});

test('Cursor account header uses the shared linked-account summary', () => {
  const body = functionBody(readRendererFile('app.js'), 'renderCursorStatus', 'refreshCursorStatus');
  assert.match(body, /t\('settings\.cursor\.connected', \{ linked: status\.linkedCount \|\| 0, total: accounts\.length \}\)/);
  assert.match(body, /setCursorStatusText\(statusEl, summary\);/);
  assert.doesNotMatch(body, /status\.email|billingCycleEnd|billingResets|selectedAccountId/);
});

test('Cursor settings use the shared multi-account rows and inline add flow', () => {
  const html = readRendererFile('index.html');
  const details = html.match(/<div id="cursorSettingsDetails"[\s\S]*?<div id="cursorErrorMessage" class="settings-note error hidden"><\/div>/)?.[0] || '';
  assert.match(details, /id="cursorAddAccountButton" class="opencode-add-summary"[^>]*aria-expanded="false"[^>]*aria-controls="cursorManualDetails"/);
  assert.match(details, /<svg class="add-icon"/);
  assert.doesNotMatch(details, /cursorRefreshButton|>Refresh<|>重新整理</);
  assert.match(details, /id="cursorAccountList" class="managed-account-list"/);
  assert.match(details, /id="cursorAgentActiveNote" class="settings-note hidden" data-i18n="settings\.cursor\.agentActive"/);
  assert.match(details, /<div id="cursorManualPanel" class="opencode-add-form">/);
  assert.match(details, /<div id="cursorManualDetails" class="opencode-add-details accordion-animated-container hidden">/);
  assert.match(details, /data-i18n="settings\.cursor\.addManual">Add account<\/span>/);
  assert.match(details, /using the button above, then sign in/);
  assert.match(details, /cursor\.com\/dashboard/);
  assert.doesNotMatch(details, /cursor\.com\/dashboard\/settings/);
  assert.doesNotMatch(details, /Tokscale|Add an account manually/);
  assert.doesNotMatch(details, /<details|<summary|cursorDetectButton|cursorManualLabel|accountLabel/);

  const body = functionBody(readRendererFile('app.js'), 'renderCursorStatus', 'refreshCursorStatus');
  assert.match(body, /input\.className = 'managed-account-checkbox'/);
  assert.match(body, /window\.tokenMonitor\.cursor\.setAccountEnabled\(account\.id, input\.checked\)/);
  assert.match(body, /right\.className = 'managed-account-right'/);
  assert.match(body, /info\.className = 'managed-account-info'/);
  assert.match(body, /const planLabel = account\.membershipType/);
  assert.match(body, /: planLabel;/);
  assert.doesNotMatch(body, /managed-account-detail|settings\.cursor\.linked/);
  assert.match(body, /if \(account\.removable === true && !managementBlocked\)/);
  assert.match(body, /remove\.className = 'managed-account-remove'/);
  assert.match(body, /window\.tokenMonitor\.cursor\.logout\(account\.id\)/);
  assert.doesNotMatch(body, /cursor-account-row|radio|selectedAccountId|selectAccount/);

  const setup = readRendererFile('app.js');
  assert.match(setup, /openExternal\('https:\/\/cursor\.com\/dashboard'\)/);
  assert.doesNotMatch(setup, /openExternal\('https:\/\/cursor\.com\/dashboard\/settings'\)/);
  assert.match(setup, /cursorAddAccountButton\?\.addEventListener\('click'/);
  assert.match(setup, /cursorManualDetails\?\.classList\.toggle\('hidden', !next\)/);
  assert.match(setup, /const expanding = !state\.cursorAccountExpanded;[\s\S]*?setCursorAccountExpanded\(expanding\);[\s\S]*?if \(expanding && !state\.cursorAccount\.busy\) void refreshCursorStatus\(\{ discover: true \}\);/);
  assert.doesNotMatch(setup, /cursorRefreshButton|refreshCursorAccounts|cursor\.refresh\(/);

  const css = readRendererFile('styles.css');
  assert.equal(declaration(cssRule(css, '#cursorManualDetails'), 'margin-top'), '0');
});

test('Cursor removal is available only for accounts added manually in Token Monitor', () => {
  const main = readRendererFile('../main.js');
  assert.match(main, /cursorManualAccountIds: \[\]/);
  assert.match(main, /removable: manual\.has\(account\.id\)/);
  assert.match(main, /settings\.cursorManualAccountIds = normalizeCursorAccountIds\(\[/);
  assert.match(main, /Only manually added Cursor accounts can be removed/);
  assert.match(main, /ipcMain\.handle\('cursor:loginManual'[\s\S]*?if \(isExternalAgentActive\(\)\)/);
  assert.match(main, /ipcMain\.handle\('cursor:logout'[\s\S]*?if \(isExternalAgentActive\(\)\)/);
  const body = functionBody(readRendererFile('app.js'), 'renderCursorStatus', 'refreshCursorStatus');
  assert.match(body, /addButton\.disabled = managementBlocked/);
  assert.match(body, /cursorAgentActiveNote'[\s\S]*?toggle\('hidden', !managementBlocked\)/);
});

test('Cursor account discovery runs automatically without a separate refresh action', () => {
  const main = readRendererFile('../main.js');
  const statusBody = functionBody(main, 'cursorStatusValue', 'rebuildWindow');
  assert.match(statusBody, /if \(discover && !managementBlocked\) \{/);
  assert.match(statusBody, /await cursorAuth\.runCursorDiscover\(\)/);
  assert.doesNotMatch(statusBody, /runCursorSync/);
  assert.match(statusBody, /managementBlocked/);
  assert.match(main, /options\?\.discover !== true/);
  assert.doesNotMatch(main, /ipcMain\.handle\('cursor:refresh'/);

  const preload = readRendererFile('../preload.js');
  assert.doesNotMatch(preload, /cursor:refresh/);
});

test('OpenCode account panel provides multi-profile management', () => {
  const html = readRendererFile('index.html');
  const details = html.match(/<div id="opencodeSettingsDetails"[\s\S]*?<div id="opencodeErrorMessage" class="settings-note error hidden"><\/div>/)?.[0] || '';
  assert.match(details, /<div id="opencodeProfileList" class="opencode-profile-list"><\/div>/);
  assert.match(details, /<div id="opencodeAddForm" class="opencode-add-form">/);
  assert.match(details, /<button id="opencodeAddToggle" class="opencode-add-summary" type="button" aria-expanded="false" aria-controls="opencodeAddDetails">/);
  assert.match(details, /<div id="opencodeAddDetails" class="opencode-add-details accordion-animated-container hidden">/);
  // The browser button serves both credential types, so it lives above the
  // selector rather than inside either block; the renderer relabels it.
  assert.match(details, /<button id="opencodeOpenBrowser" data-i18n="settings\.opencode\.openBrowserKeys">/);
  const cookieBlock = details.match(/<div id="opencodeCookieFields"[\s\S]*?<\/textarea>/)?.[0] || '';
  assert.doesNotMatch(cookieBlock, /opencodeOpenBrowser/);
  assert.match(details, /<span data-i18n="settings\.opencode\.addProfile"/);
  assert.match(details, /<input id="opencodeProfileName" type="text"[\s\S]*data-i18n-placeholder="settings\.opencode\.profileNamePlaceholder"/);
  // Credential type is a labelled select like the other provider forms use, and
  // API key is first so it is the default. Each type owns its own input.
  assert.match(details, /<select id="opencodeCredentialKind">\s*<option value="api"/);
  assert.match(details, /<option value="cookie" data-i18n="settings\.opencode\.kindCookie">/);
  assert.match(details, /<input id="opencodeApiKeyInput" type="password"[\s\S]*data-i18n-placeholder="settings\.opencode\.apiKeyPlaceholder"/);
  assert.match(details, /<textarea id="opencodeCookieInput"[\s\S]*data-i18n-placeholder="settings\.opencode\.cookiePlaceholder"/);
  // Neither credential field is named by the nearest `<label for>` — that one
  // points at the credential-type select — so each carries its own accessible
  // name, translated by the same pass that translates the placeholders.
  assert.match(details, /<input id="opencodeApiKeyInput"[^>]*data-i18n-aria-label="settings\.opencode\.kindApi"/);
  assert.match(details, /<textarea id="opencodeCookieInput"[^>]*data-i18n-aria-label="settings\.opencode\.kindCookie"/);
  // The cookie steps live inside the block that hides, so API mode never shows
  // DevTools instructions. This stylesheet has no global `.hidden`.
  assert.match(details, /<div id="opencodeCookieFields" class="opencode-credential-fields hidden">/);
  const css = readRendererFile('styles.css');
  assert.match(css, /\.opencode-credential-fields\.hidden \{ display: none; \}/);
  assert.match(details, /<div class="settings-actions">\s*<button id="opencodeCookieSubmit" data-i18n="settings\.opencode\.saveProfile">/);
  assert.match(details, /<div id="opencodeErrorMessage" class="settings-note error hidden"><\/div>/);

  const app = readRendererFile('app.js');
  assert.match(app, /function renderOpenCodeProfiles\(\)/);
  assert.match(app, /function updateOpenCodeProfilesStatus\(\)/);
  assert.match(app, /function renderOpenCodeAccountGroup\(/);
  assert.match(app, /function setOpencodeCookieExpanded\(/);

  const setupBody = functionBodyBeforeMarker(app, 'setupCursorAccountUI', '\nsetupCursorAccountUI();');
  assert.match(setupBody, /document\.getElementById\('opencodeAddToggle'\)/);
  assert.match(setupBody, /addDetails\?\.classList\.toggle\('hidden'/);
  assert.match(setupBody, /document\.getElementById\('opencodeOpenBrowser'\)\?\.addEventListener\('click'/);
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\('https:\/\/opencode\.ai\/auth'\)/);
  // The add form asks before binding: main refuses a name that already holds a
  // different credential, and the form offers the confirmation rather than
  // retrying with merge on its own.
  assert.match(setupBody, /window\.tokenMonitor\.opencode\.saveProfile\(\s*name,\s*cookie,\s*opencodeCredentialKind,\s*\{ merge \}\s*\)/);
  assert.match(setupBody, /await submit\(false\);/);
  assert.match(setupBody, /if \(result\.nameTaken && addMergeOffer\)/);
  assert.match(setupBody, /confirmOpenCodeMerge = \(\) => submit\(true\);/);
  // `submit` closes over the name and credential captured when Save was pressed,
  // so any edit afterwards has to withdraw the offer: the backend still demands
  // `merge`, but the click it receives would otherwise be consent to a proposal
  // that is no longer on screen. Withdrawing has to outlast the round trip too,
  // since the reply that offers the button arrives after the edit — hence the
  // revision captured before the await and checked in every branch after it.
  assert.match(setupBody, /const at = addMergeOffer\?\.revision\(\);/);
  assert.match(setupBody, /const stale = addMergeOffer \? addMergeOffer\.stale\(at\) : false;/);
  assert.match(setupBody, /if \(stale\) return;/);
  // A success takes down its own offer and nothing else. Two saves can overlap
  // and the newer one can answer first, so clearing unconditionally let an older
  // success wipe a confirmation the user was looking at and that was still live.
  assert.match(setupBody, /if \(!stale\) \{\s*input\.value = '';\s*nameInput\.value = '';\s*addMergeOffer\?\.withdraw\(\);\s*\}/);
  assert.match(setupBody, /addMergeOffer\.offer\(at, name, t\('settings\.opencode\.mergeInto', \{ name \}\)\)/);
  assert.match(setupBody, /const clearOpenCodeMergeOffer = \(\) => addMergeOffer\?\.withdraw\(\);/);
  assert.match(setupBody, /for \(const id of \['opencodeProfileName', 'opencodeApiKeyInput', 'opencodeCookieInput'\]\)/);
  assert.match(setupBody, /addEventListener\('input', clearOpenCodeMergeOffer\)/);
  // Switching credential type already clears the hidden field; it clears this too.
  assert.match(setupBody, /clearOpenCodeMergeOffer\(\);\s*\};/);
  assert.match(setupBody, /kindSelect\?\.addEventListener\('change', applyOpenCodeCredentialKind\)/);
  // The account name is required, not defaulted. Saving one credential keeps the
  // other under that name and the collector reads that as "same account", so a
  // blank name silently becoming 'default' could bind one account's key to
  // another account's cookie. Scoped to this handler: the other provider forms
  // still default a blank name, and they have no such merge semantics.
  const opencodeSubmit = setupBody.slice(
    setupBody.indexOf("document.getElementById('opencodeCookieSubmit')"),
    setupBody.indexOf("document.getElementById('openrouterSettingsToggle')")
  );
  assert.ok(opencodeSubmit, 'opencode submit handler should be present');
  assert.match(opencodeSubmit, /const name = \(nameInput\.value \|\| ''\)\.trim\(\);/);
  assert.doesNotMatch(opencodeSubmit, /\|\| 'default'/);
  assert.match(opencodeSubmit, /settings\.opencode\.nameRequired/);
  assert.match(setupBody, /renderOpenCodeProfiles\(\)/);
  assert.match(setupBody, /updateOpenCodeProfilesStatus\(\)/);
});

test('OpenCode multi-account rows separate profile identity from plan label', () => {
  const app = readRendererFile('app.js');
  const titleBody = functionBody(app, 'opencodeAccountTitle', 'renderOpenCodeAccountGroup');
  const groupBody = functionBody(app, 'renderOpenCodeAccountGroup', 'renderLimits');

  assert.match(titleBody, /provider\?\.accountName/);
  assert.match(titleBody, /legacyName !== 'Go' && legacyName !== 'Zen'/);
  assert.match(groupBody, /limitAccountTitle\('opencode', provider, index, providers\)/);
  assert.match(groupBody, /legacyProfileLabel/);
  assert.match(groupBody, /planText: ''/);
  assert.match(app, /provider\?\.planLabel \|\| provider\?\.accountLabel/);
  assert.doesNotMatch(groupBody, /renderLimitProviderRow\('opencode', provider\.accountLabel/);
});

test('OpenCode disabled profiles still count in the account summary', () => {
  const app = readRendererFile('app.js');
  const renderBody = functionBody(app, 'renderOpenCodeProfiles', 'updateOpenCodeProfilesStatus');
  // The auto-detected credential counts too: it is the account the limits card
  // is reading, so excluding it reports "not set up" next to live quota.
  assert.match(renderBody, /state\.opencodeProfileCount = entries\.length \+ \(hasAmbientKey \? 1 : 0\);/);
  assert.match(renderBody, /\{ profiles, hasEnvVar, hasAmbientKey, ambientEnabled = true \}/);
  // Switching the auto-detected account off is a device preference, not a stored
  // credential, so its row keeps rendering with the box clear rather than
  // vanishing along with the only control that could switch it back on.
  assert.match(renderBody, /ambientToggle\.checked = ambientEnabled;/);
  assert.match(renderBody, /setAmbientEnabled\(ambientToggle\.checked\)/);
  assert.match(renderBody, /item\.append\(ambientToggle, nameBox, rightBox\)/);
  assert.match(renderBody, /if \(entries\.length === 0 && !hasEnvVar && !hasAmbientKey\)/);
  // Credential composition stays visible after the fact, because two kinds under
  // one name is a user assertion that changes identity and fallback behaviour,
  // and each is removable so undoing it does not cost the one being kept.
  assert.match(renderBody, /\['ambient', profile\.usesAmbientKey, ambientLabel\]/);
  assert.match(renderBody, /profile\.ambientStale/);
  assert.match(renderBody, /\['api', profile\.hasApiKey/);
  assert.match(renderBody, /\['cookie', profile\.hasCookie/);
  // Per-credential actions live in an expanded section, not inline beside the
  // account's own controls, and only appear once there is more than one. The
  // summary line is itself the control that expands it.
  assert.match(renderBody, /const multiCredential = credentials\.length > 1;/);
  assert.match(renderBody, /opencodeCredentialRow\(name, kind, label\)/);
  assert.match(renderBody, /detail\.classList\.toggle\('is-open', open\)/);
  // Naming the auto-detected credential is what lets it join an account, and a
  // name that already exists is a binding, so it waits for the confirmation
  // instead of merging on a blur that happened to land on that name.
  assert.match(renderBody, /saveProfile\(name, '', 'ambient', \{ merge \}\)/);
  assert.match(renderBody, /await applyNaming\(name, false\)/);
  assert.match(renderBody, /opencodeMergeOffer\(mergeBtn, \(name\) => applyNaming\(name, true\)\)/);
  assert.match(renderBody, /opencodeMergeOffer\(mergeBtn, \(next\) => applyRename\(next, true\)\)/);
  // A confirmation has to confirm what is on screen, so editing the name
  // withdraws the pending offer instead of leaving a button that would commit
  // the account name the user has already moved on from. Every path goes through
  // the one helper: the rule reached four call sites by copy, and each copy is
  // another place an in-flight reply can put a withdrawn offer back on screen.
  // Nothing else may reveal a merge button, which is what makes that exhaustive.
  assert.equal((app.match(/opencodeMergeOffer\(/g) || []).length, 5);
  assert.equal((app.match(/mergeBtn\.classList\.remove\('hidden'\)/g) || []).length, 0);
  // Three inline name fields (the auto-detected row, an account rename, a
  // credential move); the add form withdraws through its own named helper.
  assert.equal((app.match(/nameInput\.addEventListener\('input', \(\) => offer\.withdraw\(\)\);/g) || []).length, 3);
  assert.equal((app.match(/const at = offer\.revision\(\);/g) || []).length, 3);
  assert.doesNotMatch(renderBody, /pendingName|pendingMergeName|pendingTarget/);
  // Its status element cannot be produced by sanitizing any account name.
  assert.match(renderBody, /infoSpan\.id = 'opencodeAmbientInfo'/);
  // Merging is confirmed with a button the user chooses, not a repeated keypress.
  assert.match(renderBody, /settings\.opencode\.mergeInto/);
  assert.doesNotMatch(renderBody, /mergeConfirm/);

  const credentialRow = functionBody(app, 'opencodeCredentialRow', 'updateOpenCodeProfilesStatus');
  // Renaming a credential moves it to another account: to a fresh name it splits
  // off, onto an existing one it binds — the same operation either way.
  assert.match(credentialRow, /api\.moveCredential\(accountName, kind, target, \{ merge \}\)/);
  assert.match(credentialRow, /api\.removeCredential\(accountName, kind\)/);
  assert.match(credentialRow, /opencodeMergeOffer\(mergeBtn, \(target\) => finishMove\(target, true\)\)/);
  assert.match(credentialRow, /nameInput\.addEventListener\('input', \(\) => offer\.withdraw\(\)\);/);
  assert.match(credentialRow, /if \(offer\.stale\(at\)\) return;/);
  assert.doesNotMatch(credentialRow, /pendingTarget/);
  // Unbinding is not undoable from here, so it confirms like deleting an account.
  assert.match(credentialRow, /if \(!confirming\)/);
  assert.match(renderBody, /api\.setProfileEnabled\(name, toggle\.checked\)\.then\(\(\) => \{/);
  assert.match(renderBody, /updateOpenCodeProfilesStatus\(\);/);
  assert.doesNotMatch(renderBody, /if \(toggle\.checked\) updateOpenCodeProfilesStatus\(\)/);

  const statusBody = functionBody(app, 'updateOpenCodeProfilesStatus', 'renderCursorStatus');
  assert.match(statusBody, /const configuredProfileCount = state\.opencodeProfileCount \|\| 0;/);
  // The auto-detected account arrives in its own field, so both halves of the
  // summary have to include it or a zero-config machine reports "0/0" beside
  // live quota.
  assert.match(statusBody, /if \(status\.ambient\) entries\.push\(\['opencodeAmbientInfo', status\.ambient\]\)/);
  assert.match(statusBody, /renderOpenCodeProfilesStatusSummary\(profiles, status\.ambient\)/);
  assert.match(statusBody, /const statuses = \[\.\.\.Object\.values\(profiles\), \.\.\.\(ambient \? \[ambient\] : \[\]\)\];/);
  assert.match(statusBody, /Math\.max\(statuses\.length, configuredProfileCount\)/);
  assert.match(statusBody, /t\('settings\.opencode\.connected', \{ linked: linkedCount, total: totalCount \}\)/);
});

test('OpenCode profile deletion clears the legacy default cookie when it owns the profile', () => {
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const handler = main.slice(
    main.indexOf("ipcMain.handle('opencode:deleteProfile'"),
    main.indexOf("ipcMain.handle('opencode:renameProfile'")
  );
  assert.ok(handler, 'opencode:deleteProfile handler should exist');
  assert.match(handler, /const deletedProfile = opencodeProfiles\.readProfile\(profiles, name\);/);
  assert.match(handler, /if \(deletedProfile\?\.cookie && settings\.opencodeCookie === deletedProfile\.cookie\) \{/);
  assert.match(handler, /settings\.opencodeCookie = '';/);
});

test('OpenCode profile enable toggles refresh only the affected limits lane', () => {
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const handler = main.slice(
    main.indexOf("ipcMain.handle('opencode:setProfileEnabled'"),
    main.indexOf("ipcMain.handle('codex:accounts'")
  );
  assert.ok(handler, 'opencode:setProfileEnabled handler should exist');
  // Read through the module's own-property lookup. A bare `profiles[name]`
  // resolves an inherited key, so an account named `__proto__` passed the
  // "not found" guard and then wrote `enabled` onto a shared prototype.
  assert.match(handler, /const profile = opencodeProfiles\.readProfile\(profiles, name\);/);
  assert.match(handler, /profile\.enabled = Boolean\(enabled\);/);
  assert.match(handler, /saveSettings\(\{ throwOnError: true \}\);/);
  assert.match(handler, /opencodeStatusCache = \{ value: null, at: 0 \};/);
  assert.match(handler, /queueLimitInvalidation\(\{ provider: 'opencode', accountName: name \}, 'profile-state'/);
  assert.match(handler, /clear: !enabled/);
  assert.match(handler, /refresh: Boolean\(enabled\)/);
  assert.doesNotMatch(handler, /startMode\(\)/);
});

test('Codex account panel supports per-account enable toggles without showing timestamps', () => {
  const app = readRendererFile('app.js');
  const body = functionBody(app, 'renderCodexAccounts', 'refreshCodexAccounts');
  assert.match(body, /const enabledCount = accounts\.filter\(account => account\.enabled !== false\)\.length;/);
  assert.match(body, /t\('settings\.opencode\.connected', \{ linked: enabledCount, total: accounts\.length \}\)/);
  assert.doesNotMatch(body, /t\('settings\.codex\.accountMany'/);
  assert.match(body, /input\.type = 'checkbox'/);
  assert.match(body, /input\.className = 'managed-account-checkbox'/);
  assert.match(body, /input\.checked = account\.enabled !== false/);
  assert.match(body, /window\.tokenMonitor\.codex\.setAccountEnabled\(account\.id, input\.checked\)/);
  assert.match(body, /info\.className = 'managed-account-info'/);
  assert.match(body, /account\.workspaceKind === 'personal'/);
  assert.match(body, /t\('settings\.codex\.personalWorkspace'\)/);
  assert.match(body, /account\.workspaceLabel/);
  assert.match(body, /const codexProviders = localProviderStatuses\('codex'\);/);
  assert.match(body, /accountIdentityApi\.codexManagedAccountPlanLabel\(account, codexProviders\)/);
  assert.match(body, /: t\('settings\.codex\.disabled'\)/);
  assert.match(body, /info\.textContent = accountMetadata\.join\(' · '\);/);
  assert.match(body, /right\.append\(info, remove\)/);
  assert.match(body, /row\.append\(input, main, right\)/);
  assert.doesNotMatch(
    body,
    /setAccountEnabled\(account\.id, input\.checked\)[\s\S]*?refreshStats\(\{ force: true \}\)[\s\S]*?const remove/,
    'Codex enable toggles should update the account row like OpenCode, not force-refresh all stats'
  );
  assert.doesNotMatch(body, /formatTime\(account\.updatedAt\)/);
  assert.match(body, /remove\.className = 'managed-account-remove'/);
  assert.match(body, /remove\.textContent = '✕'/);
  assert.match(body, /let confirmingRemove = false;/);
  assert.match(body, /remove\.classList\.add\('confirming'\)/);
  assert.match(body, /remove\.textContent = '✓'/);
  assert.doesNotMatch(body, /remove\.textContent = t\('settings\.codex\.remove'\)/);
  assert.doesNotMatch(
    body,
    /removeAccount\(account\.id\)[\s\S]*?await refreshStats\(\{ force: true \}\)[\s\S]*?renderCodexAccounts\(\)/,
    'Codex remove should redraw the account list before any full stats refresh'
  );
  assert.match(body, /refreshStats\(\{ force: true \}\)\.catch\(\(\) => \{\}\);/);

  const preload = fs.readFileSync(path.join(rendererDir, '..', 'preload.js'), 'utf8');
  assert.match(preload, /setAccountEnabled: \(id, enabled\) => ipcRenderer\.invoke\('codex:setAccountEnabled', id, enabled\)/);

  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('codex:setAccountEnabled'/);
  assert.match(main, /setCodexManagedAccountEnabled\(id, enabled\)/);
});

test('Codex account email masking is an opt-in display-only setting', () => {
  const app = readRendererFile('app.js');
  const html = readRendererFile('index.html');
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');

  assert.match(html, /<input id="maskLimitAccountEmailsInput" type="checkbox" \/>/);
  assert.match(html, /data-i18n="settings\.limits\.maskAccountEmails"/);

  const defaults = functionBody(main, 'defaultSettings', 'normalizeCollectionMode');
  assert.match(defaults, /maskLimitAccountEmails:\s*false/);

  const updateHandler = main.slice(
    main.indexOf("ipcMain.handle('settings:update'"),
    main.indexOf("ipcMain.handle('settings:openConfig'")
  );
  assert.match(updateHandler, /maskLimitAccountEmails:\s*parseBoolean\(patch\.maskLimitAccountEmails \?\? settings\.maskLimitAccountEmails, false\)/);
  assert.doesNotMatch(updateHandler, /accountEmail|accountKey|syncLimits|publicLimits/);

  const settingsBody = functionBody(app, 'syncSettingsForm', 'enabledClientSet');
  assert.match(settingsBody, /els\.maskLimitAccountEmailsInput\.checked = Boolean\(state\.settings\.maskLimitAccountEmails\);/);

  assert.match(app, /maskLimitAccountEmailsInput: document\.getElementById\('maskLimitAccountEmailsInput'\)/);
  assert.match(app, /els\.maskLimitAccountEmailsInput\.addEventListener\('change'/);
  assert.match(app, /saveSettings\(\{ maskLimitAccountEmails: els\.maskLimitAccountEmailsInput\.checked \}\)/);
  assert.match(app, /renderLimits\(\);/);

  // Title rendering for every provider lives in limitAccountTitles.test.js.
});

test('Codex system account switching is exposed from limits account rows', () => {
  const app = readRendererFile('app.js');
  const renderHead = functionBody(app, 'renderLimitProviderHead', 'renderProviderWindows');
  assert.match(renderHead, /if \(activeCodexAccount\)/);
  assert.doesNotMatch(renderHead, /showActiveAccount/);
  assert.match(renderHead, /activeZone\.className = 'limit-account-active-zone'/);
  assert.match(renderHead, /activePopover\.className = 'limit-account-active-popover'/);
  assert.match(renderHead, /const activeHint = t\('limits\.codex\.activeAccountHint'\)/);
  assert.match(renderHead, /activePopover\.textContent = activeHint/);
  assert.match(renderHead, /activeZone\.addEventListener\('pointerenter', markCodexActiveHintOpened\)/);
  assert.match(renderHead, /activeZone\.addEventListener\('focusin', markCodexActiveHintOpened\)/);
  assert.match(renderHead, /activeZone\.addEventListener\('pointerleave', releaseCodexActiveHint\)/);
  assert.match(renderHead, /activeZone\.addEventListener\('focusout', releaseCodexActiveHint\)/);
  assert.match(renderHead, /activeZone\.matches\(':hover, :focus-within'\)/);
  assert.match(renderHead, /activeZone\.append\(title, badge, activePopover\)/);
  assert.match(renderHead, /badge\.textContent = '\\u2713';/);
  assert.doesNotMatch(renderHead, /badge\.textContent = 'Active'/);
  // The ✓ tracks state.codexActiveAccount only (the account THIS device's Codex
  // is signed into). It must NOT re-derive "live" from the row being rendered:
  // in sync mode that row can be a remote device's record for a different account.
  assert.match(renderHead, /options\.showActiveBadge && codexActiveAccountMatchesProvider\(provider\)/);
  assert.doesNotMatch(renderHead, /!state\.codexActiveAccount && liveCodexAccount/);
  assert.doesNotMatch(renderHead, /const liveCodexAccount =/);
  assert.match(renderHead, /codexSwitchAccountForProvider\(provider\)/);
  assert.match(renderHead, /switchZone\.className = 'limit-account-switch-zone'/);
  assert.match(renderHead, /switchPopover\.className = 'limit-account-switch-popover'/);
  assert.match(renderHead, /switchButton\.className = 'limit-account-switch-button'/);
  assert.match(renderHead, /switchZone\.classList\.toggle\('has-opened', state\.codexSwitchPopoverHasOpened\)/);
  assert.match(renderHead, /state\.codexSwitchPopoverHasOpened = true;/);
  assert.match(renderHead, /state\.codexSwitchPopoverActive = true;/);
  assert.match(renderHead, /switchZone\.addEventListener\('pointerenter', markCodexSwitchPopoverOpened\)/);
  assert.match(renderHead, /switchZone\.addEventListener\('focusin', markCodexSwitchPopoverOpened\)/);
  assert.match(renderHead, /switchZone\.addEventListener\('pointerleave', releaseCodexSwitchPopover\)/);
  assert.match(renderHead, /switchZone\.addEventListener\('focusout', releaseCodexSwitchPopover\)/);
  assert.match(renderHead, /switchZone\.matches\(':hover, :focus-within'\)/);
  assert.match(renderHead, /state\.codexSwitchPopoverActive = false;/);
  assert.match(renderHead, /switchZone\.append\(title, switchPopover\)/);
  assert.match(renderHead, /window\.tokenMonitor\.codex\.switchSystemAccount\(switchAccount\.id\)/);
  assert.match(renderHead, /state\.codexActiveAccount = result\.activeAccount/);
  assert.match(renderHead, /window\.tokenMonitor\.codex\.refreshAccountLimits\(switchAccount\.id\)/);
  assert.match(renderHead, /applyCodexAccountLimitsRefresh\(refreshResult\.providers \|\| \[\]\)/);
  assert.doesNotMatch(renderHead, /refreshStats\(\{ force: true \}/);
  assert.doesNotMatch(renderHead, /titleButton\.className = 'limit-account-title-button'/);

  const group = functionBody(app, 'renderCodexAccountGroup', 'renderOpenCodeAccountGroup');
  assert.match(group, /allowSystemSwitch: true/);
  assert.match(group, /showActiveBadge: true/);

  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.match(css, /\.limit-account-switch-zone/);
  assert.match(css, /\.limit-live-badge\s*\{[^}]*display: inline-flex;/s);
  assert.match(css, /\.limit-live-badge\s*\{[^}]*width: 14px;/s);
  assert.match(css, /\.limit-live-badge\s*\{[^}]*margin-left: -6px;/s);
  assert.match(css, /html\.is-windows \.limit-live-badge\s*\{[^}]*font-size: 8px;/s);
  assert.doesNotMatch(css, /\.limit-live-badge::before/);
  assert.match(css, /\.limit-account-active-zone/);
  assert.match(css, /\.limit-account-active-popover/);
  assert.match(css, /\.limit-account-active-zone:hover \.limit-account-active-popover/);
  assert.match(css, /\.limit-account-active-zone:focus-visible \.limit-account-active-popover/);
  assert.match(css, /\.limit-account-active-zone:hover \.limit-name-title/);
  assert.match(css, /\.limit-account-active-zone:focus-visible \.limit-name-title/);
  assert.match(css, /\.limit-account-active-popover\s*\{[^}]*left: calc\(100% \+ 2px\)/s);
  assert.doesNotMatch(css, /\.limit-account-active-popover\s*\{[^}]*cursor: pointer/s);
  assert.match(css, /\.limit-account-switch-popover/);
  assert.match(css, /\.limit-account-switch-zone:hover \.limit-account-switch-popover/);
  assert.match(css, /\.limit-account-switch-zone:focus-within \.limit-account-switch-popover/);
  assert.match(css, /\.limit-account-switch-zone:hover \.limit-name-title/);
  assert.match(css, /\.limit-account-switch-zone:focus-within \.limit-name-title/);
  assert.match(css, /text-shadow: 0 0 10px rgba\(var\(--accent-rgb\), 0\.16\)/);
  assert.match(css, /top: 50%/);
  assert.match(cssRule(css, '.limit-account-switch-popover'), /left: calc\(100% \+ 8px\)/);
  assert.match(css, /\.limit-account-switch-zone::after\s*\{[^}]*width: 10px;/s);
  assert.doesNotMatch(css, /\.limit-account-switch-zone\.has-opened \.limit-account-switch-popover\s*\{[^}]*transition: none;/s);
  assert.match(css, /\.limit-account-switch-button\s*\{[^}]*rgba\(var\(--glass-rgb\), 0\.52\)/s);
  assert.match(css, /\.limit-account-switch-button\s*\{[^}]*border: 1px solid rgba\(var\(--line-rgb\), 0\.18\)/s);
  assert.match(css, /\.limit-account-switch-button/);
  assert.doesNotMatch(cssRule(css, '.limit-account-switch-popover'), /left: calc\(100% \+ 6px\)/);
  assert.doesNotMatch(css, /background: rgba\(24, 28, 32, 0\.9\)/);
  assert.doesNotMatch(css, /\.limit-account-switch-popover\s*\{[^}]*border:/s);
  assert.doesNotMatch(css, /\.limit-account-title-button\s*\{/);

  const i18n = fs.readFileSync(path.join(rendererDir, 'i18n.js'), 'utf8');
  assert.match(i18n, /'limits\.codex\.switchAccount': 'Switch'/);
  assert.match(i18n, /'limits\.codex\.activeAccountHint': 'Local'/);
  assert.match(i18n, /'limits\.codex\.switchAccount': '切換帳號'/);
  assert.match(i18n, /'limits\.codex\.activeAccountHint': '本機'/);
  assert.match(i18n, /'limits\.codex\.switchAccount': '切换账号'/);
  assert.match(i18n, /'limits\.codex\.activeAccountHint': '本机'/);

  const preload = fs.readFileSync(path.join(rendererDir, '..', 'preload.js'), 'utf8');
  assert.match(preload, /switchSystemAccount: \(id\) => ipcRenderer\.invoke\('codex:switchSystemAccount', id\)/);
  assert.match(preload, /refreshAccountLimits: \(id\) => ipcRenderer\.invoke\('codex:refreshAccountLimits', id\)/);

  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('codex:switchSystemAccount'/);
  assert.match(main, /switchCodexSystemAccount\(id\)/);
  assert.match(main, /ipcMain\.handle\('codex:refreshAccountLimits'/);
  assert.match(main, /refreshCodexManagedAccountLimits\(id\)/);
  assert.match(app, /codexSwitchPopoverHasOpened: false/);
  assert.match(app, /codexSwitchPopoverActive: false/);
  assert.match(app, /codexSwitchPopoverRenderPending: false/);
  assert.match(app, /const CODEX_PENDING_ACTIVE_GRACE_MS = 30000;/);
  assert.match(app, /codexPendingActiveAccount: null/);
  assert.match(app, /codexPendingActiveAccountUntil: 0/);
  assert.match(app, /codexPendingActiveAccountTimer: null/);
  assert.match(app, /function codexAccountsShareIdentity\(left, right\)/);
  assert.match(app, /function clearCodexPendingActiveAccount\(\)/);
  assert.match(app, /function scheduleCodexPendingActiveAccountExpiry\(\)/);
  assert.match(app, /function setCodexPendingActiveAccount\(account\)/);
  assert.match(app, /function applyCodexActiveAccountFromStats\(\)/);
  const pendingExpiryBody = functionBody(app, 'scheduleCodexPendingActiveAccountExpiry', 'setCodexPendingActiveAccount');
  assert.match(pendingExpiryBody, /setTimeout\(\(\) =>/);
  assert.match(pendingExpiryBody, /applyCodexActiveAccountFromStats\(\);/);
  assert.match(pendingExpiryBody, /renderLimits\(\);/);
  const pendingSetBody = functionBody(app, 'setCodexPendingActiveAccount', 'applyCodexActiveAccountFromStats');
  assert.match(pendingSetBody, /state\.codexPendingActiveAccountUntil = Date\.now\(\) \+ CODEX_PENDING_ACTIVE_GRACE_MS;/);
  assert.match(pendingSetBody, /scheduleCodexPendingActiveAccountExpiry\(\);/);
  const activeStatsBody = functionBody(app, 'applyCodexActiveAccountFromStats', 'applyCodexAccountLimitsRefresh');
  assert.match(activeStatsBody, /Date\.now\(\) < state\.codexPendingActiveAccountUntil/);
  assert.match(activeStatsBody, /state\.codexActiveAccount = pendingAccount;/);
  assert.match(activeStatsBody, /clearCodexPendingActiveAccount\(\);/);
  assert.match(activeStatsBody, /state\.codexActiveAccount = activeAccount;/);
  const limitsRefreshBody = functionBody(app, 'applyCodexAccountLimitsRefresh', 'renderLimitProviderHead');
  assert.match(limitsRefreshBody, /applyCodexActiveAccountFromStats\(\);/);
  assert.match(renderHead, /setCodexPendingActiveAccount\(result\.activeAccount \|\| null\);/);
  const switchHold = functionBody(app, 'codexSwitchPopoverShouldHoldRender', 'flushPendingCodexSwitchPopoverRender');
  const switchFlush = functionBody(app, 'flushPendingCodexSwitchPopoverRender', 'codexResetCreditsNode');
  assert.match(switchHold, /state\.codexSwitchPopoverActive/);
  assert.match(switchHold, /\.limit-account-switch-zone:hover, \.limit-account-switch-zone:focus-within, \.limit-account-active-zone:hover, \.limit-account-active-zone:focus-within/);
  assert.match(switchFlush, /state\.codexSwitchPopoverRenderPending/);
  assert.match(switchFlush, /state\.breakdown !== 'limits'/);
  assert.match(switchFlush, /renderLimits\(\)/);
  const switchBody = functionBody(main, 'switchCodexSystemAccount', 'refreshCodexManagedAccountLimits');
  assert.match(switchBody, /const previousAccounts = normalizeCodexManagedAccounts\(settings\.codexManagedAccounts\)/);
  assert.match(switchBody, /liveAuthSnapshot = await snapshotCodexAuthFile\(liveAuthPath\)/);
  assert.match(switchBody, /preservedLiveAccount = await preserveLiveCodexAuthAsManagedAccount/);
  assert.match(switchBody, /codexAuthMaterialForWorkspace\(targetMaterial, account\.workspaceAccountId\)/);
  assert.doesNotMatch(switchBody, /workspaceIsFedramp|codexIsFedramp/);
  assert.match(switchBody, /writeCodexAuthFile\(liveAuthPath, selectedMaterial\.data\)/);
  assert.match(switchBody, /restart: false/);
  assert.match(switchBody, /settings\.codexManagedAccounts = previousAccounts;/);
  assert.match(switchBody, /restoreCodexAuthFileSnapshot\(liveAuthSnapshot\)/);
  assert.match(switchBody, /preservedLiveAccount\?\.rollback\?\.\(\)/);
  const preserveBody = functionBody(main, 'preserveLiveCodexAuthAsManagedAccount', 'codexLoginErrorMessage');
  assert.match(preserveBody, /const authSnapshot = await snapshotCodexAuthFile/);
  assert.match(preserveBody, /persist: false/);
  assert.match(preserveBody, /rollback: \(\) => restoreCodexAuthFileSnapshot/);
  const findExistingBody = functionBody(main, 'findExistingCodexAccount', 'codexAccountId');
  assert.match(findExistingBody, /codexManagedAccountMatchesIdentity\(account, identity\)/);
  assert.match(main, /codexManagedAccountMatchesIdentity/);
  const hydrateAccountsBody = functionBody(main, 'hydrateCodexManagedAccounts', 'codexAccountsForRenderer');
  assert.match(hydrateAccountsBody, /readRegularFileNoFollow\(account\.authPath/);
  assert.match(hydrateAccountsBody, /upgradeCodexManagedAccountIdentity\(account, codexAuthIdentity\(auth\)\)/);
  const ensureSettingsBody = functionBody(main, 'ensureSettingsLoaded', 'updateRendererViewState');
  assert.match(ensureSettingsBody, /hydrateCodexManagedAccounts\(persistedCodexAccounts\)/);
  assert.match(ensureSettingsBody, /saveSettings\(\)/);
  const refreshBody = functionBody(main, 'refreshCodexManagedAccountLimits', 'migrateLimitProviders');
  assert.match(refreshBody, /deviceRuntimeHandle\.refreshLimits\(\{/);
  assert.match(refreshBody, /provider: 'codex'/);
  assert.match(refreshBody, /accountId: account\.id/);
  assert.match(refreshBody, /accountKey: account\.accountKey \|\| ''/);
  assert.match(refreshBody, /result\?\.snapshot \|\| deviceRuntimeHandle\.getSnapshot\(\)\?\.limits/);
  assert.doesNotMatch(refreshBody, /codexManagedAccountsForCollector\(\)/);
  assert.doesNotMatch(refreshBody, /collectLimitsOnce/);
  const renderLimits = functionBody(app, 'renderLimits', 'serviceStatusLabel');
  assert.match(renderLimits, /const rowOptions = id === 'codex'\s*\? \{ accountTitle: true, allowSystemSwitch: true \}/s);
  assert.match(renderLimits, /renderLimitProviderRow\(id, label, provider, thirdPartyVisual\?\.color \|\| color, rowOptions\)/);
  assert.doesNotMatch(
    renderLimits,
    /renderLimitProviderRow\(id, label, provider, color, id === 'codex' \? \{[\s\S]*?showActiveBadge: true/
  );
  assert.match(renderLimits, /const holdCodexSwitchPopoverRender = codexSwitchPopoverShouldHoldRender\(\);/);
  assert.match(renderLimits, /holdLimitDetailTooltipRender \|\| holdCodexSwitchPopoverRender/);
  assert.match(renderLimits, /if \(holdCodexSwitchPopoverRender\) state\.codexSwitchPopoverRenderPending = true;/);
  assert.match(renderLimits, /state\.codexSwitchPopoverRenderPending = false;/);
});

test('DeepSeek account panel provides a first-class API key entry', () => {
  const html = readRendererFile('index.html');
  const details = html.match(/<div id="deepseekSettingsDetails"[\s\S]*?<div id="deepseekErrorMessage" class="settings-note error hidden"><\/div>/)?.[0] || '';
  assert.match(details, /<button id="deepseekOpenBrowser"[\s\S]*data-i18n="settings\.deepseek\.openBrowser">/);
  assert.match(details, /<button id="deepseekLogoutButton" class="hidden" data-i18n="settings\.deepseek\.clearApiKey">/);
  assert.match(details, /<input id="deepseekApiKeyInput" type="password"[\s\S]*data-i18n-placeholder="settings\.deepseek\.apiKeyPlaceholder"/);
  assert.match(details, /<button id="deepseekApiKeySubmit"[\s\S]*data-i18n="settings\.deepseek\.saveApiKey">/);

  const app = readRendererFile('app.js');
  const setupBody = functionBodyBeforeMarker(app, 'setupCursorAccountUI', '\nsetupCursorAccountUI();');
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\('https:\/\/platform\.deepseek\.com\/api_keys'\)/);
  assert.match(setupBody, /saveSettings\(\{ deepseekApiKey: input\.value \}\)/);
  assert.match(setupBody, /saveSettings\(\{ deepseekApiKey: '' \}\)/);
  assert.match(setupBody, /refreshStats\(\{ force: true \}\)/);
  const renderBody = functionBody(app, 'renderDeepseekStatus', 'renderOpenCodeProfiles');
  assert.match(renderBody, /const openBtn = document\.getElementById\('deepseekOpenBrowser'\);/);
  assert.match(renderBody, /const linked = deepseekAccountLinked\(\);/);
  assert.match(renderBody, /manualPanel\.classList\.toggle\('hidden', linked\)/);
  assert.match(renderBody, /openBtn\.classList\.toggle\('hidden', linked\)/);
  assert.match(renderBody, /logoutBtn\.classList\.toggle\('hidden', !linked \|\| source !== 'settings'\)/);
  assert.match(renderBody, /refreshBtn\.classList\.toggle\('hidden', !configured\)/);
});

test('API key account entries share styling and Copilot uses the folded token entry', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');

  const animationBody = functionBodyBeforeMarker(app, 'initSettingsAnimationWrappers', '\ninitSettingsAnimationWrappers();');
  assert.match(animationBody, /'#deepseekManualPanel',\n\s*'#minimaxManualPanel',\n\s*'#zaiManualPanel',\n\s*'#zaiteamManualPanel',\n\s*'#volcengineManualPanel',\n\s*'#qoderManualPanel',\n\s*'#traeManualPanel',\n\s*'#commandcodeManualPanel',\n\s*'#kimiManualPanel'/);
  assert.doesNotMatch(animationBody, /'#mimoManualPanel'/);
  assert.doesNotMatch(animationBody, /'#copilotManualPanel'/);

  assert.match(css, /#deepseekManualPanel\.hidden,\n#minimaxManualPanel\.hidden,/);
  assert.match(css, /#minimaxManualPanel\.hidden,\n#zaiManualPanel\.hidden,\n#zaiteamManualPanel\.hidden,\n#volcengineManualPanel\.hidden,\n#qoderManualPanel\.hidden,\n#traeManualPanel\.hidden,\n#commandcodeManualPanel\.hidden,\n#ollamaManualPanel\.hidden,\n#mimoManualPanel\.hidden,\n#kimiManualPanel\.hidden,\n#copilotManualPanel\.hidden,/);
  assert.match(css, /#copilotManualPanel\.hidden,\n#copilotManualDetails\.hidden,/);
  assert.match(css, /#deepseekErrorMessage\.hidden,\n#minimaxErrorMessage\.hidden,\n#zaiErrorMessage\.hidden,\n#zaiteamErrorMessage\.hidden,\n#volcengineErrorMessage\.hidden,\n#qoderErrorMessage\.hidden,\n#traeErrorMessage\.hidden,\n#commandcodeErrorMessage\.hidden,\n#ollamaErrorMessage\.hidden,\n#kimiErrorMessage\.hidden,\n#copilotErrorMessage\.hidden,/);
  assert.match(css, /#deepseekManualPanel,\n#minimaxManualPanel,\n#zaiManualPanel,\n#zaiteamManualPanel,\n#volcengineManualPanel,\n#qoderManualPanel,\n#traeManualPanel,\n#commandcodeManualPanel,\n#ollamaManualPanel,\n#mimoManualPanel,\n#kimiManualPanel,\n#copilotManualPanel\s*\{\n\s*min-width: 0;/);
  assert.match(css, /#deepseekManualPanel > \.accordion-animation-inner,\n#minimaxManualPanel > \.accordion-animation-inner,\n#zaiManualPanel > \.accordion-animation-inner,\n#zaiteamManualPanel > \.accordion-animation-inner,\n#volcengineManualPanel > \.accordion-animation-inner,\n#qoderManualPanel > \.accordion-animation-inner,\n#traeManualPanel > \.accordion-animation-inner,\n#commandcodeManualPanel > \.accordion-animation-inner,\n#ollamaManualPanel > \.accordion-animation-inner,\n#mimoManualPanel > \.accordion-animation-inner,\n#kimiManualPanel > \.accordion-animation-inner\s*\{\n\s*display: grid;/);
  assert.doesNotMatch(css, /#copilotManualPanel > \.accordion-animation-inner/);
  assert.match(css, /#deepseekManualPanel input,\n#minimaxManualPanel input,\n#zaiManualPanel input,\n#zaiteamManualPanel input,\n#zaiApiRegionInput,\n#volcengineManualPanel input,\n#qoderManualPanel textarea,\n#qoderManualPanel select,\n#traeManualPanel input,\n#commandcodeManualPanel textarea,\n#ollamaManualPanel textarea,\n#mimoManualPanel input,\n#mimoManualPanel textarea,\n#kimiManualPanel input,\n#kimiManualPanel textarea,\n#copilotManualDetails input\s*\{[\s\S]*?font-size: 12px;/);
  assert.match(css, /#deepseekManualPanel input,\n#minimaxManualPanel input,\n#zaiManualPanel input,\n#zaiteamManualPanel input,\n#volcengineManualPanel input,\n#qoderManualPanel textarea,\n#traeManualPanel input,\n#commandcodeManualPanel textarea,\n#ollamaManualPanel textarea,\n#mimoManualPanel input,\n#mimoManualPanel textarea,\n#kimiManualPanel input,\n#kimiManualPanel textarea,\n#copilotManualDetails input\s*\{[\s\S]*?font-family: monospace;/);
  assert.match(css, /\.thirdparty-field :is\(input, select\)\s*\{[\s\S]*?font-size: 12px;/);
});

test('Copilot account panel provides GitHub sign-in plus manual token fallback', () => {
  const html = readRendererFile('index.html');
  const details = html.match(/<div id="copilotSettingsDetails"[\s\S]*?<div id="copilotErrorMessage" class="settings-note error hidden"><\/div>/)?.[0] || '';
  assert.match(details, /<button id="copilotSignInButton"[\s\S]*data-i18n="settings\.copilot\.signIn">/);
  assert.match(details, /<button id="copilotCancelSignInButton" class="hidden" data-i18n="settings\.common\.cancel">/);
  assert.match(details, /<button id="copilotLogoutButton" class="hidden" data-i18n="settings\.copilot\.logout">/);
  assert.match(details, /<pre id="copilotLoginStatus" class="codex-login-output hidden"><\/pre>/);
  assert.match(details, /<button id="copilotManualToggle"[\s\S]*aria-controls="copilotManualDetails"/);
  assert.match(details, /<div id="copilotManualDetails" class="opencode-add-details accordion-animated-container hidden">/);
  assert.match(details, /<input id="copilotApiTokenInput" type="password"[\s\S]*data-i18n-placeholder="settings\.copilot\.apiTokenPlaceholder"/);
  assert.match(details, /<button id="copilotApiTokenSubmit"[\s\S]*data-i18n="settings\.copilot\.saveToken">/);

  const app = readRendererFile('app.js');
  const setupBody = functionBodyBeforeMarker(app, 'setupCursorAccountUI', '\nsetupCursorAccountUI();');
  assert.match(setupBody, /const flowId = nextCopilotSignInFlowId\(\);/);
  assert.match(setupBody, /state\.copilotSignInFlowId = flowId;/);
  assert.match(setupBody, /window\.tokenMonitor\.copilot\.signIn\(\{ flowId \}\)/);
  assert.match(setupBody, /isCurrentCopilotSignInFlow\(status\.flowId\)/);
  assert.match(setupBody, /isCurrentCopilotSignInFlow\(result\?\.flowId \|\| flowId\)/);
  assert.match(setupBody, /window\.tokenMonitor\.copilot\.cancelSignIn\(\{ flowId \}\)/);
  assert.match(setupBody, /state\.copilotSignInFlowId = '';/);
  assert.match(setupBody, /state\.copilotSignInCancelable = true;/);
  assert.match(setupBody, /status\.phase === 'success'[\s\S]*?state\.copilotSignInCancelable = false;/);
  assert.match(setupBody, /state\.copilotAuthorizeMessage = t\('settings\.copilot\.authorize'/);
  assert.match(setupBody, /\[state\.copilotAuthorizeMessage, t\('settings\.copilot\.polling'\)\]\.filter\(Boolean\)\.join\('\\n\\n'\)/);
  assert.match(setupBody, /setCopilotManualExpanded\(false\)/);
  assert.match(setupBody, /saveSettings\(\{ copilotApiToken: input\.value \}\)/);
  assert.match(setupBody, /saveSettings\(\{ copilotApiToken: '' \}\)/);

  const renderBody = functionBody(app, 'renderCopilotStatus', 'renderDeepseekStatus');
  assert.match(renderBody, /cancelBtn\.classList\.toggle\('hidden', !state\.copilotSignInBusy \|\| !state\.copilotSignInCancelable \|\| linked\)/);
  assert.match(renderBody, /refreshBtn\.classList\.toggle\('hidden', !configured \|\| \(state\.copilotSignInBusy && !linked\)\)/);
  assert.match(renderBody, /errorEl\.textContent = state\.copilotErrorMessage \|\| '';/);
  assert.doesNotMatch(renderBody, /errorEl\.textContent = '';/);

  const statusBody = functionBody(app, 'copilotAccountStatusText', 'apiKeyAccountStatusText');
  assert.match(statusBody, /provider\?\.accountName/);
  assert.match(statusBody, /settings\.copilot\.statusSet/);

  const flowBody = functionBody(app, 'isCurrentCopilotSignInFlow', 'copilotAccountStatusText');
  assert.match(flowBody, /const current = String\(state\.copilotSignInFlowId \|\| ''\);/);
  assert.match(flowBody, /const incoming = String\(flowId \|\| ''\);/);
  assert.match(flowBody, /return current && incoming === current;/);
});

test('Z.ai, Volcengine, Qoder, Trae, and Ollama account panels are exposed in settings', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /<div id="zaiAccountGroup"[\s\S]*?<select id="zaiApiRegionInput">[\s\S]*?<input id="zaiApiKeyInput" type="password"[\s\S]*?<button id="zaiApiKeySubmit"[\s\S]*data-i18n="settings\.zai\.saveApiKey">/);
  assert.match(html, /<div id="volcengineAccountGroup"[\s\S]*?data-i18n="settings\.volcengine\.accessKeyId">API key \/ Access key ID[\s\S]*?<input id="volcengineAccessKeyInput" type="password"[\s\S]*placeholder="ark-\.\.\. or AKLT\.\.\."[\s\S]*?<input id="volcengineSecretAccessKeyInput" type="password"[\s\S]*?<input id="volcengineRegionInput" type="text"[\s\S]*?<button id="volcengineCredentialsSubmit"[\s\S]*data-i18n="settings\.volcengine\.saveCredentials">/);
  assert.match(html, /<div id="qoderAccountGroup"[\s\S]*?<select id="qoderSiteInput">[\s\S]*?<textarea id="qoderCookieInput"[\s\S]*?<button id="qoderCookieSubmit"[\s\S]*data-i18n="settings\.qoder\.saveCookie">/);
  assert.match(html, /<div id="traeAccountGroup"[\s\S]*?<input id="traeTokenInput" type="password"[\s\S]*?data-i18n-placeholder="settings\.trae\.tokenPlaceholder"[\s\S]*?<input id="traeDeviceIdInput" type="text"[\s\S]*?data-i18n-placeholder="settings\.trae\.deviceIdPlaceholder"[\s\S]*?<button id="traeTokenSubmit"[\s\S]*data-i18n="settings\.trae\.saveCredentials">/);
  const traeDetails = html.match(/<div id="traeSettingsDetails"[\s\S]*?<div id="traeErrorMessage" class="settings-note error hidden"><\/div>/)?.[0] || '';
  assert.match(traeDetails, /<strong>1\.<\/strong> <span data-i18n="settings\.trae\.step1">/);
  assert.match(traeDetails, /<strong>2\.<\/strong> <span data-i18n="settings\.trae\.step2">/);
  assert.match(traeDetails, /<strong>3\.<\/strong> <span data-i18n="settings\.trae\.step3">/);
  assert.match(traeDetails, /<strong>4\.<\/strong> <span data-i18n="settings\.trae\.step4">/);
  assert.doesNotMatch(traeDetails, /settings\.trae\.note/);
  assert.match(html, /<div id="ollamaAccountGroup"[\s\S]*?<textarea id="ollamaCookieInput"[\s\S]*?<button id="ollamaCookieSubmit"[\s\S]*data-i18n="settings\.ollama\.saveCookie">/);
  const ollamaDetails = html.match(/<div id="ollamaSettingsDetails"[\s\S]*?<div id="ollamaErrorMessage" class="settings-note error hidden"><\/div>/)?.[0] || '';
  assert.match(ollamaDetails, /<strong>1\.<\/strong> <span data-i18n="settings\.ollama\.step1">/);
  assert.match(ollamaDetails, /<strong>2\.<\/strong> <span data-i18n="settings\.ollama\.step2">/);
  assert.match(ollamaDetails, /<strong>3\.<\/strong> <span data-i18n="settings\.ollama\.step3">/);
  assert.match(ollamaDetails, /<strong>4\.<\/strong> <span data-i18n="settings\.ollama\.step4">/);
  assert.match(ollamaDetails, /placeholder="wos-session=\.\.\."/);
  assert.doesNotMatch(ollamaDetails, /settings\.ollama\.note/);
  const qoderDetails = html.match(/<div id="qoderSettingsDetails"[\s\S]*?<div id="qoderErrorMessage" class="settings-note error hidden"><\/div>/)?.[0] || '';
  assert.match(qoderDetails, /<strong>1\.<\/strong> <span data-i18n="settings\.qoder\.step1Before">[\s\S]*?<code id="qoderUsagePageHint">qoder\.com\/account\/usage<\/code>[\s\S]*?<span data-i18n="settings\.qoder\.step1After">/);
  assert.doesNotMatch(qoderDetails, /<\/code>\s*\/\s*<code>qoder\.com\.cn\/account\/usage<\/code>/);
  assert.match(qoderDetails, /<strong>2\.<\/strong> <span data-i18n="settings\.qoder\.step2">/);
  assert.match(qoderDetails, /<strong>3\.<\/strong> <span data-i18n="settings\.qoder\.step3">/);
  assert.match(qoderDetails, /<strong>4\.<\/strong> <span data-i18n="settings\.qoder\.step4">/);
  assert.doesNotMatch(qoderDetails, /settings\.qoder\.note/);
  assert.doesNotMatch(qoderDetails, /mimoAccountGroup|copilotAccountGroup/);

  const app = readRendererFile('app.js');
  const setupBody = functionBodyBeforeMarker(app, 'setupCursorAccountUI', '\nsetupCursorAccountUI();');
  assert.match(setupBody, /saveSettings\(\{ zaiApiKey: input\.value, zaiApiRegion: regionInput\?\.value \|\| 'global' \}\)/);
  assert.match(setupBody, /zaiApiRegionInput\?\.addEventListener\('change', \(\) => void saveSettings\(\{ zaiApiRegion: zaiApiRegionInput\.value \|\| 'global' \}\)\)/);
  assert.match(setupBody, /const accessKeyValue = String\(accessKeyInput\.value \|\| ''\)\.trim\(\);/);
  assert.match(setupBody, /\/\^AKLT\/i\.test\(accessKeyValue\) && !secretValue/);
  assert.match(setupBody, /saveSettings\(\{\s*volcengineAccessKeyId: accessKeyInput\.value,[\s\S]*?volcengineSecretAccessKey: secretInput\.value,[\s\S]*?volcengineRegion: regionInput\.value \|\| 'cn-beijing'/);
  assert.match(setupBody, /saveSettings\(\{ qoderCookie: input\.value, qoderSite: siteInput\?\.value \|\| 'global' \}\)/);
  assert.match(setupBody, /qoderSiteInput\?\.addEventListener\('change', \(\) => \{[\s\S]*?updateQoderUsagePageHint\(\);[\s\S]*?void saveSettings\(\{ qoderSite: qoderSiteInput\.value \|\| 'global' \}\);[\s\S]*?\}\)/);
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\(zaiPlatformUrl\(\)\)/);
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\(volcenginePlatformUrl\(\)\)/);
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\(qoderPlatformUrl\(\)\)/);
  assert.match(setupBody, /const deviceIdInput = document\.getElementById\('traeDeviceIdInput'\);/);
  assert.match(setupBody, /if \(!String\(tokenInput\.value \|\| ''\)\.trim\(\)\) \{[\s\S]*?settings\.trae\.missingAuthorization/);
  assert.match(setupBody, /traeAccessToken: tokenInput\.value,[\s\S]*?traeDeviceId: deviceIdInput\.value,[\s\S]*?limitProviders: limitProviderSelectionIncluding\('trae'\)/);
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\('https:\/\/www\.trae\.cn'\)/);
  assert.match(setupBody, /ollamaCookie: input\.value/);
  assert.match(setupBody, /const validation = await window\.tokenMonitor\.ollama\.validateCookie\(input\.value\);/);
  assert.match(setupBody, /if \(!validation\?\.ok\) \{[\s\S]*?clearExternalProviderCheckPending\('ollama'\);[\s\S]*?ollamaValidationError\(validation\);[\s\S]*?return;/);
  assert.match(setupBody, /limitProviders: limitProviderSelectionIncluding\('ollama'\)/);
  assert.match(setupBody, /limitsEnabled: true/);
  assert.match(setupBody, /clearExternalProviderCheckPending\('ollama'\);/);
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\(ollamaPlatformUrl\(\)\)/);

  const preload = fs.readFileSync(path.join(rendererDir, '..', 'preload.js'), 'utf8');
  assert.match(preload, /validateCookie: \(cookie\) => ipcRenderer\.invoke\('ollama:validateCookie', cookie\)/);

  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const validationHandler = main.slice(
    main.indexOf("ipcMain.handle('ollama:validateCookie'"),
    main.indexOf("ipcMain.handle('opencode:saveCookie'")
  );
  assert.match(validationHandler, /const cookie = normalizeOllamaCookie\(raw\);/);
  assert.match(validationHandler, /await fetchOllamaLimits\(\{ ollamaCookie: cookie \}, electronProviderDeps\(\{ bypassValidationCache: true \}\)\)/);
  assert.match(validationHandler, /rememberOllamaValidation\(cookie, provider\);/);
  assert.match(validationHandler, /return \{ ok: provider\.status === 'ok', status: provider\.status \};/);

  const qoderSiteBody = functionBody(app, 'selectedQoderSite', 'qoderUsagePagePath');
  assert.match(qoderSiteBody, /document\.getElementById\('qoderSiteInput'\)\?\.value/);
  assert.match(qoderSiteBody, /state\.settings\?\.qoderSite === 'cn' \? 'cn' : 'global'/);
  const qoderPathBody = functionBody(app, 'qoderUsagePagePath', 'qoderPlatformUrl');
  assert.match(qoderPathBody, /selectedQoderSite\(\) === 'cn' \? 'qoder\.com\.cn\/account\/usage' : 'qoder\.com\/account\/usage'/);
  const qoderUrlBody = functionBody(app, 'qoderPlatformUrl', 'updateQoderUsagePageHint');
  assert.match(qoderUrlBody, /return `https:\/\/\$\{qoderUsagePagePath\(\)\}`;/);

  const zaiUrlBody = functionBody(app, 'zaiPlatformUrl', 'volcenginePlatformUrl');
  assert.match(zaiUrlBody, /document\.getElementById\('zaiApiRegionInput'\)\?\.value/);
  assert.match(zaiUrlBody, /return region === 'bigmodel-cn'/);
  assert.match(zaiUrlBody, /https:\/\/bigmodel\.cn\/coding-plan\/personal\/usage/);
  assert.match(zaiUrlBody, /https:\/\/z\.ai\/manage-apikey\/coding-plan\/personal\/my-plan/);
  const volcengineUrlBody = functionBody(app, 'volcenginePlatformUrl', 'qoderPlatformUrl');
  assert.match(volcengineUrlBody, /console\.volcengine\.com\/ark\/region:ark\+cn-beijing\/openManagement/);
});

test('Command Code account panel saves a cookie, enables its provider, and opens the allowlisted usage page', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /<div id="commandcodeAccountGroup"[\s\S]*?<textarea id="commandcodeCookieInput"[\s\S]*?<button id="commandcodeCookieSubmit"[\s\S]*data-i18n="settings\.commandcode\.saveCookie">/);
  const details = html.match(/<div id="commandcodeSettingsDetails"[\s\S]*?<div id="commandcodeErrorMessage" class="settings-note error hidden"><\/div>/)?.[0] || '';
  for (const step of [1, 2, 3, 4]) {
    assert.match(details, new RegExp(`<strong>${step}\\.<\\/strong> <span data-i18n="settings\\.commandcode\\.step${step}">`));
  }
  assert.match(details, /placeholder="__Secure-commandcode_prod_\.session_token=\.\.\."/);

  const app = readRendererFile('app.js');
  const setupBody = functionBodyBeforeMarker(app, 'setupCursorAccountUI', '\nsetupCursorAccountUI();');
  assert.match(setupBody, /commandcodeCookie: input\.value,\n\s*limitProviders: limitProviderSelectionIncluding\('commandcode'\),\n\s*limitsEnabled: true/);
  assert.match(setupBody, /saveSettings\(\{ commandcodeCookie: '' \}\)/);
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\(commandcodePlatformUrl\(\)\)/);
  const urlBody = functionBody(app, 'commandcodePlatformUrl', 'ollamaValidationError');
  assert.match(urlBody, /return 'https:\/\/commandcode\.ai\/settings\/usage';/);

  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const allowlist = functionBody(main, 'isAllowedExternalUrl', 'revealWindow');
  assert.match(allowlist, /parsed\.hostname === 'commandcode\.ai' \|\| parsed\.hostname === 'www\.commandcode\.ai'/);
  // The cookie is a credential: the renderer only ever learns that one is set.
  const settingsForRenderer = functionBody(main, 'settingsForRenderer', 'pushSettingsToRenderer');
  assert.match(settingsForRenderer, /commandcodeCookie: settings\?\.commandcodeCookie \? 'set' : ''/);
  assert.match(settingsForRenderer, /commandcodeCookieConfigured: Boolean\(currentCommandcodeCookie\(\)\)/);
});

test('Kimi account panel stores web access separately and opens the allowlisted Code console', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /data-i18n="settings\.kimi\.title">Kimi Account<\/span>/);
  assert.match(html, /data-i18n="settings\.kimi\.openBrowser">Open Kimi Code Console<\/button>/);
  assert.match(html, /settings\.kimi\.step2[\s\S]*Application\/Storage[\s\S]*Cookies[\s\S]*www\.kimi\.com/);
  assert.match(html, /settings\.kimi\.step3[\s\S]*Find kimi-auth and copy its Value/);
  assert.match(html, /<div id="kimiAccountGroup"[\s\S]*?<textarea id="kimiWebAccessTokenInput" rows="3" autocomplete="off"[\s\S]*placeholder="kimi-auth=\.\.\."[\s\S]*?<button id="kimiWebAccessTokenSubmit"[\s\S]*?<details class="kimi-api-fallback">[\s\S]*?<input id="kimiApiKeyInput" type="password"[\s\S]*?<button id="kimiApiKeySubmit"[\s\S]*data-i18n="settings\.kimi\.saveApiKey">/);

  const app = readRendererFile('app.js');
  const setupBody = functionBodyBeforeMarker(app, 'setupCursorAccountUI', '\nsetupCursorAccountUI();');
  assert.match(setupBody, /saveSettings\(\{ kimiApiKey: input\.value \}\)/);
  assert.match(setupBody, /saveSettings\(\{ kimiWebAccessToken: input\.value \}\)/);
  assert.match(setupBody, /saveSettings\(\{ kimiApiKey: '', kimiWebAccessToken: '' \}\)/);
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\(kimiPlatformUrl\(\)\)/);
  const urlBody = functionBody(app, 'kimiPlatformUrl', 'renderExternalProviderStatus');
  assert.match(urlBody, /return 'https:\/\/www\.kimi\.com\/code\/console';/);

  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const allowlist = functionBody(main, 'isAllowedExternalUrl', 'revealWindow');
  assert.match(allowlist, /parsed\.hostname === 'kimi\.com' \|\| parsed\.hostname === 'www\.kimi\.com'/);
  assert.match(allowlist, /parsed\.hostname === 'ollama\.com' \|\| parsed\.hostname === 'www\.ollama\.com'/);
  assert.match(allowlist, /parsed\.pathname\.startsWith\('\/code'\)/);
});

test('Claude Web account panel stores a redacted cookie and opens only the usage page', () => {
  const html = readRendererFile('index.html');
  const details = html.match(
    /<div id="claudeAccountGroup"[\s\S]*?<div id="claudeErrorMessage" class="settings-note error hidden"><\/div>/
  )?.[0] || '';
  assert.match(details, /data-i18n="settings\.claude\.title">Claude Account<\/span>/);
  assert.match(details, /data-i18n="settings\.claude\.openBrowser">Open Claude usage in browser<\/button>/);
  assert.match(details, /settings\.claude\.note[\s\S]*detected automatically when Web login is not configured/);
  assert.match(details, /settings\.claude\.step2[\s\S]*Application\/Storage[\s\S]*Cookies[\s\S]*https:\/\/claude\.ai/);
  assert.match(details, /settings\.claude\.step3[\s\S]*Copy the sessionKey value/);
  assert.match(details, /<textarea id="claudeWebCookieInput" rows="3" autocomplete="off"[\s\S]*placeholder="sessionKey=\.\.\."/);
  assert.match(details, /<button id="claudeWebCookieSubmit"[\s\S]*data-i18n="settings\.claude\.saveCookie">/);
  assert.ok(
    html.indexOf('id="claudeAccountGroup"') < html.indexOf('id="codexAccountGroup"'),
    'Claude should follow the AI Limits provider order and appear before Codex'
  );

  const app = readRendererFile('app.js');
  const queriedDocument = {
    selectors: '',
    querySelectorAll(selectors) {
      this.selectors = selectors;
      return [];
    }
  };
  runRendererFunctions(
    app,
    ['initSettingsAnimationWrappers'],
    'initSettingsAnimationWrappers();',
    { document: queriedDocument }
  );
  assert.ok(
    queriedDocument.selectors.split(',').map(selector => selector.trim()).includes('#claudeManualPanel'),
    'Claude manual panel should receive the shared accordion wrapper'
  );

  const css = readRendererFile('styles.css');
  const hiddenPanelRules = cssRulesForSelector(css, '#claudeManualPanel.hidden');
  assert.ok(hiddenPanelRules.some(rule => declaration(rule, 'display') === 'none'));
  const panelRules = cssRulesForSelector(css, '#claudeManualPanel');
  assert.ok(panelRules.some(rule => declaration(rule, 'min-width') === '0'));
  const innerRules = cssRulesForSelector(css, '#claudeManualPanel > .accordion-animation-inner');
  assert.ok(innerRules.some(rule => (
    declaration(rule, 'display') === 'grid'
      && declaration(rule, 'gap') === '8px'
  )));
  const textareaRules = cssRulesForSelector(css, '#claudeManualPanel textarea');
  assert.ok(textareaRules.some(rule => (
    declaration(rule, 'width') === '100%'
      && declaration(rule, 'font-size') === '12px'
  )));
  assert.ok(textareaRules.some(rule => declaration(rule, 'font-family') === 'monospace'));
  const textareaControlRules = cssRulesForSelector(css, '.settings-panel textarea');
  assert.ok(textareaControlRules.some(rule => (
    declaration(rule, 'height') === '54px'
      && declaration(rule, 'min-height') === '54px'
      && declaration(rule, 'resize') === 'vertical'
  )));
  assert.ok(textareaControlRules.some(rule => (
    declaration(rule, 'background') === 'rgba(var(--sunken-rgb), 0.48)'
      && declaration(rule, 'color') === 'var(--text)'
      && declaration(rule, 'border') === '1px solid var(--line)'
  )));
  const textareaFocusRules = cssRulesForSelector(css, '.settings-panel textarea:focus');
  assert.ok(textareaFocusRules.some(rule => (
    declaration(rule, 'border-color') === 'rgba(115, 189, 245, 0.72)'
  )));
  const collapsedRules = cssRulesForSelector(css, '.accordion-animated-container.hidden');
  assert.ok(collapsedRules.some(rule => (
    declaration(rule, 'grid-template-rows') === '0fr'
      && declaration(rule, 'pointer-events') === 'none'
  )));
  const collapsedInnerRules = cssRulesForSelector(
    css,
    '.accordion-animated-container.hidden > .accordion-animation-inner'
  );
  assert.ok(collapsedInnerRules.some(rule => declaration(rule, 'opacity') === '0'));

  const setupBody = functionBodyBeforeMarker(app, 'setupCursorAccountUI', '\nsetupCursorAccountUI();');
  assert.match(setupBody, /if \(\/\[\\r\\n\]\/\.test\(input\.value\)\)[\s\S]*settings\.claude\.cookieInvalidFormat/);
  assert.match(setupBody, /window\.tokenMonitor\.claude\.saveCookie\(input\.value\)/);
  assert.match(setupBody, /if \(result\?\.superseded\) return;/);
  assert.ok(
    setupBody.indexOf('window.tokenMonitor.claude.saveCookie(input.value)')
      < setupBody.indexOf("limitProviders: limitProviderSelectionIncluding('claude')"),
    'Claude Web cookies must be validated before they are persisted'
  );
  assert.match(setupBody, /INVALID_CLAUDE_WEB_SESSION_KEY[\s\S]*settings\.claude\.cookieInvalidFormat/);
  assert.match(setupBody, /CLAUDE_WEB_SOURCE_CHALLENGE[\s\S]*settings\.claude\.sourceChallenge/);
  assert.match(setupBody, /result\?\.status === 'unauthorized'[\s\S]*settings\.claude\.cookieRejected/);
  assert.match(setupBody, /saveSettings\(\{\s*limitProviders: limitProviderSelectionIncluding\('claude'\),[\s\S]*?limitsEnabled: true/);
  assert.doesNotMatch(setupBody, /saveSettings\(\{\s*claudeWebCookie: input\.value/);
  assert.match(setupBody, /saveSettings\(\{ claudeWebCookie: '' \}\)/);
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\(claudePlatformUrl\(\)\)/);
  const statusBody = functionBody(app, 'renderExternalProviderStatus', 'setMinimaxAccountExpanded');
  assert.match(statusBody, /const canClearConfiguredClaude = providerName === 'claude' && configured;/);
  assert.match(statusBody, /manualPanel\.classList\.toggle\('hidden', linked\)/);
  assert.match(statusBody, /source !== 'settings' \|\| \(!linked && !canClearConfiguredClaude\)/);
  const urlBody = functionBody(app, 'claudePlatformUrl', 'selectedQoderSite');
  assert.match(urlBody, /return 'https:\/\/claude\.ai\/settings\/usage';/);

  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  assert.match(main, /function normalizeClaudeWebCookie\(value\) \{\s*return normalizeClaudeWebCookieInput\(value\);\s*\}/);
  assert.match(main, /ipcMain\.handle\('claude:saveCookie'[\s\S]*fetchClaudeLimits\([\s\S]*providerRuntimeState: new Map\(\)/);
  assert.match(main, /const requestRevision = \+\+claudeWebCookieMutationRevision;/);
  assert.match(main, /claudeWebCookieMutationRevision !== requestRevision[\s\S]*superseded: true/);
  assert.match(main, /settings\.claudeWebCookie = cookieToPersist;[\s\S]*saveSettings\(\{ throwOnError: true \}\)/);
  const preload = fs.readFileSync(path.join(rendererDir, '..', 'preload.js'), 'utf8');
  assert.match(preload, /claude: \{\s*saveCookie: \(cookie\) => ipcRenderer\.invoke\('claude:saveCookie', cookie\)/);
  const updateHandler = main.slice(
    main.indexOf("ipcMain.handle('settings:update'"),
    main.indexOf("ipcMain.handle('appearance:preview'")
  );
  assert.ok(
    updateHandler.indexOf('normalizeClaudeWebCookie(patch.claudeWebCookie)')
      < updateHandler.indexOf('saveSettings({ throwOnError: true })'),
    'invalid Claude cookies must be rejected before the existing credential can be persisted over'
  );
  const rendererSettings = functionBody(main, 'settingsForRenderer', 'pushSettingsToRenderer');
  assert.match(rendererSettings, /claudeWebCookie: settings\?\.claudeWebCookie \? 'set' : ''/);
  assert.match(rendererSettings, /claudeWebCookieConfigured: Boolean\(currentClaudeWebCookie\(\)\)/);
  assert.match(rendererSettings, /claudeWebCookieSource/);
  const allowlist = functionBody(main, 'isAllowedExternalUrl', 'revealWindow');
  assert.match(allowlist, /parsed\.hostname === 'claude\.ai' && parsed\.pathname\.startsWith\('\/settings'\)/);
});

test('DeepSeek account pill keeps its validated API key state after moving into Limits', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /deepseek: 'deepseekAccountGroup'/);
  assert.match(app, /deepseek: 'deepseekApiKeyStatus'/);

  const linkedBody = functionBody(app, 'deepseekAccountLinked', 'deepseekProviderStatus');
  assert.match(linkedBody, /Boolean\(state\.settings\?\.deepseekApiKeyConfigured\)/);
  assert.match(linkedBody, /deepseekProviderForAccount\(\)/);
  assert.match(linkedBody, /provider\?\.status === 'ok'/);

  const renderBody = functionBody(app, 'renderDeepseekStatus', 'renderOpenCodeProfiles');
  assert.match(renderBody, /const configured = Boolean\(state\.settings\?\.deepseekApiKeyConfigured\);/);
  assert.match(renderBody, /apiKeyAccountStatusText\('deepseek', provider, configured, source, enabled\)/);
});

test('DeepSeek key changes invalidate stale provider status before re-checking', () => {
  const app = readRendererFile('app.js');
  const setupBody = functionBodyBeforeMarker(app, 'setupCursorAccountUI', '\nsetupCursorAccountUI();');
  assert.match(setupBody, /markDeepseekKeyCheckPending\(\);[\s\S]*await saveSettings\(\{ deepseekApiKey: input\.value \}\);[\s\S]*renderDeepseekStatus\(\);[\s\S]*await refreshStats\(\{ force: true \}\);/);
  assert.match(setupBody, /await saveSettings\(\{ deepseekApiKey: '' \}\);[\s\S]*clearDeepseekPendingCheck\(\);[\s\S]*clearDeepseekProviderStatus\(\);[\s\S]*renderDeepseekStatus\(\);/);

  const pendingBody = functionBody(app, 'markDeepseekKeyCheckPending', 'clearDeepseekPendingCheck');
  assert.match(pendingBody, /state\.deepseekPendingCheckSince = Date\.now\(\);/);
  assert.match(pendingBody, /clearDeepseekProviderStatus\(\);/);

  const providerBody = functionBody(app, 'deepseekProviderForAccount', 'markDeepseekKeyCheckPending');
  assert.match(providerBody, /const pendingSince = Number\(state\.deepseekPendingCheckSince \|\| 0\);/);
  assert.match(providerBody, /Date\.parse\(provider\.updatedAt \|\| ''\)/);
  assert.match(providerBody, /updatedAt < pendingSince/);
  assert.match(providerBody, /state\.deepseekPendingCheckSince = 0;/);

  const clearBody = functionBody(app, 'clearDeepseekProviderStatus', 'renderDeepseekStatus');
  assert.match(clearBody, /state\.stats\.limits\.providers = state\.stats\.limits\.providers\.filter/);
  assert.match(clearBody, /provider\.provider !== 'deepseek'/);
});

test('disabled credential providers settle account status instead of checking forever', () => {
  const app = readRendererFile('app.js');
  const toggleBody = functionBody(app, 'onLimitProviderToggle', 'onLimitProviderMove');
  const clearBody = functionBody(app, 'clearDisabledLimitProviderPendingChecks', 'externalProviderForAccount');
  const externalRenderBody = functionBody(app, 'renderExternalProviderStatus', 'setMinimaxAccountExpanded');
  const deepseekRenderBody = functionBody(app, 'renderDeepseekStatus', 'renderOpenCodeProfiles');
  const minimaxRenderBody = functionBody(app, 'renderMinimaxStatus', 'renderCopilotStatus');
  const copilotRenderBody = functionBody(app, 'renderCopilotStatus', 'renderDeepseekStatus');

  assert.match(toggleBody, /clearDisabledLimitProviderPendingChecks\(new Set\(checked\)\)/);
  assert.match(clearBody, /clearDeepseekPendingCheck\(\)/);
  assert.match(clearBody, /clearMinimaxPendingCheck\(\)/);
  assert.match(clearBody, /clearCopilotPendingCheck\(\)/);
  assert.match(clearBody, /Object\.keys\(externalLimitAccountConfig\)/);
  assert.match(clearBody, /clearExternalProviderCheckPending\(providerName\)/);
  assert.match(externalRenderBody, /const enabled = limitProviderEnabled\(providerName\);/);
  assert.match(externalRenderBody, /const pending = enabled &&/);
  assert.match(externalRenderBody, /apiKeyAccountStatusText\(providerName, provider, configured, source, enabled\)/);
  assert.match(deepseekRenderBody, /apiKeyAccountStatusText\('deepseek', provider, configured, source, enabled\)/);
  assert.match(minimaxRenderBody, /apiKeyAccountStatusText\('minimax', provider, configured, source, enabled\)/);
  assert.match(copilotRenderBody, /copilotAccountStatusText\(provider, configured, source, enabled\)/);
});

test('MiniMax key changes invalidate stale provider status before re-checking', () => {
  const app = readRendererFile('app.js');
  const setupBody = functionBodyBeforeMarker(app, 'setupCursorAccountUI', '\nsetupCursorAccountUI();');
  assert.match(setupBody, /markMinimaxKeyCheckPending\(\);[\s\S]*await saveSettings\(\{ minimaxApiKey: input\.value \}\);[\s\S]*renderMinimaxStatus\(\);[\s\S]*await refreshStats\(\{ force: true \}\);/);
  assert.match(setupBody, /await saveSettings\(\{ minimaxApiKey: '' \}\);[\s\S]*clearMinimaxPendingCheck\(\);[\s\S]*clearMinimaxProviderStatus\(\);[\s\S]*renderMinimaxStatus\(\);/);

  const linkedBody = functionBody(app, 'minimaxAccountLinked', 'apiKeyAccountStatusText');
  assert.match(linkedBody, /minimaxProviderForAccount\(\)/);

  const renderBody = functionBody(app, 'renderMinimaxStatus', 'renderDeepseekStatus');
  assert.match(renderBody, /const provider = minimaxProviderForAccount\(\);/);

  const pendingBody = functionBody(app, 'markMinimaxKeyCheckPending', 'clearMinimaxPendingCheck');
  assert.match(pendingBody, /state\.minimaxPendingCheckSince = Date\.now\(\);/);
  assert.match(pendingBody, /clearMinimaxProviderStatus\(\);/);

  const providerBody = functionBody(app, 'minimaxProviderForAccount', 'markMinimaxKeyCheckPending');
  assert.match(providerBody, /const pendingSince = Number\(state\.minimaxPendingCheckSince \|\| 0\);/);
  assert.match(providerBody, /Date\.parse\(provider\.updatedAt \|\| ''\)/);
  assert.match(providerBody, /updatedAt < pendingSince/);
  assert.match(providerBody, /state\.minimaxPendingCheckSince = 0;/);

  const clearBody = functionBody(app, 'clearMinimaxProviderStatus', 'apiKeyAccountStatusText');
  assert.match(clearBody, /state\.stats\.limits\.providers = state\.stats\.limits\.providers\.filter/);
  assert.match(clearBody, /provider\.provider !== 'minimax'/);
});

test('MiMo account panel matches the manual Cookie provider layout', () => {
  const html = readRendererFile('index.html');
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const preload = fs.readFileSync(path.join(rendererDir, '..', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const details = html.match(/<div id="mimoSettingsDetails"[\s\S]*?<div id="mimoAccountErrorMessage"/)?.[0] || '';

  assert.match(details, /id="mimoCookieInput"/);
  assert.doesNotMatch(details, /id="mimoAccountNameInput"/);
  assert.match(details, /id="mimoOpenConsoleButton"/);
  assert.match(details, /id="mimoAddToggle"[\s\S]*aria-controls="mimoAddDetails"/);
  assert.match(details, /id="mimoAddDetails" class="opencode-add-details accordion-animated-container hidden"/);
  assert.match(details, /id="mimoSaveAccountButton"/);
  assert.match(details, /id="mimoManualPanel"/);
  assert.match(details, /<strong>1\.<\/strong>[\s\S]*<strong>4\.<\/strong>/);
  assert.match(details, /data-i18n="settings\.mimo\.step3Before">In Network, select<\/span> <code>balance<\/code>/);
  assert.match(details, /data-i18n="settings\.mimo\.step4">Paste it below, then click Save account\.<\/span>/);
  assert.doesNotMatch(details, /Only the cookies required for balance/);
  assert.match(details, /placeholder="Cookie: \.\.\."/);
  assert.match(details, /data-i18n-aria-label="settings\.mimo\.cookieLabel" aria-label="Cookie header"/);
  assert.ok(details.indexOf('mimoAddToggle') < details.indexOf('mimoOpenConsoleButton'));
  assert.ok(details.indexOf('mimoOpenConsoleButton') < details.indexOf('mimoCookieInput'));
  assert.ok(details.indexOf('mimoCookieInput') < details.indexOf('mimoSaveAccountButton'));
  assert.match(css, /#mimoManualPanel textarea,[\s\S]*font-size: 12px/);
  assert.match(css, /#qoderManualPanel textarea,[\s\S]*#mimoManualPanel textarea,[\s\S]*font-family: monospace/);
  assert.match(css, /\.managed-account-list:empty \{ display: none; \}/);
  assert.match(css, /\.opencode-empty\.hidden \{ display: none; \}/);
  assert.match(app, /getElementById\('mimoManualPanel'\)\?\.classList\.toggle\('expanded', next\)/);
  assert.doesNotMatch(app, /settings\.mimo\.empty/);
  assert.match(app, /window\.tokenMonitor\.mimo\.openConsole\(\)/);
  assert.match(app, /window\.tokenMonitor\.mimo\.addAccount\(input\.value\)/);
  assert.match(app, /saveButton\.textContent = t\('settings\.mimo\.checking'\)/);
  assert.match(app, /result\?\.errorCode === 'invalidCookie'/);
  assert.match(app, /function setMimoAddExpanded\(expanded\)/);
  assert.match(app, /setMimoAddExpanded\(false\)/);
  assert.match(preload, /addAccount: \(cookieHeader\) => ipcRenderer\.invoke\('mimo:addAccount', cookieHeader\)/);
  assert.match(preload, /openConsole: \(\) => ipcRenderer\.invoke\('mimo:openConsole'\)/);
  assert.match(main, /ipcMain\.handle\('mimo:openConsole'/);
  assert.match(main, /ipcMain\.handle\('mimo:addAccount', \(_event, cookieHeader\) => addMimoManagedAccount\(cookieHeader\)\)/);
  // Limits rows mask through the shared resolver; the settings list stays readable.
  assert.match(app, /maskEmail: limitAccountEmailsMasked\(\)/);
  assert.match(app, /function mimoSettingsAccountTitle\(account, index\) \{[\s\S]*account\?\.accountEmail[\s\S]*`Account \$\{index \+ 1\}`/);
  assert.match(app, /const accountName = mimoSettingsAccountTitle\(account, index\);/);
  const addBody = functionBody(main, 'addMimoManagedAccount', 'removeMimoManagedAccount');
  assert.match(addBody, /const \[validation\] = await fetchMimoLimits\(\{ mimoManagedAccounts: \[result\.account\] \}, electronProviderDeps\(\)\)/);
  assert.ok(addBody.indexOf('fetchMimoLimits') < addBody.indexOf('settings.mimoManagedAccounts ='), 'validation must happen before persistence');
  assert.match(addBody, /result\.account\.accountEmail = String\(validation\.accountEmail/);
  assert.doesNotMatch(main, /new BrowserWindow\([\s\S]{0,300}Sign in to MiMo/);
  assert.doesNotMatch(main, /MIMO_SESSION_PARTITION|mimoLoginWindow|configureMimoLoginWindow/);
});

test('DeepSeek account copy says browser and external URL is allowlisted', () => {
  const html = readRendererFile('index.html');
  const details = html.match(/<div id="deepseekSettingsDetails"[\s\S]*?<div id="deepseekErrorMessage" class="settings-note error hidden"><\/div>/)?.[0] || '';
  assert.match(details, /<button id="deepseekOpenBrowser"[\s\S]*data-i18n="settings\.deepseek\.openBrowser">/);

  const i18n = readRendererFile('i18n.js');
  assert.match(i18n, /'settings\.deepseek\.openBrowser': 'Open DeepSeek API keys in browser'/);
  assert.match(i18n, /'settings\.deepseek\.openBrowser': '在瀏覽器開啟 DeepSeek API 金鑰'/);
  assert.match(i18n, /'settings\.deepseek\.openBrowser': '在浏览器打开 DeepSeek API 密钥'/);

  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const allowlist = functionBody(main, 'isAllowedExternalUrl', 'revealWindow');
  assert.match(allowlist, /parsed\.hostname === 'platform\.deepseek\.com'/);

  const app = readRendererFile('app.js');
  const setupBody = functionBodyBeforeMarker(app, 'setupCursorAccountUI', '\nsetupCursorAccountUI();');
  assert.match(setupBody, /window\.tokenMonitor\.openExternal\('https:\/\/platform\.deepseek\.com\/api_keys'\)/);
});

test('Z.ai global and BigModel CN browser links are allowlisted', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const allowlist = functionBody(main, 'isAllowedExternalUrl', 'revealWindow');
  assert.match(allowlist, /parsed\.hostname === 'z\.ai' \|\| parsed\.hostname === 'www\.z\.ai'/);
  assert.match(allowlist, /parsed\.hostname === 'bigmodel\.cn' \|\| parsed\.hostname === 'www\.bigmodel\.cn'/);
});

test('opencode status env account avoids saved profile names', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const handler = main.slice(
    main.indexOf("ipcMain.handle('opencode:status'"),
    main.indexOf("ipcMain.handle('opencode:getProfiles'")
  );
  assert.ok(handler, 'opencode:status handler should exist');
  assert.match(handler, /hasOwnProperty\.call\(profiles, envKey\)/);
  assert.doesNotMatch(handler, /hasOwnProperty\.call\(result, envKey\)/);
});

test('settingsForRenderer strips provider cookies before they reach the renderer', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const credentialStore = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', 'credentialStore.js'), 'utf8');
  const body = main.slice(
    main.indexOf('function settingsForRenderer'),
    main.indexOf('function pushSettingsToRenderer')
  );
  assert.ok(body, 'settingsForRenderer should exist');
  assert.match(body, /credentialSettingsForRenderer\(settings, \{\s*expose: \['hubHostSecret', 'secret'\]\s*\}\)/);
  // The raw OpenCode cookie must be reduced to a presence flag, never forwarded verbatim.
  assert.match(body, /opencodeCookie:[^,}]*\?\s*'set'\s*:\s*''/);
  // Multi-account profile cookies are redacted the same way.
  assert.match(body, /opencodeProfiles: redactOpencodeProfilesForRenderer\(/);
  assert.match(body, /'workbuddyAccessToken',[\s\S]*'workbuddyDepartmentInfo'/);
  assert.doesNotMatch(body, /workbuddyLocalApp/);
  assert.doesNotMatch(main, /workbuddySession|workbuddyBrowserSession/);
  assert.doesNotMatch(body, /workbuddyBrowserSessionEnabled: settings\?\.workbuddyBrowserSessionEnabled/);
  // That redactor must name the fields it forwards. A spread of the stored
  // profile hands any field added later to the renderer verbatim, which is how
  // the API key would have leaked when profiles gained one.
  const opencodeRedactor = main.slice(
    main.indexOf('function redactOpencodeProfilesForRenderer'),
    main.indexOf('function redactOpenRouterProfilesForRenderer')
  );
  assert.doesNotMatch(opencodeRedactor, /\.\.\.profile/);
  assert.match(opencodeRedactor, /cookie: profile\?\.cookie \? 'set' : ''/);
  assert.match(opencodeRedactor, /apiKey: profile\?\.apiKey \? 'set' : ''/);
  assert.match(credentialStore, /kimiWebAccessToken: \['providers', 'kimi', 'webAccessToken'\]/);
  assert.match(body, /kimiWebAccessTokenConfigured: Boolean\(currentKimiWebAccessToken\(\)\)/);
  const mimoRendererShape = main.slice(
    main.indexOf('function mimoAccountsForRenderer'),
    main.indexOf('function mimoManagedAccountsForCollector')
  );
  assert.match(mimoRendererShape, /id, accountKey, accountEmail, accountLabel, addedAt, updatedAt, enabled/);
  assert.doesNotMatch(mimoRendererShape, /cookieHeader/);
  assert.match(credentialStore, /fsApi\.openSync\(temporary, 'wx', 0o600\)/);
  assert.match(credentialStore, /fsApi\.fchmodSync\(descriptor, 0o600\)/);
  assert.match(credentialStore, /fsApi\.openSync\(directory, constants\.O_RDONLY\)/);
  assert.match(main, /ensureCredentialStore\(\)\.writeMimoCredential\(id, cookieHeader\)/);
  assert.match(main, /cookieHeader: readMimoCredential\(account\.id\)/);
  assert.match(main, /migrateLegacyMimoCredentialFiles\(merged\.mimoManagedAccounts\)/);
  assert.match(main, /if \(!removeMimoCredential\(accountId\)\) return \{ ok: false, error: 'Could not remove stored credential' \};/);
  assert.match(main, /delete result\.account\.cookieHeader/);
});

test('WorkBuddy settings uses the same automatic provider row as other ambient integrations', () => {
  const html = readRendererFile('index.html');
  assert.doesNotMatch(html, /workbuddy(?:Settings|AccountGroup|LocalApp|Open|Refresh|Privacy|OptIn|Error)/);

  const app = readRendererFile('app.js');
  assert.match(app, /workbuddy: 'settings\.limits\.connection\.workbuddy'/);
  assert.doesNotMatch(app, /workbuddyAccountGroup|workbuddyAccountStatus|renderWorkbuddyStatus/);
  assert.doesNotMatch(app, /window\.tokenMonitor\.workbuddy/);

  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'preload.js'), 'utf8');
  assert.doesNotMatch(preload, /workbuddy:/);
});

test('WorkBuddy auth is resolved only when its enabled local provider is active', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const limitsConfig = functionBody(main, 'electronLimitsConfig', 'defaultLimitProviders');
  assert.match(limitsConfig, /settings\?\.limitsEnabled !== false/);
  assert.match(limitsConfig, /parseLimitProviders\(settings\?\.limitProviders\)\.includes\('workbuddy'\)/);
  assert.match(limitsConfig, /const workbuddyDesktopSessionSupported = isSupportedWorkbuddyLocalAppPlatform\(\)/);
  assert.match(limitsConfig, /const workbuddyDesktopSessionEnabled = workbuddyEnabled && workbuddyDesktopSessionSupported/);
  assert.match(limitsConfig, /workbuddyDesktopSessionSupported,/);
  assert.match(limitsConfig, /workbuddyDesktopSessionEnabled,/);
  assert.match(limitsConfig, /workbuddyLocalSession: workbuddyDesktopSessionEnabled \? electronWorkbuddyLocalAuth\.getSessionInfo\(\) : \{\}/);
  assert.doesNotMatch(limitsConfig, /settings\?\.workbuddyLocalAppEnabled/);
});

test('legacy credential cleanup retries independently from the migration marker', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const body = functionBody(main, 'loadCredentialSettings', 'migrateLegacyMimoCredentialFiles');
  assert.match(body, /store\.migrateLegacySettings\(saved\);/);
  assert.match(body, /if \(hasCredentialSettings\(saved\)\) \{/);
  assert.match(body, /writePrivateJsonAtomic\(settingsPath, stripCredentialSettings\(saved\)\)/);
  assert.doesNotMatch(body, /migration\.migrated/);
});

test('legacy MiMo migration rejects symlinks and retries cleanup after a partial failure', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const body = functionBody(main, 'migrateLegacyMimoCredentialFiles', 'readSettings');
  assert.match(body, /readRegularFileNoFollow\(legacyMimoCredentialPath\(account\.id\)/);
  assert.match(body, /ensureCredentialStore\(\)\.migrateLegacyMimoCredentials\(entries\);/);
  assert.match(body, /if \(!readMimoCredential\(entry\.id\)\) continue;/);
  assert.doesNotMatch(body, /migratedIds/);
});

test('credential storage failures preserve the file and surface one actionable error', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const reporter = functionBody(main, 'reportCredentialStorageError', 'loadCredentialSettings');
  assert.match(reporter, /credentialStorageErrorShown \|\| !app\.isReady\(\)/);
  assert.match(reporter, /dialog\.showErrorBox\(/);
  assert.match(reporter, /save was stopped and previous data was restored where possible/);
  const saveBody = functionBody(main, 'saveSettings', 'loginItemEnabledHere');
  assert.match(saveBody, /persistSettingsAndCredentials\(/);
  assert.match(saveBody, /settings = previousSettings;/);
  assert.match(saveBody, /reportCredentialStorageError\('could not persist settings', error\)/);
  assert.match(saveBody, /if \(options\.throwOnError\) throw error;/);

  const settingsHandler = main.slice(
    main.indexOf("ipcMain.handle('settings:update'"),
    main.indexOf("ipcMain.handle('appearance:preview'")
  );
  assert.match(settingsHandler, /saveSettings\(\{ throwOnError: true \}\);/);

  const renderer = readRendererFile('app.js');
  const rendererSave = functionBody(renderer, 'saveSettings', 'renderHomeIfVisible');
  assert.match(rendererSave, /state\.settings = await window\.tokenMonitor\.getSettings\(\)/);
  assert.match(rendererSave, /throw error;/);
});

test('successful settings saves invalidate the exported tray menu', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const saveBody = functionBody(main, 'saveSettings', 'loginItemEnabledHere');
  const successPath = saveBody.slice(0, saveBody.indexOf('} catch (error)'));
  const failurePath = saveBody.slice(saveBody.indexOf('} catch (error)'));

  assert.match(
    successPath,
    /persistedSettingsSnapshot = cloneSettingsSnapshot\(settings\);\s*refreshTrayContextMenu\(\);\s*return true;/
  );
  assert.doesNotMatch(failurePath, /refreshTrayContextMenu\(\)/);
});

test('main settings normalize the Z.ai API region', () => {
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const defaults = main.slice(main.indexOf('function defaultSettings'), main.indexOf('function defaultLimitProviders'));
  assert.match(defaults, /zaiApiRegion: normalizeZaiApiRegion\(process\.env\.TOKEN_MONITOR_ZAI_API_REGION \|\| process\.env\.ZAI_API_REGION \|\| process\.env\.Z_AI_API_HOST \|\| 'global'\)/);

  const handler = main.slice(
    main.indexOf("ipcMain.handle('settings:update'"),
    main.indexOf("ipcMain.handle('customPricing:list'")
  );
  assert.match(handler, /if \(patch\.zaiApiRegion !== undefined\) normalizedPatch\.zaiApiRegion = normalizeZaiApiRegion\(patch\.zaiApiRegion\);/);
});

test('main settings migration preserves explicit AI limit provider selections', () => {
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const context = {
    parseLimitProviders(value) {
      const known = new Set(['claude', 'codex', 'cursor', 'antigravity', 'opencode']);
      return String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter((item, index, list) => (
        known.has(item) && list.indexOf(item) === index
      ));
    },
    defaultLimitProviders() {
      return 'claude,codex,cursor,antigravity,opencode';
    }
  };

  assert.equal(
    runMainFunction(main, 'migrateLimitProviders', 'migrateLimitProviderOrder', "migrateLimitProviders('claude,codex')", context),
    'claude,codex'
  );
  assert.equal(
    runMainFunction(main, 'migrateLimitProviders', 'migrateLimitProviderOrder', "migrateLimitProviders('claude,codex,cursor,antigravity')", context),
    'claude,codex,cursor,antigravity'
  );
});

test('active Codex account labels are always shown for multi-account limits rows', () => {
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const app = readRendererFile('app.js');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const i18n = fs.readFileSync(path.join(rendererDir, 'i18n.js'), 'utf8');
  const defaultSettingsBody = functionBody(main, 'defaultSettings', 'ensureSettingsLoaded');
  const readSettingsBody = functionBody(main, 'readSettings', 'saveSettings');

  assert.doesNotMatch(defaultSettingsBody, /showActiveAccount/);
  assert.doesNotMatch(readSettingsBody, /showActiveAccount/);
  assert.doesNotMatch(main, /showActiveAccount: parseBoolean/);
  assert.doesNotMatch(app, /showActiveAccountInput/);
  assert.doesNotMatch(app, /showActiveAccount/);
  assert.doesNotMatch(html, /showActiveAccountInput/);
  assert.doesNotMatch(i18n, /settings\.limits\.showActiveAccount/);
});

test('collection cadence setting is exposed in the Collection panel', () => {
  const html = readRendererFile('index.html');
  const i18n = readRendererFile('i18n.js');
  const controls = html.match(/<div class="settings-subgroup settings-collection-cadence"[\s\S]*?<select id="collectionCadenceInput"[\s\S]*?<\/select>[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(controls, /data-i18n="settings\.collection\.cadence"/);
  assert.match(controls, /value="live"/);
  assert.match(controls, /value="smart"[\s\S]*data-i18n="settings\.collection\.mode\.smart"/);
  assert.match(i18n, /'settings\.collection\.modeDesc': 'Smart mode collects after agent activity, with an hourly reconciliation; fixed intervals turn off file watching\.'/);
  assert.match(controls, /<option value="300000"/);
  assert.match(controls, /<option value="900000"/);
  assert.match(controls, /<option value="1800000"/);
  assert.match(controls, /id="collectionCadenceNote"[\s\S]*hidden/);
  assert.doesNotMatch(controls, /<option value="3600000"/);
  assert.doesNotMatch(controls, /id="collectionModeInput"/);
  assert.doesNotMatch(controls, /id="collectionIntervalInput"/);

  const app = readRendererFile('app.js');
  const syncBody = functionBody(app, 'syncSettingsForm', 'enabledClientSet');
  assert.match(syncBody, /collectionCadenceInput/);
  assert.match(syncBody, /collectionCadenceNote[\s\S]*\.hidden\s*=/);

  const listenerSlice = app.slice(
    app.indexOf("els.collectionCadenceInput?.addEventListener('change'"),
    app.indexOf("els.wslScanInput?.addEventListener('change'")
  );
  assert.match(listenerSlice, /saveSettings\(\{[\s\S]*collectionMode:/);
  assert.match(listenerSlice, /collectionIntervalMs:/);
  assert.match(listenerSlice, /value === 'smart'/);
  assert.match(listenerSlice, /600000/);
});

test('sync upload interval setting is exposed in the Multi-device Sync panel', () => {
  const html = readRendererFile('index.html');
  const controls = html.match(/<label class="sync-upload-interval-row[^"]*"[\s\S]*?<select id="syncUploadIntervalInput"[\s\S]*?<\/select>[\s\S]*?<\/label>/)?.[0] || '';
  const clientFields = html.slice(html.indexOf('<div id="hubClientFields"'), html.indexOf('<div id="hubHostFields"'));
  assert.match(clientFields, /sync-upload-interval-row/);
  assert.match(controls, /data-i18n="settings\.sync\.uploadInterval"/);
  assert.match(controls, /<option value="0"[\s\S]*data-i18n="settings\.sync\.uploadInterval\.live"/);
  assert.match(controls, /<option value="600000"[\s\S]*data-i18n="settings\.sync\.uploadInterval\.10m"/);
  assert.match(controls, /<option value="1200000"[\s\S]*data-i18n="settings\.sync\.uploadInterval\.20m"/);
  assert.match(controls, /<option value="1800000"[\s\S]*data-i18n="settings\.sync\.uploadInterval\.30m"/);

  const app = readRendererFile('app.js');
  const syncBody = functionBody(app, 'syncSettingsForm', 'enabledClientSet');
  assert.match(syncBody, /syncUploadIntervalInput/);
  assert.match(syncBody, /state\.settings\.syncUploadIntervalMs/);
  assert.match(syncBody, /Array\.from\(els\.syncUploadIntervalInput\.options/);
  assert.doesNotMatch(syncBody, /const allowed = \[0, 600000, 1200000, 1800000\]/);
  const listenerStart = app.indexOf("els.syncUploadIntervalInput?.addEventListener('change'");
  const listenerEnd = app.indexOf("els.collectionCadenceInput?.addEventListener('change'", listenerStart);
  assert.notEqual(listenerStart, -1, 'sync upload interval listener should exist');
  assert.notEqual(listenerEnd, -1, 'collection cadence listener should follow sync upload listener');
  assert.match(app.slice(listenerStart, listenerEnd), /saveSettings\(\{\s*syncUploadIntervalMs:/);
});

// Run the shipped event wiring against controls that model a settings push:
// an auto-saved interval updates persisted state while the Hub fields keep
// their local drafts until the explicit Hub Save commits them.
function fakeHubControl(value = '') {
  const listeners = new Map();
  return {
    value,
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    async dispatch(type) {
      for (const listener of listeners.get(type) || []) await listener({ target: this });
    }
  };
}

function loadHubSettingsWiring(els, context) {
  const app = readRendererFile('app.js');
  const modeStart = app.indexOf('function syncHubModeUi()');
  const modeEnd = app.indexOf('function renderHubStatus()', modeStart);
  const draftStart = app.indexOf('const HUB_DRAFT_FIELDS = [');
  const draftEnd = app.indexOf('function syncSettingsForm()', draftStart);
  const saveStart = app.indexOf("els.saveSettingsButton.addEventListener('click'");
  const saveEnd = app.indexOf("els.hubModeOptions.addEventListener('change'", saveStart);
  const intervalStart = app.indexOf('for (const input of els.showLimitUsedInputs || [])', saveEnd);
  const intervalEnd = app.indexOf("els.collectionCadenceInput?.addEventListener('change'", intervalStart);
  assert.notEqual(modeStart, -1, 'Hub mode UI sync should exist');
  assert.notEqual(modeEnd, -1, 'Hub mode UI sync should precede Hub status rendering');
  assert.notEqual(draftStart, -1, 'Hub draft tracking should exist');
  assert.notEqual(draftEnd, -1, 'Hub draft tracking should precede settings sync');
  assert.notEqual(saveStart, -1, 'Hub Save handler should exist');
  assert.notEqual(saveEnd, -1, 'Hub mode handler should follow Hub Save');
  assert.notEqual(intervalStart, -1, 'limits display wiring should precede sync upload wiring');
  assert.notEqual(intervalEnd, -1, 'collection cadence wiring should follow sync upload wiring');
  const vmContext = {
    els,
    ...context,
    renderHubStatus: () => {},
    renderSyncClientStatus: () => {},
    renderHubBuildStatus: () => {}
  };
  vm.runInNewContext(
    `${app.slice(modeStart, modeEnd)}\n${app.slice(draftStart, draftEnd)}\n${app.slice(saveStart, saveEnd)}\n${app.slice(intervalStart, intervalEnd)}`,
    vmContext
  );
  return vmContext;
}

test('changing sync upload frequency auto-saves without replacing Hub drafts', async () => {
  const els = {
    saveSettingsButton: fakeHubControl(),
    hubUrlInput: fakeHubControl(),
    secretInput: fakeHubControl(),
    deviceIdInput: fakeHubControl(),
    syncUploadIntervalInput: fakeHubControl('0'),
    showLimitUsedInputs: []
  };
  const state = {
    settings: {
      hubMode: 'client',
      hubUrl: 'https://saved.example',
      secret: 'saved-secret',
      deviceId: 'saved-device',
      syncUploadIntervalMs: 0
    }
  };
  const patches = [];
  let vmContext;
  vmContext = loadHubSettingsWiring(els, {
    state,
    saveSettings: async (patch) => {
      patches.push({ ...patch });
      Object.assign(state.settings, patch);
      vmContext.syncHubDraftFields();
      els.syncUploadIntervalInput.value = String(state.settings.syncUploadIntervalMs);
    },
    refreshHubInfo: async () => {},
    refreshHubBuildStatus: async () => {},
    refreshStats: async () => {}
  });
  vmContext.syncHubDraftFields();

  els.hubUrlInput.value = 'https://draft.example';
  els.secretInput.value = 'draft-secret';
  els.deviceIdInput.value = 'draft-device';
  await els.hubUrlInput.dispatch('input');
  await els.secretInput.dispatch('input');
  await els.deviceIdInput.dispatch('input');
  els.syncUploadIntervalInput.value = '1200000';

  await els.syncUploadIntervalInput.dispatch('change');
  assert.equal(els.hubUrlInput.value, 'https://draft.example');
  assert.equal(els.secretInput.value, 'draft-secret');
  assert.equal(els.deviceIdInput.value, 'draft-device');
  assert.deepEqual(patches, [{ syncUploadIntervalMs: 1200000 }]);

  await els.saveSettingsButton.dispatch('click');
  assert.deepEqual(patches, [{
    syncUploadIntervalMs: 1200000
  }, {
    hubUrl: 'https://draft.example',
    secret: 'draft-secret',
    deviceId: 'draft-device'
  }]);
  assert.equal(els.hubUrlInput.value, 'https://draft.example');
  assert.equal(els.secretInput.value, 'draft-secret');
  assert.equal(els.deviceIdInput.value, 'draft-device');
});

test('Hub Save keeps edits made while persistence is in flight', async () => {
  const els = {
    saveSettingsButton: fakeHubControl(),
    hubUrlInput: fakeHubControl(),
    secretInput: fakeHubControl(),
    deviceIdInput: fakeHubControl(),
    syncUploadIntervalInput: fakeHubControl('0'),
    showLimitUsedInputs: []
  };
  const state = {
    settings: {
      hubMode: 'client',
      hubUrl: 'https://saved.example',
      secret: 'saved-secret',
      deviceId: 'saved-device',
      syncUploadIntervalMs: 0
    }
  };
  const patches = [];
  let releaseSave;
  let resolveSaveStarted;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise((resolve) => { resolveSaveStarted = resolve; });
  let vmContext;
  vmContext = loadHubSettingsWiring(els, {
    state,
    saveSettings: async (patch) => {
      patches.push({ ...patch });
      resolveSaveStarted();
      await saveGate;
      Object.assign(state.settings, patch);
      vmContext.syncHubDraftFields();
    },
    refreshHubInfo: async () => {},
    refreshHubBuildStatus: async () => {},
    refreshStats: async () => {}
  });
  vmContext.syncHubDraftFields();

  els.hubUrlInput.value = 'https://draft-a.example';
  els.secretInput.value = 'draft-secret';
  els.deviceIdInput.value = 'draft-device';
  await els.hubUrlInput.dispatch('input');
  await els.secretInput.dispatch('input');
  await els.deviceIdInput.dispatch('input');

  const savePromise = els.saveSettingsButton.dispatch('click');
  await saveStarted;
  els.hubUrlInput.value = 'https://draft-b.example';
  await els.hubUrlInput.dispatch('input');
  releaseSave();
  await savePromise;

  assert.deepEqual(patches, [{
    hubUrl: 'https://draft-a.example',
    secret: 'draft-secret',
    deviceId: 'draft-device'
  }]);
  assert.equal(els.hubUrlInput.value, 'https://draft-b.example');
  assert.equal(els.secretInput.value, 'draft-secret');
  assert.equal(els.deviceIdInput.value, 'draft-device');
  vmContext.syncHubDraftFields();
  assert.equal(els.hubUrlInput.value, 'https://draft-b.example');
});

test('Hub Save keeps an in-flight edit even when it returns to the persisted value', async () => {
  const els = {
    saveSettingsButton: fakeHubControl(),
    hubUrlInput: fakeHubControl(),
    secretInput: fakeHubControl(),
    deviceIdInput: fakeHubControl(),
    syncUploadIntervalInput: fakeHubControl('0'),
    showLimitUsedInputs: []
  };
  const state = {
    settings: {
      hubMode: 'client',
      hubUrl: 'https://saved.example',
      secret: 'saved-secret',
      deviceId: 'saved-device',
      syncUploadIntervalMs: 0
    }
  };
  let releaseSave;
  let resolveSaveStarted;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise((resolve) => { resolveSaveStarted = resolve; });
  let vmContext;
  vmContext = loadHubSettingsWiring(els, {
    state,
    saveSettings: async (patch) => {
      resolveSaveStarted();
      await saveGate;
      Object.assign(state.settings, patch);
      vmContext.syncHubDraftFields();
    },
    refreshHubInfo: async () => {},
    refreshHubBuildStatus: async () => {},
    refreshStats: async () => {}
  });
  vmContext.syncHubDraftFields();

  els.hubUrlInput.value = 'https://draft.example';
  await els.hubUrlInput.dispatch('input');

  const savePromise = els.saveSettingsButton.dispatch('click');
  await saveStarted;
  els.hubUrlInput.value = 'https://saved.example';
  await els.hubUrlInput.dispatch('input');
  releaseSave();
  await savePromise;

  assert.equal(els.hubUrlInput.value, 'https://saved.example');
  vmContext.syncHubDraftFields();
  assert.equal(els.hubUrlInput.value, 'https://saved.example');
});

test('Host Hub port draft survives settings rehydration and saves with Hub fields', async () => {
  const classList = { toggle() {} };
  const els = {
    saveSettingsButton: fakeHubControl(),
    hubModeOptions: { querySelectorAll: () => [] },
    hubClientFields: { classList },
    hubHostFields: { classList },
    hubPortInput: fakeHubControl(),
    hubSecretInput: fakeHubControl(),
    hubUrlInput: fakeHubControl(),
    secretInput: fakeHubControl(),
    deviceIdInput: fakeHubControl(),
    syncUploadIntervalInput: fakeHubControl('0'),
    showLimitUsedInputs: []
  };
  const state = {
    settings: {
      hubMode: 'host',
      hubHostPort: 17321,
      hubHostSecret: 'host-secret',
      hubUrl: '',
      secret: '',
      deviceId: 'saved-device',
      syncUploadIntervalMs: 0
    }
  };
  const patches = [];
  let vmContext;
  vmContext = loadHubSettingsWiring(els, {
    state,
    saveSettings: async (patch) => {
      patches.push({ ...patch });
      Object.assign(state.settings, patch);
      vmContext.syncHubModeUi();
      vmContext.syncHubDraftFields();
    },
    refreshHubInfo: async () => {},
    refreshHubBuildStatus: async () => {},
    refreshStats: async () => {}
  });
  vmContext.syncHubModeUi();
  vmContext.syncHubDraftFields();

  els.hubPortInput.value = '18000';
  await els.hubPortInput.dispatch('input');
  // Model the same renderer rehydration that follows any settings push.
  vmContext.syncHubModeUi();
  vmContext.syncHubDraftFields();
  assert.equal(els.hubPortInput.value, '18000');

  await els.saveSettingsButton.dispatch('click');
  assert.deepEqual(patches, [{
    hubUrl: '',
    secret: '',
    deviceId: 'saved-device',
    hubHostPort: 18000
  }]);
  assert.equal(els.hubPortInput.value, '18000');
});

test('remote Hub build status is wired as a separate localized sync hint', () => {
  const html = readRendererFile('index.html');
  const app = readRendererFile('app.js');
  const i18n = readRendererFile('i18n.js');
  const preload = fs.readFileSync(path.join(rendererDir, '..', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const clientFields = html.slice(html.indexOf('<div id="hubClientFields"'), html.indexOf('<div id="hubHostFields"'));

  assert.match(clientFields, /id="syncClientStatus"[\s\S]*id="hubBuildStatus"[\s\S]*role="status"[\s\S]*hidden/);
  assert.ok(html.indexOf('hubBuildPresentation.js') < html.indexOf('app.js'));
  assert.match(app, /getHubBuildStatus/);
  assert.match(app, /function renderHubBuildStatus\(\)/);
  assert.doesNotMatch(app, /await refreshHubBuildStatus\(\)/);
  assert.equal([...app.matchAll(/void refreshHubBuildStatus\(\)/g)].length, 5);
  const refreshBody = functionBody(app, 'refreshHubBuildStatus', 'syncPeriodTabs');
  assert.match(refreshBody, /const request = \+\+hubBuildStatusRequest/);
  assert.equal([...refreshBody.matchAll(/request !== hubBuildStatusRequest/g)].length, 2);
  assert.match(app, /HUB_BUILD_STATUS_REFRESH_TTL_MS = 5 \* 60 \* 1000/);
  assert.match(app, /visibilitychange[\s\S]*hubBuildStatusRefreshDue\(\)[\s\S]*void refreshHubBuildStatus\(\)/);
  assert.match(preload, /getHubBuildStatus: \(\) => ipcRenderer\.invoke\('hub:getBuildStatus'\)/);
  assert.match(main, /ipcMain\.handle\('hub:getBuildStatus'/);
  assert.equal([...i18n.matchAll(/'settings\.sync\.hubBuild\.current':/g)].length, 5);
  assert.equal([...i18n.matchAll(/'settings\.sync\.hubBuild\.updateAvailable':/g)].length, 5);
  assert.equal([...i18n.matchAll(/'settings\.sync\.hubBuild\.legacy':/g)].length, 0);
});

test('main settings normalize collection cadence and replace only usage when it changes', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const collector = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', 'collector.js'), 'utf8');
  assert.match(main, /function normalizeCollectionMode/);
  assert.match(main, /function normalizeCollectionIntervalMs/);
  assert.match(main, /COLLECTION_MODE_VALUES = new Set\(\[[^\]]*'smart'/);
  assert.match(main, /SMART_COLLECTION_INTERVAL_MS = 10 \* 60 \* 1000/);
  // Smart's fixed cadence must not enter the persisted-interval allowlist, or a
  // smart-mode value survives a switch back to live and changes its backstop.
  assert.doesNotMatch(main, /COLLECTION_INTERVAL_OPTIONS = \[[^\]]*10 \* 60 \* 1000/);

  const defaults = main.slice(main.indexOf('function defaultSettings'), main.indexOf('function defaultLimitProviders'));
  assert.match(defaults, /collectionMode: 'live'/);
  assert.match(defaults, /collectionIntervalMs: 5 \* 60 \* 1000/);

  const usageConfig = functionBody(main, 'electronUsageConfig', 'electronLimitsConfig');
  assert.match(usageConfig, /intervalMs: collectorIntervalMs\(\)/);
  assert.match(usageConfig, /watchEnabled: collectorWatchEnabled\(\)/);
  assert.match(usageConfig, /watchTriggersCollection: collectorWatchTriggersCollection\(\)/);
  assert.match(usageConfig, /intervalRequiresActivity: collectorIntervalRequiresActivity\(\)/);

  // Every mode watches with native events on every platform, so the widget must
  // state no preference at all: the moment it passes one it can drift from the
  // headless agent, which passes none. The shared resolver owns the default and
  // the TOKEN_MONITOR_WATCH_POLLING override, and degrades to polling itself
  // when the kernel refuses watch descriptors. Behaviour is covered in
  // tests/shared/collectorLoadGuards.test.js.
  assert.doesNotMatch(usageConfig, /^\s*watchUsePolling:/m);
  assert.doesNotMatch(main, /function collectorWatchUsePolling/);
  assert.match(collector, /const watchUsePolling = resolveWatchUsePolling\(options\.watchUsePolling\)/);
  assert.match(collector, /function resolveWatchUsePolling[\s\S]*?TOKEN_MONITOR_WATCH_POLLING/);
  assert.match(main, /function collectorIntervalRequiresActivity[\s\S]*?=== 'smart'/);

  const updateHandler = main.slice(main.indexOf("ipcMain.handle('settings:update'"), main.indexOf("ipcMain.handle('appearance:preview'"));
  assert.match(updateHandler, /const previousRuntimeSettings = JSON\.parse\(JSON\.stringify\(settings\)\);/);
  assert.match(updateHandler, /normalizedPatch\.collectionMode = normalizeCollectionMode/);
  assert.match(updateHandler, /normalizedPatch\.collectionIntervalMs = normalizeCollectionIntervalMs/);
  assert.match(updateHandler, /collectionMode: normalizeCollectionMode/);
  assert.match(updateHandler, /collectionIntervalMs: normalizeCollectionIntervalMs/);
  assert.match(updateHandler, /if \(runtimeChange\.usageStructural\) \{\s*reconfigureUsageRuntimeForMode\(\);\s*\}/);
});

test('main settings normalize sync upload intervals and restart only the device runtime when it changes', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const envExample = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  assert.match(main, /createSyncUploadScheduler/);
  assert.match(main, /normalizeSyncUploadIntervalMs/);
  assert.match(envExample, /TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS=0/);
  assert.match(envExample, /600000 \(10 min\).*1200000 \(20 min\).*1800000 \(30 min\)/);

  const defaults = main.slice(main.indexOf('function defaultSettings'), main.indexOf('function defaultLimitProviders'));
  assert.match(defaults, /syncUploadIntervalMs: normalizeSyncUploadIntervalMs\(process\.env\.TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS\)/);

  const readSettingsBody = functionBody(main, 'readSettings', 'saveSettings');
  assert.match(readSettingsBody, /merged\.syncUploadIntervalMs = normalizeSyncUploadIntervalMs\(merged\.syncUploadIntervalMs\);/);

  const syncCollector = main.slice(main.indexOf('function startSyncCollector'), main.indexOf('// Host mode'));
  assert.match(syncCollector, /createSyncUploadScheduler\(\{/);
  assert.match(syncCollector, /intervalMs: syncUploadIntervalMs\(\)/);
  assert.match(syncCollector, /const visibleSummary = \{[\s\S]*\.\.\.summary,[\s\S]*syncUploadIntervalMs: syncUploadIntervalMs\(\)[\s\S]*\};/);
  assert.match(syncCollector, /transformUsage: summaryWithArchivedClientUsage/);
  assert.match(syncCollector, /await syncUploadScheduler\.enqueue\(visibleSummary, revision\)/);

  const hostCollector = main.slice(main.indexOf('function startHostCollector'), main.indexOf('function stopHostStats'));
  assert.doesNotMatch(hostCollector, /createSyncUploadScheduler|syncUploadScheduler/);
  assert.match(hostCollector, /embeddedHub\.hub\.ingest\(payload\)/);

  const updateHandler = main.slice(main.indexOf("ipcMain.handle('settings:update'"), main.indexOf("ipcMain.handle('appearance:preview'"));
  assert.match(updateHandler, /normalizedPatch\.syncUploadIntervalMs = normalizeSyncUploadIntervalMs/);
  assert.match(updateHandler, /syncUploadIntervalMs: normalizeSyncUploadIntervalMs/);
  assert.match(updateHandler, /else if \(runtimeChange\.sinkStructural\) \{[\s\S]*?restartDeviceRuntimeForMode\(\);[\s\S]*?\} else \{/);
});

test('main collectors share one live GUI limit credential resolver in every widget mode', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const runtimeConfig = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'runtimeConfig.js'), 'utf8');
  const collectors = [
    functionBodyBeforeMarker(main, 'startSyncCollector', '// Host mode'),
    functionBody(main, 'startHostCollector', 'stopHostStats'),
    functionBody(main, 'startLocalCollector', 'scheduleStreamRetry')
  ];
  for (const collector of collectors) {
    assert.match(collector, /limitsOptions: electronLimitsConfig\(\)/);
    assert.match(collector, /limitsDeps: electronLimitsDeps\(\)/);
  }
  const limitsDeps = functionBody(main, 'electronLimitsDeps', 'normalizeDeepSeekApiKey');
  assert.match(limitsDeps, /fetch: electronLimitsFetch\(\)/);
  assert.match(limitsDeps, /resolveConfigSnapshot: \(\) => electronLimitsConfig\(\)/);
  assert.match(limitsDeps, /onClaudeWebCookieRenewed: persistClaudeWebCookieRenewal/);
  const renewalPersistence = functionBody(
    main,
    'persistClaudeWebCookieRenewal',
    'electronLimitsDeps'
  );
  assert.match(renewalPersistence, /settings\.claudeWebCookie === renewed\) return true/);
  assert.match(renewalPersistence, /saveSettings\(\{ throwOnError: true \}\)/);
  assert.doesNotMatch(renewalPersistence, /queueLimitInvalidation|classifySettingsChange/);
  for (const key of [
    'claudeWebCookie', 'zaiApiKey', 'zaiApiRegion', 'volcengineAccessKeyId', 'volcengineSecretAccessKey',
    'volcengineRegion', 'qoderCookie', 'qoderSite', 'commandcodeCookie', 'kimiApiKey', 'kimiWebAccessToken',
    'ollamaCookie'
  ]) assert.match(runtimeConfig, new RegExp(`${key}: settings\\.${key}`));
});

test('WorkBuddy Electron fetch adapter forwards parsed response JSON', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  assert.match(main, /createWorkbuddyLocalAuth\(\{\s*fetch: electronLimitsFetch\(\)/);
  const limitsDeps = functionBody(main, 'electronLimitsDeps', 'normalizeDeepSeekApiKey');
  assert.match(limitsDeps, /json: \(\) => result\.json\(\)/);
  assert.doesNotMatch(limitsDeps, /result\.body/);
});

test('main settings migrateLimitProviders normalizes without expanding old defaults', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const body = functionBody(main, 'migrateLimitProviders', 'migrateLimitProviderOrder');
  assert.match(body, /return parseLimitProviders\(value\)\.join/);
  assert.doesNotMatch(body, /preMimoDefault|legacyDefault.*return defaultLimitProviders/);
});

test('Home limits groups multiple MiMo accounts like Codex', () => {
  const app = readRendererFile('app.js');
  const groupBody = functionBody(app, 'renderMimoAccountGroup', 'renderOpenCodeAccountGroup');
  const renderLimitsBody = functionBody(app, 'renderLimits', 'serviceStatusLabel');
  // accountGroup marks the synthetic header provider, so a subscription card on
  // it summarises the group instead of adopting one member's record.
  assert.match(groupBody, /const groupProvider = \{ provider: 'mimo', status: 'ok', windows: \[\], accountGroup: true \};/);
  assert.match(groupBody, /planText: t\('settings\.mimo\.nAccounts', \{ count: providers\.length \}\)/);
  assert.match(groupBody, /renderLimitProviderRow\('mimo', limitAccountTitle\('mimo', provider, index, providers\), provider, color/);
  assert.match(renderLimitsBody, /if \(id === 'mimo' && Array\.isArray\(visibleProviders\) && visibleProviders\.length > 1\) \{/);
  assert.match(renderLimitsBody, /nodes\.push\(renderMimoAccountGroup\(label, visibleProviders, color\)\);/);
});

test('Limits groups multiple Cursor accounts with separate identity and plan rows', () => {
  const app = readRendererFile('app.js');
  const groupBody = functionBody(app, 'renderCursorAccountGroup', 'renderOpenCodeAccountGroup');
  const renderLimitsBody = functionBody(app, 'renderLimits', 'serviceStatusLabel');
  assert.match(groupBody, /const groupProvider = \{ provider: 'cursor', status: 'ok', windows: \[\], accountGroup: true \};/);
  assert.match(groupBody, /planText: t\('settings\.cursor\.nAccounts', \{ count: providers\.length \}\)/);
  assert.match(groupBody, /renderLimitProviderRow\('cursor', limitAccountTitle\('cursor', provider, index, providers\), provider, color/);
  assert.match(renderLimitsBody, /if \(id === 'cursor' && Array\.isArray\(visibleProviders\) && visibleProviders\.length > 1\) \{/);
  assert.match(renderLimitsBody, /nodes\.push\(renderCursorAccountGroup\(label, visibleProviders, color\)\);/);
});

test('a zero-config OpenCode machine is not reported as unconfigured', () => {
  // The whole point of the API path is that Go quota needs no setup. If the
  // panel derives its state only from stored profiles, that machine shows live
  // quota on the limits card and "not set up" in settings at the same time.
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');

  const gate = main.slice(
    main.indexOf('function opencodeAmbientKeyActive'),
    main.indexOf('async function probeOpenCodeApiKey')
  );
  assert.ok(gate, 'ambient gate should exist');
  // It must mirror the collector's selection: the ambient key is its own
  // account whenever it exists, and is hidden only once a saved account carries
  // that same key — the point at which the user has said they are one account.
  assert.match(gate, /opencodeGoApi\.readGoApiKey\(process\.env\)/);
  // One predicate, shared with the collector. Two copies of "who owns the
  // auto-detected key" drift into a panel offering a row the collector is not
  // scanning; its behaviour is covered in tests/shared/opencodeProfiles.test.js.
  assert.match(gate, /!opencodeProfiles\.ambientKeyClaimed\(profiles, ambientKey, ambientIdentity\)/);

  const status = main.slice(
    main.indexOf("ipcMain.handle('opencode:status'"),
    main.indexOf("ipcMain.handle('opencode:getProfiles'")
  );
  assert.ok(status, 'status handler should exist');
  assert.match(status, /opencodeAmbientKeyActive\(profiles\)/);
  // Account names are user-chosen, so any sentinel key inside `profiles` is one
  // a user can type; the synthetic entry rides in its own field instead.
  assert.match(status, /const value = \{\s*profiles: result,\s*ambient,/);
  assert.doesNotMatch(status, /result\[[^\]]*[Aa]mbient/);
  // A profile that only names the ambient key stores no credential of its own,
  // so a `cookie || apiKey` filter drops it and its row never leaves the
  // placeholder while the collector is reading live quota from that same key.
  // Both the filter and the probe resolve the key the way the collector does.
  assert.match(status, /const profileKey = \(p\) => p\.apiKey \|\| opencodeProfiles\.ambientKeyFor\(p, ambientKey, ambientIdentity\);/);
  // A reference whose pin no longer matches keeps its row and says so, rather
  // than being filtered out and leaving the row on its placeholder forever.
  assert.match(status, /const needsRebind = \(p\) => Boolean\(p\.useAmbientKey\) && !profileKey\(p\) && !p\.cookie;/);
  assert.match(status, /\.filter\(\(\[, p\]\) => \(p\.cookie \|\| profileKey\(p\) \|\| needsRebind\(p\)\) && p\.enabled\)/);
  assert.match(status, /needsRebind: true/);
  // Provider-wide, like every ownership change: this row has no account name for
  // a scoped refresh to address.
  const ambientToggle = main.slice(
    main.indexOf("ipcMain.handle('opencode:setAmbientEnabled'"),
    main.indexOf("ipcMain.handle('openrouter:getProfiles'")
  );
  assert.ok(ambientToggle, 'setAmbientEnabled handler should exist');
  assert.match(ambientToggle, /queueLimitInvalidation\(\{ provider: 'opencode' \}, 'ambient-toggle', \{ clear: true \}\)/);
  // Clearing the provider without a refresh behind it wipes every OpenCode
  // account and rebuilds none: switching off the detected key would read as
  // switching off the provider.
  assert.doesNotMatch(ambientToggle, /refresh: false/);
  assert.match(status, /const apiKey = profileKey\(profile\);/);
  assert.doesNotMatch(status, /probeOpenCodeApiKey\(profile\.apiKey\)/);

  const profilesHandler = main.slice(
    main.indexOf("ipcMain.handle('opencode:getProfiles'"),
    main.indexOf("ipcMain.handle('opencode:saveProfile'")
  );
  // hasEnvVar keeps meaning "environment cookie". Folding the ambient key into
  // it would make a later reader assume an env var that is not set.
  assert.match(profilesHandler, /const hasEnvVar = Boolean\(process\.env\.TOKEN_MONITOR_OPENCODE_COOKIE\);/);
  // Which credential kinds an account holds crosses to the renderer; none of
  // their values do.
  assert.match(profilesHandler, /hasApiKey: Boolean\(p\.apiKey\)/);
  assert.match(profilesHandler, /hasCookie: Boolean\(p\.cookie\)/);
  assert.match(profilesHandler, /usesAmbientKey: Boolean\(p\.useAmbientKey\)/);
  // Held but not resolving is its own state: on an account that also has a
  // cookie, nothing else in the panel would reveal it.
  assert.match(profilesHandler, /ambientStale: Boolean\(p\.useAmbientKey\)/);
});

test('OpenCode credentials are named, merged and removed one at a time', () => {
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');

  const save = main.slice(
    main.indexOf("ipcMain.handle('opencode:saveProfile'"),
    main.indexOf("ipcMain.handle('opencode:setProfileEnabled'")
  );
  assert.ok(save, 'saveProfile handler should exist');
  // Naming the auto-detected credential stores a reference, never the key, so a
  // key rotated inside OpenCode is still read live instead of going stale.
  assert.match(save, /\['api', 'cookie', 'ambient'\]\.includes\(kind\)/);
  // Bound to the account signed in at the time: the API returns no workspace id,
  // so a key that later changes cannot be told apart from a different account's.
  assert.match(save, /ambientKeyIdentity: opencodeGoApi\.goApiIdentity\(ambientKey\)/);
  assert.doesNotMatch(save, /useAmbientKey: true, apiKey/);

  // Every operation that could bind or destroy a credential goes through the
  // shared profile algebra, so the rule is one testable function rather than
  // four handlers that have to agree. Its behaviour is covered for real in
  // tests/shared/opencodeProfiles.test.js; what matters here is that no handler
  // reaches around it.
  const handlers = main.slice(
    main.indexOf("ipcMain.handle('opencode:saveProfile'"),
    main.indexOf("ipcMain.handle('openrouter:getProfiles'")
  );
  for (const call of [
    /opencodeProfiles\.saveCredential\(\s*settings\.opencodeProfiles \|\| \{\},\s*name,\s*credential,\s*\{ merge: options\.merge === true \}/,
    /opencodeProfiles\.removeCredential\(settings\.opencodeProfiles \|\| \{\}, name, kind\)/,
    /opencodeProfiles\.moveCredential\(/,
    /opencodeProfiles\.renameProfile\(/
  ]) assert.match(handlers, call);
  // The rule is not re-implemented alongside the module that owns it.
  assert.doesNotMatch(handlers, /options\.merge !== true/);
  assert.doesNotMatch(handlers, /api: 'apiKey', cookie: 'cookie', ambient: 'useAmbientKey'/);
});

test('the OpenCode local fallback toggle is relocated once, not once per render', () => {
  const app = readRendererFile('app.js');
  const body = functionBody(app, 'moveOpenCodeLocalFallbackSetting', 'limitProviderAccountGroup');
  assert.ok(body, 'relocation helper should exist');
  // The shared renderer builds a fresh settings list every pass, so a move that
  // does not clear the destination stacks one copy of the toggle per re-render.
  assert.match(body, /for \(const stale of \[\.\.\.target\.children\]\) if \(stale !== list\) stale\.remove\(\);/);
  // The group header already names the setting, so the item title would read
  // twice; dropping it alone leaves the label cell empty and the switch adrift.
  assert.match(body, /querySelector\('\.settings-item-title'\)\?\.remove\(\)/);
  assert.match(body, /if \(cell && desc && desc\.parentElement !== cell\) cell\.append\(desc\)/);
  // The shared collapsible helper, not a second hand-rolled one, which also
  // means the ids have to follow its \`\${prefix}SettingsToggle\` convention.
  assert.match(body, /setAccountGroupExpanded\(\s*'opencodeLocalFallback'/);
  assert.match(body, /getElementById\('opencodeLocalFallbackSettingsToggle'\)/);

  const html = readRendererFile('index.html');
  const details = html.match(/<div id="opencodeSettingsDetails"[\s\S]*?<div id="opencodeErrorMessage"/)?.[0] || '';
  // The collapse animates by squeezing one inner wrapper; a bare container has
  // nothing to shrink and keeps its height however the class is toggled.
  assert.match(details, /<div id="opencodeLocalFallbackSettingsDetails"[^>]*>\s*<div id="opencodeLocalFallbackInner" class="accordion-animation-inner">/);
  // Accounts first, then the off-by-default estimate, then adding an account.
  const order = ['settings.opencode.accountsNote', 'opencodeProfileList', 'opencodeLocalFallbackAccountGroup', 'opencodeAddForm']
    .map((token) => details.indexOf(token));
  assert.ok(order.every((index) => index >= 0), 'panel should contain note, list, fallback and add form');
  assert.deepEqual(order, [...order].sort((a, b) => a - b));

  // Left with only its description, the text cell's content-based flex basis
  // claims the whole line on its own and wraps the switch onto a second row.
  const css = readRendererFile('styles.css');
  assert.match(css, /#opencodeLocalFallbackInner \.settings-item > \.settings-item-text \{[^}]*flex: 1 1 0;/);
});

test('an expanded OpenCode account animates and its merge button gets its own row', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');

  // The shared accordion squeezes one inner wrapper; rows placed directly on
  // the container leave it with nothing to shrink.
  assert.match(app, /credentialList\.className = 'opencode-credential-list accordion-animated-container hidden';/);
  assert.match(app, /credentialInner\.className = 'accordion-animation-inner';/);
  assert.match(app, /credentialInner\.append\(opencodeCredentialRow\(name, kind, label\)\)/);
  assert.match(app, /credentialList\.append\(credentialInner\)/);
  // That container stays in the grid while collapsed, so a row gap would pad
  // every multi-credential account by its full height with nothing shown.
  assert.match(css, /\.opencode-profile-item \{[^}]*gap: 0 8px;/);

  // The merge label carries the target account name and never fits beside the
  // input or in the cell next to the rename button.
  assert.match(app, /row\.append\(labelSpan, nameInput, actions, mergeBtn\);/);
  assert.match(css, /#opencodeProfileList \.opencode-profile-item \.profile-name-box \{\s*grid-template-areas:\s*"name rename \."\s*"merge merge merge"\s*"detail detail detail";/);
  // Scoped to OpenCode: the other profile lists share this grid and have no
  // merge button, so they keep the two-row template.
  assert.match(css, /\.opencode-profile-item \.profile-name-box \{[^}]*grid-template-areas:\s*"name rename \."\s*"detail detail detail";/);

  // The summary line runs at 9px; the group-header chevron size reads as an
  // oversized arrow beside it.
  assert.match(css, /\.opencode-profile-item \.profile-detail \.cursor-disclosure-icon \{\s*width: 9px;/);
});

// The merge confirmation rule, run rather than pattern-matched. Hiding the
// button on an edit is not enough on its own: the reply that offers it arrives
// after an await, so an edit made while the request is in flight is overtaken
// by that reply and the button comes back describing the proposal the user has
// already left. Loaded through `vm` like the other renderer controllers, so the
// assertions are about behaviour and not about the source that produces it.
function loadOpencodeMergeOffer() {
  const app = readRendererFile('app.js');
  const start = app.indexOf('function opencodeMergeOffer(');
  assert.notEqual(start, -1, 'opencodeMergeOffer should exist');
  const end = app.indexOf('\nfunction ', start + 1);
  assert.notEqual(end, -1, 'opencodeMergeOffer should be followed by another function');
  const context = { module: { exports: null } };
  vm.runInNewContext(`${app.slice(start, end)}\nmodule.exports = opencodeMergeOffer;`, context);
  return context.module.exports;
}

function fakeMergeButton() {
  const clicks = [];
  const button = {
    textContent: '',
    visible: false,
    classList: {
      add: (name) => { if (name === 'hidden') button.visible = false; },
      remove: (name) => { if (name === 'hidden') button.visible = true; }
    },
    addEventListener: (type, listener) => { if (type === 'click') clicks.push(listener); },
    click: () => clicks.forEach((listener) => listener())
  };
  return button;
}

// One save, no interference: the offer appears and confirming it names exactly
// what was proposed.
test('a merge offer confirms the proposal it was made for', async () => {
  const opencodeMergeOffer = loadOpencodeMergeOffer();
  const button = fakeMergeButton();
  const confirmed = [];
  const offer = opencodeMergeOffer(button, (name) => confirmed.push(name));

  let release;
  const reply = new Promise((resolve) => { release = resolve; });
  const save = (async () => {
    const at = offer.revision();
    await reply;
    offer.offer(at, 'work', 'merge into work');
  })();

  assert.equal(button.visible, false);
  release();
  await save;
  assert.equal(button.visible, true);
  assert.equal(button.textContent, 'merge into work');
  button.click();
  assert.deepEqual(confirmed, ['work']);
});

test('an edit made while the save is in flight cancels the offer its reply carries', async () => {
  const opencodeMergeOffer = loadOpencodeMergeOffer();
  const button = fakeMergeButton();
  const confirmed = [];
  const offer = opencodeMergeOffer(button, (name) => confirmed.push(name));

  let release;
  const reply = new Promise((resolve) => { release = resolve; });
  const save = (async () => {
    const at = offer.revision();
    await reply;
    // The proposal this reply answers is no longer the one on screen.
    assert.equal(offer.stale(at), true);
    offer.offer(at, 'work', 'merge into work');
  })();

  offer.withdraw();
  release();
  await save;

  assert.equal(button.visible, false, 'a superseded reply must not put the button back');
  button.click();
  assert.deepEqual(confirmed, [], 'a hidden offer has nothing to confirm');
});

// Two saves can overlap and the newer one can answer first, so an older reply
// has to keep its hands off a proposal that is not its own.
test('an older successful reply leaves a newer offer standing', async () => {
  const opencodeMergeOffer = loadOpencodeMergeOffer();
  const button = fakeMergeButton();
  const confirmed = [];
  const offer = opencodeMergeOffer(button, (name) => confirmed.push(name));

  let releaseOld;
  const oldReply = new Promise((resolve) => { releaseOld = resolve; });
  const oldSave = (async () => {
    const at = offer.revision();
    await oldReply;
    // Succeeded, but for the proposal the user has already replaced.
    if (!offer.stale(at)) offer.withdraw();
  })();

  // The user edits and saves again; that request answers first.
  offer.withdraw();
  const newer = offer.revision();
  offer.offer(newer, 'javis', 'merge into javis');
  assert.equal(button.visible, true);

  releaseOld();
  await oldSave;

  assert.equal(button.visible, true, 'an older success must not clear a newer offer');
  button.click();
  assert.deepEqual(confirmed, ['javis']);
});

// Escape, or a blur onto nothing, cancels the request that is already out. The
// reply still arrives, and it must not put the cancelled proposal back.
test('cancelling an in-flight proposal keeps its reply from resurrecting it', async () => {
  const opencodeMergeOffer = loadOpencodeMergeOffer();
  const button = fakeMergeButton();
  const confirmed = [];
  const offer = opencodeMergeOffer(button, (name) => confirmed.push(name));

  let release;
  const reply = new Promise((resolve) => { release = resolve; });
  const save = (async () => {
    const at = offer.revision();
    await reply;
    offer.offer(at, 'work', 'merge into work');
  })();

  offer.withdraw();
  release();
  await save;

  assert.equal(button.visible, false, 'a cancelled proposal must not come back');
  button.click();
  assert.deepEqual(confirmed, []);
});

// One way down, so a cancel path cannot quietly opt out of invalidating the
// reply that is still in flight.
test('the merge offer has no way to hide without invalidating in-flight replies', () => {
  const app = readRendererFile('app.js');
  assert.doesNotMatch(app, /offer\.hide\(\)|addMergeOffer\?\.hide\(\)/);
  assert.doesNotMatch(app, /hide: \(\) =>/);
});

test('a withdrawn offer stays withdrawn until a new proposal is made', async () => {
  const opencodeMergeOffer = loadOpencodeMergeOffer();
  const button = fakeMergeButton();
  const confirmed = [];
  const offer = opencodeMergeOffer(button, (name) => confirmed.push(name));

  const first = offer.revision();
  offer.withdraw();
  offer.offer(first, 'work', 'merge into work');
  assert.equal(button.visible, false);

  // The next save captures the revision the withdrawal left behind, so the
  // user's new proposal is offered normally.
  const second = offer.revision();
  offer.offer(second, 'personal', 'merge into personal');
  assert.equal(button.visible, true);
  button.click();
  assert.deepEqual(confirmed, ['personal']);
});

// Account names are arbitrary user strings, so the id a row is found by has to
// distinguish every name a user may pick. Sanitizing to a safe character set is
// not injective: `a b` and `a_b` both became `a_b`, and whichever row rendered
// first collected the other's status.
function loadOpencodeRowId() {
  const app = readRendererFile('app.js');
  const start = app.indexOf('function opencodeRowId(');
  assert.notEqual(start, -1, 'opencodeRowId should exist');
  const end = app.indexOf('\n// ', start);
  const context = { module: { exports: null }, encodeURIComponent };
  vm.runInNewContext(`${app.slice(start, end)}\nmodule.exports = opencodeRowId;`, context);
  return context.module.exports;
}

test('two account names a user may pick never share a row id', () => {
  const opencodeRowId = loadOpencodeRowId();
  const names = ['a b', 'a_b', 'a/b', 'a%b', 'a.b', 'work', 'work ', 'wörk', '__proto__', 'a+b'];
  const ids = names.map((name) => opencodeRowId('opencode-info-', name));
  assert.equal(new Set(ids).size, names.length, `collision among ${JSON.stringify(ids)}`);
  // An id may not contain whitespace.
  for (const id of ids) assert.doesNotMatch(id, /\s/, id);
});

test('the row id is a pure function of the name, shared by both call sites', () => {
  const app = readRendererFile('app.js');
  // Rendering and the later status lookup derive it independently, so a shared
  // mutable table could drift between them; nothing may build one by hand.
  assert.doesNotMatch(app, /'opencode-info-' \+ name/);
  assert.doesNotMatch(app, /'opencode-credentials-' \+ name/);
  assert.equal((app.match(/opencodeRowId\('opencode-info-', name\)/g) || []).length, 2);
  assert.equal((app.match(/opencodeRowId\('opencode-credentials-', name\)/g) || []).length, 1);
});
