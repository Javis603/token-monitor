import { describe, expect, it, vi } from 'vitest';
import { statsFixture } from '../test/fixtures';
import { loadOfflineSnapshot, sanitizeStatsForOffline, saveOfflineSnapshot } from './snapshot';

describe('offline snapshot bridge', () => {
  it('sends a timestamped snapshot only to the service worker', async () => {
    const postMessage = vi.fn();
    await saveOfflineSnapshot(statsFixture, {
      now: () => new Date('2026-08-27T08:30:00.000Z'),
      serviceWorker: { ready: Promise.resolve({ active: { postMessage } }), controller: null }
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'SAVE_STATS_SNAPSHOT',
      payload: { savedAt: '2026-08-27T08:30:00.000Z', stats: sanitizeStatsForOffline(statsFixture) }
    });
  });

  it('drops unknown fields and account metadata from the persistent snapshot', () => {
    const input = {
      ...statsFixture,
      secretHealthDetail: 'must-not-persist',
      limits: { providers: [{
        ...statsFixture.limits?.providers?.[0],
        accountLabel: 'Private workspace',
        accountEmail: 'private@example.test',
        accountKey: 'sha256:private'
      }] },
      devices: [{
        ...statsFixture.devices?.[0],
        clientHealth: { diagnostics: 'private' }
      }]
    };
    const sanitized = sanitizeStatsForOffline(input);
    expect(sanitized).not.toHaveProperty('secretHealthDetail');
    expect(sanitized.limits?.providers?.[0]).not.toHaveProperty('accountLabel');
    expect(sanitized.limits?.providers?.[0]).not.toHaveProperty('accountEmail');
    expect(sanitized.devices?.[0]).not.toHaveProperty('clientHealth');
  });

  it('loads the explicit offline endpoint and rejects malformed snapshots', async () => {
    const valid = await loadOfflineSnapshot(vi.fn().mockResolvedValue(new Response(JSON.stringify({
      savedAt: '2026-08-27T08:30:00.000Z', stats: statsFixture
    }), { status: 200 })));
    expect(valid?.stats).toEqual(statsFixture);
    expect(await loadOfflineSnapshot(vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))).toBeNull();
  });
});
