'use strict';

// A dock card is thrown away and rebuilt from scratch on every repaint. A control
// that only listens for `click` therefore loses its activation whenever a repaint
// lands between press and release: the pressed button is detached, the release is
// dispatched at a node no longer in the tree, and the click never arrives, so the
// control silently does nothing. Activating on `pointerdown` for the primary
// pointer closes that window, and the plain `click` path stays for keyboard
// activation (Enter and Space synthesize a click that reports `detail === 0`).
// The two paths never run one action twice: a pointer-driven click reports a real
// detail count, so the click handler ignores it.
(function exposePressActivation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPressActivation = api;
})(typeof window !== 'undefined' ? window : null, function createPressActivationApi() {
  function activateOnPress(node, activate) {
    if (!node || typeof activate !== 'function') return;
    node.addEventListener('pointerdown', (event) => {
      // Only the primary button; a right or middle press belongs to the context
      // menu and must leave the default alone.
      if (event.button !== 0) return;
      // The press already committed the action, so stop it from also starting a
      // text selection or a native image drag. Focus is unaffected: that comes
      // from Tab, not from a pointer press.
      event.preventDefault();
      activate();
    });
    node.addEventListener('click', (event) => {
      // `detail === 0` is the keyboard-synthesized click. The pointer press was
      // handled above and its trailing click carries a non-zero detail, so this
      // guard is what keeps the action from firing twice for one press.
      if (event.detail !== 0) return;
      activate();
    });
  }

  return { activateOnPress };
});
