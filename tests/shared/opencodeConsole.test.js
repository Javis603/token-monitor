'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const web = require('../../src/shared/providers/opencode/web');
const { fetchOpenCodeLimits } = require('../../src/shared/providers/opencode/limits');

// Synthetic sessions only. Never read a browser jar or local auth.json here.
const consoleCookie = '__Host-console_session=fixture';
const bothCookies = `${consoleCookie}; auth=legacy-fixture`;
const now = () => Date.UTC(2026, 9, 25);
const billing = { billingMode: 'prepaid', mode: 'pay-as-you-go', balanceMicroCents: '2786781005', availableMicroCents: '9999999999' };
const meter = (used, limit, resetsAt = null) => ({ usedMicroCents: used, limitMicroCents: limit, resetsAt });
const goStatus = { access: { endsAt: '2026-11-01T00:00:00Z', meters: {
  fiveHour: meter('25', '100'), week: meter('40', '100', '2026-10-26T00:00:00.000Z'), month: meter('10', '100')
} } };
const legacyGo = { rollingUsage: { usagePercent: 17, resetInSec: 60 }, weeklyUsage: { usagePercent: 75, resetInSec: 600 } };
const response = (body, status = 200) => ({ status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });

function fixture(handler = () => undefined) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init, url });
    const result = await handler(path, init, url);
    if (result !== undefined) return result;
    if (path === '/console/api/orgs') return response([{ id: 'org_FIXTURE' }]);
    if (path === '/console/api/go/status') return response(goStatus);
    if (path === '/console/api/billing/status') return response(billing);
    return response('login', 401);
  };
  return { calls, fetch, now, env: {} };
}

test('Console-only Go reads scoped meters, omits unknown resets and uses monthly endsAt', async () => {
  const deps = fixture();
  const go = await web.fetchGoWeb(consoleCookie, deps);
  assert.equal(go.status, 'ok');
  assert.equal(go.workspaceId, 'org_FIXTURE');
  assert.deepEqual(go.windows.map(w => [w.kind, w.usedPercent]), [['session', 25], ['weekly', 40], ['monthly', 10]]);
  assert.ok(!go.windows[0].resetsAt);
  assert.equal(go.windows[2].resetsAt, '2026-11-01T00:00:00.000Z');
  assert.equal(deps.calls[0].init.headers['x-org-id'], undefined);
  assert.equal(deps.calls[1].init.headers['x-org-id'], 'org_FIXTURE');
  assert.equal(deps.calls[1].init.credentials, 'omit');
  assert.equal(deps.calls[1].init.headers.Host, undefined);
});

test('Console Zen reads billing independently of Go and converts micro-cents, not available credit', async () => {
  const deps = fixture();
  const zen = await web.fetchZen(consoleCookie, deps);
  assert.equal(zen.status, 'ok');
  assert.equal(zen.balanceUsd, 27.86781005);
  assert.deepEqual(zen.windows, []);
  assert.deepEqual(deps.calls.map(c => c.path), ['/console/api/orgs', '/console/api/billing/status']);
  assert.equal(deps.calls[1].init.headers['x-org-id'], 'org_FIXTURE');
});

for (const absent of [null, { access: null }]) test(`PAYG remains balance-only with absent Go ${JSON.stringify(absent)}`, async () => {
  const deps = fixture(path => path.endsWith('/go/status') ? response(absent) : undefined);
  const result = await fetchOpenCodeLimits({ opencodeCookie: consoleCookie }, { ...deps, opencodeReadGoApiKey: () => '' });
  assert.equal(result.status, 'ok');
  assert.equal(result.balanceUsd, 27.86781005);
  assert.deepEqual(result.windows.map(w => w.metric), ['credits']);
  assert.equal(deps.calls.filter(c => c.path === '/console/api/orgs').length, 1);
});

test('one refresh discovers one org for Go and Zen, with stable workspace identity', async () => {
  const deps = fixture(path => path === '/console/api/orgs'
    ? response([{ id: 'wrk_FIRST' }, { id: 'org_SECOND' }]) : undefined);
  const result = await fetchOpenCodeLimits({ opencodeCookie: consoleCookie }, { ...deps, opencodeReadGoApiKey: () => '' });
  assert.equal(result.status, 'ok');
  assert.equal(result.windows.length, 4);
  assert.equal(deps.calls.filter(c => c.path === '/console/api/orgs').length, 1);
  assert.ok(deps.calls.filter(c => c.path !== '/console/api/orgs').every(c => c.init.headers['x-org-id'] === 'wrk_FIRST'));
});

test('Console override skips discovery and supports org links', async () => {
  const deps = fixture();
  const zen = await web.fetchZen(consoleCookie, { ...deps, workspaceId: 'https://opencode.ai/console/org_OVERRIDE/billing' });
  assert.equal(zen.workspaceId, 'org_OVERRIDE');
  assert.deepEqual(deps.calls.map(c => c.path), ['/console/api/billing/status']);
});

for (const balance of ['0', '-100000000']) test(`Console preserves signed balance ${balance}`, async () => {
  const deps = fixture(path => path.endsWith('/billing/status') ? response({ ...billing, balanceMicroCents: balance }) : undefined);
  const result = await web.fetchZen(consoleCookie, deps);
  assert.equal(result.status, 'ok');
  assert.equal(result.balanceUsd, Number(balance) / 1e8);
});

for (const patch of [
  { billingMode: 'seat' }, { mode: 'invoiceable' }, { balanceMicroCents: null },
  { balanceMicroCents: true }, { balanceMicroCents: '1.5' }, { balanceMicroCents: '1e8' }
]) test(`Console never invents a prepaid balance from ${JSON.stringify(patch)}`, async () => {
  const deps = fixture(path => path.endsWith('/billing/status') ? response({ ...billing, ...patch }) : undefined);
  const zen = await web.fetchZen(consoleCookie, deps);
  assert.equal(zen.balanceUsd, null);
  assert.notEqual(zen.status, 'ok');
});

test('Console omits absent weekly/monthly meters and rejects malformed required meter', async () => {
  const deps = fixture(path => path.endsWith('/go/status') ? response({ access: { meters: { fiveHour: meter('1', '4') } } }) : undefined);
  const go = await web.fetchGoWeb(consoleCookie, deps);
  assert.equal(go.status, 'ok');
  assert.deepEqual(go.windows.map(w => w.kind), ['session']);
  const bad = fixture(path => path.endsWith('/go/status') ? response({ access: { meters: { fiveHour: meter(null, '100') } } }) : undefined);
  assert.equal((await web.fetchGoWeb(consoleCookie, bad)).status, 'unavailable');
});

for (const status of [401, 403, 429, 500]) test(`Console ${status} is not a no-subscription result or a valid balance`, async () => {
  const deps = fixture(path => path !== '/console/api/orgs' ? response({}, status) : undefined);
  const go = await web.fetchGoWeb(consoleCookie, deps);
  const zen = await web.fetchZen(consoleCookie, deps);
  const expected = status === 401 ? 'unauthorized' : status === 429 ? 'sourceRateLimited' : 'unavailable';
  assert.equal(go.status, expected);
  assert.equal(zen.status, expected);
  assert.equal(zen.balanceUsd, null);
  assert.ok(!deps.calls.some(c => c.path === '/_server'));
});

test('Console failure recovers through a working legacy cookie and pins fallback to discovered org', async () => {
  const deps = fixture((path, _init, url) => {
    if (path.endsWith('/go/status') || path.endsWith('/billing/status')) return response({}, 401);
    if (path === '/workspace/org_FIXTURE/go') return response(legacyGo);
    if (path === '/_server') {
      assert.match(decodeURIComponent(url), /org_FIXTURE/);
      return response({ balanceUSD: 4.5 });
    }
    return undefined;
  });
  assert.equal((await web.fetchGoWeb(bothCookies, deps)).windows[0].usedPercent, 17);
  assert.equal((await web.fetchZen(bothCookies, deps)).balanceUsd, 4.5);
});

test('independent legacy authentication recovers when Console discovery rejects', async () => {
  const deps = fixture((path, _init, url) => {
    if (path === '/console/api/orgs') return response({}, 401);
    if (path === '/_server' && url.includes(web.WORKSPACES_SERVER_ID)) return response({ id: 'wrk_LEGACY' });
    if (path === '/_server') return response({ balanceUSD: 2 });
    if (path === '/workspace/wrk_LEGACY/go') return response(legacyGo);
    return undefined;
  });
  assert.equal((await web.fetchGoWeb(bothCookies, deps)).status, 'ok');
  assert.equal((await web.fetchZen(bothCookies, deps)).balanceUsd, 2);
});

test('a failed legacy path does not hide Console permission failure as expired auth or empty success', async () => {
  const deps = fixture(path => {
    if (path.endsWith('/go/status') || path.endsWith('/billing/status')) return response({}, 403);
    if (path === '/_server') return response('null');
    return undefined;
  });
  assert.equal((await web.fetchGoWeb(bothCookies, deps)).status, 'unavailable');
  assert.equal((await web.fetchZen(bothCookies, deps)).status, 'unavailable');
});

test('recoverable Console transport failure falls back to legacy', async () => {
  const deps = fixture(path => {
    if (path.endsWith('/go/status')) throw new TypeError('offline');
    if (path === '/workspace/wrk_OVERRIDE/go') return response(legacyGo);
    return undefined;
  });
  assert.equal((await web.fetchGoWeb(bothCookies, { ...deps, workspaceId: 'wrk_OVERRIDE' })).status, 'ok');
});

for (const code of ['ABORT_ERR', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) test(`${code} never starts a legacy fallback`, async () => {
  const error = Object.assign(new Error('synthetic failure'), { code });
  const deps = fixture(() => { throw error; });
  for (const probe of [web.fetchGoWeb, web.fetchZen]) {
    await assert.rejects(probe(bothCookies, deps), e => e === error);
  }
  assert.ok(deps.calls.every(c => c.path === '/console/api/orgs'));
});

test('new Console requests never follow redirects with the managed cookie', async () => {
  const deps = fixture((_path, init) => {
    assert.equal(init.redirect, 'manual');
    return response('', 302);
  });
  assert.equal((await web.fetchZen(consoleCookie, deps)).status, 'unavailable');
  assert.equal(deps.calls.length, 1);
});

test('settings probe pair shares discovery and links a Console-only Zen account', async () => {
  const deps = fixture(path => path.endsWith('/go/status') ? response({ access: null }) : undefined);
  const [go, zen] = await web.fetchWeb(consoleCookie, deps);
  assert.deepEqual(web.summarizeLink(go, zen), { linked: true, expired: false, go: false, zen: true, hasBalance: true });
  assert.equal(deps.calls.filter(c => c.path === '/console/api/orgs').length, 1);
});

test('Console form accepts the browser Value alone and still accepts explicit cookie headers', async () => {
  const input = 'fixture-session';
  const cookie = web.sanitizeCookieHeader(input, '__Host-console_session');
  const deps = fixture();
  const [go, zen] = await web.fetchWeb(cookie, deps);
  assert.equal(go.status, 'ok');
  assert.equal(zen.status, 'ok');
  assert.ok(deps.calls.every(call => call.init.headers.Cookie === `__Host-console_session=${input}`));
  assert.equal(web.sanitizeCookieHeader(bothCookies, '__Host-console_session'), bothCookies);
  assert.equal(web.sanitizeCookieHeader('auth=fixture', '__Host-console_session'), 'auth=fixture');
  assert.equal(web.sanitizeCookieHeader(input), `auth=${input}`);
});

test('Go API remains authoritative while Console supplies only the Zen balance', async () => {
  const deps = fixture();
  const result = await fetchOpenCodeLimits({ opencodeProfiles: { account: { enabled: true, cookie: consoleCookie, apiKey: 'fixture-key' } } }, {
    ...deps, opencodeReadGoApiKey: () => '',
    opencodeCollectGoApi: async () => ({ status: 'ok', identity: 'fixture-api', windows: [{ kind: 'session', usedPercent: 77, windowMinutes: 300 }, { kind: 'weekly', usedPercent: 88, windowMinutes: 10080 }] })
  });
  assert.equal(result.source, 'api');
  assert.equal(result.windows.find(w => w.kind === 'session').usedPercent, 77);
  assert.equal(result.windows.find(w => w.kind === 'weekly').usedPercent, 88);
  assert.equal(result.balanceUsd, 27.86781005);
});

test('multiple Console profiles discover independently while each pair remains pinned', async () => {
  const deps = fixture((path, init) => path === '/console/api/orgs'
    ? response([{ id: init.headers.Cookie === consoleCookie ? 'org_A' : 'org_B' }]) : undefined);
  const result = await fetchOpenCodeLimits({ opencodeProfiles: {
    a: { enabled: true, cookie: consoleCookie }, b: { enabled: true, cookie: '__Host-console_session=other-fixture' }
  } }, { ...deps, opencodeReadGoApiKey: () => '' });
  assert.equal(result.length, 2);
  assert.ok(result.every(p => p.status === 'ok'));
  assert.notEqual(result[0].accountKey, result[1].accountKey);
  assert.equal(deps.calls.filter(c => c.path === '/console/api/orgs').length, 2);
  for (const call of deps.calls.filter(c => c.path !== '/console/api/orgs')) {
    assert.equal(call.init.headers['x-org-id'], call.init.headers.Cookie === consoleCookie ? 'org_A' : 'org_B');
  }
});

test('cancellation after discovery prevents further requests and legacy fallback', async () => {
  const controller = new AbortController();
  const reason = new Error('superseded');
  const deps = fixture(path => {
    assert.equal(path, '/console/api/orgs');
    controller.abort(reason);
    return response([{ id: 'org_FIXTURE' }]);
  });
  await assert.rejects(web.fetchGoWeb(bothCookies, { ...deps, signal: controller.signal }), e => e === reason);
  assert.equal(deps.calls.length, 1);
});

test('nested TLS certificate errors remain terminal', async () => {
  const error = new TypeError('fetch failed', { cause: Object.assign(new Error('certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) });
  const deps = fixture(() => { throw error; });
  await assert.rejects(web.fetchZen(bothCookies, deps), e => e === error);
  assert.equal(deps.calls.length, 1);
});

test('Chromium certificate failures without a code remain terminal', async () => {
  const error = new Error('net::ERR_CERT_AUTHORITY_INVALID');
  const deps = fixture(() => { throw error; });
  await assert.rejects(web.fetchZen(bothCookies, deps), e => e === error);
  assert.equal(deps.calls.length, 1);
});

test('optional billing failure preserves valid Go quota without claiming a balance', async () => {
  const deps = fixture(path => path.endsWith('/billing/status') ? response({}, 403) : undefined);
  const result = await fetchOpenCodeLimits({ opencodeCookie: consoleCookie }, { ...deps, opencodeReadGoApiKey: () => '' });
  assert.equal(result.status, 'ok');
  assert.equal(result.balanceUsd, null);
  assert.equal(result.windows.length, 3);
});

test('explicit Console no-subscription prevents stale local Go rows from inventing a quota', async () => {
  const deps = fixture(path => path.endsWith('/go/status') ? response({ access: null }) : undefined);
  const result = await fetchOpenCodeLimits({ opencodeCookie: consoleCookie, opencodeLocalLimitsEnabled: true }, {
    ...deps, opencodeReadGoApiKey: () => '',
    opencodeCollectGo: () => ({ status: 'ok', windows: [{ kind: 'session', usedPercent: 20, windowMinutes: 300 }] })
  });
  assert.equal(result.balanceUsd, 27.86781005);
  assert.ok(result.windows.every(w => w.metric === 'credits'));
});

test('Console 401 cannot become a successful Zen account through an empty legacy null', async () => {
  const deps = fixture(path => {
    if (path.endsWith('/go/status') || path.endsWith('/billing/status')) return response({}, 401);
    if (path === '/_server') return response('null');
    return undefined;
  });
  const [go, zen] = await web.fetchWeb(bothCookies, deps);
  assert.equal(zen.status, 'unauthorized');
  assert.equal(web.summarizeLink(go, zen).expired, true);
  const result = await fetchOpenCodeLimits({ opencodeCookie: bothCookies }, { ...deps, opencodeReadGoApiKey: () => '' });
  assert.equal(result.status, 'unauthorized');
  assert.equal(result.balanceUsd, null);
  assert.deepEqual(result.windows, []);
});

test('no Go subscription never masks a Zen billing permission failure in multi-account mode', async () => {
  const deps = fixture(path => {
    if (path.endsWith('/go/status')) return response({ access: null });
    if (path.endsWith('/billing/status')) return response({}, 403);
    return undefined;
  });
  const options = { opencodeProfiles: { first: { enabled: true, cookie: consoleCookie } } };
  const single = await fetchOpenCodeLimits(options, { ...deps, opencodeReadGoApiKey: () => '' });
  const multiple = await fetchOpenCodeLimits({ opencodeProfiles: { ...options.opencodeProfiles,
    second: { enabled: true, cookie: '__Host-console_session=second-fixture' }
  } }, { ...deps, opencodeReadGoApiKey: () => '' });
  assert.equal(single.status, 'unavailable');
  assert.ok(multiple.every(p => p.status === single.status));
});

for (const stage of ['billing/status', 'orgs']) for (const multi of [false, true]) test(`TLS ${stage} failure preserves successful Go API quota (multi=${multi})`, async () => {
  const deps = fixture(path => {
    if (path.endsWith(`/${stage}`)) throw Object.assign(new Error('synthetic certificate failure'), { code: 'CERT_HAS_EXPIRED' });
    return undefined;
  });
  const profile = { enabled: true, cookie: consoleCookie, apiKey: 'fixture-api-key' };
  const providers = await fetchOpenCodeLimits({ opencodeProfiles: { first: profile,
    ...(multi ? { second: { enabled: true, apiKey: 'second-fixture-key' } } : {})
  } }, { ...deps, opencodeReadGoApiKey: () => '',
    opencodeCollectGoApi: async () => ({ status: 'ok', identity: 'fixture-api', windows: [
      { kind: 'session', usedPercent: 77, windowMinutes: 300 }, { kind: 'weekly', usedPercent: 88, windowMinutes: 10080 }
    ] }) });
  const result = multi ? providers.find(p => p.accountName === 'first') : providers;
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'api');
  assert.equal(result.windows.find(w => w.kind === 'session').usedPercent, 77);
  assert.equal(result.balanceUsd, null);
  assert.ok(result.accountKey);
  assert.ok(!deps.calls.some(c => c.path === '/_server'));
});

test('Go TLS failure still permits an independent zero Zen balance', async () => {
  const deps = fixture(path => {
    if (path.endsWith('/go/status')) throw new Error('net::ERR_CERT_AUTHORITY_INVALID');
    if (path.endsWith('/billing/status')) return response({ ...billing, balanceMicroCents: '0' });
    return undefined;
  });
  const result = await fetchOpenCodeLimits({ opencodeCookie: bothCookies }, { ...deps, opencodeReadGoApiKey: () => '' });
  assert.equal(result.status, 'ok');
  assert.equal(result.balanceUsd, 0);
  assert.deepEqual(result.windows.map(w => w.metric), ['credits']);
  assert.ok(!deps.calls.some(c => c.path === '/_server'));
});

test('Console 401 still accepts a real zero balance from independent legacy auth', async () => {
  const deps = fixture(path => {
    if (path.endsWith('/billing/status')) return response({}, 401);
    if (path === '/_server') return response({ balanceUSD: 0 });
    return undefined;
  });
  const result = await web.fetchZen(bothCookies, deps);
  assert.equal(result.status, 'ok');
  assert.equal(result.balanceUsd, 0);
});

for (const multi of [false, true]) test(`cancelled Web collection cannot publish successful sibling API data (multi=${multi})`, async () => {
  const controller = new AbortController();
  const reason = new Error('superseded');
  const deps = fixture(path => {
    assert.equal(path, '/console/api/orgs');
    controller.abort(reason);
    return response([{ id: 'org_FIXTURE' }]);
  });
  const profile = { enabled: true, cookie: bothCookies, apiKey: 'fixture-key' };
  await assert.rejects(fetchOpenCodeLimits({ opencodeProfiles: {
    first: profile, ...(multi ? { second: profile } : {})
  } }, { ...deps, signal: controller.signal, opencodeReadGoApiKey: () => '',
    opencodeCollectGoApi: async () => ({ status: 'ok', windows: [{ kind: 'session', usedPercent: 77 }] })
  }), error => error === reason);
  assert.ok(deps.calls.every(c => c.path === '/console/api/orgs'));
});

for (const code of ['AbortError', 'ABORT_ERR']) test(`injected Web ${code} still cancels collection`, async () => {
  const reason = Object.assign(new Error('cancelled'), code === 'AbortError' ? { name: code } : { code });
  await assert.rejects(fetchOpenCodeLimits({ opencodeCookie: bothCookies }, {
    env: {}, opencodeReadGoApiKey: () => '',
    opencodeCollectGoApi: async () => ({ status: 'notConfigured', windows: [] }),
    opencodeFetchGoWeb: async () => { throw reason; },
    opencodeFetchZen: async () => ({ status: 'ok', windows: [], balanceUsd: 0 })
  }), error => error === reason);
});

test('TLS failure in one settings cookie source leaves its healthy sibling available', async () => {
  const deps = fixture(path => {
    if (path.endsWith('/billing/status')) throw new Error('net::ERR_CERT_AUTHORITY_INVALID');
    return undefined;
  });
  const [go, zen] = await web.fetchWeb(bothCookies, deps, { isolateErrors: true });
  assert.equal(go.status, 'ok');
  assert.equal(zen.status, 'unavailable');
  assert.equal(web.summarizeLink(go, zen).go, true);
  assert.ok(!deps.calls.some(c => c.path === '/_server'));
});

test('credential validation retains strict TLS failures', async () => {
  const error = new Error('net::ERR_CERT_AUTHORITY_INVALID');
  const deps = fixture(path => {
    if (path.endsWith('/billing/status')) throw error;
    return undefined;
  });
  await assert.rejects(web.fetchWeb(bothCookies, deps), reason => reason === error);
  assert.ok(!deps.calls.some(c => c.path === '/_server'));
});
