import { useEffect, useRef, useState } from 'preact/hooks';
import { DevicesPanel } from './components/DevicesPanel';
import { LimitsPanel } from './components/LimitsPanel';
import { CurrentSession, SessionsPanel } from './components/SessionsPanel';
import { UsageList } from './components/UsageList';
import { usePreferences, ViewControls } from './preferences';
import { createLiveStats, defaultFetchStats, type ConnectionStatus } from './data/liveStats';
import { loadOfflineSnapshot, saveOfflineSnapshot } from './data/snapshot';
import { deviceRows, formatTokens, periodFor, periodTokenSplit, recentSessions, usageRows } from './data/stats';
import type { HubStats, PeriodKey } from './data/types';

type SnapshotSource = 'network' | 'cache';

interface DashboardProps {
  stats: HubStats;
  connection: ConnectionStatus;
  source: SnapshotSource;
  savedAt: string;
}

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'month', label: '本月' },
  { key: 'allTime', label: '全部' }
];

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: '连接中',
  live: '实时',
  retrying: '重连中',
  offline: '离线',
  error: '异常'
};

function timestampLabel(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更新时间未知';
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric'
  }).format(date);
}

export function Dashboard({ stats, connection, source, savedAt }: DashboardProps) {
  const {t,locale,mode} = usePreferences();
  const [periodKey, setPeriodKey] = useState<PeriodKey>('today');
  const period = periodFor(stats, periodKey);
  // Activity is live context, independent of the selected aggregate period.
  const sessions = recentSessions(periodFor(stats, 'today'));
  const split = periodTokenSplit(period);

  return (
    <main class="shell">
      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <div class="brand-copy">
          <h1>Token Monitor</h1>
        </div>
        <div class={`connection connection--${connection}`}>
          {connection==='offline' || connection==='error' || connection==='retrying' || connection==='connecting' ? <a href="/auth/login">{t('重新登录')}</a> : null}
          <i />{t(source === 'cache' ? '离线快照' : mode === 'snapshot' && connection === 'live' ? '快照' : CONNECTION_LABEL[connection])}
        </div>
      </header>

      {source === 'cache' && (
        <aside class="offline-banner" role="status">
          <span>{t('离线快照')}</span>
          <p>{t('快照时间')} {timestampLabel(savedAt,locale)}</p>
        </aside>
      )}

      <div class="dashboard-toolbar"><nav class="period-switcher" aria-label={t('统计周期')}>
        {PERIODS.map(({ key, label }) => (
          <button
            type="button"
            key={key}
            class={periodKey === key ? 'is-active' : ''}
            aria-pressed={periodKey === key}
            onClick={() => setPeriodKey(key)}
          >{t(label)}</button>
        ))}
      </nav><ViewControls /></div>


      <section class="hero" aria-label={t('Token 用量摘要')}>
        <p class="eyebrow">{t('Token 用量')}</p>
        <div class="hero__number">{formatTokens(period.totalTokens)}</div>
        <p class="hero__timestamp">{t(mode === 'snapshot' ? '快照时间' : '更新')} · {timestampLabel(savedAt,locale)}</p>
        <div class="summary-grid">
          <div><span>{t('输入')}</span><strong>{split.input === null ? '—' : formatTokens(split.input)}</strong></div>
          <div><span>{t('输出')}</span><strong>{split.output === null ? '—' : formatTokens(split.output)}</strong></div>
          <div><span>{t('在线设备')}</span><strong>{stats.devices?.filter((device) => !device.stale).length ?? 0}<small>/{stats.devices?.length ?? 0}</small></strong></div>
        </div>
      </section>

      <LimitsPanel stats={stats} />

      <div class="dashboard-grid">
        <div class="layout-column layout-usage">
          <div class="layout-tools">
            <UsageList key={`clients-${periodKey}`} title="工具" rows={usageRows(period, 'clients')} emptyText="暂无工具用量" />
            <DevicesPanel devices={deviceRows(stats, periodKey)} />
          </div>
          <UsageList key={`models-${periodKey}`} title="模型" rows={usageRows(period, 'models')} emptyText="暂无模型用量" />
        </div>
        <div class="layout-column layout-activity">
          <CurrentSession session={sessions[0]} />
          <SessionsPanel sessions={sessions.slice(1)} />
        </div>
      </div>


    </main>
  );
}

export function App() {
  const {mode,refreshSerial,t} = usePreferences();
  const lastRefresh = useRef(refreshSerial);
  const [stats, setStats] = useState<HubStats | null>(null);
  const [source, setSource] = useState<SnapshotSource>('network');
  const [savedAt, setSavedAt] = useState('');
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const networkSeen = useRef(false);

  useEffect(() => {
    let active = true;
    void loadOfflineSnapshot().then((snapshot) => {
      if (!active || networkSeen.current || !snapshot) return;
      setStats(snapshot.stats);
      setSavedAt(snapshot.savedAt);
      setSource('cache');
      setConnection('offline');
    });

    if (mode === 'snapshot') {
      if (!stats || lastRefresh.current !== refreshSerial) {
        lastRefresh.current = refreshSerial;
        setConnection('connecting');
        void defaultFetchStats().then(next => {
          if (!active) return;
          networkSeen.current = true;
          const now = new Date().toISOString();
          setStats(next); setSavedAt(now); setSource('network'); setConnection('live');
          void saveOfflineSnapshot(next);
        }).catch(() => { if (active) setConnection('offline'); });
      }
      return () => { active = false; };
    }
    const live = createLiveStats({
      onSnapshot(nextStats) {
        if (!active) return;
        networkSeen.current = true;
        const now = new Date().toISOString();
        setStats(nextStats);
        setSavedAt(now);
        setSource('network');
        void saveOfflineSnapshot(nextStats);
      },
      onStatus(status) {
        if (active) setConnection(status);
      }
    });
    void live.start();
    return () => {
      active = false;
      live.stop();
    };
  }, [mode,refreshSerial]);

  if (!stats) {
    return (
      <main class="shell shell--centered">
        <div class="loading-mark"><span /><span /><span /></div>
        <h1>Token Monitor</h1>
        <ViewControls />
        {connection!=='live' && <a href="/auth/login">{t('重新登录')}</a>}
        <p>{t(connection === 'offline' ? '暂时无法连接 Hub，也没有可用的离线快照。' : '正在连接本地 gateway…')}</p>
      </main>
    );
  }
  return <Dashboard stats={stats} connection={connection} source={source} savedAt={savedAt} />;
}
