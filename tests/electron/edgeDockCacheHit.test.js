'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const items = require(path.join(rendererDir, 'edgeDock', 'items'));
const presentation = require(path.join(rendererDir, 'edgeDock', 'presentation'));
const fixedPeriodRanges = require(path.join(rendererDir, 'fixedPeriodRanges'));
const { LANGUAGE_OPTIONS, MESSAGES } = require(path.join(rendererDir, 'i18n'));
const { normalizePeriod, addPeriodInto } = require('../../src/shared/usage');

function cacheCell(today, otherPeriods = {}) {
  return presentation.buildEdgeDockCells({ periods: { ...otherPeriods, today } }, {
    items: [{ type: 'stat', metric: 'cacheHit' }]
  })[0];
}

test('cacheHit uses the shared Tool detail input split for the whole day', () => {
  const today = {
    totalTokens: 4000, cacheReadTokens: 2100, cacheWriteTokens: 100,
    outputTokens: 800, unclassifiedTokens: 0, capabilities: { tokenComponents: true }
  };
  const cell = cacheCell(today, { month: { ...today, totalTokens: 8000 } });
  const split = fixedPeriodRanges.tokenComponentBreakdown(today);
  assert.deepEqual(cell, {
    id: 'stat:cacheHit', kind: 'stat', metric: 'cacheHit', period: 'today',
    available: true, hit: split.cacheRead, miss: split.cacheMiss, rate: 65.625, cacheSessions: []
  });
});

test('cacheHit excludes unclassified tokens and output from the measured input', () => {
  const cell = cacheCell({
    totalTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100,
    outputTokens: 100, unclassifiedTokens: 100, capabilities: { tokenComponents: true }
  });
  assert.equal(cell.hit, 600);
  assert.equal(cell.miss, 200);
  assert.equal(cell.rate, 75);
});

test('cacheHit remains unavailable for missing, total-only, empty and output-only readings', () => {
  for (const today of [undefined, normalizePeriod({ totalTokens: 300 }),
    { totalTokens: 0, capabilities: { tokenComponents: true } },
    { totalTokens: 300, outputTokens: 300, capabilities: { tokenComponents: true } }]) {
    const cell = cacheCell(today);
    assert.equal(cell.available, false);
    assert.equal(cell.rate, null);
  }
});

test('cacheHit distinguishes measured zero hits from missing telemetry', () => {
  const cell = cacheCell({
    totalTokens: 300, outputTokens: 100, capabilities: { tokenComponents: true }
  });
  assert.equal(cell.available, true);
  assert.equal(cell.hit, 0);
  assert.equal(cell.miss, 200);
  assert.equal(cell.rate, 0);
});

test('cacheHit retains measured zero hits when unknown usage joins the period', () => {
  const today = normalizePeriod({ totalTokens: 300, inputTokens: 200,
    outputTokens: 100, capabilities: { tokenComponents: true } });
  assert.equal(cacheCell(today).rate, 0);
  addPeriodInto(today, normalizePeriod({ totalTokens: 500 }));
  assert.equal(today.capabilities.tokenComponents, false);
  const cell = cacheCell(today);
  assert.equal(cell.available, true);
  assert.equal(cell.hit, 0);
  assert.equal(cell.miss, 200);
  assert.equal(cell.rate, 0);
});

test('cache writes remain misses even without an explicit component capability', () => {
  const cell = cacheCell({ totalTokens: 100, cacheWriteTokens: 100 });
  assert.equal(cell.available, true);
  assert.equal(cell.hit, 0);
  assert.equal(cell.miss, 100);
  assert.equal(cell.rate, 0);
});

test('cacheHit details do not read activity or carry running state and expiry', () => {
  const today = {
    totalTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100,
    outputTokens: 200, capabilities: { tokenComponents: true }
  };
  Object.defineProperty(today, 'sessionActivity', {
    get() { throw new Error('Cache hit must not read live activity'); }
  });
  today.sessions = { 'codex:known': {
    client: 'codex', sessionId: 'known', title: 'Known',
    inputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 100,
    get lastUsedAt() { throw new Error('Cache hit must not read activity time'); },
    get turnEnded() { throw new Error('Cache hit must not read turn state'); }
  } };
  const cell = cacheCell(today);
  assert.equal(cell.rate, 75);
  assert.equal(cell.cacheSessions[0].rate, 75);
  for (const key of ['sessions', 'runningCount', 'runningExpiresAt']) assert.equal(Object.hasOwn(cell, key), false);
});

test('cacheHit shows completed and active sessions together in input-volume order', () => {
  const row = (id, inputTokens, cacheReadTokens, overrides = {}) => ({
    client: 'codex', sessionId: id, title: id, inputTokens, cacheReadTokens,
    cacheWriteTokens: 0, totalTokens: 999999, ...overrides
  });
  const today = {
    totalTokens: 350, cacheReadTokens: 170, outputTokens: 0,
    capabilities: { tokenComponents: true },
    sessions: {
      'codex:running': row('running', 10, 90, { turnEnded: false }),
      'codex:done': row('done', 100, 50, { turnEnded: true }),
      'codex:waiting': row('waiting', 70, 30, { waitingForInput: true })
    }
  };
  const cell = cacheCell(today);
  assert.deepEqual(cell.cacheSessions.map(row => row.key), ['codex:done', 'codex:running', 'codex:waiting']);
  assert.equal(cell.cacheSessions[0].miss, 100);
  assert.equal(cell.cacheSessions[0].rate, 50 / 150 * 100);
});

test('cacheHit session rates use measured input and the canonical session cache helper', () => {
  const sessionRows = require(path.join(rendererDir, 'sessionRows'));
  const session = {
    client: 'codex', sessionId: 'one', title: 'One', totalTokens: 1000,
    cacheReadTokens: 600, cacheWriteTokens: 100, inputTokens: 100, outputTokens: 100
  };
  const cell = cacheCell({
    totalTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100,
    outputTokens: 100, unclassifiedTokens: 100, sessions: { 'codex:one': session }
  });
  assert.equal(cell.cacheSessions[0].rate, sessionRows.sessionCacheHitPercent(session));
  assert.equal(cell.cacheSessions[0].hit, 600);
  assert.equal(cell.cacheSessions[0].miss, 200);
});

test('cacheHit omits unknown and background rows but retains measured zero-hit sessions', () => {
  const cell = cacheCell({
    totalTokens: 300, cacheReadTokens: 100, outputTokens: 0,
    sessions: {
      unknown: { client: 'codex', sessionId: 'unknown', totalTokens: 999999 },
      zero: { client: 'codex', sessionId: 'zero', inputTokens: 100, cacheReported: true },
      background: { client: 'codex', sessionId: 'background', cacheReadTokens: 100,
        sessionKind: 'background-review' }
    }
  });
  assert.deepEqual(cell.cacheSessions.map(row => row.key), ['zero']);
  assert.equal(cell.cacheSessions[0].rate, 0);
});

test('cacheHit retains every measured session, including more than six completed rows', () => {
  const sessions = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index), {
    client: 'claude', sessionId: String(index), title: `Session ${index}`,
    inputTokens: index + 1, cacheReadTokens: 10, turnEnded: true
  }]));
  const cell = cacheCell({ totalTokens: 116, cacheReadTokens: 80, sessions });
  assert.deepEqual(cell.cacheSessions.map(row => row.key), ['7', '6', '5', '4', '3', '2', '1', '0']);
});

test('cache details render on the first paint and retain scrollable rows without collapse controls', () => {
  const { Element } = require('../helpers/notchPanel');
  const source = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'dock.js'), 'utf8');
  const ast = require('espree').parse(source, { ecmaVersion: 'latest', range: true });
  const functions = ['statCard', 'clampBreakdownList', 'statLabel', 'formatCacheHitRate', 'cacheHitDetail']
    .map(name => {
      const node = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
      return source.slice(...node.range);
    }).join('\n');
  const document = {};
  const el = (tag, className, text) => {
    const node = new Element(tag, document);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const bound = [];
  const { statCard, clampBreakdownList } = Function('deps', `
    const { el, presentation, t, overflowText } = deps;
    const state = { locale: 'en' }, limitWindowsView = { setDetailTooltip() {} };
    const formatTokens = String, markNode = () => el('span', 'mark'), clientLabel = value => value;
    const BREAKDOWN_VISIBLE_ROWS = 6;
    ${functions}
    return { statCard, clampBreakdownList };
  `)({ el, presentation, t: key => MESSAGES.en[key], overflowText: { bind: node => bound.push(node.dataset.overflowKey) } });
  const cacheSessions = Array.from({ length: 8 }, (_, index) => ({
    key: String(index), client: 'codex', title: `Work ${index}`, rate: 75, hit: 600, miss: 200
  }));
  const card = statCard({ metric: 'cacheHit', available: true, hit: 4800, miss: 1600, rate: 75, cacheSessions });
  const list = card.querySelector('.edge-dock-cache-hit-sessions');
  assert.equal(list.children.length, 8);
  assert.equal(list.children[0].querySelector('.edge-dock-session-title').textContent, 'Work 0');
  assert.equal(list.children[0].querySelector('.edge-dock-session-tokens').textContent, '75.0%');
  assert.equal(card.querySelectorAll('button').length, 0);
  assert.equal(card.querySelectorAll('summary').length, 0);
  assert.equal(card.querySelectorAll('details').length, 0);
  assert.equal(bound.length, 8, 'long titles keep the existing overflow reading behavior');
  list.children.forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: index * 40, bottom: index * 40 + 32 });
  });
  const originalQuery = card.querySelector.bind(card);
  card.querySelector = selector => selector.includes('.edge-dock-cache-hit-sessions') ? list : originalQuery(selector);
  clampBreakdownList(card);
  assert.equal(list.style.maxHeight, '232px');
  assert.equal(list.children.length, 8, 'the seventh and eighth rows remain available by scrolling');
});

test('the browser loads the canonical component split before dock presentation', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'index.html'), 'utf8');
  const split = html.indexOf('src="../fixedPeriodRanges.js"');
  assert.ok(split > 0);
  assert.ok(split < html.indexOf('src="presentation.js"'));
});

test('cacheHit remains selectable and localized at every dock surface', () => {
  assert.ok(items.STAT_METRICS.includes('cacheHit'));
  assert.deepEqual(items.normalizeEdgeDockItems([{ type: 'stat', metric: 'cacheHit' }]), [
    { type: 'stat', metric: 'cacheHit' }
  ]);
  for (const locale of LANGUAGE_OPTIONS.map(option => option.value).filter(value => value !== 'auto')) {
    for (const key of ['edgeDock.period.cacheHit', 'edgeDock.periodShort.cacheHit',
      'edgeDock.cacheHit.hit', 'edgeDock.cacheHit.miss', 'edgeDock.cacheHit.description',
      'edgeDock.cacheHit.unavailable']) assert.ok(MESSAGES[locale][key]?.trim(), `${locale}: ${key}`);
    assert.match(MESSAGES[locale]['edgeDock.cacheHit.detail'], /\{hit\}.*\{miss\}/u);
  }
});

test('cacheHit formatting preserves locale, small nonzero readings, zero and unavailable', () => {
  const dock = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'dock.js'), 'utf8');
  const start = dock.indexOf('function formatCacheHitRate(');
  const end = dock.indexOf('function cacheHitDetail(', start);
  const format = Function('state', `return (${dock.slice(start, end).trim()})`)({ locale: 'pt-BR' });
  assert.equal(format(65.625), '65,6%');
  assert.equal(format(0.05), '<0,1%');
  assert.equal(format(0), '0,0%');
  assert.equal(format(null), '—');
});
