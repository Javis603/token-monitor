import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { beforeEach, expect, it, vi } from 'vitest';
import { LimitsPanel } from './LimitsPanel';
import { sanitizeStatsForOffline } from '../data/snapshot';
import type { HubStats } from '../data/types';

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
const stats: HubStats = { limits: { providers: [
  { provider: 'codex', accountKey: 'account-a', accountLabel: 'Personal', status: 'ok' },
  { provider: 'codex', accountKey: 'account-b', accountLabel: 'Work', status: 'ok' },
  { provider: 'deepseek', status: 'ok', balance: { amount: 10 } }
] } };

it('hides one account, survives refresh/reordering/offline redaction, and restores it', () => {
  const view = render(<LimitsPanel stats={stats} />);
  fireEvent.click(within(screen.getAllByRole('article')[1]).getByRole('button', { name: /隐藏/ }));
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(screen.getAllByRole('article').some(card => within(card).queryByText('Personal'))).toBe(false);
  view.unmount();
  render(<LimitsPanel stats={sanitizeStatsForOffline({ limits: { providers: [...stats.limits!.providers!].reverse() } })} />);
  expect(screen.getAllByRole('article')).toHaveLength(2);
  fireEvent.click(screen.getByText(/管理显示/));
  fireEvent.click(screen.getByRole('button', { name: '全部恢复' }));
  expect(screen.getAllByRole('article')).toHaveLength(3);
});

it('keeps recovery available when every card is hidden', () => {
  render(<LimitsPanel stats={{ limits: { providers: [stats.limits!.providers![0]] } }} />);
  fireEvent.click(screen.getByRole('button', { name: /隐藏/ }));
  expect(screen.queryAllByRole('article')).toHaveLength(0);
  expect(screen.getByText('所有项目均已隐藏')).toBeTruthy();
  fireEvent.click(screen.getByText(/管理显示/));
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getAllByRole('article')).toHaveLength(1);
});

it('works in memory when storage is blocked or malformed', () => {
  vi.stubGlobal('localStorage', { getItem: () => '{broken', setItem: () => { throw new Error('blocked'); } });
  render(<LimitsPanel stats={stats} />);
  fireEvent.click(within(screen.getAllByRole('article')[0]).getByRole('button', { name: /隐藏/ }));
  expect(screen.getAllByRole('article')).toHaveLength(2);
  cleanup();
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
  render(<LimitsPanel stats={stats} />);
  expect(screen.getAllByRole('article')).toHaveLength(3);
});


it('does not tie visibility to changing status, plan, or quota amounts', () => {
  const view = render(<LimitsPanel stats={stats} />);
  fireEvent.click(within(screen.getAllByRole('article')[1]).getByRole('button', { name: /隐藏/ }));
  view.rerender(<LimitsPanel stats={{ limits: { providers: [{ ...stats.limits!.providers![0], status: 'unauthorized', planLabel: 'New plan' }, stats.limits!.providers![1]] } }} />);
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(within(screen.getAllByRole('article')[0]).getByText('Work')).toBeTruthy();
});

it('treats indistinguishable anonymous rows as one recoverable group', () => {
  render(<LimitsPanel stats={{ limits: { providers: [{ provider: 'cursor', status: 'ok' }, { provider: 'cursor', status: 'error' }] } }} />);
  fireEvent.click(within(screen.getAllByRole('article')[0]).getByRole('button', { name: /隐藏/ }));
  expect(screen.queryAllByRole('article')).toHaveLength(0);
  fireEvent.click(screen.getByText(/管理显示/));
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getAllByRole('article')).toHaveLength(2);
});
