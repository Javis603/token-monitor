'use strict';

(function exposeUsageCharts(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorUsageCharts = api;
})(typeof window !== 'undefined' ? window : null, function createUsageChartsApi() {
  function n(value) {
    const x = Number(value);
    return Number.isFinite(x) ? x : 0;
  }

  function sumMetric(map, metric) {
    let total = 0;
    for (const v of Object.values(map || {})) total += n(v && v[metric]);
    return total;
  }

  function addDaysUTC(key, delta) {
    return new Date(Date.parse(`${key}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
  }

  function daysBetweenKeys(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  }

  // 0 = Monday … 6 = Sunday (used by the weekly K-line candles)
  function dayOfWeekMon(key) {
    const sun0 = new Date(Date.parse(`${key}T00:00:00Z`)).getUTCDay();
    return (sun0 + 6) % 7;
  }

  // 0 = Sunday … 6 = Saturday (used by the GitHub-style contribution heatmap)
  function dayOfWeekSun(key) {
    return new Date(Date.parse(`${key}T00:00:00Z`)).getUTCDay();
  }

  function weekStartKey(key) {
    const k = String(key).slice(0, 10);
    return addDaysUTC(k, -dayOfWeekMon(k));
  }

  function dailyBarsChart(series, options) {
    const o = Object.assign(
      { width: 600, height: 180, padTop: 8, padRight: 8, padBottom: 20, padLeft: 40, gap: 0.2, stackBy: 'client', metric: 'tokens', labelKey: 'date' },
      options || {}
    );
    const field = o.stackBy === 'model' ? 'perModel' : 'perClient';
    const entries = Array.isArray(series) ? series : [];

    const keyTotals = {};
    for (const e of entries) {
      for (const [k, v] of Object.entries(e[field] || {})) keyTotals[k] = (keyTotals[k] || 0) + n(v && v[o.metric]);
    }
    const keys = Object.keys(keyTotals).sort((a, b) => keyTotals[b] - keyTotals[a] || a.localeCompare(b));

    const totals = entries.map((e) => sumMetric(e[field], o.metric));
    const maxTotal = Math.max(1, ...totals);
    const innerW = o.width - o.padLeft - o.padRight;
    const innerH = o.height - o.padTop - o.padBottom;
    const slot = entries.length ? innerW / entries.length : innerW;
    const barWidth = slot * (1 - o.gap);

    const bars = entries.map((e, i) => {
      const x = o.padLeft + i * slot + (slot - barWidth) / 2;
      const source = e[field] || {};
      let cum = 0;
      const segments = [];
      for (const k of keys) {
        if (source[k] === undefined) continue;
        const value = n(source[k][o.metric]);
        const height = innerH * value / maxTotal;
        cum += height;
        segments.push({ key: k, value, x, width: barWidth, y: o.padTop + innerH - cum, height });
      }
      return { label: e[o.labelKey], index: i, x, width: barWidth, total: totals[i], segments };
    });

    return { width: o.width, height: o.height, plot: { x: o.padLeft, y: o.padTop, w: innerW, h: innerH }, maxTotal, keys, bars };
  }

  // Candlesticks from a daily-total series. Each candle aggregates `bucketDays`
  // consecutive calendar days into one OHLC bar — open = first day, close = last day,
  // high/low = busiest/quietest day in the bucket — so the high/low can protrude past
  // the body as a real wick (needs ≥3 days in the bucket to show). Buckets are anchored
  // to the most recent day and grouped backwards, so the latest data always lands on a
  // full bucket and gaps in sparse data still fall into the right calendar bucket.
  function candleChart(daily, options) {
    const o = Object.assign(
      { width: 600, height: 180, padTop: 8, padRight: 8, padBottom: 20, padLeft: 40, gap: 0.3, metric: 'tokens', bucketDays: 7 },
      options || {}
    );
    const days = (Array.isArray(daily) ? daily : [])
      .map((d) => ({ date: String(d.date).slice(0, 10), value: n(d[o.metric]) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const bucketDays = Math.max(1, Math.round(o.bucketDays));

    let base = [];
    if (days.length) {
      const lastDate = days[days.length - 1].date;
      const groups = new Map(); // bucket index counted back from the latest day (0 = newest)
      for (const d of days) {
        const idx = Math.floor(daysBetweenKeys(d.date, lastDate) / bucketDays);
        const arr = groups.get(idx) || [];
        arr.push(d);
        groups.set(idx, arr);
      }
      base = [...groups.keys()].sort((a, b) => b - a).map((idx) => {
        const ds = groups.get(idx); // days inherit the global sort, so earliest..latest
        const values = ds.map((d) => d.value);
        return {
          key: ds[0].date,
          endKey: ds[ds.length - 1].date,
          days: ds.length,
          open: ds[0].value,
          close: ds[ds.length - 1].value,
          high: Math.max(...values),
          low: Math.min(...values),
          up: ds[ds.length - 1].value >= ds[0].value
        };
      });
    }

    const maxVal = Math.max(1, ...base.map((c) => c.high));
    const innerW = o.width - o.padLeft - o.padRight;
    const innerH = o.height - o.padTop - o.padBottom;
    const slot = base.length ? innerW / base.length : innerW;
    const bodyW = slot * (1 - o.gap);
    const yOf = (v) => o.padTop + innerH - innerH * v / maxVal;

    const candles = base.map((c, i) => {
      const x = o.padLeft + i * slot + (slot - bodyW) / 2;
      const top = Math.max(c.open, c.close);
      const bottom = Math.min(c.open, c.close);
      const bodyY = yOf(top);
      return {
        key: c.key, endKey: c.endKey, days: c.days,
        open: c.open, high: c.high, low: c.low, close: c.close, up: c.up,
        x, width: bodyW, wickX: x + bodyW / 2,
        yHigh: yOf(c.high), yLow: yOf(c.low),
        bodyY, bodyHeight: Math.max(1, yOf(bottom) - bodyY)
      };
    });

    return { width: o.width, height: o.height, bucketDays, plot: { x: o.padLeft, y: o.padTop, w: innerW, h: innerH }, maxVal, candles };
  }

  function contribHeatmap(daily, options) {
    const o = Object.assign({ cell: 11, gap: 2, startDate: null, endDate: null }, options || {});
    const intensities = new Map();
    const values = new Map();
    // startDate/endDate, when given, fix the window (e.g. a rolling year) so the grid
    // spans the whole range even where there are no records; otherwise it hugs the data.
    let minDate = o.startDate ? String(o.startDate).slice(0, 10) : null;
    let maxDate = o.endDate ? String(o.endDate).slice(0, 10) : null;
    for (const d of (Array.isArray(daily) ? daily : [])) {
      const key = String(d.date).slice(0, 10);
      intensities.set(key, n(d.intensity));
      values.set(key, { tokens: n(d.tokens), cost: n(d.cost) });
      if (!o.startDate && (!minDate || key < minDate)) minDate = key;
      if (!o.endDate && (!maxDate || key > maxDate)) maxDate = key;
    }
    if (!minDate || !maxDate) return { cells: [], width: 0, height: 0, weeks: 0, monthLabels: [] };

    // Sunday-started columns, GitHub/codex style.
    const start = addDaysUTC(minDate, -dayOfWeekSun(minDate));
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const cells = [];
    const monthLabels = [];
    for (let key = start; key <= maxDate; key = addDaysUTC(key, 1)) {
      const days = Math.round((Date.parse(`${key}T00:00:00Z`) - startMs) / 86400000);
      const col = Math.floor(days / 7);
      const row = dayOfWeekSun(key);
      // Label the column that contains the 1st of a month — this puts the first
      // month flush at the left edge (the leading week always spans a month's 1st).
      if (key.slice(8, 10) === '01') monthLabels.push({ col, label: key.slice(0, 7) });
      const value = values.get(key) || { tokens: 0, cost: 0 };
      cells.push({ date: key, intensity: intensities.get(key) || 0, tokens: value.tokens, cost: value.cost, col, row, x: col * (o.cell + o.gap), y: row * (o.cell + o.gap), size: o.cell });
    }
    const weeks = cells.length ? cells[cells.length - 1].col + 1 : 0;
    return {
      cells, weeks, monthLabels, cell: o.cell, gap: o.gap,
      width: weeks ? weeks * (o.cell + o.gap) - o.gap : 0,
      height: 7 * (o.cell + o.gap) - o.gap
    };
  }

  function rollingYearHeatmap(daily, options) {
    const o = Object.assign({ endDate: new Date().toISOString().slice(0, 10), cell: 8, gap: 3 }, options || {});
    const endDate = String(o.endDate).slice(0, 10);
    const end = new Date(`${endDate}T00:00:00Z`);
    const startDate = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
    return contribHeatmap(daily, { cell: o.cell, gap: o.gap, startDate, endDate });
  }

  const STAT_CARDS = [
    { key: 'totalTokens', kind: 'tokens' },
    { key: 'totalCost', kind: 'cost' },
    { key: 'activeDays', kind: 'days' },
    { key: 'currentStreak', kind: 'days' },
    { key: 'activeTimeMs', kind: 'duration' },
    { key: 'peakDayTokens', kind: 'tokens' },
    { key: 'favoriteModel', kind: 'model' },
    { key: 'messages', kind: 'count' }
  ];

  function statsCards(summary) {
    const s = summary && typeof summary === 'object' ? summary : {};
    return STAT_CARDS.map((c) => ({
      key: c.key,
      kind: c.kind,
      value: c.kind === 'model' ? String(s[c.key] || '') : n(s[c.key])
    }));
  }

  function sparklinePreview(points, options) {
    const o = Object.assign({ width: 120, height: 28, gap: 0.25, metric: 'tokens' }, options || {});
    const arr = Array.isArray(points) ? points : [];
    const valueOf = (p) => n(p && p[o.metric]);
    const maxVal = Math.max(1, ...arr.map(valueOf));
    const slot = arr.length ? o.width / arr.length : o.width;
    const barWidth = slot * (1 - o.gap);
    const bars = arr.map((p, i) => {
      const value = valueOf(p);
      const height = o.height * value / maxVal;
      return { value, x: i * slot + (slot - barWidth) / 2, width: barWidth, y: o.height - height, height, last: i === arr.length - 1 };
    });
    return { width: o.width, height: o.height, maxVal, bars };
  }

  function areaLineChart(daily, options) {
    const o = Object.assign(
      { width: 300, height: 120, padTop: 6, padRight: 6, padBottom: 8, padLeft: 6, metric: 'tokens', labelKey: 'date', curve: false },
      options || {}
    );
    const arr = (Array.isArray(daily) ? daily : []).map((d) => ({
      label: d && d[o.labelKey],
      value: n(d && d[o.metric])
    }));
    const maxVal = Math.max(1, ...arr.map((p) => p.value));
    const innerW = Math.max(0, o.width - o.padLeft - o.padRight);
    const innerH = Math.max(0, o.height - o.padTop - o.padBottom);
    const xOf = (i) => o.padLeft + (arr.length <= 1 ? innerW / 2 : innerW * i / (arr.length - 1));
    const yOf = (value) => o.padTop + innerH - innerH * value / maxVal;
    const points = arr.map((p, i) => ({
      label: p.label,
      value: p.value,
      x: xOf(i),
      y: yOf(p.value)
    }));
    const baseline = o.padTop + innerH;
    const linePath = o.curve ? smoothLinePath(points) : straightLinePath(points);
    const areaPath = points.length
      ? `${linePath} L${svgRound(points[points.length - 1].x)},${svgRound(baseline)} L${svgRound(points[0].x)},${svgRound(baseline)} Z`
      : '';
    return {
      width: o.width,
      height: o.height,
      plot: { x: o.padLeft, y: o.padTop, w: innerW, h: innerH },
      maxVal,
      points,
      linePath,
      areaPath
    };
  }

  function straightLinePath(points) {
    return points.length
      ? points.map((p, i) => `${i === 0 ? 'M' : 'L'}${svgRound(p.x)},${svgRound(p.y)}`).join(' ')
      : '';
  }

  function smoothLinePath(points) {
    if (!points.length) return '';
    if (points.length < 3) return straightLinePath(points);
    let path = `M${svgRound(points[0].x)},${svgRound(points[0].y)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      path += ` C${svgRound(c1x)},${svgRound(c1y)} ${svgRound(c2x)},${svgRound(c2y)} ${svgRound(p2.x)},${svgRound(p2.y)}`;
    }
    return path;
  }

  function selectPreviewSeries(preview, period) {
    const p = preview && typeof preview === 'object' ? preview : {};
    const daily = Array.isArray(p.daily) ? p.daily : [];
    const monthly = Array.isArray(p.monthly) ? p.monthly : [];
    if (period === 'allTime') return { points: monthly, metric: 'tokens', labelKey: 'month' };
    if (period === 'month') {
      const latest = daily.length ? String(daily[daily.length - 1].date).slice(0, 7) : '';
      return { points: daily.filter((d) => String(d.date).slice(0, 7) === latest), metric: 'tokens', labelKey: 'date' };
    }
    return { points: daily.slice(-7), metric: 'tokens', labelKey: 'date' }; // 'today' -> last 7 days
  }

  function patchTodayBar(points, todayTotal) {
    if (!Array.isArray(points) || points.length === 0) return Array.isArray(points) ? points : [];
    const copy = points.slice();
    copy[copy.length - 1] = Object.assign({}, copy[copy.length - 1], { tokens: n(todayTotal) });
    return copy;
  }

  const clientColors = {
    claude: '#cc7c5e', codex: '#49a3b0', hermes: '#d4af37', gemini: '#4285f4',
    antigravity: '#4285f4', cline: '#323B43', kimi: '#16191e', grok: '#000000', copilot: '#000000', deepseek: '#4d6bfe', cursor: '#000000', opencode: '#000000',
    openclaw: '#ff4d4d', xai: '#000000', meta: '#1d65c1', mistral: '#fa520f', qwen: '#615ced',
    pi: '#000', zed: '#4173e7', kilocode: '#F8F676', micode: '#000000', zcode: '#000000', kiro: '#9046FF', codebuddy: '#6C4DFF', workbuddy: '#0DC8A5',
    moonshot: '#16191e', zai: '#000000', zaiteam: '#000000', cohere: '#39594d', xiaomi: '#ff6700', minimax: '#f23f5d', doubao: '#1E37FC', volcengine: '#006EFF', qoder: '#2ADB5C',
    default: '#6ab4f0'
  };
  const fallbackModelColors = ['#6ab4f0', '#cc7c5e', '#a57df0', '#49a3b0', '#f0d66a', '#f06a7b'];

  function modelVendorFor(model) {
    const name = String(model || '').toLowerCase();
    if (/^(cursor-)?auto$/.test(name)) return 'cursor';
    if (/claude|anthropic|sonnet|opus|haiku/.test(name)) return 'claude';
    if (/gpt|openai|codex|^o[134](?:-|$)|o[134]-(mini|pro|preview)|chatgpt/.test(name)) return 'codex';
    if (/gemini|gemma|google/.test(name)) return 'gemini';
    if (/grok|xai/.test(name)) return 'xai';
    if (/deepseek/.test(name)) return 'deepseek';
    if (/llama|meta/.test(name)) return 'meta';
    if (/mistral|mixtral|codestral/.test(name)) return 'mistral';
    if (/qwen|qwq|qvq/.test(name)) return 'qwen';
    if (/kimi|moonshot/.test(name)) return 'moonshot';
    if (/chatglm|\bglm-|\bzai\b|z\.ai|zhipu/.test(name)) return 'zai';
    if (/cohere|command-r/.test(name)) return 'cohere';
    if (/mimo|xiaomi/.test(name)) return 'xiaomi';
    if (/minimax|\babab/.test(name)) return 'minimax';
    if (/doubao|\bseed(?:-|$)/.test(name)) return 'doubao';
    if (/^big-pickle$/.test(name)) return 'opencode'; // OpenCode Zen stealth model — no vendor hint in the name
    return null;
  }

  function modelColor(model) {
    const vendor = modelVendorFor(model);
    if (vendor && clientColors[vendor]) return clientColors[vendor];
    const name = String(model || '').toLowerCase();
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return fallbackModelColors[Math.abs(hash) % fallbackModelColors.length];
  }

  function clampDaily(daily, range) {
    const arr = Array.isArray(daily) ? daily : [];
    const num = Number(range);
    return Number.isFinite(num) && num > 0 ? arr.slice(-num) : arr;
  }

  function svgRound(v) {
    return Math.round(v * 100) / 100;
  }

  function escapeXml(value) {
    return String(value).replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
  }

  function sparklineSvg(model, options) {
    const o = Object.assign({ radius: 1, titles: null }, options || {});
    const titles = Array.isArray(o.titles) ? o.titles : null;
    const rects = (model.bars || []).map((b, i) => {
      const tip = titles && titles[i] ? `<title>${escapeXml(titles[i])}</title>` : '';
      return `<rect x="${svgRound(b.x)}" y="${svgRound(b.y)}" width="${svgRound(b.width)}" height="${svgRound(Math.max(0, b.height))}" rx="${o.radius}" class="spark-bar${b.last ? ' spark-bar--last' : ''}">${tip}</rect>`;
    }).join('');
    return `<svg class="sparkline" viewBox="0 0 ${model.width} ${model.height}" preserveAspectRatio="none" width="100%" height="${model.height}" aria-hidden="true">${rects}</svg>`;
  }

  function areaLineSvg(model) {
    // Top-to-bottom blue fade (stop colours live in styles.css so they track the
    // theme). objectBoundingBox keeps the fade vertical regardless of the path bbox.
    const defs = model.areaPath
      ? '<defs><linearGradient id="area-line-grad" x1="0" y1="0" x2="0" y2="1">'
        + '<stop class="area-line-grad-top" offset="0"></stop>'
        + '<stop class="area-line-grad-bottom" offset="1"></stop>'
        + '</linearGradient></defs>'
      : '';
    const fill = model.areaPath ? `<path class="area-line-fill" d="${model.areaPath}"></path>` : '';
    const line = model.linePath ? `<path class="area-line-stroke" d="${model.linePath}"></path>` : '';
    return `<svg class="area-line" viewBox="0 0 ${model.width} ${model.height}" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true">${defs}${fill}${line}</svg>`;
  }

  function axisText(label, x, y) {
    return label ? `<text class="axis-label" x="${svgRound(x)}" y="${svgRound(y)}" text-anchor="middle">${escapeXml(label)}</text>` : '';
  }

  function yAxisSvg(p, maxVal, ticks, formatTick) {
    if (!(ticks > 0)) return '';
    let out = '';
    for (let i = 0; i <= ticks; i++) {
      const value = maxVal * i / ticks;
      const y = p.y + p.h - p.h * i / ticks;
      out += `<line class="grid-line" x1="${svgRound(p.x)}" y1="${svgRound(y)}" x2="${svgRound(p.x + p.w)}" y2="${svgRound(y)}"></line>`;
      out += `<text class="axis-label y-axis" x="${svgRound(p.x - 8)}" y="${svgRound(y + 3)}" text-anchor="end">${escapeXml(formatTick(value))}</text>`;
    }
    return out;
  }

  // Rect with only the top two corners rounded (codex-style bar caps).
  function topRoundedPath(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h));
    return `M${svgRound(x)},${svgRound(y + h)} L${svgRound(x)},${svgRound(y + rr)} Q${svgRound(x)},${svgRound(y)} ${svgRound(x + rr)},${svgRound(y)} `
      + `L${svgRound(x + w - rr)},${svgRound(y)} Q${svgRound(x + w)},${svgRound(y)} ${svgRound(x + w)},${svgRound(y + rr)} L${svgRound(x + w)},${svgRound(y + h)} Z`;
  }

  function barsChartSvg(model, options) {
    const o = Object.assign({ colorFor: () => '#6ab4f0', titleOf: () => '', axisLabel: () => '', yTicks: 0, formatTick: (v) => String(v), radius: 3 }, options || {});
    const p = model.plot;
    const grid = yAxisSvg(p, model.maxTotal, o.yTicks, o.formatTick);
    const parts = (model.bars || []).map((bar) => {
      const segs = bar.segments || [];
      const top = segs.length - 1;
      const drawn = segs.map((s, i) => {
        const h = Math.max(0, s.height);
        if (i === top && h > 0) {
          return `<path d="${topRoundedPath(s.x, s.y, s.width, h, o.radius)}" fill="${o.colorFor(s.key)}" class="bar-seg"></path>`;
        }
        return `<rect x="${svgRound(s.x)}" y="${svgRound(s.y)}" width="${svgRound(s.width)}" height="${svgRound(h)}" fill="${o.colorFor(s.key)}" class="bar-seg"></rect>`;
      }).join('');
      const tip = o.titleOf(bar);
      const title = tip ? `<title>${escapeXml(tip)}</title>` : '';
      const hover = `<rect data-i="${bar.index}" x="${svgRound(bar.x)}" y="${svgRound(p.y)}" width="${svgRound(bar.width)}" height="${svgRound(p.h)}" class="bar-hover">${title}</rect>`;
      const label = axisText(o.axisLabel(bar, bar.index, model.bars), bar.x + bar.width / 2, model.height - 4);
      return drawn + hover + label;
    }).join('');
    const baseline = `<line class="axis-base" x1="${svgRound(p.x)}" y1="${svgRound(p.y + p.h)}" x2="${svgRound(p.x + p.w)}" y2="${svgRound(p.y + p.h)}"></line>`;
    return `<svg class="dash-chart" viewBox="0 0 ${model.width} ${model.height}" width="100%" height="100%">${grid}${baseline}${parts}</svg>`;
  }

  function candleChartSvg(model, options) {
    const o = Object.assign({ titleOf: () => '', axisLabel: () => '', yTicks: 0, formatTick: (v) => String(v) }, options || {});
    const p = model.plot;
    const grid = yAxisSvg(p, model.maxVal, o.yTicks, o.formatTick);
    const parts = (model.candles || []).map((c, i) => {
      const cls = c.up ? 'candle-up' : 'candle-down';
      const wick = `<line class="candle-wick ${cls}" x1="${svgRound(c.wickX)}" y1="${svgRound(c.yHigh)}" x2="${svgRound(c.wickX)}" y2="${svgRound(c.yLow)}"></line>`;
      const body = `<rect class="candle-body ${cls}" x="${svgRound(c.x)}" y="${svgRound(c.bodyY)}" width="${svgRound(c.width)}" height="${svgRound(Math.max(1, c.bodyHeight))}" rx="1"></rect>`;
      const tip = o.titleOf(c);
      const title = tip ? `<title>${escapeXml(tip)}</title>` : '';
      const hover = `<rect data-i="${i}" x="${svgRound(c.x)}" y="${svgRound(p.y)}" width="${svgRound(c.width)}" height="${svgRound(p.h)}" class="bar-hover">${title}</rect>`;
      const label = axisText(o.axisLabel(c, i, model.candles), c.wickX, model.height - 4);
      return wick + body + hover + label;
    }).join('');
    return `<svg class="dash-chart" viewBox="0 0 ${model.width} ${model.height}" width="100%" height="100%">${grid}${parts}</svg>`;
  }

  function heatmapSvg(model, options) {
    const o = Object.assign({ titleOf: () => '', monthLabel: (m) => m.label, radius: 3, glowFilterId: '', spotlightId: '', spotlightRadius: 86 }, options || {});
    const botPad = 16;
    const pitch = (model.cell || 11) + (model.gap || 2);
    const glowFilterId = String(o.glowFilterId || '');
    const spotlightId = String(o.spotlightId || '');
    const spotlightGradientId = spotlightId ? `${spotlightId}Gradient` : '';
    const spotlightMaskId = spotlightId ? `${spotlightId}Mask` : '';
    const radius = svgRound(Math.max(1, Number(o.spotlightRadius) || 86));
    const defsParts = [];
    if (glowFilterId) {
      defsParts.push(`<filter id="${escapeXml(glowFilterId)}" x="-80%" y="-80%" width="260%" height="260%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="0" stdDeviation="2.1" flood-color="rgb(120, 190, 255)" flood-opacity="0.95"></feDropShadow><feDropShadow dx="0" dy="0" stdDeviation="4.2" flood-color="rgb(120, 190, 255)" flood-opacity="0.42"></feDropShadow></filter>`);
    }
    if (spotlightId) {
      defsParts.push(`<radialGradient id="${escapeXml(spotlightGradientId)}" gradientUnits="userSpaceOnUse" cx="-200" cy="-200" r="${radius}"><stop offset="0" stop-color="white" stop-opacity="1"></stop><stop offset="0.35" stop-color="white" stop-opacity="0.62"></stop><stop offset="0.75" stop-color="white" stop-opacity="0"></stop></radialGradient><mask id="${escapeXml(spotlightMaskId)}"><rect x="0" y="0" width="${svgRound(model.width)}" height="${svgRound(model.height)}" fill="url(#${escapeXml(spotlightGradientId)})"></rect></mask>`);
    }
    const defs = defsParts.length ? `<defs>${defsParts.join('')}</defs>` : '';
    const cellAttrs = (c) => `class="heat lvl-${c.intensity}" data-d="${escapeXml(c.date)}" data-t="${svgRound(c.tokens || 0)}" data-cost="${svgRound(c.cost || 0)}" x="${svgRound(c.x)}" y="${svgRound(c.y)}" width="${svgRound(c.size)}" height="${svgRound(c.size)}" rx="${svgRound(Math.max(0, Number(o.radius) || 0))}"`;
    const cells = (model.cells || []).map((c) =>
      `<rect ${cellAttrs(c)}>${o.titleOf(c) ? `<title>${escapeXml(o.titleOf(c))}</title>` : ''}</rect>`
    ).join('');
    const brightCells = spotlightId
      ? (model.cells || []).map((c) =>
        `<rect class="heat heat-bright lvl-${c.intensity}" x="${svgRound(c.x)}" y="${svgRound(c.y)}" width="${svgRound(c.size)}" height="${svgRound(c.size)}" rx="${svgRound(Math.max(0, Number(o.radius) || 0))}"></rect>`
      ).join('')
      : '';
    const brightLayer = spotlightId
      ? `<g class="heat-bright-layer" mask="url(#${escapeXml(spotlightMaskId)})" aria-hidden="true">${brightCells}</g>`
      : '';
    // Month labels sit BELOW the grid, left-anchored at the column where each month
    // starts — so the current month naturally lands on whichever column its 1st falls in
    // (no special-casing), and the first month sits flush at the left edge.
    const labelY = model.height + 12;
    const months = (model.monthLabels || []).map((m) =>
      `<text class="heat-month" x="${svgRound(m.col * pitch)}" y="${svgRound(labelY)}" text-anchor="start">${escapeXml(o.monthLabel(m))}</text>`
    ).join('');
    return `<svg class="dash-heatmap" viewBox="0 0 ${model.width} ${model.height + botPad}" width="${model.width}" height="${model.height + botPad}">${defs}<g class="heat-base-layer">${cells}</g>${brightLayer}${months}</svg>`;
  }

  function statsCardsHtml(cards, options) {
    const o = Object.assign({ label: (k) => k, format: (c) => String(c.value) }, options || {});
    return (Array.isArray(cards) ? cards : []).map((c) =>
      `<div class="dash-card"><span class="dash-card-v">${escapeXml(o.format(c))}</span><span class="dash-card-k">${escapeXml(o.label(c.key))}</span></div>`
    ).join('');
  }

  function statCardColumnWidths(contentWidths, options) {
    const widths = (Array.isArray(contentWidths) ? contentWidths : [])
      .map((width) => Math.max(0, n(width)));
    if (!widths.length) return [];
    const totalWidth = Math.max(0, n(options && options.totalWidth));
    if (totalWidth <= 0) return widths.map(() => 0);
    const equalWidth = totalWidth / widths.length;
    const minWidth = Math.max(0, n(options && options.minWidth) || equalWidth * 0.72);
    const safety = Math.max(0, n(options && options.safety));
    const required = widths.map((width) => width + safety);
    const columns = widths.map(() => equalWidth);

    for (let i = 0; i < required.length; i++) {
      if (required[i] > equalWidth) columns[i] = required[i];
    }

    let overflow = columns.reduce((sum, width) => sum + width, 0) - totalWidth;
    if (overflow > 0) {
      const capacities = required.map((width, index) =>
        Math.max(0, columns[index] - Math.max(width, minWidth))
      );
      const totalCapacity = capacities.reduce((sum, width) => sum + width, 0);
      if (totalCapacity > 0) {
        for (let i = 0; i < columns.length; i++) {
          columns[i] -= Math.min(capacities[i], overflow * (capacities[i] / totalCapacity));
        }
      }
    }

    const sum = columns.reduce((total, width) => total + width, 0);
    if (sum > totalWidth && sum > 0) {
      const scale = totalWidth / sum;
      for (let i = 0; i < columns.length; i++) columns[i] *= scale;
    }

    const rounded = columns.map((width) => Math.round(width * 10) / 10);
    const delta = Math.round((totalWidth - rounded.reduce((sumWidth, width) => sumWidth + width, 0)) * 10) / 10;
    rounded[rounded.length - 1] = Math.max(0, Math.round((rounded[rounded.length - 1] + delta) * 10) / 10);
    return rounded;
  }

  return {
    weekStartKey, dailyBarsChart, candleChart, contribHeatmap, rollingYearHeatmap, statsCards, sparklinePreview,
    areaLineChart, areaLineSvg,
    selectPreviewSeries, patchTodayBar, sparklineSvg,
    clientColors, fallbackModelColors, modelVendorFor, modelColor, clampDaily,
    barsChartSvg, candleChartSvg, heatmapSvg, statsCardsHtml, statCardColumnWidths
  };
});
