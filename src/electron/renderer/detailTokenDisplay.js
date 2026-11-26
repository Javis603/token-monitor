'use strict';

(function exposeDetailTokenDisplay(root, factory) {
  const compactTokens = typeof module === 'object' && module.exports
    ? require('../../shared/compactTokens')
    : root?.TokenMonitorCompactTokens;
  const api = factory(compactTokens);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorDetailTokenDisplay = api;
})(typeof window !== 'undefined' ? window : null, function createDetailTokenDisplayApi(compactTokens) {
  // Transient exact-count override lives only in module memory so a renderer
  // reload or app restart always returns to the persisted compact setting.
  let transientExact = false;
  const boundElements = new WeakSet();

  function formatExactNumber(value) {
    const num = Number(value);
    return Math.round(Number.isFinite(num) ? num : 0).toLocaleString('en-US');
  }

  function defaultFormatCompact(value, unitSystem, locale) {
    return compactTokens.formatCompactTokens(
      value,
      compactTokens.effectiveCompactTokenUnits(unitSystem, locale),
      locale
    );
  }

  const providers = {
    isEnabled: () => false,
    getUnitSystem: () => 'western',
    getLocale: () => 'en',
    formatExact: formatExactNumber,
    formatCompact: defaultFormatCompact,
    onToggle: null
  };

  function configure(nextProviders = {}) {
    if (typeof nextProviders.isEnabled === 'function') providers.isEnabled = nextProviders.isEnabled;
    if (typeof nextProviders.getUnitSystem === 'function') providers.getUnitSystem = nextProviders.getUnitSystem;
    if (typeof nextProviders.getLocale === 'function') providers.getLocale = nextProviders.getLocale;
    if (typeof nextProviders.formatExact === 'function') providers.formatExact = nextProviders.formatExact;
    if (typeof nextProviders.formatCompact === 'function') providers.formatCompact = nextProviders.formatCompact;
    if (nextProviders.onToggle === null || typeof nextProviders.onToggle === 'function') {
      providers.onToggle = nextProviders.onToggle;
    }
  }

  function isEnabled(options) {
    if (options && Object.prototype.hasOwnProperty.call(options, 'enabled')) {
      return options.enabled === true;
    }
    return providers.isEnabled() === true;
  }

  function isTransientExact() {
    return transientExact;
  }

  function isCompactActive(options) {
    return isEnabled(options) && !transientExact;
  }

  function formatDetailTokens(value, options) {
    if (!isCompactActive(options)) return providers.formatExact(value);
    const locale = options && Object.prototype.hasOwnProperty.call(options, 'locale')
      ? options.locale
      : providers.getLocale();
    const rawUnitSystem = options && Object.prototype.hasOwnProperty.call(options, 'unitSystem')
      ? options.unitSystem
      : providers.getUnitSystem();
    const unitSystem = compactTokens.effectiveCompactTokenUnits(rawUnitSystem, locale);
    return providers.formatCompact(value, unitSystem, locale);
  }

  function toggleTransientExact() {
    transientExact = !transientExact;
    if (typeof providers.onToggle === 'function') providers.onToggle(transientExact);
    return transientExact;
  }

  function reset() {
    transientExact = false;
    return transientExact;
  }

  function stateSignature(options) {
    const enabled = isEnabled(options);
    const locale = options && Object.prototype.hasOwnProperty.call(options, 'locale')
      ? options.locale
      : providers.getLocale();
    const rawUnitSystem = options && Object.prototype.hasOwnProperty.call(options, 'unitSystem')
      ? options.unitSystem
      : providers.getUnitSystem();
    const unitSystem = compactTokens.effectiveCompactTokenUnits(rawUnitSystem, locale);
    return `${enabled ? '1' : '0'}:${transientExact ? '1' : '0'}:${unitSystem}:${locale || ''}`;
  }

  function bindElementOnce(el) {
    if (!el || boundElements.has(el) || typeof el.addEventListener !== 'function') return;
    boundElements.add(el);
    el.addEventListener('click', (event) => {
      if (el.dataset?.detailTokenToggle !== 'true') return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      toggleTransientExact();
    });
    el.addEventListener('keydown', (event) => {
      if (el.dataset?.detailTokenToggle !== 'true') return;
      if (event?.key !== 'Enter' && event?.key !== ' ') return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      toggleTransientExact();
    });
  }

  function decorateTokenElement(el, exactText, options = {}) {
    if (!el) return;
    // Reconciliation retains the original element and its listeners when settings change.
    bindElementOnce(el);
    if (!isEnabled(options)) {
      el.classList?.remove('detail-token-toggle');
      if (el.dataset) delete el.dataset.detailTokenToggle;
      el.removeAttribute?.('role');
      el.removeAttribute?.('tabindex');
      el.removeAttribute?.('aria-pressed');
      el.removeAttribute?.('title');
      el.removeAttribute?.('aria-label');
      return;
    }
    const compact = !transientExact;
    el.classList?.add('detail-token-toggle');
    if (el.dataset) el.dataset.detailTokenToggle = 'true';
    el.setAttribute?.('role', 'button');
    el.setAttribute?.('tabindex', '0');
    el.setAttribute?.('aria-pressed', String(transientExact));
    const tooltip = compact
      ? (options.exactHint || 'Click for exact count')
      : (options.compactHint || 'Click for compact units');
    el.setAttribute?.('title', tooltip);
    if (compact) {
      el.setAttribute?.('aria-label', String(exactText));
    } else {
      el.removeAttribute?.('aria-label');
    }
  }

  return {
    configure,
    decorateTokenElement,
    formatDetailTokens,
    formatExactNumber,
    isCompactActive,
    isEnabled,
    isTransientExact,
    reset,
    stateSignature,
    toggleTransientExact
  };
});
