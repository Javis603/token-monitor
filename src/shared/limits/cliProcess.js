'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { abortError } = require('../probeDeadline');
const { envValue, errorWithStatus } = require('./providerHelpers');

// execFile cannot create a process group for POSIX launcher descendants.
function captureProcess(command, args, options, callback) {
  const { timeout, ...spawnOptions } = options;
  const child = spawn(command, args, { ...spawnOptions, detached: options.detached ?? process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  let failure;
  const stop = error => { failure ||= error; child.kill('SIGKILL'); };
  // Keep the deadline until close: an exited launcher can leave inherited pipes open.
  const timer = timeout > 0 ? setTimeout(() => {
    stop(Object.assign(errorWithStatus('unavailable', 'CLI timed out'), { code: 'ETIMEDOUT' }));
  }, timeout) : null;
  for (const name of ['stdout', 'stderr']) {
    child[name].setEncoding('utf8');
    child[name].on('data', text => {
      if (failure) return;
      output[name] += text;
      if (Buffer.byteLength(output[name]) > (options.maxBuffer || 256 * 1024)) {
        stop(Object.assign(new Error('CLI output exceeded its limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
      }
    });
  }
  child.on('error', error => { failure ||= error; });
  child.once('close', code => {
    if (timer) clearTimeout(timer);
    callback(failure || (code !== 0 ? Object.assign(errorWithStatus('unavailable', 'CLI exited unsuccessfully'), { code }) : null), output.stdout, output.stderr);
  });
  return child;
}

function runCapturedCliProcess(command, args, options) {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
  return new Promise((resolve, reject) => {
    const execute = options.execFile || captureProcess;
    const platform = options.platform || process.platform;
    let cleanup = Promise.resolve(null);
    // Cancellation is not proof of exit; wait for close and any tree cleanup.
    const onAbort = () => child.kill('SIGKILL');
    const child = execute(command, args, {
      cwd: options.cwd, env: options.env, encoding: 'utf8', windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
      detached: options.detached,
      timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024
    }, async (error, stdout = '', stderr = '') => {
      options.signal?.removeEventListener('abort', onAbort);
      // cmd.exe may close while taskkill is still working. Both must finish
      // before allowing fallback, including when cleanup eventually fails.
      const cleanupError = await cleanup;
      if (cleanupError) { reject(cleanupError); return; }
      if (options.signal?.aborted) { reject(abortError(options.signal)); return; }
      resolve({ error, stdout, stderr });
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
            const failure = error && errorWithStatus('unavailable', 'CLI process tree could not be stopped');
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
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

module.exports = { runCapturedCliProcess };
