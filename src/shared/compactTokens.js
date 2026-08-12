'use strict';

(function exposeCompactTokens(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCompactTokens = api;
})(typeof window !== 'undefined' ? window : null, function createCompactTokensApi() {
  const WESTERN_UNITS = [
    { divisor: 1e3, suffix: 'K' },
    { divisor: 1e6, suffix: 'M' },
    { divisor: 1e9, suffix: 'B' }
  ];

  function normalizeCompactTokenUnits(value) {
    return value === 'localized' ? 'localized' : 'western';
  }

  function normalizedLocale(locale) {
    return String(locale || '').replace(/_/g, '-').toLowerCase();
  }

  function supportsLocalizedCompactTokenUnits(locale) {
    return /^(zh|ja|ko)(?:-|$)/.test(normalizedLocale(locale));
  }

  function effectiveCompactTokenUnits(unitSystem, locale) {
    const normalized = normalizeCompactTokenUnits(unitSystem);
    return normalized === 'localized' && supportsLocalizedCompactTokenUnits(locale)
      ? 'localized'
      : 'western';
  }

  function localizedSuffixes(locale) {
    const language = normalizedLocale(locale);
    if (language.startsWith('ko')) return ['만', '억'];
    const isSimplifiedChinese = language.startsWith('zh-hans')
      || /^(?:zh)(?:-[a-z0-9]+)*-(?:cn|sg|my)(?:-|$)/.test(language);
    if (isSimplifiedChinese) return ['万', '亿'];
    if (language.startsWith('ja')) return ['万', '億'];
    return ['萬', '億'];
  }

  function unitsFor(unitSystem, locale) {
    if (effectiveCompactTokenUnits(unitSystem, locale) !== 'localized') return WESTERN_UNITS;
    const [tenThousand, hundredMillion] = localizedSuffixes(locale);
    return [
      { divisor: 1e4, suffix: tenThousand },
      { divisor: 1e8, suffix: hundredMillion }
    ];
  }

  function decimalsFor(unitSystem, unitIndex, scaled, options = {}) {
    if (options.fractionDigits !== null && options.fractionDigits !== '') {
      const requested = Number(options.fractionDigits);
      if (Number.isFinite(requested)) return Math.max(0, Math.min(4, Math.round(requested)));
    }
    if (unitSystem === 'localized') return Math.abs(scaled) < 10 ? 2 : 1;
    if (options.style === 'tray') return unitIndex === 2 ? 2 : 1;
    return 1;
  }

  function formatCompactValue(value, unitSystem = 'western', locale = 'en', options = {}) {
    const requested = normalizeCompactTokenUnits(unitSystem);
    const effective = effectiveCompactTokenUnits(requested, locale);
    const num = Number(value || 0);
    const abs = Math.abs(num);
    const units = unitsFor(effective, locale);
    let unitIndex = -1;
    for (let index = units.length - 1; index >= 0; index -= 1) {
      if (abs >= units[index].divisor) {
        unitIndex = index;
        break;
      }
    }
    if (unitIndex < 0) {
      const requestedDigits = Number(options.fractionDigits);
      if (options.fractionDigits !== null
        && options.fractionDigits !== ''
        && Number.isFinite(requestedDigits)) {
        return num.toFixed(Math.max(0, Math.min(4, Math.round(requestedDigits))));
      }
      return String(num);
    }

    const formatScaled = () => {
      const scaled = num / units[unitIndex].divisor;
      const digits = decimalsFor(effective, unitIndex, scaled, options);
      return scaled.toFixed(digits);
    };
    let display = formatScaled();
    const promotionBoundary = effective === 'localized' ? 10000 : 1000;
    if (Math.abs(Number(display)) >= promotionBoundary && unitIndex < units.length - 1) {
      unitIndex += 1;
      display = formatScaled();
    }

    const keepTrailingZeros = options.keepTrailingZeros === true
      || (options.style === 'tray' && effective === 'western');
    if (!keepTrailingZeros) display = display.replace(/\.?0+$/, '');
    return `${display}${units[unitIndex].suffix}`;
  }

  function formatCompactTokens(value, unitSystem = 'western', locale = 'en', options = {}) {
    return formatCompactValue(Math.round(Number(value || 0)), unitSystem, locale, options);
  }

  function compactTokenUnitThreshold(unitSystem, locale) {
    return effectiveCompactTokenUnits(unitSystem, locale) === 'localized' ? 1e4 : 1e3;
  }

  return {
    compactTokenUnitThreshold,
    effectiveCompactTokenUnits,
    formatCompactTokens,
    formatCompactValue,
    normalizeCompactTokenUnits,
    supportsLocalizedCompactTokenUnits
  };
});
