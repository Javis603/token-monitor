import { usePreferences } from '../preferences';
import { PagedList } from './PagedList';
import { formatTokens, type DeviceRow } from '../data/stats';
import { Panel } from './Panel';

export function DevicesPanel({ devices }: { devices: DeviceRow[] }) {
  const {t} = usePreferences();
  return (
    <Panel title="设备">
      {devices.length === 0 ? <p class="empty">{t('暂无设备')}</p> : (
        <PagedList className="device-list" label="设备列表">
          {devices.map((device) => (
            <article class="device-row" key={device.id}>
              <div class={`device-icon ${device.stale ? 'device-icon--stale' : ''}`} aria-hidden="true">
                {device.name.slice(0, 1).toUpperCase()}
              </div>
              <div class="device-row__identity">
                <strong>{device.name}</strong>
                <p title={device.platform}>{device.platform || device.runtime || t('平台未知')}</p>
              </div>
              <div class="device-row__usage">
                <strong>{formatTokens(device.totalTokens)}</strong>
                <span class={device.stale ? 'device-state device-state--stale' : 'device-state'}>
                  {t(device.stale ? '未更新' : '在线')}
                </span>
              </div>
            </article>
          ))}
        </PagedList>
      )}
    </Panel>
  );
}
