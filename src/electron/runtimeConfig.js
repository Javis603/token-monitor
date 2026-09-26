'use strict';

const { clientsCsvForSetting } = require('../shared/clientTracking');
const { normalizeHistoryIntervalMs } = require('../shared/collector');
const {
  normalizeLimitsRefreshMode,
  normalizeLimitsRefreshMs,
  parseLimitProviders
} = require('../shared/limits/collector');
const { normalizeSyncUploadIntervalMs } = require('../shared/syncUploadInterval');
const { normalizeCustomScanPaths } = require('../shared/customScanPaths');
const { limitProviderSettingKeys } = require('../shared/limits/accounts');
const { normalizeCursorAccountIds } = require('../shared/providers/cursor/account');
const { limitsAccountConfig } = require('./limits/accountSettings');

const DEFAULT_ALL_TIME_SINCE = '2024-01-01';

const normalizeCursorDisabledAccountIds = normalizeCursorAccountIds;

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
  'customScanPaths',
  'allTimeSince',
  'collectionIntervalMs',
  'collectionMode',
  'historyEnabled',
  'historyIntervalMs',
  'sessionUsageArchiveEnabled',
  'projectsEnabled',
  'wslScanEnabled'
]);
// Functions and identity fields deliberately stay out: this key answers only
// whether replacing the active usage runtime would change its collection work.
// Values arrive from usageConfigFromSettings() after mode-specific normalization.
const USAGE_CONFIG_FINGERPRINT_KEYS = Object.freeze([
  'clients',
  'customScanPaths',
  'allTimeSince',
  'intervalMs',
  'historyEnabled',
  'dailyHistoryArchiveEnabled',
  'projectsEnabled',
  'historyIntervalMs',
  'watchEnabled',
  'watchUsePolling',
  'watchTriggersCollection',
  'intervalRequiresActivity',
  'watchDebounceMs',
  'wslScanEnabled'
]);
const LIMITS_RECONFIGURE_KEYS = Object.freeze([
  'limitsEnabled',
  'limitProviders',
  'limitsRefreshMode',
  'limitsRefreshMs',
  'cursorDisabledAccountIds',
  'opencodeLocalLimitsEnabled'
]);
const SINK_STRUCTURAL_KEYS = Object.freeze(['syncUploadIntervalMs']);
// Derived from the account declarations: every watched field plus a
// provider's extraSettingKeys scopes a limits refresh to that provider.
const LIMIT_PROVIDER_SETTING_KEYS = Object.freeze(limitProviderSettingKeys());

function equalSetting(left, right) {
  if (left === right) return true;
  if ((left === undefined || left === null) && (right === undefined || right === null)) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch (_) { return false; }
}

function changedAny(previous, next, keys) {
  return keys.some((key) => !equalSetting(previous?.[key], next?.[key]));
}

function usageConfigFingerprint(config = {}) {
  return JSON.stringify(USAGE_CONFIG_FINGERPRINT_KEYS.map((key) => [key, config?.[key] ?? null]));
}

function normalizeAllTimeSince(value, fallback = DEFAULT_ALL_TIME_SINCE) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : fallback;
}

function usageConfigFromSettings(settings = {}, context = {}) {
  return {
    clients: clientsCsvForSetting(settings.clients),
    customScanPaths: normalizeCustomScanPaths(settings.customScanPaths),
    allTimeSince: normalizeAllTimeSince(settings.allTimeSince),
    commandTimeoutMs: Number(context.commandTimeoutMs || 120 * 1000),
    deviceId: settings.deviceId || context.defaultDeviceId,
    agentVersion: context.agentVersion,
    agentRuntime: context.agentRuntime || 'electron-widget',
    intervalMs: context.intervalMs ?? settings.collectionIntervalMs,
    historyEnabled: settings.historyEnabled !== false,
    dailyHistoryArchiveEnabled: settings.sessionUsageArchiveEnabled !== false,
    dailyHistoryArchiveWriteEnabled: context.dailyHistoryArchiveWriteEnabled,
    projectsEnabled: settings.projectsEnabled !== false,
    reasonixNativeSessionsEnabled: context.reasonixNativeSessionsEnabled === true,
    historyIntervalMs: context.historyIntervalMs ?? settings.historyIntervalMs,
    watchEnabled: context.watchEnabled,
    // Deliberately passed through as a tri-state rather than coerced: undefined
    // means "no opinion", which lets resolveWatchUsePolling() apply the shared
    // default and the TOKEN_MONITOR_WATCH_POLLING override.
    watchUsePolling: context.watchUsePolling,
    watchTriggersCollection: context.watchTriggersCollection !== false,
    intervalRequiresActivity: Boolean(context.intervalRequiresActivity),
    watchDebounceMs: Number(context.watchDebounceMs || 1500),
    deferSelfSyncOnStartup: context.deferSelfSyncOnStartup === true,
    wslScanEnabled: settings.wslScanEnabled !== false,
    onError: context.onError,
    logger: context.logger
  };
}

function limitsConfigFromSettings(settings = {}, context = {}) {
  const env = context.env || process.env;
  // The Electron widget uses the WorkBuddy app's local sign-in state. Keep the
  // raw token fallback available to the headless agent, but never let a desktop
  // .env or legacy settings value silently bypass the app-owned session.
  const workbuddySettings = context.workbuddyDesktopSessionOnly === true ? {} : settings;
  const workbuddyEnv = context.workbuddyDesktopSessionOnly === true ? {} : env;
  const workbuddyLocalSession = context.workbuddyLocalSession && typeof context.workbuddyLocalSession === 'object'
    ? context.workbuddyLocalSession
    : {};
  return {
    limitsEnabled: settings.limitsEnabled !== false,
    limitProviders: settings.limitProviders ?? context.defaultLimitProviders,
    limitsRefreshMode: normalizeLimitsRefreshMode(settings.limitsRefreshMode),
    limitsRefreshMs: normalizeLimitsRefreshMs(settings.limitsRefreshMs),
    claudePrepaidBalanceEnabled: settings.claudePrepaidBalanceEnabled !== false,
    opencodeLocalLimitsEnabled: settings.opencodeLocalLimitsEnabled === true,
    opencodeAmbientEnabled: settings.opencodeAmbientEnabled !== false,
    // Every declared account field: settings lane, declared env fallbacks,
    // declared default. The workbuddy fields below stay hand-written because
    // the desktop session rewrites their lanes entirely.
    ...limitsAccountConfig(settings, context),
    workbuddyAccessToken: workbuddySettings.workbuddyAccessToken
      || workbuddyEnv.TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN
      || workbuddyEnv.WORKBUDDY_ACCESS_TOKEN
      || '',
    workbuddyUserId: workbuddySettings.workbuddyUserId
      || workbuddyEnv.TOKEN_MONITOR_WORKBUDDY_USER_ID
      || workbuddyEnv.WORKBUDDY_USER_ID
      || (context.workbuddyDesktopSessionEnabled === true ? workbuddyLocalSession.userId : '')
      || '',
    workbuddyEnterpriseId: workbuddySettings.workbuddyEnterpriseId
      || workbuddyEnv.TOKEN_MONITOR_WORKBUDDY_ENTERPRISE_ID
      || workbuddyEnv.WORKBUDDY_ENTERPRISE_ID
      || (context.workbuddyDesktopSessionEnabled === true ? workbuddyLocalSession.enterpriseId : '')
      || '',
    workbuddyDomain: workbuddySettings.workbuddyDomain
      || workbuddyEnv.TOKEN_MONITOR_WORKBUDDY_DOMAIN
      || workbuddyEnv.WORKBUDDY_DOMAIN
      || (context.workbuddyDesktopSessionEnabled === true ? workbuddyLocalSession.domain : '')
      || '',
    workbuddyDepartmentInfo: workbuddySettings.workbuddyDepartmentInfo
      || workbuddyEnv.TOKEN_MONITOR_WORKBUDDY_DEPARTMENT_INFO
      || workbuddyEnv.WORKBUDDY_DEPARTMENT_INFO
      || (context.workbuddyDesktopSessionEnabled === true ? workbuddyLocalSession.departmentInfo : '')
      || '',
    workbuddyAccountType: context.workbuddyDesktopSessionEnabled === true
      ? workbuddyLocalSession.accountType || ''
      : '',
    // Why the app-owned session is unusable, when it is. An encrypted or
    // otherwise unreadable credential is not a signed-out app, and the limits
    // layer needs that difference to stop asking the user to sign in again.
    workbuddyLocalSessionReason: context.workbuddyDesktopSessionEnabled === true
      ? String(workbuddyLocalSession.reason || '').trim()
      : '',
    workbuddyLocale: workbuddySettings.workbuddyLocale
      || workbuddyEnv.TOKEN_MONITOR_WORKBUDDY_LOCALE
      || workbuddyEnv.WORKBUDDY_LOCALE
      || '',
    workbuddyDesktopSessionSupported: context.workbuddyDesktopSessionSupported !== false,
    workbuddyDesktopSessionEnabled: context.workbuddyDesktopSessionEnabled === true
  };
}

function diagnosticConfigurationFromSettings(settings = {}, context = {}) {
  const usage = usageConfigFromSettings(settings, context.usage || {});
  const limits = limitsConfigFromSettings(settings, context.limits || {});
  return {
    configurationSource: 'effective-normalized',
    allTimeSince: usage.allTimeSince,
    historyEnabled: usage.historyEnabled,
    historyIntervalMs: normalizeHistoryIntervalMs(usage.historyIntervalMs),
    projectsEnabled: usage.projectsEnabled,
    wslScanEnabled: usage.wslScanEnabled,
    syncUploadIntervalMs: normalizeSyncUploadIntervalMs(
      context.syncUploadIntervalMs ?? settings.syncUploadIntervalMs
    ),
    limitsRefreshMode: limits.limitsRefreshMode,
    limitsRefreshMs: limits.limitsRefreshMs
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
  USAGE_STRUCTURAL_KEYS,
  classifySettingsChange,
  diagnosticConfigurationFromSettings,
  envelopeFromSettings,
  limitsConfigFromSettings,
  normalizeAllTimeSince,
  normalizeCursorAccountIds,
  normalizeCursorDisabledAccountIds,
  usageConfigFingerprint,
  usageConfigFromSettings
};
