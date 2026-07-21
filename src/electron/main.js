'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeImage, Notification, screen, session, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { defaultDeviceId, generateHubSecret, lanIpv4Addresses, loadDotEnv, pidFilePath, sharedDataDir } = require('../shared/config');
const {
  CredentialStore,
  credentialSettingsForRenderer,
  hasCredentialSettings,
  persistSettingsAndCredentials,
  readRegularFileNoFollow,
  stripCredentialSettings,
  writePrivateJsonAtomic
} = require('../shared/credentialStore');
const { installSafeStdout } = require('../shared/safeStdio');
const { appVersion } = require('../shared/appVersion');
const { exportFileSet, exportSignature, EXPORT_FILENAMES } = require('../shared/exporter');
const motionPreferenceApi = require('./motionPreference');

// Install EPIPE suppression before anything that might log. Without this,
// a closed parent pipe turns the next log call into an unhandled 'error'
// event and Electron pops a "JavaScript error in the main process" dialog.
installSafeStdout();
const { DEFAULT_CLIENTS, KNOWN_CLIENTS, clientsCsvForSetting } = require('../shared/clientTracking');
const { lookupModelPricing, normalizeHistoryIntervalMs } = require('../shared/collector');
const { createDeviceRuntime } = require('../shared/deviceRuntime');
const { customPricingPath } = require('../shared/tokscaleConfig');
const { applyCustomPricing, normalizeCustomPricingSetting } = require('../shared/tokscaleCustomPricing');
const { createHub } = require('../hub/server');
const { deepseekToken, normalizeLimitsRefreshMs, parseBoolean, parseLimitProviders, runCodexLogin, minimaxToken, copilotToken, zaiToken, zaiRegion, zaiTeamToken, volcengineCredentials, qoderCookie, kimiToken, kimiWebToken, ollamaSessionCookie } = require('../shared/limitCollector');
const { fetchOllamaLimits, rememberOllamaValidation } = require('../shared/ollamaLimits');
const { copilotLoginErrorMessage, isAllowedVerificationUrl, runCopilotDeviceFlowLogin } = require('../shared/copilotDeviceFlow');
const { codexAuthIdentity, hashAccountKey } = require('../shared/codexAuth');
const { codexLoginUrlFromOutput, isAllowedCodexLoginUrl } = require('../shared/codexLogin');
const {
  codexAccountMatchesIdentity,
  liveCodexAuthPath,
  readCodexAuthMaterial,
  writeCodexAuthFile
} = require('../shared/codexSystemSwitch');
const {
  normalizeClientDisplayOrder,
  normalizeHiddenClients,
  normalizePinnedClients
} = require('./renderer/clientDisplayPreferences');
const { LANGUAGE_OPTIONS, resolveLocale, translate } = require('./renderer/i18n');
const {
  defaultViewDisplayPreferences,
  normalizeHiddenViews,
  normalizeViewDisplayOrder
} = require('./renderer/viewDisplayPreferences');
const {
  defaultHomeModulePreferences,
  normalizeHiddenHomeModules,
  normalizeHomeModuleOrder
} = require('./renderer/homeModulePreferences');
const {
  checkNpmForNewer,
  cleanupStaleStaging,
  downloadFromNpm,
  getTokscaleStatus,
  resetToBundled
} = require('../shared/tokscaleUpdater');
const {
  appUpdateInstallSupport,
  checkLatestRelease,
  deriveAppUpdateAvailability,
  downloadedAppUpdateMatchesLatest,
  GITHUB_REPO,
  mergeLatestReleaseMetadata,
  shouldSkipAppUpdateCheck
} = require('../shared/appUpdater');
const cursorAuth = require('../shared/cursorAuth');
const cursorProbe = require('../shared/cursorProbe');
const opencodeWeb = require('../shared/opencodeWeb');
const semver = require('semver');
const { normalizeCurrency, resolveEffectiveRates, configureRates } = require('../shared/currency');
const { fetchRates, isCacheStale } = require('../shared/exchangeRates');
const {
  applyArchivedClientUsage,
  captureArchivedClientUsage,
  normalizeArchivedClientUsage,
  pruneArchivedClientUsage
} = require('../shared/clientUsageArchive');
const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  clearSessionUsageArchive,
  normalizeSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchiveDate,
  writeSessionUsageArchive
} = require('../shared/sessionUsageArchive');
const { clearDailyHistoryArchive } = require('../shared/dailyHistoryArchive');
const { aggregateDevices, aggregateHistory, applyProjectRollups } = require('../shared/usage');
const { postSyncPayload, syncPayload } = require('../shared/syncPayload');
const { mergedLocalAllTimeSessions } = require('../shared/localSessions');
const {
  MIMO_PLATFORM_CONSOLE_URL,
  createMimoManagedAccount,
  fetchMimoLimits,
  normalizeMimoCookieHeader
} = require('../shared/mimoLimits');
const { historyPreview, historyRevision } = require('../shared/history');
const { readSessionDetail } = require('../shared/sessionDetail');
const { startDiscordRpc, stopDiscordRpc, updateDiscordRpc } = require('./discordRpc');
const linuxAutostart = require('./linuxAutostart');
const { codexAccountIdForProvider, localLiveCodexProvider } = require('./renderer/accountIdentity');
const {
  buildTrayIcon,
  createTray,
  formatTrayText,
  isBarsTrayIconMode,
  pickUsageTrayIconId,
  popoverBounds,
  reconcileCodexAccountSelection,
  sortCodexAccountsForDisplay,
  shouldUseTemplateTrayIcon
} = require('./tray');
const {
  macActivationPolicyMode,
  mainWindowCloseAction,
  normalizeTrayModeSettings,
  shouldCreateTray,
  trayToggleAction
} = require('./trayModeSettings');
const { SERVICE_STATUS_PROVIDERS, createServiceStatusClient } = require('./serviceStatus');
const { classifyStreamFailure } = require('./syncConnection');
const { composeLocalSyncStats } = require('./syncDisplayStats');
const { createSyncUploadScheduler, normalizeSyncUploadIntervalMs } = require('./syncUploadScheduler');
const {
  classifySettingsChange,
  envelopeFromSettings,
  limitsConfigFromSettings,
  usageConfigFromSettings
} = require('./runtimeConfig');
const { runManualDeviceRefresh } = require('./deviceRuntimeCoordinator');
const { describeWindowBehavior, normalizeWindowBehaviorSettings } = require('./windowBehavior');
const {
  normalizeWindowToggleShortcut,
  windowToggleShortcutAction,
  windowToggleShortcutStatus
} = require('./windowShortcut');
const {
  FLOATING_BUBBLE_HANDLE_HEIGHT,
  FLOATING_BUBBLE_HANDLE_WIDTH,
  canUseFloatingBubble,
  collapsedFloatingBubbleBounds,
  dragFloatingBubbleBounds,
  expandedFloatingBubbleBounds,
  floatingBubbleCollapsedArea,
  floatingBubbleCollapsedMargin,
  floatingBubbleCollapsePlan,
  floatingBubbleInitialRendererQuery,
  floatingBubbleNativeGlassEnabled,
  floatingBubbleSide,
  floatingBubbleWindowChrome,
  normalizeInitialRendererViewState,
  moveFloatingBubbleBounds
} = require('./floatingBubble');
const { applyWindowsChrome } = require('./windowsChrome');

if (!app.isPackaged) loadDotEnv();

const APP_NAME = 'Token Monitor';
const APP_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

const DEFAULT_WINDOW = { width: 340, height: 650 };
const WINDOW_LIMITS = { minWidth: 240, minHeight: 140, maxWidth: 1200, maxHeight: 1400 };
const ZOOM_LIMITS = { min: 0.7, max: 1.6, step: 0.1 };
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');
const TRAY_CONTENT_VALUES = new Set(['tokens', 'cost', 'both', 'tokensAll', 'costAll', 'bothAll', 'limitsAllSessions', 'bars', 'barsSession', 'barsWeekly', 'barsAllSessions', 'icon']);
const HUB_MODE_VALUES = new Set(['local', 'client', 'host']);
const LANGUAGE_VALUES = new Set(LANGUAGE_OPTIONS.map((option) => option.value));
const COLLECTION_MODE_VALUES = new Set(['live', 'interval']);
const COLLECTION_INTERVAL_OPTIONS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
const DEFAULT_COLLECTION_INTERVAL_MS = 5 * 60 * 1000;
const HUB_DEFAULT_PORT = 17321;
const KNOWN_CLIENT_LIST = KNOWN_CLIENTS.split(',').map((id) => ({ id }));
const DEFAULT_VIEW_LIST = ['home', 'tool', 'status', 'device', 'model', 'project', 'session', 'limits', 'trends'].map((id) => ({ id }));
const DEFAULT_HOME_MODULE_LIST = ['limits', 'tool', 'device', 'model', 'trends'].map((id) => ({ id }));
const TRAY_OPEN_VIEW_IDS = new Set(['home', 'project', 'session', 'limits', 'trends', 'status']);

let mainWindow = null;
let dashboardWindow = null;
let settingsPath = null;
let settings = null;
let persistedSettingsSnapshot = null;
let credentialStore = null;
let credentialStorageErrorShown = false;
let sessionUsageArchive = null;
let rendererViewState = normalizeInitialRendererViewState();
const serviceStatusClient = createServiceStatusClient();
const STATUS_PAGE_HOSTS = new Set(SERVICE_STATUS_PROVIDERS.map((provider) => new URL(provider.pageUrl).hostname));

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.javis.tokenmonitor');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

const HOME_LIMIT_ACCOUNT_COUNT_DEFAULT = 3;
const HOME_LIMIT_ACCOUNT_COUNT_MAX = 12;

function normalizeHomeLimitAccountCount(value) {
  const count = Math.trunc(Number(value));
  if (!Number.isFinite(count)) return HOME_LIMIT_ACCOUNT_COUNT_DEFAULT;
  return Math.max(1, Math.min(HOME_LIMIT_ACCOUNT_COUNT_MAX, count));
}

function defaultSettings() {
  const envHubUrl = process.env.TOKEN_MONITOR_HUB_URL || '';
  const windowBehavior = process.env.TOKEN_MONITOR_ALWAYS_ON_TOP === '0' ? 'normal' : 'floating';
  return {
    hubMode: envHubUrl ? 'client' : 'local',
    hubUrl: envHubUrl,
    hubHostPort: Math.max(1, Math.min(65535, Number(process.env.TOKEN_MONITOR_PORT) || HUB_DEFAULT_PORT)),
    // Default to TOKEN_MONITOR_SECRET so agents that already trust this env
    // value (matching what the CLI hub uses) can connect to the widget's
    // embedded hub without a fresh round of credential sharing. Falls back
    // to a random secret generated in startEmbeddedHub() if env is empty.
    hubHostSecret: process.env.TOKEN_MONITOR_SECRET || '',
    secret: process.env.TOKEN_MONITOR_SECRET || '',
    windowBehavior,
    alwaysOnTop: windowBehavior === 'floating',
    refreshMs: Number(process.env.TOKEN_MONITOR_WIDGET_REFRESH_MS || 15000),
    glassOpacity: 68,
    glassBlur: 32,
    systemGlass: true,
    reduceMotion: 'system',
    showLiveDot: true,
    showToolIcons: true,
    titleIconOnly: true,
    showCompactTotalTokens: false,
    heatmapMetric: 'cost',
    themeColors: {},
    vendorColors: {},
    floatingBubbleEnabled: false,
    floatingBubbleTrigger: 'click',
    floatingBubbleContent: 'icon',
    floatingBubbleBounds: null,
    lastViewState: { period: 'today', breakdown: 'tool' },
    discordRpcEnabled: false,
    deviceId: process.env.TOKEN_MONITOR_DEVICE_ID || defaultDeviceId(),
    lastPostedDeviceId: '',
    clients: clientsCsvForSetting(process.env.TOKEN_MONITOR_CLIENTS),
    clientDisplayOrder: '',
    hiddenClients: '',
    pinnedClients: '',
    viewDisplayOrder: '',
    hiddenViews: defaultViewDisplayPreferences().hiddenViews,
    homeModuleOrder: defaultHomeModulePreferences().homeModuleOrder,
    hiddenHomeModules: defaultHomeModulePreferences().hiddenHomeModules,
    showHomeLimitBars: false,
    showHomeLimitProviderNames: false,
    projectsEnabled: parseBoolean(process.env.TOKEN_MONITOR_PROJECTS_ENABLED, false),
    historyEnabled: true,
    historyIntervalMs: normalizeHistoryIntervalMs(process.env.TOKEN_MONITOR_HISTORY_INTERVAL_MS),
    sessionUsageArchiveEnabled: parseBoolean(process.env.TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED, true),
    wslScanEnabled: parseBoolean(process.env.TOKEN_MONITOR_WSL_SCAN, true),
    exportAutoEnabled: false,
    exportDir: '',
    exportIntervalMs: 60 * 1000,
    collectionMode: 'live',
    collectionIntervalMs: 5 * 60 * 1000,
    syncUploadIntervalMs: normalizeSyncUploadIntervalMs(process.env.TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS),
    serviceProviderDisplayOrder: '',
    hiddenServiceProviders: '',
    serviceStatusRefreshMs: 60000,
    archivedClientUsage: { version: 1, clients: {} },
    allTimeSince: process.env.TOKEN_MONITOR_ALL_TIME_SINCE || '2024-01-01',
    customModelPricing: [],
    limitsEnabled: parseBoolean(process.env.TOKEN_MONITOR_LIMITS_ENABLED, true),
    limitProviders: parseLimitProviders(process.env.TOKEN_MONITOR_LIMIT_PROVIDERS).join(','),
    limitProviderOrder: defaultLimitProviderOrder(),
    homeLimitProviderOrder: '',
    hiddenHomeLimitProviders: '',
    homeLimitAccountCount: HOME_LIMIT_ACCOUNT_COUNT_DEFAULT,
    limitsRefreshMs: normalizeLimitsRefreshMs(process.env.TOKEN_MONITOR_LIMITS_REFRESH_MS),
    showLimitSource: parseBoolean(process.env.TOKEN_MONITOR_SHOW_LIMIT_SOURCE, false),
    maskLimitAccountEmails: false,
    showLimitUsed: parseBoolean(process.env.TOKEN_MONITOR_SHOW_LIMIT_USED, false),
    windowBounds: null,
    zoomFactor: 1,
    showTrayIcon: true,
    trayMode: false,
    trayContent: 'tokens',
    showTrayProviderBadge: false,
    windowToggleShortcut: '',
    currency: normalizeCurrency(process.env.TOKEN_MONITOR_CURRENCY || 'USD'),
    currencyRates: {},
    startAtLogin: false,
    language: 'auto',
    opencodeCookie: '',
    opencodeProfiles: {},
    deepseekApiKey: '',
    minimaxApiKey: '',
    copilotApiToken: '',
    copilotEnterpriseHost: '',
    zaiApiKey: '',
    zaiApiRegion: normalizeZaiApiRegion(process.env.TOKEN_MONITOR_ZAI_API_REGION || process.env.ZAI_API_REGION || process.env.Z_AI_API_HOST || 'global'),
    zaiTeamApiKey: '',
    zaiTeamOrganizationId: '',
    zaiTeamProjectId: '',
    volcengineAccessKeyId: '',
    volcengineSecretAccessKey: '',
    volcengineRegion: '',
    qoderCookie: '',
    qoderSite: 'global',
    kimiApiKey: '',
    kimiWebAccessToken: '',
    ollamaCookie: '',
    codexManagedAccounts: [],
    mimoManagedAccounts: [],
    appUpdate: {
      lastCheckedAt: null,
      lastKnownLatest: null,
      dismissedVersion: null
    }
  };
}

function normalizeCollectionMode(value, fallback = 'live') {
  const next = String(value || '').trim();
  if (COLLECTION_MODE_VALUES.has(next)) return next;
  return COLLECTION_MODE_VALUES.has(fallback) ? fallback : 'live';
}

function normalizeHeatmapMetric(value, fallback = 'cost') {
  const next = String(value || '').trim();
  if (next === 'tokens' || next === 'cost') return next;
  return fallback === 'tokens' ? 'tokens' : 'cost';
}

function normalizeCollectionIntervalMs(value, fallback = DEFAULT_COLLECTION_INTERVAL_MS) {
  const numeric = Number(value);
  if (COLLECTION_INTERVAL_OPTIONS.includes(numeric)) return numeric;
  const fallbackNumeric = Number(fallback);
  return COLLECTION_INTERVAL_OPTIONS.includes(fallbackNumeric) ? fallbackNumeric : DEFAULT_COLLECTION_INTERVAL_MS;
}

function collectorIntervalMs() {
  return normalizeCollectionIntervalMs(settings?.collectionIntervalMs);
}

function collectorWatchEnabled() {
  return normalizeCollectionMode(settings?.collectionMode) === 'live';
}

function syncUploadIntervalMs() {
  return normalizeSyncUploadIntervalMs(settings?.syncUploadIntervalMs);
}

function electronUsageConfig(errorPrefix) {
  return usageConfigFromSettings(settings, {
    agentVersion: appVersion(),
    agentRuntime: 'electron-widget',
    commandTimeoutMs: 120 * 1000,
    defaultDeviceId: defaultDeviceId(),
    intervalMs: collectorIntervalMs(),
    historyIntervalMs: normalizeHistoryIntervalMs(settings.historyIntervalMs),
    watchEnabled: collectorWatchEnabled(),
    watchDebounceMs: 1500,
    dailyHistoryArchiveWriteEnabled: () => !isExternalAgentActive(),
    onError: (error, reason) => console.log(`[${errorPrefix}] ${reason}: ${error.message}`),
    logger: (message) => console.log(`[${errorPrefix}] ${message}`)
  });
}

function electronLimitsConfig() {
  return limitsConfigFromSettings(settings, {
    env: process.env,
    defaultLimitProviders: defaultLimitProviders(),
    codexManagedAccounts: codexManagedAccountsForCollector(),
    mimoManagedAccounts: mimoManagedAccountsForCollector()
  });
}

function electronDeviceEnvelope() {
  return envelopeFromSettings(settings, {
    agentVersion: appVersion(),
    agentRuntime: 'electron-widget',
    defaultDeviceId: defaultDeviceId()
  });
}

function defaultLimitProviders() {
  return parseLimitProviders(process.env.TOKEN_MONITOR_LIMIT_PROVIDERS).join(',');
}

function defaultLimitProviderOrder() {
  return parseLimitProviders().join(',');
}

function normalizeDeepSeekApiKey(value) {
  return deepseekToken({}, String(value || ''));
}

function currentDeepSeekApiKey() {
  return settings?.deepseekApiKey || deepseekToken(process.env);
}

function normalizeMinimaxApiKey(value) {
  return minimaxToken({}, String(value || ''));
}

function currentMinimaxApiKey() {
  return settings?.minimaxApiKey || minimaxToken(process.env);
}

function normalizeCopilotApiToken(value) {
  return copilotToken({}, { copilotApiToken: String(value || '') });
}

function currentCopilotApiToken() {
  return settings?.copilotApiToken || copilotToken(process.env);
}

function normalizeSecretSetting(value) {
  let raw = String(value || '').trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function normalizeZaiApiKey(value) {
  return zaiToken({}, String(value || ''));
}

function normalizeZaiApiRegion(value) {
  return zaiRegion({ zaiApiRegion: value }, {});
}

function currentZaiApiKey() {
  return settings?.zaiApiKey || zaiToken(process.env);
}

function normalizeZaiTeamApiKey(value) {
  return zaiTeamToken({}, String(value || ''));
}

function normalizeZaiTeamId(value) {
  return String(value || '').trim();
}

function currentZaiTeamApiKey() {
  return settings?.zaiTeamApiKey || zaiTeamToken(process.env);
}

function normalizeVolcengineRegion(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw || '';
}

function currentVolcengineCredentials() {
  return volcengineCredentials(process.env, settings || {});
}

function normalizeQoderCookie(value) {
  return qoderCookie({}, { qoderCookie: String(value || '') });
}

function normalizeQoderSite(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'cn' || raw === 'china' || raw.includes('qoder.com.cn')) return 'cn';
  return 'global';
}

function currentQoderCookie() {
  return settings?.qoderCookie || qoderCookie(process.env);
}

function normalizeOllamaCookie(value) {
  return ollamaSessionCookie({}, { ollamaCookie: String(value || '') });
}

function currentOllamaCookie() {
  return settings?.ollamaCookie || ollamaSessionCookie(process.env);
}

function normalizeKimiApiKey(value) {
  return kimiToken({}, String(value || ''));
}

function currentKimiApiKey() {
  return settings?.kimiApiKey || kimiToken(process.env);
}

function normalizeKimiWebAccessToken(value) {
  return kimiWebToken({}, String(value || ''));
}

function currentKimiWebAccessToken() {
  return settings?.kimiWebAccessToken || kimiWebToken(process.env);
}

function normalizeCopilotEnterpriseHost(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
}

let codexLoginController = null;
let codexLoginFlowId = '';
let codexLoginCanCancel = false;
let copilotLoginController = null;
let copilotLoginFlowId = '';

function normalizeCodexManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const accounts = [];
  for (const account of value) {
    if (!account || typeof account !== 'object') continue;
    const id = String(account.id || '').trim();
    const homePath = String(account.homePath || '').trim();
    if (!id || !homePath) continue;
    const accountKey = String(account.accountKey || '').trim();
    const dedupe = accountKey || String(account.email || '').trim().toLowerCase() || id;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    accounts.push({
      id,
      email: String(account.email || '').trim().toLowerCase(),
      accountKey,
      accountLabel: String(account.accountLabel || '').trim(),
      homePath,
      authPath: String(account.authPath || path.join(homePath, 'auth.json')).trim(),
      addedAt: account.addedAt || new Date().toISOString(),
      updatedAt: account.updatedAt || account.addedAt || new Date().toISOString(),
      enabled: account.enabled !== false
    });
  }
  return accounts;
}

function codexAccountsForRenderer() {
  return normalizeCodexManagedAccounts(settings?.codexManagedAccounts).map(({
    id, email, accountKey, accountLabel, addedAt, updatedAt, enabled
  }) => ({ id, email, accountKey, accountLabel, addedAt, updatedAt, enabled }));
}

function codexManagedAccountsForCollector() {
  return normalizeCodexManagedAccounts(settings?.codexManagedAccounts);
}

function normalizeMimoManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const accounts = [];
  for (const account of value) {
    if (!account || typeof account !== 'object') continue;
    const id = String(account.id || '').trim();
    const accountKey = String(account.accountKey || '').trim();
    if (!id || !accountKey) continue;
    if (seen.has(accountKey)) continue;
    seen.add(accountKey);
    accounts.push({
      id,
      accountKey,
      accountEmail: String(account.accountEmail || '').trim().slice(0, 254),
      accountLabel: String(account.accountLabel || '').trim(),
      addedAt: account.addedAt || new Date().toISOString(),
      updatedAt: account.updatedAt || account.addedAt || new Date().toISOString(),
      enabled: account.enabled !== false
    });
  }
  return accounts;
}

function mimoAccountsForRenderer() {
  return normalizeMimoManagedAccounts(settings?.mimoManagedAccounts).map(({
    id, accountKey, accountEmail, accountLabel, addedAt, updatedAt, enabled
  }) => ({ id, accountKey, accountEmail, accountLabel, addedAt, updatedAt, enabled }));
}

function mimoManagedAccountsForCollector() {
  return normalizeMimoManagedAccounts(settings?.mimoManagedAccounts).map((account) => ({
    ...account,
    cookieHeader: readMimoCredential(account.id)
  })).filter((account) => account.cookieHeader);
}

function legacyMimoCredentialPath(id) {
  const digest = crypto.createHash('sha256').update(String(id || '')).digest('hex');
  return path.join(app.getPath('userData'), 'mimo-credentials', `${digest}.cookie`);
}

function writeMimoCredential(id, value) {
  const cookieHeader = normalizeMimoCookieHeader(value);
  if (!cookieHeader) return false;
  try {
    return ensureCredentialStore().writeMimoCredential(id, cookieHeader);
  } catch (_) {
    return false;
  }
}

function readMimoCredential(id) {
  try {
    return normalizeMimoCookieHeader(ensureCredentialStore().readMimoCredential(id));
  } catch (_) {
    return '';
  }
}

function removeMimoCredential(id) {
  try {
    return ensureCredentialStore().removeMimoCredential(id);
  } catch (_) {
    return false;
  }
}

async function addMimoManagedAccount(cookieValue) {
  const accounts = normalizeMimoManagedAccounts(settings?.mimoManagedAccounts);
  const result = createMimoManagedAccount(cookieValue, accounts);
  if (!result.ok) return result;
  const [validation] = await fetchMimoLimits({ mimoManagedAccounts: [result.account] });
  if (validation?.status !== 'ok') {
    const errorCode = validation?.status === 'unauthorized'
      ? 'invalidCookie'
      : validation?.status === 'sourceRateLimited' ? 'validationRateLimited' : 'validationUnavailable';
    return { ok: false, errorCode };
  }
  result.account.accountEmail = String(validation.accountEmail || '').trim().slice(0, 254);
  const previousCookie = readMimoCredential(result.account.id);
  const credentialStored = writeMimoCredential(result.account.id, result.account.cookieHeader);
  delete result.account.cookieHeader;
  if (!credentialStored) return { ok: false, errorCode: 'credentialStorageUnavailable' };
  settings.mimoManagedAccounts = normalizeMimoManagedAccounts([
    ...accounts.filter((account) => account.accountKey !== result.account.accountKey),
    result.account
  ]);
  try {
    saveSettings({ throwOnError: true });
  } catch (_) {
    if (previousCookie) writeMimoCredential(result.account.id, previousCookie);
    else removeMimoCredential(result.account.id);
    return { ok: false, errorCode: 'credentialStorageUnavailable' };
  }
  pushSettingsToRenderer();
  sendMimoAccountsPush();
  void queueLimitInvalidation({
    provider: 'mimo',
    accountId: result.account.id,
    accountKey: result.account.accountKey
  }, 'account-added');
  return { ok: true, accounts: mimoAccountsForRenderer() };
}

async function removeMimoManagedAccount(id) {
  const accountId = String(id || '').trim();
  const accounts = normalizeMimoManagedAccounts(settings.mimoManagedAccounts);
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) return { ok: false, error: 'Account not found' };
  const previousCookie = readMimoCredential(accountId);
  if (!removeMimoCredential(accountId)) return { ok: false, error: 'Could not remove stored credential' };
  settings.mimoManagedAccounts = accounts.filter((entry) => entry.id !== accountId);
  try {
    saveSettings({ throwOnError: true });
  } catch (_) {
    if (previousCookie) writeMimoCredential(accountId, previousCookie);
    return { ok: false, error: 'Could not persist account removal' };
  }
  pushSettingsToRenderer();
  sendMimoAccountsPush();
  void queueLimitInvalidation({ provider: 'mimo', accountId, accountKey: account.accountKey }, 'account-removed', {
    clear: true,
    refresh: false
  });
  return { ok: true, accounts: mimoAccountsForRenderer() };
}

function setMimoManagedAccountEnabled(id, enabled) {
  const accountId = String(id || '').trim();
  const accounts = normalizeMimoManagedAccounts(settings.mimoManagedAccounts);
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) return { ok: false, error: 'Account not found' };
  account.enabled = Boolean(enabled);
  account.updatedAt = new Date().toISOString();
  settings.mimoManagedAccounts = accounts;
  try {
    saveSettings({ throwOnError: true });
  } catch (_) {
    return { ok: false, error: 'Could not persist account state' };
  }
  pushSettingsToRenderer();
  sendMimoAccountsPush();
  void queueLimitInvalidation({ provider: 'mimo', accountId, accountKey: account.accountKey }, 'account-state', {
    clear: !account.enabled,
    refresh: account.enabled
  });
  return { ok: true, accounts: mimoAccountsForRenderer() };
}

function codexManagedRoot() {
  return path.join(app.getPath('userData'), 'managed-codex-homes');
}

function codexManagedHomePath(accountId) {
  const resolvedRoot = path.resolve(codexManagedRoot());
  const resolvedHome = path.resolve(resolvedRoot, String(accountId || ''));
  if (resolvedHome === resolvedRoot) return '';
  if (!resolvedHome.startsWith(`${resolvedRoot}${path.sep}`)) return '';
  return resolvedHome;
}

function codexEmailDerivedAccountKey(account, identity) {
  const email = String(identity.email || account.email || '').trim().toLowerCase();
  return Boolean(email && String(account.accountKey || '').trim() === hashAccountKey(email));
}

function findExistingCodexAccount(accounts, identity) {
  return accounts.find((account) => {
    if (identity.accountKey && account.accountKey && !codexEmailDerivedAccountKey(account, identity)) {
      return account.accountKey === identity.accountKey;
    }
    return Boolean(identity.email && account.email === identity.email);
  });
}

function codexAccountId(identity, existing) {
  if (existing?.id) return existing.id;
  return `codex-${(identity.accountKey || hashAccountKey(identity.email)).replace(/^sha256:/, '').slice(0, 12)}`;
}

// Deletes a managed home only when it resolves under our managed root, mirroring
// CodexBar's safe-delete guard so a bad record can never wipe an arbitrary path.
async function removeManagedHomeIfSafe(homePath) {
  if (!homePath) return;
  const resolvedHome = path.resolve(homePath);
  const resolvedRoot = path.resolve(codexManagedRoot());
  if (resolvedHome === resolvedRoot) return;
  if (!resolvedHome.startsWith(`${resolvedRoot}${path.sep}`)) return;
  await fs.promises.rm(resolvedHome, { recursive: true, force: true });
}

// Records a managed account for the auth that already lives in `homePath`, then
// reloads the collector so the new account's limits show up immediately.
function commitCodexManagedAccount(identity, homePath, existing, options = {}) {
  const now = new Date().toISOString();
  const id = codexAccountId(identity, existing);
  const accounts = normalizeCodexManagedAccounts(settings.codexManagedAccounts);
  const record = {
    id,
    email: identity.email,
    accountKey: identity.accountKey || hashAccountKey(identity.email || id),
    accountLabel: identity.accountLabel,
    homePath,
    authPath: path.join(homePath, 'auth.json'),
    addedAt: existing?.addedAt || now,
    updatedAt: now,
    enabled: options.enabled ?? true
  };
  settings.codexManagedAccounts = normalizeCodexManagedAccounts([
    ...accounts.filter((account) => account.id !== id),
    record
  ]);
  if (options.persist !== false) saveSettings({ throwOnError: true });
  return codexAccountsForRenderer().find((account) => account.id === id);
}

function hasCodexIdentity(identity) {
  return Boolean(identity?.accountKey || identity?.email);
}

async function snapshotCodexAuthFile(authPath) {
  let parentExisted = true;
  try { await fs.promises.stat(path.dirname(authPath)); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    parentExisted = false;
  }
  try {
    return { authPath, data: await fs.promises.readFile(authPath, 'utf8'), existed: true, parentExisted };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { authPath, data: '', existed: false, parentExisted };
  }
}

async function restoreCodexAuthFileSnapshot(snapshot, options = {}) {
  if (snapshot.existed) {
    await writeCodexAuthFile(snapshot.authPath, snapshot.data);
    return;
  }
  await fs.promises.rm(snapshot.authPath, { force: true });
  if (options.removeNewParent && !snapshot.parentExisted) {
    await removeManagedHomeIfSafe(path.dirname(snapshot.authPath));
  }
}

async function preserveLiveCodexAuthAsManagedAccount(targetIdentity) {
  let liveMaterial;
  try {
    liveMaterial = await readCodexAuthMaterial(liveCodexAuthPath(process.env));
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('Could not read live Codex auth before switching accounts:', error?.message || error);
    return null;
  }
  if (!hasCodexIdentity(liveMaterial.identity)) return null;
  if (codexAccountMatchesIdentity(targetIdentity, liveMaterial.identity)) return null;
  const accounts = normalizeCodexManagedAccounts(settings.codexManagedAccounts);
  const existing = findExistingCodexAccount(accounts, liveMaterial.identity);
  const homePath = codexManagedHomePath(codexAccountId(liveMaterial.identity, existing));
  if (!homePath) return null;
  const authSnapshot = await snapshotCodexAuthFile(path.join(homePath, 'auth.json'));
  try {
    await writeCodexAuthFile(authSnapshot.authPath, liveMaterial.data);
    const account = commitCodexManagedAccount(liveMaterial.identity, homePath, existing, {
      enabled: existing?.enabled ?? true,
      persist: false,
      restart: false
    });
    return {
      account,
      rollback: () => restoreCodexAuthFileSnapshot(authSnapshot, { removeNewParent: true })
    };
  } catch (error) {
    await restoreCodexAuthFileSnapshot(authSnapshot, { removeNewParent: true }).catch(() => {});
    throw error;
  }
}

function codexLoginErrorMessage(result) {
  const detail = result.output ? `\n\n${result.output}` : '';
  switch (result.outcome) {
    case 'missingBinary':
      return 'Codex CLI not found. Install Codex, then try again.';
    case 'launchFailed':
      return `Could not start codex login.${detail}`;
    case 'timedOut':
      return `Sign-in timed out. Finish the browser login, then try again.${detail}`;
    case 'cancelled':
      return 'Sign-in cancelled.';
    default:
      return `codex login failed.${detail}`;
  }
}

function cancelledCodexLoginResult() {
  return {
    ok: false,
    error: codexLoginErrorMessage({ outcome: 'cancelled' }),
    outcome: 'cancelled'
  };
}

async function rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal) {
  if (movedToFinal) await removeManagedHomeIfSafe(homePath);
  if (backupHomePath) await fs.promises.rename(backupHomePath, homePath);
}

// Best practice: each account gets its own OAuth grant via an isolated
// `codex login` (CodexBar/tokscale model), so it never shares a refresh-token
// lineage with the user's live Codex CLI login.
async function addCodexManagedAccount(onOutput, options = {}) {
  await fs.promises.mkdir(codexManagedRoot(), { recursive: true });
  const tempHome = path.join(codexManagedRoot(), `pending-${crypto.randomUUID()}`);
  await fs.promises.mkdir(tempHome, { recursive: true });
  let backupHomePath = '';
  let movedToFinal = false;
  let accountCommitted = false;
  try {
    const result = await runCodexLogin({ homePath: tempHome, onOutput, signal: options.signal }, { env: process.env });
    if (result.outcome !== 'success') {
      return { ok: false, error: codexLoginErrorMessage(result), outcome: result.outcome };
    }
    if (options.signal?.aborted) return cancelledCodexLoginResult();
    let auth;
    try {
      auth = JSON.parse(await fs.promises.readFile(path.join(tempHome, 'auth.json'), 'utf8'));
    } catch (_) {
      return { ok: false, error: 'Sign-in finished but no Codex credentials were written.' };
    }
    const identity = codexAuthIdentity(auth);
    if (!identity.accountKey && !identity.email) {
      return { ok: false, error: 'Could not identify the Codex account after sign-in.' };
    }
    if (options.signal?.aborted) return cancelledCodexLoginResult();
    const existing = findExistingCodexAccount(normalizeCodexManagedAccounts(settings.codexManagedAccounts), identity);
    const homePath = codexManagedHomePath(codexAccountId(identity, existing));
    if (!homePath) return { ok: false, error: 'The saved Codex account path is invalid.' };
    if (path.resolve(homePath) !== path.resolve(tempHome)) {
      if (options.signal?.aborted) return cancelledCodexLoginResult();
      const candidateBackupPath = `${homePath}.backup-${crypto.randomUUID()}`;
      try {
        await fs.promises.rename(homePath, candidateBackupPath);
        backupHomePath = candidateBackupPath;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (options.signal?.aborted) {
        await rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal);
        backupHomePath = '';
        return cancelledCodexLoginResult();
      }
      try {
        await fs.promises.rename(tempHome, homePath);
        movedToFinal = true;
      } catch (error) {
        await rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal);
        backupHomePath = '';
        throw error;
      }
      if (options.signal?.aborted) {
        await rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal);
        backupHomePath = '';
        movedToFinal = false;
        return cancelledCodexLoginResult();
      }
    }
    if (options.signal?.aborted) {
      await rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal);
      backupHomePath = '';
      movedToFinal = false;
      return cancelledCodexLoginResult();
    }
    const previousAccounts = settings.codexManagedAccounts;
    options.onCommit?.();
    let account;
    try {
      account = commitCodexManagedAccount(identity, homePath, existing, { restart: false });
      if (backupHomePath) {
        await removeManagedHomeIfSafe(backupHomePath);
        backupHomePath = '';
      }
      accountCommitted = true;
    } catch (error) {
      settings.codexManagedAccounts = previousAccounts;
      try {
        saveSettings();
      } catch (rollbackError) {
        console.warn('Could not restore Codex account settings:', rollbackError?.message || rollbackError);
      }
      await rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal);
      backupHomePath = '';
      movedToFinal = false;
      throw error;
    }
    void queueLimitInvalidation({
      provider: 'codex',
      accountId: account.id,
      accountKey: account.accountKey || ''
    }, 'account-added');
    return { ok: true, account };
  } finally {
    if (!accountCommitted) await removeManagedHomeIfSafe(tempHome).catch(() => {});
  }
}

async function removeCodexManagedAccount(id) {
  const accountId = String(id || '').trim();
  const accounts = normalizeCodexManagedAccounts(settings.codexManagedAccounts);
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) return { ok: false, error: 'Account not found' };
  settings.codexManagedAccounts = accounts.filter((entry) => entry.id !== accountId);
  try {
    saveSettings({ throwOnError: true });
  } catch (error) {
    return { ok: false, error: error?.message || 'Could not persist account removal' };
  }
  await removeManagedHomeIfSafe(account.homePath);
  void queueLimitInvalidation({ provider: 'codex', accountId, accountKey: account.accountKey || '' }, 'account-removed', {
    clear: true,
    refresh: false
  });
  return { ok: true, accounts: codexAccountsForRenderer() };
}

function setCodexManagedAccountEnabled(id, enabled) {
  const accountId = String(id || '').trim();
  const accounts = normalizeCodexManagedAccounts(settings.codexManagedAccounts);
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) return { ok: false, error: 'Account not found' };
  account.enabled = Boolean(enabled);
  settings.codexManagedAccounts = accounts;
  try {
    saveSettings({ throwOnError: true });
  } catch (error) {
    return { ok: false, error: error?.message || 'Could not persist account state' };
  }
  void queueLimitInvalidation({ provider: 'codex', accountId, accountKey: account.accountKey || '' }, 'account-state', {
    clear: !account.enabled,
    refresh: account.enabled
  });
  return { ok: true, accounts: codexAccountsForRenderer() };
}

async function switchCodexSystemAccount(id) {
  const accountId = String(id || '').trim();
  const accounts = normalizeCodexManagedAccounts(settings.codexManagedAccounts);
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) return { ok: false, error: 'Account not found' };
  if (account.enabled === false) return { ok: false, error: 'Account is disabled' };

  let targetMaterial;
  try {
    targetMaterial = await readCodexAuthMaterial(account.authPath || path.join(account.homePath, 'auth.json'));
  } catch (error) {
    return { ok: false, error: `Could not read the selected Codex account credentials: ${error?.message || error}` };
  }
  if (!hasCodexIdentity(targetMaterial.identity)) {
    return { ok: false, error: 'Could not identify the selected Codex account credentials.' };
  }

  const previousAccounts = normalizeCodexManagedAccounts(settings.codexManagedAccounts);
  const liveAuthPath = liveCodexAuthPath(process.env);
  let liveAuthSnapshot;
  try {
    liveAuthSnapshot = await snapshotCodexAuthFile(liveAuthPath);
  } catch (error) {
    return { ok: false, error: `Could not back up the local Codex account: ${error?.message || error}` };
  }
  let preservedLiveAccount = null;
  try {
    preservedLiveAccount = await preserveLiveCodexAuthAsManagedAccount(targetMaterial.identity);
    await writeCodexAuthFile(liveAuthPath, targetMaterial.data);
    const refreshedAccounts = normalizeCodexManagedAccounts(settings.codexManagedAccounts);
    const refreshed = refreshedAccounts.find((entry) => entry.id === account.id) || account;
    commitCodexManagedAccount(targetMaterial.identity, refreshed.homePath, refreshed, {
      enabled: refreshed.enabled !== false,
      restart: false
    });
    void queueLimitInvalidation({ provider: 'codex' }, 'system-account-switch');
    const activeAccountId = codexAccountId(targetMaterial.identity, refreshed);
    const accountsForRenderer = codexAccountsForRenderer();
    return {
      ok: true,
      activeAccountId,
      activeAccount: accountsForRenderer.find((entry) => entry.id === activeAccountId) || null,
      accounts: accountsForRenderer
    };
  } catch (error) {
    settings.codexManagedAccounts = previousAccounts;
    const rollbackErrors = [];
    try { await restoreCodexAuthFileSnapshot(liveAuthSnapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    try { await preservedLiveAccount?.rollback?.(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    const rollbackDetail = rollbackErrors.length > 0
      ? ` Rollback also failed: ${rollbackErrors.map((rollbackError) => rollbackError?.message || rollbackError).join('; ')}`
      : '';
    return { ok: false, error: `Could not switch the local Codex account: ${error?.message || error}.${rollbackDetail}` };
  }
}

async function refreshCodexManagedAccountLimits(id) {
  const accountId = String(id || '').trim();
  const accounts = normalizeCodexManagedAccounts(settings.codexManagedAccounts);
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) return { ok: false, error: 'Account not found' };
  if (account.enabled === false) return { ok: false, error: 'Account is disabled' };
  if (!deviceRuntimeHandle) return { ok: false, error: 'Limits runtime is not ready' };
  try {
    const result = await deviceRuntimeHandle.refreshLimits({
      provider: 'codex',
      accountId: account.id,
      accountKey: account.accountKey || ''
    }, 'account-refresh');
    const summary = result?.snapshot || deviceRuntimeHandle.getSnapshot()?.limits;
    const providers = (summary?.providers || []).filter((provider) => {
      if (provider?.provider !== 'codex') return false;
      if (account.accountKey) return provider.accountKey === account.accountKey;
      if (account.email) return String(provider.accountEmail || '').toLowerCase() === account.email;
      return provider.sourceDetail === 'managed';
    });
    return {
      ok: true,
      providers
    };
  } catch (error) {
    return { ok: false, error: `Could not refresh Codex account limits: ${error?.message || error}` };
  }
}

function migrateLimitProviders(value) {
  // Saved provider selections are user intent. Normalize ids, but do not expand
  // older defaults into today's full provider list because the saved shape is
  // indistinguishable from a deliberate "only these providers" choice.
  return parseLimitProviders(value).join(',');
}

function migrateLimitProviderOrder(value) {
  return parseLimitProviders(value).join(',') || defaultLimitProviderOrder();
}

function migrateHomeLimitProviderOrder(value) {
  const isEmpty = value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0);
  if (isEmpty) return '';
  const normalized = parseLimitProviders(value).join(',');
  return normalized && normalized !== defaultLimitProviderOrder() ? normalized : '';
}

function normalizeHiddenLimitProviders(value) {
  const known = new Set(parseLimitProviders());
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const hidden = [];
  for (const item of raw) {
    const id = String(item || '').trim().toLowerCase();
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    hidden.push(id);
  }
  return hidden.join(',');
}

function migrateClientDisplayOrder(value) {
  const known = new Set(KNOWN_CLIENTS.split(','));
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const hasKnownClient = raw.some((item) => known.has(String(item || '').trim().toLowerCase()));
  return hasKnownClient ? normalizeClientDisplayOrder(value, KNOWN_CLIENT_LIST).join(',') : '';
}

const SERVICE_STATUS_REFRESH_VALUES = new Set([0, 60000, 120000, 300000, 900000, 1800000]);
function normalizeServiceStatusRefreshMs(value) {
  const n = Number(value);
  return SERVICE_STATUS_REFRESH_VALUES.has(n) ? n : 60000;
}

function migrateViewDisplayOrder(value) {
  const known = new Set(DEFAULT_VIEW_LIST.map((view) => view.id));
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const hasKnownView = raw.some((item) => known.has(String(item || '').trim().toLowerCase()));
  return hasKnownView ? normalizeViewDisplayOrder(value, DEFAULT_VIEW_LIST).join(',') : '';
}

function normalizeTrayContent(value, fallback = 'tokens') {
  const v = String(value || '').trim();
  return TRAY_CONTENT_VALUES.has(v) ? v : fallback;
}

function normalizeHubMode(value, fallback = 'local') {
  const v = String(value || '').trim();
  return HUB_MODE_VALUES.has(v) ? v : fallback;
}

function normalizeLanguageSetting(value, fallback = 'auto') {
  const raw = String(value || '').replace(/_/g, '-').trim();
  const lower = raw.toLowerCase();
  if (lower === 'auto') return 'auto';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  if (lower === 'zh-tw' || lower.startsWith('zh-hant') || /-(tw|hk|mo)\b/i.test(raw)) return 'zh-TW';
  if (lower === 'zh-cn' || lower.startsWith('zh-hans') || /-(cn|sg|my)\b/i.test(raw)) return 'zh-CN';
  return LANGUAGE_VALUES.has(raw) ? raw : fallback;
}

function normalizeHubPort(value, fallback = HUB_DEFAULT_PORT) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 65535) return fallback;
  return n;
}

function clampZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, Number(n.toFixed(2))));
}

function isBoundsOnScreen(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false;
  try {
    const display = screen.getDisplayMatching({
      x: bounds.x, y: bounds.y, width: bounds.width || 1, height: bounds.height || 1
    });
    const wa = display.workArea;
    return bounds.x + bounds.width > wa.x &&
      bounds.x < wa.x + wa.width &&
      bounds.y + bounds.height > wa.y &&
      bounds.y < wa.y + wa.height;
  } catch (_) { return false; }
}

function restoredBounds() {
  const saved = settings?.windowBounds;
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return null;
  const width = Math.min(WINDOW_LIMITS.maxWidth, Math.max(WINDOW_LIMITS.minWidth, saved.width));
  const height = Math.min(WINDOW_LIMITS.maxHeight, Math.max(WINDOW_LIMITS.minHeight, saved.height));
  if (!isBoundsOnScreen({ ...saved, width, height })) return { width, height };
  return { x: saved.x, y: saved.y, width, height };
}

let persistBoundsTimer = null;
let floatingBubbleAutoCollapseTimer = null;
const floatingBubbleState = { collapsed: false, side: null, collapsedBounds: null, expandedBounds: null, suppressNextCollapse: false, contentSize: null };
let mainWindowChrome = { collapsedFloatingBubble: false };

function stopPersistBoundsTimer() {
  if (persistBoundsTimer) clearTimeout(persistBoundsTimer);
  persistBoundsTimer = null;
}

function floatingBubblePayload() {
  return {
    enabled: canUseFloatingBubble(settings),
    collapsed: floatingBubbleState.collapsed,
    side: floatingBubbleState.side
  };
}

// Load settings once and, on that first load, seed the in-memory view state
// from the persisted snapshot so a cold start reopens the last-used view.
function ensureSettingsLoaded() {
  if (settings) return settings;
  settings = readSettings();
  persistedSettingsSnapshot = cloneSettingsSnapshot(settings);
  rendererViewState = normalizeInitialRendererViewState(settings.lastViewState, rendererViewState);
  return settings;
}

function updateRendererViewState(patch) {
  const previous = rendererViewState;
  rendererViewState = normalizeInitialRendererViewState({
    ...rendererViewState,
    ...(patch || {})
  }, rendererViewState);
  const changed = previous.period !== rendererViewState.period
    || previous.breakdown !== rendererViewState.breakdown;
  if (changed && settings) {
    settings.lastViewState = { ...rendererViewState };
    saveSettings();
  }
  return rendererViewState;
}

function sendFloatingBubbleState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('floatingBubble:state', floatingBubblePayload()); } catch (_) {}
}

function stopFloatingBubbleAutoCollapseTimer() {
  if (floatingBubbleAutoCollapseTimer) clearTimeout(floatingBubbleAutoCollapseTimer);
  floatingBubbleAutoCollapseTimer = null;
}

function restoreWindowSizeLimits() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (typeof mainWindow.setMinimumSize === 'function') {
    mainWindow.setMinimumSize(WINDOW_LIMITS.minWidth, WINDOW_LIMITS.minHeight);
  }
  if (typeof mainWindow.setMaximumSize === 'function') {
    mainWindow.setMaximumSize(WINDOW_LIMITS.maxWidth, WINDOW_LIMITS.maxHeight);
  }
}

function applyCollapsedFloatingBubbleLimits(bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (typeof mainWindow.setMinimumSize === 'function') {
    mainWindow.setMinimumSize(bounds?.width || FLOATING_BUBBLE_HANDLE_WIDTH, bounds?.height || FLOATING_BUBBLE_HANDLE_HEIGHT);
  }
  if (typeof mainWindow.setMaximumSize === 'function') {
    mainWindow.setMaximumSize(bounds?.width || FLOATING_BUBBLE_HANDLE_WIDTH, bounds?.height || FLOATING_BUBBLE_HANDLE_HEIGHT);
  }
  if (typeof mainWindow.setResizable === 'function') mainWindow.setResizable(false);
  mainWindow.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating');
  if (typeof mainWindow.setSkipTaskbar === 'function') mainWindow.setSkipTaskbar(true);
}

function displayForBounds(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return null;
  try {
    return screen.getDisplayMatching({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width || 1,
      height: bounds.height || 1
    });
  } catch (_) {
    return null;
  }
}

function displayForPoint(point) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null;
  try {
    return screen.getDisplayNearestPoint({ x: Number(point.x), y: Number(point.y) });
  } catch (_) {
    return null;
  }
}

function collapsedAreaForDisplay(display) {
  return floatingBubbleCollapsedArea(display, process.platform) || display?.workArea || display?.bounds || null;
}

function collapsedMargin() {
  return floatingBubbleCollapsedMargin(process.platform);
}

function persistWindowBounds(next) {
  const prev = settings.windowBounds || {};
  if (prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height) return false;
  settings.windowBounds = next;
  saveSettings();
  return true;
}

function collapseFloatingBubble(plan) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  stopFloatingBubbleAutoCollapseTimer();
  const { side, expandedBounds, collapsedBounds } = plan || {};
  if (!expandedBounds || !collapsedBounds) return false;
  floatingBubbleState.collapsed = true;
  floatingBubbleState.side = side;
  floatingBubbleState.collapsedBounds = collapsedBounds;
  floatingBubbleState.expandedBounds = expandedBounds;
  settings.floatingBubbleBounds = collapsedBounds;
  applyNativeMaterial();
  if (process.platform === 'win32') {
    persistWindowBounds(expandedBounds);
    replaceMainWindow(collapsedBounds, {
      collapsedFloatingBubble: true,
      focus: false,
      waitForContent: settings.floatingBubbleContent !== 'icon'
    });
    sendFloatingBubbleState();
    return true;
  }
  applyCollapsedFloatingBubbleLimits(collapsedBounds);
  mainWindow.setBounds(collapsedBounds);
  persistWindowBounds(expandedBounds);
  sendFloatingBubbleState();
  return true;
}

function maybeCollapseFloatingBubble(bounds) {
  const display = displayForBounds(bounds);
  if (!display) return false;
  const collapsedArea = collapsedAreaForDisplay(display);
  const plan = floatingBubbleCollapsePlan(bounds, display.workArea, settings, {
    collapsed: floatingBubbleState.collapsed,
    suppressNextCollapse: floatingBubbleState.suppressNextCollapse,
    collapsedArea,
    collapsedMargin: collapsedMargin(),
    collapsedBounds: settings?.floatingBubbleBounds || floatingBubbleState.collapsedBounds,
    handleWidth: floatingBubbleState.contentSize?.width,
    handleHeight: floatingBubbleState.contentSize?.height
  });
  floatingBubbleState.suppressNextCollapse = false;
  if (!plan) return false;
  return collapseFloatingBubble(plan);
}

function expandFloatingBubble(options = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || !floatingBubbleState.collapsed) return false;
  stopFloatingBubbleAutoCollapseTimer();
  const current = mainWindow.getBounds();
  const display = displayForBounds(floatingBubbleState.expandedBounds || current) || displayForBounds(current);
  const target = display
    ? expandedFloatingBubbleBounds(current, display.workArea, floatingBubbleState.expandedBounds)
    : floatingBubbleState.expandedBounds;
  floatingBubbleState.collapsed = false;
  floatingBubbleState.side = null;
  floatingBubbleState.collapsedBounds = current;
  floatingBubbleState.expandedBounds = target;
  applyNativeMaterial();
  if (target) {
    floatingBubbleState.suppressNextCollapse = true;
    if (process.platform === 'win32' && mainWindowChrome.collapsedFloatingBubble) {
      persistWindowBounds(target);
      replaceMainWindow(target, {
        collapsedFloatingBubble: false,
        focus: options.focus !== false,
        suppressInitialNumberAnimation: true,
        waitForContent: true,
        inactive: options.focus === false
      });
      setTimeout(() => { floatingBubbleState.suppressNextCollapse = false; }, 300);
      sendFloatingBubbleState();
      return true;
    }
    restoreWindowSizeLimits();
    mainWindow.setBounds(target);
    persistWindowBounds(target);
    setTimeout(() => { floatingBubbleState.suppressNextCollapse = false; }, 300);
  }
  applyWindowSettings();
  sendFloatingBubbleState();
  if (options.focus !== false) {
    mainWindow.show();
    mainWindow.focus();
  }
  return true;
}

function scheduleFloatingBubbleAutoCollapse() {
  stopFloatingBubbleAutoCollapseTimer();
  if (!canUseFloatingBubble(settings) || floatingBubbleState.collapsed) return;
  floatingBubbleAutoCollapseTimer = setTimeout(() => {
    floatingBubbleAutoCollapseTimer = null;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
    maybeCollapseFloatingBubble(mainWindow.getBounds());
  }, 180);
}

function syncFloatingBubbleAvailability() {
  if (!canUseFloatingBubble(settings)) {
    if (floatingBubbleState.collapsed) expandFloatingBubble({ focus: false });
    else {
      floatingBubbleState.side = null;
      floatingBubbleState.collapsedBounds = null;
      floatingBubbleState.expandedBounds = null;
      floatingBubbleState.suppressNextCollapse = false;
      stopFloatingBubbleAutoCollapseTimer();
      restoreWindowSizeLimits();
    }
    sendFloatingBubbleState();
    return;
  }
  sendFloatingBubbleState();
}

function persistBoundsSoon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  stopPersistBoundsTimer();
  persistBoundsTimer = setTimeout(() => {
    persistBoundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const next = mainWindow.getBounds();
    const prev = settings.windowBounds || {};
    if (settings?.trayMode) {
      // Popover x/y is anchored to the tray icon each open; only the size carries over.
      if (prev.width === next.width && prev.height === next.height) return;
      settings.windowBounds = { ...prev, width: next.width, height: next.height };
    } else if (floatingBubbleState.collapsed && floatingBubbleState.expandedBounds) {
      floatingBubbleState.collapsedBounds = next;
      const display = displayForBounds(next);
      const nextSide = display ? floatingBubbleSide(next, collapsedAreaForDisplay(display)) : floatingBubbleState.side;
      if (nextSide !== floatingBubbleState.side) {
        floatingBubbleState.side = nextSide;
        sendFloatingBubbleState();
      }
      const previousBubble = settings.floatingBubbleBounds || {};
      if (previousBubble.x === next.x &&
        previousBubble.y === next.y &&
        previousBubble.width === next.width &&
        previousBubble.height === next.height) return;
      settings.floatingBubbleBounds = next;
    } else {
      if (prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height) return;
      settings.windowBounds = next;
    }
    saveSettings();
  }, 400);
}

function applyZoomFactor(target = mainWindow) {
  if (!target || target.isDestroyed()) return;
  target.webContents.setZoomFactor(clampZoom(settings.zoomFactor));
}

function setZoomFactor(value) {
  const next = clampZoom(value);
  if (next === clampZoom(settings.zoomFactor)) return;
  settings.zoomFactor = next;
  saveSettings();
  applyZoomFactor();
}

function adjustZoom(delta) {
  setZoomFactor(clampZoom(settings.zoomFactor) + delta);
}

function normalizeCurrencyOverrides(value) {
  const out = {};
  if (value && typeof value === 'object') {
    for (const [code, raw] of Object.entries(value)) {
      const key = normalizeCurrency(code, '');
      const num = Number(raw);
      // normalizeCurrency falls back to 'USD' for unknown codes; excluding 'USD'
      // drops both unknown codes and any attempt to override the USD base (always 1).
      if (key !== 'USD' && Number.isFinite(num) && num > 0) out[key] = num;
    }
  }
  return out;
}

function ensureCredentialStore() {
  if (!credentialStore) credentialStore = new CredentialStore(app.getPath('userData'));
  return credentialStore;
}

function reportCredentialStorageError(context, error) {
  const detail = error?.message || String(error || 'Unknown error');
  console.error(`[credentials] ${context}: ${detail}`);
  if (credentialStorageErrorShown || !app.isReady()) return;
  credentialStorageErrorShown = true;
  try {
    dialog.showErrorBox(
      'Credential storage error',
      `Token Monitor could not safely access credentials.json (${context}). The save was stopped and previous data was restored where possible. Check the file's JSON and permissions, then restart the app.\n\n${detail}`
    );
  } catch (_) {}
}

function loadCredentialSettings(saved) {
  try {
    const store = ensureCredentialStore();
    store.migrateLegacySettings(saved);
    const stored = store.settingsCredentials();
    // Cleanup is intentionally independent from the migration marker. If the
    // first cleanup write fails after credentials.json was committed, retry on
    // every startup until no credential keys remain in settings.json.
    if (hasCredentialSettings(saved)) {
      try {
        writePrivateJsonAtomic(settingsPath, stripCredentialSettings(saved));
      } catch (error) {
        reportCredentialStorageError('could not remove migrated credentials from settings.json', error);
      }
    }
    return stored;
  } catch (error) {
    reportCredentialStorageError('could not load credentials.json', error);
    return {};
  }
}

function migrateLegacyMimoCredentialFiles(accounts) {
  const entries = [];
  for (const account of accounts || []) {
    try {
      const cookieHeader = normalizeMimoCookieHeader(readRegularFileNoFollow(legacyMimoCredentialPath(account.id), {
        fs,
        description: 'Legacy MiMo credential',
        encoding: 'utf8'
      }));
      if (cookieHeader) entries.push({ id: account.id, cookieHeader });
    } catch (_) {}
  }
  if (entries.length === 0) return;
  try {
    ensureCredentialStore().migrateLegacyMimoCredentials(entries);
    for (const entry of entries) {
      if (!readMimoCredential(entry.id)) continue;
      try { fs.rmSync(legacyMimoCredentialPath(entry.id), { force: true }); } catch (_) {}
    }
    try { fs.rmdirSync(path.join(app.getPath('userData'), 'mimo-credentials')); } catch (_) {}
  } catch (error) {
    console.warn(`[credentials] Could not migrate MiMo credentials: ${error.message}`);
  }
}

function readSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    const defaults = defaultSettings();
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[settings] Could not load settings.json: ${error.message}`);
    }
    if (process.platform !== 'win32') {
      try {
        const stat = fs.lstatSync(settingsPath);
        if (stat.isFile() && !stat.isSymbolicLink()) fs.chmodSync(settingsPath, 0o600);
      } catch (_) {}
    }
    const storedCredentials = loadCredentialSettings(saved);
    if (!saved.secret && defaults.secret) delete saved.secret;
    const merged = { ...defaults, ...saved, ...storedCredentials };
    // Migrate older configs that predate hubMode: infer from hubUrl.
    if (saved.hubMode === undefined) {
      merged.hubMode = (saved.hubUrl && String(saved.hubUrl).trim()) ? 'client' : 'local';
    }
    if (saved.limitProviders !== undefined) {
      merged.limitProviders = migrateLimitProviders(saved.limitProviders);
    }
    if (saved.limitProviderOrder !== undefined) {
      merged.limitProviderOrder = migrateLimitProviderOrder(saved.limitProviderOrder);
    }
    if (saved.clientDisplayOrder !== undefined) {
      merged.clientDisplayOrder = migrateClientDisplayOrder(saved.clientDisplayOrder);
    }
    if (saved.hiddenClients !== undefined) {
      merged.hiddenClients = normalizeHiddenClients(saved.hiddenClients, KNOWN_CLIENT_LIST);
    }
    if (saved.pinnedClients !== undefined) {
      merged.pinnedClients = normalizePinnedClients(saved.pinnedClients, KNOWN_CLIENT_LIST);
    }
    if (saved.viewDisplayOrder !== undefined) {
      merged.viewDisplayOrder = migrateViewDisplayOrder(saved.viewDisplayOrder);
    }
    if (saved.hiddenViews !== undefined) {
      merged.hiddenViews = normalizeHiddenViews(saved.hiddenViews, DEFAULT_VIEW_LIST);
    }
    if (saved.homeModuleOrder !== undefined) {
      merged.homeModuleOrder = normalizeHomeModuleOrder(saved.homeModuleOrder, DEFAULT_HOME_MODULE_LIST).join(',');
    }
    if (saved.hiddenHomeModules !== undefined) {
      merged.hiddenHomeModules = normalizeHiddenHomeModules(saved.hiddenHomeModules, DEFAULT_HOME_MODULE_LIST);
    }
    merged.showHomeLimitBars = parseBoolean(merged.showHomeLimitBars, false);
    merged.showHomeLimitProviderNames = parseBoolean(merged.showHomeLimitProviderNames, false);
    if (saved.homeLimitProviderOrder !== undefined) {
      merged.homeLimitProviderOrder = migrateHomeLimitProviderOrder(saved.homeLimitProviderOrder);
    }
    if (saved.hiddenHomeLimitProviders !== undefined) {
      merged.hiddenHomeLimitProviders = normalizeHiddenLimitProviders(saved.hiddenHomeLimitProviders);
    }
    merged.homeLimitAccountCount = normalizeHomeLimitAccountCount(merged.homeLimitAccountCount);
    if (saved.historyEnabled !== undefined) {
      merged.historyEnabled = parseBoolean(saved.historyEnabled, false);
    }
    if (saved.projectsEnabled !== undefined) {
      merged.projectsEnabled = parseBoolean(saved.projectsEnabled, true);
    }
    if (saved.sessionUsageArchiveEnabled !== undefined) {
      merged.sessionUsageArchiveEnabled = parseBoolean(saved.sessionUsageArchiveEnabled, true);
    }
    if (saved.wslScanEnabled !== undefined) {
      merged.wslScanEnabled = parseBoolean(saved.wslScanEnabled, true);
    }
    merged.collectionMode = normalizeCollectionMode(merged.collectionMode);
    merged.collectionIntervalMs = normalizeCollectionIntervalMs(merged.collectionIntervalMs);
    merged.syncUploadIntervalMs = normalizeSyncUploadIntervalMs(merged.syncUploadIntervalMs);
    merged.heatmapMetric = normalizeHeatmapMetric(merged.heatmapMetric);
    merged.reduceMotion = motionPreferenceApi.normalize(merged.reduceMotion);
    if (saved.serviceProviderDisplayOrder !== undefined) {
      merged.serviceProviderDisplayOrder = String(saved.serviceProviderDisplayOrder || '');
    }
    if (saved.hiddenServiceProviders !== undefined) {
      merged.hiddenServiceProviders = String(saved.hiddenServiceProviders || '');
    }
    if (saved.serviceStatusRefreshMs !== undefined) {
      merged.serviceStatusRefreshMs = normalizeServiceStatusRefreshMs(saved.serviceStatusRefreshMs);
    }
    merged.codexManagedAccounts = normalizeCodexManagedAccounts(merged.codexManagedAccounts);
    merged.mimoManagedAccounts = normalizeMimoManagedAccounts(merged.mimoManagedAccounts);
    if (saved.windowBehavior === undefined && saved.alwaysOnTop !== undefined) {
      merged.windowBehavior = saved.alwaysOnTop ? 'floating' : 'normal';
    }
    if (saved.lastViewState !== undefined) {
      merged.lastViewState = normalizeInitialRendererViewState(saved.lastViewState);
    }
    merged.hubMode = normalizeHubMode(merged.hubMode);
    merged.language = normalizeLanguageSetting(merged.language);
    merged.currency = normalizeCurrency(merged.currency);
    merged.currencyRates = normalizeCurrencyOverrides(merged.currencyRates);
    merged.hubHostPort = normalizeHubPort(merged.hubHostPort);
    merged.hubHostSecret = typeof merged.hubHostSecret === 'string' ? merged.hubHostSecret : '';
    merged.floatingBubbleEnabled = parseBoolean(merged.floatingBubbleEnabled ?? merged.edgeDrawerEnabled, false);
    merged.archivedClientUsage = normalizeArchivedClientUsage(merged.archivedClientUsage);
    delete merged.edgeDrawerEnabled;
    merged.floatingBubbleTrigger = merged.floatingBubbleTrigger === 'hover' ? 'hover' : 'click';
    merged.floatingBubbleContent = normalizeTrayContent(merged.floatingBubbleContent, 'icon');
    merged.showTrayProviderBadge = parseBoolean(merged.showTrayProviderBadge, false);
    merged.windowToggleShortcut = normalizeWindowToggleShortcut(merged.windowToggleShortcut);
    // 如果设置了 opencodeCookie 但没有 profiles，自动迁移
    if (merged.opencodeCookie && Object.keys(merged.opencodeProfiles || {}).length === 0) {
      merged.opencodeProfiles = { default: { cookie: merged.opencodeCookie, enabled: true } };
    }
    migrateLegacyMimoCredentialFiles(merged.mimoManagedAccounts);
    Object.assign(merged, normalizeTrayModeSettings(merged));
    return normalizeWindowBehaviorSettings(merged);
  }
  catch (_error) {
    const defaults = defaultSettings();
    Object.assign(defaults, normalizeTrayModeSettings(defaults));
    return normalizeWindowBehaviorSettings(defaults);
  }
}

function cloneSettingsSnapshot(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function saveSettings(options = {}) {
  const previousSettings = cloneSettingsSnapshot(persistedSettingsSnapshot || settings);
  try {
    persistSettingsAndCredentials({
      store: ensureCredentialStore(),
      settingsPath,
      settings,
      previousSettings
    });
    persistedSettingsSnapshot = cloneSettingsSnapshot(settings);
    return true;
  } catch (error) {
    settings = previousSettings;
    reportCredentialStorageError('could not persist settings', error);
    if (options.throwOnError) throw error;
    return false;
  }
}

function loginItemEnabledHere() {
  if (!app.isPackaged) return false;
  // Electron login items only cover macOS/Windows; on Linux we manage an XDG
  // autostart entry ourselves, which needs the AppImage runtime ($APPIMAGE).
  if (process.platform === 'linux') return linuxAutostart.autostartSupported();
  return true;
}

function currentLoginItemState() {
  if (!loginItemEnabledHere()) return false;
  if (process.platform === 'linux') return linuxAutostart.isAutostartEnabled();
  try { return Boolean(app.getLoginItemSettings().openAtLogin); }
  catch (_) { return false; }
}

function applyLoginItem(startAtLogin) {
  if (!loginItemEnabledHere()) return false;
  if (process.platform === 'linux') return linuxAutostart.setAutostartEnabled(Boolean(startAtLogin));
  app.setLoginItemSettings({ openAtLogin: Boolean(startAtLogin) });
  return currentLoginItemState();
}

function syncLoginItemSettingFromOs() {
  if (!settings) return;
  const actual = currentLoginItemState();
  if (settings.startAtLogin === actual) return;
  settings.startAtLogin = actual;
  saveSettings();
}

function trackedClientSet(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function removedTrackedClients(previousClients, nextClients) {
  const previous = trackedClientSet(previousClients);
  const next = trackedClientSet(nextClients);
  return Array.from(previous).filter((client) => !next.has(client));
}

function localArchiveSourceDevice() {
  const deviceId = settings?.deviceId || defaultDeviceId();
  if (lastCollectedDevice?.deviceId === deviceId) return lastCollectedDevice;
  if (localDevice?.deviceId === deviceId) return localDevice;
  return (latestStats?.devices || []).find((device) => device?.deviceId === deviceId) || null;
}

function updateArchivedClientUsage(previousClients, nextClients) {
  const removedClients = removedTrackedClients(previousClients, nextClients);
  let archive = pruneArchivedClientUsage(settings.archivedClientUsage, nextClients);
  if (removedClients.length > 0) {
    archive = captureArchivedClientUsage(archive, localArchiveSourceDevice(), removedClients);
  }
  settings.archivedClientUsage = archive;
}

function ensureSessionUsageArchiveLoaded() {
  if (sessionUsageArchive) return sessionUsageArchive;
  try {
    sessionUsageArchive = readSessionUsageArchive();
  } catch (error) {
    console.log(`[session-archive] read failed: ${error.message}`);
    sessionUsageArchive = normalizeSessionUsageArchive({});
  }
  return sessionUsageArchive;
}

function updateSessionUsageArchive(summary, now) {
  const previous = ensureSessionUsageArchiveLoaded();
  const next = captureSessionUsageArchive(previous, summary, now);
  if (JSON.stringify(next) === JSON.stringify(previous)) return previous;
  try {
    writeSessionUsageArchive(next);
    sessionUsageArchive = next;
  } catch (error) {
    console.log(`[session-archive] write failed: ${error.message}`);
  }
  return next;
}

function summaryWithArchivedClientUsage(summary) {
  const now = sessionUsageArchiveDate(summary);
  const withArchivedClients = applyArchivedClientUsage(summary, settings?.archivedClientUsage, {
    activeClients: settings?.clients,
    now
  });
  let visibleSummary = withArchivedClients;
  if (settings?.sessionUsageArchiveEnabled === false) {
    return settings?.projectsEnabled === false ? visibleSummary : applyProjectRollups(visibleSummary);
  }
  if (isExternalAgentActive()) {
    sessionUsageArchive = null;
    visibleSummary = applySessionUsageArchive(withArchivedClients, ensureSessionUsageArchiveLoaded(), { now });
  } else {
    const sessionArchive = updateSessionUsageArchive(summary, now);
    visibleSummary = applySessionUsageArchive(withArchivedClients, sessionArchive, { now });
  }
  return settings?.projectsEnabled === false ? visibleSummary : applyProjectRollups(visibleSummary);
}

function applyMacActivationPolicy(state = {}) {
  if (process.platform !== 'darwin') return;
  const mainWindowVisible = state.mainWindowVisible !== undefined
    ? state.mainWindowVisible
    : mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.isVisible()
      : true;
  const mode = macActivationPolicyMode(settings, { mainWindowVisible });
  if (typeof app.setActivationPolicy === 'function') {
    try { app.setActivationPolicy(mode); } catch (_) {}
  }
  if (!app.dock) return;
  if (mode === 'accessory') app.dock.hide();
  else app.dock.show();
}

function applyWindowSettings() {
  if (!mainWindow) return;
  if (floatingBubbleState.collapsed) {
    applyCollapsedFloatingBubbleLimits(mainWindow.getBounds());
    return;
  }
  const behavior = describeWindowBehavior(settings);
  mainWindow.setAlwaysOnTop(behavior.alwaysOnTop, 'floating');
  if (typeof mainWindow.setMovable === 'function') mainWindow.setMovable(behavior.draggable);
  if (typeof mainWindow.setResizable === 'function') mainWindow.setResizable(behavior.resizable);
  if (typeof mainWindow.setIgnoreMouseEvents === 'function') {
    mainWindow.setIgnoreMouseEvents(behavior.mousePassthrough);
  }
  if (typeof mainWindow.setFocusable === 'function') mainWindow.setFocusable(behavior.focusable);
  if (typeof mainWindow.setSkipTaskbar === 'function') mainWindow.setSkipTaskbar(Boolean(settings?.trayMode));
  if (!behavior.focusable && typeof mainWindow.blur === 'function') mainWindow.blur();
}

function nativeBlurEnabled(source = settings) {
  return floatingBubbleNativeGlassEnabled(source);
}

function keepNativeBlurActive() {
  if (!mainWindow) return;
  if (!nativeBlurEnabled()) return;
  if (process.platform === 'darwin' && typeof mainWindow.setVisualEffectState === 'function') {
    mainWindow.setVisualEffectState('active');
  }
}

function applyNativeMaterial(source = settings) {
  if (!mainWindow) return;
  const enabled = nativeBlurEnabled(source);
  if (process.platform === 'darwin' && typeof mainWindow.setVibrancy === 'function') {
    mainWindow.setVibrancy(enabled ? 'hud' : null);
    if (typeof mainWindow.setVisualEffectState === 'function') {
      mainWindow.setVisualEffectState(enabled ? 'active' : 'inactive');
    }
  }
  // Windows: backgroundMaterial is locked in at window creation. setBackgroundMaterial('none')
  // does not restore layered-window transparency once DWM SystemBackdrop has been engaged,
  // so toggling is handled by rebuildWindow() instead.
}

function withHistoryPreview(stats, devices) {
  const history = settings?.historyEnabled === false ? aggregateHistory([]) : aggregateHistory(devices);
  stats.historyPreview = historyPreview(history);
  stats.historyRevision = historyRevision(history);
  return stats;
}

let mode = 'idle';
let deviceRuntimeHandle = null;
let localDevice = null;
let localStats = null;
let sseAbortController = null;
let sseRetryTimer = null;
let streamConnected = false;
let streamFailure = null;
let lastCollectedDevice = null;
let latestHubStats = null;
let tray = null;
let latestStats = null;
let trayRefreshInFlight = false;
let trayCodexActiveAccountId = '';
let trayCodexPendingAccountId = '';
let trayCodexPendingSince = 0;
let trayCodexSwitchInFlight = false;
const DEFAULT_EXPORT_INTERVAL_MS = 60 * 1000;
let lastExportAt = 0;
let lastAutoExport = { dir: null, signature: null };

// User-chosen auto-export throttle (Settings), clamped to a sane floor.
function exportIntervalMs() {
  const v = Number(settings.exportIntervalMs);
  return Number.isFinite(v) && v >= 1000 ? v : DEFAULT_EXPORT_INTERVAL_MS;
}
let suppressNextBlurHide = false;
const providerTrayIcons = {};
let registeredWindowToggleShortcut = '';
let windowToggleShortcutRegistered = false;
let defaultTrayIcon = null;
let tokScaleNpmMetadata = null;
let tokScaleUpdaterBusy = false;
function getDefaultTrayIcon() {
  if (!defaultTrayIcon) defaultTrayIcon = buildTrayIcon();
  return defaultTrayIcon;
}
const AGENT_PID_PATH = pidFilePath();
let embeddedHub = null;
let embeddedHubError = null;
let embeddedHubUnsub = null;
let modeQueue = Promise.resolve();
const pendingLimitInvalidations = new Map();
const pendingUsageClientRefreshes = new Map();

function limitInvalidationKey(scope) {
  const provider = String(scope?.provider || '').trim().toLowerCase();
  const account = String(
    scope?.accountKey
    || scope?.accountId
    || scope?.id
    || scope?.accountName
    || scope?.accountEmail
    || scope?.accountLabel
    || ''
  ).trim();
  return account ? `${provider}:${account}` : `${provider}:*`;
}

function rememberPendingLimitInvalidation(scope, reason, clear = false, refresh = true) {
  const normalized = { ...scope, provider: String(scope?.provider || '').trim().toLowerCase() };
  const key = limitInvalidationKey(normalized);
  if (key.endsWith(':*')) {
    for (const pendingKey of pendingLimitInvalidations.keys()) {
      if (pendingKey.startsWith(`${normalized.provider}:`)) pendingLimitInvalidations.delete(pendingKey);
    }
  }
  pendingLimitInvalidations.set(key, { scope: normalized, reason, clear, refresh });
}

function queueLimitInvalidation(scope, reason = 'credential-change', options = {}) {
  const clear = options.clear === true;
  const refresh = options.refresh !== false;
  if (!deviceRuntimeHandle) {
    rememberPendingLimitInvalidation(scope, reason, clear, refresh);
    return Promise.resolve({ queued: true });
  }
  if (clear) deviceRuntimeHandle.clearLimits(scope, reason);
  if (!refresh) return Promise.resolve({ cleared: true });
  return Promise.resolve(deviceRuntimeHandle.refreshLimits(scope, reason));
}

function drainPendingLimitInvalidations(runtime) {
  const pending = [...pendingLimitInvalidations.values()];
  pendingLimitInvalidations.clear();
  for (const entry of pending) {
    if (entry.clear) runtime.clearLimits(entry.scope, entry.reason);
    if (entry.refresh) {
      void Promise.resolve(runtime.refreshLimits(entry.scope, entry.reason)).catch((error) => {
        console.log(`[limits-runtime] pending refresh failed: ${error.message}`);
      });
    }
  }
}

function refreshUsageClient(clientId, options = {}) {
  const client = String(clientId || '').trim().toLowerCase();
  if (!deviceRuntimeHandle) {
    pendingUsageClientRefreshes.set(client, { clientId: client, options: { ...options } });
    return Promise.resolve({ queued: true });
  }
  return Promise.resolve(deviceRuntimeHandle.refreshClient(client, options));
}

function drainPendingUsageClientRefreshes(runtime) {
  const pending = [...pendingUsageClientRefreshes.values()];
  pendingUsageClientRefreshes.clear();
  for (const entry of pending) {
    void Promise.resolve(runtime.refreshClient(entry.clientId, entry.options)).catch((error) => {
      console.log(`[usage-runtime] pending client refresh failed: ${error.message}`);
    });
  }
}

function drainPendingRuntimeActions(runtime) {
  drainPendingLimitInvalidations(runtime);
  drainPendingUsageClientRefreshes(runtime);
}

function effectiveHubConfig() {
  if (settings?.hubMode === 'host') {
    return {
      url: `http://127.0.0.1:${normalizeHubPort(settings.hubHostPort)}`,
      secret: settings.hubHostSecret || ''
    };
  }
  if (settings?.hubMode === 'client') {
    const url = String(settings.hubUrl || '').trim();
    return { url: url || null, secret: settings.secret || '' };
  }
  return { url: null, secret: '' };
}

function hubDataFile() {
  return path.join(app.getPath('userData'), 'hub-devices.json');
}

function sendHubPush(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('hub:push', payload); } catch (_) {}
  }
}

function getHubInfo() {
  const port = normalizeHubPort(settings?.hubHostPort);
  return {
    mode: settings?.hubMode || 'local',
    port,
    secret: settings?.hubHostSecret || '',
    listening: Boolean(embeddedHub),
    listeningPort: embeddedHub ? embeddedHub.port : null,
    error: embeddedHubError,
    lanAddresses: lanIpv4Addresses()
  };
}

async function startEmbeddedHub() {
  if (embeddedHub) return embeddedHub;
  embeddedHubError = null;
  if (!settings.hubHostSecret) {
    settings.hubHostSecret = generateHubSecret();
    saveSettings();
  }
  const port = normalizeHubPort(settings.hubHostPort);
  try {
    const hub = createHub({
      port,
      host: '0.0.0.0',
      secret: settings.hubHostSecret,
      dataFile: hubDataFile(),
      logger: { error: (err) => console.log(`[hub] ${err?.message || err}`) }
    });
    await hub.start();
    embeddedHub = { hub, port };
    console.log(`[hub] listening on 0.0.0.0:${port}`);
    sendHubPush({ type: 'listening', info: getHubInfo() });
    return embeddedHub;
  } catch (error) {
    embeddedHubError = { code: error.code || 'error', message: error.message, port };
    console.log(`[hub] failed to start on port ${port}: ${error.message}`);
    sendHubPush({ type: 'error', info: getHubInfo() });
    return null;
  }
}

async function stopEmbeddedHub() {
  if (!embeddedHub) return;
  const handle = embeddedHub;
  embeddedHub = null;
  try { await handle.hub.stop(); } catch (_) {}
  sendHubPush({ type: 'stopped', info: getHubInfo() });
}

function isExternalAgentActive() {
  try {
    const raw = fs.readFileSync(AGENT_PID_PATH, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (_) { return false; }
}

async function deleteDeviceFromHub(deviceId) {
  const { url: hubUrl, secret } = effectiveHubConfig();
  if (!hubUrl) return;
  const base = hubUrl.replace(/\/$/, '');
  const response = await fetch(`${base}/api/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: secret ? { authorization: `Bearer ${secret}` } : {}
  });
  if (!response.ok && response.status !== 404) throw new Error(`DELETE ${response.status}`);
}

async function postToHub(summary) {
  const { url: hubUrl, secret } = effectiveHubConfig();
  if (!hubUrl) throw new Error('hub not configured');
  const stale = settings.lastPostedDeviceId;
  if (stale && stale !== summary.deviceId) {
    try { await deleteDeviceFromHub(stale); }
    catch (error) { console.log(`[sync] cleanup of old deviceId ${stale} failed: ${error.message}`); }
  }
  const url = `${hubUrl.replace(/\/$/, '')}/api/ingest`;
  const { response } = await postSyncPayload(fetch, url, {
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    summary,
    logger: (message) => console.log(`[sync] ${message}`)
  });
  if (!response.ok) throw new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
  if (settings.lastPostedDeviceId !== summary.deviceId) {
    settings.lastPostedDeviceId = summary.deviceId;
    saveSettings();
  }
  return response.json();
}

function stopSyncCollector() {
  if (deviceRuntimeHandle) { try { deviceRuntimeHandle.stop(); } catch (_) {} }
  deviceRuntimeHandle = null;
}

function startSyncCollector() {
  stopSyncCollector();
  if (!effectiveHubConfig().url) return;
  const syncUploadScheduler = createSyncUploadScheduler({
    intervalMs: syncUploadIntervalMs(),
    upload: postToHub,
    onError: (error) => console.log(`[sync-collector] post failed: ${error.message}`)
  });
  const sink = {
    async enqueue(summary, revision) {
      if (isExternalAgentActive()) { sessionUsageArchive = null; return; }
      const visibleSummary = {
        ...summary,
        syncUploadIntervalMs: syncUploadIntervalMs()
      };
      lastCollectedDevice = { ...visibleSummary, receivedAt: new Date().toISOString() };
      const displayStats = composeLocalSyncStats(latestHubStats, lastCollectedDevice);
      if (displayStats) {
        updateDiscordRpc(displayStats, settings.currency);
        sendPush({ event: 'stats', data: { type: 'stats', reason: 'local', stats: displayStats, at: new Date().toISOString() } });
      }
      await syncUploadScheduler.enqueue(visibleSummary, revision);
    },
    flush: () => syncUploadScheduler.flush(),
    stop: () => syncUploadScheduler.stop()
  };
  deviceRuntimeHandle = createDeviceRuntime({
    envelope: electronDeviceEnvelope(),
    initialLimits: lastCollectedDevice?.limits,
    limitsOptions: electronLimitsConfig(),
    transformUsage: summaryWithArchivedClientUsage,
    usageOptions: electronUsageConfig('sync-collector'),
    sink,
    onError: (error, reason) => console.log(`[sync-collector] ${reason}: ${error.message}`)
  }, {
    limitsDeps: { resolveConfigSnapshot: () => electronLimitsConfig() }
  });
  drainPendingRuntimeActions(deviceRuntimeHandle);
}

// Host mode: this device's own usage goes straight into the embedded hub's store
// in-process. No loopback HTTP, so a local firewall / proxy that blocks Token
// Monitor's own outbound connections can't zero out the widget's own usage (#17).
function startHostCollector() {
  stopSyncCollector();
  const sink = {
    enqueue(summary) {
      if (isExternalAgentActive()) { sessionUsageArchive = null; return; }
      const visibleSummary = summary;
      lastCollectedDevice = { ...visibleSummary, receivedAt: new Date().toISOString() };
      if (!embeddedHub) return;
      try {
        const stale = settings.lastPostedDeviceId;
        if (stale && stale !== visibleSummary.deviceId) {
          embeddedHub.hub.deleteDevice(stale);
        }
        const payload = syncPayload(visibleSummary);
        if (payload.allTimeProjectsOmitted === true) {
          console.log('[host-ingest] all-time project breakdown omitted to reduce the sync snapshot size');
        }
        embeddedHub.hub.ingest(payload);
        if (settings.lastPostedDeviceId !== visibleSummary.deviceId) {
          settings.lastPostedDeviceId = visibleSummary.deviceId;
          saveSettings();
        }
      } catch (error) {
        console.log(`[host-ingest] failed: ${error.message}`);
      }
    }
  };
  deviceRuntimeHandle = createDeviceRuntime({
    envelope: electronDeviceEnvelope(),
    initialLimits: lastCollectedDevice?.limits,
    limitsOptions: electronLimitsConfig(),
    transformUsage: summaryWithArchivedClientUsage,
    usageOptions: electronUsageConfig('host-collector'),
    sink,
    onError: (error, reason) => console.log(`[host-collector] ${reason}: ${error.message}`)
  }, {
    limitsDeps: { resolveConfigSnapshot: () => electronLimitsConfig() }
  });
  drainPendingRuntimeActions(deviceRuntimeHandle);
}

function stopHostStats() {
  if (embeddedHubUnsub) { try { embeddedHubUnsub(); } catch (_) {} }
  embeddedHubUnsub = null;
}

function startHostStats() {
  stopHostStats();
  if (!embeddedHub) return;
  // Host mode presents the same multi-device hub aggregate as connecting to a
  // remote hub, so it reuses the renderer's 'sync' status path (Live / synced
  // data). The in-process vs loopback distinction is internal to fetchStats.
  mode = 'sync';
  sendStatus(true);
  const emit = (stats, reason = 'hub') => {
    updateDiscordRpc(stats, settings.currency);
    sendPush({ event: 'stats', data: { type: 'stats', reason, stats, at: new Date().toISOString() } });
  };
  embeddedHubUnsub = embeddedHub.hub.onStats((stats, reason) => emit(stats, reason || 'hub'));
  // Prime the renderer with the current snapshot so it isn't blank until the
  // first collector tick lands.
  emit(embeddedHub.hub.getStats(), 'snapshot');
}

// Detection status is about this machine's local files, so stamp the freshly
// collected local clientStatus AND wslStatus onto the local device in whatever
// stats we hand the renderer. This keeps the 采集 tags + WSL panel correct in
// sync/host mode without depending on the hub (or a remote Worker) being
// redeployed to preserve these fields.
function injectLocalDeviceStatus(stats) {
  if (!stats || !Array.isArray(stats.devices)) return stats;
  if (lastCollectedDevice) {
    const device = stats.devices.find((entry) => entry.deviceId === lastCollectedDevice.deviceId);
    if (device) {
      if (lastCollectedDevice.clientStatus) device.clientStatus = lastCollectedDevice.clientStatus;
      if (lastCollectedDevice.wslStatus) device.wslStatus = lastCollectedDevice.wslStatus;
    }
  }
  // syncPayload drops the unbounded allTime.sessions from uploads (#118), so a hub
  // aggregate carries no all-time session detail and the TOTAL session view would fall back
  // to a model list. Rebuild the list — the hub's cross-device month sessions as the
  // immediate baseline (present on the first frame, before this restart's first local scan),
  // then this machine's own full all-time sessions once collected (free, in-process). Carry
  // it as a display-only sibling instead of mutating periods.allTime.sessions: the exporter
  // writes periods verbatim under a lossless contract, so the export must keep the true
  // aggregate. The renderer overlays this onto periods.allTime for the session view.
  // Only sync/host mode needs this: in local mode periods.allTime.sessions already holds the
  // full native list, so building the sibling there would just ship the unbounded map twice.
  if (mode !== 'local' && stats.periods?.allTime) {
    stats.allTimeSessionsView = mergedLocalAllTimeSessions(stats.periods, lastCollectedDevice);
  }
  return stats;
}

function sendPush(payload) {
  const previousHistoryRevision = statsHistoryRevision(latestStats);
  if (payload?.data?.stats) {
    injectLocalDeviceStatus(payload.data.stats);
    latestStats = payload.data.stats;
    syncTrayCodexActiveAccount();
    updateTrayDisplay();
    if (settings.exportAutoEnabled && settings.exportDir && Date.now() - lastExportAt >= exportIntervalMs()) {
      lastExportAt = Date.now();
      writeExportTo(settings.exportDir, payload.data.stats.periods, { skipUnchanged: true })
        .catch((err) => console.warn(`[export] auto-export failed: ${err.message}`));
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('stats:push', payload); } catch (_) {}
  }
  if (payload?.data?.stats) {
    const nextHistoryRevision = statsHistoryRevision(payload.data.stats);
    if (nextHistoryRevision !== previousHistoryRevision && dashboardWindow && !dashboardWindow.isDestroyed()) {
      try { dashboardWindow.webContents.send('dashboard:historyChanged'); } catch (_) {}
    }
  }
}

function statsHistoryRevision(stats) {
  const revision = String(stats?.historyRevision || '').trim();
  if (revision) return revision;
  // Compatibility with an older remote hub that has not shipped revisions yet.
  return JSON.stringify(stats?.historyPreview || null);
}

let rateCache = null;            // { rates, date, source, fetchedAt }
let effectiveRates = null;       // { CODE: number }
let rateRefreshTimer = null;

function exchangeRateCachePath() {
  return path.join(app.getPath('userData'), 'exchange-rates.json');
}

function readRateCache() {
  try { return JSON.parse(fs.readFileSync(exchangeRateCachePath(), 'utf8')); }
  catch (_) { return null; }
}

function writeRateCache(data) {
  try { fs.writeFileSync(exchangeRateCachePath(), JSON.stringify(data)); }
  catch (_) {}
}

function applyEffectiveRates() {
  effectiveRates = resolveEffectiveRates(rateCache?.rates || {}, settings?.currencyRates || {});
  configureRates(effectiveRates);          // main process's own currency module
  return effectiveRates;
}

async function refreshExchangeRates({ force = false } = {}) {
  if (rateCache === null) rateCache = readRateCache();
  if (force || isCacheStale(rateCache)) {
    try {
      const result = await fetchRates();
      rateCache = { rates: result.rates, date: result.date, source: result.source, fetchedAt: Date.now() };
      writeRateCache(rateCache);
    } catch (_) { /* silent: keep last cache / built-in defaults */ }
  }
  applyEffectiveRates();
  updateTrayDisplay();
  if (settings?.discordRpcEnabled && latestStats) updateDiscordRpc(latestStats, settings.currency);
  pushSettingsToRenderer();
}

function updateTrayDisplay() {
  if (!tray || tray.isDestroyed()) return;
  const mode = settings?.trayContent || 'tokens';
  const currency = normalizeCurrency(settings?.currency);
  const limitText = formatTrayText(latestStats, mode, currency, {
    limitProviderOrder: settings?.limitProviderOrder,
    limitProviders: settings?.limitProviders,
    showLimitUsed: settings?.showLimitUsed
  });
  const barsImageMode = isBarsTrayIconMode(mode) && !limitText && providerTrayIcons[mode];
  // A renderer-generated icon is cached in the main process. Only reuse it
  // while the current stats still have quota text; otherwise it can outlive
  // the provider data that generated it.
  const trayImageMode = mode === 'limitsAllSessions' && Boolean(limitText) && providerTrayIcons[mode];
  const text = trayImageMode ? '' : limitText;
  if (process.platform === 'darwin') tray.setTitle(text);
  // Tooltip always shows a useful summary, even in icon-only mode where setTitle is blank.
  const tip = formatTrayText(latestStats, 'both', currency);
  tray.setToolTip(`Token Monitor - ${tip}`);
  // Icon: rendered bars image in bar modes, otherwise the app icon.
  let icon = null;
  if (barsImageMode || trayImageMode) {
    icon = providerTrayIcons[mode];
  } else {
    const usageIconId = pickUsageTrayIconId(latestStats, mode, Object.keys(providerTrayIcons));
    if (usageIconId) icon = providerTrayIcons[usageIconId];
  }
  tray.setImage(icon || getDefaultTrayIcon());
}

function sendStatus(connected, extra) {
  streamConnected = Boolean(connected);
  streamFailure = streamConnected ? null : ((extra && extra.reason) ? { reason: extra.reason, detail: extra.detail ?? null } : streamFailure);
  sendPush({ event: 'status', data: { connected: streamConnected, mode, ...(extra || {}) } });
}

function stopLocalCollector() {
  if (deviceRuntimeHandle) { try { deviceRuntimeHandle.stop(); } catch (_) {} }
  deviceRuntimeHandle = null;
  localDevice = null;
  localStats = null;
}

function startLocalCollector() {
  stopLocalCollector();
  mode = 'local';
  sendStatus(false, { reason: 'collecting' });
  deviceRuntimeHandle = createDeviceRuntime({
    envelope: electronDeviceEnvelope(),
    initialLimits: lastCollectedDevice?.limits,
    limitsOptions: electronLimitsConfig(),
    transformUsage: summaryWithArchivedClientUsage,
    usageOptions: electronUsageConfig('collector'),
    progressive: true,
    onRecord: (summary, meta) => {
      const reason = meta.reason;
      const visibleSummary = summary;
      localDevice = { ...visibleSummary, receivedAt: new Date().toISOString() };
      lastCollectedDevice = localDevice;
      localStats = withHistoryPreview(aggregateDevices([localDevice], 0), [localDevice]);
      updateDiscordRpc(localStats, settings.currency);
      sendPush({ event: 'stats', data: { type: 'stats', reason, stats: localStats, at: new Date().toISOString() } });
      sendStatus(true, { reason });
    },
    onError: (error, reason) => sendStatus(false, { reason: `${reason}:${error.message}` })
  }, {
    limitsDeps: { resolveConfigSnapshot: () => electronLimitsConfig() }
  });
  drainPendingRuntimeActions(deviceRuntimeHandle);
}

function scheduleStreamRetry(delayMs = 3000) {
  if (sseRetryTimer) return;
  sseRetryTimer = setTimeout(() => { sseRetryTimer = null; startStatsStream(); }, delayMs);
}

function stopStatsStream() {
  if (sseAbortController) { try { sseAbortController.abort(); } catch (_) {} }
  sseAbortController = null;
  if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
}

function parseSseChunk(chunk) {
  let event = 'message';
  const dataLines = [];
  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try { return { event, data: JSON.parse(dataLines.join('\n')) }; } catch (_) { return null; }
}

async function startStatsStream(options = {}) {
  stopStatsStream();
  if (options.resetSnapshot) latestHubStats = null;
  const { url: hubUrl, secret } = effectiveHubConfig();
  if (!hubUrl) return;
  mode = 'sync';
  const url = `${hubUrl.replace(/\/$/, '')}/api/stats/stream`;
  const controller = new AbortController();
  sseAbortController = controller;
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      sendStatus(false, classifyStreamFailure({ status: response.status }));
      scheduleStreamRetry();
      return;
    }
    sendStatus(true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let parsed = parseSseChunk(chunk);
        if (parsed) {
          if (parsed.event === 'stats' && parsed.data?.stats) {
            latestHubStats = parsed.data.stats;
            const displayStats = composeLocalSyncStats(latestHubStats, lastCollectedDevice);
            parsed = { ...parsed, data: { ...parsed.data, stats: displayStats } };
            updateDiscordRpc(displayStats, settings.currency);
          }
          sendPush(parsed);
        }
      }
    }
    sendStatus(false, classifyStreamFailure({ eof: true }));
    scheduleStreamRetry();
  } catch (error) {
    if (controller.signal.aborted) return;
    sendStatus(false, classifyStreamFailure({ errorCode: error?.cause?.code || error?.code, message: error?.message }));
    scheduleStreamRetry();
  }
}

function showPopover() {
  if (!mainWindow || mainWindow.isDestroyed() || !tray) return;
  applyMacActivationPolicy();
  applyWindowSettings();
  const current = mainWindow.getBounds();
  const target = popoverBounds(tray, current.width, current.height);
  mainWindow.setBounds(target);
  suppressNextBlurHide = true;
  mainWindow.show();
  mainWindow.focus();
  // The focus event itself may not fire a blur; the suppress flag covers the
  // case where macOS fires blur immediately after show because the click that
  // opened us still has the menu bar as the focused element.
  setTimeout(() => { suppressNextBlurHide = false; }, 250);
}

function hidePopover() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) mainWindow.hide();
}

function togglePopover() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) hidePopover();
  else showPopover();
}

function focusExistingWindow() {
  applyMacActivationPolicy({ mainWindowVisible: true });
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (settings?.trayMode) showPopover();
  else if (floatingBubbleState.collapsed) expandFloatingBubble();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function currentWindowToggleShortcutStatus() {
  const shortcut = normalizeWindowToggleShortcut(settings?.windowToggleShortcut);
  const registered = windowToggleShortcutRegistered && registeredWindowToggleShortcut === shortcut;
  return windowToggleShortcutStatus(shortcut, registered);
}

// Strip OpenCode session cookies from a profiles map before it reaches the
// renderer; the UI only needs the profile name and enabled flag, not the value.
function redactOpencodeProfilesForRenderer(profiles) {
  if (!profiles || typeof profiles !== 'object') return profiles;
  const out = {};
  for (const [name, profile] of Object.entries(profiles)) {
    out[name] = { ...profile, cookie: profile && profile.cookie ? 'set' : '' };
  }
  return out;
}

function settingsForRenderer() {
  const deepseekApiKeySource = settings?.deepseekApiKey
    ? 'settings'
    : deepseekToken(process.env)
      ? 'env'
      : '';
  const minimaxApiKeySource = settings?.minimaxApiKey
    ? 'settings'
    : minimaxToken(process.env)
      ? 'env'
      : '';
  const copilotApiTokenSource = settings?.copilotApiToken
    ? 'settings'
    : copilotToken(process.env)
      ? 'env'
      : '';
  const zaiApiKeySource = settings?.zaiApiKey
    ? 'settings'
    : zaiToken(process.env)
      ? 'env'
      : '';
  const zaiTeamApiKeySource = settings?.zaiTeamApiKey
    ? 'settings'
    : zaiTeamToken(process.env)
      ? 'env'
      : '';
  const volcengineCredentialsSource = volcengineCredentials({}, settings || {})
    ? 'settings'
    : volcengineCredentials(process.env)
      ? 'env'
      : '';
  const qoderCookieSource = settings?.qoderCookie
    ? 'settings'
    : qoderCookie(process.env)
      ? 'env'
      : '';
  const ollamaCookieSource = settings?.ollamaCookie
    ? 'settings'
    : ollamaSessionCookie(process.env)
      ? 'env'
      : '';
  const kimiApiKeySource = settings?.kimiApiKey
    ? 'settings'
    : kimiToken(process.env)
      ? 'env'
      : '';
  const kimiWebAccessTokenSource = settings?.kimiWebAccessToken
    ? 'settings'
    : kimiWebToken(process.env)
      ? 'env'
      : '';
  // Default-deny every credential field added to the canonical store. The two
  // hub secrets remain explicit exceptions because the existing sync UI must
  // prefill/copy them; provider credentials only cross as blank/configured state.
  const redactedCredentials = credentialSettingsForRenderer(settings, {
    expose: ['hubHostSecret', 'secret']
  });
  return {
    ...settings,
    ...redactedCredentials,
    zaiApiRegion: normalizeZaiApiRegion(settings?.zaiApiRegion || 'global'),
    zaiTeamOrganizationId: settings?.zaiTeamOrganizationId ? 'set' : '',
    zaiTeamProjectId: settings?.zaiTeamProjectId ? 'set' : '',
    volcengineAccessKeyId: settings?.volcengineAccessKeyId ? 'set' : '',
    qoderCookie: settings?.qoderCookie ? 'set' : '',
    ollamaCookie: settings?.ollamaCookie ? 'set' : '',
    // Never ship OpenCode session cookies to the renderer; the UI only needs to
    // know whether a cookie is configured, not its value.
    opencodeCookie: settings?.opencodeCookie ? 'set' : '',
    ...(settings?.opencodeProfiles
      ? { opencodeProfiles: redactOpencodeProfilesForRenderer(settings.opencodeProfiles) }
      : {}),
    codexManagedAccounts: codexAccountsForRenderer(),
    mimoManagedAccounts: mimoAccountsForRenderer(),
    deepseekApiKeyConfigured: Boolean(currentDeepSeekApiKey()),
    deepseekApiKeySource,
    minimaxApiKeyConfigured: Boolean(currentMinimaxApiKey()),
    minimaxApiKeySource,
    copilotApiTokenConfigured: Boolean(currentCopilotApiToken()),
    copilotApiTokenSource,
    zaiApiKeyConfigured: Boolean(currentZaiApiKey()),
    zaiApiKeySource,
    zaiTeamApiKeyConfigured: Boolean(currentZaiTeamApiKey()),
    zaiTeamApiKeySource,
    volcengineCredentialsConfigured: Boolean(currentVolcengineCredentials()),
    volcengineCredentialsSource,
    qoderCookieConfigured: Boolean(currentQoderCookie()),
    qoderCookieSource,
    ollamaCookieConfigured: Boolean(currentOllamaCookie()),
    ollamaCookieSource,
    kimiApiKeyConfigured: Boolean(currentKimiApiKey()),
    kimiApiKeySource,
    kimiWebAccessTokenConfigured: Boolean(currentKimiWebAccessToken()),
    kimiWebAccessTokenSource,
    kimiCredentialConfigured: Boolean(currentKimiWebAccessToken() || currentKimiApiKey()),
    kimiCredentialSource: kimiWebAccessTokenSource || kimiApiKeySource,
    currencyRatesEffective: effectiveRates || resolveEffectiveRates(rateCache?.rates || {}, settings?.currencyRates || {}),
    currencyRateInfo: rateCache ? { source: rateCache.source, date: rateCache.date, fetchedAt: rateCache.fetchedAt } : null,
    windowToggleShortcutStatus: currentWindowToggleShortcutStatus()
  };
}

function pushSettingsToRenderer() {
  const payload = settingsForRenderer();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('settings:push', payload); } catch (_) {}
  }
  // The trends dashboard is a separate renderer with its own currency module
  // instance; it must receive effective-rate updates too, otherwise an
  // already-open dashboard keeps showing the previous rate after an auto
  // refresh or manual override until it is reopened.
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    try { dashboardWindow.webContents.send('settings:push', payload); } catch (_) {}
  }
}

function sendMimoAccountsPush() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('mimo:accounts', mimoAccountsForRenderer()); } catch (_) {}
}

function unregisterWindowToggleShortcut() {
  if (registeredWindowToggleShortcut) {
    try { globalShortcut.unregister(registeredWindowToggleShortcut); } catch (_) {}
  }
  registeredWindowToggleShortcut = '';
  windowToggleShortcutRegistered = false;
}

function handleWindowToggleShortcut() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const action = windowToggleShortcutAction({
    trayMode: Boolean(settings?.trayMode),
    floatingBubbleCollapsed: Boolean(floatingBubbleState.collapsed),
    visible: mainWindow.isVisible(),
    minimized: typeof mainWindow.isMinimized === 'function' ? mainWindow.isMinimized() : false
  });
  if (action === 'togglePopover') togglePopover();
  else if (action === 'expandFloatingBubble') expandFloatingBubble();
  else if (action === 'hideWindow') mainWindow.hide();
  else focusExistingWindow();
}

function handleTrayToggle() {
  const action = trayToggleAction(settings);
  if (action === 'togglePopover') togglePopover();
  else if (action === 'focusWindow') focusExistingWindow();
}

function trayMenuLocale() {
  const preferredLanguages = typeof app.getPreferredSystemLanguages === 'function'
    ? app.getPreferredSystemLanguages()
    : [app.getLocale()];
  return resolveLocale(settings?.language || 'auto', preferredLanguages);
}

function sendMainWindowEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.webContents.send(channel, payload); } catch (_) {}
  };
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}

async function refreshFromTray() {
  if (trayRefreshInFlight) return;
  trayRefreshInFlight = true;
  try {
    const stats = await fetchStats({ force: true });
    // Collector ticks normally publish their own final snapshot. Only bridge the
    // result when fetchStats returned a different object (for example, a remote hub
    // fetch while an external headless agent owns collection).
    if (stats && stats !== latestStats) {
      sendPush({ event: 'stats', data: { stats, mode, reason: 'manual' } });
    }
  } catch (error) {
    console.warn(`[tray] refresh failed: ${error.message}`);
    showTrayRefreshError(error?.message || error);
  } finally {
    trayRefreshInFlight = false;
  }
}

function setTrayContentFromMenu(value) {
  const next = normalizeTrayContent(value, settings?.trayContent || 'tokens');
  if (next === settings?.trayContent) return;
  settings.trayContent = next;
  saveSettings();
  updateTrayDisplay();
  pushSettingsToRenderer();
}

function setWindowPresentationFromMenu(value) {
  if (value === 'tray') {
    if (settings.trayMode) return;
    settings.trayMode = true;
    saveSettings();
    syncFloatingBubbleAvailability();
    enterTrayMode();
    pushSettingsToRenderer();
    return;
  }

  const previousTrayMode = settings.trayMode;
  settings = normalizeWindowBehaviorSettings(settings, {
    trayMode: false,
    windowBehavior: value
  });
  saveSettings();
  if (previousTrayMode) exitTrayMode();
  else {
    applyWindowSettings();
    focusExistingWindow();
  }
  pushSettingsToRenderer();
}

function openSettingsFromTray() {
  focusExistingWindow();
  sendMainWindowEvent('settings:open');
}

function openViewFromTray(viewId) {
  const normalized = String(viewId || '').trim().toLowerCase();
  if (!TRAY_OPEN_VIEW_IDS.has(normalized)) return;
  focusExistingWindow();
  sendMainWindowEvent('view:open', normalized);
}

function enabledTrayCodexAccounts() {
  return sortCodexAccountsForDisplay(
    codexAccountsForRenderer().filter((account) => account.enabled !== false)
  );
}

function syncTrayCodexActiveAccount() {
  const accounts = enabledTrayCodexAccounts();
  const localDeviceId = settings?.deviceId || '';
  const liveProvider = localLiveCodexProvider(latestStats, localDeviceId);
  const selection = reconcileCodexAccountSelection({
    detectedAccountId: codexAccountIdForProvider(accounts, liveProvider),
    detectedAt: liveProvider?.updatedAt,
    pendingAccountId: trayCodexPendingAccountId,
    pendingSince: trayCodexPendingSince
  });
  trayCodexActiveAccountId = selection.activeAccountId;
  trayCodexPendingAccountId = selection.pendingAccountId;
  if (!trayCodexPendingAccountId) trayCodexPendingSince = 0;
}

function trayCodexMenuState() {
  syncTrayCodexActiveAccount();
  const accounts = enabledTrayCodexAccounts();
  return {
    accounts,
    activeAccountId: trayCodexPendingAccountId || trayCodexActiveAccountId,
    switching: trayCodexSwitchInFlight
  };
}

function showTrayCodexSwitchError(error) {
  const locale = trayMenuLocale();
  const title = translate(locale, 'trayMenu.codexSwitchFailedTitle');
  const body = translate(locale, 'trayMenu.codexSwitchFailedBody', { error: String(error || '') });
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  } else {
    dialog.showErrorBox(title, body);
  }
}

function showTrayRefreshError(error) {
  const locale = trayMenuLocale();
  const title = translate(locale, 'trayMenu.refreshFailedTitle');
  const body = translate(locale, 'trayMenu.refreshFailedBody', { error: String(error || '') });
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  } else {
    dialog.showErrorBox(title, body);
  }
}

async function switchCodexAccountFromTray(accountId) {
  if (trayCodexSwitchInFlight || !accountId) return;
  const currentId = trayCodexPendingAccountId || trayCodexActiveAccountId;
  if (accountId === currentId) return;
  trayCodexSwitchInFlight = true;
  try {
    const result = await switchCodexSystemAccount(accountId);
    if (!result?.ok) {
      showTrayCodexSwitchError(result?.error);
      return;
    }
    trayCodexActiveAccountId = result.activeAccountId || accountId;
    trayCodexPendingAccountId = trayCodexActiveAccountId;
    trayCodexPendingSince = Date.now();
    pushSettingsToRenderer();
  } catch (error) {
    showTrayCodexSwitchError(error?.message || error);
  } finally {
    trayCodexSwitchInFlight = false;
  }
}

function configureWindowToggleShortcut() {
  unregisterWindowToggleShortcut();
  const shortcut = normalizeWindowToggleShortcut(settings?.windowToggleShortcut);
  settings.windowToggleShortcut = shortcut;
  if (!shortcut || !app.isReady()) return false;
  try {
    windowToggleShortcutRegistered = globalShortcut.register(shortcut, handleWindowToggleShortcut);
    if (windowToggleShortcutRegistered) {
      registeredWindowToggleShortcut = shortcut;
      return true;
    }
  } catch (error) {
    console.log(`[shortcut] failed to register ${shortcut}: ${error.message}`);
    return false;
  }
  console.log(`[shortcut] failed to register ${shortcut}`);
  return false;
}

function ensureTray() {
  if (!shouldCreateTray(settings)) return false;
  if (tray && !tray.isDestroyed()) return;
  tray = createTray({
    getMenuState: () => {
      const codex = trayCodexMenuState();
      return {
        appVersion: appVersion(),
        refreshing: trayRefreshInFlight,
        trayContent: settings?.trayContent || 'tokens',
        trayMode: Boolean(settings?.trayMode),
        windowBehavior: settings?.windowBehavior || 'floating',
        codexAccounts: codex.accounts,
        activeCodexAccountId: codex.activeAccountId,
        codexSwitching: codex.switching,
        maskAccountEmails: Boolean(settings?.maskLimitAccountEmails),
        viewEnabled: {
          home: true,
          project: settings?.projectsEnabled !== false,
          session: true,
          limits: settings?.limitsEnabled !== false && parseLimitProviders(settings?.limitProviders).length > 0,
          trends: settings?.historyEnabled !== false,
          status: true
        }
      };
    },
    onToggle: handleTrayToggle,
    onOpenView: openViewFromTray,
    onRefresh: () => { void refreshFromTray(); },
    onSetTrayContent: setTrayContentFromMenu,
    onSetWindowPresentation: setWindowPresentationFromMenu,
    onSwitchCodexAccount: (accountId) => { void switchCodexAccountFromTray(accountId); },
    onOpenSettings: openSettingsFromTray,
    onQuit: requestAppQuit,
    translateMenu: (key, params) => translate(trayMenuLocale(), key, params)
  });
  updateTrayDisplay();
  return true;
}

function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

function enterTrayMode() {
  applyMacActivationPolicy();
  ensureTray();
  updateTrayDisplay();
  applyWindowSettings();
  applyMacActivationPolicy();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (typeof mainWindow.setSkipTaskbar === 'function') mainWindow.setSkipTaskbar(true);
    // Without this, .show() yanks the user back to the Space the window was last
    // shown on instead of popping over the current Space / fullscreen app.
    if (typeof mainWindow.setVisibleOnAllWorkspaces === 'function') {
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    mainWindow.hide();
  }
}

function exitTrayMode() {
  applyMacActivationPolicy({ mainWindowVisible: true });
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (typeof mainWindow.setSkipTaskbar === 'function') mainWindow.setSkipTaskbar(false);
    if (typeof mainWindow.setVisibleOnAllWorkspaces === 'function') {
      mainWindow.setVisibleOnAllWorkspaces(false);
    }
    const restore = restoredBounds() || DEFAULT_WINDOW;
    mainWindow.setBounds({
      width: restore.width,
      height: restore.height,
      ...(typeof restore.x === 'number' ? { x: restore.x, y: restore.y } : {})
    });
    applyWindowSettings();
    mainWindow.show();
    mainWindow.focus();
  }
  if (!shouldCreateTray(settings)) destroyTray();
  else ensureTray();
}

function startMode() {
  // Tear down collectors synchronously so they can't double-run while the
  // async reconciliation below is queued.
  stopLocalCollector();
  stopStatsStream();
  stopHostStats();
  stopSyncCollector();
  // Serialize the hub-side work so rapid UI events (mode change immediately
  // followed by a port edit or secret regenerate) reconcile in order rather
  // than racing — otherwise an in-flight start could finish with the old
  // port/secret after the UI already advertises the new ones.
  modeQueue = modeQueue.then(async () => {
    if (settings.hubMode === 'host') {
      await stopEmbeddedHub();
      const handle = await startEmbeddedHub();
      if (settings.hubMode !== 'host') {
        await stopEmbeddedHub();
        return;
      }
      if (!handle) {
        // Bind failed (e.g. EADDRINUSE). The error is already surfaced via
        // hub:push; fall back to the local collector so the widget still
        // shows data while the user fixes the port.
        startLocalCollector();
        return;
      }
      startHostStats();
      startHostCollector();
      return;
    }
    await stopEmbeddedHub();
    if (effectiveHubConfig().url) {
      startStatsStream({ resetSnapshot: true });
      startSyncCollector();
    } else {
      startLocalCollector();
    }
  }).catch((err) => {
    console.log(`[mode] reconciliation failed: ${err?.message || err}`);
  });
}

function restartDeviceRuntimeForMode() {
  if (mode === 'local') {
    startLocalCollector();
    return;
  }
  if (settings.hubMode === 'host' && embeddedHub) {
    startHostCollector();
    return;
  }
  if (effectiveHubConfig().url) startSyncCollector();
  else startLocalCollector();
}

function stopAll() {
  stopPersistBoundsTimer();
  stopLocalCollector();
  stopStatsStream();
  stopHostStats();
  stopSyncCollector();
  void stopEmbeddedHub();
  stopDiscordRpc();
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

let quitRequested = false;
function requestAppQuit() {
  if (quitRequested) return;
  quitRequested = true;
  stopAll();
  if (app.isReady()) app.quit();
  else app.exit(0);
}

// Write the export file set (JSON + CSVs) into `dir`, atomically (temp + rename)
// so a synced vault / iCloud never reads a half-written file. Pulls history
// itself; callers pass only `periods` (privacy: devices/limits never enter).
async function writeExportTo(dir, periods, options = {}) {
  if (!dir) return { ok: false, reason: 'no-dir' };
  const history = await getDashboardHistory().catch(() => null);
  // History unavailable (e.g. a transient hub fetch failure) is NOT the same as
  // "no history": writing a snapshot-only set would emit empty time-series JSON
  // AND the orphan cleanup below would delete an existing daily.csv. Never write a
  // destructive partial — skip and report, so auto-export retries next tick and
  // manual export can surface the failure instead of silently losing data.
  if (!history) return { ok: false, reason: 'history-unavailable' };
  // Auto-export skips rewriting a synced folder when the data is unchanged
  // (keyed by dir so pointing at a fresh folder always writes). Manual export
  // never skips. Signature compares inputs, not files, to ignore the volatile
  // generatedAt in the JSON.
  let signature = null;
  if (options.skipUnchanged) {
    signature = exportSignature(periods || {}, history);
    if (dir === lastAutoExport.dir && signature === lastAutoExport.signature) return { ok: true, skipped: true };
  }
  const files = exportFileSet({
    periods: periods || {},
    history,
    meta: { generatedAt: new Date().toISOString(), app: { name: 'token-monitor', version: appVersion() } }
  });
  await fs.promises.mkdir(dir, { recursive: true });
  // Per-call token so a concurrent auto + manual export to the same folder never
  // share a temp filename (which would break one side's rename or write half an update).
  const runToken = crypto.randomUUID();
  const written = new Set();
  for (const file of files) {
    const dest = path.join(dir, file.name);
    const tmp = `${dest}.tmp-${process.pid}-${runToken}`;
    await fs.promises.writeFile(tmp, file.contents);
    await fs.promises.rename(tmp, dest);
    written.add(file.name);
  }
  // Remove orphaned generated files (e.g. a stale daily.csv once history empties)
  // so consumers never read outdated data.
  for (const name of EXPORT_FILENAMES) {
    if (!written.has(name)) await fs.promises.rm(path.join(dir, name), { force: true });
  }
  // Record the signature only after a fully successful write, so a failed write
  // retries next tick instead of being skipped forever.
  if (options.skipUnchanged) lastAutoExport = { dir, signature };
  return { ok: true };
}

async function fetchStats(options = {}) {
  const force = Boolean(options?.force);
  // forceHistory stays independent of `force` on purpose: tool settings, account
  // sign-ins and limits actions all refresh with { force: true }, so folding the
  // history rescan into it would spawn the expensive `tokscale graph` on each one.
  // Only the manual refresh button opts in.
  const canRefreshRuntime = mode === 'local' || !isExternalAgentActive();
  if (force && deviceRuntimeHandle && canRefreshRuntime) {
    await runManualDeviceRefresh(deviceRuntimeHandle, {
      forceHistory: Boolean(options?.forceHistory),
      onLimitsError: (error) => console.log(`[limits-runtime] manual refresh failed: ${error.message}`)
    });
  }
  if (mode === 'local') {
    if (localStats) return localStats;
    return withHistoryPreview(aggregateDevices(localDevice ? [localDevice] : [], 0), localDevice ? [localDevice] : []);
  }
  if (settings.hubMode === 'host' && embeddedHub) {
    return injectLocalDeviceStatus(embeddedHub.hub.getStats());
  }
  const { url: hubUrl, secret } = effectiveHubConfig();
  if (!hubUrl) return withHistoryPreview(aggregateDevices([], 0), []);
  const url = `${hubUrl.replace(/\/$/, '')}/api/stats`;
  const response = await fetch(url, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  if (!response.ok) throw new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
  latestHubStats = await response.json();
  return injectLocalDeviceStatus(composeLocalSyncStats(latestHubStats, lastCollectedDevice));
}

function managedPricingSidecarPath() {
  return path.join(app.getPath('userData'), 'tokscale-managed-pricing.json');
}

function regenerateTokscalePricing() {
  try {
    applyCustomPricing(settings.customModelPricing || [], {
      pricingPath: customPricingPath(),
      sidecarPath: managedPricingSidecarPath()
    });
  } catch (error) {
    console.warn(`[pricing] failed to write custom-pricing.json: ${error.message}`);
  }
}

async function refreshAfterPricingChange() {
  try {
    if (deviceRuntimeHandle && (mode === 'local' || !isExternalAgentActive())) {
      await deviceRuntimeHandle.tick('manual', {});
    }
  } catch (error) {
    console.warn(`[pricing] refresh after pricing change failed: ${error.message}`);
  }
}

function stripTokscaleMetadata(result) {
  if (!result || typeof result !== 'object') return result;
  const { metadata: _metadata, ...publicResult } = result;
  return publicResult;
}

function sendTokscalePush(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('tokscale:push', payload); } catch (_) {}
}

async function checkTokscaleNpm({ silent = false } = {}) {
  try {
    const result = await checkNpmForNewer(app.getVersion());
    if (result.metadata) tokScaleNpmMetadata = result.metadata;
    const publicResult = stripTokscaleMetadata(result);
    sendTokscalePush({ type: 'check', ...publicResult });
    return publicResult;
  } catch (error) {
    if (silent) {
      console.log(`[tokscale] npm check failed: ${error.message}`);
      return { supported: true, error: null, silent: true };
    }
    return { supported: true, error: error.message };
  }
}

async function downloadTokscaleFromNpm() {
  if (tokScaleUpdaterBusy) return { supported: true, busy: true };
  tokScaleUpdaterBusy = true;
  try {
    if (!tokScaleNpmMetadata) {
      const checked = await checkNpmForNewer(app.getVersion());
      if (!checked.supported) return { supported: false };
      tokScaleNpmMetadata = checked.metadata;
    }
    const result = await downloadFromNpm(tokScaleNpmMetadata);
    const publicResult = stripTokscaleMetadata(result);
    sendTokscalePush({ type: 'download', ...publicResult });
    return publicResult;
  } catch (error) {
    return { supported: true, error: error.message };
  } finally {
    tokScaleUpdaterBusy = false;
  }
}

let appUpdateCheckInFlight = false;
let appUpdateCheckPromise = null;
let appUpdateLastError = null;
let appUpdateBackgroundTimer = null;
let appUpdateNativeBusy = false;
let appUpdateNativeConfigured = false;
let appUpdateNativeState = {
  phase: 'idle',
  version: null,
  progress: null,
  error: null
};

function latestFromUpdaterInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const version = semver.valid(info.version);
  if (!version) return null;
  return {
    version,
    tag: `v${version}`,
    name: (typeof info.releaseName === 'string' && info.releaseName.trim()) ? info.releaseName : `v${version}`,
    htmlUrl: `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`,
    publishedAt: typeof info.releaseDate === 'string' ? info.releaseDate : ''
  };
}

function rememberLatestAppUpdate(latest, checkedAt = new Date().toISOString()) {
  if (!latest) return null;
  const merged = mergeLatestReleaseMetadata(settings?.appUpdate?.lastKnownLatest, latest);
  settings.appUpdate = {
    ...(settings.appUpdate || {}),
    lastCheckedAt: checkedAt,
    lastKnownLatest: merged
  };
  saveSettings();
  return merged;
}

function setNativeAppUpdateState(patch = {}) {
  appUpdateNativeState = { ...appUpdateNativeState, ...patch };
  sendAppUpdatePush();
}

function configureNativeAppUpdater() {
  if (appUpdateNativeConfigured) return;
  appUpdateNativeConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console;
  autoUpdater.on('checking-for-update', () => {
    setNativeAppUpdateState({ phase: 'checking', progress: null, error: null });
  });
  autoUpdater.on('update-available', (info) => {
    const latest = rememberLatestAppUpdate(latestFromUpdaterInfo(info));
    setNativeAppUpdateState({ phase: 'available', version: latest?.version || info?.version || null, progress: null, error: null });
  });
  autoUpdater.on('update-not-available', (info) => {
    appUpdateNativeBusy = false;
    const latest = rememberLatestAppUpdate(latestFromUpdaterInfo(info));
    setNativeAppUpdateState({ phase: 'idle', version: latest?.version || null, progress: null, error: null });
  });
  autoUpdater.on('download-progress', (progress) => {
    setNativeAppUpdateState({
      phase: 'downloading',
      progress: Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : null,
      error: null
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    appUpdateNativeBusy = false;
    const latest = latestFromUpdaterInfo(info);
    setNativeAppUpdateState({ phase: 'downloaded', version: latest?.version || info?.version || appUpdateNativeState.version || null, progress: 100, error: null });
  });
  autoUpdater.on('error', (error) => {
    appUpdateNativeBusy = false;
    setNativeAppUpdateState({ phase: 'error', progress: null, error: error?.message || String(error || 'Update failed') });
  });
}

function deriveAppUpdateState() {
  const block = settings?.appUpdate || {};
  const currentVersion = app.getVersion();
  const latest = block.lastKnownLatest || null;
  const dismissedVersion = block.dismissedVersion || null;
  const installSupport = appUpdateInstallSupport({ isPackaged: app.isPackaged, platform: process.platform, env: process.env });
  const availability = deriveAppUpdateAvailability({
    currentVersion,
    latest,
    dismissedVersion,
    phase: appUpdateNativeState.phase,
    downloadedVersion: appUpdateNativeState.version
  });
  return {
    currentVersion,
    latest,
    hasUpdate: availability.hasUpdate,
    showUpdateNotice: availability.showUpdateNotice,
    dismissedVersion,
    lastCheckedAt: block.lastCheckedAt || null,
    checking: appUpdateCheckInFlight,
    lastError: appUpdateLastError,
    installSupported: installSupport.supported,
    installSupportReason: installSupport.reason,
    installPhase: appUpdateNativeState.phase,
    installProgress: appUpdateNativeState.progress,
    installVersion: appUpdateNativeState.version,
    installError: appUpdateNativeState.error,
    downloaded: availability.downloaded,
    installBusy: appUpdateNativeBusy || appUpdateNativeState.phase === 'checking' || appUpdateNativeState.phase === 'downloading'
  };
}

function restoreDismissedAppUpdate(version) {
  const block = settings?.appUpdate || {};
  if (!version || block.dismissedVersion !== version) return false;
  settings.appUpdate = {
    ...block,
    dismissedVersion: null
  };
  saveSettings();
  return true;
}

function sendAppUpdatePush() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('appUpdate:push', deriveAppUpdateState());
}

async function runAppUpdateCheck({ force = false } = {}) {
  if (appUpdateCheckPromise) {
    if (force) sendAppUpdatePush();
    const activeResult = await appUpdateCheckPromise;
    if (force) {
      if (activeResult?.ok) {
        if (activeResult.newer) restoreDismissedAppUpdate(activeResult.latest?.version);
        appUpdateLastError = null;
      } else {
        appUpdateLastError = activeResult?.error || 'Update check failed';
      }
      sendAppUpdatePush();
    }
    return deriveAppUpdateState();
  }
  const block = settings?.appUpdate || {};
  if (shouldSkipAppUpdateCheck({
    force,
    lastCheckedAt: block.lastCheckedAt,
    latest: block.lastKnownLatest,
    dismissedVersion: block.dismissedVersion,
    currentVersion: app.getVersion()
  })) {
    return deriveAppUpdateState();
  }
  const checkTask = (async () => {
    appUpdateCheckInFlight = true;
    appUpdateLastError = null;
    if (force) sendAppUpdatePush();
    let result;
    try {
      result = await checkLatestRelease(app.getVersion());
      if (result.ok) {
        rememberLatestAppUpdate(result.latest, result.checkedAt);
        if (force && result.newer) restoreDismissedAppUpdate(result.latest?.version);
        appUpdateLastError = null;
      } else {
        appUpdateLastError = force ? (result.error || 'Update check failed') : null;
        if (!force) console.warn('App update check failed:', result.error);
      }
    } catch (error) {
      const message = error.message || String(error);
      appUpdateLastError = force ? message : null;
      if (!force) console.warn('App update check threw:', error);
      return { ok: false, newer: false, latest: null, error: message };
    } finally {
      appUpdateCheckInFlight = false;
      sendAppUpdatePush();
    }
    return result;
  })();
  appUpdateCheckPromise = checkTask;
  try {
    await checkTask;
  } finally {
    if (appUpdateCheckPromise === checkTask) appUpdateCheckPromise = null;
  }
  return deriveAppUpdateState();
}

function maybeRunBackgroundUpdateCheck() {
  runAppUpdateCheck({ force: false }).catch(() => {});
}

function startAppUpdateBackgroundChecks() {
  if (appUpdateBackgroundTimer) return;
  appUpdateBackgroundTimer = setInterval(maybeRunBackgroundUpdateCheck, 60 * 60 * 1000);
  appUpdateBackgroundTimer.unref?.();
}

function dismissAppUpdateVersion(version) {
  if (typeof version !== 'string' || !version) return deriveAppUpdateState();
  settings.appUpdate = {
    ...(settings.appUpdate || {}),
    dismissedVersion: version
  };
  saveSettings();
  sendAppUpdatePush();
  return deriveAppUpdateState();
}

async function downloadAndPrepareAppUpdate() {
  const support = appUpdateInstallSupport({ isPackaged: app.isPackaged, platform: process.platform, env: process.env });
  if (!support.supported) {
    setNativeAppUpdateState({ phase: 'error', error: support.reason || 'unsupported-platform', progress: null });
    return deriveAppUpdateState();
  }
  if (appUpdateNativeBusy) return deriveAppUpdateState();
  const latest = settings?.appUpdate?.lastKnownLatest || null;
  if (downloadedAppUpdateMatchesLatest({
    phase: appUpdateNativeState.phase,
    downloadedVersion: appUpdateNativeState.version,
    latest
  })) return deriveAppUpdateState();
  restoreDismissedAppUpdate(latest?.version);
  configureNativeAppUpdater();
  appUpdateNativeBusy = true;
  setNativeAppUpdateState({ phase: 'checking', progress: null, error: null });
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo || null;
    const version = semver.valid(info?.version) || null;
    if (!version || !semver.gt(version, app.getVersion())) {
      appUpdateNativeBusy = false;
      setNativeAppUpdateState({ phase: 'idle', version, progress: null, error: null });
      return deriveAppUpdateState();
    }
    setNativeAppUpdateState({ phase: 'downloading', version, progress: 0, error: null });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    appUpdateNativeBusy = false;
    setNativeAppUpdateState({ phase: 'error', progress: null, error: error?.message || String(error) });
  }
  return deriveAppUpdateState();
}

function installDownloadedAppUpdate() {
  const latest = settings?.appUpdate?.lastKnownLatest || null;
  if (!downloadedAppUpdateMatchesLatest({
    phase: appUpdateNativeState.phase,
    downloadedVersion: appUpdateNativeState.version,
    latest
  })) return deriveAppUpdateState();
  quitRequested = true;
  autoUpdater.quitAndInstall(false, true);
  return deriveAppUpdateState();
}

function isAllowedExternalUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch (_) { return false; }
  if (parsed.protocol !== 'https:') return false;
  const enterpriseHost = settings?.copilotEnterpriseHost || process.env.COPILOT_ENTERPRISE_HOST || process.env.GITHUB_ENTERPRISE_HOST || '';
  if (isAllowedVerificationUrl(value, enterpriseHost)) return true;
  if (isAllowedCodexLoginUrl(value)) return true;
  if (parsed.hostname === 'github.com' && parsed.pathname.startsWith('/junhoyeo/tokscale')) return true;
  if (parsed.hostname === 'www.npmjs.com' && parsed.pathname.startsWith('/package/@tokscale/')) return true;
  if (parsed.hostname === 'github.com' && parsed.pathname.startsWith('/Javis603/token-monitor')) return true;
  if ((parsed.hostname === 'cursor.com' || parsed.hostname === 'www.cursor.com') && parsed.pathname.startsWith('/settings')) return true;
  if (parsed.hostname === 'opencode.ai' || parsed.hostname === 'www.opencode.ai') return true;
  if (parsed.hostname === 'platform.deepseek.com' && parsed.pathname.startsWith('/api_keys')) return true;
  if (parsed.hostname === 'platform.minimaxi.com') return true;
  if (parsed.hostname === 'platform.minimax.io') return true;
  if (parsed.hostname === 'z.ai' || parsed.hostname === 'www.z.ai') return true;
  if (parsed.hostname === 'bigmodel.cn' || parsed.hostname === 'www.bigmodel.cn') return true;
  if (parsed.hostname === 'www.volcengine.com' || parsed.hostname === 'console.volcengine.com') return true;
  if (parsed.hostname === 'qoder.com' || parsed.hostname === 'www.qoder.com' || parsed.hostname === 'qoder.com.cn' || parsed.hostname === 'www.qoder.com.cn') return true;
  if ((parsed.hostname === 'ollama.com' || parsed.hostname === 'www.ollama.com') && (parsed.pathname === '/settings' || parsed.pathname === '/signin')) return true;
  if ((parsed.hostname === 'kimi.com' || parsed.hostname === 'www.kimi.com') && parsed.pathname.startsWith('/code')) return true;
  if (STATUS_PAGE_HOSTS.has(parsed.hostname) && (parsed.pathname === '' || parsed.pathname === '/')) return true;
  return false;
}

function revealWindow(target = mainWindow, options = {}) {
  if (!target || target.isDestroyed() || target.isVisible()) return;
  const inactive = options.inactive === true || (target === mainWindow && floatingBubbleState.collapsed);
  if (inactive && typeof target.showInactive === 'function') {
    target.showInactive();
    return;
  }
  target.show();
}

function loadWindowFile(target, options = {}) {
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    if (settings?.trayMode) return; // stay hidden until tray click
    revealWindow(target, { inactive: options.inactive === true });
  };
  const waitForContent = options.waitForContent === true;
  const onContentReady = (event) => {
    if (event.sender === target.webContents) reveal();
  };
  const fallbackTimer = setTimeout(reveal, 2500);
  const cleanup = () => {
    clearTimeout(fallbackTimer);
    ipcMain.removeListener('window:contentReady', onContentReady);
  };
  target.once('show', cleanup);
  target.once('closed', cleanup);
  if (waitForContent) {
    // A recreated window paints its static "0" defaults before the renderer's
    // async stats fetch resolves; revealing on load would flash empty content.
    // Wait until the renderer reports it has rendered real data instead.
    ipcMain.on('window:contentReady', onContentReady);
    target.webContents.once('did-finish-load', () => applyZoomFactor(target));
  } else {
    target.once('ready-to-show', reveal);
    target.webContents.once('did-finish-load', () => {
      applyZoomFactor(target);
      reveal();
    });
  }
  target.webContents.once('did-fail-load', (_event, code, description) => {
    console.log(`[window] renderer load failed: ${code} ${description}`);
    reveal();
  });
  const filePath = path.join(__dirname, 'renderer', 'index.html');
  const load = options.query ? target.loadFile(filePath, { query: options.query }) : target.loadFile(filePath);
  load.catch((error) => {
    console.log(`[window] renderer load failed: ${error.message}`);
    reveal();
  });
}

function createWindow(boundsOverride, options = {}) {
  ensureSettingsLoaded();
  const collapsedFloatingBubble = options.collapsedFloatingBubble === true;
  const glass = nativeBlurEnabled();
  const bounds = boundsOverride || restoredBounds() || DEFAULT_WINDOW;
  const collapsedSizeLimits = {
    minWidth: bounds.width,
    minHeight: bounds.height,
    maxWidth: bounds.width,
    maxHeight: bounds.height
  };
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(typeof bounds.x === 'number' ? { x: bounds.x, y: bounds.y } : {}),
    ...(collapsedFloatingBubble ? collapsedSizeLimits : WINDOW_LIMITS),
    frame: false,
    transparent: !(process.platform === 'win32' && glass),
    resizable: !collapsedFloatingBubble,
    show: false,
    backgroundColor: '#00000000',
    icon: APP_ICON_PATH,
    skipTaskbar: collapsedFloatingBubble || Boolean(settings?.trayMode),
    ...(collapsedFloatingBubble ? { fullscreenable: false, maximizable: false, minimizable: false } : {}),
    ...floatingBubbleWindowChrome(process.platform, collapsedFloatingBubble),
    ...(process.platform === 'darwin' && glass ? { vibrancy: 'hud', visualEffectState: 'active' } : {}),
    ...(process.platform === 'win32' && glass ? { backgroundMaterial: 'acrylic' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;
  mainWindowChrome = { collapsedFloatingBubble };
  applyWindowsChrome(win, { round: true });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
  });
  applyWindowSettings();
  applyNativeMaterial();
  keepNativeBlurActive();
  win.on('focus', () => {
    stopFloatingBubbleAutoCollapseTimer();
    keepNativeBlurActive();
  });
  win.on('blur', () => {
    keepNativeBlurActive();
    if (settings?.trayMode && !suppressNextBlurHide && !quitRequested) hidePopover();
    else if (!quitRequested) scheduleFloatingBubbleAutoCollapse();
  });
  win.on('resized', persistBoundsSoon);
  win.on('moved', persistBoundsSoon);
  win.on('close', (event) => {
    if (quitRequested) return;
    const action = mainWindowCloseAction(settings, { platform: process.platform });
    if (action === 'hidePopover') {
      event.preventDefault();
      hidePopover();
    } else if (action === 'hideWindow') {
      event.preventDefault();
      win.hide();
      applyMacActivationPolicy({ mainWindowVisible: false });
    }
  });
  win.webContents.on('before-input-event', handleZoomShortcut);
  win.webContents.once('did-finish-load', sendFloatingBubbleState);
  loadWindowFile(win, {
    waitForContent: options.waitForContent === true,
    inactive: options.inactive === true,
    query: {
      ...floatingBubbleInitialRendererQuery(floatingBubbleState, {
        collapsedWindow: collapsedFloatingBubble,
        suppressInitialNumberAnimation: options.suppressInitialNumberAnimation === true,
        viewState: rendererViewState
      }),
      ...(settings?.systemGlass === false ? { systemGlassDisabled: '1' } : {})
    }
  });
}

function handleZoomShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  const key = input.key;
  if (key === 'Escape' && !input.control && !input.meta && !input.alt && !input.shift && canUseFloatingBubble(settings)) {
    event.preventDefault();
    maybeCollapseFloatingBubble(mainWindow.getBounds());
    return;
  }
  if (!(input.control || input.meta)) return;
  if (key === '=' || key === '+') { event.preventDefault(); adjustZoom(ZOOM_LIMITS.step); }
  else if (key === '-' || key === '_') { event.preventDefault(); adjustZoom(-ZOOM_LIMITS.step); }
  else if (key === '0') { event.preventDefault(); setZoomFactor(1); }
}

function replaceMainWindow(bounds, options = {}) {
  const old = mainWindow;
  const wasFocused = old && !old.isDestroyed() ? old.isFocused() : false;
  if (old && !old.isDestroyed()) old.removeAllListeners('close');
  // Build the new window first so total window count never drops to 0
  // (otherwise window-all-closed fires and quits the app on Windows).
  createWindow(bounds, {
    collapsedFloatingBubble: options.collapsedFloatingBubble === true,
    suppressInitialNumberAnimation: options.suppressInitialNumberAnimation === true,
    waitForContent: options.waitForContent === true,
    inactive: options.inactive === true
  });
  const next = mainWindow;
  next.once('show', () => {
    if (old && !old.isDestroyed()) old.destroy();
    if ((options.focus === true || (options.focus !== false && wasFocused)) && !next.isDestroyed()) {
      next.focus();
    }
  });
}

function discardFailedDashboardWindow(win, reason) {
  if (!win || win !== dashboardWindow || win.isDestroyed()) return;
  console.log(`[dashboard] ${reason}`);
  win.destroy();
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    // Reload so a reopened window always picks up the latest renderer + fresh history,
    // instead of showing whatever was loaded when it first opened.
    dashboardWindow.hide();
    dashboardWindow.webContents.reload();
    return dashboardWindow;
  }
  const glass = nativeBlurEnabled();
  const win = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 560,
    minHeight: 420,
    frame: false,
    transparent: !(process.platform === 'win32' && glass),
    show: false,
    backgroundColor: '#00000000',
    icon: APP_ICON_PATH,
    skipTaskbar: false,
    ...(process.platform === 'darwin' && glass ? { vibrancy: 'hud', visualEffectState: 'active' } : {}),
    ...(process.platform === 'win32' && glass ? { backgroundMaterial: 'acrylic' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  dashboardWindow = win;
  applyWindowsChrome(win, { round: true });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
  });
  // Only dashboard:ready may reveal a healthy window. Slow hub history must not
  // race a wall-clock fallback and expose the unprepared heatmap. Actual load or
  // renderer failures discard the hidden window so the next open starts cleanly.
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // ERR_ABORTED is expected during reloads.
    discardFailedDashboardWindow(win, `load failed: ${errorDescription}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    discardFailedDashboardWindow(win, `renderer stopped: ${details.reason}`);
  });
  win.on('unresponsive', () => {
    if (!win.isVisible()) discardFailedDashboardWindow(win, 'renderer became unresponsive while opening');
  });
  win.on('closed', () => { dashboardWindow = null; });
  win.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'))
    .catch((error) => discardFailedDashboardWindow(win, `load failed: ${error.message}`));
  return win;
}

async function getDashboardHistory() {
  if (settings?.historyEnabled === false) return aggregateHistory([]);
  if (mode === 'local') {
    // The local collector keeps localDevice.history current (watch + interval
    // ticks, with carry-forward), so read it directly — exactly as the hub
    // branch reads /api/history. Forcing a full collection tick here made the
    // fetch take seconds; on a quick close/reopen the response outlived the
    // renderer and was dropped, stranding the dashboard on its empty state.
    return aggregateHistory(localDevice ? [localDevice] : []);
  }
  if (settings.hubMode === 'host' && embeddedHub) {
    // Host mode reads its own hub store in-process, so the dashboard history
    // doesn't depend on a loopback fetch the local firewall/proxy might block.
    return embeddedHub.hub.getHistory();
  }
  const { url: hubUrl, secret } = effectiveHubConfig();
  if (!hubUrl) return aggregateHistory([]);
  const url = `${hubUrl.replace(/\/$/, '')}/api/history`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

let cursorStatusCache = { value: null, at: 0 };
let opencodeStatusCache = { value: null, at: 0 };
const CURSOR_STATUS_TTL_MS = 30 * 1000;

function normalizeManualCookie(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (s.toLowerCase().startsWith('cookie:')) s = s.slice(7).trim();
  // If they pasted the full cookie header, extract the WorkosCursorSessionToken= value.
  const match = s.match(/WorkosCursorSessionToken=([^;\s]+)/);
  if (match) return match[1];
  // Otherwise assume the whole string is the raw token value.
  if (/\s/.test(s)) return '';
  return s;
}

function rebuildWindow() {
  if (!mainWindow) return;
  const bounds = floatingBubbleState.collapsed && floatingBubbleState.expandedBounds
    ? floatingBubbleState.expandedBounds
    : mainWindow.getBounds();
  const wasFocused = mainWindow.isFocused();
  const old = mainWindow;
  floatingBubbleState.collapsed = false;
  floatingBubbleState.side = null;
  floatingBubbleState.collapsedBounds = null;
  floatingBubbleState.expandedBounds = null;
  floatingBubbleState.suppressNextCollapse = false;
  stopFloatingBubbleAutoCollapseTimer();
  old.removeAllListeners('close');
  // Build the new window first so total window count never drops to 0
  // (otherwise window-all-closed fires and quits the app on Windows).
  createWindow(bounds);
  mainWindow.once('show', () => {
    if (!old.isDestroyed()) old.destroy();
    if (wasFocused && !mainWindow.isDestroyed()) mainWindow.focus();
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(APP_ICON_PATH);
  ensureSettingsLoaded();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_HEADER]
      }
    });
  });
  applyMacActivationPolicy();
  createWindow();
  syncLoginItemSettingFromOs();
  configureWindowToggleShortcut();
  cleanupStaleStaging().catch((error) => console.log(`[tokscale] staging cleanup failed: ${error.message}`));
  ensureTray();
  if (settings.trayMode) enterTrayMode();
  regenerateTokscalePricing();
  startMode();
  if (settings.discordRpcEnabled) startDiscordRpc();
  rateCache = readRateCache();
  applyEffectiveRates();                 // use cache/defaults immediately, avoid first-paint gap
  refreshExchangeRates();                // non-blocking: only fetches when stale
  rateRefreshTimer = setInterval(() => { refreshExchangeRates(); }, 6 * 60 * 60 * 1000);
  setTimeout(() => { checkTokscaleNpm({ silent: true }); }, 2000);
  ipcMain.handle('settings:get', () => settingsForRenderer());
  ipcMain.handle('sessionUsageArchive:clear', () => {
    if (isExternalAgentActive()) return { ok: false, error: 'agentActive' };
    try {
      clearSessionUsageArchive();
      clearDailyHistoryArchive();
      sessionUsageArchive = normalizeSessionUsageArchive({});
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      startMode();
      pushSettingsToRenderer();
    }
  });
  ipcMain.handle('pricing:lookup', async (_event, modelId) => {
    try {
      return { ok: true, result: await lookupModelPricing(modelId) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('settings:update', (_event, patch) => {
    const previousSettingsState = settings;
    const previousRuntimeSettings = JSON.parse(JSON.stringify(settings));
    const previousNativeMaterial = nativeBlurEnabled();
    const previousClients = settings.clients;
    const previousDiscordRpcEnabled = settings.discordRpcEnabled;
    const previousShowTrayIcon = settings.showTrayIcon;
    const previousTrayMode = settings.trayMode;
    const previousTrayContent = settings.trayContent;
    const previousShowTrayProviderBadge = settings.showTrayProviderBadge;
    const previousCurrency = settings.currency;
    const previousStartAtLogin = settings.startAtLogin;
    const previousCustomModelPricing = JSON.stringify(settings.customModelPricing || []);
    const normalizedCurrency = patch.currency !== undefined ? normalizeCurrency(patch.currency, settings.currency) : normalizeCurrency(settings.currency);
    const normalizedPatch = { ...patch, currency: normalizedCurrency };
    delete normalizedPatch.codexManagedAccounts;
    delete normalizedPatch.mimoManagedAccounts;
    delete normalizedPatch.customModelPricing;
    if (patch.clients !== undefined) normalizedPatch.clients = clientsCsvForSetting(patch.clients, '');
    if (patch.deepseekApiKey !== undefined) normalizedPatch.deepseekApiKey = normalizeDeepSeekApiKey(patch.deepseekApiKey);
    if (patch.minimaxApiKey !== undefined) normalizedPatch.minimaxApiKey = normalizeMinimaxApiKey(patch.minimaxApiKey);
    if (patch.copilotApiToken !== undefined) normalizedPatch.copilotApiToken = normalizeCopilotApiToken(patch.copilotApiToken);
    if (patch.copilotEnterpriseHost !== undefined) normalizedPatch.copilotEnterpriseHost = normalizeCopilotEnterpriseHost(patch.copilotEnterpriseHost);
    if (patch.zaiApiKey !== undefined) normalizedPatch.zaiApiKey = normalizeZaiApiKey(patch.zaiApiKey);
    if (patch.zaiApiRegion !== undefined) normalizedPatch.zaiApiRegion = normalizeZaiApiRegion(patch.zaiApiRegion);
    if (patch.zaiTeamApiKey !== undefined) normalizedPatch.zaiTeamApiKey = normalizeZaiTeamApiKey(patch.zaiTeamApiKey);
    if (patch.zaiTeamOrganizationId !== undefined) normalizedPatch.zaiTeamOrganizationId = normalizeZaiTeamId(patch.zaiTeamOrganizationId);
    if (patch.zaiTeamProjectId !== undefined) normalizedPatch.zaiTeamProjectId = normalizeZaiTeamId(patch.zaiTeamProjectId);
    if (patch.volcengineAccessKeyId !== undefined) normalizedPatch.volcengineAccessKeyId = normalizeSecretSetting(patch.volcengineAccessKeyId);
    if (patch.volcengineSecretAccessKey !== undefined) normalizedPatch.volcengineSecretAccessKey = normalizeSecretSetting(patch.volcengineSecretAccessKey);
    if (patch.volcengineRegion !== undefined) normalizedPatch.volcengineRegion = normalizeVolcengineRegion(patch.volcengineRegion);
    if (patch.qoderCookie !== undefined) normalizedPatch.qoderCookie = normalizeQoderCookie(patch.qoderCookie);
    if (patch.qoderSite !== undefined) normalizedPatch.qoderSite = normalizeQoderSite(patch.qoderSite);
    if (patch.kimiApiKey !== undefined) normalizedPatch.kimiApiKey = normalizeKimiApiKey(patch.kimiApiKey);
    if (patch.kimiWebAccessToken !== undefined) normalizedPatch.kimiWebAccessToken = normalizeKimiWebAccessToken(patch.kimiWebAccessToken);
    if (patch.ollamaCookie !== undefined) normalizedPatch.ollamaCookie = normalizeOllamaCookie(patch.ollamaCookie);
    if (patch.collectionMode !== undefined) normalizedPatch.collectionMode = normalizeCollectionMode(patch.collectionMode, settings.collectionMode);
    if (patch.collectionIntervalMs !== undefined) normalizedPatch.collectionIntervalMs = normalizeCollectionIntervalMs(patch.collectionIntervalMs, settings.collectionIntervalMs);
    if (patch.syncUploadIntervalMs !== undefined) normalizedPatch.syncUploadIntervalMs = normalizeSyncUploadIntervalMs(patch.syncUploadIntervalMs, settings.syncUploadIntervalMs);
    if (patch.heatmapMetric !== undefined) normalizedPatch.heatmapMetric = normalizeHeatmapMetric(patch.heatmapMetric, settings.heatmapMetric);
    settings = normalizeWindowBehaviorSettings({
      ...settings,
      ...normalizedPatch,
      hubMode: patch.hubMode !== undefined ? normalizeHubMode(patch.hubMode, settings.hubMode) : settings.hubMode,
      hubHostPort: patch.hubHostPort !== undefined ? normalizeHubPort(patch.hubHostPort, settings.hubHostPort) : settings.hubHostPort,
      hubHostSecret: patch.hubHostSecret !== undefined ? String(patch.hubHostSecret) : settings.hubHostSecret,
      deviceId: (patch.deviceId !== undefined ? String(patch.deviceId).trim() : settings.deviceId) || defaultDeviceId(),
      clients: patch.clients !== undefined ? clientsCsvForSetting(patch.clients, '') : clientsCsvForSetting(settings.clients, DEFAULT_CLIENTS),
      refreshMs: Math.max(5000, Number(patch.refreshMs ?? settings.refreshMs ?? 15000)),
      glassOpacity: Math.max(0, Math.min(100, Number(patch.glassOpacity ?? settings.glassOpacity ?? 68))),
      glassBlur: Math.max(0, Math.min(100, Number(patch.glassBlur ?? settings.glassBlur ?? 32))),
      systemGlass: patch.systemGlass ?? settings.systemGlass ?? true,
      reduceMotion: motionPreferenceApi.normalize(patch.reduceMotion ?? settings.reduceMotion),
      showLiveDot: patch.showLiveDot ?? settings.showLiveDot ?? true,
      showToolIcons: patch.showToolIcons ?? settings.showToolIcons ?? true,
      titleIconOnly: parseBoolean(patch.titleIconOnly ?? settings.titleIconOnly, false),
      showCompactTotalTokens: parseBoolean(patch.showCompactTotalTokens ?? settings.showCompactTotalTokens, false),
      floatingBubbleEnabled: parseBoolean(patch.floatingBubbleEnabled ?? settings.floatingBubbleEnabled, false),
      discordRpcEnabled: patch.discordRpcEnabled ?? settings.discordRpcEnabled ?? false,
      limitsEnabled: parseBoolean(patch.limitsEnabled ?? settings.limitsEnabled, true),
      limitProviders: patch.limitProviders !== undefined ? parseLimitProviders(patch.limitProviders).join(',') : settings.limitProviders,
      limitProviderOrder: patch.limitProviderOrder !== undefined ? migrateLimitProviderOrder(patch.limitProviderOrder) : settings.limitProviderOrder,
      clientDisplayOrder: patch.clientDisplayOrder !== undefined ? migrateClientDisplayOrder(patch.clientDisplayOrder) : (settings.clientDisplayOrder || ''),
      hiddenClients: patch.hiddenClients !== undefined ? normalizeHiddenClients(patch.hiddenClients, KNOWN_CLIENT_LIST) : normalizeHiddenClients(settings.hiddenClients, KNOWN_CLIENT_LIST),
      pinnedClients: patch.pinnedClients !== undefined ? normalizePinnedClients(patch.pinnedClients, KNOWN_CLIENT_LIST) : normalizePinnedClients(settings.pinnedClients, KNOWN_CLIENT_LIST),
      viewDisplayOrder: patch.viewDisplayOrder !== undefined ? migrateViewDisplayOrder(patch.viewDisplayOrder) : (settings.viewDisplayOrder || ''),
      hiddenViews: patch.hiddenViews !== undefined ? normalizeHiddenViews(patch.hiddenViews, DEFAULT_VIEW_LIST) : normalizeHiddenViews(settings.hiddenViews, DEFAULT_VIEW_LIST),
      homeModuleOrder: patch.homeModuleOrder !== undefined ? normalizeHomeModuleOrder(patch.homeModuleOrder, DEFAULT_HOME_MODULE_LIST).join(',') : normalizeHomeModuleOrder(settings.homeModuleOrder, DEFAULT_HOME_MODULE_LIST).join(','),
      hiddenHomeModules: patch.hiddenHomeModules !== undefined ? normalizeHiddenHomeModules(patch.hiddenHomeModules, DEFAULT_HOME_MODULE_LIST) : normalizeHiddenHomeModules(settings.hiddenHomeModules, DEFAULT_HOME_MODULE_LIST),
      showHomeLimitBars: parseBoolean(patch.showHomeLimitBars ?? settings.showHomeLimitBars, false),
      showHomeLimitProviderNames: parseBoolean(patch.showHomeLimitProviderNames ?? settings.showHomeLimitProviderNames, false),
      homeLimitProviderOrder: patch.homeLimitProviderOrder !== undefined ? migrateHomeLimitProviderOrder(patch.homeLimitProviderOrder) : (settings.homeLimitProviderOrder || ''),
      hiddenHomeLimitProviders: patch.hiddenHomeLimitProviders !== undefined ? normalizeHiddenLimitProviders(patch.hiddenHomeLimitProviders) : normalizeHiddenLimitProviders(settings.hiddenHomeLimitProviders),
      homeLimitAccountCount: normalizeHomeLimitAccountCount(patch.homeLimitAccountCount ?? settings.homeLimitAccountCount),
      historyEnabled: parseBoolean(patch.historyEnabled ?? settings.historyEnabled, false),
      projectsEnabled: parseBoolean(patch.projectsEnabled ?? settings.projectsEnabled, true),
      historyIntervalMs: normalizeHistoryIntervalMs(patch.historyIntervalMs ?? settings.historyIntervalMs),
      sessionUsageArchiveEnabled: parseBoolean(patch.sessionUsageArchiveEnabled ?? settings.sessionUsageArchiveEnabled, true),
      wslScanEnabled: parseBoolean(patch.wslScanEnabled ?? settings.wslScanEnabled, true),
      collectionMode: normalizeCollectionMode(patch.collectionMode ?? settings.collectionMode),
      collectionIntervalMs: normalizeCollectionIntervalMs(patch.collectionIntervalMs ?? settings.collectionIntervalMs),
      syncUploadIntervalMs: normalizeSyncUploadIntervalMs(patch.syncUploadIntervalMs ?? settings.syncUploadIntervalMs),
      serviceProviderDisplayOrder: patch.serviceProviderDisplayOrder !== undefined ? String(patch.serviceProviderDisplayOrder || '') : (settings.serviceProviderDisplayOrder || ''),
      hiddenServiceProviders: patch.hiddenServiceProviders !== undefined ? String(patch.hiddenServiceProviders || '') : (settings.hiddenServiceProviders || ''),
      serviceStatusRefreshMs: normalizeServiceStatusRefreshMs(patch.serviceStatusRefreshMs ?? settings.serviceStatusRefreshMs),
      limitsRefreshMs: normalizeLimitsRefreshMs(patch.limitsRefreshMs ?? settings.limitsRefreshMs),
      showLimitSource: parseBoolean(patch.showLimitSource ?? settings.showLimitSource, false),
      maskLimitAccountEmails: parseBoolean(patch.maskLimitAccountEmails ?? settings.maskLimitAccountEmails, false),
      showLimitUsed: parseBoolean(patch.showLimitUsed ?? settings.showLimitUsed, false),
      zoomFactor: clampZoom(patch.zoomFactor ?? settings.zoomFactor),
      ...normalizeTrayModeSettings({
        showTrayIcon: patch.showTrayIcon ?? settings.showTrayIcon,
        trayMode: patch.trayMode ?? settings.trayMode
      }),
      trayContent: normalizeTrayContent(patch.trayContent ?? settings.trayContent),
      showTrayProviderBadge: parseBoolean(patch.showTrayProviderBadge ?? settings.showTrayProviderBadge, false),
      floatingBubbleContent: normalizeTrayContent(patch.floatingBubbleContent ?? settings.floatingBubbleContent, 'icon'),
      windowToggleShortcut: normalizeWindowToggleShortcut(patch.windowToggleShortcut ?? settings.windowToggleShortcut),
      currency: normalizedCurrency,
      currencyRates: patch.currencyRates !== undefined ? normalizeCurrencyOverrides(patch.currencyRates) : normalizeCurrencyOverrides(settings.currencyRates),
      language: patch.language !== undefined ? normalizeLanguageSetting(patch.language, settings.language) : normalizeLanguageSetting(settings.language),
      startAtLogin: loginItemEnabledHere() ? parseBoolean(patch.startAtLogin ?? settings.startAtLogin, false) : false,
      deepseekApiKey: patch.deepseekApiKey !== undefined ? normalizeDeepSeekApiKey(patch.deepseekApiKey) : (settings.deepseekApiKey || ''),
      minimaxApiKey: patch.minimaxApiKey !== undefined ? normalizeMinimaxApiKey(patch.minimaxApiKey) : (settings.minimaxApiKey || ''),
      copilotApiToken: patch.copilotApiToken !== undefined ? normalizeCopilotApiToken(patch.copilotApiToken) : (settings.copilotApiToken || ''),
      copilotEnterpriseHost: patch.copilotEnterpriseHost !== undefined ? normalizeCopilotEnterpriseHost(patch.copilotEnterpriseHost) : (settings.copilotEnterpriseHost || ''),
      zaiApiKey: patch.zaiApiKey !== undefined ? normalizeZaiApiKey(patch.zaiApiKey) : (settings.zaiApiKey || ''),
      zaiApiRegion: patch.zaiApiRegion !== undefined ? normalizeZaiApiRegion(patch.zaiApiRegion) : normalizeZaiApiRegion(settings.zaiApiRegion || 'global'),
      zaiTeamApiKey: patch.zaiTeamApiKey !== undefined ? normalizeZaiTeamApiKey(patch.zaiTeamApiKey) : (settings.zaiTeamApiKey || ''),
      zaiTeamOrganizationId: patch.zaiTeamOrganizationId !== undefined ? normalizeZaiTeamId(patch.zaiTeamOrganizationId) : (settings.zaiTeamOrganizationId || ''),
      zaiTeamProjectId: patch.zaiTeamProjectId !== undefined ? normalizeZaiTeamId(patch.zaiTeamProjectId) : (settings.zaiTeamProjectId || ''),
      volcengineAccessKeyId: patch.volcengineAccessKeyId !== undefined ? normalizeSecretSetting(patch.volcengineAccessKeyId) : (settings.volcengineAccessKeyId || ''),
      volcengineSecretAccessKey: patch.volcengineSecretAccessKey !== undefined ? normalizeSecretSetting(patch.volcengineSecretAccessKey) : (settings.volcengineSecretAccessKey || ''),
      volcengineRegion: patch.volcengineRegion !== undefined ? normalizeVolcengineRegion(patch.volcengineRegion) : (settings.volcengineRegion || ''),
      qoderCookie: patch.qoderCookie !== undefined ? normalizeQoderCookie(patch.qoderCookie) : (settings.qoderCookie || ''),
      qoderSite: patch.qoderSite !== undefined ? normalizeQoderSite(patch.qoderSite) : normalizeQoderSite(settings.qoderSite || 'global'),
      ollamaCookie: patch.ollamaCookie !== undefined ? normalizeOllamaCookie(patch.ollamaCookie) : (settings.ollamaCookie || ''),
      customModelPricing: patch.customModelPricing !== undefined
        ? normalizeCustomPricingSetting(patch.customModelPricing)
        : normalizeCustomPricingSetting(settings.customModelPricing)
    }, normalizedPatch);
    settings.archivedClientUsage = normalizeArchivedClientUsage(settings.archivedClientUsage);
    if (settings.clients !== previousClients) updateArchivedClientUsage(previousClients, settings.clients);
    delete settings.edgeDrawerEnabled;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      settings = previousSettingsState;
      throw error;
    }
    if (JSON.stringify(settings.customModelPricing || []) !== previousCustomModelPricing) {
      regenerateTokscalePricing();
      refreshAfterPricingChange();
    }
    configureWindowToggleShortcut();
    if (settings.startAtLogin !== previousStartAtLogin) {
      settings.startAtLogin = applyLoginItem(settings.startAtLogin);
      saveSettings({ throwOnError: true });
    }
    if (patch.zoomFactor !== undefined) applyZoomFactor();
    if (settings.discordRpcEnabled && !previousDiscordRpcEnabled) {
      startDiscordRpc();
      if (latestStats) updateDiscordRpc(latestStats, settings.currency);
    }
    else if (!settings.discordRpcEnabled && previousDiscordRpcEnabled) stopDiscordRpc();
    else if (settings.discordRpcEnabled && settings.currency !== previousCurrency && latestStats) updateDiscordRpc(latestStats, settings.currency);
    applyWindowSettings();
    syncFloatingBubbleAvailability();
    const nextNativeMaterial = nativeBlurEnabled();
    if (process.platform === 'win32' && previousNativeMaterial !== nextNativeMaterial) {
      rebuildWindow();
    } else {
      applyNativeMaterial();
    }
    const runtimeChange = classifySettingsChange(previousRuntimeSettings, settings);
    if (runtimeChange.modeStructural) {
      for (const scope of runtimeChange.limitScopes) {
        rememberPendingLimitInvalidation(scope, 'settings-change');
      }
      startMode();
    } else if (runtimeChange.usageStructural || runtimeChange.sinkStructural) {
      for (const scope of runtimeChange.limitScopes) {
        rememberPendingLimitInvalidation(scope, 'settings-change');
      }
      restartDeviceRuntimeForMode();
    } else {
      if (runtimeChange.limitsReconfigure && deviceRuntimeHandle) {
        deviceRuntimeHandle.reconfigureLimits(electronLimitsConfig());
      }
      for (const scope of runtimeChange.limitScopes) {
        void queueLimitInvalidation(scope, 'settings-change').catch((error) => {
          console.log(`[limits-runtime] settings refresh failed: ${error.message}`);
        });
      }
    }
    if (settings.showTrayIcon !== previousShowTrayIcon) {
      if (settings.showTrayIcon) ensureTray();
      else destroyTray();
    }
    if (settings.trayMode !== previousTrayMode) {
      if (settings.trayMode) enterTrayMode();
      else exitTrayMode();
    } else if (
      settings.trayContent !== previousTrayContent ||
      settings.showTrayProviderBadge !== previousShowTrayProviderBadge ||
      settings.currency !== previousCurrency
    ) {
      updateTrayDisplay();
    }
    if (patch.currency !== undefined || patch.currencyRates !== undefined) {
      applyEffectiveRates();               // sync: settingsForRenderer() below sees fresh effective map
      updateTrayDisplay();
      if (settings.discordRpcEnabled && latestStats) updateDiscordRpc(latestStats, settings.currency);
      refreshExchangeRates();              // async: fetch if stale, then re-push
    }
    return settingsForRenderer();
  });
  ipcMain.handle('appearance:preview', (_event, patch) => {
    applyNativeMaterial({ ...settings, ...patch });
    if (patch && patch.zoomFactor !== undefined && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setZoomFactor(clampZoom(patch.zoomFactor));
    }
    return true;
  });
  ipcMain.on('window:viewState', (_event, patch) => {
    updateRendererViewState(patch);
  });
  ipcMain.handle('floatingBubble:expand', () => expandFloatingBubble());
  ipcMain.handle('floatingBubble:peek', () => expandFloatingBubble({ focus: false }));
  ipcMain.handle('floatingBubble:collapseIfIdle', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (floatingBubbleState.collapsed || !canUseFloatingBubble(settings)) return false;
    if (mainWindow.isFocused()) return false; // promoted to a focused window; let blur handle collapse
    const bounds = mainWindow.getBounds();
    if (typeof screen.getCursorScreenPoint === 'function') {
      const pt = screen.getCursorScreenPoint();
      const inside = pt.x >= bounds.x && pt.x < bounds.x + bounds.width &&
        pt.y >= bounds.y && pt.y < bounds.y + bounds.height;
      if (inside) return false; // cursor returned during the grace window
    }
    // A hover peek never receives focus and never blurs, so a stale suppress flag
    // must not be allowed to wedge it open.
    floatingBubbleState.suppressNextCollapse = false;
    return maybeCollapseFloatingBubble(bounds);
  });
  ipcMain.handle('floatingBubble:setCollapsedSize', (_event, size) => {
    if (!size || !canUseFloatingBubble(settings)) return false;
    const width = Math.round(Number(size.width));
    const height = Math.round(Number(size.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
    floatingBubbleState.contentSize = { width, height }; // used by the next collapse
    if (!floatingBubbleState.collapsed || !mainWindow || mainWindow.isDestroyed()) return true;
    const current = mainWindow.getBounds();
    if (current.width === width && current.height === height) return true;
    const display = displayForBounds(current);
    if (!display) return true;
    const collapsedArea = collapsedAreaForDisplay(display);
    // Keep the docked edge fixed while resizing: collapsedFloatingBubbleBounds re-clamps the
    // current x/y against the new size (right-docked snaps flush to the edge).
    const target = collapsedFloatingBubbleBounds(current, collapsedArea, {
      margin: collapsedMargin(),
      collapsedBounds: current,
      handleWidth: width,
      handleHeight: height
    });
    if (!target) return true;
    applyCollapsedFloatingBubbleLimits(target);
    mainWindow.setBounds(target);
    floatingBubbleState.collapsedBounds = target;
    settings.floatingBubbleBounds = target;
    saveSettings();
    return true;
  });
  ipcMain.handle('floatingBubble:move', (_event, delta) => {
    if (!mainWindow || mainWindow.isDestroyed() || !floatingBubbleState.collapsed) return false;
    const current = mainWindow.getBounds();
    const hasDragOffset = delta && (
      Object.hasOwn(delta, 'offsetX') ||
      Object.hasOwn(delta, 'offsetY') ||
      Object.hasOwn(delta, 'offsetRatioX') ||
      Object.hasOwn(delta, 'offsetRatioY')
    );
    const cursor = hasDragOffset && typeof screen.getCursorScreenPoint === 'function'
      ? screen.getCursorScreenPoint()
      : null;
    const display = (cursor && displayForPoint(cursor)) || displayForBounds(current);
    if (!display) return false;
    const collapsedArea = collapsedAreaForDisplay(display);
    const margin = collapsedMargin();
    const target = cursor
      ? dragFloatingBubbleBounds(current, collapsedArea, cursor, delta, margin)
      : moveFloatingBubbleBounds(current, collapsedArea, delta, margin);
    if (!target) return false;
    floatingBubbleState.collapsedBounds = target;
    floatingBubbleState.side = floatingBubbleSide(target, collapsedArea);
    if (target.width === current.width && target.height === current.height && typeof mainWindow.setPosition === 'function') {
      mainWindow.setPosition(target.x, target.y, false);
    } else {
      mainWindow.setBounds(target);
    }
    persistBoundsSoon();
    sendFloatingBubbleState();
    return true;
  });
  ipcMain.handle('tray:setIcons', (_event, icons) => {
    if (!icons || typeof icons !== 'object') return false;
    for (const [id, dataUrl] of Object.entries(icons)) {
      if (dataUrl === null) {
        delete providerTrayIcons[id];
        continue;
      }
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) continue;
      const img = nativeImage.createFromDataURL(dataUrl);
      if (img.isEmpty()) continue;
      // Resize by height only; aspect ratio is preserved, so wide bar-style
      // icons keep their width while square provider icons stay 20x20.
      const sized = img.resize({ height: 20, quality: 'best' });
      if (shouldUseTemplateTrayIcon(id, process.platform, settings?.showTrayProviderBadge)) sized.setTemplateImage(true);
      providerTrayIcons[id] = sized;
    }
    updateTrayDisplay();
    return true;
  });
  ipcMain.handle('stats:get', (_event, options) => fetchStats(options));
  ipcMain.handle('export:now', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.exportDir || app.getPath('home')
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const stats = await fetchStats();
    const written = await writeExportTo(result.filePaths[0], stats.periods);
    if (!written.ok) return { ok: false, dir: result.filePaths[0], reason: written.reason || 'write-failed' };
    return { ok: true, dir: result.filePaths[0] };
  });
  ipcMain.handle('export:pickAutoDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.exportDir || app.getPath('home')
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, dir: result.filePaths[0] };
  });
  ipcMain.handle('session:getDetail', (_event, args) => {
    const { client, sessionId, period, sessionCost } = args || {};
    return readSessionDetail({ client, sessionId, period, sessionCost, home: os.homedir() });
  });
  ipcMain.handle('stream:status', () => ({ connected: streamConnected, mode, ...(streamFailure || {}) }));
  ipcMain.handle('serviceStatus:get', (_event, options) => serviceStatusClient.getServiceStatus({
    force: Boolean(options?.force),
    providerIds: Array.isArray(options?.providerIds) ? options.providerIds : null
  }));
  ipcMain.handle('hub:getInfo', () => getHubInfo());
  ipcMain.handle('hub:regenerateSecret', () => {
    settings.hubHostSecret = generateHubSecret();
    saveSettings({ throwOnError: true });
    if (settings.hubMode === 'host') startMode();
    return getHubInfo();
  });
  ipcMain.handle('app:getInfo', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: require('os').release(),
    isPackaged: app.isPackaged,
    userData: app.getPath('userData'),
    sharedDataDir: sharedDataDir(),
    loginItemSupported: loginItemEnabledHere(),
    loginItemOpenAtLogin: currentLoginItemState()
  }));
  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
  ipcMain.handle('app:openExternal', (_event, url) => {
    if (!isAllowedExternalUrl(url)) return { ok: false, error: 'url not in allowlist' };
    return shell.openExternal(url)
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: error.message }));
  });
  ipcMain.handle('app:openUserData', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('mimo:accounts', () => mimoAccountsForRenderer());
  ipcMain.handle('mimo:addAccount', (_event, cookieHeader) => addMimoManagedAccount(cookieHeader));
  ipcMain.handle('mimo:openConsole', () => shell.openExternal(MIMO_PLATFORM_CONSOLE_URL)
    .then(() => ({ ok: true }))
    .catch((error) => ({ ok: false, error: error.message })));
  ipcMain.handle('mimo:setAccountEnabled', (_event, id, enabled) => setMimoManagedAccountEnabled(id, enabled));
  ipcMain.handle('mimo:removeAccount', async (_event, id) => removeMimoManagedAccount(id));
  ipcMain.handle('tokscale:getStatus', () => getTokscaleStatus());
  ipcMain.handle('tokscale:checkNpm', () => checkTokscaleNpm());
  ipcMain.handle('tokscale:downloadFromNpm', () => downloadTokscaleFromNpm());
  ipcMain.handle('tokscale:resetToBundled', async () => {
    tokScaleNpmMetadata = null;
    const status = await resetToBundled();
    sendTokscalePush({ type: 'reset', status });
    return status;
  });
  ipcMain.handle('appUpdate:getState', () => deriveAppUpdateState());
  ipcMain.handle('appUpdate:checkNow', () => runAppUpdateCheck({ force: true }));
  ipcMain.handle('appUpdate:download', () => downloadAndPrepareAppUpdate());
  ipcMain.handle('appUpdate:install', () => installDownloadedAppUpdate());
  ipcMain.handle('appUpdate:dismiss', (_event, version) => dismissAppUpdateVersion(version));
  ipcMain.handle('cursor:loginManual', async (_event, raw) => {
    const token = normalizeManualCookie(raw);
    if (!token) return { ok: false, error: 'Empty or malformed token' };
    try {
      const probeResult = await cursorProbe.probe(token);
      if (!probeResult.ok) return { ok: false, error: probeResult.error?.message || 'Cursor rejected the token' };
      await cursorAuth.runCursorLogin(token);
      cursorStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'cursor' }, 'login', { clear: true });
      void refreshUsageClient('cursor', { forceSync: true });
      return { ok: true, email: probeResult.user.email };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('ollama:validateCookie', async (_event, raw) => {
    const cookie = normalizeOllamaCookie(raw);
    if (!cookie) return { ok: false, status: 'notConfigured' };
    const provider = await fetchOllamaLimits({ ollamaCookie: cookie }, { bypassValidationCache: true });
    rememberOllamaValidation(cookie, provider);
    return { ok: provider.status === 'ok', status: provider.status };
  });
  ipcMain.handle('opencode:saveCookie', async (_event, raw) => {
    const cookie = opencodeWeb.sanitizeCookieHeader(raw);
    if (!cookie) {
      settings.opencodeProfiles = {};
      settings.opencodeCookie = '';
      try {
        saveSettings({ throwOnError: true });
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not persist OpenCode credentials' };
      }
      opencodeStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'opencode' }, 'logout', { clear: true });
      return { ok: true, cleared: true };
    }
    try {
      const [go, zen] = await Promise.all([
        opencodeWeb.fetchGoWeb(cookie, {}),
        opencodeWeb.fetchZen(cookie, {})
      ]);
      if (opencodeWeb.summarizeLink(go, zen).expired) {
        return { ok: false, error: 'OpenCode rejected the cookie (it may be expired)' };
      }
      const profiles = settings.opencodeProfiles || {};
      profiles.default = { cookie, enabled: true };
      settings.opencodeProfiles = profiles;
      settings.opencodeCookie = cookie;
      saveSettings({ throwOnError: true });
      opencodeStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'opencode' }, 'credential-save', { clear: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('cursor:logout', async () => {
    try {
      await cursorAuth.runCursorLogout();
      cursorStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'cursor' }, 'logout', { clear: true });
      void refreshUsageClient('cursor', { forceSync: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('opencode:logout', async () => {
    try {
      settings.opencodeProfiles = {};
      settings.opencodeCookie = '';
      saveSettings({ throwOnError: true });
      opencodeStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'opencode' }, 'logout', { clear: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('cursor:status', async () => {
    const now = Date.now();
    if (cursorStatusCache.value && now - cursorStatusCache.at < CURSOR_STATUS_TTL_MS) {
      return cursorStatusCache.value;
    }
    const account = cursorAuth.readActiveAccount();
    if (!account) {
      const value = { loggedIn: false };
      cursorStatusCache = { value, at: now };
      return value;
    }
    const probeResult = await cursorProbe.probe(account.sessionToken);
    const value = probeResult.ok
      ? {
          loggedIn: true,
          email: probeResult.user.email,
          membershipType: probeResult.usage.membershipType,
          billingCycleEnd: probeResult.usage.billingCycleEnd,
          expired: false
        }
      : { loggedIn: true, expired: probeResult.error?.kind === 'unauthorized', error: probeResult.error?.message };
    cursorStatusCache = { value, at: now };
    return value;
  });
  ipcMain.handle('opencode:status', async () => {
    const now = Date.now();
    if (opencodeStatusCache.value && now - opencodeStatusCache.at < CURSOR_STATUS_TTL_MS) {
      return opencodeStatusCache.value;
    }
    const profiles = settings.opencodeProfiles || {};
    const entries = Object.entries(profiles).filter(([, p]) => p.cookie && p.enabled);

    // Query all profiles in parallel
    const results = await Promise.all(
      entries.map(async ([name, profile]) => {
        const [go, zen] = await Promise.all([
          opencodeWeb.fetchGoWeb(profile.cookie, {}),
          opencodeWeb.fetchZen(profile.cookie, {})
        ]);
        return [name, { ...opencodeWeb.summarizeLink(go, zen), balanceUsd: zen.balanceUsd }];
      })
    );

    const result = Object.fromEntries(results);

    // Legacy env cookie. Skip it when it matches an enabled profile so the
    // panel doesn't report an extra "connected" account that the collector
    // dedupes away (otherwise it shows 2/2 while only one account is tracked).
    const envCookie = process.env.TOKEN_MONITOR_OPENCODE_COOKIE || '';
    if (envCookie && !entries.some(([, p]) => p.cookie === envCookie)) {
      const [go, zen] = await Promise.all([
        opencodeWeb.fetchGoWeb(envCookie, {}),
        opencodeWeb.fetchZen(envCookie, {})
      ]);
      let envKey = 'env';
      for (let i = 1; Object.prototype.hasOwnProperty.call(profiles, envKey); i += 1) {
        envKey = `env:${i}`;
      }
      result[envKey] = { ...opencodeWeb.summarizeLink(go, zen), balanceUsd: zen.balanceUsd, env: true };
    }
    const value = { profiles: result, linked: Object.values(result).some(s => s.linked) };
    opencodeStatusCache = { value, at: now };
    return value;
  });
  ipcMain.handle('opencode:getProfiles', async () => {
    const profiles = settings.opencodeProfiles || {};
    const hasEnvVar = Boolean(process.env.TOKEN_MONITOR_OPENCODE_COOKIE);
    // Strip cookie values — renderer only needs name/enabled for display
    const safe = {};
    for (const [name, p] of Object.entries(profiles)) {
      safe[name] = { enabled: p.enabled };
    }
    return { profiles: safe, hasEnvVar };
  });
  ipcMain.handle('opencode:saveProfile', async (_event, name, raw) => {
    const cookie = opencodeWeb.sanitizeCookieHeader(raw);
    if (!cookie || !name) return { ok: false, error: 'Empty name or cookie' };
    try {
      const [go, zen] = await Promise.all([
        opencodeWeb.fetchGoWeb(cookie, {}),
        opencodeWeb.fetchZen(cookie, {})
      ]);
      if (opencodeWeb.summarizeLink(go, zen).expired) {
        return { ok: false, error: 'OpenCode rejected the cookie (it may be expired)' };
      }
      const profiles = settings.opencodeProfiles || {};
      profiles[name] = { cookie, enabled: true };
      settings.opencodeProfiles = profiles;
      saveSettings({ throwOnError: true });
      opencodeStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'opencode', accountName: name }, 'profile-save');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('opencode:deleteProfile', async (_event, name) => {
    const profiles = settings.opencodeProfiles || {};
    const deletedProfile = profiles[name];
    delete profiles[name];
    if (deletedProfile?.cookie && settings.opencodeCookie === deletedProfile.cookie) {
      settings.opencodeCookie = '';
    }
    settings.opencodeProfiles = profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist OpenCode profile deletion' };
    }
    opencodeStatusCache = { value: null, at: 0 };
    void queueLimitInvalidation({ provider: 'opencode', accountName: name }, 'profile-delete', {
      clear: true,
      refresh: false
    });
    return { ok: true };
  });
  ipcMain.handle('opencode:renameProfile', async (_event, oldName, newName) => {
    if (!newName || oldName === newName) return { ok: false, error: 'Invalid name' };
    const profiles = settings.opencodeProfiles || {};
    if (!profiles[oldName]) return { ok: false, error: 'Profile not found' };
    if (profiles[newName]) return { ok: false, error: 'Profile name already exists' };
    profiles[newName] = profiles[oldName];
    delete profiles[oldName];
    settings.opencodeProfiles = profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist OpenCode profile rename' };
    }
    opencodeStatusCache = { value: null, at: 0 };
    void queueLimitInvalidation({ provider: 'opencode', accountName: oldName }, 'profile-rename', {
      clear: true,
      refresh: false
    });
    void queueLimitInvalidation({ provider: 'opencode', accountName: newName }, 'profile-rename');
    return { ok: true };
  });
  ipcMain.handle('opencode:setProfileEnabled', async (_event, name, enabled) => {
    const profiles = settings.opencodeProfiles || {};
    if (!profiles[name]) return { ok: false, error: 'Profile not found' };
    profiles[name].enabled = Boolean(enabled);
    settings.opencodeProfiles = profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist OpenCode profile state' };
    }
    opencodeStatusCache = { value: null, at: 0 };
    void queueLimitInvalidation({ provider: 'opencode', accountName: name }, 'profile-state', {
      clear: !enabled,
      refresh: Boolean(enabled)
    });
    return { ok: true };
  });
  ipcMain.handle('codex:accounts', () => codexAccountsForRenderer());
  ipcMain.handle('codex:setAccountEnabled', (_event, id, enabled) => setCodexManagedAccountEnabled(id, enabled));
  ipcMain.handle('codex:addAccount', async (event, request = {}) => {
    const flowId = String(request?.flowId || '').trim();
    if (codexLoginController) return { ok: false, error: 'A Codex sign-in is already in progress.', flowId };
    const controller = new AbortController();
    codexLoginController = controller;
    codexLoginFlowId = flowId;
    codexLoginCanCancel = true;
    let streamed = '';
    const sendStatus = (payload) => {
      if (codexLoginController !== controller) return;
      if (!event.sender.isDestroyed()) {
        event.sender.send('codex:loginStatus', {
          ...payload,
          flowId
        });
      }
    };
    try {
      const result = await addCodexManagedAccount((text) => {
        streamed = (streamed + String(text || '')).slice(-8000);
        sendStatus({
          phase: 'output',
          text: String(text || ''),
          loginUrl: codexLoginUrlFromOutput(streamed)
        });
      }, {
        signal: controller.signal,
        onCommit: () => {
          if (codexLoginController === controller) codexLoginCanCancel = false;
        }
      });
      if (codexLoginController !== controller) {
        return { ok: false, error: codexLoginErrorMessage({ outcome: 'cancelled' }), outcome: 'cancelled', flowId };
      }
      return { ...result, flowId };
    } finally {
      if (codexLoginController === controller) {
        codexLoginController = null;
        codexLoginFlowId = '';
        codexLoginCanCancel = false;
      }
    }
  });
  ipcMain.handle('codex:cancelLogin', (_event, request = {}) => {
    const flowId = String(request?.flowId || '').trim();
    if (flowId && codexLoginFlowId && flowId !== codexLoginFlowId) return { ok: true, cancelled: false };
    const controller = codexLoginController;
    if (!controller) return { ok: true, cancelled: false };
    if (!codexLoginCanCancel) return { ok: false, cancelled: false, tooLate: true };
    controller?.abort();
    return { ok: true, cancelled: true };
  });
  ipcMain.handle('codex:removeAccount', async (_event, id) => removeCodexManagedAccount(id));
  ipcMain.handle('codex:switchSystemAccount', async (_event, id) => switchCodexSystemAccount(id));
  ipcMain.handle('codex:refreshAccountLimits', async (_event, id) => refreshCodexManagedAccountLimits(id));
  ipcMain.handle('copilot:signIn', async (event, request = {}) => {
    if (copilotLoginController) return { ok: false, error: 'A GitHub Copilot sign-in is already in progress.', flowId: copilotLoginFlowId };
    const controller = new AbortController();
    const flowId = String(request?.flowId || '').trim();
    copilotLoginController = controller;
    copilotLoginFlowId = flowId;
    const sendStatus = (payload) => {
      if (copilotLoginController !== controller) return;
      if (!event.sender.isDestroyed()) event.sender.send('copilot:loginStatus', { ...payload, flowId });
    };
    try {
      const result = await runCopilotDeviceFlowLogin({
        enterpriseHost: settings?.copilotEnterpriseHost || process.env.COPILOT_ENTERPRISE_HOST || process.env.GITHUB_ENTERPRISE_HOST || '',
        signal: controller.signal,
        onStatus: sendStatus
      }, {
        openExternal: (url) => shell.openExternal(url),
        copyToClipboard: (text) => clipboard.writeText(String(text || '')),
        fetch
      });
      if (copilotLoginController !== controller) {
        return { ok: false, error: copilotLoginErrorMessage({ status: 'cancelled' }), flowId };
      }
      settings.copilotApiToken = normalizeCopilotApiToken(result.accessToken);
      saveSettings({ throwOnError: true });
      pushSettingsToRenderer();
      void queueLimitInvalidation({ provider: 'copilot' }, 'login', { clear: true });
      return { ok: true, flowId };
    } catch (error) {
      const message = copilotLoginErrorMessage(error);
      sendStatus({ phase: 'error', error: message });
      return { ok: false, error: message, flowId };
    } finally {
      if (copilotLoginController === controller) {
        copilotLoginController = null;
        copilotLoginFlowId = '';
      }
    }
  });
  ipcMain.handle('copilot:cancelSignIn', (_event, request = {}) => {
    const flowId = String(request?.flowId || '').trim();
    if (flowId && copilotLoginFlowId && flowId !== copilotLoginFlowId) return { ok: true };
    const controller = copilotLoginController;
    controller?.abort();
    if (copilotLoginController === controller) {
      copilotLoginController = null;
      copilotLoginFlowId = '';
    }
    return { ok: true };
  });
  ipcMain.on('window:minimize', () => {
    if (settings?.trayMode) hidePopover();
    else mainWindow?.minimize();
  });
  ipcMain.on('window:close', () => {
    if (settings?.trayMode) hidePopover();
    else mainWindow?.close();
  });
  ipcMain.handle('dashboard:open', () => { createDashboardWindow(); return true; });
  ipcMain.handle('dashboard:getHistory', () => getDashboardHistory());
  ipcMain.on('dashboard:ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== dashboardWindow || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  ipcMain.on('dashboard:minimize', (event) => { BrowserWindow.fromWebContents(event.sender)?.minimize(); });
  ipcMain.on('dashboard:close', (event) => { BrowserWindow.fromWebContents(event.sender)?.close(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  maybeRunBackgroundUpdateCheck();
  startAppUpdateBackgroundChecks();
});

app.on('second-instance', focusExistingWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { quitRequested = true; if (rateRefreshTimer) clearInterval(rateRefreshTimer); if (appUpdateBackgroundTimer) clearInterval(appUpdateBackgroundTimer); unregisterWindowToggleShortcut(); stopAll(); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, requestAppQuit);
}
