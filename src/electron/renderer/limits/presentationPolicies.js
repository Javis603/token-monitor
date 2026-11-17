// @ts-check
'use strict';

/**
 * @typedef {Object} PresentationPolicy
 * @property {(source: string) => boolean} [linked]
 * @property {(source: string, detail: string) => string} [sourceLabel]
 * @property {(label: string) => string} [planLabel]
 * @property {(row: any) => string} [legacyPlanLabel]
 * @property {(row: any, helpers: {mimoProductLabel: (row: any) => string}) => string | undefined} [planValue]
 * @property {(row: any, translate: (key: string) => string) => string | undefined} [failureLabel]
 * @property {(windows: any[]) => any[]} [compactWindows]
 * @property {(window: any, windows: any[]) => string} [compactWindowLabel]
 * @property {(window: any, windows: any[]) => string} [compactWindowPeriodLabel]
 * @property {(row: any, source: string, status: string) => {label: string, tone: string, key?: string} | null} [statusLabel]
 * @property {Record<string, string | ((source: string) => string)>} [statusLabels]
 * @property {(rows: any[], helpers: {isMimoMembershipProduct: (row: any) => boolean}) => any} [settingsRecord]
 * @property {(window: any) => any} [antigravityQuotaWindow]
 * @property {(window: any) => boolean} [antigravityQuotaWindowVisible]
 * @property {(value: any) => string} [codexAdditionalQuotaDisplayName]
 * @property {(rows: any[]) => any} [workbuddyCreditTotals]
 * @property {(provider: any, color: any) => any} [thirdPartyAdapterVisual]
 * @property {(provider: any) => string} [thirdPartyAdapterFamily]
 * @property {(rows: any[]) => string | null} [thirdPartySharedAdapterFamily]
 * @property {(provider: any) => string | undefined} [thirdPartyGroupPlanText]
 */
module.exports = {
  'alibaba': require('../providers/alibaba/presentation'),
  'antigravity': require('../providers/antigravity/presentation'),
  'claude': require('../providers/claude/presentation'),
  'cline': require('../providers/cline/presentation'),
  'codex': require('../providers/codex/presentation'),
  'commandcode': require('../providers/commandcode/presentation'),
  'copilot': require('../providers/copilot/presentation'),
  'cursor': require('../providers/cursor/presentation'),
  'deepseek': require('../providers/deepseek/presentation'),
  'factory': require('../providers/factory/presentation'),
  'grok': require('../providers/grok/presentation'),
  'hark': require('../providers/hark/presentation'),
  'kimi': require('../providers/kimi/presentation'),
  'kiro': require('../providers/kiro/presentation'),
  'manus': require('../providers/manus/presentation'),
  'mimo': require('../providers/mimo/presentation'),
  'minimax': require('../providers/minimax/presentation'),
  'muse': require('../providers/muse/presentation'),
  'ollama': require('../providers/ollama/presentation'),
  'opencode': require('../providers/opencode/presentation'),
  'openrouter': require('../providers/openrouter/presentation'),
  'qoder': require('../providers/qoder/presentation'),
  'stepfun': require('../providers/stepfun/presentation'),
  'thirdparty': require('../providers/thirdparty/presentation'),
  'trae': require('../providers/trae/presentation'),
  'typesafe': require('../providers/typesafe/presentation'),
  'volcengine': require('../providers/volcengine/presentation'),
  'workbuddy': require('../providers/workbuddy/presentation'),
  'zai': require('../providers/zai/presentation'),
  'zaiteam': require('../providers/zaiteam/presentation'),
  'zed': require('../providers/zed/presentation')
};
