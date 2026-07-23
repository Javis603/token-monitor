'use strict';

(function exposeAppUpdatePresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorAppUpdatePresentation = api;
})(typeof window !== 'undefined' ? window : null, function createAppUpdatePresentationApi() {
  const UNSUPPORTED_DESCRIPTION_KEYS = {
    unpackaged: 'settings.appUpdate.automaticUnsupportedUnpackaged',
    'windows-portable': 'settings.appUpdate.automaticUnsupportedWindowsPortable',
    'linux-not-appimage': 'settings.appUpdate.automaticUnsupportedLinux'
  };

  function automaticAppUpdateControlState({
    preferenceEnabled = false,
    updateState = null
  } = {}) {
    const supportKnown = typeof updateState?.installSupported === 'boolean';
    const supported = supportKnown && updateState.installSupported;
    const busy = Boolean(updateState?.installBusy);
    const descriptionKey = !supportKnown
      ? 'settings.appUpdate.automaticCheckingSupport'
      : supported
        ? 'settings.appUpdate.automaticDescription'
        : UNSUPPORTED_DESCRIPTION_KEYS[updateState.installSupportReason]
          || 'settings.appUpdate.automaticUnsupported';

    return {
      checked: Boolean(supported && preferenceEnabled),
      disabled: !supported || busy,
      unavailable: supportKnown && !supported,
      descriptionKey
    };
  }

  return { automaticAppUpdateControlState };
});
