'use strict';

// This page owns only artwork and canvases; all timing/data ownership is main's.
let input = {};
const state = () => ({ ...input, appInfo: { platform: input.platform } });
const text = window.TokenMonitorTrayText;
const layout = window.TokenMonitorTrayLayout;
const compact = window.TokenMonitorCompactTokens;
const providers = window.TokenMonitorLimitProviders.LIMIT_PROVIDER_CATALOG;
const order = window.TokenMonitorLimitProviderOrder;
const painter = window.TokenMonitorTrayImageRenderer.createTrayImageRenderer({
  getState: state,
  pickWorstProvider: (stats) => text.pickWorstLimitProvider(stats),
  pickWorstSessionProvider: (stats) => text.pickLimitProviderByKindPriority(stats, ['session', 'weekly']),
  pickWorstWeeklyProvider: (stats) => text.pickWorstLimitProvider(stats, { kind: 'weekly' }),
  configuredLimitProviderOrder: () => input.settings.limitsEnabled === false ? [] : order.normalizeLimitProviderOrder(input.settings.limitProviderOrder, providers)
    .filter((id) => order.normalizeLimitProviderSelection(input.settings.limitProviders, providers).includes(id)),
  currentCurrency: () => input.settings.currency,
  compactTokenDisplayOptions: () => input.settings,
  displayLiveTokenRateSamples: () => input.liveTokenRates,
  formatLiveTokenRate: (value) => {
    const rate = Math.max(0, Number(value) || 0);
    if (rate > 0 && rate < 0.1) return '<0.1';
    if (rate > 0 && rate < 1) return rate.toLocaleString(input.settings.locale, { maximumFractionDigits: 1 });
    return compact.formatCompactTokens(rate, compact.effectiveCompactTokenUnits(input.settings.compactTokenUnits, input.settings.locale), input.settings.locale);
  },
  localLiveCodexProvider: () => input.codexActiveAccount,
  statsForTrayComposer: () => input.stats,
  themePresetsApi: { isLightHex: () => false },
  resolvedThemeColor: () => '#000000',
  formatPercent: (value) => Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : '--',
  limitFillPercent: window.TokenMonitorLimitDisplayMode.limitFillPercent,
  accountIdentityApi: window.TokenMonitorAccountIdentity,
  trayLayoutApi: layout
});
const sources = window.TokenMonitorTrayProviderIcons.trayProviderIconSources(new Set([
  ...window.TokenMonitorVendorPresentation.VENDOR_IDS,
  ...window.TokenMonitorLimitProviders.LIMIT_PROVIDER_IDS,
  'claude-brand', 'chatgpt'
]));
sources.app = '../../../assets/icons/tray-token-monitor.png';
const imagesReady = Promise.all(Object.entries(sources).map(async ([id, source]) => {
  try {
    const image = await painter.loadImage(source);
    painter.trayProviderImages[id] = image;
    painter.trayProviderImageIds.set(image, id);
  } catch (_) { /* missing optional artwork uses the shared fallback */ }
}));
window.trayImage.onRender(async (next) => {
  input = next;
  window.TokenMonitorCurrency.configureRates(input.rates || {});
  await imagesReady;
  const icons = {};
  if (input.renderArtwork) {
    for (const [id, image] of Object.entries(painter.trayProviderImages)) {
      icons[id] = painter.providerImageToPngDataUrl(image, 44, input.settings.showTrayProviderBadge === true, { trayInk: true, standalone: true });
    }
  }
  const mode = input.settings.trayContent;
  if (text.isGeneratedTrayIconMode(mode)) {
    icons[mode] = painter.trayDataUrlForMode(mode, 44, text.trayGeneratedIconColors(input.platform, input.systemDarkUi), { trayInk: true });
  }
  return icons;
});
