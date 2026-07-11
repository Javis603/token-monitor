'use strict';

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { parseZaiUsage } = require('./zaiLimits');

// The team plan only exists on the China (bigmodel.cn) side — z.ai global has no
// team tier — so the region is fixed and there is no region selector in the UI.
const ZAI_TEAM_BASE_URL = 'https://open.bigmodel.cn';
const ZAI_TEAM_QUOTA_PATH = '/api/monitor/usage/quota/limit';
const ZAI_TEAM_QUOTA_PARAMS = 'type=2';
const ZAI_TEAM_QUOTA_URL = `${ZAI_TEAM_BASE_URL}${ZAI_TEAM_QUOTA_PATH}?${ZAI_TEAM_QUOTA_PARAMS}`;
const ZAI_TEAM_DASHBOARD_URL = 'https://bigmodel.cn/coding-plan/team/usage-stats';
const ZAI_TEAM_KEY_NAMES = ['ZAI_TEAM_API_KEY', 'BIGMODEL_TEAM_API_KEY'];
const ZAI_TEAM_REGION = 'bigmodel-cn';

function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function zaiTeamToken(env = process.env, explicitKey = '') {
  const explicit = cleanSecret(explicitKey);
  if (explicit) return explicit;
  for (const name of ZAI_TEAM_KEY_NAMES) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function zaiTeamOrganizationId(options = {}, env = process.env) {
  return cleanSecret(options.zaiTeamOrganizationId || env.ZAI_TEAM_ORGANIZATION_ID || '');
}

function zaiTeamProjectId(options = {}, env = process.env) {
  return cleanSecret(options.zaiTeamProjectId || env.ZAI_TEAM_PROJECT_ID || '');
}

function zaiTeamDashboardUrl() {
  return ZAI_TEAM_DASHBOARD_URL;
}

async function fetchJson(url, { key, organization, project }, deps = {}) {
  const response = await (deps.fetch || fetch)(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      'bigmodel-organization': organization,
      'bigmodel-project': project,
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    const error = new Error(`${url} returned ${response.status}`);
    error.status = response.status === 401 || response.status === 403
      ? 'unauthorized'
      : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
    throw error;
  }
  return response.json();
}

async function fetchZaiTeamLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const key = zaiTeamToken(env, options.zaiTeamApiKey);
  const organization = zaiTeamOrganizationId(options, env);
  const project = zaiTeamProjectId(options, env);

  if (!key || !organization || !project) {
    return normalizeLimitProvider({
      provider: 'zaiteam',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: [],
      region: ZAI_TEAM_REGION
    });
  }

  try {
    const quota = await fetchJson(ZAI_TEAM_QUOTA_URL, { key, organization, project }, deps);
    const usage = parseZaiUsage(quota, null);
    return normalizeLimitProvider({
      provider: 'zaiteam',
      accountKey: hashKey('zaiteam', organization, project),
      accountLabel: usage.plan || 'Team',
      source: 'api',
      status: usage.windows.length ? 'ok' : 'unavailable',
      updatedAt,
      windows: usage.windows,
      region: ZAI_TEAM_REGION
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'zaiteam',
      source: 'api',
      status: error?.status || 'unavailable',
      updatedAt,
      windows: [],
      region: ZAI_TEAM_REGION
    });
  }
}

module.exports = {
  ZAI_TEAM_QUOTA_URL,
  zaiTeamToken,
  zaiTeamDashboardUrl,
  fetchZaiTeamLimits
};
