'use strict';

const path = require('node:path');
const {
  formatTrayText,
  isBarsTrayIconMode,
  isGeneratedTrayIconMode,
  pickUsageProviderId,
  pickWorstLimit,
  trayShowsTitle
} = require('../shared/trayText');
const { codexAccountDisplayLabel } = require('./renderer/accountIdentity');
const { translate: translateMessage } = require('./renderer/i18n');

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icons', 'tray-token-monitor.png');

// Windows keeps the taskbar's theme in SystemUsesLightTheme, separate from the
// AppsUseLightTheme that drives the app theme. Measured on Windows 11 with
// Electron 43.3.0, a system-theme flip lands like this:
//
//   nativeTheme 'updated' fires -> AppsUseLightTheme and shouldUseDarkColors are
//   already new, SystemUsesLightTheme is still the OLD value and only lands a
//   moment later (~250ms), while Chromium's cached
//   shouldUseDarkColorsForSystemIntegratedUI never catches up at all until the
//   NEXT flip.
//
// So neither reading the cached property nor a single registry read at event
// time can answer: both report the state before the flip, which is what left the
// tray one theme change behind. Re-read until the value actually moves.
// Returns true for a dark system surface, false for light, null if unreadable.
function parseWindowsSystemUsesLightTheme(output) {
  const match = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(String(output || ''));
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  // Windows only ever writes 0 or 1 here. Anything else is a value we do not
  // understand, and guessing "light" from it would repaint the tray on a reading
  // we cannot justify.
  if (value === 0) return true;
  if (value === 1) return false;
  return null;
}

// Spread wide enough to cover a slow write without holding a flip visibly: the
// measured landing is inside the first step, the rest are headroom.
const SYSTEM_UI_THEME_SETTLE_MS = [150, 400, 1000, 2000];

// Settles on a value seen twice in a row rather than on the first one that
// differs from what we hold. Those are not the same thing while two flips are in
// flight: flipping back within the write delay leaves the first flip's value
// landing under the second flip's read, and "differs from previous" would accept
// that intermediate reading and stop — parking the tray on a theme the user has
// already left, with no further event coming to correct it. Two agreeing reads a
// gap apart mean the writes have stopped moving, and every gap in the schedule is
// wider than the write delay measured above.
//
// `previous` decides only whether the settled value is worth publishing: an
// app-theme-only flip raises the same event, and the system surface did not move
// there. Answers null when nothing settled, or when it settled on what we hold.
async function settleSystemDarkUi({ read, wait, isCurrent = () => true, previous, schedule = SYSTEM_UI_THEME_SETTLE_MS }) {
  let candidate = null;
  for (const ms of schedule) {
    await wait(ms);
    if (!isCurrent()) return null;
    const value = await read();
    if (!isCurrent()) return null;
    if (typeof value !== 'boolean') continue;
    if (value === candidate) return value === previous ? null : value;
    candidate = value;
  }
  return null;
}

function buildTrayIcon(options = {}) {
  const platform = options.platform || process.platform;
  const nativeImage = options.nativeImage || require('electron').nativeImage;
  if (platform === 'darwin') {
    const image = nativeImage.createFromPath(TRAY_ICON_PATH).resize({ height: 20, quality: 'best' });
    image.setTemplateImage(true);
    return image;
  }
  return nativeImage.createFromPath(ICON_PATH).resize({ width: 20, height: 20 });
}

function trayUsagePeriod(contentMode) {
  if (contentMode === 'tokensAll' || contentMode === 'costAll' || contentMode === 'bothAll') return 'allTime';
  if (contentMode === 'tokens' || contentMode === 'cost' || contentMode === 'both') return 'today';
  return null;
}

function pickUsageTrayIconId(stats, contentMode = 'tokens', availableIconIds = []) {
  const periodKey = trayUsagePeriod(contentMode);
  if (!periodKey) return null;
  const metric = contentMode === 'cost' || contentMode === 'costAll' ? 'cost' : 'tokens';
  return pickUsageProviderId(stats, metric, periodKey, availableIconIds);
}

function shouldUseTemplateTrayIcon(id, platform = process.platform, showProviderBadge = false) {
  return platform === 'darwin' && (isGeneratedTrayIconMode(id) || !showProviderBadge);
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
  ['icon', 'trayMenu.content.appIconOnly'],
  ['custom', 'trayMenu.content.custom']
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
      return codexAccountDisplayLabel(account, codexAccounts, {
        maskEmail: state.maskAccountEmails,
        personalWorkspaceLabel: t('settings.codex.personalWorkspace')
      }) || t('trayMenu.codexAccountFallback', { number: index + 1 });
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

async function runTrayMenuAction({ setInFlight, refreshContextMenu, action }) {
  setInFlight(true);
  try {
    refreshContextMenu();
    return await action();
  } finally {
    setInFlight(false);
    refreshContextMenu();
  }
}

function createTray({
  electron = require('electron'),
  getMenuState,
  onOpenSettings,
  onOpenView,
  onQuit,
  onRefresh,
  onSetTrayContent,
  onSetWindowPresentation,
  onSwitchCodexAccount,
  onToggle,
  platform = process.platform,
  translateMenu
}) {
  const { Tray, Menu, nativeImage } = electron;
  const tray = new Tray(buildTrayIcon({ platform, nativeImage }));
  tray.setToolTip('Token Monitor');

  const menuState = () => (typeof getMenuState === 'function' ? getMenuState() : {});
  const buildMenu = (state = menuState()) => Menu.buildFromTemplate(buildTrayMenuTemplate({
    state,
    onOpenSettings,
    onOpenView,
    onQuit,
    onRefresh,
    onSetTrayContent,
    // Non-tray presentation changes can keep an existing Linux tray alive,
    // so re-export the D-Bus menu after the callback mutates settings.
    onSetWindowPresentation: (value) => {
      try {
        return typeof onSetWindowPresentation === 'function'
          ? onSetWindowPresentation(value)
          : undefined;
      } finally {
        refreshContextMenu();
      }
    },
    onSwitchCodexAccount,
    translate: translateMenu
  }));

  // Linux tray hosts (GNOME AppIndicator/KStatusNotifier, KDE Plasma) display
  // the D-Bus menu exported via com.canonical.dbusmenu on right-click and never
  // deliver a 'right-click' event, so the menu has to be attached with
  // setContextMenu() to be reachable; popUpContextMenu() alone shows nothing.
  let exportedMenuState = '';
  const refreshContextMenu = () => {
    if (platform !== 'linux' || tray.isDestroyed()) return;
    const state = menuState();
    const stateKey = JSON.stringify(state);
    if (stateKey === exportedMenuState) return;
    tray.setContextMenu(buildMenu(state));
    exportedMenuState = stateKey;
  };
  refreshContextMenu();

  tray.on('click', () => onToggle(tray));
  tray.on('right-click', () => {
    tray.popUpContextMenu(buildMenu());
  });

  tray.refreshContextMenu = refreshContextMenu;

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
  SYSTEM_UI_THEME_SETTLE_MS,
  buildTrayIcon,
  buildTrayMenuTemplate,
  createTray,
  parseWindowsSystemUsesLightTheme,
  settleSystemDarkUi,
  formatTrayText,
  isBarsTrayIconMode,
  pickUsageTrayIconId,
  pickWorstLimit,
  popoverBounds,
  reconcileCodexAccountSelection,
  runTrayMenuAction,
  shouldUseTemplateTrayIcon,
  sortCodexAccountsForDisplay,
  trayShowsTitle
};
