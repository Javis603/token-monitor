/* global document */
'use strict';
// This is plugin-owned presentation, not a host animation API. Only received
// samples enter history. A one-sample presentation buffer scrolls measured
// segments continuously without predicting values or increasing collection.
const WINDOW_MS = 120000, PLAYBACK_DELAY_MS = 2250, PERSIST_INTERVAL_MS = 10000;
let clockEpoch = Date.now(), clockStart = performance.now();
function clock() {
  const monotonic = performance.now(), wall = Date.now();
  const estimate = clockEpoch + monotonic - clockStart;
  if (Math.abs(wall - estimate) <= 1000) return estimate;
  // Source timestamps use wall time. Re-anchor after sleep/time correction,
  // rather than accumulating a permanent presentation lag. A backward epoch
  // starts fresh history so old future-dated samples cannot reject new data.
  for (const chart of charts) {
    if (wall < estimate) { chart.points = []; chart.at = 0; chart.memory = null; }
    chart.end = 0; chart.dirty = true;
  }
  clockEpoch = wall; clockStart = monotonic;
  return wall;
}
const charts = [...document.querySelectorAll('.metric')].map(element => ({
  element, metric: element.dataset.metric, points: [], at: 0, end: 0, dirty: true, persistedAt: -Infinity,
  line: element.querySelector('.line'), area: element.querySelector('.area')
}));
const labels = {
  en: ['Memory', 'Last 2 min'], 'zh-TW': ['記憶體', '最近 2 分鐘'],
  'zh-CN': ['内存', '最近 2 分钟'], ja: ['メモリ', '直近 2 分'],
  ko: ['메모리', '최근 2분'], 'pt-BR': ['Memória', 'Últimos 2 min']
};
let locale = 'en', reduced = true, frame = 0, stopped = false;
const finitePercent = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
const sourceFor = chart => `sys.${chart.metric}`;
const historyKey = chart => `chart-history-v1-${chart.metric}`;
function percent(value) { return value === null ? '—' : `${Math.round(value)}%`; }
function bytes(value) { return Number.isFinite(value) && value >= 0 ? `${(value / 1073741824).toLocaleString(locale, { maximumFractionDigits: 1 })} GB` : '—'; }
function display(chart, now) {
  // Monotonic presentation time, bounded by received data. A stalled source
  // freezes at its last sample; there is no extrapolated right-hand tail.
  const next = reduced ? chart.at : Math.min(chart.at, now - PLAYBACK_DELAY_MS);
  chart.end = Math.min(chart.at, Math.max(chart.end, next));
  return chart.end;
}
function draw(chart, now) {
  if (chart.dirty) {
    let line = '', area = '', firstX = 0, lastX = 0, open = false;
    const close = () => { if (open) area += `L${lastX} 88L${firstX} 88Z`; open = false; };
    for (const point of chart.points) {
      if (point.value === null) { close(); continue; }
      const x = 400 * (1 - (chart.at - point.at) / WINDOW_MS), y = 87 - point.value * .86;
      const command = `${open ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`;
      line += command; area += command;
      if (!open) firstX = x; lastX = x; open = true;
    }
    close(); chart.line.setAttribute('d', line); chart.area.setAttribute('d', area);
    chart.dirty = false;
  }
  // Rebuild only on data changes; each animation frame merely translates the
  // immutable measured path. The SVG viewport clips not-yet-played samples.
  const transform = `translate(${(400 * (chart.at - display(chart, now)) / WINDOW_MS).toFixed(4)} 0)`;
  chart.line.setAttribute('transform', transform); chart.area.setAttribute('transform', transform);
}
function paint() {
  frame = 0;
  const now = clock();
  for (const chart of charts) draw(chart, now);
  if (!stopped && !reduced && !document.hidden && charts.some(chart => chart.end < chart.at)) frame = requestAnimationFrame(paint);
}
function render() { if (frame) cancelAnimationFrame(frame); frame = 0; if (!stopped && !document.hidden) paint(); }
function context(value) {
  const theme = value.theme;
  locale = Object.hasOwn(labels, value.locale) ? value.locale : 'en';
  reduced = theme.reducedMotion === true;
  document.documentElement.lang = locale;
  document.documentElement.style.colorScheme = theme.dark ? 'dark' : 'light';
  for (const [key, color] of Object.entries(theme.colors)) document.documentElement.style.setProperty(`--${key}`, color);
  document.body.style.fontFamily = theme.font;
  for (const chart of charts) {
    chart.element.querySelector('h2').textContent = chart.metric === 'cpu' ? 'CPU' : labels[locale][0];
    chart.element.querySelector('footer').textContent = labels[locale][1];
    updateLabel(chart);
  }
  render();
}
function updateLabel(chart) {
  const reading = chart.points.at(-1)?.value ?? null;
  chart.element.querySelector('.value').textContent = percent(reading);
  chart.element.querySelector('svg').setAttribute('aria-label', `${chart.metric === 'cpu' ? 'CPU' : labels[locale][0]} ${percent(reading)}`);
  chart.element.querySelector('.detail').textContent = chart.metric === 'memory' && chart.memory ? `${bytes(chart.memory.used)} / ${bytes(chart.memory.total)}` : '';
}
function accept(chart, reading) {
  if (!reading || !Number.isFinite(reading.at) || reading.at < chart.at) return;
  if (reading.at === chart.at) { if (chart.metric === 'memory') chart.memory = reading.value; updateLabel(chart); return; }
  const at = reading.at, value = finitePercent(chart.metric === 'cpu' ? reading.value : reading.value?.percent);
  const previous = chart.points.at(-1);
  if (previous && at - previous.at > 15000) chart.points.push({ at: previous.at + 1, value: null });
  chart.points.push({ at, value }); chart.at = at;
  // A bounded two-minute history, with one preceding point for clipped edges.
  while (chart.points.length > 2 && chart.points[1].at < at - WINDOW_MS - PLAYBACK_DELAY_MS) chart.points.shift();
  chart.points = chart.points.slice(-242);
  chart.memory = chart.metric === 'memory' ? reading.value : null;
  chart.dirty = true;
  updateLabel(chart);
  // Checkpoint cosmetic history on received samples, never on animation frames.
  // Park revokes the bridge before freezing, so pagehide cannot guarantee a flush.
  // Retained documents keep every point; eviction can lose the trailing interval.
  const now = performance.now();
  if (now - chart.persistedAt >= PERSIST_INTERVAL_MS) {
    chart.persistedAt = now; // Failed writes retry on a later checkpoint, not every sample.
    void tm.storage.set(historyKey(chart), JSON.stringify(chart.points)).catch(() => {});
  }
}
function data(values) { clock(); for (const chart of charts) accept(chart, values[sourceFor(chart)]); render(); }
async function start() {
  const offContext = tm.onContext(context);
  window.addEventListener('pagehide', () => { stopped = true; if (frame) cancelAnimationFrame(frame); offContext(); }, { once: true });
  context(await tm.context());
  await Promise.all(charts.map(async chart => {
    const saved = await tm.storage.get(historyKey(chart)).catch(() => null);
    const now = Date.now();
    let points = [];
    // A bounded JSON string stays inside the existing broker storage contract.
    try { if (typeof saved === 'string' && saved.length <= 32768) points = JSON.parse(saved); } catch { /* Invalid cosmetic history is discarded. */ }
    chart.points = (Array.isArray(points) ? points.slice(-242) : []).filter(p => p && Number.isFinite(p.at) && p.at >= now - WINDOW_MS - PLAYBACK_DELAY_MS && p.at <= now && (p.value === null || finitePercent(p.value) === p.value)).sort((a, b) => a.at - b.at).slice(-241);
    chart.at = chart.points.at(-1)?.at || 0; chart.dirty = true;
    updateLabel(chart);
  }));
  if (stopped) return;
  const offData = tm.onData(data);
  window.addEventListener('pagehide', offData, { once: true });
  data(await tm.subscribe(charts.map(sourceFor)));
}
document.addEventListener('visibilitychange', render);
void start().catch(render);
