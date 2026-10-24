'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginRailNumbers = api;
})(typeof window !== 'undefined' ? window : null, () => {
  function create({ railNumbers, animation, viewFor, enabled, mode = () => 'roll', numberFormat }) {
    const roller = railNumbers.create({ animation, selector: '[data-plugin-roll]', mode });
    function mark(container) {
      for (const cell of container?.querySelectorAll('[data-plugin-ref]') || []) {
        const value = cell.querySelector('.pv-compact-value');
        if (!value) continue;
        const view = viewFor(cell.dataset.pluginRef), compact = view?.compact;
        // Never parse formatted strings: a label/ID with digits is not a reading.
        if (view?.status === 'ok' && compact?.motion !== 'none' && Number.isFinite(compact?.valueNumber)) {
          value.dataset.pluginRoll = '';
          railNumbers.mark(value, `plugin:${cell.dataset.pluginRef}:${view.revision}:value`, compact.valueNumber, numberFormat && compact.valueFormat ? number => numberFormat.formatValue(number, compact.valueFormat, compact.valueFormat.locale) : undefined);
        } else {
          for (const key of ['pluginRoll', 'rollKey', 'rollText', 'rollValue']) delete value.dataset[key];
        }
      }
    }
    return {
      capture: roller.capture,
      update(container, snapshot, { revealing = false } = {}) {
        mark(container);
        if (!revealing && enabled()) roller.play(container, snapshot);
        else roller.settle();
      },
      settle: roller.settle
    };
  }
  return { create };
});
