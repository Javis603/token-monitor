'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

function tokenRateFunctions() {
  const start = app.indexOf('function tokenRateActiveTimeMs(');
  const end = app.indexOf('function totalNumberFontScale(', start);
  assert.notEqual(start, -1, 'token-rate helpers should exist');
  assert.notEqual(end, -1, 'token-rate helpers should precede total-number fitting');
  const context = {};
  vm.runInNewContext(
    `${app.slice(start, end)}\nthis.tokenRateActiveTimeMs = tokenRateActiveTimeMs;\nthis.tokenRatePerMinute = tokenRatePerMinute;`,
    context
  );
  return context;
}

test('token rate uses active History time for the selected period', () => {
  const { tokenRatePerMinute } = tokenRateFunctions();
  const history = {
    daily: [
      { date: '2026-07-30', tokens: 300, activeTimeMs: 30_000 },
      { date: '2026-07-31', tokens: 900, activeTimeMs: 60_000 }
    ],
    monthly: [
      { month: '2026-07', tokens: 1_200, activeTimeMs: 120_000 }
    ],
    summary: { totalTokens: 1_200, activeTimeMs: 600_000 }
  };

  assert.equal(tokenRatePerMinute(900, history, 'today', '2026-07-31'), 900);
  assert.equal(tokenRatePerMinute(1_200, history, 'month', '2026-07-31'), 600);
  assert.equal(tokenRatePerMinute(1_200, history, 'allTime', '2026-07-31'), 120);
});

test('token rate falls back to available daily/monthly History and hides without active time', () => {
  const { tokenRateActiveTimeMs, tokenRatePerMinute } = tokenRateFunctions();
  const history = {
    daily: [{ date: '2026-07-31', activeTimeMs: 30_000 }],
    monthly: [{ month: '2026-07', activeTimeMs: 0 }],
    summary: {}
  };

  assert.equal(tokenRateActiveTimeMs(history, 'month', '2026-07-31'), 30_000);
  assert.equal(tokenRatePerMinute(0, history, 'today', '2026-07-31'), 0);
  assert.equal(tokenRatePerMinute(900, { daily: [], monthly: [], summary: {} }, 'today', '2026-07-31'), 0);
});

test('token rate is a hover-only reveal beside the compact Σ title mark', () => {
  assert.match(html, /<span id="tokenRateReveal" class="token-rate-reveal" aria-hidden="true"><\/span>/);
  assert.match(app, /tokenRateReveal: document\.getElementById\('tokenRateReveal'\)/);
  assert.match(app, /const text = rate > 0/);
  assert.match(app, /formatCompact\(rate, effectiveCompactTokenUnits\(\), currentLocale\(\)\)\}\/min/);
  assert.match(app, /els\.cost\.textContent = formatCost\(period\.costUsd \|\| 0\);\s*renderTokenRate\(\);/);
  assert.match(css, /\.shell\.title-icon-only \.app-title-mark:hover ~ \.token-rate-reveal\.has-value/);
  assert.match(css, /\.shell\.title-collapsed \.live-dot:hover ~ \.token-rate-reveal\.has-value/);
  assert.match(css, /\.app-title-mark,\s*\.live-dot\s*\{\s*-webkit-app-region:\s*no-drag/);
  assert.match(css, /\.token-rate-reveal\s*\{[^}]*max-width:\s*0/);
});
