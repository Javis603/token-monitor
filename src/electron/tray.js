'use strict';

const path = require('node:path');
const { formatTrayText, pickWorstLimit } = require('../shared/trayText');
const { maskEmailAddress } = require('./renderer/accountIdentity');
const { translate: translateMessage } = require('./renderer/i18n');

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

function buildTrayIcon() {
  const { nativeImage } = require('electron');
  // macOS menu bar items render at 16–22pt; 18px is a good middle ground.
  // Resize handles HiDPI itself; 20px matches typical menubar item size.
  return nativeImage.createFromPath(ICON_PATH).resize({ width: 20, height: 20 });
}

function trayUsagePeriod(contentMode) {
  if (contentMode === 'tokensAll' || contentMode === 'costAll' || contentMode === 'bothAll') return 'allTime';
  if (contentMode === 'tokens' || contentMode === 'cost' || contentMode === 'both') return 'today';
  return null;
}

function topClientFromMetric(values) {
  let top = null;
  let topValue = 0;
  for (const [client, rawValue] of Object.entries(values || {})) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (!top || value > topValue) {
      top = client;
      topValue = value;
    }
  }
  return top;
}

function pickUsageTrayIconId(stats, contentMode = 'tokens', availableIconIds = []) {
  const periodKey = trayUsagePeriod(contentMode);
  if (!periodKey) return null;
  const period = stats?.periods?.[periodKey] || {};
  const costMode = contentMode === 'cost' || contentMode === 'costAll';
  const costClient = costMode ? topClientFromMetric(period.clientCosts) : null;
  const client = costClient || topClientFromMetric(period.clients);
  if (!client) return null;
  const available = new Set(availableIconIds);
  return available.has(client) ? client : null;
}

function sortCodexAccountsForDisplay(accounts) {
  const label = (account) => String(
    account?.email
    || account?.accountName
    || account?.accountLabel
    || account?.accountKey
    || account?.id
    || ''
  );
  return [...(accounts || [])].sort((left, right) => label(left).localeCompare(label(right)));
}

function reconcileCodexAccountSelection({ detectedAccountId, detectedAt, pendingAccountId, pendingSince } = {}) {
  const detected = String(detectedAccountId || '').trim();
  const pending = String(pendingAccountId || '').trim();
  if (!pending) return { activeAccountId: detected, pendingAccountId: '' };
  const detectedTime = typeof detectedAt === 'number' ? detectedAt : Date.parse(detectedAt || '');
  if (!detected || !Number.isFinite(detectedTime) || detectedTime < Number(pendingSince || 0)) {
    return { activeAccountId: pending, pendingAccountId: pending };
  }
  return { activeAccountId: detected, pendingAccountId: '' };
}

const TRAY_CONTENT_MENU_ITEMS = [
  ['tokens', 'trayMenu.content.todayTokens'],
  ['cost', 'trayMenu.content.todayCost'],
  ['both', 'trayMenu.content.todayBoth'],
  ['tokensAll', 'trayMenu.content.totalTokens'],
  ['costAll', 'trayMenu.content.totalCost'],
  ['bothAll', 'trayMenu.content.totalBoth'],
  ['limitsAllSessions', 'trayMenu.content.aiToolLimits'],
  ['barsSession', 'trayMenu.content.sessionLimitBar'],
  ['barsWeekly', 'trayMenu.content.weeklyLimitBar'],
  ['barsAllSessions', 'trayMenu.content.allToolsLimitBars'],
  ['bars', 'trayMenu.content.lowestRemainingLimitBar'],
  ['icon', 'trayMenu.content.appIconOnly']
];

const WINDOW_PRESENTATION_MENU_ITEMS = [
  ['tray', 'trayMenu.presentation.tray'],
  ['floating', 'trayMenu.presentation.floating'],
  ['normal', 'trayMenu.presentation.normal'],
  ['desktop', 'trayMenu.presentation.desktop']
];

const OPEN_VIEW_MENU_ITEMS = [
  ['home', 'views.home'],
  ['project', 'views.project'],
  ['session', 'views.session'],
  ['limits', 'views.limits'],
  ['trends', 'views.trends'],
  ['status', 'views.status']
];

function buildTrayMenuTemplate(options = {}) {
  const state = options.state || {};
  const presentation = state.trayMode ? 'tray' : state.windowBehavior;
  const callback = (name) => (typeof options[name] === 'function' ? options[name] : () => {});
  const t = (key, params) => {
    const translated = typeof options.translate === 'function' ? options.translate(key, params) : '';
    return translated && translated !== key ? translated : translateMessage('en', key, params);
  };
  const codexAccounts = Array.isArray(state.codexAccounts) ? state.codexAccounts : [];
  const codexItem = codexAccounts.length >= 2 ? (() => {
    const labelFor = (account, index) => {
      const email = String(account?.email || '').trim();
      if (email) return state.maskAccountEmails ? maskEmailAddress(email) : email;
      return t('trayMenu.codexAccountFallback', { number: index + 1 });
    };
    const activeIndex = codexAccounts.findIndex((account) => account.id === state.activeCodexAccountId);
    const label = activeIndex >= 0
      ? t('trayMenu.codexAccountCurrent', { account: labelFor(codexAccounts[activeIndex], activeIndex) })
      : t('trayMenu.codexAccount');
    return {
      label,
      submenu: codexAccounts.map((account, index) => ({
        label: labelFor(account, index),
        type: 'radio',
        checked: account.id === state.activeCodexAccountId,
        enabled: !state.codexSwitching,
        click: () => {
          if (account.id !== state.activeCodexAccountId) callback('onSwitchCodexAccount')(account.id);
        }
      }))
    };
  })() : null;
  return [
    {
      label: t(state.refreshing ? 'trayMenu.refreshing' : 'trayMenu.refreshNow'),
      enabled: !state.refreshing,
      click: callback('onRefresh')
    },
    {
      label: t('trayMenu.openView'),
      submenu: OPEN_VIEW_MENU_ITEMS.map(([value, labelKey]) => ({
        label: t(labelKey),
        enabled: state.viewEnabled?.[value] !== false,
        click: () => callback('onOpenView')(value)
      }))
    },
    ...(codexItem ? [codexItem] : []),
    { type: 'separator' },
    {
      label: t('trayMenu.trayDisplay'),
      submenu: TRAY_CONTENT_MENU_ITEMS.map(([value, labelKey]) => ({
        label: t(labelKey),
        type: 'radio',
        checked: state.trayContent === value,
        click: () => callback('onSetTrayContent')(value)
      }))
    },
    {
      label: t('trayMenu.windowPresentation'),
      submenu: WINDOW_PRESENTATION_MENU_ITEMS.map(([value, labelKey]) => ({
        label: t(labelKey),
        type: 'radio',
        checked: presentation === value,
        click: () => callback('onSetWindowPresentation')(value)
      }))
    },
    { type: 'separator' },
    { label: t('trayMenu.version', { version: state.appVersion || '' }), enabled: false },
    { label: t('trayMenu.settings'), click: callback('onOpenSettings') },
    { label: t('trayMenu.quit'), click: callback('onQuit') }
  ];
}

function createTray({
  getMenuState,
  onOpenSettings,
  onOpenView,
  onQuit,
  onRefresh,
  onSetTrayContent,
  onSetWindowPresentation,
  onSwitchCodexAccount,
  onToggle,
  translateMenu
}) {
  const { Tray, Menu } = require('electron');
  const tray = new Tray(buildTrayIcon());
  tray.setToolTip('Token Monitor');

  tray.on('click', () => onToggle(tray));
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate(buildTrayMenuTemplate({
      state: typeof getMenuState === 'function' ? getMenuState() : {},
      onOpenSettings,
      onOpenView,
      onQuit,
      onRefresh,
      onSetTrayContent,
      onSetWindowPresentation,
      onSwitchCodexAccount,
      translate: translateMenu
    }));
    tray.popUpContextMenu(menu);
  });

  return tray;
}

function popoverBounds(tray, popoverWidth, popoverHeight) {
  const { screen } = require('electron');
  const trayBounds = tray?.getBounds?.() || { x: 0, y: 0, width: 0, height: 0 };
  const cursor = screen.getCursorScreenPoint();
  const anchor = trayBounds.width > 0
    ? { x: trayBounds.x + trayBounds.width / 2, y: trayBounds.y, height: trayBounds.height }
    : { x: cursor.x, y: cursor.y, height: 0 };
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  const wa = display.workArea;

  let x = Math.round(anchor.x - popoverWidth / 2);
  x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - popoverWidth - 4));

  let y;
  if (process.platform === 'darwin') {
    y = Math.round(anchor.y + (anchor.height || 0) + 4);
  } else {
    // Windows / Linux: tray icon usually sits near the bottom; open above.
    y = Math.round(anchor.y - popoverHeight - 8);
    if (y < wa.y + 4) y = Math.round(anchor.y + (anchor.height || 0) + 8);
  }
  y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - popoverHeight - 4));

  return { x, y, width: popoverWidth, height: popoverHeight };
}

module.exports = {
  buildTrayIcon,
  buildTrayMenuTemplate,
  createTray,
  formatTrayText,
  pickUsageTrayIconId,
  pickWorstLimit,
  popoverBounds,
  reconcileCodexAccountSelection,
  sortCodexAccountsForDisplay
};
