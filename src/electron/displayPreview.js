'use strict';

// A local, read-only projection. Sample data never enters collectors, native
// controllers or saved preferences. Shapes and content use production builders.
const { buildNotchData } = require('./notch/data');
const { notchPanelItems } = require('./notch/panel');
const { buildEdgeDockCells } = require('./renderer/edgeDock/presentation');
const { normalizeEdgeDockItems } = require('./renderer/edgeDock/items');
const { NOTCH_METRICS, notchGeometry, notchBounds, notchPeekBounds, notchCommands, translateCommands } = require('./notch/geometry');
const { EDGE_DOCK_METRICS: M, edgeDockCellLayout, edgeDockScale } = require('./edgeDock/geometry');
const { toSvgPath, railCommands, peekCommands } = require('./renderer/edgeDock/shapes');
const { panelContentHeight } = require('./renderer/notch/panel');

const APPEARANCE_KEYS = ['language', 'theme', 'themePreset', 'themeColors', 'vendorColors', 'interfaceFontFamily', 'displayFontFamily', 'textSize', 'glassOpacity', 'glassBlur', 'systemGlass', 'compactTokenUnits', 'currency', 'currencyRate', 'currencyRateOverride', 'currencyRatesEffective', 'showCompactTotalTokens', 'sessionContextMetric', 'tokenNumberAnimation', 'showLimitUsed', 'showCodexAdditionalLimits', 'limitProviderHiddenItems', 'maskLimitAccountEmails', 'edgeDockWarnColors', 'edgeDockRunningIndicatorEnabled', 'notchWarnColors', 'notchRunningIndicatorEnabled', 'tokenRateMode', 'contextDisplayMode'];
function sampleStats(now) {
  const period = { totalTokens: 1240800, costUsd: 3.82, clients: { claude: 840000, codex: 400800 }, clientCosts: { claude: 2.64, codex: 1.18 }, models: { 'claude-sonnet-4-6': 840000, 'gpt-5.4': 400800 }, modelCosts: { 'claude-sonnet-4-6': 2.64, 'gpt-5.4': 1.18 } };
  period.sessions = [{ sessionId: 'preview-session', client: 'claude', title: 'Example project', totalTokens: 48000, costUsd: .24, lastUsedAt: new Date(now).toISOString(), startedAt: new Date(now - 300000).toISOString() }];
  return { periods: { today: period, month: period, allTime: period }, limits: { providers: ['claude', 'codex'].map((provider, i) => ({ provider, accountKey: `preview-${provider}`, status: 'ok', updatedAt: new Date(now).toISOString(), windows: [{ id: 'session', kind: 'session', label: 'Session', usedPercent: 22 + i * 12, resetsAt: new Date(now + 7200000).toISOString() }, { id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 41 + i * 9 }] })) } };
}
function shape(commands, width, height) {
  const d = toSvgPath(commands); return { d, key: d, width, height };
}
function buildDisplayPreview(settings, id, phase = 'closed', platform = process.platform, now = Date.now(), measuredSlots = null) {
  if (!['edgeDock', 'notch'].includes(id) || !['closed', 'hover', 'open'].includes(phase)) return null;
  const appearance = Object.fromEntries(APPEARANCE_KEYS.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
  appearance.reduceMotion = 'on';
  const stats = sampleStats(now);
  const base = { platform, appearance, glass: false, liquidGlass: false, refreshEnabled: false, refreshable: false };
  if (id === 'edgeDock') {
    const cells = buildEdgeDockCells(stats, { ...settings, items: normalizeEdgeDockItems(settings.edgeDockItems) || undefined });
    const side = settings.edgeDockSide === 'left' ? 'left' : 'right';
    const layout = edgeDockCellLayout({ height: 900 }, cells.map(cell => cell.kind));
    const opened = phase === 'open';
    const width = opened ? M.railWidth : M.peekWidth, height = opened ? layout.length : M.peekLength;
    const commands = opened ? railCommands({ width, height, side, shoulder: M.shoulder, radius: M.railRadius })
      : peekCommands({ width, height, side, handleWidth: M.handleWidth, handleLength: M.handleLength });
    return { width, height, scale: edgeDockScale(settings), align: side,
      payload: { ...base, surface: opened ? 'rail' : 'peek', side, zoom: 1, cells, cellLayout: layout, always: true, peeking: !opened, reveal: 0, shape: shape(commands, width, height) } };
  }
  const zoom = edgeDockScale({ edgeDockSize: settings.notchSize, edgeDockCustomScale: settings.notchCustomScale });
  const cells = buildEdgeDockCells(stats, { ...settings, items: notchPanelItems(stats, settings) });
  const data = buildNotchData(stats, cells, settings, { nowMs: now });
  const display = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 32, width: 1440, height: 868 }, scaleFactor: 2 };
  const native = { frame: { origin: { x: 0, y: 0 }, size: { width: 1440, height: 900 } }, safeTop: 32,
    left: { origin: { x: 0, y: 868 }, size: { width: 630, height: 32 } }, right: { origin: { x: 810, y: 868 }, size: { width: 630, height: 32 } } };
  const geometry = notchGeometry(display, native, settings.notchShape);
  geometry.summaryZoom = Math.min(zoom, (geometry.height - 8) / 20);
  geometry.summaryRingSize = data.summary && geometry.gapWidth === 0 && settings.notchRunningIndicatorEnabled === true
    && data.summary.items.some(item => item.providerCell) ? 42 : 0;
  if (geometry.gapWidth === 0 && geometry.summaryRingSize) geometry.height = Math.ceil(geometry.summaryRingSize * geometry.summaryZoom + 8);
  const measured = measuredSlots && ['left', 'right'].every(key => Number.isFinite(measuredSlots[key]) && measuredSlots[key] >= 0 && measuredSlots[key] <= 1440);
  const slots = data.summary ? measured ? { left: measuredSlots.left, right: measuredSlots.right } : { left: 115, right: 100 } : null;
  const closed = notchBounds(display, geometry, false, panelContentHeight({ attached: geometry.gapWidth > 0, zoom }), slots, zoom);
  const opened = notchBounds(display, geometry, true, panelContentHeight({ attached: geometry.gapWidth > 0, zoom }), slots, zoom);
  const bounds = phase === 'open' ? opened : phase === 'hover' ? notchPeekBounds(closed) : closed;
  const width = opened.width + 120, height = opened.height + 80;
  const origin = geometry.centerX - width / 2, x = bounds.x - origin;
  const silhouette = shape(translateCommands(notchCommands(bounds.width, bounds.height, geometry.notched, phase === 'open', geometry.height, zoom), x), width, height);
  const progress = phase === 'open' ? 1 : 0;
  const headerHeight = geometry.gapWidth > 0 ? geometry.height : geometry.height * (1 - progress);
  appearance.zoomFactor = zoom;
  appearance.edgeDockWarnColors = settings.notchWarnColors === true;
  appearance.edgeDockRunningIndicatorEnabled = settings.notchRunningIndicatorEnabled === true;
  return { width, height, contentHeight: bounds.height, previewHeight: opened.height, scale: 1, align: 'center', payload: { ...base, ...data, surface: 'notch', notch: true, summaryMeasurement: { id: 1, measuring: Boolean(data.summary && !measured) }, style: settings.notchStyle || 'inherit', expanded: phase === 'open', visible: phase === 'open', shape: silhouette,
    geometry: { ...geometry, summaryBudget: 500, headerX: closed.x - origin, headerWidth: closed.width, gapOffset: geometry.centerX - geometry.gapWidth / 2 - closed.x, flare: geometry.notched ? NOTCH_METRICS.openFlare : 0, shoulder: geometry.notched && data.summary ? NOTCH_METRICS.restingFlare : 0 },
    motion: { shape: silhouette, progress, contentScale: bounds.width / opened.width, headerHeight, bodyHeight: bounds.height - headerHeight, summaryHeight: bounds.height, summaryScale: phase === 'hover' ? bounds.height / closed.height : 1, summaryIconInset: 0, summaryEdges: { left: x + 16, right: x + bounds.width - 16 }, bodyBox: { x: opened.x - origin, width: opened.width } } } };
}
module.exports = { buildDisplayPreview, sampleStats };
