'use strict';

// macOS directory events defer open SQLite WAL writes until the writer closes.
// Keep file-level watching there; chokidar 6 uses fewer native handles elsewhere.
module.exports = process.platform === 'darwin'
  ? require('chokidar-macos')
  : require('chokidar').default;
