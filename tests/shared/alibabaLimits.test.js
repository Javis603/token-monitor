'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ALIBABA_VARIANT_IDS,
  alibabaCookie,
  alibabaVariant,
  alibabaVariantConfig,
  expandEmbeddedJson,
  fetchAlibabaLimits,
  normalizeAlibabaCookieHeader,
  parseConsoleBody,
  parsePersonalUsage,
  parseTeamSummary,
  secTokenFromHtml
} = require('../../src/shared/alibabaLimits');

// The one payload in this file captured from a real account (mainland Team, via
// the report on #567). Every other fixture reproduces a shape the console is
// documented to emit but that we have not seen first-hand — if one of them ever
// disagrees with a user report, the report wins.
const REAL_MAINLAND_TEAM_BODY = JSON.stringify({
  code: '200',
  data: {
    Data: {
      Uid: 123456,
      TotalSurplusValue: '239673.78313',
      TotalCount: 1,
      TotalValue: '250000',
      ProductCode: 'sfm_tokenplanteams_dp_cn',
      NearestExpireDate: 1790582400000
    },
    Success: true
  }
});

function routedFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    // The personal gateway carries its endpoint in a percent-encoded `api`
    // query parameter, so routes are matched against the decoded URL.
    const decoded = decodeURIComponent(String(url));
    for (const [match, respond] of routes) {
      if (decoded.includes(match)) return respond(String(url), init);
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  return { calls, fetchFn };
}

function ok(body) {
  return () => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
}

function status(code, body = '{}') {
  return () => ({ ok: code >= 200 && code < 300, status: code, text: async () => body });
}

// A sec_token is resolved before every quota call; these routes keep it out of
// the way so each test asserts on the request it actually cares about.
const NO_SEC_TOKEN = [
  ['token-plan', ok('<html><body>console</body></html>')],
  ['/tool/user/info.json', ok({})]
];

test('normalizeAlibabaCookieHeader strips a Cookie: prefix, quotes and whitespace', () => {
  assert.equal(
    normalizeAlibabaCookieHeader('  Cookie: login_aliyunid_pk=abc; login_aliyunid_ticket=def  '),
    'login_aliyunid_pk=abc; login_aliyunid_ticket=def'
  );
  assert.equal(normalizeAlibabaCookieHeader('"login_aliyunid_pk=abc"'), 'login_aliyunid_pk=abc');
});

// A mis-paste is rejected at the door rather than saved and left to fail as an
// unexplained `unauthorized` on every refresh from then on.
test('normalizeAlibabaCookieHeader rejects anything without a name=value pair', () => {
  for (const input of ['', '   ', 'not-a-cookie', 'https://bailian.console.aliyun.com', 'GetSubscriptionSummary', null, 42]) {
    assert.equal(normalizeAlibabaCookieHeader(input), '', `expected ${JSON.stringify(input)} to be rejected`);
  }
});

test('alibabaCookie prefers the explicit option over the environment', () => {
  assert.equal(
    alibabaCookie({ ALIBABA_TOKEN_PLAN_COOKIE: 'env=1' }, { alibabaCookie: 'opt=1' }),
    'opt=1'
  );
  assert.equal(alibabaCookie({ ALIBABA_TOKEN_PLAN_COOKIE: 'env=1' }, {}), 'env=1');
  assert.equal(alibabaCookie({}, {}), '');
});

test('alibabaVariant defaults to mainland Team and rejects unknown values', () => {
  assert.deepEqual(ALIBABA_VARIANT_IDS, ['cn', 'intl', 'cn-personal', 'intl-personal']);
  assert.equal(alibabaVariant({}, {}), 'cn');
  assert.equal(alibabaVariant({ alibabaVariant: 'INTL-PERSONAL' }, {}), 'intl-personal');
  assert.equal(alibabaVariant({}, { ALIBABA_TOKEN_PLAN_VARIANT: 'intl' }), 'intl');
  assert.equal(alibabaVariant({ alibabaVariant: 'moon' }, {}), 'cn');
});

// Host, product code and window shape move together; a variant that mixed one
// console's host with another's product code would fail in a way no user could
// diagnose, which is why they are one enum rather than two settings.
test('every variant binds its own host, product code and plan shape', () => {
  const cn = alibabaVariantConfig('cn');
  assert.equal(cn.quotaOrigin, 'https://bailian.console.aliyun.com');
  assert.equal(cn.productCode, 'sfm_tokenplanteams_dp_cn');
  assert.equal(cn.personal, false);

  const intl = alibabaVariantConfig('intl');
  assert.equal(intl.quotaOrigin, 'https://modelstudio.console.alibabacloud.com');
  assert.equal(intl.productCode, 'sfm_tokenplanteams_dp_intl');

  // Personal reads its quota from a different host than its dashboard. That is
  // the whole reason the settings panel tells Personal users to copy the cookie
  // from the quota request instead of the dashboard page.
  const cnPersonal = alibabaVariantConfig('cn-personal');
  assert.equal(cnPersonal.gatewayOrigin, 'https://bailian.console.aliyun.com');
  assert.equal(cnPersonal.quotaOrigin, 'https://bailian-cs.console.aliyun.com');
  assert.equal(cnPersonal.personal, true);

  const intlPersonal = alibabaVariantConfig('intl-personal');
  assert.equal(intlPersonal.gatewayOrigin, 'https://modelstudio.console.alibabacloud.com');
  assert.equal(intlPersonal.quotaOrigin, 'https://bailian-singapore-cs.alibabacloud.com');
});

test('parseTeamSummary reads the captured mainland Team payload', () => {
  const summary = parseTeamSummary(parseConsoleBody(REAL_MAINLAND_TEAM_BODY));

  assert.equal(summary.uid, '123456');
  assert.equal(summary.total, 250000);
  assert.equal(summary.remaining, 239673.78313);
  assert.ok(Math.abs(summary.used - 10326.21687) < 1e-6);
  assert.equal(summary.subscriptions, 1);
  // The captured payload names no tier, so the row still says which product it
  // is for. A payload that does name one shows that instead.
  assert.equal(summary.planName, 'Token Plan');
  assert.equal(summary.resetsAt, '2026-09-28T08:00:00.000Z');
});

// The gateway double-stringifies its envelopes; without expansion a perfectly
// healthy response reads as an empty one and the provider reports no data.
test('parseConsoleBody expands a JSON envelope nested as a string', () => {
  const body = JSON.stringify({
    successResponse: {
      body: JSON.stringify({
        success: true,
        data: { totalCount: 1, totalSurplusValue: 750, totalValue: 1000 }
      })
    }
  });

  const summary = parseTeamSummary(parseConsoleBody(body));
  assert.equal(summary.total, 1000);
  assert.equal(summary.remaining, 750);
  assert.equal(summary.used, 250);
});

test('expandEmbeddedJson leaves non-JSON strings and scalars alone', () => {
  assert.deepEqual(
    expandEmbeddedJson({ a: 'plain', b: '{"c":1}', d: 3, e: ['{"f":2}'] }),
    { a: 'plain', b: { c: 1 }, d: 3, e: [{ f: 2 }] }
  );
});

// Key matching is case-insensitive across the whole tree, which is what lets one
// parser serve four consoles that disagree about capitalisation.
test('parseTeamSummary matches quota keys regardless of case or depth', () => {
  const summary = parseTeamSummary({
    Data: { envelope: { CYCLETOTALVALUE: 400, cycleSurplusValue: 100, TotalCount: 2 } }
  });
  assert.equal(summary.total, 400);
  assert.equal(summary.remaining, 100);
  assert.equal(summary.used, 300);
});

// A reported `used` is preferred over a derived one: an account whose payload
// carries used-and-total but no remaining would otherwise show nothing at all.
test('parseTeamSummary prefers a reported used over deriving it', () => {
  const summary = parseTeamSummary({ Data: { usedValue: 120, TotalValue: 500 } });
  assert.equal(summary.used, 120);
  assert.equal(summary.total, 500);
  assert.equal(summary.remaining, null);
});

test('secTokenFromHtml reads the console shell’s unquoted upper-case key', () => {
  assert.equal(secTokenFromHtml('window.ALIYUN_CONSOLE_CONFIG={SEC_TOKEN:"abc123",X:1}'), 'abc123');
  assert.equal(secTokenFromHtml('{"secToken":"def456"}'), 'def456');
  assert.equal(secTokenFromHtml('<html>nothing here</html>'), '');
});

test('parseConsoleBody maps a signed-out HTML login shell to unauthorized', () => {
  assert.throws(
    () => parseConsoleBody('<html><head><title>Login</title></head><body>sign in</body></html>'),
    (error) => error.status === 'unauthorized'
  );
});

test('parseConsoleBody maps a stale session envelope to unauthorized', () => {
  const body = JSON.stringify({
    data: {
      success: false,
      errorCode: 'BailianGateway.Login.NotLogined',
      errorMsg: 'BailianGateway.Login.NotLogined'
    },
    httpStatusCode: '200'
  });
  assert.throws(() => parseConsoleBody(body), (error) => error.status === 'unauthorized');
});

// The outer envelope can report success while a nested frame carries the real
// failure. Reading the outer one would report an outcome that did not happen.
test('parseConsoleBody reads the failure off the frame that reported it', () => {
  const body = JSON.stringify({
    code: '200',
    successResponse: true,
    data: { success: false, errorCode: 'Gateway.Boom', errorMsg: 'something broke' }
  });
  assert.throws(() => parseConsoleBody(body), (error) => (
    error.status === 'unavailable' && /something broke/.test(error.message)
  ));
});

// A workspace permission failure is not a credential failure. Reporting it as
// one would tell the user to re-paste a cookie that is already valid, and the
// replacement would fail in exactly the same way.
test('parseConsoleBody does not blame the credential for a workspace denial', () => {
  const body = JSON.stringify({
    data: {
      success: false,
      errorCode: 'BailianGateway.Workspace.NotAuthorised',
      errorMsg: 'BailianGateway.Workspace.NotAuthorised'
    }
  });
  assert.throws(() => parseConsoleBody(body), (error) => error.status === 'unavailable');
});

test('parseConsoleBody surfaces a non-200 status code carried in the body', () => {
  assert.throws(
    () => parseConsoleBody(JSON.stringify({ successResponse: false, statusCode: 403 })),
    (error) => error.status === 'unauthorized'
  );
  assert.throws(
    () => parseConsoleBody(JSON.stringify({ statusCode: 429, message: 'slow down' })),
    (error) => error.status === 'sourceRateLimited'
  );
});

test('parseConsoleBody accepts a success envelope that carries no error fields', () => {
  const payload = parseConsoleBody('{"code":"SUCCESS","successResponse":true,"msg":"Success.","data":{}}');
  assert.deepEqual(payload.data, {});
});

test('parsePersonalUsage maps both rolling windows and the plan totals', () => {
  const usage = parsePersonalUsage(
    {
      data: {
        DataV2: {
          data: {
            success: true,
            data: {
              per5HourPercentage: 0.25,
              per5HourResetTime: 1784813220000,
              per1WeekPercentage: 0.10007527475,
              per1WeekResetTime: 1785234900000
            }
          }
        }
      },
      successResponse: true
    },
    { data: { specCode: 'pro' } },
    { data: { pro: { five_hour: 1000, weekly: 20000 } } }
  );

  assert.equal(usage.planName, 'Pro');
  assert.equal(usage.fiveHourPercent, 25);
  assert.equal(usage.fiveHourTotal, 1000);
  assert.equal(usage.fiveHourResetsAt, new Date(1784813220000).toISOString());
  assert.ok(Math.abs(usage.weeklyPercent - 10.007527475) < 1e-9);
  assert.equal(usage.weeklyTotal, 20000);
});

test('parsePersonalUsage accepts a weekly-only response', () => {
  const usage = parsePersonalUsage(
    { data: { DataV2: { data: { success: true, data: { per1WeekPercentage: 0.5, per1WeekResetTime: 1785234900000 } } } } },
    null,
    null
  );
  assert.equal(usage.fiveHourPercent, null);
  assert.equal(usage.weeklyPercent, 50);
  assert.equal(usage.planName, 'Personal');
});

test('parsePersonalUsage rejects a payload with no window fields', () => {
  assert.throws(
    () => parsePersonalUsage({ data: { success: true, data: {} } }, null, null),
    (error) => error.status === 'windowsUnavailable'
  );
});

test('fetchAlibabaLimits reports notConfigured without a cookie', async () => {
  const [provider] = await fetchAlibabaLimits({}, { env: {} });
  assert.equal(provider.provider, 'alibaba');
  assert.equal(provider.status, 'notConfigured');
  assert.equal(provider.region, 'cn');
  assert.deepEqual(provider.windows, []);
});

test('fetchAlibabaLimits posts GetSubscriptionSummary and normalizes the Team pool', async () => {
  const { calls, fetchFn } = routedFetch([
    ...NO_SEC_TOKEN,
    ['GetSubscriptionSummary', ok(REAL_MAINLAND_TEAM_BODY)]
  ]);

  const [provider] = await fetchAlibabaLimits(
    { alibabaCookie: 'login_aliyunid_pk=abc; login_aliyunid_csrf=tok' },
    { env: {}, fetch: fetchFn }
  );

  const quota = calls.find((call) => call.url.includes('GetSubscriptionSummary') && call.init.method === 'POST');
  assert.ok(quota, 'expected a GetSubscriptionSummary POST');
  assert.ok(quota.url.startsWith('https://bailian.console.aliyun.com/data/api.json'));
  assert.match(quota.init.body, /ProductCode.*sfm_tokenplanteams_dp_cn/);
  assert.match(quota.init.body, /region=cn-beijing/);
  // The CSRF cookie is echoed back as a header; the gateway rejects the request
  // for accounts where it is set but not mirrored.
  assert.equal(quota.init.headers['x-xsrf-token'], 'tok');

  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'web');
  assert.equal(provider.region, 'cn');
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].kind, 'billing');
  assert.equal(provider.windows[0].label, '');
  assert.equal(provider.windows[0].limit, 250000);
  assert.equal(provider.windows[0].remaining, 239673.78313);
});

// Chromium cancels a cross-origin Referer that carries a path, so the console
// requests send a bare origin. See src/electron/limitsFetch.js.
test('fetchAlibabaLimits sends a bare-origin Referer', async () => {
  const { calls, fetchFn } = routedFetch([
    ...NO_SEC_TOKEN,
    ['GetSubscriptionSummary', ok(REAL_MAINLAND_TEAM_BODY)]
  ]);

  await fetchAlibabaLimits({ alibabaCookie: 'a=b' }, { env: {}, fetch: fetchFn });

  for (const call of calls) {
    const referer = call.init.headers?.Referer;
    if (!referer) continue;
    assert.match(referer, /^https:\/\/[^/]+\/$/, `${call.url} must not send a path in Referer`);
  }
});

test('fetchAlibabaLimits targets the international console for the intl variant', async () => {
  const { calls, fetchFn } = routedFetch([
    ...NO_SEC_TOKEN,
    ['GetSubscriptionSummary', ok(REAL_MAINLAND_TEAM_BODY)]
  ]);

  await fetchAlibabaLimits(
    { alibabaCookie: 'a=b', alibabaVariant: 'intl' },
    { env: {}, fetch: fetchFn }
  );

  const quota = calls.find((call) => call.url.includes('GetSubscriptionSummary') && call.init.method === 'POST');
  assert.ok(quota.url.startsWith('https://modelstudio.console.alibabacloud.com/data/api.json'));
  assert.match(quota.init.body, /sfm_tokenplanteams_dp_intl/);
  assert.match(quota.init.body, /region=ap-southeast-1/);
});

// An account with no active subscription is a real, authorized account. The row
// stays visible so the user can see the credential works; there is simply no
// pool to draw.
test('fetchAlibabaLimits keeps an empty subscription visible without a window', async () => {
  const { fetchFn } = routedFetch([
    ...NO_SEC_TOKEN,
    ['GetSubscriptionSummary', ok({ Success: true, Data: { TotalCount: 0 }, Code: '200' })]
  ]);

  const [provider] = await fetchAlibabaLimits({ alibabaCookie: 'a=b' }, { env: {}, fetch: fetchFn });
  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows, []);
});

test('fetchAlibabaLimits maps HTTP and envelope failures to distinct statuses', async () => {
  const cases = [
    [status(401), 'unauthorized'],
    [status(403), 'unauthorized'],
    [status(429), 'sourceRateLimited'],
    [status(500), 'unavailable'],
    [ok({ data: { success: false, errorCode: 'BailianGateway.Login.NotLogined' } }), 'unauthorized'],
    [ok('<html><body>please login</body></html>'), 'unauthorized']
  ];

  for (const [respond, expected] of cases) {
    const { fetchFn } = routedFetch([...NO_SEC_TOKEN, ['GetSubscriptionSummary', respond]]);
    const [provider] = await fetchAlibabaLimits({ alibabaCookie: 'a=b' }, { env: {}, fetch: fetchFn });
    assert.equal(provider.status, expected);
    assert.equal(provider.region, 'cn');
  }
});

test('fetchAlibabaLimits reads Personal rolling windows from the quota host', async () => {
  const { calls, fetchFn } = routedFetch([
    ['token-plan/personal', ok('<html>shell</html>')],
    ['/tool/user/info.json', ok({ data: { secToken: 'sec-1' } })],
    ['api/v2/subscription', ok({ data: { specCode: 'max' } })],
    ['api/v2/quota-config', ok({ data: { max: { five_hour: 900, weekly: 12000 } } })],
    ['api/v2/usage', ok({
      successResponse: true,
      data: {
        DataV2: {
          data: {
            success: true,
            data: {
              per5HourPercentage: 0.4,
              per5HourResetTime: 1784813220000,
              per1WeekPercentage: 0.2,
              per1WeekResetTime: 1785234900000
            }
          }
        }
      }
    })]
  ]);

  const [provider] = await fetchAlibabaLimits(
    { alibabaCookie: 'login_aliyunid_pk=abc; cna=anon1', alibabaVariant: 'cn-personal' },
    { env: {}, fetch: fetchFn }
  );

  const usage = calls.find((call) => decodeURIComponent(call.url).includes('api/v2/usage'));
  assert.ok(usage.url.startsWith('https://bailian-cs.console.aliyun.com/data/api.json'));
  // The resolved sec_token is attached; some accounts are rejected without it.
  assert.match(usage.init.body, /sec_token=sec-1/);
  // A captured `switchAgent` would bind the request to one account's workspace
  // and make every other account fail, so it is deliberately never sent.
  assert.doesNotMatch(usage.init.body, /switchAgent/);

  assert.equal(provider.status, 'ok');
  assert.equal(provider.workspaceKind, 'personal');
  assert.equal(provider.region, 'cn-personal');
  assert.equal(provider.accountLabel, 'Max');
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session', 'weekly']);
  assert.equal(provider.windows[0].usedPercent, 40);
  assert.equal(provider.windows[0].limit, 900);
  assert.equal(provider.windows[1].usedPercent, 20);
  assert.equal(provider.windows[1].limit, 12000);
});

// The Personal gateway intermittently answers 200 with no rolling-window
// payload; an immediate re-request usually returns it.
test('fetchAlibabaLimits retries a Personal response that carries no windows', async () => {
  let usageCalls = 0;
  const { fetchFn } = routedFetch([
    ['/tool/user/info.json', ok({})],
    ['api/v2/usage', () => {
      usageCalls += 1;
      const body = usageCalls < 2
        ? { successResponse: true, data: { success: true, data: {} } }
        : { successResponse: true, data: { success: true, data: { per1WeekPercentage: 0.6, per1WeekResetTime: 1785234900000 } } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }],
    ['token-plan/personal', ok('<html>shell</html>')]
  ]);

  const [provider] = await fetchAlibabaLimits(
    { alibabaCookie: 'a=b', alibabaVariant: 'intl-personal' },
    { env: {}, fetch: fetchFn, setTimeout: (fn) => fn() }
  );

  assert.equal(usageCalls, 2);
  assert.equal(provider.status, 'ok');
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].usedPercent, 60);
});

test('fetchAlibabaLimits gives up after the bounded Personal retry budget', async () => {
  let usageCalls = 0;
  const { fetchFn } = routedFetch([
    ['/tool/user/info.json', ok({})],
    ['api/v2/usage', () => {
      usageCalls += 1;
      return { ok: true, status: 200, text: async () => '{"successResponse":true,"data":{"success":true,"data":{}}}' };
    }],
    ['token-plan/personal', ok('<html>shell</html>')]
  ]);

  const [provider] = await fetchAlibabaLimits(
    { alibabaCookie: 'a=b', alibabaVariant: 'cn-personal' },
    { env: {}, fetch: fetchFn, setTimeout: (fn) => fn() }
  );

  assert.equal(usageCalls, 3);
  assert.equal(provider.status, 'unavailable');
});

// An aborted refresh is not a provider outcome. Returning a row here would
// record a fabricated `unavailable` over the last real answer.
test('fetchAlibabaLimits propagates an abort instead of reporting a status', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => fetchAlibabaLimits(
      { alibabaCookie: 'a=b' },
      { env: {}, fetch: async () => { throw new Error('must not reach the network'); }, signal: controller.signal }
    ),
    (error) => error.name === 'AbortError'
  );
});

test('fetchAlibabaLimits stops the sec_token hunt once the refresh is aborted', async () => {
  const controller = new AbortController();
  let requests = 0;
  const fetchFn = async () => {
    requests += 1;
    controller.abort();
    return { ok: true, status: 200, text: async () => '<html>shell</html>' };
  };

  await assert.rejects(
    () => fetchAlibabaLimits(
      { alibabaCookie: 'a=b' },
      { env: {}, fetch: fetchFn, signal: controller.signal }
    ),
    (error) => error.name === 'AbortError'
  );
  assert.equal(requests, 1, 'the remaining hops must not run after an abort');
});
