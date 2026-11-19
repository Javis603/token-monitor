'use strict';

// macOS 15 protects App Group containers even for correctly signed apps unless
// the process first asks NSFileManager for the authorized container URL. Node's
// fs APIs can use the returned path afterwards, but constructing
// ~/Library/Group Containers/<group> ourselves triggers an App Data consent
// prompt on every launch. Keep this bridge in the Electron main process so the
// access is performed by the provisioned host app, not an unentitled helper.

let macAppGroupApi;

function createMacAppGroupApi(koffi) {
  // Loading Foundation makes its Objective-C classes available even when this
  // module is exercised outside the packaged Electron executable.
  const foundation = koffi.load('/System/Library/Frameworks/Foundation.framework/Foundation');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const objcGetClass = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const selRegisterName = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const sendObject = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const sendObjectWithString = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'str']);
  const sendObjectWithObject = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const sendCString = objc.func('objc_msgSend', 'str', ['uintptr_t', 'uintptr_t']);

  const fileManagerClass = objcGetClass('NSFileManager');
  const stringClass = objcGetClass('NSString');
  const defaultManagerSelector = selRegisterName('defaultManager');
  const stringWithUtf8Selector = selRegisterName('stringWithUTF8String:');
  const containerUrlSelector = selRegisterName('containerURLForSecurityApplicationGroupIdentifier:');
  const fileSystemRepresentationSelector = selRegisterName('fileSystemRepresentation');

  return {
    // Retain the library wrapper for the lifetime of the function pointers.
    foundation,
    containerPath(appGroup) {
      const fileManager = sendObject(fileManagerClass, defaultManagerSelector);
      const identifier = sendObjectWithString(stringClass, stringWithUtf8Selector, appGroup);
      if (!fileManager || !identifier) return null;
      const containerUrl = sendObjectWithObject(fileManager, containerUrlSelector, identifier);
      if (!containerUrl) return null;
      return String(sendCString(containerUrl, fileSystemRepresentationSelector) || '').trim() || null;
    }
  };
}

function loadMacAppGroupApi() {
  if (macAppGroupApi !== undefined) return macAppGroupApi;
  try {
    macAppGroupApi = createMacAppGroupApi(require('koffi'));
  } catch (_) {
    macAppGroupApi = null;
  }
  return macAppGroupApi;
}

function resolveMacAppGroupContainerPath(appGroup, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return null;
  const identifier = String(appGroup || '').trim();
  if (!identifier) return null;
  const api = options.api || loadMacAppGroupApi();
  if (!api) return null;
  try {
    return api.containerPath(identifier);
  } catch (error) {
    try {
      options.logger?.(`[mac-widget] App Group container lookup failed: ${error?.message || error}`);
    } catch (_) {}
    return null;
  }
}

module.exports = {
  createMacAppGroupApi,
  resolveMacAppGroupContainerPath
};
