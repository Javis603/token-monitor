'use strict';

let windowsFolders;

function readWindowsFolders(koffi = require('koffi')) {
  const shell = koffi.load('shell32.dll');
  const ole = koffi.load('ole32.dll');
  const getPath = shell.func('int32_t __stdcall SHGetKnownFolderPath(const void *id, uint32_t flags, void *token, _Out_ void **result)');
  const free = ole.func('void __stdcall CoTaskMemFree(void *pointer)');
  const initialize = ole.func('int32_t __stdcall CoInitializeEx(void *reserved, uint32_t flags)');
  const uninitialize = ole.func('void __stdcall CoUninitialize()');
  const initialized = initialize(null, 2);
  try {
    const folder = (guid) => {
      const out = [null];
      try {
        return getPath(Buffer.from(guid, 'hex'), 0, null, out) === 0 && out[0]
          ? koffi.decode(out[0], 'char16_t', -1) : null;
      } finally { if (out[0]) free(out[0]); }
    };
    return {
      profile: folder('8f856c5e220e60479afeea3317b67173'),
      roaming: folder('db85b63ef965f64ca03ae3ef65729f3d')
    };
  } finally { if (initialized >= 0) uninitialize(); }
}

function nativeWindowsFolders() {
  if (process.platform !== 'win32') return {};
  if (windowsFolders === undefined) {
    try { windowsFolders = readWindowsFolders(); }
    catch (_) { windowsFolders = {}; }
  }
  return windowsFolders;
}

module.exports = { readWindowsFolders, nativeWindowsFolders };
