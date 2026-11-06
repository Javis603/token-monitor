'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const railNumberRollApi = require('../../src/electron/renderer/edgeDock/railNumberRoll');

const root = path.join(__dirname, '../..');

function readout(text) {
  return { dataset: {}, textContent: text };
}

function rail(...nodes) {
  return { nodes, querySelectorAll: () => nodes };
}

function harness() {
  const rolls = [];
  const settled = [];
  const timers = [];
  const animation = {
    duration: 900,
    capture: (node) => node.glyphs || null,
    beginRoll(node, from, to, increasing, prepare, glyphs) {
      const roll = { node, from, to, increasing, glyphs };
      rolls.push(roll);
      return () => settled.push(roll);
    }
  };
  const roller = railNumberRollApi.create({ animation, schedule: (callback, ms) => timers.push({ callback, ms }) });
  return { roller, rolls, settled, timers };
}

function marked(text, key, value) {
  return railNumberRollApi.mark(readout(text), key, value);
}

test('a readout whose text moved rolls from the reading the outgoing rail showed', () => {
  const { roller, rolls, timers } = harness();
  const before = rail(marked('191.8M', 'stat:today:value', 191_800_000), marked('43%', 'limit:claude:value', 43));
  const snapshot = roller.capture(before);
  const tokens = marked('191.9M', 'stat:today:value', 191_900_000);
  const percent = marked('42%', 'limit:claude:value', 42);
  roller.play(rail(tokens, percent), snapshot);
  assert.deepEqual(rolls.map(({ node, from, to, increasing }) => [node, from, to, increasing]), [
    [tokens, '191.8M', '191.9M', true],
    [percent, '43%', '42%', false]
  ]);
  assert.deepEqual(timers.map(({ ms }) => ms), [900, 900], 'each roll settles once its glyphs land');
});

test('unchanged, digitless, unmatched and skipped readouts are swapped, not rolled', () => {
  const { roller, rolls } = harness();
  const snapshot = roller.capture(rail(
    marked('HK$434', 'stat:today:cost', 55),
    marked('—', 'stat:liveRate:value', null),
    marked('12', 'stat:sessions:value', 12),
    marked('80%', 'limit:codex:value', 80)
  ));
  const refill = marked('100%', 'limit:codex:value', 100);
  roller.play(rail(
    marked('HK$434', 'stat:today:cost', 55.2),
    marked('184', 'stat:liveRate:value', 184),
    marked('3', 'limit:cursor:value', 3),
    refill
  ), snapshot, { skip: (node) => node === refill });
  assert.equal(rolls.length, 0);
});

test('a push mid-roll settles the outgoing readout and retargets from its glyphs', () => {
  const { roller, rolls, settled } = harness();
  const first = marked('1.2K', 'stat:liveRate:value', 1200);
  roller.play(rail(first), roller.capture(rail(marked('1.1K', 'stat:liveRate:value', 1100))));
  first.glyphs = [{ key: 'digit:0' }];
  const snapshot = roller.capture(rail(first));
  assert.deepEqual(settled, [rolls[0]], 'the replaced readout stops holding layers');
  const second = marked('1.3K', 'stat:liveRate:value', 1300);
  roller.play(rail(second), snapshot);
  assert.equal(rolls[1].from, '1.2K');
  assert.equal(rolls[1].glyphs, first.glyphs);
});

test('a key that names two readouts is ambiguous and left static', () => {
  const { roller, rolls } = harness();
  const snapshot = roller.capture(rail(marked('1', 'stat:sessions:value', 1), marked('2', 'stat:sessions:value', 2)));
  roller.play(rail(marked('3', 'stat:sessions:value', 3)), snapshot);
  assert.equal(rolls.length, 0);
});

test('the rail rolls its readouts on the shared setting, never on a reveal', () => {
  const dock = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
  const render = dock.slice(dock.indexOf('function renderRail('), dock.indexOf('let gesture = null;'));
  assert.ok(render.indexOf('railNumberRoll.capture(railNode)') < render.indexOf('node.remove()'));
  assert.match(render, /if \(!revealing && !prefersReducedMotion\(\)\)/);
  assert.match(dock, /mode: \(\) => tokenNumberAnimationApi\.normalize\(appearance\(\)\.tokenNumberAnimation\)/);
  assert.match(render, /const refilling = animateRingResets\(ringSnapshot\);[\s\S]*skip: \(node\) => refilling\.has\(node\)/,
    'a refill count-up owns its figure from the render that starts it');
  assert.match(dock, /const hasCreditsAmount = [^\n]+;\s*if \(hasCreditsAmount\) \{/);
  assert.match(dock, /markRoll\(value, `\$\{node\.dataset\.ringMotionKey\}:value`, hasCreditsAmount \? Number\(cell\.credits\.amount\) : shown, reading => hasCreditsAmount/,
    'a quota figure rolls on the headline identity and the reading it shows');
  assert.match(dock, /ringNumberAnimations\.clear\(\);\s*railNumberRoll\.settle\(\);/, 'reduced motion lands rolling readouts too');
  for (const key of ['value`, cell.totalTokens', 'cost`, cell.costUsd', 'rate`, cell.rate', 'value`, running']) {
    assert.ok(dock.includes(key), `rail readout ${key} is marked`);
  }
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(([, src]) => src);
  assert.ok(scripts.indexOf('../../tokenNumberAnimation.js') < scripts.indexOf('dock.js'));
  assert.ok(scripts.indexOf('railNumberRoll.js') < scripts.indexOf('dock.js'));
  const appearance = main.slice(main.indexOf('function edgeDockAppearance('), main.indexOf('const EDGE_DOCK_RATE_ACTIVE_MS'));
  assert.match(appearance, /tokenNumberAnimation: source\.tokenNumberAnimation/);
});
