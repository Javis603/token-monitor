'use strict';

const clientLabels = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', gemini: 'Gemini', cursor: 'Cursor', opencode: 'OpenCode', openclaw: 'OpenClaw', antigravity: 'Antigravity', cline: 'Cline', kimi: 'Kimi', qwen: 'Qwen', grok: 'Grok Build', copilot: 'GitHub Copilot', pi: 'Pi', zed: 'Zed', kilocode: 'Kilo Code', micode: 'MiMo Code', zcode: 'ZCode', kiro: 'Kiro', codebuddy: 'CodeBuddy', workbuddy: 'WorkBuddy', proma: 'Proma' };
const { clientColors, fallbackModelColors, modelVendorFor, modelColor } = window.TokenMonitorUsageCharts;
const motionPreferenceApi = window.TokenMonitorMotionPreference;
const reducedMotionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const clientsWithIcon = new Set([
  'claude', 'codex', 'gemini', 'cursor', 'opencode', 'openclaw', 'hermes', 'antigravity', 'cline', 'kimi', 'qwen', 'grok', 'copilot', 'pi', 'zed', 'kilocode', 'micode', 'zcode', 'kiro', 'codebuddy', 'workbuddy', 'proma',
  'xai', 'deepseek', 'meta', 'mistral', 'qwen', 'moonshot', 'zai', 'zaiteam', 'cohere', 'xiaomi', 'mimo', 'minimax', 'doubao', 'volcengine', 'qoder', 'ollama'
]);

function osIconFor(platform) {
  const prefix = String(platform || '').toLowerCase().split('-')[0];
  if (prefix === 'darwin') return 'apple';
  if (prefix === 'win32') return 'windows';
  if (prefix === 'linux' || prefix === 'freebsd' || prefix === 'openbsd') return 'linux';
  return null;
}

function iconKindFor(rowData, breakdown) {
  if (!state.settings?.showToolIcons) return { kind: 'dot' };
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
  { id: 'hermes', label: 'Hermes' },
  { id: 'opencode', label: 'OpenCode' },
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
  { id: 'micode', label: 'MiMo Code' },
  { id: 'zcode', label: 'ZCode' },
  { id: 'kiro', label: 'Kiro' },
  { id: 'codebuddy', label: 'CodeBuddy' },
  { id: 'workbuddy', label: 'WorkBuddy' },
  { id: 'proma', label: 'Proma' }
];
const LIMIT_PROVIDERS = [
  { id: 'claude', label: 'Claude', settingsLabel: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'minimax', label: 'Minimax' },
  { id: 'mimo', label: 'MiMo' },
  { id: 'grok', label: 'Grok' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'kiro', label: 'Kiro' },
  { id: 'zai', label: 'GLM' },
  { id: 'zaiteam', label: 'GLM Team' },
  { id: 'volcengine', label: 'Volcengine' },
  { id: 'qoder', label: 'Qoder' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'ollama', label: 'Ollama' }
];
const DEFAULT_LIMIT_PROVIDER_ORDER = LIMIT_PROVIDERS.map((provider) => provider.id).join(',');
const limitProviderOrderApi = window.TokenMonitorLimitProviderOrder;
const limitProviderPresentationApi = window.TokenMonitorLimitProviderPresentation;
const accountIdentityApi = window.TokenMonitorAccountIdentity;
const clientStatusPresentationApi = window.TokenMonitorClientStatusPresentation;
const serviceStatusPresentationApi = window.TokenMonitorServiceStatusPresentation;
const clientDisplayPreferencesApi = window.TokenMonitorClientDisplayPreferences;
const customPricingFormApi = window.TokenMonitorCustomPricingForm;
const viewDisplayPreferencesApi = window.TokenMonitorViewDisplayPreferences;
const preferenceDragSortApi = window.TokenMonitorPreferenceDragSort;
const homeOverviewApi = window.TokenMonitorHomeOverview;
const homeModulePreferencesApi = window.TokenMonitorHomeModulePreferences;
const { limitFillPercent, limitModeSuffix } = window.TokenMonitorLimitDisplayMode;
const i18n = window.TokenMonitorI18n;
const currencyApi = window.TokenMonitorCurrency;
const sessionRowsApi = window.TokenMonitorSessionRows;
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
  'App/CLI must be open': 'settings.limits.capability.appMustBeOpen',
  RPC: 'settings.limits.capability.rpc',
  'Local/Zen': 'settings.limits.capability.localZen',
  'Pay-as-you-go': 'settings.limits.capability.payg',
  Subscription: 'settings.limits.capability.subscription',
  'Token Plan': 'settings.limits.capability.tokenPlan',
  'Coding Plan': 'settings.limits.capability.codingPlan',
  'API key': 'settings.limits.capability.apiKey',
  'AK/SK': 'settings.limits.capability.akSk',
  'GitHub OAuth': 'settings.limits.capability.githubOAuth',
  API: 'settings.limits.capability.api',
  'Add API key': 'settings.limits.status.addApiKey',
  'Update API key': 'settings.limits.status.updateApiKey',
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
const viewPeriodValues = new Set(['today', 'month', 'allTime']);
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
const serviceStatusProviderPreferencesApi = window.TokenMonitorServiceStatusProviderPreferences;
const SETTINGS_SECTION_IDS = ['general', 'main', 'window', 'appearance', 'tools', 'limits', 'accounts', 'sync'];
const REFRESH_BUTTON_FEEDBACK_MS = 700;
const CODEX_PENDING_ACTIVE_GRACE_MS = 30000;
const initialFloatingBubble = window.__TOKEN_MONITOR_INITIAL_FLOATING_BUBBLE__ || { collapsed: false, side: null };
const initialViewState = window.__TOKEN_MONITOR_INITIAL_VIEW_STATE__ || {};
let initialBreakdownPreferenceApplied = typeof initialViewState.breakdown === 'string';

function normalizeInitialViewValue(value, allowed, fallback) {
  const raw = String(value || '').trim();
  return allowed.has(raw) ? raw : fallback;
}

const state = { period: normalizeInitialViewValue(initialViewState.period, viewPeriodValues, 'today'), appUpdate: null, breakdown: normalizeInitialViewValue(initialViewState.breakdown, viewBreakdownValues, 'home'), viewSwitcherOpen: false, viewSwitcherHasOpened: false, resetCreditsTooltipHasOpened: false, resetCreditsTooltipActive: false, resetCreditsTooltipRenderPending: false, settings: null, stats: null, homeHistory: null, homeHistoryBusy: false, homeHistoryRequested: false, homeHistorySignature: '', homeHistoryRetries: 0, homeHistoryRetryTimer: null, homeActivityScrollLeft: null, homeActivityFollowEnd: true, homeActivityResizeObserver: null, serviceStatus: null, serviceStatusBusy: false, serviceProvidersExpanded: false, trendSettingsExpanded: false, trendsActivating: false, homeSettingsExpanded: false, homeLimitSettingsExpanded: false, serviceStatusTicker: null, refreshTimer: null, refreshBusy: false, refreshFeedbackTimer: null, currentTotal: 0, rowSignature: '', streamConnected: false, streamFailure: null, mode: 'idle', appInfo: null, tokscaleStatus: null, tokscaleCheck: null, tokscaleBusy: false, hubInfo: null, cursorAccount: { status: null, error: '' }, cursorAccountExpanded: false, codexAccountExpanded: false, codexAccountError: '', codexSignInBusy: false, codexSignInFlowId: '', codexLoginUrl: '', codexLoginStatus: '', codexLoginOutput: '', codexActiveAccount: null, codexPendingActiveAccount: null, codexPendingActiveAccountUntil: 0, codexPendingActiveAccountTimer: null, codexSystemSwitchingAccountId: '', codexSystemSwitchErrorAccountId: '', codexSystemSwitchError: '', codexSwitchPopoverHasOpened: false, codexSwitchPopoverActive: false, codexSwitchPopoverRenderPending: false, customPricingExpanded: false, opencodeProfileCount: 0, opencodeCookieExpanded: false, deepseekAccountExpanded: false, deepseekPendingCheckSince: 0, minimaxAccountExpanded: false, minimaxPendingCheckSince: 0, zaiAccountExpanded: false, zaiPendingCheckSince: 0, zaiteamAccountExpanded: false, zaiteamPendingCheckSince: 0, volcengineAccountExpanded: false, volcenginePendingCheckSince: 0, qoderAccountExpanded: false, qoderPendingCheckSince: 0, kimiAccountExpanded: false, kimiPendingCheckSince: 0, ollamaAccountExpanded: false, ollamaPendingCheckSince: 0, mimoAccountExpanded: false, mimoAccountError: '', copilotAccountExpanded: false, copilotManualExpanded: false, copilotPendingCheckSince: 0, copilotSignInBusy: false, copilotSignInCancelable: false, copilotSignInFlowId: '', copilotAuthorizeMessage: '', copilotLoginStatus: '', copilotErrorMessage: '', floatingBubble: initialFloatingBubble, suppressInitialNumberAnimation: window.__TOKEN_MONITOR_SUPPRESS_INITIAL_NUMBER_ANIMATION__ === true, openSession: null, detailSort: 'time', recordingWindowShortcut: false, windowShortcutInvalid: false };
state.homeHistoryLoadedSignature = '';
state.homeHistoryRetrySignature = '';
state.appUpdateNotesPresentedVersion = '';
state.periodMotionActive = false;
state.animateBarsFromZero = false;
state.animateChartsOnRender = true;
let directBreakdownOverride = null;
state.projectSettingsExpanded = false;
state.settingsSections = Object.fromEntries(SETTINGS_SECTION_IDS.map((id) => [id, false]));
const defaultAppearance = { glassOpacity: 68, glassBlur: 32, zoomFactor: 1, systemGlass: true, reduceMotion: 'system', showLiveDot: true, showToolIcons: true, titleIconOnly: true, showCompactTotalTokens: false, settingsInTitlebar: false };
let preferenceDrag = null;
let viewSwitcherLongPressTimer = null;
let viewSwitcherLongPressTriggered = false;
let viewSwitcherHoverCloseTimer = null;
const els = {
  shell: document.querySelector('.shell'), status: document.getElementById('status'), liveDot: document.getElementById('liveDot'), totalTokens: document.getElementById('totalTokens'), totalTokensCompact: document.getElementById('totalTokensCompact'), cost: document.getElementById('cost'), homePanel: document.getElementById('homePanel'), breakdown: document.getElementById('breakdown'), serviceStatusPanel: document.getElementById('serviceStatusPanel'), limitsPanel: document.getElementById('limitsPanel'), trendsPanel: document.getElementById('trendsPanel'), viewSwitcher: document.getElementById('viewSwitcher'), pinButton: document.getElementById('pinButton'), settingsButton: document.getElementById('settingsButton'), settingsPanel: document.getElementById('settingsPanel'), languageInput: document.getElementById('languageInput'), currencyInput: document.getElementById('currencyInput'), currencyRateRow: document.getElementById('currencyRateRow'), currencyRateModeAuto: document.getElementById('currencyRateModeAuto'), currencyRateModeManual: document.getElementById('currencyRateModeManual'), currencyRateManualField: document.getElementById('currencyRateManualField'), currencyRateOverrideInput: document.getElementById('currencyRateOverrideInput'), currencyRateStatus: document.getElementById('currencyRateStatus'), hubUrlInput: document.getElementById('hubUrlInput'), secretInput: document.getElementById('secretInput'), deviceIdInput: document.getElementById('deviceIdInput'), limitProviderCheckboxes: document.getElementById('limitProviderCheckboxes'), limitsRefreshInput: document.getElementById('limitsRefreshInput'), showLimitSourceInput: document.getElementById('showLimitSourceInput'), maskLimitAccountEmailsInput: document.getElementById('maskLimitAccountEmailsInput'), showLimitUsedInput: document.getElementById('showLimitUsedInput'), systemGlassInput: document.getElementById('systemGlassInput'), liveDotInput: document.getElementById('liveDotInput'), toolIconsInput: document.getElementById('toolIconsInput'), floatingBubbleInput: document.getElementById('floatingBubbleInput'), floatingBubbleTriggerInput: document.getElementById('floatingBubbleTriggerInput'), floatingBubbleTriggerRow: document.getElementById('floatingBubbleTriggerRow'), floatingBubbleContentInput: document.getElementById('floatingBubbleContentInput'), floatingBubbleContentRow: document.getElementById('floatingBubbleContentRow'), floatingBubbleContent: document.getElementById('floatingBubbleContent'), discordRpcInput: document.getElementById('discordRpcInput'), windowBehaviorInput: document.getElementById('windowBehaviorInput'), showTrayIconInput: document.getElementById('showTrayIconInput'), showTrayProviderBadgeInput: document.getElementById('showTrayProviderBadgeInput'), trayModeInput: document.getElementById('trayModeInput'), trayContentInput: document.getElementById('trayContentInput'), windowToggleShortcutValue: document.getElementById('windowToggleShortcutValue'), windowToggleShortcutClearButton: document.getElementById('windowToggleShortcutClearButton'), windowToggleShortcutNote: document.getElementById('windowToggleShortcutNote'), glassInput: document.getElementById('glassInput'), blurInput: document.getElementById('blurInput'), zoomInput: document.getElementById('zoomInput'), resetGlassButton: document.getElementById('resetGlassButton'), resetDepthButton: document.getElementById('resetDepthButton'), resetZoomButton: document.getElementById('resetZoomButton'), saveSettingsButton: document.getElementById('saveSettingsButton'), clientDisplayList: document.getElementById('clientDisplayList'), wslScanInput: document.getElementById('wslScanInput'), wslScanRow: document.getElementById('wslScanRow'), wslPanel: document.getElementById('wslPanel'), openConfigButton: document.getElementById('openConfigButton'), exportAutoInput: document.getElementById('exportAutoInput'), exportAutoDetails: document.getElementById('exportAutoDetails'), exportAutoStatus: document.getElementById('exportAutoStatus'), exportDirLabel: document.getElementById('exportDirLabel'), exportPickDirButton: document.getElementById('exportPickDirButton'), exportIntervalInput: document.getElementById('exportIntervalInput'), exportNowButton: document.getElementById('exportNowButton'), refreshButton: document.getElementById('refreshButton'), minButton: document.getElementById('minButton'), closeButton: document.getElementById('closeButton'), floatingBubbleTab: document.getElementById('floatingBubbleTab')
};
Object.assign(els, {
  floatingBubbleOptions: document.getElementById('floatingBubbleOptions'),
  trayIconOptions: document.getElementById('trayIconOptions'),
  trayOptions: document.getElementById('trayOptions'),
  hubModeOptions: document.getElementById('hubModeOptions'),
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
  clearSessionUsageArchiveButton: document.getElementById('clearSessionUsageArchiveButton'),
  startupGroup: document.getElementById('startupGroup'),
  startAtLoginInput: document.getElementById('startAtLoginInput'),
  startupNote: document.getElementById('startupNote'),
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
  reportIssueButton: document.getElementById('reportIssueButton'),
  appUpdatePill: document.getElementById('appUpdatePill'),
  appUpdatePillAction: document.getElementById('appUpdatePillAction'),
  appUpdatePillLabel: document.getElementById('appUpdatePillLabel'),
  appUpdatePillDismiss: document.getElementById('appUpdatePillDismiss'),
  appUpdatePopover: document.getElementById('appUpdatePopover'),
  appUpdatePopoverTitle: document.getElementById('appUpdatePopoverTitle'),
  appUpdatePopoverBody: document.getElementById('appUpdatePopoverBody'),
  appUpdatePopoverAction: document.getElementById('appUpdatePopoverAction'),
  appUpdatePopoverRelease: document.getElementById('appUpdatePopoverRelease'),
  appUpdatePopoverClose: document.getElementById('appUpdatePopoverClose'),
  appUpdateInstalled: document.getElementById('appUpdateInstalled'),
  appUpdateLatest: document.getElementById('appUpdateLatest'),
  appUpdateCheckButton: document.getElementById('appUpdateCheckButton'),
  appUpdateViewReleaseButton: document.getElementById('appUpdateViewReleaseButton'),
  appUpdateNotes: document.getElementById('appUpdateNotes'),
  appUpdateNotesTitle: document.getElementById('appUpdateNotesTitle'),
  appUpdateNotesBody: document.getElementById('appUpdateNotesBody'),
  appUpdateReleaseNotesButton: document.getElementById('appUpdateReleaseNotesButton'),
  appUpdateMessage: document.getElementById('appUpdateMessage'),
  titleIconInput: document.getElementById('titleIconInput'),
  showCompactTotalTokensInput: document.getElementById('showCompactTotalTokensInput'),
  settingsInTitlebarInput: document.getElementById('settingsInTitlebarInput'),
  resetClientDisplayOrderButton: document.getElementById('resetClientDisplayOrderButton'),
  showAllClientsButton: document.getElementById('showAllClientsButton'),
  resetViewDisplayOrderButton: document.getElementById('resetViewDisplayOrderButton'),
  showAllViewsButton: document.getElementById('showAllViewsButton'),
  viewDisplayList: document.getElementById('viewDisplayList'),
  syncSettingsSummary: document.getElementById('syncSettingsSummary'),
  toolsSettingsSummary: document.getElementById('toolsSettingsSummary'),
  accountsSettingsSummary: document.getElementById('accountsSettingsSummary'),
  limitsSettingsSummary: document.getElementById('limitsSettingsSummary'),
  generalSettingsSummary: document.getElementById('generalSettingsSummary'),
  mainSettingsSummary: document.getElementById('mainSettingsSummary'),
  windowSettingsSummary: document.getElementById('windowSettingsSummary'),
  appearanceSettingsSummary: document.getElementById('appearanceSettingsSummary'),
  themePresetChips: document.getElementById('themePresetChips'),
  themeColorGrid: document.getElementById('themeColorGrid'),
  themeCodeInput: document.getElementById('themeCodeInput'),
  applyThemeCodeButton: document.getElementById('applyThemeCodeButton'),
  copyThemeCodeButton: document.getElementById('copyThemeCodeButton'),
  themeCodeStatus: document.getElementById('themeCodeStatus'),
  themeAdvancedGroup: document.getElementById('themeAdvancedGroup'),
  themeAdvancedToggle: document.getElementById('themeAdvancedToggle'),
  themeAdvancedDetails: document.getElementById('themeAdvancedDetails'),
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

document.addEventListener('pointerup', () => {
  clearViewSwitcherLongPress();
  if (viewSwitcherLongPressTriggered) {
    setTimeout(() => { viewSwitcherLongPressTriggered = false; }, 0);
  }
});

document.addEventListener('pointercancel', () => {
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
  return i18n.resolveLocale(currentLanguage(), preferredLanguages());
}

function t(key, params) {
  return i18n.translate(currentLocale(), key, params);
}

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

function cancelSettingsScrollAnchor() {
  if (settingsScrollAnchorFrame === null) return;
  cancelAnimationFrame(settingsScrollAnchorFrame);
  settingsScrollAnchorFrame = null;
}

function cancelSettingsScrollAnchorOnKeydown(event) {
  if (SETTINGS_SCROLL_KEYS.has(event.key)) cancelSettingsScrollAnchor();
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
  els.settingsPanel?.addEventListener('pointerdown', cancelSettingsScrollAnchor, { passive: true });
  els.settingsPanel?.addEventListener('wheel', cancelSettingsScrollAnchor, { passive: true });
  els.settingsPanel?.addEventListener('keydown', cancelSettingsScrollAnchorOnKeydown);
}

function refreshIntervalLabel(value) {
  const ms = Number(value) || 300000;
  const minutes = Math.max(1, Math.round(ms / 60000));
  return t('settings.summary.minutes', { minutes });
}

function viewsSummary() {
  const hidden = hiddenViewSet();
  const visible = VIEW_DISPLAY_OPTIONS.length - hidden.size;
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
    return t('settings.summary.tools', {
      tracked: enabledClientSet().size,
      visible: KNOWN_CLIENTS.length - hiddenClientSet().size,
      pinned: pinnedClientSet().size
    });
  }
  if (section === 'accounts') {
    const cursorLinked = Boolean(state.cursorAccount.status?.loggedIn) && !state.cursorAccount.status?.expired;
    const opencodeCount = state.opencodeProfileCount || 0;
    const deepseekLinked = deepseekAccountLinked();
    const minimaxLinked = minimaxAccountLinked();
    const zaiLinked = externalProviderAccountLinked('zai');
    const zaiteamLinked = externalProviderAccountLinked('zaiteam');
    const volcengineLinked = externalProviderAccountLinked('volcengine');
    const qoderLinked = externalProviderAccountLinked('qoder');
    const kimiLinked = externalProviderAccountLinked('kimi');
    const ollamaLinked = externalProviderAccountLinked('ollama');
    const mimoLinked = mimoAccountLinked();
    const copilotLinked = copilotAccountLinked();
    const codexLinked = (state.settings?.codexManagedAccounts || []).length > 0;
    return t('settings.summary.accounts', {
      linked: (codexLinked ? 1 : 0) + (cursorLinked ? 1 : 0) + (opencodeCount > 0 ? 1 : 0) + (deepseekLinked ? 1 : 0) + (minimaxLinked ? 1 : 0) + (zaiLinked ? 1 : 0) + (zaiteamLinked ? 1 : 0) + (volcengineLinked ? 1 : 0) + (qoderLinked ? 1 : 0) + (kimiLinked ? 1 : 0) + (ollamaLinked ? 1 : 0) + (mimoLinked ? 1 : 0) + (copilotLinked ? 1 : 0),
      total: 13
    });
  }
  if (section === 'limits') {
    return t('settings.summary.limits', {
      enabled: enabledLimitProviderSet().size,
      refresh: refreshIntervalLabel(state.settings.limitsRefreshMs)
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
function formatCompact(value) {
  const num = Math.round(Number(value || 0));
  const abs = Math.abs(num);
  const units = [
    { divisor: 1e3, suffix: 'K' },
    { divisor: 1e6, suffix: 'M' },
    { divisor: 1e9, suffix: 'B' }
  ];
  let unitIndex = abs >= 1e9 ? 2 : abs >= 1e6 ? 1 : abs >= 1e3 ? 0 : -1;
  if (unitIndex < 0) return String(num);

  let unit = units[unitIndex];
  let display = (num / unit.divisor).toFixed(1);
  if (Math.abs(Number(display)) >= 1000 && unitIndex < units.length - 1) {
    unit = units[unitIndex + 1];
    display = (num / unit.divisor).toFixed(1);
  }
  return `${display.replace(/\.0$/, '')}${unit.suffix}`;
}
function updateTotalCompact(value) {
  if (!els.totalTokensCompact) return;
  const num = Math.round(Number(value || 0));
  if (state.settings?.showCompactTotalTokens !== true || Math.abs(num) < 1000) {
    hideTotalCompact();
  } else {
    els.totalTokensCompact.textContent = `≈ ${formatCompact(num)}`;
    els.totalTokensCompact.classList.remove('hidden');
  }
  fitTotalNumber();
}
function hideTotalCompact() {
  if (!els.totalTokensCompact) return;
  els.totalTokensCompact.textContent = '';
  els.totalTokensCompact.classList.add('hidden');
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
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'Reset now';
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
function appUpdateActionMode(s) {
  if (!s) return '';
  if (s.downloaded) return 'install';
  if (!s.hasUpdate) return '';
  if (s.installSupported) return 'download';
  return s.latest?.htmlUrl ? 'release' : '';
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
  const mode = appUpdateActionMode(s);
  const version = s?.latest?.version || s?.installVersion || '';
  if (!s || !mode || !version || !s.showUpdateNotice) {
    pill.classList.add('hidden');
    pill.setAttribute('title', '');
    els.appUpdatePillLabel.textContent = '';
    setAppUpdatePillDisclosure(false);
    return;
  }
  const hasReleaseNotes = mode !== 'install' && releaseNoteGroupsForCurrentLocale(s.latest).length > 0;
  setAppUpdatePillDisclosure(hasReleaseNotes);
  pill.classList.remove('hidden');
  els.appUpdatePillDismiss.classList.toggle('hidden', mode === 'install' || s.installBusy);
  pill.setAttribute('title', mode === 'install' ? t('settings.appUpdate.ready') : (s.latest?.name || `v${version}`));
  if (s.installPhase === 'downloading' && Number.isFinite(s.installProgress)) {
    els.appUpdatePillLabel.textContent = `${Math.round(s.installProgress)}%`;
  } else {
    els.appUpdatePillLabel.textContent = mode === 'install'
      ? `↻ ${t('settings.appUpdate.restart')}`
      : `↑ v${version}`;
  }
}
function releaseNoteGroupsForCurrentLocale(latest) {
  const notes = latest?.releaseNotes;
  if (!notes || typeof notes !== 'object') return [];
  const preferred = currentLocale().startsWith('zh') ? notes.zh : notes.en;
  if (Array.isArray(preferred) && preferred.length > 0) return preferred;
  if (Array.isArray(notes.en) && notes.en.length > 0) return notes.en;
  return Array.isArray(notes.zh) ? notes.zh : [];
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
  const mode = appUpdateActionMode(s);
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
    els.appUpdateNotes.open = false;
    els.appUpdateNotesTitle.textContent = '';
    els.appUpdateNotesBody.replaceChildren();
    return;
  }

  els.appUpdateNotesTitle.textContent = t('settings.appUpdate.whatsNew', { version });
  els.appUpdateNotesBody.replaceChildren(...buildAppUpdateNoteGroupNodes(groups));
  els.appUpdateReleaseNotesButton.classList.toggle('hidden', !s.latest?.htmlUrl);
  if (s.hasUpdate && state.appUpdateNotesPresentedVersion !== version) {
    els.appUpdateNotes.open = true;
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
  const displayVersion = s.latest?.version || s.installVersion || '';
  if (displayVersion) {
    els.appUpdateLatest.textContent = !s.hasUpdate && semverLikeEqual(displayVersion, s.currentVersion)
      ? t('settings.appUpdate.latestWithStatus', { version: displayVersion, status: t('settings.appUpdate.upToDateShort') })
      : `v${displayVersion}`;
    const actionMode = appUpdateActionMode(s);
    els.appUpdateViewReleaseButton.classList.toggle('hidden', !actionMode);
    els.appUpdateViewReleaseButton.disabled = Boolean(s.installBusy);
    els.appUpdateViewReleaseButton.textContent = actionMode === 'install'
      ? t('settings.appUpdate.restart')
      : actionMode === 'download'
        ? t('settings.appUpdate.download')
        : t('settings.appUpdate.viewRelease');
  } else {
    els.appUpdateLatest.textContent = s.lastCheckedAt ? t('settings.appUpdate.upToDate') : t('settings.common.notChecked');
    els.appUpdateViewReleaseButton.classList.add('hidden');
  }
  els.appUpdateCheckButton.disabled = Boolean(s.checking || s.installBusy);
  els.appUpdateCheckButton.textContent = s.checking ? t('settings.appUpdate.checking') : t('settings.appUpdate.check');
  renderAppUpdateNotes(s);
  if (s.installPhase === 'downloading') {
    const percent = Number.isFinite(s.installProgress) ? Math.round(s.installProgress) : 0;
    els.appUpdateMessage.textContent = t('settings.appUpdate.downloading', { percent });
    els.appUpdateMessage.classList.remove('error');
  } else if (s.downloaded) {
    els.appUpdateMessage.textContent = state.appInfo?.platform === 'win32'
      ? t('settings.appUpdate.readyWindowsUnsigned')
      : t('settings.appUpdate.ready');
    els.appUpdateMessage.classList.remove('error');
  } else if (s.installError) {
    els.appUpdateMessage.textContent = t('settings.appUpdate.installError');
    els.appUpdateMessage.classList.add('error');
  } else if (s.lastError) {
    els.appUpdateMessage.textContent = t('settings.appUpdate.githubError');
    els.appUpdateMessage.classList.add('error');
  } else {
    els.appUpdateMessage.textContent = '';
    els.appUpdateMessage.classList.remove('error');
  }
}

function semverLikeEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a === b;
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
function cancelNumberAnimation() {
  if (numberAnimHandle) { cancelAnimationFrame(numberAnimHandle); numberAnimHandle = 0; }
}

function animateNumber(el, from, to, duration = 1000, onDone = null) {
  cancelNumberAnimation();
  if (prefersReducedMotion()) {
    el.textContent = formatNumber(to);
    if (typeof onDone === 'function') onDone();
    return;
  }
  const start = performance.now();
  const delta = to - from;
  function frame(now) {
    const progress = Math.min(1, (now - start) / duration);
    el.textContent = formatNumber(from + delta * easeOutQuart(progress));
    if (progress < 1) {
      numberAnimHandle = requestAnimationFrame(frame);
    } else {
      numberAnimHandle = 0;
      if (typeof onDone === 'function') onDone();
    }
  }
  numberAnimHandle = requestAnimationFrame(frame);
}

const rowNumberAnimationHandles = new Map();

function prefersReducedMotion() {
  return motionPreferenceApi.shouldReduceMotion(state.settings?.reduceMotion, reducedMotionMedia?.matches);
}

function settleMotionAnimations() {
  cancelNumberAnimation();
  els.totalTokens.textContent = formatNumber(state.currentTotal);
  updateTotalCompact(state.currentTotal);
  for (const [el, handle] of rowNumberAnimationHandles) {
    cancelAnimationFrame(handle);
    const target = Number(el.dataset.motionTarget || el.dataset.motionValue || 0);
    el.textContent = formatNumber(target);
    el.dataset.motionValue = String(target);
    delete el.dataset.motionTarget;
  }
  rowNumberAnimationHandles.clear();
  for (const animation of document.getAnimations?.() || []) {
    try { animation.finish(); } catch (_) { animation.cancel(); }
  }
}

function applyReduceMotionPreference(value) {
  const preference = motionPreferenceApi.normalize(value);
  document.documentElement.dataset.reduceMotion = preference;
  if (motionPreferenceApi.shouldReduceMotion(preference, reducedMotionMedia?.matches)) settleMotionAnimations();
  return preference;
}

function captureBreakdownMotion() {
  const snapshot = new Map();
  for (const row of els.breakdown?.querySelectorAll('.row[data-key]') || []) {
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
  const previousHandle = rowNumberAnimationHandles.get(el);
  if (previousHandle) cancelAnimationFrame(previousHandle);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to || prefersReducedMotion()) {
    el.textContent = formatNumber(to);
    el.dataset.motionValue = String(Number(to) || 0);
    delete el.dataset.motionTarget;
    rowNumberAnimationHandles.delete(el);
    return;
  }
  const startedAt = performance.now();
  const delta = to - from;
  el.textContent = formatNumber(from);
  el.dataset.motionValue = String(from);
  el.dataset.motionTarget = String(to);
  function frame(now) {
    if (prefersReducedMotion()) {
      el.textContent = formatNumber(to);
      el.dataset.motionValue = String(Number(to) || 0);
      delete el.dataset.motionTarget;
      rowNumberAnimationHandles.delete(el);
      return;
    }
    const progress = Math.min(1, (now - startedAt) / duration);
    const current = from + delta * easeOutQuart(progress);
    el.textContent = formatNumber(current);
    el.dataset.motionValue = String(current);
    if (progress < 1) {
      rowNumberAnimationHandles.set(el, requestAnimationFrame(frame));
    } else {
      delete el.dataset.motionTarget;
      rowNumberAnimationHandles.delete(el);
    }
  }
  rowNumberAnimationHandles.set(el, requestAnimationFrame(frame));
}

function animateBreakdownFrom(snapshot, { duration = 420 } = {}) {
  if (prefersReducedMotion()) return;
  let enteringIndex = 0;
  for (const row of els.breakdown?.querySelectorAll('.row[data-key]') || []) {
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
  if (!fill?.animate || Math.abs(toScale - fromScale) < 0.001) return;
  for (const animation of fill.getAnimations()) animation.cancel();
  fill.animate([
    { transform: `scaleX(${fromScale})` },
    { transform: `scaleX(${toScale})` }
  ], {
    duration,
    delay,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'backwards'
  });
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
  for (const animation of fill.getAnimations()) animation.cancel();
  fill.animate([
    { transform: 'scaleX(0)' },
    { transform: `scaleX(${safeScale})` }
  ], { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
}

function rowWidth(value, max) {
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

function updateRow(row, { name, subtitle, detail, value, cost, max, color, barBackground, accordionRows, stale, platform, local, client, kind, cacheReadTokens, outputTokens }) {
  const width = rowWidth(value, max);
  const isExpanded = row.classList.contains('expanded');
  row.className = `row${kind ? ` ${kind}-row` : ''}${stale ? ' stale' : ''}${local ? ' local' : ''}`;
  if (local) row.title = 'This device';
  
  if (cacheReadTokens !== undefined || outputTokens !== undefined) {
    row.dataset.cacheRead = cacheReadTokens || 0;
    row.dataset.outputTokens = outputTokens || 0;
    row.dataset.totalTokens = value || 0;
    row.dataset.name = name || '';
  }
  if (platform !== undefined) row.dataset.platform = platform || '';
  if (client !== undefined) row.dataset.client = client || '';
  if (kind !== undefined) row.dataset.kind = kind || '';
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
  valueEl.textContent = formatNumber(value);
  valueEl.dataset.motionValue = String(Number(value) || 0);
  row.dataset.motionValue = String(Number(value) || 0);
  row.querySelector('.row-cost').textContent = formatCost(cost || 0);
  const fill = row.querySelector('.bar-fill');
  fill.style.background = barBackground || color;
  applyBarScale(fill, width / 100);

  const accordionInner = row.querySelector('.row-accordion-inner');
  if (Array.isArray(accordionRows) && accordionRows.length > 0) {
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
  } else if ((cacheReadTokens !== undefined || outputTokens !== undefined) && value > 0 && kind !== 'session') {
    const cacheRead = cacheReadTokens || 0;
    const output = outputTokens || 0;
    const totalTokens = value || 0;
    const cacheMiss = Math.max(0, totalTokens - cacheRead - output);
    const inputTokens = cacheRead + cacheMiss;
    const hitPct = inputTokens > 0 ? Math.round((cacheRead / inputTokens) * 100) : 0;
    const missPct = inputTokens > 0 ? 100 - hitPct : 0;
    
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
    setAttributeIfChanged(row, 'aria-label', `${name}, ${t('dashboard.stat.totalTokens')}: ${formatNumber(value)}, ${t('dashboard.stat.totalCost')}: ${formatCost(cost || 0)}`);
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

function renderRows(rows, { showProjectIncompleteHint = false } = {}) {
  if (rows.length === 0 && !showProjectIncompleteHint) {
    els.breakdown.replaceChildren();
    state.rowSignature = '';
    return;
  }
  const max = Math.max(1, ...rows.map((row) => row.value));
  const liveMotionSnapshot = !state.periodMotionActive && !state.animateBarsFromZero
    ? captureBreakdownMotion()
    : null;
  const hintText = showProjectIncompleteHint ? t('projects.incomplete') : '';
  const signature = JSON.stringify([state.breakdown, hintText, rows.map((row) => row.key)]);
  const children = Array.from(els.breakdown.children);
  const existingHint = children.find((child) => child.classList.contains('project-incomplete-hint'));
  const existing = new Map(children.filter((child) => child !== existingHint).map((child) => [child.dataset.key, child]));
  if (signature !== state.rowSignature) {
    const nodes = rows.map((row) => existing.get(row.key) || rowTemplate(row));
    if (showProjectIncompleteHint) {
      const hint = existingHint || document.createElement('p');
      hint.className = 'project-incomplete-hint';
      hint.setAttribute('role', 'status');
      hint.textContent = hintText;
      nodes.unshift(hint);
    }
    els.breakdown.replaceChildren(...nodes);
    state.rowSignature = signature;
  }
  const current = new Map(Array.from(els.breakdown.children)
    .filter((child) => !child.classList.contains('project-incomplete-hint'))
    .map((child) => [child.dataset.key, child]));
  for (const rowData of rows) {
    const row = current.get(rowData.key);
    if (row) updateRow(row, { ...rowData, max });
  }
  if (liveMotionSnapshot) animateBreakdownFrom(liveMotionSnapshot, { duration: 600 });
}

function deviceLabel(device) {
  return device.deviceId || device.hostname || 'device';
}

function deviceColor(stale) {
  return stale ? deviceStaleColor : deviceAccent;
}

function stableColor(value, colors) {
  let hash = 0;
  for (const char of String(value || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function deviceRowsForPeriod() {
  const localId = state.settings?.deviceId || '';
  return (state.stats?.devices || []).map((device) => ({
    key: device.deviceId,
    name: deviceLabel(device),
    value: Number(device.periods?.[state.period]?.totalTokens || 0),
    cost: Number(device.periods?.[state.period]?.costUsd || 0),
    color: deviceColor(Boolean(device.stale)),
    stale: Boolean(device.stale),
    platform: device.platform || '',
    local: Boolean(localId) && device.deviceId === localId
  })).sort((a, b) => b.value - a.value);
}

function toolRowsForPeriod(period) {
  const clientRows = Object.entries(period?.clients || {}).filter(([, value]) => Number(value) > 0).map(([client, value]) => ({ key: client, name: clientLabels[client] || client, value: Number(value), cost: Number(period?.clientCosts?.[client] || 0), color: clientColors[client] || clientColors.default, stale: false, cacheReadTokens: Number(period?.clientCacheReads?.[client] || 0), cacheWriteTokens: Number(period?.clientCacheWrites?.[client] || 0), outputTokens: Number(period?.clientOutputs?.[client] || 0) }));
  if (clientRows.length > 0) {
    const usageSortedRows = clientRows.sort((a, b) => b.value - a.value);
    return clientDisplayPreferencesApi.applyClientDisplayPreferences(usageSortedRows, state.settings?.clientDisplayOrder, state.settings?.hiddenClients, KNOWN_CLIENTS, state.settings?.pinnedClients);
  }
  if (Number(period?.totalTokens || 0) === 0) return [];
  return deviceRowsForPeriod();
}

function modelRowsForPeriod(period) {
  const modelRows = Object.entries(period?.models || {}).filter(([, value]) => Number(value) > 0).map(([model, value]) => ({
    key: model,
    name: model,
    value: Number(value),
    cost: Number(period?.modelCosts?.[model] || 0),
    color: modelColor(model),
    stale: false,
    cacheReadTokens: Number(period?.modelCacheReads?.[model] || 0),
    cacheWriteTokens: Number(period?.modelCacheWrites?.[model] || 0),
    outputTokens: Number(period?.modelOutputs?.[model] || 0)
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
    archivedLabel: t('session.archived')
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
    unknownClientLabel: t('projects.unknownTool')
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
  const label = String(provider?.accountLabel || '').trim();
  if (label) return limitProviderPresentationApi.limitProviderDisplayLabel(label);
  return provider?.status && provider.status !== 'ok' ? limitStatusLabel(provider.status, false) : '';
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

function codexResetCreditExpiryDateLabel(date) {
  return new Intl.DateTimeFormat(currentLocale(), { month: 'numeric', day: 'numeric' }).format(date);
}

function resetCreditsTooltipShouldHoldRender() {
  if (!state.resetCreditsTooltipActive || !els.limitsPanel) return false;
  return Boolean(els.limitsPanel.querySelector('.limit-reset-credits-info-wrap:hover, .limit-reset-credits-info-wrap:focus-within'));
}

function flushPendingResetCreditsTooltipRender() {
  if (!state.resetCreditsTooltipRenderPending || state.breakdown !== 'limits') return;
  state.resetCreditsTooltipRenderPending = false;
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
    if (expirationDates.length > 1) {
      const infoWrap = document.createElement('span');
      infoWrap.className = 'limit-reset-credits-info-wrap';
      infoWrap.classList.toggle('has-opened', state.resetCreditsTooltipHasOpened);
      const info = document.createElement('span');
      info.className = 'limit-reset-credits-info';
      info.textContent = 'i';
      info.tabIndex = 0;
      info.setAttribute('aria-label', expirationDates.map((date, index) => `Reset ${index + 1}: ${codexResetCreditExpiryDetailLabel(date)}`).join(', '));
      const tooltip = document.createElement('span');
      tooltip.className = 'limit-reset-credits-tooltip';
      tooltip.setAttribute('role', 'tooltip');
      expirationDates.forEach((date) => {
        const row = document.createElement('span');
        row.className = 'limit-reset-credit-detail';
        const label = document.createElement('span');
        label.textContent = codexResetCreditExpiryDateLabel(date);
        const tooltipExpiry = document.createElement('span');
        tooltipExpiry.textContent = codexResetCreditExpiryLabel(date);
        row.append(label, tooltipExpiry);
        tooltip.append(row);
      });
      const markResetCreditsTooltipOpened = () => {
        state.resetCreditsTooltipHasOpened = true;
        state.resetCreditsTooltipActive = true;
        infoWrap.classList.add('has-opened');
      };
      const releaseResetCreditsTooltip = () => {
        requestAnimationFrame(() => {
          if (infoWrap.matches(':hover, :focus-within')) return;
          state.resetCreditsTooltipActive = false;
          flushPendingResetCreditsTooltipRender();
        });
      };
      infoWrap.addEventListener('pointerenter', markResetCreditsTooltipOpened);
      infoWrap.addEventListener('focusin', markResetCreditsTooltipOpened);
      infoWrap.addEventListener('pointerleave', releaseResetCreditsTooltip);
      infoWrap.addEventListener('focusout', releaseResetCreditsTooltip);
      infoWrap.append(info, tooltip);
      expiryGroup.append(infoWrap);
    }
    line.append(expiryGroup);
  }
  item.append(line);
  item.setAttribute('aria-label', ['Reset credits', valueText, expirationDates.map(codexResetCreditExpiryDetailLabel).join(', ')].filter(Boolean).join(', '));
  return item;
}

const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' };

function formatMoney(value, currency) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const symbol = CURRENCY_SYMBOLS[String(currency || '').toUpperCase()] || '$';
  return `${symbol}${number.toFixed(2)}`;
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  if (window?.kind === 'balance') {
    return `${formatMoney(window.amount, window.currency)} left`;
  }
  const percent = limitFillPercent(window?.remainingPercent, window?.usedPercent, showUsed);
  return `${formatPercent(percent)} ${limitModeSuffix(showUsed)}`;
}

function balanceRemainingWindow(balance) {
  const amount = Math.max(0, Number(balance?.amount || 0));
  const spend = Math.max(0, Number(balance?.monthSpend || 0));
  const total = amount + spend;
  const remainingPercent = total > 0 ? (amount / total) * 100 : 100;
  return { remainingPercent };
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
  const resetText = formatReset(window?.resetsAt) || window?.resetDescription || '';
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
  head.append(titleBlock, plan);
  return head;
}

function renderProviderWindows(provider, color) {
  const windows = document.createElement('div');
  windows.className = 'limit-windows';
  if (provider.provider === 'codex') {
    const session = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    if (session) {
      const sessionNode = limitWindowNode(session.label || 'Session', session, color, 0.95);
      if (!weekly) sessionNode.classList.add('limit-window-wide');
      windows.append(sessionNode);
    }
    if (weekly) {
      const weeklyNode = limitWindowNode(weekly.label || 'Weekly', weekly, color, 0.68);
      if (!session) weeklyNode.classList.add('limit-window-wide');
      windows.append(weeklyNode);
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
    const weeklyWindows = windowsForKind(provider, 'weekly');
    const visibleWindows = weeklyWindows.length > 0 ? weeklyWindows : [null];
    for (const weekly of visibleWindows) {
      const node = limitWindowNode(weekly?.label || 'Weekly', weekly, color, 0.78);
      node.classList.add('limit-window-wide');
      windows.append(node);
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
  } else if (provider.provider === 'deepseek') {
    // DeepSeek is pay-as-you-go: render the prepaid balance as a meter so the
    // provider uses the same visual language as fixed quota windows.
    windows.classList.add('limit-windows-deepseek');
    const balance = provider.balance || null;
    if (balance) {
      const currency = balance.currency;
      const balanceNode = limitWindowNode('Balance', balanceRemainingWindow(balance), color, 0.95,
        `${formatMoney(balance.amount, currency)} left`);
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);

      const parts = [];
      if (Number.isFinite(Number(balance.todaySpend))) parts.push(`Today ${formatMoney(balance.todaySpend, currency)}`);
      if (Number.isFinite(Number(balance.monthSpend))) {
        parts.push(`Month ${formatMoney(balance.monthSpend, currency)}`);
      }
      if (parts.length) {
        const spendNode = limitWindowNode('Spend', { showMeter: false }, color, 0.6, parts.join(' · '));
        spendNode.classList.add('limit-window-wide', 'limit-window-note');
        windows.append(spendNode);
      }
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

function codexAccountTitle(provider, index) {
  const email = String(provider?.accountEmail || '').trim();
  if (email) return state.settings?.maskLimitAccountEmails ? accountIdentityApi.maskEmailAddress(email) : email;
  // Never fall back to the plan label here — "Plus" as a title reads like an
  // account name. The plan still shows on the right via limitProviderPlan().
  return `Account ${index + 1}`;
}

function renderCodexAccountGroup(label, providers, color) {
  const row = document.createElement('div');
  row.className = `limit-row limit-row-group${providers.some((provider) => provider.stale) ? ' stale' : ''}`;
  const groupProvider = { provider: 'codex', status: 'ok', windows: [] };
  const head = renderLimitProviderHead('codex', label, groupProvider, color, {
    planText: `${providers.length} accounts`,
    hideMeta: true
  });
  const accountList = document.createElement('div');
  accountList.className = 'limit-account-list';
  providers.forEach((provider, index) => {
    accountList.append(renderLimitProviderRow('codex', codexAccountTitle(provider, index), provider, color, {
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

function mimoAccountTitle(provider, index) {
  const email = String(provider?.accountEmail || '').trim();
  if (email) return state.settings?.maskLimitAccountEmails ? accountIdentityApi.maskEmailAddress(email) : email;
  return `Account ${index + 1}`;
}

function mimoSettingsAccountTitle(account, index) {
  return String(account?.accountEmail || '').trim() || `Account ${index + 1}`;
}

function renderMimoAccountGroup(label, providers, color) {
  const row = document.createElement('div');
  row.className = `limit-row limit-row-group${providers.some((provider) => provider.stale) ? ' stale' : ''}`;
  const groupProvider = { provider: 'mimo', status: 'ok', windows: [] };
  const head = renderLimitProviderHead('mimo', label, groupProvider, color, {
    planText: `${providers.length} accounts`,
    hideMeta: true
  });
  const accountList = document.createElement('div');
  accountList.className = 'limit-account-list';
  providers.forEach((provider, index) => {
    accountList.append(renderLimitProviderRow('mimo', mimoAccountTitle(provider, index), provider, color, {
      accountRow: true,
      accountTitle: true,
      showIcon: false
    }));
  });
  row.append(head, accountList);
  return row;
}

function renderOpenCodeAccountGroup(label, providers, color) {
  const row = document.createElement('div');
  row.className = 'limit-row limit-row-group';
  const groupProvider = { provider: 'opencode', status: 'ok', windows: [] };
  const head = renderLimitProviderHead('opencode', label, groupProvider, color, {
    planText: t('settings.opencode.nAccounts', { count: providers.length }),
    hideMeta: true
  });
  const accountList = document.createElement('div');
  accountList.className = 'limit-account-list';
  providers.forEach((provider) => {
    accountList.append(renderLimitProviderRow('opencode', provider.accountLabel || 'OpenCode', provider, color, {
      accountRow: true,
      showIcon: false
    }));
  });
  row.append(head, accountList);
  return row;
}

function renderLimits() {
  if (!els.limitsPanel) return;
  const holdResetCreditsTooltipRender = resetCreditsTooltipShouldHoldRender();
  const holdCodexSwitchPopoverRender = codexSwitchPopoverShouldHoldRender();
  if (holdResetCreditsTooltipRender || holdCodexSwitchPopoverRender) {
    if (holdResetCreditsTooltipRender) state.resetCreditsTooltipRenderPending = true;
    if (holdCodexSwitchPopoverRender) state.codexSwitchPopoverRenderPending = true;
    return;
  }
  state.resetCreditsTooltipRenderPending = false;
  state.codexSwitchPopoverRenderPending = false;
  const limitsEnabled = state.settings?.limitsEnabled !== false;
  const enabled = enabledLimitProviderSet();
  const providers = providersByLimitProviderId(state.stats?.limits?.providers || []);
  const nodes = [];
  const rows = limitProviderOrderApi
    .orderedLimitProviders(LIMIT_PROVIDERS, state.settings?.limitProviderOrder)
    .filter(({ id }) => limitsEnabled && enabled.has(id));
  if (rows.length === 0) {
    els.limitsPanel.replaceChildren();
    return;
  }
  for (const { id, label } of rows) {
    const providerEnabled = limitsEnabled && enabled.has(id);
    const providerEntries = providerEnabled
      ? (providers.get(id) || [{ provider: id, status: state.stats ? missingLimitProviderStatus() : 'unavailable', windows: [] }])
      : [{ provider: id, status: 'disabled', windows: [] }];
    const visibleProviders = providerEntries.length > 0
      ? providerEntries
      : { provider: id, status: 'disabled', windows: [] };
    const color = id === 'mimo' ? clientColors.xiaomi : (clientColors[id] || clientColors.default);
    if (id === 'codex' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderCodexAccountGroup(label, visibleProviders, color));
      continue;
    }
    if (id === 'opencode' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderOpenCodeAccountGroup(label, visibleProviders, color));
      continue;
    }
    if (id === 'mimo' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderMimoAccountGroup(label, visibleProviders, color));
      continue;
    }
    const provider = Array.isArray(visibleProviders) ? visibleProviders[0] : visibleProviders;
    nodes.push(renderLimitProviderRow(id, label, provider, color, id === 'codex' ? {
      accountTitle: true,
      allowSystemSwitch: true
    } : undefined));
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
  state.openSession = { client, sessionId, sessionCost, title, detail: null };
  renderSessionDetail({ loading: true });
  try {
    const detail = await window.tokenMonitor.getSessionDetail({ client, sessionId, period: state.period, sessionCost });
    if (state.openSession && state.openSession.sessionId === sessionId) {
      state.openSession.detail = detail;
      renderSessionDetail({ detail });
    }
  } catch (_) {
    if (state.openSession && state.openSession.sessionId === sessionId) renderSessionDetail({ error: true });
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
  wrap.querySelector('.detail-ex-value').textContent = formatNumber(row.value);
  wrap.querySelector('.detail-ex-cost').textContent = formatCost(row.cost);
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
  el.querySelector('.detail-turn-split').textContent = split;
  el.querySelector('.detail-turn-tools').textContent = turn.tools ? `⊢ ${turn.tools}` : '';
  el.querySelector('.detail-turn-value').textContent = formatNumber(turn.value);
  el.querySelector('.detail-turn-cost').textContent = formatCost(turn.cost);
  return el;
}

let contentReadySignaled = false;

function renderTrends() {
  const charts = window.TokenMonitorUsageCharts;
  const previousBars = captureTrendBarMotion();
  const preview = state.stats?.historyPreview || { daily: [], monthly: [], summary: {} };
  const todayTotal = Number(state.stats?.periods?.today?.totalTokens || 0);
  const { points, metric, labelKey } = charts.selectPreviewSeries(preview, state.period);
  const finalPoints = state.period === 'today' ? charts.patchTodayBar(points, todayTotal) : points;

  if (finalPoints.length === 0) {
    els.trendsPanel.innerHTML = `<div class="trends-empty">${t('trends.empty')}</div>`;
    return;
  }

  const model = charts.sparklinePreview(finalPoints, { width: 300, height: 120, gap: 0.3, metric });
  const titles = finalPoints.map((p) => `${trendShortLabel(p[labelKey], labelKey)} · ${formatCompact(p[metric])}`);
  const svg = charts.sparklineSvg(model, { titles });

  const summary = preview.summary || {};
  const rangeLabel = state.period === 'allTime' ? t('trends.range.year')
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
    renderBreakdownChange(viewId);
  });
  module.addEventListener('keydown', (event) => {
    if (event.target !== module) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    renderBreakdownChange(viewId);
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
    providers: state.stats?.limits?.providers || [],
    providerOptions,
    enabledProviderIds: Array.from(enabled),
    hiddenProviderIds: Array.from(hiddenHomeLimitProviderSet()),
    colors: clientColors,
    limit: 3,
    sort: hasConfiguredOrder ? 'configured' : 'remaining',
    accountName: (provider, index, providerEntries) => {
      const id = String(provider?.provider || '').trim().toLowerCase();
      const option = providerOptions.find((entry) => entry.id === id);
      return id === 'codex' && providerEntries.length > 1 ? codexAccountTitle(provider, index) : option?.label || id;
    }
  });
}

function homeLimitWindowLabel(window) {
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
  if (window?.kind === 'balance') return 'Balance';
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
      label.textContent = homeLimitWindowLabel(window);
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
      const resetText = document.createElement('span');
      resetText.className = 'home-limit-reset';
      resetText.textContent = resetAt || (window.resetDescription
        ? t('home.reset', { value: window.resetDescription })
        : '\u00a0');
      metric.append(resetText);
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
  return Object.entries(period?.clients || {}).map(([client, value]) => ({
    key: client,
    name: clientLabels[client] || client,
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
  const rows = homeOverviewApi.homeDeviceRows(state.stats?.devices || [], {
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
  const points = Array.isArray(daily) ? daily : [];
  if (points.some((point) => Number.isFinite(Number(point?.intensity)))) return points;
  const metric = points.some((point) => Number(point?.cost || 0) > 0) ? 'cost' : 'tokens';
  const max = Math.max(1, ...points.map((point) => Number(point?.[metric] || 0)));
  return points.map((point) => {
    const ratio = Number(point?.[metric] || 0) / max;
    const intensity = ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : ratio > 0 ? 1 : 0;
    return { ...point, intensity };
  });
}

function applyHomeActivityScroll(scroller) {
  const target = homeOverviewApi.homeActivityScrollTarget({
    scrollWidth: scroller.scrollWidth,
    clientWidth: scroller.clientWidth,
    followEnd: state.homeActivityFollowEnd,
    savedLeft: state.homeActivityScrollLeft
  });
  if (Math.abs(scroller.scrollLeft - target) > 0.5) scroller.scrollLeft = target;
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

  const hide = () => {
    tooltip.dataset.visible = 'false';
    tooltip.setAttribute('aria-hidden', 'true');
    tooltip.style.transform = 'translate(-9999px, -9999px)';
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

  scroller.addEventListener('pointermove', (event) => {
    if (!svg || scroller.classList.contains('is-dragging')) {
      hide();
      return;
    }
    const rect = svg.getBoundingClientRect();
    const view = svg.viewBox.baseVal;
    const x = view.x + (event.clientX - rect.left) * view.width / Math.max(1, rect.width);
    const y = view.y + (event.clientY - rect.top) * view.height / Math.max(1, rect.height);
    moveSpotlight(x, y);

    const target = event.target instanceof Element ? event.target.closest('.heat[data-d]') : null;
    const cell = target && canvas.contains(target) ? target : null;
    if (!cell) {
      hide();
      return;
    }
    if (activeCell !== cell) {
      activeCell?.removeAttribute('data-active');
      activeCell = cell;
      activeCell.setAttribute('data-active', 'true');
      tooltip.querySelector('[data-home-activity-tooltip-count]').textContent = formatCompact(Number(cell.dataset.t || 0));
      tooltip.querySelector('[data-home-activity-tooltip-date]').textContent = cell.dataset.d || '';
    }
    tooltip.dataset.visible = 'true';
    tooltip.setAttribute('aria-hidden', 'false');
    moveHomeActivityTooltip(tooltip, cell);
  });
  scroller.addEventListener('pointerleave', hide);
  scroller.addEventListener('scroll', hide);
  // The tooltip lives on document.body and is only dismissed by handlers on this
  // scroller, which renderHome() throws away on every rebuild. Expose the latest
  // hide() so renderHome/render can clear it — DOM removal fires no pointerleave.
  state.homeActivityHoverTeardown = hide;
}

// Dismiss the body-level activity tooltip + spotlight from outside the scroller's own
// pointer handlers (Home rerender, or switching away from Home while a cell is hovered).
// Clearing the ref after teardown drops the last hold on the old hide() closure, so a
// discarded scroller + its SVG can be collected when the trends module goes away and no
// fresh setupHomeActivityHover reassigns it. setup always re-registers before any hover.
function hideHomeActivityTooltip() {
  state.homeActivityHoverTeardown?.();
  state.homeActivityHoverTeardown = null;
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
  const points = homeOverviewApi.patchDailyToday(rawDaily, today, Number(todayPeriod?.totalTokens || 0), Number(todayPeriod?.costUsd || 0));
  const activityLayout = homeOverviewApi.homeActivityHeatmapLayout();
  const activity = charts.rollingYearHeatmap(dailyWithHeatIntensity(points), {
    endDate: today,
    cell: activityLayout.cell,
    gap: activityLayout.gap
  });
  const activeDays = activity.cells.filter((cell) => cell.intensity > 0).length;
  const { module, body } = homeModuleShell('trends', t('home.activity'), 'trends', t('home.activeDays', { count: activeDays }));
  const activityScroll = document.createElement('div');
  activityScroll.className = 'home-activity-scroll';
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
  const summary = homeOverviewApi.homeTrendSummary(linePoints);
  const trendHead = document.createElement('div');
  trendHead.className = 'home-trend-head';
  const trendTitle = document.createElement('span');
  trendTitle.textContent = t('home.trend');
  const trendMeta = document.createElement('span');
  trendMeta.className = 'home-module-meta';
  trendMeta.textContent = t('home.peakTokens', { value: formatCompact(summary.peak) });
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
  for (const date of summary.dates) {
    const label = document.createElement('span');
    label.className = 'home-trend-date';
    label.textContent = trendShortLabel(date, 'date');
    dates.append(label);
  }
  body.append(activityScroll, trendHead, plot, dates);
  setupHomeActivityScroller(activityScroll, () => animateHomeHistoryVisuals(activityScroll, activityCanvas, chart));
  setupHomeActivityHover(activityScroll);
  return module;
}

function renderHome() {
  if (!els.homePanel) return;
  // The previous scroller (and its ResizeObserver) is about to be replaced; drop the
  // observer so at most one is live and it is gone if the trends module disappears,
  // and hide any open activity tooltip before its owning scroller is discarded.
  hideHomeActivityTooltip();
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
  // setupHomeActivityScroller wires a ResizeObserver that applies the scroll position
  // post-layout, so no requestAnimationFrame guess is needed here.
}

function render() {
  if (!state.stats) return;
  renderSessionUsageArchiveStatus();
  ensureBreakdownVisible();
  renderViewSwitcher();
  if (state.openSession && state.breakdown !== 'session') { state.openSession = null; els.sessionDetail.classList.add('hidden'); els.sessionDetail.replaceChildren(); els.sessionDetailHead.classList.add('hidden'); els.sessionDetailHead.replaceChildren(); }
  if (state.openSession) { els.sessionDetail.classList.remove('hidden'); els.sessionDetailHead.classList.remove('hidden'); } else { els.sessionDetail.classList.add('hidden'); els.sessionDetailHead.classList.add('hidden'); }
  const period = state.stats.periods?.[state.period] || { totalTokens: 0, costUsd: 0, clients: {} };
  const nextTotal = Number(period.totalTokens || 0);
  const totalChanged = nextTotal !== state.currentTotal;
  if (state.suppressInitialNumberAnimation) {
    cancelNumberAnimation();
    els.totalTokens.textContent = formatNumber(nextTotal);
    updateTotalCompact(nextTotal);
    state.suppressInitialNumberAnimation = false;
  } else if (totalChanged) {
    // Keep the compact chip visible through the count-up and lock the font to the
    // widest endpoint first (a downward roll starts wider than it settles), so the
    // number never vanishes, clips, or resizes mid-roll. Re-fit on completion so a
    // window resize during the animation, or a downward settle, still ends correct.
    const widest = formatNumber(nextTotal).length >= formatNumber(state.currentTotal).length ? nextTotal : state.currentTotal;
    els.totalTokens.textContent = formatNumber(widest);
    updateTotalCompact(nextTotal);
    animateNumber(els.totalTokens, state.currentTotal, nextTotal, state.periodMotionActive ? 800 : 1000, fitTotalNumber);
    pulseLiveDot();
  } else {
    cancelNumberAnimation();
    els.totalTokens.textContent = formatNumber(nextTotal);
    updateTotalCompact(nextTotal);
  }
  state.currentTotal = nextTotal;
  els.cost.textContent = formatCost(period.costUsd || 0);
  if (!state.refreshBusy && !state.refreshFeedbackTimer) setRefreshButtonState('idle');
  els.shell.classList.toggle('session-mode', state.breakdown === 'session');
  els.shell.classList.toggle('home-mode', state.breakdown === 'home');
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
    renderRows(rows, {
      showProjectIncompleteHint: state.breakdown === 'project'
        && projectRowsApi.projectBreakdownIncomplete(state.stats, state.period)
    });
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
    stats.periods.allTime.sessions = stats.allTimeSessionsView;
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
    render();
    renderLimitProviderCheckboxes();
    renderToolPreferences();
    renderWslPanel();
    renderDeepseekStatus();
    renderMinimaxStatus();
    renderExternalProviderStatus('zai');
    renderExternalProviderStatus('zaiteam');
    renderExternalProviderStatus('volcengine');
    renderExternalProviderStatus('qoder');
    renderExternalProviderStatus('kimi');
    renderExternalProviderStatus('ollama');
    renderMimoStatus();
    renderCopilotStatus();
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
    publishViewState();
    return false;
  }
  state.period = next;
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

function applyControlLayout(settingsInTitlebar) {
  const titlebarSlot = document.getElementById('titlebarActionSlot');
  const footerSlot = document.getElementById('footerActionSlot');
  if (!titlebarSlot || !footerSlot) return;
  if (settingsInTitlebar) {
    titlebarSlot.appendChild(els.settingsButton);
    footerSlot.appendChild(els.refreshButton);
  } else {
    titlebarSlot.appendChild(els.refreshButton);
    footerSlot.appendChild(els.settingsButton);
  }
}

function applyAppearanceSettings(settings) {
  const opacity = clamp(settings?.glassOpacity ?? 68, 0, 100) / 100;
  const depth = clamp(settings?.glassBlur ?? 32, 0, 100) / 100;
  document.documentElement.style.setProperty('--glass-alpha', opacity.toFixed(2));
  document.documentElement.style.setProperty('--line-alpha', (0.1 + depth * 0.09).toFixed(3));
  document.documentElement.style.setProperty('--line-strong-alpha', (0.18 + depth * 0.14).toFixed(3));
  document.documentElement.style.setProperty('--control-alpha', (0.03 + depth * 0.045).toFixed(3));
  document.documentElement.style.setProperty('--highlight-alpha', (0.045 + depth * 0.06).toFixed(3));
  applyReduceMotionPreference(settings?.reduceMotion);
  // Only full settings objects carry themeColors; glass/zoom preview patches
  // omit it, so we must not wipe theme overrides mid-slider-drag.
  if (settings && 'themeColors' in settings) applyThemeColors(settings.themeColors);
  els.liveDot.style.display = (settings?.showLiveDot !== false) ? '' : 'none';
  els.shell.classList.toggle('desktop-mode', settings?.windowBehavior === 'desktop');
  els.shell.classList.toggle('title-icon-only', settings?.titleIconOnly === true);
  if (settings && 'settingsInTitlebar' in settings) applyControlLayout(settings.settingsInTitlebar === true);
  const isWindows = navigator.userAgent.toLowerCase().includes('windows');
  
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
  const root = document.documentElement.style;
  for (const { name, value } of themePresetsApi.themeCssVarEntries(overrides)) {
    if (value) root.setProperty(name, value);
    else root.removeProperty(name);
  }
}

function applyVendorColorOverrides(overrides) {
  const merged = themePresetsApi.mergeVendorColors(BRAND_VENDOR_COLORS, overrides);
  for (const key of Object.keys(BRAND_VENDOR_COLORS)) clientColors[key] = merged[key];
}

// Current resolved palette value for an interface colour key.
function resolvedThemeColor(key) {
  const clean = themePresetsApi.normalizeOverrides(state.settings?.themeColors, themePresetsApi.INTERFACE_COLOR_KEYS);
  return clean[key] || themePresetsApi.DEFAULT_THEME[key];
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

const BUBBLE_CONTENT_VALUES = ['icon', 'tokens', 'cost', 'both', 'tokensAll', 'costAll', 'bothAll', 'limitsAllSessions', 'bars', 'barsSession', 'barsWeekly', 'barsAllSessions'];
function normalizeTrayContentValue(value) {
  return BUBBLE_CONTENT_VALUES.includes(value) ? value : 'icon';
}

function normalizeWindowToggleShortcutValue(value) {
  return windowShortcutApi.normalizeWindowToggleShortcut(value);
}

const BUBBLE_CONTENT_MIN_W = 18;
const BUBBLE_CONTENT_HEIGHT = 34;
const BUBBLE_CONTENT_PAD_X = 10;
// The tray bars are black (a macOS menu-bar template); on the bubble's dark glass they need light ink.
const BUBBLE_BARS_COLORS = { track: 'rgba(255, 255, 255, 0.22)', fill: 'rgba(255, 255, 255, 0.92)' };

function renderFloatingBubbleContent() {
  const el = els.floatingBubbleContent;
  if (!el || !state.floatingBubble.collapsed) return;
  const mode = state.settings?.floatingBubbleContent || 'icon';
  if (window.TokenMonitorTrayText.isGeneratedTrayIconMode(mode)) {
    const dataUrl = state.stats
      ? trayDataUrlForMode(mode, 44, BUBBLE_BARS_COLORS, { contentOnly: mode === 'barsAllSessions' || mode === 'limitsAllSessions' })
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
    el.textContent = (state.stats && window.TokenMonitorTrayText.formatTrayText(state.stats, mode, currentCurrency(), state.settings)) || 'Σ';
  } else if (mode === 'icon') {
    el.classList.remove('bars');
    el.textContent = 'Σ';
  } else {
    el.classList.remove('bars');
    el.textContent = state.stats ? (window.TokenMonitorTrayText.formatTrayText(state.stats, mode, currentCurrency(), state.settings) || '0') : '0';
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
  return {
    systemGlass: Boolean(els.systemGlassInput.checked),
    reduceMotion: els.reduceMotionInputs?.find((input) => input.checked)?.value || 'system',
    showLiveDot: Boolean(els.liveDotInput.checked),
    showToolIcons: Boolean(els.toolIconsInput.checked),
    titleIconOnly: Boolean(els.titleIconInput.checked),
    showCompactTotalTokens: Boolean(els.showCompactTotalTokensInput.checked),
    settingsInTitlebar: Boolean(els.settingsInTitlebarInput.checked),
    glassOpacity: Number(els.glassInput.value === '' ? defaultAppearance.glassOpacity : els.glassInput.value),
    glassBlur: Number(els.blurInput.value === '' ? defaultAppearance.glassBlur : els.blurInput.value),
    zoomFactor: Number(els.zoomInput.value === '' ? defaultAppearance.zoomFactor * 100 : els.zoomInput.value) / 100
  };
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

function syncPeriodTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.dataset.period === state.period));
  document.querySelector('.tabs')?.style.setProperty('--period-index', String(activeIndex));
  for (const tab of tabs) {
    const active = tab.dataset.period === state.period;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', String(active));
  }
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
  if (els.currencyInput) els.currencyInput.value = currentCurrency();
  syncCurrencyRateControls();
  els.hubUrlInput.value = state.settings.hubUrl || '';
  els.secretInput.value = state.settings.secret || '';
  els.deviceIdInput.value = state.settings.deviceId || '';
  els.limitsRefreshInput.value = String(LIMIT_REFRESH_OPTIONS.includes(Number(state.settings.limitsRefreshMs)) ? state.settings.limitsRefreshMs : 300000);
  els.showLimitSourceInput.checked = Boolean(state.settings.showLimitSource);
  els.maskLimitAccountEmailsInput.checked = Boolean(state.settings.maskLimitAccountEmails);
  els.showLimitUsedInput.value = state.settings.showLimitUsed ? 'used' : 'remaining';
  if (els.syncUploadIntervalInput) {
    const value = Number(state.settings.syncUploadIntervalMs);
    const allowed = Array.from(els.syncUploadIntervalInput.options, (option) => Number(option.value));
    els.syncUploadIntervalInput.value = String(allowed.includes(value) ? value : 0);
  }
  if (els.collectionCadenceInput) {
    const value = Number(state.settings.collectionIntervalMs);
    const allowed = [300000, 900000, 1800000];
    els.collectionCadenceInput.value = state.settings.collectionMode === 'interval'
      ? String(allowed.includes(value) ? value : 300000)
      : 'live';
    if (els.collectionCadenceNote) {
      els.collectionCadenceNote.hidden = els.collectionCadenceInput.value === 'live';
    }
  }
  if (els.wslScanInput) els.wslScanInput.checked = state.settings.wslScanEnabled !== false;
  if (els.sessionUsageArchiveInput) els.sessionUsageArchiveInput.checked = state.settings.sessionUsageArchiveEnabled !== false;
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
  els.systemGlassInput.checked = state.settings.systemGlass !== false;
  const reduceMotion = motionPreferenceApi.normalize(state.settings.reduceMotion);
  for (const input of els.reduceMotionInputs || []) input.checked = input.value === reduceMotion;
  els.liveDotInput.checked = state.settings.showLiveDot !== false;
  els.toolIconsInput.checked = state.settings.showToolIcons !== false;
  els.titleIconInput.checked = state.settings.titleIconOnly === true;
  els.showCompactTotalTokensInput.checked = state.settings.showCompactTotalTokens === true;
  els.settingsInTitlebarInput.checked = state.settings.settingsInTitlebar === true;
  els.discordRpcInput.checked = Boolean(state.settings.discordRpcEnabled);
  syncWindowBehaviorControls();
  els.floatingBubbleInput.checked = state.settings.floatingBubbleEnabled === true;
  if (els.floatingBubbleTriggerInput) els.floatingBubbleTriggerInput.value = state.settings.floatingBubbleTrigger === 'hover' ? 'hover' : 'click';
  if (els.floatingBubbleContentInput) els.floatingBubbleContentInput.value = normalizeTrayContentValue(state.settings.floatingBubbleContent);
  els.floatingBubbleOptions?.classList.toggle('hidden', state.settings.floatingBubbleEnabled !== true);
  const showTrayIcon = state.settings.showTrayIcon !== false;
  if (els.showTrayIconInput) els.showTrayIconInput.checked = showTrayIcon;
  els.trayModeInput.disabled = !showTrayIcon;
  els.trayModeInput.checked = showTrayIcon && Boolean(state.settings.trayMode);
  els.trayContentInput.value = ['tokens', 'cost', 'both', 'tokensAll', 'costAll', 'bothAll', 'limitsAllSessions', 'bars', 'barsSession', 'barsWeekly', 'barsAllSessions', 'icon'].includes(state.settings.trayContent) ? state.settings.trayContent : 'tokens';
  els.trayContentInput.disabled = !showTrayIcon;
  els.showTrayProviderBadgeInput.checked = state.settings.showTrayProviderBadge === true;
  els.showTrayProviderBadgeInput.disabled = !showTrayIcon;
  els.trayIconOptions?.classList.toggle('hidden', !showTrayIcon);
  els.trayOptions?.classList.toggle('hidden', !showTrayIcon || !state.settings.trayMode);
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
  renderExternalProviderStatus('zai');
  renderExternalProviderStatus('zaiteam');
  renderExternalProviderStatus('volcengine');
  renderExternalProviderStatus('qoder');
  renderExternalProviderStatus('kimi');
  renderExternalProviderStatus('ollama');
  renderMimoStatus();
  renderCopilotStatus();
  renderViewPreferences();
  renderToolPreferences();
  renderLimitProviderCheckboxes();
  renderSettingsSummaries();
  renderOpenCodeProfiles();
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
  const { kind, id } = preferenceDrag;
  const order = applyPreferenceLiveOrder(kind, event.clientY) || preferenceDrag.order;
  const changed = preferenceDrag.changed;
  releasePreferencePointer(event.pointerId);
  finishPreferenceDrag();
  if (changed) void onPreferenceOrderCommit(kind, order, id);
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
  const titleKey = kind === 'client'
    ? 'settings.tools.reorderClient'
    : kind === 'view'
      ? 'settings.views.reorderView'
      : kind === 'statusProvider'
        ? 'serviceStatus.reorderProvider'
        : kind === 'homeModule'
          ? 'settings.home.reorderModule'
          : kind === 'homeLimitProvider'
            ? 'settings.home.reorderProvider'
            : 'settings.limits.reorderProvider';
  handle.title = t(titleKey, { name: label });
  handle.setAttribute('aria-label', handle.title);
  handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End');
  handle.disabled = count <= 1;
  handle.addEventListener('pointerdown', (event) => startPreferenceDrag(event, kind, id));
  handle.addEventListener('keydown', (event) => onPreferenceOrderKeydown(event, kind, id));
  return handle;
}

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
  const visibleCount = views.filter((view) => !hidden.has(view.id)).length;
  for (const view of views) {
    const id = view.id;
    const label = viewLabel(view);
    const isHidden = hidden.has(id);
    const historyEnabled = state.settings?.historyEnabled !== false;
    const projectsEnabled = state.settings?.projectsEnabled !== false;
    const isDisabled = (id === 'trends' && !historyEnabled) || (id === 'project' && !projectsEnabled);
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
  wrap.className = 'home-limit-provider-list';
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
  wrap.append(statusLabel, header);
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
  wrap.className = 'home-settings-list';
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
    if (id === 'limits') {
      const configure = document.createElement('button');
      configure.type = 'button';
      configure.className = `view-subgroup-toggle${state.homeLimitSettingsExpanded ? ' is-expanded' : ''}`;
      configure.title = t('settings.home.configureLimits');
      configure.setAttribute('aria-label', configure.title);
      configure.setAttribute('aria-expanded', String(Boolean(state.homeLimitSettingsExpanded)));
      const toggleIcon = document.createElement('span');
      toggleIcon.className = 'view-subgroup-icon';
      toggleIcon.setAttribute('aria-hidden', 'true');
      configure.append(toggleIcon);
      configure.addEventListener('click', () => {
        state.homeLimitSettingsExpanded = !state.homeLimitSettingsExpanded;
        configure.classList.toggle('is-expanded', state.homeLimitSettingsExpanded);
        configure.setAttribute('aria-expanded', String(Boolean(state.homeLimitSettingsExpanded)));
        const container = document.getElementById('homeLimitProviderContainer');
        if (container) container.classList.toggle('hidden', !state.homeLimitSettingsExpanded);
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
  }
  return wrap;
}

function renderTrendSettingsList() {
  const wrap = document.createElement('div');
  wrap.id = 'trendSettingsList';
  wrap.className = 'trend-settings-list';
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
  wrap.className = 'trend-settings-list';
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
  wrap.className = 'status-provider-list';
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
  const devices = state.stats?.devices || [];
  const localId = state.settings?.deviceId || '';
  return (localId && devices.find((device) => device.deviceId === localId))
    || (devices.length === 1 ? devices[0] : null);
}

function localClientStatus() {
  return localDevice()?.clientStatus || {};
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
}

function renderToolPreferences() {
  if (!els.clientDisplayList) return;
  const enabled = enabledClientSet();
  const hidden = hiddenClientSet();
  const pinned = pinnedClientSet();
  const clientStatus = localClientStatus();
  const clients = clientDisplayPreferencesApi.orderedClients(KNOWN_CLIENTS, state.settings?.clientDisplayOrder, state.settings?.pinnedClients);
  const hasCustomOrder = clientDisplayPreferencesApi.hasCustomDisplayOrder(state.settings?.clientDisplayOrder);
  const hasPinnedClients = pinned.size > 0;
  const hasHiddenClients = hidden.size > 0;
  if (els.resetClientDisplayOrderButton) els.resetClientDisplayOrderButton.disabled = !hasCustomOrder && !hasPinnedClients;
  if (els.showAllClientsButton) els.showAllClientsButton.disabled = !hasHiddenClients;
  els.clientDisplayList.replaceChildren();
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
      const tagInfo = clientStatusPresentationApi.clientStatusTag(id, clientStatus[id] || 'waiting');
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
    trackInput.dataset.client = id;
    trackInput.dataset.preference = 'track';
    trackInput.checked = enabled.has(id);
    trackInput.setAttribute('aria-label', t('settings.tools.trackClient', { name: label }));
    trackInput.addEventListener('change', onToolTrackingToggle);
    track.append(trackInput);
    const visibility = document.createElement('button');
    visibility.type = 'button';
    visibility.className = `tool-visibility-button${isHidden ? ' is-hidden' : ''}`;
    visibility.dataset.client = id;
    visibility.title = t(isHidden ? 'settings.tools.showClient' : 'settings.tools.hideClient', { name: label });
    visibility.setAttribute('aria-label', visibility.title);
    visibility.setAttribute('aria-pressed', String(!isHidden));
    visibility.append(visibilityIcon(isHidden));
    visibility.addEventListener('click', () => onClientVisibilityToggle(id));
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = `tool-pin-button${isPinned ? ' is-pinned' : ''}`;
    pin.dataset.client = id;
    pin.title = t(isPinned ? 'settings.tools.unpinClient' : 'settings.tools.pinClient', { name: label });
    pin.setAttribute('aria-label', pin.title);
    pin.setAttribute('aria-pressed', String(isPinned));
    pin.append(pinIcon());
    pin.addEventListener('click', () => onClientPinnedToggle(id));
    const handle = createPreferenceOrderHandle({ kind: 'client', id, label, count: clients.length });
    const actions = document.createElement('div');
    actions.className = 'tool-preference-actions';
    actions.append(track, visibility, pin, handle);
    row.append(labelGroup, actions);
    els.clientDisplayList.appendChild(row);
  }
}

function renderLimitProviderCheckboxes() {
  if (!els.limitProviderCheckboxes) return;
  const enabled = enabledLimitProviderSet();
  const collected = new Map((state.stats?.limits?.providers || []).map((provider) => [provider.provider, provider]));
  const providers = limitProviderOrderApi.orderedLimitProviders(LIMIT_PROVIDERS, state.settings?.limitProviderOrder);
  els.limitProviderCheckboxes.replaceChildren();
  for (const { id, label, settingsLabel } of providers) {
    const provider = enabled.has(id)
      ? (collected.get(id) || { provider: id, ...(state.stats ? { status: missingLimitProviderStatus() } : {}), windows: [] })
      : { provider: id, status: 'disabled', windows: [] };
    const row = document.createElement('div');
    row.className = 'limit-provider-row';
    row.dataset.provider = id;
    const wrap = document.createElement('label');
    wrap.className = 'client-checkbox limit-provider-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.provider = id;
    cb.checked = enabled.has(id);
    cb.addEventListener('change', onLimitProviderToggle);
    const copy = document.createElement('span');
    copy.className = 'limit-provider-copy';
    const text = document.createElement('span');
    text.className = 'limit-provider-name';
    text.textContent = settingsLabel || label;
    const tags = document.createElement('span');
    tags.className = 'limit-provider-tags';
    const provenance = limitProviderProvenance(provider);
    for (const tagInfo of limitProviderPresentationApi.limitProviderSettingsTags(provider, provenance)) {
      const tag = document.createElement('span');
      tag.className = `limit-provider-tag limit-provider-tag-${tagInfo.kind}`;
      if (tagInfo.tone) tag.classList.add(`limit-provider-tag-${tagInfo.tone}`);
      tag.textContent = translatedLimitProviderTag(tagInfo);
      tags.append(tag);
    }
    copy.append(text, tags);
    wrap.append(cb, copy);
    const handle = createPreferenceOrderHandle({
      kind: 'provider',
      id,
      label: settingsLabel || label,
      count: providers.length
    });
    row.append(wrap, handle);
    els.limitProviderCheckboxes.appendChild(row);
  }
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
  await refreshStats({ force: true });
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

async function onPreferenceOrderCommit(kind, order, id) {
  const value = (order || []).join(',');
  if (kind === 'client') {
    const pinned = clientDisplayPreferencesApi.normalizePinnedClients(state.settings?.pinnedClients, KNOWN_CLIENTS).split(',').filter(Boolean);
    const hasCustomOrder = clientDisplayPreferencesApi.hasCustomDisplayOrder(state.settings?.clientDisplayOrder);
    if (!hasCustomOrder && pinned.includes(id)) {
      const pinnedSet = new Set(pinned);
      const nextPinned = (order || []).slice(0, pinned.length);
      if (nextPinned.length === pinned.length && nextPinned.every((clientId) => pinnedSet.has(clientId))) {
        const pinnedValue = nextPinned.join(',');
        if (pinnedValue !== pinned.join(',')) await saveSettings({ pinnedClients: pinnedValue });
        return;
      }
    }
    const current = clientDisplayPreferencesApi.normalizeClientDisplayOrder(state.settings?.clientDisplayOrder, KNOWN_CLIENTS).join(',');
    if (value !== current || pinned.length > 0) await saveSettings({ clientDisplayOrder: value, pinnedClients: '' });
    return;
  }
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
    return;
  }
  const current = limitProviderOrderApi.normalizeLimitProviderOrder(state.settings?.limitProviderOrder, LIMIT_PROVIDERS).join(',');
  if (value !== current) await saveSettings({ limitProviderOrder: value });
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
  const restore = () => {
    panel.scrollTop = scrollTop;
    panel.scrollLeft = scrollLeft;
  };
  const result = callback();
  restore();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
  return result;
}

async function saveSettings(patch) {
  state.settings = await window.tokenMonitor.updateSettings(patch);
  applyEffectiveCurrencyRates();
  preserveSettingsPanelScroll(syncSettingsForm);
  restartTimer();
  maybeUpdateBarsIcon();
  if (patch.showTrayProviderBadge !== undefined) {
    await deliverTrayProviderIcons(patch.showTrayProviderBadge === true);
  }
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

window.addEventListener('blur', () => {
  clearViewSwitcherLongPress();
  clearViewSwitcherHoverClose();
  viewSwitcherLongPressTriggered = false;
  if (state.viewSwitcherOpen) setViewSwitcherOpen(false);
});

async function init() {
  try { state.appInfo = await window.tokenMonitor.getAppInfo?.(); } catch (_) {}
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
    if (els.appUpdatePopover.matches(':popover-open')) renderAppUpdatePopover(payload);
  });
  if (state.appInfo?.loginItemSupported) {
    state.settings.startAtLogin = Boolean(state.appInfo.loginItemOpenAtLogin);
  }
  syncSettingsForm();
  publishViewState();
  await refreshHubInfo();
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
  tab.addEventListener('click', () => {
    const snapshot = captureBreakdownMotion();
    if (!setPeriod(tab.dataset.period)) return;
    syncPeriodTabs();
    if (state.openSession) openSessionDetail(state.openSession);
    state.rowSignature = '';
    state.periodMotionActive = true;
    render();
    state.periodMotionActive = false;
    animateBreakdownFrom(snapshot, { duration: 800 });
  });
}

els.breakdown.addEventListener('click', (event) => {
  if (state.breakdown !== 'session') return;
  const rowEl = event.target.closest('.row');
  if (!rowEl) return;
  const key = rowEl.dataset.key || '';            // "session:<client>:<sessionId>"
  const client = rowEl.dataset.client || '';
  if (client !== 'claude' && client !== 'codex' && client !== 'opencode') return;
  const match = key.match(/^session:([^:]+):(.+)$/);
  if (!match) return;
  const sessionId = match[2];
  const period = state.stats?.periods?.[state.period];
  const session = period?.sessions?.[`${client}:${sessionId}`];
  openSessionDetail({
    client,
    sessionId,
    sessionCost: Number(session?.costUsd || 0),
    title: rowEl.querySelector('.row-title')?.textContent || ''
  });
});

els.pinButton.addEventListener('click', () => {
  saveSettings({ windowBehavior: nextWindowBehavior(currentWindowBehavior()) });
});
els.settingsButton.addEventListener('click', () => {
  if (state.viewSwitcherOpen) setViewSwitcherOpen(false);
  els.settingsPanel.classList.toggle('hidden');
  const settingsOpen = !els.settingsPanel.classList.contains('hidden');
  if (!settingsOpen) stopWindowShortcutRecording();
  els.shell.classList.toggle('settings-open', settingsOpen);
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
  await refreshStats();
});

els.hubModeOptions.addEventListener('change', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.name !== 'hubMode') return;
  await saveSettings({ hubMode: target.value });
  await refreshHubInfo();
  await refreshStats();
});

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
  await saveSettings({ limitsRefreshMs: Number(els.limitsRefreshInput.value) });
  await refreshStats({ force: true });
});
els.showLimitSourceInput.addEventListener('change', async () => {
  await saveSettings({ showLimitSource: els.showLimitSourceInput.checked });
});
els.maskLimitAccountEmailsInput.addEventListener('change', async () => {
  await saveSettings({ maskLimitAccountEmails: els.maskLimitAccountEmailsInput.checked });
  renderLimits();
});
els.showLimitUsedInput.addEventListener('change', async () => {
  await saveSettings({ showLimitUsed: els.showLimitUsedInput.value === 'used' });
});
els.syncUploadIntervalInput?.addEventListener('change', async () => {
  await saveSettings({ syncUploadIntervalMs: Number(els.syncUploadIntervalInput.value) });
});
els.collectionCadenceInput?.addEventListener('change', async () => {
  const value = els.collectionCadenceInput.value;
  await saveSettings({
    collectionMode: value === 'live' ? 'live' : 'interval',
    collectionIntervalMs: value === 'live' ? Number(state.settings.collectionIntervalMs || 300000) : Number(value)
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
els.applyThemeCodeButton?.addEventListener('click', () => { void pasteAndApplyThemeCode(); });
els.copyThemeCodeButton?.addEventListener('click', () => { void copyCurrentThemeCode(); });
els.themeCodeInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void applyThemeCodeFromInput();
});
els.themeCodeInput?.addEventListener('input', invalidateThemeCodeFeedback);
function setupThemeAccordion(group, toggle, details) {
  if (!group || !toggle || !details) return;
  const setExpanded = (expanded) => {
    const open = Boolean(expanded);
    toggle.setAttribute('aria-expanded', String(open));
    details.classList.toggle('hidden', !open);
    details.inert = !open;
    group.classList.toggle('expanded', open);
  };
  toggle.addEventListener('click', () => setExpanded(details.classList.contains('hidden')));
  setExpanded(false);
}

setupThemeAccordion(els.themeAdvancedGroup, els.themeAdvancedToggle, els.themeAdvancedDetails);
setupThemeAccordion(els.themeVendorGroup, els.themeVendorToggle, els.themeVendorDetails);
els.systemGlassInput.addEventListener('change', saveAppearanceFromControls);
for (const input of els.reduceMotionInputs || []) {
  input.addEventListener('change', async () => {
    if (!input.checked) return;
    state.settings.reduceMotion = applyReduceMotionPreference(input.value);
    await saveAppearanceFromControls();
  });
}
els.liveDotInput.addEventListener('change', saveAppearanceFromControls);
els.toolIconsInput.addEventListener('change', saveAppearanceFromControls);
els.titleIconInput.addEventListener('change', saveAppearanceFromControls);
els.showCompactTotalTokensInput.addEventListener('change', async () => {
  await saveAppearanceFromControls();
  if (!numberAnimHandle) updateTotalCompact(state.currentTotal);
});
window.addEventListener('resize', () => { if (!numberAnimHandle) fitTotalNumber(); });
els.settingsInTitlebarInput.addEventListener('change', saveAppearanceFromControls);
els.discordRpcInput.addEventListener('change', saveAppearanceFromControls);
els.windowBehaviorInput.addEventListener('change', () => saveSettings({ windowBehavior: els.windowBehaviorInput.value }));
els.floatingBubbleInput.addEventListener('change', () => {
  els.floatingBubbleOptions?.classList.toggle('hidden', !els.floatingBubbleInput.checked);
  saveSettings({ floatingBubbleEnabled: els.floatingBubbleInput.checked });
});
els.floatingBubbleTriggerInput?.addEventListener('change', () => saveSettings({ floatingBubbleTrigger: els.floatingBubbleTriggerInput.value }));
els.floatingBubbleContentInput?.addEventListener('change', async () => {
  await saveSettings({ floatingBubbleContent: els.floatingBubbleContentInput.value });
  renderFloatingBubbleContent();
});
els.showTrayIconInput?.addEventListener('change', () => {
  const showTrayIcon = els.showTrayIconInput.checked;
  els.trayModeInput.disabled = !showTrayIcon;
  if (!showTrayIcon) els.trayModeInput.checked = false;
  els.trayContentInput.disabled = !showTrayIcon;
  els.showTrayProviderBadgeInput.disabled = !showTrayIcon;
  els.trayIconOptions?.classList.toggle('hidden', !showTrayIcon);
  els.trayOptions?.classList.toggle('hidden', !showTrayIcon || !els.trayModeInput.checked);
  saveSettings({ showTrayIcon, trayMode: showTrayIcon ? els.trayModeInput.checked : false });
});
els.trayModeInput.addEventListener('change', () => {
  els.trayOptions?.classList.toggle('hidden', !els.showTrayIconInput?.checked || !els.trayModeInput.checked);
  saveSettings({ trayMode: els.trayModeInput.checked });
});
els.trayContentInput.addEventListener('change', () => saveSettings({ trayContent: els.trayContentInput.value }));
els.showTrayProviderBadgeInput.addEventListener('change', () => saveSettings({ showTrayProviderBadge: els.showTrayProviderBadgeInput.checked }));
els.windowToggleShortcutValue?.addEventListener('click', startWindowShortcutRecording);
els.windowToggleShortcutClearButton?.addEventListener('click', () => setWindowToggleShortcut('').catch(() => {}));
els.startAtLoginInput?.addEventListener('change', () => saveSettings({ startAtLogin: els.startAtLoginInput.checked }));
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
els.reportIssueButton?.addEventListener('click', () => window.tokenMonitor.openExternal?.(TOKEN_MONITOR_ISSUES_URL));
els.refreshButton.addEventListener('click', () => {
  if (state.breakdown === 'status') refreshStatusViewManually().catch(() => {});
  // Only this button asks for a history rescan: `{ force: true }` is used all over the
  // settings/account flows, and folding history into it would re-run the expensive
  // `tokscale graph` on every one of them.
  else refreshStats({ force: true, forceHistory: true, feedback: true });
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
  const mode = appUpdateActionMode(state.appUpdate);
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
  if (appUpdateActionMode(state.appUpdate) === 'install') {
    await runAppUpdateAction();
    return;
  }
  if (!renderAppUpdatePopover(state.appUpdate) || typeof els.appUpdatePopover.showPopover !== 'function') {
    await runAppUpdateAction();
    return;
  }
  positionAppUpdatePopover();
  els.appUpdatePopover.showPopover();
  els.appUpdatePopoverAction.focus();
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
  state.settings = next;
  applyEffectiveCurrencyRates();
  syncSettingsForm();
  maybeUpdateBarsIcon();
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

window.tokenMonitor.onStatsPush?.((payload) => {
  if (!payload) return;
  if (payload.event === 'status') {
    state.streamConnected = Boolean(payload.data?.connected);
    if (payload.data?.mode) state.mode = payload.data.mode;
    state.streamFailure = state.streamConnected ? null : (payload.data?.reason ? { reason: payload.data.reason, detail: payload.data.detail ?? null } : state.streamFailure);
  } else if (payload.data?.stats) {
    // Local collector overlays update client-mode data independently of the
    // Hub SSE transport. Preserve its current Offline/error state until a
    // real stream status or remote stats event proves the connection changed.
    if (payload.data?.reason !== 'local') {
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
  if (payload.data?.stats) {
    render();
    renderLimitProviderCheckboxes();
    renderToolPreferences();
    renderWslPanel();
    renderDeepseekStatus();
    renderMinimaxStatus();
    renderExternalProviderStatus('zai');
    renderExternalProviderStatus('zaiteam');
    renderExternalProviderStatus('volcengine');
    renderExternalProviderStatus('qoder');
    renderExternalProviderStatus('kimi');
    renderExternalProviderStatus('ollama');
    renderCopilotStatus();
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
const trayProviderIconDeliveryGuard = window.TokenMonitorTrayProviderIcons.createTrayProviderIconDeliveryGuard();

function renderBarsIcon(stats, height = 44, picker = pickWorstProvider, colors = {}) {
  const trackColor = colors.track || 'rgba(0, 0, 0, 0.32)';
  const fillColor = colors.fill || 'rgba(0, 0, 0, 1)';
  const selection = picker(stats);
  if (!selection) return null;
  const { providerRecord, primaryWindow, secondaryWindow } = selection;
  const providerImage = trayProviderImages[providerRecord.provider];
  const { trayBarFillWidth, trayBarsLayout } = window.TokenMonitorTrayBars;
  const layout = trayBarsLayout(height);

  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, layout.width, layout.height);

  if (providerImage) {
    ctx.drawImage(providerImage, layout.padX, layout.iconY, layout.iconSize, layout.iconSize);
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

  drawBar(layout.barsStartY, primaryWindow?.remainingPercent);
  drawBar(layout.barsStartY + layout.barHeight + layout.barGap, secondaryWindow?.remainingPercent);
  return canvas.toDataURL('image/png');
}

function pickConfiguredSessionProviders(stats, configOrder) {
  return window.TokenMonitorTrayText.pickConfiguredLimitProviders(stats, {
    limitProviderOrder: configOrder,
    limitProviders: configOrder,
    showLimitUsed: Boolean(state.settings?.showLimitUsed)
  });
}

function renderAllSessionsIcon(stats, height = 44, configOrder, colors = {}) {
  const trackColor = colors.track || 'rgba(0, 0, 0, 0.32)';
  const fillColor = colors.fill || 'rgba(0, 0, 0, 1)';
  const picks = pickConfiguredSessionProviders(stats, configOrder);
  if (picks.length === 0) return null;
  // With one tool, preserve its canonical pair; a lone weekly/billing window is
  // promoted to the top lane and the lower lane remains an empty track.
  if (picks.length === 1) return renderBarsIcon(stats, height, () => picks[0], colors);

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

  drawBar(layout.barsStartY, picks[0].primaryWindow.remainingPercent);
  drawBar(layout.barsStartY + layout.barHeight + layout.barGap, picks[1].primaryWindow.remainingPercent);
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
  const showUsed = Boolean(state.settings?.showLimitUsed);

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = font;
  const visiblePicks = picks.length === 1
    ? [{
        ...picks[0],
        text: [picks[0].primaryWindow, picks[0].secondaryWindow]
          .filter(Boolean)
          .map((window) => formatPercent(limitFillPercent(window.remainingPercent, window.usedPercent, showUsed)))
          .join(separator)
      }]
    : picks.map((pick) => ({
        ...pick,
        text: formatPercent(limitFillPercent(pick.primaryWindow.remainingPercent, pick.primaryWindow.usedPercent, showUsed))
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
      ctx.drawImage(entry.image, x, layout.iconY, iconSize, iconSize);
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

function barsDataUrlForMode(mode, size = 44, colors, options = {}) {
  if (mode === 'barsAllSessions') return renderAllSessionsIcon(state.stats, size, configuredLimitProviderOrder(), colors, options);
  const pickers = { barsSession: pickWorstSessionProvider, barsWeekly: pickWorstWeeklyProvider };
  return renderBarsIcon(state.stats, size, pickers[mode] || pickWorstProvider, colors);
}

function trayDataUrlForMode(mode, size = 44, colors, options = {}) {
  if (mode === 'limitsAllSessions') return renderLimitSessionsIcon(state.stats, size, configuredLimitProviderOrder(), colors, options);
  return barsDataUrlForMode(mode, size, colors, options);
}

async function maybeUpdateBarsIcon() {
  const mode = state.settings?.trayContent;
  if (!window.TokenMonitorTrayText.isGeneratedTrayIconMode(mode)) return;
  if (!window.tokenMonitor.setTrayIcons) return;
  const dataUrl = trayDataUrlForMode(mode, 44);
  try { await window.tokenMonitor.setTrayIcons({ [mode]: dataUrl || null }); } catch (_) {}
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`load failed: ${src}`));
    img.src = src;
  });
}

function providerImageToPngDataUrl(img, size, showBadge = false) {
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
    ctx.drawImage(img, imageInset, imageInset, imageSize, imageSize);
    ctx.restore();
  }
  ctx.drawImage(img, imageInset, imageInset, imageSize, imageSize);

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
  const sources = window.TokenMonitorTrayProviderIcons.trayProviderIconSources(clientsWithIcon);
  const icons = {};
  for (const [id, path] of Object.entries(sources)) {
    try {
      const img = await loadImage(path);
      trayProviderImages[id] = img;
      icons[id] = providerImageToPngDataUrl(img, 44, showBadge);
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
  const urlActions = document.getElementById('codexLoginUrlActions');
  const details = document.getElementById('codexLoginDetails');
  const output = document.getElementById('codexLoginOutput');
  if (!addButton || !cancelButton || !refreshButton || !openButton || !copyButton || !statusEl || !urlActions || !details || !output) return;

  addButton.classList.toggle('hidden', state.codexSignInBusy);
  cancelButton.classList.toggle('hidden', !state.codexSignInBusy);
  refreshButton.classList.toggle('hidden', state.codexSignInBusy);
  statusEl.textContent = state.codexLoginStatus;
  statusEl.classList.toggle('hidden', !state.codexLoginStatus);
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
      info.textContent = enabled ? limitProviderPresentationApi.limitProviderDisplayLabel(account.accountLabel) : t('settings.codex.disabled');
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

function mimoAccountLinked() {
  return (state.settings?.mimoManagedAccounts || []).length > 0;
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
  kimi: {
    configuredKey: 'kimiApiKeyConfigured',
    sourceKey: 'kimiApiKeySource',
    pendingKey: 'kimiPendingCheckSince'
  },
  ollama: {
    configuredKey: 'ollamaCookieConfigured',
    sourceKey: 'ollamaCookieSource',
    pendingKey: 'ollamaPendingCheckSince'
  }
};

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

function copilotAccountStatusText(provider, configured, source) {
  const accountStatus = limitProviderPresentationApi.apiKeyAccountStatus(provider, configured);
  if (accountStatus === 'linked') {
    const accountName = String(provider?.accountName || '').trim();
    return accountName || t(source === 'env' ? 'settings.copilot.statusEnv' : 'settings.copilot.statusSet');
  }
  if (accountStatus === 'invalid') return t('settings.copilot.statusInvalid');
  if (accountStatus === 'notConfigured') return t('settings.copilot.statusNotSet');
  const statusKeys = {
    checking: 'settings.common.checking',
    limited: 'settings.common.limited',
    unavailable: 'settings.common.unavailable',
    notChecked: 'settings.common.notChecked',
    error: 'settings.common.error'
  };
  return t(statusKeys[accountStatus] || 'settings.common.error');
}

function apiKeyAccountStatusText(providerName, provider, configured, source) {
  const accountStatus = limitProviderPresentationApi.apiKeyAccountStatus(provider, configured);
  if (accountStatus === 'linked') {
    return t(source === 'env' ? `settings.${providerName}.statusEnv` : `settings.${providerName}.statusSet`);
  }
  if (accountStatus === 'invalid') return t(`settings.${providerName}.statusInvalid`);
  if (accountStatus === 'notConfigured') return t(`settings.${providerName}.statusNotSet`);
  const statusKeys = {
    checking: 'settings.common.checking',
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
  state[`${providerName}AccountExpanded`] = expanded;
  details.classList.toggle('hidden', !expanded);
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
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
  const pending = Number(state[config.pendingKey] || 0) > 0;
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
    pending ? t('settings.common.checking') : apiKeyAccountStatusText(providerName, provider, configured, source)
  );
  manualPanel.classList.toggle('hidden', linked);
  openBtn.classList.toggle('hidden', linked);
  logoutBtn.classList.toggle('hidden', !linked || source !== 'settings');
  refreshBtn.classList.toggle('hidden', !configured);
  renderSettingsSummaries();
}

function setMinimaxAccountExpanded(expanded) {
  const details = document.getElementById('minimaxSettingsDetails');
  const toggle = document.getElementById('minimaxSettingsToggle');
  if (!details || !toggle) return;
  state.minimaxAccountExpanded = expanded;
  details.classList.toggle('hidden', !expanded);
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
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
  const linked = minimaxAccountLinked();
  setCursorStatusText(statusEl, apiKeyAccountStatusText('minimax', provider, configured, source));
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
  const linked = copilotAccountLinked();
  errorEl.textContent = state.copilotErrorMessage || '';
  errorEl.classList.toggle('hidden', !state.copilotErrorMessage);
  setCursorStatusText(statusEl, copilotAccountStatusText(provider, configured, source));
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
  const linked = deepseekAccountLinked();
  setCursorStatusText(statusEl, apiKeyAccountStatusText('deepseek', provider, configured, source));
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

  api.getProfiles().then(({ profiles, hasEnvVar }) => {
    listEl.innerHTML = '';
    const entries = Object.entries(profiles);

    if (entries.length === 0 && !hasEnvVar) {
      listEl.innerHTML = '<div class="opencode-empty">' + t('settings.opencode.emptyList') + '</div>';
      state.opencodeProfileCount = 0;
      renderSettingsSummaries();
      return;
    }

    state.opencodeProfileCount = entries.length;
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
      function endRename(save) {
        if (!editing) return;
        editing = false;
        nameInput.classList.add('hidden');
        nameSpan.classList.remove('hidden');
        if (save && nameInput.value.trim() && nameInput.value.trim() !== name) {
          api.renameProfile(name, nameInput.value.trim()).then(() => {
            renderOpenCodeProfiles();
            updateOpenCodeProfilesStatus();
            renderSettingsSummaries();
          });
        }
      }
      renameBtn.addEventListener('click', beginRename);
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') endRename(true);
        if (e.key === 'Escape') endRename(false);
      });
      nameInput.addEventListener('blur', () => endRename(true));

      nameBox.append(nameSpan, nameInput, renameBtn);

      const rightBox = document.createElement('span');
      rightBox.className = 'profile-right';

      const infoSpan = document.createElement('span');
      infoSpan.className = 'profile-info';
      infoSpan.id = 'opencode-info-' + name.replace(/[^a-zA-Z0-9_-]/g, '_');
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

      rightBox.append(infoSpan, deleteBtn);
      item.append(toggle, nameBox, rightBox);
      listEl.appendChild(item);
    }

    updateOpenCodeProfilesStatus();
  });
}

async function updateOpenCodeProfilesStatus() {
  const api = window.tokenMonitor.opencode;
  const status = await api.status();
  const profiles = status.profiles || {};

  for (const [name, s] of Object.entries(profiles)) {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const infoEl = document.getElementById('opencode-info-' + safeName);
    if (!infoEl) continue;

    if (s.expired) {
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

  // Update summary pill
  const totalEl = document.getElementById('opencodeCookieStatus');
  if (totalEl) {
    const linkedCount = Object.values(profiles).filter(s => s.linked).length;
    const configuredProfileCount = state.opencodeProfileCount || 0;
    const totalCount = Math.max(Object.keys(profiles).length, configuredProfileCount);
    if (totalCount > 0) {
      totalEl.textContent = t('settings.opencode.connected', { linked: linkedCount, total: totalCount });
    } else {
      totalEl.textContent = t('settings.opencode.statusNotSet');
    }
  }
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
    setSettingsSectionExpanded('accounts', true);
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
    setSettingsSectionExpanded('accounts', true);
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
    row.className = 'managed-account-row';
    const main = document.createElement('div');
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
    remove.className = 'managed-account-remove';
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
    const hasInput = typeof entry.inputPerM === 'number' && entry.inputPerM > 0;
    const hasOutput = typeof entry.outputPerM === 'number' && entry.outputPerM > 0;
    if (!hasInput && !hasOutput) { showError(t('settings.customPricing.errorNoPrice')); return; }
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
    const codexLoginDetails = document.getElementById('codexLoginDetails');
    window.tokenMonitor.codex.onLoginStatus((status) => {
      if (!status || !isCurrentCodexSignInFlow(status.flowId) || status.phase !== 'output') return;
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
      state.codexAccountError = '';
      if (codexLoginDetails) codexLoginDetails.open = false;
      renderCodexLoginStatus();
      renderCodexAccounts();
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

    document.getElementById('opencodeCookieSubmit').addEventListener('click', async () => {
      const input = document.getElementById('opencodeCookieInput');
      const nameInput = document.getElementById('opencodeProfileName');
      const errorEl = document.getElementById('opencodeErrorMessage');
      const name = (nameInput.value || '').trim() || 'default';
      const cookie = input.value;

      errorEl.classList.add('hidden');

      const result = await window.tokenMonitor.opencode.saveProfile(name, cookie);
      if (result.ok) {
        input.value = '';
        nameInput.value = '';
        renderOpenCodeProfiles();
        updateOpenCodeProfilesStatus();
        renderSettingsSummaries();
      } else {
        errorEl.textContent = result.error || t('settings.opencode.saveFailedShort');
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
      await saveSettings({ kimiApiKey: '' });
      clearExternalProviderCheckPending('kimi');
      clearExternalProviderPendingStatus('kimi');
      renderExternalProviderStatus('kimi');
      await refreshStats({ force: true });
    });

    document.getElementById('kimiRefreshButton').addEventListener('click', async () => {
      await refreshStats({ force: true });
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
    '.hub-mode-fields',
    '.presence-feature-body',
    '#cursorManualPanel',
    '#opencodeManualPanel',
    '#deepseekManualPanel',
    '#minimaxManualPanel',
    '#zaiManualPanel',
    '#zaiteamManualPanel',
    '#volcengineManualPanel',
    '#qoderManualPanel',
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
