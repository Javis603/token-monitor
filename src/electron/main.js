'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, net, Notification, screen, session, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { defaultDeviceId, generateHubSecret, lanIpv4Addresses, loadDotEnv, pidFilePath, readJson, sharedDataDir } = require('../shared/config');
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
const { macWidgetRuntimeSupport } = require('../shared/macSystemRequirements');
const { exportFileSet, exportSignature, EXPORT_FILENAMES } = require('../shared/exporter');
const { createDefaultTrayLayout, normalizeTrayLayout } = require('../shared/trayLayout');
const fontSettingsApi = require('../shared/fontSettings');
const motionPreferenceApi = require('./motionPreference');
const { createClientSourceIpcHandlers } = require('./clientSourceIpc');
const { createClaudeWebFetch } = require('./claudeWebFetch');
const { createElectronLimitsFetch } = require('./limitsFetch');
const {
  expandedBoundsForCollapse,
  normalWindowBounds,
  persistWindowState,
  rebuildWindowBounds,
  restoreWindowMaximized,
  restoreWindowMaximizedForReveal,
  setWindowMaximizable,
  shouldPersistWindowBounds,
  shouldTrackWindowMaximized,
  suspendWindowMaximized
} = require('./windowState');

// Install EPIPE suppression before anything that might log. Without this,
// a closed parent pipe turns the next log call into an unhandled 'error'
// event and Electron pops a "JavaScript error in the main process" dialog.
installSafeStdout();
const electronClaudeWebFetch = createClaudeWebFetch(net);
// One transport for every widget provider call that resolves through
// `deps.fetch` — see limitsFetch.js for why the branch and the request options
// are what they are. Probes that build their own transport inherit neither
// branch: cursorProbe and antigravityProbe on node:https, Claude Web on the
// claudeWebFetch above, the CLI fallbacks on a spawned binary.
function electronLimitsFetch() {
  return createElectronLimitsFetch({ net, env: process.env });
}

// Settings-side provider probes take the same transport as the collector's.
// Most of them are what an account save is gated on, so leaving one on the
// global fetch refuses to save an account on exactly the machines this
// transport exists for.
function electronProviderDeps(deps = {}) {
  return { ...deps, fetch: electronLimitsFetch() };
}
const { DEFAULT_CLIENTS, KNOWN_CLIENTS, clientsCsvForSetting } = require('../shared/clientTracking');
const { clientDiagnosticRoots, lookupModelPricing, normalizeHistoryIntervalMs, visibleDiagnosticRoots } = require('../shared/collector');
const { deviceRecordFromAnchor } = require('../shared/anchorSeed');
const { sendWhenRendererReady } = require('./deferredWindowSend');
const { createDeviceRuntime } = require('../shared/deviceRuntime');
const { createDiagnosticJournal } = require('../shared/diagnosticJournal');
const { createDiagnosticReportGenerator } = require('./diagnostics');
const { createDiagnosticSnapshotBuilder, diagnosticStreamDetailCode, selectLocalDeviceRecord } = require('./diagnosticSnapshot');
const { customPricingPath } = require('../shared/tokscaleConfig');
const { applyCustomPricing, normalizeCustomPricingSetting } = require('../shared/tokscaleCustomPricing');
const { createHub } = require('../hub/server');
const { probeHubBuild } = require('./hubBuildStatus');
const { claudeWebCookie, deepseekToken, fetchClaudeLimits, normalizeClaudeWebCookieInput, normalizeLimitsRefreshMode, normalizeLimitsRefreshMs, parseBoolean, parseLimitProviders, runCodexLogin, minimaxToken, copilotToken, zaiToken, zaiRegion, zaiTeamToken, volcengineCredentials, qoderCookie, commandcodeCookie, kimiToken, kimiWebToken, ollamaSessionCookie } = require('../shared/limitCollector');
const { fetchOllamaLimits, rememberOllamaValidation } = require('../shared/ollamaLimits');
const { copilotLoginErrorMessage, isAllowedVerificationUrl, runCopilotDeviceFlowLogin } = require('../shared/copilotDeviceFlow');
const {
  codexAuthIdentity,
  codexManagedAccountIdentityKey,
  codexManagedAccountMatchesIdentity,
  hashAccountKey,
  preserveCodexManagedHydrationCollisions,
  upgradeCodexManagedAccountIdentity
} = require('../shared/codexAuth');
const { codexLoginUrlFromOutput, isAllowedCodexLoginUrl } = require('../shared/codexLogin');
const {
  authWithSelectedCodexWorkspace,
  listCodexWorkspaces,
  normalizeWorkspaceId
} = require('../shared/codexWorkspaces');
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
  classifyAppUpdateError,
  checkLatestRelease,
  deriveAppUpdateAvailability,
  downloadedAppUpdateMatchesLatest,
  installFailureErrorKind,
  latestFromUpdaterInfo,
  mergeLatestReleaseMetadata,
  providerUpdateCheckAvailability,
  resolveAppUpdateCheckError,
  shouldDownloadAutomaticAppUpdate,
  shouldSkipAppUpdateCheck,
  updateInstallQuitPolicy
} = require('../shared/appUpdater');
const cursorAuth = require('../shared/cursorAuth');
const cursorProbe = require('../shared/cursorProbe');
const opencodeWeb = require('../shared/opencodeWeb');
const opencodeGoApi = require('../shared/opencodeGoApi');
const opencodeProfiles = require('../shared/opencodeProfiles');

// The collector reaches the usage API behind a probe deadline; these settings
// paths call it directly, so they need their own bound or a hung request leaves
// the account panel spinning and "Save account" pending forever.
const OPENCODE_API_PROBE_TIMEOUT_MS = 15_000;

// The auto-detected key has an account of its own for exactly as long as no
// stored account claims it. Ownership is the shared predicate the collector
// uses, so the panel never offers a row the collector is not scanning.
// The auto-detected account is not addressable by name, because it has none.
// Every credential mutation queues an account-scoped refresh, and a scoped
// refresh rebuilds only the account it names, so nothing could ever create its
// row or retire it: removing the credential that claimed the key left the card
// without the account that took it over, and naming it left the old synthetic
// row behind. When ownership of the key changes, the whole provider is rebuilt.
function refreshOpencodeAmbientOwnership(wasActive) {
  if (opencodeAmbientKeyActive(settings.opencodeProfiles || {}) === wasActive) return;
  void queueLimitInvalidation({ provider: 'opencode' }, 'ambient-ownership', { clear: true });
}

function opencodeAmbientKeyActive(profiles) {
  const ambientKey = opencodeGoApi.readGoApiKey(process.env);
  if (!ambientKey) return false;
  const ambientIdentity = opencodeGoApi.goApiIdentity(ambientKey);
  return !opencodeProfiles.ambientKeyClaimed(profiles, ambientKey, ambientIdentity);
}

async function probeOpenCodeApiKey(apiKey) {
  try {
    return await opencodeGoApi.fetchGoApi(apiKey, {
      fetch: electronLimitsFetch(),
      signal: AbortSignal.timeout(OPENCODE_API_PROBE_TIMEOUT_MS)
    });
  } catch (_) {
    return { status: 'unavailable', windows: [] };
  }
}
const openrouterLimits = require('../shared/openrouterLimits');
const thirdPartyLimits = require('../shared/thirdPartyLimits');
const subscriptionDisplay = require('../shared/subscriptionDisplay');
const { normalizeCurrency, resolveEffectiveRates, configureRates } = require('../shared/currency');
const { normalizeCompactTokenUnits } = require('../shared/compactTokens');
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
  sessionUsageArchivePath,
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
const { deviceHistoryRevision, historyPreview, historyRevision } = require('../shared/history');
const { completeHistorySource, resolveCompleteHistory, resolveCompleteHistoryWithDevices } = require('./historySource');
const { fixedPeriodHistoryMeta } = require('./fixedPeriodHistory');
const { readSessionDetailForPlatform } = require('../shared/sessionDetailResolver');
const { startDiscordRpc, stopDiscordRpc, updateDiscordRpc } = require('./discordRpc');
const {
  commitMacWidgetSnapshot,
  discardMacWidgetSnapshot,
  prepareMacWidgetSnapshotUpdate,
  resolveMacWidgetSnapshotPath,
  syncMacWidgetSnapshotDirectory
} = require('./macWidgetBridge');
const { createMacWidgetSnapshotController } = require('./macWidgetSnapshotController');
const { macWidgetHistorySourceKey, resolveMacWidgetHistory } = require('./macWidgetHistory');
const {
  macWidgetHistoryCachePath,
  readMacWidgetHistoryCache,
  writeMacWidgetHistoryCache
} = require('./macWidgetHistoryStore');
const { parseMacWidgetDeepLink } = require('./macWidgetDeepLink');
const { createMacWidgetLaunchServicesRecovery } = require('./macWidgetLaunchServicesRecovery');
const { projectLimitStatsForDisplay } = require('./limitStatsPresentation');
const { normalizeWidgetURLScheme } = require('../shared/macWidgetConfig');
const { DEFAULT_WIDGET_KIND, requestMacWidgetReload, resetMacWidgetReloadThrottle } = require('./macWidgetReloader');
const { WIDGET_DEMAND_MARKER, WIDGET_DEMAND_PROVISIONAL_MARKER, createMacWidgetDemandState } = require('./macWidgetDemand');
const linuxAutostart = require('./linuxAutostart');
const { codexAccountIdForProvider, localLiveCodexProvider } = require('./renderer/accountIdentity');
const {
  buildTrayIcon,
  createTray,
  formatTrayText,
  isBarsTrayIconMode,
  pickUsageTrayIconId,
  parseWindowsSystemUsesLightTheme,
  popoverBounds,
  reconcileCodexAccountSelection,
  runTrayMenuAction,
  watchSystemDarkUi,
  sortCodexAccountsForDisplay,
  shouldUseTemplateTrayIcon,
  trayShowsTitle
} = require('./tray');
const {
  macActivationPolicyMode,
  mainWindowCloseAction,
  normalizeTrayModeSettings,
  shouldCreateTray,
  trayToggleAction
} = require('./trayModeSettings');
const { SERVICE_STATUS_PROVIDERS, createServiceStatusClient } = require('./serviceStatus');
const { createUpdateInstallQuitGuard, observeUpdateInstallHandoff } = require('./updateInstallQuit');
const { classifyStreamFailure } = require('./syncConnection');
const {
  attachLocalNativeViews,
  attachLocalPresentationNativeViews,
  composeLocalSyncStats
} = require('./syncDisplayStats');
const { createSyncUploadScheduler, normalizeSyncUploadIntervalMs } = require('./syncUploadScheduler');
const {
  classifySettingsChange,
  diagnosticConfigurationFromSettings,
  envelopeFromSettings,
  limitsConfigFromSettings,
  usageConfigFromSettings
} = require('./runtimeConfig');
const {
  canRefreshUsageRuntime,
  drainPendingUsageClientRefreshes: drainPendingUsageClientRefreshQueue,
  runLimitInvalidation,
  runManualDeviceRefresh,
  settingsLimitInvalidationPlan
} = require('./deviceRuntimeCoordinator');
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
const { setMoveToActiveSpace } = require('./macosSpaceBehavior');
const {
  WINDOWS_BACKDROP_ACCENT,
  normalizeWindowsBackdropMode
} = require('./windowsBackdropMode');
const { applyWindowsAccentBlur } = require('./windowsBackdrop');

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
const TRAY_CONTENT_VALUES = new Set(['tokens', 'cost', 'both', 'tokensAll', 'costAll', 'bothAll', 'limitsAllSessions', 'bars', 'barsSession', 'barsWeekly', 'barsAllSessions', 'icon', 'custom']);
const HUB_MODE_VALUES = new Set(['local', 'client', 'host']);
const LANGUAGE_VALUES = new Set(LANGUAGE_OPTIONS.map((option) => option.value));
const COLLECTION_MODE_VALUES = new Set(['live', 'smart', 'interval']);
const COLLECTION_INTERVAL_OPTIONS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
// Smart mode's cadence is fixed and resolved directly in collectorIntervalMs(),
// so it stays out of COLLECTION_INTERVAL_OPTIONS: that list validates the
// persisted collectionIntervalMs, and admitting 10m there would let a
// smart-mode value survive a switch back to live/interval and silently
// change that mode's backstop interval.
const SMART_COLLECTION_INTERVAL_MS = 10 * 60 * 1000;
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
let claudeWebCookieMutationRevision = 0;
let persistedSettingsSnapshot = null;
let credentialStore = null;
let credentialStorageErrorShown = false;
let sessionUsageArchive = null;
let lastSessionUsageArchiveUpdate = {
  at: null,
  durationMs: null,
  failureCode: null
};
let rendererViewState = normalizeInitialRendererViewState();
const serviceStatusClient = createServiceStatusClient();
const STATUS_PAGE_HOSTS = new Set(SERVICE_STATUS_PROVIDERS.map((provider) => new URL(provider.pageUrl).hostname));
const diagnosticJournal = createDiagnosticJournal();
const recoverMacWidgetLaunchServicesRegistration = createMacWidgetLaunchServicesRecovery();

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.javis.tokenmonitor');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

const HOME_LIMIT_ACCOUNT_COUNT_DEFAULT = 3;
const HOME_LIMIT_ACCOUNT_COUNT_MAX = 12;
const PERIOD_MONTH_MODES = new Set(['month', 'week', 'last7', 'last30']);

function normalizePeriodMonthMode(value) {
  return PERIOD_MONTH_MODES.has(value) ? value : 'month';
}

function normalizeHomeLimitAccountCount(value) {
  const count = Math.trunc(Number(value));
  if (!Number.isFinite(count)) return HOME_LIMIT_ACCOUNT_COUNT_DEFAULT;
  return Math.max(1, Math.min(HOME_LIMIT_ACCOUNT_COUNT_MAX, count));
}

let pendingMacWidgetOpen = null;
app.on('open-url', (event, url) => {
  const urlScheme = macWidgetConfiguration()?.urlScheme || 'token-monitor';
  const destination = parseMacWidgetDeepLink(url, urlScheme);
  if (!destination) return;
  event.preventDefault();
  pendingMacWidgetOpen = destination;
  if (app.isReady()) setImmediate(openMainWindowFromWidget);
});

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
    windowsBackdrop: 'acrylic',
    reduceMotion: 'system',
    showLiveDot: true,
    showToolIcons: true,
    titleIconOnly: true,
    showCompactTotalTokens: false,
    compactTokenUnits: 'western',
    tokenRateMode: 'speed',
    heatmapMetric: 'cost',
    homeActiveDaysWindow: 'all',
    periodMonthMode: 'month',
    themeColors: {},
    vendorColors: {},
    interfaceFontFamily: '',
    displayFontFamily: fontSettingsApi.DEFAULT_DISPLAY_FONT,
    floatingBubbleEnabled: false,
    floatingBubbleTrigger: 'click',
    floatingBubbleContent: 'icon',
    floatingBubbleCustomLayout: createDefaultTrayLayout(),
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
    limitsRefreshMode: normalizeLimitsRefreshMode(process.env.TOKEN_MONITOR_LIMITS_REFRESH_MODE),
    limitsRefreshMs: normalizeLimitsRefreshMs(process.env.TOKEN_MONITOR_LIMITS_REFRESH_MS),
    showLimitSource: parseBoolean(process.env.TOKEN_MONITOR_SHOW_LIMIT_SOURCE, false),
    maskLimitAccountEmails: false,
    claudePrepaidBalanceEnabled: parseBoolean(process.env.TOKEN_MONITOR_CLAUDE_PREPAID_BALANCE, true),
    // The key OpenCode stores for itself needs no setup, so tracking it is the
    // default. This turns that off for a machine that is signed in to an account
    // the user does not want reported.
    opencodeAmbientEnabled: parseBoolean(process.env.TOKEN_MONITOR_OPENCODE_AMBIENT, true),
    opencodeLocalLimitsEnabled: false,
    showLimitUsed: parseBoolean(process.env.TOKEN_MONITOR_SHOW_LIMIT_USED, false),
    // Manual subscription metadata. Plain preferences, not credentials, so they
    // live in settings.json and cross to the renderer unredacted.
    subscriptions: [],
    // Local records left behind when this device joined a hub that already had a
    // list, with the hub they were held back from. Kept until the user says
    // whether to add or drop them.
    subscriptionsOrphaned: { hubUrl: '', records: [] },
    // Which hub `subscriptions` is currently a cache of, or '' when this device
    // owns the list outright.
    subscriptionsCacheHub: '',
    windowBounds: null,
    windowMaximized: false,
    zoomFactor: 1,
    showTrayIcon: true,
    trayMode: false,
    trayContent: 'tokens',
    trayCustomLayout: createDefaultTrayLayout(),
    showTrayProviderBadge: false,
    windowToggleShortcut: '',
    currency: normalizeCurrency(process.env.TOKEN_MONITOR_CURRENCY || 'USD'),
    currencyRates: {},
    startAtLogin: false,
    automaticAppUpdates: false,
    language: 'auto',
    claudeWebCookie: '',
    opencodeCookie: '',
    opencodeProfiles: {},
    openrouterProfiles: {},
    thirdPartyProfiles: {},
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
    commandcodeCookie: '',
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

// Which throughput reading the title-mark reveal shows. 'speed' is estimated output tokens
// per second of model-busy time; 'burn' is every token per minute of the same window. Both
// derive from the timed totals the collector already puts on the period — this only picks
// the framing, and neither costs an extra scan.
function normalizeTokenRateMode(value) {
  return value === 'burn' ? 'burn' : 'speed';
}

function normalizeHeatmapMetric(value, fallback = 'cost') {
  const next = String(value || '').trim();
  if (next === 'tokens' || next === 'cost') return next;
  return fallback === 'tokens' ? 'tokens' : 'cost';
}

function normalizeHomeActiveDaysWindow(value, fallback = 'all') {
  const next = String(value || '').trim();
  if (next === 'year') return 'year';
  if (next === 'all') return 'all';
  return fallback === 'year' ? 'year' : 'all';
}

function normalizeCollectionIntervalMs(value, fallback = DEFAULT_COLLECTION_INTERVAL_MS) {
  const numeric = Number(value);
  if (COLLECTION_INTERVAL_OPTIONS.includes(numeric)) return numeric;
  const fallbackNumeric = Number(fallback);
  return COLLECTION_INTERVAL_OPTIONS.includes(fallbackNumeric) ? fallbackNumeric : DEFAULT_COLLECTION_INTERVAL_MS;
}

function collectorIntervalMs() {
  return normalizeCollectionMode(settings?.collectionMode) === 'smart'
    ? SMART_COLLECTION_INTERVAL_MS
    : normalizeCollectionIntervalMs(settings?.collectionIntervalMs);
}

function collectorWatchEnabled() {
  return normalizeCollectionMode(settings?.collectionMode) !== 'interval';
}

function collectorWatchTriggersCollection() {
  return normalizeCollectionMode(settings?.collectionMode) === 'live';
}

function collectorIntervalRequiresActivity() {
  return normalizeCollectionMode(settings?.collectionMode) === 'smart';
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
    reasonixNativeSessionsEnabled: true,
    watchEnabled: collectorWatchEnabled(),
    // No watchUsePolling on purpose. The widget states no preference so the
    // shared default in resolveWatchUsePolling() governs and the widget cannot
    // drift from the headless agent, which has never passed one. That default
    // is native events on every platform: chokidar 4 dropped the bundled
    // fsevents backend, so every platform now watches through the same
    // per-directory fs.watch path, and the earlier attempt that observed missed
    // events ran on the chokidar 3 backend that no longer exists. Where the
    // kernel cannot supply watch descriptors the collector degrades to polling
    // by itself; TOKEN_MONITOR_WATCH_POLLING overrides in both directions.
    watchTriggersCollection: collectorWatchTriggersCollection(),
    intervalRequiresActivity: collectorIntervalRequiresActivity(),
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

function normalizeClaudeWebCookie(value) {
  return normalizeClaudeWebCookieInput(value);
}

function currentClaudeWebCookie() {
  return settings?.claudeWebCookie || claudeWebCookie(process.env);
}

function persistClaudeWebCookieRenewal({ previousCookie, cookie } = {}) {
  if (!settings?.claudeWebCookie) return false;
  let expected;
  let renewed;
  try {
    expected = normalizeClaudeWebCookie(previousCookie);
    renewed = normalizeClaudeWebCookie(cookie);
  } catch (_) {
    return false;
  }
  if (!renewed || normalizeClaudeWebCookie(settings.claudeWebCookie) !== expected) return false;
  if (settings.claudeWebCookie === renewed) return true;
  settings.claudeWebCookie = renewed;
  saveSettings({ throwOnError: true });
  return true;
}

function electronLimitsDeps() {
  return {
    fetch: electronLimitsFetch(),
    claudeWebFetch: electronClaudeWebFetch,
    resolveConfigSnapshot: () => electronLimitsConfig(),
    onClaudeWebCookieRenewed: persistClaudeWebCookieRenewal
  };
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

function normalizeCommandcodeCookie(value) {
  return commandcodeCookie({}, { commandcodeCookie: String(value || '') });
}

function currentCommandcodeCookie() {
  return settings?.commandcodeCookie || commandcodeCookie(process.env);
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
let codexWorkspaceSelection = null;
let codexWorkspaceLabelHydrationPromise = null;
let copilotLoginController = null;
let copilotLoginFlowId = '';
const CODEX_WORKSPACE_LABEL_HYDRATION_CONCURRENCY = 3;

// Startup label hydration is a small one-shot map. LimitsRuntime's bounded
// executor owns lane-aware provider refresh state, so it is not reusable here.
async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.min(items.length, Math.max(1, Math.trunc(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeCodexManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const accounts = [];
  for (const account of value) {
    if (!account || typeof account !== 'object') continue;
    const id = String(account.id || '').trim();
    const homePath = String(account.homePath || '').trim();
    if (!id || !homePath) continue;
    const email = String(account.email || '').trim().toLowerCase();
    const workspaceAccountId = normalizeWorkspaceId(
      account.workspaceAccountId
      || account.providerAccountId
    );
    const rawWorkspaceLabel = String(account.workspaceLabel || '').trim();
    const workspaceKind = account.workspaceKind === 'personal' ? 'personal' : '';
    const accountKey = String(account.accountKey || '').trim();
    const dedupe = codexManagedAccountIdentityKey({
      id,
      accountKey,
      email,
      workspaceAccountId
    });
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    accounts.push({
      id,
      email,
      accountKey,
      accountLabel: String(account.accountLabel || '').trim(),
      workspaceAccountId,
      workspaceLabel: workspaceKind ? '' : rawWorkspaceLabel,
      workspaceKind,
      homePath,
      authPath: String(account.authPath || path.join(homePath, 'auth.json')).trim(),
      addedAt: account.addedAt || new Date().toISOString(),
      updatedAt: account.updatedAt || account.addedAt || new Date().toISOString(),
      enabled: account.enabled !== false
    });
  }
  return accounts;
}

function hydrateCodexManagedAccounts(value) {
  const storedAccounts = normalizeCodexManagedAccounts(value);
  const hydratedAccounts = storedAccounts.map((account) => {
    try {
      const auth = JSON.parse(readRegularFileNoFollow(account.authPath, {
        fs,
        description: 'Managed Codex auth',
        encoding: 'utf8'
      }));
      return upgradeCodexManagedAccountIdentity(account, codexAuthIdentity(auth));
    } catch (_) {
      return account;
    }
  });
  const resolvedAccounts = preserveCodexManagedHydrationCollisions(storedAccounts, hydratedAccounts);
  if (resolvedAccounts.some((account, index) => account !== hydratedAccounts[index])) {
    console.warn('[codex] Managed account identity hydration found a collision; preserved stored identities.');
  }
  return resolvedAccounts;
}

function hydrateCodexManagedWorkspaceLabels() {
  if (codexWorkspaceLabelHydrationPromise) return codexWorkspaceLabelHydrationPromise;
  if (
    settings?.limitsEnabled === false
    || !parseLimitProviders(settings?.limitProviders).includes('codex')
  ) return Promise.resolve(false);
  const candidates = normalizeCodexManagedAccounts(settings?.codexManagedAccounts)
    .filter((account) => (
      account.enabled !== false
      && account.workspaceAccountId
      && !account.workspaceLabel
      && !account.workspaceKind
    ));
  if (candidates.length === 0) return Promise.resolve(false);

  const task = mapWithConcurrency(
    candidates,
    CODEX_WORKSPACE_LABEL_HYDRATION_CONCURRENCY,
    async (account) => {
      try {
        const auth = JSON.parse(readRegularFileNoFollow(account.authPath, {
          fs,
          description: 'Managed Codex auth',
          encoding: 'utf8'
        }));
        const workspaces = await listCodexWorkspaces(auth, electronProviderDeps({ env: process.env }));
        const workspace = workspaces.find((entry) => entry.id === account.workspaceAccountId);
        return workspace
          ? {
              id: account.id,
              workspaceAccountId: account.workspaceAccountId,
              label: workspace.label,
              workspaceKind: workspace.workspaceKind
            }
          : null;
      } catch (_) {
        return null;
      }
    }
  ).then((results) => {
    const labels = new Map(
      results.filter(Boolean).map((result) => [result.id, result])
    );
    if (labels.size === 0) return false;
    let changed = false;
    const accounts = normalizeCodexManagedAccounts(settings?.codexManagedAccounts).map((account) => {
      const resolved = labels.get(account.id);
      if (
        !resolved
        || account.workspaceLabel
        || account.workspaceKind
        || account.enabled === false
        || account.workspaceAccountId !== resolved.workspaceAccountId
      ) return account;
      changed = true;
      return {
        ...account,
        workspaceLabel: resolved.label,
        workspaceKind: resolved.workspaceKind,
        updatedAt: new Date().toISOString()
      };
    });
    if (!changed) return false;
    settings.codexManagedAccounts = accounts;
    saveSettings();
    pushSettingsToRenderer();
    void queueLimitInvalidation({ provider: 'codex' }, 'workspace-label-hydrated');
    return true;
  });

  codexWorkspaceLabelHydrationPromise = task.finally(() => {
    codexWorkspaceLabelHydrationPromise = null;
  });
  return codexWorkspaceLabelHydrationPromise;
}

function codexAccountsForRenderer() {
  return normalizeCodexManagedAccounts(settings?.codexManagedAccounts).map(({
    id, email, accountKey, accountLabel, workspaceAccountId, workspaceLabel, workspaceKind, addedAt, updatedAt, enabled
  }) => ({
    id,
    email,
    accountKey,
    accountLabel,
    workspaceAccountId,
    workspaceLabel,
    workspaceKind,
    addedAt,
    updatedAt,
    enabled
  }));
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
  const [validation] = await fetchMimoLimits({ mimoManagedAccounts: [result.account] }, electronProviderDeps());
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

function findExistingCodexAccount(accounts, identity) {
  return accounts.find((account) => codexManagedAccountMatchesIdentity(account, identity));
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
    workspaceAccountId: identity.workspaceAccountId || identity.providerAccountId || '',
    workspaceLabel: String(identity.workspaceLabel || '').trim(),
    workspaceKind: identity.workspaceKind === 'personal' ? 'personal' : '',
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

async function resolveCodexWorkspaceAfterLogin(auth, homePath, options = {}) {
  const initialIdentity = codexAuthIdentity(auth);
  let workspaces;
  try {
    workspaces = await listCodexWorkspaces(auth, electronProviderDeps({
      env: process.env,
      signal: options.signal
    }));
  } catch (error) {
    if (options.signal?.aborted) return { cancelled: true };
    console.warn('Could not list Codex workspaces after sign-in:', error?.message || error);
    return { auth, identity: initialIdentity };
  }
  if (options.signal?.aborted) return { cancelled: true };
  if (workspaces.length === 0) return { auth, identity: initialIdentity };

  const currentWorkspaceId = normalizeWorkspaceId(initialIdentity.workspaceAccountId);
  let selected;
  if (workspaces.length === 1) {
    selected = workspaces[0];
  } else if (typeof options.selectWorkspace === 'function') {
    const selectedId = normalizeWorkspaceId(await options.selectWorkspace({
      email: initialIdentity.email,
      currentWorkspaceId,
      workspaces
    }));
    if (!selectedId || options.signal?.aborted) return { cancelled: true };
    selected = workspaces.find((workspace) => workspace.id === selectedId) || null;
    if (!selected) throw new Error('The selected Codex workspace is no longer available.');
  } else {
    selected = workspaces.find((workspace) => workspace.id === currentWorkspaceId) || null;
  }
  if (!selected) return { auth, identity: initialIdentity };

  const selectedAuth = authWithSelectedCodexWorkspace(auth, selected.id);
  await writeCodexAuthFile(
    path.join(homePath, 'auth.json'),
    `${JSON.stringify(selectedAuth, null, 2)}\n`
  );
  return {
    auth: selectedAuth,
    identity: {
      ...codexAuthIdentity(selectedAuth),
      workspaceLabel: selected.label,
      workspaceKind: selected.workspaceKind
    }
  };
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
    const workspaceResult = await resolveCodexWorkspaceAfterLogin(auth, tempHome, options);
    if (workspaceResult.cancelled) return cancelledCodexLoginResult();
    auth = workspaceResult.auth;
    const identity = workspaceResult.identity;
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
  const persistedCodexAccounts = settings.codexManagedAccounts;
  const hydratedCodexAccounts = hydrateCodexManagedAccounts(persistedCodexAccounts);
  persistedSettingsSnapshot = cloneSettingsSnapshot(settings);
  if (JSON.stringify(hydratedCodexAccounts) !== JSON.stringify(persistedCodexAccounts)) {
    settings.codexManagedAccounts = hydratedCodexAccounts;
    if (!saveSettings()) {
      // Keep the runtime identity coherent even if the migration cannot be
      // persisted yet; the next ordinary settings save will retry it.
      settings.codexManagedAccounts = hydratedCodexAccounts;
    }
  }
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
  // The display comes from where the window actually sits, but the bounds the
  // plan remembers as "expanded" must be the normal ones: collapsing a
  // maximized window would otherwise persist the whole screen as its size.
  const display = displayForBounds(bounds);
  if (!display) return false;
  const collapsedArea = collapsedAreaForDisplay(display);
  const plan = floatingBubbleCollapsePlan(expandedBoundsForCollapse(mainWindow, bounds), display.workArea, settings, {
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
    restoreWindowMaximized(mainWindow, settings);
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
  if (!shouldPersistWindowBounds(mainWindow)) {
    stopPersistBoundsTimer();
    return;
  }
  stopPersistBoundsTimer();
  persistBoundsTimer = setTimeout(() => {
    persistBoundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!shouldPersistWindowBounds(mainWindow)) return;
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
    merged.opencodeLocalLimitsEnabled = parseBoolean(merged.opencodeLocalLimitsEnabled, false);
    merged.windowMaximized = parseBoolean(merged.windowMaximized, false);
    merged.automaticAppUpdates = parseBoolean(merged.automaticAppUpdates, false);
    if (saved.homeLimitProviderOrder !== undefined) {
      merged.homeLimitProviderOrder = migrateHomeLimitProviderOrder(saved.homeLimitProviderOrder);
    }
    if (saved.hiddenHomeLimitProviders !== undefined) {
      merged.hiddenHomeLimitProviders = normalizeHiddenLimitProviders(saved.hiddenHomeLimitProviders);
    }
    merged.homeLimitAccountCount = normalizeHomeLimitAccountCount(merged.homeLimitAccountCount);
    merged.periodMonthMode = normalizePeriodMonthMode(merged.periodMonthMode);
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
    merged.homeActiveDaysWindow = normalizeHomeActiveDaysWindow(merged.homeActiveDaysWindow);
    merged.reduceMotion = motionPreferenceApi.normalize(merged.reduceMotion);
    merged.compactTokenUnits = normalizeCompactTokenUnits(merged.compactTokenUnits);
    merged.interfaceFontFamily = fontSettingsApi.normalizeFontFamily(merged.interfaceFontFamily);
    merged.displayFontFamily = fontSettingsApi.normalizeFontFamily(merged.displayFontFamily);
    merged.tokenRateMode = normalizeTokenRateMode(merged.tokenRateMode);
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
    merged.floatingBubbleCustomLayout = normalizeTrayLayout(merged.floatingBubbleCustomLayout);
    merged.trayCustomLayout = normalizeTrayLayout(merged.trayCustomLayout);
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
    refreshTrayContextMenu();
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
  return selectLocalDeviceRecord({
    deviceId: settings?.deviceId || defaultDeviceId(),
    externalAgentActive: isExternalAgentActive(),
    lastCollectedDevice,
    localDevice,
    latestHubStats: currentHubStatsCache(),
    latestStats
  });
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
  const startedAt = Date.now();
  const finish = (failureCode = null) => {
    lastSessionUsageArchiveUpdate = {
      at: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      failureCode
    };
  };
  const previous = ensureSessionUsageArchiveLoaded();
  const next = captureSessionUsageArchive(previous, summary, now);
  if (JSON.stringify(next) === JSON.stringify(previous)) {
    finish();
    return previous;
  }
  try {
    writeSessionUsageArchive(next);
    sessionUsageArchive = next;
  } catch (error) {
    finish('archive-write-failed');
    diagnosticJournal.record({ subsystem: 'storage', code: 'storage-archive-update-failed' });
    console.log(`[session-archive] write failed: ${error.message}`);
    return next;
  }
  finish();
  return next;
}

// Read-only projection of both archives onto a summary. Un-tracked clients and
// retained sessions add to the period totals, not just to the breakdowns, so
// anything rendered without this reads low. Takes the session archive as an
// argument because capturing into it is a separate decision, see below.
function summaryWithArchivesApplied(summary, sessionArchive, now) {
  const withArchivedClients = applyArchivedClientUsage(summary, settings?.archivedClientUsage, {
    activeClients: settings?.clients,
    now
  });
  const visibleSummary = settings?.sessionUsageArchiveEnabled === false
    ? withArchivedClients
    : applySessionUsageArchive(withArchivedClients, sessionArchive, { now });
  return settings?.projectsEnabled === false ? visibleSummary : applyProjectRollups(visibleSummary);
}

function summaryWithArchivedClientUsage(summary) {
  const now = sessionUsageArchiveDate(summary);
  if (settings?.sessionUsageArchiveEnabled === false) return summaryWithArchivesApplied(summary, null, now);
  if (isExternalAgentActive()) {
    sessionUsageArchive = null;
    return summaryWithArchivesApplied(summary, ensureSessionUsageArchiveLoaded(), now);
  }
  return summaryWithArchivesApplied(summary, updateSessionUsageArchive(summary, now), now);
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

function applyMacSpaceBehavior(trayMode = Boolean(settings?.trayMode)) {
  if (process.platform !== 'darwin' || !mainWindow || mainWindow.isDestroyed()) return;
  if (trayMode) {
    setMoveToActiveSpace(mainWindow, false);
    if (typeof mainWindow.setVisibleOnAllWorkspaces === 'function') {
      mainWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true
      });
    }
    if (typeof mainWindow.setHiddenInMissionControl === 'function') {
      mainWindow.setHiddenInMissionControl(true);
    }
  } else {
    if (typeof mainWindow.setVisibleOnAllWorkspaces === 'function') {
      mainWindow.setVisibleOnAllWorkspaces(false);
    }
    if (typeof mainWindow.setHiddenInMissionControl === 'function') {
      mainWindow.setHiddenInMissionControl(false);
    }
    // Apply this last because Electron's workspace/Mission Control setters also
    // update NSWindow.collectionBehavior.
    setMoveToActiveSpace(mainWindow, true);
  }
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
  const historyDevices = settings?.historyEnabled === false ? [] : devices;
  const history = aggregateHistory(historyDevices);
  stats.historyPreview = historyPreview(history);
  stats.historyRevision = historyRevision(history);
  stats.deviceHistoryRevision = deviceHistoryRevision(historyDevices);
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
let latestHubStatsReceivedAt = null;
let latestHubStatsSource = 'none';
let latestHubStatsGeneration = null;
let latestHubStatsIdentity = null;
let hubModeGeneration = 0;
let tray = null;
let latestStats = null;
let macWidgetSnapshotController = null;
let macWidgetDemand = null;
let macWidgetPublicationReady = false;
let cachedMacWidgetConfiguration;
let trayRefreshInFlight = false;
let trayCodexActiveAccountId = '';
let trayCodexPendingAccountId = '';

function electronPresentationStats(stats) {
  return projectLimitStatsForDisplay(stats, {
    localDeviceId: settings?.deviceId,
    syncActive: mode === 'sync' || Boolean(String(settings?.hubUrl || '').trim()),
    opencodeLocalLimitsEnabled: settings?.opencodeLocalLimitsEnabled === true
  });
}
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

function hubModeRequestIsCurrent(generation, expectedMode, expectedIdentity = null) {
  return generation === hubModeGeneration
    && settings?.hubMode === expectedMode
    && (expectedIdentity === null || currentHubStatsIdentity(expectedMode) === expectedIdentity);
}

function currentHubStatsIdentity(expectedMode = settings?.hubMode) {
  const { url } = effectiveHubConfig();
  return `${String(expectedMode || 'none')}|${String(url || 'none').replace(/\/$/, '')}`;
}

function currentHubStatsCache() {
  const hubMode = settings?.hubMode || 'local';
  const expectedSource = hubMode === 'host'
    ? 'host'
    : hubMode === 'client'
      ? 'client'
      : 'none';
  if (!latestHubStats
    || latestHubStatsSource !== expectedSource
    || latestHubStatsGeneration !== hubModeGeneration
    || latestHubStatsIdentity !== currentHubStatsIdentity(hubMode)) {
    return null;
  }
  return latestHubStats;
}

function clearLatestHubStatsCache() {
  latestHubStats = null;
  latestHubStatsReceivedAt = null;
  latestHubStatsSource = 'none';
  latestHubStatsGeneration = null;
  latestHubStatsIdentity = null;
}

function setLatestHubStatsCache(stats, source, generation, identity) {
  latestHubStats = stats;
  latestHubStatsReceivedAt = new Date().toISOString();
  latestHubStatsSource = source;
  latestHubStatsGeneration = generation;
  latestHubStatsIdentity = identity;
}

const diagnosticSnapshotBuilder = createDiagnosticSnapshotBuilder({
  getSettings: () => settings,
  getMode: () => mode,
  getEffectiveHubConfig: effectiveHubConfig,
  getExternalAgentActive: isExternalAgentActive,
  getDeviceRuntime: () => deviceRuntimeHandle,
  getEmbeddedHub: () => embeddedHub,
  getStreamState: () => ({ connected: streamConnected, failure: streamFailure }),
  getLatestHubStats: () => latestHubStats,
  getLatestHubStatsReceivedAt: () => latestHubStatsReceivedAt,
  getLatestHubStatsSource: () => latestHubStatsSource,
  getLatestHubStatsGeneration: () => latestHubStatsGeneration,
  getLatestHubStatsIdentity: () => latestHubStatsIdentity,
  getHubModeGeneration: () => hubModeGeneration,
  getCurrentHubStatsIdentity: (hubMode) => currentHubStatsIdentity(hubMode),
  getLocalRecord: localArchiveSourceDevice,
  getTokscaleStatus,
  getConfiguration: () => diagnosticConfigurationFromSettings(settings || {}, {
    usage: {
      agentVersion: appVersion(),
      agentRuntime: 'electron-widget',
      commandTimeoutMs: 120 * 1000,
      defaultDeviceId: defaultDeviceId(),
      intervalMs: collectorIntervalMs(),
      historyIntervalMs: normalizeHistoryIntervalMs(settings?.historyIntervalMs)
    },
    limits: {
      env: process.env,
      defaultLimitProviders: defaultLimitProviders()
    },
    syncUploadIntervalMs: syncUploadIntervalMs()
  }),
  getJournalSnapshot: () => diagnosticJournal.getSnapshot(),
  getArchiveState: () => {
    const enabled = settings?.sessionUsageArchiveEnabled !== false;
    const loaded = sessionUsageArchive !== null;
    return {
      enabled,
      loaded,
      sessionCount: loaded ? Object.keys(sessionUsageArchive?.sessions || {}).length : null,
      countSource: loaded ? 'loaded-memory' : enabled ? 'not-loaded' : 'not-enabled',
      lastUpdate: lastSessionUsageArchiveUpdate
    };
  },
  getAppVersion: appVersion,
  getDefaultDeviceId: defaultDeviceId,
  canRefreshUsageRuntime,
  getAppState: () => ({
    packaged: app.isPackaged,
    preferredLanguages: typeof app.getPreferredSystemLanguages === 'function'
      ? app.getPreferredSystemLanguages()
      : [app.getLocale?.() || 'en'],
    locale: app.getLocale?.() || 'en'
  })
});

const diagnosticReportGenerator = createDiagnosticReportGenerator({
  getAppMetrics: () => app.getAppMetrics(),
  getSystemMemory: () => ({ total: os.totalmem(), free: os.freemem() }),
  privateMemorySupported: process.platform === 'win32',
  getSnapshot: ({ generatedAt }) => diagnosticSnapshotBuilder.build(generatedAt),
  getArchiveFileStat: async () => {
    if (settings?.sessionUsageArchiveEnabled === false) return { ok: false, code: 'archive-not-enabled' };
    try {
      const stat = await fs.promises.stat(sessionUsageArchivePath());
      return { ok: true, stat };
    } catch (error) {
      return { ok: false, code: error?.code === 'ENOENT' ? 'archive-not-present' : 'archive-stat-failed' };
    }
  }
});

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

function rememberPendingLimitInvalidation(scope, reason, options = {}) {
  const clear = options.clear === true;
  const refresh = options.refresh !== false;
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
    rememberPendingLimitInvalidation(scope, reason, { clear, refresh });
    return Promise.resolve({ queued: true });
  }
  return runLimitInvalidation(deviceRuntimeHandle, scope, reason, { clear, refresh });
}

function drainPendingLimitInvalidations(runtime) {
  const pending = [...pendingLimitInvalidations.values()];
  pendingLimitInvalidations.clear();
  for (const entry of pending) {
    void runLimitInvalidation(runtime, entry.scope, entry.reason, entry).catch((error) => {
      console.log(`[limits-runtime] pending refresh failed: ${error.message}`);
    });
  }
}

function refreshUsageClient(clientId, options = {}) {
  const client = String(clientId || '').trim().toLowerCase();
  const tracked = trackedClientSet(clientsCsvForSetting(settings?.clients));
  if (!client || !KNOWN_CLIENTS.split(',').includes(client) || !tracked.has(client)) {
    throw new TypeError(`Unsupported targeted usage client: ${client || '(empty)'}`);
  }
  if (!deviceRuntimeHandle) {
    pendingUsageClientRefreshes.set(client, { clientId: client, options: { ...options } });
    return Promise.resolve({ queued: true });
  }
  return Promise.resolve(deviceRuntimeHandle.refreshClient(client, options));
}

function bestEffortTrackedUsageRefresh(clientId, options = {}) {
  const client = String(clientId || '').trim().toLowerCase();
  const tracked = trackedClientSet(clientsCsvForSetting(settings?.clients));
  if (
    !tracked.has(client)
    || !canRefreshUsageRuntime(mode, isExternalAgentActive)
  ) return;
  try {
    void refreshUsageClient(client, options).catch((error) => {
      console.log(`[usage-runtime] credential refresh failed: ${error.message}`);
    });
  } catch (error) {
    console.log(`[usage-runtime] credential refresh failed: ${error.message}`);
  }
}

function drainPendingUsageClientRefreshes(runtime) {
  drainPendingUsageClientRefreshQueue(
    pendingUsageClientRefreshes,
    runtime,
    (error) => {
      console.log(`[usage-runtime] pending client refresh failed: ${error.message}`);
    },
    { enabled: canRefreshUsageRuntime(mode, isExternalAgentActive) }
  );
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

async function getHubBuildStatus() {
  if (settings?.hubMode !== 'client') return { status: 'notConfigured', runtime: '', hubUrl: '' };
  const hubUrl = String(settings.hubUrl || '').trim();
  return probeHubBuild(hubUrl);
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

function ownsUsageRuntime() {
  return Boolean(
    deviceRuntimeHandle
    && canRefreshUsageRuntime(mode, isExternalAgentActive)
  );
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

// ---------------------------------------------------------------------------
// Shared subscriptions
//
// A subscription describes an account, not a machine, so devices that share a hub
// share ONE list rather than each carrying a copy. settings.subscriptions stays
// the local store in local mode, and doubles as the last-known cache in sync mode
// so a hub that is unreachable at startup shows the records instead of an empty
// list. The hub is the authority whenever it answers; writes made while it does
// not answer are refused rather than written locally, because a local write would
// fork the shared list with no way to tell later which side was right.
// ---------------------------------------------------------------------------

let hubSubscriptions = null;
// Which hub the document in hand came from. Without it, switching to a hub that
// cannot be reached kept showing the previous hub's records as though they were
// this one's.
let hubSubscriptionsHub = '';
// One lane per hub for its reads and writes, the same way startMode() serializes
// hub-side work. Discarding whichever answer came back last is not enough: a read
// that STARTS after a write can still observe the state before it, come back
// first, and leave the write invisible on screen and in settings.json. Only
// ordering the operations themselves removes that.
//
// Ordering is not re-basing, though. A write queued behind another does NOT adopt
// whatever version that one left: its list was built from a particular version,
// and if what ran ahead of it pulled in another device's records, writing over
// them under their own token is the silent erase this design exists to prevent.
// Each write carries the version it was built from and is refused if that has
// moved on.
//
// Per hub rather than one lane for all of them, because ordering is only worth
// anything against a single shared document: two hubs hold two documents with no
// ordering between them, and a hub that accepts the connection but answers
// slowly would otherwise hold up the hub the user is actually looking at.
const subscriptionQueues = new Map();
// The last version this device tried to catch up to, and when. Only a failed
// attempt is ever seen twice — a successful one leaves the document in hand
// matching the stamp, which settles it before this is consulted.
let lastSubscriptionCatchUp = { hub: '', version: '', at: 0 };
const SUBSCRIPTION_RETRY_MS = 60000;

function subscriptionsAreShared() {
  return settings?.hubMode === 'client' || settings?.hubMode === 'host';
}

// The document in hand, but only when it is the one this hub answered with.
// Everything that reads it has to ask, because the two are not kept in step: a
// switch to another hub and back leaves that hub's document installed while the
// first is in front of the user again, until its own refresh replaces it.
// Neither the records in it nor the updatedAt on it describe the hub being asked
// about, and both are load-bearing — one is what gets written, the other is what
// the hub checks it against.
function subscriptionsDocumentFor(hub) {
  return hubSubscriptionsHub === hub ? hubSubscriptions : null;
}

function effectiveSubscriptions() {
  if (!subscriptionsAreShared()) return settings.subscriptions || [];
  const hub = currentHubIdentity();
  const doc = subscriptionsDocumentFor(hub);
  if (doc) return doc.subscriptions;
  // The on-disk copy only answers for this hub, or for no hub at all — in which
  // case it is this device's own list, waiting to be seeded. Another hub's
  // records are not an answer to "what is on this one", so nothing is shown
  // rather than something wrong.
  const cacheHub = String(settings.subscriptionsCacheHub || '');
  return cacheHub === hub || cacheHub === '' ? (settings.subscriptions || []) : [];
}

// Returns whether anything actually changed. Callers use that to decide whether
// to push settings at the renderer: a push re-renders the whole settings form,
// which would fight whatever the user is typing in it.
function cacheSharedSubscriptions(doc, hub) {
  // Identity counts as a change on its own: two hubs can hold the same
  // updatedAt — an empty one, most obviously, when neither has been written to —
  // and comparing timestamps alone left the marker pointing at the previous hub,
  // so an offline restart came back showing its records.
  const changed = (hubSubscriptions?.updatedAt || '') !== (doc.updatedAt || '')
    || String(settings.subscriptionsCacheHub || '') !== hub;
  hubSubscriptions = doc;
  hubSubscriptionsHub = hub;
  if (changed) {
    settings.subscriptions = doc.subscriptions;
    settings.subscriptionsCacheHub = hub;
    persistSubscriptionState();
  }
  return changed;
}

// saveSettings() rolls the WHOLE settings object back to its last persisted
// snapshot when the file cannot be written, so a failed write here would discard
// the set-aside records this refresh just computed along with the cache — and
// their notice would vanish until the next restart, with nothing on screen
// saying anything went wrong. Re-apply both: disk is behind, but what the user
// still has to decide about stays in front of them.
function persistSubscriptionState() {
  const subscriptions = settings.subscriptions;
  const orphaned = settings.subscriptionsOrphaned;
  const cacheHub = settings.subscriptionsCacheHub;
  if (saveSettings()) return true;
  settings.subscriptions = subscriptions;
  settings.subscriptionsOrphaned = orphaned;
  settings.subscriptionsCacheHub = cacheHub;
  console.log('[sync] subscription state could not be written to disk');
  return false;
}

function queueSubscriptionOp(run) {
  // Captured on the way in, not when the operation runs: it was decided against
  // the hub in front of the user now, and a switch before it starts turns it
  // into work about a hub they have left. Each operation is handed the identity
  // it was queued for so it can say what to do about that.
  const hub = currentHubIdentity();
  const previous = subscriptionQueues.get(hub) || Promise.resolve();
  const result = previous.then(() => run(hub), () => run(hub));
  // The lane has to survive a failed operation; the caller still sees the error.
  const lane = result.then(() => {}, () => {});
  subscriptionQueues.set(hub, lane);
  // Dropped once idle, so the map holds the hub in use and, briefly, whichever
  // one is still draining — not an entry per hub the user has ever typed.
  lane.then(() => { if (subscriptionQueues.get(hub) === lane) subscriptionQueues.delete(hub); });
  return result;
}

// The user can switch hubs while an operation is queued or in flight, and an
// answer about the hub they left is not an answer about the one they are on.
function subscriptionOpIsCurrent(hub) {
  return hub === currentHubIdentity();
}

// Reported rather than dropped: whatever the user was acting on is still on
// screen, and silence would read as done.
function hubChangedError() {
  return Object.assign(new Error('hub changed'), { code: 'hub_changed' });
}

function subscriptionsEndpoint() {
  const { url: hubUrl, secret } = effectiveHubConfig();
  if (!hubUrl) return null;
  return {
    url: `${hubUrl.replace(/\/$/, '')}/api/subscriptions`,
    headers: secret ? { authorization: `Bearer ${secret}` } : {}
  };
}

async function fetchSharedSubscriptions() {
  // A host-mode widget is the hub, so it reads its own store rather than looping
  // back over HTTP to itself — the same shortcut fetchHubStats() takes.
  if (settings.hubMode === 'host' && embeddedHub) return embeddedHub.hub.getSubscriptions();
  const endpoint = subscriptionsEndpoint();
  if (!endpoint) return null;
  // A hub that accepts the connection and then never answers would hold this
  // lane open for the rest of the session, and every later read and save for that
  // hub behind it. fetch() has no deadline of its own, so it gets the same 15s
  // the other hub requests use.
  const response = await fetch(endpoint.url, { headers: endpoint.headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

// The 409 body is the hub's current list, worth caching — but only while this is
// still the newest operation. A late rejection carrying an older document would
// otherwise overwrite a write that has already landed.
function staleSubscriptionWriteError(current, hub) {
  const error = new Error('stale_write');
  error.code = 'stale_write';
  if (current && subscriptionOpIsCurrent(hub)) cacheSharedSubscriptions(current, hub);
  return error;
}

function writeSharedSubscriptions(list, baseUpdatedAt) {
  return queueSubscriptionOp((hub) => {
    // Queued against one hub, reached the front of the lane after the user moved
    // to another. The list in hand is the one they were editing on the hub they
    // left, and hubSubscriptions now holds the new hub's updatedAt to base on, so
    // sending it would write one hub's records into another against a base that
    // was never read from it.
    if (!subscriptionOpIsCurrent(hub)) throw hubChangedError();
    return writeSharedSubscriptionsNow(list, hub, baseUpdatedAt);
  });
}

// Takes the hub and the base rather than reading either. The identity is the one
// this write was queued against; the base is the version the list was built from,
// which is the whole meaning of the token. Reading it here instead would answer
// "the newest version this process knows of", and pairing that with a list made
// from an older one is a write the hub has no way to refuse: the token is
// current, so it accepts, and whatever arrived in between is gone.
async function writeSharedSubscriptionsNow(list, hub, baseUpdatedAt) {
  // Which makes the base worth checking, not just carrying. A list built on a
  // version this process has already moved past is stale for exactly the reason
  // another device's write is, and the answer is the same one the hub would give:
  // re-read and redo. Held nothing for this hub and the caller claims a version,
  // and they read it somewhere else — another hub, before a switch back to this
  // one — which is not a version of this list at all.
  if (baseUpdatedAt !== (subscriptionsDocumentFor(hub)?.updatedAt || '')) {
    throw Object.assign(new Error('stale_write'), { code: 'stale_write' });
  }
  if (settings.hubMode === 'host' && embeddedHub) {
    try {
      const stored = embeddedHub.hub.setSubscriptions(list, baseUpdatedAt);
      if (subscriptionOpIsCurrent(hub)) cacheSharedSubscriptions(stored, hub);
      return;
    } catch (error) {
      if (error.code === 'stale_write') throw staleSubscriptionWriteError(error.current, hub);
      throw error;
    }
  }
  const endpoint = subscriptionsEndpoint();
  if (!endpoint) throw new Error('hub not configured');
  const response = await fetch(endpoint.url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...endpoint.headers },
    body: JSON.stringify({ subscriptions: list, baseUpdatedAt }),
    signal: AbortSignal.timeout(15_000)
  });
  // Someone else wrote the list since this device last read it. Overwriting would
  // erase their records silently, and they exist nowhere else.
  if (response.status === 409) throw staleSubscriptionWriteError(await response.json().catch(() => null), hub);
  if (!response.ok) {
    // The hub answered, so it is reachable — a 401 is the wrong secret and a 400
    // is a bad payload. Reporting either as "could not reach the hub" sends the
    // user looking at their network instead of their settings.
    const rejected = new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
    rejected.code = 'rejected';
    rejected.status = response.status;
    throw rejected;
  }
  const stored = await response.json();
  // The write succeeded, but if the user moved to another hub while it was in
  // flight this answer no longer describes what is in front of them.
  if (!subscriptionOpIsCurrent(hub)) return;
  cacheSharedSubscriptions(stored, hub);
}

// Records this device holds that the shared list does not have, or has
// differently. Comparing ids alone is not enough: a record edited here while the
// device was in local mode keeps its id, so the shared copy would silently win
// and the edit would be gone. Neither is folding them in automatically — the
// same plan entered separately on two machines has two ids, and merging those
// would double the monthly total. So both cases are set aside for the one person
// who can tell them apart.
function rememberOrphanedSubscriptions(local, doc) {
  const shared = new Map((doc.subscriptions || []).map((entry) => [entry.id, entry]));
  const orphans = (local || []).filter((entry) => {
    if (!entry?.id) return false;
    const match = shared.get(entry.id);
    return !match || JSON.stringify(match) !== JSON.stringify(entry);
  });
  const next = orphans.length > 0
    ? { hubUrl: currentHubIdentity(), records: orphans }
    : { hubUrl: '', records: [] };
  if (JSON.stringify(next) === JSON.stringify(orphanedSubscriptions())) return false;
  settings.subscriptionsOrphaned = next;
  return true;
}

// Which hub the set-aside records were held back from. Offering them to a
// different hub would file this device's records somewhere they never belonged.
// Trimmed the same way subscriptionsEndpoint() trims it, so a trailing slash the
// user typed does not read as a different hub and strand them.
function currentHubIdentity() {
  return String(effectiveHubConfig().url || '').replace(/\/$/, '');
}

function orphanedSubscriptions() {
  const stored = settings.subscriptionsOrphaned;
  // Tolerates the bare array this field held before it carried a hub.
  if (Array.isArray(stored)) return { hubUrl: '', records: stored };
  return { hubUrl: String(stored?.hubUrl || ''), records: Array.isArray(stored?.records) ? stored.records : [] };
}

// Empty unless they belong to the hub in front of the user right now: a set held
// back from another hub, or from before a switch to local mode, has nowhere to
// go, and offering to adopt it promises something that cannot happen.
function pendingOrphanedSubscriptions() {
  const { hubUrl, records } = orphanedSubscriptions();
  if (!subscriptionsAreShared() || hubUrl !== currentHubIdentity()) return [];
  return records;
}

async function adoptOrphanedSubscriptions() {
  // Nothing to decide about; the answer that counts is taken inside the lane.
  if (pendingOrphanedSubscriptions().length === 0) return settingsForRenderer();
  // Reading, merging and writing is one operation, so all three happen in one
  // turn of the lane. Merging outside it took the document as it stood before
  // whatever was already queued, and the write that followed then carried the
  // base that operation left behind — a pairing the hub has no way to refuse,
  // because the token is current. It accepts the write, and the records the other
  // operation added in between are gone with nothing to say they were dropped.
  await queueSubscriptionOp(async (hub) => {
    if (!subscriptionOpIsCurrent(hub)) throw hubChangedError();
    const orphans = pendingOrphanedSubscriptions();
    if (orphans.length === 0) return;
    // Same-id records replace rather than append: two entries sharing an id would
    // collapse on normalization anyway, and the local edit is the one being
    // adopted. Merging into another hub's document would carry its records into
    // this one as though they had been entered here; with none in hand the write
    // goes out claiming no base, which the hub answers with 409 rather than an
    // overwrite.
    const held = subscriptionsDocumentFor(hub);
    const merged = new Map((held?.subscriptions || []).map((entry) => [entry.id, entry]));
    for (const orphan of orphans) merged.set(orphan.id, orphan);
    await writeSharedSubscriptionsNow([...merged.values()], hub, held?.updatedAt || '');
    // Cleared in the same turn: between the write landing and this, the records
    // are on the hub and still marked as waiting for a decision here.
    settings.subscriptionsOrphaned = { hubUrl: '', records: [] };
    if (!saveSettings()) throw Object.assign(new Error('settings write failed'), { code: 'write_failed' });
  });
  return settingsForRenderer();
}

// Only the message survives the IPC boundary, so the outcome goes in it. The
// renderer needs these apart: another device winning means re-read and redo, a
// rejected write means fix the secret, and an unreachable hub means try later.
function subscriptionWriteFailureCode(error) {
  if (error?.code === 'stale_write') return 'stale_write';
  if (error?.code === 'rejected') return 'hub_rejected';
  if (error?.code === 'write_failed') return 'write_failed';
  if (error?.code === 'hub_changed') return 'hub_changed';
  return 'hub_unreachable';
}

function discardOrphanedSubscriptions() {
  settings.subscriptionsOrphaned = { hubUrl: '', records: [] };
  if (!saveSettings()) throw Object.assign(new Error('settings write failed'), { code: 'write_failed' });
  return settingsForRenderer();
}

function refreshSharedSubscriptions(options = {}) {
  // Nothing left to answer for a hub the user has moved off: the switch enqueues
  // its own refresh for the hub they moved to, and this one would only spend a
  // request to be discarded on arrival.
  return queueSubscriptionOp((hub) => (subscriptionOpIsCurrent(hub) ? refreshSharedSubscriptionsNow(options) : false));
}

async function refreshSharedSubscriptionsNow({ seedFromLocal = false } = {}) {
  if (!subscriptionsAreShared()) {
    const had = Boolean(hubSubscriptions);
    hubSubscriptions = null;
    hubSubscriptionsHub = '';
    return had;
  }
  // A document fetched from another hub is not an answer about this one, and
  // holding on to it is what made an unreachable new hub show the old one's list.
  const hub = currentHubIdentity();
  if (hubSubscriptions && hubSubscriptionsHub !== hub) {
    hubSubscriptions = null;
    hubSubscriptionsHub = '';
  }

  try {
    // Only records this device actually owns may be seeded or set aside. Once
    // settings.subscriptions is a cache of some hub it is that hub's data, and
    // carrying it into the next hub would file one hub's records on another —
    // duplicating accounts that were never entered here. Switching to local mode
    // and editing hands ownership back, which is what clears the marker.
    // A marked cache is some hub's data, never this device's — including the hub
    // in front of us, whose own list is exactly what the cache holds. Only an
    // unmarked list is owned here and eligible to be seeded or set aside.
    const local = settings.subscriptionsCacheHub ? [] : (settings.subscriptions || []);
    const doc = await fetchSharedSubscriptions();
    if (!doc) return false;
    // Nothing else can have run against the hub in the meantime — the lane saw to
    // that — but the user may have switched hubs while this request was waiting,
    // and applying it would show one hub's records under another's name.
    if (!subscriptionOpIsCurrent(hub)) return false;
    // A hub nobody has ever written to: adopt this device's records rather than
    // replacing them with nothing. Keyed on updatedAt rather than on the list
    // being empty — an empty list WITH a timestamp is somebody's delete, and
    // re-uploading a stale cache over it resurrects what they removed.
    if (seedFromLocal && !doc.updatedAt && local.length > 0) {
      const previous = hubSubscriptions;
      const previousHub = hubSubscriptionsHub;
      hubSubscriptions = doc;
      hubSubscriptionsHub = hub;
      try {
        // The document just fetched is the base by definition: it is what this
        // hub answered a moment ago, and an unwritten hub answers with no token.
        await writeSharedSubscriptionsNow(local, hub, doc.updatedAt || '');
        return true;
      } catch (error) {
        // The seed failed, so the empty document must not stay installed: in
        // shared mode it is what the UI reads, and the user would watch every
        // record they entered vanish with only a console line to explain it.
        hubSubscriptions = previous;
        hubSubscriptionsHub = previousHub;
        throw error;
      }
    }
    // Joining a hub that already holds records. Until this moment the local list
    // was this device's own data, not a cache of the hub's, so anything missing
    // from the shared list is set aside for the user rather than overwritten.
    // Only recompute while there is something owned here to compare. Running it
    // against an empty list would answer "no differences" and quietly clear a set
    // of records the user has not decided about yet — which is what a second
    // reconcile against the same hub used to do.
    const orphansChanged = seedFromLocal && local.length > 0
      ? rememberOrphanedSubscriptions(local, doc)
      : false;
    const changed = cacheSharedSubscriptions(doc, hub);
    if (orphansChanged && !changed) persistSubscriptionState();
    return changed || orphansChanged;
  } catch (error) {
    console.log(`[sync] subscriptions unavailable: ${error.message}`);
    return false;
  }
}

// Every hub stamps its stats with the version of the list it holds, so an edit
// made on another device announces itself on the frames this one already
// receives instead of being polled for. Both paths carry it — the stream while
// it is up, and the widget's own stats read when it is not — and nothing is
// fetched unless the versions disagree, so the steady state costs no requests at
// all. This is the whole mechanism; there is no periodic subscription read
// behind it.
//
// A missing stamp means no news rather than an empty list: it is also what a
// local collector's own stats look like. Reading it as "the hub has nothing"
// would throw away the records on screen.
//
// The stamp is not compared against an operation already in flight for this hub,
// because what that operation will leave behind is not known yet. It is carried
// into the lane and compared there instead — see runSubscriptionCatchUp().
function maybeAdoptSharedSubscriptionRevision(stats) {
  if (!subscriptionsAreShared()) return;
  const revision = stats?.subscriptionsUpdatedAt;
  if (typeof revision !== 'string') return;
  const hub = currentHubIdentity();
  if (revision === (subscriptionsDocumentFor(hub)?.updatedAt || '')) return;
  // Getting this far twice for the same version means the last attempt did not
  // land it. Frames arrive on every ingest from every device, so retrying on each
  // one would turn a hub that serves /api/stats but not /api/subscriptions into a
  // request loop. A version that moves is news again and is tried at once — the
  // wait is a floor on retries, not a polling interval. Paired with its hub for
  // the reason every version here is: on its own it cannot say which list it
  // describes.
  const now = Date.now();
  if (hub === lastSubscriptionCatchUp.hub
    && revision === lastSubscriptionCatchUp.version
    && now - lastSubscriptionCatchUp.at < SUBSCRIPTION_RETRY_MS) return;
  lastSubscriptionCatchUp = { hub, version: revision, at: now };
  runSubscriptionCatchUp(revision);
}

// Queued rather than run, and the version is compared again once it is this
// operation's turn. By then whatever was in flight has finished and cached its
// result, which is the only thing that can tell the two cases apart: this
// device's own write leaves the document at exactly the version the hub
// broadcast, so there is nothing left to fetch, while a read that was already in
// flight when the broadcast landed leaves an older one and the fetch happens.
// Comparing before queueing cannot distinguish them — it would either re-fetch
// every write this device makes, or discard the only notice of another device's.
//
// refreshSharedSubscriptionsNow() rather than refreshSharedSubscriptions(): the
// lane is held by this operation, so the queueing wrapper would wait on itself.
//
// Deliberately not seeded from local: seeding and setting records aside belong
// to joining a hub, and doing either here would re-answer a question the user
// has already been asked.
function runSubscriptionCatchUp(revision) {
  return queueSubscriptionOp((hub) => {
    if (!subscriptionOpIsCurrent(hub)) return false;
    if (revision === (subscriptionsDocumentFor(hub)?.updatedAt || '')) return false;
    return refreshSharedSubscriptionsNow();
  })
    .then((changed) => { if (changed) pushSettingsToRenderer(); })
    .catch(() => {});
}

// base is the version the renderer's list was built from AND the hub that issued
// it, sent back together. The alternative is to read the current version here,
// which would let an edit made against the list on screen go out claiming a
// version that arrived after it — the hub accepts that, and whatever the newer
// version added is lost.
async function saveSubscriptions(list, base) {
  // Before the modes divide, because the answer applies to both. Local mode has
  // no hub, so its identity is the empty one — which makes it a context of its
  // own rather than a continuation of whichever hub was last configured, and an
  // edit composed against a hub's list is not an edit to this device's own. The
  // check below could not do this on its own: it only runs once a hub is
  // configured, and the write it guards is the one that never reaches a hub.
  if (String(base?.hub || '') !== currentHubIdentity()) throw hubChangedError();
  if (!subscriptionsAreShared()) {
    settings.subscriptions = subscriptionDisplay.normalizeSubscriptions(list, { currencyApi: { normalizeCurrency } });
    // Editing here makes the list this device's own again, so a later hub join
    // offers these records instead of treating them as some other hub's cache.
    settings.subscriptionsCacheHub = '';
    // saveSettings() rolls the whole object back when the file cannot be
    // written, so reporting success here would tell the user their record was
    // stored while it was being discarded.
    if (!saveSettings()) {
      const error = new Error('settings write failed');
      error.code = 'write_failed';
      throw error;
    }
    return settingsForRenderer();
  }
  // The hub is checked at all — rather than left to the version — because a
  // version cannot answer for it: two hubs that have never been written to both
  // report no version, so an edit made against one would pass a version check
  // against the other and be written into a list it was never meant for.
  await writeSharedSubscriptions(list, String(base?.updatedAt || ''));
  return settingsForRenderer();
}

// `options` is forwarded verbatim to the runtime; the quit path passes
// `skipCloseWatchers` (see stopAll).
function stopSyncCollector(options = {}) {
  if (deviceRuntimeHandle) { try { deviceRuntimeHandle.stop(options); } catch (_) {} }
  deviceRuntimeHandle = null;
}

function startSyncCollector() {
  stopSyncCollector();
  if (!effectiveHubConfig().url) return;
  const widgetProducerOwner = captureMacWidgetProducerOwner();
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
        updateDiscordRpcDisplay(displayStats);
        sendPush({ event: 'stats', data: { type: 'stats', reason: 'local', stats: displayStats, at: new Date().toISOString() } }, { widgetProducerOwner });
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
    onDiagnosticEvent: recordDiagnosticEvent,
    onError: (error, reason) => console.log(`[sync-collector] ${reason}: ${error.message}`)
  }, {
    limitsDeps: electronLimitsDeps()
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
    onDiagnosticEvent: recordDiagnosticEvent,
    onError: (error, reason) => console.log(`[host-collector] ${reason}: ${error.message}`)
  }, {
    limitsDeps: electronLimitsDeps()
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
  const generation = hubModeGeneration;
  const widgetProducerOwner = captureMacWidgetProducerOwner();
  const cacheIdentity = currentHubStatsIdentity('host');
  // Host mode presents the same multi-device hub aggregate as connecting to a
  // remote hub, so it reuses the renderer's 'sync' status path (Live / synced
  // data). The in-process vs loopback distinction is internal to fetchStats.
  mode = 'sync';
  sendStatus(true);
  const emit = (stats, reason = 'hub') => {
    if (!hubModeRequestIsCurrent(generation, 'host', cacheIdentity)) return;
    setLatestHubStatsCache(stats, 'host', generation, cacheIdentity);
    updateDiscordRpcDisplay(stats);
    sendPush({ event: 'stats', data: { type: 'stats', reason, stats, at: new Date().toISOString() } }, { widgetProducerOwner });
  };
  embeddedHubUnsub = embeddedHub.hub.onStats((stats, reason) => emit(stats, reason || 'hub'));
  // Prime the renderer with the current snapshot so it isn't blank until the
  // first collector tick lands.
  emit(embeddedHub.hub.getStats(), 'snapshot');
}

// Detection status is about this machine's local files, so stamp the freshly
// collected local clientStatus, clientHealth AND wslStatus onto the local device
// in whatever stats we hand the renderer. This keeps the 采集 tags + WSL panel
// correct in sync/host mode without depending on the hub (or a remote Worker)
// being redeployed to preserve these fields.
function injectLocalDeviceStatus(stats) {
  if (!stats || !Array.isArray(stats.devices)) return stats;
  attachLocalPresentationNativeViews(stats, {
    lastCollectedDevice,
    seededLocalDevice: localDevice,
    mode
  });
  if (lastCollectedDevice) {
    const device = stats.devices.find((entry) => entry.deviceId === lastCollectedDevice.deviceId);
    if (device) {
      if (lastCollectedDevice.clientStatus) device.clientStatus = lastCollectedDevice.clientStatus;
      if (lastCollectedDevice.clientHealth) device.clientHealth = lastCollectedDevice.clientHealth;
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

function macWidgetConfiguration() {
  if (!macWidgetRuntimeSupported()) return null;
  if (cachedMacWidgetConfiguration !== undefined) return cachedMacWidgetConfiguration;

  let appGroup = String(process.env.TOKEN_MONITOR_APP_GROUP || '').trim();
  let urlScheme = String(process.env.TOKEN_MONITOR_WIDGET_URL_SCHEME || 'token-monitor').trim();
  let snapshotFileName = 'snapshot.json';
  let widgetKind = DEFAULT_WIDGET_KIND;
  const configCandidates = [
    path.join(process.resourcesPath, 'token-monitor-widget.json'),
    path.resolve(__dirname, '..', '..', 'build', 'macos-widget', 'widget-config.json')
  ];
  if (!appGroup) {
    for (const configPath of configCandidates) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        appGroup = String(config.appGroup || '').trim();
        urlScheme = String(config.urlScheme || urlScheme).trim();
        widgetKind = String(config.widgetKind || widgetKind).trim();
        snapshotFileName = String(config.snapshotFileName || snapshotFileName).trim();
        if (appGroup) break;
      } catch (_) {}
    }
  }
  const snapshotPath = resolveMacWidgetSnapshotPath({
    appGroup,
    home: app.getPath('home'),
    snapshotFileName
  });
  if (!snapshotPath) {
    cachedMacWidgetConfiguration = null;
    return cachedMacWidgetConfiguration;
  }
  cachedMacWidgetConfiguration = {
    appGroup,
    snapshotPath,
    widgetKind,
    urlScheme: (() => {
      try { return normalizeWidgetURLScheme(urlScheme); } catch (_) { return 'token-monitor'; }
    })()
  };
  return cachedMacWidgetConfiguration;
}

function macWidgetRuntimeSupported(
  platform = process.platform,
  osRelease = platform === 'darwin' ? os.release() : ''
) {
  return macWidgetRuntimeSupport({ platform, osRelease }).supported;
}

function historyResolverOptions() {
  const { url: hubUrl, secret } = effectiveHubConfig();
  return {
    aggregateHistory,
    embeddedHub,
    historyEnabled: settings?.historyEnabled !== false,
    hubMode: settings?.hubMode,
    hubUrl,
    // In sync/host mode the headless agent owns this machine's producer while its
    // PID is live. Do not let the widget's last pre-handoff snapshot compete with
    // the newer Hub record; local mode always owns its collector by contract.
    localDevice: ownsUsageRuntime() ? (lastCollectedDevice || localDevice) : null,
    mode,
    secret
  };
}

function getCompleteHistory() {
  return resolveCompleteHistory(historyResolverOptions());
}

function macWidgetPresentation() {
  return Object.freeze({
    currencyCode: settings?.currency,
    currencyRate: effectiveRates?.[normalizeCurrency(settings?.currency)] || 1,
    compactNumbers: settings?.showCompactTotalTokens !== false,
    compactTokenUnits: settings?.compactTokenUnits,
    showCost: true,
    locale: settings?.language,
    theme: Object.keys(settings?.themeColors || {}).length ? 'custom' : 'system'
  });
}

function ensureMacWidgetDemand() {
  if (process.platform !== 'darwin') return null;
  if (macWidgetDemand) return macWidgetDemand;
  const widget = macWidgetConfiguration();
  if (!widget) return null;
  // The demand leases live beside the snapshot in the app group container. The
  // widget extension touches the full marker on every timeline() request and
  // the short provisional marker on a non-gallery snapshot() (the add flow),
  // so a fresh marker here means "a Widget is on screen or being placed". The
  // watcher arms immediately so a first placement primes the initial snapshot
  // within moments; the reconcile poll catches anything the watcher missed.
  const markerDirectory = path.dirname(widget.snapshotPath);
  macWidgetDemand = createMacWidgetDemandState({
    markerPath: path.join(markerDirectory, WIDGET_DEMAND_MARKER),
    provisionalMarkerPath: path.join(markerDirectory, WIDGET_DEMAND_PROVISIONAL_MARKER),
    onActivation: () => {
      const visibleStats = electronPresentationStats(latestStats);
      scheduleMacWidgetSnapshot(visibleStats, captureMacWidgetProducerOwner());
    },
    logger: (message) => console.warn(message)
  });
  macWidgetDemand.start();
  return macWidgetDemand;
}

function captureMacWidgetWork({ stats, owner }) {
  const widget = macWidgetConfiguration();
  if (!widget) return null;
  // No Widget on screen means no WidgetKit render loop is asking for data, so
  // the whole snapshot pipeline (history resolution, serialization, fsync and
  // the reload helper spawn) can be skipped. Only a confirmed missing or stale
  // demand marker closes this gate; an unarmed state must not starve someone
  // who does have a Widget.
  if (macWidgetDemand && !macWidgetDemand.isInstalled()) return null;
  const resolverConfig = Object.freeze({ ...historyResolverOptions() });
  const sourceKey = macWidgetHistorySourceKey(resolverConfig);
  return {
    stats,
    owner: Object.freeze({
      epoch: owner.epoch,
      sourceKey
    }),
    resolverConfig,
    historyCachePath: completeHistorySource(resolverConfig) === 'remote'
      ? macWidgetHistoryCachePath(app.getPath('userData'), sourceKey)
      : null,
    presentation: macWidgetPresentation(),
    snapshotPath: widget.snapshotPath,
    widgetKind: widget.widgetKind
  };
}

function ensureMacWidgetSnapshotController() {
  if (!macWidgetRuntimeSupported()) return null;
  if (macWidgetSnapshotController) return macWidgetSnapshotController;
  macWidgetSnapshotController = createMacWidgetSnapshotController({
    startPaused: !macWidgetPublicationReady,
    captureWork: captureMacWidgetWork,
    resolveHistory: (work) => resolveMacWidgetHistory({
      generation: work.owner.epoch,
      sourceKey: work.owner.sourceKey,
      revision: work.stats?.historyRevision,
      fetchHistory: () => resolveCompleteHistory(work.resolverConfig),
      ...(work.historyCachePath ? {
        loadCachedHistory: () => readMacWidgetHistoryCache(
          work.historyCachePath,
          work.owner.sourceKey,
          { logger: (message) => console.warn(message) }
        ),
        saveCachedHistory: (history) => writeMacWidgetHistoryCache(
          work.historyCachePath,
          work.owner.sourceKey,
          history,
          { logger: (message) => console.warn(message) }
        )
      } : {}),
      minIntervalMs: completeHistorySource(work.resolverConfig) === 'remote' ? undefined : 0,
      logger: (message) => console.warn(message)
    }),
    prepareSnapshot: (work, history) => prepareMacWidgetSnapshotUpdate(work.stats, {
      snapshotPath: work.snapshotPath,
      snapshotOptions: {
        presentation: work.presentation,
        history
      },
      logger: (message) => console.warn(message)
    }),
    commitSnapshot: (prepared, options) => commitMacWidgetSnapshot(prepared, {
      isCurrent: options.isCurrent,
      logger: (message) => console.warn(message)
    }),
    syncSnapshot: (_work, committed, prepared) => syncMacWidgetSnapshotDirectory({
      ...committed,
      fs: prepared?.fs
    }),
    discardSnapshot: discardMacWidgetSnapshot,
    reloadSnapshot: (work, options) => requestMacWidgetReload({
      widgetKind: work.widgetKind,
      isCurrent: options.isCurrent,
      runtimeSupported: macWidgetRuntimeSupported(),
      logger: (message) => console.warn(message)
    }),
    logger: (message) => console.warn(message)
  });
  return macWidgetSnapshotController;
}

function captureMacWidgetProducerOwner() {
  return ensureMacWidgetSnapshotController()?.captureProducerOwner() || null;
}

function advanceMacWidgetProducerAndSourceEpoch() {
  ensureMacWidgetSnapshotController()?.advanceProducerAndSourceEpoch();
}

function advanceMacWidgetSourceEpoch() {
  ensureMacWidgetSnapshotController()?.advanceSourceEpoch();
}

function refreshMacWidgetHistorySource() {
  advanceMacWidgetSourceEpoch();
  const visibleStats = electronPresentationStats(latestStats);
  scheduleMacWidgetSnapshot(visibleStats, captureMacWidgetProducerOwner());
}

function scheduleMacWidgetSnapshot(stats, producerOwner) {
  if (!macWidgetRuntimeSupported() || !stats) return false;
  return ensureMacWidgetSnapshotController()?.enqueue({ stats, producerOwner }) || false;
}

// Two options, both for the cold-start seed and neither for live stats.
// `skipExport` keeps a republished snapshot from spending the auto-export
// interval that this run's first real scan needs. `deferToRenderer` waits for
// the renderer to finish loading, and is deliberately not the default: a live
// push that lands mid-load is already covered by the refreshStats() the renderer
// runs on init, so deferring every one of them would only queue a listener per
// frame against a slow load and then replay a burst of superseded stats.
function sendPush(payload, options = {}) {
  const previousHistoryRevision = statsHistoryRevision(latestStats);
  let rendererPayload = payload;
  if (payload?.data?.stats) {
    injectLocalDeviceStatus(payload.data.stats);
    latestStats = payload.data.stats;
    const visibleStats = electronPresentationStats(latestStats);
    rendererPayload = {
      ...payload,
      data: { ...payload.data, stats: visibleStats }
    };
    scheduleMacWidgetSnapshot(visibleStats, options.widgetProducerOwner);
    syncTrayCodexActiveAccount();
    updateTrayDisplay();
    if (!options.skipExport && settings.exportAutoEnabled && settings.exportDir && Date.now() - lastExportAt >= exportIntervalMs()) {
      lastExportAt = Date.now();
      writeExportTo(settings.exportDir, payload.data.stats.periods, { skipUnchanged: true })
        .catch((err) => console.warn(`[export] auto-export failed: ${err.message}`));
    }
  }
  if (options.deferToRenderer) {
    // Only while it is still the newest thing published. A slow load can outlast
    // the first real collection, and delivering the queued snapshot then would
    // walk the numbers backwards until the next push.
    const deferred = payload?.data?.stats;
    sendMainWindowEvent('stats:push', rendererPayload, () => !deferred || latestStats === deferred);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('stats:push', rendererPayload); } catch (_) {}
  }
  if (payload?.data?.stats) {
    const nextHistoryRevision = statsHistoryRevision(payload.data.stats);
    if (nextHistoryRevision !== previousHistoryRevision && dashboardWindow && !dashboardWindow.isDestroyed()) {
      try { dashboardWindow.webContents.send('dashboard:historyChanged'); } catch (_) {}
    }
    maybeAdoptSharedSubscriptionRevision(payload.data.stats);
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
  if (settings?.discordRpcEnabled && latestStats) updateDiscordRpcDisplay(latestStats);
  pushSettingsToRenderer();
}

function compactTokenDisplayOptions() {
  return {
    compactTokenUnits: settings?.compactTokenUnits,
    locale: trayMenuLocale()
  };
}

function updateDiscordRpcDisplay(stats) {
  updateDiscordRpc(stats, settings?.currency, compactTokenDisplayOptions());
}

function refreshTrayContextMenu() {
  if (!tray || tray.isDestroyed()) return;
  if (typeof tray.refreshContextMenu === 'function') tray.refreshContextMenu();
}

function updateTrayDisplay() {
  if (!tray || tray.isDestroyed()) return;
  // Keep the exported D-Bus menu in sync (radio checks, refresh state, Codex
  // accounts) — see the Linux note in createTray().
  refreshTrayContextMenu();
  const visibleStats = electronPresentationStats(latestStats);
  const mode = settings?.trayContent || 'tokens';
  const currency = normalizeCurrency(settings?.currency);
  const compactOptions = compactTokenDisplayOptions();
  const limitText = formatTrayText(visibleStats, mode, currency, {
    limitProviderOrder: settings?.limitProviderOrder,
    limitProviders: settings?.limitProviders,
    showLimitUsed: settings?.showLimitUsed,
    ...compactOptions
  });
  const barsImageMode = isBarsTrayIconMode(mode) && !limitText && providerTrayIcons[mode];
  // A renderer-generated icon is cached in the main process. Only reuse it
  // while the current stats still have quota text; otherwise it can outlive
  // the provider data that generated it.
  const trayImageMode = mode === 'limitsAllSessions' && Boolean(limitText) && providerTrayIcons[mode];
  const customImageMode = mode === 'custom' && providerTrayIcons.custom;
  const text = trayImageMode || customImageMode ? '' : limitText;
  if (trayShowsTitle(process.platform)) tray.setTitle(text);
  // Tooltip always shows a useful summary, even in icon-only mode where setTitle is blank.
  const tip = formatTrayText(visibleStats, 'both', currency, compactOptions);
  tray.setToolTip(`Token Monitor - ${tip}`);
  // Icon: rendered bars image in bar modes, otherwise the app icon.
  let icon = null;
  if (barsImageMode || trayImageMode || customImageMode) {
    icon = providerTrayIcons[mode];
  } else {
    const usageIconId = pickUsageTrayIconId(visibleStats, mode, Object.keys(providerTrayIcons));
    if (usageIconId) icon = providerTrayIcons[usageIconId];
  }
  tray.setImage(icon || getDefaultTrayIcon());
}

function recordDiagnosticEvent(event) {
  diagnosticJournal.record({
    ...event,
    modeAtEvent: settings?.hubMode || 'local'
  });
}

function sendStatus(connected, extra) {
  const previous = streamConnected;
  streamConnected = Boolean(connected);
  streamFailure = streamConnected ? null : ((extra && extra.reason) ? { reason: extra.reason, detail: extra.detail ?? null } : streamFailure);
  if (mode === 'sync') {
    if (streamConnected && !previous) {
      recordDiagnosticEvent({ subsystem: 'stream', code: 'stream-reconnected' });
    } else if (!streamConnected && (previous || extra?.reason)) {
      recordDiagnosticEvent({
        subsystem: 'stream',
        code: 'stream-disconnected',
        detailCode: diagnosticStreamDetailCode(extra || streamFailure || {})
      });
    }
  }
  sendPush({ event: 'status', data: { connected: streamConnected, mode, ...(extra || {}) } });
}

// `options` is forwarded verbatim to the runtime; the quit path passes
// `skipCloseWatchers` (see stopAll).
function stopLocalCollector(options = {}) {
  if (deviceRuntimeHandle) { try { deviceRuntimeHandle.stop(options); } catch (_) {} }
  deviceRuntimeHandle = null;
  localDevice = null;
  localStats = null;
}

// Show the last full scan's totals while the first one of this run is still
// going, instead of zeros for the tens of seconds it takes. deviceRecordFromAnchor
// owns the trust rules; anything it rejects leaves the renderer on its normal
// wait-for-real-data path.
function primeLocalStatsFromAnchor(usageOptions, widgetProducerOwner) {
  // Cold start only. startMode() re-enters here on structural settings changes
  // as well, and there the numbers already collected are newer than any anchor.
  if (lastCollectedDevice) return;
  const deviceRecord = deviceRecordFromAnchor(
    readJson(path.join(sharedDataDir(), 'collector-anchor.json'), null),
    {
      envelope: electronDeviceEnvelope(),
      clients: usageOptions.clients,
      allTimeSince: usageOptions.allTimeSince,
      projectsEnabled: usageOptions.projectsEnabled,
      wslScanEnabled: usageOptions.wslScanEnabled,
      wslSupported: process.platform === 'win32',
      hostname: os.hostname(),
      platform: `${process.platform}-${process.arch}`
    }
  );
  if (!deviceRecord) return;
  // The anchor holds raw collector output, while everything the renderer is ever
  // shown has been through the archives first. Project the same way or the seed
  // reads low for anyone with an un-tracked client or retained sessions, and then
  // jumps when the first scan lands. Read-only on purpose: the capture step
  // records a fresh observation, and an anchor from hours ago is not one.
  const visible = summaryWithArchivesApplied(
    deviceRecord,
    settings?.sessionUsageArchiveEnabled === false ? null : ensureSessionUsageArchiveLoaded(),
    sessionUsageArchiveDate(deviceRecord)
  );
  localDevice = visible;
  localStats = withHistoryPreview(aggregateDevices([visible], 0), [visible]);
  // Through the normal publisher, not straight to the renderer: the tray reads
  // what sendPush sets, and in tray mode the window is hidden, so a seed that
  // only reached the renderer would leave the one visible surface on zero.
  // This one waits for the renderer: it is the only stats push whose whole point
  // is to be on screen before the first scan, so it cannot be left to the
  // refreshStats() that covers the rest. It must also not spend the export
  // interval this run's first live scan needs on a snapshot it is republishing.
  sendPush({
    event: 'stats',
    data: { type: 'stats', reason: 'anchor', stats: localStats, at: deviceRecord.receivedAt }
  }, { skipExport: true, deferToRenderer: true, widgetProducerOwner });
}

function startLocalCollector() {
  stopLocalCollector();
  const widgetProducerOwner = captureMacWidgetProducerOwner();
  mode = 'local';
  sendStatus(false, { reason: 'collecting' });
  // One config object for both, so the fingerprint the seed validates against
  // cannot drift from the one the collector will compute.
  const usageOptions = electronUsageConfig('collector');
  primeLocalStatsFromAnchor(usageOptions, widgetProducerOwner);
  deviceRuntimeHandle = createDeviceRuntime({
    envelope: electronDeviceEnvelope(),
    initialLimits: lastCollectedDevice?.limits,
    limitsOptions: electronLimitsConfig(),
    transformUsage: summaryWithArchivedClientUsage,
    usageOptions,
    progressive: true,
    onRecord: (summary, meta) => {
      const reason = meta.reason;
      const visibleSummary = summary;
      localDevice = { ...visibleSummary, receivedAt: new Date().toISOString() };
      lastCollectedDevice = localDevice;
      localStats = withHistoryPreview(aggregateDevices([localDevice], 0), [localDevice]);
      attachLocalNativeViews(localStats, localDevice);
      updateDiscordRpcDisplay(localStats);
      sendPush({ event: 'stats', data: { type: 'stats', reason, stats: localStats, at: new Date().toISOString() } }, { widgetProducerOwner });
      sendStatus(true, { reason });
    },
    onDiagnosticEvent: recordDiagnosticEvent,
    onError: (error, reason) => sendStatus(false, { reason: `${reason}:${error.message}` })
  }, {
    limitsDeps: electronLimitsDeps()
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
  const generation = hubModeGeneration;
  const widgetProducerOwner = captureMacWidgetProducerOwner();
  if (settings?.hubMode !== 'client') return;
  const cacheIdentity = currentHubStatsIdentity('client');
  if (options.resetSnapshot) {
    clearLatestHubStatsCache();
  }
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
    if (!hubModeRequestIsCurrent(generation, 'client', cacheIdentity)) return;
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
      if (!hubModeRequestIsCurrent(generation, 'client', cacheIdentity)) return;
      const { value, done } = await reader.read();
      if (!hubModeRequestIsCurrent(generation, 'client', cacheIdentity)) return;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let parsed = parseSseChunk(chunk);
        if (parsed) {
          if (parsed.event === 'stats' && parsed.data?.stats) {
            setLatestHubStatsCache(parsed.data.stats, 'client', generation, cacheIdentity);
            const displayStats = composeLocalSyncStats(latestHubStats, lastCollectedDevice);
            parsed = { ...parsed, data: { ...parsed.data, stats: displayStats } };
            updateDiscordRpcDisplay(displayStats);
          }
          sendPush(parsed, { widgetProducerOwner });
        }
      }
    }
    if (!hubModeRequestIsCurrent(generation, 'client', cacheIdentity)) return;
    sendStatus(false, classifyStreamFailure({ eof: true }));
    scheduleStreamRetry();
  } catch (error) {
    if (controller.signal.aborted || !hubModeRequestIsCurrent(generation, 'client', cacheIdentity)) return;
    sendStatus(false, classifyStreamFailure({ errorCode: error?.cause?.code || error?.code, message: error?.message }));
    scheduleStreamRetry();
  }
}

function showPopover() {
  if (!mainWindow || mainWindow.isDestroyed() || !tray) return;
  applyMacActivationPolicy();
  applyMacSpaceBehavior(true);
  applyWindowSettings();
  const current = mainWindow.getBounds();
  const target = popoverBounds(tray, current.width, current.height);
  mainWindow.setBounds(target);
  suppressNextBlurHide = true;
  mainWindow.show();
  // The focus event itself may not fire a blur; the suppress flag covers the
  // case where macOS fires blur immediately after show because the click that
  // opened us still has the menu bar as the focused element.
  setTimeout(() => { suppressNextBlurHide = false; }, 250);
}

function openMainWindowFromWidget() {
  if (!app.isReady()) return;
  const destination = pendingMacWidgetOpen || { page: 'overview', view: 'home', settings: false };
  pendingMacWidgetOpen = null;
  updateRendererViewState({ breakdown: destination.view });
  applyMacActivationPolicy({ mainWindowVisible: true });
  // Closing the window with the tray icon off destroys it while macOS keeps the
  // app alive, so a widget click has to be able to build one again — the same
  // recovery focusExistingWindow() performs for the dock and the shortcut.
  // Bailing out instead consumed the open-url event and left the widget dead
  // for the rest of the session, since nothing else reads pendingMacWidgetOpen.
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const sendDestination = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (destination.settings) mainWindow.webContents.send('settings:open');
    else mainWindow.webContents.send('view:open', destination.view);
  };
  if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', sendDestination);
  else sendDestination();
  if (settings?.trayMode && tray) {
    showPopover();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  applyMacSpaceBehavior(false);
  // A collapsed bubble would otherwise swallow the navigation we just sent.
  if (floatingBubbleState.collapsed) expandFloatingBubble();
  else mainWindow.show();
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
  else {
    applyMacSpaceBehavior(false);
    if (floatingBubbleState.collapsed) expandFloatingBubble();
    else {
      mainWindow.show();
      restoreWindowMaximized(mainWindow, settings);
    }
  }
}

function currentWindowToggleShortcutStatus() {
  const shortcut = normalizeWindowToggleShortcut(settings?.windowToggleShortcut);
  const registered = windowToggleShortcutRegistered && registeredWindowToggleShortcut === shortcut;
  return windowToggleShortcutStatus(shortcut, registered);
}

// Strip OpenCode session cookies from a profiles map before it reaches the
// renderer; the UI only needs the profile name and enabled flag, not the value.
// Default-deny: name every field allowed through instead of spreading the stored
// profile. A spread hands any field added later to the renderer verbatim, which
// is exactly how a credential leaks.
function redactOpencodeProfilesForRenderer(profiles) {
  if (!profiles || typeof profiles !== 'object') return profiles;
  const out = Object.create(null);
  for (const [name, profile] of Object.entries(profiles)) {
    out[name] = {
      enabled: profile?.enabled !== false,
      cookie: profile?.cookie ? 'set' : '',
      apiKey: profile?.apiKey ? 'set' : ''
    };
  }
  return out;
}

function redactOpenRouterProfilesForRenderer(profiles) {
  if (!profiles || typeof profiles !== 'object') return profiles;
  const out = Object.create(null);
  for (const [name, profile] of Object.entries(profiles)) {
    out[name] = { enabled: profile?.enabled !== false, apiKey: profile?.apiKey ? 'set' : '' };
  }
  return out;
}

function redactThirdPartyProfilesForRenderer(profiles) {
  if (!profiles || typeof profiles !== 'object') return profiles;
  const out = Object.create(null);
  for (const [name, profile] of Object.entries(profiles)) {
    const adapter = thirdPartyLimits.normalizeAdapterId(profile?.adapter);
    out[name] = {
      enabled: profile?.enabled !== false,
      adapter,
      baseUrl: thirdPartyLimits.normalizeThirdPartyBaseUrl(profile?.baseUrl, {
        stripTerminalV1: adapter !== thirdPartyLimits.CUSTOM_BALANCE_ADAPTER
      }),
      userId: String(profile?.userId || '').trim(),
      ...(adapter === thirdPartyLimits.CUSTOM_BALANCE_ADAPTER
        ? {
            endpointPath: thirdPartyLimits.normalizeCustomEndpointPath(profile?.endpointPath),
            authMode: thirdPartyLimits.normalizeCustomAuthMode(profile?.authMode),
            remainingPath: thirdPartyLimits.normalizeCustomJsonPath(profile?.remainingPath),
            usedPath: thirdPartyLimits.normalizeCustomJsonPath(profile?.usedPath),
            totalPath: thirdPartyLimits.normalizeCustomJsonPath(profile?.totalPath),
            currency: thirdPartyLimits.normalizeCustomCurrency(profile?.currency),
            divisor: thirdPartyLimits.normalizeCustomDivisor(profile?.divisor)
          }
        : {}),
      accessToken: profile?.accessToken ? 'set' : '',
      apiKey: profile?.apiKey ? 'set' : ''
    };
  }
  return out;
}

function settingsForRenderer() {
  const claudeWebCookieSource = settings?.claudeWebCookie
    ? 'settings'
    : claudeWebCookie(process.env)
      ? 'env'
      : '';
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
  const commandcodeCookieSource = settings?.commandcodeCookie
    ? 'settings'
    : commandcodeCookie(process.env)
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
    locale: trayMenuLocale(),
    ...redactedCredentials,
    // On a hub the shared list is the truth; settings.subscriptions is only the
    // last-known cache behind it.
    subscriptions: effectiveSubscriptions(),
    subscriptionsShared: subscriptionsAreShared(),
    // Which version of the shared list the one above was taken from, so an edit
    // built on it can say what it was built on rather than inheriting whatever
    // this process holds by the time the write goes out — and which hub issued
    // that version, because it does not mean anything without one.
    subscriptionsHub: currentHubIdentity(),
    subscriptionsUpdatedAt: subscriptionsDocumentFor(currentHubIdentity())?.updatedAt || '',
    subscriptionsOrphaned: pendingOrphanedSubscriptions(),
    zaiApiRegion: normalizeZaiApiRegion(settings?.zaiApiRegion || 'global'),
    zaiTeamOrganizationId: settings?.zaiTeamOrganizationId ? 'set' : '',
    zaiTeamProjectId: settings?.zaiTeamProjectId ? 'set' : '',
    volcengineAccessKeyId: settings?.volcengineAccessKeyId ? 'set' : '',
    claudeWebCookie: settings?.claudeWebCookie ? 'set' : '',
    qoderCookie: settings?.qoderCookie ? 'set' : '',
    commandcodeCookie: settings?.commandcodeCookie ? 'set' : '',
    ollamaCookie: settings?.ollamaCookie ? 'set' : '',
    // Never ship OpenCode session cookies to the renderer; the UI only needs to
    // know whether a cookie is configured, not its value.
    opencodeCookie: settings?.opencodeCookie ? 'set' : '',
    ...(settings?.opencodeProfiles
      ? { opencodeProfiles: redactOpencodeProfilesForRenderer(settings.opencodeProfiles) }
      : {}),
    ...(settings?.openrouterProfiles
      ? { openrouterProfiles: redactOpenRouterProfilesForRenderer(settings.openrouterProfiles) }
      : {}),
    ...(settings?.thirdPartyProfiles
      ? { thirdPartyProfiles: redactThirdPartyProfilesForRenderer(settings.thirdPartyProfiles) }
      : {}),
    openrouterEnvConfigured: Boolean(openrouterLimits.openrouterToken(process.env)),
    thirdPartyEnvConfigured: thirdPartyLimits.configuredAccounts({}, { env: process.env }).length > 0,
    codexManagedAccounts: codexAccountsForRenderer(),
    mimoManagedAccounts: mimoAccountsForRenderer(),
    claudeWebCookieConfigured: Boolean(currentClaudeWebCookie()),
    claudeWebCookieSource,
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
    commandcodeCookieConfigured: Boolean(currentCommandcodeCookie()),
    commandcodeCookieSource,
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

// The tray sits in system-integrated UI (menubar / taskbar / panel), whose theme
// is independent of the app's own: Windows lets the system be dark while apps
// stay light, which is exactly the case a plain `shouldUseDarkColors` gets wrong.
// That dedicated property only exists on darwin and win32, so elsewhere the app
// theme is the closest signal available.
function systemDarkTrayUi() {
  try {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const systemIntegrated = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
      if (typeof systemIntegrated === 'boolean') return systemIntegrated;
    }
    return nativeTheme.shouldUseDarkColors === true;
  } catch (_) {
    return false;
  }
}

const WINDOWS_PERSONALIZE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

function readWindowsSystemDarkUi() {
  return new Promise((resolve) => {
    try {
      require('node:child_process').execFile(
        'reg',
        ['query', WINDOWS_PERSONALIZE_KEY, '/v', 'SystemUsesLightTheme'],
        { windowsHide: true, timeout: 5000 },
        (error, stdout) => resolve(error ? null : parseWindowsSystemUsesLightTheme(stdout))
      );
    } catch (_) {
      resolve(null);
    }
  });
}

// The value the renderer last heard, so a settled reading can be told from a
// repeat of the one we already published.
let currentSystemDarkUi = null;

function currentSystemDarkTrayUi() {
  if (currentSystemDarkUi === null) currentSystemDarkUi = systemDarkTrayUi();
  return currentSystemDarkUi;
}

function pushSystemUiThemeToRenderer(dark) {
  const value = typeof dark === 'boolean' ? dark : currentSystemDarkTrayUi();
  currentSystemDarkUi = value;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('theme:systemUi', { dark: value }); } catch (_) {}
}

// Windows cannot answer this at event time — see watchSystemDarkUi in tray.js
// for what was measured. Everywhere else the event already carries the truth.
let systemUiThemeRevision = 0;

async function pushSystemUiThemeAfterChange() {
  if (process.platform !== 'win32') {
    pushSystemUiThemeToRenderer(systemDarkTrayUi());
    return;
  }
  const revision = ++systemUiThemeRevision;
  await watchSystemDarkUi({
    read: readWindowsSystemDarkUi,
    wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    isCurrent: () => revision === systemUiThemeRevision,
    held: currentSystemDarkTrayUi(),
    publish: (dark) => pushSystemUiThemeToRenderer(dark)
  });
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

function refreshLimitStatsPresentation() {
  if (!latestStats) return;
  const visibleStats = electronPresentationStats(latestStats);
  scheduleMacWidgetSnapshot(visibleStats, captureMacWidgetProducerOwner());
  updateTrayDisplay();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('stats:push', {
        event: 'stats',
        data: { type: 'stats', reason: 'presentation', mode, stats: visibleStats }
      });
    } catch (_) {}
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

// `isStillCurrent`, when given, is re-checked after the wait: see
// deferredWindowSend.js.
function sendMainWindowEvent(channel, payload, isStillCurrent) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendWhenRendererReady(mainWindow.webContents, channel, payload, isStillCurrent);
}

async function refreshFromTray() {
  if (trayRefreshInFlight) return;
  const widgetProducerOwner = captureMacWidgetProducerOwner();
  return runTrayMenuAction({
    setInFlight: (value) => { trayRefreshInFlight = value; },
    refreshContextMenu: refreshTrayContextMenu,
    action: async () => {
      try {
        const stats = await fetchStats({ force: true });
        // Collector ticks normally publish their own final snapshot. Only bridge the
        // result when fetchStats returned a different object (for example, a remote hub
        // fetch while an external headless agent owns collection).
        if (stats && stats !== latestStats) {
          sendPush({ event: 'stats', data: { stats, mode, reason: 'manual' } }, { widgetProducerOwner });
        }
      } catch (error) {
        console.warn(`[tray] refresh failed: ${error.message}`);
        showTrayRefreshError(error?.message || error);
      }
    }
  });
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
  return runTrayMenuAction({
    setInFlight: (value) => { trayCodexSwitchInFlight = value; },
    refreshContextMenu: refreshTrayContextMenu,
    action: async () => {
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
      }
    }
  });
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
        locale: trayMenuLocale(),
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
    // settings.trayMode is already true here, so this unmaximize is ignored by
    // the native handler and settings.windowMaximized keeps describing the
    // window exitTrayMode() will hand back.
    suspendWindowMaximized(mainWindow);
    setWindowMaximizable(mainWindow, false);
    applyMacSpaceBehavior(true);
    mainWindow.hide();
  }
}

function exitTrayMode() {
  applyMacActivationPolicy({ mainWindowVisible: true });
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (typeof mainWindow.setSkipTaskbar === 'function') mainWindow.setSkipTaskbar(false);
    setWindowMaximizable(mainWindow, true);
    applyMacSpaceBehavior(false);
    const restore = restoredBounds() || DEFAULT_WINDOW;
    mainWindow.setBounds({
      width: restore.width,
      height: restore.height,
      ...(typeof restore.x === 'number' ? { x: restore.x, y: restore.y } : {})
    });
    applyWindowSettings();
    mainWindow.show();
    restoreWindowMaximized(mainWindow, settings);
  }
  if (!shouldCreateTray(settings)) destroyTray();
  else ensureTray();
}

function startMode() {
  hubModeGeneration += 1;
  advanceMacWidgetProducerAndSourceEpoch();
  clearLatestHubStatsCache();
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
      reconcileSharedSubscriptions();
      return;
    }
    await stopEmbeddedHub();
    if (effectiveHubConfig().url) {
      startStatsStream({ resetSnapshot: true });
      startSyncCollector();
      reconcileSharedSubscriptions();
    } else {
      startLocalCollector();
      reconcileSharedSubscriptions();
    }
  }).catch((err) => {
    console.log(`[mode] reconciliation failed: ${err?.message || err}`);
  });
}

// Reconciled on every mode change, because switching into a hub adopts a
// different list and switching out of one falls back to the local cache — the
// renderer is showing whichever list the previous mode had.
//
// Started by the mode queue but not awaited by it. Subscriptions have a lane of
// their own, per hub, so nothing here needs the queue to order it — while holding
// the queue open for a hub request means the next hub the user picks waits out
// this one's 15s deadline before its stream and collector start, with no data on
// screen in the meantime. Its failures stay here for the same reason: nothing
// downstream is waiting to hear about them.
async function reconcileSharedSubscriptions() {
  try {
    await refreshSharedSubscriptions({ seedFromLocal: true });
    // Unconditional, unlike the stamp comparison: a mode change swaps which list
    // is showing, and the renderer is holding the previous mode's one.
    pushSettingsToRenderer();
  } catch (error) {
    console.log(`[sync] subscription reconcile failed: ${error?.message || error}`);
  }
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

// Quit-path teardown. Every step here must be synchronous, because performQuit
// exits on the next line and anything awaited in between is a chance to never
// get there. `skipCloseWatchers` is what buys that: chokidar's close() returns a
// promise, but not before an O(N) synchronous pass over every watched entry, and
// on a tree the size of ~/.claude/projects that pass alone blocks the main
// thread long enough to look like a hang. The descriptors go with the process.
// Mode switches deliberately do NOT come through here: they keep the default
// stopLocalCollector() / stopSyncCollector() behaviour so the old watcher is
// really gone before a new one starts on the same paths.
function stopAll() {
  stopPersistBoundsTimer();
  stopLocalCollector({ skipCloseWatchers: true });
  stopStatsStream();
  stopHostStats();
  stopSyncCollector({ skipCloseWatchers: true });
  macWidgetSnapshotController?.stop();
  if (macWidgetDemand) {
    macWidgetDemand.stop();
    macWidgetDemand = null;
  }
  // Fire-and-forget on purpose. server.close() does not complete until every
  // in-flight request does, so awaiting it hands a remote device on the embedded
  // hub the power to hold our own exit open. The listening socket closes with
  // the process, and a graceful hub close buys nothing on the way out.
  void stopEmbeddedHub();
  stopDiscordRpc();
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

let quitRequested = false;
let quitInProgress = false;
// Owned by the update-install guard below and by nothing else: electron-updater
// restarts the process itself, so the exit has to stand down or the install
// never runs.
let skipForcedQuit = false;

// An install request stands the forced exit down, and quitAndInstall() never
// reports back whether the installer actually took over. The guard owns that
// unconfirmed window; these two flags are all it touches here. See
// updateInstallQuit.js for why the claim expires and what promotes it.
// Set once the hand-off listener is actually attached; see the guard's watchdog.
let updateHandoffObserved = false;

const updateInstallQuit = createUpdateInstallQuitGuard({
  ...updateInstallQuitPolicy(),
  watchdogEnabled: () => updateHandoffObserved,
  claim: () => { quitRequested = true; skipForcedQuit = true; },
  release: () => { quitRequested = false; skipForcedQuit = false; },
  onStalled: () => {
    // The bound is far enough out that reaching it means the install genuinely
    // stalled, which is exactly what the user is looking at: they pressed Install
    // and the app neither restarted nor complained. What to do about it depends on
    // whether the attempt survived: where the guard handed it back the update is
    // still one press away, and only where it did not is a restart the way out.
    setNativeAppUpdateState({
      phase: 'error',
      progress: null,
      error: 'Update installer did not start',
      errorKind: installFailureErrorKind({ spent: updateInstallQuit.isSpent(), stalled: true })
    });
  },
  onHandoff: (afterStalledReport) => {
    // The bound is a decision to stop waiting, not proof the installer is dead, so
    // a hand-off that turns up later withdraws the report rather than leaving the
    // app advising a restart it is about to perform itself.
    if (!afterStalledReport) return;
    setNativeAppUpdateState({ phase: 'downloaded', progress: 100, error: null });
  }
});

// The single quit path. Teardown above is what used to hang, so it runs
// synchronously and cheaply, and then app.exit() ends the process without
// another trip through Electron's shutdown events.
function performQuit() {
  if (quitInProgress) return;
  quitInProgress = true;
  try {
    stopAll();
  } catch (error) {
    console.log(`[quit] stopAll failed: ${error?.message || error}`);
  }
  app.exit(0);
}

function requestAppQuit() {
  if (quitRequested) return;
  quitRequested = true;
  performQuit();
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
  const requestGeneration = hubModeGeneration;
  const requestHubIdentity = currentHubStatsIdentity('client');
  const force = Boolean(options?.force);
  // forceHistory and forceSelfSync stay independent of `force` on purpose: tool
  // settings, account sign-ins and limits actions all refresh with { force: true },
  // so folding them in would spawn the expensive `tokscale graph` — and the Cursor
  // and Antigravity sync subprocesses — on every one of them. Only the manual
  // refresh button opts in.
  if (force && ownsUsageRuntime()) {
    await runManualDeviceRefresh(deviceRuntimeHandle, {
      forceHistory: Boolean(options?.forceHistory),
      forceSelfSync: Boolean(options?.forceSelfSync),
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
  const stats = await response.json();
  if (!hubModeRequestIsCurrent(requestGeneration, 'client', requestHubIdentity)) {
    // The response belongs to a mode that is no longer active. Wait for the
    // queued mode reconciliation before re-reading: Client -> Host may still
    // be binding the embedded hub, and an immediate retry would hit its
    // loopback URL before it is listening.
    await modeQueue;
    return fetchStats({
      ...options,
      force: false,
      forceHistory: false,
      forceSelfSync: false
    });
  }
  setLatestHubStatsCache(stats, 'client', requestGeneration, requestHubIdentity);
  return injectLocalDeviceStatus(composeLocalSyncStats(stats, lastCollectedDevice));
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
    if (ownsUsageRuntime()) {
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
let appUpdateLastAttemptAt = null;
let appUpdateBackgroundTimer = null;
let appUpdateNativeBusy = false;
let appUpdateNativeConfigured = false;
let appUpdateNativeState = {
  phase: 'idle',
  version: null,
  progress: null,
  error: null,
  errorKind: null
};

function rememberSuccessfulAppUpdateCheck(latest, checkedAt = new Date().toISOString(), { clearLatest = false } = {}) {
  if (!latest && !clearLatest) return null;
  const remembered = latest
    ? mergeLatestReleaseMetadata(settings?.appUpdate?.lastKnownLatest, latest)
    : null;
  settings.appUpdate = {
    ...(settings.appUpdate || {}),
    lastCheckedAt: checkedAt,
    lastKnownLatest: remembered
  };
  saveSettings();
  appUpdateLastAttemptAt = checkedAt;
  appUpdateLastError = null;
  return remembered;
}

function setNativeAppUpdateState(patch = {}) {
  const next = { ...appUpdateNativeState, ...patch };
  // A kind belongs to the error it arrived with and must never outlive it, so any
  // patch that touches `error` without naming one clears it. That keeps the
  // ordinary updater failures generic without every call site restating it.
  if ('error' in patch && !('errorKind' in patch)) next.errorKind = null;
  appUpdateNativeState = next;
  sendAppUpdatePush();
}

function configureNativeAppUpdater() {
  if (appUpdateNativeConfigured) return;
  appUpdateNativeConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console;
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
  // The hand-off is emitted on Electron's own autoUpdater, not electron-updater's:
  // BaseUpdater re-emits it there to mimic what Squirrel does natively. Losing it
  // is not merely losing a confirmation, so the flag records a verified
  // registration and nothing weaker: without the listener nothing could re-claim
  // the flags after the grace period, and the guard would expire into a state a
  // late hand-off could not recover from. It stops arming the watchdog instead.
  try {
    updateHandoffObserved = observeUpdateInstallHandoff(
      require('electron').autoUpdater,
      () => updateInstallQuit.noteHandoff()
    );
  } catch (error) {
    updateHandoffObserved = false;
    console.log(`[update] cannot observe the install hand-off: ${error?.message || error}`);
  }
  if (!updateHandoffObserved) console.log('[update] no install hand-off signal; quit recovery disabled');
  autoUpdater.on('error', (error) => {
    // Released before the busy guard below, deliberately: update-downloaded has
    // already cleared appUpdateNativeBusy by the time an install can fail, so a
    // rollback behind that guard would never run and the quit flags would stay
    // stuck for the rest of the session.
    const wasInstalling = updateInstallQuit.abort();
    // Availability checks use the same provider but report through
    // appUpdateLastError. Only a real download or install attempt owns installError.
    if (!appUpdateNativeBusy && !wasInstalling) return;
    appUpdateNativeBusy = false;
    setNativeAppUpdateState({
      phase: 'error',
      progress: null,
      error: error?.message || String(error || 'Update failed'),
      // Where the attempt was single-use, a failed install also closed the in-app
      // path: the controls below now offer the release page instead of a retry, and
      // a generic "couldn't install" leaves that looking like the end of the road.
      // A restart is what brings the retry back, so the message has to say so.
      // `wasInstalling` is the part the helper cannot know: without it a check
      // failure arriving after an earlier spent attempt borrows its explanation.
      errorKind: wasInstalling
        ? installFailureErrorKind({ spent: updateInstallQuit.isSpent() })
        : null
    });
  });
}

async function checkAppUpdateProvider() {
  if (!app.isPackaged) return checkLatestRelease(app.getVersion());
  const checkedAt = new Date().toISOString();
  configureNativeAppUpdater();
  const result = await autoUpdater.checkForUpdates();
  const availability = providerUpdateCheckAvailability(result, app.getVersion());
  if (!availability.valid) {
    return {
      ok: false,
      newer: false,
      latest: null,
      error: 'Update metadata missing or invalid',
      errorKind: 'metadata',
      checkedAt
    };
  }
  return {
    ok: true,
    newer: availability.newer,
    latest: availability.latest,
    clearLatest: availability.clearLatest,
    error: null,
    errorKind: null,
    checkedAt
  };
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
    lastAttemptAt: appUpdateLastAttemptAt,
    checking: appUpdateCheckInFlight,
    lastError: appUpdateLastError?.message || null,
    lastErrorKind: appUpdateLastError?.kind || null,
    installSupported: installSupport.supported,
    installSupportReason: installSupport.reason,
    installPhase: appUpdateNativeState.phase,
    installProgress: appUpdateNativeState.progress,
    installVersion: appUpdateNativeState.version,
    installError: appUpdateNativeState.error,
    installErrorKind: appUpdateNativeState.errorKind || null,
    downloaded: availability.downloaded,
    // The hand-off window, straight from the state machine rather than inferred
    // from a pair of booleans downstream: between the press and the installer
    // taking over there is nothing else to tell the user.
    installStarting: updateInstallQuit.isInstalling(),
    // No further attempt is possible until a restart, so the action policy and the
    // automatic downloader both have to stop offering one.
    installRetryBlocked: updateInstallQuit.isSpent(),
    // An install the guard is still trying to complete counts as busy: on macOS
    // Squirrel can take tens of seconds, and leaving the control live for that long
    // invites a second press the guard can only refuse.
    installBusy: appUpdateNativeBusy
      || updateInstallQuit.isInstalling()
      || appUpdateNativeState.phase === 'checking'
      || appUpdateNativeState.phase === 'downloading'
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

async function runAppUpdateCheck({ force = false, bypassCooldown = false } = {}) {
  // An outstanding install owns the updater until the guard is idle again.
  // electron-updater reports a failed check by emitting on the same global 'error'
  // event an install failure arrives on -- checkForUpdates() emits there and
  // rethrows -- and the handler below has nothing to tell them apart. Treating a
  // check's failure as the install's would tear down the install, which is what the
  // hourly check made an ordinary overlap on macOS, where an install is outstanding
  // for as long as minutes.
  //
  // `isOutstanding` rather than `isInstalling`, so this covers a spent attempt too.
  // Spent is not terminal: the bound is only where we stopped waiting, and a late
  // hand-off still promotes it back to `handoff` and re-claims the flags. A check
  // allowed to start in the meantime would then be in flight during a genuine
  // hand-off, and its failure would release `skipForcedQuit` with the installer
  // owning the exit -- the one outcome this whole path exists to prevent. Checking
  // is worth less than that: after a spent attempt it can only find a version this
  // process is already refusing to download.
  if (updateInstallQuit.isOutstanding()) return deriveAppUpdateState();
  if (appUpdateCheckPromise) {
    if (force) sendAppUpdatePush();
    const activeResult = await appUpdateCheckPromise;
    if (force) {
      appUpdateLastAttemptAt = activeResult?.checkedAt || new Date().toISOString();
      appUpdateLastError = resolveAppUpdateCheckError(appUpdateLastError, activeResult, { force: true });
      if (activeResult?.ok) {
        if (activeResult.newer) restoreDismissedAppUpdate(activeResult.latest?.version);
      }
      sendAppUpdatePush();
    }
    return maybeDownloadAutomaticAppUpdate(deriveAppUpdateState());
  }
  const block = settings?.appUpdate || {};
  if (!bypassCooldown && shouldSkipAppUpdateCheck({
    force,
    lastCheckedAt: block.lastCheckedAt,
    latest: block.lastKnownLatest,
    dismissedVersion: block.dismissedVersion,
    currentVersion: app.getVersion()
  })) {
    return maybeDownloadAutomaticAppUpdate(deriveAppUpdateState());
  }
  const checkTask = (async () => {
    appUpdateCheckInFlight = true;
    appUpdateLastAttemptAt = new Date().toISOString();
    if (force) sendAppUpdatePush();
    let result;
    try {
      result = await checkAppUpdateProvider();
      appUpdateLastAttemptAt = result.checkedAt || appUpdateLastAttemptAt;
      if (result.ok) {
        rememberSuccessfulAppUpdateCheck(result.latest, result.checkedAt, { clearLatest: result.clearLatest });
        if (force && result.newer) restoreDismissedAppUpdate(result.latest?.version);
      } else {
        appUpdateLastError = resolveAppUpdateCheckError(appUpdateLastError, result, { force });
        if (!force) console.warn('App update check failed:', result.error);
      }
    } catch (error) {
      const classified = classifyAppUpdateError(error);
      appUpdateLastError = resolveAppUpdateCheckError(appUpdateLastError, {
        ok: false,
        error: classified.message,
        errorKind: classified.kind
      }, { force });
      if (!force) console.warn('App update check threw:', error);
      return {
        ok: false,
        newer: false,
        latest: null,
        error: classified.message,
        errorKind: classified.kind,
        checkedAt: appUpdateLastAttemptAt
      };
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
  return maybeDownloadAutomaticAppUpdate(deriveAppUpdateState());
}

async function maybeDownloadAutomaticAppUpdate(updateState) {
  if (!shouldDownloadAutomaticAppUpdate({
    automaticAppUpdates: settings?.automaticAppUpdates,
    updateState
  })) return updateState;
  return downloadAndPrepareAppUpdate();
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
  // Same ownership rule as the check path, and one more: a spent attempt can never
  // be installed by this process either, so re-entering the download lifecycle
  // rebuilds MacUpdater's local proxy while the listener the first quitAndInstall()
  // attached is still on the native updater. The renderer stops offering this and
  // the automatic downloader stands down, but neither of those is the boundary --
  // this is, and an IPC action queued before the attempt ended still arrives here.
  //
  // Every entry point uses the same rule, for the same reason (see
  // runAppUpdateCheck): while the guard holds anything, nothing else drives the
  // updater.
  if (updateInstallQuit.isOutstanding()) return deriveAppUpdateState();
  if (appUpdateCheckPromise) await appUpdateCheckPromise;
  if (appUpdateNativeBusy) return deriveAppUpdateState();
  const latest = settings?.appUpdate?.lastKnownLatest || null;
  if (downloadedAppUpdateMatchesLatest({
    phase: appUpdateNativeState.phase,
    downloadedVersion: appUpdateNativeState.version,
    latest
  })) return deriveAppUpdateState();
  configureNativeAppUpdater();
  appUpdateNativeBusy = true;
  setNativeAppUpdateState({ phase: 'checking', progress: null, error: null });
  try {
    const result = await autoUpdater.checkForUpdates();
    const availability = providerUpdateCheckAvailability(result, app.getVersion());
    if (!availability.valid) throw new Error('Update metadata missing or invalid');
    const checkedAt = new Date().toISOString();
    const latestFromCheck = rememberSuccessfulAppUpdateCheck(
      availability.latest,
      checkedAt,
      { clearLatest: availability.clearLatest }
    );
    const version = latestFromCheck?.version || null;
    if (!availability.newer || !version) {
      appUpdateNativeBusy = false;
      setNativeAppUpdateState({ phase: 'idle', version, progress: null, error: null });
      return deriveAppUpdateState();
    }
    restoreDismissedAppUpdate(version);
    setNativeAppUpdateState({ phase: 'downloading', version, progress: 0, error: null });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    appUpdateNativeBusy = false;
    setNativeAppUpdateState({ phase: 'error', progress: null, error: error?.message || String(error) });
  }
  return deriveAppUpdateState();
}

async function installDownloadedAppUpdate() {
  // The other half of the same rule. Refusing new operations during the install
  // only holds the boundary if nothing was already running when it started, and a
  // check begun a moment earlier would still be reporting on the shared event.
  // Waiting rather than refusing, since this one is a button press: the checks
  // below are read afterwards, when the update it is about to install is settled.
  if (appUpdateCheckPromise) await appUpdateCheckPromise;
  const latest = settings?.appUpdate?.lastKnownLatest || null;
  if (!downloadedAppUpdateMatchesLatest({
    phase: appUpdateNativeState.phase,
    downloadedVersion: appUpdateNativeState.version,
    latest
  })) return deriveAppUpdateState();
  // quitAndInstall goes through before-quit, and electron-updater owns the
  // restart from there. Stand the forced exit down or the installer never runs.
  // Refused while an earlier request is still outstanding, and permanently once an
  // attempt is spent, so a second press can never stack install attempts.
  if (!updateInstallQuit.request()) {
    // Say so rather than leave a button that quietly does nothing: a spent attempt
    // cannot be retried in this process at all.
    if (updateInstallQuit.phase() === 'spent') {
      setNativeAppUpdateState({
        phase: 'error',
        progress: null,
        error: 'Update install was already attempted',
        errorKind: 'attempt-spent'
      });
    }
    return deriveAppUpdateState();
  }
  try {
    // isSilent: skip the NSIS installer UI on Windows so the update feels seamless
    // (per-user install needs no elevation); isForceRunAfter relaunches the app.
    autoUpdater.quitAndInstall(true, true);
  } catch (error) {
    // The abort above ended the attempt this call had just made, so unlike the
    // updater's own error handler there is nothing else this failure could belong
    // to, and the same recovery applies.
    updateInstallQuit.abort();
    setNativeAppUpdateState({
      phase: 'error',
      progress: null,
      error: error?.message || String(error || 'Update failed'),
      errorKind: installFailureErrorKind({ spent: updateInstallQuit.isSpent() })
    });
  }
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
  if (
    (parsed.hostname === 'javis-ai.com' || parsed.hostname === 'www.javis-ai.com')
    && (parsed.pathname === '/token-monitor' || parsed.pathname.startsWith('/token-monitor/'))
  ) return true;
  if (parsed.hostname === 'claude.ai' && parsed.pathname.startsWith('/settings')) return true;
  if ((parsed.hostname === 'cursor.com' || parsed.hostname === 'www.cursor.com') && parsed.pathname.startsWith('/settings')) return true;
  if (parsed.hostname === 'opencode.ai' || parsed.hostname === 'www.opencode.ai') return true;
  if (parsed.hostname === 'openrouter.ai' && parsed.pathname.startsWith('/settings/keys')) return true;
  if (parsed.hostname === 'platform.deepseek.com' && parsed.pathname.startsWith('/api_keys')) return true;
  if (parsed.hostname === 'platform.minimaxi.com') return true;
  if (parsed.hostname === 'platform.minimax.io') return true;
  if (parsed.hostname === 'z.ai' || parsed.hostname === 'www.z.ai') return true;
  if (parsed.hostname === 'bigmodel.cn' || parsed.hostname === 'www.bigmodel.cn') return true;
  if (parsed.hostname === 'www.volcengine.com' || parsed.hostname === 'console.volcengine.com') return true;
  if (parsed.hostname === 'qoder.com' || parsed.hostname === 'www.qoder.com' || parsed.hostname === 'qoder.com.cn' || parsed.hostname === 'www.qoder.com.cn') return true;
  if (parsed.hostname === 'commandcode.ai' || parsed.hostname === 'www.commandcode.ai') return true;
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
    if (restoreWindowMaximizedForReveal(target, settings, {
      restoreMaximized: options.restoreMaximized === true,
      inactive: options.inactive === true,
      collapsedFloatingBubble: options.collapsedFloatingBubble === true
    })) return;
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
  const windowsBackdrop = normalizeWindowsBackdropMode(settings?.windowsBackdrop);
  const windowsAccent = process.platform === 'win32' && glass && windowsBackdrop === WINDOWS_BACKDROP_ACCENT;
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
    // Keeps a popover unmaximizable across rebuilds, which never re-run enterTrayMode().
    ...(settings?.trayMode ? { maximizable: false } : {}),
    ...floatingBubbleWindowChrome(process.platform, collapsedFloatingBubble),
    ...(process.platform === 'darwin' && glass ? { vibrancy: 'hud', visualEffectState: 'active' } : {}),
    ...(process.platform === 'win32' && glass && !windowsAccent ? { backgroundMaterial: 'acrylic' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;
  mainWindowChrome = { collapsedFloatingBubble };
  applyMacSpaceBehavior();
  applyWindowsChrome(win, { round: true });
  let windowsAccentFallback = false;
  if (windowsAccent && !applyWindowsAccentBlur(win)) {
    // The Accent API is undocumented and can disappear or reject a window on
    // a future Windows build. This window is still non-transparent, so the
    // documented Electron Acrylic material is a safe in-place fallback.
    windowsAccentFallback = true;
    console.warn('[window] AccentBlurBehind unavailable; falling back to Acrylic');
    try { win.setBackgroundMaterial('acrylic'); } catch (_) {}
  }
  win.on('maximize', () => {
    if (!shouldTrackWindowMaximized(settings, floatingBubbleState)) {
      // A tray popover is sized from getBounds() on every open, so a maximized
      // one would open full-screen. setMaximizable() covers Windows and macOS;
      // it is a no-op on Linux, which is why this bounce still has to exist.
      if (settings?.trayMode) suspendWindowMaximized(win);
      return;
    }
    stopPersistBoundsTimer();
    persistWindowState(settings, saveSettings, normalWindowBounds(win), true);
  });
  win.on('unmaximize', () => {
    if (!shouldTrackWindowMaximized(settings, floatingBubbleState)) return;
    persistWindowState(settings, saveSettings, normalWindowBounds(win), false);
    persistBoundsSoon();
  });
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
    collapsedFloatingBubble,
    restoreMaximized: !collapsedFloatingBubble,
    query: {
      ...floatingBubbleInitialRendererQuery(floatingBubbleState, {
        collapsedWindow: collapsedFloatingBubble,
        suppressInitialNumberAnimation: options.suppressInitialNumberAnimation === true,
        viewState: rendererViewState
      }),
      ...(settings?.systemGlass === false ? { systemGlassDisabled: '1' } : {}),
      ...(windowsAccentFallback ? { windowsBackdropFallback: '1' } : {})
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

async function getDashboardHistory(options = {}) {
  const includeDevices = options?.includeDevices === true;
  const resolved = includeDevices
    ? await resolveCompleteHistoryWithDevices(historyResolverOptions())
    : { history: await getCompleteHistory(), deviceHistories: undefined };
  const history = resolved.history;
  const source = completeHistorySource(historyResolverOptions());
  return {
    ...history,
    ...(includeDevices ? { deviceHistories: resolved.deviceHistories } : {}),
    fixedPeriods: fixedPeriodHistoryMeta({
      source
    })
  };
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
  const bounds = rebuildWindowBounds(mainWindow, floatingBubbleState);
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
  // Switching the OS between light and dark repaints the taskbar underneath an
  // icon we have already handed to the shell, so the renderer has to recompose
  // it — nothing else in the app would notice the change.
  nativeTheme.on('updated', () => { void pushSystemUiThemeAfterChange(); });
  const widgetRuntime = macWidgetRuntimeSupport({
    platform: process.platform,
    osRelease: process.platform === 'darwin' ? os.release() : ''
  });
  const widgetRuntimeSupported = widgetRuntime.supported;
  const widgetRecoveryAbort = widgetRuntimeSupported ? new AbortController() : null;
  const abortWidgetRecovery = () => widgetRecoveryAbort?.abort();
  if (widgetRecoveryAbort) app.once('before-quit', abortWidgetRecovery);
  const widgetRecovery = widgetRuntimeSupported
    ? recoverMacWidgetLaunchServicesRegistration({
      platform: process.platform,
      runtimeSupported: true,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      signal: widgetRecoveryAbort.signal,
      logger: (message) => console.warn(message)
    })
    : Promise.resolve({ status: 'skipped', reason: widgetRuntime.reason });
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
  if (pendingMacWidgetOpen) setImmediate(openMainWindowFromWidget);
  if (settings.trayMode) enterTrayMode();
  regenerateTokscalePricing();
  if (widgetRuntimeSupported) ensureMacWidgetDemand();
  startMode();
  void widgetRecovery.finally(() => {
    if (widgetRecoveryAbort) app.removeListener('before-quit', abortWidgetRecovery);
    if (!widgetRecoveryAbort?.signal.aborted) {
      macWidgetPublicationReady = true;
      macWidgetSnapshotController?.resume();
    }
  });
  void hydrateCodexManagedWorkspaceLabels();
  if (settings.discordRpcEnabled) startDiscordRpc();
  rateCache = readRateCache();
  applyEffectiveRates();                 // use cache/defaults immediately, avoid first-paint gap
  refreshExchangeRates();                // non-blocking: only fetches when stale
  rateRefreshTimer = setInterval(() => { refreshExchangeRates(); }, 6 * 60 * 60 * 1000);
  setTimeout(() => { checkTokscaleNpm({ silent: true }); }, 2000);
  ipcMain.handle('settings:get', () => settingsForRenderer());

  ipcMain.handle('subscriptions:adoptOrphans', async () => {
    try {
      return await adoptOrphanedSubscriptions();
    } catch (error) {
      throw new Error(subscriptionWriteFailureCode(error), { cause: error });
    }
  });

  ipcMain.handle('subscriptions:discardOrphans', () => discardOrphanedSubscriptions());

  ipcMain.handle('subscriptions:save', async (_event, subscriptions, base) => {
    try {
      return await saveSubscriptions(subscriptions, base);
    } catch (error) {
      // The renderer has to tell "another device won" apart from "the hub is
      // down": one means re-read and redo, the other means try again later. Only
      // the message survives the IPC boundary, so the code goes in it.
      throw new Error(subscriptionWriteFailureCode(error), { cause: error });
    }
  });
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
    if (patch?.claudeWebCookie !== undefined) claudeWebCookieMutationRevision += 1;
    const previousSettingsState = settings;
    const previousRuntimeSettings = JSON.parse(JSON.stringify(settings));
    const previousNativeMaterial = nativeBlurEnabled();
    const previousWindowsBackdrop = normalizeWindowsBackdropMode(settings?.windowsBackdrop);
    const previousClients = settings.clients;
    const previousDiscordRpcEnabled = settings.discordRpcEnabled;
    const previousShowTrayIcon = settings.showTrayIcon;
    const previousTrayMode = settings.trayMode;
    const previousTrayContent = settings.trayContent;
    const previousTrayCustomLayout = JSON.stringify(settings.trayCustomLayout || {});
    const previousFloatingBubbleCustomLayout = JSON.stringify(settings.floatingBubbleCustomLayout || {});
    const previousShowTrayProviderBadge = settings.showTrayProviderBadge;
    const previousOpenCodeLocalLimitsEnabled = settings.opencodeLocalLimitsEnabled === true;
    const previousCurrency = settings.currency;
    const previousCompactTokenUnits = settings.compactTokenUnits;
    const previousLanguage = settings.language;
    const previousStartAtLogin = settings.startAtLogin;
    const previousAutomaticAppUpdates = settings.automaticAppUpdates;
    const previousCustomModelPricing = JSON.stringify(settings.customModelPricing || []);
    const normalizedCurrency = patch.currency !== undefined ? normalizeCurrency(patch.currency, settings.currency) : normalizeCurrency(settings.currency);
    const normalizedPatch = { ...patch, currency: normalizedCurrency };
    delete normalizedPatch.windowMaximized;
    delete normalizedPatch.codexManagedAccounts;
    delete normalizedPatch.mimoManagedAccounts;
    delete normalizedPatch.openrouterProfiles;
    delete normalizedPatch.thirdPartyProfiles;
    delete normalizedPatch.customModelPricing;
    // Subscriptions go through subscriptions:save, which knows whether this
    // device owns the list or shares it with a hub. The explicit fields further
    // down are what actually hold the line — they are applied after the spread
    // and source from settings — but stripping the keys here keeps a future
    // reorder from quietly turning the spread back into a second way in.
    delete normalizedPatch.subscriptions;
    delete normalizedPatch.subscriptionsOrphaned;
    delete normalizedPatch.subscriptionsCacheHub;
    // Derived for the renderer from the hub document, not settings. Persisting a
    // copy would leave a key on disk that describes a hub as of whenever a form
    // was last saved, waiting to be mistaken for the real thing.
    delete normalizedPatch.subscriptionsShared;
    delete normalizedPatch.subscriptionsHub;
    delete normalizedPatch.subscriptionsUpdatedAt;
    if (patch.clients !== undefined) normalizedPatch.clients = clientsCsvForSetting(patch.clients, '');
    if (patch.claudeWebCookie !== undefined) normalizedPatch.claudeWebCookie = normalizeClaudeWebCookie(patch.claudeWebCookie);
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
    if (patch.commandcodeCookie !== undefined) normalizedPatch.commandcodeCookie = normalizeCommandcodeCookie(patch.commandcodeCookie);
    if (patch.kimiApiKey !== undefined) normalizedPatch.kimiApiKey = normalizeKimiApiKey(patch.kimiApiKey);
    if (patch.kimiWebAccessToken !== undefined) normalizedPatch.kimiWebAccessToken = normalizeKimiWebAccessToken(patch.kimiWebAccessToken);
    if (patch.ollamaCookie !== undefined) normalizedPatch.ollamaCookie = normalizeOllamaCookie(patch.ollamaCookie);
    if (patch.collectionMode !== undefined) normalizedPatch.collectionMode = normalizeCollectionMode(patch.collectionMode, settings.collectionMode);
    if (patch.collectionIntervalMs !== undefined) normalizedPatch.collectionIntervalMs = normalizeCollectionIntervalMs(patch.collectionIntervalMs, settings.collectionIntervalMs);
    if (patch.syncUploadIntervalMs !== undefined) normalizedPatch.syncUploadIntervalMs = normalizeSyncUploadIntervalMs(patch.syncUploadIntervalMs, settings.syncUploadIntervalMs);
    if (patch.heatmapMetric !== undefined) normalizedPatch.heatmapMetric = normalizeHeatmapMetric(patch.heatmapMetric, settings.heatmapMetric);
    if (patch.homeActiveDaysWindow !== undefined) normalizedPatch.homeActiveDaysWindow = normalizeHomeActiveDaysWindow(patch.homeActiveDaysWindow, settings.homeActiveDaysWindow);
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
      windowsBackdrop: normalizeWindowsBackdropMode(patch.windowsBackdrop ?? settings.windowsBackdrop),
      reduceMotion: motionPreferenceApi.normalize(patch.reduceMotion ?? settings.reduceMotion),
      showLiveDot: patch.showLiveDot ?? settings.showLiveDot ?? true,
      showToolIcons: patch.showToolIcons ?? settings.showToolIcons ?? true,
      titleIconOnly: parseBoolean(patch.titleIconOnly ?? settings.titleIconOnly, false),
      showCompactTotalTokens: parseBoolean(patch.showCompactTotalTokens ?? settings.showCompactTotalTokens, false),
      compactTokenUnits: normalizeCompactTokenUnits(patch.compactTokenUnits ?? settings.compactTokenUnits),
      interfaceFontFamily: fontSettingsApi.normalizeFontFamily(
        patch.interfaceFontFamily ?? settings.interfaceFontFamily
      ),
      displayFontFamily: fontSettingsApi.normalizeFontFamily(
        patch.displayFontFamily ?? settings.displayFontFamily
      ),
      tokenRateMode: normalizeTokenRateMode(patch.tokenRateMode ?? settings.tokenRateMode),
      floatingBubbleEnabled: parseBoolean(patch.floatingBubbleEnabled ?? settings.floatingBubbleEnabled, false),
      discordRpcEnabled: patch.discordRpcEnabled ?? settings.discordRpcEnabled ?? false,
      limitsEnabled: parseBoolean(patch.limitsEnabled ?? settings.limitsEnabled, true),
      // Sourced from settings only, never from the patch: subscriptions:save is
      // the one write path, because it knows whether this device owns the list
      // or shares it with a hub. Reading the patch here would let any caller
      // fork the shared list past that decision.
      subscriptions: subscriptionDisplay.normalizeSubscriptions(
        settings.subscriptions,
        { currencyApi: { normalizeCurrency } }
      ),
      subscriptionsCacheHub: String(settings.subscriptionsCacheHub || ''),
      subscriptionsOrphaned: {
        hubUrl: orphanedSubscriptions().hubUrl,
        records: subscriptionDisplay.normalizeSubscriptions(
          orphanedSubscriptions().records,
          { currencyApi: { normalizeCurrency } }
        )
      },
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
      periodMonthMode: normalizePeriodMonthMode(patch.periodMonthMode ?? settings.periodMonthMode),
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
      limitsRefreshMode: normalizeLimitsRefreshMode(patch.limitsRefreshMode ?? settings.limitsRefreshMode),
      limitsRefreshMs: normalizeLimitsRefreshMs(patch.limitsRefreshMs ?? settings.limitsRefreshMs),
      showLimitSource: parseBoolean(patch.showLimitSource ?? settings.showLimitSource, false),
      maskLimitAccountEmails: parseBoolean(patch.maskLimitAccountEmails ?? settings.maskLimitAccountEmails, false),
      claudePrepaidBalanceEnabled: parseBoolean(patch.claudePrepaidBalanceEnabled ?? settings.claudePrepaidBalanceEnabled, true),
      opencodeAmbientEnabled: parseBoolean(patch.opencodeAmbientEnabled ?? settings.opencodeAmbientEnabled, true),
      opencodeLocalLimitsEnabled: parseBoolean(patch.opencodeLocalLimitsEnabled ?? settings.opencodeLocalLimitsEnabled, false),
      showLimitUsed: parseBoolean(patch.showLimitUsed ?? settings.showLimitUsed, false),
      windowMaximized: parseBoolean(settings.windowMaximized, false),
      zoomFactor: clampZoom(patch.zoomFactor ?? settings.zoomFactor),
      ...normalizeTrayModeSettings({
        showTrayIcon: patch.showTrayIcon ?? settings.showTrayIcon,
        trayMode: patch.trayMode ?? settings.trayMode
      }),
      trayContent: normalizeTrayContent(patch.trayContent ?? settings.trayContent),
      trayCustomLayout: normalizeTrayLayout(patch.trayCustomLayout ?? settings.trayCustomLayout),
      showTrayProviderBadge: parseBoolean(patch.showTrayProviderBadge ?? settings.showTrayProviderBadge, false),
      floatingBubbleContent: normalizeTrayContent(patch.floatingBubbleContent ?? settings.floatingBubbleContent, 'icon'),
      floatingBubbleCustomLayout: normalizeTrayLayout(patch.floatingBubbleCustomLayout ?? settings.floatingBubbleCustomLayout),
      windowToggleShortcut: normalizeWindowToggleShortcut(patch.windowToggleShortcut ?? settings.windowToggleShortcut),
      currency: normalizedCurrency,
      currencyRates: patch.currencyRates !== undefined ? normalizeCurrencyOverrides(patch.currencyRates) : normalizeCurrencyOverrides(settings.currencyRates),
      language: patch.language !== undefined ? normalizeLanguageSetting(patch.language, settings.language) : normalizeLanguageSetting(settings.language),
      startAtLogin: loginItemEnabledHere() ? parseBoolean(patch.startAtLogin ?? settings.startAtLogin, false) : false,
      automaticAppUpdates: parseBoolean(patch.automaticAppUpdates ?? settings.automaticAppUpdates, false),
      claudeWebCookie: patch.claudeWebCookie !== undefined
        ? normalizeClaudeWebCookie(patch.claudeWebCookie)
        : (settings.claudeWebCookie || ''),
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
      commandcodeCookie: patch.commandcodeCookie !== undefined ? normalizeCommandcodeCookie(patch.commandcodeCookie) : (settings.commandcodeCookie || ''),
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
    if (settings.automaticAppUpdates && !previousAutomaticAppUpdates) {
      runAppUpdateCheck({ bypassCooldown: true }).catch(() => {});
    }
    if (patch.zoomFactor !== undefined) applyZoomFactor();
    if (settings.discordRpcEnabled && !previousDiscordRpcEnabled) {
      startDiscordRpc();
      if (latestStats) updateDiscordRpcDisplay(latestStats);
    }
    else if (!settings.discordRpcEnabled && previousDiscordRpcEnabled) stopDiscordRpc();
    else if (settings.discordRpcEnabled && (
      settings.currency !== previousCurrency
      || settings.compactTokenUnits !== previousCompactTokenUnits
      || settings.language !== previousLanguage
    ) && latestStats) updateDiscordRpcDisplay(latestStats);
    applyWindowSettings();
    syncFloatingBubbleAvailability();
    const nextNativeMaterial = nativeBlurEnabled();
    const nextWindowsBackdrop = normalizeWindowsBackdropMode(settings?.windowsBackdrop);
    const windowsBackdropChanged = previousWindowsBackdrop !== nextWindowsBackdrop
      && (previousNativeMaterial || nextNativeMaterial);
    if (process.platform === 'win32' && (previousNativeMaterial !== nextNativeMaterial || windowsBackdropChanged)) {
      rebuildWindow();
    } else {
      applyNativeMaterial();
    }
    const runtimeChange = classifySettingsChange(previousRuntimeSettings, settings);
    const widgetHistorySourceChanged = previousRuntimeSettings.historyEnabled !== settings.historyEnabled;
    if (widgetHistorySourceChanged && !runtimeChange.modeStructural) {
      refreshMacWidgetHistorySource();
    }
    const limitInvalidations = settingsLimitInvalidationPlan(runtimeChange);
    if (runtimeChange.modeStructural) {
      for (const { scope, reason, options } of limitInvalidations) {
        rememberPendingLimitInvalidation(scope, reason, options);
      }
      startMode();
    } else if (runtimeChange.usageStructural || runtimeChange.sinkStructural) {
      for (const { scope, reason, options } of limitInvalidations) {
        rememberPendingLimitInvalidation(scope, reason, options);
      }
      restartDeviceRuntimeForMode();
    } else {
      if (runtimeChange.limitsReconfigure && deviceRuntimeHandle) {
        deviceRuntimeHandle.reconfigureLimits(electronLimitsConfig());
      }
      for (const { scope, reason, options } of limitInvalidations) {
        void queueLimitInvalidation(scope, reason, options).catch((error) => {
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
      JSON.stringify(settings.trayCustomLayout || {}) !== previousTrayCustomLayout ||
      JSON.stringify(settings.floatingBubbleCustomLayout || {}) !== previousFloatingBubbleCustomLayout ||
      settings.showTrayProviderBadge !== previousShowTrayProviderBadge ||
      settings.currency !== previousCurrency ||
      settings.compactTokenUnits !== previousCompactTokenUnits ||
      settings.language !== previousLanguage
    ) {
      updateTrayDisplay();
    }
    if (patch.currency !== undefined || patch.currencyRates !== undefined) {
      applyEffectiveRates();               // sync: settingsForRenderer() below sees fresh effective map
      updateTrayDisplay();
      if (settings.discordRpcEnabled && latestStats) updateDiscordRpcDisplay(latestStats);
      refreshExchangeRates();              // async: fetch if stale, then re-push
    }
    if ((settings.opencodeLocalLimitsEnabled === true) !== previousOpenCodeLocalLimitsEnabled) {
      // Re-project the cached aggregate immediately. The Hub can be offline and
      // therefore may not send another frame after this local-only setting changes.
      refreshLimitStatsPresentation();
    }
    pushSettingsToRenderer();
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
  ipcMain.handle('stats:get', async (_event, options) => {
    const stats = await fetchStats(options);
    // The stream normally carries the stamp, but it is precisely when the stream
    // is down that this read is the only thing still arriving from the hub.
    maybeAdoptSharedSubscriptionRevision(stats);
    return electronPresentationStats(stats);
  });
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
    return readSessionDetailForPlatform({ client, sessionId, period, sessionCost });
  });
  ipcMain.handle('stream:status', () => ({ connected: streamConnected, mode, ...(streamFailure || {}) }));
  ipcMain.handle('serviceStatus:get', (_event, options) => serviceStatusClient.getServiceStatus({
    force: Boolean(options?.force),
    providerIds: Array.isArray(options?.providerIds) ? options.providerIds : null
  }));
  ipcMain.handle('hub:getInfo', () => getHubInfo());
  ipcMain.handle('hub:getBuildStatus', () => getHubBuildStatus());
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
    // So the diagnostics panel can print ~/… instead of the user's account name.
    homeDir: require('os').homedir(),
    sharedDataDir: sharedDataDir(),
    loginItemSupported: loginItemEnabledHere(),
    loginItemOpenAtLogin: currentLoginItemState(),
    systemDarkUi: currentSystemDarkTrayUi()
  }));
  ipcMain.handle('diagnostics:generate', async () => {
    const report = await diagnosticReportGenerator.generate();
    return {
      generatedAt: report.generatedAt,
      completeness: report.completeness,
      text: report.text,
      bytes: report.bytes,
      truncated: report.truncated,
      includedClientCount: report.includedClientCount,
      omittedClientCount: report.omittedClientCount,
      includedLimitProviderCount: report.includedLimitProviderCount,
      omittedLimitProviderCount: report.omittedLimitProviderCount,
      includedRemoteGroupCount: report.includedRemoteGroupCount,
      omittedRemoteGroupCount: report.omittedRemoteGroupCount,
      includedJournalEventCount: report.includedJournalEventCount,
      journalOmittedCount: report.journalOmittedCount
    };
  });
  // Where each known tool's data is read from on THIS machine. The absolute
  // paths stay local by design — they carry the user's home directory and never
  // go on the wire — so the renderer asks the main process for them instead.
  //
  // Probe only the client whose detail panel is open. The renderer caches the
  // result for the current health snapshot, or for the current device/client
  // pair when the tool is not tracked, avoiding eager filesystem work.
  const clientSourceIpcHandlers = createClientSourceIpcHandlers({
    knownClients: KNOWN_CLIENTS,
    trackedClients: () => trackedClientSet(clientsCsvForSetting(settings?.clients)),
    visibleDiagnosticRoots,
    clientDiagnosticRoots,
    showItemInFolder: (target) => shell.showItemInFolder(target),
    openPath: (target) => shell.openPath(target),
    canRunRescan: () => ownsUsageRuntime(),
    rescanClient: (client) => refreshUsageClient(client, { forceSync: true }),
    onRescanError: (error) => console.log(`[usage-runtime] rescan failed: ${error.message}`)
  });
  ipcMain.handle('usage:clientSources', (_event, clientId) => clientSourceIpcHandlers.clientSources(clientId));
  // The renderer sends a client id, never a path: anything it could send would
  // otherwise become an arbitrary filesystem open.
  ipcMain.handle('usage:revealClientSource', (_event, clientId) => clientSourceIpcHandlers.revealClientSource(clientId));
  ipcMain.handle('usage:rescanClient', (_event, clientId) => clientSourceIpcHandlers.rescanClient(clientId));
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
      bestEffortTrackedUsageRefresh('cursor', { forceSync: true });
      return { ok: true, email: probeResult.user.email };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('claude:saveCookie', async (_event, raw) => {
    const requestRevision = ++claudeWebCookieMutationRevision;
    let cookie;
    try {
      cookie = normalizeClaudeWebCookie(raw);
    } catch (error) {
      return {
        ok: false,
        status: 'invalid',
        errorCode: error?.code || 'INVALID_CLAUDE_WEB_SESSION_KEY'
      };
    }
    if (!cookie) {
      return {
        ok: false,
        status: 'notConfigured',
        errorCode: 'INVALID_CLAUDE_WEB_SESSION_KEY'
      };
    }
    try {
      let cookieToPersist = cookie;
      const provider = await fetchClaudeLimits(
        { claudeWebCookie: cookie },
        {
          claudeWebFetch: electronClaudeWebFetch,
          providerRuntimeState: new Map(),
          onClaudeWebCookieRenewed: ({ cookie: renewedCookie }) => {
            cookieToPersist = renewedCookie;
          }
        }
      );
      if (provider?.status !== 'ok') {
        return {
          ok: false,
          status: provider?.status || 'error'
        };
      }
      if (claudeWebCookieMutationRevision !== requestRevision) {
        return {
          ok: false,
          status: 'superseded',
          superseded: true
        };
      }
      settings.claudeWebCookie = cookieToPersist;
      saveSettings({ throwOnError: true });
      void queueLimitInvalidation({ provider: 'claude' }, 'login', { clear: true });
      return {
        ok: true,
        status: 'ok'
      };
    } catch (error) {
      return {
        ok: false,
        status: error?.status || 'error',
        errorCode: error?.code || ''
      };
    }
  });
  ipcMain.handle('ollama:validateCookie', async (_event, raw) => {
    const cookie = normalizeOllamaCookie(raw);
    if (!cookie) return { ok: false, status: 'notConfigured' };
    const provider = await fetchOllamaLimits({ ollamaCookie: cookie }, electronProviderDeps({ bypassValidationCache: true }));
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
        opencodeWeb.fetchGoWeb(cookie, electronProviderDeps()),
        opencodeWeb.fetchZen(cookie, electronProviderDeps())
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
      bestEffortTrackedUsageRefresh('cursor', { forceSync: true });
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
    // A profile that only names the auto-detected key stores no credential of
    // its own, so filtering on `cookie || apiKey` alone would skip it and leave
    // its row stuck on the placeholder while the collector reads live quota
    // from that very key. Resolve the key the same way the collector does.
    const ambientKey = opencodeGoApi.readGoApiKey(process.env);
    const ambientIdentity = ambientKey ? opencodeGoApi.goApiIdentity(ambientKey) : '';
    const profileKey = (p) => p.apiKey || opencodeProfiles.ambientKeyFor(p, ambientKey, ambientIdentity);
    // A reference that no longer resolves still has to answer for its row. It
    // has a credential the user stored, so filtering it out here would leave the
    // row on its placeholder forever with nothing saying what to do about it.
    const needsRebind = (p) => Boolean(p.useAmbientKey) && !profileKey(p) && !p.cookie;
    const entries = Object.entries(profiles)
      .filter(([, p]) => (p.cookie || profileKey(p) || needsRebind(p)) && p.enabled);

    // Query all profiles in parallel
    const results = await Promise.all(
      entries.map(async ([name, profile]) => {
        const apiKey = profileKey(profile);
        if (needsRebind(profile)) {
          return [name, {
            linked: false,
            expired: false,
            go: false,
            zen: false,
            hasBalance: false,
            balanceUsd: null,
            needsRebind: true
          }];
        }
        // An API key reaches Go quota and nothing else, so it reports the same
        // shape as a cookie with the Zen half permanently absent. Without this
        // branch an API account is never probed and the panel sits at "0/1".
        // Only a cookie account can be probed for Zen, so a profile holding both
        // falls through to the cookie path and its key is used by the collector.
        if (apiKey && !profile.cookie) {
          const probe = await probeOpenCodeApiKey(apiKey);
          // The renderer checks `linked` before `error`, so anything short of a
          // working key must not claim linked or it renders a bare "✓" with no
          // plan behind it.
          if (probe.status === 'ok') {
            return [name, { linked: true, expired: false, go: true, zen: false, hasBalance: false, balanceUsd: null }];
          }
          if (probe.status === 'unauthorized') {
            return [name, { linked: true, expired: true, go: false, zen: false, hasBalance: false, balanceUsd: null }];
          }
          return [name, {
            linked: false,
            expired: false,
            go: false,
            zen: false,
            hasBalance: false,
            balanceUsd: null,
            error: probe.status
          }];
        }
        const [go, zen, apiProbe] = await Promise.all([
          opencodeWeb.fetchGoWeb(profile.cookie, electronProviderDeps()),
          opencodeWeb.fetchZen(profile.cookie, electronProviderDeps()),
          apiKey ? probeOpenCodeApiKey(apiKey) : null
        ]);
        const summary = { ...opencodeWeb.summarizeLink(go, zen), balanceUsd: zen.balanceUsd };
        // A bound key answers for Go on its own, so the row must not read as
        // expired just because the cookie half died: the collector still has
        // quota, and only the Zen balance is actually missing.
        if (apiProbe?.status === 'ok') {
          summary.go = true;
          summary.linked = true;
          summary.expired = false;
          delete summary.error;
        }
        return [name, summary];
      })
    );

    const result = Object.fromEntries(results);

    // Legacy env cookie. Skip it when it matches an enabled profile so the
    // panel doesn't report an extra "connected" account that the collector
    // dedupes away (otherwise it shows 2/2 while only one account is tracked).
    const envCookie = process.env.TOKEN_MONITOR_OPENCODE_COOKIE || '';
    if (envCookie && !entries.some(([, p]) => p.cookie === envCookie)) {
      const [go, zen] = await Promise.all([
        opencodeWeb.fetchGoWeb(envCookie, electronProviderDeps()),
        opencodeWeb.fetchZen(envCookie, electronProviderDeps())
      ]);
      let envKey = 'env';
      for (let i = 1; Object.prototype.hasOwnProperty.call(profiles, envKey); i += 1) {
        envKey = `env:${i}`;
      }
      result[envKey] = { ...opencodeWeb.summarizeLink(go, zen), balanceUsd: zen.balanceUsd, env: true };
    }
    // Zero configuration still has an account behind it. Without probing the key
    // OpenCode stored for itself, the panel reports "not set up" while the limits
    // card is showing live quota read from that very key.
    //
    // It rides in its own field rather than under a reserved name inside
    // `profiles`: account names are user-chosen, so any sentinel key is one a
    // user can also type, and the synthetic entry would then overwrite their
    // account's real status (and collide with its DOM id in the renderer).
    let ambient = null;
    if (opencodeAmbientKeyActive(profiles) && settings.opencodeAmbientEnabled === false) {
      ambient = { linked: false, expired: false, go: false, zen: false, hasBalance: false, balanceUsd: null, ambient: true, disabled: true };
    } else if (opencodeAmbientKeyActive(profiles)) {
      const probe = await probeOpenCodeApiKey(opencodeGoApi.readGoApiKey(process.env));
      ambient = {
        linked: probe.status === 'ok',
        expired: probe.status === 'unauthorized',
        go: probe.status === 'ok',
        zen: false,
        hasBalance: false,
        balanceUsd: null,
        ambient: true,
        ...(probe.status === 'ok' || probe.status === 'unauthorized' ? {} : { error: probe.status })
      };
    }
    const value = {
      profiles: result,
      ambient,
      linked: Object.values(result).some(s => s.linked) || Boolean(ambient?.linked)
    };
    opencodeStatusCache = { value, at: now };
    return value;
  });
  ipcMain.handle('opencode:getProfiles', async () => {
    const profiles = settings.opencodeProfiles || {};
    // The Go quota also arrives with no configuration at all, from the key
    // OpenCode itself stores. Without counting that, the panel reports "not set
    // up" while the limits card is showing live API data from the same account.
    const hasEnvVar = Boolean(process.env.TOKEN_MONITOR_OPENCODE_COOKIE);
    // Kept as its own field rather than folded into hasEnvVar: an environment
    // cookie and a key OpenCode stored for itself are different sources, and a
    // later reader seeing hasEnvVar would reasonably assume the former.
    const hasAmbientKey = opencodeAmbientKeyActive(profiles);
    // Credential values never cross to the renderer; which kinds exist does, so
    // the list can show what a profile actually holds.
    const ambientKey = opencodeGoApi.readGoApiKey(process.env);
    const ambientIdentity = ambientKey ? opencodeGoApi.goApiIdentity(ambientKey) : '';
    // Keyed on user-typed names, so it must not inherit one. Structured clone
    // hands the renderer a plain object either way.
    const safe = Object.create(null);
    for (const [name, p] of Object.entries(profiles)) {
      safe[name] = {
        enabled: p.enabled,
        hasApiKey: Boolean(p.apiKey),
        hasCookie: Boolean(p.cookie),
        usesAmbientKey: Boolean(p.useAmbientKey),
        // Held but not resolving, because the key it was bound to is no longer
        // the one on this machine. Without saying so the list shows the
        // credential as present while the collector ignores it, and on an
        // account that also has a cookie nothing else would reveal it.
        ambientStale: Boolean(p.useAmbientKey)
          && !opencodeProfiles.ambientKeyFor(p, ambientKey, ambientIdentity)
      };
    }
    return {
      profiles: safe,
      hasEnvVar,
      hasAmbientKey,
      ambientEnabled: settings.opencodeAmbientEnabled !== false
    };
  });
  // `kind` defaults to 'cookie' so an older renderer calling with two arguments
  // keeps its existing behavior.
  ipcMain.handle('opencode:saveProfile', async (_event, name, raw, kind = 'cookie', options = {}) => {
    // Trimmed, so whitespace cannot create an account name that renders blank
    // and that nobody could ever type again to attach a second credential.
    name = String(name || '').trim();
    if (!name) return { ok: false, error: 'Empty name' };
    // Reject anything else rather than treating it as a cookie: an unrecognized
    // kind would store the value in the wrong field and read as a credential it
    // is not.
    if (!['api', 'cookie', 'ambient'].includes(kind)) {
      return { ok: false, error: `Unknown credential kind: ${kind}` };
    }
    try {
      let credential;
      if (kind === 'ambient') {
        // Naming the auto-detected credential. A reference is stored, never the
        // key itself, so the key is re-read every tick rather than going stale
        // at 401 behind a snapshot.
        const ambientKey = opencodeGoApi.readGoApiKey(process.env);
        if (!ambientKey) {
          return { ok: false, error: 'No OpenCode credential found on this machine' };
        }
        // Records which account the reference was bound to, so a key that later
        // changes stops resolving here instead of quietly pairing whoever is
        // signed in next with this account's cookie. It is a digest, not the
        // key: the value itself is never stored for this credential kind.
        credential = {
          useAmbientKey: true,
          ambientKeyIdentity: opencodeGoApi.goApiIdentity(ambientKey)
        };
      } else if (kind === 'api') {
        const apiKey = String(raw || '').trim();
        if (!apiKey) return { ok: false, error: 'Empty API key' };
        const probe = await probeOpenCodeApiKey(apiKey);
        if (probe.status === 'unauthorized') {
          return { ok: false, error: 'OpenCode rejected the API key' };
        }
        // The key authenticates but the workspace has no Go plan, so this
        // profile would render permanently empty. Say so instead of saving it.
        if (probe.status === 'notConfigured') {
          return { ok: false, error: 'That account has no OpenCode Go subscription' };
        }
        if (probe.status !== 'ok') {
          return { ok: false, error: 'Could not reach the OpenCode usage API' };
        }
        credential = { apiKey };
      } else {
        const cookie = opencodeWeb.sanitizeCookieHeader(raw);
        if (!cookie) return { ok: false, error: 'Empty cookie' };
        const [go, zen] = await Promise.all([
          opencodeWeb.fetchGoWeb(cookie, electronProviderDeps()),
          opencodeWeb.fetchZen(cookie, electronProviderDeps())
        ]);
        if (opencodeWeb.summarizeLink(go, zen).expired) {
          return { ok: false, error: 'OpenCode rejected the cookie (it may be expired)' };
        }
        credential = { cookie };
      }
      // Saving one credential replaces only that kind and keeps the others. Two
      // kinds under one profile name is how a user says "these are the same
      // account", which is the only thing that licenses reading Go quota from
      // the key while Zen balance comes from the cookie. Nothing associates them
      // automatically — same machine is not evidence of same account — so the
      // binding is refused here until the caller confirms it, whichever UI path
      // asked. A blur that happens to land on an existing name must not be able
      // to make that claim on the user's behalf.
      const ambientWasActive = opencodeAmbientKeyActive(settings.opencodeProfiles || {});
      const result = opencodeProfiles.saveCredential(
        settings.opencodeProfiles || {},
        name,
        credential,
        { merge: options.merge === true }
      );
      if (!result.ok) return result;
      settings.opencodeProfiles = result.profiles;
      saveSettings({ throwOnError: true });
      opencodeStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'opencode', accountName: name }, 'profile-save');
      refreshOpencodeAmbientOwnership(ambientWasActive);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('opencode:deleteProfile', async (_event, name) => {
    const profiles = settings.opencodeProfiles || {};
    const ambientWasActive = opencodeAmbientKeyActive(profiles);
    const deletedProfile = opencodeProfiles.readProfile(profiles, name);
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
    refreshOpencodeAmbientOwnership(ambientWasActive);
    return { ok: true };
  });
  // Removes one credential from an account, leaving the others. Deleting the
  // account removes all of them; this is how a binding is undone without
  // losing the credential the user wanted to keep.
  ipcMain.handle('opencode:removeCredential', async (_event, name, kind) => {
    const ambientWasActive = opencodeAmbientKeyActive(settings.opencodeProfiles || {});
    const result = opencodeProfiles.removeCredential(settings.opencodeProfiles || {}, name, kind);
    if (!result.ok) return result;
    if (result.removedCookie && settings.opencodeCookie === result.removedCookie) {
      settings.opencodeCookie = '';
    }
    settings.opencodeProfiles = result.profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist OpenCode credential removal' };
    }
    opencodeStatusCache = { value: null, at: 0 };
    void queueLimitInvalidation({ provider: 'opencode', accountName: name }, 'credential-remove', {
      clear: true
    });
    refreshOpencodeAmbientOwnership(ambientWasActive);
    return { ok: true };
  });
  // Moves one credential to another account name, creating it when needed. This
  // is what "rename a credential" means in a model where the name is the
  // account: moving it to a fresh name splits it off, moving it onto an
  // existing name binds it there. The value never crosses to the renderer.
  ipcMain.handle('opencode:moveCredential', async (_event, name, kind, targetName, options = {}) => {
    const ambientWasActive = opencodeAmbientKeyActive(settings.opencodeProfiles || {});
    const result = opencodeProfiles.moveCredential(
      settings.opencodeProfiles || {},
      name,
      kind,
      targetName,
      { merge: options.merge === true }
    );
    if (!result.ok) return result;
    if (result.unchanged) return { ok: true };
    const target = String(targetName || '').trim();
    settings.opencodeProfiles = result.profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist OpenCode credential move' };
    }
    opencodeStatusCache = { value: null, at: 0 };
    for (const account of [name, target]) {
      void queueLimitInvalidation({ provider: 'opencode', accountName: account }, 'credential-move', {
        clear: true
      });
    }
    refreshOpencodeAmbientOwnership(ambientWasActive);
    return { ok: true };
  });
  // `merge` is the caller confirming that renaming onto an existing account
  // asserts the two are the same OpenCode account — the same claim as saving a
  // second credential under one name, and the only thing that licenses reading
  // quota from one credential while identity comes from another. Without it an
  // existing name is refused, so the assertion is never made by accident.
  ipcMain.handle('opencode:renameProfile', async (_event, oldName, newName, options = {}) => {
    const ambientWasActive = opencodeAmbientKeyActive(settings.opencodeProfiles || {});
    const result = opencodeProfiles.renameProfile(
      settings.opencodeProfiles || {},
      oldName,
      newName,
      { merge: options.merge === true }
    );
    if (!result.ok) return result;
    settings.opencodeProfiles = result.profiles;
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
    refreshOpencodeAmbientOwnership(ambientWasActive);
    return { ok: true };
  });
  ipcMain.handle('opencode:setProfileEnabled', async (_event, name, enabled) => {
    const profiles = settings.opencodeProfiles || {};
    // Own properties only. An inherited key resolves to an object that is not an
    // account, and writing `enabled` onto it would reach whatever else shares
    // that prototype.
    const profile = opencodeProfiles.readProfile(profiles, name);
    if (!profile) return { ok: false, error: 'Profile not found' };
    profile.enabled = Boolean(enabled);
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
  // The auto-detected account has no stored record to carry an enabled flag, so
  // its switch is a device preference rather than a credential. Writing one
  // instead would mean a toggle that creates an account under a name the user
  // can also type, cannot be undone symmetrically once that account is edited,
  // and quietly comes back enabled when the key it pinned is rotated.
  ipcMain.handle('opencode:setAmbientEnabled', async (_event, enabled) => {
    settings.opencodeAmbientEnabled = enabled !== false;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist the OpenCode detection setting' };
    }
    opencodeStatusCache = { value: null, at: 0 };
    // Provider-wide, for the same reason every ownership change is: this row has
    // no account name for a scoped refresh to address. It must still refresh
    // afterwards. Clearing without one wipes every OpenCode account and rebuilds
    // none of them, so switching off the detected key read as switching off the
    // whole provider — the rest of the accounts are unaffected by this setting
    // and have to come straight back.
    void queueLimitInvalidation({ provider: 'opencode' }, 'ambient-toggle', { clear: true });
    return { ok: true };
  });
  ipcMain.handle('openrouter:getProfiles', async () => {
    return {
      profiles: redactOpenRouterProfilesForRenderer(settings.openrouterProfiles || {}),
      hasEnvVar: Boolean(openrouterLimits.openrouterToken(process.env))
    };
  });
  ipcMain.handle('openrouter:saveProfile', async (_event, rawName, rawApiKey) => {
    const name = openrouterLimits.openrouterProfileName(rawName);
    const apiKey = openrouterLimits.openrouterToken({}, rawApiKey);
    if (!name) return { ok: false, errorCode: 'invalidName' };
    if (!apiKey) return { ok: false, errorCode: 'missingApiKey' };
    try {
      const provider = await openrouterLimits.fetchOpenRouterAccount(name, apiKey, electronProviderDeps({
        env: process.env,
        signal: AbortSignal.timeout(15_000)
      }));
      if (provider?.status !== 'ok') {
        return { ok: false, error: provider?.status === 'unauthorized' ? 'OpenRouter rejected the API key' : 'Could not validate the OpenRouter API key' };
      }
      settings.openrouterProfiles = {
        ...(settings.openrouterProfiles || {}),
        [name]: { apiKey, enabled: true }
      };
      saveSettings({ throwOnError: true });
      void queueLimitInvalidation({ provider: 'openrouter', accountName: name }, 'profile-save');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not validate the OpenRouter API key' };
    }
  });
  ipcMain.handle('openrouter:deleteProfile', async (_event, rawName) => {
    const name = String(rawName || '').trim();
    const profiles = { ...(settings.openrouterProfiles || {}) };
    if (!profiles[name]) return { ok: false, error: 'Profile not found' };
    delete profiles[name];
    settings.openrouterProfiles = profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist OpenRouter profile deletion' };
    }
    void queueLimitInvalidation({ provider: 'openrouter', accountName: name }, 'profile-delete', {
      clear: true,
      refresh: false
    });
    return { ok: true };
  });
  ipcMain.handle('openrouter:renameProfile', async (_event, rawOldName, rawNewName) => {
    const oldName = String(rawOldName || '').trim();
    const newName = openrouterLimits.openrouterProfileName(rawNewName);
    const profiles = { ...(settings.openrouterProfiles || {}) };
    if (!newName || oldName === newName) return { ok: false, errorCode: 'invalidName' };
    if (!profiles[oldName]) return { ok: false, error: 'Profile not found' };
    if (profiles[newName]) return { ok: false, error: 'Profile name already exists' };
    profiles[newName] = profiles[oldName];
    delete profiles[oldName];
    settings.openrouterProfiles = profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist OpenRouter profile rename' };
    }
    void queueLimitInvalidation({ provider: 'openrouter', accountName: oldName }, 'profile-rename', {
      clear: true,
      refresh: false
    });
    void queueLimitInvalidation({ provider: 'openrouter', accountName: newName }, 'profile-rename');
    return { ok: true };
  });
  ipcMain.handle('openrouter:setProfileEnabled', async (_event, rawName, enabled) => {
    const name = String(rawName || '').trim();
    const profiles = { ...(settings.openrouterProfiles || {}) };
    if (!profiles[name]) return { ok: false, error: 'Profile not found' };
    profiles[name] = { ...profiles[name], enabled: Boolean(enabled) };
    settings.openrouterProfiles = profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist OpenRouter profile state' };
    }
    void queueLimitInvalidation({ provider: 'openrouter', accountName: name }, 'profile-state', {
      clear: !enabled,
      refresh: Boolean(enabled)
    });
    return { ok: true };
  });
  ipcMain.handle('thirdparty:getProfiles', async () => {
    return {
      profiles: redactThirdPartyProfilesForRenderer(settings.thirdPartyProfiles || {}),
      hasEnvVar: thirdPartyLimits.configuredAccounts({}, { env: process.env }).length > 0
    };
  });
  ipcMain.handle('thirdparty:saveProfile', async (_event, rawProfile = {}) => {
    const name = thirdPartyLimits.thirdPartyProfileName(rawProfile.name);
    const adapter = thirdPartyLimits.normalizeAdapterId(rawProfile.adapter);
    const customAdapter = adapter === thirdPartyLimits.CUSTOM_BALANCE_ADAPTER;
    const baseUrl = thirdPartyLimits.normalizeThirdPartyBaseUrl(rawProfile.baseUrl, {
      stripTerminalV1: !customAdapter
    });
    if (!name) return { ok: false, errorCode: 'invalidName' };
    if (!adapter) return { ok: false, errorCode: 'invalidAdapter' };
    if (!baseUrl) return { ok: false, errorCode: 'invalidBaseUrl' };
    if (
      adapter === thirdPartyLimits.NEWAPI_ACCOUNT_ADAPTER
      && !thirdPartyLimits.newapiAccessToken({}, rawProfile.accessToken)
    ) return { ok: false, errorCode: 'missingAccessToken' };
    if (
      [thirdPartyLimits.NEWAPI_TOKEN_ADAPTER, thirdPartyLimits.CUSTOM_BALANCE_ADAPTER].includes(adapter)
      && !thirdPartyLimits.newapiApiKey({}, rawProfile.apiKey)
    ) return { ok: false, errorCode: 'missingApiKey' };
    if (
      customAdapter
      && !thirdPartyLimits.normalizeCustomEndpointPath(rawProfile.endpointPath)
    ) return { ok: false, errorCode: 'invalidEndpointPath' };
    if (
      customAdapter
      && !thirdPartyLimits.normalizeCustomAuthMode(rawProfile.authMode)
    ) return { ok: false, errorCode: 'invalidAuthMode' };
    if (
      customAdapter
      && (
        !thirdPartyLimits.normalizeCustomJsonPath(rawProfile.remainingPath)
        || (
          String(rawProfile.usedPath || '').trim()
          && !thirdPartyLimits.normalizeCustomJsonPath(rawProfile.usedPath)
        )
        || (
          String(rawProfile.totalPath || '').trim()
          && !thirdPartyLimits.normalizeCustomJsonPath(rawProfile.totalPath)
        )
      )
    ) return { ok: false, errorCode: 'invalidJsonPath' };
    if (
      customAdapter
      && !thirdPartyLimits.normalizeCustomCurrency(rawProfile.currency)
    ) return { ok: false, errorCode: 'invalidCurrency' };
    if (
      customAdapter
      && thirdPartyLimits.normalizeCustomDivisor(rawProfile.divisor) === null
    ) return { ok: false, errorCode: 'invalidDivisor' };
    const profile = thirdPartyLimits.normalizeThirdPartyProfile({
      ...rawProfile,
      adapter,
      baseUrl,
      enabled: true
    });
    if (!profile) return { ok: false, errorCode: 'invalidCredential' };
    try {
      const provider = await thirdPartyLimits.fetchThirdPartyAccount({ name, ...profile }, electronProviderDeps({
        env: process.env,
        signal: AbortSignal.timeout(15_000)
      }));
      if (provider?.status !== 'ok') {
        return {
          ok: false,
          errorCode: provider?.status === 'unauthorized' ? 'invalidCredential' : 'unavailable'
        };
      }
      settings.thirdPartyProfiles = {
        ...(settings.thirdPartyProfiles || {}),
        [name]: profile
      };
      saveSettings({ throwOnError: true });
      void queueLimitInvalidation({ provider: 'thirdparty', accountName: name }, 'profile-save');
      return { ok: true };
    } catch (_) {
      return { ok: false, errorCode: 'unavailable' };
    }
  });
  ipcMain.handle('thirdparty:deleteProfile', async (_event, rawName) => {
    const name = String(rawName || '').trim();
    const profiles = { ...(settings.thirdPartyProfiles || {}) };
    if (!profiles[name]) return { ok: false, error: 'Profile not found' };
    delete profiles[name];
    settings.thirdPartyProfiles = profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist third-party API profile deletion' };
    }
    void queueLimitInvalidation({ provider: 'thirdparty', accountName: name }, 'profile-delete', {
      clear: true,
      refresh: false
    });
    return { ok: true };
  });
  ipcMain.handle('thirdparty:renameProfile', async (_event, rawOldName, rawNewName) => {
    const oldName = String(rawOldName || '').trim();
    const newName = thirdPartyLimits.thirdPartyProfileName(rawNewName);
    const profiles = { ...(settings.thirdPartyProfiles || {}) };
    if (!newName || oldName === newName) return { ok: false, errorCode: 'invalidName' };
    if (!profiles[oldName]) return { ok: false, error: 'Profile not found' };
    if (profiles[newName]) return { ok: false, error: 'Profile name already exists' };
    profiles[newName] = profiles[oldName];
    delete profiles[oldName];
    settings.thirdPartyProfiles = profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist third-party API profile rename' };
    }
    void queueLimitInvalidation({ provider: 'thirdparty', accountName: oldName }, 'profile-rename', {
      clear: true,
      refresh: false
    });
    void queueLimitInvalidation({ provider: 'thirdparty', accountName: newName }, 'profile-rename');
    return { ok: true };
  });
  ipcMain.handle('thirdparty:setProfileEnabled', async (_event, rawName, enabled) => {
    const name = String(rawName || '').trim();
    const profiles = { ...(settings.thirdPartyProfiles || {}) };
    if (!profiles[name]) return { ok: false, error: 'Profile not found' };
    profiles[name] = { ...profiles[name], enabled: Boolean(enabled) };
    settings.thirdPartyProfiles = profiles;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist third-party API profile state' };
    }
    void queueLimitInvalidation({ provider: 'thirdparty', accountName: name }, 'profile-state', {
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
        selectWorkspace: ({ email, currentWorkspaceId, workspaces }) => new Promise((resolve) => {
          const finish = (workspaceId) => {
            if (codexWorkspaceSelection?.controller === controller) codexWorkspaceSelection = null;
            controller.signal.removeEventListener('abort', onAbort);
            resolve(workspaceId);
          };
          const onAbort = () => finish('');
          codexWorkspaceSelection = {
            controller,
            flowId,
            webContentsId: event.sender.id,
            workspaceIds: new Set(workspaces.map((workspace) => workspace.id)),
            finish
          };
          controller.signal.addEventListener('abort', onAbort, { once: true });
          sendStatus({
            phase: 'workspaceSelection',
            email,
            currentWorkspaceId,
            workspaces: workspaces.map(({ id, label, workspaceKind }) => ({ id, label, workspaceKind }))
          });
        }),
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
        if (codexWorkspaceSelection?.controller === controller) codexWorkspaceSelection.finish('');
        codexLoginController = null;
        codexLoginFlowId = '';
        codexLoginCanCancel = false;
      }
    }
  });
  ipcMain.handle('codex:selectWorkspace', (event, request = {}) => {
    const flowId = String(request?.flowId || '').trim();
    const workspaceId = normalizeWorkspaceId(request?.workspaceId);
    const pending = codexWorkspaceSelection;
    if (!pending || pending.webContentsId !== event.sender.id) return { ok: false, stale: true };
    if (flowId && pending.flowId && flowId !== pending.flowId) return { ok: false, stale: true };
    if (!workspaceId || !pending.workspaceIds.has(workspaceId)) {
      return { ok: false, error: 'Unknown Codex workspace.' };
    }
    pending.finish(workspaceId);
    return { ok: true };
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
  ipcMain.handle('dashboard:getHistory', (_event, options) => getDashboardHistory(options));
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
// Every quit route (Cmd+Q, last window closed, system shutdown) lands here.
// performQuit is synchronous through to the exit, so there is nothing to wait
// for and deliberately no preventDefault: taking the quit over would cancel an
// OS-initiated logout or restart on macOS.
app.on('before-quit', () => {
  quitRequested = true;
  resetMacWidgetReloadThrottle();
  if (rateRefreshTimer) clearInterval(rateRefreshTimer);
  if (appUpdateBackgroundTimer) clearInterval(appUpdateBackgroundTimer);
  unregisterWindowToggleShortcut();
  if (skipForcedQuit) return;
  performQuit();
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, requestAppQuit);
}
