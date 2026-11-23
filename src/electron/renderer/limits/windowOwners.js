// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const factories = node ? {
    codex: require('../providers/codex/windows'),
    cursor: require('../providers/cursor/windows'),
    antigravity: require('../providers/antigravity/windows'),
    opencode: require('../providers/opencode/windows'),
    openrouter: require('../providers/openrouter/windows'),
    thirdparty: require('../providers/thirdparty/windows'),
    deepseek: require('../providers/deepseek/windows'),
    typesafe: require('../providers/typesafe/windows'),
    mimo: require('../providers/mimo/windows'),
    grok: require('../providers/grok/windows'),
    copilot: require('../providers/copilot/windows'),
    zed: require('../providers/zed/windows'),
    zai: require('../providers/zai/windows'),
    volcengine: require('../providers/volcengine/windows'),
    devin: require('../providers/devin/windows'),
    factory: require('../providers/factory/windows'),
    kiro: require('../providers/kiro/windows'),
    qoder: require('../providers/qoder/windows'),
    workbuddy: require('../providers/workbuddy/windows'),
    commandcode: require('../providers/commandcode/windows'),
    kimi: require('../providers/kimi/windows'),
    alibaba: require('../providers/alibaba/windows'),
    ollama: require('../providers/ollama/windows'),
    claude: require('../providers/claude/windows'),
    hark: require('../providers/hark/windows'),
    manus: require('../providers/manus/windows'),
    mistral: require('../providers/mistral/windows'),
    notion: require('../providers/notion/windows'),
    cline: require('../providers/cline/windows'),
    muse: require('../providers/muse/windows'),
    minimax: require('../providers/minimax/windows')
  } : root.TokenMonitorProviderWindows;
  const api = factory(factories);
  if (node) module.exports = api;
  if (root) root.TokenMonitorLimitWindowOwners = api;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} factories */ function createRegistry(factories) {
  /** @param {Record<string, any>} capabilities */
  function createOwners(capabilities) {
    /** @type {Record<string, any>} */
    const owners = {};
    owners.codex = factories.codex(capabilities);
    owners.cursor = factories.cursor(capabilities);
    owners.antigravity = factories.antigravity(capabilities);
    owners.opencode = factories.opencode(capabilities);
    owners.openrouter = factories.openrouter(capabilities);
    owners.thirdparty = factories.thirdparty(capabilities);
    owners.deepseek = factories.deepseek(capabilities);
    owners.mimo = factories.mimo(capabilities);
    owners.grok = factories.grok(capabilities);
    owners.copilot = factories.copilot(capabilities);
    owners.zed = factories.zed(capabilities);
    owners.zai = factories.zai(capabilities);
    owners.volcengine = factories.volcengine(capabilities);
    owners.devin = factories.devin(capabilities);
    owners.factory = factories.factory(capabilities);
    owners.kiro = factories.kiro(capabilities);
    owners.qoder = factories.qoder(capabilities);
    owners.workbuddy = factories.workbuddy(capabilities);
    owners.commandcode = factories.commandcode(capabilities);
    owners.kimi = factories.kimi(capabilities);
    owners.alibaba = factories.alibaba(capabilities);
    owners.ollama = factories.ollama(capabilities);
    owners.claude = factories.claude(capabilities);
    owners.hark = factories.hark(capabilities);
    owners.manus = factories.manus(capabilities);
    owners.mistral = factories.mistral(capabilities);
    owners.notion = factories.notion(capabilities);
    owners.cline = factories.cline(capabilities);
    owners.muse = factories.muse(capabilities);
    owners.minimax = factories.minimax(capabilities);
    owners.typesafe = factories.typesafe({ ...capabilities, reuseRenderWindows: owners.deepseek.renderWindows });
    owners.zaiteam = owners.zai;
    owners.trae = { renderWindows: owners.workbuddy.renderWindows };
    owners.stepfun = owners.alibaba;
    return owners;
  }
  return { createOwners };
});
