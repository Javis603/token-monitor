'use strict';

// Resolves a validated view tree against current Data Bus readings. The result
// is plain data (strings, numbers, arrays, display lists) that any surface can
// draw without knowing about sources, permissions or formats.

const { localize } = require('./localized');
const { pickField } = require('./dataBus');

const ROLES = Object.freeze({
  button: { label: 'text', tone: 'tone', disabled: 'bool' },
  toggle: { label: 'text', value: 'bool', disabled: 'bool' },
  slider: { label: 'text', value: 'number', disabled: 'bool' },
  select: { label: 'text', value: 'text', options: 'options', disabled: 'bool' },
  input: { label: 'text', value: 'input', placeholder: 'text', disabled: 'bool' },
  stat: { label: 'text', value: 'text', unit: 'text', caption: 'text', tone: 'tone' },
  meter: { value: 'number', label: 'text', caption: 'text', tone: 'tone' },
  ring: { value: 'number', label: 'text', caption: 'text', tone: 'tone' },
  sparkline: { series: 'series', tone: 'tone', min: 'number', max: 'number' },
  bars: { series: 'series', tone: 'tone', min: 'number', max: 'number' },
  text: { text: 'text', tone: 'tone' },
  badge: { text: 'text', tone: 'tone' },
  icon: { tone: 'tone' },
  rows: { items: 'rows' },
  draw: { list: 'draw', label: 'text', disabled: 'bool' }
});

const { finite, formatNumber, formatDuration, formatValue: formatResolvedValue } = require('./numberFormat');

function formatValue(value, binding = {}, locale = 'en') {
  return formatResolvedValue(value, { ...binding, unit: binding.unit ? localize(binding.unit, locale) : '' }, locale);
}

function toneFor(value, steps) {
  const number = finite(value);
  if (number === null) return 'muted';
  let tone = 'default';
  for (const [threshold, stepTone] of steps) if (number >= threshold) tone = stepTone;
  return tone;
}

// read(sourceId) → { value, at } | null; history(sourceId, count, field) → [].
// `@metric` sources resolve inside the plugin's own namespace.
function createResolver({ read, history, historyPoints = () => [], sourceInterval = () => 2000, pluginId, locale = 'en', sanitizeDraw = (list) => list, sanitizeRows = (rows) => rows, budget = { bytes: 256 * 1024, draws: 800, nodes: 200 } }) {
  function spend(value, draws = 0) {
    // Count the expanded value, including repeated references to one metric.
    budget.bytes -= (JSON.stringify(value)?.length || 0) * 3;
    budget.draws -= draws;
    if (budget.bytes < 0 || budget.draws < 0) throw new Error('expanded plugin view exceeds its render budget');
    return value;
  }
  function sourceId(binding) {
    return binding.$.startsWith('@') ? `plugin.${pluginId}.${binding.$.slice(1)}` : binding.$;
  }

  function raw(binding) {
    const id = sourceId(binding);
    if (binding.history) return history(id, binding.history, binding.field || '');
    const reading = read(id);
    let value = reading ? reading.value : undefined;
    if (binding.field) value = pickField(value, binding.field);
    if (finite(value) !== null && binding.scale !== undefined) value *= binding.scale;
    return value === undefined ? null : value;
  }

  function resolveProp(role, value) {
    const bound = value && typeof value === 'object' && !Array.isArray(value) && typeof value.$ === 'string';
    if (role === 'text') {
      if (!bound) return typeof value === 'number' ? formatNumber(value, locale) : localize(value, locale);
      return formatValue(raw(value), value, locale);
    }
    if (role === 'input') {
      const input = bound ? raw(value) : localize(value, locale);
      return typeof input === 'string' ? input.slice(0, 1024) : '';
    }
    if (role === 'bool') return (bound ? raw(value) : value) === true;
    if (role === 'options') return value.map(option => ({ value: option.value, label: localize(option.label, locale) }));
    if (role === 'number') {
      const number = finite(bound ? raw(value) : value);
      return number;
    }
    if (role === 'series') {
      const series = bound ? raw(value) : value;
      return Array.isArray(series) ? series.map((entry) => finite(entry)) : [];
    }
    if (role === 'tone') {
      if (!bound) return value;
      return toneFor(raw(value), value.steps || []);
    }
    if (role === 'draw') {
      const list = bound ? sanitizeDraw(raw(value)) : value;
      return spend(list, Array.isArray(list) ? list.length : 0);
    }
    if (role === 'rows') {
      return spend(bound ? sanitizeRows(raw(value)) : value);
    }
    return value;
  }

  function numberFormat(value) {
    const binding = value && typeof value === 'object' ? value : {};
    return { locale, fmt: binding.fmt || 'number', digits: binding.digits, unit: binding.unit ? localize(binding.unit, locale) : '' };
  }

  function resolveNode(node) {
    if (!node) return null;
    if (--budget.nodes < 0) throw new Error('expanded plugin view exceeds its node budget');
    const roles = ROLES[node.type] || {};
    const out = { type: node.type };
    for (const [name, value] of Object.entries(node)) {
      if (name === 'type' || name === 'children') continue;
      out[name] = roles[name] ? resolveProp(roles[name], value) : value;
      if (!['draw', 'rows'].includes(roles[name])) spend(out[name]);
    }
    if (node.type === 'sparkline' && node.smooth && node.series?.history && node.series.$) {
      out.seriesPoints = spend(historyPoints(sourceId(node.series), node.series.history, node.series.field || '').map(p => ({ at: p.at, value: p.value })));
      out.seriesIntervalMs = Math.max(250, Math.min(60000, sourceInterval(sourceId(node.series)) || 2000));
    }
    if (node.type === 'stat') {
      const number = resolveProp('number', node.value);
      if (number !== null) { out.valueNumber = number; out.valueFormat = spend(numberFormat(node.value)); }
    }
    if (node.type === 'ring' && node.caption && typeof node.caption === 'object' && typeof node.caption.$ === 'string') {
      const number = resolveProp('number', node.caption);
      if (number !== null) { out.captionNumber = number; out.captionFormat = spend(numberFormat(node.caption)); }
    }
    if (node.children) out.children = node.children.map(resolveNode).filter(Boolean);
    return out;
  }

  function resolveCompact(compact) {
    if (!compact) return null;
    const out = {};
    for (const name of ['label', 'value', 'caption']) {
      if (compact[name] !== undefined) out[name] = resolveProp('text', compact[name]);
    }
    const valueNumber = resolveProp('number', compact.value);
    if (valueNumber !== null) { out.valueNumber = valueNumber; out.valueFormat = numberFormat(compact.value); }
    if (compact.motion !== undefined) out.motion = compact.motion;
    if (compact.tone !== undefined) out.tone = resolveProp('tone', compact.tone);
    return out;
  }

  function resolveTray(tray) {
    if (!tray) return null;
    const out = { width: tray.width };
    if (tray.text !== undefined) out.text = resolveProp('text', tray.text);
    if (tray.icon) out.icon = tray.icon;
    if (tray.draw !== undefined) out.draw = resolveProp('draw', tray.draw);
    return out;
  }

  return { raw, resolveNode, resolveCompact, resolveTray, resolveProp, sourceId };
}

module.exports = { ROLES, createResolver, formatDuration, formatValue, toneFor };
