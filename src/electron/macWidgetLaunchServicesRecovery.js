'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const {
  readRegularFileNoFollow,
  writePrivateJsonAtomic
} = require('../shared/credentialStore');

const MARKER_FILE_NAME = 'mac-widget-launchservices-registration.json';
const REGISTER_HOST_ARGUMENTS = Object.freeze(['--mode', 'register-host']);
const MARKER_SCHEMA_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_REVALIDATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECOVERY_FILE_BYTES = 64 * 1024;
const MAX_CONFIG_VALUE_LENGTH = 256;

const IDENTITY_FIELDS = Object.freeze([
  'schemaVersion',
  'appGroup',
  'urlScheme',
  'widgetKind',
  'widgetUIVersion',
  'widgetSchemaVersion',
  'gitRevision',
  'packageVersion',
  'marketingVersion',
  'bundleVersion'
]);

function fixedValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_CONFIG_VALUE_LENGTH) return null;
  return normalized;
}

function normalizedIdentityConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const normalized = {};
  for (const field of IDENTITY_FIELDS) {
    const value = fixedValue(config[field]);
    if (value === null) return null;
    normalized[field] = value;
  }
  return normalized;
}

function installationArtifact(fsApi, candidate, expectedType) {
  try {
    const stat = fsApi.lstatSync(candidate, { bigint: true });
    const validType = expectedType === 'directory'
      ? stat.isDirectory()
      : stat.isFile();
    if (!validType || stat.isSymbolicLink()) return null;
    const values = [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs];
    if (values.some((value) => typeof value !== 'bigint')) return null;
    const [dev, ino, birthtimeNs, ctimeNs] = values.map(String);
    return { dev, ino, birthtimeNs, ctimeNs };
  } catch (_) {
    return null;
  }
}

function log(logger, message) {
  try { logger?.(message); } catch (_) {}
}

function registrationIdentity(config, hostAppPath, installation) {
  return crypto.createHash('sha256').update(JSON.stringify({
    recoverySchemaVersion: MARKER_SCHEMA_VERSION,
    hostAppPath,
    installation,
    config
  })).digest('hex');
}

function readMarker(markerPath, fsApi, readPrivateFile, logger) {
  try {
    const raw = readPrivateFile(markerPath, {
      fs: fsApi,
      description: 'Widget registration marker',
      encoding: 'utf8',
      mode: 0o600,
      maxBytes: MAX_RECOVERY_FILE_BYTES
    });
    const marker = JSON.parse(raw);
    if (
      marker
      && marker.schemaVersion === MARKER_SCHEMA_VERSION
      && typeof marker.registrationIdentity === 'string'
      && typeof marker.completedAt === 'string'
      && Number.isFinite(Date.parse(marker.completedAt))
    ) {
      return marker;
    }
    log(logger, '[mac-widget] invalid LaunchServices recovery marker; retrying');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log(logger, '[mac-widget] invalid LaunchServices recovery marker; retrying');
    }
  }
  return null;
}

function runRegistration(execFileImpl, helperPath, timeoutMs, signal) {
  return new Promise((resolve) => {
    try {
      execFileImpl(
        helperPath,
        REGISTER_HOST_ARGUMENTS,
        {
          shell: false,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
          windowsHide: true,
          ...(signal ? { signal } : {})
        },
        (error) => resolve(error || null)
      );
    } catch (error) {
      resolve(error);
    }
  });
}

function createMacWidgetLaunchServicesRecovery(options = {}) {
  const fsApi = options.fs || fs;
  const execFileImpl = options.execFile || execFile;
  const readPrivateFile = options.readRegularFileNoFollow || readRegularFileNoFollow;
  const writePrivateFile = options.writePrivateJsonAtomic || writePrivateJsonAtomic;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const revalidateAfterMs = Number.isFinite(options.revalidateAfterMs)
    ? Math.max(1, options.revalidateAfterMs)
    : DEFAULT_REVALIDATE_AFTER_MS;
  const now = options.now || Date.now;
  let inFlight = null;

  async function execute(input = {}) {
    if (input.platform !== 'darwin') {
      return { status: 'skipped', reason: 'unsupported-platform' };
    }
    if (input.runtimeSupported === false) {
      return { status: 'skipped', reason: 'unsupported-os' };
    }
    if (input.isPackaged !== true) {
      return { status: 'skipped', reason: 'unpackaged' };
    }
    if (input.signal?.aborted) {
      return { status: 'skipped', reason: 'cancelled' };
    }

    try {
      const resourcesPath = path.resolve(String(input.resourcesPath || ''));
      const configPath = path.join(resourcesPath, 'token-monitor-widget.json');
      const helperPath = path.join(resourcesPath, 'TokenMonitorWidgetReloader');
      const contentsPath = path.resolve(resourcesPath, '..');
      const appexPath = path.join(contentsPath, 'PlugIns', 'TokenMonitorWidget.appex');
      const hostAppPath = path.resolve(contentsPath, '..');
      if (!hostAppPath.endsWith('.app')) {
        return { status: 'skipped', reason: 'artifacts-missing' };
      }
      const installation = {
        host: installationArtifact(fsApi, hostAppPath, 'directory'),
        appex: installationArtifact(fsApi, appexPath, 'directory'),
        helper: installationArtifact(fsApi, helperPath, 'file')
      };
      if (Object.values(installation).some((artifact) => !artifact)) {
        return { status: 'skipped', reason: 'artifacts-missing' };
      }

      let config;
      try {
        const raw = readPrivateFile(configPath, {
          fs: fsApi,
          description: 'Packaged Widget configuration',
          encoding: 'utf8',
          maxBytes: MAX_RECOVERY_FILE_BYTES
        });
        config = normalizedIdentityConfig(JSON.parse(raw));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return { status: 'skipped', reason: 'artifacts-missing' };
        }
        log(input.logger, '[mac-widget] invalid packaged Widget configuration');
        return { status: 'failed', reason: 'invalid-config' };
      }
      if (!config) {
        log(input.logger, '[mac-widget] invalid packaged Widget configuration');
        return { status: 'failed', reason: 'invalid-config' };
      }

      const identity = registrationIdentity(config, hostAppPath, installation);
      const markerPath = path.join(String(input.userDataPath || ''), MARKER_FILE_NAME);
      const marker = readMarker(markerPath, fsApi, readPrivateFile, input.logger);
      const completedAt = Date.parse(marker?.completedAt || '');
      const markerAgeMs = now() - completedAt;
      if (
        marker?.registrationIdentity === identity
        && markerAgeMs >= 0
        && markerAgeMs < revalidateAfterMs
      ) {
        return { status: 'skipped', reason: 'already-completed' };
      }
      if (input.signal?.aborted) {
        return { status: 'skipped', reason: 'cancelled' };
      }

      const error = await runRegistration(execFileImpl, helperPath, timeoutMs, input.signal);
      if (input.signal?.aborted || error?.code === 'ABORT_ERR') {
        log(input.logger, '[mac-widget] LaunchServices registration refresh cancelled');
        return { status: 'failed', reason: 'cancelled' };
      }
      if (error) {
        const timedOut = error.killed === true || error.signal === 'SIGKILL';
        log(input.logger, timedOut
          ? '[mac-widget] LaunchServices registration refresh timed out'
          : '[mac-widget] LaunchServices registration refresh failed');
        return { status: 'failed', reason: timedOut ? 'timed-out' : 'launch-failed' };
      }
      if (input.signal?.aborted) {
        log(input.logger, '[mac-widget] LaunchServices registration refresh cancelled');
        return { status: 'failed', reason: 'cancelled' };
      }

      try {
        writePrivateFile(markerPath, {
          schemaVersion: MARKER_SCHEMA_VERSION,
          registrationIdentity: identity,
          completedAt: new Date(now()).toISOString()
        }, { fs: fsApi });
      } catch (_) {
        log(input.logger, '[mac-widget] could not persist LaunchServices recovery marker');
        return { status: 'failed', reason: 'marker-write-failed' };
      }
      log(input.logger, '[mac-widget] refreshed LaunchServices host registration');
      return { status: 'completed' };
    } catch (_) {
      log(input.logger, '[mac-widget] LaunchServices registration recovery failed');
      return { status: 'failed', reason: 'unexpected-error' };
    }
  }

  return function recoverMacWidgetLaunchServicesRegistration(input = {}) {
    if (!inFlight) inFlight = execute(input);
    return inFlight;
  };
}

module.exports = {
  MARKER_FILE_NAME,
  createMacWidgetLaunchServicesRecovery
};
