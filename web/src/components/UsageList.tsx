import { usePreferences } from '../preferences';
import { PagedList } from './PagedList';
import { formatTokens, type UsageRow } from '../data/stats';
import { Panel } from './Panel';

function friendlyName(value: string): string {
  const clients: Record<string, string> = { openclaw: 'OpenClaw', codex: 'Codex', hermes: 'Hermes' };
  return clients[value] || value
    .replace(/^claude-/, 'Claude ')
    .replace(/^gpt-/, 'GPT ')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function UsageList({ title, rows, emptyText }: { title: string; rows: UsageRow[]; emptyText: string }) {
  const {t} = usePreferences();
  return (
    <Panel title={title}>
      {rows.length === 0 ? <p class="empty">{t(emptyText)}</p> : (
        <PagedList className="usage-list" label={`${title}列表`}>
          {rows.map((row) => (
            <article class="usage-row" key={row.id}>
              <div class="usage-row__top">
                <span class="usage-row__name">{friendlyName(row.id)}</span>
                <strong>{formatTokens(row.total)}</strong>
              </div>
              {(row.input !== null || row.output !== null) && <div class="usage-row__split">
                {row.input !== null && <span><i class="dot dot--in" />{t('输入')} {formatTokens(row.input)}</span>}
                {row.output !== null && <span><i class="dot dot--out" />{t('输出')} {formatTokens(row.output)}</span>}
              </div>}
            </article>
          ))}
        </PagedList>
      )}
    </Panel>
  );
}
