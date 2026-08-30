'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CODEX_RESET_FORECAST_PAGE_URL,
  createCodexResetForecastClient,
  normalizeCodexResetForecast
} = require('../../src/electron/codexResetForecast');

test('normalizes an active camel-case reset watch', () => {
  const result = normalizeCodexResetForecast({
    latestReset: { occurredAt: '2026-08-29T20:43:00Z' },
    activeWatch: {
      active: true,
      probability: 0.75,
      validUntil: '2026-08-31T07:00:00Z',
      observedAt: '2026-08-30T03:00:00Z',
      source: {
        author: '@thsottiaux',
        text: 'This content must not cross into the renderer.',
        createdAt: '2026-08-30T02:30:00Z'
      }
    }
  }, { checkedAt: '2026-08-30T04:00:00Z' });

  assert.deepEqual(result, {
    status: 'active',
    chancePercent: 75,
    predictedAt: '',
    expiresAt: '2026-08-31T07:00:00.000Z',
    observedAt: '2026-08-30T02:30:00.000Z',
    sourceAuthor: '@thsottiaux',
    latestResetAt: '2026-08-29T20:43:00.000Z',
    checkedAt: '2026-08-30T04:00:00Z',
    pageUrl: CODEX_RESET_FORECAST_PAGE_URL
  });
});

test('normalizes snake-case latest reset timestamps without retaining post content', () => {
  const result = normalizeCodexResetForecast({
    data: {
      latest_reset: { announced_at: '2026-08-29T20:43:00Z' },
      active_watch: {
        active: true,
        probability: 89,
        source: { handle: '@thsottiaux', content: 'Long third-party post.' }
      }
    }
  });

  assert.equal(result.latestResetAt, '2026-08-29T20:43:00.000Z');
  assert.equal(result.sourceAuthor, '@thsottiaux');
  assert.equal(Object.hasOwn(result, 'sourceText'), false);
});

test('normalizes the public codex-resets v1 status schema', () => {
  const result = normalizeCodexResetForecast({
    data: {
      latest_reset: {
        announced_at: '2026-08-29T20:43:34.000Z',
        source: { author: 'thsottiaux' }
      },
      active_watch: {
        level: 'strong',
        reset_chance_percent: 75,
        forecast_window: 'by end of sunday',
        observed_at: '2026-08-29T21:23:38.000Z',
        expires_at: '2026-08-31T07:00:00.000Z',
        source: { author: 'thsottiaux' }
      }
    }
  }, { checkedAt: '2026-08-30T03:36:45.139Z' });

  assert.equal(result.status, 'active');
  assert.equal(result.chancePercent, 75);
  assert.equal(result.predictedAt, '');
  assert.equal(result.expiresAt, '2026-08-31T07:00:00.000Z');
  assert.equal(result.observedAt, '2026-08-29T21:23:38.000Z');
  assert.equal(result.sourceAuthor, 'thsottiaux');
  assert.equal(result.latestResetAt, '2026-08-29T20:43:34.000Z');
});

test('accepts snake-case forecast fields and clamps percentages', () => {
  const result = normalizeCodexResetForecast({
    data: {
      active_watch: {
        is_active: true,
        forecast: {
          probability_percent: 120,
          expected_at: '2026-08-31T07:00:00Z'
        }
      }
    }
  });

  assert.equal(result.status, 'active');
  assert.equal(result.chancePercent, 100);
  assert.equal(result.predictedAt, '2026-08-31T07:00:00.000Z');
  assert.equal(result.expiresAt, '');
});

test('keeps a forecast expiry separate from an expected reset time', () => {
  const result = normalizeCodexResetForecast({
    active_watch: {
      active: true,
      expires_at: '2026-08-31T07:00:00Z'
    }
  });

  assert.equal(result.predictedAt, '');
  assert.equal(result.expiresAt, '2026-08-31T07:00:00.000Z');
});

test('returns inactive for an explicit closed watch', () => {
  const result = normalizeCodexResetForecast({ active_watch: { active: false } });
  assert.equal(result.status, 'inactive');
  assert.equal(result.chancePercent, null);
});

test('fails closed when an object does not match a recognized forecast schema', () => {
  assert.equal(normalizeCodexResetForecast({}).status, 'unavailable');
  assert.equal(normalizeCodexResetForecast({ ok: true }).status, 'unavailable');
  assert.equal(normalizeCodexResetForecast({ forecast: { probability: true } }).status, 'unavailable');
  assert.equal(normalizeCodexResetForecast({ forecast: { probability: ' ' } }).status, 'unavailable');
  assert.equal(normalizeCodexResetForecast({ forecast: { validUntil: true } }).status, 'unavailable');
});

test('accepts explicit numeric strings without coercing arbitrary values', () => {
  const result = normalizeCodexResetForecast({ forecast: { probability: '0.89' } });
  assert.equal(result.status, 'active');
  assert.equal(result.chancePercent, 89);
});

test('keeps recognized latest-reset metadata without inventing a forecast status', () => {
  const result = normalizeCodexResetForecast({ latest_reset_at: '2026-08-29T20:43:00Z' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.latestResetAt, '2026-08-29T20:43:00.000Z');
});

test('keeps an explicit active signal even when it has no percentage or date', () => {
  const result = normalizeCodexResetForecast({ active_watch: { active: true } });
  assert.equal(result.status, 'active');
  assert.equal(result.chancePercent, null);
});

test('client caches success and preserves it as stale after a later failure', async () => {
  let currentTime = Date.parse('2026-08-30T04:00:00Z');
  let calls = 0;
  const client = createCodexResetForecastClient({
    now: () => currentTime,
    cacheMs: 1000,
    errorCacheMs: 100,
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) throw new Error('offline');
      return {
        ok: true,
        json: async () => ({ forecast: { probability: 75, by: '2026-08-31T07:00:00Z' } })
      };
    }
  });

  const first = await client.getForecast();
  assert.equal(first.status, 'active');
  assert.equal((await client.getForecast()).chancePercent, 75);
  assert.equal(calls, 1);

  currentTime += 1001;
  const stale = await client.getForecast();
  assert.equal(stale.status, 'active');
  assert.equal(stale.stale, true);
  assert.equal(stale.error, 'offline');
});
