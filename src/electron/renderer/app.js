'use strict';

const clientLabels = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', gemini: 'Gemini', cursor: 'Cursor', opencode: 'OpenCode', openclaw: 'OpenClaw', antigravity: 'Antigravity', cline: 'Cline', kimi: 'Kimi', qwen: 'Qwen', grok: 'Grok Build', copilot: 'GitHub Copilot' };
const { clientColors, fallbackModelColors, modelVendorFor, modelColor } = window.TokenMonitorUsageCharts;
const clientsWithIcon = new Set([
  'claude', 'codex', 'gemini', 'cursor', 'opencode', 'openclaw', 'hermes', 'antigravity', 'cline', 'kimi', 'qwen', 'grok', 'copilot',
  'xai', 'deepseek', 'meta', 'mistral', 'qwen', 'moonshot', 'zai', 'cohere', 'xiaomi', 'minimax'
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
  { id: 'copilot', label: 'GitHub Copilot' }
];
const LIMIT_PROVIDERS = [
  { id: 'claude', label: 'Claude', settingsLabel: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'deepseek', label: 'DeepSeek' }
];
const DEFAULT_LIMIT_PROVIDER_ORDER = LIMIT_PROVIDERS.map((provider) => provider.id).join(',');
const limitProviderOrderApi = window.TokenMonitorLimitProviderOrder;
const limitProviderPresentationApi = window.TokenMonitorLimitProviderPresentation;
const clientStatusPresentationApi = window.TokenMonitorClientStatusPresentation;
const serviceStatusPresentationApi = window.TokenMonitorServiceStatusPresentation;
const clientDisplayPreferencesApi = window.TokenMonitorClientDisplayPreferences;
const customPricingFormApi = window.TokenMonitorCustomPricingForm;
const viewDisplayPreferencesApi = window.TokenMonitorViewDisplayPreferences;
const preferenceDragSortApi = window.TokenMonitorPreferenceDragSort;
const homeOverviewApi = window.TokenMonitorHomeOverview;
const i18n = window.TokenMonitorI18n;
const currencyApi = window.TokenMonitorCurrency;
const sessionRowsApi = window.TokenMonitorSessionRows;
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
  'App/CLI RPC': 'settings.limits.capability.appCliRpc',
  'Manual login': 'settings.limits.capability.manualLogin',
  Web: 'settings.limits.capability.web',
  'App/CLI must be open': 'settings.limits.capability.appMustBeOpen',
  RPC: 'settings.limits.capability.rpc',
  'Local/Zen': 'settings.limits.capability.localZen',
  'Pay-as-you-go': 'settings.limits.capability.payg',
  'API key': 'settings.limits.capability.apiKey',
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
  Limited: 'settings.limits.status.limited',
  'Usage API limited': 'settings.limits.status.usageApiLimited',
  Unavailable: 'settings.limits.status.unavailable',
  'Not set up': 'settings.limits.status.notSetUp',
  Error: 'settings.limits.status.error'
};
const deviceAccent = '#73bdf5';
const deviceStaleColor = '#8c97a7';
const baseBreakdownOrder = ['tool', 'device', 'model', 'session'];
const VIEW_DISPLAY_OPTIONS = [
  { id: 'home', labelKey: 'views.home' },
  { id: 'tool', labelKey: 'views.tool' },
  { id: 'status', labelKey: 'views.status' },
  { id: 'device', labelKey: 'views.device' },
  { id: 'model', labelKey: 'views.model' },
  { id: 'session', labelKey: 'views.session' },
  { id: 'limits', labelKey: 'views.limits' },
  { id: 'trends', labelKey: 'views.trends' }
];
const viewPeriodValues = new Set(['today', 'month', 'allTime']);
const viewBreakdownValues = new Set(['home', ...baseBreakdownOrder, 'status', 'limits', 'trends']);
const HOME_MODULE_VIEW_IDS = new Set(['limits', 'model', 'trends']);
const VIEW_SWITCHER_LONG_PRESS_MS = 420;
const VIEW_SWITCHER_HOVER_CLOSE_MS = 160;
const VIEW_ICON_CLASSES = {
  home: 'view-icon-home',
  tool: 'view-icon-tool',
  status: 'view-icon-status',
  device: 'view-icon-device',
  model: 'view-icon-model',
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
const serviceStatusProviderPreferencesApi = window.TokenMonitorServiceStatusProviderPreferences;
const SETTINGS_SECTION_IDS = ['general', 'main', 'window', 'appearance', 'tools', 'limits', 'accounts', 'sync'];
const REFRESH_BUTTON_FEEDBACK_MS = 700;
const initialFloatingBubble = window.__TOKEN_MONITOR_INITIAL_FLOATING_BUBBLE__ || { collapsed: false, side: null };
const initialViewState = window.__TOKEN_MONITOR_INITIAL_VIEW_STATE__ || {};
let initialBreakdownPreferenceApplied = typeof initialViewState.breakdown === 'string';

function normalizeInitialViewValue(value, allowed, fallback) {
  const raw = String(value || '').trim();
  return allowed.has(raw) ? raw : fallback;
}

const state = { period: normalizeInitialViewValue(initialViewState.period, viewPeriodValues, 'today'), appUpdate: null, breakdown: normalizeInitialViewValue(initialViewState.breakdown, viewBreakdownValues, 'home'), viewSwitcherOpen: false, settings: null, stats: null, homeHistory: null, homeHistoryBusy: false, homeHistoryRequested: false, homeActivityScrollLeft: null, serviceStatus: null, serviceStatusBusy: false, serviceProvidersExpanded: false, trendSettingsExpanded: false, homeSettingsExpanded: false, serviceStatusTicker: null, refreshTimer: null, refreshBusy: false, refreshFeedbackTimer: null, currentTotal: 0, rowSignature: '', streamConnected: false, streamFailure: null, mode: 'idle', appInfo: null, tokscaleStatus: null, tokscaleCheck: null, tokscaleBusy: false, hubInfo: null, cursorAccount: { status: null, error: '' }, cursorAccountExpanded: false, codexAccountExpanded: false, codexAccountError: '', customPricingExpanded: false, opencodeProfileCount: 0, opencodeCookieExpanded: false, deepseekAccountExpanded: false, deepseekPendingCheckSince: 0, floatingBubble: initialFloatingBubble, suppressInitialNumberAnimation: window.__TOKEN_MONITOR_SUPPRESS_INITIAL_NUMBER_ANIMATION__ === true, openSession: null, detailSort: 'time', recordingWindowShortcut: false, windowShortcutInvalid: false };
state.settingsSections = Object.fromEntries(SETTINGS_SECTION_IDS.map((id) => [id, false]));
const defaultAppearance = { glassOpacity: 68, glassBlur: 32, zoomFactor: 1, systemGlass: true, showLiveDot: true, showToolIcons: true, titleIconOnly: false, settingsInTitlebar: false };
let preferenceDrag = null;
let viewSwitcherLongPressTimer = null;
let viewSwitcherLongPressTriggered = false;
let viewSwitcherHoverCloseTimer = null;
const els = {
  shell: document.querySelector('.shell'), status: document.getElementById('status'), liveDot: document.getElementById('liveDot'), totalTokens: document.getElementById('totalTokens'), cost: document.getElementById('cost'), homePanel: document.getElementById('homePanel'), breakdown: document.getElementById('breakdown'), serviceStatusPanel: document.getElementById('serviceStatusPanel'), limitsPanel: document.getElementById('limitsPanel'), trendsPanel: document.getElementById('trendsPanel'), viewSwitcher: document.getElementById('viewSwitcher'), pinButton: document.getElementById('pinButton'), settingsButton: document.getElementById('settingsButton'), settingsPanel: document.getElementById('settingsPanel'), languageInput: document.getElementById('languageInput'), currencyInput: document.getElementById('currencyInput'), hubUrlInput: document.getElementById('hubUrlInput'), secretInput: document.getElementById('secretInput'), deviceIdInput: document.getElementById('deviceIdInput'), limitProviderCheckboxes: document.getElementById('limitProviderCheckboxes'), limitsRefreshInput: document.getElementById('limitsRefreshInput'), showLimitSourceInput: document.getElementById('showLimitSourceInput'), showActiveAccountInput: document.getElementById('showActiveAccountInput'), systemGlassInput: document.getElementById('systemGlassInput'), liveDotInput: document.getElementById('liveDotInput'), toolIconsInput: document.getElementById('toolIconsInput'), floatingBubbleInput: document.getElementById('floatingBubbleInput'), floatingBubbleTriggerInput: document.getElementById('floatingBubbleTriggerInput'), floatingBubbleTriggerRow: document.getElementById('floatingBubbleTriggerRow'), floatingBubbleContentInput: document.getElementById('floatingBubbleContentInput'), floatingBubbleContentRow: document.getElementById('floatingBubbleContentRow'), floatingBubbleContent: document.getElementById('floatingBubbleContent'), discordRpcInput: document.getElementById('discordRpcInput'), windowBehaviorInput: document.getElementById('windowBehaviorInput'), showTrayIconInput: document.getElementById('showTrayIconInput'), trayModeInput: document.getElementById('trayModeInput'), trayContentInput: document.getElementById('trayContentInput'), windowToggleShortcutValue: document.getElementById('windowToggleShortcutValue'), windowToggleShortcutRecordButton: document.getElementById('windowToggleShortcutRecordButton'), windowToggleShortcutClearButton: document.getElementById('windowToggleShortcutClearButton'), windowToggleShortcutNote: document.getElementById('windowToggleShortcutNote'), glassInput: document.getElementById('glassInput'), blurInput: document.getElementById('blurInput'), zoomInput: document.getElementById('zoomInput'), resetGlassButton: document.getElementById('resetGlassButton'), resetDepthButton: document.getElementById('resetDepthButton'), resetZoomButton: document.getElementById('resetZoomButton'), saveSettingsButton: document.getElementById('saveSettingsButton'), clientDisplayList: document.getElementById('clientDisplayList'), openConfigButton: document.getElementById('openConfigButton'), refreshButton: document.getElementById('refreshButton'), minButton: document.getElementById('minButton'), closeButton: document.getElementById('closeButton'), floatingBubbleTab: document.getElementById('floatingBubbleTab')
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
  hubStatusRow: document.getElementById('hubStatusRow'),
  syncClientStatus: document.getElementById('syncClientStatus'),
  hubAddressList: document.getElementById('hubAddressList'),
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
  appUpdatePill: document.getElementById('appUpdatePill'),
  appUpdatePillAction: document.getElementById('appUpdatePillAction'),
  appUpdatePillLabel: document.getElementById('appUpdatePillLabel'),
  appUpdatePillDismiss: document.getElementById('appUpdatePillDismiss'),
  appUpdateInstalled: document.getElementById('appUpdateInstalled'),
  appUpdateLatest: document.getElementById('appUpdateLatest'),
  appUpdateCheckButton: document.getElementById('appUpdateCheckButton'),
  appUpdateViewReleaseButton: document.getElementById('appUpdateViewReleaseButton'),
  appUpdateMessage: document.getElementById('appUpdateMessage'),
  titleIconInput: document.getElementById('titleIconInput'),
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
  vendorColorList: document.getElementById('vendorColorList'),
  resetThemeColorsButton: document.getElementById('resetThemeColorsButton'),
  resetVendorColorsButton: document.getElementById('resetVendorColorsButton'),
  sessionDetail: document.getElementById('session-detail'),
  sessionDetailHead: document.getElementById('session-detail-head')
});

document.addEventListener('click', (e) => {
  const row = e.target.closest('.row.has-accordion');
  if (row) {
    const isExpanded = row.classList.contains('expanded');
    document.querySelectorAll('.row.expanded').forEach(r => r.classList.remove('expanded'));
    if (!isExpanded) {
      row.classList.add('expanded');
    }
  }
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

function setupSettingsSections() {
  for (const toggle of document.querySelectorAll('[data-settings-section]')) {
    const section = toggle.dataset.settingsSection;
    toggle.addEventListener('click', () => setSettingsSectionExpanded(section, !state.settingsSections[section]));
    setSettingsSectionExpanded(section, state.settingsSections[section]);
  }
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
    const codexLinked = (state.settings?.codexManagedAccounts || []).length > 0;
    return t('settings.summary.accounts', {
      linked: (codexLinked ? 1 : 0) + (cursorLinked ? 1 : 0) + (opencodeCount > 0 ? 1 : 0) + (deepseekLinked ? 1 : 0),
      total: 4
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
  if (abs >= 1e9) return `${(num / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (abs >= 1e6) return `${(num / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1e3) return `${(num / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(num);
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
function renderAppUpdatePill() {
  const s = state.appUpdate;
  const pill = els.appUpdatePill;
  if (!pill) return;
  if (!s || !s.hasUpdate || !s.latest) {
    pill.classList.add('hidden');
    pill.setAttribute('title', '');
    els.appUpdatePillLabel.textContent = '';
    return;
  }
  pill.classList.remove('hidden');
  pill.setAttribute('title', s.latest.name || `v${s.latest.version}`);
  els.appUpdatePillLabel.textContent = `↑ v${s.latest.version}`;
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
    return;
  }
  els.appUpdateInstalled.textContent = `v${s.currentVersion}`;
  if (s.latest) {
    els.appUpdateLatest.textContent = !s.hasUpdate && semverLikeEqual(s.latest.version, s.currentVersion)
      ? t('settings.appUpdate.latestWithStatus', { version: s.latest.version, status: t('settings.appUpdate.upToDateShort') })
      : `v${s.latest.version}`;
    els.appUpdateViewReleaseButton.classList.toggle('hidden', !s.hasUpdate);
  } else {
    els.appUpdateLatest.textContent = s.lastCheckedAt ? t('settings.appUpdate.upToDate') : t('settings.common.notChecked');
    els.appUpdateViewReleaseButton.classList.add('hidden');
  }
  els.appUpdateCheckButton.disabled = Boolean(s.checking);
  els.appUpdateCheckButton.textContent = s.checking ? t('settings.appUpdate.checking') : t('settings.appUpdate.check');
  if (s.lastError) {
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

function animateNumber(el, from, to, duration = 2200) {
  cancelNumberAnimation();
  const start = performance.now();
  const delta = to - from;
  function frame(now) {
    const progress = Math.min(1, (now - start) / duration);
    el.textContent = formatNumber(from + delta * easeOutQuart(progress));
    numberAnimHandle = progress < 1 ? requestAnimationFrame(frame) : 0;
  }
  numberAnimHandle = requestAnimationFrame(frame);
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

function updateRow(row, { name, subtitle, detail, value, cost, max, color, stale, platform, local, client, kind, cacheReadTokens, outputTokens }) {
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
  row.querySelector('.row-value').textContent = formatNumber(value);
  row.querySelector('.row-cost').textContent = formatCost(cost || 0);
  const fill = row.querySelector('.bar-fill');
  fill.style.background = color;
  fill.style.width = `${width}%`;

  const accordionInner = row.querySelector('.row-accordion-inner');
  if ((cacheReadTokens !== undefined || outputTokens !== undefined) && value > 0 && kind !== 'session') {
    const cacheRead = cacheReadTokens || 0;
    const output = outputTokens || 0;
    const totalTokens = value || 0;
    const cacheMiss = Math.max(0, totalTokens - cacheRead - output);
    const inputTokens = cacheRead + cacheMiss;
    const hitPct = inputTokens > 0 ? Math.round((cacheRead / inputTokens) * 100) : 0;
    const missPct = inputTokens > 0 ? 100 - hitPct : 0;
    
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
    accordionInner.innerHTML = '';
    row.classList.remove('has-accordion');
    row.classList.remove('expanded');
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

function renderRows(rows) {
  if (rows.length === 0) {
    els.breakdown.replaceChildren();
    state.rowSignature = '';
    return;
  }
  const max = Math.max(1, ...rows.map((row) => row.value));
  const signature = `${state.breakdown}\n${rows.map((row) => row.key).join('\n')}`;
  const existing = new Map(Array.from(els.breakdown.children).map((child) => [child.dataset.key, child]));
  if (signature !== state.rowSignature) {
    els.breakdown.replaceChildren(...rows.map((row) => existing.get(row.key) || rowTemplate(row)));
    state.rowSignature = signature;
  }
  const current = new Map(Array.from(els.breakdown.children).map((child) => [child.dataset.key, child]));
  for (const rowData of rows) {
    const row = current.get(rowData.key);
    if (row) updateRow(row, { ...rowData, max });
  }
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
    fallbackColors: fallbackModelColors
  });
  if (rows.length > 0) return rows.sort((a, b) => b.sortTime - a.sortTime || b.value - a.value || b.cost - a.cost || a.name.localeCompare(b.name));
  if (Number(period?.totalTokens || 0) === 0) return [];
  return modelRowsForPeriod(period);
}

function rowsForPeriod(period) {
  if (state.breakdown === 'device') return deviceRowsForPeriod();
  if (state.breakdown === 'model') return modelRowsForPeriod(period);
  if (state.breakdown === 'session') return sessionRowsForPeriod(period);
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
  const available = state.settings?.historyEnabled === false ? order.filter((id) => id !== 'trends') : order;
  return limitViewAvailable() ? [...available, 'limits'] : available;
}

function visibleBreakdownOrder() {
  return viewDisplayPreferencesApi.visibleViewOrder({
    views: VIEW_DISPLAY_OPTIONS,
    orderValue: effectiveViewDisplayOrderValue(),
    hiddenValue: state.settings?.hiddenViews,
    availableIds: availableBreakdownIds()
  });
}

function ensureBreakdownVisible() {
  const next = viewDisplayPreferencesApi.preferredViewId({
    views: VIEW_DISPLAY_OPTIONS,
    orderValue: effectiveViewDisplayOrderValue(),
    hiddenValue: state.settings?.hiddenViews,
    availableIds: availableBreakdownIds(),
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
  const label = String(provider?.accountLabel || '').trim();
  if (label) return label;
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

const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' };

function formatMoney(value, currency) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const symbol = CURRENCY_SYMBOLS[String(currency || '').toUpperCase()] || '$';
  return `${symbol}${number.toFixed(2)}`;
}

function formatLimitWindowValue(window, fillPercent, hasPercent) {
  if (hasPercent) return `${formatPercent(fillPercent)} left`;
  if (!window) return '--';
  const remaining = Number(window?.remaining);
  if (Number.isFinite(remaining)) {
    return window?.showMeter === false ? formatLimitAmount(remaining) : `${formatLimitAmount(remaining)} left`;
  }
  const limit = Number(window?.limit);
  if (Number.isFinite(limit)) return `${formatLimitAmount(limit)} cap`;
  return '';
}

function balanceRemainingWindow(balance) {
  const amount = Math.max(0, Number(balance?.amount || 0));
  const spend = Math.max(0, Number(balance?.monthSpend || 0));
  const total = amount + spend;
  const remainingPercent = total > 0 ? (amount / total) * 100 : 100;
  return { remainingPercent };
}

function limitWindowNode(label, window, color, tone = 1, valueOverride = null) {
  const remaining = Number(window?.remainingPercent);
  const used = Number(window?.usedPercent);
  const showMeter = window?.showMeter !== false;
  const hasPercent = showMeter && (Number.isFinite(remaining) || Number.isFinite(used));
  const fillPercent = Number.isFinite(remaining)
    ? remaining
    : Number.isFinite(used)
      ? 100 - used
      : 0;
  const safePercent = Math.max(0, Math.min(100, fillPercent));
  const item = document.createElement('div');
  item.className = 'limit-window';
  const text = document.createElement('div');
  text.className = 'limit-window-text';
  const name = document.createElement('span');
  name.textContent = window?.label || label;
  const value = document.createElement('span');
  value.textContent = valueOverride != null ? valueOverride : formatLimitWindowValue(window, fillPercent, hasPercent);
  text.append(name, value);
  const meter = document.createElement('div');
  meter.className = 'limit-meter';
  meter.style.background = colorWithAlpha(color, 0.16);
  const fill = document.createElement('div');
  fill.className = 'limit-meter-fill';
  fill.style.width = `${safePercent}%`;
  fill.style.background = color;
  fill.style.opacity = tone;
  meter.append(fill);
  const reset = document.createElement('div');
  reset.className = 'limit-reset';
  reset.textContent = formatReset(window?.resetsAt) || window?.resetDescription || '';
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
  name.append(title);
  const provenance = limitProviderProvenance(provider);
  // Active-account marker — the local Codex login this device's app is signed
  // into (only shown among several accounts). It hugs the email because "Active"
  // describes the identity, not the "Updated" time; the email ellipsizes first
  // so the badge never gets squeezed. Stays English like the panel's other
  // labels (Session/Weekly/Updated). Off by default — gated on showActiveAccount.
  if (state.settings?.showActiveAccount && options.accountTitle && limitProviderPresentationApi.isCodexLiveAccount(provider, provenance)) {
    const badge = document.createElement('span');
    badge.className = 'limit-live-badge';
    badge.textContent = 'Active';
    badge.title = 'Signed in to Codex on this device';
    badge.setAttribute('aria-label', 'Signed in to Codex on this device');
    name.append(badge);
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
  if (provider.provider === 'cursor') {
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
  } else {
    windows.append(limitWindowNode('Session', windowForKind(provider, 'session'), color, 0.95));
    windows.append(limitWindowNode('Weekly', windowForKind(provider, 'weekly'), color, 0.68));
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
  if (email) return email;
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
    const color = clientColors[id] || clientColors.default;
    if (id === 'codex' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderCodexAccountGroup(label, visibleProviders, color));
      continue;
    }
    if (id === 'opencode' && Array.isArray(visibleProviders) && visibleProviders.length > 1) {
      nodes.push(renderOpenCodeAccountGroup(label, visibleProviders, color));
      continue;
    }
    const provider = Array.isArray(visibleProviders) ? visibleProviders[0] : visibleProviders;
    nodes.push(renderLimitProviderRow(id, label, provider, color));
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
  wrap.querySelector('.bar-fill').style.width = `${rowWidth(row.value, max)}%`;

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
    [t('trends.longestStreak'), formatNumber(summary.longestStreak)],
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

async function loadHomeHistory() {
  if (state.homeHistoryRequested || state.homeHistoryBusy || !window.tokenMonitor.getDashboardHistory) return;
  state.homeHistoryRequested = true;
  state.homeHistoryBusy = true;
  try {
    state.homeHistory = await window.tokenMonitor.getDashboardHistory();
  } catch (error) {
    console.log(`[home] history failed: ${error.message}`);
  } finally {
    state.homeHistoryBusy = false;
    if (state.breakdown === 'home') render();
  }
}

function homeModuleIds() {
  const hidden = hiddenViewSet();
  const available = new Set(availableBreakdownIds());
  return viewDisplayPreferencesApi
    .orderedViews(VIEW_DISPLAY_OPTIONS, effectiveViewDisplayOrderValue())
    .map((view) => view.id)
    .filter((id) => HOME_MODULE_VIEW_IDS.has(id) && !hidden.has(id) && available.has(id));
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

function setViewSwitcherOpen(open, { focusMenu = false, focusDisclosure = false } = {}) {
  const nextOpen = Boolean(open);
  if (state.viewSwitcherOpen === nextOpen && !focusMenu && !focusDisclosure) return;
  state.viewSwitcherOpen = nextOpen;
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
    if (setBreakdown(nextBreakdown(state.breakdown))) render();
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
  for (const id of order) {
    const item = document.createElement('button');
    const active = id === currentId;
    item.type = 'button';
    item.className = `view-switcher-menu-item${active ? ' is-current' : ''}`;
    item.dataset.view = id;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(active));
    if (active) item.setAttribute('aria-current', 'page');
    item.tabIndex = active ? 0 : -1;
    item.append(viewSwitcherIcon(id));
    const itemLabel = document.createElement('span');
    itemLabel.className = 'view-switcher-menu-label';
    itemLabel.textContent = viewLabelById(id);
    item.append(itemLabel);
    item.addEventListener('click', () => {
      state.viewSwitcherOpen = false;
      if (setBreakdown(id)) render();
      else renderViewSwitcher({ focusDisclosure: true });
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
    if (setBreakdown(viewId)) render();
  });
  module.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (setBreakdown(viewId)) render();
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
  const providers = providersByLimitProviderId(state.stats?.limits?.providers || []);
  const accounts = [];
  for (const { id, label } of limitProviderOrderApi.orderedLimitProviders(LIMIT_PROVIDERS, state.settings?.limitProviderOrder)) {
    if (!enabled.has(id)) continue;
    const color = clientColors[id] || clientColors.default;
    const providerEntries = providers.get(id) || [];
    providerEntries.forEach((provider, index) => {
      accounts.push({
        key: `${id}:${index}`,
        providerId: id,
        name: id === 'codex' && providerEntries.length > 1 ? codexAccountTitle(provider, index) : label,
        color,
        windows: provider.windows || []
      });
    });
  }
  return homeOverviewApi.homeLimitAccounts(accounts, 3);
}

function homeLimitWindowLabel(window) {
  const key = {
    session: 'home.limit.session',
    weekly: 'home.limit.weekly',
    billing: 'home.limit.billing',
    monthly: 'home.limit.monthly'
  }[window.kind];
  return key ? t(key) : window.label;
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
      value.textContent = `${formatPercent(window.remainingPercent)} left`;
      line.append(label, value);
      const resetAt = formatReset(window.resetsAt);
      const resetText = document.createElement('span');
      resetText.className = 'home-limit-reset';
      resetText.textContent = resetAt || (window.resetDescription
        ? t('home.reset', { value: window.resetDescription })
        : '\u00a0');
      metric.append(line, resetText);
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

function setupHomeActivityScroller(scroller) {
  let drag = null;
  const updatePosition = () => {
    state.homeActivityScrollLeft = scroller.scrollLeft;
    scroller.classList.toggle('is-scrolled', scroller.scrollLeft > 2);
  };
  scroller.addEventListener('scroll', updatePosition);
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
}

function restoreHomeActivityScroll() {
  const scroller = els.homePanel?.querySelector('.home-activity-scroll');
  if (!scroller) return;
  const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const target = state.homeActivityScrollLeft == null ? max : Math.min(max, state.homeActivityScrollLeft);
  scroller.scrollLeft = target;
  scroller.classList.toggle('is-scrolled', target > 2);
}

function renderHomeTrendsModule() {
  const charts = window.TokenMonitorUsageCharts;
  const preview = state.stats?.historyPreview || { daily: [] };
  const history = state.homeHistory || preview;
  const points = history.daily || [];
  if (points.length === 0) {
    const { module, body } = homeModuleShell('trends', t('home.activity'), 'trends');
    const empty = document.createElement('div');
    empty.className = 'home-module-empty';
    empty.textContent = t('home.noHistory');
    body.append(empty);
    return module;
  }
  const activity = charts.rollingYearHeatmap(dailyWithHeatIntensity(points), {
    endDate: new Date().toISOString().slice(0, 10),
    cell: 8,
    gap: 3
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
    monthLabel: (month) => compactMonthLabel(month.label)
  });
  activityScroll.append(activityCanvas);
  setupHomeActivityScroller(activityScroll);
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
  return module;
}

function renderHome() {
  if (!els.homePanel) return;
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
    if (id === 'model') return renderHomeModelModule(period);
    return renderHomeTrendsModule();
  });
  els.homePanel.replaceChildren(...nodes);
  requestAnimationFrame(restoreHomeActivityScroll);
}

function render() {
  if (!state.stats) return;
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
    state.suppressInitialNumberAnimation = false;
  } else if (totalChanged) {
    animateNumber(els.totalTokens, state.currentTotal, nextTotal);
    pulseLiveDot();
  } else {
    cancelNumberAnimation();
    els.totalTokens.textContent = formatNumber(nextTotal);
  }
  state.currentTotal = nextTotal;
  els.cost.textContent = formatCost(period.costUsd || 0);
  if (!state.refreshBusy && !state.refreshFeedbackTimer) setRefreshButtonState('idle');
  els.shell.classList.toggle('session-mode', state.breakdown === 'session');
  els.shell.classList.toggle('home-mode', state.breakdown === 'home');
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
    renderRows(rows);
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

async function refreshStats(options = {}) {
  const feedback = options.feedback === true;
  if (feedback) {
    if (state.refreshBusy) return;
    state.refreshBusy = true;
    clearRefreshButtonFeedbackTimer();
    setRefreshButtonState('refreshing');
  }
  try {
    state.stats = await window.tokenMonitor.getStats(options);
    setStatus(statusTextFor(state.mode, state.streamConnected));
    render();
    renderLimitProviderCheckboxes();
    renderToolPreferences();
    renderDeepseekStatus();
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

function setBreakdown(breakdown) {
  const next = normalizeInitialViewValue(breakdown, viewBreakdownValues, state.breakdown);
  if (next === state.breakdown) {
    publishViewState();
    return false;
  }
  state.breakdown = next;
  state.rowSignature = '';
  publishViewState();
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
  const recordButton = els.windowToggleShortcutRecordButton;
  const clearButton = els.windowToggleShortcutClearButton;
  if (!note || !value) return;
  const shortcut = normalizeWindowToggleShortcutValue(state.settings?.windowToggleShortcut);
  const display = windowShortcutApi.formatWindowToggleShortcut(shortcut, t('settings.shortcut.off'));
  const status = state.settings?.windowToggleShortcutStatus?.state || (shortcut ? 'unregistered' : 'off');
  value.classList.toggle('recording', state.recordingWindowShortcut);
  value.textContent = state.recordingWindowShortcut ? t('settings.shortcut.recording') : display;
  if (recordButton) {
    recordButton.textContent = state.recordingWindowShortcut ? t('settings.shortcut.recording') : t('settings.shortcut.record');
    recordButton.disabled = state.recordingWindowShortcut;
  }
  if (clearButton) clearButton.disabled = !shortcut && !state.recordingWindowShortcut;
  note.classList.toggle('error', state.windowShortcutInvalid || (Boolean(shortcut) && status !== 'registered'));
  if (state.recordingWindowShortcut) {
    note.textContent = state.windowShortcutInvalid ? t('settings.display.windowShortcutInvalid') : t('settings.display.windowShortcutListening');
  } else if (!shortcut) {
    note.textContent = t('settings.display.windowShortcutNote');
  } else if (status === 'registered') {
    note.textContent = t('settings.display.windowShortcutRegistered', {
      shortcut: display
    });
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

const BUBBLE_CONTENT_VALUES = ['icon', 'tokens', 'cost', 'both', 'tokensAll', 'costAll', 'bothAll', 'bars', 'barsSession', 'barsWeekly', 'barsAllSessions'];
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

function isBarsMode(mode) {
  return mode === 'bars' || mode === 'barsSession' || mode === 'barsWeekly' || mode === 'barsAllSessions';
}

function renderFloatingBubbleContent() {
  const el = els.floatingBubbleContent;
  if (!el || !state.floatingBubble.collapsed) return;
  const mode = state.settings?.floatingBubbleContent || 'icon';
  if (isBarsMode(mode)) {
    const dataUrl = state.stats
      ? barsDataUrlForMode(mode, 44, BUBBLE_BARS_COLORS, { contentOnly: mode === 'barsAllSessions' })
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
    el.textContent = (state.stats && window.TokenMonitorTrayText.formatTrayText(state.stats, mode, currentCurrency())) || 'Σ';
  } else if (mode === 'icon') {
    el.classList.remove('bars');
    el.textContent = 'Σ';
  } else {
    el.classList.remove('bars');
    el.textContent = state.stats ? (window.TokenMonitorTrayText.formatTrayText(state.stats, mode, currentCurrency()) || '0') : '0';
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
    const pad = isBarsMode(mode) ? 8 : BUBBLE_CONTENT_PAD_X * 2;
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
    showLiveDot: Boolean(els.liveDotInput.checked),
    showToolIcons: Boolean(els.toolIconsInput.checked),
    titleIconOnly: Boolean(els.titleIconInput.checked),
    settingsInTitlebar: Boolean(els.settingsInTitlebarInput.checked),
    glassOpacity: Number(els.glassInput.value === '' ? defaultAppearance.glassOpacity : els.glassInput.value),
    glassBlur: Number(els.blurInput.value === '' ? defaultAppearance.glassBlur : els.blurInput.value),
    zoomFactor: Number(els.zoomInput.value === '' ? defaultAppearance.zoomFactor * 100 : els.zoomInput.value) / 100
  };
}

function applyAppearanceFromControls() {
  const patch = appearancePatchFromControls();
  applyAppearanceSettings(patch);
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
    await navigator.clipboard.writeText(text);
    if (button) {
      const previous = button.textContent;
      button.textContent = '✓';
      setTimeout(() => { button.textContent = previous; }, 900);
    }
  } catch (_) { /* clipboard blocked; no-op */ }
}

async function refreshHubInfo() {
  if (!window.tokenMonitor.getHubInfo) return;
  try {
    state.hubInfo = await window.tokenMonitor.getHubInfo();
    renderHubStatus();
  } catch (_) { /* ignore */ }
}

function syncPeriodTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.period === state.period);
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

function syncSettingsForm() {
  applySettingsTranslations();
  applyInitialBreakdownPreference();
  syncPeriodTabs();
  syncHubModeUi();
  if (els.languageInput) els.languageInput.value = currentLanguage();
  if (els.currencyInput) els.currencyInput.value = currentCurrency();
  els.hubUrlInput.value = state.settings.hubUrl || '';
  els.secretInput.value = state.settings.secret || '';
  els.deviceIdInput.value = state.settings.deviceId || '';
  els.limitsRefreshInput.value = String(LIMIT_REFRESH_OPTIONS.includes(Number(state.settings.limitsRefreshMs)) ? state.settings.limitsRefreshMs : 300000);
  els.showLimitSourceInput.checked = Boolean(state.settings.showLimitSource);
  els.showActiveAccountInput.checked = Boolean(state.settings.showActiveAccount);
  els.systemGlassInput.checked = state.settings.systemGlass !== false;
  els.liveDotInput.checked = state.settings.showLiveDot !== false;
  els.toolIconsInput.checked = state.settings.showToolIcons !== false;
  els.titleIconInput.checked = state.settings.titleIconOnly === true;
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
  els.trayContentInput.value = ['tokens', 'cost', 'both', 'tokensAll', 'costAll', 'bothAll', 'bars', 'barsSession', 'barsWeekly', 'barsAllSessions', 'icon'].includes(state.settings.trayContent) ? state.settings.trayContent : 'tokens';
  els.trayContentInput.disabled = !showTrayIcon;
  els.trayIconOptions?.classList.toggle('hidden', !showTrayIcon);
  els.trayOptions?.classList.toggle('hidden', !showTrayIcon || !state.settings.trayMode);
  syncWindowShortcutStatus();
  if (els.startAtLoginInput) {
    els.startAtLoginInput.disabled = !state.appInfo?.loginItemSupported;
    els.startAtLoginInput.checked = Boolean(state.settings.startAtLogin && state.appInfo?.loginItemSupported);
  }
  if (els.startupNote) {
    els.startupNote.textContent = state.appInfo?.loginItemSupported
      ? t('settings.startup.launchAtSignIn')
      : t('settings.startup.available');
  }
  els.glassInput.value = String(state.settings.glassOpacity ?? 68);
  els.blurInput.value = String(state.settings.glassBlur ?? 32);
  els.zoomInput.value = String(Math.round((Number(state.settings.zoomFactor) || 1) * 100));
  renderDeepseekStatus();
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
  return els.limitProviderCheckboxes;
}

function preferenceItemAttribute(kind) {
  if (kind === 'client') return 'client';
  if (kind === 'view') return 'view';
  if (kind === 'statusProvider') return 'statusProvider';
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
  event.currentTarget.closest('[data-client], [data-provider], [data-view], [data-status-provider]')?.classList.add('is-dragging');
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
  handle.title = t(kind === 'client'
    ? 'settings.tools.reorderClient'
    : kind === 'view'
      ? 'settings.views.reorderView'
      : kind === 'statusProvider'
        ? 'serviceStatus.reorderProvider'
        : 'settings.limits.reorderProvider', { name: label });
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
    const isDisabled = id === 'trends' && !historyEnabled;
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
    visibility.addEventListener('click', () => id === 'trends' ? onTrendVisibilityToggle() : onViewVisibilityToggle(id));
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

function renderHomeSettingsList() {
  const wrap = document.createElement('div');
  wrap.id = 'homeSettingsList';
  wrap.className = 'home-settings-list';
  const note = document.createElement('p');
  note.className = 'settings-note home-settings-note';
  note.textContent = t('settings.views.homeSettingsNote');
  wrap.append(note);
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
  input.addEventListener('change', async () => {
    await setTrendEnabled(input.checked);
    await refreshStats({ force: true });
  });
  const text = document.createElement('span');
  text.textContent = t('settings.views.enableTrend');
  label.append(input, text);
  wrap.append(label);
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

function localClientStatus() {
  const devices = state.stats?.devices || [];
  const localId = state.settings?.deviceId || '';
  const local = (localId && devices.find((device) => device.deviceId === localId))
    || (devices.length === 1 ? devices[0] : null);
  return local?.clientStatus || {};
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

async function resetServiceProviderOrder() {
  await saveSettings({ serviceProviderDisplayOrder: '' });
}

async function showAllServiceProviders() {
  await saveSettings({ hiddenServiceProviders: '' });
}

async function onPreferenceReorder(kind, id, targetIndex) {
  if (kind === 'client') await onClientDisplayReorder(id, targetIndex);
  else if (kind === 'view') await onViewDisplayReorder(id, targetIndex);
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
  preserveSettingsPanelScroll(syncSettingsForm);
  restartTimer();
  maybeUpdateBarsIcon();
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
  state.settings = await window.tokenMonitor.getSettings();
  state.appUpdate = await window.tokenMonitor.getAppUpdateState();
  renderAppUpdatePill();
  renderSettingsAppUpdateRow();
  window.tokenMonitor.onAppUpdatePush?.((payload) => {
    state.appUpdate = payload;
    renderAppUpdatePill();
    renderSettingsAppUpdateRow();
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
    setPeriod(tab.dataset.period);
    syncPeriodTabs();
    if (state.openSession) openSessionDetail(state.openSession);
    state.currentTotal = 0;
    state.rowSignature = '';
    render();
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
els.limitsRefreshInput.addEventListener('change', async () => {
  await saveSettings({ limitsRefreshMs: Number(els.limitsRefreshInput.value) });
  await refreshStats({ force: true });
});
els.showLimitSourceInput.addEventListener('change', async () => {
  await saveSettings({ showLimitSource: els.showLimitSourceInput.checked });
});
els.showActiveAccountInput.addEventListener('change', async () => {
  await saveSettings({ showActiveAccount: els.showActiveAccountInput.checked });
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
els.systemGlassInput.addEventListener('change', saveAppearanceFromControls);
els.liveDotInput.addEventListener('change', saveAppearanceFromControls);
els.toolIconsInput.addEventListener('change', saveAppearanceFromControls);
els.titleIconInput.addEventListener('change', saveAppearanceFromControls);
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
  els.trayIconOptions?.classList.toggle('hidden', !showTrayIcon);
  els.trayOptions?.classList.toggle('hidden', !showTrayIcon || !els.trayModeInput.checked);
  saveSettings({ showTrayIcon, trayMode: showTrayIcon ? els.trayModeInput.checked : false });
});
els.trayModeInput.addEventListener('change', () => {
  els.trayOptions?.classList.toggle('hidden', !els.showTrayIconInput?.checked || !els.trayModeInput.checked);
  saveSettings({ trayMode: els.trayModeInput.checked });
});
els.trayContentInput.addEventListener('change', () => saveSettings({ trayContent: els.trayContentInput.value }));
els.windowToggleShortcutRecordButton?.addEventListener('click', startWindowShortcutRecording);
els.windowToggleShortcutClearButton?.addEventListener('click', () => setWindowToggleShortcut('').catch(() => {}));
els.startAtLoginInput?.addEventListener('change', () => saveSettings({ startAtLogin: els.startAtLoginInput.checked }));
els.glassInput.addEventListener('change', saveAppearanceFromControls);
els.blurInput.addEventListener('change', saveAppearanceFromControls);
els.zoomInput.addEventListener('change', saveAppearanceFromControls);
els.resetZoomButton.addEventListener('click', async () => {
  els.zoomInput.value = String(Math.round(defaultAppearance.zoomFactor * 100));
  await saveSettings({ zoomFactor: defaultAppearance.zoomFactor });
});
els.openConfigButton.addEventListener('click', () => window.tokenMonitor.openUserData());
els.checkTokscaleButton?.addEventListener('click', checkTokscaleNpm);
els.downloadTokscaleButton?.addEventListener('click', downloadTokscaleFromNpm);
els.resetTokscaleButton?.addEventListener('click', resetTokscaleToBundled);
els.openTokscaleLinkButton?.addEventListener('click', () => window.tokenMonitor.openExternal?.('https://github.com/junhoyeo/tokscale'));
els.refreshButton.addEventListener('click', () => {
  if (state.breakdown === 'status') refreshStatusViewManually().catch(() => {});
  else refreshStats({ force: true, feedback: true });
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

els.appUpdatePillAction.addEventListener('click', async () => {
  const latest = state.appUpdate?.latest;
  if (!latest?.htmlUrl) return;
  await window.tokenMonitor.openExternal(latest.htmlUrl);
});

els.appUpdatePillDismiss.addEventListener('click', async () => {
  const version = state.appUpdate?.latest?.version;
  if (!version) return;
  state.appUpdate = await window.tokenMonitor.dismissAppUpdate(version);
  renderAppUpdatePill();
});

els.appUpdateCheckButton.addEventListener('click', async () => {
  state.appUpdate = await window.tokenMonitor.checkAppUpdateNow();
  renderAppUpdatePill();
  renderSettingsAppUpdateRow();
});

els.appUpdateViewReleaseButton.addEventListener('click', async () => {
  const url = state.appUpdate?.latest?.htmlUrl;
  if (!url) return;
  await window.tokenMonitor.openExternal(url);
});

window.tokenMonitor.onSettingsPush?.((next) => {
  if (!next) return;
  state.settings = next;
  syncSettingsForm();
  renderDeepseekStatus();
  maybeUpdateBarsIcon();
});

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
    state.streamConnected = true;
    state.streamFailure = null;
    if (payload.data?.mode) state.mode = payload.data.mode;
    state.stats = payload.data.stats;
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
    renderDeepseekStatus();
    maybeUpdateBarsIcon();
  }
  restartTimer();
});

function pickWorstProvider(stats, windowFilter) {
  const providers = stats?.limits?.providers || [];
  let worstProvider = null;
  let worstRemaining = Infinity;
  for (const provider of providers) {
    if (provider.status !== 'ok' || provider.stale) continue;
    for (const window of provider.windows || []) {
      if (windowFilter && !windowFilter(window)) continue;
      const remaining = Number(window.remainingPercent);
      if (!Number.isFinite(remaining)) continue;
      if (remaining < worstRemaining) {
        worstRemaining = remaining;
        worstProvider = provider;
      }
    }
  }
  return worstProvider;
}

function pickWorstSessionProvider(stats) {
  return pickWorstProvider(stats, (window) => window.kind === 'session');
}

function pickWorstWeeklyProvider(stats) {
  return pickWorstProvider(stats, (window) => window.kind === 'weekly');
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

function renderBarsIcon(stats, height = 44, picker = pickWorstProvider, colors = {}) {
  const trackColor = colors.track || 'rgba(0, 0, 0, 0.32)';
  const fillColor = colors.fill || 'rgba(0, 0, 0, 1)';
  const provider = picker(stats);
  if (!provider) return null;
  const session = (provider.windows || []).find((w) => w.kind === 'session');
  const weekly = (provider.windows || []).find((w) => w.kind === 'weekly');
  const providerImage = trayProviderImages[provider.provider];
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
    const fillW = trayBarFillWidth(percent, layout.barsWidth);
    if (!fillW) return;
    // Clip-to-track + flat fillRect: a rounded rect's tiny corners get lost when the icon is downscaled into the menubar.
    ctx.save();
    roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
    ctx.clip();
    ctx.fillStyle = fillColor;
    ctx.fillRect(layout.barsX, y, fillW, layout.barHeight);
    ctx.restore();
  }

  drawBar(layout.barsStartY, Number(session?.remainingPercent));
  drawBar(layout.barsStartY + layout.barHeight + layout.barGap, Number(weekly?.remainingPercent));
  return canvas.toDataURL('image/png');
}

function pickConfiguredSessionProviders(stats, configOrder) {
  const providers = stats?.limits?.providers || [];
  const byId = providersByLimitProviderId(providers);
  const result = [];
  for (const id of configOrder) {
    let pick = null;
    for (const p of byId.get(id) || []) {
      if (!p || p.status !== 'ok' || p.stale) continue;
      const session = (p.windows || []).find((w) => w.kind === 'session');
      const remaining = Number(session?.remainingPercent);
      if (!session || !Number.isFinite(remaining)) continue;
      if (!pick || remaining < Number(pick.session.remainingPercent)) pick = { provider: p, session };
    }
    if (!pick) continue;
    result.push(pick);
    if (result.length === 2) break;
  }
  return result;
}

function renderAllSessionsIcon(stats, height = 44, configOrder, colors = {}, options = {}) {
  const trackColor = colors.track || 'rgba(0, 0, 0, 0.32)';
  const fillColor = colors.fill || 'rgba(0, 0, 0, 1)';
  const picks = pickConfiguredSessionProviders(stats, configOrder);
  if (picks.length === 0) return null;
  // Only one tool has session data → fall back to that tool's session+weekly view.
  if (picks.length === 1) return renderBarsIcon(stats, height, () => picks[0].provider, colors);

  const { trayBarFillWidth, trayBarsLayout } = window.TokenMonitorTrayBars;
  const layout = trayBarsLayout(height, { contentOnly: options.contentOnly === true });
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, layout.width, layout.height);

  // No per-row icons — order in the dropdown identifies which row is which tool.
  // Default layout keeps menubar width stable; the bubble can request content-only
  // output so the mini-window hugs just the visible bars.
  function drawBar(y, percent) {
    roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
    ctx.fillStyle = trackColor;
    ctx.fill();
    const fillW = trayBarFillWidth(percent, layout.barsWidth);
    if (!fillW) return;
    ctx.save();
    roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
    ctx.clip();
    ctx.fillStyle = fillColor;
    ctx.fillRect(layout.barsX, y, fillW, layout.barHeight);
    ctx.restore();
  }

  drawBar(layout.barsStartY, Number(picks[0].session.remainingPercent));
  drawBar(layout.barsStartY + layout.barHeight + layout.barGap, Number(picks[1].session.remainingPercent));
  return canvas.toDataURL('image/png');
}

function barsDataUrlForMode(mode, size = 44, colors, options = {}) {
  if (mode === 'barsAllSessions') return renderAllSessionsIcon(state.stats, size, configuredLimitProviderOrder(), colors, options);
  const pickers = { barsSession: pickWorstSessionProvider, barsWeekly: pickWorstWeeklyProvider };
  return renderBarsIcon(state.stats, size, pickers[mode] || pickWorstProvider, colors);
}

async function maybeUpdateBarsIcon() {
  const mode = state.settings?.trayContent;
  if (mode !== 'bars' && mode !== 'barsSession' && mode !== 'barsWeekly' && mode !== 'barsAllSessions') return;
  if (!window.tokenMonitor.setTrayIcons) return;
  const dataUrl = barsDataUrlForMode(mode, 44);
  if (!dataUrl) return;
  try { await window.tokenMonitor.setTrayIcons({ [mode]: dataUrl }); } catch (_) {}
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`load failed: ${src}`));
    img.src = src;
  });
}

function imageToPngDataUrl(img, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

async function deliverTrayProviderIcons() {
  if (!window.tokenMonitor.setTrayIcons) return;
  const sources = window.TokenMonitorTrayProviderIcons.trayProviderIconSources(clientsWithIcon);
  const icons = {};
  for (const [id, path] of Object.entries(sources)) {
    try {
      const img = await loadImage(path);
      trayProviderImages[id] = img;
      icons[id] = imageToPngDataUrl(img, 44);
    } catch (_) { /* skip missing */ }
  }
  if (Object.keys(icons).length) await window.tokenMonitor.setTrayIcons(icons);
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

function setCursorStatusText(el, text) {
  el.textContent = text;
  el.title = text;
}

function setCodexAccountButtonsDisabled(disabled) {
  for (const id of ['codexAddAccountButton', 'codexRefreshAccountsButton']) {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  }
}

function renderCodexAccounts() {
  const statusEl = document.getElementById('codexAccountStatus');
  const listEl = document.getElementById('codexAccountList');
  const errorEl = document.getElementById('codexAccountErrorMessage');
  if (!statusEl || !listEl || !errorEl) return;

  const accounts = state.settings?.codexManagedAccounts || [];
  const statusText = accounts.length === 0
    ? t('settings.codex.notConfigured')
    : accounts.length === 1
      ? t('settings.codex.accountOne')
      : t('settings.codex.accountMany', { count: accounts.length });
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
      const row = document.createElement('div');
      row.className = 'managed-account-row';
      const main = document.createElement('div');
      main.className = 'managed-account-main';
      const email = document.createElement('div');
      email.className = 'managed-account-email';
      email.textContent = account.email || t('settings.codex.unnamedAccount');
      const meta = document.createElement('div');
      meta.className = 'managed-account-meta';
      meta.textContent = [account.accountLabel, account.updatedAt ? formatTime(account.updatedAt) : '']
        .filter(Boolean)
        .join(' · ');
      main.append(email, meta);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'managed-account-remove';
      remove.textContent = t('settings.codex.remove');
      remove.addEventListener('click', async () => {
        const result = await window.tokenMonitor.codex.removeAccount(account.id);
        if (!result?.ok) {
          state.codexAccountError = result?.error || t('settings.codex.removeFailed');
        } else {
          state.codexAccountError = '';
          state.settings.codexManagedAccounts = result.accounts || [];
          await refreshStats({ force: true });
        }
        renderCodexAccounts();
        renderSettingsSummaries();
      });
      row.append(main, remove);
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

function deepseekAccountLinked() {
  const provider = deepseekProviderForAccount();
  return Boolean(state.settings?.deepseekApiKeyConfigured) && provider?.status === 'ok';
}

function deepseekProviderStatus() {
  return (state.stats?.limits?.providers || []).find((provider) => provider.provider === 'deepseek') || null;
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
  const linked = deepseekAccountLinked();
  if (linked) {
    setCursorStatusText(statusEl, source === 'env' ? t('settings.deepseek.statusEnv') : t('settings.deepseek.statusSet'));
  } else if (provider?.status === 'unauthorized') {
    setCursorStatusText(statusEl, t('settings.deepseek.statusInvalid'));
  } else if (state.settings?.deepseekApiKeyConfigured) {
    setCursorStatusText(statusEl, t('settings.common.checking'));
  } else {
    setCursorStatusText(statusEl, t('settings.deepseek.statusNotSet'));
  }
  manualPanel.classList.toggle('hidden', linked);
  openBtn.classList.toggle('hidden', linked);
  logoutBtn.classList.toggle('hidden', !linked || source !== 'settings');
  refreshBtn.classList.toggle('hidden', !linked);
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
          // Enabling adds the profile to the status query; refresh so the row
          // resolves from the loading placeholder instead of sticking on '...'.
          if (toggle.checked) updateOpenCodeProfilesStatus();
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
    const totalCount = Object.keys(profiles).length;
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

    let codexLoginBusy = false;
    let codexLoginUnsubscribe = null;
    const codexLoginOutput = document.getElementById('codexLoginOutput');
    const codexAddButton = document.getElementById('codexAddAccountButton');
    const showLoginStatus = (statusKey, streamed = '') => {
      if (!codexLoginOutput) return;
      codexLoginOutput.textContent = streamed ? `${t(statusKey)}\n\n${streamed}` : t(statusKey);
      codexLoginOutput.classList.remove('hidden');
      codexLoginOutput.scrollTop = codexLoginOutput.scrollHeight;
    };
    codexAddButton.addEventListener('click', async () => {
      if (codexLoginBusy) return;
      codexLoginBusy = true;
      state.codexAccountError = '';
      let streamed = '';
      showLoginStatus('settings.codex.loginStarting');
      setCodexAccountButtonsDisabled(true);
      codexAddButton.textContent = t('settings.codex.signingIn');
      renderCodexAccounts();
      codexLoginUnsubscribe?.();
      codexLoginUnsubscribe = window.tokenMonitor.codex.onLoginOutput((text) => {
        streamed = (streamed + text).slice(-3000);
        showLoginStatus('settings.codex.loginStarting', streamed);
      });
      try {
        const result = await window.tokenMonitor.codex.addAccount();
        if (!result?.ok) {
          state.codexAccountError = result?.error || t('settings.codex.loginFailed');
          showLoginStatus('settings.codex.loginFailed', streamed);
          setCodexAccountExpanded(true);
        } else {
          state.codexAccountError = '';
          showLoginStatus('settings.codex.loginSuccess');
          state.settings.codexManagedAccounts = await window.tokenMonitor.codex.accounts();
          if (codexLoginOutput) codexLoginOutput.classList.add('hidden');
          await refreshStats({ force: true });
        }
      } catch (err) {
        state.codexAccountError = err.message;
      } finally {
        codexLoginUnsubscribe?.();
        codexLoginUnsubscribe = null;
        codexLoginBusy = false;
        setCodexAccountButtonsDisabled(false);
        codexAddButton.textContent = t('settings.codex.addAccount');
        renderCodexAccounts();
      }
    });

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
}

function initSettingsAnimationWrappers() {
  const selectors = [
    '.settings-section-details',
    '.cursor-settings-details',
    '.hub-mode-fields',
    '.presence-feature-body',
    '#cursorManualPanel',
    '#opencodeManualPanel',
    '#deepseekManualPanel'
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
deliverTrayProviderIcons();
init();
