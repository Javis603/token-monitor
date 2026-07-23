'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { defaultDeviceId, loadDotEnv, parseArgs, pidFilePath } = require('../shared/config');
const { appVersion } = require('../shared/appVersion');
const { clientsCsvForSetting } = require('../shared/clientTracking');
const { normalizeHistoryIntervalMs } = require('../shared/collector');
const { normalizeLimitsRefreshMs, parseBoolean, parseLimitProviders } = require('../shared/limitCollector');
const { postSyncPayload } = require('../shared/syncPayload');
const { applyProjectRollups } = require('../shared/usage');
const { runAgent, runAgentOnce } = require('./runtime');
const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchiveDate,
  writeSessionUsageArchive
} = require('../shared/sessionUsageArchive');

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
const projectsEnabled = parseBoolean(args.projects ?? args.projectsEnabled ?? process.env.TOKEN_MONITOR_PROJECTS_ENABLED, false);
const sessionUsageArchiveEnabled = parseBoolean(args.sessionArchive ?? args.sessionUsageArchiveEnabled ?? process.env.TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED, true);
const wslScanEnabled = parseBoolean(args.wslScan ?? args.wslScanEnabled ?? process.env.TOKEN_MONITOR_WSL_SCAN, true);
const opencodeCookie = String(process.env.TOKEN_MONITOR_OPENCODE_COOKIE || '').trim();
const once = Boolean(args.once);
const dryRun = Boolean(args['dry-run'] || args.dryRun);

const usageOptions = {
  clients,
  allTimeSince,
  commandTimeoutMs,
  deviceId,
  agentVersion: appVersion(),
  agentRuntime: 'headless-agent',
  projectsEnabled,
  historyEnabled,
  historyIntervalMs: normalizeHistoryIntervalMs(process.env.TOKEN_MONITOR_HISTORY_INTERVAL_MS),
  dailyHistoryArchiveEnabled: sessionUsageArchiveEnabled,
  dailyHistoryArchiveWriteEnabled: !dryRun,
  anchorPersistenceEnabled: !once && !dryRun,
  intervalMs,
  watchEnabled,
  watchDebounceMs,
  wslScanEnabled,
  onError: (error, reason) => console.error(`[${new Date().toISOString()}] (${reason}) ${error.message}`),
  logger: (message) => (dryRun ? console.error(message) : console.log(message))
};
const limitsOptions = {
  limitsEnabled,
  limitProviders,
  limitsRefreshMs,
  opencodeCookie
};
let sessionUsageArchive;

function summaryWithSessionUsageArchive(summary, now = new Date()) {
  let visibleSummary = summary;
  if (sessionUsageArchiveEnabled) {
    const archiveDate = sessionUsageArchiveDate(summary, now);
    const previous = sessionUsageArchive || readSessionUsageArchive();
    const next = captureSessionUsageArchive(previous, summary, archiveDate);
    if (!dryRun && JSON.stringify(next) !== JSON.stringify(previous)) {
      try {
        writeSessionUsageArchive(next);
        sessionUsageArchive = next;
      } catch (error) {
        console.error(`[session-archive] write failed: ${error.message}`);
      }
    } else if (!dryRun) {
      sessionUsageArchive = next;
    }
    visibleSummary = applySessionUsageArchive(summary, next, { now: archiveDate });
  }
  return projectsEnabled ? applyProjectRollups(visibleSummary) : visibleSummary;
}

async function postUsage(summary) {
  const { response } = await postSyncPayload(fetch, `${hubUrl}/api/ingest`, {
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    summary,
    logger: (message) => console.warn(`[sync] ${message}`)
  });
  if (!response.ok) throw new Error(`Hub responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function deliver(summary) {
  if (dryRun) { console.log(JSON.stringify(summary, null, 2)); return; }
  await postUsage(summary);
  console.log(`[${new Date().toISOString()}] posted ${summary.deviceId}: today=${summary.today.totalTokens} month=${summary.month.totalTokens} allTime=${summary.allTime.totalTokens}`);
}

function registerPidFile(stopRuntime) {
  const pidPath = pidFilePath();
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  const cleanup = () => { try { fs.unlinkSync(pidPath); } catch (_) {} };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try { stopRuntime?.(); } catch (_) {}
      cleanup();
      process.exit(0);
    });
  }
}

async function main() {
  const startupMessage = `Token Monitor agent device=${deviceId} hub=${hubUrl} intervalMs=${intervalMs} watch=${watchEnabled} projects=${projectsEnabled ? 'on' : 'off'} history=${historyEnabled ? 'on' : 'off'} sessionArchive=${sessionUsageArchiveEnabled ? 'on' : 'off'} limits=${limitsEnabled ? `${limitProviders || 'none'}:${limitsRefreshMs}ms` : 'off'}`;
  if (dryRun) console.error(startupMessage);
  else console.log(startupMessage);
  if (!secret) console.warn('Warning: TOKEN_MONITOR_SECRET is not set. Posting without authorization header.');
  // Claim archive ownership before either a one-shot or long-running scan so
  // Electron can yield before its history read-modify-write reaches disk.
  let runtimeHandle = null;
  if (!dryRun) registerPidFile(() => runtimeHandle?.stop());
  const runtimeOptions = {
    envelope: { deviceId, agentVersion: appVersion(), agentRuntime: 'headless-agent' },
    usageOptions,
    limitsOptions,
    transformUsage: summaryWithSessionUsageArchive,
    deliver,
    dryRun,
    onRuntime: (runtime) => { runtimeHandle = runtime; },
    onError: (error, reason) => console.error(`[${new Date().toISOString()}] (${reason}) ${error.message}`)
  };
  if (once) {
    await runAgentOnce(runtimeOptions);
    return;
  }
  runtimeHandle = runAgent(runtimeOptions);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
