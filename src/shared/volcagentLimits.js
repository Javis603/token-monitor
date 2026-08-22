'use strict';

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const {
  clampPercent,
  displayPlanText,
  epochToIso,
  fetchJsonWithDeadline,
  numberOrNull,
  signVolcengineRequest,
  volcengineCredentials
} = require('./volcengineLimits');

const VOLCAGENT_FETCH_TIMEOUT_MS = 12_000;

// Agent Plan 用量走火山引擎 OpenAPI 的 GetAFPUsage（AFP = Agent Fuel Point）。
// 与 Coding Plan（GetCodingPlanUsage）同属 open.volcengineapi.com、同 Version、
// 同一套签名——唯一区别是 Action 名和响应结构。
const VOLCAGENT_AFP_URL = 'https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01';

// 两个套餐通常挂在同一个火山引擎账号下，所以 volcagent 显式凭据优先，
// 未配置时回退到 volcengine 凭据（settings 或环境变量），避免重复录入。
// 只有 AK/SK（signed 模式）能查 OpenAPI；纯 Ark API key 无法查询用量。
function volcagentCredentials(env = process.env, options = {}) {
  const own = volcengineCredentials(env, {
    volcengineAccessKeyId: options.volcagentAccessKeyId,
    volcengineSecretAccessKey: options.volcagentSecretAccessKey,
    volcengineRegion: options.volcagentRegion
  });
  if (own && own.mode === 'signed') return own;
  const shared = volcengineCredentials(env, {
    volcengineAccessKeyId: options.volcengineAccessKeyId,
    volcengineSecretAccessKey: options.volcengineSecretAccessKey,
    volcengineRegion: options.volcengineRegion
  });
  return shared && shared.mode === 'signed' ? shared : null;
}

function afpPlanLabel(result) {
  for (const field of ['PlanType', 'planType', 'PlanName', 'planName', 'ProductName', 'productName']) {
    const label = displayPlanText(result?.[field]);
    if (label) return label;
  }
  return '';
}

// GetAFPUsage 的额度是绝对额度（Quota/Used）而非百分比：
// Result.AFPFiveHour / Result.AFPWeekly / Result.AFPMonthly 各含 Quota、Used、ResetTime。
// Quota <= 0 视为未订阅该窗口（套餐档位可能不含某个窗口）。
function parseVolcagentAfpUsage(body) {
  const result = body?.Result || body?.result || {};
  const windows = [];
  for (const [field, kind, label, windowMinutes] of [
    ['AFPFiveHour', 'session', '5-hour', 5 * 60],
    ['AFPWeekly', 'weekly', 'Weekly', 7 * 24 * 60],
    ['AFPMonthly', 'billing', 'Monthly', 30 * 24 * 60]
  ]) {
    const window = result[field] || result[field.toLowerCase()];
    const quota = numberOrNull(window?.Quota ?? window?.quota);
    if (quota === null || quota <= 0) continue;
    const used = numberOrNull(window?.Used ?? window?.used);
    const usedPercent = used === null ? null : clampPercent((used / quota) * 100);
    windows.push({
      kind,
      label,
      used,
      limit: quota,
      remaining: used === null ? null : Math.max(0, quota - used),
      usedPercent,
      resetsAt: epochToIso(window?.ResetTime ?? window?.resetTime ?? window?.resetTimestamp),
      windowMinutes,
      showMeter: usedPercent !== null
    });
  }
  return {
    plan: afpPlanLabel(result),
    windows
  };
}

async function fetchVolcagentLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const credentials = volcagentCredentials(env, options);
  if (!credentials) {
    return normalizeLimitProvider({
      provider: 'volcagent',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }

  try {
    const signed = signVolcengineRequest({
      url: VOLCAGENT_AFP_URL,
      method: 'POST',
      body: '',
      date: new Date(now),
      ...credentials
    });
    const { response, body } = await fetchJsonWithDeadline(VOLCAGENT_AFP_URL, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body
    }, deps);
    if (!response.ok) {
      const error = new Error(`Volcengine Agent Plan returned ${response.status}`);
      error.status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw error;
    }
    const usage = parseVolcagentAfpUsage(body);
    return normalizeLimitProvider({
      provider: 'volcagent',
      accountKey: hashKey('volcagent', credentials.accessKeyId, credentials.region),
      accountLabel: usage.plan || 'Agent Plan',
      source: 'api',
      status: usage.windows.length ? 'ok' : 'unavailable',
      updatedAt,
      windows: usage.windows,
      region: credentials.region
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'volcagent',
      source: 'api',
      status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable',
      updatedAt,
      windows: [],
      region: credentials.region
    });
  }
}

module.exports = {
  VOLCAGENT_FETCH_TIMEOUT_MS,
  VOLCAGENT_AFP_URL,
  parseVolcagentAfpUsage,
  volcagentCredentials,
  fetchVolcagentLimits
};
