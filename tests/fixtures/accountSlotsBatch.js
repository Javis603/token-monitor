'use strict';
const { hashKey } = require('../../src/shared/hashKey');
const spaces = require('./notionSpaces.json');
const allowance = require('./notionAllowance.json');
const workspace = 'f190126b-0445-43ec-94dd-f069ad1aa064';
const user = '8f24ac06-1807-4d51-9317-87d2f1a5f394';
const userB = 'ad5e1e56-1a69-42a5-aede-c8fde578f1a5';
const legacyTraeBody = { user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 100 } }, usage: { credits_amount: 10 } }] };
const fixtures = {
  typesafe: {
    values: n => ({ typesafeCookie: `session=${n}` }),
    key: n => hashKey('typesafe', `session=${n}`),
    body: (n, url, init) => url.includes('/api/usage') ? JSON.stringify({ buckets: [] })
      : url.endsWith('/chunk.js') ? `"${n.repeat(40)}","getBillingOverviewResult"`
        : init.method === 'POST' ? `0:${JSON.stringify({ ok: true, data: { billing: { balance: 5, plan: 'free_plan' } } })}`
          : '<html><script src="/_next/chunk.js"></script></html>'
  },
  ollama: {
    values: n => ({ ollamaApiKey: `key-${n}`, ollamaCookie: '' }),
    key: n => hashKey('ollama', `api-key:key-${n}`),
    body: (_n, url) => url.endsWith('/me') ? {} : { included: { balance_usd: 5, allowance_usd: 10 } }
  },
  devin: {
    values: n => ({ devinBearerToken: `token-${n}`, devinOrganization: `org/${n}` }),
    key: n => hashKey('devin', `token-${n}`, `org/${n}`),
    body: () => ({ daily_percentage: 0.1, weekly_percentage: 0.2, plan_name: 'Pro' })
  },
  trae: {
    values: n => ({ traeCookie: `sessionid=${n}`, traeAccessToken: '', traeDeviceId: '' }),
    key: n => hashKey('trae', `sessionid=${n}`),
    body: (n, url) => url.endsWith('/GetUserToken') ? { Result: { Token: `jwt-${n}` } }
      : { is_credits_billing: true, usage_summary: { total_amount: 100, consumed_amount: 10 } }
  },
  zed: {
    values: n => ({ zedCookie: `zed.session=${n}` }),
    key: n => hashKey('zed', n),
    body: (_n, url) => url.endsWith('/usage') ? { plan: 'pro', current_usage: { token_spend_in_cents: 10, token_spend: { limit_in_cents: 1000 } } } : {}
  },
  commandcode: {
    values: n => ({ commandcodeCookie: `commandcode_prod_.session_token=${n}` }),
    key: n => hashKey('commandcode', `user-${n}`),
    body: (n, url) => url.endsWith('/credits') ? { credits: { monthlyCredits: 5 } } : { success: true, data: { planId: 'individual-go', userId: `user-${n}` } }
  },
  zaiteam: {
    values: n => ({ zaiTeamApiKey: `key-${n}`, zaiTeamOrganizationId: `org-${n}`, zaiTeamProjectId: `project-${n}` }),
    key: n => hashKey('zaiteam', `org-${n}`, `project-${n}`),
    body: () => ({ code: 200, data: { level: 'max', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 100, currentValue: 10, remaining: 90 }] } })
  },
  notion: {
    values: n => ({ notionCookie: `token_v2=${n}`, notionWorkspaceId: workspace }),
    key: n => hashKey('notion', (n === 'a' ? user : userB) + workspace),
    body: (n, url) => url.endsWith('/getSpaces') ? JSON.parse(JSON.stringify(spaces).replaceAll(user, n === 'a' ? user : userB)) : structuredClone(allowance)
  },
  opendesign: {
    values: n => ({ opendesignCookie: `session=${n}` }),
    key: n => hashKey('opendesign', `workspace-${n}`),
    body: (n, url) => url.endsWith('/current') ? { workspaceId: `workspace-${n}` } : { workspaceId: `workspace-${n}`, eligible: true, windows: [{ durationSeconds: 18000, usedCredits: 1, limitCredits: 20 }] }
  }
};
// Identify each request from its actual credential headers, never its call order.
function transport(id, seen = []) {
  const fixture = fixtures[id];
  return async (url, init) => {
    const credential = init.headers.Cookie || init.headers.Authorization;
    const n = credential.endsWith('a') ? 'a' : 'b';
    const values = fixture.values(n);
    assertHeaders(id, values, init.headers);
    seen.push({ n, url, init });
    if (id === 'typesafe' && init.method === 'POST') require('node:assert/strict').equal(init.headers['Next-Action'], n.repeat(40));
    const body = fixture.body(n, url, init);
    return { ok: true, status: 200, json: async () => body, text: async () => body, headers: { get: () => null } };
  };
}
function assertHeaders(id, values, headers) {
  const assert = require('node:assert/strict');
  if (id === 'ollama') {
    assert.equal(headers.Authorization, `Bearer ${values.ollamaApiKey}`);
    assert.equal(headers.Cookie, undefined);
  } else if (id === 'devin') {
    assert.equal(headers.Authorization, `Bearer ${values.devinBearerToken}`);
  } else if (id === 'trae') {
    assert.equal(headers.Cookie, values.traeCookie);
    if (headers.Authorization) assert.equal(headers.Authorization, `Cloud-IDE-JWT jwt-${headers.Cookie.slice(-1)}`);
  } else if (id === 'zaiteam') {
    assert.equal(headers.Authorization, `Bearer ${values.zaiTeamApiKey}`);
    assert.equal(headers['bigmodel-organization'], values.zaiTeamOrganizationId);
    assert.equal(headers['bigmodel-project'], values.zaiTeamProjectId);
  } else assert.equal(headers.Cookie, Object.values(values)[0]);
}
module.exports = { fixtures, transport, legacyTraeBody };
