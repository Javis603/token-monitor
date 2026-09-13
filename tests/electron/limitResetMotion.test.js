'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  displayPercent,
  durationMs,
  providerKey,
  remainingPercent,
  shouldAnimateReset,
  windowKey
} = require('../../src/electron/renderer/limitResetMotion');

const root = path.join(__dirname, '../..');

test('quota refill motion requires an existing non-full value reaching full', () => {
  assert.equal(shouldAnimateReset(
    { remainingPercent: 0 },
    { remainingPercent: 100 }
  ), true);
  assert.equal(shouldAnimateReset(
    { remainingPercent: 69 },
    { remainingPercent: 100 }
  ), true);
  assert.equal(shouldAnimateReset(null, { remainingPercent: 100 }), false);
  assert.equal(shouldAnimateReset(
    { remainingPercent: 70 },
    { remainingPercent: 85 }
  ), false);
  assert.equal(shouldAnimateReset(
    { remainingPercent: 100 },
    { remainingPercent: 100 }
  ), false);
});

test('remaining percentage preserves missing values and derives used-only windows', () => {
  assert.equal(remainingPercent(null), null);
  assert.equal(remainingPercent({ remainingPercent: null }), null);
  assert.equal(remainingPercent({ usedPercent: 100 }), 0);
  assert.equal(remainingPercent({ usedPercent: 31 }), 69);
  assert.equal(remainingPercent({ remainingPercent: 42, usedPercent: 58 }), 42);
});

test('display percentage clamps provider overrun values to the meter range', () => {
  assert.equal(displayPercent(-1), 0);
  assert.equal(displayPercent(101), 100);
  assert.equal(displayPercent(42.5), 42.5);
  assert.equal(displayPercent(null), null);
});

test('refill duration follows the distance while preserving the approved short refill pace', () => {
  assert.equal(durationMs(0, 100), 1600);
  assert.equal(durationMs(69, 100), 1117);
  assert.equal(durationMs(null, 100), 1100);
});

test('known reset boundaries must advance before a refill animates', () => {
  const firstReset = '2026-09-09T01:00:00.000Z';
  const nextReset = '2026-09-09T06:00:00.000Z';
  assert.equal(shouldAnimateReset(
    { remainingPercent: 14, resetsAt: firstReset },
    { remainingPercent: 100, resetsAt: nextReset }
  ), true);
  assert.equal(shouldAnimateReset(
    { remainingPercent: 14, resetsAt: firstReset },
    { remainingPercent: 100, resetsAt: firstReset }
  ), false);
  assert.equal(shouldAnimateReset(
    { remainingPercent: 14, resetsAt: nextReset },
    { remainingPercent: 100, resetsAt: firstReset }
  ), false);
});

test('used-only snapshots can still identify a refill without changing display mode', () => {
  assert.equal(shouldAnimateReset(
    { remainingPercent: remainingPercent({ usedPercent: 86 }) },
    { remainingPercent: remainingPercent({ usedPercent: 0 }) }
  ), true);
});

test('motion keys preserve account and window identity without exposing labels', () => {
  assert.equal(providerKey(null), providerKey());
  assert.equal(windowKey('Weekly', null), windowKey('Weekly'));
  const firstAccount = providerKey({ provider: 'codex', accountEmail: 'first@example.com' });
  const secondAccount = providerKey({ provider: 'codex', accountEmail: 'second@example.com' });
  assert.notEqual(firstAccount, secondAccount);
  assert.doesNotMatch(firstAccount, /first|example/);

  const session = windowKey('Session', { kind: 'session' });
  const weekly = windowKey('Weekly', { kind: 'weekly' });
  assert.notEqual(session, weekly);
});

test('renderer wires reset motion before app boot and respects reduced motion', () => {
  const html = fs.readFileSync(path.join(root, 'src/electron/renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/electron/renderer/styles.css'), 'utf8');

  assert.ok(html.indexOf('<script src="limitResetMotion.js"></script>') < html.indexOf('<script src="app.js"></script>'));
  assert.match(app, /const resetMotionSnapshot = captureLimitResetMotion\(\);/);
  assert.match(app, /els\.limitsPanel\.replaceChildren\(\.\.\.nodes\);\s*animateLimitResets\(resetMotionSnapshot\);/);
  assert.match(app, /limitResetMotionApi\.shouldAnimateReset\(previous, current\)/);
  assert.match(app, /previous\.displayPercent === ''/);
  assert.match(app, /LIMIT_RESET_MOTION_EASING/);
  assert.match(app, /const duration = limitResetMotionApi\.durationMs\(from, to\);/);
  assert.match(app, /animateLimitResetCompletion\(fill, duration\);/);
  assert.match(app, /const fillPercent = limitResetMotionApi\.displayPercent\([\s\S]*limitFillPercent\(remaining, used, showUsed\)[\s\S]*\);/);
  assert.match(app, /requestAnimationFrame\(\(startedAt\) => \{/);
  assert.match(app, /duration,\s*startedAt\s*\);/);
  assert.match(app, /delay: Math\.max\(0, duration - LIMIT_RESET_GLOW_LEAD_MS\)/);
  assert.match(app, /highlight\.className = 'limit-meter-completion'/);
  assert.doesNotMatch(app, /filter: 'brightness\(/);
  assert.match(app, /if \(nextText !== renderedText\)/);
  assert.match(css, /\.limit-meter-completion\s*\{[^}]*position:\s*absolute;[^}]*opacity:\s*0;/s);
  assert.doesNotMatch(css, /limit-window-resetting|limit-reset-shine|limit-reset-brighten|limit-reset-glow/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.limit-meter-fill/);
});
