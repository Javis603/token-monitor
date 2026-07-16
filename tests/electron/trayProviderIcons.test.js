'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createTrayProviderIconDeliveryGuard,
  trayProviderIconSources,
  trayProviderBadgeLayout
} = require('../../src/electron/renderer/trayProviderIcons');

const CURRENT_TOOLS = ['claude', 'codex', 'hermes', 'opencode', 'openclaw', 'cursor', 'antigravity', 'cline', 'grok'];

function assetPathFromRendererSource(source) {
  return path.resolve(__dirname, '..', '..', 'src', 'electron', 'renderer', source);
}

test('tray provider icon sources cover all currently supported tools', () => {
  const sources = trayProviderIconSources(CURRENT_TOOLS);
  assert.deepEqual(Object.keys(sources).sort(), CURRENT_TOOLS.slice().sort());
  for (const tool of CURRENT_TOOLS) {
    assert.equal(fs.existsSync(assetPathFromRendererSource(sources[tool])), true, `${tool} icon asset exists`);
  }
});

test('tray provider icon sources keep optimized menubar icons where available', () => {
  const sources = trayProviderIconSources(CURRENT_TOOLS);
  assert.equal(sources.claude, '../../../assets/icons/tray-claude.svg');
  assert.equal(sources.codex, '../../../assets/icons/tray-codex.svg');
  assert.equal(sources.hermes, '../../../assets/icons/hermes-agent.svg');
  assert.equal(sources.grok, '../../../assets/icons/grok.svg');
  assert.equal(trayProviderIconSources(['micode']).micode, '../../../assets/icons/xiaomi.svg');
  assert.equal(trayProviderIconSources(['mimo']).mimo, '../../../assets/icons/xiaomi.svg');
  assert.equal(trayProviderIconSources(['zcode']).zcode, '../../../assets/icons/zai.svg');
  // CodeBuddy/WorkBuddy have their own brand svg, so they fall through to the id-named default.
  assert.equal(trayProviderIconSources(['codebuddy']).codebuddy, '../../../assets/icons/codebuddy.svg');
  assert.equal(trayProviderIconSources(['workbuddy']).workbuddy, '../../../assets/icons/workbuddy.svg');
});

test('tray provider badge stays legible at renderer and native tray sizes', () => {
  assert.deepEqual(trayProviderBadgeLayout(44), {
    iconSize: 44,
    badgeSize: 19,
    x: 24,
    y: 24,
    radius: 5,
    borderWidth: 2
  });
  assert.deepEqual(trayProviderBadgeLayout(20), {
    iconSize: 20,
    badgeSize: 9,
    x: 10,
    y: 10,
    radius: 3,
    borderWidth: 2
  });
});

test('tray provider icon delivery guard invalidates older async work', () => {
  const guard = createTrayProviderIconDeliveryGuard();
  const olderDelivery = guard.begin();
  assert.equal(guard.isCurrent(olderDelivery), true);

  const latestDelivery = guard.begin();
  assert.equal(guard.isCurrent(olderDelivery), false);
  assert.equal(guard.isCurrent(latestDelivery), true);
});
