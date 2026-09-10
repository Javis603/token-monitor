import { usePreferences } from '../preferences';
import { useState } from 'preact/hooks';
import type { VNode } from 'preact';

export function PagedList({ children, className, label }: { children: VNode[]; className: string; label: string }) {
  const {t} = usePreferences();
  const [page, setPage] = useState(0);
  const size = 6;
  const pages = Math.ceil(children.length / size);
  const current = Math.min(page, Math.max(0, pages - 1));
  return <>
    <div class={className} aria-label={t(label)}>{children.slice(current * size, (current + 1) * size)}</div>
    {pages > 1 && <nav class="list-pagination" aria-label={t(`${label}分页`)}>
      <span aria-live="polite">{current * size + 1}–{Math.min((current + 1) * size, children.length)} / {children.length}</span>
      <div>
        <button type="button" disabled={current === 0} aria-label={t(`${label}上一页`)} onClick={() => setPage(current - 1)}>{t('上一页')}</button>
        <button type="button" disabled={current === pages - 1} aria-label={t(`${label}下一页`)} onClick={() => setPage(current + 1)}>{t('下一页')}</button>
      </div>
    </nav>}
  </>;
}
