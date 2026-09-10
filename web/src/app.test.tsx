import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dashboard } from './app';
import { statsFixture } from './test/fixtures';

describe('Overview dashboard', () => {
  it('renders summary, tools, models, limits, current session, and devices', () => {
    render(<Dashboard stats={statsFixture} connection="live" source="network" savedAt="2026-08-27T08:00:00.000Z" />);
    expect(screen.getByRole('heading', { name: 'Token Monitor' })).toBeTruthy();
    expect(screen.getByText('1.5K')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '最近活跃' })).toBeTruthy();
    expect(screen.getAllByText('Token Monitor Web')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '工具' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '模型' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '余额与额度' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '设备' })).toBeTruthy();
    expect(screen.getByText('workstation')).toBeTruthy();
    expect(screen.getByText('未更新')).toBeTruthy();
  });

  it('switches period locally without another request', async () => {
    const user = userEvent.setup();
    render(<Dashboard stats={statsFixture} connection="live" source="network" savedAt="2026-08-27T08:00:00.000Z" />);
    await user.click(screen.getByRole('button', { name: '本月' }));
    expect(screen.getByText('2.5M')).toBeTruthy();
  });

  it('clearly labels cached offline data', () => {
    render(<Dashboard stats={statsFixture} connection="offline" source="cache" savedAt="2026-08-27T08:00:00.000Z" />);
    expect(screen.getAllByText('离线快照')).toHaveLength(2);
  });
});

it('does not show deployment accounting tips below token usage', () => {
  vi.stubEnv('VITE_USAGE_OBSERVATIONS_SINCE', '2026-09-10T12:11:12+08:00');
  try {
    render(<Dashboard stats={statsFixture} connection="live" source="network" savedAt="2026-09-10T04:11:12Z" />);
    expect(screen.queryByText('部分数据')).toBeNull();
    expect(screen.queryByText('统计口径')).toBeNull();
  } finally { vi.unstubAllEnvs(); }
});
