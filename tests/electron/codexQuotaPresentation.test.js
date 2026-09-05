'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(projectRoot, 'src', 'electron', 'renderer', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(projectRoot, 'src', 'electron', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(projectRoot, 'src', 'electron', 'renderer', 'styles.css'), 'utf8');
const { translate } = require('../../src/electron/renderer/i18n');

const LOCALES = ['en', 'zh-TW', 'zh-CN', 'ko', 'ja'];

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  const endLineStart = source.lastIndexOf('\n', end) + 1;
  return source.slice(start, endLineStart);
}

function functionBodyBeforeMarker(source, name, marker) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(marker, start);
  assert.notEqual(end, -1, `${marker} should follow ${name}`);
  return source.slice(start, end);
}

function extractNamedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  let depth = 0;
  let started = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
      started = true;
    } else if (char === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} function should terminate`);
}

// The estimate block renders nested rows, so the fake node's flat
// `textContent` is never assigned: collect the text recursively instead.
function nodeText(node) {
  if (!node) return '';
  const own = typeof node.textContent === 'string' ? node.textContent : '';
  const childText = (node.children || []).map(nodeText).join(' ');
  return [own, childText].filter(Boolean).join(' ');
}

function createNode() {
  return {
    className: '',
    textContent: '',
    title: '',
    attributes: {},
    children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    append(child) { this.children.push(child); }
  };
}

function renderEstimateContext() {
  return {
    document: { createElement: () => createNode() },
    t: (key, params) => translate('en', key, params),
    formatCompact: (value) => (Math.abs(Number(value)) >= 1_000_000
      ? `${(Number(value) / 1_000_000).toFixed(1)}M`
      : `${Number(value)}`),
    formatCompactMoney: (value) => `$${Number(value).toFixed(2)}`
  };
}

function renderEstimate(windowValue, context = renderEstimateContext()) {
  const helper = extractNamedFunction(app, 'appendCodexQuotaEstimate');
  return vm.runInNewContext(
    `${helper}\nconst node = document.createElement('div');\nappendCodexQuotaEstimate(node, windowValue);\nnode;`,
    { ...context, windowValue }
  );
}

test('Codex canonical windows get localized kind titles, a column divider, and per-window estimates', () => {
  const renderProviderWindows = functionBody(app, 'renderProviderWindows', 'renderLimitProviderRow');
  assert.match(renderProviderWindows, /limitWindowNode\(t\('limits\.codex\.quota\.sessionTitle'\), \{\s*\.\.\.session,\s*label: ''\s*\}/);
  assert.match(renderProviderWindows, /limitWindowNode\(t\('limits\.codex\.quota\.weeklyTitle'\), \{\s*\.\.\.weekly,\s*label: ''\s*\}/);
  assert.match(renderProviderWindows, /if \(session && weekly\) windows\.classList\.add\('limit-windows-codex-pair'\)/);
  assert.match(renderProviderWindows, /codexWindowDividerNode\(\)/);
  // The divider must be appended between the session and weekly nodes so the
  // 1fr/1px/1fr grid places it in its own middle column.
  const sessionAppend = renderProviderWindows.indexOf('appendCodexQuotaEstimate(sessionNode, session)');
  const dividerAppend = renderProviderWindows.indexOf('windows.append(codexWindowDividerNode())');
  const weeklyAppend = renderProviderWindows.indexOf('appendCodexQuotaEstimate(weeklyNode, weekly)');
  assert.ok(sessionAppend < dividerAppend && dividerAppend < weeklyAppend, 'divider sits between the two windows');
  assert.doesNotMatch(renderProviderWindows, /appendCodexQuotaEstimate\(monthlyNode/);
  const helper = extractNamedFunction(app, 'appendCodexQuotaEstimate');
  assert.match(helper, /limits\.codex\.quota\.collecting/);
  assert.match(helper, /limits\.codex\.quota\.disclaimer/);
  assert.match(helper, /formatCompactMoney\(estimate\.pricedUsd, 'USD'\)/);
  assert.doesNotMatch(helper, /official bill(?! or)/i);
  // The helper is pure per-window: it never reads shared renderer state, so
  // one account's estimate can never leak into another account's row.
  assert.match(helper, /window\?\.quotaEstimate/);
  assert.doesNotMatch(helper, /\bstate\./);
});

test('unstable estimates keep capacityUsd in the data but never output the amount', () => {
  const estimate = {
    confidence: 'unstable',
    observedTokens: 1_200_000,
    pricedUsd: 1.25,
    coverage: 1,
    capacityUsd: 5.6,
    reasons: ['cumulative-rollback', 'accounting-baseline-gap']
  };
  const node = renderEstimate({ quotaEstimate: estimate });
  // The internal quota contract still carries the raw fit for audit; only the
  // main view suppresses it.
  assert.equal(estimate.capacityUsd, 5.6);
  const text = nodeText(node);
  assert.match(text, /Volatile samples, collecting/);
  assert.match(text, /Observed/);
  assert.match(text, /\$1\.25 API eq/);
  assert.match(text, /1\.2M/);
  assert.doesNotMatch(text, /\$5\.60/);
  assert.doesNotMatch(text, /5\.60/);
  assert.doesNotMatch(text, /Est\. full quota/i);
  assert.doesNotMatch(text, /Preliminary/i);
  // Full pricing coverage adds no coverage row.
  assert.doesNotMatch(text, /Priced/);
  // Unstable diagnostics ride the existing tooltip surface, along with the
  // counterfactual-pricing disclaimer for the observed money.
  assert.match(node.children[0].title, /cumulative-rollback, accounting-baseline-gap/);
  assert.match(node.children[0].title, /not an official bill or subscription credit/i);
});

test('preliminary estimates show a hedged amount, never a full-cycle claim', () => {
  const node = renderEstimate({
    quotaEstimate: {
      confidence: 'preliminary',
      observedTokens: 1_000,
      pricedUsd: 1.25,
      coverage: 1,
      capacityUsd: 10
    }
  });
  const text = nodeText(node);
  assert.match(text, /Preliminary est\./);
  assert.match(text, /\$10\.00/);
  assert.doesNotMatch(text, /Est\. full quota/i);
  assert.match(node.children[0].title, /not an official bill or subscription credit/i);
});

test('only stable estimates present the full quota amount', () => {
  const node = renderEstimate({
    quotaEstimate: {
      confidence: 'stable',
      observedTokens: 10_000_000,
      pricedUsd: 22.09,
      coverage: 1,
      capacityUsd: 44.19
    }
  });
  const text = nodeText(node);
  assert.match(text, /Est\. full quota/);
  assert.match(text, /\$44\.19/);
  assert.match(node.children[0].title, /not an official bill or subscription credit/i);
});

test('collecting and unavailable states never emit a dollar figure', () => {
  const collecting = renderEstimate({
    quotaEstimate: { confidence: 'collecting', observedTokens: null, pricedUsd: null, coverage: null, capacityUsd: null }
  });
  assert.equal(nodeText(collecting), 'Collecting local usage');
  assert.doesNotMatch(nodeText(collecting), /\$/);
  assert.equal(collecting.children[0].title, '');
  const unavailable = renderEstimate({
    quotaEstimate: { confidence: 'unavailable', observedTokens: null, pricedUsd: null, coverage: null, capacityUsd: 99 }
  });
  assert.match(nodeText(unavailable), /Unable to estimate/);
  assert.doesNotMatch(nodeText(unavailable), /\$99|\$0/);
  const unavailableWithObserved = renderEstimate({
    quotaEstimate: { confidence: 'unavailable', observedTokens: 500, pricedUsd: null, coverage: null, capacityUsd: null }
  });
  assert.match(nodeText(unavailableWithObserved), /Unable to estimate/);
  assert.match(nodeText(unavailableWithObserved), /500/);
});

test('partial pricing coverage surfaces its own row, complete coverage stays quiet', () => {
  const partial = renderEstimate({
    quotaEstimate: { confidence: 'unstable', observedTokens: 1_200_000, pricedUsd: 0.8, coverage: 0.82, capacityUsd: 5.6 }
  });
  const partialText = nodeText(partial);
  assert.match(partialText, /Priced/);
  assert.match(partialText, /82%/);
  const rows = partial.children[0].children;
  assert.equal(rows.length, 3);
  assert.equal(rows[1].children[0].textContent, 'Priced');
  assert.equal(rows[1].children[1].textContent, '82%');
});

test('the same observed amount renders inside each window without leaking capacity across rows', () => {
  // The same local usage legitimately lands in both the 5-hour and weekly
  // windows: each window block shows its own copy of the observed amount.
  const session = renderEstimate({
    quotaEstimate: { confidence: 'unstable', observedTokens: 1_200_000, pricedUsd: 1.25, coverage: 1, capacityUsd: 5.6 }
  });
  const weekly = renderEstimate({
    quotaEstimate: { confidence: 'collecting', observedTokens: 1_200_000, pricedUsd: 1.25, coverage: null, capacityUsd: null }
  });
  assert.match(nodeText(session), /\$1\.25/);
  assert.match(nodeText(weekly), /\$1\.25/);
  assert.doesNotMatch(nodeText(weekly), /\$5\.60/);
  // Account A's stable capacity never appears in account B's row and vice
  // versa: each render consumes only its own window's estimate.
  const accountA = renderEstimate({
    quotaEstimate: { confidence: 'stable', observedTokens: 10_000_000, pricedUsd: 22.09, coverage: 1, capacityUsd: 44.19 }
  });
  const accountB = renderEstimate({
    quotaEstimate: { confidence: 'unstable', observedTokens: 1_200_000, pricedUsd: 1.25, coverage: 1, capacityUsd: 5.6 }
  });
  assert.match(nodeText(accountA), /\$44\.19/);
  assert.doesNotMatch(nodeText(accountB), /\$44\.19/);
  assert.doesNotMatch(nodeText(accountA), /\$5\.60/);
});

test('window titles and estimate copy exist in every bundled locale and never leak keys', () => {
  for (const locale of LOCALES) {
    const keys = [
      'sessionTitle',
      'weeklyTitle',
      'observedLabel',
      'coverageLabel',
      'capacityLabel',
      'preliminaryLabel',
      'priced',
      'collecting',
      'unstable',
      'unavailable',
      'disclaimer'
    ];
    for (const key of keys) {
      const value = translate(locale, `limits.codex.quota.${key}`);
      assert.notEqual(value, `limits.codex.quota.${key}`, `${locale} should translate ${key}`);
      assert.ok(value.trim(), `${locale} should not leave ${key} empty`);
    }
    const sessionTitle = translate(locale, 'limits.codex.quota.sessionTitle');
    const weeklyTitle = translate(locale, 'limits.codex.quota.weeklyTitle');
    assert.notEqual(sessionTitle, weeklyTitle, `${locale} should distinguish the two windows`);
    // The wording tiers must stay distinguishable within a locale.
    assert.notEqual(translate(locale, 'limits.codex.quota.capacityLabel'), translate(locale, 'limits.codex.quota.preliminaryLabel'));
  }
  assert.equal(translate('zh-CN', 'limits.codex.quota.sessionTitle'), '5 小时额度');
  assert.equal(translate('zh-CN', 'limits.codex.quota.weeklyTitle'), '每周额度');
  assert.equal(translate('zh-CN', 'limits.codex.quota.capacityLabel'), '估算完整额度');
  assert.equal(translate('zh-CN', 'limits.codex.quota.preliminaryLabel'), '初步估算');
  assert.equal(translate('zh-CN', 'limits.codex.quota.unstable'), '样本波动较大，继续收集');
  assert.equal(translate('en', 'limits.codex.quota.sessionTitle'), '5-hour quota');
  assert.equal(translate('en', 'limits.codex.quota.weeklyTitle'), 'Weekly quota');
});

test('quota rows keep stable local alignment and the narrow-window layout stacks instead of shrinking', () => {
  assert.match(styles, /\.codex-quota-estimate\s*\{/);
  assert.match(styles, /\.codex-quota-row\s*\{[^}]*justify-content: space-between;/s);
  assert.match(styles, /\.codex-quota-key\s*\{[^}]*text-overflow: ellipsis;/s);
  assert.match(styles, /\.codex-quota-value\s*\{[^}]*text-overflow: ellipsis;/s);
  // The divider column separates the two windows at normal width.
  assert.match(styles, /\.limit-windows-codex-pair\s*\{[^}]*grid-template-columns: 1fr 1px 1fr;/s);
  assert.match(styles, /\.codex-window-divider\s*\{/);
  // Narrow windows stack the pair and drop the divider rather than compressing
  // the rows into overlapping text.
  const narrow = styles.slice(styles.indexOf('@media (max-width: 300px)'));
  assert.match(narrow, /\.limit-windows-codex-pair\s*\{\s*grid-template-columns: 1fr;\s*\}/);
  assert.match(narrow, /\.codex-window-divider\s*\{\s*display: none;\s*\}/);
  // No negative letter-spacing and no viewport-scaled fonts in the new rules
  // (line 6565's -0.01em predates this change and is out of scope here).
  const codexQuotaCss = styles.slice(
    styles.indexOf('.codex-quota-estimate'),
    styles.indexOf('.limit-spend-line', styles.indexOf('.codex-window-divider'))
  );
  assert.doesNotMatch(codexQuotaCss, /letter-spacing:\s*-/);
  assert.doesNotMatch(codexQuotaCss, /font-size:\s*[^;]*vw/);
});

test('main captures local Codex quota in every widget collector and overlays presentation only', () => {
  const syncCollector = functionBodyBeforeMarker(main, 'startSyncCollector', '// Host mode');
  const hostCollector = functionBody(main, 'startHostCollector', 'stopHostStats');
  const localCollector = functionBody(main, 'startLocalCollector', 'scheduleStreamRetry');
  for (const collector of [syncCollector, hostCollector, localCollector]) {
    assert.match(collector, /captureCodexQuotaFromDevice\(lastCollectedDevice\)/);
  }
  assert.match(main, /function electronPresentationStats\(stats\)[\s\S]*projectLimitStatsForDisplay[\s\S]*attachCodexQuotaEstimates/);
  assert.match(main, /codex-quota-archive\.json/);
  // Persistence lives in the extracted archive store, whose damaged-file
  // fail-closed behaviour is covered by its own test file.
  assert.match(main, /createCodexQuotaArchiveStore\(codexQuotaArchivePath\(\)\)/);
  const store = fs.readFileSync(path.join(projectRoot, 'src', 'electron', 'codexQuotaArchive.js'), 'utf8');
  assert.match(store, /locked/);
  assert.match(store, /writeJsonAtomic/);
  assert.doesNotMatch(main, /ipcMain\.handle\('codexQuota/);
  assert.doesNotMatch(main, /syncPayload\([^)]*quotaEstimate/);
});
