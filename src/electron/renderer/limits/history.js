'use strict';

(() => {
  const bridge = window.limitsHistory;
  document.documentElement.classList.toggle('is-windows', bridge.platform === 'win32');
  const cardFrames = window.TokenMonitorCardMotion.createCardFrameLoop({ sendFrame: id => bridge.cardFrame(id) });
  bridge.onCardMotion(next => { if (bridge.platform === 'win32') cardFrames.update(next); });
  const model = window.TokenMonitorLimitsHistoryModel;
  const paintSvg = window.TokenMonitorLimitSvgPaint.paint;
  const i18n = window.TokenMonitorI18n;
  const $ = id => document.getElementById(id);
  let payload = null;
  const glass = window.TokenMonitorGlassRendering;
  let material = glass.normalizeNativeMaterialState();
  function appearance() {
    if (!payload) return;
    const settings = payload.appearance || {};
    glass.applyNativeMaterialClasses(material);
    const root = document.documentElement.style;
    const depth = (glass.usesNativeMaterial(material) ? 32 : Math.max(0, Math.min(100, settings.glassBlur ?? 32))) / 100;
    root.setProperty('--glass-alpha', glass.renderedGlassOpacity(settings, { userAgent: navigator.userAgent }).toFixed(2));
    root.setProperty('--line-alpha', (0.1 + depth * 0.09).toFixed(3));
    root.setProperty('--line-strong-alpha', (0.18 + depth * 0.14).toFixed(3));
    root.setProperty('--control-alpha', (0.03 + depth * 0.045).toFixed(3));
    document.documentElement.classList.toggle('system-glass-disabled', settings.systemGlass === false);
  }

  let selected = '';
  let hoveredBucket = '';
  let trendRangeMode = 'cycle';
  let trendScaleMode = 'unified';
  function currentTrendView() {
    return trendScaleMode === 'normalized' ? 'normalized' : trendRangeMode === 'recent' ? 'unifiedRecent' : 'unifiedCycle';
  }
  function setTrendView(view) {
    trendScaleMode = view === 'normalized' ? 'normalized' : 'unified';
    trendRangeMode = view === 'unifiedRecent' ? 'recent' : 'cycle';
  }
  let restoreReading = () => {};
  let contentAnimation = null;
  let animateMeasurement = false;
  const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  const SERIES_PALETTE = ['var(--accent)', '#0ea5e9', '#8b5cf6', '#f59e0b'];

  function t(key, args) { return i18n.translate(payload?.locale || 'en', `limits.history.${key}`, args); }
  function number(value) { return new Intl.NumberFormat(payload?.locale || 'en', { maximumFractionDigits: 2 }).format(value); }
  function date(at, options) { return new Date(at).toLocaleString(payload?.locale || 'en', options); }
  function unit(entry) { return entry.unit || entry.points.at(-1)?.unit || model.historyReadings(entry.window).primary?.unit || 'pp'; }
  function amount(value, entry) { return unit(entry) === 'pp' ? `${number(value)}%` : `${number(value)} ${unit(entry)}`; }
  function label(entry) { return window.TokenMonitorLimitWindowLabels.limitWindowLabel(payload.provider, entry.window, entry.window.kind); }
  function current() { return payload?.windows.find(entry => entry.key === selected) || payload?.windows[0]; }
  function seriesColor(index, total) {
    if (total <= 1) return 'var(--accent)';
    // Magpie-inspired distinct colors when merging multiple quota cycles (e.g. 5h indigo + 7d sky/accent)
    const multiPalette = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
    return multiPalette[index % multiPalette.length] || SERIES_PALETTE[index % SERIES_PALETTE.length];
  }
  function formatRelativeReset(resetsAt) {
    const ms = Date.parse(resetsAt) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const totalMinutes = Math.max(1, Math.round(ms / 60_000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const duration = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    return t('inDuration', { duration });
  }
  function overlayEntries(primaryEntry) {
    if (!payload?.windows?.length || !primaryEntry) return [];
    if (unit(primaryEntry) !== 'pp') return [primaryEntry];
    const ppWindows = payload.windows.filter(item => unit(item) === 'pp');
    return ppWindows.length > 1 ? ppWindows : [primaryEntry];
  }
  function svgNode(tag, attrs, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }


  function drawTrend() {
    const entry = current();
    if (!entry) return;
    const plot = $('trend');
    const width = plot.getBoundingClientRect().width;
    if (!width) return;
    const now = Date.now();
    const series = overlayEntries(entry);
    plot.replaceChildren();
    plot.setAttribute('viewBox', `0 0 ${width} 86`);
    if (trendScaleMode === 'normalized') {
      drawNormalizedTrend(series, plot, width, now);
      return;
    }
    plot.setAttribute('aria-label', `${label(entry)} · ${$('trend-heading').textContent}`);
    const moneyAxis = unit(entry) !== 'pp';
    const { start, end, cycle, guideEntry } = moneyAxis
      ? { ...model.trendBounds(entry.window, now, payload.provider), guideEntry: entry }
      : model.combinedTrendBounds(series, now, payload.provider, { rangeMode: trendRangeMode, primaryEntry: entry });
    const seriesWithPoints = series.map((item, idx) => {
      const sourcePoints = (trendRangeMode === 'recent' || trendScaleMode === 'unified') && item.recentPoints?.length
        ? item.recentPoints : item.points;
      let shown = sourcePoints.filter(p => p.at >= start && p.at <= end);
      if (!shown.length) {
        const reading = model.historyReadings(item.window).primary;
        if (reading?.unit === 'pp') {
          // A lane with no observation in this range (an unused model, or a
          // history that starts after the cycle began) still has a current
          // level. Hold that level across the cycle instead of omitting the
          // series entirely.
          shown = [{ at: start, value: reading.value }, { at: end, value: reading.value }];
        }
      }
      return { item, shown, color: seriesColor(idx, series.length) };
    });
    const anyShown = seriesWithPoints.some(s => s.shown.length > 0);
    $('empty').hidden = anyShown;
    plot.hidden = false;
    const allShownPoints = seriesWithPoints.flatMap(s => s.shown);
    const max = moneyAxis ? Math.max(1, model.historyReadings(entry.window).primary?.value || 0, ...allShownPoints.map(p => p.value)) * 1.08 : 100;
    const left = 26, right = width - 5, top = 10, bottom = 62;
    const span = Math.max(1, end - start);
    const X = at => left + Math.max(0, Math.min(1, (at - start) / span)) * (right - left);
    const Y = value => bottom - Math.max(0, Math.min(max, value)) / max * (bottom - top);
    for (const value of [max, max / 2, 0]) {
      plot.append(svgNode('line', { x1: left, x2: right, y1: Y(value), y2: Y(value), class: 'quota-history-grid' }));
      if (value !== max / 2) plot.append(svgNode('text', { x: 0, y: Y(value) + 4 }, moneyAxis ? number(value) : `${number(value)}%`));
    }
    const showGuide = !moneyAxis && cycle;
    $('guide-caption').hidden = !showGuide;
    $('guide-caption').textContent = t('guide');
    if (showGuide) {
      const guideColor = guideEntry ? seriesColor(Math.max(0, series.indexOf(guideEntry)), series.length) : 'var(--accent)';
      plot.append(paintSvg(svgNode('line', { x1: X(start), x2: X(end), y1: Y(100), y2: Y(0), class: 'quota-history-guide', 'aria-hidden': 'true' }), { stroke: guideColor }));
      if (now > start && now < end) {
        plot.append(svgNode('line', { x1: X(now), x2: X(now), y1: top, y2: bottom, class: 'quota-history-now', 'aria-hidden': 'true' }));
      }
    }
    for (const { item, shown, color } of seriesWithPoints) {
      const isSelected = item === entry;
      const strokeWidth = series.length > 1 ? (isSelected ? 2 : 1.45) : 1.65;
      const opacity = series.length > 1 && !isSelected ? 0.78 : 1;
      const segs = model.segments(shown);
      for (const segment of segs) {
        let d = '';
        segment.forEach((point, index) => {
          const y = Y(moneyAxis ? point.value : 100 - point.value);
          d += `${index === 0 ? 'M' : 'L'}${X(point.at)},${y}`;
        });
        if (segment.length > 1 && isSelected) {
          const firstX = X(segment[0].at), lastX = X(segment.at(-1).at);
          const areaD = `${d} L${lastX},${bottom} L${firstX},${bottom} Z`;
          plot.append(paintSvg(svgNode('path', { d: areaD, class: 'quota-history-area' }), { fill: color }));
        }
        plot.append(paintSvg(svgNode('path', { d, class: 'quota-history-curve' }), { stroke: color, 'stroke-width': strokeWidth, opacity }));
        if (segment.length === 1) {
          const point = segment[0];
          const x = X(point.at), y = Y(moneyAxis ? point.value : 100 - point.value);
          plot.append(paintSvg(svgNode('line', { x1: Math.max(left, x - 2), x2: Math.min(right, x + 2), y1: y, y2: y, class: 'quota-history-curve' }), { stroke: color, 'stroke-width': strokeWidth }));
        }
      }
      const lastPoint = shown.at(-1);
      if (lastPoint) {
        const cx = X(lastPoint.at), cy = Y(moneyAxis ? lastPoint.value : 100 - lastPoint.value);
        plot.append(paintSvg(svgNode('circle', { cx, cy, r: isSelected ? 2.6 : 2, class: 'quota-history-dot' }), { fill: color, opacity }));
      }
    }
    const format = end - start < 86400_000
      ? { hour: '2-digit', minute: '2-digit' }
      : cycle ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' };
    plot.append(svgNode('text', { x: left, y: 81 }, date(start, format)));
    plot.append(svgNode('text', { x: right, y: 81, 'text-anchor': 'end' }, date(end, format)));
  }

  function drawNormalizedTrend(series, plot, width, now) {
    const rows = series.map((item, idx) => ({
      item,
      bounds: model.trendBounds(item.window, now, payload.provider),
      color: seriesColor(idx, series.length)
    })).filter(row => row.bounds.cycle);
    plot.setAttribute('aria-label', `${label(current())} · ${t('trendNormalized')}`);
    if (!rows.length) {
      $('empty').hidden = false;
      $('empty').textContent = t('empty');
      plot.hidden = false;
      return;
    }
    const left = 26, right = width - 5, top = 10, bottom = 62;
    const X = fraction => left + Math.max(0, Math.min(1, fraction)) * (right - left);
    const Y = value => bottom - Math.max(0, Math.min(100, value)) / 100 * (bottom - top);
    for (const value of [100, 50, 0]) {
      plot.append(svgNode('line', { x1: left, x2: right, y1: Y(value), y2: Y(value), class: 'quota-history-grid' }));
      if (value !== 50) plot.append(svgNode('text', { x: 0, y: Y(value) + 4 }, `${value}%`));
    }
    // The scaled view compares each lane at the same current instant. Its x
    // axis is therefore cycle start -> now, not cycle start -> reset; otherwise
    // the latest points of a 5h and a 7d lane land at different fractions.
    $('guide-caption').hidden = true;
    const shownRows = rows.map(row => {
      let points = (row.item.points || []).filter(point => point.at >= row.bounds.start && point.at <= row.bounds.end);
      if (!points.length) {
        const reading = model.historyReadings(row.item.window).primary;
        if (reading?.unit === 'pp') points = [
          { at: row.bounds.start, value: reading.value },
          { at: Math.min(now, row.bounds.end), value: reading.value }
        ];
      }
      return { ...row, points };
    });
    $('empty').hidden = shownRows.some(row => row.points.length > 0);
    for (const row of shownRows) {
      const isSelected = row.item === current();
      const strokeWidth = rows.length > 1 ? (isSelected ? 2 : 1.45) : 1.65;
      const opacity = rows.length > 1 && !isSelected ? 0.78 : 1;
      const viewEnd = Math.min(now, row.bounds.end);
      const XAt = at => X((at - row.bounds.start) / Math.max(1, viewEnd - row.bounds.start));
      for (const segment of model.segments(row.points)) {
        let d = '';
        segment.forEach((point, index) => {
          d += `${index === 0 ? 'M' : 'L'}${XAt(point.at)},${Y(100 - point.value)}`;
        });
        if (segment.length > 1 && isSelected) {
          const areaD = `${d} L${XAt(segment.at(-1).at)},${bottom} L${XAt(segment[0].at)},${bottom} Z`;
          plot.append(paintSvg(svgNode('path', { d: areaD, class: 'quota-history-area' }), { fill: row.color }));
        }
        plot.append(paintSvg(svgNode('path', { d, class: 'quota-history-curve' }), { stroke: row.color, 'stroke-width': strokeWidth, opacity }));
        if (segment.length === 1) {
          const point = segment[0];
          plot.append(paintSvg(svgNode('line', { x1: Math.max(left, XAt(point.at) - 2), x2: Math.min(right, XAt(point.at) + 2), y1: Y(100 - point.value), y2: Y(100 - point.value), class: 'quota-history-curve' }), { stroke: row.color, 'stroke-width': strokeWidth }));
        }
      }
      const last = row.points.at(-1);
      if (last) plot.append(paintSvg(svgNode('circle', { cx: XAt(last.at), cy: Y(100 - last.value), r: isSelected ? 2.6 : 2, class: 'quota-history-dot' }), { fill: row.color, opacity }));
    }
    plot.append(svgNode('text', { x: left, y: 81 }, t('cycleStart')));
    plot.append(svgNode('text', { x: right, y: 81, 'text-anchor': 'end' }, t('cycleNow')));
  }

  function drawDistribution(entry) {
    const result = entry.distribution || model.distribution(entry.points, { now: Date.now() });
    const values = result.buckets.map(b => b.value ?? 0);
    const peak = Math.max(1, ...values);
    const magnitude = 10 ** Math.floor(Math.log10(peak));
    const ceiling = [1, 2, 5, 10].find(value => value * magnitude >= peak) * magnitude;
    const format = { month: 'numeric', day: 'numeric' };
    $('range').textContent = t('lastDays', { count: 14 });
    $('bars').replaceChildren();
    $('bars').setAttribute('role', 'list');
    $('bars').setAttribute('aria-label', t('distribution'));
    if (!result.buckets.some(b => b.key === hoveredBucket)) hoveredBucket = '';
    const today = result.buckets.find(bucket => bucket.key === model.dayKey(Date.now()));
    function reading(bucket, isToday = false) {
      const value = bucket?.value == null ? t('insufficient') : amount(bucket.value, entry);
      $('reading').textContent = `${isToday ? t('today') : date(bucket.at, format)} · ${value}`;
    }
    restoreReading = () => reading(today, true);
    for (const bucket of result.buckets) {
      const button = document.createElement('span');
      button.setAttribute('role', 'listitem');
      button.dataset.historyBucket = bucket.key;
      button.className = ['quota-history-bar', bucket.value === null ? 'is-unknown' : '', bucket.uncertain ? 'is-partial' : ''].filter(Boolean).join(' ');
      button.classList.toggle('is-hovered', bucket.key === hoveredBucket);
      button.setAttribute('aria-label', `${date(bucket.at, format)} · ${bucket.value === null ? t('unknown') : amount(bucket.value, entry)}${bucket.uncertain ? ` · ${t('partial')}` : ''}`);
      const fill = document.createElement('i');
      fill.style.height = `${(bucket.value ?? 0) / ceiling * 100}%`;
      button.append(fill);
      button.addEventListener('pointerenter', () => {
        hoveredBucket = bucket.key;
        for (const bar of $('bars').children) {
          bar.classList.toggle('is-hovered', bar === button);
        }
        reading(bucket);
      });
      $('bars').append(button);
    }
    const picked = result.buckets.find(bucket => bucket.key === hoveredBucket);
    if (picked) reading(picked);
    else restoreReading();
    const first = result.buckets[0], last = result.buckets.at(-1);
    $('first').textContent = first ? date(first.at, format) : '';
    $('last').textContent = last ? date(last.at, format) : '';
    $('notice').hidden = !result.buckets.some(bucket => bucket.uncertain || bucket.value === null);
    $('unallocated').textContent = result.unallocated > 0 ? t('unallocated', { amount: amount(result.unallocated, entry) }) : '';
  }

  function render() {
    if (!payload) return;
    document.documentElement.lang = payload.locale;
    const now = Date.now();
    const entry = current();
    $('provider').textContent = payload.label;
    $('account').textContent = payload.account;
    $('history').setAttribute('aria-label', t('open'));
    const selector = $('windows');
    selector.setAttribute('aria-label', t('windows'));
    selector.replaceChildren();
    const meters = $('meters');
    meters.replaceChildren();
    const series = overlayEntries(entry);
    const hasNonPercentWindows = payload.windows.some(item => unit(item) !== 'pp');
    // Show pill selector only when there are non-percent windows mixed in;
    // otherwise the Magpie-style top progress meter cards act as the interactive selector.
    selector.hidden = !hasNonPercentWindows || payload.windows.length < 2;
    for (const [idx, item] of payload.windows.entries()) {
      const reading = model.historyReadings(item.window).primary;
      const placeholder = item.placeholder === true;
      const isPp = unit(item) === 'pp' && (reading || placeholder);
      const remainingPct = isPp ? (reading ? Math.round(100 - reading.value) : 0) : null;
      const value = isPp
        ? `${remainingPct}% ${t('remaining')}`
        : `${number(reading?.value)} ${item.window.currency || 'credits'}`;
      const duplicateLabel = payload.windows.some(other => other !== item && label(other) === label(item));
      const itemLabel = duplicateLabel && item.window.currency ? `${label(item)} · ${item.window.currency}` : label(item);
      const description = `${label(item)} · ${value}`;
      const selectWindow = () => {
        if (selected === item.key) return;
        selected = item.key; hoveredBucket = '';
        renderContent(true);
      };

      const option = document.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.dataset.historyWindow = item.key;
      option.textContent = itemLabel;
      option.setAttribute('aria-label', description);
      option.setAttribute('aria-pressed', String(item === entry));
      option.addEventListener('mousedown', event => event.preventDefault());
      option.addEventListener('click', selectWindow);
      if (item === entry) $('quota').textContent = description;
      selector.append(option);

      // Magpie-style top meter card with progress bar, reset countdown, and pace indicator
      const card = document.createElement('button');
      card.type = 'button';
      card.tabIndex = -1;
      card.className = 'quota-history-meter-card';
      card.dataset.historyMeter = item.key;
      card.setAttribute('aria-pressed', String(item === entry));
      card.addEventListener('mousedown', event => event.preventDefault());
      card.addEventListener('click', selectWindow);
      const topRow = document.createElement('div');
      topRow.className = 'quota-history-meter-top';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'quota-history-meter-label';
      nameSpan.textContent = itemLabel;
      const valSpan = document.createElement('span');
      valSpan.className = 'quota-history-meter-value';
      valSpan.textContent = value;
      topRow.append(nameSpan, valSpan);
      card.append(topRow);
      if (isPp) {
        const track = document.createElement('div');
        track.className = 'quota-history-meter-track';
        const fill = document.createElement('div');
        fill.className = 'quota-history-meter-fill';
        const seriesIdx = series.indexOf(item);
        const barColor = seriesIdx >= 0 ? seriesColor(seriesIdx, series.length) : seriesColor(idx, payload.windows.length);
        fill.style.width = `${Math.max(0, Math.min(100, remainingPct))}%`;
        fill.style.background = barColor;
        track.append(fill);
        card.append(track);
      }
      const metaParts = [];
      if (item.window.resetsAt) {
        const resetTime = date(item.window.resetsAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const rel = formatRelativeReset(item.window.resetsAt);
        metaParts.push([t('resetAt', { time: resetTime }), rel].filter(Boolean).join(' · '));
      }
      const pace = model.windowPace(item.window, now, payload.provider);
      if (metaParts.length > 0 || pace) {
        const meta = document.createElement('div');
        meta.className = 'quota-history-meter-meta';
        if (metaParts.length > 0) {
          const resetNode = document.createElement('span');
          resetNode.textContent = metaParts.join(' · ') + (pace ? ' · ' : '');
          meta.append(resetNode);
        }
        if (pace) {
          const paceNode = document.createElement('span');
          const sign = pace.delta > 0 ? '+' : '';
          paceNode.className = `quota-history-pace ${pace.delta > 2 ? 'is-ahead' : pace.delta < -2 ? 'is-behind' : ''}`.trim();
          paceNode.textContent = t('pace', { delta: `${sign}${pace.delta}%` });
          meta.append(paceNode);
        }
        card.append(meta);
      }
      meters.append(card);
    }
    $('quota').hidden = meters.children.length > 0;
    if (!entry) return;
    const hasAnyCycle = series.some(item => model.trendBounds(item.window, now, payload.provider).cycle);
    const bounds = unit(entry) !== 'pp'
      ? model.trendBounds(entry.window, now, payload.provider)
      : model.combinedTrendBounds(series, now, payload.provider, { rangeMode: trendRangeMode, primaryEntry: entry });
    const spent = unit(entry) !== 'pp' && entry.balance === false;
    const normalized = trendScaleMode === 'normalized' && unit(entry) === 'pp';
    $('trend-heading').textContent = normalized
      ? t('trendNormalized')
      : bounds.cycle ? t(spent ? 'trendSpent' : 'trend') : t(spent ? 'trendSpentRecent' : 'trendRecent', { count: 14 });
    const view = currentTrendView();
    const viewBtn = $('trend-view-btn');
    viewBtn.hidden = unit(entry) !== 'pp' || !hasAnyCycle;
    viewBtn.textContent = `${t(view === 'normalized' ? 'viewNormalized' : view === 'unifiedRecent' ? 'viewUnifiedRecent' : 'viewUnifiedCycle', { count: 14 })} ▾`;
    viewBtn.setAttribute('aria-label', t('viewMenu'));
    viewBtn.setAttribute('aria-expanded', 'false');
    const viewMenu = $('trend-view-menu');
    viewMenu.hidden = true;
    for (const option of viewMenu.querySelectorAll('[data-trend-view]')) {
      const optionView = option.dataset.trendView;
      option.textContent = t(optionView === 'normalized' ? 'viewNormalized' : optionView === 'unifiedRecent' ? 'viewUnifiedRecent' : 'viewUnifiedCycle', { count: 14 });
      option.setAttribute('aria-checked', String(optionView === view));
    }
    const money = window.TokenMonitorLimitBalanceDisplay;
    const rawAmount = entry.window.metric === 'spend' ? entry.window.used : entry.window.remaining;
    const hasBalance = ['credits', 'spend'].includes(entry.window.metric) && unit(entry) === 'pp' && typeof rawAmount === 'number';
    $('balance').hidden = !hasBalance;
    $('balance').textContent = hasBalance ? [money.formatMoney(rawAmount, entry.window.currency || 'credits'),
      ...(entry.window.limit > 0 ? [money.formatMoney(entry.window.limit, entry.window.currency || 'credits')] : [])].join(' / ') : '';
    $('reset').textContent = entry.window.resetsAt ? t('resetAt', { time: date(entry.window.resetsAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }) : '';
    $('reset').hidden = meters.children.length > 0;
    $('updated').textContent = payload.updatedAt ? date(payload.updatedAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const legend = $('legend');
    legend.replaceChildren();
    legend.hidden = series.length < 2;
    for (const [idx, item] of series.entries()) {
      const reading = model.historyReadings(item.window).primary;
      const pct = reading ? `${Math.round(100 - reading.value)}%` : item.placeholder === true ? '0%' : '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.className = 'quota-history-legend-item';
      btn.setAttribute('aria-pressed', String(item === entry));
      const dot = document.createElement('span');
      dot.className = 'quota-history-legend-dot';
      dot.style.background = seriesColor(idx, series.length);
      const text = document.createElement('span');
      text.textContent = [label(item), pct].filter(Boolean).join(' ');
      btn.append(dot, text);
      btn.addEventListener('mousedown', event => event.preventDefault());
      btn.addEventListener('click', () => {
        if (selected === item.key) return;
        selected = item.key; hoveredBucket = '';
        renderContent(true);
      });
      legend.append(btn);
    }
    $('distribution-heading').textContent = t('distribution');
    $('empty').textContent = t('empty');
    $('notice').textContent = t('notice');
    $('error').hidden = payload.persistent !== false;
    $('error').textContent = t('persistenceError');
    drawDistribution(entry);
    drawTrend();
  }

  function reduceMotion() {
    return window.TokenMonitorMotionPreference.shouldReduceMotion(payload?.appearance?.reduceMotion, reducedMotionMedia.matches);
  }

  function renderContent(animate = false, opening = false) {
    contentAnimation?.cancel();
    contentAnimation = null;
    animateMeasurement = animate && !opening && !reduceMotion();
    // No outgoing snapshot: the latest account is visible before the frame moves.
    render();
    // Reopening unchanged content must also release the native show.
    scheduleSize(opening);
    if (opening || !animate || reduceMotion()) return;
    contentAnimation = $('history-content').animate([{ opacity: .8 }, { opacity: 1 }],
      { duration: 150, easing: 'ease-out' });
    contentAnimation.finished.catch(() => {});
  }

  reducedMotionMedia.addEventListener('change', () => { if (reduceMotion()) renderContent(); });
  const viewBtn = $('trend-view-btn');
  const viewMenu = $('trend-view-menu');
  viewBtn.addEventListener('mousedown', event => event.preventDefault());
  viewBtn.addEventListener('click', () => {
    const open = viewMenu.hidden;
    viewMenu.hidden = !open;
    viewBtn.setAttribute('aria-expanded', String(open));
  });
  for (const option of viewMenu.querySelectorAll('[data-trend-view]')) {
    option.addEventListener('mousedown', event => event.preventDefault());
    option.addEventListener('click', () => {
      setTrendView(option.dataset.trendView);
      viewMenu.hidden = true;
      viewBtn.setAttribute('aria-expanded', 'false');
      renderContent(true);
    });
  }
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest?.('.quota-history-view')) {
      viewMenu.hidden = true;
      viewBtn.setAttribute('aria-expanded', 'false');
    }
  });
  $('bars').addEventListener('pointerleave', () => {
    hoveredBucket = '';
    restoreReading();
    for (const bar of $('bars').children) bar.classList.remove('is-hovered');
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') bridge.close(); });
  document.documentElement.addEventListener('pointerenter', () => bridge.enter());
  document.documentElement.addEventListener('pointerleave', () => bridge.leave());
  bridge.onRender(next => {
    const accountChanged = payload?.key !== next.key || payload?.source !== next.source;
    if (next.opening === true) hoveredBucket = '';
    if (accountChanged) {
      selected = next.windows.find(entry => entry.window.kind === 'weekly')?.key || next.windows[0]?.key || '';
      hoveredBucket = '';
      trendRangeMode = 'cycle';
      trendScaleMode = 'unified';
    }
    payload = next;
    const frameStyle = getComputedStyle($('history'));
    const inset = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, key) => sum + parseFloat(frameStyle[key]), 0);
    $('history-content').style.width = `${Math.max(1, next.layoutWidth - inset)}px`;
    for (const { name, value } of window.TokenMonitorThemePresets.themeCssVarEntries({ ...next.colors, ...(next.color ? { accent: next.color } : {}) })) {
      if (value === null) document.documentElement.style.removeProperty(name);
      else document.documentElement.style.setProperty(name, value);
    }
    document.documentElement.style.setProperty('--ui-text-scale', String(next.textScale || 1));
    if (next.interfaceFont) document.documentElement.style.setProperty('--ui-font', next.interfaceFont);
    material = glass.normalizeNativeMaterialState(next.nativeMaterial);
    appearance();
    renderContent(accountChanged || next.opening === true, next.opening === true);
  });
  bridge.onNativeMaterial(next => { material = glass.normalizeNativeMaterialState(next); appearance(); });
  new ResizeObserver(drawTrend).observe($('trend'));
  const cardLayout = window.TokenMonitorCardLayout.createCardLayout({
    measure() {
      const style = getComputedStyle($('history'));
      const inset = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + parseFloat(style[key]), 0);
      return Math.ceil($('history-content').getBoundingClientRect().height + inset);
    },
    report(height, content) {
      bridge.resize(height, content.renderToken, content.animate, content.reduce);
      animateMeasurement = false;
    }
  });
  function scheduleSize(opening = false) {
    if (!payload) return;
    cardLayout.prepare({ renderToken: payload.renderToken, animate: animateMeasurement, reduce: reduceMotion() }, { opening, afterPaint: true });
  }
  window.addEventListener('pagehide', () => { cardFrames.cancel(); cardLayout.cancel(); }, { once: true });
  new ResizeObserver(() => scheduleSize()).observe($('history-content'));
})();
