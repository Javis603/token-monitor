'use strict';

// console.log is wired to the same stdout stream that npm / Electron inherit
// from the parent shell. When the parent closes its end of the pipe (npm
// detached, terminal closed, log redirected to a non-seekable consumer), the
// next write raises EPIPE asynchronously on the stream's 'error' event. With
// no listener that becomes an unhandled 'error' and Electron pops a
// "JavaScript error in the main process" dialog, even though the app is fine.
// Install a one-time no-op EPIPE handler so background log traffic never
// disturbs the user; re-throw anything else so genuine bugs still surface.
function installSafeStdout() {
  if (process.stdout._tokenMonitorEpipeHandled) return;
  process.stdout._tokenMonitorEpipeHandled = true;
  process.stdout.on('error', (err) => {
    if (!err || err.code !== 'EPIPE') throw err;
  });
  // stderr mirrors stdout; install a handler there too for symmetry.
  if (!process.stderr._tokenMonitorEpipeHandled) {
    process.stderr._tokenMonitorEpipeHandled = true;
    process.stderr.on('error', (err) => {
      if (!err || err.code !== 'EPIPE') throw err;
    });
  }
}

module.exports = { installSafeStdout };
