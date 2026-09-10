import { describe, expect, it } from 'vitest';
import { statsFixture } from '../test/fixtures';
import {
  deviceRows,
  formatTokens,
  limitRows,
  periodFor,
  periodTokenSplit,
  recentSessions,
  usageRows
} from './stats';

describe('stats view model', () => {
  it('selects periods and formats compact token values', () => {
    expect(periodFor(statsFixture, 'month').totalTokens).toBe(2_500_000);
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_530)).toBe('1.5K');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  it('normalizes sorted tool and model input/output rows', () => {
    expect(usageRows(periodFor(statsFixture, 'today'), 'clients')[0]).toMatchObject({
      id: 'codex', total: 1_000, input: 400, output: 250
    });
    expect(usageRows(periodFor(statsFixture, 'today'), 'models')[1]).toMatchObject({
      id: 'claude-opus-4-8', total: 530, input: 230, output: 180
    });
    expect(usageRows(periodFor(statsFixture, 'month'), 'models')[0].input).toBe(2_000_000);
    expect(periodTokenSplit(periodFor(statsFixture, 'today'))).toEqual({ input: 630, output: 430 });
  });

  it('sorts sessions by most recent use', () => {
    expect(recentSessions(periodFor(statsFixture, 'today')).map((row) => row.id)).toEqual([
      'codex:recent', 'claude:older'
    ]);
  });

  it('normalizes limit windows from used or remaining percentages', () => {
    const rows = limitRows(statsFixture);
    expect(rows[0].windows.map((window) => window.usedPercent)).toEqual([32, 56]);
    expect(rows[1]).toMatchObject({ provider: 'claude', status: 'unauthorized' });
  });

  it('preserves Hub device freshness and period totals', () => {
    expect(deviceRows(statsFixture, 'today')).toEqual([
      expect.objectContaining({ id: 'workstation', stale: false, totalTokens: 1_000 }),
      expect.objectContaining({ id: 'laptop', stale: true, totalTokens: 530 })
    ]);
  });
});
it('orders recent activity ahead of undated high-volume sessions deterministically', () => {
  const rows = recentSessions({ sessions: {
    unknown: { client: 'hermes', totalTokens: 999999 },
    old: { client: 'hermes', lastUsedAt: '2026-09-10T01:00:00Z', totalTokens: 300 },
    live: { client: 'openclaw', lastUsedAt: '2026-09-10T04:30:00Z', totalTokens: 100 }
  } });
  expect(rows.map(r => r.id)).toEqual(['live', 'old', 'unknown']);
});
