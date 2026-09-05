'use strict';

// Display names for the AI Tool Limits providers, in the desktop's default order.
//
// This is a *presentation mirror*, not an identity source. Canonical provider
// identity — the id set, the new-install order, the client aliases and the
// limits schema — stays in limitProviders.js, and this file is constrained by
// it: tests/shared/limitProviderLabels.test.js pins the ids here to
// LIMIT_PROVIDER_IDS with an order-sensitive comparison.
//
// Deliberately a separate module rather than extra fields on limitProviders.js,
// because that file is part of the portable Hub core hashed into
// hubBuildRegistry.json (scripts/hub-build-manifest.js). Labels are desktop-only
// and the Hub never reads them, so folding them in would make every renamed
// provider bump the core build id and tell self-hosted Hubs to redeploy for a
// change their runtime cannot observe.
//
// Named "labels", not "presentation": the renderer already has its own
// limitProviderPresentation.js owning TokenMonitorLimitProviderPresentation, and
// two UMD modules claiming one global silently overwrite each other.
//
// Pure data, no DOM and no Node built-ins, so the widget renderer can load it as
// a plain <script> and node:test can require it.
(function exposeLimitProviderLabels(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitProviderLabels = api;
})(typeof window !== 'undefined' ? window : null, function createLimitProviderLabelsApi() {
  // `settingsLabel` overrides the name in the AI Tool Limits settings list only,
  // where the provider is being connected as a specific tool rather than named
  // as a quota source.
  const LIMIT_PROVIDER_PRESENTATION = Object.freeze([
    { id: 'claude', label: 'Claude', settingsLabel: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'opencode', label: 'OpenCode' },
    { id: 'cursor', label: 'Cursor' },
    { id: 'antigravity', label: 'Antigravity' },
    { id: 'kimi', label: 'Kimi' },
    { id: 'grok', label: 'Grok' },
    { id: 'copilot', label: 'GitHub Copilot' },
    { id: 'zed', label: 'Zed' },
    { id: 'commandcode', label: 'Command Code' },
    { id: 'mimo', label: 'MiMo' },
    { id: 'zai', label: 'GLM' },
    { id: 'zaiteam', label: 'GLM Team' },
    { id: 'kiro', label: 'Kiro' },
    { id: 'workbuddy', label: 'WorkBuddy' },
    { id: 'qoder', label: 'Qoder' },
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'minimax', label: 'Minimax' },
    { id: 'volcengine', label: 'Volcengine' },
    { id: 'ollama', label: 'Ollama' },
    { id: 'trae', label: 'Trae CN' },
    { id: 'alibaba', label: 'Alibaba Cloud' },
    { id: 'thirdparty', label: 'Third-party APIs' }
  ].map((provider) => Object.freeze({ ...provider })));

  const LIMIT_PROVIDER_LABELS = Object.freeze(Object.fromEntries(
    LIMIT_PROVIDER_PRESENTATION.map(({ id, label }) => [id, label])
  ));

  return { LIMIT_PROVIDER_PRESENTATION, LIMIT_PROVIDER_LABELS };
});
