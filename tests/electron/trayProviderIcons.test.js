'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { trayProviderIconSources } = require('../../src/electron/renderer/trayProviderIcons');

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
