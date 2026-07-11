'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { defaultDeviceId, loadDotEnv, parseArgs, pidFilePath } = require('../shared/config');
const { appVersion } = require('../shared/appVersion');
const { clientsCsvForSetting } = require('../shared/clientTracking');
const { collectUsageOnce, normalizeHistoryIntervalMs, startCollector } = require('../shared/collector');
const { normalizeLimitsRefreshMs, parseBoolean, parseLimitProviders } = require('../shared/limitCollector');
const { syncPayload } = require('../shared/syncPayload');

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
const hubUrl = String(args.hub || args.hubUrl || process.env.TOKEN_MONITOR_HUB_URL || 'http://127.0.0.1:17321').replace(/\/$/, '');
const secret = String(args.secret || process.env.TOKEN_MONITOR_SECRET || '').trim();
const deviceId = String(args.device || args.deviceId || process.env.TOKEN_MONITOR_DEVICE_ID || defaultDeviceId());
const intervalMs = Number(args.interval || args.intervalMs || process.env.TOKEN_MONITOR_INTERVAL_MS || 5 * 60 * 1000);
const watchEnabled = String(args.watch ?? process.env.TOKEN_MONITOR_WATCH ?? '1') !== '0';
const watchDebounceMs = Number(args.watchDebounceMs || process.env.TOKEN_MONITOR_WATCH_DEBOUNCE_MS || 1500);
const clients = clientsCsvForSetting(args.clients ?? process.env.TOKEN_MONITOR_CLIENTS);
const allTimeSince = String(args.since || args.allTimeSince || process.env.TOKEN_MONITOR_ALL_TIME_SINCE || '2024-01-01');
const commandTimeoutMs = Number(args.timeoutMs || process.env.TOKEN_MONITOR_TOKSCALE_TIMEOUT_MS || 120 * 1000);
const limitsEnabled = parseBoolean(args.limits ?? args.limitsEnabled ?? process.env.TOKEN_MONITOR_LIMITS_ENABLED, true);
const limitProviders = parseLimitProviders(args.limitProviders ?? process.env.TOKEN_MONITOR_LIMIT_PROVIDERS).join(',');
const limitsRefreshMs = normalizeLimitsRefreshMs(args.limitsRefreshMs || process.env.TOKEN_MONITOR_LIMITS_REFRESH_MS);
const historyEnabled = parseBoolean(args.history ?? args.historyEnabled ?? process.env.TOKEN_MONITOR_HISTORY_ENABLED, true);
const wslScanEnabled = parseBoolean(args.wslScan ?? args.wslScanEnabled ?? process.env.TOKEN_MONITOR_WSL_SCAN, true);
const opencodeCookie = String(process.env.TOKEN_MONITOR_OPENCODE_COOKIE || '').trim();
const once = Boolean(args.once);
const dryRun = Boolean(args['dry-run'] || args.dryRun);

const collectorOptions = { clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion: appVersion(), agentRuntime: 'headless-agent', historyEnabled, historyIntervalMs: normalizeHistoryIntervalMs(process.env.TOKEN_MONITOR_HISTORY_INTERVAL_MS), limitsEnabled, limitProviders, limitsRefreshMs, wslScanEnabled, opencodeCookie };

async function postUsage(summary) {
  const response = await fetch(`${hubUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(syncPayload(summary))
  });
  if (!response.ok) throw new Error(`Hub responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function deliver(summary) {
  if (dryRun) { console.log(JSON.stringify(summary, null, 2)); return; }
  await postUsage(summary);
  console.log(`[${new Date().toISOString()}] posted ${summary.deviceId}: today=${summary.today.totalTokens} month=${summary.month.totalTokens} allTime=${summary.allTime.totalTokens}`);
}

function registerPidFile() {
  const pidPath = pidFilePath();
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  const cleanup = () => { try { fs.unlinkSync(pidPath); } catch (_) {} };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanup(); process.exit(0); });
  }
}

async function main() {
  console.log(`Token Monitor agent device=${deviceId} hub=${hubUrl} intervalMs=${intervalMs} watch=${watchEnabled} history=${historyEnabled ? 'on' : 'off'} limits=${limitsEnabled ? `${limitProviders || 'none'}:${limitsRefreshMs}ms` : 'off'}`);
  if (!secret) console.warn('Warning: TOKEN_MONITOR_SECRET is not set. Posting without authorization header.');
  if (once) {
    const summary = await collectUsageOnce({ ...collectorOptions, includeHistory: true });
    await deliver(summary);
    return;
  }
  if (!dryRun) registerPidFile();
  startCollector({
    ...collectorOptions,
    intervalMs,
    watchEnabled,
    watchDebounceMs,
    onUpdate: (summary, reason) => {
      deliver(summary).catch((error) => console.error(`[${new Date().toISOString()}] (${reason}) ${error.message}`));
    },
    onError: (error, reason) => console.error(`[${new Date().toISOString()}] (${reason}) ${error.message}`),
    logger: (msg) => console.log(msg)
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
