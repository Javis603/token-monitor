import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
import { Dashboard } from './app';
import { translate, ViewControls } from './preferences';
import { CurrentSession } from './components/SessionsPanel';
import { isHubStats, recentSessions } from './data/stats';
import { sanitizeStatsForOffline } from './data/snapshot';
import { statsFixture } from './test/fixtures';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('keeps a login recovery link available while the stream retries', () => {
  render(<Dashboard stats={statsFixture} connection="retrying" source="network" savedAt="2026-09-10T09:00:00Z" />);
  expect(screen.getByRole('link', { name: '重新登录' }).getAttribute('href')).toBe('/auth/login');
});
it('returns strings for inherited object names', () => {
  for (const name of ['constructor', 'toString', '__proto__']) expect(translate(name, 'en')).toBe(name);
});
it.each([
  { periods: {}, devices: [null] },
  { periods: { today: { sessions: { broken: null } } }, devices: [] },
  { periods: {}, devices: [{ hostname: 42 }] },
  { periods: {}, devices: [], limits: { providers: [null] } },
  { periods: {}, devices: [], limits: { providers: [{ windows: [null] }] } },
  { periods: {}, devices: [], limits: { providers: [{ provider: 42 }] } }
])('rejects malformed nested stats: %j', value => expect(isHubStats(value)).toBe(false));
it('keeps the same recent sessions when persisting a snapshot', () => {
  const sessions = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, { totalTokens: i, ...(i ? { lastUsedAt: `2026-09-10T09:00:0${i}Z` } : {}) }]));
  const stats = { periods: { today: { sessions } }, devices: [] };
  expect(recentSessions(sanitizeStatsForOffline(stats).periods!.today!).map(x => x.id)).toEqual(recentSessions(stats.periods.today).map(x => x.id));
});
it('advances session age without stats events and cleans up its timer', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-10T09:00:00Z'));
  const view = render(<CurrentSession session={{ id: 'test', totalTokens: 0, lastUsedAt: new Date().toISOString() }} />);
  expect(screen.getByText('刚刚')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(screen.getByText('1 分钟前')).toBeTruthy();
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])('clears offline data even when network logout fails (%s)', async offline => {
  vi.stubGlobal('fetch', offline ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue(new Response('', { status: 500 })));
  const remove = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('caches', { keys: async () => ['token-monitor-static-v19', 'token-monitor-snapshot-v2', 'other-app'], delete: remove });
  const unregister = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ unregister }) } });
  render(<ViewControls />); fireEvent.click(screen.getByRole('button', { name: '退出登录', hidden: true }));
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
  expect(remove).not.toHaveBeenCalledWith('other-app');
  expect(unregister).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert')).toBeTruthy();
});

it('renders prototype-named provider, window and session labels as text', () => {
  const stats = { periods: { today: { sessions: { one: { client: 'constructor' } } } }, devices: [],
    limits: { providers: [{ provider: 'constructor', status: 'toString', windows: [{ label: '__proto__' }] }] } };
  expect(isHubStats(stats)).toBe(true);
  render(<Dashboard stats={stats} connection="live" source="network" savedAt="2026-09-10T09:00:00Z" />);
  expect(screen.getAllByText('constructor').length).toBeGreaterThan(0);
});
