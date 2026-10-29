'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorWindowActivationFocus = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function create({ document, shell, header }) {
    let inputEpoch = 0, navigating = false, keyboardTarget = null, summoned = false;
    const view = document.defaultView;
    function settleFocus() {
      const input = inputEpoch;
      view.requestAnimationFrame(() => {
        if (!summoned || input !== inputEpoch || !document.hasFocus()) return;
        const active = document.activeElement;
        // Native and plugin header buttons use the same policy. Editors and
        // page content retain focus; deliberate keyboard navigation wins.
        if (active?.tagName === 'BUTTON' && header.contains(active) && active !== keyboardTarget) {
          shell.focus({ preventScroll: true });
        }
      });
    }
    document.addEventListener('keydown', event => {
      inputEpoch++; summoned = false;
      // Global summons and OS app switching are not in-document navigation.
      navigating = !event.metaKey && !event.ctrlKey && !event.altKey
        && ['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key);
      if (navigating) keyboardTarget = document.activeElement;
    }, true);
    document.addEventListener('pointerdown', () => {
      inputEpoch++; summoned = false; navigating = false; keyboardTarget = null;
    }, true);
    document.addEventListener('focusin', event => {
      if (navigating && event.target !== document.body) {
        keyboardTarget = event.target;
        navigating = false;
      }
      // Native hide/show can focus body before restoring the same control.
      // That intermediate focus is not evidence of a new interaction.
      if (summoned) settleFocus();
    }, true);
    // Chromium can emit window blur between a Tab press and its focusin.
    // Consume navigation on the resulting focus, not on that transient blur.
    view.addEventListener('blur', () => { summoned = false; });
    return {
      summon() {
        navigating = false;
        summoned = true;
        settleFocus();
      }
    };
  }
  return { create };
});
