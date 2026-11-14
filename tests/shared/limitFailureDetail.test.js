'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { limitFailureDetail, limitStage } = require('../../src/shared/limits/failureDetail');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { errorWithStatus, fetchJson } = require('../../src/shared/limits/providerHelpers');
const {
  deriveDiagnosticFindings, formatDiagnosticReport, projectLimitsDiagnostics
} = require('../../src/shared/diagnosticReport');

function response(status, body = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => '', getSetCookie: () => [] }, json: async () => body };
}

function withCode(error, code) {
  error.code = code;
  return error;
}

test('failure detail separates what the published status collapses into unavailable', async () => {
  const http = await fetchJson('https://example.test/usage', {}, { fetch: async () => response(503) }).catch((error) => error);
  assert.equal(http.status, 'unavailable');
  assert.deepEqual(limitFailureDetail(http), { kind: 'http', httpStatus: 503 });

  const challenge = await fetchJson('https://example.test/usage', {}, {
    fetch: async () => ({ ...response(403), headers: { get: (name) => (name === 'cf-mitigated' ? 'challenge' : '') } })
  }).catch((error) => error);
  assert.deepEqual(limitFailureDetail(challenge), { kind: 'challenge', httpStatus: 403 });

  const timeout = await fetchJson('https://example.test/usage', {}, {
    fetchTimeoutMs: 1,
    fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }))
  }).catch((error) => error);
  assert.equal(timeout.status, 'unavailable');
  assert.deepEqual(limitFailureDetail(timeout), { kind: 'timeout' });

  assert.deepEqual(limitFailureDetail(new Error('net::ERR_PROXY_CONNECTION_FAILED')),
    { kind: 'network', code: 'ERR_PROXY_CONNECTION_FAILED' });
  // A transport timeout is a timeout, not an outage.
  assert.deepEqual(limitFailureDetail(new Error('net::ERR_TIMED_OUT')),
    { kind: 'timeout', code: 'ERR_TIMED_OUT' });
  assert.deepEqual(limitFailureDetail(withCode(new Error('connect timed out'), 'ETIMEDOUT')),
    { kind: 'timeout', code: 'ETIMEDOUT' });
  // Codes the network filter does not carry must still read as timeouts.
  assert.deepEqual(limitFailureDetail(withCode(new Error('socket hang up'), 'ESOCKETTIMEDOUT')),
    { kind: 'timeout', code: 'ESOCKETTIMEDOUT' });
  assert.deepEqual(limitFailureDetail(withCode(new Error('timed out'), 'ERR_TIMED_OUT')),
    { kind: 'timeout', code: 'ERR_TIMED_OUT' });
  // A code lifted out of free text gets the same shape and length check as any
  // other code, so an oversized one is dropped rather than printed.
  assert.deepEqual(limitFailureDetail(new Error(`net::ERR_${'X'.repeat(60)}`)), { kind: 'error' });
  const undici = new TypeError('fetch failed', { cause: withCode(new Error('getaddrinfo'), 'ENOTFOUND') });
  assert.deepEqual(limitFailureDetail(undici), { kind: 'network', code: 'ENOTFOUND' });
  assert.deepEqual(limitFailureDetail(new SyntaxError('Unexpected token <')), { kind: 'response' });
});

test('failure detail keeps the innermost stage and never treats file errors as network', async () => {
  const inner = await Promise.reject(new Error('net::ERR_CONNECTION_RESET')).catch(limitStage('oauth-profile')).catch((error) => error);
  const relabelled = await Promise.reject(inner).catch(limitStage('outer')).catch((error) => error);
  assert.equal(relabelled.limitStage, 'oauth-profile');

  const wrapped = withCode(errorWithStatus('unavailable', 'identity lookup failed'), 'CLAUDE_IDENTITY_UNAVAILABLE');
  wrapped.cause = inner;
  assert.deepEqual(limitFailureDetail(wrapped, { source: 'oauth' }),
    { source: 'oauth', stage: 'oauth-profile', kind: 'network', code: 'ERR_CONNECTION_RESET' });

  assert.deepEqual(limitFailureDetail(withCode(new Error('open /Users/someone/.claude'), 'EACCES')),
    { kind: 'error', code: 'EACCES' });
  // A wrapper with no code of its own keeps its kind, but not at the cost of the
  // step its cause failed in.
  const wrappedUncoded = withCode(errorWithStatus('unavailable', 'identity lookup failed'), 'CLAUDE_IDENTITY_UNAVAILABLE');
  wrappedUncoded.cause = Object.assign(new Error('profile unavailable'), { limitStage: 'oauth-profile' });
  assert.deepEqual(limitFailureDetail(wrappedUncoded),
    { stage: 'oauth-profile', kind: 'error', code: 'CLAUDE_IDENTITY_UNAVAILABLE' });
  assert.deepEqual(limitFailureDetail(new Error('https://claude.ai/api/organizations/org-secret returned weird')),
    { kind: 'error' });
  assert.deepEqual(limitFailureDetail(new Error('x'), { source: 'Not A Source!', stage: 'cli-usage' }),
    { stage: 'cli-usage', kind: 'error' });
});

function claudeFixture() {
  const account = { id: 'a', cookie: 'sessionKey=sk-ant-sid01-test-fixture-not-a-real-key', organizationId: 'org-a', enabled: true };
  let failing = true;
  const deps = {
    autoStart: false, autoRetry: false, env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token' },
    now: () => Date.parse('2026-11-14T00:00:00Z'),
    platform: 'linux', providerRuntimeState: new Map(),
    resolveClaudeWebCredential: () => account.cookie,
    fetch: async (url, init) => {
      if (init.headers.cookie) {
        if (failing) throw new Error('net::ERR_CONNECTION_RESET');
        if (url.endsWith('/api/organizations')) return response(200, [{ uuid: 'org-a', name: 'Workspace' }]);
        if (url.endsWith('/api/account')) return response(200, { uuid: 'account-a', email_address: 'a@example.com' });
        if (url.endsWith('/prepaid/credits')) return response(200, { amount: 0, currency: 'USD' });
        return response(200, { five_hour: { utilization: 10 } });
      }
      if (failing && url.includes('/api/oauth/usage')) return response(503);
      if (url.endsWith('/api/oauth/profile')) return response(200, {
        account: { uuid: 'account-c', email: 'c@example.com' }, organization: { uuid: 'org-c' }
      });
      return response(200, { five_hour: { utilization: 20 } });
    }
  };
  return { account, deps };
}

test('runtime diagnostics name each failing Claude source', async (t) => {
  const f = claudeFixture();
  const runtime = createLimitsRuntime({
    limitProviders: ['claude'], claudeManagedAccounts: [f.account], claudeCliFallbackEnabled: false
  }, f.deps);
  t.after(() => runtime.stop());

  await runtime.refresh({ provider: 'claude' }, 'credential-save');
  const failed = runtime.getDiagnostics().providers[0];
  assert.equal(failed.lastFailureCode, 'unavailable');
  assert.deepEqual(failed.lastFailureDetail.failures, [
    { source: 'web', stage: 'web-organizations', kind: 'network', code: 'ERR_CONNECTION_RESET' },
    { source: 'oauth', stage: 'oauth-usage', kind: 'http', httpStatus: 503 }
  ]);
  assert.deepEqual(failed.lastFailureDetail.httpStatuses, [503]);
  assert.deepEqual(failed.lastFailureDetail.networkCodes, ['ERR_CONNECTION_RESET']);
  assert.equal(JSON.stringify(failed).includes('sk-ant'), false);
});

test('a CLI fallback timeout is reported as a timeout, not a plain error', async (t) => {
  const runtime = createLimitsRuntime({ limitProviders: ['claude'], claudeCliFallbackEnabled: true }, {
    autoStart: false,
    autoRetry: false,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token' },
    now: () => Date.parse('2026-11-14T00:00:00Z'),
    platform: 'win32',
    providerRuntimeState: new Map(),
    isClaudeCliAuthenticated: () => true,
    runClaudeUsageCli: async () => {
      // execFile's own timeout: killed, no code.
      const error = new Error('Command failed: claude');
      error.killed = true;
      error.signal = 'SIGKILL';
      error.code = null;
      throw error;
    },
    fetch: async (url) => {
      if (url.endsWith('/api/oauth/profile')) {
        return response(200, { account: { uuid: 'account-c', email: 'c@example.com' }, organization: { uuid: 'org-c' } });
      }
      if (url.includes('/api/oauth/usage')) return response(503);
      return response(200, { five_hour: { utilization: 20 } });
    }
  });
  t.after(() => runtime.stop());

  await runtime.refresh({ provider: 'claude' }, 'credential-save');
  const failures = runtime.getDiagnostics().providers[0].lastFailureDetail.failures;
  assert.deepEqual(failures.find((entry) => entry.source === 'cli'),
    { source: 'cli', stage: 'cli-usage', kind: 'timeout' });
});

test('a process timeout carries the diagnostic timeout code', async () => {
  const { runProcessText } = require('../../src/shared/limits/providerHelpers');
  const { EventEmitter } = require('node:events');
  const neverExits = () => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill() { return true; }
  });
  const error = await runProcessText('claude', ['--version'], { spawn: neverExits, timeoutMs: 5 })
    .catch((thrown) => thrown);
  assert.equal(error.status, 'unavailable');
  assert.deepEqual(limitFailureDetail(error), { kind: 'timeout' });
});

test('a cold-start OAuth failure names its source', async (t) => {
  const runtime = createLimitsRuntime({ limitProviders: ['claude'], claudeCliFallbackEnabled: false }, {
    autoStart: false,
    autoRetry: false,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token' },
    now: () => Date.parse('2026-11-14T00:00:00Z'),
    platform: 'linux',
    providerRuntimeState: new Map(),
    fetch: async (url) => {
      if (url.endsWith('/api/oauth/profile')) {
        return response(200, { account: { uuid: 'account-c', email: 'c@example.com' }, organization: { uuid: 'org-c' } });
      }
      if (url.includes('/api/oauth/usage')) return response(503);
      return response(200, { five_hour: { utilization: 20 } });
    }
  });
  t.after(() => runtime.stop());

  await runtime.refresh({ provider: 'claude' }, 'credential-save');
  assert.deepEqual(runtime.getDiagnostics().providers[0].lastFailureDetail.failures,
    [{ source: 'oauth', stage: 'oauth-usage', kind: 'http', httpStatus: 503 }]);
});

test('a provider without its own detail still reports the HTTP errors its requests saw, until it recovers', async (t) => {
  let status = 200;
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, {
    autoStart: false, autoRetry: false, cleanupGraceMs: 0, providerPhysicalBoundMs: () => 1000,
    providerFetchers: {
      kimi: async (_options, deps) => {
        const reply = await deps.fetch('https://example.test/quota');
        if (!reply.ok) throw errorWithStatus('unavailable', `quota returned ${reply.status}`);
        return { provider: 'kimi', accountKey: 'k', status: 'ok', updatedAt: '2026-11-14T00:00:00.000Z',
          windows: [{ kind: 'session', usedPercent: 5 }] };
      }
    },
    fetch: async () => response(status)
  });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'kimi' }, 'credential-save');
  assert.equal(runtime.getDiagnostics().providers[0].lastFailureDetail, null);

  status = 502;
  await runtime.refresh({ provider: 'kimi' }, 'credential-save');
  const detail = runtime.getDiagnostics().providers[0].lastFailureDetail;
  assert.deepEqual(detail.failures, [{ kind: 'error' }]);
  assert.deepEqual(detail.httpStatuses, [502]);

  status = 200;
  await runtime.refresh({ provider: 'kimi' }, 'credential-save');
  const recovered = runtime.getDiagnostics().providers[0];
  assert.equal(recovered.lastFailureDetail, null);
});

test('accounts failing the same way share one entry, so another source still fits', async (t) => {
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, {
    autoStart: false, autoRetry: false, cleanupGraceMs: 0, providerPhysicalBoundMs: () => 1000,
    providerFetchers: {
      kimi: async (_options, deps) => {
        const shared = errorWithStatus('unavailable', 'account quota failed');
        shared.httpStatus = 503;
        for (let index = 0; index < 4; index += 1) deps.noteLimitFailure?.(shared, { source: 'web' });
        const oauth = errorWithStatus('unavailable', 'oauth quota failed');
        oauth.httpStatus = 502;
        deps.noteLimitFailure?.(oauth, { source: 'oauth' });
        throw shared;
      }
    }
  });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'kimi' }, 'credential-save');
  assert.deepEqual(runtime.getDiagnostics().providers[0].lastFailureDetail.failures, [
    { source: 'web', kind: 'http', httpStatus: 503 },
    { source: 'oauth', kind: 'http', httpStatus: 502 }
  ]);
});

test('a missing credential is not reported as a failure detail', async (t) => {
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, {
    autoStart: false, autoRetry: false, cleanupGraceMs: 0, providerPhysicalBoundMs: () => 1000,
    providerFetchers: { kimi: async () => { throw errorWithStatus('notConfigured', 'no key'); } }
  });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'kimi' }, 'credential-save');
  assert.equal(runtime.getDiagnostics().providers[0].lastFailureDetail, null);
});

test('a failed provider names its failure kind in the findings list', () => {
  const now = Date.parse('2026-11-14T14:20:00.000Z');
  const findings = deriveDiagnosticFindings({
    collector: {
      detailsAvailable: true,
      intervalMs: 5 * 60 * 1000,
      lastTickSuccessAt: '2026-11-14T14:19:00.000Z'
    },
    usage: {},
    topology: {},
    limits: {
      providers: [
        {
          provider: 'claude',
          failureCode: 'unavailable',
          failureDetail: { at: '2026-11-14T14:16:02.138Z', failures: [{ source: 'web', stage: 'web-organizations', kind: 'challenge', httpStatus: 403 }] }
        },
        { provider: 'codex', failureCode: 'unavailable' }
      ]
    }
  }, now);
  assert.deepEqual(findings, [
    { code: 'limits-provider-failed', provider: 'claude', detailCode: 'challenge' },
    { code: 'limits-provider-failed', provider: 'codex' }
  ]);

  const report = formatDiagnosticReport({ findings, limits: { providers: [] } });
  assert.match(report.text, /- limits-provider-failed provider=claude detail=challenge/);
  assert.match(report.text, /\n- limits-provider-failed provider=codex\n/);
});

test('the report re-validates failure detail and prints it under a failed provider only', () => {
  const limits = projectLimitsDiagnostics({
    providers: [{
      provider: 'claude',
      lastFailureCode: 'unavailable',
      lastFailureDetail: {
        at: '2026-11-14T14:16:02.138Z',
        failures: [
          { source: 'web', stage: 'web-usage', kind: 'challenge', httpStatus: 403 },
          { source: 'oauth', stage: 'oauth-usage', kind: 'network', code: 'ERR_TIMED_OUT' },
          { kind: 'made-up', code: 'X' },
          { kind: 'error', code: 'https://claude.ai/secret' }
        ],
        httpStatuses: [403, 'nope', 9999],
        networkCodes: ['ERR_TIMED_OUT', 'fake-cookie-value']
      }
    }, {
      provider: 'codex',
      lastSuccessAt: '2026-11-14T14:17:33.503Z',
      lastFailureDetail: { at: '2026-11-14T14:00:00.000Z', failures: [{ kind: 'timeout' }] }
    }]
  });
  assert.deepEqual(limits.providers[0].failureDetail, {
    at: '2026-11-14T14:16:02.138Z',
    failures: [
      { source: 'web', stage: 'web-usage', kind: 'challenge', httpStatus: 403 },
      { source: 'oauth', stage: 'oauth-usage', kind: 'network', code: 'ERR_TIMED_OUT' },
      { kind: 'error' }
    ],
    httpStatuses: [403],
    networkCodes: ['ERR_TIMED_OUT']
  });
  assert.equal('failureDetail' in limits.providers[1], false);

  const report = formatDiagnosticReport({ limits: { providers: [{
    provider: 'claude',
    lastFailureCode: 'unavailable',
    lastFailureDetail: {
      at: '2026-11-14T14:16:02.138Z',
      failures: [{ source: 'web', stage: 'web-usage', kind: 'challenge', httpStatus: 403 }],
      httpStatuses: [403],
      networkCodes: []
    }
  }] } });
  assert.match(report.text, /failureDetailAt: 2026-11-14T14:16:02\.138Z/);
  assert.match(report.text, /- source=web stage=web-usage kind=challenge httpStatus=403/);
  assert.match(report.text, /observedHttpErrors: 403/);
  assert.equal(report.text.includes('observedNetworkErrors'), false);
});
