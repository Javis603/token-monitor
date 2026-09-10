import PROVIDER_NAMES from 'virtual:provider-labels';
import { usePreferences } from '../preferences';
import { limitRows, type LimitRow } from '../data/stats';
import type { HubStats, LimitBalance } from '../data/types';

const STATUS_LABELS: Record<string, string> = {
  ok: '正常', stale: '未更新', unauthorized: '需要重新授权',
  notConfigured: '未配置', unavailable: '不可用', error: '更新失败',
  disabled: '已停用', rateLimited: '额度受限', sourceRateLimited: '查询受限'
};
const WINDOW_LABELS: Record<string, string> = {
  '5-hour': '5 小时', Daily: '每日', session: '当前周期', weekly: '每周', billing: '账期',
  Balance: '余额', Credits: '账户额度', Weekly: '每周', Monthly: '每月',
  'Daily limit': '每日限额', 'Weekly limit': '每周限额',
  'Monthly limit': '每月限额', 'API key limit': 'API Key 限额'
};

function ownLabel(labels: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(labels, key) ? labels[key] : undefined;
}

function known(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatAmount(value: number, currency?: string | null): string {
  const amount = value.toLocaleString('en-US', {
    minimumFractionDigits: currency ? 2 : 0, maximumFractionDigits: currency ? 2 : 3
  });
  return currency ? `${currency} ${amount}` : amount;
}

function Timestamp({ label, value }: { label: string; value?: string | null }) {
  const {t,locale} = usePreferences();
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return <p class="limit-card__note">{t(label)} <time dateTime={value} title={new Date(value).toLocaleString(locale)}>{new Date(value).toLocaleString(locale, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })}</time></p>;
}

function BalanceDetails({ balance, row }: { balance: LimitBalance; row: LimitRow }) {
  const {t} = usePreferences();
  const management = row.provider === 'openrouter' && row.planLabel?.trim().toLowerCase() === 'management';
  const spend = (management ? [] : [
    ['今日', balance.todaySpend], ['本周', balance.weekSpend],
    ['本月', balance.monthSpend], ['累计', balance.allTimeSpend]
  ]).filter((entry): entry is [string, number] => typeof entry[0] === 'string' && known(entry[1]));
  const title = row.provider === 'deepseek' ? '消费估算' : row.provider === 'openrouter' ? '此 Key 消费' : '消费';
  return <>
    <div class="limit-balance">
      <span>{t('账户余额')}</span>
      <strong>{known(balance.amount) ? formatAmount(balance.amount, balance.currency) : t('暂不可用')}</strong>
    </div>
    {spend.length > 0 && <details class="limit-details">
      <summary>{t(title)}</summary>
      <dl class="limit-spend">
        {spend.map(([label, amount]) => <div key={t(label)}><dt>{t(label)}</dt><dd>{formatAmount(amount, balance.currency)}</dd></div>)}
      </dl>
    </details>}
  </>;
}

type WindowRow = LimitRow['windows'][number];

function windowLabel(window: WindowRow, provider: string) {
  let label = ownLabel(WINDOW_LABELS, window.label || '') || window.label || ownLabel(WINDOW_LABELS, window.kind || '') || '额度';
  if (provider === 'Codex' && window.label && !ownLabel(WINDOW_LABELS, window.label) && !Object.values(WINDOW_LABELS).includes(window.label)) {
    const title = window.label === 'GPT-5.3-Codex-Spark' ? 'Spark' : window.label === 'gpt-reserve' ? 'Luna Reserve' : label;
    const period = window.kind === 'weekly' ? '每周' : window.windowMinutes === 300 ? '5 小时' : ownLabel(WINDOW_LABELS, window.kind || '');
    label = period ? `${title} · ${period}` : title;
  }
  return label;
}

function QuotaWindow({ window, provider, currency, compact = false }: { window: WindowRow; provider: string; currency?: string | null; compact?: boolean }) {
  const {t} = usePreferences();
  const label = windowLabel(window, provider);
  const isMoney = window.metric === 'credits' || Boolean(window.currency) || provider === 'OpenRouter';
  const unit = window.currency || (isMoney ? currency : null);
  const usedPercent = window.usedPercent;
  const remaining = known(window.remaining) ? window.remaining : null;
  let headline = '余量未知';
  if (isMoney && remaining !== null) headline = formatAmount(remaining, unit);
  else if (usedPercent !== null) headline = `剩余 ${Number((100 - usedPercent).toFixed(1))}%`;
  else if (remaining !== null) headline = `剩余 ${formatAmount(remaining)}`;
  const details: string[] = [];
  if (known(window.used)) {
    const total = known(window.limit) ? ` / ${formatAmount(window.limit, unit)}` : '';
    details.push(`已用 ${formatAmount(window.used, unit)}${total}`);
  } else if (known(window.limit)) details.push(`总额 ${formatAmount(window.limit, unit)}`);
  if (!isMoney && remaining !== null) details.push(`剩余 ${formatAmount(remaining)}`);
  return <div class="limit-window">
    <div class="limit-window__labels"><span>{t(label)}</span><strong>{t(headline)}</strong></div>
    {window.showMeter !== false && usedPercent !== null && <progress max="100" value={100 - usedPercent}
      aria-label={`${provider} ${t(label)} ${t('剩余')}`} />}
    {!compact && details.length > 0 && <div class="limit-card__note limit-amounts">{details.map(detail => <span key={t(detail)}>{t(detail)}</span>)}</div>}
    <Timestamp label="重置" value={window.resetsAt} />
    {window.resetDescription && <p class="limit-card__note">{window.resetDescription}</p>}
    {window.detail && <p class="limit-card__note">{window.detail}</p>}
  </div>;
}

function ProviderCard({ row }: { row: LimitRow }) {
  const {t} = usePreferences();
  const name = ownLabel(PROVIDER_NAMES, row.provider) || row.provider.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  // Older payloads may carry only a credits window, without a balance object.
  const creditWindow = row.windows.find((window) => window.metric === 'credits'
    || (row.provider === 'openrouter' && !window.metric && window.label === 'Credits'));
  const balance = row.balance || (creditWindow ? {
    amount: creditWindow.remaining, currency: creditWindow.currency
  } : null);
  // Credits are the account balance, not a second subscription/key quota.
  const windows = row.provider === 'deepseek' ? [] : row.windows.filter((window) => {
    if (row.provider === 'openrouter' && window === creditWindow) return false;
    return !(balance && window === creditWindow && window.usedPercent === null
      && !window.resetsAt && !known(window.used) && !known(window.limit));
  });
  const spark = row.provider === 'codex' ? windows.filter(w => w.label === 'GPT-5.3-Codex-Spark') : [];
  const primary = windows.filter(w => !spark.includes(w));
  const count = row.resetCredits?.availableCount;
  const status = row.status !== 'ok' && row.status !== 'stale' ? row.status : row.stale || row.status === 'stale' ? 'stale' : 'ok';
  const plan = ['Management', 'Pay-as-you-go'].includes(row.planLabel || '') ? null : row.planLabel;
  return <article class="limit-card">
    <div class="limit-card__header">
      <div class="limit-card__identity"><strong>{t(name)}</strong>
        <span class="muted">{[['environment', 'Pay-as-you-go'].includes(row.accountLabel || '') ? null : row.accountLabel,
          plan !== row.accountLabel ? plan : null].filter(Boolean).join(' · ')}</span>
      </div>
      <div class="limit-card__state">
        <span class={`status-label status-label--${row.status === 'ok' && !row.stale ? 'ok' : 'warn'}`}>
          {t(ownLabel(STATUS_LABELS, status) ?? '未知状态')}
        </span>
        <Timestamp label="更新" value={row.updatedAt} />
      </div>
    </div>
    {balance && <BalanceDetails balance={balance} row={row} />}
    {balance && primary.length > 0 ? <details class="limit-details"><summary>{t('额度明细')}</summary>
      {primary.map((window, index) => <QuotaWindow key={index} window={window} provider={t(name)} currency={balance.currency} />)}
    </details> : <>
      <div class="quota-windows">{primary.map((window, index) => <QuotaWindow key={index} window={window} provider={t(name)} compact />)}</div>
      {primary.some(window => known(window.used) || known(window.limit)) && <details class="limit-details"><summary>{t('用量明细')}</summary>
        <dl class="quota-details">{primary.map((window, index) => <div key={index}>
          <dt>{t(windowLabel(window, name))}</dt>
          <dd>{known(window.used) ? `${t('已用')} ${formatAmount(window.used)}` : t('已用未知')}{known(window.limit) ? ` / ${formatAmount(window.limit)}` : ''}
            {known(window.remaining) && <span>{t('剩余')} {formatAmount(window.remaining)}</span>}</dd>
        </div>)}</dl>
      </details>}
    </>}
    {spark.length > 0 && <details class="limit-details spark-details"><summary>{t('Spark 额度')}</summary>
      {spark.map((window, index) => <QuotaWindow key={index} window={window} provider={t(name)} />)}
    </details>}
    {!balance && windows.length === 0 && <p class="limit-card__note">{t('暂无额度数据')}</p>}
    {known(count) && <div class="limit-reset"><span>{t('可用重置 ')}<strong>{count}</strong></span>
      <Timestamp label="到期" value={row.resetCredits?.nextExpiresAt} /></div>}
  </article>;
}

export function LimitsPanel({ stats }: { stats: HubStats }) {
  const {t} = usePreferences();
  const rows = limitRows(stats).filter((row) => !['notConfigured', 'disabled'].includes(row.status));
  const balances = rows.filter(row => row.balance || row.windows.some(window => window.metric === 'credits'));
  const quotas = rows.filter(row => !balances.includes(row));
  return <section class="limits-section" aria-labelledby="limits-title">
    <header class="panel__header"><h2 id="limits-title">{t('余额与额度')}</h2></header>
    {rows.length === 0 ? <p class="empty">{t('暂无额度数据')}</p> : <>
      {balances.length > 0 && <div class="limits-list limits-list--balances" role="group" aria-label={t('账户余额')}>
        {balances.map((row, index) => <ProviderCard key={`${row.provider}-${index}`} row={row} />)}
      </div>}
      {quotas.length > 0 && <div class="limits-list limits-list--quotas" role="group" aria-label={t('订阅额度')}>
        {quotas.map((row, index) => <ProviderCard key={`${row.provider}-${index}`} row={row} />)}
      </div>}
    </>}
  </section>;
}
