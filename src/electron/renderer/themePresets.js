'use strict';

// Appearance theme data: interface palette presets and vendor-colour helpers.
// Pure data + functions so it can be unit-tested under node:test and shared by
// the widget and dashboard renderers. No DOM / Node built-ins here.
(function exposeThemePresets(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('../../shared/vendorPresentation') : root?.TokenMonitorVendorPresentation);
  if (node) module.exports = api;
  if (root) root.TokenMonitorThemePresets = api;
})(typeof window !== 'undefined' ? window : null, function createThemePresetsApi(vendorPresentation) {
  // The customisable interface colours, in display order. Each maps to a CSS
  // custom property on :root (see styles.css). `bg` drives the glass tint
  // (--glass-rgb, an "r, g, b" triplet); `text` also drives --number (the big
  // TOTAL figure) so it reads as plain text. Semantic status colours
  // (--success/--blue/--orange/--purple/--yellow/--red) stay independent from
  // both the interaction accent and the custom chart colour.
  const INTERFACE_COLOR_KEYS = ['accent', 'chart', 'bg', 'text', 'muted'];
  const LEGACY_THEME_CODE_KEYS = ['accent', 'bg', 'text', 'muted'];
  const THEME_CODE_KEYS = [...LEGACY_THEME_CODE_KEYS, 'chart'];
  const THEME_CODE_VERSION = 'TM2';

  const THEME_VAR_MAP = {
    accent: '--accent',
    chart: '--chart-color',
    bg: '--glass-rgb',
    text: '--text',
    muted: '--muted'
  };

  // Built-in defaults — must mirror the :root values in styles.css.
  // bg #303438 == rgb(48, 52, 56) (the --glass-rgb default).
  const DEFAULT_THEME = {
    accent: '#b7ead4',
    chart: '#73bdf5',
    bg: '#303438',
    text: '#eef5fb',
    muted: '#a3adbb'
  };

  // Curated one-click themes. Each is a full palette — accent + background tint
  // + text + muted swap together, so picking one changes the whole mood, not
  // just the accent. All stay dark (the stylesheet's overlays/borders assume a
  // dark base); a true light mode is a separate, larger piece of work. The
  // non-default themes borrow from well-known palettes for a familiar feel.
  // Three themes: the shipped graphite default (also the reset point), a
  // near-black "Carbon", and a light "Paper". Paper relies on the light-mode
  // flip in themeCssVarEntries() so borders/panels stay visible on a pale base.
  const THEME_PRESETS = [
    { id: 'default', colors: { ...DEFAULT_THEME } },
    { id: 'obsidian', colors: { accent: '#e6e8ec', chart: DEFAULT_THEME.chart, bg: '#0b0c0e', text: '#eceef2', muted: '#8f949c' } },
    { id: 'porcelain', colors: { accent: '#2563eb', chart: DEFAULT_THEME.chart, bg: '#f6f7f9', text: '#1c1f26', muted: '#5b626d' } }
  ];

  // Surface RGBs used when the background is light, so overlays/borders read as
  // subtle dark-on-light, the settings/tooltip card becomes a white card, and
  // sunken inputs/tracks become light grey — instead of staying dark.
  const LIGHT_OVERLAY_RGB = '15, 18, 24';
  const LIGHT_LINE_RGB = '24, 28, 36';
  const LIGHT_PANEL_RGB = '255, 255, 255';
  const LIGHT_SUNKEN_RGB = '188, 196, 206';
  const LIGHT_SUCCESS = '#18794e';
  const LIGHT_SUCCESS_RGB = '24, 121, 78';

  // Vendors shown in the vendor-colour list and their labels, from the vendor
  // presentation table (tracked clients first). Vendors not listed here but
  // present in clientColors are appended after these, then the synthetic
  // "default" fallback is shown last.
  const { VENDOR_IDS: VENDOR_ORDER, VENDOR_LABELS } = vendorPresentation;

  const HEX_RE = /^#[0-9a-fA-F]{6}$/;

  function isValidHex(value) {
    return typeof value === 'string' && HEX_RE.test(value.trim());
  }

  function normalizeHex(value) {
    return isValidHex(value) ? value.trim().toLowerCase() : null;
  }

  // Keep only valid hex entries from a stored overrides object, restricted to a
  // set of allowed keys. Returns a fresh object — safe to store as-is.
  function normalizeOverrides(overrides, allowedKeys) {
    const allowed = allowedKeys ? new Set(allowedKeys) : null;
    const out = {};
    if (!overrides || typeof overrides !== 'object') return out;
    for (const [key, value] of Object.entries(overrides)) {
      if (allowed && !allowed.has(key)) continue;
      const hex = normalizeHex(value);
      if (hex) out[key] = hex;
    }
    return out;
  }

  // Resolve the full interface palette: defaults with valid overrides applied.
  function mergeThemeColors(overrides) {
    const clean = normalizeOverrides(overrides, INTERFACE_COLOR_KEYS);
    return { ...DEFAULT_THEME, ...clean };
  }

  // TM1 keeps its original four-field order. Only a custom chart colour needs
  // TM2, whose fifth field carries it; untouched themes remain shareable with
  // older app versions. Importing TM1 restores the default chart palette.
  function encodeThemeCode(overrides) {
    const colors = mergeThemeColors(overrides);
    const customChart = colors.chart !== DEFAULT_THEME.chart;
    const keys = customChart ? THEME_CODE_KEYS : LEGACY_THEME_CODE_KEYS;
    const fields = keys.map((key) => colors[key].slice(1).toUpperCase());
    return `${customChart ? THEME_CODE_VERSION : 'TM1'}-${fields.join('-')}`;
  }

  function decodeThemeCode(value) {
    const code = typeof value === 'string' ? value.trim() : '';
    const version = /^TM(\d+)(?:-|$)/i.exec(code);
    if (version && !['1', '2'].includes(version[1])) return { ok: false, reason: 'unsupportedVersion' };

    const fields = code.split('-');
    const keys = version?.[1] === '2' ? THEME_CODE_KEYS : LEGACY_THEME_CODE_KEYS;
    if (!version || fields.length !== keys.length + 1 || fields.slice(1).some((field) => !/^[0-9a-f]{6}$/i.test(field))) {
      return { ok: false, reason: 'invalid' };
    }

    const colors = Object.fromEntries(
      keys.map((key, index) => [key, `#${fields[index + 1].toLowerCase()}`])
    );
    return { ok: true, colors, code: encodeThemeCode(colors) };
  }

  function hexToRgbTriplet(hex) {
    const v = String(hex).replace('#', '');
    return `${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}`;
  }

  // Perceived brightness (0–1). Used to decide whether a background needs the
  // light-mode overlay flip — true for white/pale backgrounds.
  function isLightHex(hex) {
    if (!isValidHex(hex)) return false;
    const v = hex.replace('#', '');
    const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
  }

  // The list of CSS custom properties to set for a given override set. A null
  // value means "remove the property" so it falls back to the stylesheet
  // default. Handles the two special cases: `bg` becomes an --glass-rgb triplet,
  // and `text` is mirrored onto --number (the big TOTAL figure). Both renderers
  // consume this so the mapping lives in exactly one place.
  function themeCssVarEntries(overrides) {
    const clean = normalizeOverrides(overrides, INTERFACE_COLOR_KEYS);
    const entries = [];
    for (const key of INTERFACE_COLOR_KEYS) {
      const value = clean[key] || null;
      if (key === 'chart') {
        // Clearing/default blue retains the exact shipped ramp and bar colour.
        const custom = value && value !== DEFAULT_THEME.chart ? value : null;
        entries.push({ name: '--chart-color', value: custom });
        entries.push({ name: '--chart-rgb', value: custom ? hexToRgbTriplet(custom) : null });
        entries.push({ name: '--chart-bar', value: custom });
        const rgb = custom ? hexToRgbTriplet(custom).split(', ').map(Number) : null;
        for (let level = 1; level <= 4; level += 1) {
          const tint = (level - 1) * 0.18;
          entries.push({
            name: `--chart-heat-${level}-rgb`,
            value: rgb ? rgb.map((channel) => Math.round(channel + (255 - channel) * tint)).join(', ') : null
          });
        }
        continue;
      }
      if (key === 'bg') {
        entries.push({ name: '--glass-rgb', value: value ? hexToRgbTriplet(value) : null });
        continue;
      }
      entries.push({ name: THEME_VAR_MAP[key], value });
      if (key === 'text') entries.push({ name: '--number', value });
      // Accent also drives --accent-rgb so the tinted borders / glows / active
      // states flip with it, not just the accent text colour.
      if (key === 'accent') entries.push({ name: '--accent-rgb', value: value ? hexToRgbTriplet(value) : null });
    }
    // Flip the overlay/border system + native control scheme when the resolved
    // background is light, so a white theme (or any light custom bg) doesn't
    // render with invisible borders and washed-out panels. Null falls back to
    // the dark :root defaults.
    const light = isLightHex(clean.bg);
    entries.push({ name: '--overlay-rgb', value: light ? LIGHT_OVERLAY_RGB : null });
    entries.push({ name: '--line-rgb', value: light ? LIGHT_LINE_RGB : null });
    entries.push({ name: '--panel-rgb', value: light ? LIGHT_PANEL_RGB : null });
    entries.push({ name: '--sunken-rgb', value: light ? LIGHT_SUNKEN_RGB : null });
    // Semantic success stays green regardless of the custom accent. Use a
    // darker green on pale themes so status text and borders keep their
    // contrast instead of inheriting the user's interaction colour.
    entries.push({ name: '--success', value: light ? LIGHT_SUCCESS : null });
    entries.push({ name: '--success-rgb', value: light ? LIGHT_SUCCESS_RGB : null });
    entries.push({ name: 'color-scheme', value: light ? 'light' : null });
    return entries;
  }

  // Resolve the effective vendor colours: brand defaults with valid overrides
  // applied. `brand` is the canonical clientColors map (incl. "default").
  function mergeVendorColors(brand, overrides) {
    const clean = normalizeOverrides(overrides, Object.keys(brand || {}));
    return { ...(brand || {}), ...clean };
  }

  // Ordered list of vendor ids to render in the picker, given the live brand
  // map. Known order first, then any extra brand keys, then "default" last.
  function orderedVendorIds(brand) {
    const keys = Object.keys(brand || {}).filter((k) => k !== 'default');
    const seen = new Set();
    const ordered = [];
    for (const id of VENDOR_ORDER) {
      if (keys.includes(id)) { ordered.push(id); seen.add(id); }
    }
    for (const id of keys) {
      if (!seen.has(id)) ordered.push(id);
    }
    if (Object.prototype.hasOwnProperty.call(brand || {}, 'default')) ordered.push('default');
    return ordered;
  }

  function vendorLabel(id) {
    return VENDOR_LABELS[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : id);
  }

  return {
    INTERFACE_COLOR_KEYS,
    THEME_CODE_VERSION,
    THEME_VAR_MAP,
    DEFAULT_THEME,
    THEME_PRESETS,
    VENDOR_ORDER,
    VENDOR_LABELS,
    isValidHex,
    normalizeHex,
    normalizeOverrides,
    mergeThemeColors,
    encodeThemeCode,
    decodeThemeCode,
    hexToRgbTriplet,
    isLightHex,
    themeCssVarEntries,
    mergeVendorColors,
    orderedVendorIds,
    vendorLabel
  };
});
