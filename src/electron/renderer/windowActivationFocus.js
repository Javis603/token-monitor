'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorWindowActivationFocus = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function create({ document, shell, header }) {
    let navigating = false, keyboardTarget = null, pending = null;
    const view = document.defaultView;
    function cancel() {
      if (pending) view.clearTimeout(pending.expiry);
      pending = null;
    }
    function settleFocus() {
      const transaction = pending;
      view.requestAnimationFrame(() => {
        if (!transaction || transaction !== pending || !document.hasFocus()) return;
        const active = document.activeElement;
        // Body/shell can precede Chromium's retained-control restoration.
        // Wait for a real target, bounded by the native show grace period.
        if (!active || active === document.body || active === shell) return;
        cancel();
        // Native and plugin header buttons use the same policy. Editors and
        // page content retain focus; deliberate keyboard navigation wins.
        if (active?.tagName === 'BUTTON' && header.contains(active) && active !== keyboardTarget) {
          shell.focus({ preventScroll: true });
        }
      });
    }
    document.addEventListener('keydown', event => {
      cancel();
      // Global summons and OS app switching are not in-document navigation.
      navigating = !event.metaKey && !event.ctrlKey && !event.altKey
        && ['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key);
      if (navigating) keyboardTarget = document.activeElement;
    }, true);
    document.addEventListener('pointerdown', () => {
      cancel(); navigating = false; keyboardTarget = null;
    }, true);
    document.addEventListener('focusin', event => {
      if (navigating && event.target !== document.body) {
        keyboardTarget = event.target;
        navigating = false;
      }
      // Native hide/show can focus body before restoring the same control.
      // That intermediate focus is not evidence of a new interaction.
      if (pending) settleFocus();
    }, true);
    // Chromium can emit window blur between a Tab press and its focusin.
    // Consume navigation on the resulting focus, not on that transient blur.
    // Renderer blur is also emitted during native activation. Only the main
    // process can distinguish its suppressed menu-bar blur from a departure.
    // document.hasFocus() prevents DOM focus moves while another app is active.
    view.addEventListener('focus', () => { if (pending) settleFocus(); });
    return {
      cancel,
      summon() {
        cancel();
        navigating = false;
        pending = { expiry: view.setTimeout(cancel, 250) };
        settleFocus();
      }
    };
  }
  return { create };
});
