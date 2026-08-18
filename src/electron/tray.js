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
// icon.png is authored to the macOS icon grid, where the squircle is inset from
// its canvas — the artwork covers ~75% of the 1024px square and the Dock reads
// the margin as spacing. The Windows notification area spaces the cells itself
// and expects full-bleed artwork, so downscaling that padded canvas into the
// small-icon metric spends a quarter of the cell on nothing at every scale,
// which is why #314 reads as undersized at 100% (12px of mark in a 16px cell)
// as much as at 150% (18px in 24px). icon-win.png is the full-bleed variant
// electron-builder already ships to the Windows installer.
const WINDOWS_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon-win.png');
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

// Delays BETWEEN reads, not deadlines measured from the event — so these sample
// at 150, 300, 450, 700, 1100, 1700, 2600 and 4000ms. Tight while the write is
// expected (measured at ~250ms, so the typical flip is answered by the third
// read), then stretching out: the tail is there for a machine slower than the
// one this was measured on, and polling it at 150ms throughout would spawn
// reg.exe two dozen times for a flip that never touched the system surface.
const SYSTEM_UI_THEME_SETTLE_MS = [150, 150, 150, 250, 400, 600, 900, 1400];

// One extra read after the window closes. Without it a value first seen on the
// last sample has nothing to confirm it, so the window would only really cover
// writes landing by 2600ms — a boundary short of the four seconds it claims.
const SYSTEM_UI_THEME_CONFIRM_MS = 150;

// Publishes as soon as a reading looks settled, then keeps watching to the end
// of the window instead of stopping there. Two readings that agree only prove
// nothing moved between those two samples — they cannot prove Windows has no
// write still to land, in either direction. The old value is stable before the
// first write arrives, and an intermediate value is stable between the two
// writes of a fast flip back. Stopping on either leaves the tray on a theme the
// user has already left, with no further event coming to correct it.
//
// So publishing is not the end of the watch, it is the current best answer: the
// measured shape is answered on the third read, keeping a flip under half a
// second, and anything that lands afterwards corrects it. `held` tracks what the
// renderer has been told so the same value is never published twice, which is
// also what keeps an app-theme-only flip — the same event, no movement on the
// system surface — from repainting anything at all.
async function watchSystemDarkUi({ read, wait, publish, isCurrent = () => true, held, schedule = SYSTEM_UI_THEME_SETTLE_MS, confirmMs = SYSTEM_UI_THEME_CONFIRM_MS }) {
  let current = held;
  let candidate = null;
  for (const ms of [...schedule, confirmMs]) {
    await wait(ms);
    if (!isCurrent()) return current;
    const value = await read();
    if (!isCurrent()) return current;
    if (typeof value !== 'boolean') continue;
    if (value === candidate && value !== current) {
      current = value;
      publish(value);
    }
    candidate = value;
  }
  return current;
}

// Each platform renders the notification-area / menubar icon at a different
// logical size, so the resize target is platform-specific instead of the old
// one-size-fits-all height: 20.
//   - macOS menubar icons sit at ~22 pt and use template tinting.
//   - Windows draws the notification-area icon at the small-icon system metric
//     (SM_CXSMICON): 16 px at 100%, scaling with the display's DPI factor
//     (24 @150%, 32 @200%, 40 @250%, 48 @300%) — track the metric, no cap.
// https://learn.microsoft.com/en-us/windows/win32/shell/notification-area
const DARWIN_TRAY_ICON_HEIGHT = 20;
const WINDOWS_SMALL_ICON_BASE_PX = 16;

function windowsTrayIconHeight(scaleFactor) {
  const factor = Math.max(1, Number(scaleFactor) || 1);
  return Math.max(WINDOWS_SMALL_ICON_BASE_PX, Math.round(WINDOWS_SMALL_ICON_BASE_PX * factor));
}

function primaryDisplayScaleFactor() {
  // Best-effort: the tray lives on the primary display's taskbar. In contexts
  // without a live Electron screen (tests), fall back to 1 (= 100% metric).
  try {
    return require('electron').screen.getPrimaryDisplay().scaleFactor || 1;
  } catch (_) {
    return 1;
  }
}

// Resize a tray source image to the platform's metric. `height`-only resizing
// preserves aspect ratio, so wide bar-style icons keep their width while square
// provider icons stay square. Windows keeps a larger, metric-matched source so
// the OS never has to blur-upscale an undersized icon on HiDPI.
function resizeTrayIconForPlatform(img, { platform = process.platform, scaleFactor, square = false } = {}) {
  if (platform === 'darwin') {
    return img.resize({ height: DARWIN_TRAY_ICON_HEIGHT, quality: 'best' });
  }
  if (platform === 'win32') {
    const factor = scaleFactor == null ? primaryDisplayScaleFactor() : scaleFactor;
    return img.resize({ height: windowsTrayIconHeight(factor), quality: 'best' });
  }
  // Linux and anything else. Generated tray icons (bars / sessions / limits) are
  // wider than tall, so default to the aspect-preserving height-only resize the
  // tray:setIcons handler always used. The bundled default app icon is square
  // and opts into force-square sizing via `square` to guarantee a 20x20 tile
  // regardless of the source aspect (the historical buildTrayIcon sizing).
  return square
    ? img.resize({ width: 20, height: 20 })
    : img.resize({ height: 20, quality: 'best' });
}

// The tightest rectangle covering every drawn pixel, or null when nothing is
// drawn. `bitmap` is Electron's raw 4-bytes-per-pixel buffer; only the alpha
// byte matters, and its offset is the same whether the transport is RGBA or
// BGRA. The threshold ignores the near-invisible tail of an antialiased edge,
// which would otherwise pin the bounds to a pixel nobody can see.
function trayIconOpaqueBounds(bitmap, width, height, alphaThreshold = 12) {
  if (!bitmap || !(width > 0) || !(height > 0)) return null;
  if (bitmap.length < width * height * 4) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (bitmap[(y * width + x) * 4 + 3] <= alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// Windows fits the whole bitmap into one square cell of the small-icon metric,
// so every transparent row and column the renderer left around the artwork is
// cell space the icon does not get. The renderer composes at 44px with the macOS
// menubar's breathing room built in — a provider mark sits at 78% of its box, a
// text segment's ink at about half its canvas height — which on a 24px cell is a
// quarter of the icon spent on nothing, while every neighbouring app draws edge
// to edge. Trimming to the drawn pixels is a no-op for a bitmap that already
// reaches its edges, and is deliberately not applied on macOS: the menubar has
// no cell to fill and that breathing room is what keeps the icon off the text
// beside it.
function trimTrayIconPadding(img) {
  const { width, height } = img.getSize();
  const bounds = trayIconOpaqueBounds(img.toBitmap(), width, height);
  if (!bounds) return img;
  if (bounds.width === width && bounds.height === height) return img;
  return img.crop(bounds);
}

// The whole path from a renderer-composed bitmap to the one the shell draws, so
// the Windows-only trim travels with the resize it belongs to instead of living
// at the IPC boundary.
function prepareTrayIconForPlatform(img, { platform = process.platform, scaleFactor, square = false } = {}) {
  const source = platform === 'win32' ? trimTrayIconPadding(img) : img;
  return resizeTrayIconForPlatform(source, { platform, scaleFactor, square });
}

function buildTrayIcon(options = {}) {
  const platform = options.platform || process.platform;
  const nativeImage = options.nativeImage || require('electron').nativeImage;
  if (platform === 'darwin') {
    const image = nativeImage.createFromPath(TRAY_ICON_PATH);
    const sized = resizeTrayIconForPlatform(image, { platform, scaleFactor: options.scaleFactor });
    sized.setTemplateImage(true);
    return sized;
  }
  // Windows / Linux: the bundled app icon is already high-resolution, so a
  // single best-quality downscale to the platform metric keeps the small
  // notification-area icon crisp on HiDPI instead of the old fixed 20x20.
  // Windows takes the full-bleed variant so the mark fills its cell; both
  // canvases are square, so the force-square 20x20 tile still applies.
  const image = nativeImage.createFromPath(platform === 'win32' ? WINDOWS_ICON_PATH : ICON_PATH);
  return resizeTrayIconForPlatform(image, { platform, scaleFactor: options.scaleFactor, square: true });
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
  SYSTEM_UI_THEME_CONFIRM_MS,
  SYSTEM_UI_THEME_SETTLE_MS,
  buildTrayIcon,
  buildTrayMenuTemplate,
  createTray,
  parseWindowsSystemUsesLightTheme,
  watchSystemDarkUi,
  formatTrayText,
  isBarsTrayIconMode,
  pickUsageTrayIconId,
  pickWorstLimit,
  popoverBounds,
  prepareTrayIconForPlatform,
  primaryDisplayScaleFactor,
  reconcileCodexAccountSelection,
  resizeTrayIconForPlatform,
  runTrayMenuAction,
  shouldUseTemplateTrayIcon,
  sortCodexAccountsForDisplay,
  trayIconOpaqueBounds,
  trayShowsTitle,
  trimTrayIconPadding,
  windowsTrayIconHeight
};
