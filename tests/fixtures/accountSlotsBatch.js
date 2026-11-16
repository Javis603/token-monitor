'use strict';
const { hashKey } = require('../../src/shared/hashKey');
const spaces = require('./notionSpaces.json');
const allowance = require('./notionAllowance.json');
const workspace = 'f190126b-0445-43ec-94dd-f069ad1aa064';
const user = '8f24ac06-1807-4d51-9317-87d2f1a5f394';
const userB = 'ad5e1e56-1a69-42a5-aede-c8fde578f1a5';
const fixtures = {
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
    const body = fixture.body(n, url);
    return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
  };
}
function assertHeaders(id, values, headers) {
  const assert = require('node:assert/strict');
  if (id === 'zaiteam') {
    assert.equal(headers.Authorization, `Bearer ${values.zaiTeamApiKey}`);
    assert.equal(headers['bigmodel-organization'], values.zaiTeamOrganizationId);
    assert.equal(headers['bigmodel-project'], values.zaiTeamProjectId);
  } else assert.equal(headers.Cookie, Object.values(values)[0]);
}
module.exports = { fixtures, transport };
