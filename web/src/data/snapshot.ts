import { isHubStats, recentSessions } from './stats';
import type { HubStats, StoredSnapshot, UsagePeriod } from './types';

interface WorkerTarget {
  postMessage(message: unknown): void;
}

export interface ServiceWorkerBridge {
  ready: Promise<{ active: WorkerTarget | null }>;
  controller: WorkerTarget | null;
}

interface SaveOptions {
  now?: () => Date;
  serviceWorker?: ServiceWorkerBridge;
}

function numericMap(value: Record<string, number> | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(value ?? {}).filter((entry) => Number.isFinite(entry[1])));
}

function sanitizePeriod(period: UsagePeriod | undefined): UsagePeriod {
  const source = period ?? {};
  const sessions = recentSessions(source).map(({ id, ...session }) => [id, session] as const);
  return {
    capabilities: { tokenComponents: source.capabilities?.tokenComponents === true },
    totalTokens: source.totalTokens,
    outputTokens: source.outputTokens,
    cacheReadTokens: source.cacheReadTokens,
    cacheWriteTokens: source.cacheWriteTokens,
    unclassifiedTokens: source.unclassifiedTokens,
    clients: numericMap(source.clients),
    clientOutputs: numericMap(source.clientOutputs),
    clientCacheReads: numericMap(source.clientCacheReads),
    clientCacheWrites: numericMap(source.clientCacheWrites),
    clientUnclassifiedTokens: numericMap(source.clientUnclassifiedTokens),
    models: numericMap(source.models),
    modelOutputs: numericMap(source.modelOutputs),
    modelCacheReads: numericMap(source.modelCacheReads),
    modelCacheWrites: numericMap(source.modelCacheWrites),
    modelUnclassifiedTokens: numericMap(source.modelUnclassifiedTokens),
    sessions: Object.fromEntries(sessions.map(([id, session]) => [id, {
      client: session.client,
      sessionId: session.sessionId,
      projectLabel: session.projectLabel,
      totalTokens: session.totalTokens,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      lastUsedAt: session.lastUsedAt,
      startedAt: session.startedAt
    }]))
  };
}

export function sanitizeStatsForOffline(stats: HubStats): HubStats {
  return {
    periods: {
      today: sanitizePeriod(stats.periods?.today),
      month: sanitizePeriod(stats.periods?.month),
      allTime: sanitizePeriod(stats.periods?.allTime)
    },
    limits: {
      providers: (stats.limits?.providers ?? []).map((provider) => ({
        provider: provider.provider,
        // Preserve only the key-kind flag needed for display, never arbitrary plan/account labels.
        ...(provider.provider === 'openrouter' && provider.planLabel?.trim().toLowerCase() === 'management'
          ? { planLabel: 'Management' } : {}),
        status: provider.status,
        stale: provider.stale,
        updatedAt: provider.updatedAt,
        balance: provider.balance ? {
          amount: provider.balance.amount,
          currency: provider.balance.currency,
          todaySpend: provider.balance.todaySpend,
          weekSpend: provider.balance.weekSpend,
          monthSpend: provider.balance.monthSpend,
          allTimeSpend: provider.balance.allTimeSpend,
          trackingSince: provider.balance.trackingSince,
          monthSinceTracking: provider.balance.monthSinceTracking
        } : undefined,
        resetCredits: provider.resetCredits ? {
          availableCount: provider.resetCredits.availableCount,
          nextExpiresAt: provider.resetCredits.nextExpiresAt
        } : undefined,
        // Keep structured quota data; provider detail/resetDescription remain online-only.
        windows: (provider.windows ?? []).map((window) => ({
          kind: window.kind,
          label: window.label,
          usedPercent: window.usedPercent,
          windowMinutes: window.windowMinutes,
          remainingPercent: window.remainingPercent,
          resetsAt: window.resetsAt,
          showMeter: window.showMeter,
          metric: window.metric,
          used: window.used,
          limit: window.limit,
          remaining: window.remaining,
          currency: window.currency
        }))
      }))
    },
    devices: (stats.devices ?? []).map((device) => ({
      deviceId: device.deviceId,
      hostname: device.hostname,
      platform: device.platform,
      osName: device.osName,
      osVersion: device.osVersion,
      agentRuntime: device.agentRuntime,
      receivedAt: device.receivedAt,
      stale: device.stale,
      periods: {
        today: { totalTokens: device.periods?.today?.totalTokens },
        month: { totalTokens: device.periods?.month?.totalTokens },
        allTime: { totalTokens: device.periods?.allTime?.totalTokens }
      }
    }))
  };
}

export async function saveOfflineSnapshot(stats: HubStats, options: SaveOptions = {}): Promise<void> {
  const serviceWorker = options.serviceWorker
    ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined);
  if (!serviceWorker) return;
  const registration = await serviceWorker.ready;
  const target = serviceWorker.controller ?? registration.active;
  target?.postMessage({
    type: 'SAVE_STATS_SNAPSHOT',
    payload: {
      savedAt: (options.now ?? (() => new Date()))().toISOString(),
      stats: sanitizeStatsForOffline(stats)
    }
  });
}

export async function loadOfflineSnapshot(
  fetcher: typeof fetch = fetch
): Promise<StoredSnapshot | null> {
  try {
    const response = await fetcher('/__offline__/stats.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const value = await response.json() as Partial<StoredSnapshot>;
    if (typeof value.savedAt !== 'string' || !isHubStats(value.stats)) return null;
    return { savedAt: value.savedAt, stats: value.stats };
  } catch {
    return null;
  }
}
