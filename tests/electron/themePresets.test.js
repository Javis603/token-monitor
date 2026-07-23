'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
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
} = require('../../src/electron/renderer/themePresets');

const { clientColors } = require('../../src/electron/renderer/usageCharts');

test('interface palette is the four always-visible colours, each mapped to a CSS variable', () => {
  assert.deepEqual(INTERFACE_COLOR_KEYS, ['accent', 'bg', 'text', 'muted']);
  // Semantic status colours are intentionally not customisable.
  for (const dead of ['success', 'blue', 'orange', 'purple', 'yellow', 'red']) {
    assert.ok(!INTERFACE_COLOR_KEYS.includes(dead), `${dead} should not be customisable`);
  }
  for (const key of INTERFACE_COLOR_KEYS) {
    assert.ok(THEME_VAR_MAP[key], `missing CSS var for ${key}`);
    assert.ok(isValidHex(DEFAULT_THEME[key]), `default for ${key} is not hex`);
  }
  // bg default must equal the --glass-rgb default (48, 52, 56).
  assert.equal(hexToRgbTriplet(DEFAULT_THEME.bg), '48, 52, 56');
});

test('semantic success states stay independent from the custom accent', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/styles.css'), 'utf8');
  const semanticSelectors = [
    '.export-status-pill.is-active',
    '.hub-status.ok',
    '.tokscale-message.success',
    '.tool-status-tag-ok',
    '.theme-code-status.success',
    '.refresh-button.is-refreshed',
    '.service-status-ok .service-status-pill'
  ];

  for (const selector of semanticSelectors) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
    assert.match(rule, /var\(--success(?:-rgb)?\)/, `${selector} should use semantic success`);
    assert.doesNotMatch(rule, /var\(--accent(?:-rgb)?\)/, `${selector} should not inherit the custom accent`);
  }
});

test('presence and current-account indicators follow the custom accent', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/styles.css'), 'utf8');
  for (const selector of ['.live-dot.live', '.limit-live-badge']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
    assert.match(rule, /var\(--accent(?:-rgb)?\)/, `${selector} should follow the custom accent`);
    assert.doesNotMatch(rule, /var\(--success(?:-rgb)?\)/, `${selector} should not imply success`);
  }
});

test('device provenance tags use informational colours instead of state colours', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/styles.css'), 'utf8');
  const ruleFor = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
  };

  const local = ruleFor('.limit-provider-tag-local');
  assert.match(local, /color:\s*var\(--muted\)/);
  assert.doesNotMatch(local, /var\(--(?:accent|success|yellow)(?:-rgb)?\)/);

  for (const selector of ['.limit-provider-tag-remote', '.limit-provider-tag-multi']) {
    const rule = ruleFor(selector);
    assert.match(rule, /color:\s*var\(--blue\)/, `${selector} should be informational`);
    assert.doesNotMatch(rule, /var\(--(?:accent|success|yellow)(?:-rgb)?\)/, `${selector} should not imply selection, success, or warning`);
  }
});

test('hexToRgbTriplet converts hex to a CSS rgb triplet', () => {
  assert.equal(hexToRgbTriplet('#000000'), '0, 0, 0');
  assert.equal(hexToRgbTriplet('#ffffff'), '255, 255, 255');
  assert.equal(hexToRgbTriplet('303438'), '48, 52, 56');
});

test('themeCssVarEntries maps bg to --glass-rgb and mirrors text onto --number', () => {
  const byName = (entries) => Object.fromEntries(entries.map((e) => [e.name, e.value]));

  // No overrides -> every property is cleared (null), incl. the two specials.
  const cleared = byName(themeCssVarEntries({}));
  assert.equal(cleared['--glass-rgb'], null);
  assert.equal(cleared['--text'], null);
  assert.equal(cleared['--number'], null);

  const set = byName(themeCssVarEntries({ bg: '#101010', text: '#abcdef', accent: '#112233' }));
  assert.equal(set['--glass-rgb'], '16, 16, 16'); // bg becomes a triplet
  assert.equal(set['--text'], '#abcdef');
  assert.equal(set['--number'], '#abcdef'); // big TOTAL figure follows text
  assert.equal(set['--accent'], '#112233'); // accent maps to the interaction token
  assert.equal(set['--accent-rgb'], '17, 34, 51'); // accent also flips the tints
  assert.equal(cleared['--accent-rgb'], null); // absent accent -> :root default
  assert.equal(set['--success'], null); // dark-theme success never inherits accent
});

test('isLightHex detects pale backgrounds', () => {
  assert.equal(isLightHex('#f6f7f9'), true);
  assert.equal(isLightHex('#ffffff'), true);
  assert.equal(isLightHex('#303438'), false); // graphite default
  assert.equal(isLightHex('#0b0c0e'), false); // carbon
  assert.equal(isLightHex('not-a-hex'), false);
});

test('themeCssVarEntries flips the overlay/border system for light backgrounds', () => {
  const byName = (entries) => Object.fromEntries(entries.map((e) => [e.name, e.value]));

  // Dark bg -> surface vars cleared to the dark :root defaults.
  const dark = byName(themeCssVarEntries({ bg: '#0b0c0e' }));
  for (const name of ['--overlay-rgb', '--line-rgb', '--panel-rgb', '--sunken-rgb', '--success', '--success-rgb', 'color-scheme']) {
    assert.equal(dark[name], null, `${name} should be cleared on a dark bg`);
  }

  // Light bg -> dark overlays/borders, a white card surface, light sunken
  // tracks, and the light native control scheme.
  const light = byName(themeCssVarEntries({ bg: '#f6f7f9' }));
  assert.equal(light['--overlay-rgb'], '15, 18, 24');
  assert.equal(light['--line-rgb'], '24, 28, 36');
  assert.equal(light['--panel-rgb'], '255, 255, 255');
  assert.equal(light['--sunken-rgb'], '188, 196, 206');
  assert.equal(light['--success'], '#18794e');
  assert.equal(light['--success-rgb'], '24, 121, 78');
  assert.equal(light['color-scheme'], 'light');

  // No bg override resolves to the dark default, so no flip.
  assert.equal(byName(themeCssVarEntries({})) ['color-scheme'], null);
});

test('every preset is a full palette of valid hex for all four keys', () => {
  for (const preset of THEME_PRESETS) {
    assert.ok(preset.id, 'preset missing id');
    assert.deepEqual(Object.keys(preset.colors).sort(), [...INTERFACE_COLOR_KEYS].sort(), `${preset.id} is not a full palette`);
    for (const key of INTERFACE_COLOR_KEYS) {
      assert.ok(isValidHex(preset.colors[key]), `${preset.id}.${key} is not hex`);
    }
  }
});

test('the default preset is first and equals the documented defaults', () => {
  assert.equal(THEME_PRESETS[0].id, 'default');
  assert.deepEqual(THEME_PRESETS[0].colors, DEFAULT_THEME);
});

test('isValidHex / normalizeHex', () => {
  assert.equal(isValidHex('#aabbcc'), true);
  assert.equal(isValidHex('#ABC'), false); // shorthand not accepted
  assert.equal(isValidHex('aabbcc'), false);
  assert.equal(isValidHex('#zzzzzz'), false);
  assert.equal(isValidHex(123), false);
  assert.equal(normalizeHex('  #AABBCC '), '#aabbcc');
  assert.equal(normalizeHex('nope'), null);
});

test('normalizeOverrides drops invalid values and disallowed keys', () => {
  const out = normalizeOverrides(
    { accent: '#AABBCC', text: 'bad', bogus: '#ffffff' },
    INTERFACE_COLOR_KEYS
  );
  assert.deepEqual(out, { accent: '#aabbcc' });
  assert.deepEqual(normalizeOverrides(null, INTERFACE_COLOR_KEYS), {});
});

test('mergeThemeColors layers valid overrides on defaults', () => {
  const merged = mergeThemeColors({ accent: '#111111', text: 'invalid' });
  assert.equal(merged.accent, '#111111');
  assert.equal(merged.text, DEFAULT_THEME.text); // invalid override ignored
  assert.equal(merged.muted, DEFAULT_THEME.muted); // absent key falls back
});

test('TM1 theme codes round-trip the four interface colours in a stable order', () => {
  assert.equal(THEME_CODE_VERSION, 'TM1');
  const code = encodeThemeCode({
    accent: '#112233',
    bg: '#445566',
    text: '#AABBCC',
    muted: '#778899'
  });
  assert.equal(code, 'TM1-112233-445566-AABBCC-778899');
  assert.deepEqual(decodeThemeCode(code), {
    ok: true,
    code,
    colors: {
      accent: '#112233',
      bg: '#445566',
      text: '#aabbcc',
      muted: '#778899'
    }
  });
});

test('TM1 theme codes normalize input and reject malformed or future versions', () => {
  assert.equal(
    decodeThemeCode('  tm1-b7ead4-303438-eef5fb-a3adbb  ').code,
    'TM1-B7EAD4-303438-EEF5FB-A3ADBB'
  );
  assert.deepEqual(decodeThemeCode('TM1-not-a-theme'), { ok: false, reason: 'invalid' });
  assert.deepEqual(decodeThemeCode('TM2-B7EAD4-303438-EEF5FB-A3ADBB'), { ok: false, reason: 'unsupportedVersion' });
  assert.deepEqual(decodeThemeCode(''), { ok: false, reason: 'invalid' });
});

test('mergeVendorColors overrides brand defaults, ignoring junk', () => {
  const brand = { claude: '#cc7c5e', codex: '#49a3b0', default: '#6ab4f0' };
  assert.deepEqual(mergeVendorColors(brand, {}), brand);
  assert.deepEqual(
    mergeVendorColors(brand, { claude: '#000000', unknown: '#fff000', codex: 'bad' }),
    { claude: '#000000', codex: '#49a3b0', default: '#6ab4f0' }
  );
});

test('empty overrides resolve to exactly the live brand colours', () => {
  assert.deepEqual(mergeVendorColors(clientColors, {}), clientColors);
  assert.deepEqual(mergeVendorColors(clientColors, undefined), { ...clientColors });
});

test('orderedVendorIds covers every brand key once, tracked first, default last', () => {
  const ordered = orderedVendorIds(clientColors);
  const brandKeys = Object.keys(clientColors);
  assert.equal(ordered.length, brandKeys.length);
  assert.deepEqual([...ordered].sort(), [...brandKeys].sort());
  assert.equal(new Set(ordered).size, ordered.length, 'no duplicates');
  assert.equal(ordered[0], 'claude', 'tracked client comes first');
  assert.equal(ordered[ordered.length - 1], 'default', 'default fallback last');
});

test('every non-default brand vendor has a display label', () => {
  for (const id of Object.keys(clientColors)) {
    if (id === 'default') continue;
    assert.ok(VENDOR_LABELS[id], `no label for vendor ${id}`);
  }
  assert.equal(vendorLabel('claude'), 'Claude Code');
  assert.equal(vendorLabel('somethingnew'), 'Somethingnew'); // graceful fallback
});

test('Kimi usage and limits share one vendor color entry', () => {
  assert.equal(VENDOR_ORDER.filter((id) => id === 'kimi').length, 1);
  assert.equal(clientColors.kimi, '#16191e');
});
