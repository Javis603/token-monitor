export type PeriodKey = 'today' | 'month' | 'allTime';

export interface UsageSession {
  client?: string;
  sessionId?: string;
  projectLabel?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  lastUsedAt?: string;
  startedAt?: string;
}

export interface UsagePeriod {
  capabilities?: { tokenComponents?: boolean };
  totalTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  unclassifiedTokens?: number;
  reasoningTokens?: number;
  clients?: Record<string, number>;
  clientOutputs?: Record<string, number>;
  clientCacheReads?: Record<string, number>;
  clientCacheWrites?: Record<string, number>;
  clientUnclassifiedTokens?: Record<string, number>;
  models?: Record<string, number>;
  modelOutputs?: Record<string, number>;
  modelCacheReads?: Record<string, number>;
  modelCacheWrites?: Record<string, number>;
  modelUnclassifiedTokens?: Record<string, number>;
  sessions?: Record<string, UsageSession>;
}

export interface LimitWindow {
  windowMinutes?: number;
  kind?: string;
  label?: string;
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetsAt?: string | null;
  showMeter?: boolean;
  metric?: string;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  currency?: string | null;
  detail?: string;
  resetDescription?: string;
}

export interface LimitBalance {
  amount?: number | null;
  currency?: string | null;
  todaySpend?: number | null;
  weekSpend?: number | null;
  monthSpend?: number | null;
  allTimeSpend?: number | null;
  trackingSince?: string | null;
  monthSinceTracking?: boolean;
}

export interface ResetCredits {
  availableCount?: number | null;
  nextExpiresAt?: string | null;
}

export interface LimitProvider {
  accountKey?: string;
  webAccountKey?: string;
  accountEmail?: string;
  accountName?: string;
  visibilityKey?: string;
  provider?: string;
  accountLabel?: string;
  planLabel?: string;
  balance?: LimitBalance | null;
  resetCredits?: ResetCredits | null;
  status?: string;
  stale?: boolean;
  updatedAt?: string;
  windows?: LimitWindow[];
}

export interface HubDevice {
  deviceId?: string;
  hostname?: string;
  platform?: string;
  osName?: string;
  osVersion?: string;
  agentRuntime?: string;
  receivedAt?: string;
  stale?: boolean;
  periods?: Partial<Record<PeriodKey, UsagePeriod>>;
}

export interface HubStats {
  staleAfterMs?: number;
  periods?: Partial<Record<PeriodKey, UsagePeriod>>;
  limits?: { providers?: LimitProvider[] };
  devices?: HubDevice[];
  [key: string]: unknown;
}

export interface StoredSnapshot {
  savedAt: string;
  stats: HubStats;
}
