'use strict';

// Appearance theme data: interface palette presets and vendor-colour helpers.
// Pure data + functions so it can be unit-tested under node:test and shared by
// the widget and dashboard renderers. No DOM / Node built-ins here.
(function exposeThemePresets(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorThemePresets = api;
})(typeof window !== 'undefined' ? window : null, function createThemePresetsApi() {
  // The customisable interface colours, in display order. Each maps to a CSS
  // custom property on :root (see styles.css). `bg` drives the glass tint
  // (--glass-rgb, an "r, g, b" triplet); `text` also drives --number (the big
  // TOTAL figure) so it reads as plain text. The semantic status colours
  // (--blue/--orange/--purple/--yellow/--red) are intentionally NOT exposed:
  // they only surface in edge states (links, warnings, errors) and --purple is
  // unused entirely, so a picker for them would be a no-op for everyday use.
  const INTERFACE_COLOR_KEYS = ['accent', 'bg', 'text', 'muted'];

  const THEME_VAR_MAP = {
    accent: '--green',
    bg: '--glass-rgb',
    text: '--text',
    muted: '--muted'
  };

  // Built-in defaults — must mirror the :root values in styles.css.
  // bg #303438 == rgb(48, 52, 56) (the --glass-rgb default).
  const DEFAULT_THEME = {
    accent: '#b7ead4',
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
    { id: 'obsidian', colors: { accent: '#e6e8ec', bg: '#0b0c0e', text: '#eceef2', muted: '#8f949c' } },
    { id: 'porcelain', colors: { accent: '#2563eb', bg: '#f6f7f9', text: '#1c1f26', muted: '#5b626d' } }
  ];

  // Surface RGBs used when the background is light, so overlays/borders read as
  // subtle dark-on-light, the settings/tooltip card becomes a white card, and
  // sunken inputs/tracks become light grey — instead of staying dark.
  const LIGHT_OVERLAY_RGB = '15, 18, 24';
  const LIGHT_LINE_RGB = '24, 28, 36';
  const LIGHT_PANEL_RGB = '255, 255, 255';
  const LIGHT_SUNKEN_RGB = '188, 196, 206';
  const LIGHT_HEAT_VARS = {
    '--heat-base-empty': 'rgba(236, 242, 247, 0.88)',
    '--heat-base-1': 'rgba(214, 231, 241, 1)',
    '--heat-base-2': 'rgba(177, 214, 235, 1)',
    '--heat-base-3': 'rgba(122, 188, 220, 1)',
    '--heat-base-4': 'rgba(84, 156, 194, 1)',
    '--heat-ambient-layer-opacity': '0.16',
    '--heat-ambient-hover-opacity': '0.1',
    '--heat-ambient-empty': 'rgba(250, 252, 253, 0.42)',
    '--heat-ambient-1': 'rgba(240, 246, 250, 0.48)',
    '--heat-ambient-2': 'rgba(224, 238, 247, 0.54)',
    '--heat-ambient-3': 'rgba(194, 222, 239, 0.62)',
    '--heat-ambient-4': 'rgba(162, 204, 229, 0.7)',
    '--heat-focus-hover-opacity': '0.62',
    '--heat-focus-empty': 'rgba(255, 255, 255, 0.12)',
    '--heat-focus-1': 'rgba(245, 249, 251, 0.18)',
    '--heat-focus-2': 'rgba(228, 240, 247, 0.28)',
    '--heat-focus-3': 'rgba(195, 221, 238, 0.42)',
    '--heat-focus-4': 'rgba(152, 198, 226, 0.56)',
    '--heat-bright-empty': 'rgba(255, 255, 255, 0.08)',
    '--heat-bright-1': 'rgba(248, 250, 252, 0.14)',
    '--heat-bright-2': 'rgba(233, 242, 248, 0.22)',
    '--heat-bright-3': 'rgba(206, 228, 242, 0.34)',
    '--heat-bright-4': 'rgba(164, 207, 230, 0.46)',
    '--heat-hover-fill': 'rgba(244, 250, 255, 0.98)',
    '--heat-hover-stroke': 'rgba(120, 176, 214, 0.22)',
    '--heat-hover-shadow': '0 5px 12px rgba(88, 149, 193, 0.1)'
  };

  // Vendors shown in the vendor-colour list, tracked clients first. Vendors not
  // listed here but present in clientColors are appended after these, then the
  // synthetic "default" fallback is shown last.
  const VENDOR_ORDER = [
    'claude', 'codex', 'hermes', 'opencode', 'openclaw', 'cline', 'cursor',
    'gemini', 'antigravity', 'kimi', 'qwen', 'grok', 'copilot', 'pi', 'zed', 'kilocode', 'micode', 'zcode', 'kiro', 'codebuddy', 'workbuddy', 'deepseek', 'xai', 'meta', 'mistral',
    'moonshot', 'zai', 'cohere', 'xiaomi', 'minimax', 'doubao', 'volcengine', 'qoder'
  ];

  // Display labels for every vendor in the clientColors map. The widget also
  // has its own clientLabels for tracked clients; this map is the complete set
  // so the appearance picker is self-contained.
  const VENDOR_LABELS = {
    claude: 'Claude Code',
    codex: 'Codex',
    hermes: 'Hermes',
    opencode: 'OpenCode',
    openclaw: 'OpenClaw',
    cline: 'Cline',
    cursor: 'Cursor',
    gemini: 'Gemini',
    antigravity: 'Antigravity',
    kimi: 'Kimi',
    grok: 'Grok Build',
    copilot: 'GitHub Copilot',
    pi: 'Pi',
    zed: 'Zed',
    kilocode: 'Kilo Code',
    micode: 'MiMo Code',
    zcode: 'ZCode',
    kiro: 'Kiro',
    codebuddy: 'CodeBuddy',
    workbuddy: 'WorkBuddy',
    deepseek: 'DeepSeek',
    xai: 'xAI',
    meta: 'Meta',
    mistral: 'Mistral',
    qwen: 'Qwen',
    moonshot: 'Moonshot',
    zai: 'GLM',
    cohere: 'Cohere',
    xiaomi: 'Xiaomi',
    minimax: 'MiniMax',
    doubao: 'Doubao',
    volcengine: 'Volcengine',
    qoder: 'Qoder',
    default: 'Default'
  };

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
    for (const [name, value] of Object.entries(LIGHT_HEAT_VARS)) {
      entries.push({ name, value: light ? value : null });
    }
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
    THEME_VAR_MAP,
    DEFAULT_THEME,
    THEME_PRESETS,
    VENDOR_ORDER,
    VENDOR_LABELS,
    isValidHex,
    normalizeHex,
    normalizeOverrides,
    mergeThemeColors,
    hexToRgbTriplet,
    isLightHex,
    themeCssVarEntries,
    mergeVendorColors,
    orderedVendorIds,
    vendorLabel
  };
});
