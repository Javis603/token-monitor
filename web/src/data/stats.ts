import type {
  HubStats,
  LimitProvider,
  LimitWindow,
  PeriodKey,
  UsagePeriod,
  UsageSession
} from './types.js';

const EMPTY_PERIOD: UsagePeriod = {};

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function periodFor(stats: HubStats, key: PeriodKey): UsagePeriod {
  return stats.periods?.[key] ?? EMPTY_PERIOD;
}

export function formatTokens(value: unknown): string {
  const number = Math.max(0, finite(value));
  if (number < 1_000) return Math.round(number).toLocaleString('en-US');
  const units = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' }
  ];
  const unit = units.find(({ threshold }) => number >= threshold) ?? units[2];
  const compact = number / unit.threshold;
  const digits = compact >= 100 ? 0 : 1;
  return `${compact.toFixed(digits).replace(/\.0$/, '')}${unit.suffix}`;
}

export interface UsageRow {
  id: string;
  total: number;
  input: number | null;
  output: number | null;
}

export function usageRows(period: UsagePeriod, kind: 'clients' | 'models'): UsageRow[] {
  const totals = period[kind] ?? {};
  const outputs = kind === 'clients' ? period.clientOutputs : period.modelOutputs;
  const cacheReads = kind === 'clients' ? period.clientCacheReads : period.modelCacheReads;
  const cacheWrites = kind === 'clients' ? period.clientCacheWrites : period.modelCacheWrites;
  const unclassified = kind === 'clients' ? period.clientUnclassifiedTokens : period.modelUnclassifiedTokens;
  const componentsAvailable = period.capabilities?.tokenComponents === true;
  return Object.entries(totals)
    .map(([id, total]) => {
      const normalizedTotal = finite(total);
      const explicitOutput = optionalFinite(outputs?.[id]);
      const output = componentsAvailable ? (explicitOutput ?? 0) : explicitOutput;
      return {
        id,
        total: normalizedTotal,
        // The Hub intentionally stores output/cache families, not an input map.
        // Input is the remainder only when every component is declared trusted.
        input: componentsAvailable
          ? Math.max(0, normalizedTotal - (output ?? 0) - finite(cacheReads?.[id]) - finite(cacheWrites?.[id]) - finite(unclassified?.[id]))
          : null,
        output
      };
    })
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
}

export function periodTokenSplit(period: UsagePeriod): { input: number | null; output: number | null } {
  if (period.capabilities?.tokenComponents !== true) return { input: null, output: null };
  const total = finite(period.totalTokens);
  const output = Math.min(total, Math.max(0, finite(period.outputTokens)));
  const input = Math.max(
    0,
    total - output - finite(period.cacheReadTokens) - finite(period.cacheWriteTokens) - finite(period.unclassifiedTokens)
  );
  return { input, output };
}

export interface SessionRow extends UsageSession {
  id: string;
  totalTokens: number;
}

export function recentSessions(period: UsagePeriod, limit = 8): SessionRow[] {
  return Object.entries(period.sessions ?? {})
    .map(([id, session]) => ({ ...session, id, totalTokens: finite(session.totalTokens) }))
    .sort((a, b) => (Date.parse(b.lastUsedAt ?? '') || 0) - (Date.parse(a.lastUsedAt ?? '') || 0) || b.totalTokens - a.totalTokens || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function normalizedUsedPercent(window: LimitWindow): number | null {
  const used = optionalFinite(window.usedPercent);
  const remaining = optionalFinite(window.remainingPercent);
  const value = used ?? (remaining === null ? null : 100 - remaining);
  return value === null ? null : Math.min(100, Math.max(0, value));
}

export interface LimitRow extends Omit<LimitProvider, 'provider' | 'windows'> {
  provider: string;
  status: string;
  windows: Array<Omit<LimitWindow, 'usedPercent'> & { usedPercent: number | null }>;
}

export function limitRows(stats: HubStats): LimitRow[] {
  return (stats.limits?.providers ?? []).map((provider) => ({
    ...provider,
    provider: provider.provider?.trim() || 'unknown',
    status: provider.status?.trim() || 'unknown',
    windows: (provider.windows ?? [])
      .map((window) => ({ ...window, usedPercent: normalizedUsedPercent(window) }))
  }));
}

export interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  runtime: string;
  receivedAt: string;
  stale: boolean;
  totalTokens: number;
}

export function deviceRows(stats: HubStats, key: PeriodKey): DeviceRow[] {
  return (stats.devices ?? [])
    .map((device) => ({
      id: device.deviceId?.trim() || 'unknown',
      name: device.hostname?.trim() || device.deviceId?.trim() || 'Unknown device',
      platform: [device.osName || device.platform, device.osVersion].filter(Boolean).join(' '),
      runtime: device.agentRuntime?.trim() || '',
      receivedAt: device.receivedAt?.trim() || '',
      stale: device.stale === true,
      totalTokens: finite(device.periods?.[key]?.totalTokens)
    }))
    .sort((a, b) => Number(a.stale) - Number(b.stale) || b.totalTokens - a.totalTokens || a.id.localeCompare(b.id));
}

type JsonObject = Record<string, unknown>;
function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: JsonObject, names: string[], type: 'string' | 'number' | 'boolean'): boolean {
  return names.every(name => value[name] == null || (typeof value[name] === type && (type !== 'number' || Number.isFinite(value[name]))));
}
function validPeriod(value: unknown): boolean {
  if (!record(value)) return false;
  if (!fields(value, ['totalTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unclassifiedTokens', 'reasoningTokens'], 'number')) return false;
  if (value.capabilities != null && (!record(value.capabilities) || !fields(value.capabilities, ['tokenComponents'], 'boolean'))) return false;
  for (const name of ['clients', 'clientOutputs', 'clientCacheReads', 'clientCacheWrites', 'clientUnclassifiedTokens', 'models', 'modelOutputs', 'modelCacheReads', 'modelCacheWrites', 'modelUnclassifiedTokens']) {
    const map = value[name];
    if (map != null && (!record(map) || !Object.values(map).every(item => typeof item === 'number' && Number.isFinite(item)))) return false;
  }
  return value.sessions == null || (record(value.sessions) && Object.values(value.sessions).every(session =>
    record(session) && fields(session, ['client', 'sessionId', 'projectLabel', 'lastUsedAt', 'startedAt'], 'string')
      && fields(session, ['totalTokens', 'inputTokens', 'outputTokens'], 'number')));
}
function validPeriods(value: unknown): boolean {
  return record(value) && ['today', 'month', 'allTime'].every(key => value[key] == null || validPeriod(value[key]));
}
function validProvider(value: unknown): boolean {
  if (!record(value) || !fields(value, ['provider', 'accountLabel', 'planLabel', 'status', 'updatedAt'], 'string') || !fields(value, ['stale'], 'boolean')) return false;
  if (value.balance != null && (!record(value.balance) || !fields(value.balance, ['amount', 'todaySpend', 'weekSpend', 'monthSpend', 'allTimeSpend'], 'number') || !fields(value.balance, ['currency', 'trackingSince'], 'string') || !fields(value.balance, ['monthSinceTracking'], 'boolean'))) return false;
  if (value.resetCredits != null && (!record(value.resetCredits) || !fields(value.resetCredits, ['availableCount'], 'number') || !fields(value.resetCredits, ['nextExpiresAt'], 'string'))) return false;
  return value.windows == null || (Array.isArray(value.windows) && value.windows.every(window =>
    record(window) && fields(window, ['kind', 'label', 'resetsAt', 'metric', 'currency', 'detail', 'resetDescription'], 'string')
      && fields(window, ['windowMinutes', 'usedPercent', 'remainingPercent', 'used', 'limit', 'remaining'], 'number') && fields(window, ['showMeter'], 'boolean')));
}
export function isHubStats(value: unknown): value is HubStats {
  if (!record(value) || !validPeriods(value.periods) || !Array.isArray(value.devices)) return false;
  if (!value.devices.every(device => record(device)
    && fields(device, ['deviceId', 'hostname', 'platform', 'osName', 'osVersion', 'agentRuntime', 'receivedAt'], 'string')
    && fields(device, ['stale'], 'boolean') && (device.periods == null || validPeriods(device.periods)))) return false;
  return value.limits == null || (record(value.limits) && (value.limits.providers == null
    || (Array.isArray(value.limits.providers) && value.limits.providers.every(validProvider))));
}
