import { usePreferences } from '../preferences';
import { PagedList } from './PagedList';
import { formatTokens, type SessionRow } from '../data/stats';
import { Panel } from './Panel';

const clientLabel = (value?: string) => ({ openclaw: 'OpenClaw', codex: 'Codex', hermes: 'Hermes', claude: 'Claude' }[value || ''] || value || '未知工具');

function relativeTime(value?: string): string {
  if (!value) return '时间未知';
  const milliseconds = Date.now() - Date.parse(value);
  if (!Number.isFinite(milliseconds)) return '时间未知';
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function CurrentSession({ session }: { session?: SessionRow }) {
  const {t} = usePreferences();
  return (
    <Panel title="最近活跃" className="panel--accent">
      {!session ? <p class="empty">{t('暂无会话')}</p> : (
        <div class="current-session">
          <div>
            <strong>{session.projectLabel || (session.client ? clientLabel(session.client) : t('未知工具'))}</strong>
            <p>{session.projectLabel && `${(session.client ? clientLabel(session.client) : t('未知工具'))} · `}{t(relativeTime(session.lastUsedAt))}</p>
          </div>
          <div class="current-session__usage">
            <span>{formatTokens(session.totalTokens)}</span>
            <small>tokens</small>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function SessionsPanel({ sessions }: { sessions: SessionRow[] }) {
  const {t} = usePreferences();
  return (
    <Panel title="近期会话">
      {sessions.length === 0 ? <p class="empty">{t('暂无其他会话')}</p> : (
        <PagedList className="session-list" label="近期会话列表">
          {sessions.map((session) => (
            <article class="session-row" key={session.id}>
              <div>
                <strong>{session.projectLabel || (session.client ? clientLabel(session.client) : t('未知工具'))}</strong>
                <p>{session.projectLabel && `${(session.client ? clientLabel(session.client) : t('未知工具'))} · `}{t(relativeTime(session.lastUsedAt))}</p>
              </div>
              <span>{formatTokens(session.totalTokens)}</span>
            </article>
          ))}
        </PagedList>
      )}
    </Panel>
  );
}
