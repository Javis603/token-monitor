'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBuildPayload() {
  const filePath = path.join(__dirname, '..', '..', 'src', 'electron', 'discordRpc.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const sandbox = {
    console,
    module: { exports: {} },
    require(name) {
      if (name === '@xhayper/discord-rpc') return { Client: class {} };
      if (name === '../shared/currency') return require('../../src/shared/currency');
      if (name === '../shared/compactTokens') return require('../../src/shared/compactTokens');
      if (name === '../shared/clientCatalog') return require('../../src/shared/clientCatalog');
      return require(name);
    },
    setTimeout,
    clearTimeout,
    Date
  };

  vm.runInNewContext(`${source}\nmodule.exports.__buildPayload = buildPayload;`, sandbox, { filename: filePath });
  return sandbox.module.exports.__buildPayload;
}

test('Discord Rich Presence uses Antigravity label and asset key', () => {
  const buildPayload = loadBuildPayload();
  const payload = buildPayload({
    periods: {
      today: {
        totalTokens: 12_345,
        costUsd: 0.125,
        clients: { antigravity: 12_345 }
      }
    }
  });

  assert.equal(payload.details, 'Antigravity · 12.3K tokens');
  assert.equal(payload.smallImageKey, 'antigravity');
  assert.equal(payload.smallImageText, 'Antigravity');
});

test('Discord Rich Presence uses Cline label and asset key', () => {
  const buildPayload = loadBuildPayload();
  const payload = buildPayload({
    periods: {
      today: {
        totalTokens: 12_345,
        costUsd: 0.125,
        clients: { cline: 12_345 }
      }
    }
  });

  assert.equal(payload.details, 'Cline · 12.3K tokens');
  assert.equal(payload.smallImageKey, 'cline');
  assert.equal(payload.smallImageText, 'Cline');
});

test('Discord Rich Presence follows localized compact token units', () => {
  const buildPayload = loadBuildPayload();
  const payload = buildPayload({
    periods: {
      today: {
        totalTokens: 15_000,
        costUsd: 0.125,
        clients: { claude: 15_000 }
      }
    }
  }, 'USD', 'localized', 'zh-TW');

  assert.equal(payload.details, 'Claude · 1.5萬 tokens');
});

test('Discord Rich Presence uses labels and asset keys for tracked clients', () => {
  const buildPayload = loadBuildPayload();
  for (const [client, label] of [['hermes', 'Hermes Agent'], ['kimi', 'Kimi'], ['qwen', 'Qwen'], ['grok', 'Grok Build'], ['copilot', 'GitHub Copilot']]) {
    const payload = buildPayload({
      periods: {
        today: {
          totalTokens: 12_345,
          costUsd: 0.125,
          clients: { [client]: 12_345 }
        }
      }
    });

    assert.equal(payload.details, `${label} · 12.3K tokens`);
    assert.equal(payload.smallImageKey, client);
    assert.equal(payload.smallImageText, label);
  }
});

test('Discord Rich Presence uses labels and asset keys for newer tracked clients', () => {
  const buildPayload = loadBuildPayload();
  for (const [client, label] of [['pi', 'Pi'], ['zed', 'Zed'], ['kilo', 'Kilo'], ['commandcode', 'Command Code'], ['mimo', 'Xiaomi MiMo'], ['zcode', 'ZCode'], ['kiro', 'Kiro'], ['codebuddy', 'CodeBuddy'], ['workbuddy', 'WorkBuddy'], ['reasonix', 'Reasonix'], ['dsh', 'DeepSeek Harness'], ['lmstudio', 'LM Studio']]) {
    const payload = buildPayload({
      periods: {
        today: {
          totalTokens: 12_345,
          costUsd: 0.125,
          clients: { [client]: 12_345 }
        }
      }
    });

    assert.equal(payload.details, `${label} · 12.3K tokens`);
    assert.equal(payload.smallImageKey, client);
    assert.equal(payload.smallImageText, label);
  }
});

test('Discord Rich Presence uses the Unsloth label and asset key', () => {
  const payload = loadBuildPayload()({
    periods: { today: { totalTokens: 12345, costUsd: 0, clients: { unsloth: 12345 } } }
  });
  assert.equal(payload.details, 'Unsloth · 12.3K tokens');
  assert.equal(payload.smallImageKey, 'unsloth');
  assert.equal(payload.smallImageText, 'Unsloth');
});

test('Discord Rich Presence formats today cost with selected currency', () => {
  const buildPayload = loadBuildPayload();
  const payload = buildPayload({
    periods: {
      today: {
        totalTokens: 12_345,
        costUsd: 1,
        clients: { codex: 12_345 }
      }
    }
  }, 'CNY');

  assert.equal(payload.state, '¥6.80 today');
});

test('Discord Rich Presence derives client labels and image keys from the catalog', () => {
  const { CLIENT_CATALOG } = require('../../src/shared/clientCatalog');
  const buildPayload = loadBuildPayload();
  for (const { id, label } of CLIENT_CATALOG) {
    const expectedLabel = id === 'claude' ? 'Claude' : label;
    const payload = buildPayload({
      periods: { today: { totalTokens: 100, costUsd: 0, clients: { [id]: 100 } } }
    });
    assert.equal(payload.details, `${expectedLabel} · 100 tokens`, id);
    assert.equal(payload.smallImageKey, id);
    assert.equal(payload.smallImageText, expectedLabel);
  }
});

test('Discord Rich Presence preserves non-catalog labels and omits unknown image keys', () => {
  const buildPayload = loadBuildPayload();
  const today = (id) => ({ periods: { today: { totalTokens: 100, costUsd: 0, clients: { [id]: 100 } } } });
  const gemini = buildPayload(today('gemini'));
  assert.equal(gemini.smallImageKey, 'gemini');
  assert.equal(gemini.smallImageText, 'Gemini');
  const unknown = buildPayload(today('other-client'));
  assert.equal(unknown.details, 'other-client · 100 tokens');
  assert.equal(unknown.smallImageKey, undefined);
  const inheritedName = buildPayload(today('constructor'));
  assert.equal(inheritedName.details, 'constructor · 100 tokens');
  assert.equal(inheritedName.smallImageKey, undefined);
});
