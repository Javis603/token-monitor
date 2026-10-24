'use strict';

// Draws resolved plugin views. Main resolves bindings and validates every
// value; this module only turns plain data into DOM, SVG or canvas, with no
// innerHTML, URLs or plugin-supplied styles. The same renderer serves the
// widget, the Edge Dock and the Notch, so a plugin looks native everywhere
// and follows the active theme and skin through CSS variables.
(function exposePluginViews(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginViews = api;
})(typeof window !== 'undefined' ? window : null, function createPluginViewsApi() {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TONES = ['default', 'muted', 'accent', 'chart', 'ok', 'warn', 'bad', 'info'];

  // 24×24 stroke icons. Plugins may also supply their own path data, which
  // main has already restricted to path commands and numbers.
  const ICON_PATHS = Object.freeze({
    cpu: 'M8 4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3',
    memory: 'M3 7h18v10H3zM7 10v4M11 10v4M15 10v4M6 17v3M10 17v3M14 17v3M18 17v3',
    gauge: 'M4 18a8 8 0 1 1 16 0M12 18l4-6M8 18h8',
    bolt: 'M13 2 5 13h6l-1 9 8-11h-6l1-9z',
    clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2',
    pulse: 'M2 12h4l2-6 4 12 3-9 2 3h5',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    alert: 'M12 3 2 20h20L12 3zM12 9v5M12 17v.5',
    check: 'M4 12l5 5L20 6',
    dot: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
    token: 'M12 2l8.5 5v10L12 22l-8.5-5V7L12 2zM12 7v10M8 9.5l8 5M16 9.5l-8 5',
    globe: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
    battery: 'M3 8h15v8H3zM18 11h3v2h-3M6 11v2M9 11v2',
    thermometer: 'M10 4a2 2 0 0 1 4 0v10a4 4 0 1 1-4 0zM12 10v7'
  });

  function toneClass(tone) {
    return TONES.includes(tone) ? `pv-tone-${tone}` : '';
  }

  function toneVar(paint) {
    if (!paint) return '';
    return TONES.includes(paint) ? `var(--plugin-${paint})` : paint;
  }

  function el(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
  }

  function svg(document, tag, attributes = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value !== undefined && value !== null) node.setAttribute(name, String(value));
    }
    return node;
  }

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function clampPercent(value) {
    const number = finite(value);
    return number === null ? null : Math.max(0, Math.min(100, number));
  }

  function iconNode(document, name, path, size = 16) {
    const d = path || ICON_PATHS[name] || ICON_PATHS.dot;
    const node = svg(document, 'svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', class: 'pv-icon' });
    node.append(svg(document, 'path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return node;
  }

  function applyPaint(node, op) {
    node.style.fill = op.fill ? toneVar(op.fill) : 'none';
    if (op.stroke) {
      node.style.stroke = toneVar(op.stroke);
      node.setAttribute('stroke-width', String(op.sw ?? 1));
      if (op.cap) node.setAttribute('stroke-linecap', op.cap);
    }
    if (op.o !== undefined) node.setAttribute('opacity', String(op.o));
    return node;
  }

  function arcPath(cx, cy, r, startDeg, endDeg) {
    const span = Math.max(-359.99, Math.min(359.99, endDeg - startDeg));
    const start = (startDeg - 90) * Math.PI / 180;
    const end = (startDeg + span - 90) * Math.PI / 180;
    const large = Math.abs(span) > 180 ? 1 : 0;
    const sweep = span >= 0 ? 1 : 0;
    return `M${cx + r * Math.cos(start)} ${cy + r * Math.sin(start)} A${r} ${r} 0 ${large} ${sweep} ${cx + r * Math.cos(end)} ${cy + r * Math.sin(end)}`;
  }

  // Free drawing: a display list in the box's own coordinates, scaled to fit.
  function renderDisplayList(document, list, width, height) {
    const root = svg(document, 'svg', { viewBox: `0 0 ${width} ${height}`, class: 'pv-draw', role: 'img', 'aria-hidden': 'true' });
    root.style.aspectRatio = `${width} / ${height}`;
    for (const op of Array.isArray(list) ? list : []) {
      let node = null;
      if (op.op === 'rect') node = svg(document, 'rect', { x: op.x, y: op.y, width: op.w, height: op.h, rx: op.r });
      else if (op.op === 'circle') node = svg(document, 'circle', { cx: op.cx, cy: op.cy, r: op.r });
      else if (op.op === 'line') node = svg(document, 'line', { x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 });
      else if (op.op === 'arc') node = svg(document, 'path', { d: arcPath(op.cx, op.cy, op.r, op.start, op.end) });
      else if (op.op === 'poly') {
        const points = [];
        for (let index = 0; index + 1 < op.points.length; index += 2) points.push(`${op.points[index]},${op.points[index + 1]}`);
        node = svg(document, op.closed ? 'polygon' : 'polyline', { points: points.join(' ') });
      } else if (op.op === 'path') node = svg(document, 'path', { d: op.d });
      else if (op.op === 'text') {
        node = svg(document, 'text', { x: op.x, y: op.y, 'font-size': op.size, 'text-anchor': op.anchor, 'font-weight': op.weight === 'bold' ? 700 : op.weight === 'medium' ? 600 : 400 });
        node.textContent = op.text;
        if (op.mono) node.setAttribute('class', 'pv-draw-mono');
        node.style.fill = toneVar(op.fill || 'default');
        if (op.o !== undefined) node.setAttribute('opacity', String(op.o));
        root.append(node);
        continue;
      }
      if (node) root.append(applyPaint(node, op));
    }
    return root;
  }

  function seriesPath(series, width, height, min, max) {
    const values = series.map(finite);
    const known = values.filter((value) => value !== null);
    if (!known.length) return { line: '', area: '' };
    const low = finite(min) ?? Math.min(...known);
    const high = finite(max) ?? Math.max(...known);
    const span = high - low || 1;
    const step = values.length > 1 ? width / (values.length - 1) : 0;
    let line = '';
    let area = '';
    let open = false;
    let firstX = 0;
    values.forEach((value, index) => {
      if (value === null) {
        if (open) area += `L${(index - 1) * step} ${height}L${firstX} ${height}Z`;
        open = false;
        return;
      }
      const x = index * step;
      const y = height - ((Math.max(low, Math.min(high, value)) - low) / span) * (height - 2) - 1;
      line += `${open ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
      area += `${open ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
      if (!open) firstX = x;
      open = true;
    });
    if (open) area += `L${(values.length - 1) * step} ${height}L${firstX} ${height}Z`;
    return { line, area };
  }

  function renderSparkline(document, node) {
    const height = node.height || 32;
    const width = 100;
    const root = svg(document, 'svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', class: `pv-sparkline ${toneClass(node.tone || 'chart')}` });
    root.style.height = `${height}px`;
    const { line, area } = seriesPath(node.series || [], width, height, node.min, node.max);
    if (node.smooth && Array.isArray(node.seriesPoints) && node.seriesPoints.length) {
      root._pvChart = node;
      root.style.overflow = 'hidden';
    }
    if (node.fill && (area || root._pvChart)) root.append(svg(document, 'path', { d: area, class: 'pv-sparkline-area' }));
    if (line || root._pvChart) root.append(svg(document, 'path', { d: line, class: 'pv-sparkline-line', 'vector-effect': 'non-scaling-stroke' }));
    return root;
  }

  function prepareChart(root) {
    const node = root._pvChart;
    if (!node) return;
    const points = node.seriesPoints.filter(p => Number.isFinite(p.at));
    const at = points.at(-1)?.at;
    if (!Number.isFinite(at)) return;
    const height = node.height || 32, windowMs = node.windowMs || 120000;
    const values = points.map(p => p.value).filter(Number.isFinite);
    const low = finite(node.min) ?? Math.min(0, ...values), high = finite(node.max) ?? Math.max(1, ...values);
    const span = Math.max(1, high - low);
    let line = '', area = '', start = 0, last = 0, previous = null, open = false;
    const close = () => { if (open) area += `L${last} ${height}L${start} ${height}Z`; open = false; };
    for (const point of points) {
      if (previous !== null && (point.at <= previous || point.at - previous > Math.max(15000, node.seriesIntervalMs * 3))) close();
      previous = point.at;
      if (!Number.isFinite(point.value)) { close(); continue; }
      const x = 100 * (1 - (at - point.at) / windowMs);
      const y = height - 1 - (Math.max(low, Math.min(high, point.value)) - low) / span * (height - 2);
      const segment = `${open ? 'L' : 'M'}${x.toFixed(4)} ${y.toFixed(4)}`;
      line += segment; area += segment;
      if (!open) start = x;
      last = x; open = true;
    }
    close();
    root.querySelector('.pv-sparkline-line')?.setAttribute('d', line);
    root.querySelector('.pv-sparkline-area')?.setAttribute('d', area);
    root._pvChartAt = at;
  }

  function renderBars(document, node) {
    const height = node.height || 32;
    const series = (node.series || []).map(finite);
    const known = series.filter((value) => value !== null);
    const low = finite(node.min) ?? Math.min(0, ...known);
    const high = finite(node.max) ?? Math.max(1, ...known);
    const root = svg(document, 'svg', { viewBox: `0 0 ${Math.max(1, series.length) * 3} ${height}`, preserveAspectRatio: 'none', class: `pv-bars ${toneClass(node.tone || 'chart')}` });
    root.style.height = `${height}px`;
    series.forEach((value, index) => {
      if (value === null) return;
      const h = Math.max(0.5, ((value - low) / (high - low || 1)) * height);
      root.append(svg(document, 'rect', { x: index * 3, y: height - h, width: 2.2, height: h, rx: 0.6 }));
    });
    return root;
  }

  function renderRing(document, node) {
    const size = node.size || 48;
    const percent = clampPercent(node.value);
    const wrap = el(document, 'div', 'pv-ring');
    const box = el(document, 'div', `pv-ring-box ${toneClass(node.tone || 'accent')}`);
    box.style.width = box.style.height = `${size}px`;
    const radius = 15.5;
    const circumference = 2 * Math.PI * radius;
    const ring = svg(document, 'svg', { viewBox: '0 0 36 36', width: size, height: size, 'aria-hidden': 'true' });
    ring.append(svg(document, 'circle', { cx: 18, cy: 18, r: radius, class: 'pv-ring-track' }));
    const arc = svg(document, 'circle', { cx: 18, cy: 18, r: radius, class: 'pv-ring-arc', 'stroke-dasharray': `${circumference}`, 'stroke-dashoffset': `${circumference * (1 - (percent ?? 0) / 100)}` });
    ring.append(arc);
    const caption = el(document, 'span', 'pv-ring-caption', node.caption ?? (percent === null ? '—' : `${Math.round(percent)}%`));
    if (Number.isFinite(node.captionNumber)) {
      caption._pvNumber = node.captionNumber;
      caption._pvFormat = node.captionFormat;
    } else if (node.caption == null) { caption._pvNumber = percent; caption._pvFormat = { fmt: 'percent', digits: 0 }; }
    box.append(ring, caption);
    wrap.append(box);
    if (node.label) wrap.append(el(document, 'span', 'pv-ring-label', node.label));
    return wrap;
  }

  function renderMeter(document, node) {
    const percent = clampPercent(node.value);
    const wrap = el(document, 'div', `pv-meter ${toneClass(node.tone || 'accent')}`);
    if (node.label || node.caption) {
      const head = el(document, 'div', 'pv-meter-head');
      head.append(el(document, 'span', 'pv-meter-label', node.label || ''), el(document, 'span', 'pv-meter-caption', node.caption || ''));
      wrap.append(head);
    }
    const track = el(document, 'div', 'pv-meter-track');
    const fill = el(document, 'div', 'pv-meter-fill');
    fill.style.width = `${percent ?? 0}%`;
    track.append(fill);
    wrap.append(track);
    return wrap;
  }

  const CONTROL_TYPES = ['button', 'toggle', 'slider', 'select', 'input'];
  function sendControl(out, input) {
    if (out._pvModel.disabled || !out._pvSend) return;
    out._pvSend({ action: out._pvModel.action, ...input });
  }
  function updateControl(document, out, node, options) {
    out._pvModel = node; out._pvSend = options.onInteraction;
    const field = node.type === 'button' ? out : out.querySelector('.pv-field');
    field.disabled = node.disabled === true || !options.onInteraction;
    if (node.type === 'button') { out.textContent = node.label; return; }
    out.querySelector('.pv-control-label').textContent = node.label;
    if (node.type === 'toggle') field.checked = node.value === true;
    else if (node.type === 'slider') {
      field.min = node.min ?? 0; field.max = node.max ?? 100; field.step = node.step ?? 1;
      if (!out._pvDragging) field.value = node.value ?? field.min;
      out.querySelector('output').textContent = field.value;
    } else if (node.type === 'select') {
      const key = JSON.stringify(node.options);
      if (key !== out._pvOptions) {
        out._pvOptions = key; field.replaceChildren();
        for (const item of node.options || []) { const option = el(document, 'option', '', item.label); option.value = item.value; field.append(option); }
      }
      field.value = node.value ?? '';
    } else {
      field.maxLength = node.maxLength || 256; field.placeholder = node.placeholder || '';
      // Live metric pushes must preserve an in-progress edit and IME composition.
      if (field.value === (node.value ?? '')) out._pvDirty = false;
      if (document.activeElement !== field && !out._pvDirty) field.value = node.value ?? '';
    }
  }
  function renderControl(document, node, options) {
    const out = el(document, node.type === 'button' ? 'button' : 'label', `pv-control pv-control-${node.type}`);
    if (node.type === 'button') { out.type = 'button'; out.addEventListener('click', () => sendControl(out, { type: 'press' })); }
    else {
      out.append(el(document, 'span', 'pv-control-label'));
      const field = el(document, node.type === 'select' ? 'select' : 'input', 'pv-field');
      if (node.type !== 'select') field.type = node.type === 'toggle' ? 'checkbox' : node.type === 'slider' ? 'range' : 'text';
      out.append(field);
      if (node.type === 'slider') {
        out.append(el(document, 'output'));
        field.addEventListener('pointerdown', () => { out._pvDragging = true; });
        for (const type of ['pointerup', 'pointercancel', 'blur']) field.addEventListener(type, () => { out._pvDragging = false; });
        field.addEventListener('input', () => { out.querySelector('output').textContent = field.value; });
      }
      if (node.type === 'input') field.addEventListener('input', () => { out._pvDirty = field.value !== (out._pvModel.value ?? ''); });
      const commit = () => sendControl(out, { type: 'change', value: node.type === 'toggle' ? field.checked : node.type === 'slider' ? Number(field.value) : field.value });
      field.addEventListener('change', commit);
      if (node.type === 'input') field.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); field.blur(); } });
    }
    out.addEventListener('pointerdown', event => event.stopPropagation());
    out.addEventListener('click', event => event.stopPropagation());
    updateControl(document, out, node, options);
    return out;
  }
  function interactiveDrawing(document, out, node, options) {
    out._pvModel = node; out._pvSend = options.onInteraction;
    out.classList.add('pv-draw-interactive');
    out.tabIndex = node.disabled || !options.onInteraction ? -1 : 0;
    out.setAttribute('role', 'group'); out.setAttribute('aria-label', node.label);
    const sendPointer = event => {
      const model = out._pvModel, rect = out.firstElementChild.getBoundingClientRect();
      const x = Math.max(0, Math.min(model.width || 100, (event.clientX - rect.left) / rect.width * (model.width || 100)));
      const y = Math.max(0, Math.min(model.height || 40, (event.clientY - rect.top) / rect.height * (model.height || 40)));
      out._pvPosition = { x, y };
      sendControl(out, { type: event.type, x, y });
    };
    out.addEventListener('pointerdown', event => {
      if (event.button !== 0 || out._pvModel.disabled || !out._pvSend || out._pvPointer != null) return;
      event.preventDefault(); event.stopPropagation(); out.focus(); out.setPointerCapture(event.pointerId); out._pvPointer = event.pointerId; out._pvLastMove = 0; sendPointer(event);
    });
    out.addEventListener('pointermove', event => {
      if (out._pvPointer !== event.pointerId || event.timeStamp - out._pvLastMove < 50) return;
      event.preventDefault(); event.stopPropagation(); out._pvLastMove = event.timeStamp; sendPointer(event);
    });
    for (const type of ['pointerup', 'pointercancel']) out.addEventListener(type, event => {
      if (out._pvPointer !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation(); sendPointer(event); out._pvPointer = null;
      if (out.hasPointerCapture(event.pointerId)) out.releasePointerCapture(event.pointerId);
    });
    out.addEventListener('lostpointercapture', () => { if (out._pvPointer != null) { sendControl(out, { type: 'pointercancel', ...out._pvPosition }); out._pvPointer = null; } });
    out.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', ' '].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); sendControl(out, { type: 'key', key: event.key });
    });
    out.addEventListener('click', event => event.stopPropagation());
  }
  function patchNode(document, old, node, options) {
    if (!old || old._pvType !== node.type || old._pvAction !== node.action) return renderNode(document, node, options);
    old.dataset.pvMotion = node.motion || 'inherit';
    if (CONTROL_TYPES.includes(node.type)) { updateControl(document, old, node, options); return old; }
    if (node.type === 'stack') {
      const children = node.children || [];
      children.forEach((child, index) => {
        const current = old.children[index], next = patchNode(document, current, child, options);
        if (!current) old.append(next); else if (next !== current) current.replaceWith(next);
      });
      while (old.children.length > children.length) old.lastElementChild.remove();
      return old;
    }
    if (node.type === 'draw' && node.action) {
      old._pvModel = node; old._pvSend = options.onInteraction;
      old.tabIndex = node.disabled || !options.onInteraction ? -1 : 0; old.setAttribute('aria-label', node.label);
      const drawing = renderDisplayList(document, node.list || [], node.width || 100, node.height || 40);
      old.firstElementChild.replaceChildren(...drawing.childNodes);
      return old;
    }
    return renderNode(document, node, options);
  }
  function renderNode(document, node, options = {}) {
    if (!node || typeof node !== 'object') return null;
    let out;
    if (CONTROL_TYPES.includes(node.type)) out = renderControl(document, node, options);
    else switch (node.type) {
      case 'stack': {
        out = el(document, 'div', `pv-stack pv-dir-${node.dir === 'row' ? 'row' : 'col'}`);
        if (node.gap !== undefined) out.style.gap = `calc(${node.gap}px * var(--pv-spacing, 1))`;
        if (node.align) out.style.alignItems = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' }[node.align];
        if (node.justify) out.style.justifyContent = { start: 'flex-start', end: 'flex-end', center: 'center', between: 'space-between' }[node.justify];
        if (node.wrap) out.style.flexWrap = 'wrap';
        for (const child of node.children || []) {
          const rendered = renderNode(document, child, options);
          if (rendered) out.append(rendered);
        }
        break;
      }
      case 'stat': {
        out = el(document, 'div', `pv-stat pv-size-${node.size || 'm'}`);
        if (node.label) out.append(el(document, 'span', 'pv-stat-label', node.label));
        const value = el(document, 'div', `pv-stat-value ${toneClass(node.tone)}`);
        const number = el(document, 'span', 'pv-stat-number', node.value ?? '—');
        number._pvNumber = node.valueNumber;
        number._pvFormat = node.valueFormat;
        value.append(number);
        if (node.unit) value.append(el(document, 'span', 'pv-stat-unit', node.unit));
        out.append(value);
        if (node.caption) out.append(el(document, 'span', 'pv-stat-caption', node.caption));
        break;
      }
      case 'meter': out = renderMeter(document, node); break;
      case 'ring': out = renderRing(document, node); break;
      case 'sparkline': out = renderSparkline(document, node); break;
      case 'bars': out = renderBars(document, node); break;
      case 'text':
        out = el(document, 'span', `pv-text pv-text-${node.size || 's'} pv-weight-${node.weight || 'regular'} ${node.mono ? 'pv-mono' : ''} ${toneClass(node.tone)}`, node.text ?? '');
        if (node.align) out.style.textAlign = node.align;
        break;
      case 'badge':
        out = el(document, 'span', `pv-badge ${toneClass(node.tone || 'muted')}`, node.text ?? '');
        break;
      case 'icon':
        out = el(document, 'span', `pv-icon-wrap ${toneClass(node.tone)}`);
        out.append(iconNode(document, node.name, node.path, node.size || 16));
        break;
      case 'rows': {
        out = el(document, 'div', 'pv-rows');
        for (const row of (node.items || []).slice(0, node.limit || 20)) {
          const line = el(document, 'div', `pv-row ${toneClass(row.tone)}`);
          line.append(el(document, 'span', 'pv-row-label', row.label), el(document, 'span', 'pv-row-value', row.value));
          if (row.bar !== undefined) {
            const bar = el(document, 'span', 'pv-row-bar');
            const fill = el(document, 'span', 'pv-row-bar-fill');
            fill.style.width = `${clampPercent(row.bar) ?? 0}%`;
            bar.append(fill);
            line.append(bar);
          }
          out.append(line);
        }
        break;
      }
      case 'draw':
        out = el(document, 'div', 'pv-draw-box');
        out.append(renderDisplayList(document, node.list || [], node.width || 100, node.height || 40));
        if (node.action) interactiveDrawing(document, out, node, options);
        break;
      case 'spacer':
        out = el(document, 'div', 'pv-spacer');
        if (node.size !== undefined) out.style.flexBasis = `${node.size}px`;
        break;
      case 'divider':
        out = el(document, 'div', 'pv-divider');
        break;
      default:
        return null;
    }
    out.dataset.pvMotion = node.motion || 'inherit';
    out._pvType = node.type; out._pvAction = node.action;
    if (node.flex !== undefined) {
      out.style.flex = `${node.flex} 1 0`;
      out.style.minWidth = '0';
    }
    return out;
  }

  function renderTree(document, tree, options = {}) {
    const root = el(document, 'div', 'pv-root');
    const rendered = renderNode(document, tree, options);
    if (rendered) root.append(rendered);
    return root;
  }

  function renderCompact(document, state) {
    const node = el(document, 'div', `pv-compact ${toneClass(state?.compact?.tone)}`);
    node.append(el(document, 'span', 'pv-compact-label', state?.compact?.label || state?.title || ''));
    node.append(el(document, 'span', 'pv-compact-value', state?.compact?.value ?? '—'));
    if (state?.compact?.caption) node.append(el(document, 'span', 'pv-compact-caption', state.compact.caption));
    return node;
  }

  const STATUS_KEYS = {
    missing: 'plugins.view.missing',
    disabled: 'plugins.view.disabled',
    pluginsOff: 'plugins.view.disabled',
    safeMode: 'plugins.view.safeMode',
    needsApproval: 'plugins.view.needsApproval',
    crashed: 'plugins.view.crashed',
    error: 'plugins.view.error',
    unsupported: 'plugins.view.unsupported',
    invalid: 'plugins.view.error'
  };

  function renderPlaceholder(document, state, t) {
    const node = el(document, 'div', 'pv-placeholder');
    node.append(iconNode(document, state?.icon || 'dot', null, 14));
    node.append(el(document, 'span', '', t ? t(STATUS_KEYS[state?.status] || 'plugins.view.loading') : (state?.status || '')));
    return node;
  }

  function applyAppearance(container, value = {}) {
    for (const [key, choices] of Object.entries({ font: ['inherit', 'system', 'mono'], density: ['compact', 'standard', 'comfortable'], corners: ['square', 'rounded', 'soft'], panel: ['plain', 'outline', 'soft'] })) container.dataset[`pv${key[0].toUpperCase()}${key.slice(1)}`] = choices.includes(value[key]) ? value[key] : choices[key === 'density' || key === 'corners' ? 1 : 0];
    for (const [key, property] of Object.entries({ accent: '--plugin-accent', chart: '--plugin-chart', text: '--plugin-default', muted: '--plugin-muted', background: '--pv-background' })) {
      if (/^#[0-9a-f]{6}$/i.test(value.colors?.[key] || '')) container.style.setProperty(property, value.colors[key]);
      else container.style.removeProperty(property);
    }
  }

  // Tracks where each view is mounted on one page, keeps the latest payload
  // per surface, repaints mounted nodes in place on every push and reports
  // which refs are actually visible so main samples nothing else.
  function createPluginViewHost({ document, window, t, onDemand = () => {}, onInteraction, onMount, onPaint, isSurfaceActive = () => true, motionAllowed = () => false, motionMode = () => 'roll' }) {
    const latest = new Map();
    let appearance = {};
    const mounts = new Map();
    const explicit = new Map();
    const lastDemand = new Map();
    const intersections = new Map();
    let demandFrame = 0;
    const observer = typeof window?.IntersectionObserver === 'function'
      ? new window.IntersectionObserver((entries) => {
        for (const entry of entries) intersections.set(entry.target, entry.isIntersecting);
        scheduleDemand();
      }) : null;

    function stateFor(surface, ref) {
      return latest.get(surface)?.[ref] || null;
    }

    // Full views share the existing App roller. Compact rail values are owned
    // by its adapter so host repainting never starts two animations per value.
    const numberRoll = window?.TokenMonitorEdgeDockRailNumberRoll;
    const numberAnimation = window?.TokenMonitorTokenNumberAnimation;
    function canMove(mount) {
      return motionAllowed() && document.visibilityState !== 'hidden' && isSurfaceActive(mount.surface) && isVisible(mount.container);
    }
    let chartFrame = 0, chartEpoch = Date.now(), chartStart = window?.performance?.now() || 0;
    function chartClock() {
      const mono = window?.performance?.now() || 0, wall = Date.now();
      const estimate = chartEpoch + mono - chartStart;
      if (Math.abs(wall - estimate) > 1000) { chartEpoch = wall; chartStart = mono; return wall; }
      return estimate;
    }
    function animateCharts() {
      if (chartFrame) { window.cancelAnimationFrame(chartFrame); chartFrame = 0; }
      const now = chartClock();
      let moving = false;
      for (const mount of mounts.values()) {
        let count = 0;
        for (const root of mount.container.querySelectorAll?.('.pv-sparkline') || []) {
          const node = root._pvChart, at = root._pvChartAt;
          if (!node || !Number.isFinite(at)) continue;
          const allowed = ++count <= 16 && canMove(mount) && !root.closest('[data-pv-motion="none"]');
          const end = allowed ? Math.min(at, now - (node.seriesIntervalMs || 2000) - 250) : at;
          // Never extrapolate samples or animate a stale/future clock epoch.
          const offset = allowed && at <= now + 1000 ? Math.max(0, Math.min(node.windowMs || 120000, at - end)) : 0;
          for (const path of root.querySelectorAll('path')) path.setAttribute('transform', `translate(${(100 * offset / (node.windowMs || 120000)).toFixed(4)} 0)`);
          moving ||= offset > 0;
        }
      }
      if (moving && window?.requestAnimationFrame) chartFrame = window.requestAnimationFrame(animateCharts);
    }
    function refreshMotion() {
      for (const mount of mounts.values()) if (!canMove(mount) || mount.motionMode !== motionMode()) mount.roller?.settle();
      animateCharts();
    }
    function paint(mount) {
      const snapshot = mount.roller?.capture(mount.container);
      onPaint?.(mount);
      paintContent(mount);
      for (const chart of mount.container.querySelectorAll?.('.pv-sparkline') || []) prepareChart(chart);
      animateCharts();
      const state = stateFor(mount.surface, mount.ref);
      if (!mount.roller || state?.status !== 'ok') return;
      // Bounded visual work. Long text and remaining readings stay static.
      let index = 0;
      for (const node of mount.container.querySelectorAll('.pv-stat-number, .pv-ring-caption')) {
        const key = `${mount.ref}:${state.revision}:${index++}`;
        if (index > 16 || !Number.isFinite(node._pvNumber) || node.textContent.length > 32 || node.closest('[data-pv-motion="none"]')) continue;
        node.dataset.pvRoll = '';
        numberRoll.mark(node, key, node._pvNumber, node._pvFormat && window?.TokenMonitorPluginNumberFormat
          ? value => window.TokenMonitorPluginNumberFormat.formatValue(value, node._pvFormat, node._pvFormat.locale) : undefined);
      }
      mount.motionMode = motionMode();
      if (canMove(mount)) mount.roller.play(mount.container, snapshot);
    }
    function paintContent(mount) {
      const state = stateFor(mount.surface, mount.ref);
      const { container, variant } = mount;
      applyAppearance(container, appearance);
      container.dataset.pluginStatus = state?.status || 'loading';
      if (!state || state.status !== 'ok') {
        container.replaceChildren(renderPlaceholder(document, state || { status: 'loading' }, t));
        return;
      }
      if (variant === 'compact') container.replaceChildren(renderCompact(document, state));
      else if (state.tree) {
        const options = { onInteraction: onInteraction && !state.pending ? input => {
          Promise.resolve().then(() => onInteraction(mount.surface, mount.ref, input, state.revision)).then(() => { container.querySelector('.pv-action-error')?.remove(); }).catch(error => {
            if (!container.isConnected || mount.revision !== state.revision) return;
            let message = container.querySelector('.pv-action-error');
            if (!message) { message = el(document, 'p', 'pv-action-error'); message.setAttribute('role', 'alert'); container.append(message); }
            message.textContent = t ? t('settings.plugins.actionFailed', { error: error.message }) : error.message;
          });
        } : null };
        const root = container.firstElementChild;
        if (root?.classList.contains('pv-root') && (mount.revision === state.revision || mount.retainDrafts)) {
          const child = root.firstElementChild, next = patchNode(document, child, state.tree, options);
          if (child !== next) root.replaceChildren(next);
        } else container.replaceChildren(renderTree(document, state.tree, options));
        mount.revision = state.revision;
      }
      else container.replaceChildren(renderCompact(document, state));
    }

    function isVisible(container) {
      return container.isConnected && container.getClientRects().length > 0 && intersections.get(container) !== false;
    }

    function computeDemand() {
      demandFrame = 0;
      refreshMotion();
      const pageVisible = document.visibilityState !== 'hidden';
      const bySurface = new Map();
      for (const [surface, refs] of explicit) bySurface.set(surface, new Set(refs));
      for (const [container, mount] of [...mounts]) {
        if (!container.isConnected) {
          mount.roller?.settle();
          mounts.delete(container);
          intersections.delete(container);
          observer?.unobserve(container);
          continue;
        }
        if (!bySurface.has(mount.surface)) bySurface.set(mount.surface, new Set());
        if (pageVisible && isSurfaceActive(mount.surface) && isVisible(container)) bySurface.get(mount.surface).add(mount.ref);
      }
      const retainedPages = new Set([...mounts.values()].filter(mount => mount.surface === 'page').map(mount => mount.ref));
      for (const ref of Object.keys(latest.get('page') || {})) if (!retainedPages.has(ref)) delete latest.get('page')[ref];
      for (const surface of new Set([...lastDemand.keys(), ...bySurface.keys()])) {
        const refs = [...(bySurface.get(surface) || [])].sort();
        const key = refs.join(',');
        if (lastDemand.get(surface) === key) continue;
        lastDemand.set(surface, key);
        onDemand(surface, refs);
      }
    }

    function scheduleDemand() {
      if (demandFrame) return;
      // Animation frames can stop in hidden native windows; revocation must not.
      demandFrame = setTimeout(computeDemand, 0);
    }

    document.addEventListener?.('visibilitychange', scheduleDemand);

    return {
      update(payload) {
        if (!payload?.surface || !payload.views) return;
        appearance = payload.appearance || {};
        latest.set(payload.surface, payload.surface === 'page' ? { ...latest.get('page'), ...payload.views } : payload.views);
        for (const mount of mounts.values()) {
          if (mount.surface !== payload.surface) continue;
          // A page leaving the demand union is not a deletion. Keep its draft
          // while another page is selected; catalog removal unmounts it.
          if (mount.surface === 'page' && !Object.hasOwn(payload.views, mount.ref)) continue;
          paint(mount);
        }
      },
      mount(container, ref, surface, { variant = 'full', retainDrafts = false } = {}) {
        container.classList.add('pv-mount');
        const mount = { container, ref, surface, variant, retainDrafts,
          roller: variant === 'full' && numberRoll && numberAnimation ? numberRoll.create({ animation: numberAnimation, selector: '[data-pv-roll]', mode: motionMode }) : null };
        mounts.set(container, mount);
        observer?.observe(container);
        onMount?.(mount);
        paint(mount);
        scheduleDemand();
        return container;
      },
      // Surfaces without DOM (the tray bitmap) declare demand directly.
      setExplicitDemand(surface, refs) {
        explicit.set(surface, [...new Set(refs)]);
        scheduleDemand();
      },
      refreshDemand: scheduleDemand,
      refreshMotion,
      state: stateFor
    };
  }

  // Tray bitmaps: resolve tones to concrete colours once per draw.
  function drawDisplayList(ctx, list, { x = 0, y = 0, width, height, boxWidth, boxHeight, colors = {} }) {
    const scaleX = width / (boxWidth || width);
    const scaleY = height / (boxHeight || height);
    const paint = (value) => (TONES.includes(value) ? colors[value] || colors.default || '#fff' : value);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scaleX, scaleY);
    for (const op of Array.isArray(list) ? list : []) {
      ctx.globalAlpha = op.o ?? 1;
      ctx.lineWidth = op.sw ?? 1;
      ctx.lineCap = op.cap || 'butt';
      const shape = new Path2D();
      if (op.op === 'rect') {
        if (op.r && shape.roundRect) shape.roundRect(op.x, op.y, op.w, op.h, op.r);
        else shape.rect(op.x, op.y, op.w, op.h);
      } else if (op.op === 'circle') shape.arc(op.cx, op.cy, op.r, 0, Math.PI * 2);
      else if (op.op === 'line') { shape.moveTo(op.x1, op.y1); shape.lineTo(op.x2, op.y2); }
      else if (op.op === 'arc') shape.addPath(new Path2D(arcPath(op.cx, op.cy, op.r, op.start, op.end)));
      else if (op.op === 'poly') {
        for (let index = 0; index + 1 < op.points.length; index += 2) {
          if (index) shape.lineTo(op.points[index], op.points[index + 1]);
          else shape.moveTo(op.points[index], op.points[index + 1]);
        }
        if (op.closed) shape.closePath();
      } else if (op.op === 'path') shape.addPath(new Path2D(op.d));
      else if (op.op === 'text') {
        ctx.font = `${op.weight === 'bold' ? 700 : op.weight === 'medium' ? 600 : 400} ${op.size}px ${op.mono ? 'ui-monospace, Menlo, monospace' : '-apple-system, system-ui, sans-serif'}`;
        ctx.textAlign = op.anchor === 'middle' ? 'center' : op.anchor === 'end' ? 'right' : 'left';
        ctx.fillStyle = paint(op.fill || 'default');
        ctx.fillText(op.text, op.x, op.y);
        continue;
      }
      if (op.fill) {
        ctx.fillStyle = paint(op.fill);
        ctx.fill(shape);
      }
      if (op.stroke) {
        ctx.strokeStyle = paint(op.stroke);
        ctx.stroke(shape);
      }
    }
    ctx.restore();
  }

  function drawIcon(ctx, name, { x, y, size, color }) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(ICON_PATHS[name] || ICON_PATHS.dot));
    ctx.restore();
  }

  return {
    ICON_PATHS,
    TONES,
    applyAppearance,
    createPluginViewHost,
    drawDisplayList,
    drawIcon,
    iconNode,
    renderCompact,
    renderDisplayList,
    renderPlaceholder,
    renderTree
  };
});
