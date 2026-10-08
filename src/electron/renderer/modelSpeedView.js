'use strict';
(function expose(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./usageCharts') : root?.TokenMonitorUsageCharts,
    node ? require('../../shared/modelSpeedRange') : root?.TokenMonitorModelSpeedRange);
  if (node) module.exports = api;
  if (root) root.TokenMonitorModelSpeedView = api;
})(typeof window !== 'undefined' ? window : null, function createView(charts, ranges) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const REFRESH_MS = 30000;
  // The detail has no range control of its own. DAY / MONTH / TOTAL at the top
  // of the window is the only range selector, so every speed surface reports
  // the same period back and the numbers can never describe two windows at once.
  const DEFAULT_RANGE_LABEL = 'home.modelSpeed.range.today';
  const DEFAULT_ROW_LIMIT = 5;
  function number(value) { return Number.isFinite(value) && value >= 0 ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'; }
  function change(value) { return Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(0)}%` : '—'; }
  let gradientId = 0;
  function plotSegments(points, width, height) {
    const valid = (Array.isArray(points) ? points : [])
      .filter(p => Number.isFinite(p?.at) && Number.isFinite(p?.tps) && p.tps >= 0)
      .sort((a, b) => a.at - b.at);
    if (valid.length < 2) return [];
    const start = valid[0].at, end = valid.at(-1).at;
    const maximum = Math.max(1, ...valid.map(p => p.tps)) * 1.1;
    const spanOf = p => Number.isFinite(p.span) && p.span > 0 ? p.span : 3600000;
    const segments = [];
    for (let i = 0; i < valid.length; i += 1) {
      const p = valid[i];
      const gap = i > 0 && p.at - valid[i - 1].at > 3 * Math.max(spanOf(p), spanOf(valid[i - 1]));
      if (i === 0 || gap) segments.push([]);
      segments.at(-1).push({
        x: 2 + (p.at - start) / Math.max(1, end - start) * (width - 4),
        y: height - 2 - p.tps / maximum * (height - 4),
        point: p
      });
    }
    return segments;
  }
  function plot(points, width = 96, height = 28) {
    return plotSegments(points, width, height)
      .map(segment => charts.smoothLinePath(segment, { bounded: true })).join(' ');
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag); if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text; return node;
  }
  function svgEl(tag) { return document.createElementNS(SVG_NS, tag); }
  // Each real gap starts another subpath. A lone sample has no invented line or
  // filled interval; the area of each measured run closes at its own endpoints.
  function graph(points, width, height, strokeWidth) {
    const segments = plotSegments(points, width, height);
    if (!segments.some(segment => segment.length > 1)) return null;
    const paths = segments.map(segment => charts.smoothLinePath(segment, { bounded: true }));
    const svg = svgEl('svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const defs = svgEl('defs');
    const gradient = svgEl('linearGradient');
    const id = `model-speed-gradient-${++gradientId}`;
    gradient.setAttribute('id', id);
    gradient.setAttribute('x1', '0'); gradient.setAttribute('y1', '0');
    gradient.setAttribute('x2', '0'); gradient.setAttribute('y2', '1');
    for (const [offset, cls] of [['0', 'model-speed-area-top'], ['1', 'model-speed-area-bottom']]) {
      const stop = svgEl('stop');
      stop.setAttribute('offset', offset); stop.setAttribute('class', cls);
      gradient.append(stop);
    }
    defs.append(gradient);
    const area = svgEl('path');
    area.setAttribute('class', 'model-speed-area');
    area.setAttribute('fill', `url(#${id})`);
    area.setAttribute('d', segments.flatMap((segment, i) => segment.length > 1
      ? [`${paths[i]} L${segment.at(-1).x.toFixed(2)},${height - 2} L${segment[0].x.toFixed(2)},${height - 2} Z`] : []).join(' '));
    const path = svgEl('path');
    path.setAttribute('class', 'model-speed-line');
    path.setAttribute('d', paths.join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', String(strokeWidth));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(defs, area, path);
    return svg;
  }
  function displayNameFor(raw, displayModel) {
    if (typeof displayModel === 'function') {
      try { const name = displayModel(raw); if (typeof name === 'string' && name.length) return name; } catch (_) { /* fall back to the raw id */ }
    }
    return raw;
  }
  // createMark() supplies the shared .row-icon mark; without it this is the plain
  // .home-list-mark dot the other Home list rows already use.
  function markFor(raw, createMark) {
    let mark = null;
    if (typeof createMark === 'function') { try { mark = createMark(raw); } catch (_) { mark = null; } }
    if (!mark || typeof mark.nodeType !== 'number') mark = el('span', 'home-list-mark');
    if (typeof mark.setAttribute === 'function') mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
  function figure(value, label) {
    const box = el('span', 'model-speed-figure');
    box.append(el('span', 'model-speed-figure-value', number(value)), el('span', 'model-speed-figure-label', label));
    return box;
  }
  // Three ticks share the Home trend's start / middle / end alignment. Short
  // histories use clock labels; their full local date remains available on hover.
  function dateRange(trend, locale) {
    const times = (Array.isArray(trend) ? trend : []).map(point => point?.at)
      .filter(Number.isFinite).sort((a, b) => a - b);
    if (!times.length) return null;
    const first = times[0], last = times.at(-1);
    const anchors = first === last ? [first] : [first, first + (last - first) / 2, last];
    const clock = last - first < 86400000;
    const row = el('div', 'model-speed-dates');
    for (const at of anchors) {
      const date = new Date(at);
      const label = clock
        ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
        : date.toLocaleDateString(locale, { month: '2-digit', day: '2-digit' });
      const node = el('span', '', label);
      node.title = date.toLocaleString(locale);
      row.append(node);
    }
    return row;
  }
  function attachChartHover(svg, trend, { t, locale }) {
    const segments = plotSegments(trend, 300, 110);
    const points = segments.flat();
    if (!points.length) return () => {};
    const tooltip = el('div', 'model-speed-chart-tooltip');
    tooltip.hidden = true;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.id = `model-speed-tooltip-${gradientId}`;
    const date = el('div', 'model-speed-chart-tooltip-date');
    const values = el('div', 'model-speed-chart-tooltip-values');
    const tps = el('span', 'model-speed-chart-tooltip-rate');
    const tpm = el('span', 'model-speed-chart-tooltip-rate');
    const samples = el('div', 'model-speed-chart-tooltip-samples');
    values.append(tps, tpm); tooltip.append(date, values, samples);
    document.body.append(tooltip);
    const guide = svgEl('line');
    guide.setAttribute('class', 'model-speed-chart-guide');
    guide.setAttribute('y1', '2'); guide.setAttribute('y2', '108');
    guide.setAttribute('vector-effect', 'non-scaling-stroke');
    const marker = svgEl('ellipse');
    marker.setAttribute('class', 'model-speed-chart-marker');
    marker.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(guide, marker);
    svg.removeAttribute('aria-hidden');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('home.modelSpeed.chartHint'));
    svg.setAttribute('aria-describedby', tooltip.id);
    svg.setAttribute('focusable', 'true');
    let selected = -1;
    function hide() {
      tooltip.hidden = true;
      svg.classList.remove('is-inspecting');
      selected = -1;
    }
    function show(sample, pointerY) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return hide();
      const point = sample.point;
      selected = points.indexOf(sample);
      const start = new Date(point.at);
      const end = new Date(point.at + (Number.isFinite(point.span) && point.span > 0 ? point.span : 3600000));
      const sameDay = start.toDateString() === end.toDateString();
      const dateOptions = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
      date.textContent = `${start.toLocaleString(locale, dateOptions)} – ${sameDay
        ? end.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
        : end.toLocaleString(locale, dateOptions)}`;
      tps.textContent = `${number(point.tps)} ${t('home.modelSpeed.tps')}`;
      tpm.textContent = `${number(point.tps * 60)} ${t('home.modelSpeed.tpm')}`;
      samples.textContent = `${number(point.samples)} ${t('home.modelSpeed.samples')}`;
      tooltip.dataset.sampleAt = String(point.at);
      tooltip.hidden = false;
      guide.setAttribute('x1', sample.x); guide.setAttribute('x2', sample.x);
      marker.setAttribute('cx', sample.x); marker.setAttribute('cy', sample.y);
      marker.setAttribute('rx', 3 * 300 / rect.width); marker.setAttribute('ry', 3 * 110 / rect.height);
      svg.classList.add('is-inspecting');
      const box = tooltip.getBoundingClientRect();
      const sampleX = rect.left + sample.x / 300 * rect.width;
      const sampleY = Number.isFinite(pointerY) ? pointerY : rect.top + sample.y / 110 * rect.height;
      const margin = 8;
      const left = Math.max(margin, Math.min(window.innerWidth - box.width - margin, sampleX - box.width / 2));
      const above = sampleY - box.height - 12;
      const top = Math.max(margin, Math.min(window.innerHeight - box.height - margin,
        above >= margin ? above : sampleY + 12));
      tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
    }
    function move(event) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return hide();
      const x = (event.clientX - rect.left) / rect.width * 300;
      const tolerance = 6 / rect.width * 300;
      // The same measured runs draw the curve and own its hit regions. Moving
      // across an unmeasured gap cannot project a neighbouring speed into it.
      const segment = segments.find(run => x >= run[0].x - tolerance && x <= run.at(-1).x + tolerance);
      if (!segment) return hide();
      const nearest = segment.reduce((best, sample) => Math.abs(sample.x - x) < Math.abs(best.x - x) ? sample : best);
      show(nearest, event.clientY);
    }
    function key(event) {
      if (event.key === 'Escape') {
        if (!tooltip.hidden) event.preventDefault();
        hide(); return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
        : selected < 0 ? 0 : Math.max(0, Math.min(points.length - 1, selected + (event.key === 'ArrowRight' ? 1 : -1)));
      show(points[next]);
    }
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('keydown', key);
    svg.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      hide(); tooltip.remove();
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerleave', hide);
      svg.removeEventListener('keydown', key);
      svg.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }
  function modelRow(row, { t, onOpen, displayModel, createMark }) {
    const raw = String(row.model ?? '');
    const name = displayNameFor(raw, displayModel);
    const fullName = name === raw ? raw : `${name} · ${raw}`;
    const status = row.status || 'learning';
    const statusText = t(`home.modelSpeed.${status}`);
    const tps = Number.isFinite(row.lastTps) ? row.lastTps : null;
    const tpm = Number.isFinite(row.outputTpm) ? row.outputTpm : null;
    const changeText = Number.isFinite(row.changePercent) ? change(row.changePercent) : '';
    const baselineText = Number.isFinite(row.baselineTps)
      ? `${t('home.modelSpeed.baseline')} ${number(row.baselineTps)} ${t('home.modelSpeed.tps')}`
      : t('home.modelSpeed.baselinePending');
    const button = el('button', 'model-speed-row');
    button.type = 'button';
    button.dataset.speedId = row.id;
    button.title = [fullName, statusText, changeText, baselineText, row.referenceOnly ? t('home.modelSpeed.reference') : '']
      .filter(Boolean).join(' · ');
    button.setAttribute('aria-label', [fullName,
      tps === null ? t('home.modelSpeed.waiting') : `${number(tps)} ${t('home.modelSpeed.tps')}`,
      statusText, changeText].filter(Boolean).join(', '));
    const nameNode = el('span', 'home-list-name', name);
    nameNode.title = fullName;
    const sub = el('span', 'home-list-sub model-speed-row-sub');
    sub.append(el('span', `model-speed-status ${status}`, statusText));
    if (changeText) sub.append(el('span', 'model-speed-sep model-speed-change-sep', '·'), el('span', 'model-speed-change', changeText));
    if (Number.isFinite(row.samples)) {
      sub.append(el('span', 'model-speed-sep model-speed-samples-sep', '·'), el('span', 'model-speed-samples', `${row.samples} ${t('home.modelSpeed.samples')}`));
    }
    const main = el('span', 'model-speed-row-main');
    main.append(nameNode, sub);
    const metrics = el('span', 'model-speed-row-metrics');
    const waiting = tps === null || tpm === null;
    metrics.append(el('span', 'home-list-value model-speed-row-tps', tps === null ? '—' : `${number(tps)} ${t('home.modelSpeed.tps')}`),
      el('span', `home-list-sub ${waiting ? 'model-speed-row-waiting' : 'model-speed-row-tpm'}`,
        waiting ? t('home.modelSpeed.waiting') : `${number(tpm)} ${t('home.modelSpeed.tpm')}`));
    const spark = el('span', 'model-speed-row-spark');
    const svg = graph(row.trend, 44, 16, 1.5);
    if (svg) { if (status === 'slower') svg.classList.add('is-slower'); spark.append(svg); }
    button.append(markFor(raw, createMark), main, metrics, spark);
    if (typeof onOpen === 'function') button.addEventListener('click', () => onOpen(row.id, raw));
    return button;
  }
  function rangeLabelFor(summary, t) {
    const key = summary?.range?.labelKey || DEFAULT_RANGE_LABEL;
    return t(key);
  }
  function renderModule(summary, options = {}) {
    const { t, onOpen, onOpenList, displayModel, createMark } = options;
    // Home is still a preview, but the row budget grows with the window so a
    // taller window can show more models instead of leaving the space unused.
    const limit = Number.isFinite(options.rowLimit)
      ? Math.max(1, Math.floor(options.rowLimit)) : DEFAULT_ROW_LIMIT;
    const models = Array.isArray(summary?.models) ? summary.models.slice(0, limit) : [];
    const section = el('section', 'home-module home-module-modelspeed');
    section.setAttribute('aria-label', t('home.modelSpeed.title'));
    const openable = typeof onOpenList === 'function';
    const head = el(openable ? 'button' : 'div', 'home-module-head model-speed-head');
    if (openable) {
      head.type = 'button';
      head.title = t('home.modelSpeed.allModels');
      head.addEventListener('click', onOpenList);
    }
    const titleWrap = el('span', 'home-module-title-wrap');
    titleWrap.append(el('span', 'home-module-label', t('home.modelSpeed.title')));
    // The module states the window it is showing, so "average speed" on Home
    // is never read as a different range than the detail's.
    titleWrap.append(el('span', 'home-module-subtitle model-speed-range', rangeLabelFor(summary, t)));
    const end = el('span', 'home-module-head-end');
    const jump = el('span', 'home-module-jump view-icon-model');
    jump.setAttribute('aria-hidden', 'true');
    end.append(jump);
    head.append(titleWrap, end);
    const body = el('div', 'home-module-body model-speed-rows');
    if (summary?.state === 'paused') body.append(el('p', 'model-speed-note', t('home.modelSpeed.paused')));
    if (models.length === 0) body.append(el('p', 'model-speed-note', t('home.modelSpeed.empty')));
    for (const row of models) body.append(modelRow(row, { t, onOpen, displayModel, createMark }));
    section.append(head, body);
    return section;
  }
  // A full, keyed list; only Home is capped. The controller owns one poll and
  // ignores disposed responses. Unchanged rows keep their nodes and hover state.
  function createList(options = {}, initialData = null) {
    let config = options;
    const element = el('section', 'model-speed-list');
    const heading = el('header', 'model-speed-list-head');
    const title = el('h2', 'model-speed-detail-name');
    const count = el('span', 'home-module-meta');
    heading.append(title, count);
    // The list states the same window as Home and the detail, so "all model
    // speeds" is never read against a range the top tabs do not show.
    const rangeNote = el('p', 'model-speed-caption model-speed-range');
    rangeNote.textContent = rangeLabelFor(null, options.t);
    const notice = el('div', 'model-speed-list-notice');
    notice.setAttribute('role', 'status');
    const body = el('div', 'model-speed-list-rows');
    const retry = el('button', 'model-speed-all-link');
    retry.type = 'button'; retry.hidden = true;
    retry.addEventListener('click', () => { void refresh(); });
    element.append(heading, rangeNote, notice, body, retry);
    const rows = new Map();
    let snapshot = null, generation = 0, disposed = false, inflight = null;
    let timer = null;
    function render(data) {
      const models = Array.isArray(data?.models) ? data.models : [];
      const { t } = config;
      const scroller = element.parentElement;
      const focus = body.contains(document.activeElement) ? document.activeElement : null;
      const viewport = scroller?.getBoundingClientRect();
      const anchor = viewport && [...body.children].find(node => node.getBoundingClientRect().bottom > viewport.top);
      const anchorTop = anchor?.getBoundingClientRect().top;
      const scrollTop = scroller?.scrollTop || 0;
      title.textContent = t('home.modelSpeed.allModels');
      count.textContent = t('home.modelSpeed.modelCount', { count: models.length });
      const keep = new Set();
      for (const [index, row] of models.entries()) {
        if (!row || typeof row.id !== 'string' || keep.has(row.id)) continue;
        keep.add(row.id);
        const label = displayNameFor(String(row.model ?? ''), config.displayModel);
        const signature = JSON.stringify([row, label, config.presentationKey]);
        let item = rows.get(row.id);
        if (!item) {
          const node = modelRow(row, { ...config, onOpen: (id, model) => config.onOpen?.(id, model) });
          item = { node, signature }; rows.set(row.id, item);
        } else if (signature !== item.signature) {
          const next = modelRow(row, { ...config, onOpen: null });
          item.node.replaceChildren(...next.childNodes);
          item.node.title = next.title;
          item.node.setAttribute('aria-label', next.getAttribute('aria-label'));
          item.signature = signature;
        }
        if (body.children[index] !== item.node) body.insertBefore(item.node, body.children[index] || null);
      }
      for (const [id, item] of rows) {
        if (!keep.has(id)) { item.node.remove(); rows.delete(id); }
      }
      notice.textContent = data?.state === 'paused' ? t('home.modelSpeed.paused')
        : models.length ? '' : t('home.modelSpeed.empty');
      notice.hidden = !notice.textContent;
      rangeNote.textContent = rangeLabelFor(data, t);
      retry.hidden = true;
      if (scroller && scrollTop > 0) {
        scroller.scrollTop = scrollTop + (anchor?.isConnected ? anchor.getBoundingClientRect().top - anchorTop : 0);
      }
      if (focus?.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true });
    }
    function refresh() {
      if (disposed) return Promise.resolve();
      if (inflight) return inflight;
      const version = ++generation;
      body.setAttribute('aria-busy', 'true');
      if (!snapshot) { notice.hidden = false; notice.textContent = config.t('home.modelSpeed.loading'); }
      const request = (async () => {
        try {
          const data = await config.get({ period: typeof config.rangeFor === 'function' ? config.rangeFor() : null });
          if (disposed || version !== generation) return;
          if (!data || !Array.isArray(data.models)) throw new Error('MODEL_SPEED_LIST_UNAVAILABLE');
          snapshot = data; render(data);
        } catch (_) {
          if (disposed || version !== generation) return;
          notice.hidden = false;
          notice.textContent = config.t('home.modelSpeed.error');
          retry.textContent = config.t('home.modelSpeed.retry'); retry.hidden = false;
        } finally {
          if (!disposed && version === generation) body.removeAttribute('aria-busy');
        }
      })();
      inflight = request;
      void request.finally(() => { if (inflight === request) inflight = null; });
      return request;
    }
    function updateOptions(next) {
      const changed = config.presentationKey !== next.presentationKey;
      const rangeChanged = typeof config.rangeFor === 'function' && typeof next.rangeFor === 'function'
        && config.rangeFor() !== next.rangeFor();
      config = { ...config, ...next };
      if (changed && snapshot) render(snapshot);
      // A period change replaces every number in the list, so pull the new
      // window rather than leaving the previous range's rows on screen.
      if (rangeChanged) void refresh();
    }
    function dispose() {
      disposed = true; generation += 1;
      if (timer !== null) clearInterval(timer);
      timer = null;
    }
    if (initialData && Array.isArray(initialData.models)) { snapshot = initialData; render(initialData); }
    else { title.textContent = config.t('home.modelSpeed.allModels'); }
    timer = setInterval(() => { void refresh(); }, REFRESH_MS);
    void refresh();
    return { element, refresh, updateOptions, dispose, snapshot: () => snapshot };
  }
  // The detail is a plain section the caller mounts (no dialog, no backdrop, no
  // own back/close button). Content lives in `body`; the header and method notes
  // are static, so refreshes keep focus and the open/closed details state. The
  // range comes from the caller's top-level period, never from a control here.
  function sourceSection(data, t) {
    const section = el('section', 'model-speed-sources');
    section.append(el('h3', 'model-speed-sources-title', t('home.modelSpeed.sources')));
    const sources = Array.isArray(data.sources) ? data.sources : [];
    if (!sources.length) {
      section.append(el('p', 'model-speed-caption', t('home.modelSpeed.sourcesEmpty')));
      return section;
    }
    const list = el('ul', 'model-speed-source-list');
    for (const source of sources) {
      const row = el('li', 'model-speed-source');
      const identity = el('div', 'model-speed-source-identity');
      const platform = source.platform || t('home.modelSpeed.platformUnknown');
      const account = source.accountLabel
        ? `${source.accountLabel}${source.accountTag ? ` · #${source.accountTag}` : ''}`
        : source.accountTag ? `#${source.accountTag}` : t('home.modelSpeed.accountUnknown');
      const access = ['subscription', 'api'].includes(source.accessType) ? source.accessType : 'accessUnknown';
      const title = el('div', 'model-speed-source-title');
      title.append(el('span', 'model-speed-source-platform', platform),
        el('span', `model-speed-source-access ${access}`, t(`home.modelSpeed.${access}`)));
      identity.append(title, el('span', 'model-speed-source-account', t('home.modelSpeed.sourceAccount', { account })),
        el('span', 'model-speed-source-client', source.client || t('home.modelSpeed.clientUnknown')));
      const metric = el('div', 'model-speed-source-metric');
      metric.append(el('span', 'model-speed-source-rate', Number.isFinite(source.weightedTps)
        ? `${number(source.weightedTps)} ${t('home.modelSpeed.tps')}` : '—'));
      metric.append(el('span', 'model-speed-source-samples', source.referenceOnly
        ? t('home.modelSpeed.sourceReference')
        : Number.isFinite(source.samples) ? `${source.samples} ${t('home.modelSpeed.samples')}` : t('home.modelSpeed.sourceLegacy')));
      row.append(identity, metric); list.append(row);
    }
    section.append(list, el('p', 'model-speed-caption', t('home.modelSpeed.sourcesScope')));
    return section;
  }
  function createDetail(id, rawModel, options = {}) {
    const { t, get, displayModel, createMark, locale, animateChart, prefersReducedMotion, rangeFor } = options;
    const raw = String(rawModel ?? '');
    const name = displayNameFor(raw, displayModel);
    const element = el('section', 'model-speed-detail');
    const head = el('header', 'model-speed-detail-head');
    head.append(markFor(raw, createMark));
    const titleWrap = el('span', 'model-speed-detail-title');
    const title = el('h2', 'model-speed-detail-name', name);
    titleWrap.append(title);
    if (name !== raw) {
      title.title = raw;
      const rawLine = el('span', 'model-speed-detail-raw');
      rawLine.title = raw;
      rawLine.append(el('span', 'model-speed-detail-raw-label', `${t('home.modelSpeed.originalId')} `),
        el('span', 'model-speed-detail-raw-value', raw));
      titleWrap.append(rawLine);
    }
    const statusNode = el('span', 'model-speed-status');
    statusNode.hidden = true;
    head.append(titleWrap, statusNode);
    // No range control here: the top-level DAY / MONTH / TOTAL selection owns
    // the window for every speed surface. This line only names the window the
    // numbers below describe, so a stale poll can never look like a new range.
    const rangeNote = el('p', 'model-speed-caption model-speed-range');
    rangeNote.textContent = rangeLabelFor(null, t);
    const body = el('div', 'model-speed-body');
    const method = el('details', 'model-speed-method');
    method.append(el('summary', 'model-speed-method-summary', t('home.modelSpeed.method')));
    for (const key of ['home.modelSpeed.scope', 'home.modelSpeed.rule', 'home.modelSpeed.caution']) {
      method.append(el('p', 'model-speed-note', t(key)));
    }
    element.append(head, rangeNote, body, method);
    let generation = 0;
    let disposed = false;
    let rendered = false;
    let timer = null;
    let errorNote = null;
    let chartAnimation = null;
    let chartHoverCleanup = null;
    function clearChartHover() {
      chartHoverCleanup?.();
      chartHoverCleanup = null;
    }
    let pendingRender = null;
    let renderSignature = null;
    let renderedRangeKey = null;
    let rangeUnavailable = false;
    function stopChart() {
      pendingRender = null;
      const previous = chartAnimation;
      chartAnimation = null;
      previous?.cancel?.();
    }
    function animate(svg) {
      if (typeof animateChart !== 'function' || !svg) return;
      const reduced = typeof prefersReducedMotion === 'function' ? prefersReducedMotion() : prefersReducedMotion === true;
      if (reduced) return;
      try {
        const animation = animateChart(svg);
        if (!animation?.finished) return;
        chartAnimation = animation;
        const settled = () => {
          if (chartAnimation !== animation || disposed) return;
          chartAnimation = null;
          const pending = pendingRender;
          pendingRender = null;
          if (pending && pending.generation === generation) renderDetail(pending.data, false);
        };
        animation.finished.then(settled, settled);
      } catch (_) { /* animation is optional */ }
    }
    function setStatus(status) {
      if (!status) { statusNode.hidden = true; return; }
      statusNode.hidden = false;
      statusNode.className = `model-speed-status ${status}`;
      statusNode.textContent = t(`home.modelSpeed.${status}`);
    }
    function stateNote(kind, period) {
      stopChart(); clearChartHover(); renderSignature = null;
      // With no figures to label, name the requested window even when it fails
      // or is empty. Successful figures still use main's data.range label.
      rangeNote.textContent = t(ranges?.LABEL_KEYS?.[period] || DEFAULT_RANGE_LABEL);
      const text = kind === 'error' ? t('home.modelSpeed.error') : t('home.modelSpeed.empty');
      body.replaceChildren(el('p', `model-speed-note model-speed-state ${kind}`, text));
      rendered = true;
    }
    function renderDetail(data, animateNow) {
      const signature = JSON.stringify(data);
      // An unchanged poll never replaces the SVG or cancels a running reveal.
      if (!animateNow && renderSignature === signature) return;
      if (!animateNow && chartAnimation && (chartAnimation.pending || chartAnimation.playState === 'running')) {
        pendingRender = { data, generation };
        return;
      }
      stopChart();
      renderSignature = signature;
      const nodes = [];
      if (data.state === 'paused') nodes.push(el('p', 'model-speed-note', t('home.modelSpeed.paused')));
      const tps = Number.isFinite(data.weightedTps) ? data.weightedTps : null;
      let chartSvg = null;
      if (tps === null) {
        nodes.push(el('p', 'model-speed-note model-speed-state waiting',
          t(data.status === 'unmeasured' ? 'home.modelSpeed.unmeasuredReason' : 'home.modelSpeed.waiting')));
      } else {
        // Name the window the average covers, so the figure is never read as a
        // different range than the top-level selection shows.
        nodes.push(el('p', 'model-speed-caption',
          t('home.modelSpeed.average', { range: rangeLabelFor(data, t) })));
        const figures = el('div', 'model-speed-figures');
        figures.append(figure(tps, t('home.modelSpeed.tps')), figure(tps * 60, t('home.modelSpeed.tpm')));
        nodes.push(figures);
        chartSvg = graph(data.trend, 300, 110, 2);
        if (chartSvg) {
          chartSvg.classList.add('model-speed-chart');
          if (data.status === 'slower') chartSvg.classList.add('is-slower');
          // The SVG scales to its box, so the detail can hand it every spare
          // pixel; a taller window then shows a taller curve, not more empty space.
          const plot = el('div', 'model-speed-chart-plot');
          plot.append(chartSvg);
          nodes.push(plot);
          const dates = dateRange(data.trend, locale);
          if (dates) nodes.push(dates);
        } else {
          nodes.push(el('p', 'model-speed-note model-speed-state waiting', t('home.modelSpeed.waiting')));
        }
      }
      if (data.status !== 'unmeasured' && Number.isFinite(data.samples)) {
        const stats = el('dl', 'model-speed-stats');
        const stat = (label, value) => {
          stats.append(el('dt', 'model-speed-stat-label', label), el('dd', 'model-speed-stat-value', value));
        };
        stat(t('home.modelSpeed.baseline'), Number.isFinite(data.baselineTps)
          ? `${number(data.baselineTps)} ${t('home.modelSpeed.tps')}${Number.isFinite(data.baselineSamples) ? ` · ${data.baselineSamples} ${t('home.modelSpeed.samples')}` : ''}`
          : t('home.modelSpeed.baselinePending'));
        if (Number.isFinite(data.changePercent)) stat(t('home.modelSpeed.change'), change(data.changePercent));
        stat(t('home.modelSpeed.samples'), String(data.samples));
        if (Number.isFinite(data.recentSamples)) stat(t('home.modelSpeed.recent'), String(data.recentSamples));
        if (Number.isFinite(data.gaps)) stat(t('home.modelSpeed.gaps'), String(data.gaps));
        nodes.push(stats);
      }
      nodes.push(sourceSection(data, t));
      clearChartHover();
      body.replaceChildren(...nodes);
      if (chartSvg) chartHoverCleanup = attachChartHover(chartSvg, data.trend, { t, locale });
      setStatus(data.status);
      rendered = true;
      if (chartSvg && animateNow) animate(chartSvg);
    }
    async function load(animateNow = false) {
      if (disposed) return;
      const version = ++generation;
      // The caller owns the selection; this view only reports which window it
      // last rendered, so a period change re-labels and re-fades the numbers.
      const requestPeriod = typeof rangeFor === 'function' ? rangeFor() : null;
      const requestKey = requestPeriod || 'default';
      if (!rendered || rangeUnavailable) {
        clearChartHover();
        body.replaceChildren(el('p', 'model-speed-note model-speed-state loading', t('home.modelSpeed.loading')));
      } else if (animateNow) {
        // Only a user-requested range change fades. Routine polls stay still.
        clearChartHover();
        body.classList.add('is-refreshing');
      }
      body.setAttribute('aria-busy', 'true');
      let data = null;
      let failed = false;
      try { data = await get({ id, period: requestPeriod }); } catch (_) { failed = true; }
      if (disposed || version !== generation) return;
      body.classList.remove('is-refreshing');
      body.removeAttribute('aria-busy');
      if (failed) {
        // A background refresh keeps the last good view and only flags the failure;
        // a first load has nothing to keep, so it shows the error state itself.
        if (!rendered || animateNow || rangeUnavailable || renderedRangeKey !== requestKey) {
          // Do not label a previous range's numbers as the newly selected range.
          setStatus(null); errorNote = null; rangeUnavailable = true; stateNote('error', requestPeriod);
        } else if (!errorNote) {
          errorNote = el('p', 'model-speed-note model-speed-state error', t('home.modelSpeed.error'));
          body.append(errorNote);
        }
        return;
      }
      if (!data) {
        setStatus(null); errorNote = null; rangeUnavailable = true; stateNote('empty', requestPeriod); return;
      }
      if (errorNote) { errorNote.remove(); errorNote = null; }
      try {
        renderDetail(data, animateNow || renderedRangeKey !== requestKey);
        renderedRangeKey = requestKey;
        rangeNote.textContent = rangeLabelFor(data, t);
        rangeUnavailable = false;
      } catch (_) {
        setStatus(null); rangeUnavailable = true; stateNote('error', requestPeriod);
      }
    }
    function dispose() {
      stopChart(); clearChartHover();
      disposed = true;
      generation += 1;
      if (timer !== null) { clearInterval(timer); timer = null; }
    }
    function refresh() { return disposed ? Promise.resolve() : load(false); }
    // A period change is a user action: fade the curve rather than swapping it
    // in place, and never let the previous window's numbers stand unlabelled.
    function setRange() { return disposed ? Promise.resolve() : load(true); }
    timer = setInterval(() => { void load(false); }, REFRESH_MS);
    void load(true);
    return { element, dispose, refresh, setRange };
  }
  return { number, change, plot, renderModule, createList, createDetail };
});
