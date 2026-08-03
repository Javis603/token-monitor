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

  function releaseNoteGroupsForLocale(notes, locale) {
    if (!notes || typeof notes !== 'object') return [];
    const fallbackKeys = {
      'zh-TW': ['zh-TW', 'zh', 'en'],
      'zh-CN': ['zh', 'en'],
      ko: ['ko', 'en', 'zh'],
      ja: ['ja', 'en', 'zh']
    }[locale] || ['en', 'zh'];

    for (const key of fallbackKeys) {
      if (Array.isArray(notes[key]) && notes[key].length > 0) return notes[key];
    }
    return [];
  }

  function appUpdateErrorMessageKey(kind) {
    const keys = {
      githubUnavailable: 'settings.appUpdate.githubUnavailable',
      metadata: 'settings.appUpdate.metadataError',
      rateLimited: 'settings.appUpdate.rateLimited',
      timeout: 'settings.appUpdate.timeout'
    };
    return keys[kind] || 'settings.appUpdate.githubError';
  }

  function appUpdateStatusPresentation(updateState = null) {
    const displayVersion = updateState?.latest?.version || updateState?.installVersion || '';
    const hasCheckError = Boolean(updateState?.lastError);
    const latestStatusKey = !displayVersion
      ? ''
      : hasCheckError
        ? 'settings.appUpdate.lastKnownShort'
        : !updateState?.hasUpdate && displayVersion === updateState?.currentVersion
          ? 'settings.appUpdate.upToDateShort'
          : '';

    return {
      displayVersion,
      latestStatusKey,
      errorKey: hasCheckError ? appUpdateErrorMessageKey(updateState?.lastErrorKind) : '',
      lastSuccessfulCheckAt: hasCheckError ? updateState?.lastCheckedAt || null : null
    };
  }

  return {
    appUpdateErrorMessageKey,
    appUpdateStatusPresentation,
    automaticAppUpdateControlState,
    releaseNoteGroupsForLocale
  };
});
