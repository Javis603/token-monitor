import { render, screen, within } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { LimitsPanel } from './LimitsPanel';
import { sanitizeStatsForOffline } from '../data/snapshot';
import type { HubStats } from '../data/types';

const balances = { limits: { providers: [
  { provider: 'deepseek', status: 'ok', windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 0, currency: 'CNY', showMeter: false }], balance: { amount: 0, currency: 'CNY', todaySpend: 1.25 } },
  { provider: 'openrouter', status: 'ok', windows: [], balance: { amount: null, currency: 'USD', todaySpend: 0 } }
] } } as HubStats;

describe('quota and balance display', () => {
  it('shows a zero balance as money without inventing a percentage, and keeps unknown balance unknown', () => {
    render(<LimitsPanel stats={balances} />);
    const cards = screen.getAllByRole('article');
    expect(within(cards[0]).getByText('CNY 0.00')).toBeTruthy();
    expect(within(cards[0]).getByText('CNY 1.25')).toBeTruthy();
    expect(within(cards[0]).queryByRole('progressbar', { hidden: true })).toBeNull();
    expect(within(cards[1]).getByText('暂不可用')).toBeTruthy();
    expect(within(cards[1]).getByText('USD 0.00')).toBeTruthy();
  });

  it('shows quota remaining, absolute usage, reset time and reset credits while preserving stale status', () => {
    render(<LimitsPanel stats={{ limits: { providers: [{
      provider: 'codex', status: 'ok', stale: true,
      windows: [{ kind: 'session', usedPercent: 25, used: 250, limit: 1000, remaining: 750, resetsAt: '2026-09-10T06:00:00Z' }],
      resetCredits: { availableCount: 2, nextExpiresAt: '2026-09-11T06:00:00Z' }
    }] } } as HubStats} />);
    expect(screen.getByText('剩余 75%')).toBeTruthy();
    expect(screen.getByText('已用 250 / 1,000')).toBeTruthy();
    expect(screen.getByText('剩余 750')).toBeTruthy();
    expect(screen.getByText('可用重置')).toBeTruthy();
    expect(screen.getByText('未更新')).toBeTruthy();
    expect(document.querySelector('time[datetime="2026-09-10T06:00:00Z"]')).toBeTruthy();
    expect(document.querySelector('time[datetime="2026-09-11T06:00:00Z"]')).toBeTruthy();
  });

  it('does not draw a zero-percent meter for unknown quota', () => {
    render(<LimitsPanel stats={{ limits: { providers: [{ provider: 'volcengine', windows: [{ kind: 'weekly' }] }] } }} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('余量未知')).toBeTruthy();
  });

  it('distinguishes key limits from account credits and uses currency for both', () => {
    render(<LimitsPanel stats={{ limits: { providers: [{ provider: 'openrouter', status: 'ok',
      balance: { amount: 75, currency: 'USD' }, windows: [
        { kind: 'billing', label: 'API key limit', used: 2, limit: 10, remaining: 8, usedPercent: 20 },
        { kind: 'billing', metric: 'credits', label: 'Credits', used: 25, limit: 100, remaining: 75, usedPercent: 25 }
      ]
    }] } }} />);
    expect(screen.getByText('API Key 限额')).toBeTruthy();
    expect(screen.getByText('USD 8.00')).toBeTruthy();
    expect(screen.getByText('已用 USD 2.00 / USD 10.00')).toBeTruthy();
    expect(screen.getAllByRole('progressbar', { hidden: true })).toHaveLength(1);
    expect(screen.queryByText('账户额度')).toBeNull();
  });

  it.each([false, true])('keeps account balance and real limits without irrelevant Management key spend, offline=%s', (offline) => {
    const stats: HubStats = { limits: { providers: [{ provider: 'openrouter', status: 'ok', planLabel: 'Management',
      balance: { amount: 75, currency: 'USD', todaySpend: 0, monthSpend: 0, allTimeSpend: 0 },
      windows: [
        { kind: 'billing', label: 'API key limit', usedPercent: 0, remaining: 20, limit: 20 },
        { kind: 'billing', metric: 'credits', label: 'Credits', usedPercent: 25, remaining: 75, limit: 100 }
      ]
    }] } };
    render(<LimitsPanel stats={offline ? sanitizeStatsForOffline(stats) : stats} />);
    expect(screen.getAllByText('USD 75.00')).toHaveLength(1);
    expect(screen.queryByText('此 Key 消费')).toBeNull();
    expect(screen.queryByText('账户额度')).toBeNull();
    expect(screen.getByText('API Key 限额')).toBeTruthy();
    expect(screen.getAllByRole('progressbar', { hidden: true })).toHaveLength(1);
  });

  it('renders legacy balance-only windows and preserves numeric Agent Plan quotas without a meter', () => {
    render(<LimitsPanel stats={{ limits: { providers: [
      { provider: 'deepseek', windows: [{ kind: 'billing', metric: 'credits', remaining: 12.34, currency: 'USD' }] },
      { provider: 'agent-plan', windows: [{ kind: 'weekly', label: 'Weekly AFP', used: 5, limit: 20, remaining: 15, usedPercent: 25, showMeter: false }] }
    ] } }} />);
    expect(screen.getByText('USD 12.34')).toBeTruthy();
    expect(screen.getByText('已用 5 / 20')).toBeTruthy();
    expect(screen.getByText('剩余 15')).toBeTruthy();
    expect(screen.queryByRole('progressbar', { hidden: true })).toBeNull();
  });

  it('keeps balances through offline sanitization but drops nested unknown fields', () => {
    const source = structuredClone(balances);
    Object.assign(source.limits!.providers![0].balance!, { secret: 'discard-me' });
    const snapshot = sanitizeStatsForOffline(source);
    expect(snapshot.limits?.providers?.[0].balance).toEqual({ amount: 0, currency: 'CNY', todaySpend: 1.25 });
    expect(snapshot.limits?.providers?.[0].windows?.[0]).toMatchObject({ remaining: 0, currency: 'CNY', metric: 'credits' });
    render(<LimitsPanel stats={snapshot} />);
    expect(screen.getByText('CNY 0.00')).toBeTruthy();
  });
});

it('hides unconfigured and disabled providers, but retains configured failures and stale data', () => {
  render(<LimitsPanel stats={{ limits: { providers: [
    { provider: 'deepseek', status: 'notConfigured' },
    { provider: 'openrouter', status: 'disabled' },
    { provider: 'codex', status: 'unauthorized' },
    { provider: 'agent-plan', status: 'stale' }
  ] } }} />);
  expect(screen.queryByText('DeepSeek')).toBeNull();
  expect(screen.queryByText('OpenRouter')).toBeNull();
  expect(screen.getByText('需要重新授权')).toBeTruthy();
  expect(screen.getByText('未更新')).toBeTruthy();
});

it('labels DeepSeek estimates without ratio math or explanatory paragraphs', () => {
  render(<LimitsPanel stats={{ limits: { providers: [{ provider: 'deepseek', status: 'ok',
    balance: { amount: 75, currency: 'USD', todaySpend: 0, weekSpend: 10, monthSpend: 25, allTimeSpend: 40 }
  }] } }} />);
  expect(screen.queryByRole('progressbar', { hidden: true })).toBeNull();
  expect(screen.getByText('USD 25.00')).toBeTruthy();
  expect(screen.getByText('消费估算')).toBeTruthy();
  expect(screen.queryByText('账户额度')).toBeNull();
});

it('does not invent an explanation drawer for Management balances', () => {
  render(<LimitsPanel stats={{ limits: { providers: [{ provider: 'openrouter', status: 'ok', planLabel: 'Management',
    balance: { amount: 37.6543, currency: 'USD', todaySpend: 0 },
    windows: [{ metric: 'credits', usedPercent: 96, remaining: 37.6543 }]
  }] } }} />);
  expect(screen.getByText('USD 37.65')).toBeTruthy();
  expect(document.querySelector('.limit-card details')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByText(/Management Key/)).toBeNull();
  expect(screen.queryByText(/累计 Credits/)).toBeNull();
});
it('distinguishes Spark five-hour and weekly windows without discarding either', () => {
  render(<LimitsPanel stats={{ limits: { providers: [{ provider: 'codex', status: 'ok', windows: [
    { label: 'GPT-5.3-Codex-Spark', kind: 'session', windowMinutes: 300, usedPercent: 0 },
    { label: 'GPT-5.3-Codex-Spark', kind: 'weekly', windowMinutes: 10080, usedPercent: 10 }
  ] }] } }} />);
  expect(screen.getByText('Spark · 5 小时')).toBeTruthy();
  expect(screen.getByText('Spark · 每周')).toBeTruthy();
  expect(document.querySelector<HTMLDetailsElement>('.spark-details')?.open).toBe(false);
  expect(screen.getAllByRole('progressbar').every(el => el.closest('details') !== null)).toBe(true);
});

it('retains actionable errors and update time without repeating stale-data prose', () => {
  render(<LimitsPanel stats={{ limits: { providers: [{ provider: 'deepseek', status: 'unauthorized', stale: true,
    updatedAt: '2026-09-10T04:00:00Z', balance: { amount: 20, currency: 'CNY' }
  }] } }} />);
  expect(screen.getByText('需要重新授权')).toBeTruthy();
  expect(screen.queryByText('上次成功数据')).toBeNull();
  expect(document.querySelector('time[datetime="2026-09-10T04:00:00Z"]')).toBeTruthy();
});
