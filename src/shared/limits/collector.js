'use strict';

const { LIMIT_PROVIDER_IDS } = require('../limitProviders');
const {
  DEFAULT_LIMITS_REFRESH_MS,
  normalizeLimitProvider,
  normalizeLimitsSummary
} = require('./core');
const { parseRetryAfterHeader } = require('./retryPolicy');
const openrouterLimits = require('../providers/openrouter/limits');
const thirdPartyLimits = require('../providers/thirdparty/limits');
const minimaxLimits = require('../providers/minimax/limits');
const { minimaxToken, minimaxBaseUrl, parseMinimaxTiers, fetchMinimaxLimits } = minimaxLimits;
const mimoLimits = require('../providers/mimo/limits');
const { fetchMimoLimits } = mimoLimits;
const grokLimits = require('../providers/grok/limits');
const copilotLimits = require('../providers/copilot/limits');
const { copilotToken, fetchCopilotLimits } = copilotLimits;
const kiroLimits = require('../providers/kiro/limits');
const { parseKiroUsage, fetchKiroLimits } = kiroLimits;
const zaiLimits = require('../providers/zai/limits');
const { zaiToken, zaiRegion, fetchZaiLimits } = zaiLimits;
const zaiTeamLimits = require('../providers/zaiteam/limits');
const { fetchZaiTeamLimits, zaiTeamToken } = zaiTeamLimits;
const volcengineLimits = require('../providers/volcengine/limits');
const alibabaLimits = require('../providers/alibaba/limits');
const { volcengineCredentials, fetchVolcengineLimits } = volcengineLimits;
const qoderLimits = require('../providers/qoder/limits');
const { qoderCookie, fetchQoderLimits } = qoderLimits;
const commandcodeLimits = require('../providers/commandcode/limits');
const { commandcodeCookie, fetchCommandcodeLimits } = commandcodeLimits;
const ollamaLimits = require('../providers/ollama/limits');
const { ollamaSessionCookie, fetchOllamaLimits } = ollamaLimits;
const kimiLimits = require('../providers/kimi/limits');
const { kimiToken, kimiWebToken, fetchKimiLimits } = kimiLimits;
const workbuddyLimits = require('../providers/workbuddy/limits');
const traeLimits = require('../providers/trae/limits');
const zedLimits = require('../providers/zed/limits');
const {
  grokCredential,
  readAuthJson,
  parseGrokBilling,
  parseGrokGrpcWebBilling,
  fetchGrokRpcBilling,
  fetchGrokWebGrpcBilling,
  fetchGrokLimits
} = grokLimits;
const {
  nowIso,
  parseBoolean,
  providerStatusFromError,
  runProcessText
} = require('./providerHelpers');
const claudeLimits = require('../providers/claude/limits');
const codexLimits = require('../providers/codex/limits');
const {
  claudeCommandCandidates,
  claudeWebCookie,
  delegatedClaudeRefresh,
  fetchClaudeLimits,
  mapClaudeCliUsageToProvider,
  mapClaudeUsageToProvider,
  normalizeClaudeWebCookieInput,
  parseClaudeCliUsageText,
  rankClaudeCredentialFiles,
  refreshClaudeAccessToken,
  refreshClaudeCredentials,
  touchClaudeAuthPath,
  wslClaudeCredentialPaths
} = claudeLimits;
const {
  codexCommandCandidates,
  codexCommandSourceDetail,
  fetchCodexLimits,
  mapCodexRateLimitsToProvider,
  normalizeCodexManagedAccounts,
  readCodexRpcWithCommand,
  runCodexLogin
} = codexLimits;

const { fetchAntigravityLimits } = require('../providers/antigravity/limits');
const { fetchOpenCodeLimits, fetchOpenCodeProfile } = require('../providers/opencode/limits');
const { deepseekToken, fetchDeepSeekLimits, selectFundedRow } = require('../providers/deepseek/limits');
const { fetchCursorLimits } = require('../providers/cursor/limits');

const DEFAULT_PROVIDER_PHYSICAL_BOUND_MS = 120_000;
const PROVIDER_CLEANUP_GRACE_MS = 5_000;
const LIMIT_REFRESH_VALUES = new Set([60_000, 120_000, 300_000, 900_000, 1_800_000]);
function parseLimitProviders(value) {
  // Omission keeps the historical default; an explicitly empty setting means
  // that no provider is enabled and must survive persistence/reload.
  const source = value === undefined || value === null ? LIMIT_PROVIDER_IDS : value;
  const raw = Array.isArray(source) ? source : String(source).split(',');
  const seen = new Set();
  const providers = [];
  for (const item of raw) {
    const provider = String(item || '').trim().toLowerCase();
    if (!LIMIT_PROVIDER_IDS.includes(provider) || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers;
}

function normalizeLimitsRefreshMs(value) {
  const parsed = Number(value);
  if (LIMIT_REFRESH_VALUES.has(parsed)) return parsed;
  return DEFAULT_LIMITS_REFRESH_MS;
}

// A scheduling policy, kept separate from limitsRefreshMs so that switching to
// adaptive and back restores the interval the user had chosen, and so that no
// consumer doing arithmetic on limitsRefreshMs has to handle a sentinel value.
function normalizeLimitsRefreshMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'adaptive' ? 'adaptive' : 'fixed';
}

function statusProvider(provider, status, updatedAt) {
  return normalizeLimitProvider({ provider, status, updatedAt, windows: [] });
}

function providerFetchers(deps = {}) {
  return {
    claude: (providerOptions, probeDeps) => fetchClaudeLimits(providerOptions, probeDeps),
    codex: (providerOptions, probeDeps) => fetchCodexLimits(providerOptions, probeDeps),
    cursor: (providerOptions, probeDeps) => fetchCursorLimits(providerOptions, probeDeps),
    antigravity: (providerOptions, probeDeps) => fetchAntigravityLimits(providerOptions, probeDeps),
    opencode: (providerOptions, probeDeps) => fetchOpenCodeLimits(providerOptions, probeDeps),
    openrouter: (providerOptions, probeDeps) => openrouterLimits.fetchOpenRouterLimits(providerOptions, probeDeps),
    deepseek: (providerOptions, probeDeps) => fetchDeepSeekLimits(providerOptions, probeDeps),
    minimax: (providerOptions, probeDeps) => minimaxLimits.fetchMinimaxLimits(providerOptions, probeDeps),
    mimo: (providerOptions, probeDeps) => fetchMimoLimits(providerOptions, probeDeps),
    grok: (providerOptions, probeDeps) => grokLimits.fetchGrokLimits(providerOptions, probeDeps),
    copilot: (providerOptions, probeDeps) => copilotLimits.fetchCopilotLimits(providerOptions, probeDeps),
    kiro: (providerOptions, probeDeps) => kiroLimits.fetchKiroLimits(providerOptions, probeDeps),
    zai: (providerOptions, probeDeps) => zaiLimits.fetchZaiLimits(providerOptions, probeDeps),
    zaiteam: (providerOptions, probeDeps) => zaiTeamLimits.fetchZaiTeamLimits(providerOptions, probeDeps),
    volcengine: (providerOptions, probeDeps) => volcengineLimits.fetchVolcengineLimits(providerOptions, probeDeps),
    alibaba: (providerOptions, probeDeps) => alibabaLimits.fetchAlibabaLimits(providerOptions, probeDeps),
    commandcode: (providerOptions, probeDeps) => commandcodeLimits.fetchCommandcodeLimits(providerOptions, probeDeps),
    qoder: (providerOptions, probeDeps) => qoderLimits.fetchQoderLimits(providerOptions, probeDeps),
    trae: (providerOptions, probeDeps) => traeLimits.fetchTraeLimits(providerOptions, probeDeps),
    workbuddy: (providerOptions, probeDeps) => workbuddyLimits.fetchWorkbuddyLimits(providerOptions, probeDeps),
    ollama: (providerOptions, probeDeps) => ollamaLimits.fetchOllamaLimits(providerOptions, probeDeps),
    kimi: (providerOptions, probeDeps) => kimiLimits.fetchKimiLimits(providerOptions, probeDeps),
    zed: (providerOptions, probeDeps) => zedLimits.fetchZedLimits(providerOptions, probeDeps),
    thirdparty: (providerOptions, probeDeps) => thirdPartyLimits.fetchThirdPartyLimits(providerOptions, probeDeps),
    ...(deps.providerFetchers || {})
  };
}

function providerPhysicalBoundMs(provider, options = {}, deps = {}) {
  const configured = Number(deps.providerPhysicalBounds?.[provider]);
  const base = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_PROVIDER_PHYSICAL_BOUND_MS;
  let jobs = 1;
  if (provider === 'codex') {
    const managed = normalizeCodexManagedAccounts(options.codexManagedAccounts || deps.codexManagedAccounts);
    jobs = options.limitRefreshScope?.provider === 'codex' && [
      'accountKey',
      'accountId',
      'managedAccountId',
      'id',
      'accountEmail',
      'email',
      'accountName',
      'name',
      'accountLabel'
    ].some((key) => String(options.limitRefreshScope[key] || '').trim())
      ? 1
      : Math.max(1, managed.length + 1);
  } else if (provider === 'mimo') {
    const managed = Array.isArray(options.mimoManagedAccounts || deps.mimoManagedAccounts)
      ? (options.mimoManagedAccounts || deps.mimoManagedAccounts)
      : [];
    jobs = options.limitRefreshScope?.provider === 'mimo' ? 1 : Math.max(1, managed.length);
  }
  return base * jobs;
}

function createProbeFetch(fetchFn, context = {}, deps = {}) {
  return async (url, init = {}) => {
    const signals = [context.signal, init.signal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const response = await fetchFn(url, {
      ...init,
      ...(signal ? { signal } : {})
    });
    if (Number(response?.status) >= 400) {
      const retryAfterMs = parseRetryAfterHeader(
        response?.headers?.get?.('retry-after'),
        (deps.now || Date.now)()
      );
      if (retryAfterMs !== null) context.onRetryAfter?.(retryAfterMs);
    }
    return response;
  };
}

function resolveProviderFetch(provider, deps = {}) {
  if (typeof deps.fetch === 'function') return deps.fetch;
  if (provider === 'workbuddy' && typeof deps.workbuddyFetch === 'function') return deps.workbuddyFetch;
  if (provider === 'grok') return grokLimits.resolveGrokFetch(deps);
  return fetch;
}

async function probeLimitProvider(provider, options = {}, context = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const fetcher = providerFetchers(deps)[provider];
  if (!fetcher) return [statusProvider(provider, 'notConfigured', nowIso(nowMs))];
  try {
    const signal = context.signal ?? deps.signal;
    const result = await fetcher(options, {
      ...deps,
      fetch: createProbeFetch(resolveProviderFetch(provider, deps), { ...context, signal }, deps),
      signal
    });
    return (Array.isArray(result) ? result : [result]).filter(Boolean);
  } catch (error) {
    return [statusProvider(provider, providerStatusFromError(error), nowIso(nowMs))];
  }
}

async function collectLimitsOnce(options = {}, deps = {}) {
  const enabled = parseBoolean(options.limitsEnabled ?? options.enabled, true);
  const refreshMs = normalizeLimitsRefreshMs(options.limitsRefreshMs ?? options.refreshMs);
  const nowMs = (deps.now || Date.now)();
  if (!enabled) return normalizeLimitsSummary({ updatedAt: nowIso(nowMs), refreshMs, providers: [] });

  const providers = [];
  const scope = options.limitRefreshScope;
  const selectedProviders = parseLimitProviders(options.limitProviders ?? options.providers)
    .filter((provider) => !scope?.provider || provider === scope.provider);
  for (const provider of selectedProviders) {
    providers.push(...await probeLimitProvider(provider, options, {}, deps));
  }
  return normalizeLimitsSummary({ updatedAt: nowIso(nowMs), refreshMs, providers });
}

// Compatibility facade for internal callers that still use the former
// snapshot/refreshScope API. All ordering, identity, retention, and deadline
// semantics are owned by LimitsRuntime; this facade only retains the former
// full-snapshot TTL and has no in-flight coordination of its own.
function createLimitsCollector(options = {}, deps = {}) {
  const { createLimitsRuntime } = require('./runtime');
  const runtime = createLimitsRuntime(options, { ...deps, autoStart: false, autoRetry: false });
  const refreshMs = normalizeLimitsRefreshMs(options.limitsRefreshMs ?? options.refreshMs);
  const now = deps.now || Date.now;
  let lastFullRefreshAt = null;
  const refreshedSnapshot = async (scope, reason) => {
    const result = await runtime.refresh(scope, reason);
    return result?.snapshot || (result?.providers ? result : runtime.getSnapshot());
  };
  const refreshedFullSnapshot = async (reason) => {
    const result = await refreshedSnapshot({}, reason);
    lastFullRefreshAt = now();
    return result;
  };
  return {
    refreshScope: (scope) => refreshedSnapshot(scope, 'compat-scoped'),
    snapshot: (force = false) => {
      const stale = lastFullRefreshAt === null || now() - lastFullRefreshAt >= refreshMs;
      return force || stale
        ? refreshedFullSnapshot(force ? 'compat-full' : 'compat-stale')
        : Promise.resolve(runtime.getSnapshot());
    },
    stop: () => runtime.stop()
  };
}

module.exports = {
  LIMIT_PROVIDER_IDS,
  DEFAULT_PROVIDER_PHYSICAL_BOUND_MS,
  PROVIDER_CLEANUP_GRACE_MS,
  collectLimitsOnce,
  claudeCommandCandidates,
  codexCommandCandidates,
  codexCommandSourceDetail,
  createProbeFetch,
  resolveProviderFetch,
  createLimitsCollector,
  probeLimitProvider,
  providerFetchers,
  providerPhysicalBoundMs,
  fetchAntigravityLimits,
  fetchOpenCodeLimits,
  fetchOpenRouterLimits: openrouterLimits.fetchOpenRouterLimits,
  fetchThirdPartyLimits: thirdPartyLimits.fetchThirdPartyLimits,
  fetchOpenCodeProfile,
  claudeWebCookie,
  normalizeClaudeWebCookieInput,
  fetchClaudeLimits,
  fetchCodexLimits,
  fetchCursorLimits,
  fetchDeepSeekLimits,
  fetchMimoLimits,
  readCodexRpcWithCommand,
  runCodexLogin,
  runProcessText,
  deepseekToken,
  selectFundedRow,
  minimaxToken,
  minimaxBaseUrl,
  parseMinimaxTiers,
  fetchMinimaxLimits,
  grokCredential,
  readAuthJson,
  parseGrokBilling,
  parseGrokGrpcWebBilling,
  fetchGrokRpcBilling,
  fetchGrokWebGrpcBilling,
  fetchGrokLimits,
  copilotToken,
  fetchCopilotLimits,
  parseKiroUsage,
  fetchKiroLimits,
  zaiToken,
  zaiRegion,
  fetchZaiLimits,
  zaiTeamToken,
  fetchZaiTeamLimits,
  volcengineCredentials,
  fetchVolcengineLimits,
  alibabaCookie: alibabaLimits.alibabaCookie,
  alibabaVariant: alibabaLimits.alibabaVariant,
  alibabaDashboardUrl: alibabaLimits.alibabaDashboardUrl,
  normalizeAlibabaCookieHeader: alibabaLimits.normalizeAlibabaCookieHeader,
  fetchAlibabaLimits: alibabaLimits.fetchAlibabaLimits,
  qoderCookie,
  fetchQoderLimits,
  traeAccessToken: traeLimits.traeAccessToken,
  traeDeviceId: traeLimits.traeDeviceId,
  fetchTraeLimits: traeLimits.fetchTraeLimits,
  fetchWorkbuddyLimits: workbuddyLimits.fetchWorkbuddyLimits,
  commandcodeCookie,
  fetchCommandcodeLimits,
  ollamaSessionCookie,
  fetchOllamaLimits,
  kimiToken,
  kimiWebToken,
  fetchKimiLimits,
  zedCookie: zedLimits.zedCookie,
  normalizeZedCookieHeader: zedLimits.normalizeZedCookieHeader,
  fetchZedLimits: zedLimits.fetchZedLimits,
  mapClaudeCliUsageToProvider,
  mapClaudeUsageToProvider,
  mapCodexRateLimitsToProvider,
  parseClaudeCliUsageText,
  parseBoolean,
  parseLimitProviders,
  normalizeLimitsRefreshMode,
  normalizeLimitsRefreshMs,
  refreshClaudeAccessToken,
  refreshClaudeCredentials,
  delegatedClaudeRefresh,
  touchClaudeAuthPath,
  rankClaudeCredentialFiles,
  wslClaudeCredentialPaths
};
