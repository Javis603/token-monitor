'use strict';

const { clientsCsvForSetting } = require('../shared/clientTracking');
const { normalizeLimitsRefreshMs, parseLimitProviders } = require('../shared/limitCollector');

const MODE_STRUCTURAL_KEYS = Object.freeze([
  'hubMode',
  'hubUrl',
  'secret',
  'hubHostPort',
  'hubHostSecret',
  'deviceId'
]);
const USAGE_STRUCTURAL_KEYS = Object.freeze([
  'clients',
  'allTimeSince',
  'collectionIntervalMs',
  'collectionMode',
  'historyEnabled',
  'historyIntervalMs',
  'sessionUsageArchiveEnabled',
  'projectsEnabled',
  'wslScanEnabled'
]);
const LIMITS_RECONFIGURE_KEYS = Object.freeze([
  'limitsEnabled',
  'limitProviders',
  'limitsRefreshMs'
]);
const SINK_STRUCTURAL_KEYS = Object.freeze(['syncUploadIntervalMs']);
const LIMIT_PROVIDER_SETTING_KEYS = Object.freeze({
  opencode: ['opencodeCookie', 'opencodeProfiles'],
  deepseek: ['deepseekApiKey'],
  minimax: ['minimaxApiKey'],
  copilot: ['copilotApiToken', 'copilotEnterpriseHost'],
  zai: ['zaiApiKey', 'zaiApiRegion'],
  zaiteam: ['zaiTeamApiKey', 'zaiTeamOrganizationId', 'zaiTeamProjectId'],
  volcengine: ['volcengineAccessKeyId', 'volcengineSecretAccessKey', 'volcengineRegion'],
  qoder: ['qoderCookie', 'qoderSite'],
  kimi: ['kimiApiKey', 'kimiWebAccessToken'],
  ollama: ['ollamaCookie'],
  codex: ['codexManagedAccounts'],
  mimo: ['mimoManagedAccounts']
});

function equalSetting(left, right) {
  if (left === right) return true;
  if ((left === undefined || left === null) && (right === undefined || right === null)) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch (_) { return false; }
}

function changedAny(previous, next, keys) {
  return keys.some((key) => !equalSetting(previous?.[key], next?.[key]));
}

function usageConfigFromSettings(settings = {}, context = {}) {
  return {
    clients: clientsCsvForSetting(settings.clients),
    allTimeSince: settings.allTimeSince || '2024-01-01',
    commandTimeoutMs: Number(context.commandTimeoutMs || 120 * 1000),
    deviceId: settings.deviceId || context.defaultDeviceId,
    agentVersion: context.agentVersion,
    agentRuntime: context.agentRuntime || 'electron-widget',
    intervalMs: context.intervalMs ?? settings.collectionIntervalMs,
    historyEnabled: settings.historyEnabled !== false,
    dailyHistoryArchiveEnabled: settings.sessionUsageArchiveEnabled !== false,
    dailyHistoryArchiveWriteEnabled: context.dailyHistoryArchiveWriteEnabled,
    projectsEnabled: settings.projectsEnabled !== false,
    historyIntervalMs: context.historyIntervalMs ?? settings.historyIntervalMs,
    watchEnabled: context.watchEnabled,
    watchDebounceMs: Number(context.watchDebounceMs || 1500),
    wslScanEnabled: settings.wslScanEnabled !== false,
    onError: context.onError,
    logger: context.logger
  };
}

function limitsConfigFromSettings(settings = {}, context = {}) {
  const env = context.env || process.env;
  return {
    limitsEnabled: settings.limitsEnabled !== false,
    limitProviders: settings.limitProviders ?? context.defaultLimitProviders,
    limitsRefreshMs: normalizeLimitsRefreshMs(settings.limitsRefreshMs),
    opencodeCookie: settings.opencodeCookie || env.TOKEN_MONITOR_OPENCODE_COOKIE || '',
    opencodeProfiles: settings.opencodeProfiles || {},
    deepseekApiKey: settings.deepseekApiKey || '',
    minimaxApiKey: settings.minimaxApiKey || '',
    copilotApiToken: settings.copilotApiToken || '',
    copilotEnterpriseHost: settings.copilotEnterpriseHost || '',
    zaiApiKey: settings.zaiApiKey || '',
    zaiApiRegion: settings.zaiApiRegion || 'global',
    zaiTeamApiKey: settings.zaiTeamApiKey || '',
    zaiTeamOrganizationId: settings.zaiTeamOrganizationId || '',
    zaiTeamProjectId: settings.zaiTeamProjectId || '',
    volcengineAccessKeyId: settings.volcengineAccessKeyId || '',
    volcengineSecretAccessKey: settings.volcengineSecretAccessKey || '',
    volcengineRegion: settings.volcengineRegion || '',
    qoderCookie: settings.qoderCookie || '',
    qoderSite: settings.qoderSite || 'global',
    kimiApiKey: settings.kimiApiKey || '',
    kimiWebAccessToken: settings.kimiWebAccessToken || '',
    ollamaCookie: settings.ollamaCookie || '',
    codexManagedAccounts: context.codexManagedAccounts ?? settings.codexManagedAccounts ?? [],
    mimoManagedAccounts: context.mimoManagedAccounts ?? settings.mimoManagedAccounts ?? []
  };
}

function envelopeFromSettings(settings = {}, context = {}) {
  return {
    deviceId: settings.deviceId || context.defaultDeviceId,
    agentVersion: context.agentVersion,
    agentRuntime: context.agentRuntime || 'electron-widget'
  };
}

function classifySettingsChange(previous = {}, next = {}) {
  const limitScopes = [];
  for (const [provider, keys] of Object.entries(LIMIT_PROVIDER_SETTING_KEYS)) {
    if (changedAny(previous, next, keys)) limitScopes.push({ provider });
  }
  return {
    modeStructural: changedAny(previous, next, MODE_STRUCTURAL_KEYS),
    usageStructural: changedAny(previous, next, USAGE_STRUCTURAL_KEYS),
    limitsReconfigure: changedAny(previous, next, LIMITS_RECONFIGURE_KEYS),
    sinkStructural: changedAny(previous, next, SINK_STRUCTURAL_KEYS),
    limitScopes,
    enabledProviders: parseLimitProviders(next.limitProviders)
  };
}

module.exports = {
  LIMIT_PROVIDER_SETTING_KEYS,
  classifySettingsChange,
  envelopeFromSettings,
  limitsConfigFromSettings,
  usageConfigFromSettings
};
