'use strict';

// Grok (xAI) SuperGrok subscription usage lookup.
//
// Primary path: Grok CLI's `grok agent stdio` JSON-RPC extension method
// `x.ai/billing`. Web fallback mirrors CodexBar/tokscale's grok.com
// gRPC-web billing endpoint with a bearer token from ~/.grok/auth.json
// (written by `grok login`) or GROK_BEARER_TOKEN env var.
//
// The CLI RPC may return a JSON `config` envelope; the web fallback returns
// the protobuf `GetGrokCreditsConfig` response used by CodexBar.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { createOutboundFetch } = require('./outboundFetch');

const GROK_WEB_BILLING_GRPC_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const GROK_KEY_NAMES = ['GROK_BEARER_TOKEN'];
const GROK_OIDC_PREFIX = 'https://auth.x.ai::';
const GROK_LEGACY_SCOPE = 'https://accounts.x.ai/sign-in';

function resolveGrokHome(env = process.env) {
  if (typeof env.GROK_HOME === 'string' && env.GROK_HOME.trim()) {
    return path.resolve(env.GROK_HOME.trim());
  }
  return path.join(os.homedir(), '.grok');
}

function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

// Read ~/.grok/auth.json. Prefer OIDC scope (SuperGrok), fall back to legacy
// /sign-in, then fall back to any entry with a non-empty `key` field.
// Returns { token, source, path } or null. Synchronous — uses fs.readFileSync
// because auth.json is tiny and the only async entry point (limitCollector)
// just needs the data ready before issuing the HTTP fetch.
function readAuthJson(env = process.env, deps = {}) {
  const home = deps.grokHome || resolveGrokHome(env);
  const filePath = path.join(home, 'auth.json');
  let raw;
  try {
    raw = (deps.readFileSync || fs.readFileSync)(filePath, 'utf8');
  } catch (_) {
    return null;
  }
  let root;
  try { root = JSON.parse(raw); } catch (_) { return null; }
  if (!root || typeof root !== 'object') return null;
  const entries = Object.entries(root).filter(([, v]) => v && typeof v === 'object'
    && typeof v.key === 'string' && v.key.trim() !== '');
  const oidc = entries.find(([scope]) => scope.startsWith(GROK_OIDC_PREFIX));
  const legacy = entries.find(([scope]) => scope === GROK_LEGACY_SCOPE || scope.includes('/sign-in'));
  const picked = oidc || legacy || entries[0];
  if (!picked) return null;
  const [scope, entry] = picked;
  return {
    token: entry.key.trim(),
    source: oidc ? 'auth.json-oidc' : legacy ? 'auth.json-legacy' : `auth.json:${scope}`,
    email: typeof entry.email === 'string' ? entry.email.trim() : '',
    path: filePath
  };
}

function grokCredential(env = process.env, options = {}) {
  // Priority: explicit settings > env > ~/.grok/auth.json (auto).
  // The widget GUI no longer exposes a token field; env var and auth.json
  // cover headless / CLI flows.
  if (options && options.grokBearerToken) {
    const raw = cleanSecret(options.grokBearerToken);
    if (raw) return { token: raw, source: 'settings' };
  }
  for (const name of GROK_KEY_NAMES) {
    const raw = cleanSecret(env[name]);
    if (raw) return { token: raw, source: 'env' };
  }
  return readAuthJson(env, options);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && value !== null && 'val' in value) return numberOrNull(value.val);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function normalizeIsoReset(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ts = Date.parse(value.trim());
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null;
}

function dateMs(value) {
  const iso = normalizeIsoReset(value);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function windowMinutesFromBillingCycle(start, end) {
  const startMs = dateMs(start);
  const endMs = dateMs(end);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return Math.round((endMs - startMs) / 60000);
}

function billingWindowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Monthly';
  const days = Math.round(minutes / (24 * 60));
  if (days >= 4 && days <= 12) return 'Weekly';
  if (days >= 20 && days <= 45) return 'Monthly';
  return 'Billing';
}

// Build a single window spec from a (used, limit) pair. Returns null when
// limit is missing/zero or used is unknown.
function buildWindow(label, used, limit, resetsAt, windowMinutes = null) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return {
    kind: 'billing',
    label,
    usedPercent: clampPercent((used / limit) * 100),
    resetsAt,
    windowMinutes,
    showMeter: true
  };
}

// Parse JSON billing from RPC `x.ai/billing` into one quota window. Prefer
// newer unified-credits fields when present; retain monthlyLimit/used support
// for current CLI response compatibility.
function parseGrokBilling(body) {
  const root = body && typeof body === 'object' ? body : null;
  const config = root && root.config && typeof root.config === 'object' ? root.config : root;
  if (!config || typeof config !== 'object') {
    const err = new Error('Grok billing response missing config');
    err.status = 'unavailable';
    throw err;
  }

  // Newer credits-config shape (creditUsagePercent + currentPeriod).
  const creditPercent = numberOrNull(
    config.creditUsagePercent ?? config.credit_usage_percent
  );
  const currentPeriod = config.currentPeriod && typeof config.currentPeriod === 'object'
    ? config.currentPeriod
    : (config.current_period && typeof config.current_period === 'object' ? config.current_period : null);
  if (creditPercent !== null) {
    const periodStart = currentPeriod?.start ?? currentPeriod?.billingPeriodStart;
    const periodEnd = currentPeriod?.end ?? currentPeriod?.billingPeriodEnd;
    const resetAt = normalizeIsoReset(periodEnd);
    const windowMinutes = windowMinutesFromBillingCycle(periodStart, periodEnd);
    const label = billingWindowLabel(windowMinutes);
    const periodType = String(currentPeriod?.type || currentPeriod?.period_type || currentPeriod?.periodType || '').toUpperCase();
    const forcedLabel = periodType.includes('WEEK') ? 'Weekly' : periodType.includes('MONTH') ? 'Monthly' : label;
    // Percent is already 0–100 usage; model as used/limit against 100.
    const window = buildWindow(forcedLabel, creditPercent, 100, resetAt, windowMinutes);
    if (window) return [window];
  }

  const monthlyLimit = numberOrNull(config.monthlyLimit);
  const usage = config.usage && typeof config.usage === 'object' ? config.usage : null;
  const used = numberOrNull(config.used ?? config.totalUsed ?? usage?.totalUsed ?? usage?.includedUsed);
  const billingCycle = config.billingCycle && typeof config.billingCycle === 'object' ? config.billingCycle : null;
  const billingPeriodStart = config.billingPeriodStart ?? billingCycle?.billingPeriodStart;
  const billingPeriodEnd = config.billingPeriodEnd ?? billingCycle?.billingPeriodEnd;
  const resetAt = normalizeIsoReset(billingPeriodEnd);
  const windowMinutes = windowMinutesFromBillingCycle(billingPeriodStart, billingPeriodEnd);
  const label = billingWindowLabel(windowMinutes);

  const monthly = buildWindow(label, used, monthlyLimit, resetAt, windowMinutes);
  if (!monthly) {
    const err = new Error('Grok billing response has no monthly quota');
    err.status = 'unavailable';
    throw err;
  }
  return [monthly];
}

function bufferFrom(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.alloc(0);
}

function grpcWebDataFrames(data) {
  const bytes = bufferFrom(data);
  const frames = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) return [];
    const flags = bytes[offset];
    const length = bytes.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (end > bytes.length) return [];
    if ((flags & 0x80) === 0) frames.push(bytes.subarray(start, end));
    offset = end;
  }
  return frames;
}

function grpcWebTrailerFields(data) {
  const bytes = bufferFrom(data);
  const fields = {};
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const flags = bytes[offset];
    const length = bytes.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (end > bytes.length) break;
    if ((flags & 0x80) !== 0) {
      const text = bytes.subarray(start, end).toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
      }
    }
    offset = end;
  }
  return fields;
}

function grpcField(fields, name) {
  if (!fields) return '';
  if (typeof fields.get === 'function') return String(fields.get(name) || '');
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(fields)) {
    if (String(key).toLowerCase() === target) return String(value || '');
  }
  return '';
}

function decodeGrpcMessage(value) {
  const raw = String(value || '');
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

function validateGrokGrpcStatus(fields) {
  const rawStatus = grpcField(fields, 'grpc-status');
  if (!rawStatus || rawStatus === '0') return;
  const status = Number(rawStatus);
  const message = decodeGrpcMessage(grpcField(fields, 'grpc-message'));
  const lower = message.toLowerCase();
  const authenticationFailure = status === 16
    || (status === 7 && (
      lower.includes('bad-credentials')
      || lower.includes('unauthenticated')
      || (lower.includes('oauth2') && lower.includes('could not be validated'))
      || (lower.includes('access token') && (
        lower.includes('invalid')
        || lower.includes('expired')
        || lower.includes('could not be validated')
      ))
    ));
  const error = new Error(authenticationFailure
    ? 'Grok web billing rejected credentials'
    : `Grok web billing RPC failed (status ${rawStatus}${message ? `: ${message}` : ''})`);
  error.status = authenticationFailure ? 'unauthorized' : 'unavailable';
  throw error;
}

function looksLikeProtobufPayload(data) {
  const bytes = bufferFrom(data);
  if (!bytes.length) return false;
  const fieldNumber = bytes[0] >> 3;
  const wireType = bytes[0] & 0x07;
  return fieldNumber > 0 && (wireType === 0 || wireType === 1 || wireType === 2 || wireType === 5);
}

function readProtoVarint(bytes, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < bytes.length && shift <= 63n) {
    const byte = bytes[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value: Number(value), offset };
    }
    shift += 7n;
  }
  return null;
}

function scanGrokProto(data, depth = 0, path = [], state = null) {
  const bytes = bufferFrom(data);
  const out = state || { fixed32Fields: [], varintFields: [], order: 0 };
  if (!bytes.length || depth > 8) return out;

  let offset = 0;
  while (offset < bytes.length) {
    const key = readProtoVarint(bytes, offset);
    if (!key) return out;
    offset = key.offset;
    const field = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (field <= 0) return out;
    const nextPath = path.concat(field);

    if (wireType === 0) {
      const read = readProtoVarint(bytes, offset);
      if (!read) return out;
      out.varintFields.push({ path: nextPath, value: read.value, order: out.order++ });
      offset = read.offset;
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) return out;
      offset += 8;
    } else if (wireType === 2) {
      const read = readProtoVarint(bytes, offset);
      if (!read) return out;
      offset = read.offset;
      const end = offset + read.value;
      if (read.value < 0 || end > bytes.length) return out;
      if (read.value > 0) scanGrokProto(bytes.subarray(offset, end), depth + 1, nextPath, out);
      offset = end;
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) return out;
      out.fixed32Fields.push({ path: nextPath, value: bytes.readFloatLE(offset), order: out.order++ });
      offset += 4;
    } else {
      return out;
    }
  }

  return out;
}

function parseGrokGrpcWebBilling(data, nowMs = Date.now()) {
  let payloads = grpcWebDataFrames(data);
  const bytes = bufferFrom(data);
  if (payloads.length === 0 && looksLikeProtobufPayload(bytes)) payloads = [bytes];
  if (payloads.length === 0) {
    const err = new Error('Grok web billing returned no protobuf payload');
    err.status = 'unavailable';
    throw err;
  }

  const scan = { fixed32Fields: [], varintFields: [], order: 0 };
  for (const payload of payloads) scanGrokProto(payload, 0, [], scan);

  const percentField = scan.fixed32Fields
    .filter((field) => field.path[field.path.length - 1] === 1
      && Number.isFinite(field.value)
      && field.value >= 0
      && field.value <= 100)
    .sort((a, b) => (a.path.length - b.path.length) || (a.order - b.order))[0];

  const timestampFields = scan.varintFields
    .filter((field) => field.value >= 1_700_000_000 && field.value <= 2_100_000_000)
    .map((field) => ({ ...field, ms: field.value * 1000 }));
  const futureResets = timestampFields
    .filter((field) => field.ms > nowMs);
  const preferredStart = timestampFields
    .filter((field) => field.path.join('.') === '1.4.1')
    .sort((a, b) => b.ms - a.ms)[0]
    || null;
  const preferredReset = futureResets
    .filter((field) => field.path.join('.') === '1.5.1')
    .sort((a, b) => a.ms - b.ms)[0]
    || futureResets.sort((a, b) => a.ms - b.ms)[0]
    || null;

  const hasUsagePeriod = scan.varintFields.some((field) => {
    const key = field.path.join('.');
    return key.startsWith('1.6') || (key === '1.8.1' && (field.value === 1 || field.value === 2));
  });
  const noUsageYet = !percentField && scan.fixed32Fields.length === 0 && preferredReset && hasUsagePeriod;
  const percent = percentField ? percentField.value : noUsageYet ? 0 : null;
  if (percent === null) {
    const err = new Error('Could not parse Grok web billing usage');
    err.status = 'unavailable';
    throw err;
  }

  const resetsAt = preferredReset ? new Date(preferredReset.ms).toISOString() : null;
  const minutesUntilReset = preferredReset ? Math.round((preferredReset.ms - nowMs) / 60000) : null;
  const windowMinutes = preferredStart && preferredReset && preferredReset.ms > preferredStart.ms
    ? Math.round((preferredReset.ms - preferredStart.ms) / 60000)
    : null;
  return [buildWindow(billingWindowLabel(windowMinutes ?? minutesUntilReset), percent, 100, resetsAt, windowMinutes)];
}

function grokRpcCommand(env = process.env, options = {}) {
  const explicit = cleanSecret(options.grokCommand || env.GROK_CLI_PATH);
  return explicit || 'grok';
}

function grokRpcArgs(options = {}) {
  return Array.isArray(options.grokRpcArgs) && options.grokRpcArgs.length
    ? options.grokRpcArgs.map(String)
    : ['agent', 'stdio'];
}

function classifyGrokRpcError(error) {
  const message = String(error && (error.message || error) || '').toLowerCase();
  if (error && error.code === 'ENOENT') return 'notConfigured';
  if (error && error.status) return error.status;
  if (message.includes('authentication required') || message.includes('grok login') || message.includes('not authenticated')) {
    return 'unauthorized';
  }
  return 'unavailable';
}

function grokRpcError(message, status = 'unavailable') {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function fetchGrokRpcBilling(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const spawnFn = deps.spawn || spawn;
  const command = grokRpcCommand(env, options);
  const args = grokRpcArgs(options);
  const timeoutMs = Number(deps.rpcTimeoutMs || deps.fetchTimeoutMs || 5000);

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let initialized = false;
    let buffer = '';
    let timer = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (child && typeof child.kill === 'function') {
        try { child.kill(); } catch (_) {}
      }
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    }

    function writeJsonLine(value) {
      const raw = JSON.stringify(value).replace(/\\\//g, '/');
      child.stdin.write(raw + '\n');
    }

    function handleMessage(message) {
      if (!message || typeof message !== 'object') return;
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error && typeof message.error === 'object') {
        const text = typeof message.error.message === 'string' ? message.error.message : 'Grok RPC request failed';
        finish(grokRpcError(text, classifyGrokRpcError({ message: text })));
        return;
      }
      if (message.id === 1 && !initialized) {
        initialized = true;
        writeJsonLine({
          jsonrpc: '2.0',
          id: 2,
          method: 'x.ai/billing',
          params: {}
        });
        return;
      }
      if (message.id === 2) {
        if (!message.result || typeof message.result !== 'object') {
          finish(grokRpcError('Grok RPC billing response missing result'));
          return;
        }
        finish(null, message.result);
      }
    }

    try {
      child = spawnFn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      finish(error);
      return;
    }

    timer = setTimeout(() => finish(grokRpcError('Grok RPC timed out')), timeoutMs);
    child.on?.('error', finish);
    child.on?.('exit', (code) => {
      if (!settled) finish(grokRpcError(`Grok RPC exited before billing response (${code ?? 'unknown'})`));
    });
    child.stdout?.on?.('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch (_) {
            // Ignore non-JSON stdout noise from the CLI.
          }
        }
        newline = buffer.indexOf('\n');
      }
    });

    writeJsonLine({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '1',
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        }
      }
    });
  });
}

function shouldTryGrokRpc(credential, deps = {}) {
  if (typeof deps.fetchRpcBilling === 'function') return true;
  return credential && typeof credential.source === 'string' && credential.source.startsWith('auth.json');
}

function unauthorizedGrokProvider(updatedAt, source = 'web', sourceDetail = '') {
  return normalizeLimitProvider({
    provider: 'grok',
    source,
    sourceDetail,
    status: 'unauthorized',
    updatedAt,
    windows: []
  });
}

function resolveGrokFetch(deps = {}) {
  if (typeof deps.fetch === 'function') return deps.fetch;
  return createOutboundFetch(deps.env || process.env);
}

function isRetryableNetworkError(error) {
  if (!error || error.status === 'unauthorized') return false;
  const code = String(error.code || error.cause?.code || '');
  const message = String(error.message || error.cause?.message || error || '').toLowerCase();
  // A reachable proxy/host actively refused the connection; an immediate
  // retry cannot help and `fetch failed` must not classify it as transient.
  if (code === 'ECONNREFUSED') return false;
  return code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_SOCKET'
    || message.includes('fetch failed')
    || message.includes('socket disconnected')
    || message.includes('connect timeout');
}

async function fetchGrokWebGrpcBillingOnce(credential, deps = {}) {
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const fetchFn = resolveGrokFetch(deps);
    const response = await fetchFn(GROK_WEB_BILLING_GRPC_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.token}`,
        'X-XAI-Token-Auth': 'xai-grok-cli',
        Accept: '*/*',
        'Content-Type': 'application/grpc-web+proto',
        'User-Agent': 'Grok Build',
        Origin: 'https://grok.com',
        Referer: 'https://grok.com/?_s=usage',
        'x-grpc-web': '1',
        'x-user-agent': 'connect-es/2.1.1'
      },
      body: Buffer.from([0, 0, 0, 0, 0]),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (response.status === 401 || response.status === 403) {
      const err = new Error('Grok web billing rejected credentials');
      err.status = 'unauthorized';
      throw err;
    }
    if (!response.ok) {
      const err = new Error(`Grok web billing request failed (HTTP ${response.status})`);
      err.status = 'unavailable';
      throw err;
    }
    validateGrokGrpcStatus(response.headers);
    const body = Buffer.from(await response.arrayBuffer());
    validateGrokGrpcStatus(grpcWebTrailerFields(body));
    return parseGrokGrpcWebBilling(body, (deps.now || Date.now)());
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Local proxies occasionally reset the first CONNECT; one silent retry is enough
// to keep the Grok meter green without lengthening the happy path much.
async function fetchGrokWebGrpcBilling(credential, deps = {}) {
  try {
    return await fetchGrokWebGrpcBillingOnce(credential, deps);
  } catch (error) {
    if (!isRetryableNetworkError(error)) throw error;
    return fetchGrokWebGrpcBillingOnce(credential, deps);
  }
}

async function fetchGrokLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const credential = grokCredential(env, { ...options, ...(deps.grokHome ? { grokHome: deps.grokHome } : {}) });
  if (shouldTryGrokRpc(credential, deps)) {
    try {
      const rpcBody = await (deps.fetchRpcBilling || fetchGrokRpcBilling)(options, deps);
      const windows = parseGrokBilling(rpcBody);
      return normalizeLimitProvider({
        provider: 'grok',
        accountKey: credential ? hashKey('grok', credential.token) : '',
        accountLabel: 'SuperGrok',
        accountEmail: credential?.email || '',
        source: 'rpc',
        sourceDetail: 'cli',
        status: 'ok',
        updatedAt,
        windows
      });
    } catch (error) {
      const status = classifyGrokRpcError(error);
      if (!credential || status === 'unauthorized') {
        return status === 'unauthorized'
          ? unauthorizedGrokProvider(updatedAt, 'rpc', 'cli')
          : normalizeLimitProvider({
            provider: 'grok',
            source: 'rpc',
            sourceDetail: 'cli',
            status,
            updatedAt,
            windows: []
          });
      }
      // With an auth.json credential available, CodexBar falls back from CLI RPC
      // to the web billing path in auto mode. Preserve that behavior here.
    }
  }
  if (!credential) {
    return normalizeLimitProvider({
      provider: 'grok',
      source: 'web',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }
  let windows;
  try {
    windows = await (deps.fetchWebGrpcBilling || fetchGrokWebGrpcBilling)(credential, deps);
  } catch (webError) {
    return normalizeLimitProvider({
      provider: 'grok',
      source: 'web',
      sourceDetail: 'credits-config',
      status: webError && webError.status ? webError.status : 'unavailable',
      updatedAt,
      windows: []
    });
  }

  try {
    return normalizeLimitProvider({
      provider: 'grok',
      accountKey: hashKey('grok', credential.token),
      accountLabel: 'SuperGrok',
      accountEmail: credential.email || '',
      source: 'web',
      sourceDetail: 'credits-config',
      status: 'ok',
      updatedAt,
      windows
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'grok',
      source: 'web',
      status: error && error.status ? error.status : 'unavailable',
      updatedAt,
      windows: []
    });
  }
}

module.exports = {
  GROK_WEB_BILLING_GRPC_URL,
  GROK_KEY_NAMES,
  GROK_OIDC_PREFIX,
  GROK_LEGACY_SCOPE,
  resolveGrokHome,
  readAuthJson,
  grokCredential,
  parseGrokBilling,
  parseGrokGrpcWebBilling,
  fetchGrokRpcBilling,
  fetchGrokWebGrpcBilling,
  fetchGrokLimits,
  isRetryableNetworkError,
  grpcWebTrailerFields,
  validateGrokGrpcStatus,
  billingWindowLabel
};
