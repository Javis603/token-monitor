import { describe, expect, it, vi } from 'vitest';
import { statsFixture } from '../test/fixtures';
import { createLiveStats, retryDelayMs, type EventSourceLike, type VisibilityLike } from './liveStats';

class FakeVisibility implements VisibilityLike {
  visibilityState: DocumentVisibilityState = 'visible';
  listener: (() => void) | undefined;
  addEventListener(_type: 'visibilitychange', listener: () => void) { this.listener = listener; }
  removeEventListener() { this.listener = undefined; }
  set(state: DocumentVisibilityState) { this.visibilityState = state; this.listener?.(); }
}

class FakeSource implements EventSourceLike {
  closed = false;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>); }
}

describe('live stats lifecycle', () => {
  it('fetches once, opens one visible stream, and closes it while hidden', async () => {
    const visibility = new FakeVisibility();
    const sources: FakeSource[] = [];
    const snapshots: unknown[] = [];
    const controller = createLiveStats({
      visibility,
      fetchStats: vi.fn().mockResolvedValue(statsFixture),
      openEventSource: () => { const source = new FakeSource(); sources.push(source); return source; },
      onSnapshot: (stats) => snapshots.push(stats)
    });

    await controller.start();
    expect(snapshots).toEqual([statsFixture]);
    expect(sources).toHaveLength(1);

    visibility.set('hidden');
    expect(sources[0].closed).toBe(true);
    visibility.set('visible');
    expect(sources).toHaveLength(2);
    controller.stop();
    expect(sources[1].closed).toBe(true);
  });

  it('accepts snapshot/stats events and uses controlled exponential retries', async () => {
    const visibility = new FakeVisibility();
    const sources: FakeSource[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const onSnapshot = vi.fn();
    const controller = createLiveStats({
      visibility,
      fetchStats: vi.fn().mockResolvedValue(statsFixture),
      openEventSource: () => { const source = new FakeSource(); sources.push(source); return source; },
      schedule: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
      cancel: vi.fn(),
      random: () => 0,
      onSnapshot
    });

    await controller.start();
    sources[0].emit('snapshot', { stats: { ...statsFixture, marker: 1 } });
    sources[0].emit('stats', { stats: { ...statsFixture, marker: 2 } });
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ marker: 2 }), 'stream');

    sources[0].onerror?.();
    expect(sources[0].closed).toBe(true);
    expect(timers[0].delay).toBe(1_000);
    timers[0].callback();
    expect(sources).toHaveLength(2);
    expect(retryDelayMs(10, () => 0)).toBe(30_000);
    controller.stop();
  });

  it('ignores a late error from a stream already closed by visibility', async () => {
    const visibility = new FakeVisibility();
    const sources: FakeSource[] = [];
    const controller = createLiveStats({
      visibility,
      fetchStats: vi.fn().mockResolvedValue(statsFixture),
      openEventSource: () => { const source = new FakeSource(); sources.push(source); return source; },
      onSnapshot: vi.fn()
    });

    await controller.start();
    visibility.set('hidden');
    visibility.set('visible');
    sources[0].onerror?.();

    expect(sources[1].closed).toBe(false);
    controller.stop();
  });

  it('does not open a stream before the initial fetch settles after becoming visible', async () => {
    const visibility = new FakeVisibility();
    visibility.visibilityState = 'hidden';
    let resolveFetch: ((value: typeof statsFixture) => void) | undefined;
    const fetchStats = vi.fn(() => new Promise<typeof statsFixture>((resolve) => { resolveFetch = resolve; }));
    const sources: FakeSource[] = [];
    const controller = createLiveStats({
      visibility,
      fetchStats,
      openEventSource: () => { const source = new FakeSource(); sources.push(source); return source; },
      onSnapshot: vi.fn()
    });

    const starting = controller.start();
    visibility.set('visible');
    expect(sources).toHaveLength(0);
    resolveFetch?.(statsFixture);
    await starting;
    expect(sources).toHaveLength(1);
    controller.stop();
  });
});

it('ignores a pending fetch from an earlier start, including its cleanup', async () => {
  const resolvers: Array<(value: typeof statsFixture) => void> = [];
  const onSnapshot = vi.fn(); const openEventSource = vi.fn(() => new FakeSource());
  const controller = createLiveStats({ visibility: new FakeVisibility(), fetchStats: () => new Promise(resolve => resolvers.push(resolve)), openEventSource, onSnapshot });
  const first = controller.start(); controller.stop(); const second = controller.start();
  resolvers[0]({ ...statsFixture, marker: 'stale' }); await first;
  expect(onSnapshot).not.toHaveBeenCalled(); expect(openEventSource).not.toHaveBeenCalled();
  resolvers[1](statsFixture); await second;
  expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(statsFixture, 'fetch'); expect(openEventSource).toHaveBeenCalledOnce();
  controller.stop();
});
