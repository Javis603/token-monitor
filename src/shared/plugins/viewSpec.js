'use strict';

// Declarative plugin views. A view is a small component tree plus optional
// free drawing (a display list); both are data, never markup or code, so the
// host can validate them once and render them with its own DOM, SVG or canvas
// code on any surface. Anything this module does not recognise is dropped.

const { normalizeLocalized } = require('./localized');
const { ACTION_RE, CONTROLS } = require('./interactions');

const SURFACES = Object.freeze(['home', 'notch', 'edgeDock', 'tray', 'page']);
const TONES = Object.freeze(['default', 'muted', 'accent', 'chart', 'ok', 'warn', 'bad', 'info']);
const FORMATS = Object.freeze(['number', 'percent', 'bytes', 'compact', 'duration', 'text', 'rate']);
const ICONS = Object.freeze(['cpu', 'memory', 'gauge', 'bolt', 'clock', 'pulse', 'chart', 'alert', 'check', 'dot', 'token', 'globe', 'battery', 'thermometer']);

const LIMITS = Object.freeze({
  depth: 8,
  nodes: 200,
  series: 240,
  rows: 20,
  steps: 8,
  drawOps: 400,
  drawPathChars: 8192,
  drawText: 64,
  coordinate: 4096
});

const SOURCE_RE = /^(?:(?:sys|tm)\.[a-z][a-zA-Z0-9]{0,31}|@[a-z][a-zA-Z0-9]{0,31})$/;
const FIELD_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}(?:\.[a-zA-Z][a-zA-Z0-9]{0,31}){0,3}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]+$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function clampInt(value, min, max) {
  const number = finite(value);
  return number === null ? null : Math.max(min, Math.min(max, Math.round(number)));
}

function isBinding(value) {
  return isObject(value) && typeof value.$ === 'string';
}

function normalizeBinding(raw, ctx, path, errors) {
  const source = raw.$.trim();
  if (!SOURCE_RE.test(source)) {
    errors.push(`${path}: unknown source "${source}"`);
    return null;
  }
  if (source.startsWith('@') && !ctx.metrics.has(source.slice(1))) {
    errors.push(`${path}: metric "${source.slice(1)}" is not declared`);
    return null;
  }
  const binding = { $: source };
  if (raw.field !== undefined) {
    if (typeof raw.field !== 'string' || !FIELD_RE.test(raw.field)) errors.push(`${path}: invalid field`);
    else binding.field = raw.field;
  }
  if (raw.history !== undefined) {
    const history = clampInt(raw.history, 2, 120);
    if (history !== null) binding.history = history;
  }
  if (raw.fmt !== undefined) {
    if (FORMATS.includes(raw.fmt)) binding.fmt = raw.fmt;
    else errors.push(`${path}: unknown format "${raw.fmt}"`);
  }
  if (raw.digits !== undefined) {
    const digits = clampInt(raw.digits, 0, 4);
    if (digits !== null) binding.digits = digits;
  }
  if (raw.scale !== undefined && finite(raw.scale) !== null) binding.scale = raw.scale;
  if (raw.unit !== undefined) {
    const unit = normalizeLocalized(raw.unit, 16);
    if (unit) binding.unit = unit;
  }
  if (raw.steps !== undefined) {
    const steps = Array.isArray(raw.steps) ? raw.steps.slice(0, LIMITS.steps)
      .filter((step) => Array.isArray(step) && finite(step[0]) !== null && TONES.includes(step[1]))
      .map((step) => [step[0], step[1]]).sort((a, b) => a[0] - b[0]) : [];
    if (steps.length) binding.steps = steps;
    else errors.push(`${path}: steps must be [threshold, tone] pairs`);
  }
  if (raw.fallback !== undefined && (typeof raw.fallback === 'string' || finite(raw.fallback) !== null)) {
    binding.fallback = typeof raw.fallback === 'string' ? raw.fallback.slice(0, 40) : raw.fallback;
  }
  ctx.sources.add(source);
  return Object.freeze(binding);
}

function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  if (TONES.includes(color)) return color;
  return COLOR_RE.test(color) ? color.toLowerCase() : null;
}

function coordinate(value) {
  const number = finite(value);
  return number === null ? null : Math.max(-LIMITS.coordinate, Math.min(LIMITS.coordinate, Math.round(number * 100) / 100));
}

// Free drawing inside a host-owned box. Coordinates are in the box's own units;
// paint references theme tones or literal colours, never URLs or gradients by
// reference, so a list can be rasterised into the tray bitmap as safely as it
// is drawn into SVG.
function sanitizeDisplayList(list, errors = [], path = 'draw') {
  if (!Array.isArray(list)) return Object.freeze([]);
  const ops = [];
  let pathChars = 0;
  for (const [index, raw] of list.slice(0, LIMITS.drawOps).entries()) {
    if (!isObject(raw)) continue;
    const at = `${path}[${index}]`;
    const paint = {};
    const fill = normalizeColor(raw.fill);
    const stroke = normalizeColor(raw.stroke);
    if (fill) paint.fill = fill;
    if (stroke) paint.stroke = stroke;
    const sw = finite(raw.sw);
    if (sw !== null) paint.sw = Math.max(0, Math.min(64, sw));
    const opacity = finite(raw.o);
    if (opacity !== null) paint.o = Math.max(0, Math.min(1, opacity));
    if (raw.cap === 'round' || raw.cap === 'butt' || raw.cap === 'square') paint.cap = raw.cap;
    if (raw.op === 'rect') {
      const [x, y, w, h] = [raw.x, raw.y, raw.w, raw.h].map(coordinate);
      if ([x, y, w, h].includes(null) || w < 0 || h < 0) { errors.push(`${at}: rect needs x, y, w, h`); continue; }
      const r = finite(raw.r);
      ops.push({ op: 'rect', x, y, w, h, ...(r !== null ? { r: Math.max(0, Math.min(w / 2, h / 2, r)) } : {}), ...paint });
    } else if (raw.op === 'circle') {
      const [cx, cy, r] = [raw.cx, raw.cy, raw.r].map(coordinate);
      if ([cx, cy, r].includes(null) || r < 0) { errors.push(`${at}: circle needs cx, cy, r`); continue; }
      ops.push({ op: 'circle', cx, cy, r, ...paint });
    } else if (raw.op === 'line') {
      const [x1, y1, x2, y2] = [raw.x1, raw.y1, raw.x2, raw.y2].map(coordinate);
      if ([x1, y1, x2, y2].includes(null)) { errors.push(`${at}: line needs x1, y1, x2, y2`); continue; }
      ops.push({ op: 'line', x1, y1, x2, y2, ...paint });
    } else if (raw.op === 'arc') {
      const [cx, cy, r] = [raw.cx, raw.cy, raw.r].map(coordinate);
      const start = finite(raw.start);
      const end = finite(raw.end);
      if ([cx, cy, r, start, end].includes(null) || r < 0) { errors.push(`${at}: arc needs cx, cy, r, start, end`); continue; }
      ops.push({ op: 'arc', cx, cy, r, start: Math.max(-720, Math.min(720, start)), end: Math.max(-720, Math.min(720, end)), ...paint });
    } else if (raw.op === 'poly') {
      const points = Array.isArray(raw.points) ? raw.points.slice(0, 512).map(coordinate) : [];
      if (points.length < 4 || points.length % 2 || points.includes(null)) { errors.push(`${at}: poly needs an even list of numbers`); continue; }
      ops.push({ op: 'poly', points, closed: raw.closed === true, ...paint });
    } else if (raw.op === 'path') {
      const d = typeof raw.d === 'string' ? raw.d.trim() : '';
      if (!d || !PATH_RE.test(d) || pathChars + d.length > LIMITS.drawPathChars) { errors.push(`${at}: path data rejected`); continue; }
      pathChars += d.length;
      ops.push({ op: 'path', d, ...paint });
    } else if (raw.op === 'text') {
      const [x, y] = [raw.x, raw.y].map(coordinate);
      const text = typeof raw.text === 'string' || finite(raw.text) !== null ? String(raw.text).replace(/[\u0000-\u001f]/g, ' ').slice(0, LIMITS.drawText) : '';
      if (x === null || y === null || !text) { errors.push(`${at}: text needs x, y, text`); continue; }
      const size = clampInt(raw.size, 6, 48) ?? 11;
      ops.push({
        op: 'text', x, y, text, size,
        weight: ['regular', 'medium', 'bold'].includes(raw.weight) ? raw.weight : 'regular',
        anchor: ['start', 'middle', 'end'].includes(raw.anchor) ? raw.anchor : 'start',
        mono: raw.mono === true,
        ...paint
      });
    } else {
      errors.push(`${at}: unknown op "${raw.op}"`);
    }
  }
  return Object.freeze(ops.map(Object.freeze));
}

// Rows are plain label/value pairs with an optional tone and 0–100 bar.
function normalizeRows(rows) {
  if (!Array.isArray(rows)) return Object.freeze([]);
  return Object.freeze(rows.slice(0, LIMITS.rows).filter(isObject).map((row) => Object.freeze({
    label: typeof row.label === 'string' || finite(row.label) !== null ? String(row.label).replace(/[\u0000-\u001f]/g, ' ').slice(0, 48) : '',
    value: typeof row.value === 'string' || finite(row.value) !== null ? String(row.value).replace(/[\u0000-\u001f]/g, ' ').slice(0, 32) : '',
    ...(TONES.includes(row.tone) ? { tone: row.tone } : {}),
    ...(finite(row.bar) !== null ? { bar: Math.max(0, Math.min(100, row.bar)) } : {})
  })).filter((row) => row.label || row.value));
}

const PROP_KINDS = Object.freeze({
  text(value, ctx, path, errors) {
    if (isBinding(value)) return normalizeBinding(value, ctx, path, errors);
    if (finite(value) !== null) return value;
    return normalizeLocalized(value, 160);
  },
  number(value, ctx, path, errors) {
    if (isBinding(value)) return normalizeBinding(value, ctx, path, errors);
    return finite(value);
  },
  series(value, ctx, path, errors) {
    if (isBinding(value)) return normalizeBinding(value, ctx, path, errors);
    if (!Array.isArray(value)) return null;
    return Object.freeze(value.slice(-LIMITS.series).map((entry) => finite(entry)));
  },
  tone(value, ctx, path, errors) {
    if (isBinding(value)) {
      const binding = normalizeBinding(value, ctx, path, errors);
      if (binding && !binding.steps) errors.push(`${path}: a tone binding needs steps`);
      return binding && binding.steps ? binding : null;
    }
    return TONES.includes(value) ? value : null;
  },
  bool(value) { return typeof value === 'boolean' ? value : null; },
  boundBool(value, ctx, path, errors) {
    if (isBinding(value)) return normalizeBinding(value, ctx, path, errors);
    return typeof value === 'boolean' ? value : null;
  },
  inputValue(value, ctx, path, errors) {
    if (isBinding(value)) return normalizeBinding(value, ctx, path, errors);
    return normalizeLocalized(value, 1024);
  },
  options(value) {
    if (!Array.isArray(value) || !value.length || value.length > 32) return null;
    const seen = new Set(), out = [];
    for (const option of value) {
      if (typeof option?.value !== 'string' || option.value.length > 64 || seen.has(option.value)) return null;
      const label = normalizeLocalized(option.label, 80); if (!label) return null;
      seen.add(option.value); out.push(Object.freeze({ value: option.value, label }));
    }
    return Object.freeze(out);
  },
  draw(value, ctx, path, errors) {
    if (isBinding(value)) return normalizeBinding(value, ctx, path, errors);
    return Array.isArray(value) ? sanitizeDisplayList(value, errors, path) : null;
  },
  rows(value, ctx, path, errors) {
    if (isBinding(value)) return normalizeBinding(value, ctx, path, errors);
    return Array.isArray(value) ? normalizeRows(value) : null;
  },
  iconPath(value) {
    if (typeof value !== 'string') return null;
    const d = value.trim();
    return d && d.length <= 2048 && PATH_RE.test(d) ? d : null;
  }
});

function enumKind(values) {
  return (value) => (values.includes(value) ? value : null);
}

function intKind(min, max) {
  return (value) => clampInt(value, min, max);
}

const FLEX = intKind(0, 12);

const CONTROL_PROPS = { label: PROP_KINDS.text, disabled: PROP_KINDS.boundBool, flex: FLEX };

const COMPONENTS = Object.freeze({
  button: { props: { ...CONTROL_PROPS, tone: PROP_KINDS.tone } },
  toggle: { props: { ...CONTROL_PROPS, value: PROP_KINDS.boundBool } },
  slider: { props: { ...CONTROL_PROPS, value: PROP_KINDS.number, min: PROP_KINDS.number, max: PROP_KINDS.number, step: PROP_KINDS.number } },
  select: { props: { ...CONTROL_PROPS, value: PROP_KINDS.text, options: PROP_KINDS.options } },
  input: { props: { ...CONTROL_PROPS, value: PROP_KINDS.inputValue, placeholder: PROP_KINDS.text, maxLength: intKind(1, 1024) } },
  stack: { children: true, props: { dir: enumKind(['row', 'col']), gap: intKind(0, 24), align: enumKind(['start', 'center', 'end', 'stretch']), justify: enumKind(['start', 'center', 'end', 'between']), wrap: PROP_KINDS.bool, flex: FLEX } },
  stat: { props: { label: PROP_KINDS.text, value: PROP_KINDS.text, unit: PROP_KINDS.text, caption: PROP_KINDS.text, tone: PROP_KINDS.tone, size: enumKind(['s', 'm', 'l']), flex: FLEX } },
  meter: { props: { value: PROP_KINDS.number, label: PROP_KINDS.text, caption: PROP_KINDS.text, tone: PROP_KINDS.tone, flex: FLEX } },
  ring: { props: { value: PROP_KINDS.number, label: PROP_KINDS.text, caption: PROP_KINDS.text, tone: PROP_KINDS.tone, size: intKind(24, 120), flex: FLEX } },
  sparkline: { props: { smooth: PROP_KINDS.bool, windowMs: intKind(1000, 3600000), series: PROP_KINDS.series, tone: PROP_KINDS.tone, height: intKind(12, 160), min: PROP_KINDS.number, max: PROP_KINDS.number, fill: PROP_KINDS.bool, flex: FLEX } },
  bars: { props: { series: PROP_KINDS.series, tone: PROP_KINDS.tone, height: intKind(12, 160), min: PROP_KINDS.number, max: PROP_KINDS.number, flex: FLEX } },
  text: { props: { text: PROP_KINDS.text, tone: PROP_KINDS.tone, size: enumKind(['xs', 's', 'm', 'l', 'xl']), weight: enumKind(['regular', 'medium', 'bold']), mono: PROP_KINDS.bool, align: enumKind(['start', 'center', 'end']), flex: FLEX } },
  badge: { props: { text: PROP_KINDS.text, tone: PROP_KINDS.tone } },
  icon: { props: { name: enumKind(ICONS), path: PROP_KINDS.iconPath, tone: PROP_KINDS.tone, size: intKind(10, 48) } },
  rows: { props: { items: PROP_KINDS.rows, limit: intKind(1, LIMITS.rows) } },
  draw: { props: { label: PROP_KINDS.text, disabled: PROP_KINDS.boundBool, width: intKind(8, 640), height: intKind(8, 400), list: PROP_KINDS.draw, flex: FLEX } },
  spacer: { props: { size: intKind(0, 48), flex: FLEX } },
  divider: { props: {} }
});

function normalizeNode(raw, ctx, path, depth, errors) {
  if (!isObject(raw)) {
    errors.push(`${path}: node must be an object`);
    return null;
  }
  const spec = COMPONENTS[raw.type];
  if (!spec) {
    errors.push(`${path}: unknown component "${raw.type}"`);
    return null;
  }
  if (depth > LIMITS.depth) {
    errors.push(`${path}: nested too deeply`);
    return null;
  }
  ctx.nodes += 1;
  if (ctx.nodes > LIMITS.nodes) {
    if (ctx.nodes === LIMITS.nodes + 1) errors.push(`${path}: more than ${LIMITS.nodes} nodes`);
    return null;
  }
  const node = { type: raw.type };
  if (raw.motion !== undefined) {
    if (['inherit', 'none'].includes(raw.motion)) node.motion = raw.motion;
    else errors.push(`${path}.motion: expected inherit or none`);
  }
  for (const [name, kind] of Object.entries(spec.props)) {
    if (raw[name] === undefined) continue;
    const value = kind(raw[name], ctx, `${path}.${name}`, errors);
    if (value !== null && value !== undefined) node[name] = value;
  }
  if (CONTROLS.includes(node.type) || (node.type === 'draw' && raw.action !== undefined)) {
    if (ctx.interactive === false) errors.push(`${path}: interactive controls require main code`);
    if (typeof raw.action !== 'string' || !ACTION_RE.test(raw.action) || ctx.actions.has(raw.action)) errors.push(`${path}: needs a unique action identifier`);
    else { node.action = raw.action; ctx.actions.add(raw.action); }
    if (!node.label) errors.push(`${path}: interactive controls need a label`);
    if (node.type === 'select' && !node.options) errors.push(`${path}: select needs unique options`);
    if (node.type === 'slider') {
      if (['min', 'max', 'step'].some(name => node[name] !== undefined && typeof node[name] !== 'number')) {
        errors.push(`${path}: slider bounds must be literal numbers`);
        return null;
      }
      const min = node.min ?? 0, max = node.max ?? 100, step = node.step ?? 1;
      if (min >= max || min < -1e6 || max > 1e6 || step <= 0 || step > max - min) {
        errors.push(`${path}: invalid slider range`);
        return null;
      }
    }
  }
  if (spec.children) {
    const children = Array.isArray(raw.children) ? raw.children : [];
    node.children = Object.freeze(children
      .map((child, index) => normalizeNode(child, ctx, `${path}.children[${index}]`, depth + 1, errors))
      .filter(Boolean));
  }
  return Object.freeze(node);
}

function normalizeTree(raw, ctx, path, errors) {
  ctx.nodes = 0;
  ctx.actions = new Set();
  return normalizeNode(raw, ctx, path, 1, errors);
}

const VIEW_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

// ctx.metrics: the plugin's declared metric ids. Returns null when the view is
// unusable; recoverable problems are reported in `errors` and dropped.
function normalizeView(raw, ctx, errors) {
  if (!isObject(raw)) return null;
  const id = String(raw.id || '');
  const path = `views.${id || '?'}`;
  if (!VIEW_ID_RE.test(id)) {
    errors.push(`${path}: invalid view id`);
    return null;
  }
  const title = normalizeLocalized(raw.title, 48);
  if (!title) {
    errors.push(`${path}: title is required`);
    return null;
  }
  const local = { metrics: ctx.metrics, interactive: ctx.interactive, sources: new Set(), nodes: 0 };
  const surfaces = Array.isArray(raw.surfaces) ? [...new Set(raw.surfaces.filter((surface) => SURFACES.includes(surface)))] : [];
  if (!surfaces.length) {
    errors.push(`${path}: surfaces must name at least one of ${SURFACES.join(', ')}`);
    return null;
  }
  const layout = raw.layout === undefined ? null : normalizeTree(raw.layout, local, `${path}.layout`, errors);
  const layouts = {};
  if (isObject(raw.layouts)) {
    for (const surface of ['home', 'notch', 'edgeDock', 'page']) {
      if (raw.layouts[surface] === undefined) continue;
      const tree = normalizeTree(raw.layouts[surface], local, `${path}.layouts.${surface}`, errors);
      if (tree) layouts[surface] = tree;
    }
  }
  let compact = null;
  if (isObject(raw.compact)) {
    compact = {};
    for (const name of ['label', 'value', 'caption']) {
      if (raw.compact[name] === undefined) continue;
      const value = PROP_KINDS.text(raw.compact[name], local, `${path}.compact.${name}`, errors);
      if (value !== null) compact[name] = value;
    }
    if (raw.compact.tone !== undefined) {
      const tone = PROP_KINDS.tone(raw.compact.tone, local, `${path}.compact.tone`, errors);
      if (tone !== null) compact.tone = tone;
    }
    if (raw.compact.motion !== undefined) {
      if (['inherit', 'none'].includes(raw.compact.motion)) compact.motion = raw.compact.motion;
      else errors.push(`${path}.compact.motion: expected inherit or none`);
    }
    compact = Object.freeze(compact);
  }
  let tray = null;
  if (isObject(raw.tray)) {
    tray = {};
    if (raw.tray.text !== undefined) {
      const text = PROP_KINDS.text(raw.tray.text, local, `${path}.tray.text`, errors);
      if (text !== null) tray.text = text;
    }
    if (raw.tray.icon !== undefined && ICONS.includes(raw.tray.icon)) tray.icon = raw.tray.icon;
    if (raw.tray.draw !== undefined) {
      const draw = PROP_KINDS.draw(raw.tray.draw, local, `${path}.tray.draw`, errors);
      if (draw !== null) tray.draw = draw;
      tray.width = clampInt(raw.tray.width, 8, 120) ?? 32;
    }
    tray = Object.freeze(tray);
  }
  const missingLayout = surfaces.filter((surface) => (['home', 'notch', 'page'].includes(surface)) && !layouts[surface] && !layout);
  if (missingLayout.length) {
    errors.push(`${path}: a layout is required for ${missingLayout.join(', ')}`);
    return null;
  }
  if (surfaces.includes('edgeDock') && !compact && !layout && !layouts.edgeDock) {
    errors.push(`${path}: an edgeDock view needs compact or a layout`);
    return null;
  }
  if (surfaces.includes('tray') && !tray && !compact) {
    errors.push(`${path}: a tray view needs tray or compact`);
    return null;
  }
  return Object.freeze({
    id,
    title,
    icon: ICONS.includes(raw.icon) ? raw.icon : 'dot',
    surfaces: Object.freeze(surfaces),
    layout,
    layouts: Object.freeze(layouts),
    compact,
    tray,
    sources: Object.freeze([...local.sources].sort())
  });
}

// The tree a surface draws for a view, falling back to the shared layout.
function layoutFor(view, surface) {
  return view?.layouts?.[surface] || view?.layout || null;
}

module.exports = {
  COMPONENTS,
  FORMATS,
  ICONS,
  LIMITS,
  SOURCE_RE,
  SURFACES,
  TONES,
  isBinding,
  layoutFor,
  normalizeBinding,
  normalizeRows,
  normalizeView,
  sanitizeDisplayList
};
