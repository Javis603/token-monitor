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
    // A spent attempt stops the background downloader too, so the standing promise
    // to fetch updates on its own is not true until the app restarts. Said in the
    // description rather than by disabling the control: the preference itself is
    // unaffected and still worth changing, and grey would read as unsupported here
    // and invite toggling it off and on to no effect.
    //
    // Only while the preference is on, because that is the promise being suspended.
    // Switched off there is nothing to resume, and saying so anyway would tell the
    // user their restart will turn a setting back on that they just turned off.
    const descriptionKey = !supportKnown
      ? 'settings.appUpdate.automaticCheckingSupport'
      : !supported
        ? UNSUPPORTED_DESCRIPTION_KEYS[updateState.installSupportReason]
          || 'settings.appUpdate.automaticUnsupported'
        : preferenceEnabled && updateState.installRetryBlocked
          ? 'settings.appUpdate.automaticBlockedUntilRestart'
          : 'settings.appUpdate.automaticDescription';

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

  // One entry per release the user is about to receive, newest first. Older
  // remembered state and the unpackaged check carry only the latest release's
  // notes, which become a one-entry history.
  function releaseNoteHistoryForLocale(latest, locale) {
    const history = Array.isArray(latest?.releaseNoteHistory) && latest.releaseNoteHistory.length > 0
      ? latest.releaseNoteHistory
      : latest?.version
        ? [{ version: latest.version, htmlUrl: latest.htmlUrl, releaseNotes: latest.releaseNotes }]
        : [];
    return history
      .filter((entry) => typeof entry?.version === 'string' && entry.version)
      .map((entry) => ({
        version: entry.version,
        htmlUrl: typeof entry.htmlUrl === 'string' ? entry.htmlUrl : '',
        groups: releaseNoteGroupsForLocale(entry.releaseNotes, locale)
      }));
  }

  // Release notes lead each item with a bold topic ("**Goose usage:** Supports…").
  // The parser keeps plain text, so the topic is recovered from its colon to
  // restore that emphasis. A colon deep in a sentence is not a topic.
  const RELEASE_NOTE_LEAD_RE = /^([^。．.!?！？:：]{1,40}?[:：])\s*(\S[\s\S]*)$/;
  function splitReleaseNoteLead(item) {
    const text = String(item || '');
    const match = RELEASE_NOTE_LEAD_RE.exec(text);
    return match ? { lead: match[1], body: match[2] } : { lead: '', body: text };
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

  // An install failure the updater merely reports has nothing to tell the user
  // beyond "it failed". These have more: the app is still running, the in-app path
  // is closed until it restarts, and a generic message cannot say either.
  function appUpdateInstallErrorMessageKey(kind) {
    const keys = {
      'installer-did-not-start': 'settings.appUpdate.installerDidNotStart',
      'installer-did-not-start-spent': 'settings.appUpdate.installerDidNotStartSpent',
      'install-spent-by-failure': 'settings.appUpdate.installSpentByFailure',
      'attempt-spent': 'settings.appUpdate.installAttemptSpent'
    };
    return keys[kind] || 'settings.appUpdate.installError';
  }

  // What the update control should offer. A spent install attempt closes the
  // in-app path entirely: re-downloading only buys another refusal, and on macOS it
  // restarts a download lifecycle while the first Squirrel request may still be
  // live. The release page is what remains until a restart.
  function appUpdateActionMode(updateState) {
    const s = updateState;
    if (!s) return '';
    if (s.installRetryBlocked) return s.latest?.htmlUrl ? 'release' : '';
    if (s.downloaded) return 'install';
    if (!s.hasUpdate) return '';
    if (s.installSupported) return 'download';
    return s.latest?.htmlUrl ? 'release' : '';
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

  // The card anchors to the footer button from below, so its cap is the space
  // left above the button minus a small top margin. No floor: at the window's
  // 140px minimum height a floor would push the header off the top edge — the
  // card scrolls itself instead.
  function appUpdatePopoverMaxHeight({ viewportHeight, bottom }) {
    return Math.max(0, Math.min(440, viewportHeight - bottom - 12));
  }

  return {
    appUpdateActionMode,
    appUpdateErrorMessageKey,
    appUpdateInstallErrorMessageKey,
    appUpdatePopoverMaxHeight,
    appUpdateStatusPresentation,
    automaticAppUpdateControlState,
    releaseNoteGroupsForLocale,
    releaseNoteHistoryForLocale,
    splitReleaseNoteLead
  };
});
