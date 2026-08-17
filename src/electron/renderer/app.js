'use strict';

const clientLabels = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes Agent', gemini: 'Gemini', cursor: 'Cursor', opencode: 'OpenCode', openclaw: 'OpenClaw', antigravity: 'Antigravity', cline: 'Cline', kimi: 'Kimi', qwen: 'Qwen', grok: 'Grok Build', copilot: 'GitHub Copilot', pi: 'Pi', zed: 'Zed', kilocode: 'Kilo Code', commandcode: 'Command Code', micode: 'MiMo Code', zcode: 'ZCode', kiro: 'Kiro', codebuddy: 'CodeBuddy', workbuddy: 'WorkBuddy', proma: 'Proma', qodercn: 'Qoder CN', reasonix: 'Reasonix' };
const reasonixSessionGuard = window.TokenMonitorReasonixSessionGuard;
const { clientColors, fallbackModelColors, modelVendorFor, modelColor } = window.TokenMonitorUsageCharts;
const motionPreferenceApi = window.TokenMonitorMotionPreference;
const windowsGlassApi = window.TokenMonitorWindowsGlass;
const glassRenderingApi = window.TokenMonitorGlassRendering;
const fontSettingsApi = window.TokenMonitorFontSettings;
const wslStatusPresentationApi = window.TokenMonitorWslStatusPresentation;
const statsRenderSchedulerApi = window.TokenMonitorStatsRenderScheduler;
const tokenRateApi = window.TokenMonitorTokenRate;
const { tokenRatePerSecond, tokenBurnPerMinute } = tokenRateApi;
const reducedMotionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const clientsWithIcon = new Set([
  'claude', 'codex', 'gemini', 'cursor', 'opencode', 'openclaw', 'hermes', 'antigravity', 'cline', 'kimi', 'qwen', 'grok', 'copilot', 'pi', 'zed', 'kilocode', 'commandcode', 'micode', 'zcode', 'kiro', 'codebuddy', 'workbuddy', 'proma', 'qodercn', 'reasonix',
  'xai', 'openrouter', 'deepseek', 'meta', 'mistral', 'qwen', 'moonshot', 'zai', 'zaiteam', 'cohere', 'xiaomi', 'mimo', 'minimax', 'doubao', 'volcengine', 'qoder', 'ollama', 'thirdparty', 'hunyuan'
]);

function osIconFor(platform) {
  const prefix = String(platform || '').toLowerCase().split('-')[0];
  if (prefix === 'darwin') return 'apple';
  if (prefix === 'win32') return 'windows';
  if (prefix === 'linux' || prefix === 'freebsd' || prefix === 'openbsd') return 'linux';
  return null;
}

function iconKindFor(rowData, breakdown) {
  if (!toolIconsEnabled(state.settings?.showToolIcons)) return { kind: 'dot' };
  if (breakdown === 'device') {
    const os = osIconFor(rowData.platform);
    return os ? { kind: 'icon', iconClass: `row-icon-os-${os}` } : { kind: 'dot' };
  }
  if (breakdown === 'model') {
    const vendor = modelVendorFor(rowData.key);
    return vendor && clientsWithIcon.has(vendor)
      ? { kind: 'icon', iconClass: `row-icon-${vendor}` }
      : { kind: 'dot' };
  }
  if (breakdown === 'session') {
    return rowData.client && clientsWithIcon.has(rowData.client)
      ? { kind: 'icon', iconClass: `row-icon-${rowData.client}` }
      : { kind: 'dot' };
  }
  if (breakdown === 'project') return { kind: 'icon', iconClass: 'row-icon-project' };
  return clientsWithIcon.has(rowData.key)
    ? { kind: 'icon', iconClass: `row-icon-${rowData.key}` }
    : { kind: 'dot' };
}

const KNOWN_CLIENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'hermes', label: 'Hermes Agent' },
  { id: 'openclaw', label: 'OpenClaw' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'cline', label: 'Cline' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'qwen', label: 'Qwen' },
  { id: 'grok', label: 'Grok Build' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'pi', label: 'Pi' },
  { id: 'zed', label: 'Zed' },
  { id: 'kilocode', label: 'Kilo Code' },
  { id: 'commandcode', label: 'Command Code' },
  { id: 'micode', label: 'MiMo Code' },
  { id: 'zcode', label: 'ZCode' },
  { id: 'kiro', label: 'Kiro' },
  { id: 'codebuddy', label: 'CodeBuddy' },
  { id: 'workbuddy', label: 'WorkBuddy' },
  { id: 'proma', label: 'Proma' },
  { id: 'qodercn', label: 'Qoder CN' },
  { id: 'reasonix', label: 'Reasonix' }
];
const LIMIT_PROVIDERS = [
  { id: 'claude', label: 'Claude', settingsLabel: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'grok', label: 'Grok' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'commandcode', label: 'Command Code' },
  { id: 'mimo', label: 'MiMo' },
  { id: 'zai', label: 'GLM' },
  { id: 'zaiteam', label: 'GLM Team' },
  { id: 'kiro', label: 'Kiro' },
  { id: 'qoder', label: 'Qoder' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'minimax', label: 'Minimax' },
  { id: 'volcengine', label: 'Volcengine' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'thirdparty', label: 'Third-party APIs' }
];
const LIMIT_PROVIDER_ACCOUNT_GROUP_IDS = {
  claude: 'claudeAccountGroup',
  codex: 'codexAccountGroup',
  opencode: 'opencodeCookieGroup',
  cursor: 'cursorAccountGroup',
  kimi: 'kimiAccountGroup',
  copilot: 'copilotAccountGroup',
  mimo: 'mimoAccountGroup',
  zai: 'zaiAccountGroup',
  zaiteam: 'zaiteamAccountGroup',
  deepseek: 'deepseekAccountGroup',
  openrouter: 'openrouterAccountGroup',
  minimax: 'minimaxAccountGroup',
  volcengine: 'volcengineAccountGroup',
  qoder: 'qoderAccountGroup',
  commandcode: 'commandcodeAccountGroup',
  ollama: 'ollamaAccountGroup',
  thirdparty: 'thirdpartyAccountGroup'
};
const LIMIT_PROVIDER_ACCOUNT_STATUS_IDS = {
  claude: 'claudeAccountStatus',
  codex: 'codexAccountStatus',
  opencode: 'opencodeCookieStatus',
  cursor: 'cursorAccountStatus',
  kimi: 'kimiAccountStatus',
  copilot: 'copilotApiTokenStatus',
  mimo: 'mimoAccountStatus',
  zai: 'zaiAccountStatus',
  zaiteam: 'zaiteamAccountStatus',
  deepseek: 'deepseekApiKeyStatus',
  openrouter: 'openrouterStatus',
  minimax: 'minimaxApiKeyStatus',
  volcengine: 'volcengineAccountStatus',
  qoder: 'qoderAccountStatus',
  commandcode: 'commandcodeAccountStatus',
  ollama: 'ollamaAccountStatus',
  thirdparty: 'thirdpartyStatus'
};
const LIMIT_PROVIDER_CONNECTION_DETAIL_KEYS = {
  antigravity: 'settings.limits.connection.antigravity',
  grok: 'settings.limits.connection.grok',
  kiro: 'settings.limits.connection.kiro'
};
const TRAY_ICON_VARIANTS = [
  { id: 'claude-brand', label: 'Claude', after: 'claude' },
  { id: 'chatgpt', label: 'ChatGPT', after: 'codex' }
];
const trayIconProviderIds = new Set([
  ...clientsWithIcon,
  ...TRAY_ICON_VARIANTS.map((provider) => provider.id)
]);
const TRAY_ICON_PROVIDERS = [
  ...KNOWN_CLIENTS.flatMap((provider) => [
    provider,
    ...TRAY_ICON_VARIANTS.filter((variant) => variant.after === provider.id)
  ]),
  ...LIMIT_PROVIDERS
]
  .filter((provider, index, providers) => (
    trayIconProviderIds.has(provider.id)
    && providers.findIndex((entry) => entry.id === provider.id) === index
  ));
const DEFAULT_LIMIT_PROVIDER_ORDER = LIMIT_PROVIDERS.map((provider) => provider.id).join(',');
const limitProviderOrderApi = window.TokenMonitorLimitProviderOrder;
const limitProviderPresentationApi = window.TokenMonitorLimitProviderPresentation;
const appUpdatePresentationApi = window.TokenMonitorAppUpdatePresentation;
const accountIdentityApi = window.TokenMonitorAccountIdentity;
const clientStatusPresentationApi = window.TokenMonitorClientStatusPresentation;
const clientHealthPresentationApi = window.TokenMonitorClientHealthPresentation;
const clientSourceCacheApi = window.TokenMonitorClientSourceCache;
const clientRescanStateApi = window.TokenMonitorClientRescanState;
const serviceStatusPresentationApi = window.TokenMonitorServiceStatusPresentation;
const clientDisplayPreferencesApi = window.TokenMonitorClientDisplayPreferences;
const customPricingFormApi = window.TokenMonitorCustomPricingForm;
const viewDisplayPreferencesApi = window.TokenMonitorViewDisplayPreferences;
const preferenceDragSortApi = window.TokenMonitorPreferenceDragSort;
const verticalDragSortApi = window.TokenMonitorVerticalDragSort;
const rowDragControllerApi = window.TokenMonitorRowDragController;
const homeOverviewApi = window.TokenMonitorHomeOverview;
const homeModulePreferencesApi = window.TokenMonitorHomeModulePreferences;
const fixedPeriodRangesApi = window.TokenMonitorFixedPeriodRanges;
const hubBuildPresentationApi = window.TokenMonitorHubBuildPresentation;
const { limitFillPercent, limitModeSuffix } = window.TokenMonitorLimitDisplayMode;
const i18n = window.TokenMonitorI18n;
const currencyApi = window.TokenMonitorCurrency;
const subscriptionApi = window.TokenMonitorSubscriptionDisplay;
const compactTokenApi = window.TokenMonitorCompactTokens;
const trayLayoutApi = window.TokenMonitorTrayLayout;
const sessionRowsApi = window.TokenMonitorSessionRows;
const breakdownRenderPolicyApi = window.TokenMonitorBreakdownRenderPolicy;
const {
  createAfterLayoutScheduler,
  isLargeSessionBreakdown,
  rowRenderFingerprint,
  shouldAnimateBreakdownRows,
  toolIconsEnabled
} = breakdownRenderPolicyApi;
const deviceBreakdownApi = window.TokenMonitorDeviceBreakdown;
const usageAttributionRowsApi = window.TokenMonitorUsageAttributionRows;
const projectRowsApi = window.TokenMonitorProjectRows;
const sessionDetailApi = window.TokenMonitorSessionDetail;
const windowShortcutApi = window.TokenMonitorWindowShortcut;
const LIMIT_REFRESH_OPTIONS = [60000, 120000, 300000, 900000, 1800000];
const WINDOW_BEHAVIOR_VALUES = ['floating', 'normal', 'desktop'];
const WINDOW_BEHAVIOR_ICONS = { floating: '⇧', normal: '○', desktop: '⇩' };
const LIMIT_SOURCE_LABELS = { oauth: 'OAuth', cli: 'CLI', web: 'Web', rpc: 'RPC', local: 'Local', api: 'API' };
const LIMIT_CAPABILITY_TAG_KEYS = {
  Auto: 'settings.limits.capability.auto',
  'OAuth/CLI': 'settings.limits.capability.oauthCli',
  'CLI RPC': 'settings.limits.capability.cliRpc',
  'CLI/Web': 'settings.limits.capability.cliWeb',
  'App/CLI RPC': 'settings.limits.capability.appCliRpc',
  'Manual login': 'settings.limits.capability.manualLogin',
  Web: 'settings.limits.capability.web',
  'Web/API': 'settings.limits.capability.webApi',
  'API/Web': 'settings.limits.capability.apiWeb',
  'App/CLI must be open': 'settings.limits.capability.appMustBeOpen',
  RPC: 'settings.limits.capability.rpc',
  'Local/Zen': 'settings.limits.capability.localZen',
  'Pay-as-you-go': 'settings.limits.capability.payg',
  Subscription: 'settings.limits.capability.subscription',
  'Token Plan': 'settings.limits.capability.tokenPlan',
  'Coding Plan': 'settings.limits.capability.codingPlan',
  Relay: 'settings.limits.capability.relay',
  'API key': 'settings.limits.capability.apiKey',
  'AK/SK': 'settings.limits.capability.akSk',
  'GitHub OAuth': 'settings.limits.capability.githubOAuth',
  API: 'settings.limits.capability.api',
  'Add API key': 'settings.limits.status.addApiKey',
  'Update API key': 'settings.limits.status.updateApiKey',
  'Add credential': 'settings.limits.status.addCredential',
  'Update credential': 'settings.limits.status.updateCredential',
  Live: 'settings.limits.status.live',
  Linked: 'settings.limits.status.linked',
  'Sign in': 'settings.limits.status.signIn',
  'Open app or CLI': 'settings.limits.status.openApp',
  'No synced data': 'settings.limits.status.noSyncedData',
  Stale: 'settings.limits.status.stale',
  Disabled: 'settings.limits.status.disabled',
  'Sign in again': 'settings.limits.status.signInAgain',
  'Run grok login': 'settings.limits.status.runGrokLogin',
  'Run kiro-cli login': 'settings.limits.status.runKiroLogin',
  'Re-login': 'settings.limits.status.relogin',
  Limited: 'settings.limits.status.limited',
  'Usage API limited': 'settings.limits.status.usageApiLimited',
  Unavailable: 'settings.limits.status.unavailable',
  'Not set up': 'settings.limits.status.notSetUp',
  Error: 'settings.limits.status.error'
};
const deviceAccent = '#73bdf5';
const deviceStaleColor = '#8c97a7';
const baseBreakdownOrder = ['tool', 'device', 'model', 'project', 'session'];
const VIEW_DISPLAY_OPTIONS = [
  { id: 'home', labelKey: 'views.home' },
  { id: 'tool', labelKey: 'views.tool' },
  { id: 'status', labelKey: 'views.status' },
  { id: 'device', labelKey: 'views.device' },
  { id: 'model', labelKey: 'views.model' },
  { id: 'project', labelKey: 'views.project' },
  { id: 'session', labelKey: 'views.session' },
  { id: 'limits', labelKey: 'views.limits' },
  { id: 'trends', labelKey: 'views.trends' }
];
const viewPeriodValues = new Set(['today', 'month', 'week', 'last7', 'last30', 'allTime']);
const viewBreakdownValues = new Set(['home', ...baseBreakdownOrder, 'status', 'limits', 'trends']);
const HOME_MODULE_OPTIONS = [
  { id: 'limits', labelKey: 'home.limits', viewId: 'limits' },
  { id: 'tool', labelKey: 'home.tools', viewId: 'tool' },
  { id: 'device', labelKey: 'home.devices', viewId: 'device' },
  { id: 'model', labelKey: 'home.models', viewId: 'model' },
  { id: 'trends', labelKey: 'home.activity', viewId: 'trends' }
];
const VIEW_SWITCHER_LONG_PRESS_MS = 420;
const VIEW_SWITCHER_HOVER_CLOSE_MS = 160;
const VIEW_ICON_CLASSES = {
  home: 'view-icon-home',
  tool: 'view-icon-tool',
  status: 'view-icon-status',
  device: 'view-icon-device',
  model: 'view-icon-model',
  project: 'view-icon-project',
  session: 'view-icon-session',
  limits: 'view-icon-limits',
  trends: 'view-icon-trends'
};
const SERVICE_STATUS_PLACEHOLDERS = [
  { id: 'claude', label: 'Claude', pageUrl: 'https://status.claude.com' },
  { id: 'openai', label: 'OpenAI', pageUrl: 'https://status.openai.com' },
  { id: 'cursor', label: 'Cursor', pageUrl: 'https://status.cursor.com' },
  { id: 'deepseek', label: 'DeepSeek', pageUrl: 'https://status.deepseek.com' }
];
const SERVICE_PROVIDER_OPTIONS = SERVICE_STATUS_PLACEHOLDERS.map((entry) => ({ id: entry.id, label: entry.label }));
const TOKEN_MONITOR_REPOSITORY_URL = 'https://github.com/Javis603/token-monitor';
const TOKEN_MONITOR_ISSUES_URL = `${TOKEN_MONITOR_REPOSITORY_URL}/issues/new/choose`;
const TOKEN_MONITOR_WEBSITE_URL = 'https://javis-ai.com/token-monitor/';
const TOKEN_MONITOR_WSL_SQLITE_GUIDE_URL = `${TOKEN_MONITOR_REPOSITORY_URL}/blob/main/docs/wsl-sqlite-setup.md`;
const serviceStatusProviderPreferencesApi = window.TokenMonitorServiceStatusProviderPreferences;
const SETTINGS_SECTION_IDS = ['general', 'main', 'window', 'appearance', 'tools', 'limits', 'subscriptions', 'sync'];
const REFRESH_BUTTON_FEEDBACK_MS = 700;
const CODEX_PENDING_ACTIVE_GRACE_MS = 30000;
const initialFloatingBubble = window.__TOKEN_MONITOR_INITIAL_FLOATING_BUBBLE__ || { collapsed: false, side: null };
const initialViewState = window.__TOKEN_MONITOR_INITIAL_VIEW_STATE__ || {};
let initialBreakdownPreferenceApplied = typeof initialViewState.breakdown === 'string';

function normalizeInitialViewValue(value, allowed, fallback) {
  const raw = String(value || '').trim();
  return allowed.has(raw) ? raw : fallback;
}

const state = { period: normalizeInitialViewValue(initialViewState.period, viewPeriodValues, 'today'), appUpdate: null, breakdown: normalizeInitialViewValue(initialViewState.breakdown, viewBreakdownValues, 'home'), viewSwitcherOpen: false, viewSwitcherHasOpened: false, limitDetailTooltipHasOpened: false, limitDetailTooltipActive: false, limitDetailTooltipRenderPending: false, settings: null, stats: null, homeHistory: null, homeHistoryBusy: false, homeHistoryRequested: false, homeHistorySignature: '', homeHistoryRetries: 0, homeHistoryRetryTimer: null, homeActivityScrollLeft: null, homeActivityFollowEnd: true, homeActivityResizeObserver: null, serviceStatus: null, serviceStatusBusy: false, serviceProvidersExpanded: false, trendSettingsExpanded: false, trendsActivating: false, homeSettingsExpanded: false, homeLimitSettingsExpanded: false, limitProviderSettingsExpanded: '', clientHealthExpanded: '', clientSources: clientSourceCacheApi.createClientSourceCache(), clientSourcesKey: '', clientSourcesRequest: 0, subscriptionEditingId: '', subscriptionTopUps: [], subscriptionFormBase: null, subscriptionEditorTransitionId: 0, serviceStatusTicker: null, refreshTimer: null, refreshBusy: false, refreshFeedbackTimer: null, currentTotal: 0, rowSignature: '', streamConnected: false, streamFailure: null, mode: 'idle', appInfo: null, systemDarkUi: false, tokscaleStatus: null, tokscaleCheck: null, tokscaleBusy: false, hubInfo: null, hubBuildStatus: null, cursorAccount: { status: null, error: '' }, cursorAccountExpanded: false, codexAccountExpanded: false, codexAccountError: '', codexSignInBusy: false, codexSignInFlowId: '', codexLoginUrl: '', codexLoginStatus: '', codexLoginOutput: '', codexWorkspaceChoices: [], codexWorkspaceId: '', codexActiveAccount: null, codexPendingActiveAccount: null, codexPendingActiveAccountUntil: 0, codexPendingActiveAccountTimer: null, codexSystemSwitchingAccountId: '', codexSystemSwitchErrorAccountId: '', codexSystemSwitchError: '', codexSwitchPopoverHasOpened: false, codexSwitchPopoverActive: false, codexSwitchPopoverRenderPending: false, customPricingExpanded: false, claudeAccountExpanded: false, claudePendingCheckSince: 0, opencodeProfileCount: 0, opencodeCookieExpanded: false, openrouterProfileCount: 0, openrouterAccountExpanded: false, thirdPartyProfileCount: 0, thirdPartyAccountExpanded: false, deepseekAccountExpanded: false, deepseekPendingCheckSince: 0, minimaxAccountExpanded: false, minimaxPendingCheckSince: 0, zaiAccountExpanded: false, zaiPendingCheckSince: 0, zaiteamAccountExpanded: false, zaiteamPendingCheckSince: 0, volcengineAccountExpanded: false, volcenginePendingCheckSince: 0, qoderAccountExpanded: false, qoderPendingCheckSince: 0, commandcodeAccountExpanded: false, commandcodePendingCheckSince: 0, kimiAccountExpanded: false, kimiPendingCheckSince: 0, ollamaAccountExpanded: false, ollamaPendingCheckSince: 0, mimoAccountExpanded: false, mimoAccountError: '', copilotAccountExpanded: false, copilotManualExpanded: false, copilotPendingCheckSince: 0, copilotSignInBusy: false, copilotSignInCancelable: false, copilotSignInFlowId: '', copilotAuthorizeMessage: '', copilotLoginStatus: '', copilotErrorMessage: '', floatingBubble: initialFloatingBubble, suppressInitialNumberAnimation: window.__TOKEN_MONITOR_SUPPRESS_INITIAL_NUMBER_ANIMATION__ === true, openSession: null, detailSort: 'time', recordingWindowShortcut: false, windowShortcutInvalid: false };
state.clientRescans = clientRescanStateApi.createClientRescanState({
  onChange: (clientId) => {
    if (state.clientHealthExpanded === clientId) refillOpenClientHealthPanel();
  }
});
state.toolPreferenceRenderSignature = '';
state.toolPreferenceDetailSignature = '';
state.toolPreferenceSourceSignature = '';
state.limitProviderRenderSignature = '';
state.limitPanelRenderSignature = '';
state.settingsPushRevision = 0;
state.homeHistoryLoadedSignature = '';
state.homeHistoryRetrySignature = '';
state.homeReturnVisible = false;
state.appUpdateNotesPresentedVersion = '';
state.periodMotionActive = false;
state.animateBarsFromZero = false;
state.animateChartsOnRender = true;
state.fixedPeriodHistory = null;
state.fixedPeriodHistoryBusy = false;
state.fixedPeriodHistoryRequested = false;
state.fixedPeriodHistoryFailed = false;
state.fixedPeriodHistorySignature = '';
state.fixedPeriodHistoryRetries = 0;
state.fixedPeriodHistoryRetrySignature = '';
state.fixedPeriodHistoryRetryTimer = null;
state.fixedPeriodHistoryPromise = null;
state.fixedPeriodHistoryCoordinator = null;
state.fixedPeriodSnapshot = null;
state.periodMenuOpen = false;
let directBreakdownOverride = null;
state.projectSettingsExpanded = false;
state.homeActivitySettingsExpanded = false;
state.settingsSections = Object.fromEntries(SETTINGS_SECTION_IDS.map((id) => [id, false]));
const defaultAppearance = { glassOpacity: 68, glassBlur: 32, zoomFactor: 1, systemGlass: true, windowsBackdrop: 'acrylic', reduceMotion: 'system', showLiveDot: true, showToolIcons: true, titleIconOnly: true, showCompactTotalTokens: false, compactTokenUnits: 'western', settingsInTitlebar: false };
let preferenceDrag = null;
let viewSwitcherLongPressTimer = null;
let viewSwitcherLongPressTriggered = false;
let viewSwitcherHoverCloseTimer = null;
const els = {
  shell: document.querySelector('.shell'), status: document.getElementById('status'), liveDot: document.getElementById('liveDot'), tokenRateReveal: document.getElementById('tokenRateReveal'), totalTokens: document.getElementById('totalTokens'), totalTokensCompact: document.getElementById('totalTokensCompact'), cost: document.getElementById('cost'), homePanel: document.getElementById('homePanel'), breakdown: document.getElementById('breakdown'), serviceStatusPanel: document.getElementById('serviceStatusPanel'), limitsPanel: document.getElementById('limitsPanel'), trendsPanel: document.getElementById('trendsPanel'), viewSwitcher: document.getElementById('viewSwitcher'), pinButton: document.getElementById('pinButton'), utilityActions: document.getElementById('utilityActions'), settingsButton: document.getElementById('settingsButton'), settingsPanel: document.getElementById('settingsPanel'), languageInput: document.getElementById('languageInput'), currencyInput: document.getElementById('currencyInput'), currencyRateRow: document.getElementById('currencyRateRow'), currencyRateModeAuto: document.getElementById('currencyRateModeAuto'), currencyRateModeManual: document.getElementById('currencyRateModeManual'), currencyRateManualField: document.getElementById('currencyRateManualField'), currencyRateOverrideInput: document.getElementById('currencyRateOverrideInput'), currencyRateStatus: document.getElementById('currencyRateStatus'), hubUrlInput: document.getElementById('hubUrlInput'), secretInput: document.getElementById('secretInput'), deviceIdInput: document.getElementById('deviceIdInput'), limitProviderCheckboxes: document.getElementById('limitProviderCheckboxes'), limitsRefreshInput: document.getElementById('limitsRefreshInput'), limitsRefreshAdaptiveNote: document.getElementById('limitsRefreshAdaptiveNote'), showLimitSourceInput: document.getElementById('showLimitSourceInput'), maskLimitAccountEmailsInput: document.getElementById('maskLimitAccountEmailsInput'), showLimitUsedInputs: Array.from(document.querySelectorAll('input[name="showLimitUsed"]')), liveDotInput: document.getElementById('liveDotInput'), toolIconsInput: document.getElementById('toolIconsInput'), floatingBubbleInput: document.getElementById('floatingBubbleInput'), floatingBubbleTriggerInputs: Array.from(document.querySelectorAll('input[name="floatingBubbleTrigger"]')), floatingBubbleTriggerRow: document.getElementById('floatingBubbleTriggerRow'), floatingBubbleContentInput: document.getElementById('floatingBubbleContentInput'), floatingBubbleContentRow: document.getElementById('floatingBubbleContentRow'), floatingBubbleComposer: document.getElementById('floatingBubbleComposer'), floatingBubbleContent: document.getElementById('floatingBubbleContent'), discordRpcInput: document.getElementById('discordRpcInput'), windowBehaviorInput: document.getElementById('windowBehaviorInput'), showTrayIconInput: document.getElementById('showTrayIconInput'), showTrayProviderBadgeInput: document.getElementById('showTrayProviderBadgeInput'), trayModeInput: document.getElementById('trayModeInput'), trayContentInput: document.getElementById('trayContentInput'), trayComposer: document.getElementById('trayComposer'), windowToggleShortcutValue: document.getElementById('windowToggleShortcutValue'), windowToggleShortcutClearButton: document.getElementById('windowToggleShortcutClearButton'), windowToggleShortcutNote: document.getElementById('windowToggleShortcutNote'), glassInput: document.getElementById('glassInput'), blurInput: document.getElementById('blurInput'), zoomInput: document.getElementById('zoomInput'), resetGlassButton: document.getElementById('resetGlassButton'), resetDepthButton: document.getElementById('resetDepthButton'), resetZoomButton: document.getElementById('resetZoomButton'), saveSettingsButton: document.getElementById('saveSettingsButton'), clientDisplayList: document.getElementById('clientDisplayList'), wslScanInput: document.getElementById('wslScanInput'), wslScanRow: document.getElementById('wslScanRow'), wslPanel: document.getElementById('wslPanel'), openConfigButton: document.getElementById('openConfigButton'), exportAutoInput: document.getElementById('exportAutoInput'), exportAutoDetails: document.getElementById('exportAutoDetails'), exportAutoStatus: document.getElementById('exportAutoStatus'), exportDirLabel: document.getElementById('exportDirLabel'), exportPickDirButton: document.getElementById('exportPickDirButton'), exportIntervalInput: document.getElementById('exportIntervalInput'), exportNowButton: document.getElementById('exportNowButton'), refreshButton: document.getElementById('refreshButton'), minButton: document.getElementById('minButton'), closeButton: document.getElementById('closeButton'), floatingBubbleTab: document.getElementById('floatingBubbleTab'),
  subscriptionList: document.getElementById('subscriptionList'), subscriptionAddForm: document.getElementById('subscriptionAddForm'), subscriptionAddToggle: document.getElementById('subscriptionAddToggle'), subscriptionAddDetails: document.getElementById('subscriptionAddDetails'), subscriptionProviderInput: document.getElementById('subscriptionProviderInput'), subscriptionAccountInput: document.getElementById('subscriptionAccountInput'), subscriptionPlanNameInput: document.getElementById('subscriptionPlanNameInput'), subscriptionAmountInput: document.getElementById('subscriptionAmountInput'), subscriptionCurrencyInput: document.getElementById('subscriptionCurrencyInput'), subscriptionIntervalCountInput: document.getElementById('subscriptionIntervalCountInput'), subscriptionIntervalInput: document.getElementById('subscriptionIntervalInput'), subscriptionStartDateInput: document.getElementById('subscriptionStartDateInput'), subscriptionAutoRenewInput: document.getElementById('subscriptionAutoRenewInput'), subscriptionNextRenewalInput: document.getElementById('subscriptionNextRenewalInput'), subscriptionNote: document.getElementById('subscriptionNote'), subscriptionOrphanNotice: document.getElementById('subscriptionOrphanNotice'), subscriptionOrphanText: document.getElementById('subscriptionOrphanText'), subscriptionOrphanAdopt: document.getElementById('subscriptionOrphanAdopt'), subscriptionOrphanDiscard: document.getElementById('subscriptionOrphanDiscard'), subscriptionSyncError: document.getElementById('subscriptionSyncError'), subscriptionNextRenewalLabel: document.getElementById('subscriptionNextRenewalLabel'), subscriptionNextRenewalNote: document.getElementById('subscriptionNextRenewalNote'), subscriptionSubmit: document.getElementById('subscriptionSubmit'), subscriptionCancelEdit: document.getElementById('subscriptionCancelEdit'), subscriptionTotalRow: document.getElementById('subscriptionTotalRow'), subscriptionErrorMessage: document.getElementById('subscriptionErrorMessage'), subscriptionPlanFields: document.getElementById('subscriptionPlanFields'), subscriptionTopUpFields: document.getElementById('subscriptionTopUpFields'), subscriptionTopUpList: document.getElementById('subscriptionTopUpList'), subscriptionTopUpDateInput: document.getElementById('subscriptionTopUpDateInput'), subscriptionTopUpAmountInput: document.getElementById('subscriptionTopUpAmountInput'), subscriptionTopUpAddButton: document.getElementById('subscriptionTopUpAddButton'), subscriptionAmountRow: document.getElementById('subscriptionAmountRow'), subscriptionTopUpHeadingRow: document.getElementById('subscriptionTopUpHeadingRow'), subscriptionKindInputs: [...document.querySelectorAll('input[name="subscriptionKind"]')]
};
Object.assign(els, {
  fixedPeriodMessage: document.getElementById('fixedPeriodMessage'),
  monthPeriodMenu: document.getElementById('monthPeriodMenu'),
  monthPeriodTab: document.getElementById('monthPeriodTab'),
  periodMonthModeInput: document.getElementById('periodMonthModeInput')
});
Object.assign(els, {
  appTitleMark: document.querySelector('.app-title-mark'),
  viewBackRow: document.getElementById('viewBackRow'),
  backHomeButton: document.getElementById('backHomeButton'),
  systemGlassInputs: Array.from(document.querySelectorAll('input[name="systemGlassOption"]')),
  floatingBubbleOptions: document.getElementById('floatingBubbleOptions'),
  trayIconOptions: document.getElementById('trayIconOptions'),
  trayOptions: document.getElementById('trayOptions'),
  hubModeOptions: document.getElementById('hubModeOptions'),
  hubBuildStatus: document.getElementById('hubBuildStatus'),
  hubClientFields: document.getElementById('hubClientFields'),
  hubHostFields: document.getElementById('hubHostFields'),
  hubPortInput: document.getElementById('hubPortInput'),
  hubSecretInput: document.getElementById('hubSecretInput'),
  hubSecretCopyButton: document.getElementById('hubSecretCopyButton'),
  hubSecretRegenButton: document.getElementById('hubSecretRegenButton'),
  secretPasteButton: document.getElementById('secretPasteButton'),
  hubStatusRow: document.getElementById('hubStatusRow'),
  syncClientStatus: document.getElementById('syncClientStatus'),
  hubAddressList: document.getElementById('hubAddressList'),
  syncUploadIntervalInput: document.getElementById('syncUploadIntervalInput'),
  collectionCadenceInput: document.getElementById('collectionCadenceInput'),
  collectionCadenceNote: document.getElementById('collectionCadenceNote'),
  sessionUsageArchiveInput: document.getElementById('sessionUsageArchiveInput'),
  sessionUsageArchiveStatus: document.getElementById('sessionUsageArchiveStatus'),
  reduceMotionInputs: Array.from(document.querySelectorAll('input[name="reduceMotionOption"]')),
  windowsBackdropRow: document.getElementById('windowsBackdropRow'),
  windowsBackdropInput: document.getElementById('windowsBackdropInput'),
  windowsBackdropNote: document.getElementById('windowsBackdropNote'),
  clearSessionUsageArchiveButton: document.getElementById('clearSessionUsageArchiveButton'),
  startupGroup: document.getElementById('startupGroup'),
  startAtLoginInput: document.getElementById('startAtLoginInput'),
  startupNote: document.getElementById('startupNote'),
  advancedSettingsGroup: document.getElementById('advancedSettingsGroup'),
  advancedSettingsToggle: document.getElementById('advancedSettingsToggle'),
  advancedSettingsDetails: document.getElementById('advancedSettingsDetails'),
  advancedSettingsSummary: document.getElementById('advancedSettingsSummary'),
  tokscaleGroup: document.getElementById('tokscaleGroup'),
  tokscaleInstalled: document.getElementById('tokscaleInstalled'),
  tokscaleBundledLine: document.getElementById('tokscaleBundledLine'),
  tokscaleBundled: document.getElementById('tokscaleBundled'),
  tokscaleNpm: document.getElementById('tokscaleNpm'),
  tokscaleMessage: document.getElementById('tokscaleMessage'),
  checkTokscaleButton: document.getElementById('checkTokscaleButton'),
  downloadTokscaleButton: document.getElementById('downloadTokscaleButton'),
  resetTokscaleButton: document.getElementById('resetTokscaleButton'),
  openTokscaleLinkButton: document.getElementById('openTokscaleLinkButton'),
  aboutVersion: document.getElementById('aboutVersion'),
  openRepositoryButton: document.getElementById('openRepositoryButton'),
  openWebsiteButton: document.getElementById('openWebsiteButton'),
  reportIssueButton: document.getElementById('reportIssueButton'),
  appUpdatePill: document.getElementById('appUpdatePill'),
  appUpdatePillAction: document.getElementById('appUpdatePillAction'),
  appUpdatePillLabel: document.getElementById('appUpdatePillLabel'),
  appUpdatePillRestart: document.getElementById('appUpdatePillRestart'),
  appUpdatePillRestartLabel: document.getElementById('appUpdatePillRestartLabel'),
  appUpdatePillDismiss: document.getElementById('appUpdatePillDismiss'),
  appUpdatePopover: document.getElementById('appUpdatePopover'),
  appUpdatePopoverTitle: document.getElementById('appUpdatePopoverTitle'),
  appUpdatePopoverBody: document.getElementById('appUpdatePopoverBody'),
  appUpdatePopoverAction: document.getElementById('appUpdatePopoverAction'),
  appUpdatePopoverRelease: document.getElementById('appUpdatePopoverRelease'),
  appUpdatePopoverClose: document.getElementById('appUpdatePopoverClose'),
  appUpdateInstalled: document.getElementById('appUpdateInstalled'),
  automaticAppUpdatesRow: document.getElementById('automaticAppUpdatesRow'),
  automaticAppUpdatesInput: document.getElementById('automaticAppUpdatesInput'),
  automaticAppUpdatesNote: document.getElementById('automaticAppUpdatesNote'),
  appUpdateLatest: document.getElementById('appUpdateLatest'),
  appUpdateCheckButton: document.getElementById('appUpdateCheckButton'),
  appUpdateViewReleaseButton: document.getElementById('appUpdateViewReleaseButton'),
  appUpdateNotes: document.getElementById('appUpdateNotes'),
  appUpdateNotesToggle: document.getElementById('appUpdateNotesToggle'),
  appUpdateNotesDetails: document.getElementById('appUpdateNotesDetails'),
  appUpdateNotesTitle: document.getElementById('appUpdateNotesTitle'),
  appUpdateNotesBody: document.getElementById('appUpdateNotesBody'),
  appUpdateReleaseNotesButton: document.getElementById('appUpdateReleaseNotesButton'),
  appUpdateMessage: document.getElementById('appUpdateMessage'),
  titleIconInput: document.getElementById('titleIconInput'),
  showCompactTotalTokensInput: document.getElementById('showCompactTotalTokensInput'),
  compactTokenUnitsRow: document.getElementById('compactTokenUnitsRow'),
  compactTokenUnitsInput: document.getElementById('compactTokenUnitsInput'),
  swapSettingsRefreshInput: document.getElementById('swapSettingsRefreshInput'),
  resetClientDisplayOrderButton: document.getElementById('resetClientDisplayOrderButton'),
  showAllClientsButton: document.getElementById('showAllClientsButton'),
  resetViewDisplayOrderButton: document.getElementById('resetViewDisplayOrderButton'),
  showAllViewsButton: document.getElementById('showAllViewsButton'),
  viewDisplayList: document.getElementById('viewDisplayList'),
  syncSettingsSummary: document.getElementById('syncSettingsSummary'),
  toolsSettingsSummary: document.getElementById('toolsSettingsSummary'),
  limitsSettingsSummary: document.getElementById('limitsSettingsSummary'),
  generalSettingsSummary: document.getElementById('generalSettingsSummary'),
  mainSettingsSummary: document.getElementById('mainSettingsSummary'),
  windowSettingsSummary: document.getElementById('windowSettingsSummary'),
  appearanceSettingsSummary: document.getElementById('appearanceSettingsSummary'),
  subscriptionsSettingsSummary: document.getElementById('subscriptionsSettingsSummary'),
  themePresetChips: document.getElementById('themePresetChips'),
  themeColorGrid: document.getElementById('themeColorGrid'),
  themeCodeInput: document.getElementById('themeCodeInput'),
  applyThemeCodeButton: document.getElementById('applyThemeCodeButton'),
  copyThemeCodeButton: document.getElementById('copyThemeCodeButton'),
  themeCodeStatus: document.getElementById('themeCodeStatus'),
  themeAdvancedGroup: document.getElementById('themeAdvancedGroup'),
  themeAdvancedToggle: document.getElementById('themeAdvancedToggle'),
  themeAdvancedDetails: document.getElementById('themeAdvancedDetails'),
  interfaceFontPreset: document.getElementById('interfaceFontPreset'),
  interfaceFontInput: document.getElementById('interfaceFontInput'),
  interfaceFontCustomRow: document.getElementById('interfaceFontCustomRow'),
  interfaceFontPreview: document.getElementById('interfaceFontPreview'),
  displayFontPreset: document.getElementById('displayFontPreset'),
  displayFontInput: document.getElementById('displayFontInput'),
  displayFontCustomRow: document.getElementById('displayFontCustomRow'),
  displayFontPreview: document.getElementById('displayFontPreview'),
  resetInterfaceFontButton: document.getElementById('resetInterfaceFontButton'),
  resetDisplayFontButton: document.getElementById('resetDisplayFontButton'),
  themeVendorGroup: document.getElementById('themeVendorGroup'),
  themeVendorToggle: document.getElementById('themeVendorToggle'),
  themeVendorDetails: document.getElementById('themeVendorDetails'),
  vendorColorList: document.getElementById('vendorColorList'),
  resetThemeColorsButton: document.getElementById('resetThemeColorsButton'),
  resetVendorColorsButton: document.getElementById('resetVendorColorsButton'),
  sessionDetail: document.getElementById('session-detail'),
  sessionDetailHead: document.getElementById('session-detail-head')
});

function toggleAccordionRow(row) {
  const isExpanded = row.classList.contains('expanded');
  document.querySelectorAll('.row.expanded').forEach((other) => {
    other.classList.remove('expanded');
    other.setAttribute('aria-expanded', 'false');
  });
  if (!isExpanded) {
    row.classList.add('expanded');
    row.setAttribute('aria-expanded', 'true');
  }
}

function setAttributeIfChanged(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

document.addEventListener('click', (event) => {
  const row = event.target.closest('.row.has-accordion');
  if (row) toggleAccordionRow(row);
});

document.addEventListener('keydown', (event) => {
  const row = event.target.closest('.row.has-accordion');
  if (!row || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  toggleAccordionRow(row);
});

document.addEventListener('pointerdown', (event) => {
  if (state.viewSwitcherOpen && !event.target.closest('#viewSwitcher')) {
    setViewSwitcherOpen(false);
  }
});

document.addEventListener('pointerup', (event) => {
  releaseTokenRateBoost(event);
  clearViewSwitcherLongPress();
  if (viewSwitcherLongPressTriggered) {
    setTimeout(() => { viewSwitcherLongPressTriggered = false; }, 0);
  }
});

document.addEventListener('pointercancel', (event) => {
  cancelTokenRateBoost(event);
  clearViewSwitcherLongPress();
  viewSwitcherLongPressTriggered = false;
});

function preferredLanguages() {
  return navigator.languages?.length ? navigator.languages : [navigator.language || 'en'];
}

function currentLanguage() {
  return i18n.normalizeLanguage(state.settings?.language || 'auto');
}

function currentLocale() {
  return i18n.resolveLocale(state.settings?.locale || currentLanguage(), preferredLanguages());
}

function currentCalendarLocale() {
  return i18n.resolveRegionalLocale([...preferredLanguages(), state.settings?.locale]);
}

function supportsLocalizedCompactTokenUnits(locale) {
  return compactTokenApi.supportsLocalizedCompactTokenUnits(locale);
}

function effectiveCompactTokenUnits() {
  return compactTokenApi.effectiveCompactTokenUnits(state.settings?.compactTokenUnits, currentLocale());
}

function compactTokenDisplayOptions() {
  return { ...(state.settings || {}), locale: currentLocale() };
}

function t(key, params) {
  return i18n.translate(currentLocale(), key, params);
}

const diagnosticsPanel = window.TokenMonitorDiagnosticsPanel?.createDiagnosticsPanel({
  api: window.tokenMonitor,
  translate: t,
  getLocale: currentLocale
});

function translatedLimitCapabilityTag(label) {
  const key = LIMIT_CAPABILITY_TAG_KEYS[label];
  return key ? t(key) : label;
}

function translatedLimitProviderTag(tagInfo) {
  if (tagInfo?.key) return t(tagInfo.key, tagInfo.values);
  return translatedLimitCapabilityTag(tagInfo?.label || '');
}

function applySettingsTranslations() {
  if (els.languageInput) els.languageInput.value = currentLanguage();
  i18n.applyTranslations(document, currentLocale());
  setThirdPartyAdapterFields();
  setSubscriptionFormMode();
  diagnosticsPanel?.render();
}

function applySettingsSectionDom(id, open) {
  const toggle = document.querySelector(`[data-settings-section="${id}"]`);
  const details = document.getElementById(`${id}SettingsDetails`);
  const group = toggle?.closest('.settings-collapsible-group');
  toggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
  details?.classList.toggle('hidden', !open);
  group?.classList.toggle('expanded', open);
}

function setSettingsSectionExpanded(section, expanded) {
  const id = String(section || '').trim();
  if (!SETTINGS_SECTION_IDS.includes(id)) return;
  const next = Boolean(expanded);
  if (next) {
    for (const other of SETTINGS_SECTION_IDS) {
      if (other === id || !state.settingsSections[other]) continue;
      state.settingsSections[other] = false;
      applySettingsSectionDom(other, false);
    }
  }
  state.settingsSections[id] = next;
  applySettingsSectionDom(id, next);
}

// Expanding a section auto-collapses the previously open one. When that one
// sits ABOVE the clicked header, the content above shrinks while scrollTop
// stays put, so the clicked card visually flies upward. Pin the clicked
// header to its on-screen position for the duration of the 250ms accordion
// transition (rAF-corrected each frame; a single pass when motion is off).
const SETTINGS_SCROLL_ANCHOR_MS = 360;
const SETTINGS_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab']);
let settingsScrollAnchorFrame = null;
let settingsScrollInteractionRevision = 0;

function cancelSettingsScrollAnchor() {
  if (settingsScrollAnchorFrame === null) return;
  cancelAnimationFrame(settingsScrollAnchorFrame);
  settingsScrollAnchorFrame = null;
}

function cancelSettingsScrollAnchorOnInteraction() {
  settingsScrollInteractionRevision += 1;
  cancelSettingsScrollAnchor();
}

function cancelSettingsScrollAnchorOnKeydown(event) {
  if (SETTINGS_SCROLL_KEYS.has(event.key)) cancelSettingsScrollAnchorOnInteraction();
}

function shouldAnchorSettingsScroll(section, expanding) {
  if (!expanding) return false;
  const sectionIndex = SETTINGS_SECTION_IDS.indexOf(section);
  return SETTINGS_SECTION_IDS.slice(0, sectionIndex).some(id => state.settingsSections[id]);
}

function anchorSettingsScroll(anchorEl, mutate) {
  cancelSettingsScrollAnchor();
  const panel = els.settingsPanel;
  if (!panel || !anchorEl) { mutate(); return; }
  const offset = anchorEl.getBoundingClientRect().top - panel.getBoundingClientRect().top;
  mutate();
  const reducedMotion = prefersReducedMotion();
  const deadline = performance.now() + SETTINGS_SCROLL_ANCHOR_MS;
  const pin = () => {
    settingsScrollAnchorFrame = null;
    if (!anchorEl.isConnected || panel.classList.contains('hidden')) return;
    const drift = anchorEl.getBoundingClientRect().top - panel.getBoundingClientRect().top - offset;
    if (Math.abs(drift) > 0.5) panel.scrollTop += drift;
    if (!reducedMotion && performance.now() < deadline) {
      settingsScrollAnchorFrame = requestAnimationFrame(pin);
    }
  };
  settingsScrollAnchorFrame = requestAnimationFrame(pin);
}

function setupSettingsSections() {
  for (const toggle of document.querySelectorAll('[data-settings-section]')) {
    const section = toggle.dataset.settingsSection;
    toggle.addEventListener('click', () => {
      const expanding = !state.settingsSections[section];
      const mutate = () => setSettingsSectionExpanded(section, expanding);
      if (shouldAnchorSettingsScroll(section, expanding)) anchorSettingsScroll(toggle, mutate);
      else { cancelSettingsScrollAnchor(); mutate(); }
    });
    setSettingsSectionExpanded(section, state.settingsSections[section]);
  }
  els.settingsPanel?.addEventListener('pointerdown', cancelSettingsScrollAnchorOnInteraction, { passive: true });
  els.settingsPanel?.addEventListener('wheel', cancelSettingsScrollAnchorOnInteraction, { passive: true });
  els.settingsPanel?.addEventListener('keydown', cancelSettingsScrollAnchorOnKeydown);
}

function refreshIntervalLabel(value) {
  const ms = Number(value) || 300000;
  const minutes = Math.max(1, Math.round(ms / 60000));
  return t('settings.summary.minutes', { minutes });
}

// Adaptive is a scheduling policy rather than a duration, so the summary names
// it instead of printing the fixed interval the user would return to.
function limitsRefreshSummaryLabel(settings) {
  return settings.limitsRefreshMode === 'adaptive'
    ? t('settings.limits.refreshAdaptive')
    : refreshIntervalLabel(settings.limitsRefreshMs);
}

function viewsSummary() {
  const visible = viewDisplayPreferencesApi.visibleViewCount({
    views: VIEW_DISPLAY_OPTIONS,
    hiddenValue: state.settings?.hiddenViews,
    disabledIds: disabledViewIds()
  });
  return t('settings.summary.views', { visible, total: VIEW_DISPLAY_OPTIONS.length });
}

function settingsSectionSummary(section) {
  if (!state.settings) return '';
  if (section === 'sync') {
    if (state.settings.hubMode === 'host') return t('settings.sync.hostHub');
    if (state.settings.hubMode === 'client') return t('settings.sync.connectHub');
    return t('settings.sync.localOnly');
  }
  if (section === 'tools') {
    const counts = clientHealthPresentationApi.clientHealthCountsForTracked(
      localClientHealth(),
      enabledClientSet()
    );
    if (counts) return t('settings.summary.toolsHealth', counts);
    return t('settings.summary.tools', {
      tracked: enabledClientSet().size,
      visible: KNOWN_CLIENTS.length - hiddenClientSet().size,
      pinned: pinnedClientSet().size
    });
  }
  if (section === 'limits') {
    return t('settings.summary.limits', {
      enabled: enabledLimitProviderSet().size,
      refresh: limitsRefreshSummaryLabel(state.settings)
    });
  }
  if (section === 'subscriptions') {
    const list = subscriptionList();
    if (list.length === 0) return t('settings.subscriptions.summaryEmpty');
    // The monthly total in the collapsed summary is the whole reason this is a
    // top-level section rather than a subgroup: the number people want is
    // visible without opening anything.
    //
    // Counted over the same set the total sums, so the two halves never
    // disagree — a lapsed plan costs nothing this month and is not one of them.
    const active = subscriptionApi.activeSubscriptions(list);
    return t('settings.subscriptions.summary', {
      count: active.length,
      total: formatCost(subscriptionApi.monthlyTotalUsd(active, currencyApi))
    });
  }
  if (section === 'main') {
    return viewsSummary();
  }
  if (section === 'window') {
    const behavior = WINDOW_BEHAVIOR_VALUES.includes(state.settings.windowBehavior) ? state.settings.windowBehavior : 'floating';
    return t(`settings.windowBehavior.${behavior}`);
  }
  if (section === 'appearance') {
    return appearanceSummary();
  }
  if (section === 'general') {
    const startup = state.appInfo?.loginItemSupported
      ? (state.settings.startAtLogin ? t('settings.summary.on') : t('settings.summary.off'))
      : t('settings.summary.unavailable');
    return t('settings.summary.general', {
      startup
    });
  }
  return '';
}

function renderSettingsSummaries() {
  for (const section of SETTINGS_SECTION_IDS) {
    const el = els[`${section}SettingsSummary`];
    if (el) el.textContent = settingsSectionSummary(section);
  }
}

function formatNumber(value) { return Math.round(Number(value || 0)).toLocaleString('en-US'); }
function formatCompact(value, unitSystem, locale) {
  return compactTokenApi.formatCompactTokens(
    value,
    unitSystem === undefined ? effectiveCompactTokenUnits() : unitSystem,
    locale === undefined ? currentLocale() : locale
  );
}
function updateTotalCompact(value) {
  if (!els.totalTokensCompact) return;
  const num = Math.round(Number(value || 0));
  const unitSystem = effectiveCompactTokenUnits();
  const threshold = compactTokenApi.compactTokenUnitThreshold(unitSystem, currentLocale());
  if (state.settings?.showCompactTotalTokens !== true || Math.abs(num) < threshold) {
    hideTotalCompact();
  } else {
    els.totalTokensCompact.textContent = `≈ ${formatCompact(num, unitSystem, currentLocale())}`;
    els.totalTokensCompact.classList.remove('hidden');
  }
  fitTotalNumber();
}
function hideTotalCompact() {
  if (!els.totalTokensCompact) return;
  els.totalTokensCompact.textContent = '';
  els.totalTokensCompact.classList.add('hidden');
}
function currentTokenRateValue() {
  const period = state.stats?.periods?.[state.period];
  const burn = state.settings?.tokenRateMode === 'burn';
  return {
    burn,
    mode: burn ? 'burn' : 'speed',
    rate: burn ? tokenBurnPerMinute(period) : tokenRatePerSecond(period)
  };
}
const tokenRateBoost = tokenRateApi.createTokenRateBoostController({
  readValue: currentTokenRateValue,
  canStart: () => els.shell?.classList.contains('title-icon-only') || els.shell?.classList.contains('title-collapsed'),
  prefersReducedMotion,
  onChange: () => renderTokenRate()
});
function tokenRateText(rate, burn) {
  // formatCompact rounds, so a sub-0.5 rate would render as a bare "0". Treat that as no
  // data and stay hidden rather than claim a zero pace.
  return Math.round(rate) > 0
    ? t(burn ? 'home.tokenRateBurn' : 'home.tokenRate', {
      value: formatCompact(rate, effectiveCompactTokenUnits(), currentLocale())
    })
    : '';
}
function renderTokenRate() {
  if (!els.tokenRateReveal) return;
  tokenRateBoost.refresh();
  const { burn, rate } = currentTokenRateValue();
  const boost = tokenRateBoost.getSnapshot();
  const displayRate = boost ? boost.displayRate : rate;
  const text = tokenRateText(displayRate, boost ? boost.mode === 'burn' : burn);
  els.tokenRateReveal.textContent = text;
  els.tokenRateReveal.classList.toggle('has-value', Boolean(text));
  els.tokenRateReveal.classList.toggle('boosting', boost?.phase === 'boosting');
  els.tokenRateReveal.classList.toggle('settling', boost?.phase === 'settling');
}
function startTokenRateBoost(event) {
  if (!tokenRateBoost.start(event)) return;
  try { event.currentTarget?.setPointerCapture?.(event.pointerId); } catch (_) {}
}
function releaseTokenRateBoost(event) {
  tokenRateBoost.release(event);
}
function cancelTokenRateBoost(event, options) {
  tokenRateBoost.cancel(event, options);
}
function suppressTokenRateClickAfterHold(event) {
  if (!tokenRateBoost.consumeClick()) return;
  event.stopImmediatePropagation();
}
// The title mark is the only pixel of the reveal that can take a click: a drag region does
// not deliver mouse events, so this control and its hover target are the same no-drag island.
//
// Deliberately pointer-only, and the mark stays a non-focusable aria-hidden span. A focusable
// control here is worse than no keyboard path: the window assigns focus to a control when it
// is shown, and Chromium then derives :focus-visible from that activation rather than from
// any click, so the reveal reopens with a focus ring on a window the user just summoned with
// the pointer nowhere near the title. Visibility cancellation keeps transient state from
// surviving a hide/show, but it does not make this hover-only reading a useful keyboard control.
// Short clicks still switch the reading; a sustained pointer hold is the transient boost affordance.
function toggleTokenRateMode() {
  // A mode switch during settling would relabel the old reading with the new unit. End the
  // transient state first; the next render then starts from the selected framing's real rate.
  tokenRateBoost.cancel(undefined, { suppressClick: false });
  const next = state.settings?.tokenRateMode === 'burn' ? 'speed' : 'burn';
  // Repaint before the settings round trip. saveSettings re-syncs the entire settings form,
  // which is orders of magnitude heavier than this label and would make the switch lag.
  if (state.settings) state.settings.tokenRateMode = next;
  renderTokenRate();
  // Repaint again if the write failed: saveSettings re-reads settings from the main process on
  // rejection, so state has already reverted to the persisted framing while the label is still
  // showing the one the click asked for. Without this the label stays wrong until some later
  // tick silently flips it back.
  saveSettings({ tokenRateMode: next }).catch(() => renderTokenRate());
}
// Scale the exact total to fit the width it is actually given instead of clipping
// it to an ellipsis. The compact chip (when shown) is flex:0 0 auto and claims its
// width first, so the number's clientWidth is its allotted box while scrollWidth is
// its natural width; the ratio is how far the font must shrink to stay whole.
function totalNumberFontScale(availableWidth, naturalWidth, minScale = 0.5) {
  if (!(naturalWidth > 0) || !(availableWidth > 0)) return 1;
  return Math.min(1, Math.max(minScale, availableWidth / naturalWidth));
}
function fitTotalNumber() {
  const el = els.totalTokens;
  if (!el) return;
  el.style.fontSize = '';
  const base = parseFloat(getComputedStyle(el).fontSize);
  if (!(base > 0)) return;
  const scale = totalNumberFontScale(el.clientWidth, el.scrollWidth);
  if (scale < 1) el.style.fontSize = `${Math.floor(base * scale)}px`;
}
function trendShortLabel(label, labelKey) {
  const value = String(label || '');
  if (labelKey === 'month') return value.slice(0, 7);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${Number(m[2])}/${Number(m[3])}` : value;
}
function compactMonthLabel(label) {
  const match = /^(\d{4})-(\d{2})/.exec(String(label || ''));
  if (!match) return String(label || '');
  return new Intl.DateTimeFormat(currentLocale(), { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}
function currentCurrency() { return currencyApi.normalizeCurrency(state.settings?.currency); }
function formatCost(value) { return currencyApi.formatCurrencyFromUsd(value, currentCurrency()); }
function applyEffectiveCurrencyRates() {
  if (state.settings?.currencyRatesEffective) currencyApi.configureRates(state.settings.currencyRatesEffective);
}
function formatRate(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return String(Number(num.toFixed(num >= 1 ? 2 : 4)));   // trim noise: 31.6749… -> 31.67
}
function currencyRateMode(code) {
  const override = Number(state.settings?.currencyRates?.[code]);
  return Number.isFinite(override) && override > 0 ? 'manual' : 'auto';
}
function syncCurrencyRateControls() {
  const code = currentCurrency();
  if (!els.currencyRateRow) return;
  if (code === 'USD') { els.currencyRateRow.classList.add('hidden'); return; }
  els.currencyRateRow.classList.remove('hidden');
  const mode = currencyRateMode(code);
  if (els.currencyRateModeAuto) els.currencyRateModeAuto.checked = mode === 'auto';
  if (els.currencyRateModeManual) els.currencyRateModeManual.checked = mode === 'manual';
  const eff = Number(state.settings?.currencyRatesEffective?.[code]);
  if (mode === 'manual') {
    els.currencyRateManualField?.classList.remove('hidden');
    if (els.currencyRateStatus) els.currencyRateStatus.textContent = '';
    // Don't clobber the field while the user is typing in it.
    if (els.currencyRateOverrideInput && document.activeElement !== els.currencyRateOverrideInput) {
      els.currencyRateOverrideInput.value = formatRate(eff);
    }
  } else {
    els.currencyRateManualField?.classList.add('hidden');
    if (els.currencyRateStatus) {
      const info = state.settings?.currencyRateInfo;
      if (!Number.isFinite(eff)) els.currencyRateStatus.textContent = '';
      else if (info?.source) els.currencyRateStatus.textContent = t('settings.currency.rateLive', { rate: formatRate(eff), date: (info.date || '').slice(5) });
      else els.currencyRateStatus.textContent = t('settings.currency.rateDefault', { rate: formatRate(eff) });
    }
  }
}
function formatTime(value) { const date = value ? new Date(value) : new Date(); return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function formatPercent(value) { return Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : '--'; }
function formatReset(value) {
  const diffMs = limitProviderPresentationApi.limitResetRemainingMs(value);
  if (diffMs === null) return '';
  if (diffMs === 0) return 'Reset now';
  return `Reset ${formatDuration(diffMs)}`;
}
function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}
function formatActiveDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(Number(ms || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '0m';
}
function formatUpdatedAge(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'Update unknown';
  const diffMs = Math.max(0, Date.now() - date.getTime());
  if (diffMs < 45_000) return 'Updated just now';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}
function versionText(value) {
  return value ? `v${value}` : 'unknown';
}
function setAppUpdatePillDisclosure(available) {
  const action = els.appUpdatePillAction;
  if (available) {
    action.setAttribute('aria-haspopup', 'dialog');
    action.setAttribute('aria-controls', 'appUpdatePopover');
    action.setAttribute('aria-expanded', String(els.appUpdatePopover.matches(':popover-open')));
    return;
  }
  action.removeAttribute('aria-haspopup');
  action.removeAttribute('aria-controls');
  action.removeAttribute('aria-expanded');
}
function renderAppUpdatePill() {
  const s = state.appUpdate;
  const pill = els.appUpdatePill;
  if (!pill) return;
  const mode = appUpdatePresentationApi.appUpdateActionMode(s);
  const version = s?.latest?.version || s?.installVersion || '';
  if (!s || !mode || !version || !s.showUpdateNotice) {
    pill.classList.add('hidden');
    pill.classList.remove('is-ready');
    pill.setAttribute('title', '');
    els.appUpdatePillLabel.textContent = '';
    els.appUpdatePillAction.removeAttribute('title');
    els.appUpdatePillAction.removeAttribute('aria-label');
    els.appUpdatePillAction.disabled = false;
    els.appUpdatePillRestart.classList.add('hidden');
    els.appUpdatePillRestartLabel.textContent = '';
    els.appUpdatePillRestart.disabled = false;
    els.appUpdatePillRestart.removeAttribute('title');
    els.appUpdatePillRestart.removeAttribute('aria-label');
    setAppUpdatePillDisclosure(false);
    return;
  }
  const hasReleaseNotes = releaseNoteGroupsForCurrentLocale(s.latest).length > 0;
  setAppUpdatePillDisclosure(hasReleaseNotes);
  pill.classList.remove('hidden');
  pill.classList.toggle('is-ready', mode === 'install');
  els.appUpdatePillDismiss.classList.toggle('hidden', mode === 'install' || s.installBusy);
  pill.setAttribute('title', '');
  const releaseLabel = hasReleaseNotes
    ? t('settings.appUpdate.whatsNew', { version })
    : (s.latest?.name || `v${version}`);
  els.appUpdatePillAction.setAttribute('title', releaseLabel);
  els.appUpdatePillAction.setAttribute('aria-label', releaseLabel);
  els.appUpdatePillAction.disabled = mode === 'install' && !hasReleaseNotes && !s.latest?.htmlUrl;
  els.appUpdatePillRestart.classList.toggle('hidden', mode !== 'install');
  els.appUpdatePillRestart.disabled = Boolean(s.installBusy);
  els.appUpdatePillRestartLabel.textContent = mode === 'install'
    ? t('settings.appUpdate.restartShort')
    : '';
  els.appUpdatePillRestart.setAttribute('title', t('settings.appUpdate.ready'));
  els.appUpdatePillRestart.setAttribute('aria-label', t('settings.appUpdate.restart'));
  if (s.installPhase === 'downloading' && Number.isFinite(s.installProgress)) {
    els.appUpdatePillLabel.textContent = `${Math.round(s.installProgress)}%`;
  } else {
    els.appUpdatePillLabel.textContent = mode === 'install'
      ? `v${version}`
      : `↑ v${version}`;
  }
}
function releaseNoteGroupsForCurrentLocale(latest) {
  return appUpdatePresentationApi.releaseNoteGroupsForLocale(latest?.releaseNotes, currentLocale());
}
function buildAppUpdateNoteGroupNodes(groups) {
  return groups.map((group) => {
    const section = document.createElement('section');
    section.className = 'app-update-note-group';
    const title = document.createElement('div');
    title.className = 'app-update-note-title';
    title.textContent = String(group?.title || '');
    const list = document.createElement('ul');
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      const row = document.createElement('li');
      row.textContent = String(item || '');
      list.append(row);
    }
    section.append(title, list);
    return section;
  });
}
function renderAppUpdatePopover(s) {
  const version = s?.latest?.version || '';
  const groups = releaseNoteGroupsForCurrentLocale(s?.latest);
  const mode = appUpdatePresentationApi.appUpdateActionMode(s);
  if (!version || groups.length === 0 || !mode) {
    if (els.appUpdatePopover.matches(':popover-open')) els.appUpdatePopover.hidePopover();
    els.appUpdatePopoverTitle.textContent = '';
    els.appUpdatePopoverBody.replaceChildren();
    return false;
  }
  els.appUpdatePopoverTitle.textContent = t('settings.appUpdate.whatsNew', { version });
  els.appUpdatePopoverBody.replaceChildren(...buildAppUpdateNoteGroupNodes(groups));
  els.appUpdatePopoverAction.textContent = mode === 'install'
    ? t('settings.appUpdate.restart')
    : mode === 'download'
      ? t('settings.appUpdate.download')
      : t('settings.appUpdate.viewRelease');
  els.appUpdatePopoverAction.disabled = Boolean(s.installBusy);
  els.appUpdatePopoverRelease.classList.toggle('hidden', !s.latest?.htmlUrl);
  return true;
}
function positionAppUpdatePopover() {
  const rect = els.appUpdatePill.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 24);
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
  els.appUpdatePopover.style.width = `${width}px`;
  els.appUpdatePopover.style.left = `${left}px`;
  els.appUpdatePopover.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 8)}px`;
}
function renderAppUpdateNotes(s) {
  const version = s?.latest?.version || '';
  const groups = releaseNoteGroupsForCurrentLocale(s?.latest);
  const visible = Boolean(version && groups.length > 0);
  els.appUpdateNotes.classList.toggle('hidden', !visible);
  if (!visible) {
    setSettingsAccordionExpanded(els.appUpdateNotes, els.appUpdateNotesToggle, els.appUpdateNotesDetails, false);
    els.appUpdateNotesTitle.textContent = '';
    els.appUpdateNotesBody.replaceChildren();
    return;
  }

  els.appUpdateNotesTitle.textContent = t('settings.appUpdate.whatsNew', { version });
  els.appUpdateNotesBody.replaceChildren(...buildAppUpdateNoteGroupNodes(groups));
  els.appUpdateReleaseNotesButton.classList.toggle('hidden', !s.latest?.htmlUrl);
  if (s.hasUpdate && state.appUpdateNotesPresentedVersion !== version) {
    // The disclosure may have just changed from display:none. Commit its
    // collapsed grid once so the first automatic reveal can transition too.
    els.appUpdateNotesDetails.getBoundingClientRect();
    setSettingsAccordionExpanded(els.appUpdateNotes, els.appUpdateNotesToggle, els.appUpdateNotesDetails, true);
    state.appUpdateNotesPresentedVersion = version;
  }
}
function renderSettingsAppUpdateRow() {
  const s = state.appUpdate;
  if (!s) {
    els.appUpdateInstalled.textContent = '—';
    els.appUpdateLatest.textContent = t('settings.common.notChecked');
    els.appUpdateCheckButton.disabled = false;
    els.appUpdateCheckButton.textContent = t('settings.appUpdate.check');
    els.appUpdateViewReleaseButton.classList.add('hidden');
    els.appUpdateMessage.textContent = '';
    els.appUpdateMessage.classList.remove('error');
    renderAppUpdateNotes(null);
    return;
  }
  els.appUpdateInstalled.textContent = `v${s.currentVersion}`;
  const presentation = appUpdatePresentationApi.appUpdateStatusPresentation(s);
  const displayVersion = presentation.displayVersion;
  if (displayVersion) {
    const status = presentation.latestStatusKey ? t(presentation.latestStatusKey) : '';
    els.appUpdateLatest.textContent = status
      ? t('settings.appUpdate.latestWithStatus', { version: displayVersion, status })
      : `v${displayVersion}`;
    const actionMode = appUpdatePresentationApi.appUpdateActionMode(s);
    els.appUpdateViewReleaseButton.classList.toggle('hidden', !actionMode);
    els.appUpdateViewReleaseButton.disabled = Boolean(s.installBusy);
    els.appUpdateViewReleaseButton.textContent = actionMode === 'install'
      ? t('settings.appUpdate.restart')
      : actionMode === 'download'
        ? t('settings.appUpdate.download')
        : t('settings.appUpdate.viewRelease');
  } else {
    els.appUpdateLatest.textContent = s.lastError
      ? t('settings.appUpdate.unavailable')
      : s.lastCheckedAt
        ? t('settings.appUpdate.upToDate')
        : t('settings.common.notChecked');
    els.appUpdateViewReleaseButton.classList.add('hidden');
  }
  // installRetryBlocked as well as busy: the main process stops running checks once
  // an attempt is spent, so without this the button would sit live and do nothing.
  // It is not folded into installBusy, which would disable View release along with
  // it and take away the one path a spent attempt leaves working.
  els.appUpdateCheckButton.disabled = Boolean(s.checking || s.installBusy || s.installRetryBlocked);
  els.appUpdateCheckButton.textContent = s.checking ? t('settings.appUpdate.checking') : t('settings.appUpdate.check');
  renderAppUpdateNotes(s);
  if (s.installPhase === 'downloading') {
    const percent = Number.isFinite(s.installProgress) ? Math.round(s.installProgress) : 0;
    els.appUpdateMessage.textContent = t('settings.appUpdate.downloading', { percent });
    els.appUpdateMessage.classList.remove('error');
  } else if (s.installStarting) {
    els.appUpdateMessage.textContent = t('settings.appUpdate.installStarting');
    els.appUpdateMessage.classList.remove('error');
  } else if (s.downloaded) {
    els.appUpdateMessage.textContent = t('settings.appUpdate.ready');
    els.appUpdateMessage.classList.remove('error');
  } else if (s.installError) {
    els.appUpdateMessage.textContent = t(appUpdatePresentationApi.appUpdateInstallErrorMessageKey(s.installErrorKind));
    els.appUpdateMessage.classList.add('error');
  } else if (s.lastError) {
    const error = t(presentation.errorKey);
    const age = compactAge(presentation.lastSuccessfulCheckAt);
    els.appUpdateMessage.textContent = age
      ? t('settings.appUpdate.errorWithLastSuccess', { error, age })
      : error;
    els.appUpdateMessage.classList.add('error');
  } else {
    els.appUpdateMessage.textContent = '';
    els.appUpdateMessage.classList.remove('error');
  }
}

function renderAutomaticAppUpdateControl() {
  if (!els.automaticAppUpdatesInput) return;
  const control = appUpdatePresentationApi.automaticAppUpdateControlState({
    preferenceEnabled: state.settings?.automaticAppUpdates,
    updateState: state.appUpdate
  });
  els.automaticAppUpdatesInput.checked = control.checked;
  els.automaticAppUpdatesInput.disabled = control.disabled;
  els.automaticAppUpdatesRow?.classList.toggle('is-disabled', control.unavailable);
  if (els.automaticAppUpdatesNote) {
    els.automaticAppUpdatesNote.textContent = t(control.descriptionKey);
  }
}

function compactAge(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const diffMs = Math.max(0, Date.now() - date.getTime());
  if (diffMs < 45_000) return t('settings.age.justNow');
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) return t('settings.age.minutesAgo', { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('settings.age.hoursAgo', { hours });
  return t('settings.age.daysAgo', { days: Math.round(hours / 24) });
}
function colorWithAlpha(hex, alpha) {
  const raw = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(raw)) return `rgba(183, 234, 212, ${alpha})`;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function setTokscaleMessage(text = '', tone = '') {
  if (!els.tokscaleMessage) return;
  els.tokscaleMessage.textContent = text;
  els.tokscaleMessage.classList.toggle('error', tone === 'error');
  els.tokscaleMessage.classList.toggle('success', tone === 'success');
}

function mergeTokscalePayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.status) state.tokscaleStatus = payload.status;
  else if (payload.supported === false) state.tokscaleStatus = { supported: false };
  else if (payload.current || payload.bundled || payload.downloaded) {
    state.tokscaleStatus = {
      ...(state.tokscaleStatus || { supported: true }),
      supported: payload.supported !== false,
      current: payload.current ?? state.tokscaleStatus?.current ?? null,
      bundled: payload.bundled ?? state.tokscaleStatus?.bundled ?? null,
      downloaded: payload.downloaded ?? state.tokscaleStatus?.downloaded ?? null
    };
  }
  if (payload.npm || payload.checkedAt) {
    state.tokscaleCheck = {
      newer: Boolean(payload.newer),
      npm: payload.npm || state.tokscaleCheck?.npm || null,
      checkedAt: payload.checkedAt || state.tokscaleCheck?.checkedAt || null
    };
  }
  if (payload.downloaded === true && state.tokscaleCheck?.npm?.version === payload.version) {
    state.tokscaleCheck = { ...state.tokscaleCheck, newer: false };
  }
}

function renderTokscaleStatus() {
  if (!els.tokscaleGroup) return;
  const status = state.tokscaleStatus;
  const advancedSummaryKey = state.tokscaleCheck?.newer
    ? 'settings.advanced.tokscaleUpdate'
    : 'settings.advanced.summary';
  if (els.advancedSettingsSummary) {
    els.advancedSettingsSummary.dataset.i18n = advancedSummaryKey;
    els.advancedSettingsSummary.textContent = t(advancedSummaryKey);
  }
  if (status?.supported === false) {
    els.tokscaleGroup.classList.add('hidden');
    return;
  }
  els.tokscaleGroup.classList.remove('hidden');
  const current = status?.current;
  const source = current?.source === 'downloaded'
    ? (current.installedAt
      ? t('settings.tokscale.downloadedSourceWithAge', { age: compactAge(current.installedAt) })
      : t('settings.tokscale.downloadedSource'))
    : t('settings.tokscale.bundledSource');
  els.tokscaleInstalled.textContent = current ? `${versionText(current.version)} (${source})` : t('settings.common.notFound');
  els.tokscaleBundledLine.classList.toggle('hidden', !status?.downloaded || !status?.bundled);
  els.tokscaleBundled.textContent = status?.bundled ? versionText(status.bundled.version) : '—';
  if (state.tokscaleCheck?.npm?.version) {
    els.tokscaleNpm.textContent = state.tokscaleCheck.newer
      ? versionText(state.tokscaleCheck.npm.version)
      : t('settings.appUpdate.latestWithStatus', { version: state.tokscaleCheck.npm.version, status: t('settings.tokscale.currentSuffix') });
  } else {
    els.tokscaleNpm.textContent = t('settings.common.notChecked');
  }
  els.checkTokscaleButton.disabled = state.tokscaleBusy;
  els.downloadTokscaleButton.disabled = state.tokscaleBusy;
  els.resetTokscaleButton.disabled = state.tokscaleBusy;
  els.downloadTokscaleButton.classList.toggle('hidden', !state.tokscaleCheck?.newer);
  els.resetTokscaleButton.classList.toggle('hidden', !status?.downloaded);
}

async function refreshTokscaleStatus() {
  if (!window.tokenMonitor.getTokscaleStatus) return;
  try {
    state.tokscaleStatus = await window.tokenMonitor.getTokscaleStatus();
    renderTokscaleStatus();
  } catch (error) {
    setTokscaleMessage(error.message, 'error');
  }
}

async function checkTokscaleNpm() {
  state.tokscaleBusy = true;
  setTokscaleMessage(t('settings.tokscale.checkingNpm'));
  renderTokscaleStatus();
  try {
    const result = await window.tokenMonitor.checkTokscaleNpm();
    if (result?.error) throw new Error(result.error);
    mergeTokscalePayload(result);
    if (state.tokscaleStatus?.supported === false) return;
    setTokscaleMessage(state.tokscaleCheck?.newer ? t('settings.tokscale.newerOnNpm') : t('settings.tokscale.bundledCurrent'));
  } catch (error) {
    setTokscaleMessage(error.message, 'error');
  } finally {
    state.tokscaleBusy = false;
    renderTokscaleStatus();
  }
}

async function downloadTokscaleFromNpm() {
  state.tokscaleBusy = true;
  setTokscaleMessage(t('settings.tokscale.downloading'));
  renderTokscaleStatus();
  try {
    const result = await window.tokenMonitor.downloadTokscaleFromNpm();
    if (result?.error) throw new Error(result.error);
    mergeTokscalePayload(result);
    setTokscaleMessage(t('settings.tokscale.downloaded', { version: versionText(result.version) }), 'success');
  } catch (error) {
    setTokscaleMessage(error.message, 'error');
  } finally {
    state.tokscaleBusy = false;
    renderTokscaleStatus();
  }
}

async function resetTokscaleToBundled() {
  state.tokscaleBusy = true;
  setTokscaleMessage(t('settings.tokscale.resetting'));
  renderTokscaleStatus();
  try {
    state.tokscaleStatus = await window.tokenMonitor.resetTokscaleToBundled();
    state.tokscaleCheck = null;
    setTokscaleMessage(t('settings.tokscale.usingBundled'), 'success');
  } catch (error) {
    setTokscaleMessage(error.message, 'error');
  } finally {
    state.tokscaleBusy = false;
    renderTokscaleStatus();
  }
}
function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }

// A single in-flight tween on the headline number. Without cancelling it, an
// orphaned loop from the previous period keeps writing its old value every
// frame and overwrites a later static update (e.g. switching to a zero period
// mid-animation).
let numberAnimHandle = 0;
let numberAnimTarget = null;
let numberAnimValue = 0;
function cancelNumberAnimation() {
  if (numberAnimHandle) cancelAnimationFrame(numberAnimHandle);
  numberAnimHandle = 0;
  numberAnimTarget = null;
}

function headlineNumberIsAnimatingTo(value) {
  return Boolean(numberAnimHandle) && numberAnimTarget === value;
}

function animateNumber(el, from, to, duration = 1000, onDone = null) {
  cancelNumberAnimation();
  if (prefersReducedMotion()) {
    el.textContent = formatNumber(to);
    numberAnimValue = to;
    if (typeof onDone === 'function') onDone();
    return;
  }
  const start = performance.now();
  const delta = to - from;
  numberAnimTarget = to;
  numberAnimValue = from;
  function frame(now) {
    const progress = Math.min(1, (now - start) / duration);
    numberAnimValue = from + delta * easeOutQuart(progress);
    el.textContent = formatNumber(numberAnimValue);
    if (progress < 1) {
      numberAnimHandle = requestAnimationFrame(frame);
    } else {
      numberAnimHandle = 0;
      numberAnimTarget = null;
      numberAnimValue = to;
      if (typeof onDone === 'function') onDone();
    }
  }
  numberAnimHandle = requestAnimationFrame(frame);
}

function animateTotalNumber(el, from, to, duration) {
  animateNumber(el, from, to, duration, () => updateTotalCompact(to));
}

const rowNumberAnimations = new Map();
const rowBarAnimations = new Map();
const rowRenderFingerprints = new WeakMap();
const largeSessionContainmentScheduler = createAfterLayoutScheduler(
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null,
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null
);

function updateLargeSessionContainment(enabled, { remeasure = false } = {}) {
  els.breakdown.classList.toggle('large-session-list', enabled);
  if (!enabled) {
    largeSessionContainmentScheduler.cancel();
    els.breakdown.classList.remove('large-session-list-ready');
    return;
  }
  if (remeasure) {
    largeSessionContainmentScheduler.cancel();
    els.breakdown.classList.remove('large-session-list-ready');
  }
  if (largeSessionContainmentScheduler.pending() || els.breakdown.classList.contains('large-session-list-ready')) return;
  // Let Chromium lay out every new row without size containment first. The
  // `auto` intrinsic size can then retain each row's real block size before
  // off-screen rendering is enabled, avoiding scroll-geometry corrections.
  largeSessionContainmentScheduler.schedule(() => {
    if (els.breakdown.classList.contains('large-session-list')) {
      els.breakdown.classList.add('large-session-list-ready');
    }
  });
}

function prefersReducedMotion() {
  return motionPreferenceApi.shouldReduceMotion(state.settings?.reduceMotion, reducedMotionMedia?.matches);
}

function settleMotionAnimations() {
  cancelTokenRateBoost(undefined, { suppressClick: false });
  cancelNumberAnimation();
  numberAnimValue = state.currentTotal;
  els.totalTokens.textContent = formatNumber(state.currentTotal);
  updateTotalCompact(state.currentTotal);
  for (const [el, motion] of rowNumberAnimations) {
    cancelAnimationFrame(motion.handle);
    const target = Number(motion.target ?? el.dataset.motionTarget ?? el.dataset.motionValue ?? 0);
    el.textContent = formatNumber(target);
    el.dataset.motionValue = String(target);
    delete el.dataset.motionTarget;
  }
  rowNumberAnimations.clear();
  for (const animation of document.getAnimations?.() || []) {
    try { animation.finish(); } catch (_) { animation.cancel(); }
  }
  rowBarAnimations.clear();
}

function applyReduceMotionPreference(value) {
  const preference = motionPreferenceApi.normalize(value);
  document.documentElement.dataset.reduceMotion = preference;
  if (motionPreferenceApi.shouldReduceMotion(preference, reducedMotionMedia?.matches)) settleMotionAnimations();
  return preference;
}

function captureBreakdownMotion() {
  const rows = Array.from(els.breakdown?.querySelectorAll('.row[data-key]') || []);
  if (!shouldAnimateBreakdownRows(rows.length, { reducedMotion: prefersReducedMotion() })) return null;
  const snapshot = new Map();
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const fill = row.querySelector('.bar-fill');
    const trackWidth = fill?.parentElement?.getBoundingClientRect().width || 0;
    const fillWidth = fill?.getBoundingClientRect().width || 0;
    snapshot.set(row.dataset.key, {
      top: rect.top,
      value: Number(row.querySelector('.row-value')?.dataset.motionValue || row.dataset.motionValue || 0),
      barScale: trackWidth > 0 ? Math.max(0, Math.min(1, fillWidth / trackWidth)) : 0
    });
  }
  return snapshot;
}

function animateRowNumber(el, from, to, duration = 420) {
  const previous = rowNumberAnimations.get(el);
  if (previous?.target === to) return;
  if (previous) cancelAnimationFrame(previous.handle);
  const startValue = Number.isFinite(previous?.value) ? previous.value : from;
  if (!Number.isFinite(startValue) || !Number.isFinite(to) || startValue === to || prefersReducedMotion()) {
    el.textContent = formatNumber(to);
    el.dataset.motionValue = String(Number(to) || 0);
    delete el.dataset.motionTarget;
    rowNumberAnimations.delete(el);
    return;
  }
  const startedAt = performance.now();
  const delta = to - startValue;
  const motion = { handle: 0, target: to, value: startValue };
  el.textContent = formatNumber(startValue);
  el.dataset.motionValue = String(startValue);
  el.dataset.motionTarget = String(to);
  function frame(now) {
    if (prefersReducedMotion()) {
      el.textContent = formatNumber(to);
      el.dataset.motionValue = String(Number(to) || 0);
      delete el.dataset.motionTarget;
      if (rowNumberAnimations.get(el) === motion) rowNumberAnimations.delete(el);
      return;
    }
    const progress = Math.min(1, (now - startedAt) / duration);
    motion.value = startValue + delta * easeOutQuart(progress);
    el.textContent = formatNumber(motion.value);
    el.dataset.motionValue = String(motion.value);
    if (progress < 1) {
      motion.handle = requestAnimationFrame(frame);
    } else {
      delete el.dataset.motionTarget;
      if (rowNumberAnimations.get(el) === motion) rowNumberAnimations.delete(el);
    }
  }
  motion.handle = requestAnimationFrame(frame);
  rowNumberAnimations.set(el, motion);
}

function cancelRowNumberAnimation(el) {
  if (!el) return;
  const motion = rowNumberAnimations.get(el);
  if (motion) cancelAnimationFrame(motion.handle);
  rowNumberAnimations.delete(el);
  delete el.dataset.motionTarget;
}

function animateBreakdownFrom(snapshot, { duration = 420 } = {}) {
  if (!snapshot) return;
  const rows = Array.from(els.breakdown?.querySelectorAll('.row[data-key]') || []);
  if (!shouldAnimateBreakdownRows(rows.length, { reducedMotion: prefersReducedMotion() })) return;
  let enteringIndex = 0;
  for (const row of rows) {
    // An unavailable native session value must stay a semantic label. The
    // ordinary row-number tween formats its zero placeholder as "0", which
    // would turn unknown data into a false numeric reading after every render.
    if (row.dataset.tokenDataUnavailable === 'true') {
      cancelRowNumberAnimation(row.querySelector('.row-value'));
      continue;
    }
    const previous = snapshot.get(row.dataset.key);
    const value = Number(row.dataset.motionValue || 0);
    const fill = row.querySelector('.bar-fill');
    const targetScale = Math.max(0, Math.min(1, Number(fill?.style.getPropertyValue('--bar-scale')) || 0));
    if (previous) {
      const deltaY = previous.top - row.getBoundingClientRect().top;
      if (Math.abs(deltaY) > 0.5) {
        row.animate([
          { transform: `translate3d(0, ${deltaY}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' }
        ], { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      }
      animateBarBetween(fill, previous.barScale, targetScale, 0, duration);
      animateRowNumber(row.querySelector('.row-value'), previous.value, value, duration);
      continue;
    }
    row.animate([
      { opacity: 0, transform: 'translate3d(0, 7px, 0)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ], {
      duration: 240,
      delay: Math.min(enteringIndex, 6) * 18,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'backwards'
    });
    const delay = Math.min(enteringIndex, 6) * 18;
    animateBarBetween(fill, 0, targetScale, delay, Math.max(1, duration - delay));
    animateRowNumber(row.querySelector('.row-value'), 0, value, duration);
    enteringIndex += 1;
  }
}

function animateBarBetween(fill, fromScale, toScale, delay = 0, duration = 420) {
  if (!fill?.animate) return;
  const previous = rowBarAnimations.get(fill);
  const previousIsActive = previous?.animation.pending || previous?.animation.playState === 'running';
  if (previousIsActive && Math.abs(previous.target - toScale) < 0.001) return;
  for (const animation of fill.getAnimations()) animation.cancel();
  rowBarAnimations.delete(fill);
  if (Math.abs(toScale - fromScale) < 0.001) return;
  const animation = fill.animate([
    { transform: `scaleX(${fromScale})` },
    { transform: `scaleX(${toScale})` }
  ], {
    duration,
    delay,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'backwards'
  });
  const motion = { animation, target: toScale };
  const forget = () => {
    if (rowBarAnimations.get(fill) === motion) rowBarAnimations.delete(fill);
  };
  animation.onfinish = forget;
  animation.oncancel = forget;
  rowBarAnimations.set(fill, motion);
}

function captureTrendBarMotion() {
  const snapshot = new Map();
  for (const bar of els.trendsPanel?.querySelectorAll('.spark-bar[data-motion-key]') || []) {
    snapshot.set(bar.dataset.motionKey, { height: bar.getBoundingClientRect().height });
  }
  return snapshot;
}

function animateTrendBarsFrom(snapshot, { fromZero = false } = {}) {
  if (prefersReducedMotion()) return;
  const bars = Array.from(els.trendsPanel?.querySelectorAll('.spark-bar[data-motion-key]') || []);
  bars.forEach((bar, index) => {
    const previous = snapshot.get(bar.dataset.motionKey);
    const targetHeight = bar.getBoundingClientRect().height;
    const fromScale = fromZero || !previous
      ? 0
      : targetHeight > 0 ? previous.height / targetHeight : 1;
    if (Math.abs(fromScale - 1) < 0.001) return;
    bar.animate([
      { transform: `scaleY(${fromScale})` },
      { transform: 'scaleY(1)' }
    ], {
      duration: 420,
      delay: previous && !fromZero ? 0 : Math.min(index, 14) * 14,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'backwards'
    });
  });
}

const HOME_HISTORY_MOTION_MS = 920;
const HOME_HEATMAP_MOTION_MS = 640;
const HOME_HEAT_CELL_MOTION_MS = 240;

function animateHomeHistoryVisuals(activityScroll, activityCanvas, trendChart) {
  if (!state.animateChartsOnRender) return;
  state.animateChartsOnRender = false;
  if (prefersReducedMotion()) return;

  const heatCells = Array.from(activityCanvas?.querySelectorAll('.heat-base-layer .heat') || []);
  const viewport = activityScroll?.getBoundingClientRect();
  const visibleCells = heatCells.map((cell, index) => ({ cell, column: Math.floor(index / 7), rect: cell.getBoundingClientRect() }))
    .filter(({ rect }) => viewport && rect.right > viewport.left && rect.left < viewport.right);
  const firstVisibleColumn = visibleCells.length ? visibleCells[0].column : 0;
  const lastVisibleColumn = visibleCells.length ? visibleCells[visibleCells.length - 1].column : firstVisibleColumn;
  const heatColumnDelay = (HOME_HEATMAP_MOTION_MS - HOME_HEAT_CELL_MOTION_MS) / Math.max(1, lastVisibleColumn - firstVisibleColumn);
  visibleCells.forEach(({ cell, column }) => {
    cell.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: HOME_HEAT_CELL_MOTION_MS,
      delay: (column - firstVisibleColumn) * heatColumnDelay,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'backwards'
    });
  });

  const line = trendChart?.querySelector('.area-line-stroke');
  const fill = trendChart?.querySelector('.area-line-fill');
  const length = line?.getTotalLength?.() || 0;
  if (length > 0) {
    line.animate([
      { strokeDasharray: `${length} ${length}`, strokeDashoffset: length },
      { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0 }
    ], {
      duration: HOME_HISTORY_MOTION_MS,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'backwards'
    });
  }
  fill?.animate([
    { clipPath: 'inset(0 100% 0 0)' },
    { clipPath: 'inset(0 0 0 0)' }
  ], {
    duration: HOME_HISTORY_MOTION_MS,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'backwards'
  });
}

function applyBarScale(fill, scale) {
  const safeScale = Math.max(0, Math.min(1, Number(scale) || 0));
  fill.style.setProperty('--bar-scale', String(safeScale));
  if (!state.animateBarsFromZero || prefersReducedMotion() || !fill.animate) return;
  animateBarBetween(fill, 0, safeScale, 0, 420);
}

function rowWidth(value, max) {
  if (Number(value) <= 0) return 0;
  return max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
}

function rowTemplate(rowData) {
  const { key, name, platform, client, subtitle, detail, kind } = rowData;
  const row = document.createElement('div');
  row.dataset.key = key;
  if (platform) row.dataset.platform = platform;
  if (client) row.dataset.client = client;
  if (kind) row.dataset.kind = kind;
  row.innerHTML = '<div class="row-head"><div class="row-name"><span class="row-mark"></span><div class="row-label"><span class="row-title"></span><span class="row-subtitle"></span><span class="row-detail"></span></div></div><div class="row-metrics"><div class="row-value"></div><div class="row-cost"></div></div></div><div class="row-body"><div class="bar"><div class="bar-fill"></div></div><div class="row-accordion"><div class="row-accordion-inner"></div></div></div>';
  row.querySelector('.row-title').textContent = name;
  row.querySelector('.row-subtitle').textContent = subtitle || '';
  row.querySelector('.row-detail').textContent = detail || '';
  return row;
}

function renderDeviceAccordion(accordionInner, deviceDetail) {
  const signature = JSON.stringify([
    toolIconsEnabled(state.settings?.showToolIcons),
    deviceDetail.emptyText,
    deviceDetail.metaParts,
    deviceDetail.tools.map((tool) => [
      tool.key,
      tool.value,
      Math.round(tool.percent),
      tool.color,
      tool.models.map((model) => [model.key, model.value])
    ])
  ]);
  if (accordionInner.dataset.signature === signature) return;

  const content = document.createElement('div');
  content.className = 'accordion-content device-breakdown';
  if (deviceDetail.tools.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'device-breakdown-empty';
    empty.textContent = deviceDetail.emptyText;
    content.append(empty);
  } else {
    for (const tool of deviceDetail.tools) {
      const toolGroup = document.createElement('div');
      toolGroup.className = 'device-tool';
      const head = document.createElement('div');
      head.className = 'device-tool-head';
      const label = document.createElement('div');
      label.className = 'device-tool-label';
      const mark = document.createElement('span');
      if (toolIconsEnabled(state.settings?.showToolIcons) && clientsWithIcon.has(tool.client)) {
        mark.className = `device-tool-mark row-icon row-icon-${tool.client}`;
      } else {
        mark.className = 'device-tool-mark dot';
        mark.style.background = tool.color;
      }
      const name = document.createElement('span');
      name.className = 'device-tool-name';
      name.textContent = tool.name;
      const percent = document.createElement('span');
      percent.className = 'accordion-pct';
      percent.textContent = `${Math.round(tool.percent)}%`;
      label.append(mark, name, percent);
      const metrics = document.createElement('span');
      metrics.className = 'device-tool-metrics';
      metrics.textContent = formatNumber(tool.value);
      head.append(label, metrics);
      toolGroup.append(head);

      if (tool.models.length > 0) {
        const modelList = document.createElement('div');
        modelList.className = 'device-model-list';
        for (const model of tool.models) {
          const modelRow = document.createElement('div');
          modelRow.className = 'device-model-row';
          const modelName = document.createElement('span');
          modelName.className = 'device-model-name';
          modelName.textContent = model.name;
          const modelValue = document.createElement('span');
          modelValue.className = 'device-model-value';
          modelValue.textContent = formatCompact(model.value);
          modelRow.append(modelName, modelValue);
          modelList.append(modelRow);
        }
        toolGroup.append(modelList);
      }
      content.append(toolGroup);
    }
  }
  if (deviceDetail.metaParts.length > 0) {
    const meta = document.createElement('div');
    meta.className = 'device-meta';
    meta.textContent = deviceDetail.metaParts.join(' · ');
    content.append(meta);
  }
  accordionInner.replaceChildren(content);
  accordionInner.dataset.signature = signature;
}

function updateRow(row, { name, subtitle, detail, value, cost, max, color, barBackground, accordionRows, deviceDetail, stale, platform, local, client, kind, cacheReadTokens, outputTokens, unclassifiedTokens, tokenDataUnavailable, sessionDetailAvailable }) {
  const width = rowWidth(value, max);
  const isExpanded = row.classList.contains('expanded');
  row.className = `row${kind ? ` ${kind}-row` : ''}${stale ? ' stale' : ''}${local ? ' local' : ''}`;
  row.title = local ? 'This device' : '';
  
  if (cacheReadTokens !== undefined || outputTokens !== undefined || unclassifiedTokens !== undefined) {
    row.dataset.cacheRead = cacheReadTokens || 0;
    row.dataset.outputTokens = outputTokens || 0;
    row.dataset.unclassifiedTokens = unclassifiedTokens || 0;
    row.dataset.totalTokens = value || 0;
    row.dataset.name = name || '';
  }
  if (platform !== undefined) row.dataset.platform = platform || '';
  if (client !== undefined) row.dataset.client = client || '';
  if (kind !== undefined) row.dataset.kind = kind || '';
  if (kind === 'session' && client === 'reasonix') {
    row.dataset.detailUnavailable = sessionDetailAvailable === true ? 'false' : 'true';
  } else if (row.hasAttribute('data-detail-unavailable')) {
    row.removeAttribute('data-detail-unavailable');
  }
  const mark = row.querySelector('.row-mark');
  const iconKind = iconKindFor({ key: row.dataset.key, platform: row.dataset.platform || '', client: row.dataset.client || '' }, state.breakdown);
  if (iconKind.kind === 'icon') {
    mark.className = `row-mark row-icon ${iconKind.iconClass}`;
    mark.style.background = '';
  } else {
    mark.className = 'row-mark dot';
    mark.style.background = color;
  }
  row.querySelector('.row-title').textContent = name;
  const subtitleEl = row.querySelector('.row-subtitle');
  subtitleEl.textContent = subtitle || '';
  subtitleEl.classList.toggle('hidden', !subtitle);
  const detailEl = row.querySelector('.row-detail');
  detailEl.textContent = detail || '';
  detailEl.classList.toggle('hidden', !detail);
  const valueEl = row.querySelector('.row-value');
  if (tokenDataUnavailable === true) {
    row.dataset.tokenDataUnavailable = 'true';
    cancelRowNumberAnimation(valueEl);
    valueEl.textContent = t('detailTokenUnavailable') || 'Unavailable';
  } else {
    delete row.dataset.tokenDataUnavailable;
    valueEl.textContent = formatNumber(value);
  }
  valueEl.dataset.motionValue = String(Number(value) || 0);
  row.dataset.motionValue = String(Number(value) || 0);
  row.querySelector('.row-cost').textContent = tokenDataUnavailable === true ? '' : formatCost(cost || 0);
  const fill = row.querySelector('.bar-fill');
  fill.style.background = barBackground || color;
  applyBarScale(fill, width / 100);

  const accordionInner = row.querySelector('.row-accordion-inner');
  if (deviceDetail) {
    renderDeviceAccordion(accordionInner, deviceDetail);
    row.classList.add('has-accordion');
    if (isExpanded) row.classList.add('expanded');
  } else if (Array.isArray(accordionRows) && accordionRows.length > 0) {
    const accordionSignature = JSON.stringify(accordionRows.map((tool) => [tool.name, tool.value, Math.round(tool.percent), tool.color]));
    if (accordionInner.dataset.signature !== accordionSignature) {
      const content = document.createElement('div');
      content.className = 'accordion-content project-tool-breakdown';
      for (const tool of accordionRows) {
        const item = document.createElement('div');
        item.className = 'accordion-row project-tool-row';
        const label = document.createElement('div');
        label.className = 'accordion-label';
        const mark = document.createElement('span');
        mark.className = 'project-tool-mark';
        mark.style.background = tool.color;
        const text = document.createElement('span');
        text.textContent = tool.name;
        const percent = document.createElement('span');
        percent.className = 'accordion-pct';
        percent.textContent = `${Math.round(tool.percent)}%`;
        label.append(mark, text, percent);
        const tokens = document.createElement('span');
        tokens.className = 'accordion-value';
        tokens.textContent = formatNumber(tool.value);
        item.append(label, tokens);
        content.append(item);
      }
      accordionInner.replaceChildren(content);
      accordionInner.dataset.signature = accordionSignature;
    }
    row.classList.add('has-accordion');
    if (isExpanded) row.classList.add('expanded');
  } else if ((cacheReadTokens !== undefined || outputTokens !== undefined || unclassifiedTokens !== undefined) && value > 0 && kind !== 'session') {
    const {
      cacheRead,
      cacheMiss,
      output,
      unclassified,
      hitPct,
      missPct
    } = fixedPeriodRangesApi.tokenComponentBreakdown({
      totalTokens: value,
      cacheReadTokens,
      outputTokens,
      unclassifiedTokens
    });
    
    delete accordionInner.dataset.signature;
    accordionInner.innerHTML = `
      <div class="accordion-content">
        <div class="accordion-row">
          <div class="accordion-label">${t('dashboard.tooltip.inputCacheHit')} <span class="accordion-pct">${hitPct}%</span></div>
          <div class="accordion-value">${formatNumber(cacheRead)}</div>
        </div>
        <div class="accordion-row">
          <div class="accordion-label">${t('dashboard.tooltip.inputCacheMiss')} <span class="accordion-pct">${missPct}%</span></div>
          <div class="accordion-value">${formatNumber(cacheMiss)}</div>
        </div>
        <div class="accordion-row">
          <div class="accordion-label">${t('dashboard.tooltip.output')}</div>
          <div class="accordion-value">${formatNumber(output)}</div>
        </div>
        ${unclassified > 0 ? `
        <div class="accordion-row">
          <div class="accordion-label">${t('dashboard.tooltip.unclassified')}</div>
          <div class="accordion-value">${formatNumber(unclassified)}</div>
        </div>` : ''}
      </div>
    `;
    row.classList.add('has-accordion');
    if (isExpanded) row.classList.add('expanded');
  } else {
    accordionInner.replaceChildren();
    delete accordionInner.dataset.signature;
    row.classList.remove('has-accordion');
    row.classList.remove('expanded');
  }
  if (row.classList.contains('has-accordion')) {
    if (row.tabIndex !== 0) row.tabIndex = 0;
    setAttributeIfChanged(row, 'role', 'button');
    setAttributeIfChanged(row, 'aria-expanded', String(row.classList.contains('expanded')));
    const tokenLabel = tokenDataUnavailable === true
      ? (t('detailTokenUnavailable') || 'Unavailable')
      : formatNumber(value);
    const costLabel = tokenDataUnavailable === true ? '' : `, ${t('dashboard.stat.totalCost')}: ${formatCost(cost || 0)}`;
    setAttributeIfChanged(row, 'aria-label', `${name}, ${t('dashboard.stat.totalTokens')}: ${tokenLabel}${costLabel}`);
  } else {
    if (row.hasAttribute('tabindex')) row.removeAttribute('tabindex');
    if (row.hasAttribute('role')) row.removeAttribute('role');
    if (row.hasAttribute('aria-expanded')) row.removeAttribute('aria-expanded');
    if (row.hasAttribute('aria-label')) row.removeAttribute('aria-label');
  }
}

function applyHomeListMark(mark, iconKind, color) {
  if (iconKind.kind === 'icon') {
    mark.className = `home-list-mark row-icon ${iconKind.iconClass}`;
    mark.style.background = '';
    return;
  }
  mark.className = 'home-list-mark';
  mark.style.background = color;
}

function renderRows(rows, { incompleteHint = '' } = {}) {
  const largeSessionList = isLargeSessionBreakdown(state.breakdown, rows.length);
  if (rows.length === 0 && !incompleteHint) {
    updateLargeSessionContainment(false);
    els.breakdown.replaceChildren();
    state.rowSignature = '';
    return;
  }
  const max = Math.max(1, ...rows.map((row) => row.value));
  const liveMotionSnapshot = !state.periodMotionActive && !state.animateBarsFromZero
    ? captureBreakdownMotion()
    : null;
  const hintText = incompleteHint ? t(incompleteHint) : '';
  const signature = JSON.stringify([state.breakdown, hintText, rows.map((row) => row.key)]);
  const children = Array.from(els.breakdown.children);
  const existingHint = children.find((child) => child.classList.contains('breakdown-incomplete-hint'));
  const existing = new Map(children.filter((child) => child !== existingHint).map((child) => [child.dataset.key, child]));
  const structureChanged = signature !== state.rowSignature;
  if (structureChanged) {
    const nodes = rows.map((row) => existing.get(row.key) || rowTemplate(row));
    if (incompleteHint) {
      const hint = existingHint || document.createElement('p');
      hint.className = 'breakdown-incomplete-hint';
      hint.setAttribute('role', 'status');
      hint.textContent = hintText;
      nodes.unshift(hint);
    }
    els.breakdown.replaceChildren(...nodes);
    state.rowSignature = signature;
  }
  updateLargeSessionContainment(largeSessionList, { remeasure: structureChanged });
  const current = new Map(Array.from(els.breakdown.children)
    .filter((child) => !child.classList.contains('breakdown-incomplete-hint'))
    .map((child) => [child.dataset.key, child]));
  const renderContext = {
    breakdown: state.breakdown,
    currency: currentCurrency(),
    currencyRatesEffective: state.settings?.currencyRatesEffective || null,
    locale: currentLocale(),
    showToolIcons: toolIconsEnabled(state.settings?.showToolIcons)
  };
  for (const rowData of rows) {
    const row = current.get(rowData.key);
    if (!row) continue;
    const fingerprint = rowRenderFingerprint(rowData, max, renderContext);
    if (rowRenderFingerprints.get(row) === fingerprint) continue;
    updateRow(row, { ...rowData, max });
    rowRenderFingerprints.set(row, fingerprint);
  }
  if (liveMotionSnapshot) animateBreakdownFrom(liveMotionSnapshot, { duration: 600 });
}

function deviceLabel(device) {
  return device.deviceId || device.hostname || 'device';
}

function deviceColor(stale) {
  return stale ? deviceStaleColor : deviceAccent;
}

function deviceRuntimeLabel(value) {
  if (value === 'electron-widget') return t('devices.runtime.widget');
  if (value === 'headless-agent') return t('devices.runtime.agent');
  return String(value || '');
}

function deviceSyncedLabel(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const diffMs = Math.max(0, Date.now() - date.getTime());
  let age;
  if (diffMs < 45_000) age = t('settings.age.justNow');
  else {
    const minutes = Math.round(diffMs / 60000);
    if (minutes < 60) age = t('settings.age.minutesAgo', { minutes });
    else {
      const hours = Math.round(minutes / 60);
      age = hours < 24
        ? t('settings.age.hoursAgo', { hours })
        : t('settings.age.daysAgo', { days: Math.round(hours / 24) });
    }
  }
  return t('devices.synced', { age });
}

function stableColor(value, colors) {
  let hash = 0;
  for (const char of String(value || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function fixedPeriodDevices() {
  if (!fixedPeriodRangesApi.isDerived(state.period)) return state.stats?.devices || [];
  return fixedPeriodRangesApi.devicesForReadySnapshot(state.fixedPeriodSnapshot, state.period);
}

function fixedPeriodSources() {
  return fixedPeriodRangesApi.joinDeviceHistorySources(
    state.fixedPeriodHistory?.deviceHistories || [],
    state.stats?.devices || []
  );
}

function buildFixedPeriodSourcesSnapshot() {
  const meta = state.fixedPeriodHistory?.fixedPeriods || {};
  return fixedPeriodRangesApi.fixedPeriodSnapshotFromDevices(state.period, fixedPeriodSources(), {
    historyEnabled: state.settings?.historyEnabled !== false,
    historyAvailable: meta.historyTransportAvailable === true,
    todayKey: fixedPeriodTodayKey(),
    locale: currentCalendarLocale()
  });
}

function deviceRowsForPeriod() {
  const localId = state.settings?.deviceId || '';
  return fixedPeriodDevices().map((device) => {
    const breakdown = deviceBreakdownApi.deviceBreakdownForPeriod(device, state.period, {
      clientLabels,
      clientColors,
      fallbackColor: clientColors.default,
      unattributedLabel: t('dashboard.tooltip.unclassified')
    });
    const period = device.periods?.[state.period] || {};
    const runtime = deviceRuntimeLabel(device.agentRuntime);
    const version = device.agentVersion ? `${runtime ? `${runtime} ` : ''}v${device.agentVersion}` : runtime;
    const metaParts = [deviceBreakdownApi.devicePlatformLabel(device.platform, device.osName, device.osVersion), version, deviceSyncedLabel(device.updatedAt)].filter(Boolean);
    return {
      key: device.deviceId,
      name: deviceLabel(device),
      value: breakdown.totalTokens,
      cost: Number(period.costUsd || 0),
      color: deviceColor(Boolean(device.stale)),
      stale: Boolean(device.stale),
      platform: device.platform || '',
      local: Boolean(localId) && device.deviceId === localId,
      deviceDetail: {
        ...breakdown,
        emptyText: breakdown.totalTokens > 0 ? t('devices.detailsUnavailable') : t('home.noTools'),
        metaParts
      }
    };
  }).sort((a, b) => b.value - a.value);
}

function attributionComponent(period, field, key) {
  const aggregateField = {
    clientCacheReads: 'cacheReadTokens',
    modelCacheReads: 'cacheReadTokens',
    clientCacheWrites: 'cacheWriteTokens',
    modelCacheWrites: 'cacheWriteTokens',
    clientOutputs: 'outputTokens',
    modelOutputs: 'outputTokens',
    clientUnclassifiedTokens: 'unclassifiedTokens',
    modelUnclassifiedTokens: 'unclassifiedTokens'
  }[field];
  return usageAttributionRowsApi.attributionValue(
    period?.[field],
    period?.[aggregateField],
    key
  );
}

function periodAttributionRows(period, values, costs) {
  const rows = usageAttributionRowsApi.attributionRows(values, costs, {
    totalValue: period?.totalTokens,
    totalCost: period?.costUsd
  });
  return usageAttributionRowsApi.visibleAttributionRows(rows, formatCost);
}

function toolRowsForPeriod(period) {
  const clientRows = periodAttributionRows(period, period?.clients, period?.clientCosts)
    .map(({ key: client, value, cost }) => ({ key: client, name: client === usageAttributionRowsApi.UNATTRIBUTED_KEY ? t('dashboard.tooltip.unclassified') : clientLabels[client] || client, value, cost, color: clientColors[client] || clientColors.default, stale: false, cacheReadTokens: attributionComponent(period, 'clientCacheReads', client), cacheWriteTokens: attributionComponent(period, 'clientCacheWrites', client), outputTokens: attributionComponent(period, 'clientOutputs', client), unclassifiedTokens: attributionComponent(period, 'clientUnclassifiedTokens', client) }));
  if (clientRows.length > 0) {
    const usageSortedRows = clientRows.sort((a, b) => b.value - a.value);
    return clientDisplayPreferencesApi.applyClientDisplayPreferences(usageSortedRows, state.settings?.clientDisplayOrder, state.settings?.hiddenClients, KNOWN_CLIENTS, state.settings?.pinnedClients);
  }
  if (Number(period?.totalTokens || 0) === 0) return [];
  return deviceRowsForPeriod();
}

function modelRowsForPeriod(period) {
  const modelRows = periodAttributionRows(period, period?.models, period?.modelCosts).map(({ key: model, value, cost }) => ({
    key: model,
    name: model === usageAttributionRowsApi.UNATTRIBUTED_KEY ? t('dashboard.tooltip.unclassified') : model,
    value,
    cost,
    color: modelColor(model),
    stale: false,
    cacheReadTokens: attributionComponent(period, 'modelCacheReads', model),
    cacheWriteTokens: attributionComponent(period, 'modelCacheWrites', model),
    outputTokens: attributionComponent(period, 'modelOutputs', model),
    unclassifiedTokens: attributionComponent(period, 'modelUnclassifiedTokens', model)
  }));
  if (modelRows.length > 0) return modelRows.sort((a, b) => b.value - a.value);
  if (Number(period?.totalTokens || 0) === 0) return [];
  return toolRowsForPeriod(period);
}

function sessionRowsForPeriod(period) {
  const rows = sessionRowsApi.sessionRowsForPeriod(period, {
    clientLabels,
    clientColors,
    modelColor,
    stableColor,
    fallbackColors: fallbackModelColors,
    archivedLabel: t('session.archived'),
    nativeSessions: state.stats?.nativeSessions?.[state.period] || {}
  });
  if (rows.length > 0) return rows.sort((a, b) => b.sortTime - a.sortTime || b.value - a.value || b.cost - a.cost || a.name.localeCompare(b.name));
  if (Number(period?.totalTokens || 0) === 0) return [];
  return modelRowsForPeriod(period);
}

function projectRowsForPeriod(period) {
  return projectRowsApi.projectRowsForPeriod(period, {
    clientLabels,
    clientColors,
    stableColor,
    fallbackColors: fallbackModelColors,
    unknownClientLabel: t('projects.unknownTool'),
    nativeProjects: state.stats?.nativeProjects?.[state.period] || {},
    nativeSessions: state.stats?.nativeSessions?.[state.period] || {}
  });
}

function rowsForPeriod(period) {
  if (state.breakdown === 'device') return deviceRowsForPeriod();
  if (state.breakdown === 'model') return modelRowsForPeriod(period);
  if (state.breakdown === 'session') return sessionRowsForPeriod(period);
  if (state.breakdown === 'project') return projectRowsForPeriod(period);
  return toolRowsForPeriod(period);
}

function limitViewAvailable() {
  return enabledLimitProviderSet().size > 0;
}

function effectiveViewDisplayOrderValue() {
  const raw = state.settings?.viewDisplayOrder;
  const rawIds = String(raw || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (rawIds.length > 0 && !rawIds.includes('home')) {
    const normalized = viewDisplayPreferencesApi.normalizeViewDisplayOrder(raw, VIEW_DISPLAY_OPTIONS);
    return ['home', ...normalized.filter((id) => id !== 'home')].join(',');
  }
  return raw;
}

function availableBreakdownIds() {
  const order = ['home', baseBreakdownOrder[0], 'status', 'trends', ...baseBreakdownOrder.slice(1)];
  let available = state.settings?.historyEnabled === false ? order.filter((id) => id !== 'trends') : order;
  if (state.settings?.projectsEnabled === false) available = available.filter((id) => id !== 'project');
  return limitViewAvailable() ? [...available, 'limits'] : available;
}

function visibleBreakdownOrder() {
  return viewDisplayPreferencesApi.visibleViewOrder({
    views: VIEW_DISPLAY_OPTIONS,
    orderValue: effectiveViewDisplayOrderValue(),
    hiddenValue: state.settings?.hiddenViews,
    availableIds: availableBreakdownIds(),
    includeIds: directBreakdownOverride ? [directBreakdownOverride] : []
  });
}

function ensureBreakdownVisible() {
  const availableIds = availableBreakdownIds();
  if (directBreakdownOverride === state.breakdown && availableIds.includes(state.breakdown)) return;
  directBreakdownOverride = null;
  const next = viewDisplayPreferencesApi.preferredViewId({
    views: VIEW_DISPLAY_OPTIONS,
    orderValue: effectiveViewDisplayOrderValue(),
    hiddenValue: state.settings?.hiddenViews,
    availableIds,
    currentId: state.breakdown
  });
  if (next !== state.breakdown) setBreakdown(next);
}

function limitStatusLabel(status) {
  if (status === 'ok') return 'Live';
  if (status === 'disabled') return 'Disabled';
  if (status === 'notConfigured') return 'Not signed in';
  if (status === 'noSyncedData') return 'No synced data';
  if (status === 'unauthorized') return 'Sign in again';
  if (status === 'rateLimited') return 'Limited';
  if (status === 'sourceRateLimited') return 'Usage API limited';
  if (status === 'unavailable') return 'Unavailable';
  return 'Error';
}

function syncProvenanceActive() {
  return state.mode === 'sync' || Boolean(String(state.settings?.hubUrl || '').trim());
}

function limitProviderProvenance(provider) {
  return limitProviderPresentationApi.limitProviderProvenance(provider, {
    localDeviceId: state.settings?.deviceId || '',
    syncActive: syncProvenanceActive(),
    devices: state.stats?.devices || []
  });
}

function limitProviderMeta(provider, provenance = null) {
  const sourceDevice = limitProviderPresentationApi.limitProviderMainDeviceLabel(provenance, { showSource: Boolean(state.settings?.showLimitSource) });
  if (provider.stale) {
    const parts = ['Stale', formatUpdatedAge(provider.updatedAt).replace('Updated ', '')];
    if (sourceDevice) parts.push(sourceDevice);
    return parts.join(' · ');
  }
  if (provider.status === 'ok') {
    const parts = [];
    if (state.settings?.showLimitSource) {
      const sourceLabel = limitProviderPresentationApi.limitProviderSourceLabel(provider) || LIMIT_SOURCE_LABELS[provider.source];
      if (sourceLabel) parts.push(sourceLabel);
    }
    if (sourceDevice) parts.push(sourceDevice);
    return `${formatUpdatedAge(provider.updatedAt)}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
  }
  return limitStatusLabel(provider.status, false);
}

function limitProviderPlan(provider) {
  if (provider?.status && provider.status !== 'ok' && !provider.stale) return limitStatusLabel(provider.status, false);
  const label = String(provider?.planLabel || provider?.accountLabel || '').trim();
  if (label) return limitProviderPresentationApi.limitProviderDisplayLabel(label);
  return provider?.status && provider.status !== 'ok' ? limitStatusLabel(provider.status, false) : '';
}

// ---------------------------------------------------------------------------
// Subscriptions
//
// What each account actually costs, entered by hand. Nothing here talks to a
// provider — the numbers are the user's own. The value comes from pairing them
// with usage this app already measures.
// ---------------------------------------------------------------------------

function subscriptionList() {
  return subscriptionApi.normalizeSubscriptions(state.settings?.subscriptions, { currencyApi });
}

function subscriptionProviderLabel(providerId) {
  const entry = LIMIT_PROVIDERS.find((provider) => provider.id === providerId);
  return entry?.settingsLabel || entry?.label || providerId;
}

// Keyed off the same list the label comes from, because a `.row-icon-<id>` with
// no mask rule behind it paints a solid square rather than nothing — so a record
// still bound to a provider that has since left the list gets no icon at all.
function subscriptionProviderIconClass(providerId) {
  const known = LIMIT_PROVIDERS.some((provider) => provider.id === providerId);
  return known ? `row-icon row-icon-${providerId}` : '';
}

function isCreditsProvider(provider) {
  return subscriptionApi.isBalanceOnlyAccount(provider);
}

// Every account the limits page renders, which is the cross-device aggregate —
// a shared list names accounts that may be signed in on another machine.
// Preferring this device's own list hid those rows, and worse, left a single
// local account as the only candidate: matchProviderAccount()'s sole-account
// fallback would then bind a remote subscription to whatever is signed in here.
// Local entries come first so this device wins a tie on identical accounts.
function limitProvidersForSubscriptions() {
  const seen = new Set();
  const merged = [];
  for (const provider of [...(localDeviceLimitsProviders() || []), ...(state.stats?.limits?.providers || [])]) {
    const key = subscriptionAccountValue(provider);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(provider);
  }
  return merged;
}

// Every configured account, balance ones included. They used to be hidden behind
// a toggle because the form could only describe a subscription; now the record
// kind says which shape is being recorded, so hiding the accounts only got in
// the way of reaching them.
function subscriptionAccountChoices() {
  const visible = limitProvidersForSubscriptions()
    .filter((provider) => provider?.provider && provider.status !== 'notConfigured');
  return visible.map((provider, index) => ({
    provider,
    value: subscriptionAccountValue(provider),
    label: accountIdentityApi.accountTitleLabel(provider, visible, {
      maskEmail: state.settings?.maskLimitAccountEmails === true,
      index
    }) || subscriptionProviderLabel(provider.provider)
  }));
}

function subscriptionAccountValue(provider) {
  return [provider?.provider || '', provider?.accountKey || '', provider?.accountName || ''].join('\0');
}

// The plan the account already reports ("Pro", "Plus") is nearly always what the
// user would type, so the picker seeds it. limitProviderPlan() doubles as the
// status-label producer, so a provider that is down would otherwise seed the
// field with "Offline" — only a live account may.
function subscriptionSuggestedPlanName(provider) {
  if (!provider) return '';
  if (provider.status && provider.status !== 'ok' && !provider.stale) return '';
  return limitProviderPlan(provider);
}

function subscriptionSelectedAccount() {
  const value = String(els.subscriptionAccountInput?.value || '');
  return subscriptionAccountChoices().find((choice) => choice.value === value)?.provider || null;
}

function subscriptionAmountText(subscription) {
  const code = currencyApi.normalizeCurrency(subscription?.currency);
  const symbol = currencyApi.CURRENCY_RATES[code]?.symbol || `${code} `;
  return `${symbol}${subscriptionApi.amountUnits(subscription).toFixed(2)}`;
}

function subscriptionCadenceText(subscription) {
  const count = Number(subscription?.intervalCount) || 1;
  const unit = subscription?.interval === 'year'
    ? t('settings.subscriptions.unitYear')
    : t('settings.subscriptions.unitMonth');
  return count === 1 ? unit : t('settings.subscriptions.everyN', { count, unit });
}

function subscriptionPriceText(subscription) {
  return `${subscriptionAmountText(subscription)} / ${subscriptionCadenceText(subscription)}`;
}

// "0 days left" reads like a bug on the day itself, which is exactly the day the
// user is most likely to be looking.
function subscriptionDaysText(days) {
  return days === 0
    ? t('subscription.tooltip.today')
    : t('subscription.tooltip.daysLeft', { days });
}

function subscriptionDateText(dateString) {
  if (!dateString) return '';
  // Construct in local time from the calendar parts so the rendered day always
  // matches the stored one, whatever the timezone.
  return subscriptionLocalDate(dateString)?.toLocaleDateString(currentLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }) || '';
}

// The settings rows are two dense lines inside a ~300px panel and the date is the
// longest thing on the second one, so there it is the numeric short form the
// locale itself defines. Everywhere with room to spell it out — the tooltip
// above all — still uses subscriptionDateText().
function subscriptionShortDateText(dateString) {
  if (!dateString) return '';
  return subscriptionLocalDate(dateString)?.toLocaleDateString(currentLocale(), { dateStyle: 'short' }) || '';
}

function subscriptionLocalDate(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(year, month - 1, day);
}

// Usage cost is keyed by client, and every provider whose id names a tracked
// client can be compared against it. Providers with no same-named client
// (openrouter, deepseek, thirdparty, zai…) simply produce nothing, which is the
// correct answer: their spend is either pay-as-you-go or spread across clients
// with no way to attribute it.
function subscriptionUsageCostUsd(providerId) {
  if (!Object.prototype.hasOwnProperty.call(clientLabels, providerId)) return null;
  const month = state.stats?.periods?.month;
  const cost = Number(month?.clientCosts?.[providerId] || 0);
  return cost > 0 ? cost : null;
}

// Matched against every account the provider has, never against a one-element
// list of the row being rendered: matchProviderAccount() falls back to "the
// provider has exactly one account, so there is no ambiguity", and a single-row
// universe makes that fallback true for every sibling. That is what put one
// Codex subscription's card on all three Codex accounts.
function subscriptionForProvider(provider) {
  const id = String(provider?.provider || '').toLowerCase();
  const accounts = limitProvidersForSubscriptions();
  const identity = subscriptionAccountValue(provider);
  for (const subscription of subscriptionList()) {
    if (subscription.provider !== id) continue;
    const account = subscriptionApi.matchProviderAccount(subscription, accounts);
    if (account && subscriptionAccountValue(account) === identity) return subscription;
  }
  return null;
}

// Every subscription recorded against a provider, paired with the account it
// resolves to. Drives the group header, which stands for all of them at once.
function subscriptionsForProviderGroup(providerId) {
  const id = String(providerId || '').toLowerCase();
  const accounts = limitProvidersForSubscriptions();
  return subscriptionList()
    .filter((subscription) => subscription.provider === id)
    .map((subscription) => ({
      subscription,
      account: subscriptionApi.matchProviderAccount(subscription, accounts)
    }));
}

// The record already held against an account, if any. One account holds one
// record: a second one saved without complaint and then never appeared — the
// card resolves the first match and stops — which read as the new entry having
// replaced the old one.
function subscriptionForAccountValue(list, providerId, accountValue, excludeId) {
  const accounts = limitProvidersForSubscriptions();
  return list.find((entry) => {
    if (entry.id === excludeId || entry.provider !== providerId) return false;
    const bound = subscriptionApi.matchProviderAccount(entry, accounts);
    return Boolean(bound) && subscriptionAccountValue(bound) === accountValue;
  }) || null;
}

// Rows are {label, value} pairs so the tooltip stays a table and the caller does
// not have to know which shape it is looking at.
// Keyed off what the user recorded, never off the account's balance marker: the
// marker only seeds the choice, and reading it here would show subscription rows
// for a ledger the moment a provider started reporting a balance.
function subscriptionTooltipRows(subscription, provider, includeRollup) {
  const today = subscriptionApi.todayString();
  return subscriptionApi.isTopUp(subscription)
    ? topUpTooltipRows(subscription, provider, today, includeRollup)
    : subscriptionPlanTooltipRows(subscription, provider, today, includeRollup);
}

// How long the user has been paying, plus what that adds up to. Months is the
// unit people quote a subscription in, but it rounds a three-week-old plan down
// to "0 months" — which reads as a bug beside a non-zero total, and does so for
// most of the first month of every subscription anyone records. Below a month
// the honest unit is days. A start date that has not arrived yet has no elapsed
// time and nothing paid, so it says so instead of reporting zero of both.
//
// Once coverage has lapsed the clock stops there: a plan bought for one month
// and never renewed stays "1 month", it does not keep ageing after it ended.
function subscriptionElapsedText(subscription, today) {
  const stop = subscriptionApi.coverageStopDate(subscription);
  const asOf = stop && stop < today ? stop : today;
  const daysSinceStart = subscriptionApi.daysBetween(subscription.startDate, asOf);
  if (daysSinceStart !== null && daysSinceStart < 0) return t('subscription.tooltip.notStarted');

  const months = subscriptionApi.subscribedMonths(subscription, asOf);
  const elapsed = months >= 1
    ? t('subscription.tooltip.months', { months })
    : t('subscription.tooltip.daysCount', { days: Math.max(0, daysSinceStart || 0) });
  const code = currencyApi.normalizeCurrency(subscription.currency);
  const symbol = currencyApi.CURRENCY_RATES[code]?.symbol || `${code} `;
  const paid = subscriptionApi.paidToDateMinor(subscription, today) / 100;
  return `${elapsed} · ${t('subscription.tooltip.paidTotal', { total: `${symbol}${paid.toFixed(2)}` })}`;
}

function subscriptionPlanTooltipRows(subscription, provider, today, includeRollup) {
  const rows = [];
  rows.push({ label: t('subscription.tooltip.price'), value: subscriptionPriceText(subscription) });

  const endDate = subscriptionApi.coverageEndDate(subscription, today);
  const daysLeft = subscriptionApi.daysUntilRenewal(subscription, today);
  const whenLabel = subscription.autoRenew
    ? t('subscription.tooltip.nextCharge')
    : t('subscription.tooltip.validUntil');
  // A lapsed plan has no days left to count down. Saying so beats a negative
  // number, and beats the silent roll-forward that used to keep a cancelled
  // plan permanently four days from renewing.
  const whenSuffix = daysLeft === null
    ? ''
    : ` · ${daysLeft < 0 ? t('subscription.tooltip.expired') : subscriptionDaysText(daysLeft)}`;
  rows.push({ label: whenLabel, value: `${subscriptionDateText(endDate)}${whenSuffix}` });
  if (!subscription.autoRenew) {
    rows.push({ label: t('subscription.tooltip.autoRenew'), value: t('subscription.tooltip.autoRenewOff') });
  }

  rows.push({
    label: t('subscription.tooltip.subscribed'),
    value: subscriptionElapsedText(subscription, today)
  });

  // The rollup covers every account of the provider at once, so it belongs on
  // whichever row stands for the provider as a whole. When a group header is
  // rendered that is the header, and repeating the same three lines under each
  // member is the noise the header exists to avoid.
  if (!includeRollup) return rows;

  // tokscale records which client produced the tokens, never which signed-in
  // account did, so three logins share one usage figure. Charging that figure
  // against a single account would claim it three times over; the rollup is the
  // only honest denominator.
  const usageCostUsd = subscriptionUsageCostUsd(subscription.provider);
  if (usageCostUsd === null) return rows;
  const rollup = subscriptionApi.providerRollup(subscriptionList(), subscription.provider, currencyApi, today);
  const multiple = subscriptionApi.valueMultiple(rollup.monthlyUsd, usageCostUsd);
  if (multiple === null) return rows;

  rows.push({ separator: true });
  if (rollup.count > 1) {
    rows.push({
      label: t('subscription.tooltip.providerTotal', { provider: subscriptionProviderLabel(subscription.provider) }),
      value: t('subscription.tooltip.providerTotalValue', {
        count: rollup.count,
        total: formatCost(rollup.monthlyUsd)
      })
    });
  }
  rows.push({
    label: t('subscription.tooltip.monthUsage'),
    // Prefixed with "≈" and titled below: this is tokscale's equivalent API
    // pricing, not money owed. Under a subscription nothing is billed per token.
    value: `≈ ${formatCost(usageCostUsd)}${rollup.count > 1 ? ` · ${t('subscription.tooltip.allAccounts')}` : ''}`,
    title: t('subscription.tooltip.monthUsageNote')
  });
  rows.push({
    label: t('subscription.tooltip.valueMultiple'),
    value: `${multiple.toFixed(1)}×`
  });
  return rows;
}

// The group header stands for every account at once, so it summarises rather
// than picking one of them. Usage and the value multiple are already provider
// level on the per-account card; here the price is too.
function subscriptionGroupTooltipRows(providerId, today) {
  const rollup = subscriptionApi.providerRollup(subscriptionList(), providerId, currencyApi, today);
  const rows = [{
    label: t('subscription.tooltip.providerTotal', { provider: subscriptionProviderLabel(providerId) }),
    value: t('subscription.tooltip.providerTotalValue', {
      count: rollup.count,
      total: formatCost(rollup.monthlyUsd)
    })
  }];

  const usageCostUsd = subscriptionUsageCostUsd(providerId);
  if (usageCostUsd === null) return rows;
  rows.push({ separator: true });
  rows.push({
    label: t('subscription.tooltip.monthUsage'),
    value: `≈ ${formatCost(usageCostUsd)} · ${t('subscription.tooltip.allAccounts')}`,
    title: t('subscription.tooltip.monthUsageNote')
  });
  const multiple = subscriptionApi.valueMultiple(rollup.monthlyUsd, usageCostUsd);
  if (multiple !== null) {
    rows.push({ label: t('subscription.tooltip.valueMultiple'), value: `${multiple.toFixed(1)}×` });
  }
  return rows;
}

function topUpMinorText(subscription, amountMinor) {
  const code = currencyApi.normalizeCurrency(subscription?.currency);
  const symbol = currencyApi.CURRENCY_RATES[code]?.symbol || `${code} `;
  return `${symbol}${(amountMinor / 100).toFixed(2)}`;
}

function topUpTooltipRows(subscription, provider, today, includeRollup) {
  const rows = [];
  const last = subscriptionApi.lastTopUp(subscription);
  if (last) {
    rows.push({
      label: t('subscription.tooltip.lastTopUp'),
      value: `${subscriptionDateText(last.date)} · ${topUpMinorText(subscription, last.amountMinor)}`
    });
  }
  const monthMinor = subscriptionApi.topUpMonthMinor(subscription, today);
  if (monthMinor > 0) {
    rows.push({
      label: t('subscription.tooltip.topUpMonth'),
      value: topUpMinorText(subscription, monthMinor)
    });
  }
  const entries = subscriptionApi.topUpEntries(subscription);
  if (entries.length > 1) {
    rows.push({
      label: t('subscription.tooltip.topUpTotal'),
      value: `${topUpMinorText(subscription, subscriptionApi.topUpTotalMinor(subscription))} · ${t('subscription.tooltip.topUpCount', { count: entries.length })}`
    });
  }

  const creditsWindow = (provider?.windows || []).find(isCreditsWindow) || null;
  const balance = creditsAmount(provider, creditsWindow);
  if (balance === null) return topUpRollupRows(rows, subscription, today, includeRollup);
  const balanceCurrency = String(creditsWindow?.currency || provider?.balance?.currency || subscription.currency);
  rows.push({ label: t('subscription.tooltip.balance'), value: formatMoney(balance, balanceCurrency) });

  const projection = subscriptionApi.topUpProjection(subscription, balance, today, {
    currencyApi,
    balanceCurrency
  });
  if (!projection || projection.dailyBurn <= 0) return topUpRollupRows(rows, subscription, today, includeRollup);
  rows.push({
    label: t('subscription.tooltip.burnRate'),
    value: t('subscription.tooltip.perDay', { amount: formatMoney(projection.dailyBurn, balanceCurrency) })
  });
  if (projection.exhaustDate) {
    rows.push({
      label: t('subscription.tooltip.exhausts'),
      value: `${subscriptionDateText(projection.exhaustDate)} · ${subscriptionDaysText(projection.daysRemaining)}`
    });
  }
  return topUpRollupRows(rows, subscription, today, includeRollup);
}

// A ledger earns the same provider-level comparison a plan gets: what went in
// this month against what the month's tokens would have cost.
function topUpRollupRows(rows, subscription, today, includeRollup) {
  if (!includeRollup) return rows;
  const usageCostUsd = subscriptionUsageCostUsd(subscription.provider);
  if (usageCostUsd === null) return rows;
  const rollup = subscriptionApi.providerRollup(subscriptionList(), subscription.provider, currencyApi, today);
  const multiple = subscriptionApi.valueMultiple(rollup.monthlyUsd, usageCostUsd);
  if (multiple === null) return rows;
  rows.push({ separator: true });
  rows.push({
    label: t('subscription.tooltip.monthUsage'),
    value: `≈ ${formatCost(usageCostUsd)}`,
    title: t('subscription.tooltip.monthUsageNote')
  });
  rows.push({ label: t('subscription.tooltip.valueMultiple'), value: `${multiple.toFixed(1)}×` });
  return rows;
}

// No heading. The card is already reached by hovering a plan label, and every
// row names itself — a "Subscription" line above them only repeats what the
// gesture said, and the other tooltips in this panel carry no title either.
function subscriptionCardNode(rows) {
  if (rows.length === 0) return null;
  const card = document.createElement('span');
  card.className = 'limit-detail-tooltip subscription-tooltip';
  for (const row of rows) {
    if (row.separator) {
      const rule = document.createElement('span');
      rule.className = 'subscription-tooltip-rule';
      card.append(rule);
      continue;
    }
    // display:contents on the row lets label and value land directly in the
    // card's two-column grid, so the existing tooltip cell styling applies.
    const line = document.createElement('span');
    line.className = 'limit-detail-tooltip-row';
    const label = document.createElement('span');
    label.textContent = row.label;
    const value = document.createElement('span');
    if (row.warn) value.className = 'subscription-tooltip-warn';
    value.textContent = row.value;
    if (row.title) {
      label.title = row.title;
      value.title = row.title;
    }
    line.append(label, value);
    card.append(line);
  }
  return card;
}

// A group header is rendered whenever a provider has more than one account, and
// it is the row that stands for the provider as a whole — which is what decides
// where the provider-wide rollup goes.
//
// Counted from the list renderLimits() groups on, deliberately not from
// limitProvidersForSubscriptions(): that one narrows to this device so a
// subscription binds to an account you actually hold, while the question here is
// only what the panel drew. In sync mode the two lists differ, and answering
// from the wrong one puts the rollup on every member row of a group.
function subscriptionProviderHasGroupHeader(providerId) {
  const id = String(providerId || '').toLowerCase();
  return (state.stats?.limits?.providers || [])
    .filter((account) => String(account?.provider || '').toLowerCase() === id).length > 1;
}

// An account row shows its own subscription and nothing else. A group header
// stands for all of them, so it summarises — except when only one account is
// recorded, where the summary would just restate that one card with less in it.
function subscriptionCardForRow(provider) {
  if (provider?.accountGroup === true) {
    const entries = subscriptionsForProviderGroup(provider.provider);
    if (entries.length === 0) return null;
    if (entries.length === 1) {
      return subscriptionCardNode(
        subscriptionTooltipRows(entries[0].subscription, entries[0].account || provider, true)
      );
    }
    return subscriptionCardNode(
      subscriptionGroupTooltipRows(provider.provider, subscriptionApi.todayString())
    );
  }
  const subscription = subscriptionForProvider(provider);
  if (!subscription) return null;
  return subscriptionCardNode(
    subscriptionTooltipRows(subscription, provider, !subscriptionProviderHasGroupHeader(provider.provider))
  );
}

// The card opens upward, but the limits list scrolls inside a clipping panel, so
// on the topmost row every pixel of it landed outside that panel and vanished.
// Measured on open rather than on render: the row's offset within the panel
// changes as the user scrolls. Kept to a class flip so the card's own placement
// stays declarative.
function positionSubscriptionTooltip(wrap, card) {
  const clip = wrap.closest('.limits-panel');
  if (!clip) return;
  const roomAbove = wrap.getBoundingClientRect().top - clip.getBoundingClientRect().top;
  card.classList.toggle('is-below', roomAbove < card.offsetHeight + 5);
}

// Wraps the plan label so hovering it reveals the subscription card. Reuses the
// limit-detail tooltip plumbing, which already holds off the six-second list
// re-render while the pointer is inside (limitDetailTooltipShouldHoldRender).
//
// Deliberately not behind a preference: an account with no record decorates
// nothing, so having recorded one IS the switch. A separate toggle only made it
// possible to enter the data and see nothing happen.
function decoratePlanWithSubscription(plan, provider) {
  const card = subscriptionCardForRow(provider);
  if (!card) return plan;

  const wrap = document.createElement('div');
  wrap.className = 'limit-plan limit-detail-tooltip-wrap subscription-plan-wrap';
  wrap.classList.toggle('has-opened', state.limitDetailTooltipHasOpened);
  wrap.tabIndex = 0;
  const trigger = document.createElement('span');
  trigger.className = 'subscription-plan-trigger';
  trigger.textContent = plan.textContent;
  wrap.append(trigger, card);

  const markOpened = () => {
    state.limitDetailTooltipHasOpened = true;
    state.limitDetailTooltipActive = true;
    wrap.classList.add('has-opened');
    positionSubscriptionTooltip(wrap, card);
  };
  const release = () => {
    state.limitDetailTooltipActive = false;
    flushPendingLimitDetailTooltipRender();
  };
  wrap.addEventListener('pointerenter', markOpened);
  wrap.addEventListener('focusin', markOpened);
  wrap.addEventListener('pointerleave', release);
  wrap.addEventListener('focusout', release);
  return wrap;
}

// The title's job is to say WHICH record this is, so it names the account. The
// plan name is not an identity — three Codex rows all reading "Codex · Plus"
// name nothing — so it moved to the meta line, where it always shows.
//
// When the live account list cannot resolve the row, the fallback is the record's
// own stored binding rather than the plan name: the binding is what the user
// picked, it survives the provider being signed out or still loading, and it
// keeps sibling rows distinct in exactly the moment the plan name could not.
function subscriptionRowTitle(subscription, account) {
  const providerLabel = subscriptionProviderLabel(subscription.provider);
  return [providerLabel, subscriptionRowAccountLabel(subscription, account) || subscription.planName]
    .filter(Boolean)
    .join(' · ');
}

function subscriptionRowAccountLabel(subscription, account) {
  const identity = account || {
    provider: subscription.provider,
    accountName: subscription.binding?.profileName,
    accountEmail: subscription.binding?.accountEmail
  };
  return accountIdentityApi.accountTitleLabel(identity, [identity], {
    maskEmail: state.settings?.maskLimitAccountEmails === true
  });
}

function subscriptionRowMeta(subscription, account) {
  const today = subscriptionApi.todayString();
  // The plan name only earns a slot here when the title did not already fall back
  // to it. An account with no label of its own would otherwise spend both lines
  // saying "Go" twice, and the second line is the one that runs out of room.
  const parts = subscriptionRowAccountLabel(subscription, account) && subscription.planName
    ? [subscription.planName]
    : [];
  if (subscriptionApi.isTopUp(subscription)) {
    const monthMinor = subscriptionApi.topUpMonthMinor(subscription, today);
    parts.push(t('settings.subscriptions.topUpMonthMeta', {
      total: topUpMinorText(subscription, monthMinor)
    }));
    const last = subscriptionApi.lastTopUp(subscription);
    if (last) {
      parts.push(t('settings.subscriptions.topUpLastMeta', { date: subscriptionShortDateText(last.date) }));
    }
    return parts.join(' · ');
  }
  parts.push(subscriptionPriceText(subscription));
  const endDate = subscriptionApi.coverageEndDate(subscription, today);
  if (endDate) {
    const date = subscriptionShortDateText(endDate);
    parts.push(t(subscription.autoRenew ? 'settings.subscriptions.renewsOn' : 'settings.subscriptions.endsOn', { date }));
  }
  return parts.join(' · ');
}

function syncSubscriptionAddControl() {
  const toggle = els.subscriptionAddToggle;
  const form = els.subscriptionAddForm;
  const details = els.subscriptionAddDetails;
  if (!toggle || !form) return;

  // While editing, this button is a mode switch, not the disclosure control for
  // the editor that is currently parked beneath another row. Keeping the add
  // action's disclosure state separate prevents a plus from turning into an x
  // and avoids two controls claiming the same expanded region.
  if (state.subscriptionEditingId) {
    toggle.removeAttribute('aria-expanded');
    toggle.removeAttribute('aria-controls');
    form.classList.remove('expanded');
    return;
  }

  const open = Boolean(details && !details.classList.contains('hidden'));
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.setAttribute('aria-controls', 'subscriptionAddDetails');
  form.classList.toggle('expanded', open);
}

// Rebuild only the list-owned rows. The editor is a live child of this list
// while editing, and removing it from the DOM would drop focus from whichever
// field the user is typing in before positionSubscriptionEditor() can put it
// back.
function clearSubscriptionListChildren(listEl, preservedNode) {
  for (const child of [...listEl.children]) {
    if (child !== preservedNode) child.remove();
  }
}

function positionSubscriptionEditor() {
  const listEl = els.subscriptionList;
  const form = els.subscriptionAddForm;
  const details = els.subscriptionAddDetails;
  if (!listEl || !form || !details) return;

  const editingId = String(state.subscriptionEditingId || '');
  const editingRow = editingId
    ? [...listEl.children].find((child) => child.dataset?.subscriptionId === editingId)
    : null;
  if (editingRow) editingRow.after(details);
  else form.append(details);

  for (const row of listEl.querySelectorAll('[data-subscription-id]')) {
    row.classList.toggle('is-editing', row.dataset.subscriptionId === editingId);
  }
  syncSubscriptionAddControl();
  syncSubscriptionEditControls();
}

function syncSubscriptionEditControls() {
  const listEl = els.subscriptionList;
  const details = els.subscriptionAddDetails;
  if (!listEl) return;
  const editingId = String(state.subscriptionEditingId || '');
  const editorOpen = Boolean(details && !details.classList.contains('hidden'));
  for (const row of listEl.querySelectorAll('[data-subscription-id]')) {
    const edit = row.querySelector('.subscription-row-edit');
    if (!edit) continue;
    const editOpen = editorOpen && row.dataset.subscriptionId === editingId;
    const editLabel = editOpen ? t('settings.subscriptions.cancelEdit') : t('settings.subscriptions.edit');
    edit.textContent = editOpen ? '×' : '✎';
    edit.title = editLabel;
    edit.setAttribute('aria-label', editLabel);
    edit.setAttribute('aria-expanded', editOpen ? 'true' : 'false');
  }
}

function renderSubscriptionRows() {
  const listEl = els.subscriptionList;
  if (!listEl) return;
  const editor = els.subscriptionAddDetails?.parentElement === listEl
    ? els.subscriptionAddDetails
    : null;
  clearSubscriptionListChildren(listEl, editor);
  const list = subscriptionList();
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'opencode-empty';
    empty.textContent = t('settings.subscriptions.emptyList');
    listEl.append(empty);
    positionSubscriptionEditor();
    return;
  }

  const providers = limitProvidersForSubscriptions();
  for (const subscription of list) {
    const account = subscriptionApi.matchProviderAccount(subscription, providers);
    const row = document.createElement('div');
    row.className = `subscription-row${state.subscriptionEditingId === subscription.id ? ' is-editing' : ''}`;
    row.dataset.subscriptionId = subscription.id;

    // The provider name is in the title too, but these rows are a dense stack of
    // near-identical text — four Codex accounts read as one block until the mark
    // in front of them differs. Gated on the same preference as every other tool
    // icon in the app, so turning icons off turns them off here as well.
    const iconClass = toolIconsEnabled(state.settings?.showToolIcons)
      ? subscriptionProviderIconClass(subscription.provider)
      : '';
    if (iconClass) {
      const icon = document.createElement('span');
      icon.className = `subscription-row-icon ${iconClass}`;
      row.append(icon);
    }

    const main = document.createElement('div');
    main.className = 'subscription-row-main';
    const title = document.createElement('span');
    title.className = 'subscription-row-title';
    title.textContent = subscriptionRowTitle(subscription, account);
    const meta = document.createElement('span');
    meta.className = 'subscription-row-meta';
    meta.textContent = subscriptionRowMeta(subscription, account);
    main.append(title, meta);

    // Only a real ambiguity is surfaced. A provider that is simply not signed in
    // right now keeps its subscription quietly; the data is never dropped.
    if (subscriptionApi.needsRebinding(subscription, providers)) {
      const warn = document.createElement('span');
      warn.className = 'subscription-row-warn';
      warn.textContent = t('settings.subscriptions.needsRebind');
      main.append(warn);
    }

    // Keep the edit control as a disclosure toggle: the active row gets an
    // explicit cancel state, and the accessible state follows the editor.
    const actions = document.createElement('div');
    actions.className = 'subscription-row-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'subscription-row-edit';
    const editing = state.subscriptionEditingId === subscription.id;
    const editOpen = editing && Boolean(els.subscriptionAddDetails && !els.subscriptionAddDetails.classList.contains('hidden'));
    const editLabel = editOpen ? t('settings.subscriptions.cancelEdit') : t('settings.subscriptions.edit');
    edit.textContent = editOpen ? '×' : '✎';
    edit.title = editLabel;
    edit.setAttribute('aria-label', editLabel);
    edit.setAttribute('aria-expanded', editOpen ? 'true' : 'false');
    edit.setAttribute('aria-controls', 'subscriptionAddDetails');
    edit.addEventListener('click', () => {
      if (state.subscriptionEditingId === subscription.id && els.subscriptionAddDetails && !els.subscriptionAddDetails.classList.contains('hidden')) {
        closeSubscriptionEditor();
        return;
      }
      beginSubscriptionEdit(subscription.id);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'subscription-row-delete';
    remove.textContent = '✕';
    remove.title = t('settings.subscriptions.delete');
    let armed = false;
    remove.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        remove.textContent = '✓';
        remove.title = t('settings.subscriptions.deleteConfirm');
        remove.classList.add('is-armed');
        setTimeout(() => {
          armed = false;
          remove.textContent = '✕';
          remove.title = t('settings.subscriptions.delete');
          remove.classList.remove('is-armed');
        }, 4000);
        return;
      }
      // Read now rather than reused from the render this row was drawn in, so the
      // list and the version sent with it come from the same moment.
      const current = subscriptionList();
      if (!await saveSubscriptions(
        current.filter((entry) => entry.id !== subscription.id),
        subscriptionSettingsVersion(),
        { render: false }
      )) return;
      if (state.subscriptionEditingId === subscription.id) resetSubscriptionForm();
      preserveSettingsPanelScroll(renderSubscriptionSettings);
    });
    actions.append(edit, remove);
    row.append(main, actions);
    listEl.append(row);
  }
  positionSubscriptionEditor();
}

function renderSubscriptionPickers() {
  const providerSelect = els.subscriptionProviderInput;
  const accountSelect = els.subscriptionAccountInput;
  if (!providerSelect || !accountSelect) return;

  const choices = subscriptionAccountChoices();
  const providerIds = [...new Set(choices.map((choice) => choice.provider.provider))];
  const previousProvider = providerSelect.value;
  providerSelect.replaceChildren();
  for (const id of providerIds) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = subscriptionProviderLabel(id);
    providerSelect.append(option);
  }
  if (providerIds.includes(previousProvider)) providerSelect.value = previousProvider;

  const activeProvider = providerSelect.value;
  const previousAccount = accountSelect.value;
  accountSelect.replaceChildren();
  for (const choice of choices.filter((entry) => entry.provider.provider === activeProvider)) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    accountSelect.append(option);
  }
  if ([...accountSelect.options].some((option) => option.value === previousAccount)) {
    accountSelect.value = previousAccount;
  }

  const currencySelect = els.subscriptionCurrencyInput;
  if (currencySelect && currencySelect.options.length === 0) {
    for (const code of currencyApi.CURRENCY_CODES) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = code;
      currencySelect.append(option);
    }
    currencySelect.value = currencyApi.normalizeCurrency(state.settings?.currency);
  }
}

function renderSubscriptionTotal() {
  const totalEl = els.subscriptionTotalRow;
  if (!totalEl) return;
  const list = subscriptionList();
  totalEl.classList.toggle('hidden', list.length === 0);
  if (list.length === 0) return;
  totalEl.textContent = t('settings.subscriptions.total', {
    total: formatCost(subscriptionApi.monthlyTotalUsd(list, currencyApi))
  });
}

function renderSubscriptionSettings() {
  renderSubscriptionNote();
  renderSubscriptionOrphanNotice();
  renderSubscriptionSyncError();
  renderSubscriptionRows();
  renderSubscriptionPickers();
  renderSubscriptionTotal();
  renderSettingsSummaries();
}

// The list may live on a hub shared with other devices, so writing it is a
// network round trip that can be refused. Whatever happens, what is on screen
// afterwards is what is actually stored: on failure the optimistic list is
// thrown away and main.js's copy is re-read and re-rendered.
// The version of the shared list on screen and the hub that issued it, which are
// only worth anything together: a hub nobody has written to reports no version,
// and so does the next one, so a version alone cannot say which list it describes.
function subscriptionSettingsVersion() {
  return {
    hub: state.settings?.subscriptionsHub || '',
    updatedAt: state.settings?.subscriptionsUpdatedAt || ''
  };
}

// Every settings snapshot that arrives because THIS device acted — a save, an
// adopt, a discard, or the re-read after one of them was refused. An open form
// re-anchors on the version in it: the user made the change, or has just been
// shown it, so it is not one they need to be stopped over. Which is also the
// rule stated in one place rather than at each write, because the paths that
// move the shared list on have outnumbered the ones that remember to say so.
// A version arriving from another device does not come through here, and that is
// the only reason the form holds one at all.
function applySubscriptionSettings(settings) {
  state.settings = settings;
  if (state.subscriptionFormBase === null) return;
  const current = subscriptionSettingsVersion();
  // Unless the hub itself changed under it. Then the form is holding an edit made
  // for a hub the user has left, and re-anchoring would let that edit be saved
  // into the one they moved to — there is nothing here it could belong to, so it
  // stops being a form rather than becoming a form for the wrong list.
  if (state.subscriptionFormBase.hub !== current.hub) {
    if (typeof closeSubscriptionEditor === 'function') {
      closeSubscriptionEditor();
    } else {
      setSubscriptionFormOpen(false);
      resetSubscriptionForm();
    }
    return;
  }
  state.subscriptionFormBase = current;
}

// base is what the list being saved was built from — the open form's snapshot, or
// what is on screen for a row action. Passed in rather than read here, because
// those two stop being the same the moment a push lands.
async function saveSubscriptions(list, base, { render = true } = {}) {
  try {
    applySubscriptionSettings(await window.tokenMonitor.saveSubscriptions(list, base));
    state.subscriptionSyncError = '';
    if (render) renderSubscriptionSettings();
    return true;
  } catch (error) {
    // Four different problems with four different answers: look at what changed,
    // fix the secret, retry later, or free some disk. One message for all of
    // them would send the user looking in the wrong place.
    state.subscriptionSyncError = subscriptionWriteErrorKey(error);
    // Refused, so the list on screen is now the current one and the form still
    // holds what was typed. Re-anchoring lets the user look at what changed and
    // save again; keeping the version they opened on would refuse the second
    // attempt too, and every one after it.
    try { applySubscriptionSettings(await window.tokenMonitor.getSettings()); } catch (_) {}
    renderSubscriptionSettings();
    return false;
  }
}

function subscriptionWriteErrorKey(error) {
  const message = error?.message || '';
  if (/stale_write/.test(message)) return 'settings.subscriptions.errorStaleWrite';
  if (/hub_rejected/.test(message)) return 'settings.subscriptions.errorHubRejected';
  if (/write_failed/.test(message)) return 'settings.subscriptions.errorWriteFailed';
  if (/hub_changed/.test(message)) return 'settings.subscriptions.errorHubChanged';
  return 'settings.subscriptions.errorHubWrite';
}

// This device joined a hub that already had a list, so its own records are not
// in it. Neither dropping them nor merging them is safe to decide here: the same
// plan recorded on two machines has two ids and would become two charges.
function renderSubscriptionOrphanNotice() {
  const notice = els.subscriptionOrphanNotice;
  if (!notice) return;
  const orphans = state.settings?.subscriptionsOrphaned || [];
  notice.classList.toggle('hidden', orphans.length === 0);
  if (orphans.length === 0) return;
  if (els.subscriptionOrphanText) {
    els.subscriptionOrphanText.textContent = t('settings.subscriptions.orphanNotice', { count: orphans.length });
  }
}

function renderSubscriptionSyncError() {
  const el = els.subscriptionSyncError;
  if (!el) return;
  const key = state.subscriptionSyncError;
  el.textContent = key ? t(key) : '';
  el.classList.toggle('hidden', !key);
}

// The note promises the data never leaves this device, which stops being true
// the moment a hub is configured. Retargeting data-i18n as well as the text
// keeps a later language switch on whichever key currently applies.
function renderSubscriptionNote() {
  const el = els.subscriptionNote;
  if (!el) return;
  const key = state.settings?.subscriptionsShared
    ? 'settings.subscriptions.noteShared'
    : 'settings.subscriptions.note';
  el.dataset.i18n = key;
  el.textContent = t(key);
}

function setSubscriptionError(message) {
  const errorEl = els.subscriptionErrorMessage;
  if (!errorEl) return;
  errorEl.textContent = message || '';
  errorEl.classList.toggle('hidden', !message);
}

function setSubscriptionFormOpen(open, formBase = null) {
  els.subscriptionAddDetails?.classList.toggle('hidden', !open);
  syncSubscriptionAddControl();
  if (typeof syncSubscriptionEditControls === 'function') syncSubscriptionEditControls();
  // What the form was filled from, held for as long as it stays open. A push
  // landing mid-edit replaces state.settings, and reading the version at save
  // time would claim to have seen a change the form was never shown — the save is
  // then accepted, taking another device's edit to the same record with it. Null
  // while closed, so the paths that save without a form say so.
  state.subscriptionFormBase = open
    ? (formBase || subscriptionSettingsVersion())
    : null;
}

const SUBSCRIPTION_EDITOR_TRANSITION_MS = 250;
let subscriptionEditorCloseCleanup = null;
let subscriptionEditorCloseOnCanceled = null;

function cancelSubscriptionEditorClose() {
  const onCanceled = subscriptionEditorCloseOnCanceled;
  subscriptionEditorCloseOnCanceled = null;
  subscriptionEditorCloseCleanup?.();
  subscriptionEditorCloseCleanup = null;
  // A successful write defers the full render until the collapse has settled so
  // the transition can paint. If a new mode cancels that collapse, settle the
  // deferred render here instead of silently dropping it with the old timer.
  onCanceled?.();
}

// The class change has to happen in a later frame than the initial collapsed
// layout. Otherwise Chromium batches both states into one paint and there is no
// transition for the grid track to animate between.
function openSubscriptionEditor() {
  const details = els.subscriptionAddDetails;
  if (!details) return;
  // Capture the concurrency context before the visual transition yields to the
  // browser. A settings push can arrive before the next frame, but it must not
  // make fields loaded from the previous list look like a newer edit.
  const formBase = subscriptionSettingsVersion();
  cancelSubscriptionEditorClose();
  const transitionId = (state.subscriptionEditorTransitionId || 0) + 1;
  state.subscriptionEditorTransitionId = transitionId;
  details.classList.add('hidden');
  details.getBoundingClientRect();
  const schedule = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (callback) => setTimeout(callback, 0);
  schedule(() => {
    if (transitionId !== state.subscriptionEditorTransitionId) return;
    setSubscriptionFormOpen(true, formBase);
  });
}

// Keep the editor in place until its collapse has finished. Moving it back to
// the add form in the same task as hiding it cancels the transition entirely.
function closeSubscriptionEditor({ onClosed, onCanceled } = {}) {
  cancelSubscriptionEditorClose();
  const details = els.subscriptionAddDetails;
  const editingId = String(state.subscriptionEditingId || '');
  const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
  const editingRow = editingId && els.subscriptionList
    ? [...els.subscriptionList.querySelectorAll('[data-subscription-id]')]
      .find((row) => row.dataset?.subscriptionId === editingId)
    : null;
  const editingButton = editingRow?.querySelector('.subscription-row-edit');
  const returnFocusTarget = editingId ? editingButton : els.subscriptionAddToggle;
  // Keep the focus contract of a disclosure: when the editor closes, keyboard
  // users return to the control that opened it. Do not steal focus from a user
  // who moved elsewhere while the close animation ran.
  const shouldRestoreFocus = Boolean(
    activeElement && (
      activeElement === returnFocusTarget
      || activeElement === details
      || details?.contains?.(activeElement)
    )
  );
  const restoreFocus = () => {
    if (!shouldRestoreFocus) return;
    const current = typeof document !== 'undefined' ? document.activeElement : null;
    const body = typeof document !== 'undefined' ? document.body : null;
    const stillInClosingContext = current === activeElement
      || current === body
      || current === returnFocusTarget
      || current === details
      || details?.contains?.(current);
    if (!stillInClosingContext) return;
    if (editingId) {
      const row = [...(els.subscriptionList?.querySelectorAll?.('[data-subscription-id]') || [])]
        .find((candidate) => candidate.dataset?.subscriptionId === editingId);
      row?.querySelector('.subscription-row-edit')?.focus();
      return;
    }
    returnFocusTarget?.focus();
  };
  const transitionId = (state.subscriptionEditorTransitionId || 0) + 1;
  state.subscriptionEditorTransitionId = transitionId;

  if (!details || details.classList.contains('hidden')) {
    setSubscriptionFormOpen(false);
    resetSubscriptionForm();
    if (typeof renderSubscriptionRows === 'function') renderSubscriptionRows();
    onClosed?.();
    restoreFocus();
    return;
  }

  setSubscriptionFormOpen(false);
  subscriptionEditorCloseOnCanceled = onCanceled;
  let finished = false;
  let timer = null;
  const onTransitionEnd = (event) => {
    if (event.target === details && event.propertyName === 'grid-template-rows') finish();
  };
  const cleanup = () => {
    details.removeEventListener('transitionend', onTransitionEnd);
    if (timer !== null) clearTimeout(timer);
    if (subscriptionEditorCloseCleanup === cleanup) {
      subscriptionEditorCloseCleanup = null;
      subscriptionEditorCloseOnCanceled = null;
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    cleanup();
    if (transitionId !== state.subscriptionEditorTransitionId) return;
    resetSubscriptionForm();
    if (typeof renderSubscriptionRows === 'function') renderSubscriptionRows();
    onClosed?.();
    restoreFocus();
  };
  details.addEventListener('transitionend', onTransitionEnd);
  subscriptionEditorCloseCleanup = cleanup;
  timer = setTimeout(finish, SUBSCRIPTION_EDITOR_TRANSITION_MS + 50);
}

// Seeded on explicit picker changes and on opening the form — never from a
// render, which runs again on every settings save and would wipe whatever the
// user is halfway through typing. Editing is not exempt: switching the account
// mid-edit is exactly as deliberate as switching it while adding, and leaving
// the previous account's plan name behind is the surprising outcome.
// beginSubscriptionEdit assigns the selects programmatically, which fires no
// change event, so the saved plan name still survives opening an edit.
function seedSubscriptionPlanName() {
  const input = els.subscriptionPlanNameInput;
  if (!input) return;
  input.value = subscriptionSuggestedPlanName(subscriptionSelectedAccount());
}

// A top-up is not a subscription with different words on it — it is a ledger of
// irregular payments — so the form swaps whole field groups rather than
// relabelling one set. Both groups live in the markup with their own data-i18n,
// which is what keeps them correct across a language change.
function setSubscriptionFormMode() {
  const topUp = subscriptionFormIsTopUp();
  els.subscriptionPlanFields?.classList.toggle('hidden', topUp);
  els.subscriptionTopUpFields?.classList.toggle('hidden', !topUp);
  // One record, one currency — so the select is moved to sit beside whichever
  // money field is on screen rather than taking a labelled row of its own. It is
  // a static element that nothing re-renders, so relocating it is safe.
  const slot = topUp ? els.subscriptionTopUpHeadingRow : els.subscriptionAmountRow;
  if (slot && els.subscriptionCurrencyInput && els.subscriptionCurrencyInput.parentElement !== slot) {
    slot.append(els.subscriptionCurrencyInput);
  }
  renderSubscriptionTopUpEntries();
  setSubscriptionRenewalFieldMode();
}

// Auto-renew off means there is no next charge, so the date field stops asking
// for one and asks when the plan runs out instead — the one thing that cannot be
// derived once a plan has been cancelled after several renewals. Retargeting
// data-i18n as well as the text keeps a later language switch on the right key.
function setSubscriptionRenewalFieldMode() {
  const renewing = els.subscriptionAutoRenewInput?.checked !== false;
  const labelKey = renewing ? 'settings.subscriptions.nextRenewal' : 'settings.subscriptions.coverageEnd';
  const noteKey = renewing ? 'settings.subscriptions.nextRenewalNote' : 'settings.subscriptions.coverageEndNote';
  if (els.subscriptionNextRenewalLabel) {
    els.subscriptionNextRenewalLabel.dataset.i18n = labelKey;
    els.subscriptionNextRenewalLabel.textContent = t(labelKey);
  }
  if (els.subscriptionNextRenewalNote) {
    els.subscriptionNextRenewalNote.dataset.i18n = noteKey;
    els.subscriptionNextRenewalNote.textContent = t(noteKey);
  }
}

function subscriptionFormIsTopUp() {
  return (els.subscriptionKindInputs || []).some((input) => input.checked && input.value === 'topup');
}

function setSubscriptionFormKind(kind) {
  for (const input of els.subscriptionKindInputs || []) input.checked = input.value === kind;
}

// The account's balance marker picks the kind, but only as a starting point —
// the same rule the plan name follows. Both are seeded on an explicit picker
// change, never from a render, so neither can overwrite a deliberate choice
// made after that.
function applySubscriptionAccountSelection() {
  seedSubscriptionPlanName();
  setSubscriptionFormKind(isCreditsProvider(subscriptionSelectedAccount()) ? 'topup' : 'subscription');
  setSubscriptionFormMode();
}

// The ledger being edited, held in form state until the record is saved so that
// adding a row is not itself a settings write.
function subscriptionFormTopUps() {
  return subscriptionApi.normalizeTopUps(state.subscriptionTopUps);
}

function renderSubscriptionTopUpEntries() {
  const listEl = els.subscriptionTopUpList;
  if (!listEl) return;
  listEl.replaceChildren();
  const entries = subscriptionFormTopUps();
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'opencode-empty';
    empty.textContent = t('settings.subscriptions.topUpEmpty');
    listEl.append(empty);
    return;
  }
  const code = currencyApi.normalizeCurrency(els.subscriptionCurrencyInput?.value);
  const symbol = currencyApi.CURRENCY_RATES[code]?.symbol || `${code} `;
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'subscription-topup-row';
    const date = document.createElement('span');
    date.className = 'subscription-topup-date';
    date.textContent = subscriptionDateText(entry.date);
    const amount = document.createElement('span');
    amount.className = 'subscription-topup-amount';
    amount.textContent = `${symbol}${(entry.amountMinor / 100).toFixed(2)}`;
    // Armed the same way as the record rows above: a mis-click here silently
    // rewrites the month total the ledger exists to report, and the entry cannot
    // be recovered from anywhere else.
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'subscription-topup-remove';
    remove.textContent = '✕';
    remove.title = t('settings.subscriptions.topUpRemove');
    let armed = false;
    remove.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        remove.textContent = '✓';
        remove.title = t('settings.subscriptions.topUpRemoveConfirm');
        remove.classList.add('is-armed');
        setTimeout(() => {
          armed = false;
          remove.textContent = '✕';
          remove.title = t('settings.subscriptions.topUpRemove');
          remove.classList.remove('is-armed');
        }, 4000);
        return;
      }
      state.subscriptionTopUps = subscriptionFormTopUps().filter((other) => other.id !== entry.id);
      renderSubscriptionTopUpEntries();
      setSubscriptionError('');
    });
    row.append(date, amount, remove);
    listEl.append(row);
  }
}

function addSubscriptionTopUpEntry() {
  const date = String(els.subscriptionTopUpDateInput?.value || '').trim();
  const amount = Number(els.subscriptionTopUpAmountInput?.value);
  if (!date) {
    setSubscriptionError(t('settings.subscriptions.errorTopUpDate'));
    return;
  }
  if (date > subscriptionApi.todayString()) {
    setSubscriptionError(t('settings.subscriptions.errorFutureDate'));
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    setSubscriptionError(t('settings.subscriptions.errorAmount'));
    return;
  }
  // Normalized on the way in, not on the way out: normalizeTopUps() mints an id
  // for any entry lacking one, so leaving raw entries in state re-minted every
  // id on every render and the delete button never matched the row it was on.
  //
  // Two top-ups on one day is a real thing, so entries are never merged by date.
  state.subscriptionTopUps = subscriptionApi.normalizeTopUps([
    ...subscriptionFormTopUps(),
    { date, amountMinor: Math.round(amount * 100) }
  ]);
  if (els.subscriptionTopUpDateInput) els.subscriptionTopUpDateInput.value = '';
  if (els.subscriptionTopUpAmountInput) els.subscriptionTopUpAmountInput.value = '';
  renderSubscriptionTopUpEntries();
  setSubscriptionError('');
}

// Writing min/max on a date input rebuilds its internal editor, which throws
// away the segment the user is halfway through typing. This runs on the input's
// own change event — which fires the moment the year reaches one digit — so an
// unconditional write restarted the year field mid-entry, and the next keystroke
// produced year 0000 and blanked the whole value. Only write a bound that
// actually changed.
function setSubscriptionDateBound(input, attribute, value) {
  if (!input || input.getAttribute(attribute) === value) return;
  input.setAttribute(attribute, value);
}

// A first charge cannot be in the future, and a next-charge override only means
// anything at or after it. Bounding the native picker is most of what makes it
// usable: its "today" button then lands on a date the form will accept.
function syncSubscriptionDateBounds() {
  const today = subscriptionApi.todayString();
  setSubscriptionDateBound(els.subscriptionStartDateInput, 'max', today);
  setSubscriptionDateBound(
    els.subscriptionNextRenewalInput,
    'min',
    String(els.subscriptionStartDateInput?.value || '') || today
  );
}

function resetSubscriptionForm() {
  state.subscriptionEditingId = '';
  state.subscriptionTopUps = [];
  if (els.subscriptionTopUpDateInput) els.subscriptionTopUpDateInput.value = '';
  if (els.subscriptionTopUpAmountInput) els.subscriptionTopUpAmountInput.value = '';
  if (els.subscriptionPlanNameInput) els.subscriptionPlanNameInput.value = '';
  if (els.subscriptionAmountInput) els.subscriptionAmountInput.value = '';
  if (els.subscriptionIntervalCountInput) els.subscriptionIntervalCountInput.value = '1';
  if (els.subscriptionIntervalInput) els.subscriptionIntervalInput.value = 'month';
  if (els.subscriptionStartDateInput) els.subscriptionStartDateInput.value = '';
  if (els.subscriptionNextRenewalInput) els.subscriptionNextRenewalInput.value = '';
  if (els.subscriptionAutoRenewInput) els.subscriptionAutoRenewInput.checked = true;
  if (els.subscriptionSubmit) els.subscriptionSubmit.textContent = t('settings.subscriptions.save');
  els.subscriptionCancelEdit?.classList.add('hidden');
  setSubscriptionFormMode();
  syncSubscriptionDateBounds();
  positionSubscriptionEditor();
  setSubscriptionError('');
}

function openSubscriptionAddEditor() {
  renderSubscriptionPickers();
  applySubscriptionAccountSelection();
  openSubscriptionEditor();
}

function beginSubscriptionAdd() {
  resetSubscriptionForm();
  renderSubscriptionRows();
  openSubscriptionAddEditor();
}

function beginSubscriptionEdit(id) {
  const subscription = subscriptionList().find((entry) => entry.id === id);
  if (!subscription) return;
  if (state.subscriptionEditingId === id && els.subscriptionAddDetails && !els.subscriptionAddDetails.classList.contains('hidden')) {
    closeSubscriptionEditor();
    return;
  }
  state.subscriptionEditingId = id;

  const account = subscriptionApi.matchProviderAccount(subscription, limitProvidersForSubscriptions());
  if (els.subscriptionProviderInput) els.subscriptionProviderInput.value = subscription.provider;
  renderSubscriptionPickers();
  if (account && els.subscriptionAccountInput) {
    els.subscriptionAccountInput.value = subscriptionAccountValue(account);
  }
  setSubscriptionFormKind(subscription.kind);
  state.subscriptionTopUps = subscription.topUps;
  if (els.subscriptionPlanNameInput) els.subscriptionPlanNameInput.value = subscription.planName;
  if (els.subscriptionAmountInput) els.subscriptionAmountInput.value = String(subscriptionApi.amountUnits(subscription));
  if (els.subscriptionCurrencyInput) els.subscriptionCurrencyInput.value = subscription.currency;
  if (els.subscriptionIntervalCountInput) els.subscriptionIntervalCountInput.value = String(subscription.intervalCount);
  if (els.subscriptionIntervalInput) els.subscriptionIntervalInput.value = subscription.interval;
  if (els.subscriptionStartDateInput) els.subscriptionStartDateInput.value = subscription.startDate;
  // One field, whichever date the record actually carries.
  if (els.subscriptionNextRenewalInput) {
    els.subscriptionNextRenewalInput.value =
      (subscription.autoRenew ? subscription.nextRenewalOverride : subscription.endDate) || '';
  }
  if (els.subscriptionAutoRenewInput) els.subscriptionAutoRenewInput.checked = subscription.autoRenew;
  if (els.subscriptionSubmit) els.subscriptionSubmit.textContent = t('settings.subscriptions.update');
  els.subscriptionCancelEdit?.classList.remove('hidden');
  setSubscriptionFormMode();
  syncSubscriptionDateBounds();
  positionSubscriptionEditor();
  openSubscriptionEditor();
  setSubscriptionError('');
}

async function submitSubscription() {
  const providerId = String(els.subscriptionProviderInput?.value || '').trim();
  const accountValue = String(els.subscriptionAccountInput?.value || '').trim();
  const amount = Number(els.subscriptionAmountInput?.value);
  const startDate = String(els.subscriptionStartDateInput?.value || '').trim();
  const autoRenew = els.subscriptionAutoRenewInput?.checked !== false;
  const renewalDate = String(els.subscriptionNextRenewalInput?.value || '').trim();

  if (!providerId || !accountValue) {
    setSubscriptionError(t('settings.subscriptions.errorAccount'));
    return;
  }
  const topUps = subscriptionFormTopUps();
  const kind = subscriptionFormIsTopUp() ? 'topup' : 'subscription';
  if (kind === 'topup') {
    if (topUps.length === 0) {
      setSubscriptionError(t('settings.subscriptions.errorTopUpEntries'));
      return;
    }
  } else {
    if (!Number.isFinite(amount) || amount <= 0) {
      setSubscriptionError(t('settings.subscriptions.errorAmount'));
      return;
    }
    if (!startDate) {
      setSubscriptionError(t('settings.subscriptions.errorStartDate'));
      return;
    }
    // The input's `max` only styles an out-of-range value as invalid; it never
    // blocks one from being typed. A first charge is an event that has already
    // happened, and a future one makes every figure derived from it meaningless.
    if (startDate > subscriptionApi.todayString()) {
      setSubscriptionError(t('settings.subscriptions.errorFutureDate'));
      return;
    }
    // Whichever meaning the field currently carries, a date at or before the
    // first charge describes coverage that ends before it begins.
    if (renewalDate && renewalDate <= startDate) {
      setSubscriptionError(t('settings.subscriptions.errorRenewalDate'));
      return;
    }
  }

  const account = subscriptionAccountChoices().find((choice) => choice.value === accountValue)?.provider;
  const list = subscriptionList();
  const editing = state.subscriptionEditingId
    ? list.find((entry) => entry.id === state.subscriptionEditingId)
    : null;

  if (subscriptionForAccountValue(list, providerId, accountValue, editing?.id)) {
    setSubscriptionError(t('settings.subscriptions.errorDuplicate'));
    return;
  }

  const next = subscriptionApi.normalizeSubscription({
    ...(editing || {}),
    id: editing?.id,
    provider: providerId,
    kind,
    binding: account ? subscriptionApi.bindingFromAccount(account) : editing?.binding,
    planName: String(els.subscriptionPlanNameInput?.value || '').trim(),
    amountMinor: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0,
    currency: String(els.subscriptionCurrencyInput?.value || 'USD'),
    interval: String(els.subscriptionIntervalInput?.value || 'month'),
    intervalCount: Number(els.subscriptionIntervalCountInput?.value) || 1,
    // Each kind keeps only its own anchor, so switching kind on an existing
    // record cannot leave the other one's stale dates behind it.
    startDate: kind === 'topup' ? null : startDate,
    topUps: kind === 'topup' ? topUps : [],
    autoRenew,
    // The one date field feeds whichever of the two dates it currently means,
    // and always clears the other — a stale override left behind by a toggle
    // would silently keep scheduling charges on a cancelled plan.
    nextRenewalOverride: kind === 'topup' || !autoRenew ? null : renewalDate || null,
    endDate: kind === 'topup' || autoRenew ? null : renewalDate || null,
    updatedAt: new Date().toISOString()
  }, { currencyApi });
  if (!next) {
    setSubscriptionError(t(kind === 'topup' ? 'settings.subscriptions.errorTopUpEntries' : 'settings.subscriptions.errorStartDate'));
    return;
  }

  const updated = editing
    ? list.map((entry) => (entry.id === editing.id ? next : entry))
    : [...list, next];
  if (!await saveSubscriptions(updated, state.subscriptionFormBase, { render: false })) return;
  closeSubscriptionEditor({
    onClosed: renderSubscriptionSettings,
    onCanceled: renderSubscriptionSettings
  });
}

function configuredLimitProviderOrder() {
  const enabled = enabledLimitProviderSet();
  return limitProviderOrderApi
    .normalizeLimitProviderOrder(state.settings?.limitProviderOrder, LIMIT_PROVIDERS)
    .filter((id) => enabled.has(id));
}

function configuredLimitProviderSelection() {
  const raw = state.settings?.limitProviders;
  const source = raw === undefined || raw === null ? DEFAULT_LIMIT_PROVIDER_ORDER : raw;
  return limitProviderOrderApi.normalizeLimitProviderSelection(source, LIMIT_PROVIDERS);
}

function enabledLimitProviderSet() {
  if (state.settings?.limitsEnabled === false) return new Set();
  return new Set(configuredLimitProviderSelection());
}

function limitProviderEnabled(providerName) {
  return enabledLimitProviderSet().has(providerName);
}

function limitProviderSelectionIncluding(providerName) {
  const selected = new Set(configuredLimitProviderSelection());
  selected.add(providerName);
  return LIMIT_PROVIDERS
    .map((provider) => provider.id)
    .filter((id) => selected.has(id))
    .join(',');
}

function missingLimitProviderStatus() {
  return state.mode === 'sync' || String(state.settings?.hubUrl || '').trim() ? 'noSyncedData' : 'notConfigured';
}

function windowForKind(provider, kind) {
  return (provider?.windows || []).find((window) => window.kind === kind) || null;
}

function windowsForKind(provider, kind) {
  return (provider?.windows || []).filter((window) => window.kind === kind);
}

function antigravityQuotaGroups(provider) {
  const entries = (provider?.windows || [])
    .filter((window) => window.kind === 'session' || window.kind === 'weekly')
    .map((window) => {
      const presentation = limitProviderPresentationApi.antigravityQuotaWindow(window);
      return presentation ? { ...presentation, window } : null;
    });
  // Legacy GetUserStatus pools have model names rather than group + period
  // labels. Keep their existing flat layout instead of guessing a hierarchy.
  if (entries.length === 0 || entries.some((entry) => entry === null)) return [];
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.groupLabel)) groups.set(entry.groupLabel, []);
    groups.get(entry.groupLabel).push(entry);
  }
  return [...groups].map(([label, windows]) => ({ label, windows }));
}

function formatLimitAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return `$${number.toFixed(2)}`;
}

// Absolute count for windows that expose units (credits). It follows the same
// display mode as percent bars: remaining/total in quota mode, used/total in
// used mode.
function formatLimitCount(window, showUsed = false) {
  const used = Number(window?.used);
  const limit = Number(window?.limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return '';
  const trim = (n) => Number(Math.max(0, n).toFixed(2)).toString();
  return `${trim(showUsed ? used : limit - used)}/${trim(limit)}`;
}

// Command Code credits are USD, so the count under the bar is money rather than
// the raw units formatLimitCount prints: "$8.78 / $10.00", or nothing at all for
// a pool with no allowance (the headline already carries its amount).
function formatCommandcodeCreditsDetail(window) {
  const remaining = Number(window?.remaining);
  const limit = Number(window?.limit);
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return '';
  const showUsed = Boolean(state.settings?.showLimitUsed);
  const value = showUsed ? Math.max(0, limit - remaining) : remaining;
  return `${formatMoney(value, window?.currency)} / ${formatMoney(limit, window?.currency)}`;
}

// One-line Overage value: "12.5 credits · $3.20" (credits used, then est. cost).
// Either piece may be absent; the row only renders when at least one is present.
function formatKiroOverageValue(window) {
  const parts = [];
  const credits = Number(window?.used);
  if (Number.isFinite(credits)) parts.push(`${Number(credits.toFixed(2))} credits`);
  const cost = Number(window?.remaining);
  if (Number.isFinite(cost)) parts.push(formatLimitAmount(cost));
  return parts.join(' · ');
}

function formatCodexResetCreditsValue(resetCredits) {
  const available = Number(resetCredits?.availableCount);
  if (!Number.isFinite(available)) return '';
  const count = Math.max(0, Math.floor(available));
  if (count <= 0) return '';
  return `${count} reset${count === 1 ? '' : 's'}`;
}

function codexResetCreditExpirationDates(resetCredits) {
  const values = Array.isArray(resetCredits?.expirations) ? resetCredits.expirations : [];
  const dates = values
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length > 0) return dates;
  const fallback = resetCredits?.nextExpiresAt ? new Date(resetCredits.nextExpiresAt) : null;
  return fallback && !Number.isNaN(fallback.getTime()) ? [fallback] : [];
}

function codexResetCreditExpiryLabel(date) {
  const diffMs = date.getTime() - Date.now();
  return diffMs <= 0 ? 'now' : formatDuration(diffMs);
}

function codexResetCreditExpiryDetailLabel(date) {
  const diffMs = date.getTime() - Date.now();
  return diffMs <= 0 ? 'Expires now' : `Expires in ${formatDuration(diffMs)}`;
}

// Shared by Codex reset credits and Claude prepaid grants.
function expiryDateLabel(date) {
  return new Intl.DateTimeFormat(currentLocale(), {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function limitDetailTooltipShouldHoldRender() {
  if (!state.limitDetailTooltipActive || !els.limitsPanel) return false;
  return Boolean(els.limitsPanel.querySelector('.limit-detail-tooltip-wrap:hover, .limit-detail-tooltip-wrap:focus-within'));
}

function flushPendingLimitDetailTooltipRender() {
  if (!state.limitDetailTooltipRenderPending || state.breakdown !== 'limits') return;
  state.limitDetailTooltipRenderPending = false;
  renderLimits();
}

function codexSwitchPopoverShouldHoldRender() {
  if (!state.codexSwitchPopoverActive || !els.limitsPanel) return false;
  return Boolean(els.limitsPanel.querySelector(
    '.limit-account-switch-zone:hover, .limit-account-switch-zone:focus-within, .limit-account-active-zone:hover, .limit-account-active-zone:focus-within'
  ));
}

function flushPendingCodexSwitchPopoverRender() {
  if (!state.codexSwitchPopoverRenderPending || state.breakdown !== 'limits') return;
  state.codexSwitchPopoverRenderPending = false;
  renderLimits();
}

function codexResetCreditsNode(resetCredits) {
  const valueText = formatCodexResetCreditsValue(resetCredits);
  if (!valueText) return null;
  const expirationDates = codexResetCreditExpirationDates(resetCredits);
  const item = document.createElement('div');
  item.className = 'limit-window limit-window-wide limit-window-note limit-reset-credits';
  const line = document.createElement('div');
  line.className = 'limit-reset-credits-line';
  const value = document.createElement('span');
  value.className = 'limit-reset-credits-value';
  value.textContent = valueText;
  line.append(value);
  if (expirationDates.length > 0) {
    const expiryGroup = document.createElement('span');
    expiryGroup.className = 'limit-reset-credits-expiry-group';
    const timeline = document.createElement('span');
    timeline.className = 'limit-reset-credits-timeline';
    const summaryParts = expirationDates.slice(0, 3).map(codexResetCreditExpiryLabel);
    const hiddenExpirationCount = expirationDates.length - summaryParts.length;
    if (hiddenExpirationCount > 0) summaryParts.push(`+${hiddenExpirationCount}`);
    summaryParts.forEach((text, index) => {
      const time = document.createElement('span');
      time.className = 'limit-reset-credits-time';
      if (index > 0) {
        const separator = document.createElement('span');
        separator.className = 'limit-reset-credits-separator';
        separator.textContent = '·';
        separator.setAttribute('aria-hidden', 'true');
        time.append(separator);
      }
      time.append(document.createTextNode(text));
      timeline.append(time);
    });
    expiryGroup.append(timeline);
    if (expirationDates.length > 0) {
      // A date paired with a bare duration doesn't read as `<name>: <value>`, so
      // the spoken label is supplied rather than derived from the cells. Keep
      // this detail available for a single reset as well as multiple resets.
      const infoNode = limitDetailInfoNode(
        expirationDates.map((date) => [expiryDateLabel(date), codexResetCreditExpiryLabel(date)]),
        '',
        expirationDates.map((date, index) => `Reset ${index + 1}: ${codexResetCreditExpiryDetailLabel(date)}`).join(', ')
      );
      if (infoNode) expiryGroup.append(infoNode);
    }
    line.append(expiryGroup);
  }
  item.append(line);
  item.setAttribute('aria-label', ['Reset credits', valueText, expirationDates.map(codexResetCreditExpiryDetailLabel).join(', ')].filter(Boolean).join(', '));
  return item;
}

function providerSpendEntries(balance) {
  return [
    ['Today', optionalFiniteNumber(balance?.todaySpend)],
    ['Week', optionalFiniteNumber(balance?.weekSpend)],
    ['Month', optionalFiniteNumber(balance?.monthSpend)],
    ['All time', optionalFiniteNumber(balance?.allTimeSpend)]
  ].filter(([, value]) => value !== null);
}

// The meter-less note row every balance/spend provider draws: a label on the
// left, then an optional summary and an optional ⓘ tooltip on the right. The
// wording stays with the callers — each provider says something different about
// the same layout — so the spoken label is `label` plus whatever parts they pass.
function limitNoteRowNode({ label, summary = '', detailEntries = null, ariaParts = [] }) {
  const item = document.createElement('div');
  item.className = 'limit-window limit-window-wide limit-window-note limit-spend';
  const line = document.createElement('div');
  line.className = 'limit-window-text limit-spend-line';
  const labelNode = document.createElement('span');
  labelNode.textContent = label;
  const right = document.createElement('span');
  right.className = 'limit-spend-right';
  if (summary) {
    const summaryNode = document.createElement('span');
    summaryNode.className = 'limit-spend-summary';
    summaryNode.textContent = summary;
    right.append(summaryNode);
  }
  const infoNode = detailEntries ? limitDetailInfoNode(detailEntries, 'limit-spend-info-wrap') : null;
  if (infoNode) right.append(infoNode);
  line.append(labelNode, right);
  item.append(line);
  item.setAttribute('aria-label', [label, ...ariaParts].join(', '));
  return item;
}

// Entries are rows of cells: `[label, value]`, or `[label, middle, value]` when
// a row carries an extra field. Rows are grid cells (`display: contents`), so a
// short row would slide into the next row's columns — pad every row to the
// widest one and widen the grid to match. `ariaLabel` overrides the spoken label
// for callers whose cells don't read as `<name>: <value>` on their own.
function limitDetailInfoNode(entries, extraClass = '', ariaLabel = '') {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const columns = entries.reduce((widest, entry) => Math.max(widest, entry.length), 0);
  const infoWrap = document.createElement('span');
  infoWrap.className = ['limit-detail-tooltip-wrap', extraClass].filter(Boolean).join(' ');
  infoWrap.classList.toggle('has-opened', state.limitDetailTooltipHasOpened);
  const info = document.createElement('span');
  info.className = 'limit-detail-tooltip-trigger';
  info.textContent = 'i';
  info.tabIndex = 0;
  info.setAttribute(
    'aria-label',
    ariaLabel || entries.map(([entryLabel, ...rest]) => `${entryLabel}: ${rest.filter(Boolean).join(' ')}`).join(', ')
  );
  const tooltip = document.createElement('span');
  tooltip.className = ['limit-detail-tooltip', columns > 2 ? 'limit-detail-tooltip-triple' : '']
    .filter(Boolean).join(' ');
  tooltip.setAttribute('role', 'tooltip');
  entries.forEach((entry) => {
    const row = document.createElement('span');
    row.className = 'limit-detail-tooltip-row';
    for (let column = 0; column < columns; column += 1) {
      const cell = document.createElement('span');
      cell.textContent = entry[column] ?? '';
      row.append(cell);
    }
    tooltip.append(row);
  });
  const markOpened = () => {
    state.limitDetailTooltipHasOpened = true;
    state.limitDetailTooltipActive = true;
    infoWrap.classList.add('has-opened');
  };
  const release = () => {
    requestAnimationFrame(() => {
      if (limitDetailTooltipShouldHoldRender()) return;
      state.limitDetailTooltipActive = false;
      flushPendingLimitDetailTooltipRender();
    });
  };
  infoWrap.addEventListener('pointerenter', markOpened);
  infoWrap.addEventListener('focusin', markOpened);
  infoWrap.addEventListener('pointerleave', release);
  infoWrap.addEventListener('focusout', release);
  infoWrap.append(info, tooltip);
  return infoWrap;
}

function providerSpendNode(balance) {
  const entries = providerSpendEntries(balance);
  if (entries.length === 0) return null;
  const currency = balance?.currency || 'USD';
  const preferredSummary = entries.filter(([label]) => label === 'Today' || label === 'Month');
  const summaryEntries = preferredSummary.length > 0 ? preferredSummary : entries.slice(0, 2);
  const formatted = entries.map(([entryLabel, value]) => [entryLabel, formatMoney(value, currency)]);
  return limitNoteRowNode({
    label: 'Spend',
    summary: summaryEntries
      .map(([label, value]) => `${label} ${formatMoney(value, currency)}`)
      .join(' · '),
    // Only worth a tooltip when it would say more than the summary already does.
    detailEntries: entries.length > summaryEntries.length ? formatted : null,
    ariaParts: formatted.map(([entryLabel, value]) => `${entryLabel} ${value}`)
  });
}

function thirdPartySpendNode(provider, quotaWindow) {
  const balance = provider?.balance || null;
  const currency = balance?.currency || 'USD';
  const allTimeSpend = optionalFiniteNumber(balance?.allTimeSpend);
  const entries = [];
  const total = optionalFiniteNumber(quotaWindow?.limit);
  const requestCount = optionalFiniteNumber(balance?.requestCount);
  const quotaGroup = String(balance?.quotaGroup || '').trim();
  const expiresAt = balance?.expiresAt ? new Date(balance.expiresAt) : null;
  if (total !== null) entries.push([t('settings.thirdparty.totalQuota'), formatMoney(total, currency)]);
  if (requestCount !== null) {
    entries.push([t('settings.thirdparty.requests'), Math.max(0, Math.trunc(requestCount)).toLocaleString()]);
  }
  if (quotaGroup) entries.push([t('settings.thirdparty.group'), quotaGroup]);
  if (expiresAt && !Number.isNaN(expiresAt.getTime())) {
    entries.push([t('settings.thirdparty.expires'), expiresAt.toLocaleDateString()]);
  }
  if (allTimeSpend === null && entries.length === 0) return null;
  // Without a spend figure the row has nothing to summarize, so it retitles
  // itself and leans entirely on the tooltip.
  const summary = allTimeSpend === null ? '' : `All time ${formatMoney(allTimeSpend, currency)}`;
  return limitNoteRowNode({
    label: allTimeSpend === null ? 'Details' : 'Spend',
    summary,
    detailEntries: entries,
    ariaParts: [
      ...(summary ? [summary] : []),
      ...entries.map(([entryLabel, value]) => `${entryLabel} ${value}`)
    ]
  });
}

// One tooltip row per prepaid grant: amount, expiry date, time left, the same
// shape Codex's reset credits use. `aria` spells the expiry out, since the
// terse columns no longer say what the date and duration mean.
function claudePrepaidGrantRows(tranches, currency) {
  return tranches
    .filter((tranche) => optionalFiniteNumber(tranche?.amount) !== null)
    .map((tranche) => {
      const money = formatMoney(tranche.amount, tranche.currency || currency);
      const expiresAt = tranche.expiresAt ? new Date(tranche.expiresAt) : null;
      if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        return { cells: [money, '', 'No expiry'], aria: `${money} no expiry` };
      }
      const diffMs = expiresAt.getTime() - Date.now();
      const remaining = diffMs <= 0 ? 'Expired' : formatDuration(diffMs);
      return {
        cells: [money, expiryDateLabel(expiresAt), remaining],
        aria: diffMs <= 0 ? `${money} expired` : `${money} expires in ${remaining}`
      };
    });
}

// Claude's prepaid credits. Deliberately meter-less: the headline is a sum of
// grants whose expiries belong to its parts, so a bar would need a denominator
// this pool doesn't report. Expiries live in the tooltip instead.
function claudeBalanceNode(provider) {
  // Also checked here, not just in the collector: a record collected before the
  // setting was switched off is still in state, and the row should disappear on
  // the toggle rather than on the next refresh.
  if (state.settings?.claudePrepaidBalanceEnabled === false) return null;
  const balance = provider?.balance || null;
  const amount = optionalFiniteNumber(balance?.amount);
  if (amount === null) return null;
  const currency = balance?.currency || 'USD';
  const tranches = Array.isArray(balance.tranches) ? balance.tranches : [];
  const grants = claudePrepaidGrantRows(tranches, currency);
  return limitNoteRowNode({
    label: 'Balance',
    summary: formatMoney(amount, currency),
    detailEntries: grants.map((grant) => grant.cells),
    ariaParts: [formatMoney(amount, currency), ...grants.map((grant) => grant.aria)]
  });
}

const {
  creditsAmount,
  creditsMeterPercent,
  formatCompactMoney,
  formatMoney,
  isCreditsWindow,
  spendWindow
} = window.TokenMonitorLimitBalanceDisplay;

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function openrouterCreditsWindow(provider) {
  const windows = Array.isArray(provider?.windows) ? provider.windows : [];
  // Older hubs normalized windows before `metric` existed. Keep the label
  // fallback only for those mixed-version payloads.
  return windows.find((window) => window?.metric === 'credits')
    || windows.find((window) => !window?.metric && window?.label === 'Credits')
    || null;
}

function thirdPartyQuotaWindow(provider) {
  const windows = Array.isArray(provider?.windows) ? provider.windows : [];
  return windows.find((window) => window?.metric === 'credits') || null;
}

function formatLimitWindowValue(window, fillPercent, hasPercent, showUsed) {
  if (hasPercent) return `${formatPercent(fillPercent)} ${limitModeSuffix(showUsed)}`;
  if (!window) return '--';
  const remaining = Number(window?.remaining);
  if (Number.isFinite(remaining)) {
    return window?.showMeter === false ? formatLimitAmount(remaining) : `${formatLimitAmount(remaining)} left`;
  }
  const limit = Number(window?.limit);
  if (Number.isFinite(limit)) return `${formatLimitAmount(limit)} cap`;
  return '';
}

function formatHomeLimitWindowValue(window, showUsed) {
  if (window?.planStatus === 'expired') return t('limits.mimo.planExpired');
  // A credits window's headline value is money. Its percentage denominator is
  // lifetime spend, which reads as a quota but isn't one.
  if (window?.metric === 'credits') {
    if (window.remaining == null) {
      return String(window.detail || '').toLowerCase() === 'unlimited'
        ? t('settings.thirdparty.unlimited')
        : (window.detail || '--');
    }
    return formatCompactMoney(window.remaining, window.currency);
  }
  const percent = limitFillPercent(window?.remainingPercent, window?.usedPercent, showUsed);
  return `${formatPercent(percent)} ${limitModeSuffix(showUsed)}`;
}

function mimoTokenPlanWindowFromBalance(balance) {
  if (!balance) return null;
  if (balance.planStatus === 'expired') return null;
  const used = optionalFiniteNumber(balance.planUsed);
  const limit = optionalFiniteNumber(balance.planLimit);
  const percent = optionalFiniteNumber(balance.planPercent);
  const hasUsed = used !== null;
  const hasLimit = limit !== null;
  const hasPercent = percent !== null;
  if (!hasUsed && !hasLimit && !hasPercent) return null;
  const resolvedPercent = hasPercent
    ? Math.max(0, Math.min(100, percent))
    : (hasUsed && hasLimit && limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : null);
  return {
    kind: 'billing',
    label: 'Token Plan',
    used: hasUsed ? used : null,
    limit: hasLimit ? limit : null,
    remaining: hasUsed && hasLimit ? Math.max(0, limit - used) : null,
    usedPercent: resolvedPercent,
    remainingPercent: resolvedPercent == null ? null : Math.max(0, Math.min(100, 100 - resolvedPercent)),
    showMeter: true
  };
}

function limitMeterNode(color, percent, tone = 1) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const meter = document.createElement('div');
  meter.className = 'limit-meter';
  meter.style.background = colorWithAlpha(color, 0.16);
  const fill = document.createElement('div');
  fill.className = 'limit-meter-fill';
  applyBarScale(fill, safePercent / 100);
  fill.style.background = color;
  fill.style.opacity = tone;
  meter.append(fill);
  return meter;
}

function limitWindowNode(label, window, color, tone = 1, valueOverride = null, detailText = '') {
  const remaining = Number(window?.remainingPercent);
  const used = Number(window?.usedPercent);
  const showMeter = window?.showMeter !== false;
  const hasPercent = showMeter && (Number.isFinite(remaining) || Number.isFinite(used));
  // valueOverride windows carry a fixed (money/amount) label — keep their meter
  // on "remaining" so bar and label stay consistent; only percent-labelled
  // windows honour the used-mode flip.
  const showUsed = Boolean(state.settings?.showLimitUsed) && valueOverride == null;
  const fillPercent = limitFillPercent(remaining, used, showUsed);
  const item = document.createElement('div');
  item.className = 'limit-window';
  const text = document.createElement('div');
  text.className = 'limit-window-text';
  const name = document.createElement('span');
  name.textContent = window?.label || label;
  const value = document.createElement('span');
  value.textContent = valueOverride != null ? valueOverride : formatLimitWindowValue(window, fillPercent, hasPercent, showUsed);
  text.append(name, value);
  const meter = limitMeterNode(color, fillPercent, tone);
  const reset = document.createElement('div');
  reset.className = 'limit-reset';
  const resetText = window?.resetsAt
    ? formatReset(window.resetsAt)
    : window?.resetDescription || '';
  if (detailText) {
    // Keep the reset text left-aligned (consistent with every other provider)
    // and add the absolute count on the right, under the top-line percentage.
    reset.classList.add('limit-reset-split');
    const resetSpan = document.createElement('span');
    resetSpan.textContent = resetText;
    const detailSpan = document.createElement('span');
    detailSpan.className = 'limit-detail';
    detailSpan.textContent = detailText;
    reset.append(resetSpan, detailSpan);
  } else {
    reset.textContent = resetText;
  }
  if (showMeter) {
    item.append(text, meter, reset);
  } else {
    item.classList.add('limit-window-note');
    item.append(text, reset);
  }
  return item;
}

function providersByLimitProviderId(providers) {
  const byId = new Map();
  for (const provider of providers || []) {
    const id = String(provider?.provider || '').trim().toLowerCase();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(provider);
  }
  return byId;
}

function renderLimitProviderMark(id, color) {
  const mark = document.createElement('span');
  if (clientsWithIcon.has(id)) {
    mark.className = `limit-icon limit-icon-${id}`;
  } else {
    mark.className = 'dot';
    mark.style.background = color;
  }
  return mark;
}

function codexSwitchAccountForProvider(provider) {
  if (!provider || provider.provider !== 'codex') return null;
  if (!provider.accountKey && !provider.accountEmail) return null;
  return (state.settings?.codexManagedAccounts || []).find((account) => {
    if (account.enabled === false) return false;
    return accountIdentityApi.codexAccountMatchesProvider(account, provider);
  }) || null;
}

function codexProviderMatchesProvider(left, right) {
  if (!left || !right || left.provider !== 'codex' || right.provider !== 'codex') return false;
  const leftKey = String(left.accountKey || '').trim();
  const rightKey = String(right.accountKey || '').trim();
  if (leftKey && rightKey && leftKey === rightKey) return true;
  const leftEmail = String(left.accountEmail || '').trim().toLowerCase();
  const rightEmail = String(right.accountEmail || '').trim().toLowerCase();
  return Boolean(leftEmail && rightEmail && leftEmail === rightEmail);
}

function codexActiveAccountMatchesProvider(provider) {
  return accountIdentityApi.codexAccountMatchesProvider(state.codexActiveAccount, provider);
}

function codexAccountsShareIdentity(left, right) {
  if (!left || !right) return false;
  const leftKey = String(left.accountKey || '').trim();
  const rightKey = String(right.accountKey || '').trim();
  if (leftKey && rightKey) return leftKey === rightKey;
  const leftEmail = String(left.email || left.accountEmail || '').trim().toLowerCase();
  const rightEmail = String(right.email || right.accountEmail || '').trim().toLowerCase();
  return Boolean(leftEmail && rightEmail && leftEmail === rightEmail);
}

// The account THIS device's Codex app/CLI is signed into is a purely local fact:
// the local device's own record for it carries a live (non-managed) sourceDetail.
// Read it from the local device's RAW limits, not the cross-device aggregate:
// aggregateLimits() keeps one record per account by freshness, so after sync the
// selected codex row can belong to a remote device signed into a *different*
// account. Reading the aggregate would move the active marker onto that remote
// login, or drop it entirely when every selected row is 'managed'. Legacy stats
// without per-device rows fall back to the aggregate (localDeviceLimitsProviders
// returns null there), mirroring localProviderStatus().
function localLiveCodexProvider() {
  return accountIdentityApi.localLiveCodexProvider(state.stats, state.settings?.deviceId || '');
}

function codexActiveAccountFromStats() {
  const provider = localLiveCodexProvider();
  if (!provider) return null;
  return {
    id: codexSwitchAccountForProvider(provider)?.id || '',
    email: provider.accountEmail || '',
    accountKey: provider.accountKey || '',
    accountLabel: provider.accountLabel || ''
  };
}

function clearCodexPendingActiveAccount() {
  if (state.codexPendingActiveAccountTimer) {
    clearTimeout(state.codexPendingActiveAccountTimer);
    state.codexPendingActiveAccountTimer = null;
  }
  state.codexPendingActiveAccount = null;
  state.codexPendingActiveAccountUntil = 0;
}

function scheduleCodexPendingActiveAccountExpiry() {
  if (state.codexPendingActiveAccountTimer) clearTimeout(state.codexPendingActiveAccountTimer);
  const delay = Math.max(0, state.codexPendingActiveAccountUntil - Date.now());
  state.codexPendingActiveAccountTimer = setTimeout(() => {
    state.codexPendingActiveAccountTimer = null;
    applyCodexActiveAccountFromStats();
    renderLimits();
    renderCodexAccounts();
    renderSettingsSummaries();
  }, delay);
}

function setCodexPendingActiveAccount(account) {
  if (!account) {
    clearCodexPendingActiveAccount();
    return;
  }
  state.codexPendingActiveAccount = account;
  state.codexPendingActiveAccountUntil = Date.now() + CODEX_PENDING_ACTIVE_GRACE_MS;
  scheduleCodexPendingActiveAccountExpiry();
}

function applyCodexActiveAccountFromStats() {
  const activeAccount = codexActiveAccountFromStats();
  if (state.codexPendingActiveAccount) {
    const pendingAccount = state.codexPendingActiveAccount;
    if (activeAccount && codexAccountsShareIdentity(pendingAccount, activeAccount)) {
      clearCodexPendingActiveAccount();
      state.codexActiveAccount = activeAccount;
      return;
    }
    if (Date.now() < state.codexPendingActiveAccountUntil) {
      state.codexActiveAccount = pendingAccount;
      return;
    }
    clearCodexPendingActiveAccount();
  }
  state.codexActiveAccount = activeAccount;
}

function applyCodexAccountLimitsRefresh(providers) {
  const refreshed = (providers || []).filter((provider) => provider?.provider === 'codex');
  if (!refreshed.length || !state.stats?.limits) return;
  const used = new Set();
  const existingProviders = state.stats.limits.providers || [];
  const nextProviders = existingProviders.map((provider) => {
    if (provider?.provider !== 'codex') return provider;
    const index = refreshed.findIndex((candidate, candidateIndex) => (
      !used.has(candidateIndex) && codexProviderMatchesProvider(candidate, provider)
    ));
    if (index === -1) return provider;
    used.add(index);
    return refreshed[index];
  });
  refreshed.forEach((provider, index) => {
    if (!used.has(index)) nextProviders.push(provider);
  });
  state.stats = {
    ...state.stats,
    limits: {
      ...state.stats.limits,
      providers: nextProviders
    }
  };
  applyCodexActiveAccountFromStats();
  renderLimits();
  maybeUpdateBarsIcon();
}

function renderLimitProviderHead(id, label, provider, color, options = {}) {
  const head = document.createElement('div');
  head.className = 'limit-head';
  const titleBlock = document.createElement('div');
  titleBlock.className = 'limit-title';
  const name = document.createElement('div');
  name.className = 'limit-name';
  if (options.showIcon !== false) name.append(renderLimitProviderMark(id, color));
  const title = document.createElement('span');
  title.className = 'limit-name-title';
  title.textContent = options.title || label;
  const provenance = limitProviderProvenance(provider);
  // The ✓ marks the account THIS device's Codex is signed into
  // (state.codexActiveAccount, derived locally by codexActiveAccountFromStats).
  // It only disambiguates rows in the multi-account group, so it's gated on
  // showActiveBadge. Never re-derive "live" from the row being rendered — in
  // sync mode that row can be a remote device's record for a different account,
  // which would move the ✓ onto the wrong one.
  const activeCodexAccount = options.showActiveBadge && codexActiveAccountMatchesProvider(provider);
  const switchAccount = options.allowSystemSwitch && !activeCodexAccount ? codexSwitchAccountForProvider(provider) : null;
  if (switchAccount && window.tokenMonitor?.codex?.switchSystemAccount) {
    const switchZone = document.createElement('span');
    const switchPopover = document.createElement('span');
    const switchButton = document.createElement('button');
    const switching = state.codexSystemSwitchingAccountId === switchAccount.id;
    const failed = state.codexSystemSwitchErrorAccountId === switchAccount.id && state.codexSystemSwitchError;
    switchZone.className = 'limit-account-switch-zone';
    switchZone.classList.toggle('has-opened', state.codexSwitchPopoverHasOpened);
    switchZone.classList.toggle('is-switching', Boolean(switching));
    switchZone.classList.toggle('is-error', Boolean(failed));
    switchPopover.className = 'limit-account-switch-popover';
    switchButton.type = 'button';
    switchButton.className = 'limit-account-switch-button';
    switchButton.disabled = Boolean(state.codexSystemSwitchingAccountId);
    switchButton.title = failed || t('limits.codex.switchAccountTitle', {
      account: switchAccount.email || t('settings.codex.unnamedAccount')
    });
    switchButton.setAttribute('aria-label', switchButton.title);
    switchButton.textContent = switching
      ? t('limits.codex.switching')
      : failed
        ? t('limits.codex.switchFailedShort')
        : t('limits.codex.switchAccount');
    const markCodexSwitchPopoverOpened = () => {
      state.codexSwitchPopoverHasOpened = true;
      state.codexSwitchPopoverActive = true;
      switchZone.classList.add('has-opened');
    };
    const releaseCodexSwitchPopover = () => {
      requestAnimationFrame(() => {
        if (switchZone.matches(':hover, :focus-within')) return;
        state.codexSwitchPopoverActive = false;
        flushPendingCodexSwitchPopoverRender();
      });
    };
    switchZone.addEventListener('pointerenter', markCodexSwitchPopoverOpened);
    switchZone.addEventListener('focusin', markCodexSwitchPopoverOpened);
    switchZone.addEventListener('pointerleave', releaseCodexSwitchPopover);
    switchZone.addEventListener('focusout', releaseCodexSwitchPopover);
    switchButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (state.codexSystemSwitchingAccountId) return;
      state.codexSystemSwitchingAccountId = switchAccount.id;
      state.codexSystemSwitchErrorAccountId = '';
      state.codexSystemSwitchError = '';
      state.codexSwitchPopoverActive = false;
      renderLimits();
      try {
        const result = await window.tokenMonitor.codex.switchSystemAccount(switchAccount.id);
        if (!result?.ok) {
          const message = result?.error || t('limits.codex.switchFailed');
          state.codexSystemSwitchErrorAccountId = switchAccount.id;
          state.codexSystemSwitchError = message;
          state.codexAccountError = message;
        } else {
          state.codexAccountError = '';
          state.settings.codexManagedAccounts = result.accounts || state.settings.codexManagedAccounts || [];
          setCodexPendingActiveAccount(result.activeAccount || null);
          state.codexActiveAccount = result.activeAccount;
          renderLimits();
          window.tokenMonitor.codex.refreshAccountLimits(switchAccount.id).then((refreshResult) => {
            if (refreshResult?.ok) applyCodexAccountLimitsRefresh(refreshResult.providers || []);
            else if (refreshResult?.error) console.log(`[codex] refresh account limits failed: ${refreshResult.error}`);
          }).catch((refreshError) => {
            console.log(`[codex] refresh account limits failed: ${refreshError?.message || refreshError}`);
          });
        }
      } catch (error) {
        const message = error?.message || t('limits.codex.switchFailed');
        state.codexSystemSwitchErrorAccountId = switchAccount.id;
        state.codexSystemSwitchError = message;
        state.codexAccountError = message;
      } finally {
        state.codexSystemSwitchingAccountId = '';
        renderLimits();
        renderCodexAccounts();
        renderSettingsSummaries();
      }
    });
    switchPopover.append(switchButton);
    switchZone.append(title, switchPopover);
    name.append(switchZone);
  } else if (activeCodexAccount) {
    const activeZone = document.createElement('span');
    const badge = document.createElement('span');
    const activePopover = document.createElement('span');
    const activeHint = t('limits.codex.activeAccountHint');
    activeZone.className = 'limit-account-active-zone';
    activeZone.tabIndex = 0;
    activeZone.setAttribute('aria-label', activeHint);
    badge.className = 'limit-live-badge';
    badge.textContent = '\u2713';
    activePopover.className = 'limit-account-active-popover';
    activePopover.textContent = activeHint;
    const markCodexActiveHintOpened = () => {
      state.codexSwitchPopoverActive = true;
    };
    const releaseCodexActiveHint = () => {
      requestAnimationFrame(() => {
        if (activeZone.matches(':hover, :focus-within')) return;
        state.codexSwitchPopoverActive = false;
        flushPendingCodexSwitchPopoverRender();
      });
    };
    activeZone.addEventListener('pointerenter', markCodexActiveHintOpened);
    activeZone.addEventListener('focusin', markCodexActiveHintOpened);
    activeZone.addEventListener('pointerleave', releaseCodexActiveHint);
    activeZone.addEventListener('focusout', releaseCodexActiveHint);
    activeZone.append(title, badge, activePopover);
    name.append(activeZone);
  } else {
    name.append(title);
  }
  titleBlock.append(name);
  // The multi-account group header has no quota of its own, and its accounts can
  // update at different times (different devices too), so it omits the meta line
  // entirely — each account row below shows its own "Updated" time.
  if (!options.hideMeta) {
    const meta = document.createElement('div');
    meta.className = 'limit-meta';
    const metaParts = [];
    // A single Codex account stays clean like every other provider (just the
    // "Updated" line). The email only matters when several accounts share the
    // group, where it's each subrow's title (options.accountTitle) — not here.
    if (provider.status === 'ok' || provider.stale) metaParts.push(limitProviderMeta(provider, provenance));
    const metaText = metaParts.filter(Boolean).join(' · ');
    if (metaText) meta.append(document.createTextNode(metaText));
    titleBlock.append(meta);
  }
  const plan = document.createElement('div');
  plan.className = 'limit-plan';
  plan.textContent = options.planText ?? limitProviderPlan(provider);
  head.append(titleBlock, decoratePlanWithSubscription(plan, provider));
  return head;
}

function renderProviderWindows(provider, color) {
  const windows = document.createElement('div');
  windows.className = 'limit-windows';
  if (provider.provider === 'codex') {
    const session = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    const monthly = windowForKind(provider, 'billing');
    if (session) {
      const sessionNode = limitWindowNode(session.label || 'Session', session, color, 0.95);
      if (!weekly && !monthly) sessionNode.classList.add('limit-window-wide');
      windows.append(sessionNode);
    }
    if (weekly) {
      const weeklyNode = limitWindowNode(weekly.label || 'Weekly', weekly, color, 0.68);
      if (!session && !monthly) weeklyNode.classList.add('limit-window-wide');
      windows.append(weeklyNode);
    }
    if (monthly) {
      const monthlyNode = limitWindowNode(monthly.label || 'Monthly', monthly, color, 0.68);
      monthlyNode.classList.add('limit-window-wide');
      windows.append(monthlyNode);
    }
    const resetNode = codexResetCreditsNode(provider.resetCredits);
    if (resetNode) windows.append(resetNode);
  } else if (provider.provider === 'cursor') {
    windows.classList.add('limit-windows-cursor');
    const billingWindows = windowsForKind(provider, 'billing');
    const visibleWindows = billingWindows.length > 0 ? billingWindows : [null];
    for (const billing of visibleWindows) {
      const node = limitWindowNode('Billing cycle', billing, color, 0.68);
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  } else if (provider.provider === 'antigravity') {
    windows.classList.add('limit-windows-antigravity');
    const quotaGroups = antigravityQuotaGroups(provider);
    if (quotaGroups.length > 0) {
      windows.classList.add('limit-windows-antigravity-grouped');
      for (const group of quotaGroups) {
        const groupNode = document.createElement('div');
        groupNode.className = 'limit-window-group';
        groupNode.setAttribute('role', 'group');
        groupNode.setAttribute('aria-label', group.label);
        const title = document.createElement('div');
        title.className = 'limit-window-group-title';
        title.textContent = group.label;
        const groupWindows = document.createElement('div');
        groupWindows.className = 'limit-window-group-items';
        for (const entry of group.windows) {
          const opacity = entry.window.kind === 'session' ? 0.95 : 0.78;
          groupWindows.append(limitWindowNode(
            entry.windowLabel,
            { ...entry.window, label: entry.windowLabel },
            color,
            opacity
          ));
        }
        groupNode.append(title, groupWindows);
        windows.append(groupNode);
      }
    } else {
      const weeklyWindows = windowsForKind(provider, 'weekly');
      const visibleWindows = weeklyWindows.length > 0 ? weeklyWindows : [null];
      for (const quotaWindow of visibleWindows) {
        const node = limitWindowNode(quotaWindow?.label || 'Weekly', quotaWindow, color, 0.78);
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
    }
  } else if (provider.provider === 'opencode') {
    // Go reports session/weekly/monthly windows ($12/$30/$60); Zen reports a prepaid balance (and,
    // when the account is active, rolling/weekly). The monthly window normalizes to kind 'billing'
    // (see normalizeWindowKind). Show only the windows that exist — no empty `--` placeholders — and
    // surface the Zen balance as a full-width, no-meter note when present.
    const session = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    const monthly = windowForKind(provider, 'billing');
    if (session) windows.append(limitWindowNode('Session', session, color, 0.95));
    if (weekly) windows.append(limitWindowNode('Weekly', weekly, color, 0.68));
    // Monthly spans the full row (like Balance) so it never leaves a half-empty grid cell.
    if (monthly) {
      const node = limitWindowNode('Monthly', monthly, color, 0.5);
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
    // Balance is a Zen-only concept. Show it only when a real balance number came
    // back (incl. $0.00). It can't key off `source === 'web'` anymore — Go usage is
    // now fetched over the web too, so a pure-Go account (no Zen, balanceUsd null)
    // must not get a phantom `Balance —` line.
    const hasBalance = typeof provider.balanceUsd === 'number' && Number.isFinite(provider.balanceUsd);
    if (hasBalance) {
      const node = limitWindowNode('Balance', { showMeter: false }, color, 0.68, formatLimitAmount(provider.balanceUsd));
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  } else if (provider.provider === 'openrouter') {
    windows.classList.add('limit-windows-openrouter');
    const balance = provider.balance || null;
    const currency = balance?.currency || 'USD';
    const balanceAmount = optionalFiniteNumber(balance?.amount);
    const creditsWindow = openrouterCreditsWindow(provider);
    if (balanceAmount !== null) {
      const balanceWindow = creditsWindow || (balanceAmount === 0
        ? { usedPercent: 100, remainingPercent: 0, showMeter: true }
        : { showMeter: false });
      const balanceNode = limitWindowNode(
        'Balance',
        { ...balanceWindow, label: 'Balance' },
        color,
        0.95,
        formatMoney(balanceAmount, currency)
      );
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);
    }
    for (const quotaWindow of (provider.windows || []).filter((window) => window !== creditsWindow)) {
      const hasMeter = quotaWindow?.showMeter !== false;
      const remaining = optionalFiniteNumber(quotaWindow?.remaining);
      const limit = optionalFiniteNumber(quotaWindow?.limit);
      const absoluteDetail = hasMeter && remaining !== null && limit !== null
        ? `${formatMoney(remaining, 'USD')} left · ${formatMoney(limit, 'USD')} total`
        : '';
      const valueOverride = hasMeter ? null : (quotaWindow?.detail || '—');
      const node = limitWindowNode(
        quotaWindow?.label || 'Usage',
        quotaWindow,
        color,
        hasMeter ? 0.85 : 0.6,
        valueOverride,
        absoluteDetail
      );
      node.classList.add('limit-window-wide');
      if (!hasMeter) node.classList.add('limit-window-no-reset');
      windows.append(node);
    }
    const spendNode = providerSpendNode(balance);
    if (spendNode) windows.append(spendNode);
  } else if (provider.provider === 'thirdparty') {
    windows.classList.add('limit-windows-thirdparty');
    const balance = provider.balance || null;
    const currency = balance?.currency || 'USD';
    const balanceAmount = optionalFiniteNumber(balance?.amount);
    const quotaWindow = thirdPartyQuotaWindow(provider);
    const balanceLabel = quotaWindow?.label || 'Balance';
    if (balanceAmount !== null) {
      const balanceValue = formatMoney(balanceAmount, currency);
      const balanceNode = limitWindowNode(
        balanceLabel,
        { ...(quotaWindow || { showMeter: false }), label: balanceLabel },
        color,
        0.95,
        balanceValue
      );
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);
    } else if (quotaWindow?.showMeter === false && quotaWindow.detail) {
      const value = String(quotaWindow.detail).toLowerCase() === 'unlimited'
        ? t('settings.thirdparty.unlimited')
        : quotaWindow.detail;
      const balanceNode = limitWindowNode(
        balanceLabel,
        { ...quotaWindow, label: balanceLabel },
        color,
        0.95,
        value
      );
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);
    }
    const spendNode = thirdPartySpendNode(provider, quotaWindow);
    if (spendNode) windows.append(spendNode);
  } else if (provider.provider === 'deepseek') {
    // DeepSeek does not expose a fixed quota denominator. This intentionally
    // visualizes the balance relative to this month's inferred starting funds:
    // current / (current + observed month spend).
    windows.classList.add('limit-windows-deepseek');
    const balance = provider.balance || null;
    if (balance) {
      const currency = balance.currency;
      const balanceNode = limitWindowNode(
        'Balance',
        { remainingPercent: creditsMeterPercent(provider, null) },
        color,
        0.95,
        formatMoney(balance.amount, currency)
      );
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);

      const spendNode = providerSpendNode(balance);
      if (spendNode) windows.append(spendNode);
    }
  } else if (provider.provider === 'mimo') {
    windows.classList.add('limit-windows-mimo');
    const balance = provider.balance || null;
    const tokenPlan = windowForKind(provider, 'billing') || mimoTokenPlanWindowFromBalance(balance);
    if (tokenPlan) {
      const node = limitWindowNode(tokenPlan.label || 'Token Plan', tokenPlan, color, 0.68);
      node.classList.add('limit-window-wide');
      windows.append(node);
    } else if (balance?.planStatus === 'expired') {
      const node = limitWindowNode('Token Plan', { showMeter: false }, color, 0.68, t('limits.mimo.planExpired'));
      node.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(node);
    }
    const amount = optionalFiniteNumber(balance?.amount);
    const giftBalance = optionalFiniteNumber(balance?.giftBalance);
    const cashBalance = optionalFiniteNumber(balance?.cashBalance);
    if (amount !== null || giftBalance !== null || cashBalance !== null) {
      const detailParts = [];
      if (giftBalance !== null) detailParts.push(`Gift ${formatMoney(giftBalance, balance.currency)}`);
      if (cashBalance !== null) detailParts.push(`Cash ${formatMoney(cashBalance, balance.currency)}`);
      const balanceText = formatMoney(amount, balance.currency) || '—';
      const balanceNode = limitWindowNode(
        'Balance',
        { showMeter: false },
        color,
        0.68,
        balanceText,
        detailParts.join(' · ')
      );
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);
    }
  } else if (provider.provider === 'grok') {
    // Grok exposes a single Monthly billing window (no session/weekly). Render it
    // full-width so it doesn't share a row with an empty placeholder. This mirrors
    // how Cursor's billing cycle and OpenCode's Monthly are handled.
    windows.classList.add('limit-windows-grok');
    const monthly = windowForKind(provider, 'billing');
    if (monthly) {
      const node = limitWindowNode(monthly.label || 'Monthly', monthly, color, 0.68);
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  } else if (provider.provider === 'copilot') {
    windows.classList.add('limit-windows-copilot');
    const billingWindows = windowsForKind(provider, 'billing');
    for (const billing of billingWindows) {
      const node = limitWindowNode(billing?.label || 'Monthly', billing, color, 0.68);
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  } else if (provider.provider === 'zai' || provider.provider === 'zaiteam') {
    const fiveHour = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    const mcp = windowForKind(provider, 'billing');
    if (fiveHour) {
      const fiveHourNode = limitWindowNode('5-hour', fiveHour, color, 0.95);
      if (!weekly) fiveHourNode.classList.add('limit-window-wide');
      windows.append(fiveHourNode);
    }
    if (weekly) windows.append(limitWindowNode('Weekly', weekly, color, 0.68));
    if (mcp) {
      const mcpNode = limitWindowNode('MCP', mcp, color, 0.68);
      mcpNode.classList.add('limit-window-wide');
      windows.append(mcpNode);
    }
  } else if (provider.provider === 'volcengine') {
    const session = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    const monthly = windowForKind(provider, 'billing');
    if (session) {
      const sessionNode = limitWindowNode(session.label || '5-hour', session, color, 0.95);
      if (!weekly && !monthly && session.label) sessionNode.classList.add('limit-window-wide');
      windows.append(sessionNode);
    }
    if (weekly) windows.append(limitWindowNode('Weekly', weekly, color, 0.68));
    if (monthly) {
      const monthlyNode = limitWindowNode('Monthly', monthly, color, 0.68);
      monthlyNode.classList.add('limit-window-wide');
      windows.append(monthlyNode);
    }
  } else if (provider.provider === 'kiro') {
    // Kiro exposes monthly credits (plus an optional bonus pool), both billing
    // windows. Render them full-width like Copilot's quota windows.
    windows.classList.add('limit-windows-kiro');
    const billingWindows = windowsForKind(provider, 'billing');
    for (const billing of billingWindows) {
      if (billing?.showMeter === false) {
        // Overage: a single compact line like Cursor's "Credits $0.00" (no bar,
        // no reset) with the credits used and estimated cost joined on the right.
        const node = limitWindowNode(billing.label || 'Overage', billing, color, 0.6, formatKiroOverageValue(billing));
        node.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(node);
      } else {
        const node = limitWindowNode(
          billing?.label || 'Credits',
          billing,
          color,
          0.68,
          null,
          formatLimitCount(billing, Boolean(state.settings?.showLimitUsed))
        );
        node.classList.add('limit-window-wide');
        windows.append(node);
      }
    }
  } else if (provider.provider === 'qoder') {
    windows.classList.add('limit-windows-qoder');
    const credits = windowForKind(provider, 'billing');
    if (credits) {
      const node = limitWindowNode(
        credits?.label || 'Credits',
        credits,
        color,
        0.68,
        null,
        formatLimitCount(credits, Boolean(state.settings?.showLimitUsed))
      );
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  } else if (provider.provider === 'commandcode') {
    // 5-hour and weekly are rate-limit windows (percent); the monthly grant and
    // any rollover top-up are money, so they get the amount on the right of the
    // reset line and span the row like Kimi's Monthly.
    const fiveHour = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    if (fiveHour) {
      const node = limitWindowNode('5-hour', fiveHour, color, 0.95);
      if (!weekly) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    if (weekly) {
      const node = limitWindowNode('Weekly', weekly, color, 0.68);
      if (!fiveHour) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    for (const credits of windowsForKind(provider, 'billing')) {
      const node = limitWindowNode(
        credits.label || 'Monthly',
        credits,
        color,
        0.5,
        null,
        formatCommandcodeCreditsDetail(credits)
      );
      node.classList.add('limit-window-wide');
      // A grant with no known plan allowance has no meter, so there is no bar
      // for a reset line to sit under either.
      if (credits.showMeter === false) node.classList.add('limit-window-no-reset');
      windows.append(node);
    }
  } else if (provider.provider === 'kimi') {
    const fiveHour = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    const monthly = windowForKind(provider, 'billing');
    if (fiveHour) {
      const node = limitWindowNode(fiveHour.label || '5-hour', fiveHour, color, 0.95);
      if (!weekly) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    if (weekly) {
      const node = limitWindowNode(weekly.label || 'Weekly', weekly, color, 0.68);
      if (!fiveHour) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    if (monthly) {
      const node = limitWindowNode(
        monthly.label || 'Monthly',
        monthly,
        color,
        0.5,
        null,
        monthly.detail || ''
      );
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
  } else if (provider.provider === 'ollama') {
    const session = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    if (session) {
      const node = limitWindowNode('Session', session, color, 0.95);
      if (!weekly) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    if (weekly) windows.append(limitWindowNode('Weekly', weekly, color, 0.68));
  } else if (provider.provider === 'claude') {
    // Claude usually shows session + one all-models weekly, but can carry a second
    // model-scoped weekly (the temporary "Fable only" promo cap). Render every
    // weekly the response actually has, and nothing when a bucket is absent — no
    // empty placeholder — so the scoped bar appears only while the promo is live.
    const session = windowForKind(provider, 'session');
    if (session) windows.append(limitWindowNode(session.label || 'Session', session, color, 0.95));
    for (const weekly of windowsForKind(provider, 'weekly')) {
      const node = limitWindowNode(weekly.label || 'Weekly', weekly, color, 0.68);
      // The all-models weekly pairs with Session in the two-column grid; a
      // model-scoped weekly (the "Fable only" promo cap) has no partner, so span
      // the full row instead of leaving a half-empty cell.
      if (weekly.label) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    // Usage credits: "$2.35 / $20.00" with a meter when a monthly spend limit is
    // set, "$2.35 spent" without one. Absent entirely when credits are off.
    const usageCredits = spendWindow(provider);
    if (usageCredits) {
      const value = usageCredits.limit === null
        ? `${formatMoney(usageCredits.used, usageCredits.currency)} spent`
        : `${formatMoney(usageCredits.used, usageCredits.currency)} / ${formatMoney(usageCredits.limit, usageCredits.currency)}`;
      const node = limitWindowNode('Usage credits', usageCredits, color, 0.5, value);
      node.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(node);
    }
    const balanceNode = claudeBalanceNode(provider);
    if (balanceNode) windows.append(balanceNode);
  } else {
    // Default: render only the windows the provider actually has. Providers
    // that only expose a single window shouldn't leave a half-empty bar next to
    // the real one. (Grok is handled above; this branch covers minimax's
    // session + weekly pair and any future session/weekly provider.)
    const session = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    if (session) windows.append(limitWindowNode(session.label || 'Session', session, color, 0.95));
    if (weekly) windows.append(limitWindowNode(weekly.label || 'Weekly', weekly, color, 0.68));
  }
  return windows;
}

function renderLimitProviderRow(id, label, provider, color, options = {}) {
  const row = document.createElement('div');
  const classes = ['limit-row'];
  if (options.accountRow) classes.push('limit-account-row');
  if (provider.stale) classes.push('stale');
  row.className = classes.join(' ');
  row.append(
    renderLimitProviderHead(id, label, provider, color, options),
    renderProviderWindows(provider, color)
  );
  return row;
}

// Every limits surface (the limits panel and the Home cards) resolves account
// titles here. One table keeps a provider from masking its email on one surface
// while leaking it on the other, and from rendering two different titles for the
// same account. Providers identified by email need no entry — the default below
// already masks them.
const LIMIT_ACCOUNT_TITLES = {
  codex: codexAccountTitle,
  opencode: opencodeAccountTitle,
  openrouter: (provider, index) => namedApiAccountTitle(provider, index, 'openrouter'),
  thirdparty: (provider, index) => namedApiAccountTitle(provider, index, 'thirdparty')
};

function limitAccountTitle(id, provider, index, providerEntries = [provider]) {
  const resolve = LIMIT_ACCOUNT_TITLES[String(id || '').trim().toLowerCase()];
  return resolve
    ? resolve(provider, index, providerEntries)
    : limitAccountDefaultTitle(provider, index, providerEntries);
}

// maskLimitAccountEmails is display-only: it hides the address on the limits
// surfaces without changing what is collected, synced, or stored.
function limitAccountEmailsMasked() {
  return state.settings?.maskLimitAccountEmails === true;
}

function limitAccountDefaultTitle(provider, index, providerEntries = [provider]) {
  return accountIdentityApi.accountTitleLabel(provider, providerEntries, {
    maskEmail: limitAccountEmailsMasked(),
    index
  }) || `Account ${index + 1}`;
}

function codexAccountTitle(provider, index, providers = [provider]) {
  const label = accountIdentityApi.codexAccountDisplayLabel(provider, providers, {
    maskEmail: limitAccountEmailsMasked(),
    index,
    // Limits presents raw account data such as email and Plus/Pro labels, so
    // keep the provider's canonical English workspace name on this surface.
    personalWorkspaceLabel: 'Personal'
  });
  if (label) return label;
  // Never fall back to the plan label here — "Plus" as a title reads like an
  // account name. The plan still shows on the right via limitProviderPlan().
  return `Account ${index + 1}`;
}

function renderCodexAccountGroup(label, providers, color) {
  const row = document.createElement('div');
  row.className = `limit-row limit-row-group${providers.some((provider) => provider.stale) ? ' stale' : ''}`;
  const groupProvider = { provider: 'codex', status: 'ok', windows: [], accountGroup: true };
  const head = renderLimitProviderHead('codex', label, groupProvider, color, {
    planText: t('settings.codex.nAccounts', { count: providers.length }),
    hideMeta: true
  });
  const accountList = document.createElement('div');
  accountList.className = 'limit-account-list';
  providers.forEach((provider, index) => {
    accountList.append(renderLimitProviderRow('codex', limitAccountTitle('codex', provider, index, providers), provider, color, {
      accountRow: true,
      accountTitle: true,
      allowSystemSwitch: true,
      showActiveBadge: true,
      showIcon: false
    }));
  });
  row.append(head, accountList);
  return row;
}

function renderClaudeAccountGroup(label, providers, color) {
  const row = document.createElement('div');
  row.className = `limit-row limit-row-group${providers.some((provider) => provider.stale) ? ' stale' : ''}`;
  const groupProvider = { provider: 'claude', status: 'ok', windows: [], accountGroup: true };
  const head = renderLimitProviderHead('claude', label, groupProvider, color, {
    planText: t('settings.claude.nAccounts', { count: providers.length }),
    hideMeta: true
  });
  const accountList = document.createElement('div');
  accountList.className = 'limit-account-list';
  providers.forEach((provider, index) => {
    accountList.append(renderLimitProviderRow('claude', limitAccountTitle('claude', provider, index, providers), provider, color, {
      accountRow: true,
      accountTitle: true,
      showIcon: false
    }));
  });
  row.append(head, accountList);
  return row;
}

function mimoSettingsAccountTitle(account, index) {
  return String(account?.accountEmail || '').trim() || `Account ${index + 1}`;
}

function renderMimoAccountGroup(label, providers, color) {
  const row = document.createElement('div');
  row.className = `limit-row limit-row-group${providers.some((provider) => provider.stale) ? ' stale' : ''}`;
  const groupProvider = { provider: 'mimo', status: 'ok', windows: [], accountGroup: true };
  const head = renderLimitProviderHead('mimo', label, groupProvider, color, {
    planText: t('settings.mimo.nAccounts', { count: providers.length }),
    hideMeta: true
  });
  const accountList = document.createElement('div');
  accountList.className = 'limit-account-list';
  providers.forEach((provider, index) => {
    accountList.append(renderLimitProviderRow('mimo', limitAccountTitle('mimo', provider, index, providers), provider, color, {
      accountRow: true,
      accountTitle: true,
      showIcon: false
    }));
  });
  row.append(head, accountList);
  return row;
}

function opencodeAccountTitle(provider, index) {
  const name = String(provider?.accountName || '').trim();
  // The collector's canonical name is shown as-is. This column holds account
  // names, which are user strings and almost never translated, so a localized
  // phrase reads as a stray UI label among them — and the plan and source
  // columns beside it are English for the same reason.
  if (name) return name;
  // Older synced clients put the user-defined profile name in accountLabel.
  // Keep those rows identifiable while new clients carry profile and plan in
  // separate fields. Go/Zen are plan labels, never account identities.
  const legacyName = String(provider?.accountLabel || '').trim();
  return legacyName && legacyName !== 'Go' && legacyName !== 'Zen'
    ? legacyName
    : `Account ${index + 1}`;
}

function renderOpenCodeAccountGroup(label, providers, color) {
  const row = document.createElement('div');
  row.className = 'limit-row limit-row-group';
  const groupProvider = { provider: 'opencode', status: 'ok', windows: [], accountGroup: true };
  const head = renderLimitProviderHead('opencode', label, groupProvider, color, {
    planText: t('settings.opencode.nAccounts', { count: providers.length }),
    hideMeta: true
  });
  const accountList = document.createElement('div');
  accountList.className = 'limit-account-list';
  providers.forEach((provider, index) => {
    const legacyProfileLabel = !provider?.accountName
      && provider?.accountLabel
      && provider.accountLabel !== 'Go'
      && provider.accountLabel !== 'Zen';
    accountList.append(renderLimitProviderRow('opencode', limitAccountTitle('opencode', provider, index, providers), provider, color, {
      accountRow: true,
      showIcon: false,
      ...(legacyProfileLabel ? { planText: '' } : {})
    }));
  });
  row.append(head, accountList);
  return row;
}

function namedApiAccountTitle(provider, index, providerId) {
  const accountName = String(provider?.accountName || provider?.accountLabel || '').trim();
  if (accountName.toLowerCase() === 'environment') return t(`settings.${providerId}.environment`);
  return accountName || `Account ${index + 1}`;
}

function thirdPartyPlanText(provider) {
  if (provider?.status !== 'ok') return undefined;
  const planLabel = String(provider?.planLabel || '').toLowerCase();
  if (planLabel === 'account') return 'Account';
  if (planLabel === 'api key') return 'API key';
  if (planLabel === 'custom') return 'Custom';
  return undefined;
}

function renderNamedApiAccountGroup(providerId, label, providers, color, options = {}) {
  const row = document.createElement('div');
  row.className = `limit-row limit-row-group${providers.some((provider) => provider.stale) ? ' stale' : ''}`;
  const groupProvider = { provider: providerId, status: 'ok', windows: [], accountGroup: true };
  const head = renderLimitProviderHead(providerId, label, groupProvider, color, {
    planText: options.groupPlanText,
    hideMeta: true
  });
  const accountList = document.createElement('div');
  accountList.className = 'limit-account-list';
  providers.forEach((provider, index) => {
    accountList.append(renderLimitProviderRow(
      providerId,
      limitAccountTitle(providerId, provider, index, providers),
      provider,
      color,
      {
        accountRow: true,
        showIcon: false,
        ...(options.planTextForProvider
          ? { planText: options.planTextForProvider(provider) }
          : {})
      }
    ));
  });
  row.append(head, accountList);
  return row;
}

function renderOpenRouterAccountGroup(label, providers, color) {
  return renderNamedApiAccountGroup('openrouter', label, providers, color, {
    groupPlanText: t('settings.openrouter.nAccounts', { count: providers.length })
  });
}

function renderThirdPartyAccountGroup(label, providers, color) {
  return renderNamedApiAccountGroup('thirdparty', label, providers, color, {
    groupPlanText: t('settings.thirdparty.nAccounts', { count: providers.length }),
    planTextForProvider: thirdPartyPlanText
  });
}

function renderLimits() {
  if (!els.limitsPanel) return;
  const holdLimitDetailTooltipRender = limitDetailTooltipShouldHoldRender();
  const holdCodexSwitchPopoverRender = codexSwitchPopoverShouldHoldRender();
  if (holdLimitDetailTooltipRender || holdCodexSwitchPopoverRender) {
    if (holdLimitDetailTooltipRender) state.limitDetailTooltipRenderPending = true;
    if (holdCodexSwitchPopoverRender) state.codexSwitchPopoverRenderPending = true;
    return;
  }
  state.limitDetailTooltipRenderPending = false;
  state.codexSwitchPopoverRenderPending = false;
  const limitsEnabled = state.settings?.limitsEnabled !== false;
  const enabled = enabledLimitProviderSet();
  const providers = providersByLimitProviderId(state.stats?.limits?.providers || []);
  const orderedProviders = limitProviderOrderApi
    .orderedLimitProviders(LIMIT_PROVIDERS, state.settings?.limitProviderOrder)
    .filter(({ id }) => limitsEnabled && enabled.has(id));
  const visibleProviderEntries = new Map(orderedProviders.map(({ id }) => {
    const providerEntries = limitsEnabled && enabled.has(id)
      ? (providers.get(id) || [{ provider: id, status: state.stats ? missingLimitProviderStatus() : 'unavailable', windows: [] }])
      : [{ provider: id, status: 'disabled', windows: [] }];
    return [id, providerEntries];
  }));
  const renderSignature = JSON.stringify({
    locale: currentLocale(),
    minute: Math.floor(Date.now() / 60000),
    mode: state.mode,
    hubUrl: state.settings?.hubUrl || '',
    deviceId: state.settings?.deviceId || '',
    settings: [
      state.settings?.showLimitSource === true,
      state.settings?.maskLimitAccountEmails === true,
      state.settings?.showLimitUsed === true,
      state.settings?.showToolIcons !== false,
      state.settings?.claudePrepaidBalanceEnabled !== false,
      state.settings?.currency || '',
      state.settings?.currencyRatesEffective || null,
      state.settings?.subscriptions || [],
      state.settings?.codexManagedAccounts || [],
      state.codexActiveAccount || null,
      state.codexSystemSwitchingAccountId || '',
      state.codexSystemSwitchErrorAccountId || '',
      state.codexSystemSwitchError || ''
    ],
    providerOrder: orderedProviders.map(({ id }) => id),
    providers: [...visibleProviderEntries.entries()]
  });
  if (
    state.limitPanelRenderSignature === renderSignature
    && els.limitsPanel.children.length === orderedProviders.length
  ) {
    return;
  }
  state.limitPanelRenderSignature = renderSignature;
  const nodes = [];
  const rows = orderedProviders;
  if (rows.length === 0) {
    els.limitsPanel.replaceChildren();
    return;
  }
  for (const { id, label } of rows) {
    const visibleProviders = visibleProviderEntries.get(id) || [{ provider: id, status: 'disabled', windows: [] }];
    const color = id === 'mimo' ? clientColors.xiaomi : (clientColors[id] || clientColors.default);
    if (id === 'claude' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderClaudeAccountGroup(label, visibleProviders, color));
      continue;
    }
    if (id === 'codex' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderCodexAccountGroup(label, visibleProviders, color));
      continue;
    }
    if (id === 'opencode' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderOpenCodeAccountGroup(label, visibleProviders, color));
      continue;
    }
    if (id === 'openrouter' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderOpenRouterAccountGroup(label, visibleProviders, color));
      continue;
    }
    if (id === 'thirdparty' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderThirdPartyAccountGroup(label, visibleProviders, color));
      continue;
    }
    if (id === 'mimo' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderMimoAccountGroup(label, visibleProviders, color));
      continue;
    }
    const provider = Array.isArray(visibleProviders) ? visibleProviders[0] : visibleProviders;
    const rowOptions = id === 'codex'
      ? { accountTitle: true, allowSystemSwitch: true }
      : id === 'thirdparty'
        ? { planText: thirdPartyPlanText(provider) }
        : undefined;
    nodes.push(renderLimitProviderRow(id, label, provider, color, rowOptions));
  }
  els.limitsPanel.replaceChildren(...nodes);
}

function serviceStatusLabel(status) {
  if (status === 'ok') return t('serviceStatus.ok');
  if (status === 'degraded') return t('serviceStatus.degraded');
  if (status === 'outage') return t('serviceStatus.outage');
  return t('serviceStatus.unknown');
}

function serviceStatusMeta(provider) {
  // Show a short affected-component *count* rather than the names: the names are
  // the variable-length part that overflowed the line, while the count keeps the
  // real scope visible — an incident title (line 2) often understates it, e.g.
  // "errors on Haiku" while claude.ai/API/Code are all degraded. Full names stay
  // in the row tooltip (set in renderServiceStatus).
  const parts = [];
  const affectedCount = serviceStatusPresentationApi.affectedComponentNames(provider.componentIssues).all.length;
  if (affectedCount > 0) parts.push(t('serviceStatus.components', { count: affectedCount }));
  if (Number(provider.incidentCount || 0) > 0) parts.push(t('serviceStatus.incidents', { count: provider.incidentCount }));
  if (Number(provider.maintenanceCount || 0) > 0) parts.push(t('serviceStatus.maintenance', { count: provider.maintenanceCount }));
  if (parts.length) return parts.join(' · ');
  // "No ongoing issues" only reads true for a healthy provider — a degraded one
  // with nothing to count shows just its timestamp rather than a contradiction.
  return provider.status === 'ok' ? t('serviceStatus.noIssues') : '';
}

function visibleServiceProviderIds() {
  return serviceStatusProviderPreferencesApi.visibleOrder(
    SERVICE_PROVIDER_OPTIONS,
    state.settings?.serviceProviderDisplayOrder,
    state.settings?.hiddenServiceProviders
  );
}

function serviceStatusRows() {
  const order = visibleServiceProviderIds();
  const rank = new Map(order.map((id, index) => [id, index]));
  const base = (state.serviceStatus?.providers?.length)
    ? state.serviceStatus.providers
    : SERVICE_STATUS_PLACEHOLDERS.map((provider) => ({
        ...provider,
        status: 'unknown',
        description: state.serviceStatusBusy ? t('serviceStatus.loading') : t('serviceStatus.notChecked'),
        checkedAt: '',
        updatedAt: '',
        componentIssues: [],
        incidentCount: 0,
        maintenanceCount: 0
      }));
  return base
    .filter((provider) => rank.has(provider.id))
    .sort((a, b) => rank.get(a.id) - rank.get(b.id));
}

function serviceStatusIconId(id) {
  return id === 'openai' ? 'codex' : id; // claude/cursor/deepseek map 1:1
}

function renderServiceStatus() {
  if (!els.serviceStatusPanel) return;
  const rows = serviceStatusRows().map((provider) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `service-status-row service-status-${provider.status || 'unknown'}`;
    row.dataset.provider = provider.id;
    row.title = t('serviceStatus.openPage', { name: provider.label });
    row.addEventListener('click', () => window.tokenMonitor.openExternal?.(provider.pageUrl));
    const head = document.createElement('div');
    head.className = 'service-status-head';
    const title = document.createElement('div');
    title.className = 'service-status-title';
    if (state.settings?.showToolIcons) {
      const icon = document.createElement('span');
      icon.className = `service-status-icon row-icon row-icon-${serviceStatusIconId(provider.id)}`;
      title.append(icon);
    }
    const name = document.createElement('strong');
    name.textContent = provider.label;
    title.append(name);
    const pill = document.createElement('span');
    pill.className = 'service-status-pill';
    pill.textContent = serviceStatusLabel(provider.status);
    head.append(title, pill);
    const description = document.createElement('div');
    description.className = 'service-status-description';
    description.textContent = serviceStatusPresentationApi.statusHeadline(provider) || t('serviceStatus.unknown');
    const meta = document.createElement('div');
    meta.className = 'service-status-meta';
    const metaInfo = serviceStatusMeta(provider);
    meta.textContent = metaInfo;
    if (provider.checkedAt) {
      if (metaInfo) meta.append(document.createTextNode(' · '));
      const checkedSpan = document.createElement('span');
      checkedSpan.className = 'service-status-checked';
      checkedSpan.dataset.checkedAt = provider.checkedAt;
      checkedSpan.textContent = formatAgo(Date.now() - Date.parse(provider.checkedAt));
      meta.append(checkedSpan);
    }
    const affected = serviceStatusPresentationApi.affectedComponentNames(provider.componentIssues).all;
    if (affected.length) meta.title = affected.join(t('serviceStatus.listSeparator'));
    row.append(head, description, meta);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'service-status-empty';
    empty.textContent = t('serviceStatus.allHidden');
    els.serviceStatusPanel.replaceChildren(empty);
    return;
  }
  els.serviceStatusPanel.replaceChildren(...rows);
}

async function refreshServiceStatus(options = {}) {
  if (!window.tokenMonitor.getServiceStatus || state.serviceStatusBusy) return;
  state.serviceStatusBusy = true;
  renderServiceStatus();
  try {
    state.serviceStatus = await window.tokenMonitor.getServiceStatus({ force: options.force === true, providerIds: visibleServiceProviderIds() });
  } catch (error) {
    const checkedAt = new Date().toISOString();
    state.serviceStatus = {
      checkedAt,
      providers: SERVICE_STATUS_PLACEHOLDERS.map((provider) => ({
        ...provider,
        status: 'unknown',
        indicator: 'unknown',
        description: t('serviceStatus.checkFailed'),
        checkedAt,
        updatedAt: '',
        componentIssues: [],
        incidentCount: 0,
        maintenanceCount: 0,
        error: error.message
      }))
    };
  } finally {
    state.serviceStatusBusy = false;
    renderServiceStatus();
  }
}

function formatAgo(ms) {
  const { unit, value } = serviceStatusPresentationApi.agoBucket(ms);
  const key = `serviceStatus.ago${unit.charAt(0).toUpperCase()}${unit.slice(1)}`;
  return t(key, { n: value });
}

function serviceStatusRefreshMs() {
  const value = Number(state.settings?.serviceStatusRefreshMs);
  return value > 0 ? value : Infinity; // 0 = Manual
}

function lastServiceStatusCheckedAt() {
  return Date.parse(state.serviceStatus?.checkedAt || '') || 0;
}

function maybeFetchServiceStatus() {
  if (state.serviceStatusBusy) return;
  if (visibleServiceProviderIds().length === 0) return;
  if (!state.serviceStatus) { refreshServiceStatus().catch(() => {}); return; }
  const intervalMs = serviceStatusRefreshMs();
  if (Number.isFinite(intervalMs) && Date.now() - lastServiceStatusCheckedAt() >= intervalMs) {
    refreshServiceStatus().catch(() => {});
  }
}

function updateServiceStatusAgoLabels() {
  const spans = els.serviceStatusPanel?.querySelectorAll('.service-status-checked') || [];
  for (const span of spans) {
    const checkedAt = Date.parse(span.dataset.checkedAt || '');
    if (Number.isFinite(checkedAt)) span.textContent = formatAgo(Date.now() - checkedAt);
  }
}

function onServiceStatusTick() {
  if (state.breakdown !== 'status') { stopServiceStatusTicker(); return; }
  updateServiceStatusAgoLabels();
  maybeFetchServiceStatus();
}

function ensureServiceStatusTicker() {
  if (state.serviceStatusTicker) return;
  state.serviceStatusTicker = setInterval(onServiceStatusTick, 1000);
  onServiceStatusTick();
}

function stopServiceStatusTicker() {
  if (!state.serviceStatusTicker) return;
  clearInterval(state.serviceStatusTicker);
  state.serviceStatusTicker = null;
}

async function openSessionDetail({ client, sessionId, sessionCost, title }) {
  const request = { client, sessionId, sessionCost, title, period: state.period, detail: null };
  state.openSession = request;
  renderSessionDetail({ loading: true });
  try {
    const detail = await window.tokenMonitor.getSessionDetail({ client, sessionId, period: request.period, sessionCost });
    if (state.openSession === request) {
      request.detail = detail;
      renderSessionDetail({ detail });
    }
  } catch (_) {
    if (state.openSession === request) renderSessionDetail({ error: true });
  }
}

function toggleDetailSort() {
  state.detailSort = state.detailSort === 'tokens' ? 'time' : 'tokens';
  if (state.openSession && state.openSession.detail) renderSessionDetail({ detail: state.openSession.detail });
}

function closeSessionDetail() {
  state.openSession = null;
  els.sessionDetail.classList.add('hidden');
  els.sessionDetail.replaceChildren();
  els.sessionDetailHead.classList.add('hidden');
  els.sessionDetailHead.replaceChildren();
  render();
}

function renderSessionDetail({ detail, loading, error } = {}) {
  els.breakdown.classList.add('hidden');
  els.sessionDetail.classList.remove('hidden');
  els.sessionDetailHead.classList.remove('hidden');
  const head = els.sessionDetailHead;       // static layer — rows scroll independently below it
  const container = els.sessionDetail;
  head.replaceChildren();
  container.replaceChildren();

  const back = document.createElement('button');
  back.className = 'detail-back';
  back.textContent = `‹ ${t('sessions') || 'Sessions'}`;
  back.addEventListener('click', closeSessionDetail);
  head.append(back);

  if (loading) { container.append(detailNote(t('detailLoading') || 'Loading…')); return; }
  if (error || (detail && detail.found === false)) { container.append(detailNote(t('detailNotFound') || 'Transcript not found on this machine.')); return; }

  const rows = sessionDetailApi.exchangeRows(detail, { now: new Date(), sortBy: state.detailSort });
  if (rows.length === 0) { container.append(detailNote(t('detailEmpty') || 'No activity in this period.')); return; }
  if (detail?.tokenDataUnavailable === true) {
    container.append(detailNote(t('detailTokenDataUnavailable') || 'Token data is unavailable for this session.'));
  }

  const sort = document.createElement('button');
  sort.className = 'detail-sort';
  sort.textContent = state.detailSort === 'tokens' ? (t('sortMostTokens') || '↕ Most tokens') : (t('sortNewest') || '↕ Newest');
  sort.addEventListener('click', toggleDetailSort);
  head.append(sort);

  const max = Math.max(1, ...rows.map((row) => row.value));
  for (const row of rows) container.append(exchangeNode(row, max));
}

function detailNote(text) {
  const note = document.createElement('div');
  note.className = 'detail-note';
  note.textContent = text;
  return note;
}

function exchangeNode(row, max) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-exchange';
  wrap.innerHTML = '<div class="detail-ex-head"><span class="detail-chev">▸</span>'
    + '<div class="detail-ex-label"><span class="detail-ex-title"></span><span class="detail-ex-sub"></span></div>'
    + '<div class="detail-ex-metrics"><span class="detail-ex-value"></span><span class="detail-ex-cost"></span></div></div>'
    + '<div class="bar"><div class="bar-fill"></div></div>'
    + '<div class="detail-turns hidden"></div>';
  const exTitle = wrap.querySelector('.detail-ex-title');
  if (row.isPrompt) {
    const role = document.createElement('span');
    role.className = 'detail-role-user';
    role.textContent = t('roleYou') || 'You';
    const sep = document.createElement('span');
    sep.className = 'detail-role-sep';
    sep.textContent = ' › ';
    exTitle.append(role, sep);
  }
  exTitle.append(document.createTextNode(row.title));
  wrap.querySelector('.detail-ex-sub').textContent = row.subtitle;
  const tokensAvailable = row.tokensAvailable !== false;
  wrap.querySelector('.detail-ex-value').textContent = tokensAvailable
    ? formatNumber(row.value)
    : (t('detailTokenUnavailable') || 'Unavailable');
  wrap.querySelector('.detail-ex-cost').textContent = tokensAvailable ? formatCost(row.cost) : '';
  applyBarScale(wrap.querySelector('.bar-fill'), rowWidth(row.value, max) / 100);

  const turnsEl = wrap.querySelector('.detail-turns');
  for (const turn of row.turns) turnsEl.append(turnNode(turn));

  const head = wrap.querySelector('.detail-ex-head');
  head.addEventListener('click', () => {
    const collapsed = turnsEl.classList.toggle('hidden');
    wrap.querySelector('.detail-chev').textContent = collapsed ? '▸' : '▾';
  });
  return wrap;
}

function turnNode(turn) {
  const el = document.createElement('div');
  el.className = 'detail-turn';
  const tk = turn.tokens || {};
  // "cache" folds cache reads + cache writes (Claude's cache_creation) into one bucket so the
  // in/out/cache breakdown sums to the turn total; reason is an informational subset of out.
  const cache = (tk.cacheRead || 0) + (tk.cacheWrite || 0);
  const split = `in ${formatNumber(tk.input || 0)} · out ${formatNumber(tk.output || 0)} · cache ${formatNumber(cache)}`
    + (tk.reasoning ? ` · reason ${formatNumber(tk.reasoning)}` : '');
  el.innerHTML = '<div class="detail-turn-label"><span class="detail-turn-title"></span><span class="detail-turn-split"></span><span class="detail-turn-tools"></span></div>'
    + '<div class="detail-turn-metrics"><span class="detail-turn-value"></span><span class="detail-turn-cost"></span></div>';
  el.querySelector('.detail-turn-title').textContent = `AI ${turn.label}`;
  const tokensAvailable = turn.tokensAvailable !== false;
  el.querySelector('.detail-turn-split').textContent = tokensAvailable
    ? split
    : (t('detailTokenUnavailable') || 'Unavailable');
  el.querySelector('.detail-turn-tools').textContent = turn.tools ? `⊢ ${turn.tools}` : '';
  el.querySelector('.detail-turn-value').textContent = tokensAvailable
    ? formatNumber(turn.value)
    : (t('detailTokenUnavailable') || 'Unavailable');
  el.querySelector('.detail-turn-cost').textContent = tokensAvailable ? formatCost(turn.cost) : '';
  return el;
}

let contentReadySignaled = false;

function renderTrends() {
  const charts = window.TokenMonitorUsageCharts;
  const previousBars = captureTrendBarMotion();
  const preview = state.stats?.historyPreview || { daily: [], monthly: [], summary: {} };
  const todayTotal = Number(state.stats?.periods?.today?.totalTokens || 0);
  const fixed = fixedPeriodRangesApi.isDerived(state.period) ? state.fixedPeriodSnapshot : null;
  // Fixed headline ranges do not collapse the Trends context down to a handful
  // of bars. Keep the established long-range monthly view; the range-specific
  // active-time and peak cards below still describe the selected fixed period.
  const selected = charts.selectPreviewSeries(preview, fixed?.status === 'ready' ? 'allTime' : state.period);
  const { points, metric, labelKey } = selected;
  const finalPoints = state.period === 'today' ? charts.patchTodayBar(points, todayTotal) : points;

  if (finalPoints.length === 0) {
    els.trendsPanel.innerHTML = `<div class="trends-empty">${t('trends.empty')}</div>`;
    return;
  }

  const model = charts.sparklinePreview(finalPoints, { width: 300, height: 120, gap: 0.3, metric });
  const titles = finalPoints.map((p) => `${trendShortLabel(p[labelKey], labelKey)} · ${formatCompact(p[metric])}`);
  const svg = charts.sparklineSvg(model, { titles, showZeroMarkers: state.period === 'today' });

  const summary = homeOverviewApi.activityStatsForPeriod({
    period: state.period,
    fixedSnapshot: fixed,
    daily: preview.daily,
    historySummary: preview.summary,
    todayKey: charts.localDayKey()
  });
  const rangeLabel = fixed?.status === 'ready' || state.period === 'allTime'
    ? t('trends.range.year')
    : state.period === 'month' ? t('trends.range.month') : t('trends.range.week');
  const first = trendShortLabel(finalPoints[0][labelKey], labelKey);
  const last = trendShortLabel(finalPoints[finalPoints.length - 1][labelKey], labelKey);
  const stats = [
    [t('trends.activeDays'), formatNumber(summary.activeDays)],
    [t('trends.currentStreak'), formatNumber(summary.currentStreak)],
    [t('trends.activeTime'), formatActiveDuration(summary.activeTimeMs)],
    [t('trends.peakDay'), formatCompact(summary.peakDayTokens)]
  ];
  const statsHtml = stats
    .map(([k, v]) => `<div class="trends-stat"><span class="trends-stat-v">${v}</span><span class="trends-stat-k">${k}</span></div>`)
    .join('');

  els.trendsPanel.innerHTML =
    `<div class="trends-cap"><span>${rangeLabel}</span><span class="trends-open-hint" title="${t('trends.open')}">↗</span></div>`
    + `<div class="trends-spark" role="button" tabindex="0" title="${t('trends.open')}">${svg}</div>`
    + `<div class="trends-axis"><span>${first}</span><span>${last}</span></div>`
    + `<div class="trends-stats">${statsHtml}</div>`;
  const bars = Array.from(els.trendsPanel.querySelectorAll('.spark-bar'));
  bars.forEach((bar, index) => {
    bar.dataset.motionKey = String(finalPoints[index]?.[labelKey] || index);
  });
  const fromZero = state.animateChartsOnRender;
  animateTrendBarsFrom(previousBars, { fromZero });
  if (fromZero) state.animateChartsOnRender = false;
}

function viewLabelById(id) {
  const view = VIEW_DISPLAY_OPTIONS.find((option) => option.id === id);
  return view ? viewLabel(view) : id;
}

function openHomeSettings() {
  if (!els.settingsPanel) return;
  els.settingsPanel.classList.remove('hidden');
  els.shell.classList.add('settings-open');
  els.shell.style.transform = 'translateZ(0)';
  setSettingsSectionExpanded('main', true);
  state.homeSettingsExpanded = true;
  syncSettingsForm();
  requestAnimationFrame(() => {
    document.getElementById('homeSettingsContainer')?.scrollIntoView({ block: 'nearest' });
  });
}

function openTrendSettings() {
  if (!els.settingsPanel) return;
  els.settingsPanel.classList.remove('hidden');
  els.shell.classList.add('settings-open');
  els.shell.style.transform = 'translateZ(0)';
  setSettingsSectionExpanded('main', true);
  state.trendSettingsExpanded = true;
  syncSettingsForm();
  requestAnimationFrame(() => {
    document.getElementById('trendSettingsContainer')?.scrollIntoView({ block: 'nearest' });
  });
}

function openSettingsPanel() {
  if (!els.settingsPanel) return;
  if (state.viewSwitcherOpen) setViewSwitcherOpen(false);
  els.settingsPanel.classList.remove('hidden');
  els.shell.classList.add('settings-open');
  els.shell.style.transform = 'translateZ(0)';
  requestAnimationFrame(() => { els.shell.style.transform = ''; });
}

function openViewFromTray(viewId) {
  if (!availableBreakdownIds().includes(viewId)) return;
  if (state.viewSwitcherOpen) setViewSwitcherOpen(false);
  stopWindowShortcutRecording();
  els.settingsPanel?.classList.add('hidden');
  els.shell.classList.remove('settings-open');
  state.openSession = null;
  renderBreakdownChange(viewId, { allowHidden: true });
}

const HOME_HISTORY_MAX_RETRIES = 3;
const HOME_HISTORY_RETRY_MS = 4000;
const FIXED_PERIOD_HISTORY_MAX_RETRIES = 3;
const FIXED_PERIOD_HISTORY_RETRY_MS = 4000;

async function loadHomeHistory() {
  if (state.homeHistoryBusy || !window.tokenMonitor.getDashboardHistory) return;
  if (!homeOverviewApi.shouldFetchHomeHistory({
    requested: state.homeHistoryRequested,
    stats: state.stats,
    lastSignature: state.homeHistorySignature
  })) return;
  // The signature is recorded before the await on purpose: it stops a failed or empty
  // fetch from re-firing on the very next render (renderHome runs loadHomeHistory every
  // render), which is the #39 spin loop. A transient failure or a raced empty result is
  // recovered by the bounded timer-driven retry in the finally block instead, not by
  // render — so Home is not stranded on the 30-day preview until the history genuinely
  // changes, which for an account with history but no current activity might be never.
  const requestSignature = homeOverviewApi.homeHistorySignature(state.stats);
  const previewHadDays = homeOverviewApi.historyHasDays(state.stats?.historyPreview);
  if (state.homeHistoryRetrySignature !== requestSignature) {
    clearTimeout(state.homeHistoryRetryTimer);
    state.homeHistoryRetryTimer = null;
    state.homeHistoryRetrySignature = requestSignature;
    state.homeHistoryRetries = 0;
  }
  state.homeHistoryRequested = true;
  state.homeHistorySignature = requestSignature;
  state.homeHistoryBusy = true;
  let resolved = false;
  let fetchedHistory = null;
  try {
    // Only ever one fetch in flight (homeHistoryBusy), so the response is the freshest
    // history at invoke time and can be taken as-is — no older reply can land on top of
    // a newer one.
    fetchedHistory = await window.tokenMonitor.getDashboardHistory();
    resolved = true;
  } catch (error) {
    console.log(`[home] history failed: ${error.message}`);
  } finally {
    state.homeHistoryBusy = false;
    const outcome = homeOverviewApi.homeHistoryFetchOutcome({
      resolved,
      history: fetchedHistory,
      previewHasDays: previewHadDays
    });
    if (outcome.accepted) {
      state.homeHistory = fetchedHistory;
      state.homeHistoryLoadedSignature = requestSignature;
      state.homeHistoryRetries = 0;
      state.homeHistoryRetrySignature = '';
      clearTimeout(state.homeHistoryRetryTimer);
      state.homeHistoryRetryTimer = null;
    } else if (homeOverviewApi.shouldRetryHomeHistory({
      loadedDays: outcome.loadedDays,
      previewHasDays: previewHadDays,
      retries: state.homeHistoryRetries,
      maxRetries: HOME_HISTORY_MAX_RETRIES
    })) {
      state.homeHistoryRetries += 1;
      clearTimeout(state.homeHistoryRetryTimer);
      state.homeHistoryRetryTimer = setTimeout(() => {
        state.homeHistoryRetryTimer = null;
        // Stale display data is not proof that this signature loaded. Retry only
        // while the target is still current and no later request accepted it.
        if (state.homeHistoryLoadedSignature === requestSignature) return;
        if (homeOverviewApi.homeHistorySignature(state.stats) !== requestSignature) return;
        state.homeHistorySignature = '';
        void loadHomeHistory();
      }, HOME_HISTORY_RETRY_MS);
    }
    if (state.breakdown === 'home') render();
  }
}

function fixedPeriodTodayKey() {
  return fixedPeriodRangesApi.localDayKey();
}

function fixedPeriodHistorySignature() {
  const inventory = fixedPeriodRangesApi.deviceInventorySignature(state.stats?.devices || []);
  const revision = state.stats?.deviceHistoryRevision || state.stats?.historyRevision || '';
  return `${String(revision)}:${fixedPeriodTodayKey()}:${inventory}`;
}

function fixedPeriodHistoryInventoriesMatch(history) {
  return fixedPeriodRangesApi.deviceInventorySignature(history?.deviceHistories || [])
    === fixedPeriodRangesApi.deviceInventorySignature(state.stats?.devices || []);
}

function buildFixedPeriodSnapshot() {
  if (!fixedPeriodRangesApi.isDerived(state.period)) return { status: 'native', period: null };
  if (state.settings?.historyEnabled === false) {
    return { status: 'unavailable', reason: 'historyDisabled', period: null };
  }
  if (!state.fixedPeriodHistoryRequested) {
    return { status: 'loading', reason: 'loading', period: null };
  }
  if (state.fixedPeriodHistoryBusy) {
    const ready = fixedPeriodRangesApi.readySnapshotForSelection(
      state.fixedPeriodSnapshot,
      state.period
    );
    return ready
      ? ready
      : { status: 'loading', reason: 'loading', period: null };
  }
  if (state.fixedPeriodHistoryFailed) {
    return { status: 'unavailable', reason: 'historyUnavailable', period: null };
  }
  return buildFixedPeriodSourcesSnapshot();
}

async function performFixedPeriodHistoryLoad({ force = false, signature = fixedPeriodHistorySignature() } = {}) {
  if (!window.tokenMonitor.getDashboardHistory) return false;
  if (!force && state.fixedPeriodHistoryRequested && state.fixedPeriodHistorySignature === signature) return false;
  if (state.fixedPeriodHistoryRetrySignature !== signature) {
    clearTimeout(state.fixedPeriodHistoryRetryTimer);
    state.fixedPeriodHistoryRetryTimer = null;
    state.fixedPeriodHistoryRetrySignature = signature;
    state.fixedPeriodHistoryRetries = 0;
  }
  state.fixedPeriodHistoryRequested = true;
  state.fixedPeriodHistoryBusy = true;
  state.fixedPeriodHistoryFailed = false;
  state.fixedPeriodHistorySignature = signature;
  if (state.fixedPeriodSnapshot?.status !== 'ready') {
    state.fixedPeriodSnapshot = { status: 'loading', reason: 'loading', period: null };
  }
  let fetchedHistory = null;
  let failed = false;
  try {
    fetchedHistory = await window.tokenMonitor.getDashboardHistory({ includeDevices: true });
  } catch (error) {
    console.log(`[period] history failed: ${error.message}`);
    failed = true;
  } finally {
    state.fixedPeriodHistoryBusy = false;
    const requestIsCurrent = fixedPeriodHistorySignature() === signature;
    if (requestIsCurrent) {
      state.fixedPeriodHistoryFailed = failed;
      state.fixedPeriodHistory = failed ? null : fetchedHistory;
      const inventoryMatches = !failed && fixedPeriodHistoryInventoriesMatch(fetchedHistory);
      if (inventoryMatches) {
        state.fixedPeriodHistoryRetries = 0;
        state.fixedPeriodHistoryRetrySignature = '';
        clearTimeout(state.fixedPeriodHistoryRetryTimer);
        state.fixedPeriodHistoryRetryTimer = null;
      } else if (fixedPeriodRangesApi.shouldRetryFixedPeriodHistory({
        signature,
        currentSignature: fixedPeriodHistorySignature(),
        retries: state.fixedPeriodHistoryRetries,
        maxRetries: FIXED_PERIOD_HISTORY_MAX_RETRIES,
        failed,
        inventoryMatches
      })) {
        state.fixedPeriodHistoryRetries += 1;
        clearTimeout(state.fixedPeriodHistoryRetryTimer);
        state.fixedPeriodHistoryRetryTimer = setTimeout(() => {
          state.fixedPeriodHistoryRetryTimer = null;
          if (fixedPeriodHistorySignature() !== signature) return;
          if (!state.fixedPeriodHistoryFailed
            && fixedPeriodHistoryInventoriesMatch(state.fixedPeriodHistory)) return;
          void loadFixedPeriodHistory({ force: true });
        }, FIXED_PERIOD_HISTORY_RETRY_MS);
      }
      state.fixedPeriodSnapshot = buildFixedPeriodSnapshot();
      if (state.fixedPeriodSnapshot.status === 'ready' && state.stats?.periods) {
        state.stats.periods[state.period] = state.fixedPeriodSnapshot.period;
      }
    }
  }
  return true;
}

function fixedPeriodHistoryCoordinator() {
  if (!state.fixedPeriodHistoryCoordinator) {
    state.fixedPeriodHistoryCoordinator = fixedPeriodRangesApi.createLatestRequestCoordinator({
      signature: fixedPeriodHistorySignature,
      load: performFixedPeriodHistoryLoad,
      onSettled: ({ render: shouldRender }) => {
        if (shouldRender && fixedPeriodRangesApi.isDerived(state.period)) {
          statsRenderScheduler.request();
        }
      }
    });
  }
  return state.fixedPeriodHistoryCoordinator;
}

function loadFixedPeriodHistory(options = {}) {
  const promise = fixedPeriodHistoryCoordinator().request(options);
  state.fixedPeriodHistoryPromise = promise;
  const clearPromise = () => {
    if (state.fixedPeriodHistoryPromise === promise) state.fixedPeriodHistoryPromise = null;
  };
  void promise.then(clearPromise, clearPromise);
  return promise;
}

function resetFixedPeriodHistoryRetryBudget() {
  clearTimeout(state.fixedPeriodHistoryRetryTimer);
  state.fixedPeriodHistoryRetryTimer = null;
  state.fixedPeriodHistoryRetrySignature = '';
  state.fixedPeriodHistoryRetries = 0;
}

function fixedPeriodHistoryNeedsWarmup(options = {}) {
  return fixedPeriodRangesApi.shouldWarmFixedPeriodHistory({
    hasStats: Boolean(state.stats),
    historyEnabled: state.settings?.historyEnabled !== false,
    apiAvailable: Boolean(window.tokenMonitor.getDashboardHistory),
    active: fixedPeriodHistoryCoordinator().active(),
    force: options.force === true,
    retryFailed: options.retryFailed === true,
    failed: state.fixedPeriodHistoryFailed,
    requested: state.fixedPeriodHistoryRequested,
    loadedSignature: state.fixedPeriodHistorySignature,
    currentSignature: fixedPeriodHistorySignature()
  });
}

async function warmFixedPeriodHistory(options = {}) {
  if (!fixedPeriodHistoryNeedsWarmup(options)) return false;
  const explicitRecovery = options.force === true
    || (options.retryFailed === true && state.fixedPeriodHistoryFailed);
  if (explicitRecovery) resetFixedPeriodHistoryRetryBudget();
  await loadFixedPeriodHistory({
    force: explicitRecovery,
    renderOnComplete: options.renderOnComplete === true
  });
  return true;
}

function fixedPeriodMessage(snapshot, breakdown = '') {
  if (snapshot?.status === 'loading') return t('periodRange.loading');
  if (breakdown === 'session') return t('periodRange.sessionUnavailable');
  if (breakdown === 'project') return t('periodRange.projectUnavailable');
  if (snapshot?.reason === 'historyDisabled') return t('periodRange.historyDisabled');
  if (snapshot?.reason === 'historyUnavailable') return t('periodRange.historyUnavailable');
  return t('periodRange.historyUnavailable');
}

function hidePeriodContentForMessage(message) {
  els.fixedPeriodMessage.textContent = message;
  els.fixedPeriodMessage.classList.remove('hidden');
  els.homePanel.classList.add('hidden');
  els.breakdown.classList.add('hidden');
  els.serviceStatusPanel?.classList.add('hidden');
  els.limitsPanel.classList.add('hidden');
  els.trendsPanel.classList.add('hidden');
  els.sessionDetail.classList.add('hidden');
  els.sessionDetailHead.classList.add('hidden');
}

function periodMenuButtons() {
  return Array.from(els.monthPeriodMenu?.querySelectorAll('[data-fixed-period]') || []);
}

function focusPeriodMenuButton(index) {
  const buttons = periodMenuButtons();
  if (!buttons.length) return;
  const target = buttons[Math.max(0, Math.min(buttons.length - 1, Number(index) || 0))];
  for (const button of buttons) button.tabIndex = button === target ? 0 : -1;
  target?.focus();
}

function setPeriodMenuOpen(open, { restoreFocus = false, focus = '' } = {}) {
  state.periodMenuOpen = Boolean(open);
  els.monthPeriodMenu?.closest('.titlebar')?.classList.toggle('period-menu-open', state.periodMenuOpen);
  els.monthPeriodMenu?.classList.toggle('hidden', !state.periodMenuOpen);
  els.monthPeriodTab?.setAttribute('aria-expanded', String(state.periodMenuOpen));
  for (const button of periodMenuButtons()) {
    button.tabIndex = state.periodMenuOpen && button.classList.contains('is-current') ? 0 : -1;
  }
  if (state.periodMenuOpen && focus) {
    const buttons = periodMenuButtons();
    const current = Math.max(0, buttons.findIndex((button) => button.classList.contains('is-current')));
    focusPeriodMenuButton(focus === 'first' ? 0 : focus === 'last' ? buttons.length - 1 : current);
  }
  if (!state.periodMenuOpen && restoreFocus) els.monthPeriodTab?.focus();
}

function syncPeriodMenu() {
  const mode = fixedPeriodRangesApi.slotForSelection(state.period) === 'month'
    ? fixedPeriodRangesApi.normalizeMonthMode(state.period)
    : fixedPeriodRangesApi.normalizeMonthMode(state.settings?.periodMonthMode);
  for (const button of periodMenuButtons()) {
    const active = button.dataset.fixedPeriod === mode;
    button.classList.toggle('is-current', active);
    button.setAttribute('aria-checked', String(active));
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
    button.tabIndex = state.periodMenuOpen && active ? 0 : -1;
  }
}

function homeModuleIds() {
  const hidden = hiddenHomeModuleSet();
  return homeModulePreferencesApi
    .orderedHomeModules(HOME_MODULE_OPTIONS, state.settings?.homeModuleOrder)
    .map((module) => module.id)
    .filter((id) => !hidden.has(id));
}

function nextBreakdown(value) {
  const order = visibleBreakdownOrder();
  if (order.length === 0) return 'home';
  const index = order.indexOf(value);
  return order[(index + 1) % order.length] || order[0];
}

function viewSwitcherIcon(id) {
  const icon = document.createElement('span');
  icon.className = `view-switcher-icon ${VIEW_ICON_CLASSES[id] || 'view-icon-home'}`;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function clearViewSwitcherLongPress() {
  if (viewSwitcherLongPressTimer) clearTimeout(viewSwitcherLongPressTimer);
  viewSwitcherLongPressTimer = null;
}

function clearViewSwitcherHoverClose() {
  if (viewSwitcherHoverCloseTimer) clearTimeout(viewSwitcherHoverCloseTimer);
  viewSwitcherHoverCloseTimer = null;
}

function scheduleViewSwitcherHoverClose() {
  clearViewSwitcherHoverClose();
  viewSwitcherHoverCloseTimer = setTimeout(() => {
    viewSwitcherHoverCloseTimer = null;
    if (state.viewSwitcherOpen) setViewSwitcherOpen(false);
  }, VIEW_SWITCHER_HOVER_CLOSE_MS);
}

function updateViewSwitcherOpenState({ focusMenu = false, focusDisclosure = false } = {}) {
  if (!els.viewSwitcher) return false;
  const menu = els.viewSwitcher.querySelector('#viewSwitcherMenu');
  const disclosure = els.viewSwitcher.querySelector('.view-switcher-disclosure');
  if (!menu || !disclosure) return false;

  els.viewSwitcher.classList.toggle('is-open', state.viewSwitcherOpen);
  els.viewSwitcher.classList.toggle('has-opened', state.viewSwitcherHasOpened);
  disclosure.setAttribute('aria-expanded', String(state.viewSwitcherOpen));
  menu.classList.toggle('hidden', !state.viewSwitcherOpen);
  menu.setAttribute('aria-hidden', String(!state.viewSwitcherOpen));
  for (const item of menu.querySelectorAll('.view-switcher-menu-item')) {
    item.tabIndex = state.viewSwitcherOpen && item.classList.contains('is-current') ? 0 : -1;
  }
  if (focusMenu) requestAnimationFrame(() => menu.querySelector('.is-current')?.focus());
  if (focusDisclosure) requestAnimationFrame(() => disclosure.focus());
  return true;
}

function setViewSwitcherOpen(open, { focusMenu = false, focusDisclosure = false } = {}) {
  const nextOpen = Boolean(open);
  if (state.viewSwitcherOpen === nextOpen && !focusMenu && !focusDisclosure) return;
  if (nextOpen) state.viewSwitcherHasOpened = true;
  state.viewSwitcherOpen = nextOpen;
  if (updateViewSwitcherOpenState({ focusMenu, focusDisclosure })) return;
  renderViewSwitcher({ focusMenu, focusDisclosure });
}

function renderViewSwitcher({ focusMenu = false, focusDisclosure = false } = {}) {
  if (!els.viewSwitcher) return;
  const order = visibleBreakdownOrder();
  const currentId = order.includes(state.breakdown) ? state.breakdown : (order[0] || 'home');
  const currentLabel = viewLabelById(currentId);
  const nextId = nextBreakdown(currentId);
  const nextLabel = viewLabelById(nextId);

  const current = document.createElement('button');
  current.type = 'button';
  current.className = 'view-switcher-current';
  current.title = t('views.switcher.next', { view: nextLabel });
  current.setAttribute('aria-label', current.title);
  current.append(viewSwitcherIcon(currentId));
  const label = document.createElement('span');
  label.className = 'view-switcher-label';
  label.textContent = currentLabel;
  current.append(label);
  current.addEventListener('click', () => {
    if (viewSwitcherLongPressTriggered) {
      viewSwitcherLongPressTriggered = false;
      return;
    }
    state.viewSwitcherOpen = false;
    updateViewSwitcherOpenState();
    renderBreakdownChange(nextBreakdown(state.breakdown));
  });
  current.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    clearViewSwitcherLongPress();
    viewSwitcherLongPressTriggered = false;
    viewSwitcherLongPressTimer = setTimeout(() => {
      viewSwitcherLongPressTimer = null;
      viewSwitcherLongPressTriggered = true;
      setViewSwitcherOpen(true, { focusMenu: true });
    }, VIEW_SWITCHER_LONG_PRESS_MS);
  });
  current.addEventListener('pointerleave', clearViewSwitcherLongPress);
  current.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    clearViewSwitcherLongPress();
    setViewSwitcherOpen(true, { focusMenu: true });
  });

  const disclosure = document.createElement('button');
  disclosure.type = 'button';
  disclosure.className = 'view-switcher-disclosure';
  disclosure.title = t('views.switcher.choose');
  disclosure.setAttribute('aria-label', disclosure.title);
  disclosure.setAttribute('aria-haspopup', 'menu');
  disclosure.setAttribute('aria-controls', 'viewSwitcherMenu');
  disclosure.setAttribute('aria-expanded', String(state.viewSwitcherOpen));
  disclosure.addEventListener('pointerenter', (event) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    clearViewSwitcherHoverClose();
    if (!state.viewSwitcherOpen) setViewSwitcherOpen(true);
  });
  disclosure.addEventListener('click', (event) => {
    if (event.detail > 0 && state.viewSwitcherOpen) return;
    const open = !state.viewSwitcherOpen;
    setViewSwitcherOpen(open, { focusMenu: open });
  });

  const menu = document.createElement('div');
  menu.id = 'viewSwitcherMenu';
  menu.className = `view-switcher-menu${state.viewSwitcherOpen ? '' : ' hidden'}`;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('views.switcher.choose'));
  menu.setAttribute('aria-hidden', String(!state.viewSwitcherOpen));
  for (const id of order) {
    const item = document.createElement('button');
    const active = id === currentId;
    item.type = 'button';
    item.className = `view-switcher-menu-item${active ? ' is-current' : ''}`;
    item.dataset.view = id;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(active));
    if (active) item.setAttribute('aria-current', 'page');
    item.tabIndex = state.viewSwitcherOpen ? (active ? 0 : -1) : -1;
    item.append(viewSwitcherIcon(id));
    const itemLabel = document.createElement('span');
    itemLabel.className = 'view-switcher-menu-label';
    itemLabel.textContent = viewLabelById(id);
    item.append(itemLabel);
    item.addEventListener('click', () => {
      state.viewSwitcherOpen = false;
      updateViewSwitcherOpenState();
      if (id === state.breakdown) renderViewSwitcher({ focusDisclosure: true });
      else renderBreakdownChange(id);
    });
    menu.append(item);
  }
  menu.addEventListener('keydown', (event) => {
    const items = Array.from(menu.querySelectorAll('.view-switcher-menu-item'));
    if (event.key === 'Escape') {
      event.preventDefault();
      setViewSwitcherOpen(false, { focusDisclosure: true });
      return;
    }
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? 1
      : (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0);
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const currentIndex = Math.max(0, items.indexOf(document.activeElement));
    const nextIndex = event.key === 'Home'
      ? 0
      : (event.key === 'End' ? items.length - 1 : (currentIndex + direction + items.length) % items.length);
    items[nextIndex]?.focus();
  });

  els.viewSwitcher.classList.toggle('is-open', state.viewSwitcherOpen);
  els.viewSwitcher.classList.toggle('has-opened', state.viewSwitcherHasOpened);
  els.viewSwitcher.replaceChildren(current, disclosure, menu);
  if (focusMenu) requestAnimationFrame(() => menu.querySelector('.is-current')?.focus());
  if (focusDisclosure) requestAnimationFrame(() => disclosure.focus());
}

function homeModuleShell(kind, title, viewId, meta = '') {
  const module = document.createElement('section');
  module.className = `home-module home-module-${kind}`;
  module.tabIndex = 0;
  module.setAttribute('role', 'button');
  module.setAttribute('aria-label', title);
  module.addEventListener('click', (event) => {
    if (event.target.closest('.home-activity-scroll')) return;
    renderBreakdownChange(viewId, { fromHome: true });
  });
  module.addEventListener('keydown', (event) => {
    if (event.target !== module) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    renderBreakdownChange(viewId, { fromHome: true });
  });
  const head = document.createElement('div');
  head.className = 'home-module-head';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'home-module-title-wrap';
  const label = document.createElement('span');
  label.className = 'home-module-label';
  label.textContent = title;
  titleWrap.append(label);
  const end = document.createElement('div');
  end.className = 'home-module-head-end';
  if (meta) {
    const metaText = document.createElement('span');
    metaText.className = 'home-module-meta';
    metaText.textContent = meta;
    end.append(metaText);
  }
  const icon = document.createElement('span');
  icon.className = `home-module-jump ${VIEW_ICON_CLASSES[viewId] || ''}`;
  icon.setAttribute('aria-hidden', 'true');
  end.append(icon);
  head.append(titleWrap, end);
  const body = document.createElement('div');
  body.className = 'home-module-body';
  module.append(head, body);
  return { module, body };
}

function homeLimitRows() {
  const enabled = enabledLimitProviderSet();
  const providerOrder = state.settings?.homeLimitProviderOrder || state.settings?.limitProviderOrder;
  const providerOptions = limitProviderOrderApi.orderedLimitProviders(LIMIT_PROVIDERS, providerOrder);
  const hasConfiguredOrder = Boolean(state.settings?.homeLimitProviderOrder);
  return homeOverviewApi.homeLimitAccountsForProviders({
    providers: (state.stats?.limits?.providers || []).map((provider) => ({
      ...provider,
      windows: limitProviderPresentationApi.limitProviderCompactWindows(provider, provider.windows)
    })),
    providerOptions,
    enabledProviderIds: Array.from(enabled),
    hiddenProviderIds: Array.from(hiddenHomeLimitProviderSet()),
    colors: clientColors,
    limit: state.settings?.homeLimitAccountCount ?? 3,
    sort: hasConfiguredOrder ? 'configured' : 'remaining',
    accountName: (provider, index, providerEntries) => {
      const id = String(provider?.provider || '').trim().toLowerCase();
      const option = providerOptions.find((entry) => entry.id === id);
      const providerTitle = option?.label || id;
      if (providerEntries.length > 1) {
        const accountTitle = limitAccountTitle(id, provider, index, providerEntries);
        return state.settings?.showHomeLimitProviderNames === true || state.settings?.showToolIcons === false
          ? `${providerTitle} · ${accountTitle}`
          : accountTitle;
      }
      return providerTitle;
    }
  });
}

function homeLimitWindowLabel(window, providerId = '', visibleWindows = []) {
  const compactLabel = limitProviderPresentationApi.limitProviderCompactWindowLabel(providerId, window, visibleWindows);
  if (compactLabel) return compactLabel;
  if (window?.kind === 'billing') {
    const label = String(window?.label || '').trim();
    if (label) return label;
  }
  const key = {
    session: 'home.limit.session',
    weekly: 'home.limit.weekly',
    billing: 'home.limit.billing',
    monthly: 'home.limit.monthly'
  }[window.kind];
  if (key) return t(key);
  return window.label;
}

function renderHomeLimitModule() {
  const { module, body } = homeModuleShell('limits', t('home.limits'), 'limits');
  const rows = homeLimitRows();
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-module-empty';
    empty.textContent = t('home.noLimits');
    body.append(empty);
    return module;
  }
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'home-limit-account';
    const account = document.createElement('div');
    account.className = 'home-limit-account-head';
    const mark = document.createElement('span');
    applyHomeListMark(mark, iconKindFor({ key: row.providerId || row.key }, 'limits'), row.color);
    const name = document.createElement('span');
    name.className = 'home-list-name';
    name.textContent = row.name;
    account.append(mark, name);
    const windows = document.createElement('div');
    windows.className = 'home-limit-windows';
    for (const window of row.windows) {
      const metric = document.createElement('div');
      metric.className = 'home-limit-window';
      const line = document.createElement('div');
      line.className = 'home-limit-window-line';
      const label = document.createElement('span');
      label.className = 'home-limit-window-label';
      label.textContent = homeLimitWindowLabel(window, row.providerId, row.windows);
      const value = document.createElement('span');
      value.className = 'home-list-value';
      const showUsed = Boolean(state.settings?.showLimitUsed);
      value.textContent = window.value || formatHomeLimitWindowValue(window, showUsed);
      if (state.settings?.showHomeLimitBars === true && window.remainingPercent != null) {
        const remainingPercent = Math.max(0, Math.min(100, Number(window.remainingPercent) || 0));
        if (remainingPercent < 20) {
          value.classList.add('home-limit-value-critical');
        } else if (remainingPercent < 50) {
          value.classList.add('home-limit-value-low');
          value.style.setProperty('--home-limit-accent', row.color);
        }
      }
      line.append(label, value);
      metric.append(line);
      const resetAt = formatReset(window.resetsAt);
      const resetLabel = window.resetsAt
        ? resetAt || ''
        : window.resetDescription
        ? t('home.reset', { value: window.resetDescription })
        : '';
      if (resetLabel) {
        const resetText = document.createElement('span');
        resetText.className = 'home-limit-reset';
        const periodLabel = limitProviderPresentationApi.limitProviderCompactWindowPeriodLabel(row.providerId, window, row.windows);
        resetText.textContent = periodLabel ? `${periodLabel} · ${resetLabel}` : resetLabel;
        metric.append(resetText);
      }
      windows.append(metric);
    }
    item.append(account, windows);
    body.append(item);
  }
  return module;
}

function renderHomeModelModule(period) {
  const { module, body } = homeModuleShell('model', t('home.models'), 'model');
  const rows = homeOverviewApi.homeModelRows(modelRowsForPeriod(period), period?.totalTokens, 5);
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-module-empty';
    empty.textContent = t('home.noModels');
    body.append(empty);
    return module;
  }
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'home-list-row home-model-row';
    const mark = document.createElement('span');
    applyHomeListMark(mark, iconKindFor({ key: row.key || row.name }, 'model'), row.color);
    const name = document.createElement('span');
    name.className = 'home-list-name';
    name.textContent = row.name;
    const value = document.createElement('span');
    value.className = 'home-list-value';
    value.textContent = formatCompact(row.value);
    const share = document.createElement('span');
    share.className = 'home-list-aux';
    share.textContent = formatPercent(row.share * 100);
    item.append(mark, name, value, share);
    body.append(item);
  }
  return module;
}

function homeToolSourceRows(period) {
  return periodAttributionRows(period, period?.clients, period?.clientCosts).map(({ key: client, value }) => ({
    key: client,
    name: client === usageAttributionRowsApi.UNATTRIBUTED_KEY ? t('dashboard.tooltip.unclassified') : clientLabels[client] || client,
    value: Number(value || 0),
    color: clientColors[client] || clientColors.default
  }));
}

function renderHomeToolModule(period) {
  const { module, body } = homeModuleShell('tool', t('home.tools'), 'tool');
  const rows = homeOverviewApi.homeToolRows(homeToolSourceRows(period), period?.totalTokens, 5);
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-module-empty';
    empty.textContent = t('home.noTools');
    body.append(empty);
    return module;
  }
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'home-list-row home-tool-row';
    const mark = document.createElement('span');
    applyHomeListMark(mark, iconKindFor({ key: row.key }, 'tool'), row.color);
    const name = document.createElement('span');
    name.className = 'home-list-name';
    name.textContent = row.name;
    const value = document.createElement('span');
    value.className = 'home-list-value';
    value.textContent = formatCompact(row.value);
    const share = document.createElement('span');
    share.className = 'home-list-aux';
    share.textContent = formatPercent(row.share * 100);
    item.append(mark, name, value, share);
    body.append(item);
  }
  return module;
}

function renderHomeDeviceModule() {
  const { module, body } = homeModuleShell('device', t('home.devices'), 'device');
  const rows = homeOverviewApi.homeDeviceRows(fixedPeriodDevices(), {
    localDeviceId: state.settings?.deviceId || '',
    period: state.period,
    limit: 4
  });
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-module-empty';
    empty.textContent = t('home.noDevices');
    body.append(empty);
    return module;
  }
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'home-list-row home-device-row';
    if (row.isStale) {
      item.classList.add('is-stale');
      item.title = t('home.staleDevice');
    }
    const mark = document.createElement('span');
    applyHomeListMark(mark, iconKindFor({ platform: row.platform }, 'device'), row.isStale ? deviceStaleColor : deviceAccent);
    const label = document.createElement('span');
    label.className = 'home-list-name home-device-label';
    const name = document.createElement('span');
    name.className = 'home-device-name';
    name.textContent = row.name;
    label.append(name);
    if (row.isLocal) {
      const badge = document.createElement('span');
      badge.className = 'home-device-badge';
      badge.textContent = 'you';
      label.append(badge);
    }
    const value = document.createElement('span');
    value.className = 'home-list-value';
    value.textContent = formatCompact(row.value);
    item.append(mark, label, value);
    body.append(item);
  }
  return module;
}

function dailyWithHeatIntensity(daily) {
  return window.TokenMonitorUsageCharts.computeHeatmapIntensities(daily);
}

const homeActivityProgrammaticScrollers = new WeakSet();

function applyHomeActivityScroll(scroller) {
  const target = homeOverviewApi.homeActivityScrollTarget({
    scrollWidth: scroller.scrollWidth,
    clientWidth: scroller.clientWidth,
    followEnd: state.homeActivityFollowEnd,
    savedLeft: state.homeActivityScrollLeft
  });
  if (Math.abs(scroller.scrollLeft - target) > 0.5) {
    homeActivityProgrammaticScrollers.add(scroller);
    scroller.scrollLeft = target;
  }
  scroller.classList.toggle('is-scrolled', target > 2);
}

function setupHomeActivityScroller(scroller, onReady = null) {
  let drag = null;
  let readySignaled = false;
  const applySettledLayout = () => {
    applyHomeActivityScroll(scroller);
    if (readySignaled || typeof onReady !== 'function') return;
    const svg = scroller.querySelector('.dash-heatmap');
    if (scroller.clientWidth <= 0 || !svg || svg.getBoundingClientRect().width <= 0) return;
    readySignaled = true;
    onReady();
  };
  scroller.addEventListener('scroll', () => {
    scroller.classList.toggle('is-scrolled', scroller.scrollLeft > 2);
    const record = homeOverviewApi.homeActivityScrollRecord({
      scrollLeft: scroller.scrollLeft,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth
    });
    if (!record) return; // not laid out / panel hidden — don't persist a bogus position
    state.homeActivityScrollLeft = record.scrollLeft;
    state.homeActivityFollowEnd = record.followEnd;
  });
  scroller.addEventListener('click', (event) => event.stopPropagation());
  scroller.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    event.preventDefault();
    drag = { x: event.clientX, left: scroller.scrollLeft };
    scroller.classList.add('is-dragging');
    scroller.setPointerCapture?.(event.pointerId);
  });
  scroller.addEventListener('pointermove', (event) => {
    if (!drag) return;
    event.preventDefault();
    scroller.scrollLeft = drag.left - (event.clientX - drag.x);
  });
  const endDrag = (event) => {
    if (!drag) return;
    drag = null;
    scroller.classList.remove('is-dragging');
    if (scroller.hasPointerCapture?.(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
  };
  scroller.addEventListener('pointerup', endDrag);
  scroller.addEventListener('pointercancel', endDrag);

  // Land on the newest (right) column only after the browser has actually laid the
  // heatmap out. A single requestAnimationFrame measures before layout settles on a
  // cold window (far more often on Windows), reads scrollWidth === clientWidth, and
  // sticks at the oldest edge. ResizeObserver delivers post-layout and also fires once
  // the panel becomes visible / the window resizes, so the measurement is always real.
  state.homeActivityResizeObserver?.disconnect();
  if (typeof ResizeObserver === 'function') {
    state.homeActivityResizeObserver = new ResizeObserver(applySettledLayout);
    state.homeActivityResizeObserver.observe(scroller);
  } else if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(applySettledLayout));
  }
  applyHomeActivityScroll(scroller);
}

function homeActivityTooltipEl() {
  let tooltip = document.querySelector('.home-activity-tooltip');
  if (tooltip) return tooltip;
  tooltip = document.createElement('div');
  tooltip.className = 'home-activity-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.setAttribute('aria-hidden', 'true');

  const count = document.createElement('span');
  count.className = 'home-activity-tooltip-count';
  count.dataset.homeActivityTooltipCount = 'true';

  const label = document.createElement('span');
  label.className = 'home-activity-tooltip-label';
  label.dataset.homeActivityTooltipLabel = 'true';
  label.textContent = 'tokens';

  const date = document.createElement('span');
  date.className = 'home-activity-tooltip-date';
  date.dataset.homeActivityTooltipDate = 'true';

  const row = document.createElement('span');
  row.className = 'home-activity-tooltip-row';
  row.append(count, label);
  tooltip.append(row, date);
  document.body.append(tooltip);
  return tooltip;
}

function moveHomeActivityTooltip(tooltip, cell) {
  const cellRect = cell.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const gap = 9;
  const pad = 6;
  const desiredX = cellRect.left + cellRect.width / 2;
  const x = Math.max(pad + tooltipRect.width / 2, Math.min(window.innerWidth - pad - tooltipRect.width / 2, desiredX));
  const aboveY = cellRect.top - tooltipRect.height - gap;
  const belowY = cellRect.bottom + gap;
  const y = aboveY >= pad ? aboveY : Math.min(window.innerHeight - pad - tooltipRect.height, belowY);
  tooltip.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`;
}

function setupHomeActivityHover(scroller) {
  const canvas = scroller.querySelector('.home-activity-canvas');
  const svg = canvas?.querySelector('.dash-heatmap');
  const gradient = svg?.querySelector('#homeActivitySpotlightGradient');
  const tooltip = homeActivityTooltipEl();
  let activeCell = null;
  let spotlightFrame = 0;
  let spotlightVisible = false;
  const spotlightTarget = { x: -200, y: -200 };
  const spotlightCurrent = { x: -200, y: -200 };

  const setSpotlight = (point) => {
    gradient?.setAttribute('cx', String(Math.round(point.x * 10) / 10));
    gradient?.setAttribute('cy', String(Math.round(point.y * 10) / 10));
  };

  const scheduleSpotlight = () => {
    if (spotlightFrame || !gradient) return;
    spotlightFrame = requestAnimationFrame(() => {
      spotlightFrame = 0;
      const dx = spotlightTarget.x - spotlightCurrent.x;
      const dy = spotlightTarget.y - spotlightCurrent.y;
      if (Math.abs(dx) < 0.12 && Math.abs(dy) < 0.12) {
        spotlightCurrent.x = spotlightTarget.x;
        spotlightCurrent.y = spotlightTarget.y;
      } else {
        spotlightCurrent.x += dx * 0.32;
        spotlightCurrent.y += dy * 0.32;
        scheduleSpotlight();
      }
      setSpotlight(spotlightCurrent);
    });
  };

  const moveSpotlight = (x, y) => {
    spotlightTarget.x = x;
    spotlightTarget.y = y;
    if (!spotlightVisible) {
      spotlightVisible = true;
      spotlightCurrent.x = x;
      spotlightCurrent.y = y;
      setSpotlight(spotlightCurrent);
      return;
    }
    scheduleSpotlight();
  };

  const hide = ({ clearHover = true, concealTooltip = true } = {}) => {
    if (clearHover) {
      state.homeActivityHoverPoint = null;
      state.homeActivityHoverDate = '';
    }
    if (concealTooltip) {
      tooltip.dataset.visible = 'false';
      tooltip.setAttribute('aria-hidden', 'true');
      tooltip.style.transform = 'translate(-9999px, -9999px)';
    }
    if (spotlightFrame) cancelAnimationFrame(spotlightFrame);
    spotlightFrame = 0;
    spotlightVisible = false;
    spotlightTarget.x = -200;
    spotlightTarget.y = -200;
    spotlightCurrent.x = -200;
    spotlightCurrent.y = -200;
    setSpotlight(spotlightCurrent);
    if (activeCell) activeCell.removeAttribute('data-active');
    activeCell = null;
  };

  const showAtPoint = (clientX, clientY, target) => {
    if (!svg || scroller.classList.contains('is-dragging')) {
      hide();
      return;
    }
    const rect = svg.getBoundingClientRect();
    const view = svg.viewBox.baseVal;
    const x = view.x + (clientX - rect.left) * view.width / Math.max(1, rect.width);
    const y = view.y + (clientY - rect.top) * view.height / Math.max(1, rect.height);
    moveSpotlight(x, y);

    const targetCell = target instanceof Element ? target.closest('.heat[data-d]') : null;
    const cell = targetCell && canvas.contains(targetCell) ? targetCell : null;
    if (!cell) {
      hide();
      return;
    }
    state.homeActivityHoverPoint = { x: clientX, y: clientY };
    state.homeActivityHoverDate = cell.dataset.d || '';
    if (activeCell !== cell) {
      activeCell?.removeAttribute('data-active');
      activeCell = cell;
      activeCell.setAttribute('data-active', 'true');
      tooltip.querySelector('[data-home-activity-tooltip-count]').textContent = formatCompact(Number(cell.dataset.t || 0));
      tooltip.querySelector('[data-home-activity-tooltip-label]').textContent = 'tokens';
      tooltip.querySelector('[data-home-activity-tooltip-date]').textContent = cell.dataset.d || '';
    }
    tooltip.dataset.visible = 'true';
    tooltip.setAttribute('aria-hidden', 'false');
    moveHomeActivityTooltip(tooltip, cell);
  };

  scroller.addEventListener('pointermove', (event) => {
    showAtPoint(event.clientX, event.clientY, event.target);
  });
  scroller.addEventListener('pointerleave', () => hide());
  scroller.addEventListener('scroll', () => {
    // Restoring the saved/right-edge position emits a delayed scroll event. It is not
    // user intent and must not clear the hover that renderHome just reconnected.
    if (homeActivityProgrammaticScrollers.delete(scroller)) {
      state.homeActivityHoverRestore?.();
      return;
    }
    hide();
  });
  // The tooltip lives on document.body and is only dismissed by handlers on this
  // scroller, which renderHome() throws away on every rebuild. Preserve the visible
  // tooltip plus its semantic cell identity across that replacement, so live stats
  // refreshes do not fade or jump it before the new cell is ready.
  state.homeActivityHoverTeardown = ({ preserveHover = false } = {}) => hide({
    clearHover: !preserveHover,
    concealTooltip: !preserveHover
  });
  state.homeActivityHoverRestore = () => {
    const point = state.homeActivityHoverPoint;
    const date = state.homeActivityHoverDate;
    if (!point || !date) return;
    const cell = Array.from(canvas?.querySelectorAll('.heat[data-d]') || [])
      .find((candidate) => candidate.dataset.d === date);
    if (!cell) {
      hide();
      return;
    }
    const rect = cell.getBoundingClientRect();
    const hitSlop = 2;
    const stillHovered = point.x >= rect.left - hitSlop
      && point.x <= rect.right + hitSlop
      && point.y >= rect.top - hitSlop
      && point.y <= rect.bottom + hitSlop;
    if (!stillHovered) {
      hide();
      return;
    }
    showAtPoint(point.x, point.y, cell);
  };
}

// Dismiss the body-level activity tooltip + spotlight from outside the scroller's own
// pointer handlers. A Home rerender may preserve the active hover for the replacement
// scroller; leaving Home clears it. Dropping both closures lets the old SVG be collected.
function hideHomeActivityTooltip({ preserveHover = false } = {}) {
  const teardown = state.homeActivityHoverTeardown;
  teardown?.({ preserveHover });
  state.homeActivityHoverTeardown = null;
  state.homeActivityHoverRestore = null;
  if (!preserveHover) {
    state.homeActivityHoverPoint = null;
    state.homeActivityHoverDate = '';
    if (!teardown) {
      const tooltip = document.querySelector('.home-activity-tooltip');
      if (tooltip) {
        tooltip.dataset.visible = 'false';
        tooltip.setAttribute('aria-hidden', 'true');
        tooltip.style.transform = 'translate(-9999px, -9999px)';
      }
    }
  }
}

function renderHomeTrendsModule() {
  const charts = window.TokenMonitorUsageCharts;
  const historyEnabled = state.settings?.historyEnabled !== false;
  const preview = state.stats?.historyPreview || { daily: [] };
  const history = homeOverviewApi.pickHomeHistory(state.homeHistory, preview);
  const rawDaily = history.daily || [];
  if (!historyEnabled || rawDaily.length === 0) {
    const { module, body } = homeModuleShell('trends', t('home.activity'), 'trends');
    const empty = document.createElement('div');
    empty.className = 'home-module-empty';
    if (historyEnabled) {
      empty.textContent = state.trendsActivating ? t('home.historyLoading') : t('home.noHistory');
    } else {
      const text = document.createElement('span');
      text.textContent = t('home.historyDisabled');
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'home-module-empty-action';
      action.textContent = t('home.enableHistory');
      action.addEventListener('click', (event) => {
        event.stopPropagation();
        openTrendSettings();
      });
      empty.append(text, action);
    }
    body.append(empty);
    return module;
  }
  // The snapshot's today bucket lags the live headline total between history ticks;
  // patch today's tokens with the live period total (like the trends sparkline's
  // patchTodayBar) so the heatmap and trend line match the number shown above them.
  // The key must be the LOCAL day: the period being patched in is local-day scoped.
  const today = charts.localDayKey();
  const todayPeriod = state.stats?.periods?.today;
  const points = homeOverviewApi.patchDailyToday(
    rawDaily,
    today,
    Number(todayPeriod?.totalTokens || 0),
    Number(todayPeriod?.costUsd || 0)
  );
  const activityLayout = homeOverviewApi.homeActivityHeatmapLayout();
  const heatMetric = state.settings?.heatmapMetric || 'cost';
  const intensityField = heatMetric === 'cost' ? 'costIntensity' : 'tokenIntensity';
  const intensityPoints = dailyWithHeatIntensity(points).map((p) => ({
    ...p,
    intensity: Number(p[intensityField] ?? p.intensity ?? 0)
  }));
  const activity = charts.rollingYearHeatmap(intensityPoints, {
    endDate: today,
    cell: activityLayout.cell,
    gap: activityLayout.gap
  });
  const summaryActiveDays = state.stats?.historyPreview?.summary?.activeDays;
  const activeDaysWindow = state.settings?.homeActiveDaysWindow || 'all';
  const displayActiveDays = activeDaysWindow === 'year'
    ? activity.cells.filter((cell) => cell.tokens > 0).length
    : (Number.isFinite(summaryActiveDays)
        ? summaryActiveDays
        : activity.cells.filter((cell) => cell.tokens > 0).length);
  const activeDaysLabel = activeDaysWindow === 'year'
    ? t('home.activeDaysYear', { count: displayActiveDays })
    : t('home.activeDays', { count: displayActiveDays });
  const { module, body } = homeModuleShell('trends', t('home.activity'), 'trends', activeDaysLabel);
  const activityScroll = document.createElement('div');
  activityScroll.className = 'home-activity-scroll';
  if (state.homeActivityHoverPoint && state.homeActivityHoverDate) {
    // This replacement is being inserted directly under a stationary pointer. Keep
    // the already-visible spotlight from replaying its hover fade on the new SVG.
    activityScroll.classList.add('is-restoring-hover');
  }
  activityScroll.tabIndex = 0;
  activityScroll.setAttribute('role', 'region');
  activityScroll.setAttribute('aria-label', t('home.activityScroll'));
  const activityCanvas = document.createElement('div');
  activityCanvas.className = 'home-activity-canvas';
  activityCanvas.innerHTML = charts.heatmapSvg(activity, {
    monthLabel: (month) => compactMonthLabel(month.label),
    radius: activityLayout.radius,
    glowFilterId: 'homeActivityHeatGlow',
    spotlightId: 'homeActivitySpotlight',
    spotlightRadius: 82
  });
  activityScroll.append(activityCanvas);
  const linePoints = charts.clampDaily(points, 45);
  const trendSummary = homeOverviewApi.homeTrendSummary(linePoints);
  const longRangePeak = homeOverviewApi.longRangePeakDayTokens({
    historySummary: history.summary,
    daily: points
  });
  const trendHead = document.createElement('div');
  trendHead.className = 'home-trend-head';
  const trendTitle = document.createElement('span');
  trendTitle.textContent = t('home.trend');
  const trendMeta = document.createElement('span');
  trendMeta.className = 'home-module-meta';
  trendMeta.textContent = t('home.peakTokens', { value: formatCompact(longRangePeak) });
  trendHead.append(trendTitle, trendMeta);
  const model = charts.areaLineChart(linePoints, { width: 300, height: 70, padTop: 4, padRight: 3, padBottom: 4, padLeft: 3, metric: 'tokens', curve: true });
  const plot = document.createElement('div');
  plot.className = 'home-trend-plot';
  const chart = document.createElement('div');
  chart.className = 'home-area-chart';
  chart.innerHTML = charts.areaLineSvg(model);
  plot.append(chart);
  const dates = document.createElement('div');
  dates.className = 'home-trend-dates';
  for (const date of trendSummary.dates) {
    const label = document.createElement('span');
    label.className = 'home-trend-date';
    label.textContent = trendShortLabel(date, 'date');
    dates.append(label);
  }
  body.append(activityScroll, trendHead, plot, dates);
  setupHomeActivityScroller(activityScroll, () => {
    // The scroller is now laid out and has its saved/right-edge position. Reconnect
    // an active hover only after that geometry is stable; otherwise the replacement
    // briefly resolves against the oldest (left) edge and then drops the tooltip.
    state.homeActivityHoverRestore?.();
    animateHomeHistoryVisuals(activityScroll, activityCanvas, chart);
  });
  setupHomeActivityHover(activityScroll);
  return module;
}

function renderHome() {
  if (!els.homePanel) return;
  // The previous scroller (and its ResizeObserver) is about to be replaced; drop the
  // observer so at most one is live. Keep the active tooltip visible while the
  // replacement heatmap reconnects it to the same date cell.
  hideHomeActivityTooltip({ preserveHover: true });
  state.homeActivityResizeObserver?.disconnect();
  state.homeActivityResizeObserver = null;
  const period = state.stats.periods?.[state.period] || { totalTokens: 0, costUsd: 0, clients: {} };
  const moduleIds = homeModuleIds();
  if (moduleIds.includes('trends')) void loadHomeHistory();
  if (moduleIds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-empty';
    const title = document.createElement('div');
    title.className = 'home-empty-title';
    title.textContent = t('home.emptyTitle');
    const body = document.createElement('div');
    body.className = 'home-empty-body';
    body.textContent = t('home.emptyBody');
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'home-empty-action';
    action.textContent = t('home.customize');
    action.addEventListener('click', openHomeSettings);
    empty.append(title, body, action);
    els.homePanel.replaceChildren(empty);
    hideHomeActivityTooltip();
    return;
  }
  const nodes = moduleIds.map((id) => {
    if (id === 'limits') return renderHomeLimitModule();
    if (id === 'tool') return renderHomeToolModule(period);
    if (id === 'device') return renderHomeDeviceModule();
    if (id === 'model') return renderHomeModelModule(period);
    return renderHomeTrendsModule();
  });
  els.homePanel.replaceChildren(...nodes);
  // setupHomeActivityScroller first runs while its module is detached, where
  // scrollWidth can equal clientWidth. Apply again synchronously now that the DOM is
  // attached, before the browser paints or hover restoration measures the new cell.
  const activityScroller = els.homePanel.querySelector('.home-activity-scroll');
  if (activityScroller) applyHomeActivityScroll(activityScroller);
  if (state.homeActivityHoverRestore) state.homeActivityHoverRestore();
  else hideHomeActivityTooltip();
  if (activityScroller?.classList.contains('is-restoring-hover')) {
    requestAnimationFrame(() => activityScroller.classList.remove('is-restoring-hover'));
  }
  // ResizeObserver repeats the scroll + hover restoration once layout fully settles.
}

function render() {
  if (!state.stats) return;
  renderSessionUsageArchiveStatus();
  ensureBreakdownVisible();
  renderViewSwitcher();
  const derivedPeriod = fixedPeriodRangesApi.isDerived(state.period);
  if (derivedPeriod) {
    const signature = fixedPeriodHistorySignature();
    if (!state.fixedPeriodHistoryRequested
      || state.fixedPeriodHistorySignature !== signature
      || state.fixedPeriodHistoryBusy) {
      // Joining an existing background preload upgrades its completion into a
      // visible repaint, so switching to a fixed range cannot remain on loading.
      void loadFixedPeriodHistory();
    }
    state.fixedPeriodSnapshot = buildFixedPeriodSnapshot();
    if (state.fixedPeriodSnapshot.status === 'ready') {
      state.stats.periods[state.period] = state.fixedPeriodSnapshot.period;
    }
  } else {
    state.fixedPeriodSnapshot = null;
  }
  if (state.openSession && state.breakdown !== 'session') { state.openSession = null; els.sessionDetail.classList.add('hidden'); els.sessionDetail.replaceChildren(); els.sessionDetailHead.classList.add('hidden'); els.sessionDetailHead.replaceChildren(); }
  if (state.openSession) { els.sessionDetail.classList.remove('hidden'); els.sessionDetailHead.classList.remove('hidden'); } else { els.sessionDetail.classList.add('hidden'); els.sessionDetailHead.classList.add('hidden'); }
  const period = state.stats.periods?.[state.period] || { totalTokens: 0, costUsd: 0, clients: {} };
  const fixedUnavailable = derivedPeriod && state.fixedPeriodSnapshot?.status !== 'ready';
  const detailUnavailable = derivedPeriod
    && !fixedPeriodRangesApi.supportsBreakdown(state.period, state.breakdown, {
      deviceHistoriesAvailable: Array.isArray(state.fixedPeriodHistory?.deviceHistories)
    });
  if (fixedUnavailable || detailUnavailable) {
    cancelNumberAnimation();
    els.totalTokens.textContent = fixedUnavailable ? '—' : formatNumber(Number(period.totalTokens || 0));
    updateTotalCompact(fixedUnavailable ? 0 : Number(period.totalTokens || 0));
    els.cost.textContent = fixedUnavailable ? '' : formatCost(period.costUsd || 0);
    state.currentTotal = fixedUnavailable ? 0 : Number(period.totalTokens || 0);
    hidePeriodContentForMessage(fixedPeriodMessage(state.fixedPeriodSnapshot, detailUnavailable ? state.breakdown : ''));
    renderFloatingBubbleContent();
    if (!contentReadySignaled) {
      contentReadySignaled = true;
      window.tokenMonitor.signalContentReady?.();
    }
    return;
  }
  els.fixedPeriodMessage.classList.add('hidden');
  const nextTotal = Number(period.totalTokens || 0);
  const totalChanged = nextTotal !== state.currentTotal;
  if (state.suppressInitialNumberAnimation) {
    cancelNumberAnimation();
    numberAnimValue = nextTotal;
    els.totalTokens.textContent = formatNumber(nextTotal);
    updateTotalCompact(nextTotal);
    state.suppressInitialNumberAnimation = false;
  } else if (totalChanged) {
    // Keep the compact chip visible through the count-up and lock the font to the
    // widest endpoint first (a downward roll starts wider than it settles), so the
    // number never vanishes, clips, or resizes mid-roll. Re-fit on completion so a
    // window resize during the animation, or a downward settle, still ends correct.
    const animationFrom = numberAnimHandle ? numberAnimValue : state.currentTotal;
    const widest = formatNumber(nextTotal).length >= formatNumber(animationFrom).length ? nextTotal : animationFrom;
    els.totalTokens.textContent = formatNumber(widest);
    updateTotalCompact(nextTotal);
    animateTotalNumber(els.totalTokens, animationFrom, nextTotal, state.periodMotionActive ? 800 : 1000);
    pulseLiveDot();
  } else if (!headlineNumberIsAnimatingTo(nextTotal)) {
    cancelNumberAnimation();
    numberAnimValue = nextTotal;
    els.totalTokens.textContent = formatNumber(nextTotal);
    updateTotalCompact(nextTotal);
  }
  state.currentTotal = nextTotal;
  els.cost.textContent = formatCost(period.costUsd || 0);
  renderTokenRate();
  if (!state.refreshBusy && !state.refreshFeedbackTimer) setRefreshButtonState('idle');
  els.shell.classList.toggle('session-mode', state.breakdown === 'session');
  els.shell.classList.toggle('home-mode', state.breakdown === 'home');
  els.viewBackRow?.classList.toggle('hidden', state.breakdown === 'home' || !state.homeReturnVisible);
  // Leaving Home only CSS-hides the panel, so its heatmap scroller never sees a
  // pointerleave — dismiss the body-level tooltip here (renderHome covers rerenders).
  if (state.breakdown !== 'home') hideHomeActivityTooltip();
  if (state.breakdown === 'status') ensureServiceStatusTicker(); else stopServiceStatusTicker();
  if (state.breakdown === 'home') {
    els.breakdown.classList.add('hidden');
    els.serviceStatusPanel?.classList.add('hidden');
    els.trendsPanel.classList.add('hidden');
    els.limitsPanel.classList.add('hidden');
    els.homePanel.classList.remove('hidden');
    renderHome();
  } else if (state.breakdown === 'limits') {
    els.homePanel.classList.add('hidden');
    els.breakdown.classList.add('hidden');
    els.serviceStatusPanel?.classList.add('hidden');
    els.trendsPanel.classList.add('hidden');
    els.limitsPanel.classList.remove('hidden');
    renderLimits();
  } else if (state.breakdown === 'trends') {
    els.homePanel.classList.add('hidden');
    els.breakdown.classList.add('hidden');
    els.limitsPanel.classList.add('hidden');
    els.serviceStatusPanel?.classList.add('hidden');
    els.trendsPanel.classList.remove('hidden');
    renderTrends();
  } else if (state.breakdown === 'status') {
    els.homePanel.classList.add('hidden');
    els.breakdown.classList.add('hidden');
    els.limitsPanel.classList.add('hidden');
    els.trendsPanel.classList.add('hidden');
    els.serviceStatusPanel?.classList.remove('hidden');
    renderServiceStatus();
  } else if (state.openSession) {
    // session-detail view replaces the breakdown list; keep both the list and
    // limits hidden so a periodic re-render doesn't surface them over the detail.
    els.limitsPanel.classList.add('hidden');
    els.serviceStatusPanel?.classList.add('hidden');
    els.trendsPanel.classList.add('hidden');
    els.homePanel.classList.add('hidden');
    els.breakdown.classList.add('hidden');
  } else {
    els.homePanel.classList.add('hidden');
    els.limitsPanel.classList.add('hidden');
    els.serviceStatusPanel?.classList.add('hidden');
    els.trendsPanel.classList.add('hidden');
    els.breakdown.classList.remove('hidden');
    const rows = rowsForPeriod(period);
    let incompleteHint = '';
    if (state.breakdown === 'project' && projectRowsApi.projectBreakdownIncomplete(state.stats, state.period)) {
      incompleteHint = 'projects.incomplete';
    } else if (state.breakdown === 'session' && sessionRowsApi.sessionBreakdownIncomplete(state.stats, state.period)) {
      incompleteHint = 'sessions.incomplete';
    }
    renderRows(rows, { incompleteHint });
  }
  
  renderFloatingBubbleContent();
  // Tell main the window has painted real content (not the static "0" defaults),
  // so a recreated window can stay hidden until it's populated. See loadWindowFile.
  if (!contentReadySignaled) {
    contentReadySignaled = true;
    window.tokenMonitor.signalContentReady?.();
  }
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

const STREAM_REASON_KEYS = {
  unauthorized: 'settings.sync.offline.unauthorized',
  refused: 'settings.sync.offline.refused',
  timeout: 'settings.sync.offline.timeout',
  dns: 'settings.sync.offline.dns',
  unreachable: 'settings.sync.offline.unreachable',
  server_error: 'settings.sync.offline.serverError',
  disconnected: 'settings.sync.offline.disconnected',
  network: 'settings.sync.offline.network'
};

function streamFailureText(failure) {
  if (!failure || !failure.reason) return '';
  // Only render reasons that come from the stream classifier. Local-collector
  // statuses (e.g. 'collecting') can land in streamFailure during client→local
  // fallback; mapping those to a sync error would be a false "Connection failed".
  const key = STREAM_REASON_KEYS[failure.reason];
  if (!key) return '';
  const base = t(key);
  return failure.detail ? `${base} (${failure.detail})` : base;
}

function statusTextFor(mode, connected) {
  if (mode === 'sync') return connected ? 'Live' : 'Offline';
  if (mode === 'local') return connected ? 'Local' : 'Collecting…';
  return 'Starting…';
}

function liveDotTitle(mode, connected) {
  if (mode === 'sync') {
    if (connected) return t('status.hubStreamLive');
    const reason = streamFailureText(state.streamFailure);
    return reason ? `${t('status.hubStreamOffline')}: ${reason}` : t('status.hubStreamOffline');
  }
  if (mode === 'local') return connected ? 'Local collector running' : 'Local collector starting…';
  return 'Idle';
}

function setLiveDot(connected) {
  els.liveDot.classList.toggle('live', Boolean(connected));
  els.liveDot.title = liveDotTitle(state.mode, connected);
}

// Flare the live dot once when fresh data arrives. Re-arming the one-shot
// animation needs a class remove + forced reflow before re-adding.
function pulseLiveDot() {
  const dot = els.liveDot;
  if (!dot || !dot.classList.contains('live')) return;
  dot.classList.remove('pulse');
  void dot.offsetWidth;
  dot.classList.add('pulse');
}

function refreshButtonIdleTitle() {
  if (state.stats?.updatedAt) return t('refreshButton.refreshedAt', { time: formatTime(state.stats.updatedAt) });
  return t('refreshButton.label');
}

function clearRefreshButtonFeedbackTimer() {
  if (!state.refreshFeedbackTimer) return;
  clearTimeout(state.refreshFeedbackTimer);
  state.refreshFeedbackTimer = null;
}

function setRefreshButtonState(status = 'idle') {
  if (!els.refreshButton) return;
  els.refreshButton.classList.toggle('is-refreshing', status === 'refreshing');
  els.refreshButton.classList.toggle('is-refreshed', status === 'refreshed');
  els.refreshButton.classList.toggle('is-refresh-error', status === 'error');
  els.refreshButton.disabled = status === 'refreshing';
  if (status === 'refreshing') {
    els.refreshButton.title = t('refreshButton.refreshing');
    els.refreshButton.setAttribute('aria-label', t('refreshButton.refreshing'));
    els.refreshButton.setAttribute('aria-busy', 'true');
  } else if (status === 'refreshed') {
    els.refreshButton.title = t('refreshButton.refreshed');
    els.refreshButton.setAttribute('aria-label', t('refreshButton.refreshed'));
    els.refreshButton.setAttribute('aria-busy', 'false');
  } else if (status === 'error') {
    els.refreshButton.title = t('refreshButton.failed');
    els.refreshButton.setAttribute('aria-label', t('refreshButton.failed'));
    els.refreshButton.setAttribute('aria-busy', 'false');
  } else {
    els.refreshButton.title = refreshButtonIdleTitle();
    els.refreshButton.setAttribute('aria-label', t('refreshButton.label'));
    els.refreshButton.removeAttribute('aria-busy');
  }
}

function settleRefreshButtonState(status) {
  clearRefreshButtonFeedbackTimer();
  setRefreshButtonState(status);
  state.refreshFeedbackTimer = setTimeout(() => {
    state.refreshFeedbackTimer = null;
    setRefreshButtonState('idle');
  }, REFRESH_BUTTON_FEEDBACK_MS);
}

// The main process rebuilds the TOTAL session list for display but ships it as a
// display-only sibling (`allTimeSessionsView`) so it never pollutes the lossless
// period export. Overlay it onto periods.allTime here, on the renderer's own copy, so
// every session-view reader (list, archived count, detail lookup) sees it. See
// injectLocalDeviceStatus in main.js.
function overlayAllTimeSessions(stats) {
  if (stats && stats.allTimeSessionsView && stats.periods?.allTime) {
    const sessions = reasonixSessionGuard?.filterReasonixSyntheticSessions
      ? reasonixSessionGuard.filterReasonixSyntheticSessions(stats.allTimeSessionsView)
      : stats.allTimeSessionsView;
    stats.allTimeSessionsView = sessions;
    stats.periods.allTime.sessions = sessions;
  }
  return stats;
}

async function refreshStats(options = {}) {
  const feedback = options.feedback === true;
  if (feedback) {
    if (state.refreshBusy) return;
    state.refreshBusy = true;
    clearRefreshButtonFeedbackTimer();
    setRefreshButtonState('refreshing');
  }
  try {
    state.stats = overlayAllTimeSessions(await window.tokenMonitor.getStats(options));
    if (options.forceHistory === true) {
      // A manual history rescan is an explicit retry boundary. Let Home request the
      // corresponding full payload even when its revision is unchanged, and restore
      // a retry budget that an earlier outage may have exhausted.
      clearTimeout(state.homeHistoryRetryTimer);
      state.homeHistoryRetryTimer = null;
      state.homeHistoryLoadedSignature = '';
      state.homeHistoryRetrySignature = '';
      state.homeHistoryRetries = 0;
      state.homeHistorySignature = '';
    }
    applyCodexActiveAccountFromStats();
    setStatus(statusTextFor(state.mode, state.streamConnected));
    const forceFixedPeriodHistory = options.forceHistory === true;
    if (fixedPeriodRangesApi.isDerived(state.period)) {
      await warmFixedPeriodHistory({
        force: forceFixedPeriodHistory,
        retryFailed: forceFixedPeriodHistory,
        renderOnComplete: false
      });
      statsRenderScheduler.request();
    } else {
      statsRenderScheduler.request();
      void warmFixedPeriodHistory({
        force: forceFixedPeriodHistory,
        retryFailed: forceFixedPeriodHistory,
        renderOnComplete: false
      });
    }
    maybeUpdateBarsIcon();
    if (feedback) settleRefreshButtonState('refreshed');
  } catch (error) {
    // The dot colour shows the offline state and the reason lives in the
    // live-dot tooltip + sync settings line, so keep the header status pill
    // hidden instead of surfacing the raw hub error (e.g. a 404 HTML page).
    console.log(`[refresh] getStats failed: ${error.message}`);
    setStatus(statusTextFor(state.mode, state.streamConnected));
    if (feedback) settleRefreshButtonState('error');
  } finally {
    if (feedback) state.refreshBusy = false;
  }
}

async function refreshStatusViewManually() {
  if (state.refreshBusy || state.serviceStatusBusy) return;
  state.refreshBusy = true;
  clearRefreshButtonFeedbackTimer();
  setRefreshButtonState('refreshing');
  try {
    await refreshServiceStatus({ force: true });
    settleRefreshButtonState('refreshed');
  } catch (error) {
    setStatus(error.message, true);
    settleRefreshButtonState('error');
  } finally {
    state.refreshBusy = false;
  }
}

function publishViewState() {
  window.tokenMonitor.setViewState?.({ period: state.period, breakdown: state.breakdown });
}

function setPeriod(period) {
  const next = normalizeInitialViewValue(period, viewPeriodValues, state.period);
  if (next === state.period) {
    if (fixedPeriodRangesApi.isDerived(next) && state.fixedPeriodHistoryFailed) {
      void warmFixedPeriodHistory({ retryFailed: true, renderOnComplete: true });
    }
    publishViewState();
    return false;
  }
  state.period = next;
  if (fixedPeriodRangesApi.isDerived(next) && state.fixedPeriodHistoryFailed) {
    void warmFixedPeriodHistory({ retryFailed: true, renderOnComplete: true });
  }
  publishViewState();
  return true;
}

function setBreakdown(breakdown, options = {}) {
  const next = normalizeInitialViewValue(breakdown, viewBreakdownValues, state.breakdown);
  directBreakdownOverride = options.allowHidden === true ? next : null;
  if (next === state.breakdown) {
    publishViewState();
    return false;
  }
  state.homeReturnVisible = options.fromHome === true && state.breakdown === 'home' && next !== 'home';
  state.breakdown = next;
  state.rowSignature = '';
  publishViewState();
  return true;
}

function renderBreakdownChange(breakdown, options = {}) {
  if (!setBreakdown(breakdown, options)) return false;
  state.animateBarsFromZero = true;
  state.animateChartsOnRender = true;
  let renderSucceeded = false;
  try {
    render();
    renderSucceeded = true;
  } finally {
    state.animateBarsFromZero = false;
    // Home consumes this flag asynchronously after ResizeObserver confirms layout.
    // Clear it only after a failed render so that deferred entry motion still runs.
    if (!renderSucceeded) state.animateChartsOnRender = false;
  }
  return true;
}

function restartTimer() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  const interval = state.streamConnected
    ? 5 * 60 * 1000
    : Number(state.settings?.refreshMs || 15000);
  state.refreshTimer = setInterval(refreshStats, interval);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function applyControlLayout(swapSettingsAndRefresh) {
  const footerSlot = document.getElementById('footerActionSlot');
  if (!footerSlot || !els.utilityActions) return;
  footerSlot.appendChild(els.utilityActions);
  els.utilityActions.classList.toggle('is-swapped', swapSettingsAndRefresh);
  if (swapSettingsAndRefresh) {
    els.utilityActions.append(els.settingsButton, els.refreshButton);
  } else {
    els.utilityActions.append(els.refreshButton, els.settingsButton);
  }
}

function applyFontSettings(settings) {
  const source = { ...(state.settings || {}), ...(settings || {}) };
  const root = document.documentElement.style;
  const { interfaceFont, displayFont } = fontSettingsApi.resolveEffectiveFontSettings(source);
  root.setProperty('--ui-font', interfaceFont);
  root.setProperty('--display-font', displayFont);
}

function applyAppearanceSettings(settings) {
  const opacity = glassRenderingApi.renderedGlassOpacity(settings, {
    platform: state.appInfo?.platform,
    userAgent: navigator.userAgent
  });
  const depth = clamp(settings?.glassBlur ?? 32, 0, 100) / 100;
  const systemGlassDisabled = settings?.systemGlass === false;
  const isWindows = navigator.userAgent.toLowerCase().includes('windows');
  const windowsGlass = windowsGlassApi.appearanceState(settings, { isWindows });
  document.documentElement.style.setProperty('--glass-alpha', opacity.toFixed(2));
  document.documentElement.style.setProperty('--line-alpha', (0.1 + depth * 0.09).toFixed(3));
  document.documentElement.style.setProperty('--line-strong-alpha', (0.18 + depth * 0.14).toFixed(3));
  document.documentElement.style.setProperty('--control-alpha', (0.03 + depth * 0.045).toFixed(3));
  document.documentElement.classList.toggle('system-glass-disabled', systemGlassDisabled);
  els.windowsBackdropRow?.classList.toggle('hidden', !windowsGlass.showBackdropControl);
  if (els.windowsBackdropInput) {
    els.windowsBackdropInput.value = windowsGlass.backdropMode;
  }
  if (els.windowsBackdropNote) {
    const accentFallback = windowsGlass.showAccentNote
      && new URLSearchParams(window.location.search).get('windowsBackdropFallback') === '1';
    els.windowsBackdropNote.textContent = t(accentFallback
      ? 'settings.appearance.windowsBackdropFallback'
      : 'settings.appearance.windowsBackdropNote');
    els.windowsBackdropNote.classList.toggle('error', accentFallback);
    els.windowsBackdropNote.classList.toggle('hidden', !windowsGlass.showAccentNote);
  }
  applyReduceMotionPreference(settings?.reduceMotion);
  applyFontSettings(settings);
  // Only full settings objects carry themeColors; glass/zoom preview patches
  // omit it, so we must not wipe theme overrides mid-slider-drag.
  if (settings && 'themeColors' in settings) applyThemeColors(settings.themeColors);
  els.liveDot.style.display = (settings?.showLiveDot !== false) ? '' : 'none';
  els.shell.classList.toggle('desktop-mode', settings?.windowBehavior === 'desktop');
  els.shell.classList.toggle('title-icon-only', settings?.titleIconOnly === true);
  const trayMode = settings && 'trayMode' in settings
    ? settings.trayMode === true
    : state.settings?.trayMode === true;
  els.shell.classList.toggle('tray-mode', trayMode);
  if (settings && ('settingsInTitlebar' in settings || 'trayMode' in settings)) {
    applyControlLayout(settings.settingsInTitlebar === true);
  }
  let isMacLegacyRadius = false;
  if (!isWindows && state.appInfo?.platform === 'darwin' && state.appInfo?.osRelease) {
    // macOS Tahoe (macOS 26) is Darwin 25. Older macOS versions (like 14, 15) use a ~12px native vibrancy radius.
    const major = parseInt(state.appInfo.osRelease.split('.')[0], 10);
    if (major < 25) isMacLegacyRadius = true;
  }

  document.documentElement.classList.remove('is-windows-glass'); // cleanup old class
  document.body.classList.remove('is-windows-glass');
  
  document.documentElement.classList.toggle('is-windows', isWindows);
  document.body.classList.toggle('is-windows', isWindows);
  
  document.documentElement.classList.toggle('is-mac-legacy', isMacLegacyRadius);
  document.body.classList.toggle('is-mac-legacy', isMacLegacyRadius);
  updateTitleFit();
}

const themePresetsApi = window.TokenMonitorThemePresets;
let themeCodeFeedbackGeneration = 0;
let appliedThemeOverrides = {};
// Snapshot of the canonical brand colours, taken before any override is
// applied. clientColors is mutated in place (other modules hold the same
// reference), so this is the source of truth for "reset to brand".
const BRAND_VENDOR_COLORS = { ...clientColors };

function appearanceSummary() {
  const theme = themePresetsApi.normalizeOverrides(state.settings?.themeColors, themePresetsApi.INTERFACE_COLOR_KEYS);
  const vendor = themePresetsApi.normalizeOverrides(state.settings?.vendorColors, Object.keys(BRAND_VENDOR_COLORS));
  const presetId = matchingThemePresetId(theme);
  const presetLabel = presetId ? t(`settings.appearance.preset.${presetId}`) : t('settings.appearance.custom');
  const customVendors = Object.keys(vendor).length;
  if (customVendors > 0) {
    return t('settings.summary.appearance', { theme: presetLabel, vendors: customVendors });
  }
  return presetLabel;
}

// Returns the preset id whose colours exactly match the resolved palette, or
// null when the palette is a custom mix.
function matchingThemePresetId(overrides) {
  const resolved = themePresetsApi.mergeThemeColors(overrides);
  for (const preset of themePresetsApi.THEME_PRESETS) {
    if (themePresetsApi.INTERFACE_COLOR_KEYS.every((k) => resolved[k] === preset.colors[k])) return preset.id;
  }
  return null;
}

function applyThemeColors(overrides) {
  appliedThemeOverrides = themePresetsApi.normalizeOverrides(overrides, themePresetsApi.INTERFACE_COLOR_KEYS);
  const root = document.documentElement.style;
  for (const { name, value } of themePresetsApi.themeCssVarEntries(appliedThemeOverrides)) {
    if (value) root.setProperty(name, value);
    else root.removeProperty(name);
  }
  renderFloatingBubbleContent();
}

function applyVendorColorOverrides(overrides) {
  const merged = themePresetsApi.mergeVendorColors(BRAND_VENDOR_COLORS, overrides);
  for (const key of Object.keys(BRAND_VENDOR_COLORS)) clientColors[key] = merged[key];
}

// Current resolved palette value for an interface colour key.
function resolvedThemeColor(key) {
  return appliedThemeOverrides[key] || themePresetsApi.DEFAULT_THEME[key];
}

function buildAppearanceColorControls() {
  renderThemePresetChips();
  renderThemeColorGrid();
  renderVendorColorList();
  if (els.themeCodeInput && document.activeElement !== els.themeCodeInput) {
    const code = themePresetsApi.encodeThemeCode(state.settings?.themeColors);
    if (els.themeCodeInput.value !== code) {
      els.themeCodeInput.value = code;
      invalidateThemeCodeFeedback();
    }
  }
}

function renderThemePresetChips() {
  if (!els.themePresetChips) return;
  const activeId = matchingThemePresetId(state.settings?.themeColors);
  els.themePresetChips.innerHTML = '';
  for (const preset of themePresetsApi.THEME_PRESETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'theme-preset-chip';
    chip.classList.toggle('active', preset.id === activeId);
    chip.dataset.presetId = preset.id;
    const dot = document.createElement('span');
    dot.className = 'theme-preset-dot';
    dot.style.background = preset.colors.accent;
    const label = document.createElement('span');
    label.textContent = t(`settings.appearance.preset.${preset.id}`);
    chip.append(dot, label);
    chip.addEventListener('click', () => selectThemePreset(preset.id));
    els.themePresetChips.appendChild(chip);
  }
}

function renderThemeColorGrid() {
  if (!els.themeColorGrid) return;
  els.themeColorGrid.innerHTML = '';
  for (const key of themePresetsApi.INTERFACE_COLOR_KEYS) {
    const row = document.createElement('label');
    row.className = 'color-picker-row';
    const name = document.createElement('span');
    name.className = 'color-picker-name';
    name.textContent = t(`settings.appearance.color.${key}`);
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'color-picker-input';
    input.value = resolvedThemeColor(key);
    input.dataset.themeKey = key;
    input.addEventListener('input', () => previewThemeColor(key, input.value));
    input.addEventListener('change', () => saveThemeColor(key, input.value));
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset-appearance-button reset-inline';
    reset.textContent = '↺';
    reset.title = t('settings.appearance.resetColor');
    reset.addEventListener('click', () => resetThemeColor(key));
    row.append(name, input, reset);
    els.themeColorGrid.appendChild(row);
  }
}

function renderVendorColorList() {
  if (!els.vendorColorList) return;
  const overrides = themePresetsApi.normalizeOverrides(state.settings?.vendorColors, Object.keys(BRAND_VENDOR_COLORS));
  els.vendorColorList.innerHTML = '';
  for (const id of themePresetsApi.orderedVendorIds(BRAND_VENDOR_COLORS)) {
    const row = document.createElement('label');
    row.className = 'vendor-color-row';
    const name = document.createElement('span');
    name.className = 'vendor-color-name';
    name.textContent = id === 'default' ? t('settings.appearance.vendorDefault') : themePresetsApi.vendorLabel(id);
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'color-picker-input';
    input.value = overrides[id] || BRAND_VENDOR_COLORS[id];
    input.dataset.vendorId = id;
    input.addEventListener('input', () => previewVendorColor(id, input.value));
    input.addEventListener('change', () => saveVendorColor(id, input.value));
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset-appearance-button reset-inline';
    reset.textContent = '↺';
    reset.title = t('settings.appearance.resetBrand');
    reset.addEventListener('click', () => resetVendorColor(id));
    row.append(name, input, reset);
    els.vendorColorList.appendChild(row);
  }
}

function currentThemeOverrides() {
  return themePresetsApi.normalizeOverrides(state.settings?.themeColors, themePresetsApi.INTERFACE_COLOR_KEYS);
}

function currentVendorOverrides() {
  return themePresetsApi.normalizeOverrides(state.settings?.vendorColors, Object.keys(BRAND_VENDOR_COLORS));
}

function previewThemeColor(key, value) {
  if (!themePresetsApi.isValidHex(value)) return;
  const next = { ...currentThemeOverrides(), [key]: themePresetsApi.normalizeHex(value) };
  applyThemeColors(next);
}

async function saveThemeColor(key, value) {
  if (!themePresetsApi.isValidHex(value)) return;
  const next = { ...currentThemeOverrides(), [key]: themePresetsApi.normalizeHex(value) };
  await commitThemeColors(next);
}

async function resetThemeColor(key) {
  const next = { ...currentThemeOverrides() };
  delete next[key];
  await commitThemeColors(next);
}

async function selectThemePreset(presetId) {
  const preset = themePresetsApi.THEME_PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  // Store only the keys that differ from the built-in default, so the palette
  // tracks default changes for untouched colours.
  const next = {};
  for (const key of themePresetsApi.INTERFACE_COLOR_KEYS) {
    if (preset.colors[key] !== themePresetsApi.DEFAULT_THEME[key]) next[key] = preset.colors[key];
  }
  await commitThemeColors(next);
}

async function commitThemeColors(overrides) {
  state.settings.themeColors = overrides;
  applyThemeColors(overrides);
  buildAppearanceColorControls();
  renderSettingsSummaries();
  await saveSettings({ themeColors: overrides });
}

function showThemeCodeStatus(key, type = '') {
  if (!els.themeCodeStatus) return;
  els.themeCodeStatus.textContent = t(key);
  els.themeCodeStatus.classList.toggle('success', type === 'success');
  els.themeCodeStatus.classList.toggle('error', type === 'error');
}

function clearThemeCodeStatus() {
  if (!els.themeCodeStatus) return;
  els.themeCodeStatus.textContent = '';
  els.themeCodeStatus.classList.remove('success', 'error');
}

function invalidateThemeCodeFeedback() {
  themeCodeFeedbackGeneration += 1;
  clearThemeCodeStatus();
  return themeCodeFeedbackGeneration;
}

function themeCodeFeedbackIsCurrent(generation, code) {
  return generation === themeCodeFeedbackGeneration && els.themeCodeInput?.value === code;
}

async function applyThemeCodeFromInput() {
  const generation = invalidateThemeCodeFeedback();
  const parsed = themePresetsApi.decodeThemeCode(els.themeCodeInput?.value);
  if (!parsed.ok) {
    const key = parsed.reason === 'unsupportedVersion'
      ? 'settings.appearance.themeCodeUnsupported'
      : 'settings.appearance.themeCodeInvalid';
    showThemeCodeStatus(key, 'error');
    return;
  }
  els.themeCodeInput.value = parsed.code;
  await commitThemeColors(parsed.colors);
  if (themeCodeFeedbackIsCurrent(generation, parsed.code)) {
    showThemeCodeStatus('settings.appearance.themeCodeApplied', 'success');
  }
}

async function pasteAndApplyThemeCode() {
  const generation = invalidateThemeCodeFeedback();
  const code = els.themeCodeInput?.value;
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch (_) {
    if (!themeCodeFeedbackIsCurrent(generation, code)) return;
    showThemeCodeStatus('settings.appearance.themeCodeCopyFailed', 'error');
    return;
  }
  if (!themeCodeFeedbackIsCurrent(generation, code)) return;
  const trimmed = (text || '').trim();
  if (els.themeCodeInput) els.themeCodeInput.value = trimmed;
  await applyThemeCodeFromInput();
}

async function copyCurrentThemeCode() {
  const generation = invalidateThemeCodeFeedback();
  const code = themePresetsApi.encodeThemeCode(state.settings?.themeColors);
  els.themeCodeInput.value = code;
  const copied = await copyToClipboard(code);
  if (!themeCodeFeedbackIsCurrent(generation, code)) return;
  showThemeCodeStatus(
    copied ? 'settings.appearance.themeCodeCopied' : 'settings.appearance.themeCodeCopyFailed',
    copied ? 'success' : 'error'
  );
}

function previewVendorColor(id, value) {
  if (!themePresetsApi.isValidHex(value)) return;
  const next = { ...currentVendorOverrides(), [id]: themePresetsApi.normalizeHex(value) };
  applyVendorColorOverrides(next);
  render();
}

async function saveVendorColor(id, value) {
  if (!themePresetsApi.isValidHex(value)) return;
  const next = { ...currentVendorOverrides(), [id]: themePresetsApi.normalizeHex(value) };
  await commitVendorColors(next);
}

async function resetVendorColor(id) {
  const next = { ...currentVendorOverrides() };
  delete next[id];
  await commitVendorColors(next);
}

async function commitVendorColors(overrides) {
  state.settings.vendorColors = overrides;
  applyVendorColorOverrides(overrides);
  render();
  buildAppearanceColorControls();
  renderSettingsSummaries();
  await saveSettings({ vendorColors: overrides });
}

function currentWindowBehavior(source = state.settings) {
  if (WINDOW_BEHAVIOR_VALUES.includes(source?.windowBehavior)) return source.windowBehavior;
  return source?.alwaysOnTop ? 'floating' : 'normal';
}

function nextWindowBehavior(mode) {
  const index = WINDOW_BEHAVIOR_VALUES.indexOf(mode);
  return WINDOW_BEHAVIOR_VALUES[(index + 1) % WINDOW_BEHAVIOR_VALUES.length] || 'floating';
}

function syncWindowBehaviorControls() {
  const mode = currentWindowBehavior();
  const next = nextWindowBehavior(mode);
  els.windowBehaviorInput.value = mode;
  els.pinButton.textContent = WINDOW_BEHAVIOR_ICONS[mode] || WINDOW_BEHAVIOR_ICONS.normal;
  els.pinButton.classList.toggle('active', mode !== 'normal');
  const title = t('settings.windowBehavior.buttonTitle', {
    current: t(`settings.windowBehavior.${mode}`),
    next: t(`settings.windowBehavior.${next}`)
  });
  els.pinButton.title = title;
  els.pinButton.setAttribute('aria-label', title);
}

function syncWindowShortcutStatus() {
  const note = els.windowToggleShortcutNote;
  const value = els.windowToggleShortcutValue;
  const clearButton = els.windowToggleShortcutClearButton;
  if (!note || !value) return;
  const shortcut = normalizeWindowToggleShortcutValue(state.settings?.windowToggleShortcut);
  // The value pill doubles as the record button, so its empty state is the action ("Record"), not "Off".
  const display = windowShortcutApi.formatWindowToggleShortcut(shortcut, t('settings.shortcut.record'));
  const status = state.settings?.windowToggleShortcutStatus?.state || (shortcut ? 'unregistered' : 'off');
  value.classList.toggle('recording', state.recordingWindowShortcut);
  value.textContent = state.recordingWindowShortcut ? t('settings.shortcut.recording') : display;
  if (clearButton) clearButton.disabled = !shortcut && !state.recordingWindowShortcut;
  note.classList.toggle('error', state.windowShortcutInvalid || (Boolean(shortcut) && status !== 'registered'));
  if (state.recordingWindowShortcut) {
    note.textContent = state.windowShortcutInvalid ? t('settings.display.windowShortcutInvalid') : t('settings.display.windowShortcutListening');
  } else if (!shortcut) {
    note.textContent = t('settings.display.windowShortcutNote');
  } else if (status === 'registered') {
    // The value pill already shows the active shortcut; repeating it here reads as clutter.
    note.textContent = t('settings.display.windowShortcutNote');
  } else {
    note.textContent = t('settings.display.windowShortcutConflict', {
      shortcut: display
    });
  }
}

function stopWindowShortcutRecording() {
  if (!state.recordingWindowShortcut) return;
  state.recordingWindowShortcut = false;
  state.windowShortcutInvalid = false;
  window.removeEventListener('keydown', handleWindowShortcutRecordKey, true);
  syncWindowShortcutStatus();
}

function startWindowShortcutRecording() {
  if (state.recordingWindowShortcut) return;
  state.recordingWindowShortcut = true;
  state.windowShortcutInvalid = false;
  window.addEventListener('keydown', handleWindowShortcutRecordKey, true);
  syncWindowShortcutStatus();
}

async function setWindowToggleShortcut(shortcut) {
  stopWindowShortcutRecording();
  await saveSettings({ windowToggleShortcut: shortcut });
}

function handleWindowShortcutRecordKey(event) {
  if (!state.recordingWindowShortcut) return;
  event.preventDefault();
  event.stopPropagation();
  const result = windowShortcutApi.windowToggleShortcutFromEvent(event, navigator.platform);
  if (result.action === 'cancel') {
    stopWindowShortcutRecording();
    return;
  }
  if (result.action === 'clear') {
    setWindowToggleShortcut('').catch(() => {});
    return;
  }
  if (result.action === 'record') {
    setWindowToggleShortcut(result.shortcut).catch(() => {});
    return;
  }
  state.windowShortcutInvalid = true;
  syncWindowShortcutStatus();
}

function applyFloatingBubbleState(payload = {}) {
  const side = payload?.collapsed && ['left', 'right'].includes(payload.side) ? payload.side : null;
  state.floatingBubble = { collapsed: Boolean(side), side };
  document.documentElement.classList.toggle('floating-bubble-collapsed-left', side === 'left');
  document.documentElement.classList.toggle('floating-bubble-collapsed-right', side === 'right');
  document.body.classList.toggle('floating-bubble-collapsed-left', side === 'left');
  document.body.classList.toggle('floating-bubble-collapsed-right', side === 'right');
  const title = t('floatingBubble.expand');
  if (els.floatingBubbleTab) {
    els.floatingBubbleTab.title = title;
    els.floatingBubbleTab.setAttribute('aria-label', title);
  }
  renderFloatingBubbleContent();
}

const BUBBLE_CONTENT_VALUES = ['icon', 'tokens', 'cost', 'both', 'tokensAll', 'costAll', 'bothAll', 'limitsAllSessions', 'bars', 'barsSession', 'barsWeekly', 'barsAllSessions', 'custom'];
function normalizeTrayContentValue(value) {
  return BUBBLE_CONTENT_VALUES.includes(value) ? value : 'icon';
}

function normalizeWindowToggleShortcutValue(value) {
  return windowShortcutApi.normalizeWindowToggleShortcut(value);
}

const BUBBLE_CONTENT_MIN_W = 34;
const BUBBLE_CONTENT_HEIGHT = 34;
const BUBBLE_CONTENT_PAD_X = 10;

function floatingBubbleGeneratedColors() {
  const text = resolvedThemeColor('text');
  const rgb = themePresetsApi.hexToRgbTriplet(text);
  return {
    track: `rgba(${rgb}, 0.22)`,
    fill: `rgba(${rgb}, 0.92)`,
    text: `rgba(${rgb}, 0.92)`
  };
}

function renderFloatingBubbleContent() {
  const el = els.floatingBubbleContent;
  if (!el || !state.floatingBubble.collapsed) return;
  const mode = state.settings?.floatingBubbleContent || 'icon';
  if (window.TokenMonitorTrayText.isGeneratedTrayIconMode(mode)) {
    const dataUrl = state.stats
      ? trayDataUrlForMode(mode, 44, floatingBubbleGeneratedColors(), {
          contentOnly: mode === 'barsAllSessions' || mode === 'limitsAllSessions',
          providerContrastHalo: true,
          showProviderBadge: false,
          layout: mode === 'custom' ? state.settings?.floatingBubbleCustomLayout : undefined
        })
      : null;
    if (dataUrl) {
      el.classList.add('bars');
      const img = new Image();
      img.alt = '';
      // A data-URL image has no layout width until it loads; size once it does.
      img.addEventListener('load', reportFloatingBubbleSize, { once: true });
      img.src = dataUrl;
      el.replaceChildren(img);
      return;
    }
    el.classList.remove('bars');
    el.textContent = (state.stats && window.TokenMonitorTrayText.formatTrayText(state.stats, mode, currentCurrency(), compactTokenDisplayOptions())) || 'Σ';
  } else if (mode === 'icon') {
    el.classList.remove('bars');
    el.textContent = 'Σ';
  } else {
    el.classList.remove('bars');
    el.textContent = state.stats ? (window.TokenMonitorTrayText.formatTrayText(state.stats, mode, currentCurrency(), compactTokenDisplayOptions()) || '0') : '0';
  }
  reportFloatingBubbleSize();
}

function reportFloatingBubbleSize() {
  if (!state.floatingBubble.collapsed) return;
  const el = els.floatingBubbleContent;
  const mode = state.settings?.floatingBubbleContent || 'icon';
  // Height is constant; only the width tracks the content.
  let width = BUBBLE_CONTENT_MIN_W;
  if (mode !== 'icon' && el) {
    const pad = window.TokenMonitorTrayText.isGeneratedTrayIconMode(mode) ? 8 : BUBBLE_CONTENT_PAD_X * 2;
    width = Math.max(BUBBLE_CONTENT_MIN_W, Math.ceil(el.scrollWidth) + pad);
  }
  window.tokenMonitor.setFloatingBubbleCollapsedSize?.({ width, height: BUBBLE_CONTENT_HEIGHT });
}

const HOVER_REVEAL_DELAY_MS = 250;
const HOVER_COLLAPSE_GRACE_MS = 200;
let floatingBubbleHoverRevealTimer = null;
let floatingBubbleHoverCollapseTimer = null;
let suppressHoverRevealUntilReentry = false;

function floatingBubbleHoverMode() {
  return state.settings?.floatingBubbleTrigger === 'hover' && state.settings?.floatingBubbleEnabled === true;
}

function clearHoverRevealTimer() {
  if (floatingBubbleHoverRevealTimer) { clearTimeout(floatingBubbleHoverRevealTimer); floatingBubbleHoverRevealTimer = null; }
}

function clearHoverCollapseTimer() {
  if (floatingBubbleHoverCollapseTimer) { clearTimeout(floatingBubbleHoverCollapseTimer); floatingBubbleHoverCollapseTimer = null; }
}

function handleFloatingBubbleHoverEnter() {
  if (!floatingBubbleHoverMode() || !state.floatingBubble.collapsed || suppressHoverRevealUntilReentry) return;
  clearHoverRevealTimer();
  floatingBubbleHoverRevealTimer = setTimeout(() => {
    floatingBubbleHoverRevealTimer = null;
    if (!floatingBubbleHoverMode() || !state.floatingBubble.collapsed || floatingBubbleDrag) return;
    window.tokenMonitor.peekFloatingBubble?.();
  }, HOVER_REVEAL_DELAY_MS);
}

function handleFloatingBubbleHoverLeave() {
  clearHoverRevealTimer();
  suppressHoverRevealUntilReentry = false;
}

function handleDocumentHoverLeave() {
  if (!floatingBubbleHoverMode() || state.floatingBubble.collapsed) return;
  clearHoverCollapseTimer();
  floatingBubbleHoverCollapseTimer = setTimeout(() => {
    floatingBubbleHoverCollapseTimer = null;
    if (!floatingBubbleHoverMode() || state.floatingBubble.collapsed) return;
    window.tokenMonitor.collapseFloatingBubbleIfIdle?.();
  }, HOVER_COLLAPSE_GRACE_MS);
}

let floatingBubbleDrag = null;

function floatingBubblePointerOffset(event) {
  const rect = els.floatingBubbleTab?.getBoundingClientRect?.();
  const width = rect?.width || els.floatingBubbleTab?.offsetWidth || 18;
  const height = rect?.height || els.floatingBubbleTab?.offsetHeight || 34;
  const rawX = rect ? event.clientX - rect.left : width / 2;
  const rawY = rect ? event.clientY - rect.top : height / 2;
  const offsetX = Number.isFinite(rawX) ? Math.max(0, Math.min(width, rawX)) : width / 2;
  const offsetY = Number.isFinite(rawY) ? Math.max(0, Math.min(height, rawY)) : height / 2;
  return {
    offsetX: Math.round(offsetX),
    offsetY: Math.round(offsetY),
    offsetRatioX: width > 0 ? offsetX / width : 0.5,
    offsetRatioY: height > 0 ? offsetY / height : 0.5
  };
}

function finishFloatingBubbleDrag(pointerId) {
  if (!floatingBubbleDrag || floatingBubbleDrag.pointerId !== pointerId) return null;
  const drag = floatingBubbleDrag;
  floatingBubbleDrag = null;
  els.floatingBubbleTab?.classList.remove('dragging');
  try { els.floatingBubbleTab?.releasePointerCapture?.(pointerId); } catch (_) {}
  return drag;
}

function handleFloatingBubblePointerDown(event) {
  if (!state.floatingBubble.collapsed || event.button !== 0) return;
  clearHoverRevealTimer();
  floatingBubbleDrag = {
    pointerId: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    ...floatingBubblePointerOffset(event),
    moved: false
  };
  els.floatingBubbleTab?.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function handleFloatingBubblePointerMove(event) {
  const drag = floatingBubbleDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const totalDx = event.screenX - drag.startX;
  const totalDy = event.screenY - drag.startY;
  if (!drag.moved && Math.hypot(totalDx, totalDy) < 4) return;
  drag.moved = true;
  els.floatingBubbleTab?.classList.add('dragging');
  const move = window.tokenMonitor.moveFloatingBubble?.({
    offsetX: drag.offsetX,
    offsetY: drag.offsetY,
    offsetRatioX: drag.offsetRatioX,
    offsetRatioY: drag.offsetRatioY
  });
  move?.catch?.(() => {});
  event.preventDefault();
}

function handleFloatingBubblePointerUp(event) {
  const drag = finishFloatingBubbleDrag(event.pointerId);
  if (!drag) return;
  if (!drag.moved) window.tokenMonitor.expandFloatingBubble?.();
  else {
    suppressHoverRevealUntilReentry = true;
    const move = window.tokenMonitor.moveFloatingBubble?.({
      offsetX: drag.offsetX,
      offsetY: drag.offsetY,
      offsetRatioX: drag.offsetRatioX,
      offsetRatioY: drag.offsetRatioY
    });
    move?.catch?.(() => {});
  }
  event.preventDefault();
}

function appearancePatchFromControls() {
  const systemGlass = els.systemGlassInputs?.find((input) => input.checked)?.value !== 'off';
  return {
    systemGlass,
    windowsBackdrop: windowsGlassApi.normalizeWindowsBackdropMode(els.windowsBackdropInput?.value),
    reduceMotion: els.reduceMotionInputs?.find((input) => input.checked)?.value || 'system',
    showLiveDot: Boolean(els.liveDotInput.checked),
    showToolIcons: Boolean(els.toolIconsInput.checked),
    titleIconOnly: Boolean(els.titleIconInput.checked),
    showCompactTotalTokens: Boolean(els.showCompactTotalTokensInput.checked),
    compactTokenUnits: els.compactTokenUnitsInput?.value === 'localized' ? 'localized' : 'western',
    settingsInTitlebar: Boolean(els.swapSettingsRefreshInput.checked),
    glassOpacity: Number(els.glassInput.value === '' ? defaultAppearance.glassOpacity : els.glassInput.value),
    glassBlur: Number(els.blurInput.value === '' ? defaultAppearance.glassBlur : els.blurInput.value),
    zoomFactor: Number(els.zoomInput.value === '' ? defaultAppearance.zoomFactor * 100 : els.zoomInput.value) / 100
  };
}

function fontControlsFor(role) {
  return role === 'display'
    ? { preset: els.displayFontPreset, input: els.displayFontInput, customRow: els.displayFontCustomRow }
    : { preset: els.interfaceFontPreset, input: els.interfaceFontInput, customRow: els.interfaceFontCustomRow };
}

function syncFontCustomRow(role) {
  const controls = fontControlsFor(role);
  const isCustom = controls.preset?.value === 'custom';
  controls.customRow?.classList.toggle('hidden', !isCustom);
  if (controls.input) controls.input.disabled = !isCustom;
  updateFontPreview(role);
}

function fontFamilyFromControls(role) {
  const controls = fontControlsFor(role);
  return fontSettingsApi.fontFamilyForPreset(controls.preset?.value || (role === 'display' ? 'follow' : 'app'), controls.input?.value, role);
}

function fontPreviewForControls(role) {
  const resolved = fontSettingsApi.resolveEffectiveFontSettings({
    interfaceFontFamily: fontFamilyFromControls('interface'),
    displayFontFamily: fontFamilyFromControls('display')
  });
  return role === 'display' ? resolved.displayFont : resolved.interfaceFont;
}

function updateFontPreview(role) {
  const preview = role === 'display' ? els.displayFontPreview : els.interfaceFontPreview;
  if (preview) preview.style.fontFamily = fontPreviewForControls(role);
}

function fontPatchFromControls() {
  return {
    interfaceFontFamily: fontFamilyFromControls('interface'),
    displayFontFamily: fontFamilyFromControls('display')
  };
}

function previewFontSettings() {
  syncFontCustomRow('interface');
  syncFontCustomRow('display');
  applyFontSettings(fontPatchFromControls());
}

async function saveFontSettingsFromControls() {
  previewFontSettings();
  await saveSettings(fontPatchFromControls());
}

function handleFontPresetChange(role) {
  syncFontCustomRow(role);
  const controls = fontControlsFor(role);
  previewFontSettings();
  if (controls.preset?.value === 'custom') {
    controls.input?.focus();
    if (!fontSettingsApi.normalizeFontFamily(controls.input?.value)) return;
  }
  void saveFontSettingsFromControls();
}

async function resetInterfaceFont() {
  if (els.interfaceFontPreset) els.interfaceFontPreset.value = 'app';
  if (els.interfaceFontInput) els.interfaceFontInput.value = '';
  syncFontCustomRow('interface');
  previewFontSettings();
  await saveSettings({ interfaceFontFamily: '' });
}

async function resetDisplayFont() {
  if (els.displayFontPreset) els.displayFontPreset.value = 'app';
  if (els.displayFontInput) els.displayFontInput.value = '';
  syncFontCustomRow('display');
  previewFontSettings();
  await saveSettings({ displayFontFamily: fontSettingsApi.DEFAULT_DISPLAY_FONT });
}

function syncFontSettingsControls() {
  for (const [role, settingKey] of [['interface', 'interfaceFontFamily'], ['display', 'displayFontFamily']]) {
    const controls = fontControlsFor(role);
    const value = fontSettingsApi.normalizeFontFamily(state.settings?.[settingKey]);
    const preset = fontSettingsApi.presetForFontFamily(value, role);
    if (controls.preset) controls.preset.value = preset;
    if (controls.input) controls.input.value = preset === 'custom' ? value : '';
    syncFontCustomRow(role);
  }
}

function syncSliderRow(input) {
  if (!input) return;
  const valueEl = input.closest('.settings-slider-item')?.querySelector('.slider-value');
  if (valueEl) valueEl.textContent = String(Math.round(Number(input.value)));
}

function syncSliderRows() {
  syncSliderRow(els.glassInput);
  syncSliderRow(els.blurInput);
  syncSliderRow(els.zoomInput);
}

function applyAppearanceFromControls() {
  const patch = appearancePatchFromControls();
  applyAppearanceSettings(patch);
  syncSliderRows();
  window.tokenMonitor.previewAppearance?.(patch).catch(() => {});
}

async function saveAppearanceFromControls() {
  await saveSettings({ ...appearancePatchFromControls(), discordRpcEnabled: Boolean(els.discordRpcInput.checked) });
}

function syncHubModeUi() {
  const mode = state.settings.hubMode || 'local';
  for (const input of els.hubModeOptions.querySelectorAll('input[name="hubMode"]')) {
    input.checked = input.value === mode;
  }
  els.hubClientFields.classList.toggle('hidden', mode !== 'client');
  els.hubHostFields.classList.toggle('hidden', mode !== 'host');
  if (mode === 'host') {
    els.hubPortInput.value = String(state.settings.hubHostPort || 17321);
    els.hubSecretInput.value = state.settings.hubHostSecret || '';
    renderHubStatus();
  }
  renderSyncClientStatus();
  renderHubBuildStatus();
}

function renderHubStatus() {
  if (!els.hubStatusRow || !els.hubAddressList) return;
  const info = state.hubInfo;
  const port = Number(state.settings.hubHostPort || 17321);
  if (!info) {
    els.hubStatusRow.textContent = t('settings.sync.starting');
    els.hubStatusRow.className = 'hub-status';
    els.hubAddressList.replaceChildren();
    return;
  }
  if (info.error) {
    const code = info.error.code === 'EADDRINUSE' ? t('settings.sync.portInUse', { port }) : info.error.code || t('settings.common.error');
    els.hubStatusRow.textContent = `${code} — ${info.error.message}`;
    els.hubStatusRow.className = 'hub-status error';
    els.hubAddressList.replaceChildren();
    return;
  }
  if (!info.listening) {
    els.hubStatusRow.textContent = t('settings.sync.hubStopped');
    els.hubStatusRow.className = 'hub-status';
    els.hubAddressList.replaceChildren();
    return;
  }
  els.hubStatusRow.textContent = t('settings.sync.listening', { port: info.listeningPort });
  els.hubStatusRow.className = 'hub-status ok';
  renderHubAddresses(info.lanAddresses || [], info.listeningPort);
}

function renderSyncClientStatus() {
  if (!els.syncClientStatus) return;
  // Gate on the runtime mode, not just the hubMode setting: client mode with no
  // URL falls back to the local collector (mode 'local'), and its statuses must
  // not surface as a sync failure in this row. Matches liveDotTitle's gating.
  const show = state.settings?.hubMode === 'client' && state.mode === 'sync' && !state.streamConnected;
  const text = show ? streamFailureText(state.streamFailure) : '';
  els.syncClientStatus.textContent = text;
  els.syncClientStatus.className = 'hub-status error';
  // Empty .hub-status still renders a bordered box, so hide it entirely when
  // there is nothing to show (connected, or not in client mode).
  els.syncClientStatus.hidden = !text;
}

function renderHubBuildStatus() {
  if (!els.hubBuildStatus) return;
  const visible = state.settings?.hubMode === 'client';
  const model = visible ? hubBuildPresentationApi.presentation(state.hubBuildStatus) : null;
  if (!model) {
    els.hubBuildStatus.hidden = true;
    els.hubBuildStatus.textContent = '';
    return;
  }
  const target = t(model.targetKey);
  els.hubBuildStatus.textContent = t(model.key, { target });
  els.hubBuildStatus.className = `hub-status hub-build-status${model.tone ? ` ${model.tone}` : ''}`;
  els.hubBuildStatus.hidden = false;
}

function renderHubAddresses(addresses, port) {
  els.hubAddressList.replaceChildren();
  if (addresses.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hub-address-empty';
    empty.textContent = t('settings.sync.noLanAddress', { port });
    els.hubAddressList.appendChild(empty);
    return;
  }
  const header = document.createElement('div');
  header.className = 'hub-address-header';
  header.textContent = t('settings.sync.connectWith');
  els.hubAddressList.appendChild(header);
  for (const addr of addresses) {
    const url = `http://${addr.address}:${port}`;
    const row = document.createElement('div');
    row.className = 'hub-address-row';
    const code = document.createElement('code');
    code.textContent = url;
    const ifaceLabel = document.createElement('span');
    ifaceLabel.className = 'hub-address-iface';
    ifaceLabel.textContent = addr.interface;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'icon-button';
    copy.title = t('settings.sync.copyUrl', { url });
    copy.textContent = '⧉';
    copy.addEventListener('click', () => copyToClipboard(url, copy));
    row.append(code, ifaceLabel, copy);
    els.hubAddressList.appendChild(row);
  }
}

async function copyToClipboard(text, button) {
  try {
    if (window.tokenMonitor.copyText) await window.tokenMonitor.copyText(text);
    else await navigator.clipboard.writeText(text);
    if (button) {
      const previous = button.textContent;
      button.textContent = '✓';
      setTimeout(() => { button.textContent = previous; }, 900);
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function refreshHubInfo() {
  if (!window.tokenMonitor.getHubInfo) return;
  try {
    state.hubInfo = await window.tokenMonitor.getHubInfo();
    renderHubStatus();
  } catch (_) { /* ignore */ }
}

const HUB_BUILD_STATUS_REFRESH_TTL_MS = 5 * 60 * 1000;
let hubBuildStatusRequest = 0;
let hubBuildStatusLastProbeAt = 0;

function hubBuildStatusRefreshDue(now = Date.now()) {
  return !hubBuildStatusLastProbeAt
    || now < hubBuildStatusLastProbeAt
    || now - hubBuildStatusLastProbeAt >= HUB_BUILD_STATUS_REFRESH_TTL_MS;
}

async function refreshHubBuildStatus() {
  const request = ++hubBuildStatusRequest;
  if (!window.tokenMonitor.getHubBuildStatus || state.settings?.hubMode !== 'client') {
    hubBuildStatusLastProbeAt = 0;
    state.hubBuildStatus = null;
    renderHubBuildStatus();
    return;
  }
  hubBuildStatusLastProbeAt = Date.now();
  const requestedUrl = String(state.settings.hubUrl || '').trim().replace(/\/$/, '');
  try {
    const result = await window.tokenMonitor.getHubBuildStatus();
    const currentUrl = String(state.settings.hubUrl || '').trim().replace(/\/$/, '');
    if (request !== hubBuildStatusRequest
      || currentUrl !== requestedUrl
      || (result?.hubUrl && result.hubUrl !== currentUrl)) return;
    state.hubBuildStatus = result;
  } catch (_) {
    if (request !== hubBuildStatusRequest) return;
    state.hubBuildStatus = null;
  }
  renderHubBuildStatus();
}

function syncPeriodTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const activeSlot = fixedPeriodRangesApi.slotForSelection(state.period);
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.dataset.periodSlot === activeSlot));
  document.querySelector('.tabs')?.style.setProperty('--period-index', String(activeIndex));
  for (const tab of tabs) {
    const active = tab.dataset.periodSlot === activeSlot;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', String(active));
  }
  if (els.monthPeriodTab) {
    const mode = activeSlot === 'month'
      ? fixedPeriodRangesApi.normalizeMonthMode(state.period)
      : fixedPeriodRangesApi.normalizeMonthMode(state.settings?.periodMonthMode);
    els.monthPeriodTab.textContent = fixedPeriodRangesApi.displayLabel(mode);
    els.monthPeriodTab.dataset.period = mode;
  }
  syncPeriodMenu();
}

function applyInitialBreakdownPreference() {
  if (initialBreakdownPreferenceApplied || !state.settings) return;
  initialBreakdownPreferenceApplied = true;
  const next = viewDisplayPreferencesApi.preferredViewId({
    views: VIEW_DISPLAY_OPTIONS,
    orderValue: effectiveViewDisplayOrderValue(),
    hiddenValue: state.settings?.hiddenViews,
    availableIds: availableBreakdownIds(),
    currentId: state.breakdown,
    preferFirst: true
  });
  if (next !== state.breakdown) setBreakdown(next);
}

function renderSessionUsageArchiveStatus() {
  if (!els.sessionUsageArchiveStatus) return;
  if (state.settings?.sessionUsageArchiveEnabled === false) {
    els.sessionUsageArchiveStatus.textContent = t('settings.collection.sessionArchivePaused');
    return;
  }
  const count = sessionRowsApi.archivedSessionCount(state.stats);
  els.sessionUsageArchiveStatus.textContent = count > 0
    ? t('settings.collection.sessionArchiveActiveCount', { count })
    : t('settings.collection.sessionArchiveEmpty');
}

function syncSettingsForm() {
  applySettingsTranslations();
  applyInitialBreakdownPreference();
  syncPeriodTabs();
  syncHubModeUi();
  if (els.languageInput) els.languageInput.value = currentLanguage();
  if (els.periodMonthModeInput) {
    els.periodMonthModeInput.value = fixedPeriodRangesApi.normalizeMonthMode(state.settings?.periodMonthMode);
  }
  if (els.currencyInput) els.currencyInput.value = currentCurrency();
  syncCurrencyRateControls();
  els.hubUrlInput.value = state.settings.hubUrl || '';
  els.secretInput.value = state.settings.secret || '';
  els.deviceIdInput.value = state.settings.deviceId || '';
  els.limitsRefreshInput.value = state.settings.limitsRefreshMode === 'adaptive'
    ? 'adaptive'
    : String(LIMIT_REFRESH_OPTIONS.includes(Number(state.settings.limitsRefreshMs)) ? state.settings.limitsRefreshMs : 300000);
  if (els.limitsRefreshAdaptiveNote) {
    els.limitsRefreshAdaptiveNote.classList.toggle('hidden', state.settings.limitsRefreshMode !== 'adaptive');
  }
  els.showLimitSourceInput.checked = Boolean(state.settings.showLimitSource);
  els.maskLimitAccountEmailsInput.checked = Boolean(state.settings.maskLimitAccountEmails);
  renderSubscriptionSettings();
  const showLimitUsed = state.settings.showLimitUsed ? 'used' : 'remaining';
  for (const input of els.showLimitUsedInputs || []) input.checked = input.value === showLimitUsed;
  if (els.syncUploadIntervalInput) {
    const value = Number(state.settings.syncUploadIntervalMs);
    const allowed = Array.from(els.syncUploadIntervalInput.options, (option) => Number(option.value));
    els.syncUploadIntervalInput.value = String(allowed.includes(value) ? value : 0);
  }
  if (els.collectionCadenceInput) {
    const value = Number(state.settings.collectionIntervalMs);
    const allowed = [300000, 900000, 1800000];
    els.collectionCadenceInput.value = state.settings.collectionMode === 'smart'
      ? 'smart'
      : state.settings.collectionMode === 'interval'
        ? String(allowed.includes(value) ? value : 300000)
        : 'live';
    if (els.collectionCadenceNote) {
      els.collectionCadenceNote.hidden = els.collectionCadenceInput.value === 'live';
    }
  }
  if (els.wslScanInput) els.wslScanInput.checked = state.settings.wslScanEnabled !== false;
  if (els.sessionUsageArchiveInput) els.sessionUsageArchiveInput.checked = state.settings.sessionUsageArchiveEnabled !== false;
  renderAutomaticAppUpdateControl();
  renderSessionUsageArchiveStatus();
  const exportAutoOn = Boolean(state.settings.exportAutoEnabled);
  const exportDir = state.settings.exportDir || '';
  if (els.exportAutoInput) els.exportAutoInput.checked = exportAutoOn;
  if (els.exportAutoDetails) els.exportAutoDetails.classList.toggle('hidden', !exportAutoOn);
  if (els.exportIntervalInput) els.exportIntervalInput.value = String(state.settings.exportIntervalMs || 60000);
  if (els.exportDirLabel) els.exportDirLabel.textContent = exportDir || t('settings.export.noFolder');
  if (els.exportAutoStatus) {
    const exportActive = exportAutoOn && Boolean(exportDir);
    els.exportAutoStatus.classList.toggle('hidden', !exportAutoOn);
    els.exportAutoStatus.classList.toggle('is-active', exportActive);
    els.exportAutoStatus.textContent = exportActive
      ? t('settings.export.statusActive')
      : t('settings.export.statusNeedsFolder');
  }
  renderWslPanel();
  const systemGlass = state.settings.systemGlass === false ? 'off' : 'system';
  for (const input of els.systemGlassInputs || []) input.checked = input.value === systemGlass;
  if (els.windowsBackdropInput) els.windowsBackdropInput.value = windowsGlassApi.normalizeWindowsBackdropMode(state.settings.windowsBackdrop);
  const reduceMotion = motionPreferenceApi.normalize(state.settings.reduceMotion);
  for (const input of els.reduceMotionInputs || []) input.checked = input.value === reduceMotion;
  els.liveDotInput.checked = state.settings.showLiveDot !== false;
  els.toolIconsInput.checked = state.settings.showToolIcons !== false;
  els.titleIconInput.checked = state.settings.titleIconOnly === true;
  els.showCompactTotalTokensInput.checked = state.settings.showCompactTotalTokens === true;
  if (els.compactTokenUnitsInput) {
    els.compactTokenUnitsInput.value = state.settings.compactTokenUnits === 'localized' ? 'localized' : 'western';
  }
  syncFontSettingsControls();
  els.compactTokenUnitsRow?.classList.toggle(
    'hidden',
    !supportsLocalizedCompactTokenUnits(currentLocale())
  );
  els.swapSettingsRefreshInput.checked = state.settings.settingsInTitlebar === true;
  els.discordRpcInput.checked = Boolean(state.settings.discordRpcEnabled);
  syncWindowBehaviorControls();
  els.floatingBubbleInput.checked = state.settings.floatingBubbleEnabled === true;
  const floatingBubbleTrigger = state.settings.floatingBubbleTrigger === 'hover' ? 'hover' : 'click';
  for (const input of els.floatingBubbleTriggerInputs || []) input.checked = input.value === floatingBubbleTrigger;
  if (els.floatingBubbleContentInput) els.floatingBubbleContentInput.value = normalizeTrayContentValue(state.settings.floatingBubbleContent);
  els.floatingBubbleOptions?.classList.toggle('hidden', state.settings.floatingBubbleEnabled !== true);
  const showTrayIcon = state.settings.showTrayIcon !== false;
  if (els.showTrayIconInput) els.showTrayIconInput.checked = showTrayIcon;
  els.trayModeInput.disabled = !showTrayIcon;
  els.trayModeInput.checked = showTrayIcon && Boolean(state.settings.trayMode);
  els.trayContentInput.value = ['tokens', 'cost', 'both', 'tokensAll', 'costAll', 'bothAll', 'limitsAllSessions', 'bars', 'barsSession', 'barsWeekly', 'barsAllSessions', 'icon', 'custom'].includes(state.settings.trayContent) ? state.settings.trayContent : 'tokens';
  els.trayContentInput.disabled = !showTrayIcon;
  els.showTrayProviderBadgeInput.checked = state.settings.showTrayProviderBadge === true;
  els.showTrayProviderBadgeInput.disabled = !showTrayIcon;
  els.trayIconOptions?.classList.toggle('hidden', !showTrayIcon);
  els.trayOptions?.classList.toggle('hidden', !showTrayIcon || !state.settings.trayMode);
  refreshTrayComposers();
  syncWindowShortcutStatus();
  if (els.startAtLoginInput) {
    els.startAtLoginInput.disabled = !state.appInfo?.loginItemSupported;
    els.startAtLoginInput.checked = Boolean(state.settings.startAtLogin && state.appInfo?.loginItemSupported);
  }
  if (els.startupNote) {
    els.startupNote.textContent = !state.appInfo?.loginItemSupported
      ? t('settings.startup.available')
      : state.appInfo?.platform === 'linux'
        ? t('settings.startup.appimageNote')
        : t('settings.startup.launchAtSignIn');
  }
  els.glassInput.value = String(state.settings.glassOpacity ?? 68);
  els.blurInput.value = String(state.settings.glassBlur ?? 32);
  els.zoomInput.value = String(Math.round((Number(state.settings.zoomFactor) || 1) * 100));
  syncSliderRows();
  renderDeepseekStatus();
  renderMinimaxStatus();
  renderExternalProviderStatus('claude');
  renderExternalProviderStatus('zai');
  renderExternalProviderStatus('zaiteam');
  renderExternalProviderStatus('volcengine');
  renderExternalProviderStatus('qoder');
  renderExternalProviderStatus('commandcode');
  renderExternalProviderStatus('kimi');
  renderExternalProviderStatus('ollama');
  renderMimoStatus();
  renderCopilotStatus();
  renderViewPreferences();
  renderToolPreferences();
  renderLimitProviderCheckboxes();
  renderSettingsSummaries();
  renderOpenCodeProfiles();
  renderOpenRouterProfiles();
  renderThirdPartyProfiles();
  applyVendorColorOverrides(state.settings.vendorColors);
  applyAppearanceSettings(state.settings);
  buildAppearanceColorControls();
  renderTokscaleStatus();
  renderSettingsAppUpdateRow();
  renderCodexAccounts();
  renderCustomPricing();
  renderCursorStatus();
  applyFloatingBubbleState(state.floatingBubble);
  if (state.breakdown === 'limits') renderLimits();
  else render();
}

function enabledClientSet() {
  return new Set(String(state.settings.clients || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function hiddenClientSet() {
  return new Set(clientDisplayPreferencesApi.normalizeHiddenClients(state.settings?.hiddenClients, KNOWN_CLIENTS).split(',').filter(Boolean));
}

function hiddenViewSet() {
  return new Set(viewDisplayPreferencesApi.normalizeHiddenViews(state.settings?.hiddenViews, VIEW_DISPLAY_OPTIONS).split(',').filter(Boolean));
}

// Views the user cannot reach because the feature behind them is switched off.
// The settings rows, the summary count and the last-visible-view guard all read
// this one list so they cannot disagree about what is on screen.
function disabledViewIds() {
  const ids = [];
  if (state.settings?.historyEnabled === false) ids.push('trends');
  if (state.settings?.projectsEnabled === false) ids.push('project');
  return ids;
}

function hiddenHomeModuleSet() {
  return new Set(homeModulePreferencesApi.normalizeHiddenHomeModules(state.settings?.hiddenHomeModules, HOME_MODULE_OPTIONS).split(',').filter(Boolean));
}

function hiddenHomeLimitProviderSet() {
  const hidden = limitProviderOrderApi.normalizeLimitProviderSelection(state.settings?.hiddenHomeLimitProviders || '', LIMIT_PROVIDERS);
  return new Set(hidden);
}

function homeLimitProviderOrderValue() {
  return state.settings?.homeLimitProviderOrder || state.settings?.limitProviderOrder;
}

function viewLabel(view) {
  return t(view.labelKey || `views.${view.id}`);
}

function pinnedClientSet() {
  return new Set(clientDisplayPreferencesApi.normalizePinnedClients(state.settings?.pinnedClients, KNOWN_CLIENTS).split(',').filter(Boolean));
}

function visibilityIcon(hidden) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const paths = [
    'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'
  ];
  if (hidden) paths.push('M4 4l16 16');
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function pinIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M14 3l7 7-3 1-4 4 .5 3-2 2-3-5-5-3 2-2 3 .5 4-4 1-3Z');
  svg.appendChild(path);
  return svg;
}

function preferenceListForKind(kind) {
  if (kind === 'client') return els.clientDisplayList;
  if (kind === 'view') return els.viewDisplayList;
  if (kind === 'statusProvider') return document.getElementById('serviceProviderList');
  if (kind === 'homeModule') return document.getElementById('homeSettingsList');
  if (kind === 'homeLimitProvider') return document.getElementById('homeLimitProviderList');
  return els.limitProviderCheckboxes;
}

function preferenceItemAttribute(kind) {
  if (kind === 'client') return 'client';
  if (kind === 'view') return 'view';
  if (kind === 'statusProvider') return 'statusProvider';
  if (kind === 'homeModule') return 'homeModule';
  if (kind === 'homeLimitProvider') return 'homeLimitProvider';
  return 'provider';
}

function preferenceRows(kind) {
  const list = preferenceListForKind(kind);
  const selector = kind === 'client'
    ? '.tool-preference-row[data-client]'
    : kind === 'view'
      ? '.view-preference-row[data-view]'
      : kind === 'statusProvider'
        ? '.status-provider-row[data-status-provider]'
        : kind === 'homeModule'
          ? '.home-module-preference-row[data-home-module]'
          : kind === 'homeLimitProvider'
            ? '.home-limit-provider-row[data-home-limit-provider]'
            : '.limit-provider-row[data-provider]';
  return Array.from(list?.querySelectorAll(selector) || []);
}

function preferenceOrder(kind) {
  const attr = preferenceItemAttribute(kind);
  return preferenceRows(kind).map((row) => row.dataset[attr]).filter(Boolean);
}

function preferenceRowRects(kind) {
  const attr = preferenceItemAttribute(kind);
  return preferenceRows(kind).map((row) => {
    const rect = row.getBoundingClientRect();
    return { id: row.dataset[attr], top: rect.top, bottom: rect.bottom };
  });
}

function applyPreferenceOrder(kind, order) {
  const list = preferenceListForKind(kind);
  if (!list) return;
  const attr = preferenceItemAttribute(kind);
  const rowsById = new Map(preferenceRows(kind).map((row) => [row.dataset[attr], row]));
  for (const id of order || []) {
    const row = rowsById.get(id);
    if (row) list.appendChild(row);
  }
}

function finishPreferenceDrag() {
  setPreferencePointerListeners(false);
  document.querySelectorAll('.is-dragging').forEach((row) => row.classList.remove('is-dragging'));
  preferenceDrag = null;
}

function applyPreferenceLiveOrder(kind, clientY) {
  if (!preferenceDrag) return -1;
  const currentOrder = preferenceOrder(kind);
  const nextOrder = preferenceDragSortApi.reorderItemsFromClientY(currentOrder, preferenceRowRects(kind), preferenceDrag.id, clientY);
  if (nextOrder.join(',') !== currentOrder.join(',')) {
    applyPreferenceOrder(kind, nextOrder);
    preferenceDrag.changed = true;
  }
  preferenceDrag.order = nextOrder;
  return nextOrder;
}

function startPreferenceDrag(event, kind, id) {
  if (event.currentTarget.disabled) return;
  event.preventDefault();
  const order = preferenceOrder(kind);
  preferenceDrag = { kind, id, pointerId: event.pointerId, originalOrder: order, order, changed: false, handle: event.currentTarget };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  event.currentTarget.closest('[data-client], [data-provider], [data-view], [data-status-provider], [data-home-module], [data-home-limit-provider]')?.classList.add('is-dragging');
  setPreferencePointerListeners(true);
  applyPreferenceLiveOrder(kind, event.clientY);
}

function setPreferencePointerListeners(active) {
  const method = active ? 'addEventListener' : 'removeEventListener';
  window[method]('pointermove', onPreferencePointerMove, true);
  window[method]('pointerup', onPreferencePointerUp, true);
  window[method]('pointercancel', onPreferencePointerCancel, true);
}

function releasePreferencePointer(pointerId) {
  const handle = preferenceDrag?.handle;
  if (handle?.hasPointerCapture?.(pointerId)) {
    handle.releasePointerCapture(pointerId);
  }
}

function onPreferencePointerMove(event) {
  if (!preferenceDrag || preferenceDrag.pointerId !== event.pointerId) return;
  event.preventDefault();
  applyPreferenceLiveOrder(preferenceDrag.kind, event.clientY);
}

function onPreferencePointerUp(event) {
  if (!preferenceDrag || preferenceDrag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const { kind } = preferenceDrag;
  const order = applyPreferenceLiveOrder(kind, event.clientY) || preferenceDrag.order;
  const changed = preferenceDrag.changed;
  releasePreferencePointer(event.pointerId);
  finishPreferenceDrag();
  if (changed) void onPreferenceOrderCommit(kind, order);
}

function onPreferencePointerCancel(event) {
  if (!preferenceDrag || preferenceDrag.pointerId !== event.pointerId) return;
  applyPreferenceOrder(preferenceDrag.kind, preferenceDrag.originalOrder);
  releasePreferencePointer(event.pointerId);
  finishPreferenceDrag();
}

function createPreferenceOrderHandle({ kind, id, label, count }) {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'preference-order-handle';
  handle.dataset.preferenceOrderHandle = kind;
  const titleKey = kind === 'view'
    ? 'settings.views.reorderView'
    : kind === 'statusProvider'
      ? 'serviceStatus.reorderProvider'
      : kind === 'homeModule'
        ? 'settings.home.reorderModule'
        : 'settings.home.reorderProvider';
  handle.title = t(titleKey, { name: label });
  handle.setAttribute('aria-label', handle.title);
  handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End');
  handle.disabled = count <= 1;
  handle.addEventListener('pointerdown', (event) => startPreferenceDrag(event, kind, id));
  handle.addEventListener('keydown', (event) => onPreferenceOrderKeydown(event, kind, id));
  return handle;
}

// The limit provider list drags from the whole row instead of a handle. The
// gesture itself is generic and lives in `rowDragController.js`; what stays
// here is the wiring to this list's DOM, ordering setting, and accordion.
//
// The checkbox, nested controls, and options panel own their clicks. The main
// disclosure button is deliberately the drag surface too: below the threshold
// it clicks, above it the drag suppresses that click.
const LIMIT_PROVIDER_DRAG_EXCLUDED = 'button:not(.limit-provider-main), input, select, textarea, a, .accordion-animated-container';

const limitProviderRowDrag = rowDragControllerApi.createRowDragController({
  dragSort: verticalDragSortApi,
  getList: () => els.limitProviderCheckboxes,
  getScrollPanel: () => els.settingsPanel,
  rowSelector: '.limit-provider-row[data-provider]',
  idKey: 'provider',
  dragExcluded: LIMIT_PROVIDER_DRAG_EXCLUDED,
  getExpanded: () => state.limitProviderSettingsExpanded,
  setExpanded: setLimitProviderSettingsExpanded,
  applyOrder: (order) => applyPreferenceOrder('provider', order),
  preserveScroll: preserveSettingsPanelScroll,
  mirrorOrder: (order) => { state.settings = { ...state.settings, limitProviderOrder: order.join(',') }; },
  // Saved directly rather than through `onPreferenceOrderCommit`, whose no-op
  // guard compares against the value `mirrorOrder` just wrote and would drop it.
  persistOrder: (order) => void saveSettings({ limitProviderOrder: order.join(',') }),
  requestRender: () => renderLimitProviderCheckboxes()
});

function renderViewPreferences() {
  if (!els.viewDisplayList) return;
  const hidden = hiddenViewSet();
  const orderValue = effectiveViewDisplayOrderValue();
  const views = viewDisplayPreferencesApi.orderedViews(VIEW_DISPLAY_OPTIONS, orderValue);
  const hasCustomOrder = viewDisplayPreferencesApi.hasCustomViewDisplayOrder(state.settings?.viewDisplayOrder);
  const hasHiddenViews = hidden.size > 0;
  if (els.resetViewDisplayOrderButton) els.resetViewDisplayOrderButton.disabled = !hasCustomOrder;
  if (els.showAllViewsButton) els.showAllViewsButton.disabled = !hasHiddenViews;
  els.viewDisplayList.replaceChildren();
  const disabled = new Set(disabledViewIds());
  const visibleCount = viewDisplayPreferencesApi.visibleViewCount({
    views,
    hiddenValue: state.settings?.hiddenViews,
    disabledIds: [...disabled]
  });
  for (const view of views) {
    const id = view.id;
    const label = viewLabel(view);
    const isHidden = hidden.has(id);
    const isDisabled = disabled.has(id);
    const isEffectivelyHidden = isHidden || isDisabled;
    const row = document.createElement('div');
    row.className = 'view-preference-row';
    row.dataset.view = id;
    row.classList.toggle('is-hidden', isEffectivelyHidden);
    row.classList.toggle('is-disabled', isDisabled);
    const name = document.createElement('div');
    name.className = 'tool-preference-name';
    name.textContent = label;
    const visibility = document.createElement('button');
    visibility.type = 'button';
    visibility.className = `tool-visibility-button${isEffectivelyHidden ? ' is-hidden' : ''}`;
    visibility.dataset.view = id;
    visibility.title = t(isEffectivelyHidden ? 'settings.views.showView' : 'settings.views.hideView', { name: label });
    visibility.setAttribute('aria-label', visibility.title);
    visibility.setAttribute('aria-pressed', String(!isEffectivelyHidden));
    visibility.disabled = !isEffectivelyHidden && visibleCount <= 1;
    visibility.append(visibilityIcon(isEffectivelyHidden));
    visibility.addEventListener('click', () => {
      if (id === 'trends') return onTrendVisibilityToggle();
      if (id === 'project') return onProjectVisibilityToggle();
      return onViewVisibilityToggle(id);
    });
    const handle = createPreferenceOrderHandle({ kind: 'view', id, label, count: views.length });
    const actions = document.createElement('div');
    actions.className = 'tool-preference-actions';
    actions.append(visibility, handle);
    row.append(name, actions);
    els.viewDisplayList.appendChild(row);
    if (id === 'home') {
      row.classList.add('has-subgroup');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `view-subgroup-toggle${state.homeSettingsExpanded ? ' is-expanded' : ''}`;
      toggle.title = t('settings.views.configureHome', { name: label });
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', String(Boolean(state.homeSettingsExpanded)));
      const toggleIcon = document.createElement('span');
      toggleIcon.className = 'view-subgroup-icon';
      toggleIcon.setAttribute('aria-hidden', 'true');
      toggle.append(toggleIcon);
      toggle.addEventListener('click', () => {
        state.homeSettingsExpanded = !state.homeSettingsExpanded;
        toggle.classList.toggle('is-expanded', state.homeSettingsExpanded);
        toggle.setAttribute('aria-expanded', String(Boolean(state.homeSettingsExpanded)));
        const container = document.getElementById('homeSettingsContainer');
        if (container) container.classList.toggle('hidden', !state.homeSettingsExpanded);
      });
      actions.insertBefore(toggle, visibility);

      const listContainer = document.createElement('div');
      listContainer.id = 'homeSettingsContainer';
      listContainer.className = `accordion-animated-container${state.homeSettingsExpanded ? '' : ' hidden'}`;
      const inner = document.createElement('div');
      inner.className = 'accordion-animation-inner';
      inner.appendChild(renderHomeSettingsList());
      listContainer.appendChild(inner);
      els.viewDisplayList.appendChild(listContainer);
    }
    if (id === 'trends') {
      row.classList.add('has-subgroup');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `view-subgroup-toggle${state.trendSettingsExpanded ? ' is-expanded' : ''}`;
      toggle.title = t('settings.views.configureTrend', { name: label });
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', String(Boolean(state.trendSettingsExpanded)));
      const toggleIcon = document.createElement('span');
      toggleIcon.className = 'view-subgroup-icon';
      toggleIcon.setAttribute('aria-hidden', 'true');
      toggle.append(toggleIcon);
      toggle.addEventListener('click', () => {
        state.trendSettingsExpanded = !state.trendSettingsExpanded;
        toggle.classList.toggle('is-expanded', state.trendSettingsExpanded);
        toggle.setAttribute('aria-expanded', String(Boolean(state.trendSettingsExpanded)));
        const container = document.getElementById('trendSettingsContainer');
        if (container) container.classList.toggle('hidden', !state.trendSettingsExpanded);
      });
      actions.insertBefore(toggle, visibility);
      
      const listContainer = document.createElement('div');
      listContainer.id = 'trendSettingsContainer';
      listContainer.className = `accordion-animated-container${state.trendSettingsExpanded ? '' : ' hidden'}`;
      const inner = document.createElement('div');
      inner.className = 'accordion-animation-inner';
      inner.appendChild(renderTrendSettingsList());
      listContainer.appendChild(inner);
      els.viewDisplayList.appendChild(listContainer);
    }
    if (id === 'project') {
      row.classList.add('has-subgroup');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `view-subgroup-toggle${state.projectSettingsExpanded ? ' is-expanded' : ''}`;
      toggle.title = t('settings.views.configureProject', { name: label });
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', String(Boolean(state.projectSettingsExpanded)));
      const toggleIcon = document.createElement('span');
      toggleIcon.className = 'view-subgroup-icon';
      toggleIcon.setAttribute('aria-hidden', 'true');
      toggle.append(toggleIcon);
      toggle.addEventListener('click', () => {
        state.projectSettingsExpanded = !state.projectSettingsExpanded;
        toggle.classList.toggle('is-expanded', state.projectSettingsExpanded);
        toggle.setAttribute('aria-expanded', String(Boolean(state.projectSettingsExpanded)));
        const container = document.getElementById('projectSettingsContainer');
        if (container) container.classList.toggle('hidden', !state.projectSettingsExpanded);
      });
      actions.insertBefore(toggle, visibility);

      const listContainer = document.createElement('div');
      listContainer.id = 'projectSettingsContainer';
      listContainer.className = `accordion-animated-container${state.projectSettingsExpanded ? '' : ' hidden'}`;
      const inner = document.createElement('div');
      inner.className = 'accordion-animation-inner';
      inner.appendChild(renderProjectSettingsList());
      listContainer.appendChild(inner);
      els.viewDisplayList.appendChild(listContainer);
    }
    if (id === 'status') {
      row.classList.add('has-subgroup');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `view-subgroup-toggle${state.serviceProvidersExpanded ? ' is-expanded' : ''}`;
      toggle.title = t('serviceStatus.configureProviders', { name: label });
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', String(Boolean(state.serviceProvidersExpanded)));
      const toggleIcon = document.createElement('span');
      toggleIcon.className = 'view-subgroup-icon';
      toggleIcon.setAttribute('aria-hidden', 'true');
      toggle.append(toggleIcon);
      toggle.addEventListener('click', () => {
        state.serviceProvidersExpanded = !state.serviceProvidersExpanded;
        toggle.classList.toggle('is-expanded', state.serviceProvidersExpanded);
        toggle.setAttribute('aria-expanded', String(Boolean(state.serviceProvidersExpanded)));
        const container = document.getElementById('serviceProvidersContainer');
        if (container) container.classList.toggle('hidden', !state.serviceProvidersExpanded);
      });
      actions.insertBefore(toggle, actions.firstChild);
      
      const listContainer = document.createElement('div');
      listContainer.id = 'serviceProvidersContainer';
      listContainer.className = `accordion-animated-container${state.serviceProvidersExpanded ? '' : ' hidden'}`;
      const inner = document.createElement('div');
      inner.className = 'accordion-animation-inner';
      inner.appendChild(renderServiceProviderList());
      listContainer.appendChild(inner);
      els.viewDisplayList.appendChild(listContainer);
    }
  }
}

function renderHomeLimitProviderList() {
  const wrap = document.createElement('div');
  wrap.id = 'homeLimitProviderList';
  wrap.className = 'settings-nested-list home-limit-provider-list';
  const hidden = hiddenHomeLimitProviderSet();
  const enabled = enabledLimitProviderSet();
  const providers = limitProviderOrderApi
    .orderedLimitProviders(LIMIT_PROVIDERS, homeLimitProviderOrderValue())
    .filter(({ id }) => enabled.has(id));
  const hasCustomOrder = Boolean(state.settings?.homeLimitProviderOrder);
  const statusLabel = document.createElement('label');
  statusLabel.className = 'checkbox-label home-limit-status-setting';
  const statusInput = document.createElement('input');
  statusInput.type = 'checkbox';
  statusInput.checked = state.settings?.showHomeLimitBars === true;
  const statusText = document.createElement('span');
  statusText.textContent = t('settings.home.showLimitBars');
  statusInput.addEventListener('change', () => void saveSettings({ showHomeLimitBars: statusInput.checked }));
  statusLabel.append(statusInput, statusText);
  const providerNamesLabel = document.createElement('label');
  providerNamesLabel.className = 'checkbox-label home-limit-status-setting';
  const providerNamesInput = document.createElement('input');
  providerNamesInput.type = 'checkbox';
  const providerNamesRequired = state.settings?.showToolIcons === false;
  providerNamesInput.checked = providerNamesRequired || state.settings?.showHomeLimitProviderNames === true;
  providerNamesInput.disabled = providerNamesRequired;
  const providerNamesText = document.createElement('span');
  providerNamesText.textContent = t('settings.home.showLimitProviderNames');
  const providerNamesCopy = document.createElement('span');
  providerNamesCopy.className = 'home-limit-provider-names-copy';
  providerNamesCopy.append(providerNamesText);
  if (providerNamesRequired) {
    const requiredReason = t('settings.home.providerNamesRequiredWithoutIcons');
    const requiredReasonText = document.createElement('span');
    requiredReasonText.id = 'homeLimitProviderNamesReason';
    requiredReasonText.className = 'home-limit-provider-names-reason';
    requiredReasonText.textContent = requiredReason;
    providerNamesCopy.append(requiredReasonText);
    providerNamesLabel.title = requiredReason;
    providerNamesInput.setAttribute('aria-describedby', requiredReasonText.id);
  }
  providerNamesInput.addEventListener('change', async () => {
    await saveSettings({ showHomeLimitProviderNames: providerNamesInput.checked });
    renderHomeIfVisible();
  });
  providerNamesLabel.append(providerNamesInput, providerNamesCopy);
  const countLabel = document.createElement('label');
  countLabel.className = 'settings-item home-limit-account-count-setting';
  const countText = document.createElement('span');
  countText.className = 'settings-item-text';
  const countTitle = document.createElement('span');
  countTitle.className = 'settings-item-title';
  countTitle.textContent = t('settings.home.limitAccountCount');
  countText.append(countTitle);
  const countInput = document.createElement('input');
  countInput.type = 'number';
  countInput.min = '1';
  countInput.max = '12';
  countInput.step = '1';
  countInput.inputMode = 'numeric';
  countInput.value = String(state.settings?.homeLimitAccountCount ?? 3);
  countInput.addEventListener('change', async () => {
    await saveSettings({ homeLimitAccountCount: Number(countInput.value) });
    renderHomeIfVisible();
  });
  countLabel.append(countText, countInput);
  const header = document.createElement('div');
  header.className = 'settings-note-row home-limit-provider-header';
  const note = document.createElement('p');
  note.className = 'settings-note';
  note.textContent = t('settings.home.limitProvidersNote');
  const headerActions = document.createElement('div');
  headerActions.className = 'tool-header-actions';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'tool-header-action';
  reset.textContent = '↺';
  reset.title = t('settings.views.resetOrder');
  reset.setAttribute('aria-label', reset.title);
  reset.disabled = !hasCustomOrder;
  reset.addEventListener('click', () => void resetHomeLimitProviderOrder());
  const showAll = document.createElement('button');
  showAll.type = 'button';
  showAll.className = 'tool-header-action';
  const showAllEye = document.createElement('span');
  showAllEye.className = 'tool-header-eye';
  showAllEye.setAttribute('aria-hidden', 'true');
  showAll.append(showAllEye);
  showAll.title = t('settings.views.showAll');
  showAll.setAttribute('aria-label', showAll.title);
  showAll.disabled = providers.every(({ id }) => !hidden.has(id));
  showAll.addEventListener('click', () => void showAllHomeLimitProviders());
  headerActions.append(reset, showAll);
  header.append(note, headerActions);
  wrap.append(statusLabel, providerNamesLabel, countLabel, header);
  for (const { id, label, settingsLabel } of providers) {
    const isHidden = hidden.has(id);
    const row = document.createElement('div');
    row.className = 'home-limit-provider-row';
    row.dataset.homeLimitProvider = id;
    row.classList.toggle('is-hidden', isHidden);
    const labelGroup = document.createElement('div');
    labelGroup.className = 'tool-preference-label';
    const name = document.createElement('div');
    name.className = 'tool-preference-name';
    name.textContent = settingsLabel || label;
    labelGroup.append(name);
    const visibility = document.createElement('button');
    visibility.type = 'button';
    visibility.className = `tool-visibility-button${isHidden ? ' is-hidden' : ''}`;
    visibility.title = t(isHidden ? 'settings.home.showProvider' : 'settings.home.hideProvider', { name: settingsLabel || label });
    visibility.setAttribute('aria-label', visibility.title);
    visibility.setAttribute('aria-pressed', String(!isHidden));
    visibility.append(visibilityIcon(isHidden));
    visibility.addEventListener('click', () => onHomeLimitProviderVisibilityToggle(id));
    const handle = createPreferenceOrderHandle({ kind: 'homeLimitProvider', id, label: settingsLabel || label, count: providers.length });
    const actions = document.createElement('div');
    actions.className = 'tool-preference-actions';
    actions.append(visibility, handle);
    row.append(labelGroup, actions);
    wrap.append(row);
  }
  return wrap;
}

function renderHomeSettingsList() {
  const wrap = document.createElement('div');
  wrap.id = 'homeSettingsList';
  wrap.className = 'settings-nested-list home-settings-list';
  const hidden = hiddenHomeModuleSet();
  const modules = homeModulePreferencesApi.orderedHomeModules(HOME_MODULE_OPTIONS, state.settings?.homeModuleOrder);
  const hasCustomOrder = homeModulePreferencesApi.normalizeHomeModuleOrder(state.settings?.homeModuleOrder, HOME_MODULE_OPTIONS).join(',') !== homeModulePreferencesApi.DEFAULT_HOME_MODULE_ORDER;
  const header = document.createElement('div');
  header.className = 'settings-note-row home-settings-header';
  const note = document.createElement('p');
  note.className = 'settings-note home-settings-note';
  note.textContent = t('settings.views.homeSettingsNote');
  const headerActions = document.createElement('div');
  headerActions.className = 'tool-header-actions';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'tool-header-action';
  reset.textContent = '↺';
  reset.title = t('settings.views.resetOrder');
  reset.setAttribute('aria-label', reset.title);
  reset.disabled = !hasCustomOrder;
  reset.addEventListener('click', () => void resetHomeModuleOrder());
  const showAll = document.createElement('button');
  showAll.type = 'button';
  showAll.className = 'tool-header-action';
  const showAllEye = document.createElement('span');
  showAllEye.className = 'tool-header-eye';
  showAllEye.setAttribute('aria-hidden', 'true');
  showAll.append(showAllEye);
  showAll.title = t('settings.views.showAll');
  showAll.setAttribute('aria-label', showAll.title);
  showAll.disabled = hidden.size === 0;
  showAll.addEventListener('click', () => void showAllHomeModules());
  headerActions.append(reset, showAll);
  header.append(note, headerActions);
  wrap.append(header);
  for (const moduleOption of modules) {
    const id = moduleOption.id;
    const label = t(moduleOption.labelKey);
    const isHidden = hidden.has(id);
    const row = document.createElement('div');
    row.className = 'home-module-preference-row';
    row.dataset.homeModule = id;
    row.classList.toggle('is-hidden', isHidden);
    const name = document.createElement('div');
    name.className = 'tool-preference-name';
    name.textContent = label;
    const actions = document.createElement('div');
    actions.className = 'tool-preference-actions';
    if (id === 'limits' || id === 'trends') {
      const configure = document.createElement('button');
      configure.type = 'button';
      const expanded = id === 'limits' ? state.homeLimitSettingsExpanded : state.homeActivitySettingsExpanded;
      configure.className = `view-subgroup-toggle${expanded ? ' is-expanded' : ''}`;
      configure.title = t(id === 'limits' ? 'settings.home.configureLimits' : 'settings.home.configureActivity');
      configure.setAttribute('aria-label', configure.title);
      configure.setAttribute('aria-expanded', String(Boolean(expanded)));
      const toggleIcon = document.createElement('span');
      toggleIcon.className = 'view-subgroup-icon';
      toggleIcon.setAttribute('aria-hidden', 'true');
      configure.append(toggleIcon);
      configure.addEventListener('click', () => {
        if (id === 'limits') {
          state.homeLimitSettingsExpanded = !state.homeLimitSettingsExpanded;
          configure.classList.toggle('is-expanded', state.homeLimitSettingsExpanded);
          configure.setAttribute('aria-expanded', String(Boolean(state.homeLimitSettingsExpanded)));
          const container = document.getElementById('homeLimitProviderContainer');
          if (container) container.classList.toggle('hidden', !state.homeLimitSettingsExpanded);
          return;
        }
        state.homeActivitySettingsExpanded = !state.homeActivitySettingsExpanded;
        configure.classList.toggle('is-expanded', state.homeActivitySettingsExpanded);
        configure.setAttribute('aria-expanded', String(Boolean(state.homeActivitySettingsExpanded)));
        const container = document.getElementById('homeActivitySettingsContainer');
        if (container) container.classList.toggle('hidden', !state.homeActivitySettingsExpanded);
      });
      actions.append(configure);
    }
    const visibility = document.createElement('button');
    visibility.type = 'button';
    visibility.className = `tool-visibility-button${isHidden ? ' is-hidden' : ''}`;
    visibility.title = t(isHidden ? 'settings.home.showModule' : 'settings.home.hideModule', { name: label });
    visibility.setAttribute('aria-label', visibility.title);
    visibility.setAttribute('aria-pressed', String(!isHidden));
    visibility.append(visibilityIcon(isHidden));
    visibility.addEventListener('click', () => onHomeModuleVisibilityToggle(id));
    const handle = createPreferenceOrderHandle({ kind: 'homeModule', id, label, count: modules.length });
    actions.append(visibility, handle);
    row.append(name, actions);
    wrap.append(row);
    if (id === 'limits') {
      const listContainer = document.createElement('div');
      listContainer.id = 'homeLimitProviderContainer';
      listContainer.className = `accordion-animated-container${state.homeLimitSettingsExpanded ? '' : ' hidden'}`;
      const inner = document.createElement('div');
      inner.className = 'accordion-animation-inner';
      inner.appendChild(renderHomeLimitProviderList());
      listContainer.appendChild(inner);
      wrap.append(listContainer);
    }
    if (id === 'trends') {
      const listContainer = document.createElement('div');
      listContainer.id = 'homeActivitySettingsContainer';
      listContainer.className = `accordion-animated-container${state.homeActivitySettingsExpanded ? '' : ' hidden'}`;
      const inner = document.createElement('div');
      inner.className = 'accordion-animation-inner';
      inner.appendChild(renderHomeActivitySettings());
      listContainer.appendChild(inner);
      wrap.append(listContainer);
    }
  }
  return wrap;
}

function renderHomeActivitySettings() {
  const frag = document.createDocumentFragment();

  const heatmapRow = document.createElement('div');
  heatmapRow.className = 'home-activity-settings';
  const heatmapLabel = document.createElement('span');
  heatmapLabel.textContent = t('settings.home.heatmapColor');
  const heatmapOptions = document.createElement('div');
  heatmapOptions.className = 'inline-options';
  heatmapOptions.setAttribute('role', 'radiogroup');
  heatmapOptions.setAttribute('aria-label', heatmapLabel.textContent);
  const currentMetric = state.settings?.heatmapMetric || 'cost';
  for (const metric of ['tokens', 'cost']) {
    const option = document.createElement('label');
    option.className = 'inline-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'homeHeatmapMetric';
    input.value = metric;
    input.checked = currentMetric === metric;
    input.addEventListener('change', () => {
      if (input.checked) void saveSettings({ heatmapMetric: metric }).then(renderHomeIfVisible);
    });
    const text = document.createElement('span');
    text.textContent = t(metric === 'tokens' ? 'dashboard.heatmap.tokens' : 'dashboard.heatmap.cost');
    option.append(input, text);
    heatmapOptions.append(option);
  }
  heatmapRow.append(heatmapLabel, heatmapOptions);
  frag.append(heatmapRow);

  const daysRow = document.createElement('div');
  daysRow.className = 'home-activity-settings';
  const daysLabel = document.createElement('span');
  daysLabel.textContent = t('settings.home.activeDaysWindow');
  const daysOptions = document.createElement('div');
  daysOptions.className = 'inline-options';
  daysOptions.setAttribute('role', 'radiogroup');
  daysOptions.setAttribute('aria-label', daysLabel.textContent);
  const currentDaysWindow = state.settings?.homeActiveDaysWindow || 'all';
  for (const mode of ['all', 'year']) {
    const option = document.createElement('label');
    option.className = 'inline-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'homeActiveDaysWindow';
    input.value = mode;
    input.checked = currentDaysWindow === mode;
    input.addEventListener('change', () => {
      if (input.checked) void saveSettings({ homeActiveDaysWindow: mode }).then(renderHomeIfVisible);
    });
    const text = document.createElement('span');
    text.textContent = t(`settings.home.activeDaysWindow.${mode}`);
    option.append(input, text);
    daysOptions.append(option);
  }
  daysRow.append(daysLabel, daysOptions);
  frag.append(daysRow);

  return frag;
}

function renderTrendSettingsList() {
  const wrap = document.createElement('div');
  wrap.id = 'trendSettingsList';
  wrap.className = 'settings-nested-list trend-settings-list';
  const label = document.createElement('label');
  label.className = 'checkbox-label trend-settings-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = state.settings?.historyEnabled !== false;
  const text = document.createElement('span');
  text.textContent = t('settings.views.enableTrend');
  label.append(input, text);
  wrap.append(label);

  const HISTORY_INTERVAL_OPTIONS = [300000, 600000, 900000, 1800000, 3600000];
  const intervalRow = document.createElement('label');
  intervalRow.className = 'status-provider-interval';
  intervalRow.classList.toggle('hidden', !input.checked);
  const intervalLabel = document.createElement('span');
  intervalLabel.textContent = t('settings.views.trendInterval');
  const select = document.createElement('select');
  select.id = 'trendIntervalSelect';
  const currentMs = HISTORY_INTERVAL_OPTIONS.includes(Number(state.settings?.historyIntervalMs)) ? Number(state.settings.historyIntervalMs) : 900000;
  for (const ms of HISTORY_INTERVAL_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(ms);
    option.textContent = t('settings.views.trendIntervalMinutes', { n: ms / 60000 });
    if (ms === currentMs) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', () => void saveSettings({ historyIntervalMs: Number(select.value) }));
  intervalRow.append(intervalLabel, select);
  wrap.append(intervalRow);

  input.addEventListener('change', async () => {
    const enabling = input.checked;
    intervalRow.classList.toggle('hidden', !enabling);
    await setTrendEnabled(enabling);
    state.trendsActivating = enabling;
    renderHomeIfVisible();
  });

  return wrap;
}

function renderProjectSettingsList() {
  const wrap = document.createElement('div');
  wrap.id = 'projectSettingsList';
  wrap.className = 'settings-nested-list trend-settings-list';
  const label = document.createElement('label');
  label.className = 'checkbox-label trend-settings-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = state.settings?.projectsEnabled !== false;
  const text = document.createElement('span');
  text.textContent = t('settings.views.enableProjects');
  label.append(input, text);
  wrap.append(label);
  input.addEventListener('change', async () => {
    await setProjectsEnabled(input.checked);
    await refreshStats({ force: true });
  });
  return wrap;
}

async function setTrendEnabled(enabled) {
  if (!enabled) {
    await saveSettings({ historyEnabled: enabled });
    return;
  }
  const hidden = hiddenViewSet();
  hidden.delete('trends');
  const nextHiddenViews = Array.from(hidden).join(',');
  await saveSettings({ historyEnabled: enabled, hiddenViews: nextHiddenViews });
}

async function setProjectsEnabled(enabled) {
  if (!enabled) {
    await saveSettings({ projectsEnabled: false });
    return;
  }
  const hidden = hiddenViewSet();
  hidden.delete('project');
  await saveSettings({ projectsEnabled: true, hiddenViews: Array.from(hidden).join(',') });
}

function renderServiceProviderList() {
  const wrap = document.createElement('div');
  wrap.id = 'serviceProviderList';
  wrap.className = 'settings-nested-list status-provider-list';
  const hidden = hiddenServiceProviderSet();
  const providers = serviceStatusProviderPreferencesApi.orderedOptions(SERVICE_PROVIDER_OPTIONS, state.settings?.serviceProviderDisplayOrder);
  const hasCustomOrder = serviceStatusProviderPreferencesApi.hasCustomOrder(state.settings?.serviceProviderDisplayOrder);
  const header = document.createElement('div');
  header.className = 'settings-note-row status-provider-header';
  const note = document.createElement('p');
  note.className = 'settings-note';
  note.textContent = t('serviceStatus.providersNote');
  const headerActions = document.createElement('div');
  headerActions.className = 'tool-header-actions';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'tool-header-action';
  reset.textContent = '↺';
  reset.title = t('settings.views.resetOrder');
  reset.setAttribute('aria-label', reset.title);
  reset.disabled = !hasCustomOrder;
  reset.addEventListener('click', () => void resetServiceProviderOrder());
  const showAll = document.createElement('button');
  showAll.type = 'button';
  showAll.className = 'tool-header-action';
  const showAllEye = document.createElement('span');
  showAllEye.className = 'tool-header-eye';
  showAllEye.setAttribute('aria-hidden', 'true');
  showAll.append(showAllEye);
  showAll.title = t('settings.views.showAll');
  showAll.setAttribute('aria-label', showAll.title);
  showAll.disabled = hidden.size === 0;
  showAll.addEventListener('click', () => void showAllServiceProviders());
  headerActions.append(reset, showAll);
  header.append(note, headerActions);
  wrap.append(header);
  const SERVICE_STATUS_REFRESH_OPTIONS = [0, 60000, 120000, 300000, 900000, 1800000];
  const intervalRow = document.createElement('label');
  intervalRow.className = 'status-provider-interval';
  const intervalLabel = document.createElement('span');
  intervalLabel.textContent = t('serviceStatus.refreshEvery');
  const select = document.createElement('select');
  select.id = 'serviceStatusRefreshSelect';
  const currentMs = Number(state.settings?.serviceStatusRefreshMs) || 0;
  for (const ms of SERVICE_STATUS_REFRESH_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(ms);
    option.textContent = ms === 0 ? t('serviceStatus.refreshManual') : t('serviceStatus.refreshMinutes', { n: ms / 60000 });
    if (ms === currentMs) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', () => void saveSettings({ serviceStatusRefreshMs: Number(select.value) }));
  intervalRow.append(intervalLabel, select);
  wrap.append(intervalRow);
  for (const { id, label } of providers) {
    const isHidden = hidden.has(id);
    const row = document.createElement('div');
    row.className = 'status-provider-row';
    row.dataset.statusProvider = id;
    row.classList.toggle('is-hidden', isHidden);
    const name = document.createElement('div');
    name.className = 'tool-preference-name';
    name.textContent = label;
    const visibility = document.createElement('button');
    visibility.type = 'button';
    visibility.className = `tool-visibility-button${isHidden ? ' is-hidden' : ''}`;
    visibility.dataset.statusProvider = id;
    visibility.title = t(isHidden ? 'serviceStatus.showProvider' : 'serviceStatus.hideProvider', { name: label });
    visibility.setAttribute('aria-label', visibility.title);
    visibility.setAttribute('aria-pressed', String(!isHidden));
    visibility.append(visibilityIcon(isHidden));
    visibility.addEventListener('click', () => onServiceProviderVisibilityToggle(id));
    const handle = createPreferenceOrderHandle({ kind: 'statusProvider', id, label, count: providers.length });
    const actions = document.createElement('div');
    actions.className = 'tool-preference-actions';
    actions.append(visibility, handle);
    row.append(name, actions);
    wrap.append(row);
  }
  return wrap;
}

function localDevice() {
  return clientHealthPresentationApi.exactDevice(state.stats, state.settings?.deviceId);
}

function localClientStatus() {
  return localDevice()?.clientStatus || {};
}

function localClientHealth() {
  return localDevice()?.clientHealth || null;
}

// Single entry point for the tool detail accordion, mirroring the limits
// list: the drag gesture collapses and restores it too, so the class and aria
// bookkeeping cannot live inside the disclosure's own click handler.
function setClientHealthExpanded(clientId, options = {}) {
  state.clientHealthExpanded = clientId || '';
  const rows = els.clientDisplayList?.querySelectorAll('.tool-preference-row[data-client]') || [];
  for (const row of rows) {
    const disclosure = row.querySelector('.tool-preference-main');
    const container = row.querySelector(':scope > .accordion-animated-container');
    if (!disclosure || !container) continue;
    const open = row.dataset.client === state.clientHealthExpanded;
    // Filled here rather than during the repaint. Only one row can be open, so
    // building all of them cost 219 of the list's 552 nodes — 40% of its DOM,
    // rebuilt every stats tick — to render nothing. A panel already filled is
    // left alone so a collapse still has something to animate.
    if (open) {
      const force = options.refreshPlaceholder === true
        && !clientHealthPresentationApi.hasClientHealth(localClientHealth(), row.dataset.client);
      loadClientSources(row.dataset.client, { force });
      if (container.childElementCount === 0) {
        fillClientHealthPanel(container, row.dataset.client);
      }
    }
    disclosure.setAttribute('aria-expanded', String(open));
    row.classList.toggle('expanded', open);
    container.classList.toggle('hidden', !open);
  }
}

// This client's numbers across the three periods, straight off the stats the app
// already renders everywhere else. No new wire field and no new collection —
// the panel just puts them side by side, which is the whole point.
function clientPeriodUsage(clientId) {
  return clientHealthPresentationApi.clientPeriodUsage(localDevice(), clientId);
}

// Where this machine looks for each tool's data. A check id answers "which kind
// of root", but "did I install it somewhere else" needs the path itself — and a
// path only exists on the machine that probed it, so it comes over IPC rather
// than the wire. Probe only the open client and cache it for this health
// snapshot: a panel is rebuilt on every stats tick, and refetching made the
// paths flicker back to bare ids. The health envelope's observedAt changes
// only when a full source probe completes, so it refreshes path existence once
// per snapshot without spending IPC on progressive previews that carry the old
// envelope.
function clientSourcesIdentity(clientId) {
  const id = String(clientId || '');
  const health = localClientHealth();
  const tracked = enabledClientSet().has(id);
  return clientSourceCacheApi.clientSourceIdentity({
    deviceId: localDevice()?.deviceId,
    clientId: id,
    observedAt: health?.observedAt,
    tracked,
    // The health envelope timestamp is shared by every client. Only use it
    // when this client has its own health entry; otherwise unrelated client
    // updates must not invalidate this client's source probe cache.
    hasObservation: clientHealthPresentationApi.hasClientHealth(health, id)
  });
}

function exactLocalClientSources(clientId) {
  return clientSourceCacheApi.readClientSources(
    state.clientSources,
    clientSourcesIdentity(clientId)
  );
}

function localClientSources(clientId) {
  const identity = clientSourcesIdentity(clientId);
  const exactSources = exactLocalClientSources(clientId);
  const key = clientSourceCacheApi.clientSourceRequestKey(identity);
  const pendingSources = key && state.clientSourcesKey === key;
  const sources = pendingSources
    ? (exactSources ?? clientSourceCacheApi.readLatestClientSources(state.clientSources, identity) ?? [])
      .map((source) => ({ ...source, exists: false, pending: true }))
    : exactSources;
  const detectedInWsl = localDevice()?.wslStatus?.detected?.includes(clientId);
  if (!detectedInWsl) return sources;
  return [...(sources || []), { id: 'wsl-home', dir: '', exists: true }];
}

function loadClientSources(clientId, options = {}) {
  const id = String(clientId || '');
  const identity = clientSourcesIdentity(id);
  const key = clientSourceCacheApi.clientSourceRequestKey(identity);
  if (!key) return false;
  if (!options.force && state.clientSourcesKey === key) return true;
  if (
    !options.force
    && clientSourceCacheApi.readClientSources(state.clientSources, identity) !== null
  ) return false;
  state.clientSourcesKey = key;
  const request = ++state.clientSourcesRequest;
  void window.tokenMonitor?.clientSources?.(id).then((result) => {
    if (!result || typeof result !== 'object') throw new TypeError('Invalid client source result');
    if (state.clientSourcesRequest !== request || state.clientSourcesKey !== key) return;
    clientSourceCacheApi.writeClientSources(
      state.clientSources,
      identity,
      Array.isArray(result.sources) ? result.sources : []
    );
    state.clientSourcesKey = '';
    refillOpenClientHealthPanel();
  }).catch(() => {
    if (state.clientSourcesRequest !== request || state.clientSourcesKey !== key) return;
    state.clientSourcesKey = '';
    refillOpenClientHealthPanel();
  });
  return true;
}

function refillOpenClientHealthPanel() {
  const clientId = state.clientHealthExpanded;
  if (!clientId) return;
  const row = els.clientDisplayList?.querySelector(`.tool-preference-row[data-client="${CSS.escape(clientId)}"]`);
  const container = row?.querySelector(':scope > .accordion-animated-container');
  if (container) fillClientHealthPanel(container, clientId);
}

// Everything the panel draws beyond the health record itself: the numbers the
// app already renders elsewhere, and this machine's own paths.
function clientHealthDetailFor(clientId) {
  const options = {
    usage: clientPeriodUsage(clientId),
    sources: localClientSources(clientId),
    collectionState: enabledClientSet().has(clientId) ? 'waiting' : 'notTracked'
  };
  const detail = clientHealthPresentationApi.clientHealthDetail(localClientHealth(), clientId, options);
  if (detail) return detail;
  return clientHealthPresentationApi.clientHealthPlaceholderDetail(options);
}

function sameRenderedNode(current, next) {
  if (current.nodeType !== next.nodeType) return false;
  if (current.nodeType !== Node.ELEMENT_NODE) return true;
  if (current.tagName !== next.tagName || current.className !== next.className) return false;
  const currentAction = current.dataset?.healthAction || '';
  const nextAction = next.dataset?.healthAction || '';
  return currentAction === nextAction;
}

function patchRenderedNode(current, next) {
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  for (const name of current.getAttributeNames()) {
    if (!next.hasAttribute(name)) current.removeAttribute(name);
  }
  for (const name of next.getAttributeNames()) {
    const value = next.getAttribute(name);
    if (current.getAttribute(name) !== value) current.setAttribute(name, value);
  }
  const currentChildren = Array.from(current.childNodes);
  const nextChildren = Array.from(next.childNodes);
  for (let index = 0; index < nextChildren.length; index += 1) {
    const currentChild = currentChildren[index];
    const nextChild = nextChildren[index];
    if (!currentChild) {
      current.append(nextChild);
    } else if (sameRenderedNode(currentChild, nextChild)) {
      patchRenderedNode(currentChild, nextChild);
    } else {
      currentChild.replaceWith(nextChild);
    }
  }
  for (let index = nextChildren.length; index < currentChildren.length; index += 1) {
    currentChildren[index].remove();
  }
}

function fillClientHealthPanel(container, clientId) {
  const detail = clientHealthDetailFor(clientId);
  if (!detail) return;
  const next = clientHealthPanel(detail, clientId);
  const current = container.firstElementChild;
  if (current && sameRenderedNode(current, next)) patchRenderedNode(current, next);
  else container.replaceChildren(next);
}

// Home-relative so the panel does not print the user's account name back at
// them; absolute paths remain local and are never added to the health record.
function friendlyPath(dir) {
  return clientHealthPresentationApi.friendlyPath(dir, state.appInfo?.homeDir, state.appInfo?.platform);
}

// Values are formatted here and nowhere else — the presentation helper returns
// three semantic groups containing only raw numbers, timestamps and i18n keys.
function clientHealthGroup(group, notes) {
  const section = document.createElement('section');
  section.className = `tool-health-group tool-health-group-${group.id}`;
  const heading = document.createElement('h4');
  heading.className = 'tool-health-group-title';
  heading.textContent = t(group.key);
  const body = document.createElement('div');
  body.className = 'tool-health-group-body';

  if (group.id === 'source') {
    const summary = document.createElement('div');
    summary.className = 'tool-health-group-summary';
    summary.textContent = t(`settings.tools.health.source.${group.state}`, {
      detected: group.detectedCount,
      checked: group.checkedCount
    });
    body.append(summary);
    if (group.checks.length > 0) {
      const list = document.createElement('div');
      list.className = 'tool-health-checks';
      for (const check of group.checks) {
        const paths = check.paths?.length ? check.paths : [{ dir: '', exists: check.exists }];
        for (const pathInfo of paths) {
          const chip = document.createElement('code');
          chip.className = `tool-health-check${pathInfo.exists ? ' found' : pathInfo.pending ? ' pending' : ''}`;
          chip.textContent = pathInfo.dir ? friendlyPath(pathInfo.dir) : check.id;
          if (pathInfo.dir) chip.title = pathInfo.dir;
          list.append(chip);
        }
      }
      body.append(list);
    }
  } else if (group.id === 'collection') {
    const summary = document.createElement('div');
    summary.className = 'tool-health-group-summary';
    summary.textContent = t(`settings.tools.health.sync.${group.state}`);
    body.append(summary);
    const stamps = [
      ['lastAttemptAt', 'settings.tools.health.lastAttempt'],
      ['lastSuccessAt', 'settings.tools.health.lastSuccess']
    ];
    for (const [field, key] of stamps) {
      const stamp = group[field];
      if (!stamp) continue;
      const elapsed = Math.max(0, Date.now() - (Date.parse(stamp) || Date.now()));
      const meta = document.createElement('div');
      meta.className = 'tool-health-group-meta';
      meta.textContent = t(key, { time: formatAgo(elapsed) });
      body.append(meta);
    }
  } else {
    if (group.periods) {
      const usage = document.createElement('div');
      usage.className = 'tool-health-usage';
      for (const entry of group.periods) {
        const cell = document.createElement('div');
        cell.className = 'tool-health-usage-cell';
        const head = document.createElement('span');
        head.className = 'tool-health-usage-label';
        head.textContent = t(`trayComposer.period.${entry.period}`);
        const amount = document.createElement('span');
        amount.className = 'tool-health-usage-value';
        amount.textContent = formatCompact(entry.tokens);
        cell.append(head, amount);
        if (entry.cost > 0) {
          const cost = document.createElement('span');
          cost.className = 'tool-health-usage-cost';
          cost.textContent = formatCost(entry.cost);
          cell.append(cost);
        }
        usage.append(cell);
      }
      body.append(usage);
    } else {
      const tokens = document.createElement('div');
      tokens.className = 'tool-health-group-summary';
      tokens.textContent = t('settings.tools.health.tokensValue', { tokens: formatCompact(group.tokens) });
      body.append(tokens);
    }
    if (group.lastActivityDay) {
      const activity = document.createElement('div');
      activity.className = 'tool-health-group-meta';
      activity.textContent = t('settings.tools.health.lastActivityValue', {
        relative: relativeDayLabel(group.lastActivityDay),
        day: group.lastActivityDay
      });
      body.append(activity);
    }
  }

  for (const note of notes) {
    const line = document.createElement('div');
    line.className = `tool-health-note-line tone-${note.tone}`;
    line.textContent = t(`settings.tools.health.code.${note.code}`);
    body.append(line);
  }
  section.append(heading, body);
  return section;
}

function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Days come from the daily history buckets, which are local dates — the same
// boundary computePeriodWindows() rolls "today" over on. A day in the future
// (a clock that moved) has no honest phrase, so it stays a plain date.
function relativeDayLabel(day) {
  const today = localDayKey();
  if (day === today) return t('settings.tools.health.day.today');
  const parsed = Date.parse(`${day}T00:00:00`);
  if (!Number.isFinite(parsed)) return day;
  const days = Math.round((Date.parse(`${today}T00:00:00`) - parsed) / 86400000);
  if (days === 1) return t('settings.tools.health.day.yesterday');
  if (days > 1) return t('settings.tools.health.day.daysAgo', { n: days });
  return day;
}

function clientHealthActions(clientId) {
  const actions = document.createElement('div');
  actions.className = 'tool-health-actions';
  const button = (labelKey, onClick) => {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'tool-health-action';
    control.textContent = t(labelKey);
    control.addEventListener('click', onClick);
    actions.append(control);
    return control;
  };
  // The detail is already bound to the exact local device. Renderer mode is a
  // transport state (`local`/`sync`), not topology, so host and client collectors
  // expose the same targeted capability through preload.
  if (enabledClientSet().has(clientId)
    && localDevice()
    && typeof window.tokenMonitor?.rescanClient === 'function') {
    const rescanState = state.clientRescans.snapshot(clientId);
    const feedback = document.createElement('span');
    feedback.className = 'tool-health-action-feedback';
    feedback.dataset.healthAction = 'rescan-feedback';
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    feedback.textContent = rescanState.failed ? t('settings.tools.health.rescanFailed') : '';
    const rescan = button('settings.tools.health.rescan', async () => {
      const requestId = state.clientRescans.begin(clientId);
      let succeeded = false;
      try {
        succeeded = await window.tokenMonitor.rescanClient(clientId) === true;
        if (succeeded) loadClientSources(clientId, { force: true });
      } catch (_) {
        succeeded = false;
      } finally {
        state.clientRescans.finish(clientId, requestId, succeeded);
      }
    });
    rescan.dataset.healthAction = 'rescan';
    rescan.id = `toolHealthRescan-${clientId}`;
    rescan.disabled = rescanState.pending;
    actions.append(feedback);
  }
  // Only where something was actually found: the button opens the first existing
  // root, and offering it for a tool with none would open nothing.
  if ((exactLocalClientSources(clientId) || []).some((source) => source.dir && source.exists)) {
    const reveal = button('settings.tools.health.reveal', () => { void window.tokenMonitor?.revealClientSource?.(clientId); });
    reveal.dataset.healthAction = 'reveal';
    reveal.id = `toolHealthReveal-${clientId}`;
  }
  return actions;
}

function clientHealthPanel(detail, clientId) {
  const inner = document.createElement('div');
  inner.className = 'accordion-animation-inner';
  // The padded, tinted box is a child rather than the animated element itself:
  // a collapsed accordion is a grid row sized to 0fr, and padding does not
  // compress — an inner with its own padding stays that many pixels tall and
  // pads every collapsed row in the list.
  const box = document.createElement('div');
  box.className = 'tool-health-inner';
  inner.append(box);
  const groups = document.createElement('div');
  groups.className = 'tool-health-groups';
  for (const group of detail.groups) {
    groups.append(clientHealthGroup(
      group,
      detail.notes.filter((note) => note.group === group.id)
    ));
  }
  box.append(groups, clientHealthActions(clientId));
  return inner;
}

function localWslStatus() {
  return localDevice()?.wslStatus || null;
}

// WSL attribution panel: shows the WSL pipeline state + which tools were detected
// (markers) vs which returned tokens. Windows-only (the whole block hides off-Win).
function renderWslPanel() {
  if (!els.wslScanRow) return;
  const isWin = state.appInfo?.platform === 'win32';
  els.wslScanRow.classList.toggle('hidden', !isWin);
  if (!els.wslPanel) return;
  els.wslPanel.replaceChildren();
  const status = localWslStatus();
  if (!isWin || !status) return;

  const header = document.createElement('div');
  header.className = 'wsl-panel-header';
  const title = document.createElement('span');
  title.className = 'wsl-panel-title';
  title.textContent = t('settings.collection.wslPanel.title');
  // Tone classes are the existing ones: ok (green) / neutral (amber) / muted (grey).
  const tone = (status.state === 'active') ? 'ok'
    : (status.state === 'no-data' || status.state === 'not-running') ? 'neutral'
    : 'muted';
  const stateTag = document.createElement('span');
  stateTag.className = `tool-status-tag tool-status-tag-${tone}`;
  const stateKeyMap = { active: 'active', 'no-data': 'noData', 'not-running': 'notRunning', 'not-installed': 'notInstalled', disabled: 'disabled' };
  stateTag.textContent = t(`settings.collection.wslPanel.${stateKeyMap[status.state] || 'disabled'}`);
  header.append(title, stateTag);
  els.wslPanel.append(header);

  // Tool rows whenever detection found markers (active OR markers-but-no-tokens).
  if ((status.detected || []).length > 0) {
    const withData = new Set(status.withData || []);
    for (const id of status.detected) {
      const row = document.createElement('div');
      row.className = 'wsl-panel-row';
      const name = document.createElement('span');
      name.className = 'wsl-panel-name';
      name.textContent = (clientLabels[id] || id);
      const has = withData.has(id);
      const tag = document.createElement('span');
      tag.className = `tool-status-tag tool-status-tag-${has ? 'ok' : 'neutral'}`;
      tag.textContent = t(has ? 'settings.collection.wslPanel.hasData' : 'settings.collection.wslPanel.noDataTag');
      row.append(name, tag);
      els.wslPanel.append(row);
    }
  }

  if (wslStatusPresentationApi.shouldShowSqliteHelp(status)) {
    const help = document.createElement('p');
    help.className = 'settings-note wsl-panel-help';
    const message = document.createElement('span');
    message.textContent = t('settings.collection.wslPanel.sqliteHelp');
    const guide = document.createElement('button');
    guide.type = 'button';
    guide.className = 'inline-link';
    guide.textContent = t('settings.collection.wslPanel.setupGuide');
    guide.addEventListener('click', () => window.tokenMonitor.openExternal?.(TOKEN_MONITOR_WSL_SQLITE_GUIDE_URL));
    help.append(message, ' ', guide);
    els.wslPanel.append(help);
  }
}

// The tracked-tools list drags from the whole row too, on the same controller
// as the limits list. What differs is the commit: its order is not one setting.
// While the list is on its default order the pinned block is the only thing
// shaping it, so a drop can mean either a pin change or an explicit order.
// `clientDisplayOrderCommit` decides, and the patch it returns is carried from
// the local mirror to the save rather than derived twice — the mirror writes
// the very keys that decision reads.
const CLIENT_PREFERENCE_DRAG_EXCLUDED = 'button:not(.tool-preference-main), input, select, textarea, a, label, .accordion-animated-container';

const clientPreferenceRowDrag = rowDragControllerApi.createRowDragController({
  dragSort: verticalDragSortApi,
  getList: () => els.clientDisplayList,
  getScrollPanel: () => els.settingsPanel,
  rowSelector: '.tool-preference-row[data-client]',
  idKey: 'client',
  dragExcluded: CLIENT_PREFERENCE_DRAG_EXCLUDED,
  getExpanded: () => state.clientHealthExpanded,
  setExpanded: setClientHealthExpanded,
  applyOrder: (order) => applyPreferenceOrder('client', order),
  preserveScroll: preserveSettingsPanelScroll,
  mirrorOrder: (order, id) => {
    const patch = clientDisplayPreferencesApi.clientDisplayOrderCommit(order, KNOWN_CLIENTS, state.settings?.clientDisplayOrder, state.settings?.pinnedClients, id);
    state.settings = { ...state.settings, ...patch };
    return patch;
  },
  persistOrder: (_order, _id, patch) => void saveSettings(patch),
  requestRender: () => renderToolPreferences()
});

function renderToolPreferences() {
  if (!els.clientDisplayList) return;
  // A stats update mid-drag would replace the rows under the pointer and kill
  // the gesture silently. Defer the repaint until the drop.
  if (clientPreferenceRowDrag.deferRender()) return;
  return preserveSettingsPanelScroll(renderToolPreferencesNow);
}

function toolPreferenceRenderSignature() {
  const clientStatus = localClientStatus();
  const health = localClientHealth();
  const device = localDevice();
  return JSON.stringify({
    settings: [
      [...enabledClientSet()].sort(),
      state.settings?.hiddenClients || '',
      state.settings?.pinnedClients || '',
      state.settings?.clientDisplayOrder || '',
      state.settings?.locale || state.settings?.language || '',
      state.settings?.currency || '',
      state.settings?.compactTokenUnits || ''
    ],
    deviceId: device?.deviceId || '',
    clientStatus,
    healthRows: KNOWN_CLIENTS.map(({ id }) => [
      id,
      health?.clients?.[id]?.overall || '',
      Boolean(health?.clients?.[id])
    ])
  });
}

function renderToolPreferencesNow() {
  const renderSignature = toolPreferenceRenderSignature();
  const detailSignature = JSON.stringify([
    localClientHealth(),
    localDevice(),
    state.settings?.currencyRatesEffective || null
  ]);
  const sourceSignature = clientSourceCacheApi.clientSourceRequestKey(
    clientSourcesIdentity(state.clientHealthExpanded)
  );
  if (
    state.toolPreferenceRenderSignature
    && state.toolPreferenceRenderSignature === renderSignature
    && els.clientDisplayList.children.length === KNOWN_CLIENTS.length
  ) {
    if (state.toolPreferenceDetailSignature !== detailSignature) {
      state.toolPreferenceDetailSignature = detailSignature;
      if (state.toolPreferenceSourceSignature !== sourceSignature) {
        state.toolPreferenceSourceSignature = sourceSignature;
        loadClientSources(state.clientHealthExpanded);
        refillOpenClientHealthPanel();
      } else {
        refillOpenClientHealthPanel();
      }
    }
    return;
  }
  state.toolPreferenceRenderSignature = renderSignature;
  state.toolPreferenceDetailSignature = detailSignature;
  state.toolPreferenceSourceSignature = sourceSignature;
  const previousRows = Array.from(els.clientDisplayList.children);
  const focusedId = document.activeElement?.id || '';
  const enabled = enabledClientSet();
  const hidden = hiddenClientSet();
  const pinned = pinnedClientSet();
  const clientStatus = localClientStatus();
  const health = localClientHealth();
  const clients = clientDisplayPreferencesApi.orderedClients(KNOWN_CLIENTS, state.settings?.clientDisplayOrder, state.settings?.pinnedClients);
  const hasCustomOrder = clientDisplayPreferencesApi.hasCustomDisplayOrder(state.settings?.clientDisplayOrder);
  const hasPinnedClients = pinned.size > 0;
  const hasHiddenClients = hidden.size > 0;
  if (els.resetClientDisplayOrderButton) els.resetClientDisplayOrderButton.disabled = !hasCustomOrder && !hasPinnedClients;
  if (els.showAllClientsButton) els.showAllClientsButton.disabled = !hasHiddenClients;
  for (const { id, label } of clients) {
    const row = document.createElement('div');
    row.className = 'tool-preference-row';
    row.dataset.client = id;
    const isHidden = hidden.has(id);
    const isPinned = pinned.has(id);
    row.classList.toggle('is-hidden', isHidden);
    row.classList.toggle('is-pinned', isPinned);
    const labelGroup = document.createElement('div');
    labelGroup.className = 'tool-preference-label';
    const name = document.createElement('div');
    name.className = 'tool-preference-name';
    name.textContent = label;
    labelGroup.append(name);
    if (enabled.has(id)) {
      // A tracked client with no reported status yet (first collect still running)
      // reads as "waiting for data" rather than a bare blank.
      //
      // `attention` overrides it. The legacy status is derived from usage, so a
      // client whose sync broke this morning still counts yesterday's tokens and
      // would keep reporting "Tracking" — leaving the one state this whole
      // feature exists to surface invisible until the row is expanded.
      const needsAttention = health?.clients?.[id]?.overall === 'attention';
      const tagInfo = needsAttention
        ? { key: 'settings.tools.status.attention', tone: 'warn' }
        : clientStatusPresentationApi.clientStatusTag(id, clientStatus[id] || 'waiting');
      if (tagInfo) {
        const tag = document.createElement('span');
        tag.className = `tool-status-tag tool-status-tag-${tagInfo.tone}`;
        tag.textContent = t(tagInfo.key);
        labelGroup.append(tag);
      }
    }
    const track = document.createElement('label');
    track.className = 'tool-preference-toggle';
    const trackInput = document.createElement('input');
    trackInput.type = 'checkbox';
    trackInput.id = `toolTrackEnabled-${id}`;
    trackInput.dataset.client = id;
    trackInput.dataset.preference = 'track';
    trackInput.checked = enabled.has(id);
    trackInput.setAttribute('aria-label', t('settings.tools.trackClient', { name: label }));
    trackInput.addEventListener('change', onToolTrackingToggle);
    // The drag handle is gone, so the checkbox carries the keyboard reorder
    // shortcuts. A checkbox has no native arrow-key behaviour, so the existing
    // key bindings transfer unchanged.
    trackInput.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End');
    trackInput.addEventListener('keydown', (event) => onPreferenceOrderKeydown(event, 'client', id));
    track.append(trackInput);
    const visibility = document.createElement('button');
    visibility.type = 'button';
    visibility.id = `toolVisibility-${id}`;
    visibility.className = `tool-visibility-button${isHidden ? ' is-hidden' : ''}`;
    visibility.dataset.client = id;
    visibility.title = t(isHidden ? 'settings.tools.showClient' : 'settings.tools.hideClient', { name: label });
    visibility.setAttribute('aria-label', visibility.title);
    visibility.setAttribute('aria-pressed', String(!isHidden));
    visibility.append(visibilityIcon(isHidden));
    visibility.addEventListener('click', () => onClientVisibilityToggle(id));
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.id = `toolPin-${id}`;
    pin.className = `tool-pin-button${isPinned ? ' is-pinned' : ''}`;
    pin.dataset.client = id;
    pin.title = t(isPinned ? 'settings.tools.unpinClient' : 'settings.tools.pinClient', { name: label });
    pin.setAttribute('aria-label', pin.title);
    pin.setAttribute('aria-pressed', String(isPinned));
    pin.append(pinIcon());
    pin.addEventListener('click', () => onClientPinnedToggle(id));
    const actions = document.createElement('div');
    actions.className = 'tool-preference-actions';
    actions.append(visibility, pin);
    // Tracked tools use the health snapshot; untracked tools get an on-demand
    // source view so every row keeps the same disclosure affordance.
    const detail = clientHealthDetailFor(id);
    if (detail) {
      const expanded = state.clientHealthExpanded === id;
      row.classList.toggle('expanded', expanded);
      const main = document.createElement('button');
      main.type = 'button';
      main.id = `toolHealthDisclosure-${id}`;
      main.className = 'tool-preference-main';
      main.title = t('settings.tools.health.open', { name: label });
      main.setAttribute('aria-label', main.title);
      main.setAttribute('aria-expanded', String(expanded));
      const disclosureIcon = document.createElement('span');
      disclosureIcon.className = 'cursor-disclosure-icon';
      disclosureIcon.setAttribute('aria-hidden', 'true');
      main.append(disclosureIcon);
      const panel = document.createElement('div');
      panel.id = `toolHealthPanel-${id}`;
      panel.className = `accordion-animated-container${expanded ? '' : ' hidden'}`;
      main.setAttribute('aria-controls', panel.id);
      if (expanded) {
        loadClientSources(id);
        panel.append(clientHealthPanel(clientHealthDetailFor(id) || detail, id));
      }
      main.addEventListener('click', () => {
        const open = state.clientHealthExpanded !== id;
        setClientHealthExpanded(open ? id : '', { refreshPlaceholder: open });
      });
      // Last of the row's controls, where the eye and the pin already are —
      // the label stays plain text, exactly as it reads without this feature.
      actions.append(main);
      row.classList.add('has-health');
      row.append(track, labelGroup, actions, panel);
    } else {
      row.append(track, labelGroup, actions);
    }
    row.addEventListener('pointerdown', (event) => clientPreferenceRowDrag.startRowDrag(event, id));
    els.clientDisplayList.appendChild(row);
  }
  // Appended first and only then swapped out: replacing the list wholesale
  // would destroy the row under the pointer on every stats tick.
  for (const row of previousRows) row.remove();
  if (focusedId && document.activeElement === document.body) {
    document.getElementById(focusedId)?.focus({ preventScroll: true });
  }
}

function connectLimitProviderCheckboxName(checkbox, nameNode, providerId) {
  const nameId = `limitProviderName-${providerId}`;
  nameNode.id = nameId;
  checkbox.setAttribute('aria-labelledby', nameId);
}

function moveLimitProviderLiveNode(parent, node, before = null) {
  if (!parent || !node || node.parentElement === parent) return;
  parent.moveBefore(node, before);
}

function renderLimitProviderCheckboxes() {
  if (!els.limitProviderCheckboxes) return;
  // A stats update mid-drag would replace the rows under the pointer and kill
  // the gesture silently. Defer the repaint until the drop.
  if (limitProviderRowDrag.deferRender()) return;
  return preserveSettingsPanelScroll(renderLimitProviderCheckboxesNow);
}

function renderLimitProviderCheckboxesNow() {
  const renderSignature = limitProviderSettingsRenderSignature();
  if (
    state.limitProviderRenderSignature === renderSignature
    && els.limitProviderCheckboxes.children.length === LIMIT_PROVIDERS.length
  ) {
    return;
  }
  const previousRows = Array.from(els.limitProviderCheckboxes.children);
  const focusedId = document.activeElement?.id || '';
  const reusableSettingInputs = new Map();
  for (const row of previousRows) {
    const providerId = row.dataset?.provider || '';
    const settings = LIMIT_PROVIDER_SETTINGS[providerId] || [];
    const inputs = row.querySelectorAll?.(
      ':scope > .accordion-animated-container .limit-provider-settings-list > .settings-item > input[type="checkbox"]'
    ) || [];
    settings.forEach((setting, index) => {
      const input = inputs[index];
      if (input) reusableSettingInputs.set(`${providerId}:${setting.key}`, input);
    });
  }
  const enabled = enabledLimitProviderSet();
  const collected = new Map((state.stats?.limits?.providers || []).map((provider) => [provider.provider, provider]));
  const providers = limitProviderOrderApi.orderedLimitProviders(LIMIT_PROVIDERS, state.settings?.limitProviderOrder);
  for (const { id, label, settingsLabel } of providers) {
    const isEnabled = enabled.has(id);
    const provider = isEnabled
      ? (collected.get(id) || { provider: id, ...(state.stats ? { status: missingLimitProviderStatus() } : {}), windows: [] })
      : { provider: id, status: 'disabled', windows: [] };
    const row = document.createElement('div');
    row.className = `limit-provider-row${isEnabled ? '' : ' is-disabled'}`;
    row.dataset.provider = id;
    const wrap = document.createElement('label');
    wrap.className = 'client-checkbox limit-provider-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `limitProviderEnabled-${id}`;
    cb.dataset.provider = id;
    cb.checked = isEnabled;
    cb.addEventListener('change', onLimitProviderToggle);
    // The drag handle is gone, so the checkbox carries the keyboard reorder
    // shortcuts. A checkbox has no native arrow-key behaviour, so the existing
    // key bindings transfer unchanged.
    cb.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End');
    cb.addEventListener('keydown', (event) => onPreferenceOrderKeydown(event, 'provider', id));
    const copy = document.createElement('span');
    copy.className = 'limit-provider-copy';
    const nameLine = document.createElement('span');
    nameLine.className = 'limit-provider-name-line';
    const text = document.createElement('span');
    text.className = 'limit-provider-name';
    text.textContent = settingsLabel || label;
    connectLimitProviderCheckboxName(cb, text, id);
    nameLine.append(text);
    const tags = document.createElement('span');
    tags.className = 'limit-provider-tags';
    const provenance = limitProviderProvenance(provider);
    const connectionDetailKey = LIMIT_PROVIDER_CONNECTION_DETAIL_KEYS[id];
    const accountGroup = limitProviderAccountGroup(id);
    const tagInfos = limitProviderPresentationApi.limitProviderSettingsTags(provider, provenance);
    const detected = provider.status === 'ok' && !provider.stale;
    if (detected) {
      const statusTag = tagInfos.find((tagInfo) => tagInfo.kind === 'status');
      const dot = document.createElement('span');
      dot.className = 'limit-provider-status-dot';
      dot.title = translatedLimitProviderTag(statusTag);
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', dot.title);
      nameLine.append(dot);
    }
    for (const tagInfo of tagInfos) {
      if ((detected || !isEnabled) && tagInfo.kind === 'status') continue;
      const duplicatesInlineSetup = tagInfo.kind === 'capability'
        && ((connectionDetailKey && tagInfo.label === 'Auto')
          || (accountGroup && tagInfo.label === 'Manual login'));
      if (duplicatesInlineSetup) continue;
      const tag = document.createElement('span');
      tag.className = `limit-provider-tag limit-provider-tag-${tagInfo.kind}`;
      if (tagInfo.tone) tag.classList.add(`limit-provider-tag-${tagInfo.tone}`);
      tag.textContent = translatedLimitProviderTag(tagInfo);
      tags.append(tag);
    }
    copy.append(nameLine, tags);
    wrap.append(cb);
    const actions = document.createElement('span');
    actions.className = 'limit-provider-actions';
    const accountStatus = limitProviderAccountStatus(id);
    if (connectionDetailKey) {
      const mode = document.createElement('span');
      mode.className = 'cursor-status-pill limit-provider-mode-pill';
      mode.textContent = t('settings.limits.connection.autoDetect');
      actions.append(mode);
    }
    const settings = LIMIT_PROVIDER_SETTINGS[id];
    const hasOptions = Boolean(accountGroup || settings || connectionDetailKey);
    let optionsContainer = null;
    let optionsInner = null;
    let main = null;
    let disclosureIcon = null;
    if (hasOptions) {
      const expanded = state.limitProviderSettingsExpanded === id;
      row.classList.toggle('expanded', expanded);
      main = document.createElement('button');
      main.type = 'button';
      main.id = `limitProviderDisclosure-${id}`;
      main.className = 'limit-provider-main';
      main.title = t('settings.limits.providerOptions', { provider: settingsLabel || label });
      main.setAttribute('aria-label', main.title);
      main.setAttribute('aria-expanded', String(expanded));
      disclosureIcon = document.createElement('span');
      disclosureIcon.className = 'cursor-disclosure-icon';
      disclosureIcon.setAttribute('aria-hidden', 'true');
      actions.append(disclosureIcon);
      optionsContainer = document.createElement('div');
      optionsContainer.id = `limitProviderOptions-${id}`;
      optionsContainer.className = `accordion-animated-container${expanded ? '' : ' hidden'}`;
      main.setAttribute('aria-controls', optionsContainer.id);
      optionsInner = document.createElement('div');
      optionsInner.className = 'accordion-animation-inner limit-provider-options-inner';
      if (accountGroup) {
        accountGroup.classList.add('limit-provider-account-group');
      }
      if (connectionDetailKey) optionsInner.append(limitProviderConnectionDetail(connectionDetailKey));
      if (settings) optionsInner.append(limitProviderSettingsList(id, settings, reusableSettingInputs));
      optionsContainer.append(optionsInner);
      const toggleOptions = () => {
        const opening = state.limitProviderSettingsExpanded !== id;
        const accountToggle = accountGroup?.querySelector(':scope > .settings-group-header');
        const accountOpen = accountToggle?.getAttribute('aria-expanded') === 'true';
        if (accountToggle && accountOpen !== opening) accountToggle.click();
        else setLimitProviderSettingsExpanded(opening ? id : '');
      };
      main.addEventListener('click', toggleOptions);
    }
    if (main) {
      main.append(copy, actions);
      row.append(wrap, main);
    } else {
      row.append(wrap, copy, actions);
    }
    row.addEventListener('pointerdown', (event) => limitProviderRowDrag.startRowDrag(event, id));
    // Kept inside the row rather than as a sibling: reordering moves only
    // `.limit-provider-row` nodes, so a sibling panel would be stranded when the
    // list is dragged.
    if (optionsContainer) row.append(optionsContainer);
    els.limitProviderCheckboxes.appendChild(row);
    // `moveBefore()` preserves focus and edit state while reparenting. Its
    // destination must already be connected, so the row is mounted first.
    moveLimitProviderLiveNode(actions, accountStatus, disclosureIcon);
    moveLimitProviderLiveNode(optionsInner, accountGroup);
    // OpenCode's one setting is an off-by-default fallback estimate. Rendered by
    // the shared path it lands above the account list, reading as the first
    // thing to set up; it belongs below the accounts, collapsed. Reparented
    // rather than special-cased in the shared renderer so the setting keeps its
    // change tracking and re-render signature.
    if (id === 'opencode') moveOpenCodeLocalFallbackSetting();
  }
  for (const row of previousRows) row.remove();
  if (focusedId && document.activeElement === document.body) {
    document.getElementById(focusedId)?.focus({ preventScroll: true });
  }
  state.limitProviderRenderSignature = renderSignature;
}

// Moves the OpenCode local-DB toggle into its own collapsed group beneath the
// account list, and keeps that group's status pill in sync with the setting.
function moveOpenCodeLocalFallbackSetting() {
  const target = document.getElementById('opencodeLocalFallbackInner');
  const list = document.querySelector('#limitProviderOptions-opencode .limit-provider-settings-list');
  if (!target) return;
  if (list) {
    if (list.parentElement !== target) moveLimitProviderLiveNode(target, list);
    // The shared renderer builds a fresh settings list on every pass, so moving
    // without clearing stacks one copy of the toggle per re-render.
    for (const stale of [...target.children]) if (stale !== list) stale.remove();
    // The group header already names the setting, so the item's own title would
    // read twice. Dropping it alone leaves the label cell empty and the switch
    // adrift, so the description moves into that cell and becomes the label.
    for (const item of target.querySelectorAll('.settings-item')) {
      item.querySelector('.settings-item-title')?.remove();
      const cell = item.querySelector('.settings-item-text');
      const desc = item.querySelector('.settings-item-desc');
      if (cell && desc && desc.parentElement !== cell) cell.append(desc);
    }
  }

  const pill = document.getElementById('opencodeLocalFallbackStatus');
  if (pill) {
    const on = (state.settings || {}).opencodeLocalLimitsEnabled === true;
    pill.textContent = t(on ? 'settings.appearance.motion.on' : 'settings.appearance.motion.off');
  }

  const toggle = document.getElementById('opencodeLocalFallbackSettingsToggle');
  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = '1';
    // The shared helper, so this collapses exactly like every other group
    // instead of a second hand-rolled implementation of the same thing.
    toggle.addEventListener('click', () => setAccountGroupExpanded(
      'opencodeLocalFallback',
      toggle.getAttribute('aria-expanded') !== 'true'
    ));
  }
}

function limitProviderAccountGroup(providerId) {
  const groupId = LIMIT_PROVIDER_ACCOUNT_GROUP_IDS[providerId];
  return groupId ? document.getElementById(groupId) : null;
}

function limitProviderAccountStatus(providerId) {
  const statusId = LIMIT_PROVIDER_ACCOUNT_STATUS_IDS[providerId];
  return statusId ? document.getElementById(statusId) : null;
}

function limitProviderConnectionDetail(bodyKey) {
  const panel = document.createElement('div');
  panel.className = 'limit-provider-connection-detail';
  const title = document.createElement('span');
  title.className = 'limit-provider-connection-title';
  title.textContent = t('settings.limits.connection.title');
  const body = document.createElement('p');
  body.className = 'settings-note';
  body.textContent = t(bodyKey);
  panel.append(title, body);
  return panel;
}

// Single entry point for the provider options accordion. The drag gesture also
// needs to collapse and restore it, so the class/aria bookkeeping cannot stay
// inside the disclosure's own click handler.
function setLimitProviderSettingsExpanded(providerId) {
  state.limitProviderSettingsExpanded = providerId || '';
  const rows = els.limitProviderCheckboxes?.querySelectorAll('.limit-provider-row[data-provider]') || [];
  for (const row of rows) {
    const disclosure = row.querySelector('.limit-provider-main');
    const container = row.querySelector(':scope > .accordion-animated-container');
    if (!disclosure || !container) continue;
    const open = row.dataset.provider === state.limitProviderSettingsExpanded;
    disclosure.setAttribute('aria-expanded', String(open));
    row.classList.toggle('expanded', open);
    container.classList.toggle('hidden', !open);
  }
}

// Provider-scoped options, rendered under their own row rather than in the
// section footer, which is reserved for settings that apply to every provider.
const LIMIT_PROVIDER_SETTINGS = {
  claude: [{
    key: 'claudePrepaidBalanceEnabled',
    titleKey: 'settings.limits.prepaidBalance',
    descKey: 'settings.limits.prepaidBalanceDesc',
    requiresConfiguredKey: 'claudeWebCookieConfigured',
    defaultValue: true
  }],
  opencode: [{
    key: 'opencodeLocalLimitsEnabled',
    titleKey: 'settings.limits.opencodeLocalLimits',
    descKey: 'settings.limits.opencodeLocalLimitsDesc',
    defaultValue: false
  }]
};

function limitProviderSettingsRenderSignature() {
  const settings = state.settings || {};
  const providerSignature = (provider) => {
    return [
      provider?.provider || '',
      provider?.status || '',
      Boolean(provider?.stale),
      provider?.source || '',
      provider?.sourceDetail || '',
      provider?.sourceDeviceId || '',
      provider?.accountKey || ''
    ];
  };
  const deviceSignature = (device) => [
    device?.deviceId || '',
    device?.hostname || '',
    (device?.limits?.providers || []).map((provider) => [
      provider?.provider || '',
      provider?.status || '',
      provider?.accountKey || ''
    ])
  ];
  const settingValues = Object.values(LIMIT_PROVIDER_SETTINGS).flatMap((entries) => entries.map((setting) => [
    setting.key,
    settings[setting.key],
    setting.requiresConfiguredKey ? Boolean(settings[setting.requiresConfiguredKey]) : true
  ]));
  return JSON.stringify({
    locale: currentLocale(),
    mode: state.mode,
    hubUrl: settings.hubUrl || '',
    settings: [
      settings.limitsEnabled !== false,
      [...enabledLimitProviderSet()].sort(),
      limitProviderOrderApi.orderedLimitProviders(LIMIT_PROVIDERS, settings.limitProviderOrder).map(({ id }) => id),
      settings.deviceId || '',
      settingValues,
      state.limitProviderSettingsExpanded
    ],
    providers: (state.stats?.limits?.providers || []).map(providerSignature),
    devices: (state.stats?.devices || []).map(deviceSignature)
  });
}

function limitProviderSettingsList(providerId, settings, reusableInputs = null) {
  const list = document.createElement('div');
  list.className = 'settings-nested-list limit-provider-settings-list';
  for (const setting of settings) {
    // Same shape as Start at login: the description is a sibling of the input,
    // not part of the title cell, so the switch stays on the title's line and
    // the note wraps full-width underneath instead of squeezing it onto its own
    // row.
    const item = document.createElement('label');
    item.className = 'checkbox-label settings-item';
    const copy = document.createElement('span');
    copy.className = 'settings-item-text';
    const title = document.createElement('span');
    title.className = 'settings-item-title';
    title.textContent = t(setting.titleKey);
    copy.append(title);
    const inputKey = `${providerId}:${setting.key}`;
    const existingInput = reusableInputs?.get(inputKey);
    const input = existingInput || document.createElement('input');
    input.type = 'checkbox';
    const available = !setting.requiresConfiguredKey || Boolean(state.settings?.[setting.requiresConfiguredKey]);
    const storedValue = state.settings?.[setting.key];
    const defaultValue = setting.defaultValue !== false;
    input.checked = available && (storedValue === undefined ? defaultValue : storedValue !== false);
    input.disabled = !available;
    item.classList.toggle('is-disabled', !available);
    if (!existingInput) {
      input.addEventListener('change', async () => {
        await saveSettings({ [setting.key]: input.checked });
      });
    }
    const desc = document.createElement('span');
    desc.className = 'settings-note settings-item-desc';
    desc.textContent = t(setting.descKey);
    item.append(copy, input, desc);
    list.append(item);
  }
  return list;
}

async function onToolTrackingToggle() {
  const checked = Array.from(els.clientDisplayList.querySelectorAll('input[data-preference="track"]'))
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.client);
  await saveSettings({ clients: checked.join(',') });
  await refreshStats({ force: true });
}

async function onClientVisibilityToggle(clientId) {
  const hidden = hiddenClientSet();
  if (hidden.has(clientId)) hidden.delete(clientId);
  else hidden.add(clientId);
  await saveSettings({ hiddenClients: Array.from(hidden).join(',') });
}

async function onClientPinnedToggle(clientId) {
  const next = clientDisplayPreferencesApi.togglePinnedClient(state.settings?.pinnedClients, KNOWN_CLIENTS, clientId);
  await saveSettings({ pinnedClients: next, clientDisplayOrder: '' });
}

async function onViewVisibilityToggle(viewId) {
  const hidden = hiddenViewSet();
  if (hidden.has(viewId)) hidden.delete(viewId);
  else hidden.add(viewId);
  await saveSettings({ hiddenViews: Array.from(hidden).join(',') });
}

async function onTrendVisibilityToggle() {
  if (state.settings?.historyEnabled === false) {
    await setTrendEnabled(true);
    await refreshStats({ force: true });
    return;
  }
  await onViewVisibilityToggle('trends');
}

async function onProjectVisibilityToggle() {
  if (state.settings?.projectsEnabled === false) {
    await setProjectsEnabled(true);
    await refreshStats({ force: true });
    return;
  }
  await onViewVisibilityToggle('project');
}

async function onLimitProviderToggle() {
  const checked = Array.from(els.limitProviderCheckboxes.querySelectorAll('input[type=checkbox]'))
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.provider);
  if (checked.length === 0 && state.breakdown === 'limits') {
    setBreakdown('tool');
  }
  await saveSettings({ limitProviders: checked.join(','), limitsEnabled: checked.length > 0 });
  clearDisabledLimitProviderPendingChecks(new Set(checked));
  // settings:update reconfigures LimitsRuntime immediately. Its existing
  // snapshot and the newly enabled provider's eventual result arrive through
  // the normal stats push, so a forced usage + all-provider refresh here only
  // replaces stable account summaries with an interim snapshot and duplicates
  // collection work.
}

async function onLimitProviderMove(providerId, direction) {
  const next = limitProviderOrderApi.moveLimitProvider(state.settings?.limitProviderOrder, LIMIT_PROVIDERS, providerId, direction);
  await saveSettings({ limitProviderOrder: next });
}

async function onLimitProviderReorder(providerId, targetIndex) {
  const current = limitProviderOrderApi.normalizeLimitProviderOrder(state.settings?.limitProviderOrder, LIMIT_PROVIDERS).join(',');
  const next = limitProviderOrderApi.reorderLimitProvider(state.settings?.limitProviderOrder, LIMIT_PROVIDERS, providerId, targetIndex);
  if (next === current) return;
  await saveSettings({ limitProviderOrder: next });
}

async function onClientDisplayMove(clientId, direction) {
  const pinned = pinnedClientSet();
  const hasCustomOrder = clientDisplayPreferencesApi.hasCustomDisplayOrder(state.settings?.clientDisplayOrder);
  if (!hasCustomOrder && pinned.has(clientId)) {
    const nextPinned = clientDisplayPreferencesApi.movePinnedClient(state.settings?.pinnedClients, KNOWN_CLIENTS, clientId, direction);
    if (nextPinned !== clientDisplayPreferencesApi.normalizePinnedClients(state.settings?.pinnedClients, KNOWN_CLIENTS)) await saveSettings({ pinnedClients: nextPinned });
    return;
  }
  const next = clientDisplayPreferencesApi.moveClientDisplayOrder(state.settings?.clientDisplayOrder, KNOWN_CLIENTS, clientId, direction);
  await saveSettings({ clientDisplayOrder: next, pinnedClients: '' });
}

async function onClientDisplayReorder(clientId, targetIndex) {
  const pinned = pinnedClientSet();
  const hasCustomOrder = clientDisplayPreferencesApi.hasCustomDisplayOrder(state.settings?.clientDisplayOrder);
  if (!hasCustomOrder && pinned.has(clientId)) {
    const pinnedTargetIndex = Math.max(0, Math.min(pinned.size - 1, Number(targetIndex) || 0));
    const nextPinned = clientDisplayPreferencesApi.reorderPinnedClient(state.settings?.pinnedClients, KNOWN_CLIENTS, clientId, pinnedTargetIndex);
    if (nextPinned !== clientDisplayPreferencesApi.normalizePinnedClients(state.settings?.pinnedClients, KNOWN_CLIENTS)) await saveSettings({ pinnedClients: nextPinned });
    return;
  }
  const current = clientDisplayPreferencesApi.normalizeClientDisplayOrder(state.settings?.clientDisplayOrder, KNOWN_CLIENTS).join(',');
  const next = clientDisplayPreferencesApi.reorderClientDisplayOrder(state.settings?.clientDisplayOrder, KNOWN_CLIENTS, clientId, targetIndex);
  if (next === current) return;
  await saveSettings({ clientDisplayOrder: next, pinnedClients: '' });
}

async function onViewDisplayMove(viewId, direction) {
  const next = viewDisplayPreferencesApi.moveViewDisplayOrder(effectiveViewDisplayOrderValue(), VIEW_DISPLAY_OPTIONS, viewId, direction);
  await saveSettings({ viewDisplayOrder: next });
}

async function onViewDisplayReorder(viewId, targetIndex) {
  const orderValue = effectiveViewDisplayOrderValue();
  const current = viewDisplayPreferencesApi.normalizeViewDisplayOrder(orderValue, VIEW_DISPLAY_OPTIONS).join(',');
  const next = viewDisplayPreferencesApi.reorderViewDisplayOrder(orderValue, VIEW_DISPLAY_OPTIONS, viewId, targetIndex);
  if (next === current) return;
  await saveSettings({ viewDisplayOrder: next });
}

async function onHomeModuleVisibilityToggle(moduleId) {
  const hidden = hiddenHomeModuleSet();
  if (hidden.has(moduleId)) hidden.delete(moduleId);
  else hidden.add(moduleId);
  await saveSettings({ hiddenHomeModules: Array.from(hidden).join(',') });
  renderHomeIfVisible();
}

async function onHomeModuleMove(moduleId, direction) {
  const next = homeModulePreferencesApi.moveHomeModuleOrder(state.settings?.homeModuleOrder, HOME_MODULE_OPTIONS, moduleId, direction);
  await saveSettings({ homeModuleOrder: next });
  renderHomeIfVisible();
}

async function onHomeModuleReorder(moduleId, targetIndex) {
  const current = homeModulePreferencesApi.normalizeHomeModuleOrder(state.settings?.homeModuleOrder, HOME_MODULE_OPTIONS).join(',');
  const next = homeModulePreferencesApi.reorderHomeModuleOrder(state.settings?.homeModuleOrder, HOME_MODULE_OPTIONS, moduleId, targetIndex);
  if (next === current) return;
  await saveSettings({ homeModuleOrder: next });
  renderHomeIfVisible();
}

async function resetHomeModuleOrder() {
  await saveSettings({ homeModuleOrder: homeModulePreferencesApi.DEFAULT_HOME_MODULE_ORDER });
  renderHomeIfVisible();
}

async function showAllHomeModules() {
  await saveSettings({ hiddenHomeModules: '' });
  renderHomeIfVisible();
}

function hiddenServiceProviderSet() {
  return new Set(serviceStatusProviderPreferencesApi.normalizeHidden(state.settings?.hiddenServiceProviders, SERVICE_PROVIDER_OPTIONS).split(',').filter(Boolean));
}

async function onServiceProviderVisibilityToggle(providerId) {
  const hidden = hiddenServiceProviderSet();
  if (hidden.has(providerId)) hidden.delete(providerId);
  else hidden.add(providerId);
  await saveSettings({ hiddenServiceProviders: Array.from(hidden).join(',') });
}

async function onServiceProviderMove(providerId, direction) {
  const next = serviceStatusProviderPreferencesApi.moveOrder(state.settings?.serviceProviderDisplayOrder, SERVICE_PROVIDER_OPTIONS, providerId, direction);
  await saveSettings({ serviceProviderDisplayOrder: next });
}

async function onServiceProviderReorder(providerId, targetIndex) {
  const current = serviceStatusProviderPreferencesApi.normalizeOrder(state.settings?.serviceProviderDisplayOrder, SERVICE_PROVIDER_OPTIONS).join(',');
  const next = serviceStatusProviderPreferencesApi.reorderOrder(state.settings?.serviceProviderDisplayOrder, SERVICE_PROVIDER_OPTIONS, providerId, targetIndex);
  if (next === current) return;
  await saveSettings({ serviceProviderDisplayOrder: next });
}

async function onHomeLimitProviderVisibilityToggle(providerId) {
  const hidden = hiddenHomeLimitProviderSet();
  if (hidden.has(providerId)) hidden.delete(providerId);
  else hidden.add(providerId);
  await saveSettings({ hiddenHomeLimitProviders: Array.from(hidden).join(',') });
  renderHomeIfVisible();
}

async function onHomeLimitProviderMove(providerId, direction) {
  const next = limitProviderOrderApi.moveLimitProvider(homeLimitProviderOrderValue(), LIMIT_PROVIDERS, providerId, direction);
  await saveSettings({ homeLimitProviderOrder: next });
  renderHomeIfVisible();
}

async function onHomeLimitProviderReorder(providerId, targetIndex) {
  const current = limitProviderOrderApi.normalizeLimitProviderOrder(homeLimitProviderOrderValue(), LIMIT_PROVIDERS).join(',');
  const next = limitProviderOrderApi.reorderLimitProvider(homeLimitProviderOrderValue(), LIMIT_PROVIDERS, providerId, targetIndex);
  if (next === current) return;
  await saveSettings({ homeLimitProviderOrder: next });
  renderHomeIfVisible();
}

async function resetHomeLimitProviderOrder() {
  await saveSettings({ homeLimitProviderOrder: '' });
  renderHomeIfVisible();
}

async function showAllHomeLimitProviders() {
  await saveSettings({ hiddenHomeLimitProviders: '' });
  renderHomeIfVisible();
}

async function resetServiceProviderOrder() {
  await saveSettings({ serviceProviderDisplayOrder: '' });
}

async function showAllServiceProviders() {
  await saveSettings({ hiddenServiceProviders: '' });
}

async function onPreferenceReorder(kind, id, targetIndex) {
  if (kind === 'client') await onClientDisplayReorder(id, targetIndex);
  else if (kind === 'view') await onViewDisplayReorder(id, targetIndex);
  else if (kind === 'homeModule') await onHomeModuleReorder(id, targetIndex);
  else if (kind === 'homeLimitProvider') await onHomeLimitProviderReorder(id, targetIndex);
  else if (kind === 'statusProvider') await onServiceProviderReorder(id, targetIndex);
  else await onLimitProviderReorder(id, targetIndex);
}

// Only the handle-based lists commit through here; the two whole-row lists save
// from their own drag wiring, because this compares against the value they have
// already mirrored into `state.settings` and would read the write as a no-op.
async function onPreferenceOrderCommit(kind, order) {
  const value = (order || []).join(',');
  if (kind === 'view') {
    const current = viewDisplayPreferencesApi.normalizeViewDisplayOrder(effectiveViewDisplayOrderValue(), VIEW_DISPLAY_OPTIONS).join(',');
    if (value !== current) await saveSettings({ viewDisplayOrder: value });
    return;
  }
  if (kind === 'homeModule') {
    const current = homeModulePreferencesApi.normalizeHomeModuleOrder(state.settings?.homeModuleOrder, HOME_MODULE_OPTIONS).join(',');
    if (value !== current) await saveSettings({ homeModuleOrder: value });
    return;
  }
  if (kind === 'homeLimitProvider') {
    const current = limitProviderOrderApi.normalizeLimitProviderOrder(homeLimitProviderOrderValue(), LIMIT_PROVIDERS).join(',');
    if (value !== current) await saveSettings({ homeLimitProviderOrder: value });
    return;
  }
  if (kind === 'statusProvider') {
    const current = serviceStatusProviderPreferencesApi.normalizeOrder(state.settings?.serviceProviderDisplayOrder, SERVICE_PROVIDER_OPTIONS).join(',');
    if (value !== current) await saveSettings({ serviceProviderDisplayOrder: value });
  }
}

function onPreferenceOrderKeydown(event, kind, id) {
  const moves = { ArrowUp: 'up', ArrowDown: 'down' };
  if (moves[event.key]) {
    event.preventDefault();
    if (kind === 'client') void onClientDisplayMove(id, moves[event.key]);
    else if (kind === 'view') void onViewDisplayMove(id, moves[event.key]);
    else if (kind === 'homeModule') void onHomeModuleMove(id, moves[event.key]);
    else if (kind === 'homeLimitProvider') void onHomeLimitProviderMove(id, moves[event.key]);
    else if (kind === 'statusProvider') void onServiceProviderMove(id, moves[event.key]);
    else void onLimitProviderMove(id, moves[event.key]);
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const targetIndex = event.key === 'Home' ? 0 : Number.MAX_SAFE_INTEGER;
    void onPreferenceReorder(kind, id, targetIndex);
  }
}

async function resetClientDisplayOrder() {
  await saveSettings({ clientDisplayOrder: '', pinnedClients: '' });
}

async function showAllClients() {
  await saveSettings({ hiddenClients: '' });
}

async function resetViewDisplayOrder() {
  await saveSettings({ viewDisplayOrder: '' });
}

async function showAllViews() {
  await saveSettings({ hiddenViews: '' });
}

function preserveSettingsPanelScroll(callback) {
  const panel = els.settingsPanel;
  if (!panel || panel.classList.contains('hidden')) return callback();
  const scrollTop = panel.scrollTop;
  const scrollLeft = panel.scrollLeft;
  const interactionRevision = settingsScrollInteractionRevision;
  const restore = () => {
    panel.scrollTop = scrollTop;
    panel.scrollLeft = scrollLeft;
  };
  const result = callback();
  restore();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (settingsScrollInteractionRevision === interactionRevision) restore();
    });
  }
  return result;
}

async function saveSettings(patch) {
  const settingsPushRevision = state.settingsPushRevision;
  try {
    state.settings = await window.tokenMonitor.updateSettings(patch);
  } catch (error) {
    console.error('Could not persist settings:', error);
    try { state.settings = await window.tokenMonitor.getSettings(); } catch (_) {}
    applyEffectiveCurrencyRates();
    preserveSettingsPanelScroll(syncSettingsForm);
    restartTimer();
    maybeUpdateBarsIcon();
    throw error;
  }
  applyEffectiveCurrencyRates();
  // settings:update broadcasts the normalized settings before resolving the
  // IPC request. The push already ran the full sync; repeating it when the
  // promise resolves rebuilds the provider rows a second time and restarts
  // their accordion/switch layout transition.
  if (state.settingsPushRevision === settingsPushRevision) {
    preserveSettingsPanelScroll(syncSettingsForm);
  }
  restartTimer();
  maybeUpdateBarsIcon();
  if (patch.showTrayProviderBadge !== undefined) {
    await deliverTrayProviderIcons(patch.showTrayProviderBadge === true);
  }
  return true;
}

function renderHomeIfVisible() {
  if (state.breakdown === 'home' && state.stats) render();
}

function updateTitleFit() {
  const measure = document.querySelector('.app-title-measure');
  const container = document.querySelector('.app-title');
  if (!measure || !container) return;
  if (state.settings?.titleIconOnly || els.shell.classList.contains('title-icon-only')) {
    els.shell.classList.remove('title-collapsed');
    return;
  }
  const dotSpace = (els.liveDot?.offsetWidth || 4) + 5;
  // 4px buffer so the swap happens just before clipping would visibly start.
  const collapse = measure.scrollWidth + 4 > container.clientWidth - dotSpace;
  els.shell.classList.toggle('title-collapsed', collapse);
}

if (typeof ResizeObserver === 'function') {
  const tb = document.querySelector('.titlebar');
  if (tb) new ResizeObserver(updateTitleFit).observe(tb);
}

els.viewSwitcher?.addEventListener('pointerenter', clearViewSwitcherHoverClose);
els.viewSwitcher?.addEventListener('pointerleave', scheduleViewSwitcherHoverClose);
els.backHomeButton?.addEventListener('click', (event) => {
  if (state.viewSwitcherOpen) setViewSwitcherOpen(false);
  if (!renderBreakdownChange('home')) return;
  if (event.detail === 0) {
    requestAnimationFrame(() => els.viewSwitcher?.querySelector('.view-switcher-current')?.focus());
  }
});

window.addEventListener('blur', () => {
  cancelTokenRateBoost();
  clearViewSwitcherLongPress();
  clearViewSwitcherHoverClose();
  viewSwitcherLongPressTriggered = false;
  if (state.viewSwitcherOpen) setViewSwitcherOpen(false);
});

async function init() {
  // Subscribed before the app-info round trip, not after: a theme flipped while
  // that call is in flight would otherwise be missed until the next flip. The
  // seeded value then only fills in when no push has already answered.
  let systemUiThemeSeeded = false;
  const applySystemUiTheme = (dark) => {
    systemUiThemeSeeded = true;
    if (dark === state.systemDarkUi) return;
    state.systemDarkUi = dark;
    // Two caches carry baked-in ink and both go stale here: the generated bitmap
    // for the current mode, and the provider bitmaps main holds for the usage
    // modes. Repainting only the first leaves a black provider icon sitting on a
    // taskbar that just turned dark.
    void maybeUpdateBarsIcon();
    void deliverTrayProviderIcons();
  };
  window.tokenMonitor.onSystemUiThemePush?.((payload) => applySystemUiTheme(payload?.dark === true));
  try { state.appInfo = await window.tokenMonitor.getAppInfo?.(); } catch (_) {}
  // Seeding assigns directly: the rest of init delivers both icon sets anyway,
  // and settings have not loaded yet, so repainting from here would only churn.
  if (!systemUiThemeSeeded) state.systemDarkUi = state.appInfo?.systemDarkUi === true;
  if (els.aboutVersion) els.aboutVersion.textContent = state.appInfo?.version ? `v${state.appInfo.version}` : '—';
  state.settings = await window.tokenMonitor.getSettings();
  applyEffectiveCurrencyRates();
  deliverTrayProviderIcons();

  state.appUpdate = await window.tokenMonitor.getAppUpdateState();
  renderAppUpdatePill();
  renderSettingsAppUpdateRow();
  window.tokenMonitor.onAppUpdatePush?.((payload) => {
    state.appUpdate = payload;
    renderAppUpdatePill();
    renderSettingsAppUpdateRow();
    renderAutomaticAppUpdateControl();
    if (els.appUpdatePopover.matches(':popover-open')) renderAppUpdatePopover(payload);
  });
  if (state.appInfo?.loginItemSupported) {
    state.settings.startAtLogin = Boolean(state.appInfo.loginItemOpenAtLogin);
  }
  syncSettingsForm();
  diagnosticsPanel?.render();
  publishViewState();
  await refreshHubInfo();
  void refreshHubBuildStatus();
  await refreshTokscaleStatus();
  restartTimer();
  try {
    const status = await window.tokenMonitor.getStreamStatus?.();
    if (status) {
      state.streamConnected = Boolean(status.connected);
      state.mode = status.mode || state.mode;
      state.streamFailure = status.connected ? null : (status.reason ? { reason: status.reason, detail: status.detail ?? null } : null);
      setLiveDot(state.streamConnected);
      renderSyncClientStatus();
    }
  } catch (_) {}
  await refreshStats();
  restartTimer();
  updateTitleFit();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', (event) => {
    const slot = tab.dataset.periodSlot || tab.dataset.period;
    const activeSlot = fixedPeriodRangesApi.slotForSelection(state.period);
    if (slot === 'month' && activeSlot === 'month') {
      event.stopPropagation();
      setPeriodMenuOpen(!state.periodMenuOpen, { focus: state.periodMenuOpen ? '' : 'current' });
      return;
    }
    setPeriodMenuOpen(false);
    const targetPeriod = slot === 'month'
      ? fixedPeriodRangesApi.normalizeMonthMode(state.settings?.periodMonthMode)
      : tab.dataset.period;
    const snapshot = captureBreakdownMotion();
    if (!setPeriod(targetPeriod)) return;
    syncPeriodTabs();
    if (state.openSession && fixedPeriodRangesApi.supportsBreakdown(state.period, 'session')) {
      openSessionDetail(state.openSession);
    } else if (state.openSession) {
      state.openSession = null;
    }
    state.rowSignature = '';
    state.periodMotionActive = true;
    render();
    state.periodMotionActive = false;
    animateBreakdownFrom(snapshot, { duration: 800 });
  });
}

for (const button of els.monthPeriodMenu?.querySelectorAll('[data-fixed-period]') || []) {
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const selection = fixedPeriodRangesApi.normalizeMonthMode(button.dataset.fixedPeriod);
    setPeriodMenuOpen(false, { restoreFocus: true });
    const changed = setPeriod(selection);
    state.settings.periodMonthMode = selection;
    syncPeriodTabs();
    syncPeriodMenu();
    if (changed) {
      state.rowSignature = '';
      state.periodMotionActive = true;
      render();
      state.periodMotionActive = false;
    }
    await saveSettings({ periodMonthMode: selection });
  });
}

els.monthPeriodTab?.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  setPeriodMenuOpen(true, { focus: event.key === 'ArrowUp' ? 'last' : 'first' });
});

els.monthPeriodMenu?.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    setPeriodMenuOpen(false);
    return;
  }
  const buttons = periodMenuButtons();
  const currentIndex = buttons.findIndex((button) => button === event.target);
  fixedPeriodRangesApi.handlePeriodMenuNavigation(event, {
    currentIndex,
    itemCount: buttons.length,
    focusIndex: focusPeriodMenuButton
  });
});

els.periodMonthModeInput?.addEventListener('change', async () => {
  const selection = fixedPeriodRangesApi.normalizeMonthMode(els.periodMonthModeInput.value);
  state.settings.periodMonthMode = selection;
  if (fixedPeriodRangesApi.slotForSelection(state.period) === 'month') setPeriod(selection);
  syncPeriodTabs();
  render();
  await saveSettings({ periodMonthMode: selection });
});

document.addEventListener('click', (event) => {
  if (!state.periodMenuOpen) return;
  if (els.monthPeriodMenu?.contains(event.target) || els.monthPeriodTab?.contains(event.target)) return;
  setPeriodMenuOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.periodMenuOpen) {
    event.preventDefault();
    setPeriodMenuOpen(false, { restoreFocus: true });
  }
});

els.breakdown.addEventListener('click', (event) => {
  if (state.breakdown !== 'session') return;
  const rowEl = event.target.closest('.row');
  if (!rowEl) return;
  const key = rowEl.dataset.key || '';            // "session:<client>:<sessionId>"
  const client = rowEl.dataset.client || '';
  if (client !== 'claude' && client !== 'codex' && client !== 'opencode' && client !== 'reasonix') return;
  if (client === 'reasonix' && rowEl.dataset.detailUnavailable === 'true') return;
  const match = key.match(/^session:([^:]+):(.+)$/);
  if (!match) return;
  const sessionId = client === 'reasonix' ? `reasonix:${match[2]}` : match[2];
  const period = state.stats?.periods?.[state.period];
  const session = client === 'reasonix'
    ? state.stats?.nativeSessions?.[state.period]?.[sessionId]
    : period?.sessions?.[`${client}:${sessionId}`];
  openSessionDetail({
    client,
    sessionId,
    sessionCost: client === 'reasonix' ? Number(session?.reportedCostUsd || 0) : Number(session?.costUsd || 0),
    title: rowEl.querySelector('.row-title')?.textContent || ''
  });
});

els.pinButton.addEventListener('click', () => {
  saveSettings({ windowBehavior: nextWindowBehavior(currentWindowBehavior()) });
});
els.settingsButton.addEventListener('click', (event) => {
  if (state.viewSwitcherOpen) setViewSwitcherOpen(false);
  els.settingsPanel.classList.toggle('hidden');
  const settingsOpen = !els.settingsPanel.classList.contains('hidden');
  if (!settingsOpen) stopWindowShortcutRecording();
  els.shell.classList.toggle('settings-open', settingsOpen);
  if (!settingsOpen && event.detail > 0) els.settingsButton.blur();
  els.shell.style.transform = 'translateZ(0)';
  requestAnimationFrame(() => { els.shell.style.transform = ''; });
});
els.saveSettingsButton.addEventListener('click', async () => {
  const patch = {
    hubUrl: els.hubUrlInput.value.trim(),
    secret: els.secretInput.value,
    deviceId: els.deviceIdInput.value.trim()
  };
  if (state.settings.hubMode === 'host') {
    patch.hubHostPort = Number(els.hubPortInput.value) || 17321;
  }
  await saveSettings(patch);
  await refreshHubInfo();
  void refreshHubBuildStatus();
  await refreshStats();
});

els.hubModeOptions.addEventListener('change', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.name !== 'hubMode') return;
  await saveSettings({ hubMode: target.value });
  await refreshHubInfo();
  void refreshHubBuildStatus();
  await refreshStats();
});

// Both, not just the mark: either one reveals the reading on hover, so a click or hold that
// only worked on one of them would leave the other looking broken. The suppression listener
// must be registered before the existing toggle listener so a long hold does not also toggle
// the persisted speed/burn framing when its pointerup synthesizes a click.
els.appTitleMark?.addEventListener('pointerdown', startTokenRateBoost);
els.liveDot?.addEventListener('pointerdown', startTokenRateBoost);
els.appTitleMark?.addEventListener('lostpointercapture', (event) => {
  // A normal pointerup has already entered settling before capture is released. Only an
  // unexpected loss while boosting is a cancellation; otherwise the release animation would
  // be cut off immediately by the browser's follow-up lostpointercapture event.
  cancelTokenRateBoost(event, { preserveSettling: true });
});
els.liveDot?.addEventListener('lostpointercapture', (event) => {
  cancelTokenRateBoost(event, { preserveSettling: true });
});
els.appTitleMark?.addEventListener('click', suppressTokenRateClickAfterHold);
els.liveDot?.addEventListener('click', suppressTokenRateClickAfterHold);
els.appTitleMark?.addEventListener('click', toggleTokenRateMode);
els.liveDot?.addEventListener('click', toggleTokenRateMode);

els.languageInput?.addEventListener('change', async () => {
  await saveSettings({ language: els.languageInput.value });
});

els.currencyInput?.addEventListener('change', async () => {
  await saveSettings({ currency: els.currencyInput.value });
});

els.currencyRateModeAuto?.addEventListener('change', async () => {
  if (!els.currencyRateModeAuto.checked) return;
  const code = currentCurrency();
  if (code === 'USD') return;
  const next = { ...(state.settings?.currencyRates || {}) };
  delete next[code];                       // auto = no override
  await saveSettings({ currencyRates: next });
});

els.currencyRateModeManual?.addEventListener('change', async () => {
  if (!els.currencyRateModeManual.checked) return;
  const code = currentCurrency();
  if (code === 'USD') return;
  const current = Number(state.settings?.currencyRatesEffective?.[code]);  // seed with the live rate
  const seed = Number(formatRate(current)) || 1;                            // stored == what's shown
  await saveSettings({ currencyRates: { ...(state.settings?.currencyRates || {}), [code]: seed } });
  els.currencyRateOverrideInput?.focus();
});

els.currencyRateOverrideInput?.addEventListener('change', async () => {
  const code = currentCurrency();
  if (code === 'USD') return;
  const next = { ...(state.settings?.currencyRates || {}) };
  const num = Number(els.currencyRateOverrideInput.value);
  if (Number.isFinite(num) && num > 0) next[code] = num;
  else delete next[code];                  // cleared/invalid -> revert to auto
  await saveSettings({ currencyRates: next });
});

els.hubSecretCopyButton?.addEventListener('click', () => {
  copyToClipboard(els.hubSecretInput.value, els.hubSecretCopyButton);
});

els.hubSecretRegenButton?.addEventListener('click', async () => {
  if (!window.tokenMonitor.regenerateHubSecret) return;
  const info = await window.tokenMonitor.regenerateHubSecret();
  state.hubInfo = info;
  state.settings = { ...state.settings, hubHostSecret: info.secret };
  els.hubSecretInput.value = info.secret;
  renderHubStatus();
});
els.secretPasteButton?.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      els.secretInput.value = text.trim();
    }
  } catch (_) {}
});
els.limitsRefreshInput.addEventListener('change', async () => {
  // Adaptive carries its own baseline, so the stored interval is left alone and
  // comes back unchanged when a fixed option is selected again.
  const value = els.limitsRefreshInput.value;
  await saveSettings(value === 'adaptive'
    ? { limitsRefreshMode: 'adaptive' }
    : { limitsRefreshMode: 'fixed', limitsRefreshMs: Number(value) });
  await refreshStats({ force: true });
});
els.showLimitSourceInput.addEventListener('change', async () => {
  await saveSettings({ showLimitSource: els.showLimitSourceInput.checked });
});
els.maskLimitAccountEmailsInput.addEventListener('change', async () => {
  await saveSettings({ maskLimitAccountEmails: els.maskLimitAccountEmailsInput.checked });
  renderLimits();
});
els.subscriptionAddToggle?.addEventListener('click', () => {
  const opening = els.subscriptionAddDetails?.classList.contains('hidden');
  if (opening) {
    beginSubscriptionAdd();
    return;
  }
  if (state.subscriptionEditingId) {
    closeSubscriptionEditor({ onClosed: openSubscriptionAddEditor });
    return;
  }
  closeSubscriptionEditor();
});
els.subscriptionProviderInput?.addEventListener('change', () => {
  renderSubscriptionPickers();
  applySubscriptionAccountSelection();
});
els.subscriptionAccountInput?.addEventListener('change', applySubscriptionAccountSelection);
els.subscriptionStartDateInput?.addEventListener('change', syncSubscriptionDateBounds);
els.subscriptionAutoRenewInput?.addEventListener('change', setSubscriptionRenewalFieldMode);
els.subscriptionOrphanAdopt?.addEventListener('click', async () => {
  try {
    applySubscriptionSettings(await window.tokenMonitor.adoptOrphanedSubscriptions());
    state.subscriptionSyncError = '';
  } catch (error) {
    // The records stay set aside on failure — they are only cleared once the
    // shared list has actually accepted them.
    state.subscriptionSyncError = subscriptionWriteErrorKey(error);
    try { applySubscriptionSettings(await window.tokenMonitor.getSettings()); } catch (_) {}
  }
  renderSubscriptionSettings();
});
els.subscriptionOrphanDiscard?.addEventListener('click', async () => {
  try {
    applySubscriptionSettings(await window.tokenMonitor.discardOrphanedSubscriptions());
    // A discard that worked resolves whatever the failed adopt was complaining
    // about; leaving the message up would describe a state that is over.
    state.subscriptionSyncError = '';
  } catch (error) {
    state.subscriptionSyncError = subscriptionWriteErrorKey(error);
    try { applySubscriptionSettings(await window.tokenMonitor.getSettings()); } catch (_) {}
  }
  renderSubscriptionSettings();
});
for (const input of els.subscriptionKindInputs || []) {
  input.addEventListener('change', setSubscriptionFormMode);
}
// The ledger prints its amounts in the picked currency, so it has to redraw when
// that changes.
els.subscriptionCurrencyInput?.addEventListener('change', renderSubscriptionTopUpEntries);
els.subscriptionTopUpAddButton?.addEventListener('click', addSubscriptionTopUpEntry);
els.subscriptionSubmit?.addEventListener('click', submitSubscription);
els.subscriptionCancelEdit?.addEventListener('click', () => closeSubscriptionEditor());
for (const input of els.showLimitUsedInputs || []) {
  input.addEventListener('change', async () => {
    if (input.checked) await saveSettings({ showLimitUsed: input.value === 'used' });
  });
}
els.syncUploadIntervalInput?.addEventListener('change', async () => {
  await saveSettings({ syncUploadIntervalMs: Number(els.syncUploadIntervalInput.value) });
});
els.collectionCadenceInput?.addEventListener('change', async () => {
  const value = els.collectionCadenceInput.value;
  await saveSettings({
    collectionMode: value === 'live' ? 'live' : value === 'smart' ? 'smart' : 'interval',
    collectionIntervalMs: value === 'smart'
      ? 600000
      : value === 'live'
        ? Number(state.settings.collectionIntervalMs || 300000)
        : Number(value)
  });
});
els.sessionUsageArchiveInput?.addEventListener('change', async () => {
  await saveSettings({ sessionUsageArchiveEnabled: els.sessionUsageArchiveInput.checked });
});
els.clearSessionUsageArchiveButton?.addEventListener('click', async () => {
  if (!window.confirm(t('settings.collection.sessionArchiveConfirm'))) return;
  els.clearSessionUsageArchiveButton.disabled = true;
  try {
    const result = await window.tokenMonitor.clearSessionUsageArchive();
    if (!result?.ok) {
      window.alert(t(result?.error === 'agentActive'
        ? 'settings.collection.sessionArchiveAgentActive'
        : 'settings.collection.sessionArchiveFailed'));
      return;
    }
    await refreshStats();
  } finally {
    els.clearSessionUsageArchiveButton.disabled = false;
  }
});
els.wslScanInput?.addEventListener('change', async () => {
  await saveSettings({ wslScanEnabled: els.wslScanInput.checked });
});
els.exportAutoInput?.addEventListener('change', async () => {
  await saveSettings({ exportAutoEnabled: els.exportAutoInput.checked });
});
els.exportPickDirButton?.addEventListener('click', async () => {
  const result = await window.tokenMonitor.pickExportDir();
  if (result?.ok) await saveSettings({ exportDir: result.dir });
});
els.exportIntervalInput?.addEventListener('change', async () => {
  await saveSettings({ exportIntervalMs: Number(els.exportIntervalInput.value) });
});
els.exportNowButton?.addEventListener('click', async () => {
  els.exportNowButton.disabled = true;
  try {
    const result = await window.tokenMonitor.exportNow();
    if (result?.ok) {
      els.exportNowButton.textContent = t('settings.export.manualDone');
      setTimeout(() => { els.exportNowButton.textContent = t('settings.export.manualNow'); }, 1600);
    } else if (result && !result.canceled) {
      els.exportNowButton.textContent = t('settings.export.manualFailed');
      setTimeout(() => { els.exportNowButton.textContent = t('settings.export.manualNow'); }, 1600);
    }
  } finally {
    els.exportNowButton.disabled = false;
  }
});
els.resetClientDisplayOrderButton?.addEventListener('click', resetClientDisplayOrder);
els.showAllClientsButton?.addEventListener('click', showAllClients);
els.resetViewDisplayOrderButton?.addEventListener('click', resetViewDisplayOrder);
els.showAllViewsButton?.addEventListener('click', showAllViews);
els.resetGlassButton.addEventListener('click', async () => {
  els.glassInput.value = String(defaultAppearance.glassOpacity);
  applyAppearanceFromControls();
  await saveSettings({ glassOpacity: defaultAppearance.glassOpacity });
});
els.resetDepthButton.addEventListener('click', async () => {
  els.blurInput.value = String(defaultAppearance.glassBlur);
  applyAppearanceFromControls();
  await saveSettings({ glassBlur: defaultAppearance.glassBlur });
});
els.glassInput.addEventListener('input', applyAppearanceFromControls);
els.blurInput.addEventListener('input', applyAppearanceFromControls);
els.zoomInput.addEventListener('input', applyAppearanceFromControls);
els.resetThemeColorsButton?.addEventListener('click', () => commitThemeColors({}));
els.resetVendorColorsButton?.addEventListener('click', () => commitVendorColors({}));
els.interfaceFontPreset?.addEventListener('change', () => handleFontPresetChange('interface'));
els.displayFontPreset?.addEventListener('change', () => handleFontPresetChange('display'));
els.interfaceFontInput?.addEventListener('input', previewFontSettings);
els.displayFontInput?.addEventListener('input', previewFontSettings);
els.interfaceFontInput?.addEventListener('change', saveFontSettingsFromControls);
els.displayFontInput?.addEventListener('change', saveFontSettingsFromControls);
els.resetInterfaceFontButton?.addEventListener('click', () => resetInterfaceFont());
els.resetDisplayFontButton?.addEventListener('click', () => resetDisplayFont());
els.applyThemeCodeButton?.addEventListener('click', () => { void pasteAndApplyThemeCode(); });
els.copyThemeCodeButton?.addEventListener('click', () => { void copyCurrentThemeCode(); });
els.themeCodeInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void applyThemeCodeFromInput();
});
els.themeCodeInput?.addEventListener('input', invalidateThemeCodeFeedback);
function setSettingsAccordionExpanded(group, toggle, details, expanded) {
  if (!group || !toggle || !details) return;
  const open = Boolean(expanded);
  toggle.setAttribute('aria-expanded', String(open));
  details.classList.toggle('hidden', !open);
  details.inert = !open;
  group.classList.toggle('expanded', open);
}
function setupSettingsAccordion(group, toggle, details) {
  if (!group || !toggle || !details) return;
  toggle.addEventListener('click', () => {
    setSettingsAccordionExpanded(group, toggle, details, details.classList.contains('hidden'));
  });
  setSettingsAccordionExpanded(group, toggle, details, false);
}

setupSettingsAccordion(els.appUpdateNotes, els.appUpdateNotesToggle, els.appUpdateNotesDetails);
setupSettingsAccordion(els.advancedSettingsGroup, els.advancedSettingsToggle, els.advancedSettingsDetails);
setupSettingsAccordion(els.themeAdvancedGroup, els.themeAdvancedToggle, els.themeAdvancedDetails);
setupSettingsAccordion(els.themeVendorGroup, els.themeVendorToggle, els.themeVendorDetails);
for (const input of els.systemGlassInputs || []) {
  input.addEventListener('change', () => {
    if (input.checked) saveAppearanceFromControls();
  });
}
els.windowsBackdropInput?.addEventListener('change', saveAppearanceFromControls);
for (const input of els.reduceMotionInputs || []) {
  input.addEventListener('change', async () => {
    if (!input.checked) return;
    state.settings.reduceMotion = applyReduceMotionPreference(input.value);
    await saveAppearanceFromControls();
  });
}
els.liveDotInput.addEventListener('change', saveAppearanceFromControls);
els.toolIconsInput.addEventListener('change', async () => {
  state.settings.showToolIcons = els.toolIconsInput.checked;
  renderHomeIfVisible();
  await saveAppearanceFromControls();
});
els.titleIconInput.addEventListener('change', saveAppearanceFromControls);
els.showCompactTotalTokensInput.addEventListener('change', async () => {
  await saveAppearanceFromControls();
});
els.compactTokenUnitsInput?.addEventListener('change', async () => {
  await saveAppearanceFromControls();
});
window.addEventListener('resize', () => { if (!numberAnimHandle) fitTotalNumber(); });
els.swapSettingsRefreshInput.addEventListener('change', () => {
  applyControlLayout(els.swapSettingsRefreshInput.checked);
  void saveAppearanceFromControls();
});
els.discordRpcInput.addEventListener('change', saveAppearanceFromControls);
els.windowBehaviorInput.addEventListener('change', () => saveSettings({ windowBehavior: els.windowBehaviorInput.value }));
els.floatingBubbleInput.addEventListener('change', () => {
  state.settings.floatingBubbleEnabled = els.floatingBubbleInput.checked;
  els.floatingBubbleOptions?.classList.toggle('hidden', !els.floatingBubbleInput.checked);
  refreshTrayComposers();
  saveSettings({ floatingBubbleEnabled: els.floatingBubbleInput.checked });
});
for (const input of els.floatingBubbleTriggerInputs || []) {
  input.addEventListener('change', () => {
    if (input.checked) void saveSettings({ floatingBubbleTrigger: input.value });
  });
}
els.floatingBubbleContentInput?.addEventListener('change', async () => {
  state.settings.floatingBubbleContent = els.floatingBubbleContentInput.value;
  refreshTrayComposers();
  await saveSettings({ floatingBubbleContent: els.floatingBubbleContentInput.value });
  renderFloatingBubbleContent();
});
els.showTrayIconInput?.addEventListener('change', () => {
  const showTrayIcon = els.showTrayIconInput.checked;
  state.settings.showTrayIcon = showTrayIcon;
  els.trayModeInput.disabled = !showTrayIcon;
  if (!showTrayIcon) els.trayModeInput.checked = false;
  els.trayContentInput.disabled = !showTrayIcon;
  els.showTrayProviderBadgeInput.disabled = !showTrayIcon;
  els.trayIconOptions?.classList.toggle('hidden', !showTrayIcon);
  els.trayOptions?.classList.toggle('hidden', !showTrayIcon || !els.trayModeInput.checked);
  refreshTrayComposers();
  saveSettings({ showTrayIcon, trayMode: showTrayIcon ? els.trayModeInput.checked : false });
});
els.trayModeInput.addEventListener('change', () => {
  els.trayOptions?.classList.toggle('hidden', !els.showTrayIconInput?.checked || !els.trayModeInput.checked);
  saveSettings({ trayMode: els.trayModeInput.checked });
});
els.trayContentInput.addEventListener('change', () => {
  state.settings.trayContent = els.trayContentInput.value;
  refreshTrayComposers();
  saveSettings({ trayContent: els.trayContentInput.value });
});
els.showTrayProviderBadgeInput.addEventListener('change', () => {
  state.settings.showTrayProviderBadge = els.showTrayProviderBadgeInput.checked;
  void maybeUpdateBarsIcon();
  saveSettings({ showTrayProviderBadge: els.showTrayProviderBadgeInput.checked });
});
els.windowToggleShortcutValue?.addEventListener('click', startWindowShortcutRecording);
els.windowToggleShortcutClearButton?.addEventListener('click', () => setWindowToggleShortcut('').catch(() => {}));
els.startAtLoginInput?.addEventListener('change', () => saveSettings({ startAtLogin: els.startAtLoginInput.checked }));
els.automaticAppUpdatesInput?.addEventListener('change', () => saveSettings({ automaticAppUpdates: els.automaticAppUpdatesInput.checked }));
els.glassInput.addEventListener('change', saveAppearanceFromControls);
els.blurInput.addEventListener('change', saveAppearanceFromControls);
els.zoomInput.addEventListener('change', saveAppearanceFromControls);
els.resetZoomButton.addEventListener('click', async () => {
  els.zoomInput.value = String(Math.round(defaultAppearance.zoomFactor * 100));
  syncSliderRow(els.zoomInput);
  await saveSettings({ zoomFactor: defaultAppearance.zoomFactor });
});
els.openConfigButton.addEventListener('click', () => window.tokenMonitor.openUserData());
els.checkTokscaleButton?.addEventListener('click', checkTokscaleNpm);
els.downloadTokscaleButton?.addEventListener('click', downloadTokscaleFromNpm);
els.resetTokscaleButton?.addEventListener('click', resetTokscaleToBundled);
els.openTokscaleLinkButton?.addEventListener('click', () => window.tokenMonitor.openExternal?.('https://github.com/junhoyeo/tokscale'));
els.openRepositoryButton?.addEventListener('click', () => window.tokenMonitor.openExternal?.(TOKEN_MONITOR_REPOSITORY_URL));
els.openWebsiteButton?.addEventListener('click', () => window.tokenMonitor.openExternal?.(TOKEN_MONITOR_WEBSITE_URL));
els.reportIssueButton?.addEventListener('click', () => window.tokenMonitor.openExternal?.(TOKEN_MONITOR_ISSUES_URL));
els.refreshButton.addEventListener('click', () => {
  if (state.breakdown === 'status') refreshStatusViewManually().catch(() => {});
  // Only this button asks for a history rescan and a self-sync: `{ force: true }` is
  // used all over the settings/account flows, and folding those into it would re-run
  // the expensive `tokscale graph`, plus the Cursor and Antigravity sync subprocesses,
  // on every one of them.
  else refreshStats({ force: true, forceHistory: true, forceSelfSync: true, feedback: true });
});
els.minButton.addEventListener('click', () => window.tokenMonitor.minimize());
els.closeButton.addEventListener('click', () => window.tokenMonitor.close());
els.trendsPanel.addEventListener('click', (event) => {
  if (event.target.closest('.trends-spark, .trends-open-hint')) window.tokenMonitor.openDashboard();
});
els.trendsPanel.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('.trends-spark')) {
    event.preventDefault();
    window.tokenMonitor.openDashboard();
  }
});
els.floatingBubbleTab.addEventListener('pointerdown', handleFloatingBubblePointerDown);
els.floatingBubbleTab.addEventListener('pointermove', handleFloatingBubblePointerMove);
els.floatingBubbleTab.addEventListener('pointerup', handleFloatingBubblePointerUp);
els.floatingBubbleTab.addEventListener('pointercancel', (event) => { finishFloatingBubbleDrag(event.pointerId); });
els.floatingBubbleTab.addEventListener('mouseenter', handleFloatingBubbleHoverEnter);
els.floatingBubbleTab.addEventListener('mouseleave', handleFloatingBubbleHoverLeave);
document.documentElement.addEventListener('mouseleave', handleDocumentHoverLeave);
document.documentElement.addEventListener('mouseenter', clearHoverCollapseTimer);
els.floatingBubbleTab.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  window.tokenMonitor.expandFloatingBubble?.();
});

async function runAppUpdateAction() {
  const mode = appUpdatePresentationApi.appUpdateActionMode(state.appUpdate);
  if (mode === 'install') {
    state.appUpdate = await window.tokenMonitor.installAppUpdate();
  } else if (mode === 'download') {
    state.appUpdate = await window.tokenMonitor.downloadAppUpdate();
  } else if (mode === 'release') {
    const latest = state.appUpdate?.latest;
    if (!latest?.htmlUrl) return;
    await window.tokenMonitor.openExternal(latest.htmlUrl);
  } else {
    return;
  }
  renderAppUpdatePill();
  renderSettingsAppUpdateRow();
}

els.appUpdatePillAction.addEventListener('click', async () => {
  if (!renderAppUpdatePopover(state.appUpdate) || typeof els.appUpdatePopover.showPopover !== 'function') {
    if (appUpdatePresentationApi.appUpdateActionMode(state.appUpdate) === 'install') {
      const url = state.appUpdate?.latest?.htmlUrl;
      if (url) await window.tokenMonitor.openExternal(url);
      return;
    }
    await runAppUpdateAction();
    return;
  }
  positionAppUpdatePopover();
  els.appUpdatePopover.showPopover();
  els.appUpdatePopoverAction.focus();
});

els.appUpdatePillRestart.addEventListener('click', async () => {
  await runAppUpdateAction();
});

els.appUpdatePillDismiss.addEventListener('click', async () => {
  const version = state.appUpdate?.latest?.version;
  if (!version) return;
  state.appUpdate = await window.tokenMonitor.dismissAppUpdate(version);
  if (els.appUpdatePopover.matches(':popover-open')) els.appUpdatePopover.hidePopover();
  renderAppUpdatePill();
});

els.appUpdatePopoverClose.addEventListener('click', () => {
  els.appUpdatePopover.hidePopover();
});

els.appUpdatePopover.addEventListener('toggle', (event) => {
  const open = event.newState === 'open';
  if (els.appUpdatePillAction.hasAttribute('aria-haspopup')) {
    els.appUpdatePillAction.setAttribute('aria-expanded', String(open));
  }
  if (!open) {
    const active = document.activeElement;
    if (active === document.body || active === els.appUpdatePopover || els.appUpdatePopover.contains(active)) {
      els.appUpdatePillAction.focus();
    }
  }
});

els.appUpdatePopoverAction.addEventListener('click', async () => {
  els.appUpdatePopover.hidePopover();
  await runAppUpdateAction();
});

els.appUpdatePopoverRelease.addEventListener('click', async () => {
  const url = state.appUpdate?.latest?.htmlUrl;
  if (url) await window.tokenMonitor.openExternal(url);
});

window.addEventListener('resize', () => {
  if (els.appUpdatePopover.matches(':popover-open')) positionAppUpdatePopover();
});

els.appUpdateCheckButton.addEventListener('click', async () => {
  state.appUpdate = await window.tokenMonitor.checkAppUpdateNow();
  renderAppUpdatePill();
  renderSettingsAppUpdateRow();
});

els.appUpdateViewReleaseButton.addEventListener('click', async () => {
  await runAppUpdateAction();
});

els.appUpdateReleaseNotesButton.addEventListener('click', async () => {
  const url = state.appUpdate?.latest?.htmlUrl;
  if (url) await window.tokenMonitor.openExternal(url);
});

window.tokenMonitor.onSettingsPush?.((next) => {
  if (!next) return;
  state.settingsPushRevision += 1;
  const prevMetric = state.settings?.heatmapMetric;
  const prevLanguage = state.settings?.language;
  const prevCompactTokenUnits = state.settings?.compactTokenUnits;
  const prevShowCompactTotalTokens = state.settings?.showCompactTotalTokens;
  state.settings = next;
  applyEffectiveCurrencyRates();
  preserveSettingsPanelScroll(syncSettingsForm);
  maybeUpdateBarsIcon();
  if ((prevMetric || 'cost') !== (next.heatmapMetric || 'cost')) {
    render();
  } else if (
    prevLanguage !== next.language
    || prevCompactTokenUnits !== next.compactTokenUnits
  ) {
    render();
  } else if (prevShowCompactTotalTokens !== next.showCompactTotalTokens) {
    updateTotalCompact(state.currentTotal);
  }
});

reducedMotionMedia?.addEventListener?.('change', () => {
  if (motionPreferenceApi.normalize(state.settings?.reduceMotion) !== 'system') return;
  applyReduceMotionPreference('system');
});

window.tokenMonitor.onOpenSettings?.(openSettingsPanel);
window.tokenMonitor.onOpenView?.(openViewFromTray);

window.tokenMonitor.onFloatingBubbleState?.((payload) => {
  applyFloatingBubbleState(payload);
});

window.tokenMonitor.onHubPush?.((payload) => {
  if (!payload?.info) return;
  state.hubInfo = payload.info;
  // The first switch to Host mode generates the shared secret asynchronously
  // after settings:update has already returned, so mirror the freshly minted
  // value back into state + input — otherwise the Shared Secret field stays
  // blank and other devices can't pair until the user clicks Regenerate.
  if (payload.info.secret && payload.info.secret !== state.settings?.hubHostSecret) {
    state.settings = { ...state.settings, hubHostSecret: payload.info.secret };
    if (els.hubSecretInput && state.settings.hubMode === 'host') {
      els.hubSecretInput.value = payload.info.secret;
    }
  }
  renderHubStatus();
});

window.tokenMonitor.onTokscalePush?.((payload) => {
  mergeTokscalePayload(payload);
  renderTokscaleStatus();
});

function renderStatsUpdate() {
  render();
  renderCodexAccounts();
  renderSettingsSummaries();
  renderLimitProviderCheckboxes();
  renderToolPreferences();
  renderWslPanel();
  updateOpenRouterProfilesStatus();
  updateThirdPartyProfilesStatus();
  renderDeepseekStatus();
  renderMinimaxStatus();
  renderExternalProviderStatus('claude');
  renderExternalProviderStatus('zai');
  renderExternalProviderStatus('zaiteam');
  renderExternalProviderStatus('volcengine');
  renderExternalProviderStatus('qoder');
  renderExternalProviderStatus('commandcode');
  renderExternalProviderStatus('kimi');
  renderExternalProviderStatus('ollama');
  renderCopilotStatus();
}

const statsRenderScheduler = statsRenderSchedulerApi.createStatsRenderScheduler({
  isHidden: () => document.hidden,
  render: renderStatsUpdate
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelTokenRateBoost();
  if (!document.hidden && state.settings?.hubMode === 'client' && hubBuildStatusRefreshDue()) {
    void refreshHubBuildStatus();
  }
  statsRenderScheduler.flush();
});

window.tokenMonitor.onStatsPush?.((payload) => {
  if (!payload) return;
  const wasStreamConnected = state.streamConnected;
  if (payload.event === 'status') {
    state.streamConnected = Boolean(payload.data?.connected);
    if (payload.data?.mode) state.mode = payload.data.mode;
    state.streamFailure = state.streamConnected ? null : (payload.data?.reason ? { reason: payload.data.reason, detail: payload.data.detail ?? null } : state.streamFailure);
  } else if (payload.data?.stats) {
    // Local collector overlays update client-mode data independently of the
    // Hub SSE transport. Preserve its current Offline/error state until a
    // real stream status or remote stats event proves the connection changed.
    if (payload.data?.reason !== 'local' && payload.data?.reason !== 'presentation') {
      state.streamConnected = true;
      state.streamFailure = null;
    }
    if (payload.data?.mode) state.mode = payload.data.mode;
    state.stats = overlayAllTimeSessions(payload.data.stats);
    applyCodexActiveAccountFromStats();
    // Progressive mid-tick pushes never carry a fresh history scan (see
    // AGENTS.md collector notes), so only the final push can retire the
    // "just turned trends on" loading state without a flash back to empty.
    if (payload.data?.reason !== 'progress') state.trendsActivating = false;
  } else {
    return;
  }
  setLiveDot(state.streamConnected);
  setStatus(statusTextFor(state.mode, state.streamConnected));
  renderSyncClientStatus();
  if (!wasStreamConnected && state.streamConnected && state.settings?.hubMode === 'client') {
    void refreshHubBuildStatus();
  }
  if (payload.data?.stats) {
    if (fixedPeriodRangesApi.isDerived(state.period)) {
      // Keep the currently rendered range stable while a new History revision is
      // fetched; repaint once with the coherent snapshot instead of flashing an
      // intermediate loading layout.
      if (fixedPeriodHistoryNeedsWarmup()) {
        void warmFixedPeriodHistory({ renderOnComplete: true });
      } else {
        statsRenderScheduler.request();
      }
    } else {
      statsRenderScheduler.request();
      void warmFixedPeriodHistory({ renderOnComplete: false });
    }
    maybeUpdateBarsIcon();
  }
  restartTimer();
});

function pickWorstProvider(stats) {
  return window.TokenMonitorTrayText.pickWorstLimitProvider(stats);
}

function pickWorstSessionProvider(stats) {
  return window.TokenMonitorTrayText.pickLimitProviderByKindPriority(stats, ['session', 'weekly']);
}

function pickWorstWeeklyProvider(stats) {
  return window.TokenMonitorTrayText.pickWorstLimitProvider(stats, { kind: 'weekly' });
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const trayProviderImages = {};
const trayProviderImageIds = new WeakMap();
const trayProviderImageOpticalSamples = new WeakMap();
const trayProviderIconDeliveryGuard = window.TokenMonitorTrayProviderIcons.createTrayProviderIconDeliveryGuard();
const trayComposers = {};
let customTrayClockTimer = null;

function providerImageOpticalSample(image) {
  const cached = trayProviderImageOpticalSamples.get(image);
  if (cached) return cached;

  const sampleSize = 128;
  const canvas = document.createElement('canvas');
  canvas.width = sampleSize;
  canvas.height = sampleSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, sampleSize, sampleSize);

  let bounds = { x: 0, y: 0, width: sampleSize, height: sampleSize };
  // Whether the mark is drawn in one flat ink, i.e. authored `fill="currentColor"`
  // and meant to be re-inked, as opposed to brand artwork that must be left alone.
  // The rule itself lives in isFlatInkPixels so it can be tested against pixels
  // directly; pixels we cannot read back (a future non-local image) leave it
  // false, which means untinted.
  let flatInk = false;
  try {
    const pixels = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
    flatInk = window.TokenMonitorTrayProviderIcons.isFlatInkPixels(pixels);
    let minX = sampleSize;
    let minY = sampleSize;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < sampleSize; y += 1) {
      for (let x = 0; x < sampleSize; x += 1) {
        if (pixels[(y * sampleSize + x) * 4 + 3] <= 12) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX >= minX && maxY >= minY) {
      bounds = {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1
      };
    }
  } catch (_) {
    // Keep the original frame if a future non-local image cannot be inspected.
  }

  const sample = { canvas, bounds, flatInk };
  trayProviderImageOpticalSamples.set(image, sample);
  return sample;
}

function paintProviderImage(ctx, image, x, y, size, templateColor = '') {
  const {
    trayProviderOpticalLayout,
    trayProviderOpticalRatio
  } = window.TokenMonitorTrayProviderIcons;
  const sample = providerImageOpticalSample(image);
  const opticalRatio = trayProviderOpticalRatio(trayProviderImageIds.get(image));
  const layout = trayProviderOpticalLayout(sample.bounds, size, opticalRatio);
  const maskSize = Math.max(1, Math.round(size));
  const mask = document.createElement('canvas');
  mask.width = maskSize;
  mask.height = maskSize;
  const maskCtx = mask.getContext('2d');
  maskCtx.drawImage(
    sample.canvas,
    sample.bounds.x,
    sample.bounds.y,
    sample.bounds.width,
    sample.bounds.height,
    layout.x,
    layout.y,
    layout.width,
    layout.height
  );
  if (templateColor) {
    maskCtx.globalCompositeOperation = 'source-in';
    maskCtx.fillStyle = templateColor;
    maskCtx.fillRect(0, 0, maskSize, maskSize);
  }
  ctx.drawImage(mask, x, y, size, size);
}

// Which ink a provider mark is drawn in. An explicit colour always wins — the
// menubar previews and the floating bubble pass their own, and the bubble
// deliberately passes none to keep the artwork in colour. `trayInk` is set only
// by the two paths that hand a bitmap to the system tray, where a monochrome
// mark has to be re-inked for a dark taskbar (see trayProviderGlyphInk).
function trayGlyphInk(options, image) {
  if (options?.templateIconColor) return options.templateIconColor;
  if (options?.trayInk !== true || !image) return '';
  return window.TokenMonitorTrayText.trayProviderGlyphInk(
    state.appInfo?.platform,
    state.systemDarkUi,
    providerImageOpticalSample(image).flatInk
  );
}

function drawProviderImage(ctx, image, x, y, size, contrastHalo = false, templateColor = '') {
  if (contrastHalo) {
    const lightSurface = themePresetsApi.isLightHex(resolvedThemeColor('bg'));
    ctx.save();
    ctx.shadowColor = lightSurface ? 'rgba(0, 0, 0, 0.58)' : 'rgba(255, 255, 255, 0.82)';
    ctx.shadowBlur = Math.max(2, Math.round(size * 0.1));
    paintProviderImage(ctx, image, x, y, size, templateColor);
    ctx.restore();
  }
  paintProviderImage(ctx, image, x, y, size, templateColor);
}

function renderBarsIcon(stats, height = 44, picker = pickWorstProvider, colors = {}, options = {}) {
  const trackColor = colors.track || 'rgba(0, 0, 0, 0.32)';
  const fillColor = colors.fill || 'rgba(0, 0, 0, 1)';
  const selection = picker(stats);
  if (!selection) return null;
  const { providerRecord } = selection;
  const providerImage = trayProviderImages[providerRecord.provider];
  const { trayBarFillWidth, trayBarsLayout } = window.TokenMonitorTrayBars;
  const layout = trayBarsLayout(height);

  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, layout.width, layout.height);

  if (providerImage) {
    drawProviderImage(
      ctx,
      providerImage,
      layout.padX,
      layout.iconY,
      layout.iconSize,
      options.providerContrastHalo === true,
      trayGlyphInk(options, providerImage)
    );
  }

  function drawBar(y, percent) {
    roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
    ctx.fillStyle = trackColor;
    ctx.fill();
    const fillW = trayBarFillWidth(limitFillPercent(percent, undefined, Boolean(state.settings?.showLimitUsed)), layout.barsWidth);
    if (!fillW) return;
    // Clip-to-track + flat fillRect: a rounded rect's tiny corners get lost when the icon is downscaled into the menubar.
    ctx.save();
    roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
    ctx.clip();
    ctx.fillStyle = fillColor;
    ctx.fillRect(layout.barsX, y, fillW, layout.barHeight);
    ctx.restore();
  }

  // Read the selection's resolved percentages, not the raw windows: a balance
  // window carries no wire percentage and would draw an empty (exhausted) bar.
  drawBar(layout.barsStartY, selection.primaryPercent);
  drawBar(layout.barsStartY + layout.barHeight + layout.barGap, selection.secondaryPercent);
  return canvas.toDataURL('image/png');
}

function pickConfiguredSessionProviders(stats, configOrder) {
  return window.TokenMonitorTrayText.pickConfiguredLimitProviders(stats, {
    limitProviderOrder: configOrder,
    limitProviders: configOrder,
    showLimitUsed: Boolean(state.settings?.showLimitUsed)
  });
}

function renderAllSessionsIcon(stats, height = 44, configOrder, colors = {}, options = {}) {
  const trackColor = colors.track || 'rgba(0, 0, 0, 0.32)';
  const fillColor = colors.fill || 'rgba(0, 0, 0, 1)';
  const picks = pickConfiguredSessionProviders(stats, configOrder);
  if (picks.length === 0) return null;
  // With one tool, preserve its canonical pair; a lone weekly/billing window is
  // promoted to the top lane and the lower lane remains an empty track.
  if (picks.length === 1) return renderBarsIcon(stats, height, () => picks[0], colors, options);

  const { trayBarFillWidth, trayBarsLayout } = window.TokenMonitorTrayBars;
  const layout = trayBarsLayout(height, { contentOnly: true });
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, layout.width, layout.height);

  // No per-row icons — order in the dropdown identifies which row is which tool.
  // Keep the canvas to just the bars, so the tray does not reserve a blank icon area.
  function drawBar(y, percent) {
    roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
    ctx.fillStyle = trackColor;
    ctx.fill();
    const fillW = trayBarFillWidth(limitFillPercent(percent, undefined, Boolean(state.settings?.showLimitUsed)), layout.barsWidth);
    if (!fillW) return;
    ctx.save();
    roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
    ctx.clip();
    ctx.fillStyle = fillColor;
    ctx.fillRect(layout.barsX, y, fillW, layout.barHeight);
    ctx.restore();
  }

  // The picker's resolved remaining percentage, not the raw window: drawBar
  // applies the used-mode flip itself, and a balance window has no wire
  // percentage to read.
  drawBar(layout.barsStartY, picks[0].remaining);
  drawBar(layout.barsStartY + layout.barHeight + layout.barGap, picks[1].remaining);
  return canvas.toDataURL('image/png');
}

function renderLimitSessionsIcon(stats, height = 44, configOrder, colors = {}, options = {}) {
  const picks = pickConfiguredSessionProviders(stats, configOrder);
  if (picks.length === 0) return null;

  const textColor = colors.text || colors.fill || 'rgba(0, 0, 0, 1)';
  const { trayBarsLayout } = window.TokenMonitorTrayBars;
  const layout = trayBarsLayout(height);
  const iconSize = layout.iconSize;
  const gap = Math.max(3, Math.round(height * 0.1));
  const separator = ' · ';
  const padX = options.contentOnly === true ? 0 : layout.padX;
  const fontSize = Math.round(height * 0.68);
  const font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = font;
  // `percent` / `secondaryPercent` are already mode-adjusted by the picker and
  // handle balance windows, which carry no wire percentage of their own.
  const visiblePicks = picks.length === 1
    ? [{
        ...picks[0],
        text: [picks[0].percent, picks[0].secondaryPercent]
          .filter((percent) => percent !== null && percent !== undefined)
          .map((percent) => formatPercent(percent))
          .join(separator)
      }]
    : picks.map((pick) => ({
        ...pick,
        text: formatPercent(pick.percent)
      }));
  const entries = visiblePicks.map((pick) => {
    const text = pick.text;
    const image = trayProviderImages[pick.providerRecord.provider];
    const textWidth = Math.ceil(measureCtx.measureText(text).width);
    const iconWidth = image ? iconSize + gap : 0;
    return { pick, text, image, width: iconWidth + textWidth };
  }).filter((entry) => entry.text);
  if (entries.length === 0) return null;

  const separatorWidth = Math.ceil(measureCtx.measureText(separator).width);
  const width = Math.ceil(
    padX * 2 +
    entries.reduce((sum, entry) => sum + entry.width, 0) +
    separatorWidth * Math.max(0, entries.length - 1)
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = textColor;

  let x = padX;
  const centerY = height / 2;
  entries.forEach((entry, index) => {
    if (entry.image) {
      drawProviderImage(ctx, entry.image, x, layout.iconY, iconSize,
        options.providerContrastHalo === true,
        trayGlyphInk(options, entry.image)
      );
      x += iconSize + gap;
    }
    ctx.fillText(entry.text, x, centerY + 1);
    x += Math.ceil(ctx.measureText(entry.text).width);
    if (index < entries.length - 1) {
      ctx.fillText(separator, x, centerY + 1);
      x += separatorWidth;
    }
  });
  return canvas.toDataURL('image/png');
}

function trayComposerSampleStats() {
  const resetSoon = new Date(Date.now() + 3 * 60 * 60 * 1000 + 7 * 60 * 1000).toISOString();
  const resetLater = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString();
  return {
    periods: {
      today: { totalTokens: 1_240_000, costUsd: 12.34 },
      month: { totalTokens: 18_600_000, costUsd: 184.2 },
      allTime: { totalTokens: 225_437_666, costUsd: 1502.72 }
    },
    limits: {
      providers: [
        {
          provider: 'codex',
          status: 'ok',
          accountKey: 'preview-codex',
          accountEmail: 'you@example.com',
          sourceDetail: 'app',
          windows: [
            { kind: 'session', label: '', remainingPercent: 64, resetsAt: resetSoon },
            { kind: 'weekly', label: '', remainingPercent: 42, resetsAt: resetLater }
          ]
        },
        {
          provider: 'claude',
          status: 'ok',
          accountKey: 'preview-claude',
          accountEmail: 'work@example.com',
          sourceDetail: 'oauth',
          windows: [
            { kind: 'session', label: '', remainingPercent: 78, resetsAt: resetSoon },
            { kind: 'weekly', label: '', remainingPercent: 57, resetsAt: resetLater }
          ]
        }
      ]
    }
  };
}

function statsForTrayComposer() {
  const sample = trayComposerSampleStats();
  const liveProviders = state.stats?.limits?.providers;
  return {
    ...sample,
    ...state.stats,
    periods: {
      ...sample.periods,
      ...(state.stats?.periods || {})
    },
    limits: Array.isArray(liveProviders) && liveProviders.some((provider) => provider?.status === 'ok' && !provider?.stale)
      ? state.stats.limits
      : sample.limits
  };
}

function drawTrayFallbackMark(ctx, value, x, y, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `600 ${Math.round(size * 0.46)}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(value === 'app' ? 'Σ' : String(value || '?').slice(0, 1).toUpperCase(), x + size / 2, y + size / 2 + 1);
  ctx.restore();
}

function trayTextCanvasFont(item, fontSize, defaultWeight) {
  const style = item?.fontStyle || 'normal';
  const family = style === 'compactMono'
    ? 'ui-monospace, ".AppleSystemUIFontMonospaced", "SFMono-Regular", "SF Mono", Menlo, monospace'
    : '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
  const weight = style === 'menubar' ? 700 : style === 'compactMono' ? 600 : defaultWeight;
  return `${weight} ${fontSize}px ${family}`;
}

function trayTextHorizontalScale(item) {
  if (item?.fontStyle === 'condensed') return 0.86;
  if (item?.fontStyle === 'menubar') return 0.92;
  return 1;
}

function trayTextSpaceScale(item) {
  return item?.fontStyle === 'compactMono' ? 0.55 : 1;
}

function trayTextRuns(ctx, text, item) {
  const spaceScale = trayTextSpaceScale(item);
  return (String(text).match(/\s+|\S+/g) || ['']).map((value) => {
    const blank = /^\s+$/.test(value);
    return {
      value,
      blank,
      width: ctx.measureText(value).width * (blank ? spaceScale : 1)
    };
  });
}

function measureTrayText(ctx, text, item, horizontalScale = 1) {
  return trayTextRuns(ctx, text, item)
    .reduce((width, run) => width + run.width, 0) * horizontalScale;
}

function drawTrayText(ctx, text, x, y, item, horizontalScale = 1) {
  const spaceScale = trayTextSpaceScale(item);
  if (spaceScale === 1 && horizontalScale === 1) {
    ctx.fillText(text, x, y);
    return;
  }

  const runs = trayTextRuns(ctx, text, item);
  const rawWidth = runs.reduce((width, run) => width + run.width, 0);
  const alignment = ctx.textAlign;
  const startX = alignment === 'right' || alignment === 'end'
    ? -rawWidth
    : alignment === 'center'
      ? -rawWidth / 2
      : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(horizontalScale, 1);
  ctx.textAlign = 'left';
  let cursor = startX;
  for (const run of runs) {
    if (!run.blank) ctx.fillText(run.value, cursor, 0);
    cursor += run.width;
  }
  ctx.restore();
}

function drawCustomTrayProviderBadge(ctx, x, y, size, color) {
  const { trayProviderBadgeLayout } = window.TokenMonitorTrayProviderIcons;
  const layout = trayProviderBadgeLayout(size);
  const badgeX = x + layout.x;
  const badgeY = y + layout.y;
  const { badgeSize, radius, borderWidth } = layout;
  ctx.save();
  roundedRectPath(ctx, badgeX, badgeY, badgeSize, badgeSize, radius);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = borderWidth;
  ctx.strokeStyle = color;
  ctx.stroke();

  // Custom tray images remain macOS template images. Cut the sigma out of the
  // badge alpha so the mark survives the menu-bar tint as negative space.
  const left = badgeX + badgeSize * 0.29;
  const right = badgeX + badgeSize * 0.72;
  const top = badgeY + badgeSize * 0.27;
  const middle = badgeY + badgeSize * 0.5;
  const bottom = badgeY + badgeSize * 0.73;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.moveTo(right, top);
  ctx.lineTo(left, top);
  ctx.lineTo(badgeX + badgeSize * 0.56, middle);
  ctx.lineTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.lineWidth = Math.max(1, badgeSize * 0.13);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000000';
  ctx.stroke();
  ctx.restore();
}

function drawCustomTrayProviderImage(ctx, img, provider, x, y, size, options = {}) {
  const showBadge = options.showProviderBadge === true && provider && provider !== 'app';
  const inset = showBadge ? Math.max(1, Math.round(size * 0.07)) : 0;
  const imageSize = size - inset * 2;
  drawProviderImage(
    ctx,
    img,
    x + inset,
    y + inset,
    imageSize,
    options.providerContrastHalo === true,
    trayGlyphInk(options, img)
  );
  if (showBadge) {
    drawCustomTrayProviderBadge(
      ctx,
      x,
      y,
      size,
      options.templateIconColor || options.textColor || '#000000'
    );
  }
}

function renderCustomTrayItemCanvas(item, height = 44, colors = {}, options = {}) {
  const trackColor = colors.track || 'rgba(0, 0, 0, 0.32)';
  const fillColor = colors.fill || 'rgba(0, 0, 0, 1)';
  const textColor = colors.text || fillColor;
  const h = Math.max(16, Math.round(height));

  if (item.type === 'spacer') {
    const isDot = item.variant === 'dot';
    const ratios = isDot
      ? { narrow: 0.18, regular: 0.24, wide: 0.34 }
      : { narrow: 0.07, regular: 0.14, wide: 0.27 };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(h * (ratios[item.size] || ratios.regular)));
    canvas.height = h;
    if (isDot) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = textColor;
      ctx.beginPath();
      ctx.arc(canvas.width / 2, h / 2, Math.max(1, h * 0.055), 0, Math.PI * 2);
      ctx.fill();
    } else if (options.spacerGuide) {
      const ctx = canvas.getContext('2d');
      ctx.strokeStyle = trackColor;
      ctx.setLineDash([1, 2]);
      ctx.beginPath();
      ctx.moveTo(0.5, h * 0.2);
      ctx.lineTo(0.5, h * 0.8);
      ctx.moveTo(canvas.width - 0.5, h * 0.2);
      ctx.lineTo(canvas.width - 0.5, h * 0.8);
      ctx.stroke();
    }
    return canvas;
  }

  if (item.type === 'icon') {
    const canvas = document.createElement('canvas');
    canvas.width = h;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const provider = item.provider || 'app';
    const providerImage = trayProviderImages[provider];
    if (providerImage) {
      drawCustomTrayProviderImage(
        ctx,
        providerImage,
        provider,
        0,
        0,
        h,
        { ...options, textColor }
      );
    } else {
      drawTrayFallbackMark(ctx, provider, 0, 0, h, textColor);
    }
    return canvas;
  }

  if (item.type === 'bars') {
    const { trayBarFillWidth, trayBarsLayout } = window.TokenMonitorTrayBars;
    const showIcon = item.icon !== 'none';
    const barLayout = trayBarsLayout(h, { contentOnly: !showIcon });
    const canvas = document.createElement('canvas');
    canvas.width = barLayout.width;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const rows = item.rows.length > 1 ? item.rows.slice(0, 2) : item.rows.slice(0, 1);
    const drawBar = (row, y) => {
      roundedRectPath(ctx, barLayout.barsX, y, barLayout.barsWidth, barLayout.barHeight, barLayout.radius);
      ctx.fillStyle = trackColor;
      ctx.fill();
      const fillWidth = trayBarFillWidth(row.percent, barLayout.barsWidth);
      if (!fillWidth) return;
      ctx.save();
      roundedRectPath(ctx, barLayout.barsX, y, barLayout.barsWidth, barLayout.barHeight, barLayout.radius);
      ctx.clip();
      ctx.fillStyle = fillColor;
      ctx.fillRect(barLayout.barsX, y, fillWidth, barLayout.barHeight);
      ctx.restore();
    };
    if (showIcon) {
      const preferredIndex = item.icon === 'second' ? 1 : 0;
      const provider = item.icon === 'app'
        ? 'app'
        : trayLayoutApi.preferredRowProvider(rows, preferredIndex);
      const providerImage = trayProviderImages[provider];
      if (providerImage) {
        drawCustomTrayProviderImage(
          ctx,
          providerImage,
          provider,
          barLayout.padX,
          barLayout.iconY,
          barLayout.iconSize,
          { ...options, textColor }
        );
      } else {
        drawTrayFallbackMark(ctx, provider || '?', barLayout.padX, barLayout.iconY, barLayout.iconSize, textColor);
      }
    }
    const ys = rows.length > 1
      ? [barLayout.barsStartY, barLayout.barsStartY + barLayout.barHeight + barLayout.barGap]
      : [Math.round((h - barLayout.barHeight) / 2)];
    rows.forEach((row, index) => {
      drawBar(row, ys[index]);
    });
    return canvas;
  }

  if (item.type === 'stack') {
    const rows = item.rows.slice(0, 2);
    const showIcon = item.icon !== 'none';
    const preferredIndex = item.icon === 'second' ? 1 : 0;
    const provider = item.icon === 'app'
      ? 'app'
      : trayLayoutApi.preferredRowProvider(rows, preferredIndex);
    const iconSize = h;
    const iconGap = Math.max(2, Math.round(h * 0.08));
    const fontSize = Math.max(8, Math.round(h * 0.43));
    const font = trayTextCanvasFont(item, fontSize, 600);
    const horizontalScale = trayTextHorizontalScale(item);
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = font;
    const textWidth = Math.max(
      ...rows.map((row) => measureTrayText(measure, row.text || '--', item, horizontalScale)),
      1
    );
    const padX = Math.max(1, Math.round(h * 0.04));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(textWidth) + padX * 2 + (showIcon ? iconSize + iconGap : 0);
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const alignment = item.alignment === 'left' ? 'left' : 'right';
    let textX = alignment === 'right' ? canvas.width - padX : padX;
    if (showIcon) {
      const providerImage = trayProviderImages[provider];
      if (providerImage) {
        drawCustomTrayProviderImage(
          ctx,
          providerImage,
          provider,
          0,
          0,
          iconSize,
          { ...options, textColor }
        );
      } else {
        drawTrayFallbackMark(ctx, provider || '?', 0, 0, iconSize, textColor);
      }
      if (alignment === 'left') textX += iconSize + iconGap;
    }
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = alignment;
    const textBaselineOffset = Math.max(1, Math.round(h * 0.025));
    rows.forEach((row, index) => {
      ctx.fillStyle = row.available === false ? trackColor : textColor;
      drawTrayText(
        ctx,
        row.text || '--',
        textX,
        h * (index === 0 ? 0.28 : 0.72) + textBaselineOffset,
        item,
        horizontalScale
      );
    });
    return canvas;
  }

  const text = item.text || '--';
  const fontSize = Math.round(h * 0.68);
  const font = trayTextCanvasFont(item, fontSize, 500);
  const horizontalScale = trayTextHorizontalScale(item);
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const padX = Math.max(1, Math.round(h * 0.04));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(measureTrayText(measure, text, item, horizontalScale)) + padX * 2);
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = item.available === false ? trackColor : textColor;
  drawTrayText(ctx, text, padX, h / 2 + 1, item, horizontalScale);
  return canvas;
}

function renderCustomTrayLayout(stats, layout, height = 44, colors = {}, options = {}) {
  const activeCodex = localLiveCodexProvider();
  const activeCodexKey = activeCodex?.accountKey
    && (stats?.limits?.providers || []).some((provider) => (
      provider?.provider === 'codex' && provider?.accountKey === activeCodex.accountKey
    ))
    ? activeCodex.accountKey
    : '';
  const resolved = trayLayoutApi.resolveTrayLayout(layout, stats, {
    currency: currentCurrency(),
    ...compactTokenDisplayOptions(),
    nowMs: Date.now(),
    activeAccountKeys: activeCodexKey ? { codex: activeCodexKey } : {},
    availableProviderIds: Object.keys(trayProviderImages)
  });
  const items = resolved.items.map((item) => (
    item.type === 'text'
      && item.metric === 'account'
      && limitAccountEmailsMasked()
      ? { ...item, text: accountIdentityApi.maskEmailAddress(item.text) }
      : item
  ));
  const segments = items.map((item) => renderCustomTrayItemCanvas(item, height, colors, options));
  if (!segments.length) return null;
  const gap = Math.max(1, Math.round(height * 0.03));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, segments.reduce((width, segment) => width + segment.width, 0) + gap * Math.max(0, segments.length - 1));
  canvas.height = Math.max(16, Math.round(height));
  const ctx = canvas.getContext('2d');
  let x = 0;
  for (const segment of segments) {
    ctx.drawImage(segment, x, 0);
    x += segment.width + gap;
  }
  return canvas.toDataURL('image/png');
}

function barsDataUrlForMode(mode, size = 44, colors, options = {}) {
  const stats = options.stats || state.stats;
  if (mode === 'barsAllSessions') return renderAllSessionsIcon(stats, size, configuredLimitProviderOrder(), colors, options);
  const pickers = { barsSession: pickWorstSessionProvider, barsWeekly: pickWorstWeeklyProvider };
  return renderBarsIcon(stats, size, pickers[mode] || pickWorstProvider, colors, options);
}

function trayDataUrlForMode(mode, size = 44, colors, options = {}) {
  if (mode === 'custom') {
    return renderCustomTrayLayout(
      options.stats || state.stats || statsForTrayComposer(),
      options.layout || state.settings?.trayCustomLayout,
      size,
      colors,
      {
        showProviderBadge: state.settings?.showTrayProviderBadge === true,
        ...options
      }
    );
  }
  if (mode === 'limitsAllSessions') {
    return renderLimitSessionsIcon(options.stats || state.stats, size, configuredLimitProviderOrder(), colors, options);
  }
  return barsDataUrlForMode(mode, size, colors, options);
}

async function maybeUpdateBarsIcon(options = {}) {
  if (options.refreshComposers !== false) refreshTrayComposers();
  const mode = state.settings?.trayContent;
  if (!window.TokenMonitorTrayText.isGeneratedTrayIconMode(mode)) return;
  if (!window.tokenMonitor.setTrayIcons) return;
  // Ink follows the surface the shell will draw this on, not the app's own theme
  // (see trayGeneratedIconColors) — on a dark taskbar the historical black made
  // the icon invisible.
  const colors = window.TokenMonitorTrayText.trayGeneratedIconColors(state.appInfo?.platform, state.systemDarkUi);
  const dataUrl = trayDataUrlForMode(mode, 44, colors, { trayInk: true });
  try { await window.tokenMonitor.setTrayIcons({ [mode]: dataUrl || null }); } catch (_) {}
}

function trayComposerProviderIcon(provider) {
  const id = provider === 'auto' ? 'app' : provider;
  const cached = trayProviderImages[id];
  if (cached) {
    try {
      return providerImageToPngDataUrl(cached, 44, false, {
        templateColor: floatingBubbleGeneratedColors().text
      });
    } catch (_) {}
  }
  if (id === 'app') return '../../../assets/icons/tray-token-monitor.png';
  return window.TokenMonitorTrayProviderIcons.trayProviderIconSources([id])[id] || '';
}

function trayComposerProviderChoices(currentProviders = [], options = {}) {
  const current = new Set(
    (Array.isArray(currentProviders) ? currentProviders : [currentProviders])
      .map((provider) => String(provider || '').trim().toLowerCase())
      .filter((provider) => provider && provider !== 'auto')
  );
  const available = new Set(
    trayLayoutApi.providerOptions(state.stats || {}).map((entry) => entry.value)
  );
  const includeAll = options.includeAll === true;
  const catalogue = includeAll ? TRAY_ICON_PROVIDERS : LIMIT_PROVIDERS;
  return [
    {
      value: 'auto',
      label: t('trayComposer.provider.auto'),
      detail: t('trayComposer.provider.autoDetail'),
      icon: trayComposerProviderIcon('auto')
    },
    ...catalogue
      .filter((provider) => includeAll || available.has(provider.id) || current.has(provider.id))
      .map((provider) => ({
        value: provider.id,
        label: provider.label,
        detail: includeAll || available.has(provider.id) ? '' : t('trayComposer.provider.unavailable'),
        icon: trayComposerProviderIcon(provider.id)
      }))
  ];
}

function trayComposerAccountChoices(provider) {
  const stats = state.stats || {};
  const raw = provider === 'auto'
    ? LIMIT_PROVIDERS.flatMap((entry) => trayLayoutApi.accountOptions(stats, entry.id))
    : trayLayoutApi.accountOptions(stats, provider);
  return raw.map((entry) => ({
    value: entry.value,
    label: entry.label,
    detail: LIMIT_PROVIDERS.find((providerEntry) => providerEntry.id === entry.provider?.provider)?.label || entry.provider?.provider || '',
    icon: trayComposerProviderIcon(entry.provider?.provider)
  }));
}

function trayComposerSourcePreview(source) {
  const item = trayLayoutApi.createTrayLayoutItem('singleBar');
  item.rows = [{ ...item.rows[0], ...source }];
  return renderCustomTrayLayout(
    statsForTrayComposer(),
    { version: trayLayoutApi.VERSION, items: [item] },
    32,
    floatingBubbleGeneratedColors(),
    { templateIconColor: floatingBubbleGeneratedColors().text }
  );
}

function trayComposerWindowChoices(source) {
  const choices = trayLayoutApi.sourceWindowOptions(
    state.stats || {},
    source
  ).map((entry) => ({
    value: entry.value,
    label: trayComposerWindowLabel(entry),
    preview: trayComposerSourcePreview({ ...source, window: entry.value })
  }));
  if (choices.length) return choices;
  return [{
    value: 'primary',
    label: t('trayComposer.window.primary'),
    preview: trayComposerSourcePreview({ ...source, window: 'primary' })
  }];
}

function trayComposerWindowLabel(entry) {
  const kind = String(entry.kind || 'other').toLowerCase();
  const kindKey = `trayComposer.window.${kind}`;
  const translatedKind = t(kindKey);
  const kindLabel = translatedKind === kindKey ? t('trayComposer.window.primary') : translatedKind;
  const rawLabel = String(entry.label || '').trim();
  const normalizedLabel = rawLabel.toLowerCase();
  const redundantLabels = new Set([kind, 'session', 'weekly', 'billing', 'total']);
  if (!rawLabel || redundantLabels.has(normalizedLabel)) return kindLabel;
  return `${kindLabel} · ${rawLabel}`;
}

function previewItemForStyle(style) {
  return trayLayoutApi.createTrayLayoutItem(style);
}

function renderTrayComposerItem(item, options = {}) {
  return renderCustomTrayLayout(
    statsForTrayComposer(),
    { version: trayLayoutApi.VERSION, items: [item] },
    36,
    floatingBubbleGeneratedColors(),
    { templateIconColor: floatingBubbleGeneratedColors().text, ...options }
  );
}

function renderTrayComposerFontPreview(item, fontStyle, options = {}) {
  return renderTrayComposerItem({ ...item, fontStyle }, options);
}

function trayPreviewUsageIconId(stats, mode) {
  if (mode === 'icon') return 'app';
  const period = ['tokensAll', 'costAll', 'bothAll'].includes(mode) ? 'allTime' : 'today';
  const metric = ['cost', 'costAll'].includes(mode) ? 'cost' : 'tokens';
  return window.TokenMonitorTrayText.pickUsageProviderId(
    stats,
    metric,
    period,
    Object.keys(trayProviderImages)
  ) || 'app';
}

function joinTrayPreviewCanvases(segments, height = 44, gap = Math.max(1, Math.round(height * 0.03))) {
  const visible = segments.filter(Boolean);
  if (!visible.length) return '';
  const canvas = document.createElement('canvas');
  canvas.width = visible.reduce((width, segment) => width + segment.width, 0) + gap * Math.max(0, visible.length - 1);
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  let x = 0;
  for (const segment of visible) {
    ctx.drawImage(segment, x, 0);
    x += segment.width + gap;
  }
  return canvas.toDataURL('image/png');
}

function renderStandardUsageTrayPreview(mode, stats) {
  const height = 44;
  const colors = floatingBubbleGeneratedColors();
  const showProviderBadge = state.settings?.showTrayProviderBadge === true;
  const icon = renderCustomTrayItemCanvas(
    { type: 'icon', provider: trayPreviewUsageIconId(stats, mode) },
    height,
    colors,
    {
      showProviderBadge,
      templateIconColor: showProviderBadge ? '' : colors.text
    }
  );
  // Windows and Linux only get the icon; their text lives in the tooltip, so
  // previewing a title there would advertise something the tray never draws.
  if (mode === 'icon' || !window.TokenMonitorTrayText.trayShowsTitle(state.appInfo?.platform)) {
    return joinTrayPreviewCanvases([icon], height);
  }

  const text = window.TokenMonitorTrayText.formatTrayText(
    stats,
    mode,
    currentCurrency(),
    compactTokenDisplayOptions()
  );
  const title = text
    ? renderCustomTrayItemCanvas({ type: 'text', text, fontStyle: 'normal' }, height, colors)
    : null;
  return joinTrayPreviewCanvases([icon, title], height);
}

function renderStandardTrayPreview(mode, stats) {
  if (window.TokenMonitorTrayText.isGeneratedTrayIconMode(mode)) {
    const colors = floatingBubbleGeneratedColors();
    return {
      // Match the same high-resolution source that main resizes to the tray's 20 px height.
      generatedSrc: trayDataUrlForMode(mode, 44, colors, {
        stats,
        templateIconColor: colors.text
      })
    };
  }
  return { src: renderStandardUsageTrayPreview(mode, stats) };
}

function trayComposerPreview(surface) {
  const isTray = surface === 'tray';
  const contentKey = isTray ? 'trayContent' : 'floatingBubbleContent';
  const layoutKey = isTray ? 'trayCustomLayout' : 'floatingBubbleCustomLayout';
  const mode = state.settings?.[contentKey] || (isTray ? 'tokens' : 'icon');
  const stats = statsForTrayComposer();
  if (isTray) return renderStandardTrayPreview(mode, stats);
  if (window.TokenMonitorTrayText.isGeneratedTrayIconMode(mode)) {
    // Mirror renderFloatingBubbleContent exactly: the bubble draws provider
    // icons in colour, so no templateIconColor here — that is a menu-bar-only
    // requirement and would preview the bubble as monochrome.
    return {
      src: trayDataUrlForMode(mode, 44, floatingBubbleGeneratedColors(), {
        stats,
        layout: state.settings?.[layoutKey],
        contentOnly: mode === 'barsAllSessions' || mode === 'limitsAllSessions',
        providerContrastHalo: true,
        showProviderBadge: false
      })
    };
  }
  if (mode === 'icon') return { text: 'Σ' };
  return {
    text: window.TokenMonitorTrayText.formatTrayText(
      stats,
      mode,
      currentCurrency(),
      compactTokenDisplayOptions()
    ) || '—'
  };
}

function activateTrayComposer(surface) {
  const isTray = surface === 'tray';
  const contentKey = isTray ? 'trayContent' : 'floatingBubbleContent';
  const input = isTray ? els.trayContentInput : els.floatingBubbleContentInput;
  state.settings[contentKey] = 'custom';
  if (input) input.value = 'custom';
  if (isTray) void maybeUpdateBarsIcon();
  else renderFloatingBubbleContent();
  refreshTrayComposers();
  void saveSettings({ [contentKey]: 'custom' });
}

function createTrayComposer(surface) {
  const isTray = surface === 'tray';
  const root = isTray ? els.trayComposer : els.floatingBubbleComposer;
  const layoutKey = isTray ? 'trayCustomLayout' : 'floatingBubbleCustomLayout';
  const contentKey = isTray ? 'trayContent' : 'floatingBubbleContent';
  return window.TokenMonitorTrayComposer.createTrayComposer({
    root,
    surface,
    layoutApi: trayLayoutApi,
    getLayout: () => state.settings?.[layoutKey],
    getStylePreview: (style) => renderTrayComposerItem(
      previewItemForStyle(style),
      {
        showProviderBadge: isTray && state.settings?.showTrayProviderBadge === true,
        spacerGuide: style === 'spacer'
      }
    ),
    getFontStylePreview: (item, fontStyle) => renderTrayComposerFontPreview(item, fontStyle, {
      showProviderBadge: isTray && state.settings?.showTrayProviderBadge === true
    }),
    renderItem: (item) => renderTrayComposerItem(item, {
      showProviderBadge: isTray && state.settings?.showTrayProviderBadge === true
    }),
    getPreview: () => trayComposerPreview(surface),
    isEditable: () => state.settings?.[contentKey] === 'custom',
    onCustomize: () => activateTrayComposer(surface),
    providerChoices: trayComposerProviderChoices,
    accountChoices: trayComposerAccountChoices,
    windowChoices: trayComposerWindowChoices,
    label: t,
    onLayoutChange: (nextLayout, { commit }) => {
      state.settings[layoutKey] = trayLayoutApi.normalizeTrayLayout(nextLayout);
      if (isTray) void maybeUpdateBarsIcon({ refreshComposers: commit });
      else {
        renderFloatingBubbleContent();
        if (commit) refreshTrayComposers();
      }
      if (commit) void saveSettings({ [layoutKey]: state.settings[layoutKey] });
    }
  });
}

function refreshTrayComposers() {
  const surfaces = [
    { id: 'tray', root: els.trayComposer, visible: state.settings?.showTrayIcon !== false },
    { id: 'floatingBubble', root: els.floatingBubbleComposer, visible: state.settings?.floatingBubbleEnabled === true }
  ];
  window.TokenMonitorTrayComposer.syncTrayComposerSurfaces(
    surfaces,
    trayComposers,
    createTrayComposer
  );
  Object.values(trayComposers).forEach((composer) => composer?.refresh());
  const clockNeeded = (
    state.settings?.trayContent === 'custom'
      && trayLayoutApi.trayLayoutNeedsClock(state.settings?.trayCustomLayout)
  ) || (
    state.settings?.floatingBubbleContent === 'custom'
      && trayLayoutApi.trayLayoutNeedsClock(state.settings?.floatingBubbleCustomLayout)
  );
  if (clockNeeded && !customTrayClockTimer) {
    customTrayClockTimer = setInterval(() => {
      void maybeUpdateBarsIcon({ refreshComposers: false });
      renderFloatingBubbleContent();
    }, 30 * 1000);
  } else if (!clockNeeded && customTrayClockTimer) {
    clearInterval(customTrayClockTimer);
    customTrayClockTimer = null;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`load failed: ${src}`));
    img.src = src;
  });
}

function providerImageToPngDataUrl(img, size, showBadge = false, options = {}) {
  const { trayProviderBadgeLayout } = window.TokenMonitorTrayProviderIcons;
  const layout = trayProviderBadgeLayout(size);
  const canvas = document.createElement('canvas');
  canvas.width = layout.iconSize;
  canvas.height = layout.iconSize;
  const ctx = canvas.getContext('2d');
  const imageInset = showBadge ? Math.max(1, Math.round(layout.iconSize * 0.07)) : 0;
  const imageSize = layout.iconSize - imageInset * 2;
  if (showBadge) {
    ctx.save();
    ctx.shadowColor = 'rgba(255, 255, 255, 0.95)';
    ctx.shadowBlur = Math.max(2, Math.round(layout.iconSize * 0.1));
    paintProviderImage(ctx, img, imageInset, imageInset, imageSize);
    ctx.restore();
  }
  drawProviderImage(
    ctx,
    img,
    imageInset,
    imageInset,
    imageSize,
    false,
    trayGlyphInk({ templateIconColor: options.templateColor, trayInk: options.trayInk }, img)
  );

  if (!showBadge) return canvas.toDataURL('image/png');

  const { x, y, badgeSize, radius, borderWidth } = layout;
  roundedRectPath(ctx, x, y, badgeSize, badgeSize, radius);
  ctx.fillStyle = '#1688f8';
  ctx.fill();
  ctx.lineWidth = borderWidth;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // Draw the project's sigma mark as geometry so it remains crisp without a font dependency.
  const left = x + badgeSize * 0.29;
  const right = x + badgeSize * 0.72;
  const top = y + badgeSize * 0.27;
  const middle = y + badgeSize * 0.5;
  const bottom = y + badgeSize * 0.73;
  ctx.beginPath();
  ctx.moveTo(right, top);
  ctx.lineTo(left, top);
  ctx.lineTo(x + badgeSize * 0.56, middle);
  ctx.lineTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.lineWidth = Math.max(2, badgeSize * 0.13);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  return canvas.toDataURL('image/png');
}

async function deliverTrayProviderIcons(showBadge = state.settings?.showTrayProviderBadge === true) {
  if (!window.tokenMonitor.setTrayIcons) return;
  const deliveryId = trayProviderIconDeliveryGuard.begin();
  const sources = window.TokenMonitorTrayProviderIcons.trayProviderIconSources(trayIconProviderIds);
  sources.app = '../../../assets/icons/tray-token-monitor.png';
  const icons = {};
  for (const [id, path] of Object.entries(sources)) {
    try {
      const img = await loadImage(path);
      trayProviderImages[id] = img;
      trayProviderImageIds.set(img, id);
      icons[id] = providerImageToPngDataUrl(img, 44, showBadge, { trayInk: true });
    } catch (_) { /* skip missing */ }
  }
  if (!trayProviderIconDeliveryGuard.isCurrent(deliveryId)) return;
  if (Object.keys(icons).length) await window.tokenMonitor.setTrayIcons(icons);
  if (!trayProviderIconDeliveryGuard.isCurrent(deliveryId)) return;
  // Provider images may unlock a richer bars icon now that they're cached.
  maybeUpdateBarsIcon();
}

function setAccountGroupExpanded(prefix, expanded, stateKey) {
  const toggle = document.getElementById(`${prefix}SettingsToggle`);
  const details = document.getElementById(`${prefix}SettingsDetails`);
  const group = document.getElementById(`${prefix}AccountGroup`) || document.getElementById(`${prefix}CookieGroup`);
  if (!toggle || !details) return;
  const next = Boolean(expanded);
  if (stateKey) state[stateKey] = next;
  toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
  details.classList.toggle('hidden', !next);
  if (group) group.classList.toggle('expanded', next);
  syncLimitProviderAccountExpansion(prefix, next);
}

function syncLimitProviderAccountExpansion(providerId, expanded) {
  if (!LIMIT_PROVIDER_ACCOUNT_GROUP_IDS[providerId]) return;
  if (expanded) {
    setLimitProviderSettingsExpanded(providerId);
  } else if (state.limitProviderSettingsExpanded === providerId) {
    setLimitProviderSettingsExpanded('');
  }
}

function setCodexAccountExpanded(expanded) {
  setAccountGroupExpanded('codex', expanded, 'codexAccountExpanded');
}

function setCursorAccountExpanded(expanded) {
  setAccountGroupExpanded('cursor', expanded, 'cursorAccountExpanded');
}

function setOpencodeCookieExpanded(expanded) {
  setAccountGroupExpanded('opencode', expanded, 'opencodeCookieExpanded');
}

function setOpenrouterAccountExpanded(expanded) {
  setAccountGroupExpanded('openrouter', expanded, 'openrouterAccountExpanded');
}

function setThirdPartyAccountExpanded(expanded) {
  setAccountGroupExpanded('thirdparty', expanded, 'thirdPartyAccountExpanded');
}

function selectedThirdPartyAdapter() {
  const platform = String(document.getElementById('thirdpartyPlatformInput')?.value || 'newapi');
  const mode = String(document.getElementById('thirdpartyModeInput')?.value || 'account');
  if (platform === 'custom') return 'custom';
  return mode === 'token' ? 'newapi-token' : 'newapi-account';
}

function updateThirdPartyHttpWarning() {
  const input = document.getElementById('thirdpartyBaseUrlInput');
  const warning = document.getElementById('thirdpartyHttpWarning');
  if (!warning) return;
  let insecure;
  try {
    insecure = new URL(String(input?.value || '').trim()).protocol === 'http:';
  } catch {
    warning.classList.add('hidden');
    return;
  }
  warning.classList.toggle('hidden', !insecure);
}

function setThirdPartyAdapterFields() {
  const adapter = selectedThirdPartyAdapter();
  const customMode = adapter === 'custom';
  const accountMode = adapter === 'newapi-account';
  const newApiAccountMode = adapter === 'newapi-account';
  document.getElementById('thirdpartyChoiceGrid')?.classList.toggle('single-field', customMode);
  document.getElementById('thirdpartyModeField')?.classList.toggle('hidden', customMode);
  document.getElementById('thirdpartyCredentialGrid')?.classList.toggle(
    'single-field',
    !newApiAccountMode
  );
  document.getElementById('thirdpartyAccessTokenRow')?.classList.toggle('hidden', !accountMode);
  document.getElementById('thirdpartyUserIdRow')?.classList.toggle('hidden', !newApiAccountMode);
  document.getElementById('thirdpartyApiKeyRow')?.classList.toggle('hidden', accountMode);
  document.getElementById('thirdpartyCustomConfig')?.classList.toggle('hidden', !customMode);
  const hint = document.getElementById('thirdpartyModeHint');
  if (hint) {
    const hintKey = customMode
      ? 'settings.thirdparty.hintCustom'
      : adapter === 'newapi-token'
      ? 'settings.thirdparty.hintNewApiToken'
      : 'settings.thirdparty.hintNewApiAccount';
    hint.textContent = t(hintKey);
  }
}

function setDeepseekAccountExpanded(expanded) {
  setAccountGroupExpanded('deepseek', expanded, 'deepseekAccountExpanded');
}

function setMimoAccountExpanded(expanded) {
  setAccountGroupExpanded('mimo', expanded, 'mimoAccountExpanded');
}

function setCopilotAccountExpanded(expanded) {
  setAccountGroupExpanded('copilot', expanded, 'copilotAccountExpanded');
}

function setCopilotManualExpanded(expanded) {
  const next = Boolean(expanded);
  state.copilotManualExpanded = next;
  document.getElementById('copilotManualToggle')?.setAttribute('aria-expanded', next ? 'true' : 'false');
  document.getElementById('copilotManualDetails')?.classList.toggle('hidden', !next);
  document.getElementById('copilotManualPanel')?.classList.toggle('expanded', next);
}

function setCursorStatusText(el, text) {
  el.textContent = text;
  el.title = text;
}

function renderCodexLoginStatus() {
  const addButton = document.getElementById('codexAddAccountButton');
  const cancelButton = document.getElementById('codexCancelLoginButton');
  const refreshButton = document.getElementById('codexRefreshAccountsButton');
  const openButton = document.getElementById('codexOpenLoginUrlButton');
  const copyButton = document.getElementById('codexCopyLoginUrlButton');
  const statusEl = document.getElementById('codexLoginStatus');
  const workspaceSelection = document.getElementById('codexWorkspaceSelection');
  const workspaceSelect = document.getElementById('codexWorkspaceSelect');
  const urlActions = document.getElementById('codexLoginUrlActions');
  const details = document.getElementById('codexLoginDetails');
  const output = document.getElementById('codexLoginOutput');
  if (!addButton || !cancelButton || !refreshButton || !openButton || !copyButton || !statusEl || !workspaceSelection || !workspaceSelect || !urlActions || !details || !output) return;

  addButton.classList.toggle('hidden', state.codexSignInBusy);
  cancelButton.classList.toggle('hidden', !state.codexSignInBusy);
  refreshButton.classList.toggle('hidden', state.codexSignInBusy);
  statusEl.textContent = state.codexLoginStatus;
  statusEl.classList.toggle('hidden', !state.codexLoginStatus);
  workspaceSelection.classList.toggle('hidden', state.codexWorkspaceChoices.length === 0);
  workspaceSelect.replaceChildren(...state.codexWorkspaceChoices.map((workspace) => {
    const option = document.createElement('option');
    option.value = workspace.id;
    option.textContent = workspace.workspaceKind === 'personal'
      ? t('settings.codex.personalWorkspace')
      : workspace.label || workspace.id;
    option.selected = workspace.id === state.codexWorkspaceId;
    return option;
  }));
  urlActions.classList.toggle('hidden', !state.codexSignInBusy);
  openButton.classList.toggle('hidden', !state.codexLoginUrl);
  copyButton.classList.toggle('hidden', !state.codexLoginUrl);
  output.textContent = state.codexLoginOutput;
  details.classList.toggle('hidden', !state.codexLoginOutput);
}

function renderCodexAccounts() {
  const statusEl = document.getElementById('codexAccountStatus');
  const listEl = document.getElementById('codexAccountList');
  const errorEl = document.getElementById('codexAccountErrorMessage');
  if (!statusEl || !listEl || !errorEl) return;

  const accounts = state.settings?.codexManagedAccounts || [];
  const enabledCount = accounts.filter(account => account.enabled !== false).length;
  const statusText = accounts.length === 0
    ? t('settings.codex.notConfigured')
    : t('settings.opencode.connected', { linked: enabledCount, total: accounts.length });
  setCursorStatusText(statusEl, statusText);
  errorEl.textContent = state.codexAccountError || '';
  errorEl.classList.toggle('hidden', !state.codexAccountError);
  listEl.replaceChildren();
  if (accounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-note';
    empty.textContent = t('settings.codex.empty');
    listEl.append(empty);
  } else {
    const codexProviders = localProviderStatuses('codex');
    for (const account of accounts) {
      const enabled = account.enabled !== false;
      const row = document.createElement('div');
      row.className = 'managed-account-row';
      row.classList.toggle('disabled', !enabled);
      const input = document.createElement('input');
      input.className = 'managed-account-checkbox';
      input.type = 'checkbox';
      input.checked = account.enabled !== false;
      input.setAttribute('aria-label', t('settings.codex.toggleAccount', {
        account: account.email || t('settings.codex.unnamedAccount')
      }));
      const main = document.createElement('div');
      main.className = 'managed-account-main';
      const email = document.createElement('div');
      email.className = 'managed-account-email';
      email.textContent = account.email || t('settings.codex.unnamedAccount');
      main.append(email);
      input.addEventListener('change', async () => {
        input.disabled = true;
        const result = await window.tokenMonitor.codex.setAccountEnabled(account.id, input.checked);
        if (!result?.ok) {
          state.codexAccountError = result?.error || t('settings.codex.toggleFailed');
        } else {
          state.codexAccountError = '';
          state.settings.codexManagedAccounts = result.accounts || [];
        }
        renderCodexAccounts();
        renderSettingsSummaries();
      });
      const right = document.createElement('span');
      right.className = 'managed-account-right';
      const info = document.createElement('span');
      info.className = 'managed-account-info';
      const workspaceLabel = account.workspaceKind === 'personal'
        ? t('settings.codex.personalWorkspace')
        : account.workspaceLabel;
      const accountMetadata = [
        workspaceLabel,
        enabled
          ? limitProviderPresentationApi.limitProviderDisplayLabel(
            accountIdentityApi.codexManagedAccountPlanLabel(account, codexProviders)
          )
          : t('settings.codex.disabled')
      ].filter((value, index, values) => value && values.indexOf(value) === index);
      info.textContent = accountMetadata.join(' · ');
      info.title = accountMetadata.join(' · ');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'managed-account-remove';
      remove.textContent = '✕';
      remove.title = t('settings.codex.remove');
      let confirmingRemove = false;
      remove.addEventListener('click', async () => {
        if (!confirmingRemove) {
          confirmingRemove = true;
          remove.classList.add('confirming');
          remove.textContent = '✓';
          remove.title = t('settings.codex.removeConfirm', {
            account: account.email || t('settings.codex.unnamedAccount')
          });
          return;
        }
        const result = await window.tokenMonitor.codex.removeAccount(account.id);
        if (!result?.ok) {
          state.codexAccountError = result?.error || t('settings.codex.removeFailed');
        } else {
          state.codexAccountError = '';
          state.settings.codexManagedAccounts = result.accounts || [];
          renderCodexAccounts();
          renderSettingsSummaries();
          refreshStats({ force: true }).catch(() => {});
          return;
        }
        renderCodexAccounts();
        renderSettingsSummaries();
      });
      right.append(info, remove);
      row.append(input, main, right);
      listEl.append(row);
    }
  }
  renderSettingsSummaries();
}

async function refreshCodexAccounts() {
  try {
    state.settings.codexManagedAccounts = await window.tokenMonitor.codex.accounts();
    state.codexAccountError = '';
  } catch (err) {
    state.codexAccountError = err.message;
  }
  renderCodexAccounts();
}

// Account cards reflect THIS machine's configured credential, so read the
// local device's RAW limits from state.stats.devices — NOT the collapsed
// state.stats.limits.providers. In sync mode, aggregateLimits() collapses a
// local `unauthorized` row out in favor of a remote `ok` (providerCollapseKey
// for deepseek/minimax/grok is just the provider name; pickBetterProvider keeps
// the higher statusRank). Searching the aggregate would miss the local row and
// fall back to the remote `ok`, falsely reporting an invalid local key as
// Linked. Only legacy/non-aggregated stats without a `devices` array may fall
// back to the aggregate; once raw device rows are present they are authoritative.
function localDeviceLimitsProviders() {
  return accountIdentityApi.localDeviceLimitsProviders(
    state.stats,
    state.settings?.deviceId || ''
  );
}

function localProviderStatus(name) {
  const localProviders = localDeviceLimitsProviders();
  if (localProviders !== null) {
    return localProviders.find((provider) => provider.provider === name) || null;
  }
  return (state.stats?.limits?.providers || []).find((provider) => provider.provider === name) || null;
}

function localProviderStatuses(name) {
  const localProviders = localDeviceLimitsProviders();
  const providers = localProviders !== null
    ? localProviders
    : (state.stats?.limits?.providers || []);
  return providers.filter((provider) => provider.provider === name);
}

function deepseekAccountLinked() {
  const provider = deepseekProviderForAccount();
  return Boolean(state.settings?.deepseekApiKeyConfigured) && provider?.status === 'ok';
}

function deepseekProviderStatus() {
  return localProviderStatus('deepseek');
}

function deepseekProviderForAccount() {
  const provider = deepseekProviderStatus();
  const pendingSince = Number(state.deepseekPendingCheckSince || 0);
  if (!provider || !pendingSince) return provider;
  const updatedAt = Date.parse(provider.updatedAt || '');
  if (!Number.isFinite(updatedAt) || updatedAt < pendingSince) return null;
  state.deepseekPendingCheckSince = 0;
  return provider;
}

function markDeepseekKeyCheckPending() {
  state.deepseekPendingCheckSince = Date.now();
  clearDeepseekProviderStatus();
}

function clearDeepseekPendingCheck() {
  state.deepseekPendingCheckSince = 0;
}

function clearDeepseekProviderStatus() {
  if (!Array.isArray(state.stats?.limits?.providers)) return;
  state.stats.limits.providers = state.stats.limits.providers.filter((provider) => provider.provider !== 'deepseek');
}

function renderMimoStatus() {
  const statusEl = document.getElementById('mimoAccountStatus');
  const listEl = document.getElementById('mimoAccountList');
  const emptyEl = document.getElementById('mimoAccountEmpty');
  const errorEl = document.getElementById('mimoAccountErrorMessage');
  if (!statusEl || !listEl || !emptyEl || !errorEl) return;
  const accounts = state.settings?.mimoManagedAccounts || [];
  const enabledCount = accounts.filter((account) => account.enabled !== false).length;
  const statusText = accounts.length === 0
    ? t('settings.mimo.notConfigured')
    : t('settings.mimo.connected', { linked: enabledCount, total: accounts.length });
  setCursorStatusText(statusEl, statusText);
  errorEl.textContent = state.mimoAccountError || '';
  errorEl.classList.toggle('hidden', !state.mimoAccountError);
  emptyEl.classList.toggle('hidden', accounts.length > 0);

  listEl.replaceChildren();
  if (accounts.length > 0) {
    for (const [index, account] of accounts.entries()) {
      const enabled = account.enabled !== false;
      const accountName = mimoSettingsAccountTitle(account, index);
      const row = document.createElement('div');
      row.className = 'managed-account-row';
      row.classList.toggle('disabled', !enabled);

      const input = document.createElement('input');
      input.className = 'managed-account-checkbox';
      input.type = 'checkbox';
      input.checked = enabled;
      input.setAttribute('aria-label', t('settings.mimo.toggleAccount', {
        account: accountName
      }));
      input.addEventListener('change', async () => {
        input.disabled = true;
        const result = await window.tokenMonitor.mimo.setAccountEnabled(account.id, input.checked);
        if (!result?.ok) {
          state.mimoAccountError = result?.error || t('settings.mimo.toggleFailed');
        } else {
          state.mimoAccountError = '';
          state.settings.mimoManagedAccounts = result.accounts || [];
        }
        renderMimoStatus();
        renderSettingsSummaries();
      });

      const main = document.createElement('div');
      main.className = 'managed-account-main';
      const label = document.createElement('div');
      label.className = 'managed-account-email';
      label.textContent = accountName;
      main.append(label);

      const right = document.createElement('span');
      right.className = 'managed-account-right';
      const info = document.createElement('span');
      info.className = 'managed-account-info';
      info.textContent = enabled ? limitProviderPresentationApi.limitProviderDisplayLabel(account.accountLabel) : t('settings.mimo.disabled');

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'managed-account-remove';
      remove.textContent = '✕';
      remove.title = t('settings.mimo.remove');
      let confirmingRemove = false;
      remove.addEventListener('click', async () => {
        if (!confirmingRemove) {
          confirmingRemove = true;
          remove.classList.add('confirming');
          remove.textContent = '✓';
          remove.title = t('settings.mimo.removeConfirm', {
            account: accountName
          });
          return;
        }
        const result = await window.tokenMonitor.mimo.removeAccount(account.id);
        if (result?.ok) {
          state.mimoAccountError = '';
          state.settings.mimoManagedAccounts = result.accounts || [];
          renderMimoStatus();
          renderSettingsSummaries();
          refreshStats({ force: true }).catch(() => {});
          return;
        }
        state.mimoAccountError = result?.error || t('settings.mimo.removeFailed');
        renderMimoStatus();
        renderSettingsSummaries();
      });

      right.append(info, remove);
      row.append(input, main, right);
      listEl.append(row);
    }
  }
  renderSettingsSummaries();
}

function minimaxProviderStatus() {
  return localProviderStatus('minimax');
}

function minimaxAccountLinked() {
  const provider = minimaxProviderForAccount();
  return Boolean(state.settings?.minimaxApiKeyConfigured) && provider?.status === 'ok';
}

function minimaxProviderForAccount() {
  const provider = minimaxProviderStatus();
  const pendingSince = Number(state.minimaxPendingCheckSince || 0);
  if (!provider || !pendingSince) return provider;
  const updatedAt = Date.parse(provider.updatedAt || '');
  if (!Number.isFinite(updatedAt) || updatedAt < pendingSince) return null;
  state.minimaxPendingCheckSince = 0;
  return provider;
}

function markMinimaxKeyCheckPending() {
  state.minimaxPendingCheckSince = Date.now();
  clearMinimaxProviderStatus();
}

function clearMinimaxPendingCheck() {
  state.minimaxPendingCheckSince = 0;
}

function clearMinimaxProviderStatus() {
  if (!Array.isArray(state.stats?.limits?.providers)) return;
  state.stats.limits.providers = state.stats.limits.providers.filter((provider) => provider.provider !== 'minimax');
}

function copilotProviderStatus() {
  return localProviderStatus('copilot');
}

function copilotAccountLinked() {
  const provider = copilotProviderForAccount();
  return Boolean(state.settings?.copilotApiTokenConfigured) && provider?.status === 'ok';
}

function copilotProviderForAccount() {
  const provider = copilotProviderStatus();
  const pendingSince = Number(state.copilotPendingCheckSince || 0);
  if (!provider || !pendingSince) return provider;
  const updatedAt = Date.parse(provider.updatedAt || '');
  if (!Number.isFinite(updatedAt) || updatedAt < pendingSince) return null;
  state.copilotPendingCheckSince = 0;
  return provider;
}

function markCopilotTokenCheckPending() {
  state.copilotPendingCheckSince = Date.now();
  clearCopilotProviderStatus();
}

function clearCopilotPendingCheck() {
  state.copilotPendingCheckSince = 0;
}

function clearCopilotProviderStatus() {
  if (!Array.isArray(state.stats?.limits?.providers)) return;
  state.stats.limits.providers = state.stats.limits.providers.filter((provider) => provider.provider !== 'copilot');
}

const externalLimitAccountConfig = {
  claude: {
    configuredKey: 'claudeWebCookieConfigured',
    sourceKey: 'claudeWebCookieSource',
    pendingKey: 'claudePendingCheckSince'
  },
  zai: {
    configuredKey: 'zaiApiKeyConfigured',
    sourceKey: 'zaiApiKeySource',
    pendingKey: 'zaiPendingCheckSince'
  },
  zaiteam: {
    configuredKey: 'zaiTeamApiKeyConfigured',
    sourceKey: 'zaiTeamApiKeySource',
    pendingKey: 'zaiteamPendingCheckSince'
  },
  volcengine: {
    configuredKey: 'volcengineCredentialsConfigured',
    sourceKey: 'volcengineCredentialsSource',
    pendingKey: 'volcenginePendingCheckSince'
  },
  qoder: {
    configuredKey: 'qoderCookieConfigured',
    sourceKey: 'qoderCookieSource',
    pendingKey: 'qoderPendingCheckSince'
  },
  commandcode: {
    configuredKey: 'commandcodeCookieConfigured',
    sourceKey: 'commandcodeCookieSource',
    pendingKey: 'commandcodePendingCheckSince'
  },
  kimi: {
    configuredKey: 'kimiCredentialConfigured',
    sourceKey: 'kimiCredentialSource',
    pendingKey: 'kimiPendingCheckSince'
  },
  ollama: {
    configuredKey: 'ollamaCookieConfigured',
    sourceKey: 'ollamaCookieSource',
    pendingKey: 'ollamaPendingCheckSince'
  }
};

function clearDisabledLimitProviderPendingChecks(enabledProviders) {
  if (!enabledProviders.has('deepseek')) clearDeepseekPendingCheck();
  if (!enabledProviders.has('minimax')) clearMinimaxPendingCheck();
  if (!enabledProviders.has('copilot')) clearCopilotPendingCheck();
  for (const providerName of Object.keys(externalLimitAccountConfig)) {
    if (!enabledProviders.has(providerName)) clearExternalProviderCheckPending(providerName);
  }
}

function externalProviderForAccount(providerName) {
  const provider = localProviderStatus(providerName);
  const config = externalLimitAccountConfig[providerName];
  const pendingSince = Number(config ? state[config.pendingKey] : 0);
  if (!provider || !pendingSince) return provider;
  const updatedAt = Date.parse(provider.updatedAt || '');
  if (!Number.isFinite(updatedAt) || updatedAt < pendingSince) return null;
  state[config.pendingKey] = 0;
  return provider;
}

function externalProviderAccountLinked(providerName) {
  const config = externalLimitAccountConfig[providerName];
  const provider = externalProviderForAccount(providerName);
  return Boolean(config && state.settings?.[config.configuredKey]) && provider?.status === 'ok';
}

function markExternalProviderCheckPending(providerName) {
  const config = externalLimitAccountConfig[providerName];
  if (!config) return;
  state[config.pendingKey] = Date.now();
  clearExternalProviderPendingStatus(providerName);
}

function clearExternalProviderCheckPending(providerName) {
  const config = externalLimitAccountConfig[providerName];
  if (config) state[config.pendingKey] = 0;
}

function clearExternalProviderPendingStatus(providerName) {
  if (!Array.isArray(state.stats?.limits?.providers)) return;
  state.stats.limits.providers = state.stats.limits.providers.filter((provider) => provider.provider !== providerName);
}

function nextCopilotSignInFlowId() {
  return `copilot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nextCodexSignInFlowId() {
  return `codex-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isCurrentCodexSignInFlow(flowId) {
  const current = String(state.codexSignInFlowId || '');
  const incoming = String(flowId || '');
  return current && incoming === current;
}

function isCurrentCopilotSignInFlow(flowId) {
  const current = String(state.copilotSignInFlowId || '');
  const incoming = String(flowId || '');
  return current && incoming === current;
}

function copilotAccountStatusText(provider, configured, source, enabled = true) {
  const accountStatus = limitProviderPresentationApi.apiKeyAccountStatus(provider, configured, enabled);
  if (accountStatus === 'linked') {
    const accountName = String(provider?.accountName || '').trim();
    return accountName || t(source === 'env' ? 'settings.copilot.statusEnv' : 'settings.copilot.statusSet');
  }
  if (accountStatus === 'invalid') return t('settings.copilot.statusInvalid');
  if (accountStatus === 'notConfigured') return t('settings.copilot.statusNotSet');
  const statusKeys = {
    checking: 'settings.common.checking',
    disabled: 'settings.limits.status.disabled',
    limited: 'settings.common.limited',
    unavailable: 'settings.common.unavailable',
    notChecked: 'settings.common.notChecked',
    error: 'settings.common.error'
  };
  return t(statusKeys[accountStatus] || 'settings.common.error');
}

function apiKeyAccountStatusText(providerName, provider, configured, source, enabled = true) {
  const accountStatus = limitProviderPresentationApi.apiKeyAccountStatus(provider, configured, enabled);
  if (accountStatus === 'linked') {
    return t(source === 'env' ? `settings.${providerName}.statusEnv` : `settings.${providerName}.statusSet`);
  }
  if (accountStatus === 'invalid') return t(`settings.${providerName}.statusInvalid`);
  if (accountStatus === 'notConfigured') return t(`settings.${providerName}.statusNotSet`);
  const statusKeys = {
    checking: 'settings.common.checking',
    disabled: 'settings.limits.status.disabled',
    limited: 'settings.common.limited',
    unavailable: 'settings.common.unavailable',
    notChecked: 'settings.common.notChecked',
    error: 'settings.common.error'
  };
  return t(statusKeys[accountStatus] || 'settings.common.error');
}

// Follow the region we last successfully polled so a global (minimax.io)
// account lands on platform.minimax.io, not the CN landing page. Fall back
// to the CN host until we've seen a successful poll.
function minimaxPlatformUrl() {
  const provider = minimaxProviderForAccount();
  const region = provider && provider.region === 'en' ? 'en' : 'cn';
  return region === 'en'
    ? 'https://platform.minimax.io/user-center/payment/token-plan'
    : 'https://platform.minimaxi.com/user-center/payment/token-plan';
}

function setExternalAccountExpanded(providerName, expanded) {
  const details = document.getElementById(`${providerName}SettingsDetails`);
  const toggle = document.getElementById(`${providerName}SettingsToggle`);
  if (!details || !toggle) return;
  const next = Boolean(expanded);
  state[`${providerName}AccountExpanded`] = next;
  details.classList.toggle('hidden', !next);
  toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
  limitProviderAccountGroup(providerName)?.classList.toggle('expanded', next);
  syncLimitProviderAccountExpansion(providerName, next);
}

function zaiPlatformUrl() {
  const selectedRegion = document.getElementById('zaiApiRegionInput')?.value;
  const region = selectedRegion || (state.settings?.zaiApiRegion === 'bigmodel-cn' ? 'bigmodel-cn' : 'global');
  return region === 'bigmodel-cn'
    ? 'https://bigmodel.cn/coding-plan/personal/usage'
    : 'https://z.ai/manage-apikey/coding-plan/personal/my-plan';
}

function zaiteamPlatformUrl() {
  return 'https://bigmodel.cn/coding-plan/team/usage-stats';
}

function volcenginePlatformUrl() {
  return 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe';
}

function claudePlatformUrl() {
  return 'https://claude.ai/settings/usage';
}

function selectedQoderSite() {
  const selectedSite = document.getElementById('qoderSiteInput')?.value;
  return selectedSite || (state.settings?.qoderSite === 'cn' ? 'cn' : 'global');
}

function qoderUsagePagePath() {
  return selectedQoderSite() === 'cn' ? 'qoder.com.cn/account/usage' : 'qoder.com/account/usage';
}

function qoderPlatformUrl() {
  return `https://${qoderUsagePagePath()}`;
}

function updateQoderUsagePageHint() {
  const hint = document.getElementById('qoderUsagePageHint');
  if (hint) hint.textContent = qoderUsagePagePath();
}

function kimiPlatformUrl() {
  return 'https://www.kimi.com/code/console';
}

function ollamaPlatformUrl() {
  return 'https://ollama.com/settings';
}

function commandcodePlatformUrl() {
  // Account-scoped in the address bar (/<username>/settings/usage), but this
  // path resolves to it and bounces through signin?returnTo= when signed out,
  // so it is the one link that works without knowing the username.
  return 'https://commandcode.ai/settings/usage';
}

function ollamaValidationError(provider) {
  if (provider?.status === 'unauthorized') return t('settings.ollama.validationInvalid');
  if (provider?.status === 'rateLimited' || provider?.status === 'sourceRateLimited') {
    return t('settings.ollama.validationRateLimited');
  }
  return t('settings.ollama.validationUnavailable');
}

function renderExternalProviderStatus(providerName) {
  const config = externalLimitAccountConfig[providerName];
  const statusEl = document.getElementById(`${providerName}AccountStatus`);
  const openBtn = document.getElementById(`${providerName}OpenBrowser`);
  const logoutBtn = document.getElementById(`${providerName}LogoutButton`);
  const refreshBtn = document.getElementById(`${providerName}RefreshButton`);
  const manualPanel = document.getElementById(`${providerName}ManualPanel`);
  const errorEl = document.getElementById(`${providerName}ErrorMessage`);
  if (!config || !statusEl || !openBtn || !logoutBtn || !refreshBtn || !manualPanel || !errorEl) return;

  errorEl.classList.add('hidden');
  errorEl.textContent = '';

  const source = state.settings?.[config.sourceKey] || '';
  const wasPending = Number(state[config.pendingKey] || 0) > 0;
  const provider = externalProviderForAccount(providerName);
  const configured = Boolean(state.settings?.[config.configuredKey]);
  const enabled = limitProviderEnabled(providerName);
  const pending = enabled && Number(state[config.pendingKey] || 0) > 0;
  const linked = externalProviderAccountLinked(providerName);
  if (providerName === 'ollama' && wasPending && !pending && linked) {
    setExternalAccountExpanded('ollama', false);
  }
  if (providerName === 'zai') {
    const regionInput = document.getElementById('zaiApiRegionInput');
    if (regionInput) regionInput.value = state.settings?.zaiApiRegion === 'bigmodel-cn' ? 'bigmodel-cn' : 'global';
  }
  if (providerName === 'qoder') {
    const siteInput = document.getElementById('qoderSiteInput');
    if (siteInput) siteInput.value = state.settings?.qoderSite === 'cn' ? 'cn' : 'global';
    updateQoderUsagePageHint();
  }
  setCursorStatusText(
    statusEl,
    pending ? t('settings.common.checking') : apiKeyAccountStatusText(providerName, provider, configured, source, enabled)
  );
  manualPanel.classList.toggle('hidden', linked);
  openBtn.classList.toggle('hidden', linked);
  const canClearConfiguredClaude = providerName === 'claude' && configured;
  logoutBtn.classList.toggle('hidden', source !== 'settings' || (!linked && !canClearConfiguredClaude));
  refreshBtn.classList.toggle('hidden', !configured);
  renderSettingsSummaries();
}

function setMinimaxAccountExpanded(expanded) {
  const details = document.getElementById('minimaxSettingsDetails');
  const toggle = document.getElementById('minimaxSettingsToggle');
  if (!details || !toggle) return;
  const next = Boolean(expanded);
  state.minimaxAccountExpanded = next;
  details.classList.toggle('hidden', !next);
  toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
  limitProviderAccountGroup('minimax')?.classList.toggle('expanded', next);
  syncLimitProviderAccountExpansion('minimax', next);
}

function renderMinimaxStatus() {
  const statusEl = document.getElementById('minimaxApiKeyStatus');
  const openBtn = document.getElementById('minimaxOpenBrowser');
  const logoutBtn = document.getElementById('minimaxLogoutButton');
  const refreshBtn = document.getElementById('minimaxRefreshButton');
  const manualPanel = document.getElementById('minimaxManualPanel');
  const errorEl = document.getElementById('minimaxErrorMessage');
  if (!statusEl || !openBtn || !logoutBtn || !refreshBtn || !manualPanel || !errorEl) return;

  errorEl.classList.add('hidden');
  errorEl.textContent = '';

  const source = state.settings?.minimaxApiKeySource || '';
  const provider = minimaxProviderForAccount();
  const configured = Boolean(state.settings?.minimaxApiKeyConfigured);
  const enabled = limitProviderEnabled('minimax');
  const linked = minimaxAccountLinked();
  setCursorStatusText(statusEl, apiKeyAccountStatusText('minimax', provider, configured, source, enabled));
  manualPanel.classList.toggle('hidden', linked);
  openBtn.classList.toggle('hidden', linked);
  logoutBtn.classList.toggle('hidden', !linked || source !== 'settings');
  refreshBtn.classList.toggle('hidden', !configured);
  renderSettingsSummaries();
}

function renderCopilotStatus() {
  const statusEl = document.getElementById('copilotApiTokenStatus');
  const signInBtn = document.getElementById('copilotSignInButton');
  const cancelBtn = document.getElementById('copilotCancelSignInButton');
  const logoutBtn = document.getElementById('copilotLogoutButton');
  const refreshBtn = document.getElementById('copilotRefreshButton');
  const manualPanel = document.getElementById('copilotManualPanel');
  const loginStatusEl = document.getElementById('copilotLoginStatus');
  const errorEl = document.getElementById('copilotErrorMessage');
  if (!statusEl || !signInBtn || !cancelBtn || !logoutBtn || !refreshBtn || !manualPanel || !loginStatusEl || !errorEl) return;

  const source = state.settings?.copilotApiTokenSource || '';
  const provider = copilotProviderForAccount();
  const configured = Boolean(state.settings?.copilotApiTokenConfigured);
  const enabled = limitProviderEnabled('copilot');
  const linked = copilotAccountLinked();
  errorEl.textContent = state.copilotErrorMessage || '';
  errorEl.classList.toggle('hidden', !state.copilotErrorMessage);
  setCursorStatusText(statusEl, copilotAccountStatusText(provider, configured, source, enabled));
  manualPanel.classList.toggle('hidden', linked);
  if (linked && state.copilotManualExpanded) setCopilotManualExpanded(false);
  signInBtn.classList.toggle('hidden', linked || state.copilotSignInBusy);
  cancelBtn.classList.toggle('hidden', !state.copilotSignInBusy || !state.copilotSignInCancelable || linked);
  logoutBtn.classList.toggle('hidden', !linked || source !== 'settings');
  refreshBtn.classList.toggle('hidden', !configured || (state.copilotSignInBusy && !linked));
  loginStatusEl.classList.toggle('hidden', !state.copilotLoginStatus);
  loginStatusEl.textContent = state.copilotLoginStatus;
  renderSettingsSummaries();
}

function renderDeepseekStatus() {
  const statusEl = document.getElementById('deepseekApiKeyStatus');
  const openBtn = document.getElementById('deepseekOpenBrowser');
  const logoutBtn = document.getElementById('deepseekLogoutButton');
  const refreshBtn = document.getElementById('deepseekRefreshButton');
  const manualPanel = document.getElementById('deepseekManualPanel');
  const errorEl = document.getElementById('deepseekErrorMessage');
  if (!statusEl || !openBtn || !logoutBtn || !refreshBtn || !manualPanel || !errorEl) return;

  errorEl.classList.add('hidden');
  errorEl.textContent = '';

  const source = state.settings?.deepseekApiKeySource || '';
  const provider = deepseekProviderForAccount();
  const configured = Boolean(state.settings?.deepseekApiKeyConfigured);
  const enabled = limitProviderEnabled('deepseek');
  const linked = deepseekAccountLinked();
  setCursorStatusText(statusEl, apiKeyAccountStatusText('deepseek', provider, configured, source, enabled));
  manualPanel.classList.toggle('hidden', linked);
  openBtn.classList.toggle('hidden', linked);
  logoutBtn.classList.toggle('hidden', !linked || source !== 'settings');
  refreshBtn.classList.toggle('hidden', !configured);
  renderSettingsSummaries();
}

function renderOpenCodeProfiles() {
  const listEl = document.getElementById('opencodeProfileList');
  if (!listEl) return;

  const api = window.tokenMonitor.opencode;

  api.getProfiles().then(({ profiles, hasEnvVar, hasAmbientKey, ambientEnabled = true }) => {
    listEl.innerHTML = '';
    const entries = Object.entries(profiles);

    if (entries.length === 0 && !hasEnvVar && !hasAmbientKey) {
      listEl.innerHTML = '<div class="opencode-empty">' + t('settings.opencode.emptyList') + '</div>';
      state.opencodeProfileCount = 0;
      renderOpenCodeProfilesStatusSummary({});
      renderSettingsSummaries();
      return;
    }

    // The auto-detected key counts as an account: it is what the limits card is
    // reading, so leaving it out of the total reports "not set up" next to live
    // quota. It has no toggle or delete because Token Monitor does not own that
    // credential — OpenCode does — but naming it does belong here: a name is
    // what lets it join an account, and typing an existing account's name is
    // how a user says the two are the same OpenCode account.
    if (hasAmbientKey) {
      const item = document.createElement('div');
      item.className = 'opencode-profile-item';
      // Switchable like any other account, even without a name. Turning it off
      // is a device preference rather than a stored credential, so the row keeps
      // rendering with its box clear instead of disappearing along with the only
      // control that could bring it back.
      const ambientToggle = document.createElement('input');
      ambientToggle.className = 'profile-toggle';
      ambientToggle.type = 'checkbox';
      ambientToggle.checked = ambientEnabled;
      ambientToggle.title = t('settings.opencode.ambientDetail');
      ambientToggle.addEventListener('change', async () => {
        await window.tokenMonitor.opencode.setAmbientEnabled(ambientToggle.checked);
        renderOpenCodeProfiles();
        updateOpenCodeProfilesStatus();
        renderSettingsSummaries();
      });
      const nameBox = document.createElement('span');
      nameBox.className = 'profile-name-box';
      // An editable field rather than a label behind an edit button: this row
      // has no name yet, and naming it is the only thing a user can do here, so
      // hiding that behind a hover-revealed pencil hides the whole feature. The
      // placeholder carries the label the row used to show.
      const nameInput = document.createElement('input');
      nameInput.className = 'profile-name-input is-placeholder';
      nameInput.type = 'text';
      nameInput.placeholder = t('settings.opencode.ambientName');
      nameInput.title = t('settings.opencode.nameAmbient');

      // Typing an existing account's name binds the auto-detected key into that
      // account. That claim is confirmed, never inferred: the main process
      // refuses it without `merge`, so a blur landing on a name that happens to
      // exist offers the button instead of quietly merging.
      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'credential-merge-btn hidden';
      const offer = opencodeMergeOffer(mergeBtn, (name) => applyNaming(name, true));
      const applyNaming = async (name, merge) => {
        const at = offer.revision();
        // 'ambient' stores a reference rather than the key, so a key rotated
        // inside OpenCode keeps being read live.
        const result = await window.tokenMonitor.opencode.saveProfile(name, '', 'ambient', { merge });
        if (!result.ok) {
          if (result.nameTaken) {
            offer.offer(at, name, t('settings.opencode.mergeInto', { name }));
            return;
          }
          if (offer.stale(at)) return;
          const errorEl = document.getElementById('opencodeErrorMessage');
          errorEl.textContent = opencodeSaveErrorText(result);
          errorEl.classList.remove('hidden');
          return;
        }
        renderOpenCodeProfiles();
        updateOpenCodeProfilesStatus();
        renderSettingsSummaries();
      };
      const endNaming = async (save) => {
        const name = nameInput.value.trim();
        if (!save || !name) {
          nameInput.value = '';
          offer.withdraw();
          return;
        }
        await applyNaming(name, false);
      };
      // Editing the name withdraws the offer: the confirmation names one account,
      // and it must be the one on screen when the user clicks it.
      nameInput.addEventListener('input', () => offer.withdraw());
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') endNaming(true);
        if (e.key === 'Escape') endNaming(false);
      });
      nameInput.addEventListener('blur', () => endNaming(true));

      const detail = document.createElement('span');
      detail.className = 'profile-detail';
      detail.textContent = t('settings.opencode.ambientDetail');
      nameBox.append(nameInput, mergeBtn, detail);

      const rightBox = document.createElement('span');
      rightBox.className = 'profile-right';
      const infoSpan = document.createElement('span');
      infoSpan.className = 'profile-info';
      // Not `opencode-info-<name>`: that shape is generated from user-chosen
      // account names, so a profile named the same as any sentinel would take
      // this row's status.
      infoSpan.id = 'opencodeAmbientInfo';
      infoSpan.textContent = ambientEnabled ? '...' : t('settings.opencode.disabled');
      rightBox.append(infoSpan);
      item.append(ambientToggle, nameBox, rightBox);
      listEl.appendChild(item);
    }

    state.opencodeProfileCount = entries.length + (hasAmbientKey ? 1 : 0);
    renderSettingsSummaries();

    for (const [name, profile] of entries) {
      const item = document.createElement('div');
      item.className = 'opencode-profile-item';

      const toggle = document.createElement('input');
      toggle.className = 'profile-toggle';
      toggle.type = 'checkbox';
      toggle.checked = profile.enabled;
      toggle.addEventListener('change', () => {
        api.setProfileEnabled(name, toggle.checked).then(() => {
          const info = item.querySelector('.profile-info');
          info.textContent = toggle.checked ? '...' : t('settings.opencode.disabled');
          renderSettingsSummaries();
          updateOpenCodeProfilesStatus();
        });
      });

      const nameBox = document.createElement('span');
      nameBox.className = 'profile-name-box';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'profile-name';
      nameSpan.textContent = name;

      const nameInput = document.createElement('input');
      nameInput.className = 'profile-name-input hidden';
      nameInput.type = 'text';
      nameInput.value = name;

      const renameBtn = document.createElement('button');
      renameBtn.className = 'profile-rename-btn';
      renameBtn.textContent = '✎';
      renameBtn.title = t('settings.opencode.rename');

      let editing = false;
      function beginRename() {
        if (editing) return;
        editing = true;
        nameSpan.classList.add('hidden');
        nameInput.classList.remove('hidden');
        nameInput.focus();
        nameInput.select();
      }
      // Renaming onto an existing account merges the two, which asserts they are
      // the same OpenCode account. That claim gets a visible button rather than
      // a repeated keypress: confirming should be something the user chooses,
      // not something they discover by pressing Enter again.
      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'credential-merge-btn hidden';
      const offer = opencodeMergeOffer(mergeBtn, (next) => applyRename(next, true));
      const applyRename = async (next, merge) => {
        const at = offer.revision();
        const errorEl = document.getElementById('opencodeErrorMessage');
        const result = await api.renameProfile(name, next, { merge });
        if (!result.ok) {
          if (result.nameTaken) {
            offer.offer(at, next, t('settings.opencode.mergeInto', { name: next }));
            return;
          }
          if (offer.stale(at)) return;
          errorEl.textContent = opencodeSaveErrorText(result);
          errorEl.classList.remove('hidden');
          return;
        }
        errorEl.classList.add('hidden');
        renderOpenCodeProfiles();
        updateOpenCodeProfilesStatus();
        renderSettingsSummaries();
      };
      // Retyping withdraws the offer, so the button can only ever confirm the
      // name the user is currently proposing.
      nameInput.addEventListener('input', () => offer.withdraw());
      async function endRename(save) {
        if (!editing) return;
        editing = false;
        nameInput.classList.add('hidden');
        nameSpan.classList.remove('hidden');
        const next = nameInput.value.trim();
        if (!save || !next || next === name) return;
        await applyRename(next, false);
      }
      renameBtn.addEventListener('click', beginRename);
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') endRename(true);
        if (e.key === 'Escape') endRename(false);
      });
      nameInput.addEventListener('blur', () => endRename(true));

      // Which credentials this account holds. Two of them under one name is the
      // user's assertion that they are the same OpenCode account, and that
      // assertion decides which source answers for quota and which identity the
      // account is published under, so it stays visible. Acting on them lives in
      // the expanded section rather than inline: a click that unbinds an account
      // should not sit one pixel from the account's own controls.
      // A reference the collector has stopped using says so on its own row.
      // Otherwise an account that also holds a cookie shows the credential as
      // present, keeps reporting fine from the cookie, and nothing anywhere
      // reveals that its Go quota is no longer coming from the detected key.
      const ambientLabel = profile.ambientStale
        ? `${t('settings.opencode.ambientName')} · ${t('settings.opencode.needsRebind')}`
        : t('settings.opencode.ambientName');
      const credentials = [
        ['ambient', profile.usesAmbientKey, ambientLabel],
        ['api', profile.hasApiKey, t('settings.opencode.kindApi')],
        ['cookie', profile.hasCookie, t('settings.opencode.kindCookie')]
      ].filter(([, present]) => present);

      // The summary line is the control that expands it: clicking the thing you
      // want to see beats a separate chevron stranded between the status text
      // and the delete button.
      const multiCredential = credentials.length > 1;
      const detail = document.createElement(multiCredential ? 'button' : 'span');
      detail.className = 'profile-detail';
      let chevron = null;
      if (multiCredential) {
        detail.type = 'button';
        detail.classList.add('is-expandable');
        detail.setAttribute('aria-expanded', 'false');
        detail.title = t('settings.opencode.showCredentials');
        // The same disclosure chevron every other group uses, so it animates and
        // reads the same; only the direction differs, pointing right when closed.
        chevron = document.createElement('span');
        chevron.className = 'cursor-disclosure-icon';
        chevron.setAttribute('aria-hidden', 'true');
      }
      detail.textContent = credentials.map(([, , label]) => label).join(' + ');
      if (chevron) detail.append(chevron);

      nameBox.append(nameSpan, nameInput, renameBtn, mergeBtn, detail);

      const rightBox = document.createElement('span');
      rightBox.className = 'profile-right';

      const infoSpan = document.createElement('span');
      infoSpan.className = 'profile-info';
      infoSpan.id = opencodeRowId('opencode-info-', name);
      infoSpan.textContent = profile.enabled ? '...' : t('settings.opencode.disabled');

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'profile-delete';
      deleteBtn.textContent = '✕';
      deleteBtn.title = t('settings.opencode.delete');
      let confirmingDelete = false;
      deleteBtn.addEventListener('click', async () => {
        if (!confirmingDelete) {
          confirmingDelete = true;
          deleteBtn.classList.add('confirming');
          deleteBtn.textContent = '✓';
          deleteBtn.title = t('settings.opencode.deleteConfirm', { name });
          return;
        }
        await api.deleteProfile(name);
        renderOpenCodeProfiles();
        updateOpenCodeProfilesStatus();
        renderSettingsSummaries();
      });

      // Expanding is only worth offering once an account holds more than one
      // credential — with a single one the row already says everything.
      let credentialList = null;
      if (multiCredential) {
        credentialList = document.createElement('div');
        credentialList.className = 'opencode-credential-list accordion-animated-container hidden';
        credentialList.id = opencodeRowId('opencode-credentials-', name);
        // The shared accordion squeezes one inner wrapper, so the rows go inside
        // it rather than on the container, which cannot shrink.
        const credentialInner = document.createElement('div');
        credentialInner.className = 'accordion-animation-inner';
        for (const [kind, , label] of credentials) {
          credentialInner.append(opencodeCredentialRow(name, kind, label));
        }
        credentialList.append(credentialInner);
        detail.setAttribute('aria-controls', credentialList.id);
        detail.addEventListener('click', () => {
          const open = credentialList.classList.toggle('hidden') === false;
          detail.setAttribute('aria-expanded', String(open));
          detail.classList.toggle('is-open', open);
        });
      }

      rightBox.append(infoSpan, deleteBtn);
      item.append(toggle, nameBox, rightBox);
      if (credentialList) item.append(credentialList);
      listEl.appendChild(item);
    }

    updateOpenCodeProfilesStatus();
  });
}

// A merge that would land two credentials of the same kind on one account is
// refused rather than resolved: confirming that two accounts are the same is a
// different question from choosing which of two cookies to keep.
function opencodeSaveErrorText(result) {
  if (result?.credentialConflict) {
    return t('settings.opencode.credentialConflict', {
      kind: t(result.kind === 'cookie' ? 'settings.opencode.kindCookie'
        : result.kind === 'ambient' ? 'settings.opencode.ambientName'
          : 'settings.opencode.kindApi')
    });
  }
  return result?.error || t('settings.opencode.saveFailedShort');
}

// A merge confirmation names one specific proposal: this credential, into this
// account. Editing the field withdraws it, so the click the main process
// receives is consent to what the user is looking at.
//
// Hiding the button is not enough on its own, because the answer that offers it
// arrives after an await: an edit made while that request is in flight is
// overtaken by the reply, and the button comes back describing the proposal the
// user has just moved on from. So a withdrawal advances a revision the reply is
// checked against, and a reply from a superseded revision is dropped rather
// than shown. The same rule reached four call sites by copy, which is why it
// lives in one place now.
//
// There is deliberately one way to take an offer down. A plain hide looks
// harmless on the cancel paths (Escape, a blur onto nothing) but leaves the
// revision where it was, so the reply to the request the user just cancelled
// still matched and put the button back — the original bug, reached through the
// other door. Everything that ends an offer withdraws it.
function opencodeMergeOffer(button, confirm) {
  let revision = 0;
  let pending = '';
  button.addEventListener('click', () => {
    if (pending !== '') confirm(pending);
  });
  return {
    // Captured before the await, compared after it.
    revision: () => revision,
    stale: (at) => at !== revision,
    withdraw: () => {
      revision += 1;
      pending = '';
      button.classList.add('hidden');
    },
    offer: (at, name, label) => {
      if (at !== revision) return;
      pending = name;
      button.textContent = label;
      button.classList.remove('hidden');
    }
  };
}

// Element ids for a row, from the account name.
//
// Reversible rather than sanitized. Replacing everything outside a safe set with
// `_` is not injective, so two accounts a user is perfectly entitled to name —
// `a b` and `a_b`, or `a/b` and `a_b` — landed on one id, and whichever rendered
// first collected the other's status. `encodeURIComponent` is injective and
// leaves no whitespace, which is the only thing an id may not contain.
//
// A counter would work too, but these two call sites are independent: one
// renders the row, the other looks it up from a later status reply. A pure
// function of the name cannot drift between them the way a shared table can.
function opencodeRowId(prefix, name) {
  return `${prefix}${encodeURIComponent(name)}`;
}

// One credential inside an expanded account. Renaming moves it to another
// account name, which is what splits a binding apart or forms a new one;
// deleting drops just this credential and leaves the rest of the account.
function opencodeCredentialRow(accountName, kind, label) {
  const api = window.tokenMonitor.opencode;
  const errorEl = () => document.getElementById('opencodeErrorMessage');
  const refresh = () => {
    renderOpenCodeProfiles();
    updateOpenCodeProfilesStatus();
    renderSettingsSummaries();
  };

  const row = document.createElement('div');
  row.className = 'opencode-credential-row';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'credential-label';
  labelSpan.textContent = label;

  // The account name is shown on every credential rather than hidden behind an
  // edit button, because seeing the same name twice is the explanation for why
  // these are one account. Typing a different one moves that credential out.
  const nameInput = document.createElement('input');
  nameInput.className = 'credential-name-input';
  nameInput.type = 'text';
  nameInput.value = accountName;
  nameInput.title = t('settings.opencode.moveCredential', { kind: label });
  nameInput.placeholder = t('settings.opencode.profileNamePlaceholder');

  const actions = document.createElement('span');
  actions.className = 'credential-actions';

  // A merge is a claim that two credentials belong to one OpenCode account, so
  // it is confirmed with a visible button rather than by pressing the same key
  // twice and hoping the user reads why.
  const mergeBtn = document.createElement('button');
  mergeBtn.className = 'credential-merge-btn hidden';
  const offer = opencodeMergeOffer(mergeBtn, (target) => finishMove(target, true));

  const finishMove = async (target, merge) => {
    const at = offer.revision();
    const result = await api.moveCredential(accountName, kind, target, { merge });
    if (!result.ok) {
      if (result.nameTaken) {
        offer.offer(at, target, t('settings.opencode.mergeInto', { name: target }));
        return;
      }
      if (offer.stale(at)) return;
      errorEl().textContent = opencodeSaveErrorText(result);
      errorEl().classList.remove('hidden');
      return;
    }
    refresh();
  };
  const endMove = async (save) => {
    const target = nameInput.value.trim();
    if (!save || !target || target === accountName) {
      nameInput.value = accountName;
      offer.withdraw();
      return;
    }
    await finishMove(target, false);
  };

  // Same rule as everywhere else: retyping the target withdraws the pending
  // confirmation rather than leaving a button that would move it somewhere the
  // user is no longer proposing.
  nameInput.addEventListener('input', () => offer.withdraw());
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') endMove(true);
    if (e.key === 'Escape') endMove(false);
  });
  nameInput.addEventListener('blur', () => endMove(true));

  const removeBtn = document.createElement('button');
  removeBtn.className = 'profile-delete';
  removeBtn.textContent = '✕';
  removeBtn.title = t('settings.opencode.removeCredential', { kind: label });
  // Two-step, like deleting an account: unbinding is not undoable from here.
  let confirming = false;
  removeBtn.addEventListener('click', async () => {
    if (!confirming) {
      confirming = true;
      removeBtn.classList.add('confirming');
      removeBtn.textContent = '✓';
      return;
    }
    const result = await api.removeCredential(accountName, kind);
    if (result.ok) refresh();
  });

  actions.append(removeBtn);
  // The merge label carries the target account name and never fits beside the
  // input, so it trails the row and wraps onto its own line when it appears.
  row.append(labelSpan, nameInput, actions, mergeBtn);
  return row;
}

async function updateOpenCodeProfilesStatus() {
  const api = window.tokenMonitor.opencode;
  const status = await api.status();
  const profiles = status.profiles || {};

  // The auto-detected key has no account name, so it arrives in its own field
  // and lands on its own element rather than one keyed by a name a user could
  // also type.
  const entries = Object.entries(profiles).map(([name, s]) => [
    opencodeRowId('opencode-info-', name),
    s
  ]);
  if (status.ambient) entries.push(['opencodeAmbientInfo', status.ambient]);

  for (const [elementId, s] of entries) {
    const infoEl = document.getElementById(elementId);
    if (!infoEl) continue;

    if (s.disabled) {
      infoEl.textContent = t('settings.opencode.disabled');
    } else if (s.needsRebind) {
      // Said once, on the credential line, which has room for it and is the
      // thing that needs re-attaching. This cell is a fixed narrow column and
      // would only repeat it truncated.
      infoEl.textContent = '';
    } else if (s.expired) {
      infoEl.textContent = t('settings.opencode.statusExpired');
    } else if (s.linked) {
      const parts = [];
      if (s.go) parts.push('Go');
      if (s.zen) parts.push('Zen');
      let text = '✓ ' + parts.join(' · ');
      if (s.hasBalance && s.balanceUsd != null) {
        text += '  $' + Number(s.balanceUsd).toFixed(2);
      }
      infoEl.textContent = text;
    } else if (s.error) {
      infoEl.textContent = s.error;
    } else {
      infoEl.textContent = t('settings.opencode.connectFailed');
    }
  }

  renderOpenCodeProfilesStatusSummary(profiles, status.ambient);
}

// `ambient` counts toward both halves: it is a row in the list and it is what
// the limits card reads on a machine with nothing configured, so leaving it out
// reports "0/0" beside live quota.
function renderOpenCodeProfilesStatusSummary(profiles, ambient = null) {
  const totalEl = document.getElementById('opencodeCookieStatus');
  if (totalEl) {
    const statuses = [...Object.values(profiles), ...(ambient ? [ambient] : [])];
    const linkedCount = statuses.filter(s => s.linked).length;
    const configuredProfileCount = state.opencodeProfileCount || 0;
    const totalCount = Math.max(statuses.length, configuredProfileCount);
    if (totalCount > 0) {
      totalEl.textContent = t('settings.opencode.connected', { linked: linkedCount, total: totalCount });
    } else {
      totalEl.textContent = t('settings.opencode.statusNotSet');
    }
  }
}

function openrouterProfileStatusText(provider, options = {}) {
  const status = limitProviderPresentationApi.namedApiProfileStatus(provider, options);
  if (status === 'disabled') return t('settings.profiles.disabled');
  if (status === 'hidden') return '';
  if (status === 'checking') return t('settings.openrouter.checking');
  if (status === 'invalid') return t('settings.openrouter.invalidKey');
  if (status !== 'linked') return t('settings.openrouter.unavailable');
  const balance = optionalFiniteNumber(provider.balance?.amount);
  if (balance !== null) return `✓ ${formatMoney(balance, 'USD')}`;
  const quota = (provider.windows || []).find((window) => window?.showMeter !== false);
  const remaining = optionalFiniteNumber(quota?.remaining);
  if (remaining !== null) return `✓ ${formatMoney(remaining, 'USD')} left`;
  return '✓';
}

function thirdPartyProfileStatusText(provider, options = {}) {
  const status = limitProviderPresentationApi.namedApiProfileStatus(provider, options);
  if (status === 'disabled') return t('settings.profiles.disabled');
  if (status === 'hidden') return '';
  if (status === 'checking') return t('settings.thirdparty.checking');
  if (status === 'invalid') return t('settings.thirdparty.invalidKey');
  if (status !== 'linked') return t('settings.thirdparty.unavailable');
  const balance = optionalFiniteNumber(provider.balance?.amount);
  if (balance !== null) return `✓ ${formatCompactMoney(balance, provider.balance?.currency || 'USD')}`;
  const unlimited = (provider.windows || []).some((window) => (
    window?.showMeter === false && String(window?.detail || '').toLowerCase() === 'unlimited'
  ));
  return unlimited ? `✓ ${t('settings.thirdparty.unlimited')}` : '✓';
}

function updateNamedApiProfilesStatus({
  providerId,
  profileSettingsKey,
  profileCountStateKey,
  statusText
}) {
  const providerEnabled = limitProviderEnabled(providerId);
  const providers = localProviderStatuses(providerId);
  const byName = new Map(providers.map((provider) => [
    String(provider.accountName || provider.accountLabel || ''),
    provider
  ]));
  for (const infoEl of document.querySelectorAll(`[data-managed-profile-provider="${providerId}"][data-managed-profile-name]`)) {
    const name = infoEl.dataset.managedProfileName || '';
    const profile = state.settings?.[profileSettingsKey]?.[name];
    infoEl.textContent = statusText(byName.get(name), {
      providerEnabled,
      profileEnabled: profile?.enabled !== false
    });
  }
  const envInfo = document.querySelector(
    `[data-managed-profile-provider="${providerId}"][data-managed-profile-environment]`
  );
  if (envInfo) envInfo.textContent = statusText(byName.get('environment'), { providerEnabled });
  const statusEl = document.getElementById(`${providerId}Status`);
  if (!statusEl) return;
  const total = state[profileCountStateKey] || 0;
  const linked = providers.filter((provider) => provider.status === 'ok').length;
  statusEl.textContent = total === 0
    ? t(`settings.${providerId}.statusNotSet`)
    : !providerEnabled
      ? t(`settings.${providerId}.nAccounts`, { count: total })
      : t(`settings.${providerId}.connected`, { linked, total });
}

function updateOpenRouterProfilesStatus() {
  updateNamedApiProfilesStatus({
    providerId: 'openrouter',
    profileSettingsKey: 'openrouterProfiles',
    profileCountStateKey: 'openrouterProfileCount',
    statusText: openrouterProfileStatusText
  });
}

function updateThirdPartyProfilesStatus() {
  updateNamedApiProfilesStatus({
    providerId: 'thirdparty',
    profileSettingsKey: 'thirdPartyProfiles',
    profileCountStateKey: 'thirdPartyProfileCount',
    statusText: thirdPartyProfileStatusText
  });
}

function openrouterProfileErrorText(result) {
  if (result?.errorCode === 'invalidName') return t('settings.openrouter.invalidName');
  if (result?.errorCode === 'missingApiKey') return t('settings.openrouter.statusNotSet');
  return result?.error || t('settings.openrouter.saveFailedShort');
}

function thirdPartyProfileErrorText(result) {
  if (result?.errorCode === 'invalidName') return t('settings.thirdparty.invalidName');
  if (result?.errorCode === 'invalidAdapter') return t('settings.thirdparty.invalidAdapter');
  if (result?.errorCode === 'invalidBaseUrl') return t('settings.thirdparty.invalidBaseUrl');
  if (result?.errorCode === 'missingAccessToken') return t('settings.thirdparty.missingAccessToken');
  if (result?.errorCode === 'missingApiKey') return t('settings.thirdparty.missingApiKey');
  if (result?.errorCode === 'invalidEndpointPath') return t('settings.thirdparty.invalidEndpointPath');
  if (result?.errorCode === 'invalidAuthMode') return t('settings.thirdparty.invalidAuthMode');
  if (result?.errorCode === 'invalidJsonPath') return t('settings.thirdparty.invalidJsonPath');
  if (result?.errorCode === 'invalidCurrency') return t('settings.thirdparty.invalidCurrency');
  if (result?.errorCode === 'invalidDivisor') return t('settings.thirdparty.invalidDivisor');
  if (result?.errorCode === 'invalidCredential') return t('settings.thirdparty.invalidCredential');
  if (result?.errorCode === 'unavailable') return t('settings.thirdparty.unavailable');
  return result?.error || t('settings.thirdparty.saveFailedShort');
}

function appendNamedApiProfileRow(listEl, config) {
  const {
    api,
    providerId,
    name = '',
    profile = { enabled: true },
    env = false,
    rerender,
    updateStatus,
    errorText,
    detail = ''
  } = config;
  const item = document.createElement('div');
  item.className = 'opencode-profile-item';
  if (!env) {
    const toggle = document.createElement('input');
    toggle.className = 'profile-toggle';
    toggle.type = 'checkbox';
    toggle.checked = profile.enabled !== false;
    toggle.setAttribute('aria-label', name);
    toggle.addEventListener('change', async () => {
      const previousEnabled = profile.enabled !== false;
      profile.enabled = toggle.checked;
      toggle.disabled = true;
      updateStatus();
      try {
        const result = await api.setProfileEnabled(name, toggle.checked);
        if (!result?.ok) {
          toggle.checked = previousEnabled;
          profile.enabled = previousEnabled;
          updateStatus();
        }
      } catch (_) {
        toggle.checked = previousEnabled;
        profile.enabled = previousEnabled;
        updateStatus();
      } finally {
        toggle.disabled = false;
        renderSettingsSummaries();
      }
    });
    item.append(toggle);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'profile-toggle';
    spacer.setAttribute('aria-hidden', 'true');
    item.append(spacer);
  }

  const nameBox = document.createElement('span');
  nameBox.className = 'profile-name-box';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'profile-name';
  nameSpan.textContent = env ? t(`settings.${providerId}.environment`) : name;
  nameBox.append(nameSpan);
  if (detail) {
    const detailSpan = document.createElement('span');
    detailSpan.className = 'profile-detail';
    detailSpan.textContent = detail;
    detailSpan.title = detail;
    nameBox.append(detailSpan);
  }

  if (!env) {
    const nameInput = document.createElement('input');
    nameInput.className = 'profile-name-input hidden';
    nameInput.type = 'text';
    nameInput.value = name;
    const renameBtn = document.createElement('button');
    renameBtn.className = 'profile-rename-btn';
    renameBtn.textContent = '✎';
    renameBtn.title = t('settings.profiles.rename');
    let editing = false;
    const finishRename = async (save) => {
      if (!editing) return;
      editing = false;
      nameInput.classList.add('hidden');
      nameSpan.classList.remove('hidden');
      const nextName = nameInput.value.trim();
      if (save && nextName && nextName !== name) {
        const result = await api.renameProfile(name, nextName);
        if (result?.ok) {
          rerender();
        } else {
          nameInput.value = name;
          const errorEl = document.getElementById(`${providerId}ErrorMessage`);
          if (errorEl) {
            errorEl.textContent = errorText(result);
            errorEl.classList.remove('hidden');
          }
        }
      }
    };
    renameBtn.addEventListener('click', () => {
      editing = true;
      nameSpan.classList.add('hidden');
      nameInput.classList.remove('hidden');
      nameInput.focus();
      nameInput.select();
    });
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void finishRename(true);
      if (event.key === 'Escape') void finishRename(false);
    });
    nameInput.addEventListener('blur', () => void finishRename(true));
    nameBox.append(nameInput, renameBtn);
  }

  const rightBox = document.createElement('span');
  rightBox.className = 'profile-right';
  const info = document.createElement('span');
  info.className = 'profile-info';
  info.dataset.managedProfileProvider = providerId;
  if (env) info.dataset.managedProfileEnvironment = 'true';
  else info.dataset.managedProfileName = name;
  info.textContent = t(`settings.${providerId}.checking`);
  rightBox.append(info);

  if (!env) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'profile-delete';
    deleteBtn.textContent = '✕';
    deleteBtn.title = t('settings.profiles.delete');
    let confirming = false;
    deleteBtn.addEventListener('click', async () => {
      if (!confirming) {
        confirming = true;
        deleteBtn.classList.add('confirming');
        deleteBtn.textContent = '✓';
        deleteBtn.title = t('settings.profiles.deleteConfirm', { name });
        return;
      }
      const result = await api.deleteProfile(name);
      if (result?.ok) rerender();
    });
    rightBox.append(deleteBtn);
  }
  item.append(nameBox, rightBox);
  listEl.append(item);
}

function renderNamedApiProfiles(config) {
  const {
    providerId,
    profileSettingsKey,
    envConfiguredKey,
    profileCountStateKey,
    api,
    rerender,
    updateStatus,
    errorText,
    detailForProfile = () => ''
  } = config;
  const listEl = document.getElementById(`${providerId}ProfileList`);
  if (!listEl || !api) return;
  api.getProfiles().then(({ profiles, hasEnvVar }) => {
    listEl.replaceChildren();
    state.settings[profileSettingsKey] = profiles;
    state.settings[envConfiguredKey] = Boolean(hasEnvVar);
    const entries = Object.entries(profiles);
    state[profileCountStateKey] = entries.length + (hasEnvVar ? 1 : 0);
    if (state[profileCountStateKey] === 0) {
      const empty = document.createElement('div');
      empty.className = 'opencode-empty';
      empty.textContent = t(`settings.${providerId}.emptyList`);
      listEl.append(empty);
      updateStatus();
      renderSettingsSummaries();
      return;
    }

    for (const [name, profile] of entries) {
      appendNamedApiProfileRow(listEl, {
        api,
        providerId,
        name,
        profile,
        rerender,
        updateStatus,
        errorText,
        detail: detailForProfile(profile)
      });
    }
    if (hasEnvVar) {
      appendNamedApiProfileRow(listEl, {
        api,
        providerId,
        env: true,
        rerender,
        updateStatus,
        errorText
      });
    }
    updateStatus();
    renderSettingsSummaries();
  }).catch(() => {
    const statusEl = document.getElementById(`${providerId}Status`);
    if (statusEl) statusEl.textContent = t(`settings.${providerId}.unavailable`);
  });
}

function renderOpenRouterProfiles() {
  renderNamedApiProfiles({
    providerId: 'openrouter',
    profileSettingsKey: 'openrouterProfiles',
    envConfiguredKey: 'openrouterEnvConfigured',
    profileCountStateKey: 'openrouterProfileCount',
    api: window.tokenMonitor.openrouter,
    rerender: renderOpenRouterProfiles,
    updateStatus: updateOpenRouterProfilesStatus,
    errorText: openrouterProfileErrorText
  });
}

function renderThirdPartyProfiles() {
  renderNamedApiProfiles({
    providerId: 'thirdparty',
    profileSettingsKey: 'thirdPartyProfiles',
    envConfiguredKey: 'thirdPartyEnvConfigured',
    profileCountStateKey: 'thirdPartyProfileCount',
    api: window.tokenMonitor.thirdparty,
    rerender: renderThirdPartyProfiles,
    updateStatus: updateThirdPartyProfilesStatus,
    errorText: thirdPartyProfileErrorText,
    detailForProfile: (profile) => {
      const adapter = profile?.adapter === 'newapi-token'
        ? t('settings.thirdparty.detailNewApiKey')
        : profile?.adapter === 'custom'
          ? t('settings.thirdparty.detailCustom')
          : t('settings.thirdparty.detailNewApiAccount');
      let host = '';
      try { host = new URL(String(profile?.baseUrl || '')).host; } catch (_) {}
      return [adapter, host].filter(Boolean).join(' · ');
    }
  });
}

function renderCursorStatus() {
  const statusEl = document.getElementById('cursorAccountStatus');
  const loginBtn = document.getElementById('cursorLoginButton');
  const logoutBtn = document.getElementById('cursorLogoutButton');
  const refreshBtn = document.getElementById('cursorRefreshButton');
  const manualPanel = document.getElementById('cursorManualPanel');
  const errorEl = document.getElementById('cursorErrorMessage');
  if (!statusEl || !loginBtn || !logoutBtn || !refreshBtn || !manualPanel || !errorEl) return;

  errorEl.classList.add('hidden');
  errorEl.textContent = '';

  if (state.cursorAccount.error) {
    setCursorStatusText(statusEl, t('settings.common.error'));
    errorEl.textContent = t('settings.cursor.statusCheckFailed', { message: state.cursorAccount.error });
    errorEl.classList.remove('hidden');
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    refreshBtn.classList.remove('hidden');
    manualPanel.classList.remove('hidden');
    setCursorCheckboxesEnabled(false);
    setSettingsSectionExpanded('limits', true);
    setCursorAccountExpanded(true);
    renderSettingsSummaries();
    return;
  }

  const status = state.cursorAccount.status;
  if (!status) {
    setCursorStatusText(statusEl, t('settings.common.checking'));
    renderSettingsSummaries();
    return;
  }

  if (!status.loggedIn) {
    setCursorStatusText(statusEl, t('settings.cursor.notLoggedIn'));
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    refreshBtn.classList.add('hidden');
    manualPanel.classList.remove('hidden');
    setCursorCheckboxesEnabled(false);
    renderSettingsSummaries();
    return;
  }
  if (status.expired) {
    setCursorStatusText(statusEl, t('settings.cursor.expired'));
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
    refreshBtn.classList.remove('hidden');
    manualPanel.classList.remove('hidden');
    setCursorCheckboxesEnabled(false);
    setSettingsSectionExpanded('limits', true);
    setCursorAccountExpanded(true);
    renderSettingsSummaries();
    return;
  }
  const summary = status.email || t('settings.cursor.loggedIn');
  setCursorStatusText(statusEl, summary);
  loginBtn.classList.add('hidden');
  logoutBtn.classList.remove('hidden');
  refreshBtn.classList.remove('hidden');
  manualPanel.classList.add('hidden');
  setCursorCheckboxesEnabled(true);
  renderSettingsSummaries();
}

async function refreshCursorStatus() {
  state.cursorAccount = { status: null, error: '' };
  renderCursorStatus();
  try {
    const status = await window.tokenMonitor.cursor.status();
    state.cursorAccount = { status, error: '' };
  } catch (err) {
    state.cursorAccount = { status: null, error: err.message };
  }
  renderCursorStatus();
}

function setCursorCheckboxesEnabled(enabled) {
  const row = document.querySelector('#clientDisplayList .tool-preference-row[data-client="cursor"]');
  const input = row?.querySelector('input[data-preference="track"]');
  row?.classList.toggle('disabled', !enabled);
  if (input) {
    input.disabled = !enabled;
    input.title = enabled ? '' : t('settings.cursor.loginRequired');
  }
}

let openCustomPricingForm = null;

function customPricingMeta(ov) {
  const parts = [];
  if (typeof ov.cacheReadPerM === 'number') parts.push(`${t('settings.customPricing.cacheRead')} $${ov.cacheReadPerM}`);
  if (typeof ov.inputPerM === 'number') parts.push(`${t('settings.customPricing.input')} $${ov.inputPerM}`);
  if (typeof ov.outputPerM === 'number') parts.push(`${t('settings.customPricing.output')} $${ov.outputPerM}`);
  return parts.length ? `${parts.join(' · ')} / 1M` : '';
}

function renderCustomPricing() {
  const listEl = document.getElementById('customPricingList');
  const statusEl = document.getElementById('customPricingStatus');
  if (!listEl) return;
  const overrides = state.settings?.customModelPricing || [];
  if (statusEl) {
    statusEl.textContent = overrides.length
      ? t('settings.customPricing.count', { count: overrides.length })
      : t('settings.customPricing.none');
  }
  listEl.replaceChildren();
  if (overrides.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-note';
    empty.textContent = t('settings.customPricing.empty');
    listEl.append(empty);
    return;
  }
  for (const ov of overrides) {
    const row = document.createElement('div');
    row.className = 'managed-account-row custom-pricing-row';
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'managed-account-main custom-pricing-edit';
    main.title = t('settings.customPricing.edit');
    main.addEventListener('click', () => { if (openCustomPricingForm) openCustomPricingForm(ov); });
    const name = document.createElement('div');
    name.className = 'managed-account-email';
    name.textContent = ov.modelId;
    const meta = document.createElement('div');
    meta.className = 'managed-account-meta';
    meta.textContent = customPricingMeta(ov);
    main.append(name, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'managed-account-remove custom-pricing-remove';
    remove.textContent = t('settings.customPricing.remove');
    remove.addEventListener('click', async () => {
      const next = customPricingFormApi.removeOverride(state.settings?.customModelPricing || [], ov.modelId);
      await saveSettings({ customModelPricing: next });
      renderCustomPricing();
    });
    row.append(main, remove);
    listEl.append(row);
  }
}

function setupCustomPricingUI() {
  const toggle = document.getElementById('customPricingSettingsToggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => setAccountGroupExpanded('customPricing', !state.customPricingExpanded, 'customPricingExpanded'));
  setAccountGroupExpanded('customPricing', false, 'customPricingExpanded');

  const form = document.getElementById('customPricingForm');
  const addButton = document.getElementById('customPricingAddButton');
  const select = document.getElementById('customPricingModelSelect');
  const manualInput = document.getElementById('customPricingModelInput');
  const inputEl = document.getElementById('customPricingInput');
  const outputEl = document.getElementById('customPricingOutput');
  const cacheReadEl = document.getElementById('customPricingCacheRead');
  const hintEl = document.getElementById('customPricingHint');
  const errorEl = document.getElementById('customPricingError');
  const saveButton = document.getElementById('customPricingSaveButton');
  const cancelButton = document.getElementById('customPricingCancelButton');
  manualInput.placeholder = t('settings.customPricing.modelPlaceholder');

  const showHint = (text) => { hintEl.textContent = text || ''; };
  const showError = (text) => { errorEl.textContent = text || ''; errorEl.classList.toggle('hidden', !text); };
  const selectedModelId = () => (select.value === '__manual__' ? manualInput.value.trim() : select.value);

  const resetForm = () => {
    inputEl.value = ''; outputEl.value = ''; cacheReadEl.value = '';
    manualInput.value = ''; manualInput.classList.add('hidden');
    for (const id of ['customPricingInputApprox', 'customPricingOutputApprox', 'customPricingCacheReadApprox']) {
      const span = document.getElementById(id);
      if (span) span.textContent = '';
    }
    showHint(''); showError('');
  };

  const populateModels = () => {
    const ids = customPricingFormApi.inUseModelIds(state.stats);
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('settings.customPricing.selectModel');
    select.append(placeholder);
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      select.append(opt);
    }
    const manual = document.createElement('option');
    manual.value = '__manual__';
    manual.textContent = t('settings.customPricing.manualEntry');
    select.append(manual);
  };

  const closeForm = () => {
    form.classList.add('hidden');
    addButton.classList.remove('hidden');
    resetForm();
  };
  openCustomPricingForm = (prefill) => {
    resetForm();
    populateModels();
    if (prefill && prefill.modelId) {
      const hasOption = [...select.options].some((o) => o.value === prefill.modelId);
      if (hasOption) {
        select.value = prefill.modelId;
      } else {
        select.value = '__manual__';
        manualInput.classList.remove('hidden');
        manualInput.value = prefill.modelId;
      }
      inputEl.value = prefill.inputPerM ?? '';
      outputEl.value = prefill.outputPerM ?? '';
      cacheReadEl.value = prefill.cacheReadPerM ?? '';
      for (const el of [inputEl, outputEl, cacheReadEl]) el.dispatchEvent(new Event('input'));
    }
    form.classList.remove('hidden');
    addButton.classList.add('hidden');
  };

  addButton.addEventListener('click', () => openCustomPricingForm());
  cancelButton.addEventListener('click', closeForm);

  select.addEventListener('change', async () => {
    showError('');
    manualInput.classList.toggle('hidden', select.value !== '__manual__');
    if (!select.value || select.value === '__manual__') { showHint(''); return; }
    const id = select.value;
    showHint(t('settings.customPricing.lookingUp'));
    try {
      const res = await window.tokenMonitor.lookupModelPricing(id);
      if (res?.ok && res.result?.pricing) {
        const p = customPricingFormApi.perMillionFromPricing(res.result);
        if (p.inputPerM !== undefined) inputEl.value = p.inputPerM;
        if (p.outputPerM !== undefined) outputEl.value = p.outputPerM;
        if (p.cacheReadPerM !== undefined) cacheReadEl.value = p.cacheReadPerM;
        for (const el of [inputEl, outputEl, cacheReadEl]) el.dispatchEvent(new Event('input'));
        showHint(t('settings.customPricing.currentPrice', { key: res.result.matchedKey || id, source: res.result.source || '' }));
      } else {
        showHint(t('settings.customPricing.noCurrentPrice'));
      }
    } catch (_) {
      showHint(t('settings.customPricing.noCurrentPrice'));
    }
  });

  for (const el of [inputEl, outputEl, cacheReadEl]) {
    el.addEventListener('input', () => {
      const span = document.getElementById(el.id + 'Approx');
      if (!span) return;
      const v = Number(el.value);
      span.textContent = (el.value !== '' && Number.isFinite(v)) ? `≈ ${formatCost(v)} / 1M` : '';
    });
  }

  saveButton.addEventListener('click', async () => {
    showError('');
    const modelId = selectedModelId();
    if (!modelId) { showError(t('settings.customPricing.errorNoModel')); return; }
    const entry = {
      modelId,
      inputPerM: inputEl.value === '' ? undefined : Number(inputEl.value),
      outputPerM: outputEl.value === '' ? undefined : Number(outputEl.value),
      cacheReadPerM: cacheReadEl.value === '' ? undefined : Number(cacheReadEl.value)
    };
    if (!customPricingFormApi.hasUsableBasePrice(entry)) { showError(t('settings.customPricing.errorNoPrice')); return; }
    const next = customPricingFormApi.upsertOverride(state.settings?.customModelPricing || [], entry);
    await saveSettings({ customModelPricing: next });
    closeForm();
    renderCustomPricing();
  });

  renderCustomPricing();
}

function setupCursorAccountUI() {
  const codexToggle = document.getElementById('codexSettingsToggle');
  if (codexToggle) {
    codexToggle.addEventListener('click', () => setCodexAccountExpanded(!state.codexAccountExpanded));
    setCodexAccountExpanded(false);
    renderCodexAccounts();

    const codexAddButton = document.getElementById('codexAddAccountButton');
    const codexCancelButton = document.getElementById('codexCancelLoginButton');
    const codexOpenUrlButton = document.getElementById('codexOpenLoginUrlButton');
    const codexCopyUrlButton = document.getElementById('codexCopyLoginUrlButton');
    const codexWorkspaceSelect = document.getElementById('codexWorkspaceSelect');
    const codexConfirmWorkspaceButton = document.getElementById('codexConfirmWorkspaceButton');
    const codexLoginDetails = document.getElementById('codexLoginDetails');
    window.tokenMonitor.codex.onLoginStatus((status) => {
      if (!status || !isCurrentCodexSignInFlow(status.flowId)) return;
      if (status.phase === 'workspaceSelection') {
        state.codexWorkspaceChoices = Array.isArray(status.workspaces) ? status.workspaces : [];
        state.codexWorkspaceId = state.codexWorkspaceChoices.some((workspace) => workspace.id === status.currentWorkspaceId)
          ? status.currentWorkspaceId
          : state.codexWorkspaceChoices[0]?.id || '';
        state.codexLoginStatus = t('settings.codex.chooseWorkspace');
        renderCodexLoginStatus();
        return;
      }
      if (status.phase !== 'output') return;
      state.codexLoginOutput = (state.codexLoginOutput + String(status.text || '')).slice(-3000);
      if (status.loginUrl) state.codexLoginUrl = status.loginUrl;
      state.codexLoginStatus = t(state.codexLoginUrl ? 'settings.codex.loginWaiting' : 'settings.codex.loginStarting');
      renderCodexLoginStatus();
    });
    codexAddButton.addEventListener('click', async () => {
      if (state.codexSignInBusy) return;
      const flowId = nextCodexSignInFlowId();
      state.codexSignInFlowId = flowId;
      state.codexSignInBusy = true;
      state.codexLoginUrl = '';
      state.codexLoginOutput = '';
      state.codexWorkspaceChoices = [];
      state.codexWorkspaceId = '';
      state.codexLoginStatus = t('settings.codex.loginStarting');
      state.codexAccountError = '';
      if (codexLoginDetails) codexLoginDetails.open = false;
      renderCodexLoginStatus();
      renderCodexAccounts();
      try {
        const result = await window.tokenMonitor.codex.addAccount({ flowId });
        if (!isCurrentCodexSignInFlow(result?.flowId || flowId)) return;
        if (!result?.ok) {
          if (result?.outcome === 'cancelled') return;
          state.codexAccountError = result?.error || t('settings.codex.loginFailed');
          state.codexLoginStatus = t('settings.codex.loginFailed');
          if (codexLoginDetails && state.codexLoginOutput) codexLoginDetails.open = true;
          setCodexAccountExpanded(true);
        } else {
          state.codexAccountError = '';
          state.codexLoginStatus = t('settings.codex.loginSuccess');
          renderCodexLoginStatus();
          state.settings.codexManagedAccounts = await window.tokenMonitor.codex.accounts();
          await refreshStats({ force: true });
          state.codexLoginStatus = '';
          state.codexLoginOutput = '';
          state.codexWorkspaceChoices = [];
          state.codexWorkspaceId = '';
        }
      } catch (err) {
        if (!isCurrentCodexSignInFlow(flowId)) return;
        state.codexAccountError = err.message;
        state.codexLoginStatus = t('settings.codex.loginFailed');
        if (codexLoginDetails && state.codexLoginOutput) codexLoginDetails.open = true;
      } finally {
        if (isCurrentCodexSignInFlow(flowId)) {
          state.codexSignInBusy = false;
          state.codexSignInFlowId = '';
          state.codexLoginUrl = '';
          state.codexWorkspaceChoices = [];
          state.codexWorkspaceId = '';
          renderCodexLoginStatus();
          renderCodexAccounts();
        }
      }
    });

    codexCancelButton.addEventListener('click', async () => {
      const flowId = state.codexSignInFlowId;
      if (!isCurrentCodexSignInFlow(flowId)) return;
      const result = await window.tokenMonitor.codex.cancelLogin({ flowId });
      if (!result?.cancelled || !isCurrentCodexSignInFlow(flowId)) return;
      state.codexSignInBusy = false;
      state.codexSignInFlowId = '';
      state.codexLoginUrl = '';
      state.codexLoginStatus = '';
      state.codexLoginOutput = '';
      state.codexWorkspaceChoices = [];
      state.codexWorkspaceId = '';
      state.codexAccountError = '';
      if (codexLoginDetails) codexLoginDetails.open = false;
      renderCodexLoginStatus();
      renderCodexAccounts();
    });

    codexWorkspaceSelect.addEventListener('change', () => {
      state.codexWorkspaceId = codexWorkspaceSelect.value;
    });

    codexConfirmWorkspaceButton.addEventListener('click', async () => {
      const flowId = state.codexSignInFlowId;
      const workspaceId = state.codexWorkspaceId;
      if (!isCurrentCodexSignInFlow(flowId) || !workspaceId) return;
      codexConfirmWorkspaceButton.disabled = true;
      try {
        const result = await window.tokenMonitor.codex.selectWorkspace({ flowId, workspaceId });
        if (!result?.ok || !isCurrentCodexSignInFlow(flowId)) return;
        state.codexWorkspaceChoices = [];
        state.codexWorkspaceId = '';
        state.codexLoginStatus = t('settings.codex.loginLoadingAccount');
        renderCodexLoginStatus();
      } finally {
        codexConfirmWorkspaceButton.disabled = false;
      }
    });

    codexOpenUrlButton.addEventListener('click', async () => {
      if (!state.codexLoginUrl) return;
      const result = await window.tokenMonitor.openExternal(state.codexLoginUrl);
      if (!result?.ok) {
        state.codexAccountError = result?.error || t('settings.codex.openLoginUrlFailed');
        renderCodexAccounts();
      }
    });

    codexCopyUrlButton.addEventListener('click', () => {
      if (state.codexLoginUrl) copyToClipboard(state.codexLoginUrl, codexCopyUrlButton);
    });

    renderCodexLoginStatus();

    document.getElementById('codexRefreshAccountsButton').addEventListener('click', () => {
      refreshCodexAccounts();
    });
  }

  document.getElementById('cursorSettingsToggle').addEventListener('click', () => {
    setCursorAccountExpanded(!state.cursorAccountExpanded);
  });
  setCursorAccountExpanded(false);

  document.getElementById('cursorLoginButton').addEventListener('click', () => {
    window.tokenMonitor.openExternal('https://cursor.com/settings');
  });

  document.getElementById('cursorLogoutButton').addEventListener('click', async () => {
    await window.tokenMonitor.cursor.logout();
    await refreshCursorStatus();
    await refreshStats({ force: true });
  });

  document.getElementById('cursorRefreshButton').addEventListener('click', () => {
    refreshCursorStatus();
  });

  document.getElementById('cursorManualSubmit').addEventListener('click', async () => {
    const input = document.getElementById('cursorManualInput');
    const errorEl = document.getElementById('cursorErrorMessage');
    errorEl.classList.add('hidden');
    const result = await window.tokenMonitor.cursor.loginManual(input.value);
    if (!result.ok) {
      errorEl.textContent = t('settings.cursor.loginFailed', { message: result.error });
      errorEl.classList.remove('hidden');
      return;
    }
    input.value = '';
    await refreshCursorStatus();
    setCursorAccountExpanded(false);
    await refreshStats({ force: true });
  });

  refreshCursorStatus();

  const opencodeToggle = document.getElementById('opencodeSettingsToggle');
  if (opencodeToggle) {
    opencodeToggle.addEventListener('click', () => {
      const expanding = document.getElementById('opencodeSettingsDetails').classList.contains('hidden');
      setOpencodeCookieExpanded(expanding);
      if (expanding) renderOpenCodeProfiles();
    });

    const addToggle = document.getElementById('opencodeAddToggle');
    const addDetails = document.getElementById('opencodeAddDetails');
    function setOpenCodeAddExpanded(expanded) {
      const next = Boolean(expanded);
      addToggle?.setAttribute('aria-expanded', next ? 'true' : 'false');
      addDetails?.classList.toggle('hidden', !next);
      document.getElementById('opencodeAddForm')?.classList.toggle('expanded', next);
    }
    addToggle?.addEventListener('click', () => setOpenCodeAddExpanded(addDetails?.classList.contains('hidden')));

    document.getElementById('opencodeOpenBrowser')?.addEventListener('click', () => {
      window.tokenMonitor.openExternal('https://opencode.ai/auth');
    });

    // API key is the default: it needs no browser round trip. The cookie stays
    // selectable because it is the only thing that reaches the Zen balance.
    const kindSelect = document.getElementById('opencodeCredentialKind');
    // The merge confirmation is about one specific proposal: this name, this
    // credential. Editing any part of the form makes the offer on screen stale,
    // and a confirmation the user gives has to be a confirmation of what they
    // are looking at, so any edit withdraws it.
    const addMergeButton = document.getElementById('opencodeCredentialMerge');
    // Confirming re-runs the submit handler's own closure, which is what holds
    // the name and credential the offer was made for.
    let confirmOpenCodeMerge = () => {};
    const addMergeOffer = addMergeButton
      ? opencodeMergeOffer(addMergeButton, () => confirmOpenCodeMerge())
      : null;
    const clearOpenCodeMergeOffer = () => addMergeOffer?.withdraw();
    for (const id of ['opencodeProfileName', 'opencodeApiKeyInput', 'opencodeCookieInput']) {
      document.getElementById(id)?.addEventListener('input', clearOpenCodeMergeOffer);
    }
    const applyOpenCodeCredentialKind = () => {
      const isCookie = kindSelect?.value === 'cookie';
      document.getElementById('opencodeApiFields')?.classList.toggle('hidden', isCookie);
      document.getElementById('opencodeCookieFields')?.classList.toggle('hidden', !isCookie);
      // One button for both modes; only what it is fetching differs. The keys
      // page itself lives under a workspace id we do not have, so both land on
      // the console sign-in.
      const browserButton = document.getElementById('opencodeOpenBrowser');
      if (browserButton) {
        const key = isCookie ? 'settings.opencode.openBrowser' : 'settings.opencode.openBrowserKeys';
        browserButton.dataset.i18n = key;
        browserButton.textContent = t(key);
      }
      // Clear the field being hidden so a value typed under one credential type
      // can never be submitted as the other.
      const stale = document.getElementById(isCookie ? 'opencodeApiKeyInput' : 'opencodeCookieInput');
      if (stale) stale.value = '';
      document.getElementById('opencodeErrorMessage')?.classList.add('hidden');
      clearOpenCodeMergeOffer();
    };
    kindSelect?.addEventListener('change', applyOpenCodeCredentialKind);
    applyOpenCodeCredentialKind();

    document.getElementById('opencodeCookieSubmit').addEventListener('click', async () => {
      const opencodeCredentialKind = kindSelect?.value === 'cookie' ? 'cookie' : 'api';
      const input = document.getElementById(opencodeCredentialKind === 'cookie'
        ? 'opencodeCookieInput'
        : 'opencodeApiKeyInput');
      const nameInput = document.getElementById('opencodeProfileName');
      const errorEl = document.getElementById('opencodeErrorMessage');
      const name = (nameInput.value || '').trim();
      const cookie = input.value;

      errorEl.classList.add('hidden');

      // The name is required rather than defaulted. Saving one credential keeps
      // the other under the same name, and the collector reads that as "these
      // are the same account", so a blank name silently becoming `default`
      // could attach one account's key to another account's cookie. Making the
      // user type the name is what keeps the association explicit.
      if (!name) {
        errorEl.textContent = t('settings.opencode.nameRequired');
        errorEl.classList.remove('hidden');
        nameInput.focus();
        return;
      }

      // A name that already holds a different credential kind binds the two into
      // one account, so the main process refuses it and the form asks first.
      // The confirmation replaces the submit button rather than appearing beside
      // it: the next click has different consequences from the one just made.
      const submit = async (merge) => {
        const at = addMergeOffer?.revision();
        confirmOpenCodeMerge = () => submit(true);
        const result = await window.tokenMonitor.opencode.saveProfile(
          name,
          cookie,
          opencodeCredentialKind,
          { merge }
        );
        // Whether or not the form still shows this proposal, a save that landed
        // has to reach the list. Only the fields are left alone, so an edit made
        // while the request was in flight is not wiped by its reply.
        const stale = addMergeOffer ? addMergeOffer.stale(at) : false;
        if (result.ok) {
          // Only this proposal's own offer is taken down. Two saves can overlap,
          // and the newer one can answer first: clearing unconditionally let an
          // older success wipe a merge confirmation the user was looking at and
          // that was still correct.
          if (!stale) {
            input.value = '';
            nameInput.value = '';
            addMergeOffer?.withdraw();
          }
          renderOpenCodeProfiles();
          updateOpenCodeProfilesStatus();
          renderSettingsSummaries();
          return;
        }
        if (stale) return;
        if (result.nameTaken && addMergeOffer) {
          addMergeOffer.offer(at, name, t('settings.opencode.mergeInto', { name }));
          return;
        }
        errorEl.textContent = opencodeSaveErrorText(result);
        errorEl.classList.remove('hidden');
      };
      await submit(false);
    });
  }

  const openrouterToggle = document.getElementById('openrouterSettingsToggle');
  if (openrouterToggle) {
    openrouterToggle.addEventListener('click', () => {
      const expanding = !state.openrouterAccountExpanded;
      setOpenrouterAccountExpanded(expanding);
      if (expanding) renderOpenRouterProfiles();
    });
    setOpenrouterAccountExpanded(false);

    const addToggle = document.getElementById('openrouterAddToggle');
    const addDetails = document.getElementById('openrouterAddDetails');
    addToggle?.addEventListener('click', () => {
      const expanded = addDetails?.classList.contains('hidden');
      addToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      addDetails?.classList.toggle('hidden', !expanded);
      document.getElementById('openrouterAddForm')?.classList.toggle('expanded', expanded);
    });
    document.getElementById('openrouterOpenBrowser')?.addEventListener('click', () => {
      window.tokenMonitor.openExternal('https://openrouter.ai/settings/keys');
    });
    document.getElementById('openrouterProfileSubmit')?.addEventListener('click', async () => {
      const nameInput = document.getElementById('openrouterProfileName');
      const keyInput = document.getElementById('openrouterApiKeyInput');
      const errorEl = document.getElementById('openrouterErrorMessage');
      const name = String(nameInput?.value || '').trim() || 'default';
      const apiKey = String(keyInput?.value || '').trim();
      errorEl?.classList.add('hidden');
      if (!apiKey) {
        if (errorEl) {
          errorEl.textContent = t('settings.openrouter.statusNotSet');
          errorEl.classList.remove('hidden');
        }
        return;
      }
      const result = await window.tokenMonitor.openrouter.saveProfile(name, apiKey);
      if (result?.ok) {
        nameInput.value = '';
        keyInput.value = '';
        renderOpenRouterProfiles();
        await refreshStats({ force: true });
      } else if (errorEl) {
        errorEl.textContent = openrouterProfileErrorText(result);
        errorEl.classList.remove('hidden');
      }
    });
  }

  const thirdpartyToggle = document.getElementById('thirdpartySettingsToggle');
  if (thirdpartyToggle) {
    thirdpartyToggle.addEventListener('click', () => {
      const expanding = !state.thirdPartyAccountExpanded;
      setThirdPartyAccountExpanded(expanding);
      if (expanding) renderThirdPartyProfiles();
    });
    setThirdPartyAccountExpanded(false);

    const addToggle = document.getElementById('thirdpartyAddToggle');
    const addDetails = document.getElementById('thirdpartyAddDetails');
    const platformInput = document.getElementById('thirdpartyPlatformInput');
    const modeInput = document.getElementById('thirdpartyModeInput');
    const baseUrlInput = document.getElementById('thirdpartyBaseUrlInput');
    platformInput?.addEventListener('change', setThirdPartyAdapterFields);
    modeInput?.addEventListener('change', setThirdPartyAdapterFields);
    baseUrlInput?.addEventListener('input', updateThirdPartyHttpWarning);
    setThirdPartyAdapterFields();
    updateThirdPartyHttpWarning();
    addToggle?.addEventListener('click', () => {
      const expanded = addDetails?.classList.contains('hidden');
      addToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      addDetails?.classList.toggle('hidden', !expanded);
      document.getElementById('thirdpartyAddForm')?.classList.toggle('expanded', expanded);
    });
    document.getElementById('thirdpartyProfileSubmit')?.addEventListener('click', async () => {
      const nameInput = document.getElementById('thirdpartyProfileName');
      const accessTokenInput = document.getElementById('thirdpartyAccessTokenInput');
      const userIdInput = document.getElementById('thirdpartyUserIdInput');
      const keyInput = document.getElementById('thirdpartyApiKeyInput');
      const endpointPathInput = document.getElementById('thirdpartyEndpointPathInput');
      const authModeInput = document.getElementById('thirdpartyAuthModeInput');
      const remainingPathInput = document.getElementById('thirdpartyRemainingPathInput');
      const usedPathInput = document.getElementById('thirdpartyUsedPathInput');
      const totalPathInput = document.getElementById('thirdpartyTotalPathInput');
      const currencyInput = document.getElementById('thirdpartyCurrencyInput');
      const divisorInput = document.getElementById('thirdpartyDivisorInput');
      const errorEl = document.getElementById('thirdpartyErrorMessage');
      const name = String(nameInput?.value || '').trim() || 'default';
      const adapter = selectedThirdPartyAdapter();
      const baseUrl = String(baseUrlInput?.value || '').trim();
      const accessToken = String(accessTokenInput?.value || '').trim();
      const userId = String(userIdInput?.value || '').trim();
      const apiKey = String(keyInput?.value || '').trim();
      errorEl?.classList.add('hidden');
      const result = await window.tokenMonitor.thirdparty.saveProfile({
        name,
        adapter,
        baseUrl,
        accessToken,
        userId,
        apiKey,
        endpointPath: String(endpointPathInput?.value || '').trim(),
        authMode: String(authModeInput?.value || '').trim(),
        remainingPath: String(remainingPathInput?.value || '').trim(),
        usedPath: String(usedPathInput?.value || '').trim(),
        totalPath: String(totalPathInput?.value || '').trim(),
        currency: String(currencyInput?.value || '').trim(),
        divisor: String(divisorInput?.value || '').trim()
      });
      if (result?.ok) {
        nameInput.value = '';
        baseUrlInput.value = '';
        updateThirdPartyHttpWarning();
        accessTokenInput.value = '';
        userIdInput.value = '';
        keyInput.value = '';
        endpointPathInput.value = '/user/balance';
        authModeInput.value = 'bearer';
        remainingPathInput.value = '';
        usedPathInput.value = '';
        totalPathInput.value = '';
        currencyInput.value = 'USD';
        divisorInput.value = '1';
        renderThirdPartyProfiles();
        await refreshStats({ force: true });
      } else if (errorEl) {
        errorEl.textContent = thirdPartyProfileErrorText(result);
        errorEl.classList.remove('hidden');
      }
    });
  }

  const deepseekToggle = document.getElementById('deepseekSettingsToggle');
  if (deepseekToggle) {
    deepseekToggle.addEventListener('click', () => setDeepseekAccountExpanded(!state.deepseekAccountExpanded));
    setDeepseekAccountExpanded(false);
    renderDeepseekStatus();

    document.getElementById('deepseekOpenBrowser').addEventListener('click', () => {
      window.tokenMonitor.openExternal('https://platform.deepseek.com/api_keys');
    });

    document.getElementById('deepseekLogoutButton').addEventListener('click', async () => {
      await saveSettings({ deepseekApiKey: '' });
      clearDeepseekPendingCheck();
      clearDeepseekProviderStatus();
      renderDeepseekStatus();
      await refreshStats({ force: true });
    });

    document.getElementById('deepseekRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });

    document.getElementById('deepseekApiKeySubmit').addEventListener('click', async () => {
      const input = document.getElementById('deepseekApiKeyInput');
      const errorEl = document.getElementById('deepseekErrorMessage');
      errorEl.classList.add('hidden');
      if (!String(input.value || '').trim()) {
        errorEl.textContent = t('settings.deepseek.statusNotSet');
        errorEl.classList.remove('hidden');
        return;
      }
      try {
        markDeepseekKeyCheckPending();
        await saveSettings({ deepseekApiKey: input.value });
        input.value = '';
        renderDeepseekStatus();
        await refreshStats({ force: true });
        if (deepseekAccountLinked()) setDeepseekAccountExpanded(false);
        else setDeepseekAccountExpanded(true);
        renderDeepseekStatus();
      } catch (err) {
        clearDeepseekPendingCheck();
        errorEl.textContent = t('settings.deepseek.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      }
    });
  }
  const minimaxToggle = document.getElementById('minimaxSettingsToggle');
  if (minimaxToggle) {
    minimaxToggle.addEventListener('click', () => setMinimaxAccountExpanded(!state.minimaxAccountExpanded));
    setMinimaxAccountExpanded(false);
    renderMinimaxStatus();

    document.getElementById('minimaxOpenBrowser').addEventListener('click', () => {
      window.tokenMonitor.openExternal(minimaxPlatformUrl());
    });

    document.getElementById('minimaxLogoutButton').addEventListener('click', async () => {
      await saveSettings({ minimaxApiKey: '' });
      clearMinimaxPendingCheck();
      clearMinimaxProviderStatus();
      renderMinimaxStatus();
      await refreshStats({ force: true });
    });

    document.getElementById('minimaxRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });

    document.getElementById('minimaxApiKeySubmit').addEventListener('click', async () => {
      const input = document.getElementById('minimaxApiKeyInput');
      const errorEl = document.getElementById('minimaxErrorMessage');
      errorEl.classList.add('hidden');
      if (!String(input.value || '').trim()) {
        errorEl.textContent = t('settings.minimax.statusNotSet');
        errorEl.classList.remove('hidden');
        return;
      }
      try {
        markMinimaxKeyCheckPending();
        await saveSettings({ minimaxApiKey: input.value });
        input.value = '';
        renderMinimaxStatus();
        await refreshStats({ force: true });
        if (minimaxAccountLinked()) setMinimaxAccountExpanded(false);
        else setMinimaxAccountExpanded(true);
        renderMinimaxStatus();
      } catch (err) {
        clearMinimaxPendingCheck();
        errorEl.textContent = t('settings.minimax.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      }
    });
  }

  const zaiToggle = document.getElementById('zaiSettingsToggle');
  if (zaiToggle) {
    const zaiApiRegionInput = document.getElementById('zaiApiRegionInput');
    if (zaiApiRegionInput) zaiApiRegionInput.value = state.settings?.zaiApiRegion === 'bigmodel-cn' ? 'bigmodel-cn' : 'global';
    zaiApiRegionInput?.addEventListener('change', () => void saveSettings({ zaiApiRegion: zaiApiRegionInput.value || 'global' }));
    zaiToggle.addEventListener('click', () => setExternalAccountExpanded('zai', !state.zaiAccountExpanded));
    setExternalAccountExpanded('zai', false);
    renderExternalProviderStatus('zai');

    document.getElementById('zaiOpenBrowser').addEventListener('click', () => {
      window.tokenMonitor.openExternal(zaiPlatformUrl());
    });

    document.getElementById('zaiLogoutButton').addEventListener('click', async () => {
      await saveSettings({ zaiApiKey: '' });
      clearExternalProviderCheckPending('zai');
      clearExternalProviderPendingStatus('zai');
      renderExternalProviderStatus('zai');
      await refreshStats({ force: true });
    });

    document.getElementById('zaiRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });

    document.getElementById('zaiApiKeySubmit').addEventListener('click', async () => {
      const input = document.getElementById('zaiApiKeyInput');
      const regionInput = document.getElementById('zaiApiRegionInput');
      const errorEl = document.getElementById('zaiErrorMessage');
      errorEl.classList.add('hidden');
      if (!String(input.value || '').trim()) {
        errorEl.textContent = t('settings.zai.statusNotSet');
        errorEl.classList.remove('hidden');
        return;
      }
      try {
        markExternalProviderCheckPending('zai');
        await saveSettings({ zaiApiKey: input.value, zaiApiRegion: regionInput?.value || 'global' });
        input.value = '';
        renderExternalProviderStatus('zai');
        await refreshStats({ force: true });
        setExternalAccountExpanded('zai', !externalProviderAccountLinked('zai'));
        renderExternalProviderStatus('zai');
      } catch (err) {
        clearExternalProviderCheckPending('zai');
        errorEl.textContent = t('settings.zai.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      }
    });
  }

  const zaiteamToggle = document.getElementById('zaiteamSettingsToggle');
  if (zaiteamToggle) {
    zaiteamToggle.addEventListener('click', () => setExternalAccountExpanded('zaiteam', !state.zaiteamAccountExpanded));
    setExternalAccountExpanded('zaiteam', false);
    renderExternalProviderStatus('zaiteam');

    document.getElementById('zaiteamOpenBrowser').addEventListener('click', () => {
      window.tokenMonitor.openExternal(zaiteamPlatformUrl());
    });

    document.getElementById('zaiteamLogoutButton').addEventListener('click', async () => {
      await saveSettings({ zaiTeamApiKey: '', zaiTeamOrganizationId: '', zaiTeamProjectId: '' });
      clearExternalProviderCheckPending('zaiteam');
      clearExternalProviderPendingStatus('zaiteam');
      renderExternalProviderStatus('zaiteam');
      await refreshStats({ force: true });
    });

    document.getElementById('zaiteamRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });

    document.getElementById('zaiteamApiKeySubmit').addEventListener('click', async () => {
      const keyInput = document.getElementById('zaiteamApiKeyInput');
      const orgInput = document.getElementById('zaiteamOrganizationIdInput');
      const projectInput = document.getElementById('zaiteamProjectIdInput');
      const errorEl = document.getElementById('zaiteamErrorMessage');
      errorEl.classList.add('hidden');
      const apiKey = String(keyInput.value || '').trim();
      const organizationId = String(orgInput.value || '').trim();
      const projectId = String(projectInput.value || '').trim();
      if (!apiKey || !organizationId || !projectId) {
        errorEl.textContent = t('settings.zaiteam.statusNotSet');
        errorEl.classList.remove('hidden');
        return;
      }
      try {
        markExternalProviderCheckPending('zaiteam');
        await saveSettings({ zaiTeamApiKey: apiKey, zaiTeamOrganizationId: organizationId, zaiTeamProjectId: projectId });
        keyInput.value = '';
        orgInput.value = '';
        projectInput.value = '';
        renderExternalProviderStatus('zaiteam');
        await refreshStats({ force: true });
        setExternalAccountExpanded('zaiteam', !externalProviderAccountLinked('zaiteam'));
        renderExternalProviderStatus('zaiteam');
      } catch (err) {
        clearExternalProviderCheckPending('zaiteam');
        errorEl.textContent = t('settings.zaiteam.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      }
    });
  }

  const volcengineToggle = document.getElementById('volcengineSettingsToggle');
  if (volcengineToggle) {
    volcengineToggle.addEventListener('click', () => setExternalAccountExpanded('volcengine', !state.volcengineAccountExpanded));
    setExternalAccountExpanded('volcengine', false);
    renderExternalProviderStatus('volcengine');

    document.getElementById('volcengineOpenBrowser').addEventListener('click', () => {
      window.tokenMonitor.openExternal(volcenginePlatformUrl());
    });

    document.getElementById('volcengineLogoutButton').addEventListener('click', async () => {
      await saveSettings({ volcengineAccessKeyId: '', volcengineSecretAccessKey: '', volcengineRegion: '' });
      clearExternalProviderCheckPending('volcengine');
      clearExternalProviderPendingStatus('volcengine');
      renderExternalProviderStatus('volcengine');
      await refreshStats({ force: true });
    });

    document.getElementById('volcengineRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });

    document.getElementById('volcengineCredentialsSubmit').addEventListener('click', async () => {
      const accessKeyInput = document.getElementById('volcengineAccessKeyInput');
      const secretInput = document.getElementById('volcengineSecretAccessKeyInput');
      const regionInput = document.getElementById('volcengineRegionInput');
      const errorEl = document.getElementById('volcengineErrorMessage');
      errorEl.classList.add('hidden');
      const accessKeyValue = String(accessKeyInput.value || '').trim();
      const secretValue = String(secretInput.value || '').trim();
      if (!accessKeyValue || (/^AKLT/i.test(accessKeyValue) && !secretValue)) {
        errorEl.textContent = t('settings.volcengine.statusNotSet');
        errorEl.classList.remove('hidden');
        return;
      }
      try {
        markExternalProviderCheckPending('volcengine');
        await saveSettings({
          volcengineAccessKeyId: accessKeyInput.value,
          volcengineSecretAccessKey: secretInput.value,
          volcengineRegion: regionInput.value || 'cn-beijing'
        });
        accessKeyInput.value = '';
        secretInput.value = '';
        renderExternalProviderStatus('volcengine');
        await refreshStats({ force: true });
        setExternalAccountExpanded('volcengine', !externalProviderAccountLinked('volcengine'));
        renderExternalProviderStatus('volcengine');
      } catch (err) {
        clearExternalProviderCheckPending('volcengine');
        errorEl.textContent = t('settings.volcengine.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      }
    });
  }

  const claudeToggle = document.getElementById('claudeSettingsToggle');
  if (claudeToggle) {
    claudeToggle.addEventListener('click', () => setExternalAccountExpanded('claude', !state.claudeAccountExpanded));
    setExternalAccountExpanded('claude', false);
    renderExternalProviderStatus('claude');

    document.getElementById('claudeOpenBrowser').addEventListener('click', () => {
      window.tokenMonitor.openExternal(claudePlatformUrl());
    });

    document.getElementById('claudeLogoutButton').addEventListener('click', async () => {
      await saveSettings({ claudeWebCookie: '' });
      clearExternalProviderCheckPending('claude');
      clearExternalProviderPendingStatus('claude');
      renderExternalProviderStatus('claude');
      await refreshStats({ force: true });
    });

    document.getElementById('claudeRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });

    document.getElementById('claudeWebCookieSubmit').addEventListener('click', async () => {
      const input = document.getElementById('claudeWebCookieInput');
      const submitButton = document.getElementById('claudeWebCookieSubmit');
      const errorEl = document.getElementById('claudeErrorMessage');
      errorEl.classList.add('hidden');
      if (!String(input.value || '').trim()) {
        errorEl.textContent = t('settings.claude.cookieRequired');
        errorEl.classList.remove('hidden');
        return;
      }
      if (/[\r\n]/.test(input.value)) {
        errorEl.textContent = t('settings.claude.cookieInvalidFormat');
        errorEl.classList.remove('hidden');
        return;
      }
      if (submitButton.disabled) return;
      submitButton.disabled = true;
      submitButton.textContent = t('settings.common.checking');
      try {
        const result = await window.tokenMonitor.claude.saveCookie(input.value);
        if (result?.superseded) return;
        if (!result?.ok) {
          if (result?.errorCode === 'INVALID_CLAUDE_WEB_SESSION_KEY') {
            errorEl.textContent = t('settings.claude.cookieInvalidFormat');
          } else if (result?.errorCode === 'CLAUDE_WEB_SOURCE_CHALLENGE') {
            errorEl.textContent = t('settings.claude.sourceChallenge');
          } else if (result?.status === 'unauthorized') {
            errorEl.textContent = t('settings.claude.cookieRejected');
          } else {
            errorEl.textContent = t('settings.claude.cookieCheckFailed');
          }
          errorEl.classList.remove('hidden');
          return;
        }
        markExternalProviderCheckPending('claude');
        await saveSettings({
          limitProviders: limitProviderSelectionIncluding('claude'),
          limitsEnabled: true
        });
        input.value = '';
        renderExternalProviderStatus('claude');
        await refreshStats({ force: true });
        setExternalAccountExpanded('claude', !externalProviderAccountLinked('claude'));
        renderExternalProviderStatus('claude');
      } catch (err) {
        clearExternalProviderCheckPending('claude');
        errorEl.textContent = t('settings.claude.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = t('settings.claude.saveCookie');
      }
    });
  }

  const qoderToggle = document.getElementById('qoderSettingsToggle');
  if (qoderToggle) {
    qoderToggle.addEventListener('click', () => setExternalAccountExpanded('qoder', !state.qoderAccountExpanded));
    setExternalAccountExpanded('qoder', false);
    renderExternalProviderStatus('qoder');

    const qoderSiteInput = document.getElementById('qoderSiteInput');
    if (qoderSiteInput) qoderSiteInput.value = state.settings?.qoderSite === 'cn' ? 'cn' : 'global';
    updateQoderUsagePageHint();
    qoderSiteInput?.addEventListener('change', () => {
      updateQoderUsagePageHint();
      void saveSettings({ qoderSite: qoderSiteInput.value || 'global' });
    });

    document.getElementById('qoderOpenBrowser').addEventListener('click', () => {
      window.tokenMonitor.openExternal(qoderPlatformUrl());
    });

    document.getElementById('qoderLogoutButton').addEventListener('click', async () => {
      await saveSettings({ qoderCookie: '' });
      clearExternalProviderCheckPending('qoder');
      clearExternalProviderPendingStatus('qoder');
      renderExternalProviderStatus('qoder');
      await refreshStats({ force: true });
    });

    document.getElementById('qoderRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });

    document.getElementById('qoderCookieSubmit').addEventListener('click', async () => {
      const input = document.getElementById('qoderCookieInput');
      const siteInput = document.getElementById('qoderSiteInput');
      const errorEl = document.getElementById('qoderErrorMessage');
      errorEl.classList.add('hidden');
      if (!String(input.value || '').trim()) {
        errorEl.textContent = t('settings.qoder.statusNotSet');
        errorEl.classList.remove('hidden');
        return;
      }
      try {
        markExternalProviderCheckPending('qoder');
        await saveSettings({ qoderCookie: input.value, qoderSite: siteInput?.value || 'global' });
        input.value = '';
        renderExternalProviderStatus('qoder');
        await refreshStats({ force: true });
        setExternalAccountExpanded('qoder', !externalProviderAccountLinked('qoder'));
        renderExternalProviderStatus('qoder');
      } catch (err) {
        clearExternalProviderCheckPending('qoder');
        errorEl.textContent = t('settings.qoder.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      }
    });
  }

  const commandcodeToggle = document.getElementById('commandcodeSettingsToggle');
  if (commandcodeToggle) {
    commandcodeToggle.addEventListener('click', () => setExternalAccountExpanded('commandcode', !state.commandcodeAccountExpanded));
    setExternalAccountExpanded('commandcode', false);
    renderExternalProviderStatus('commandcode');

    document.getElementById('commandcodeOpenBrowser').addEventListener('click', () => {
      window.tokenMonitor.openExternal(commandcodePlatformUrl());
    });

    document.getElementById('commandcodeLogoutButton').addEventListener('click', async () => {
      await saveSettings({ commandcodeCookie: '' });
      clearExternalProviderCheckPending('commandcode');
      clearExternalProviderPendingStatus('commandcode');
      renderExternalProviderStatus('commandcode');
      await refreshStats({ force: true });
    });

    document.getElementById('commandcodeRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });

    document.getElementById('commandcodeCookieSubmit').addEventListener('click', async () => {
      const input = document.getElementById('commandcodeCookieInput');
      const errorEl = document.getElementById('commandcodeErrorMessage');
      errorEl.classList.add('hidden');
      if (!String(input.value || '').trim()) {
        errorEl.textContent = t('settings.commandcode.statusNotSet');
        errorEl.classList.remove('hidden');
        return;
      }
      try {
        markExternalProviderCheckPending('commandcode');
        await saveSettings({
          commandcodeCookie: input.value,
          limitProviders: limitProviderSelectionIncluding('commandcode'),
          limitsEnabled: true
        });
        input.value = '';
        renderExternalProviderStatus('commandcode');
        await refreshStats({ force: true });
        setExternalAccountExpanded('commandcode', !externalProviderAccountLinked('commandcode'));
        renderExternalProviderStatus('commandcode');
      } catch (err) {
        clearExternalProviderCheckPending('commandcode');
        errorEl.textContent = t('settings.commandcode.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      }
    });
  }

  const ollamaToggle = document.getElementById('ollamaSettingsToggle');
  if (ollamaToggle) {
    ollamaToggle.addEventListener('click', () => setExternalAccountExpanded('ollama', !state.ollamaAccountExpanded));
    setExternalAccountExpanded('ollama', false);
    renderExternalProviderStatus('ollama');

    document.getElementById('ollamaOpenBrowser').addEventListener('click', () => {
      window.tokenMonitor.openExternal(ollamaPlatformUrl());
    });
    document.getElementById('ollamaLogoutButton').addEventListener('click', async () => {
      await saveSettings({ ollamaCookie: '' });
      clearExternalProviderCheckPending('ollama');
      clearExternalProviderPendingStatus('ollama');
      renderExternalProviderStatus('ollama');
      await refreshStats({ force: true });
    });
    document.getElementById('ollamaRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });
    document.getElementById('ollamaCookieSubmit').addEventListener('click', async () => {
      const input = document.getElementById('ollamaCookieInput');
      const errorEl = document.getElementById('ollamaErrorMessage');
      errorEl.classList.add('hidden');
      if (!String(input.value || '').trim()) {
        errorEl.textContent = t('settings.ollama.statusNotSet');
        errorEl.classList.remove('hidden');
        return;
      }
      try {
        markExternalProviderCheckPending('ollama');
        renderExternalProviderStatus('ollama');
        const validation = await window.tokenMonitor.ollama.validateCookie(input.value);
        if (!validation?.ok) {
          clearExternalProviderCheckPending('ollama');
          renderExternalProviderStatus('ollama');
          errorEl.textContent = ollamaValidationError(validation);
          errorEl.classList.remove('hidden');
          return;
        }
        await saveSettings({
          ollamaCookie: input.value,
          limitProviders: limitProviderSelectionIncluding('ollama'),
          limitsEnabled: true
        });
        if (!state.settings?.ollamaCookieConfigured) {
          clearExternalProviderCheckPending('ollama');
          renderExternalProviderStatus('ollama');
          errorEl.textContent = t('settings.ollama.validationInvalid');
          errorEl.classList.remove('hidden');
          return;
        }
        input.value = '';
        renderExternalProviderStatus('ollama');
      } catch (err) {
        clearExternalProviderCheckPending('ollama');
        renderExternalProviderStatus('ollama');
        errorEl.textContent = t('settings.ollama.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      }
    });
  }

  const kimiToggle = document.getElementById('kimiSettingsToggle');
  if (kimiToggle) {
    kimiToggle.addEventListener('click', () => setExternalAccountExpanded('kimi', !state.kimiAccountExpanded));
    setExternalAccountExpanded('kimi', false);
    renderExternalProviderStatus('kimi');

    document.getElementById('kimiOpenBrowser').addEventListener('click', () => {
      window.tokenMonitor.openExternal(kimiPlatformUrl());
    });

    document.getElementById('kimiLogoutButton').addEventListener('click', async () => {
      await saveSettings({ kimiApiKey: '', kimiWebAccessToken: '' });
      clearExternalProviderCheckPending('kimi');
      clearExternalProviderPendingStatus('kimi');
      renderExternalProviderStatus('kimi');
      await refreshStats({ force: true });
    });

    document.getElementById('kimiRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });

    document.getElementById('kimiWebAccessTokenSubmit').addEventListener('click', async () => {
      const input = document.getElementById('kimiWebAccessTokenInput');
      const errorEl = document.getElementById('kimiErrorMessage');
      errorEl.classList.add('hidden');
      if (!String(input.value || '').trim()) {
        errorEl.textContent = t('settings.kimi.statusNotSet');
        errorEl.classList.remove('hidden');
        return;
      }
      try {
        markExternalProviderCheckPending('kimi');
        await saveSettings({ kimiWebAccessToken: input.value });
        input.value = '';
        renderExternalProviderStatus('kimi');
        await refreshStats({ force: true });
        setExternalAccountExpanded('kimi', !externalProviderAccountLinked('kimi'));
        renderExternalProviderStatus('kimi');
      } catch (err) {
        clearExternalProviderCheckPending('kimi');
        errorEl.textContent = t('settings.kimi.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      }
    });

    document.getElementById('kimiApiKeySubmit').addEventListener('click', async () => {
      const input = document.getElementById('kimiApiKeyInput');
      const errorEl = document.getElementById('kimiErrorMessage');
      errorEl.classList.add('hidden');
      if (!String(input.value || '').trim()) {
        errorEl.textContent = t('settings.kimi.statusNotSet');
        errorEl.classList.remove('hidden');
        return;
      }
      try {
        markExternalProviderCheckPending('kimi');
        await saveSettings({ kimiApiKey: input.value });
        input.value = '';
        renderExternalProviderStatus('kimi');
        await refreshStats({ force: true });
        setExternalAccountExpanded('kimi', !externalProviderAccountLinked('kimi'));
        renderExternalProviderStatus('kimi');
      } catch (err) {
        clearExternalProviderCheckPending('kimi');
        errorEl.textContent = t('settings.kimi.saveFailed', { message: err.message });
        errorEl.classList.remove('hidden');
      }
    });
  }

  const mimoToggle = document.getElementById('mimoSettingsToggle');
  if (mimoToggle) {
    mimoToggle.addEventListener('click', () => setMimoAccountExpanded(!state.mimoAccountExpanded));

    const addToggle = document.getElementById('mimoAddToggle');
    const addDetails = document.getElementById('mimoAddDetails');
    function setMimoAddExpanded(expanded) {
      const next = Boolean(expanded);
      addToggle?.setAttribute('aria-expanded', next ? 'true' : 'false');
      addDetails?.classList.toggle('hidden', !next);
      document.getElementById('mimoManualPanel')?.classList.toggle('expanded', next);
    }
    addToggle?.addEventListener('click', () => setMimoAddExpanded(addDetails?.classList.contains('hidden')));
    setMimoAccountExpanded(false);
    renderMimoStatus();

    window.tokenMonitor.mimo.onAccounts((accounts) => {
      state.settings.mimoManagedAccounts = accounts || [];
      renderMimoStatus();
    });

    window.tokenMonitor.mimo.accounts().then((accounts) => {
      state.settings.mimoManagedAccounts = accounts || [];
      renderMimoStatus();
    }).catch(() => {});

    document.getElementById('mimoOpenConsoleButton').addEventListener('click', async () => {
      const result = await window.tokenMonitor.mimo.openConsole();
      if (!result?.ok) {
        state.mimoAccountError = result?.error || t('settings.mimo.openFailed');
        renderMimoStatus();
        return;
      }
      state.mimoAccountError = '';
      renderMimoStatus();
    });

    document.getElementById('mimoSaveAccountButton').addEventListener('click', async () => {
      const input = document.getElementById('mimoCookieInput');
      const saveButton = document.getElementById('mimoSaveAccountButton');
      saveButton.disabled = true;
      saveButton.textContent = t('settings.mimo.checking');
      let result;
      try {
        result = await window.tokenMonitor.mimo.addAccount(input.value);
      } catch (_) {
        result = { ok: false, errorCode: 'validationUnavailable' };
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = t('settings.mimo.saveAccount');
      }
      if (!result?.ok) {
        if (result?.errorCode === 'missingRequiredCookies') {
          state.mimoAccountError = t('settings.mimo.missingCookies', { cookies: (result.missingCookies || []).join(', ') });
        } else if (result?.errorCode === 'invalidCookie') {
          state.mimoAccountError = t('settings.mimo.invalidCookie');
        } else if (result?.errorCode === 'validationRateLimited') {
          state.mimoAccountError = t('settings.mimo.validationRateLimited');
        } else if (result?.errorCode === 'validationUnavailable') {
          state.mimoAccountError = t('settings.mimo.validationUnavailable');
        } else if (result?.errorCode === 'credentialStorageUnavailable') {
          state.mimoAccountError = t('settings.mimo.credentialStorageUnavailable');
        } else {
          state.mimoAccountError = result?.error || t('settings.mimo.addFailed');
        }
        renderMimoStatus();
        return;
      }
      input.value = '';
      state.mimoAccountError = '';
      state.settings.mimoManagedAccounts = await window.tokenMonitor.mimo.accounts();
      renderMimoStatus();
      setMimoAddExpanded(false);
      await refreshStats({ force: true });
    });
  }
  const copilotToggle = document.getElementById('copilotSettingsToggle');
  if (copilotToggle) {
    copilotToggle.addEventListener('click', () => setCopilotAccountExpanded(!state.copilotAccountExpanded));
    document.getElementById('copilotManualToggle')?.addEventListener('click', () => {
      const details = document.getElementById('copilotManualDetails');
      setCopilotManualExpanded(details?.classList.contains('hidden'));
    });
    setCopilotAccountExpanded(false);
    setCopilotManualExpanded(false);
    renderCopilotStatus();

    const errorEl = document.getElementById('copilotErrorMessage');
    const setCopilotError = (message) => {
      state.copilotErrorMessage = message || '';
      if (errorEl) {
        errorEl.textContent = state.copilotErrorMessage;
        errorEl.classList.toggle('hidden', !state.copilotErrorMessage);
      }
    };

    window.tokenMonitor.copilot?.onLoginStatus?.((status) => {
      if (!status) return;
      if (!isCurrentCopilotSignInFlow(status.flowId)) return;
      if (status.phase === 'authorize') {
        state.copilotAuthorizeMessage = t('settings.copilot.authorize', { code: status.userCode || '' });
        state.copilotLoginStatus = state.copilotAuthorizeMessage;
      } else if (status.phase === 'polling') {
        state.copilotLoginStatus = [state.copilotAuthorizeMessage, t('settings.copilot.polling')].filter(Boolean).join('\n\n');
      } else if (status.phase === 'success') {
        state.copilotSignInCancelable = false;
        state.copilotAuthorizeMessage = '';
        state.copilotLoginStatus = t('settings.copilot.loginSuccess');
      } else if (status.phase === 'error') {
        state.copilotSignInCancelable = false;
        state.copilotAuthorizeMessage = '';
        state.copilotLoginStatus = '';
        setCopilotError(status.error || t('settings.copilot.loginFailed'));
      } else {
        state.copilotAuthorizeMessage = '';
        state.copilotLoginStatus = t('settings.copilot.loginStarting');
      }
      renderCopilotStatus();
    });

    document.getElementById('copilotSignInButton').addEventListener('click', async () => {
      if (state.copilotSignInBusy) return;
      const flowId = nextCopilotSignInFlowId();
      state.copilotSignInFlowId = flowId;
      state.copilotSignInBusy = true;
      state.copilotSignInCancelable = true;
      state.copilotAuthorizeMessage = '';
      state.copilotLoginStatus = t('settings.copilot.loginStarting');
      setCopilotError('');
      setCopilotManualExpanded(false);
      renderCopilotStatus();
      try {
        const result = await window.tokenMonitor.copilot.signIn({ flowId });
        if (!isCurrentCopilotSignInFlow(result?.flowId || flowId)) return;
        if (!result?.ok) {
          setCopilotError(result?.error || t('settings.copilot.loginFailed'));
          setCopilotAccountExpanded(true);
        } else {
          state.copilotSignInCancelable = false;
          markCopilotTokenCheckPending();
          state.copilotAuthorizeMessage = '';
          state.copilotLoginStatus = '';
          renderCopilotStatus();
          await refreshStats({ force: true });
          if (copilotAccountLinked()) setCopilotAccountExpanded(false);
        }
      } catch (err) {
        if (!isCurrentCopilotSignInFlow(flowId)) return;
        setCopilotError(err.message);
      } finally {
        if (isCurrentCopilotSignInFlow(flowId)) {
          state.copilotSignInBusy = false;
          state.copilotSignInCancelable = false;
          state.copilotSignInFlowId = '';
          state.copilotAuthorizeMessage = '';
          state.copilotLoginStatus = '';
          renderCopilotStatus();
        }
      }
    });

    document.getElementById('copilotCancelSignInButton').addEventListener('click', async () => {
      const flowId = state.copilotSignInFlowId;
      await window.tokenMonitor.copilot.cancelSignIn({ flowId });
      if (!isCurrentCopilotSignInFlow(flowId)) return;
      state.copilotSignInBusy = false;
      state.copilotSignInCancelable = false;
      state.copilotSignInFlowId = '';
      state.copilotAuthorizeMessage = '';
      state.copilotLoginStatus = '';
      renderCopilotStatus();
    });

    document.getElementById('copilotLogoutButton').addEventListener('click', async () => {
      await saveSettings({ copilotApiToken: '' });
      clearCopilotPendingCheck();
      clearCopilotProviderStatus();
      renderCopilotStatus();
      await refreshStats({ force: true });
    });

    document.getElementById('copilotRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
    });

    document.getElementById('copilotApiTokenSubmit').addEventListener('click', async () => {
      const input = document.getElementById('copilotApiTokenInput');
      setCopilotError('');
      if (!String(input.value || '').trim()) {
        setCopilotManualExpanded(true);
        setCopilotError(t('settings.copilot.statusNotSet'));
        return;
      }
      try {
        markCopilotTokenCheckPending();
        await saveSettings({ copilotApiToken: input.value });
        input.value = '';
        renderCopilotStatus();
        await refreshStats({ force: true });
        if (copilotAccountLinked()) setCopilotAccountExpanded(false);
        else setCopilotAccountExpanded(true);
        renderCopilotStatus();
      } catch (err) {
        clearCopilotPendingCheck();
        setCopilotError(t('settings.copilot.saveFailed', { message: err.message }));
      }
    });
  }

}

function initSettingsAnimationWrappers() {
  const selectors = [
    '.settings-section-details',
    '.cursor-settings-details',
    '.advanced-settings-details',
    '.app-update-notes-details',
    '.hub-mode-fields',
    '.presence-feature-body',
    '#claudeManualPanel',
    '#cursorManualPanel',
    '#opencodeManualPanel',
    '#deepseekManualPanel',
    '#minimaxManualPanel',
    '#zaiManualPanel',
    '#zaiteamManualPanel',
    '#volcengineManualPanel',
    '#qoderManualPanel',
    '#commandcodeManualPanel',
    '#kimiManualPanel',
    '#ollamaManualPanel'
  ].join(', ');

  document.querySelectorAll(selectors).forEach(el => {
    if (el.children.length === 1 && el.firstChild.classList?.contains('accordion-animation-inner')) return;

    const inner = document.createElement('div');
    // Keep specific class for specific paddings, but add common class for animation
    const innerSpecificClass = el.classList.contains('cursor-settings-details')
      ? 'cursor-settings-details-inner'
      : el.classList.contains('settings-section-details')
        ? 'settings-section-details-inner'
        : 'accordion-animation-inner';

    inner.className = `accordion-animation-inner ${innerSpecificClass}`;
    while (el.firstChild) {
      inner.appendChild(el.firstChild);
    }
    el.appendChild(inner);
    el.classList.add('accordion-animated-container');
  });
}

initSettingsAnimationWrappers();
setupSettingsSections();
setupCursorAccountUI();
setupCustomPricingUI();
init();
