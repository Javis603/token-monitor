import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { PagedList } from './PagedList';

it('makes every row reachable without an inner scrolling region', async () => {
  const user = userEvent.setup();
  render(<PagedList label="模型列表" className="usage-list">{Array.from({ length: 14 }, (_, i) => <article key={i}>模型 {i + 1}</article>)}</PagedList>);
  expect(screen.getByText('模型 6')).toBeTruthy();
  expect(screen.queryByText('模型 7')).toBeNull();
  await user.click(screen.getByRole('button', { name: '模型列表下一页' }));
  expect(screen.getByText('模型 7')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '模型列表下一页' }));
  expect(screen.getByText('模型 14')).toBeTruthy();
  expect((screen.getByRole('button', { name: '模型列表下一页' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: '模型列表上一页' }));
  expect(screen.getByText('模型 7')).toBeTruthy();
});
