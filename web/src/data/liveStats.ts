import { isHubStats } from './stats';
import type { HubStats } from './types';

export interface EventSourceLike {
  onerror: EventSource['onerror'];
  onopen?: EventSource['onopen'];
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface VisibilityLike {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export type ConnectionStatus = 'connecting' | 'live' | 'retrying' | 'offline' | 'error';

interface LiveStatsOptions {
  visibility?: VisibilityLike;
  fetchStats?: () => Promise<HubStats>;
  openEventSource?: () => EventSourceLike;
  schedule?: (callback: () => void, delay: number) => number;
  cancel?: (handle: number) => void;
  random?: () => number;
  onSnapshot(stats: HubStats, source: 'fetch' | 'stream'): void;
  onStatus?(status: ConnectionStatus): void;
}

export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.min(30_000, Math.round(exponential * (1 + random() * 0.2)));
}

export async function defaultFetchStats(): Promise<HubStats> {
  const response = await fetch('/api/stats', { cache: 'no-store' });
  if (!response.ok) throw new Error(`stats request failed (${response.status})`);
  const value: unknown = await response.json();
  if (!isHubStats(value)) throw new Error('stats response has an unsupported shape');
  return value;
}

export function createLiveStats(options: LiveStatsOptions) {
  const visibility = options.visibility ?? document;
  const fetchStats = options.fetchStats ?? defaultFetchStats;
  const openEventSource = options.openEventSource ?? (() => new EventSource('/api/stats/stream'));
  const schedule = options.schedule ?? ((callback, delay) => window.setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => window.clearTimeout(handle));
  const random = options.random ?? Math.random;
  let started = false;
  let source: EventSourceLike | null = null;
  let timer: number | null = null;
  let attempt = 0;
  let initialFetchPending = false;

  function clearRetry() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function closeSource() {
    const current = source;
    source = null;
    current?.close();
  }

  function scheduleRetry() {
    closeSource();
    clearRetry();
    if (!started || visibility.visibilityState !== 'visible') return;
    options.onStatus?.('retrying');
    const delay = retryDelayMs(attempt, random);
    attempt += 1;
    timer = schedule(() => {
      timer = null;
      connect();
    }, delay);
  }

  function acceptEvent(event: MessageEvent<string>) {
    try {
      const envelope = JSON.parse(event.data) as { stats?: unknown };
      if (!isHubStats(envelope.stats)) return;
      attempt = 0;
      options.onSnapshot(envelope.stats, 'stream');
      options.onStatus?.('live');
    } catch {
      // Keep the last valid snapshot when an individual frame is malformed.
    }
  }

  function connect() {
    if (!started || initialFetchPending || visibility.visibilityState !== 'visible' || source) return;
    clearRetry();
    options.onStatus?.('connecting');
    const next = openEventSource();
    source = next;
    const acceptCurrentEvent = (event: MessageEvent<string>) => {
      if (source === next) acceptEvent(event);
    };
    next.addEventListener('snapshot', acceptCurrentEvent);
    next.addEventListener('stats', acceptCurrentEvent);
    next.onopen = () => {
      if (source === next) options.onStatus?.('live');
    };
    next.onerror = () => {
      if (source === next) scheduleRetry();
    };
  }

  function onVisibilityChange() {
    if (visibility.visibilityState !== 'visible') {
      clearRetry();
      closeSource();
      return;
    }
    attempt = 0;
    connect();
  }

  return {
    async start() {
      if (started) return;
      started = true;
      visibility.addEventListener('visibilitychange', onVisibilityChange);
      options.onStatus?.('connecting');
      initialFetchPending = true;
      try {
        const stats = await fetchStats();
        if (!started) return;
        options.onSnapshot(stats, 'fetch');
      } catch {
        if (!started) return;
        options.onStatus?.('offline');
      } finally {
        initialFetchPending = false;
      }
      connect();
    },
    stop() {
      if (!started) return;
      started = false;
      visibility.removeEventListener('visibilitychange', onVisibilityChange);
      clearRetry();
      closeSource();
    }
  };
}
