'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { envValue, errorWithStatus } = require('../../limits/providerHelpers');

// execFile cannot create a process group for POSIX launcher descendants.
function captureProcess(command, args, options, callback) {
  const { timeout, ...spawnOptions } = options;
  const child = spawn(command, args, { ...spawnOptions, detached: options.detached ?? process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let failure;
  const stop = error => { failure ||= error; child.kill('SIGKILL'); };
  // Keep the deadline until close: an exited launcher can leave inherited pipes open.
  const timer = timeout > 0 ? setTimeout(() => {
    stop(Object.assign(errorWithStatus('unavailable', 'CLI timed out'), { code: 'ETIMEDOUT' }));
  }, timeout) : null;
  for (const name of ['stdout', 'stderr']) {
    let bytes = 0;
    child[name].setEncoding('utf8');
    child[name].on('data', text => {
      if (failure) return;
      bytes += Buffer.byteLength(text);
      if (bytes > (options.maxBuffer || 256 * 1024)) {
        stop(Object.assign(new Error('CLI output exceeded its limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
      }
    });
  }
  child.on('error', error => { failure ||= error; });
  child.once('close', code => {
    if (timer) clearTimeout(timer);
    callback(failure || (code !== 0 ? Object.assign(errorWithStatus('unavailable', 'CLI exited unsuccessfully'), { code }) : null));
  });
  return child;
}

function runCapturedCliProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const execute = options.execFile || captureProcess;
    const platform = options.platform || process.platform;
    let cleanup = Promise.resolve(null);
    const child = execute(command, args, {
      cwd: options.cwd, env: options.env, encoding: 'utf8', windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
      detached: options.detached,
      timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024
    }, () => {
      // cmd.exe may close while taskkill is still working. Both must finish
      // before allowing fallback, including when cleanup eventually fails.
      cleanup.then(error => error ? reject(error) : resolve());
    });
    if (child.pid) {
      const kill = child.kill.bind(child);
      if (platform !== 'win32') {
        child.kill = signal => {
          // A timeout must stop launcher descendants before another probe starts.
          try { process.kill(-child.pid, signal); }
          catch (error) {
            if (error.code !== 'ESRCH') {
              const failure = errorWithStatus('unavailable', 'CLI process group could not be stopped');
              failure.code = 'CLI_PROCESS_CLEANUP_FAILED';
              cleanup = Promise.resolve(failure);
            }
          }
          return kill(signal);
        };
      } else if (options.windowsVerbatimArguments) {
        // A .cmd shim owns another process: terminating cmd.exe alone leaves it alive.
        let stopping = false;
        child.kill = signal => {
          if (stopping) return true;
          stopping = true;
          let complete;
          cleanup = new Promise(resolve => { complete = resolve; });
          const root = envValue(options.env, 'SystemRoot') || 'C:\\Windows';
          const finished = error => {
            // taskkill exits 128 when the shim already exited; nothing is left
            // to stop, so that is successful cleanup, not a failure.
            const notFound = error && (error.code === 128
              || /not found|no running instance|没有运行|找不到/iu.test(error.message || ''));
            const failure = error && !notFound && errorWithStatus('unavailable', 'CLI process tree could not be stopped');
            if (failure) failure.code = 'CLI_PROCESS_CLEANUP_FAILED';
            complete(failure || null);
            kill(signal);
          };
          try {
            execute(path.win32.join(root, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'],
              { windowsHide: true, timeout: 2000, killSignal: 'SIGKILL' }, finished);
          } catch (error) { finished(error); }
          return true;
        };
      }
    }
    child.stdin?.end();
  });
}

module.exports = { runCapturedCliProcess };
