'use strict';

(() => {
  const bridge = window.limitsHistory;
  const model = window.TokenMonitorLimitsHistoryModel;
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
  let restoreReading = () => {};
  let contentAnimation = null;
  let measureFrame = null;
  let animateMeasurement = false;
  const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');

  function t(key, args) { return i18n.translate(payload?.locale || 'en', `limits.history.${key}`, args); }
  function number(value) { return new Intl.NumberFormat(payload?.locale || 'en', { maximumFractionDigits: 2 }).format(value); }
  function date(at, options) { return new Date(at).toLocaleString(payload?.locale || 'en', options); }
  function unit(entry) { return entry.unit || entry.points.at(-1)?.unit || model.historyReadings(entry.window).primary?.unit || 'pp'; }
  function amount(value, entry) { return unit(entry) === 'pp' ? `${number(value)}%` : `${number(value)} ${unit(entry)}`; }
  function label(entry) { return window.TokenMonitorLimitWindowLabels.limitWindowLabel(payload.provider, entry.window, entry.window.kind); }
  function current() { return payload?.windows.find(entry => entry.key === selected) || payload?.windows[0]; }
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
    const points = entry.points;
    plot.replaceChildren();
    plot.setAttribute('viewBox', `0 0 ${width} 80`);
    plot.setAttribute('aria-label', `${label(entry)} · ${$('trend-heading').textContent}`);
    const moneyAxis = unit(entry) !== 'pp';
    const { start, end, cycle } = model.trendBounds(entry.window, Date.now(), payload.provider);
    const shown = points.filter(p => p.at >= start && p.at <= end);
    $('empty').hidden = shown.length > 0;
    plot.hidden = false;
    const max = moneyAxis ? Math.max(1, model.historyReadings(entry.window).primary?.value || 0, ...shown.map(p => p.value)) * 1.08 : 100;
    const left = 26, right = width - 5, top = 10, bottom = 58;
    const X = at => left + (at - start) / (end - start) * (right - left);
    const Y = value => bottom - Math.max(0, value) / max * (bottom - top);
    for (const value of [max, max / 2, 0]) {
      plot.append(svgNode('line', { x1: left, x2: right, y1: Y(value), y2: Y(value), class: 'quota-history-grid' }));
      if (value !== max / 2) plot.append(svgNode('text', { x: 0, y: Y(value) + 4 }, moneyAxis ? number(value) : `${number(value)}%`));
    }
    const showGuide = !moneyAxis && cycle;
    $('guide-caption').hidden = !showGuide;
    $('guide-caption').textContent = t('guide');
    if (showGuide) plot.append(svgNode('line', { x1: X(start), x2: X(end), y1: Y(100), y2: Y(0), class: 'quota-history-guide', 'aria-hidden': 'true' }));
    for (const segment of model.segments(shown)) {
      let d = '';
      segment.forEach((point, index) => {
        const y = Y(moneyAxis ? point.value : 100 - point.value);
        d += `${index === 0 ? 'M' : 'L'}${X(point.at)},${y}`;
      });
      plot.append(svgNode('path', { d, class: 'quota-history-curve' }));
      if (segment.length === 1) {
        const point = segment[0];
        const x = X(point.at), y = Y(moneyAxis ? point.value : 100 - point.value);
        plot.append(svgNode('line', { x1: Math.max(left, x - 1.5), x2: Math.min(right, x + 1.5), y1: y, y2: y, class: 'quota-history-curve' }));
      }
    }
    const format = end - start < 86400_000 ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' };
    plot.append(svgNode('text', { x: left, y: 77 }, date(start, format)));
    plot.append(svgNode('text', { x: right, y: 77, 'text-anchor': 'end' }, date(end, format)));
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
    const entry = current();
    $('provider').textContent = payload.label;
    $('account').textContent = payload.account;
    $('history').setAttribute('aria-label', t('open'));
    const selector = $('windows');
    selector.setAttribute('aria-label', t('windows'));
    selector.replaceChildren();
    selector.hidden = payload.windows.length < 2;
    for (const item of payload.windows) {
      const option = document.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.dataset.historyWindow = item.key;
      const reading = model.historyReadings(item.window).primary;
      const value = unit(item) === 'pp' && reading
        ? `${Math.round(100 - reading.value)}% ${t('remaining')}`
        : `${number(reading?.value)} ${item.window.currency || 'credits'}`;
      const duplicateLabel = payload.windows.some(other => other !== item && label(other) === label(item));
      option.textContent = duplicateLabel && item.window.currency ? `${label(item)} · ${item.window.currency}` : label(item);
      const description = `${label(item)} · ${value}`;
      option.setAttribute('aria-label', description);
      option.setAttribute('aria-pressed', String(item === entry));
      option.addEventListener('mousedown', event => event.preventDefault());
      option.addEventListener('click', () => {
        if (selected === item.key) return;
        selected = item.key; hoveredBucket = '';
        renderContent(true);
      });
      if (item === entry) $('quota').textContent = description;
      selector.append(option);
    }
    if (!entry) return;
    const bounds = model.trendBounds(entry.window, Date.now(), payload.provider);
    const spent = unit(entry) !== 'pp' && entry.balance === false;
    $('trend-heading').textContent = bounds.cycle ? t(spent ? 'trendSpent' : 'trend') : t(spent ? 'trendSpentRecent' : 'trendRecent', { count: 14 });
    const money = window.TokenMonitorLimitBalanceDisplay;
    const rawAmount = entry.window.metric === 'spend' ? entry.window.used : entry.window.remaining;
    const hasBalance = ['credits', 'spend'].includes(entry.window.metric) && unit(entry) === 'pp' && typeof rawAmount === 'number';
    $('balance').hidden = !hasBalance;
    $('balance').textContent = hasBalance ? [money.formatMoney(rawAmount, entry.window.currency || 'credits'),
      ...(entry.window.limit > 0 ? [money.formatMoney(entry.window.limit, entry.window.currency || 'credits')] : [])].join(' / ') : '';
    $('reset').textContent = entry.window.resetsAt ? t('resetAt', { time: date(entry.window.resetsAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }) : '';
    $('updated').textContent = payload.updatedAt ? date(payload.updatedAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    $('distribution-heading').textContent = t('distribution');
    $('empty').textContent = t('empty');
    $('notice').textContent = t('notice');
    $('error').hidden = payload.persistent !== false;
    $('error').textContent = t('persistenceError');
    drawDistribution(entry);
    drawTrend();
    // A reused window may reopen at its default bounds with identical content.
    // ResizeObserver alone cannot report an unchanged content size again.
    scheduleSize();
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
    if (!animate || reduceMotion()) return;
    contentAnimation = $('history-content').animate([{ opacity: opening ? 0 : .8 }, { opacity: 1 }],
      { duration: 150, easing: 'ease-out' });
    contentAnimation.finished.catch(() => {});
  }

  reducedMotionMedia.addEventListener('change', () => { if (reduceMotion()) renderContent(); });
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
  function reportSize() {
    measureFrame = null;
    if (!payload) return;
    const style = getComputedStyle($('history'));
    const inset = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + parseFloat(style[key]), 0);
    const height = Math.ceil($('history-content').getBoundingClientRect().height + inset);
    bridge.resize(height, payload.renderToken, animateMeasurement, reduceMotion());
    animateMeasurement = false;
  }
  function scheduleSize() {
    if (measureFrame !== null) return;
    // Let the new content paint before moving the native frame onto its anchor.
    measureFrame = requestAnimationFrame(() => { measureFrame = requestAnimationFrame(reportSize); });
  }
  new ResizeObserver(scheduleSize).observe($('history-content'));
})();
