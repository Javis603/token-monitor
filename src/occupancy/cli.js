#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { defaultDeviceId, loadDotEnv } = require('../shared/config');

const DEFAULT_HUB_URL = 'http://127.0.0.1:17321';
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_TTL_MS = 45_000;
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

class CliError extends Error {
  constructor(message, { code = 'cli_error', status = 0, payload = null } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

function usage() {
  return `Token Monitor account occupancy CLI

Usage:
  token-monitor-occupancy account list
  token-monitor-occupancy account add --provider <name> --alias <name> --advisory-threshold <n>
  token-monitor-occupancy account update <id|alias> [account options]
  token-monitor-occupancy account remove <id|alias>
  token-monitor-occupancy status
  token-monitor-occupancy start --account <id|alias> [--task <label>] [--project <label>]
  token-monitor-occupancy heartbeat <lease-id> --fence-token <token>
  token-monitor-occupancy stop <lease-id> --fence-token <token>
  token-monitor-occupancy run --account <id|alias> [--task <label>] [--project <label>] -- <command...>

Connection options (accepted before the command):
  --hub-url <url>    Hub URL (default: TOKEN_MONITOR_HUB_URL or ${DEFAULT_HUB_URL})
  --secret <secret>  Shared Hub secret (default: TOKEN_MONITOR_SECRET)
  --device-id <id>   Device identifier (default: TOKEN_MONITOR_DEVICE_ID or hostname)
  --json             Print JSON responses

Account options:
  --provider <name> --alias <name> --advisory-threshold <n>
  --max-concurrency <n> is accepted as an alias
  --quota-provider <id> --quota-account-key <stable account key>
  --quota-account-email <email> hashes the email in the Hub before persistence
  --clear-quota-link removes an existing quota binding
  --identity <masked identity> --enabled <true|false> --disabled`;
}

function parseOptions(tokens) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--') || token === '--') {
      positionals.push(token);
      continue;
    }
    const equalAt = token.indexOf('=');
    if (equalAt > 2) {
      options[token.slice(2, equalAt)] = token.slice(equalAt + 1);
      continue;
    }
    const name = token.slice(2);
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return { options, positionals };
}

function parseCommandLine(argv) {
  const separator = argv.indexOf('--');
  const ownTokens = separator === -1 ? argv : argv.slice(0, separator);
  const childCommand = separator === -1 ? [] : argv.slice(separator + 1);
  const commands = new Set(['account', 'status', 'start', 'heartbeat', 'stop', 'run', 'help']);
  const commandAt = ownTokens.findIndex((token) => commands.has(token));
  if (commandAt === -1) {
    const { options } = parseOptions(ownTokens);
    return { command: '', subcommand: '', options, positionals: [], childCommand };
  }

  const command = ownTokens[commandAt];
  const prefix = parseOptions(ownTokens.slice(0, commandAt));
  let rest = ownTokens.slice(commandAt + 1);
  let subcommand = '';
  if (command === 'account' && rest[0] && !rest[0].startsWith('--')) {
    subcommand = rest[0];
    rest = rest.slice(1);
  }
  const parsed = parseOptions(rest);
  return {
    command,
    subcommand,
    options: { ...prefix.options, ...parsed.options },
    positionals: [...prefix.positionals, ...parsed.positionals],
    childCommand
  };
}

function requiredOption(options, name) {
  const value = options[name];
  if (value === undefined || value === true || String(value).trim() === '') {
    throw new CliError(`Missing required option --${name}`, { code: 'invalid_arguments' });
  }
  return String(value).trim();
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`${label} must be a positive integer`, { code: 'invalid_arguments' });
  }
  return parsed;
}

function booleanOption(value, label) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new CliError(`${label} must be true or false`, { code: 'invalid_arguments' });
}

function connectionConfig(options, env = process.env) {
  const hubUrl = String(options['hub-url'] || options.hub || env.TOKEN_MONITOR_HUB_URL || DEFAULT_HUB_URL)
    .trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(hubUrl)) {
    throw new CliError('Hub URL must begin with http:// or https://', { code: 'invalid_arguments' });
  }
  return {
    hubUrl,
    secret: String(options.secret || env.TOKEN_MONITOR_SECRET || '').trim(),
    deviceId: String(options['device-id'] || env.TOKEN_MONITOR_DEVICE_ID || defaultDeviceId()).trim(),
    deviceName: String(options['device-name'] || env.TOKEN_MONITOR_DEVICE_NAME || os.hostname()).trim(),
    json: Boolean(options.json)
  };
}

function accountPayload(options, { partial = false } = {}) {
  const payload = {};
  if (!partial || options.provider !== undefined) payload.provider = requiredOption(options, 'provider');
  if (!partial || options.alias !== undefined) payload.alias = requiredOption(options, 'alias');
  const threshold = options['advisory-threshold'] ?? options['max-concurrency'];
  if (!partial || threshold !== undefined) {
    if (threshold === undefined || threshold === true || String(threshold).trim() === '') {
      throw new CliError('Missing required option --advisory-threshold', { code: 'invalid_arguments' });
    }
    payload.maxConcurrency = positiveInteger(threshold, '--advisory-threshold');
  }
  if (options.identity !== undefined) payload.maskedIdentity = String(options.identity).trim();
  const quotaProvider = options['quota-provider'];
  const quotaAccountKey = options['quota-account-key'];
  const quotaAccountEmail = options['quota-account-email'];
  if (quotaProvider !== undefined || quotaAccountKey !== undefined || quotaAccountEmail !== undefined) {
    payload.quotaLink = {
      provider: String(quotaProvider || '').trim(),
      accountKey: String(quotaAccountKey || '').trim(),
      accountEmail: String(quotaAccountEmail || '').trim()
    };
  }
  if (options['clear-quota-link'] !== undefined) payload.quotaLink = null;
  if (options.enabled !== undefined) payload.enabled = booleanOption(options.enabled, '--enabled');
  if (options.disabled !== undefined) payload.enabled = false;
  if (partial && Object.keys(payload).length === 0) {
    throw new CliError('No account fields were supplied', { code: 'invalid_arguments' });
  }
  return payload;
}

function errorMessage(payload, status) {
  if (payload && typeof payload === 'object') {
    return String(payload.message || payload.error || `Hub request failed (${status})`);
  }
  return `Hub request failed (${status})`;
}

function createHubClient({ hubUrl, secret, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  if (typeof fetchImpl !== 'function') throw new CliError('This CLI requires a Node.js runtime with fetch support');

  async function request(method, pathname, body) {
    const headers = { accept: 'application/json' };
    if (secret) headers.authorization = `Bearer ${secret}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${hubUrl}${pathname}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new CliError(`Could not reach Hub at ${hubUrl}: ${error.message}`, {
        code: error.name === 'TimeoutError' ? 'request_timeout' : 'network_error'
      });
    }

    const text = await response.text();
    let payload = null;
    if (text.trim()) {
      try { payload = JSON.parse(text); }
      catch (_) { payload = { message: text.trim() }; }
    }
    if (!response.ok) {
      throw new CliError(errorMessage(payload, response.status), {
        code: payload?.error || 'hub_error',
        status: response.status,
        payload
      });
    }
    return payload;
  }

  return {
    snapshot: () => request('GET', '/api/occupancy/snapshot'),
    listAccounts: () => request('GET', '/api/occupancy/accounts'),
    addAccount: (body) => request('POST', '/api/occupancy/accounts', body),
    updateAccount: (id, body) => request('PUT', `/api/occupancy/accounts/${encodeURIComponent(id)}`, body),
    removeAccount: (id) => request('DELETE', `/api/occupancy/accounts/${encodeURIComponent(id)}`),
    startLease: (body) => request('POST', '/api/occupancy/leases', body),
    heartbeat: (id, body) => request('POST', `/api/occupancy/leases/${encodeURIComponent(id)}/heartbeat`, body),
    stopLease: (id, body) => request('DELETE', `/api/occupancy/leases/${encodeURIComponent(id)}`, body)
  };
}

function accountArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (Array.isArray(payload?.snapshot?.accounts)) return payload.snapshot.accounts;
  return [];
}

async function resolveAccount(client, reference) {
  const payload = await client.listAccounts();
  const accounts = accountArray(payload);
  const exactId = accounts.find((account) => String(account.id) === reference);
  if (exactId) return exactId;
  const normalized = reference.toLocaleLowerCase();
  const aliasMatches = accounts.filter((account) => String(account.alias || '').toLocaleLowerCase() === normalized);
  if (aliasMatches.length === 1) return aliasMatches[0];
  if (aliasMatches.length > 1) {
    throw new CliError(`Account alias is ambiguous: ${reference}`, { code: 'ambiguous_account' });
  }
  throw new CliError(`Account not found: ${reference}`, { code: 'account_not_found' });
}

function stateIcon(account) {
  const state = String(account.state || account.light || account.status || '').toLowerCase();
  if (state === 'green' || state === 'available') return 'GREEN';
  if (state === 'yellow' || state === 'partial') return 'YELLOW';
  if (state === 'red' || state === 'full') return 'RED';
  if (state === 'gray' || state === 'grey' || state === 'offline') return 'GRAY';
  const active = Number(account.activeCount ?? account.currentConcurrency ?? account.usage ?? 0);
  const maximum = Number(account.advisoryThreshold ?? account.maxConcurrency ?? account.capacity ?? 0);
  if (maximum > 0 && active >= maximum) return 'RED';
  return active > 0 ? 'YELLOW' : 'GREEN';
}

function formatAccounts(payload) {
  const accounts = accountArray(payload);
  if (accounts.length === 0) return 'No occupancy accounts configured.';
  return accounts.map((account) => {
    const active = Number(account.activeCount ?? account.currentConcurrency ?? account.usage ?? 0);
    const maximum = Number(account.advisoryThreshold ?? account.maxConcurrency ?? account.capacity ?? 0);
    const identity = account.maskedIdentity ? ` ${account.maskedIdentity}` : '';
    return `[${stateIcon(account)}] ${account.alias || account.id} (${account.provider || 'unknown'}) ${active}/${maximum}${identity}`;
  }).join('\n');
}

function writeOutput(io, value, json = false) {
  const text = json
    ? JSON.stringify(value, null, 2)
    : (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  io.stdout.write(`${text}\n`);
}

function leaseIdFrom(payload) {
  return String(payload?.leaseId || payload?.lease?.id || '').trim();
}

function fenceTokenFrom(payload) {
  return String(payload?.fenceToken || payload?.lease?.fenceToken || '').trim();
}

function intervalFromEnv(env) {
  const heartbeatMs = positiveInteger(env.TOKEN_MONITOR_OCCUPANCY_HEARTBEAT_MS || DEFAULT_HEARTBEAT_MS, 'TOKEN_MONITOR_OCCUPANCY_HEARTBEAT_MS');
  const ttlMs = positiveInteger(env.TOKEN_MONITOR_OCCUPANCY_TTL_MS || DEFAULT_TTL_MS, 'TOKEN_MONITOR_OCCUPANCY_TTL_MS');
  if (heartbeatMs >= ttlMs) {
    throw new CliError('Occupancy heartbeat interval must be shorter than the lease TTL', { code: 'invalid_configuration' });
  }
  return { heartbeatMs, ttlMs };
}

async function runWithLease({ client, accountId, command, labels, connection, env, io, spawnImpl = spawn, signalEmitter = process }) {
  if (!command.length) throw new CliError('run requires a command after --', { code: 'invalid_arguments' });
  let timing = null;
  try { timing = intervalFromEnv(env); }
  catch (error) {
    io.stderr.write(`Warning: invalid occupancy timing configuration; starting command without reporting: ${error.message}\n`);
  }
  const heartbeatMs = timing?.heartbeatMs;
  const ttlMs = timing?.ttlMs;
  let leaseId = '';
  let fenceToken = '';
  if (accountId && timing) {
    try {
      // Generate the fencing token client-side so an idempotent retry can
      // return the same usable lease even when the first response was lost.
      const fenceTokenRequest = crypto.randomBytes(32).toString('base64url');
      const lease = await client.startLease({
        accountId,
        deviceId: connection.deviceId,
        deviceName: connection.deviceName,
        taskLabel: labels.task || `CLI: ${path.basename(command[0])}`,
        projectLabel: labels.project || path.basename(process.cwd()),
        source: 'wrapper',
        idempotencyKey: crypto.randomUUID(),
        fenceToken: fenceTokenRequest,
        ttlMs
      });
      leaseId = leaseIdFrom(lease);
      fenceToken = fenceTokenFrom(lease);
      if (!leaseId || !fenceToken) throw new CliError('Hub returned an invalid lease response', { code: 'invalid_hub_response' });
    } catch (error) {
      // Occupancy reporting is advisory. A Hub outage or stale account mapping
      // must never prevent the user's original AI command from starting.
      io.stderr.write(`Warning: occupancy reporting unavailable; starting command without it: ${error.message}\n`);
      leaseId = '';
      fenceToken = '';
    }
  }

  let releasePromise = null;
  let heartbeatRunning = false;
  const releaseOnce = (reason) => {
    if (!leaseId) return Promise.resolve();
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      try { await client.stopLease(leaseId, { fenceToken, reason }); }
      catch (error) { io.stderr.write(`Warning: could not release lease ${leaseId}: ${error.message}\n`); }
    })();
    return releasePromise;
  };

  let child;
  try {
    // Most AI CLIs are installed as .cmd shims on Windows. Node cannot launch
    // those with shell:false (ENOENT), while Unix binaries should remain direct
    // child processes so argument boundaries are preserved.
    child = spawnImpl(command[0], command.slice(1), {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...env }
    });
  } catch (error) {
    await releaseOnce('spawn_failed');
    throw new CliError(`Could not start ${command[0]}: ${error.message}`, { code: 'spawn_failed' });
  }

  const heartbeatTimer = leaseId
    ? setInterval(async () => {
      if (heartbeatRunning || releasePromise) return;
      heartbeatRunning = true;
      try { await client.heartbeat(leaseId, { fenceToken, ttlMs }); }
      catch (error) { io.stderr.write(`Warning: lease heartbeat failed: ${error.message}\n`); }
      finally { heartbeatRunning = false; }
    }, heartbeatMs)
    : null;

  let receivedSignal = '';
  let releaseReason = 'process_exit';
  let killTimer = null;
  const signalHandlers = new Map();
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    const handler = () => {
      if (receivedSignal) return;
      receivedSignal = signal;
      clearInterval(heartbeatTimer);
      try { child.kill(signal); } catch (_) {}
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3_000);
    };
    signalHandlers.set(signal, handler);
    signalEmitter.on(signal, handler);
  }

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      releaseReason = 'spawn_failed';
      reject(new CliError(`Could not start ${command[0]}: ${error.message}`, { code: 'spawn_failed' }));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      releaseReason = Number.isInteger(code) ? `exit_${code}` : (signal ? `signal_${String(signal).toLowerCase()}` : 'process_exit');
      resolve({ code, signal });
    });
  }).finally(async () => {
    clearInterval(heartbeatTimer);
    if (killTimer) clearTimeout(killTimer);
    for (const [signal, handler] of signalHandlers) signalEmitter.off(signal, handler);
    await releaseOnce(receivedSignal ? `signal_${receivedSignal.toLowerCase()}` : releaseReason);
  });

  if (receivedSignal) return SIGNAL_EXIT_CODES[receivedSignal];
  if (Number.isInteger(result.code)) return result.code;
  return result.signal ? (SIGNAL_EXIT_CODES[result.signal] || 1) : 1;
}

async function execute(parsed, deps = {}) {
  const env = deps.env || process.env;
  const io = deps.io || { stdout: process.stdout, stderr: process.stderr };
  if (parsed.options.help || parsed.command === 'help' || !parsed.command) {
    writeOutput(io, usage());
    return 0;
  }

  const connection = connectionConfig(parsed.options, env);
  const client = deps.client || createHubClient({
    hubUrl: connection.hubUrl,
    secret: connection.secret,
    fetchImpl: deps.fetchImpl
  });

  if (parsed.command === 'account') {
    if (parsed.subcommand === 'list') {
      const result = await client.listAccounts();
      writeOutput(io, connection.json ? result : formatAccounts(result), connection.json);
      return 0;
    }
    if (parsed.subcommand === 'add') {
      const result = await client.addAccount(accountPayload(parsed.options));
      writeOutput(io, result, connection.json);
      return 0;
    }
    if (parsed.subcommand === 'update') {
      const reference = parsed.positionals[0];
      if (!reference) throw new CliError('account update requires an id or alias', { code: 'invalid_arguments' });
      const account = await resolveAccount(client, reference);
      const result = await client.updateAccount(account.id, accountPayload(parsed.options, { partial: true }));
      writeOutput(io, result, connection.json);
      return 0;
    }
    if (parsed.subcommand === 'remove') {
      const reference = parsed.positionals[0];
      if (!reference) throw new CliError('account remove requires an id or alias', { code: 'invalid_arguments' });
      const account = await resolveAccount(client, reference);
      const result = await client.removeAccount(account.id);
      writeOutput(io, result, connection.json);
      return 0;
    }
    throw new CliError('Unknown account command. Use list, add, update, or remove.', { code: 'invalid_arguments' });
  }

  if (parsed.command === 'status') {
    const result = await client.snapshot();
    writeOutput(io, connection.json ? result : formatAccounts(result), connection.json);
    return 0;
  }

  if (parsed.command === 'start') {
    const account = await resolveAccount(client, requiredOption(parsed.options, 'account'));
    const { ttlMs } = intervalFromEnv(env);
    const fenceToken = crypto.randomBytes(32).toString('base64url');
    const result = await client.startLease({
      accountId: account.id,
      deviceId: connection.deviceId,
      deviceName: connection.deviceName,
      taskLabel: parsed.options.task ? String(parsed.options.task) : undefined,
      projectLabel: parsed.options.project ? String(parsed.options.project) : undefined,
      source: 'manual',
      idempotencyKey: String(parsed.options['idempotency-key'] || crypto.randomUUID()),
      fenceToken,
      ttlMs
    });
    writeOutput(io, result, connection.json);
    return 0;
  }

  if (parsed.command === 'heartbeat') {
    const leaseId = parsed.positionals[0] || parsed.options.lease;
    if (!leaseId) throw new CliError('heartbeat requires a lease id', { code: 'invalid_arguments' });
    const { ttlMs } = intervalFromEnv(env);
    const result = await client.heartbeat(String(leaseId), {
      fenceToken: requiredOption(parsed.options, 'fence-token'),
      ttlMs
    });
    writeOutput(io, result, connection.json);
    return 0;
  }

  if (parsed.command === 'stop') {
    const leaseId = parsed.positionals[0] || parsed.options.lease;
    if (!leaseId) throw new CliError('stop requires a lease id', { code: 'invalid_arguments' });
    const result = await client.stopLease(String(leaseId), {
      fenceToken: requiredOption(parsed.options, 'fence-token'),
      reason: String(parsed.options.reason || 'manual_stop')
    });
    writeOutput(io, result, connection.json);
    return 0;
  }

  if (parsed.command === 'run') {
    const accountReference = requiredOption(parsed.options, 'account');
    let accountId = '';
    try {
      accountId = (await resolveAccount(client, accountReference)).id;
    } catch (error) {
      // Fail open for the wrapper command: a monitoring problem must not turn
      // into an AI tool outage. runWithLease will launch without telemetry.
      io.stderr.write(`Warning: could not resolve occupancy account "${accountReference}": ${error.message}\n`);
    }
    return runWithLease({
      client,
      accountId,
      command: parsed.childCommand,
      labels: { task: parsed.options.task, project: parsed.options.project },
      connection,
      env,
      io,
      spawnImpl: deps.spawnImpl,
      signalEmitter: deps.signalEmitter
    });
  }

  throw new CliError(`Unknown command: ${parsed.command}`, { code: 'invalid_arguments' });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  return execute(parseCommandLine(argv), deps);
}

if (require.main === module) {
  loadDotEnv();
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    const prefix = error.status ? `Hub error ${error.status}` : 'Error';
    process.stderr.write(`${prefix}: ${error.message}\n`);
    process.exitCode = error.status === 409 ? 2 : 1;
  });
}

module.exports = {
  CliError,
  accountArray,
  accountPayload,
  connectionConfig,
  createHubClient,
  execute,
  formatAccounts,
  main,
  parseCommandLine,
  resolveAccount,
  runWithLease,
  usage
};
