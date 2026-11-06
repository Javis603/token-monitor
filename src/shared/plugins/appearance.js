'use strict';
// Finite tokens only. Neither plugin presets nor imported styles carry CSS.
const OPTIONS = Object.freeze({ font: ['inherit', 'system', 'mono'], density: ['compact', 'standard', 'comfortable'], corners: ['square', 'rounded', 'soft'], panel: ['plain', 'outline', 'soft'] });
const DEFAULTS = Object.freeze({ font: 'inherit', density: 'standard', corners: 'rounded', panel: 'plain' });
const COLOR_KEYS = Object.freeze(['accent', 'chart', 'text', 'muted', 'background']);
function normalizeAppearance(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('style must be an object');
  const out = { ...DEFAULTS, colors: {} };
  for (const [key, choices] of Object.entries(OPTIONS)) {
    if (raw[key] !== undefined && !choices.includes(raw[key])) throw new Error(`unsupported style ${key}`);
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  if (raw.colors !== undefined && (!raw.colors || typeof raw.colors !== 'object' || Array.isArray(raw.colors))) throw new Error('style colors must be an object');
  for (const key of COLOR_KEYS) if (raw.colors?.[key] !== undefined) {
    if (typeof raw.colors[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(raw.colors[key])) throw new Error(`invalid style color ${key}`);
    out.colors[key] = raw.colors[key].toLowerCase();
  }
  return out;
}
module.exports = { OPTIONS, DEFAULTS, COLOR_KEYS, normalizeAppearance };
