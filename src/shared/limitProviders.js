'use strict';

// Keep provider order stable: it is also the default order for a new install.
// Saved user ordering is parsed separately and must not be overwritten.
const LIMIT_PROVIDER_IDS = Object.freeze([
  'claude', 'codex', 'opencode', 'cursor', 'antigravity', 'kimi', 'grok',
  'copilot', 'mimo', 'zai', 'zaiteam', 'kiro', 'deepseek', 'openrouter',
  'minimax', 'volcengine', 'qoder', 'workbuddy', 'ollama', 'thirdparty'
]);

// These are the only window metrics that cross the shared limits schema.
const LIMIT_WINDOW_METRICS = Object.freeze(['credits', 'spend']);
const VALID_LIMIT_WINDOW_METRICS = new Set(LIMIT_WINDOW_METRICS);

module.exports = {
  LIMIT_PROVIDER_IDS,
  LIMIT_WINDOW_METRICS,
  VALID_LIMIT_WINDOW_METRICS
};
