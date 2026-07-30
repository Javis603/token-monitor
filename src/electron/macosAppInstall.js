'use strict';

function shouldOfferMacAppInstall({ app, platform = process.platform } = {}) {
  return platform === 'darwin'
    && Boolean(app?.isPackaged)
    && typeof app.isInApplicationsFolder === 'function'
    && !app.isInApplicationsFolder();
}

function replaceExistingApp(dialog, appName, conflictType) {
  const running = conflictType === 'existsAndRunning';
  const response = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: `${appName} is already in Applications`,
    detail: running
      ? 'The installed copy is currently open. Close it, then try moving this copy again.'
      : 'Replace the existing copy with this one?'
  });
  return !running && response === 0;
}

async function offerMacAppInstall({ app, dialog, appName, platform = process.platform } = {}) {
  if (!shouldOfferMacAppInstall({ app, platform })) return false;

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Move to Applications', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: `Move ${appName} to Applications?`,
    detail: 'This installs the app in the standard macOS location. It will reopen after the move.'
  });
  if (response !== 0) return false;

  try {
    // Electron copies the bundle when it is running from a read-only DMG, then
    // relaunches the copy. The explicit conflict handler never replaces an
    // installed app without the user's approval.
    return app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => replaceExistingApp(dialog, appName, conflictType)
    });
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      buttons: ['OK'],
      message: `Could not move ${appName} to Applications`,
      detail: error?.message || String(error)
    });
    return false;
  }
}

module.exports = {
  offerMacAppInstall,
  replaceExistingApp,
  shouldOfferMacAppInstall
};
