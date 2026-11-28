// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tokscaleHomeDir } = require('../../tokscaleConfig');
const { throwIfAborted } = require('../../abortSignal');
const { classifyClientSyncDetailCode } = require('../../clientHealth');

// Keep discovery aligned with Tokscale. Amp is tracked by default, so a
// machine without the CLI should quietly keep reading any local threads.
/** @param {NodeJS.ProcessEnv} env */
function ampCliAvailable(env) {
  const names = process.platform === 'win32' ? ['amp.exe', 'amp.cmd'] : ['amp'];
  const home = tokscaleHomeDir({ env });
  const searchPath = process.platform === 'win32'
    ? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
    : env.PATH;
  const directories = [
    ...(searchPath || '').split(path.delimiter).filter(Boolean),
    path.join(home, '.amp', 'bin'),
    path.join(home, '.local', 'share', 'amp', 'bin')
  ];
  return directories.some(dir => names.some(name => {
    try { return fs.statSync(path.join(dir.replace(/^"(.*)"$/, '$1'), name)).isFile(); }
    catch (_) { return false; }
  }));
}

/** @typedef {{ complete: boolean, exported: number, remaining?: number, error?: string | null }} AmpSyncResult */
/** @typedef {{ signal?: AbortSignal, minIntervalMs: number, run: (signal?: AbortSignal) => Promise<AmpSyncResult> }} AmpSyncOptions */

/**
 * @param {ReturnType<typeof import('../../selfSyncThrottle').createSelfSyncThrottle>} throttle
 * @param {AmpSyncOptions} options
 * @returns {Promise<{ changed: boolean } | null>}
 */
async function syncAmp(throttle, { signal, minIntervalMs, run }) {
  throwIfAborted(signal);
  if (throttle.syncStatus('amp').state === 'pending' || !throttle.claim('amp', minIntervalMs)) return null;
  const attempt = throttle.beginAttempt('amp');
  /** @type {AmpSyncResult | undefined} */
  let output;
  try {
    output = await run(signal);
    throwIfAborted(signal);
    if (output?.complete !== true || !Number.isSafeInteger(output.exported) || output.exported < 0) {
      throw new Error('invalid response from Amp sync');
    }
    throttle.completeAttempt('amp', attempt, false);
  } catch (caught) {
    if (signal?.aborted) {
      throttle.cancelAttempt('amp', attempt);
      throwIfAborted(signal);
    }
    const error = /** @type {Error & { code?: string, tokscaleExitCode?: number, tokscaleJson?: AmpSyncResult }} */ (caught);
    output = error.tokscaleJson || output;
    const message = output?.error || error.message;
    const detailCode = /run `?amp login|not logged in|please log in/i.test(message)
      ? 'authentication-failed'
      : classifyClientSyncDetailCode({ text: message });
    const stage = /^tokscale timed out/i.test(error.message) || Number(output?.remaining) > 0
      ? 'timeout'
      : error.tokscaleExitCode != null ? 'process-exit' : error.code === 'ENOENT' ? 'spawn' : 'unknown';
    throttle.completeAttempt('amp', attempt, true, '', {
      failureStage: stage,
      detailCode,
      exitCode: error.tokscaleExitCode
    });
  }
  // A partially successful sync can still import historical usage.
  return { changed: Number(output?.exported) > 0 };
}

module.exports = { ampCliAvailable, syncAmp };
