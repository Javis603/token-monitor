'use strict';

// Controls activate on the primary press for immediate response; keyboard clicks
// retain their normal activation path. Ignore the trailing pointer click so one
// press never runs the action twice. Rail and summary controls use this too.
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
