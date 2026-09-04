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
    latestReset: { occurredAt: '2026-08-29T20:43:00Z', resetType: 'regular' },
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
    latestResetType: 'regular',
    checkedAt: '2026-08-30T04:00:00Z',
    pageUrl: CODEX_RESET_FORECAST_PAGE_URL
  });
});

test('normalizes snake-case latest reset timestamps without retaining post content', () => {
  const result = normalizeCodexResetForecast({
    data: {
      latest_reset: { announced_at: '2026-08-29T20:43:00Z', reset_type: 'banked' },
      active_watch: {
        active: true,
        probability_percent: 89,
        source: { handle: '@thsottiaux', content: 'Long third-party post.' }
      }
    }
  });

  assert.equal(result.latestResetAt, '2026-08-29T20:43:00.000Z');
  assert.equal(result.latestResetType, 'banked');
  assert.equal(result.sourceAuthor, '@thsottiaux');
  assert.equal(Object.hasOwn(result, 'sourceText'), false);
});

test('normalizes the public codex-resets v1 status schema', () => {
  const result = normalizeCodexResetForecast({
    data: {
      latest_reset: {
        announced_at: '2026-08-29T20:43:34.000Z',
        reset_type: 'banked',
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
  assert.equal(result.latestResetType, 'banked');
});

test('drops unknown reset types instead of exposing third-party values', () => {
  const result = normalizeCodexResetForecast({
    data: {
      latest_reset: {
        announced_at: '2026-08-29T20:43:34.000Z',
        reset_type: 'surprise<script>'
      },
      active_watch: null
    }
  });

  assert.equal(result.latestResetType, '');
});

test('treats the public active_watch null shape as no active signal', async () => {
  const payload = {
    data: {
      latest_reset: { announced_at: '2026-08-29T20:43:34.000Z' },
      active_watch: null
    }
  };
  const result = normalizeCodexResetForecast(payload, { checkedAt: '2026-08-30T04:00:00Z' });

  assert.equal(result.status, 'inactive');
  assert.equal(result.latestResetAt, '2026-08-29T20:43:34.000Z');

  const client = createCodexResetForecastClient({
    now: () => Date.parse('2026-08-30T04:00:00Z'),
    fetchImpl: async () => ({ ok: true, json: async () => payload })
  });
  const cached = await client.getForecast();
  assert.equal(cached.status, 'inactive');
  assert.equal(cached.error, undefined);
  assert.equal(cached.retryAfterMs, 15 * 60 * 1000);
});

test('keeps explicit percent fields distinct from ratio fields', () => {
  assert.equal(normalizeCodexResetForecast({ forecast: { reset_chance_percent: 1 } }).chancePercent, 1);
  assert.equal(normalizeCodexResetForecast({ forecast: { reset_chance_percent: 0.5 } }).chancePercent, 0.5);
  assert.equal(normalizeCodexResetForecast({ forecast: { probability: 0.75 } }).chancePercent, 75);
  assert.equal(normalizeCodexResetForecast({ forecast: { probability: 1 } }).chancePercent, 100);

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
  assert.equal(result.chancePercent, null);
  assert.equal(result.predictedAt, '2026-08-31T07:00:00.000Z');
  assert.equal(result.expiresAt, '');
  assert.equal(normalizeCodexResetForecast({ forecast: { reset_chance_percent: 120 } }).status, 'unavailable');
  assert.equal(normalizeCodexResetForecast({ forecast: { probability: 1.2 } }).status, 'unavailable');
});

test('keeps a forecast expiry separate from an expected reset time', () => {
  const result = normalizeCodexResetForecast({
    active_watch: {
      active: true,
      expires_at: '2026-08-31T07:00:00Z'
    }
  }, { checkedAt: '2026-08-30T04:00:00Z' });

  assert.equal(result.predictedAt, '');
  assert.equal(result.expiresAt, '2026-08-31T07:00:00.000Z');
});

test('treats an expired forecast as inactive at the expiry boundary', () => {
  const payload = {
    active_watch: {
      active: true,
      reset_chance_percent: 75,
      observed_at: '2026-08-30T03:00:00Z',
      expires_at: '2026-08-30T04:00:00Z'
    }
  };

  assert.equal(normalizeCodexResetForecast(payload, { checkedAt: '2026-08-30T03:59:59.999Z' }).status, 'active');
  assert.equal(normalizeCodexResetForecast(payload, { checkedAt: '2026-08-30T04:00:00.000Z' }).status, 'inactive');
});

test('treats a watch observed before the latest reset as inactive', () => {
  const result = normalizeCodexResetForecast({
    data: {
      latest_reset: {
        announced_at: '2026-08-30T04:00:00Z',
        reset_type: 'regular'
      },
      active_watch: {
        active: true,
        reset_chance_percent: 75,
        observed_at: '2026-08-30T04:00:00Z',
        expires_at: '2026-08-30T05:00:00Z'
      }
    }
  }, { checkedAt: '2026-08-30T04:01:00Z' });

  assert.equal(result.status, 'inactive');
});

test('does not supersede an active watch with a later banked reset', () => {
  const result = normalizeCodexResetForecast({
    data: {
      latest_reset: {
        announced_at: '2026-08-30T04:00:00Z',
        reset_type: 'banked'
      },
      active_watch: {
        active: true,
        reset_chance_percent: 75,
        observed_at: '2026-08-30T03:00:00Z',
        expires_at: '2026-08-30T05:00:00Z'
      }
    }
  }, { checkedAt: '2026-08-30T04:01:00Z' });

  assert.equal(result.status, 'active');
});

test('keeps legacy supersession when a later reset type is unknown', () => {
  const result = normalizeCodexResetForecast({
    data: {
      latest_reset: {
        announced_at: '2026-08-30T04:00:00Z',
        reset_type: 'future-reset-type'
      },
      active_watch: {
        active: true,
        reset_chance_percent: 75,
        observed_at: '2026-08-30T03:00:00Z',
        expires_at: '2026-08-30T05:00:00Z'
      }
    }
  }, { checkedAt: '2026-08-30T04:01:00Z' });

  assert.equal(result.latestResetType, '');
  assert.equal(result.status, 'inactive');
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

test('client keeps successful forecasts for 15 minutes by default', async () => {
  let currentTime = Date.parse('2026-08-30T04:00:00Z');
  let calls = 0;
  const client = createCodexResetForecastClient({
    now: () => currentTime,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ forecast: { reset_chance_percent: 75 } })
      };
    }
  });

  await client.getForecast();
  currentTime += 5 * 60 * 1000;
  await client.getForecast();
  currentTime += 10 * 60 * 1000 - 1;
  await client.getForecast();
  assert.equal(calls, 1);

  currentTime += 1;
  await client.getForecast();
  assert.equal(calls, 2);
});

test('client refreshes when an active forecast expires before the default cache boundary', async () => {
  let currentTime = Date.parse('2026-08-30T04:00:00Z');
  let calls = 0;
  const client = createCodexResetForecastClient({
    now: () => currentTime,
    fetchImpl: async () => ({
      ok: true,
      json: async () => (++calls === 1
        ? {
            data: {
              active_watch: {
                active: true,
                reset_chance_percent: 75,
                observed_at: '2026-08-30T03:00:00Z',
                expires_at: '2026-08-30T04:01:00Z'
              }
            }
          }
        : { data: { active_watch: null } })
    })
  });

  const first = await client.getForecast();
  assert.equal(first.status, 'active');
  assert.equal(first.retryAfterMs, 60 * 1000);

  currentTime += 60 * 1000 - 1;
  assert.equal((await client.getForecast()).status, 'active');
  assert.equal(calls, 1);

  currentTime += 1;
  assert.equal((await client.getForecast()).status, 'inactive');
  assert.equal(calls, 2);
});

test('client evaluates validity when the response settles, not when the request starts', async () => {
  let currentTime = Date.parse('2026-08-30T04:00:00Z');
  const client = createCodexResetForecastClient({
    now: () => currentTime,
    fetchImpl: async () => {
      currentTime += 1000;
      return {
        ok: true,
        json: async () => ({
          data: {
            active_watch: {
              active: true,
              reset_chance_percent: 75,
              observed_at: '2026-08-30T03:00:00Z',
              expires_at: '2026-08-30T04:00:00.500Z'
            }
          }
        })
      };
    }
  });

  assert.equal((await client.getForecast()).status, 'inactive');
});

test('client rejects redirects at the fixed third-party network boundary', async () => {
  let requestInit = null;
  const client = createCodexResetForecastClient({
    fetchImpl: async (_url, init) => {
      requestInit = init;
      return { ok: true, json: async () => ({ data: { active_watch: null } }) };
    }
  });

  await client.getForecast();
  assert.equal(requestInit.redirect, 'error');
  assert.equal(requestInit.credentials, 'omit');
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
        json: async () => ({ forecast: { probability: 0.75, by: '2026-08-31T07:00:00Z' } })
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
  assert.equal(stale.errorKind, 'request');
  assert.equal(stale.retryAfterMs, 100);
});

test('client never keeps an expired last-good forecast active', async () => {
  let currentTime = Date.parse('2026-08-30T04:00:00Z');
  let calls = 0;
  const client = createCodexResetForecastClient({
    now: () => currentTime,
    errorCacheMs: 30 * 1000,
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) throw new Error('offline');
      return {
        ok: true,
        json: async () => ({
          data: {
            active_watch: {
              active: true,
              reset_chance_percent: 75,
              observed_at: '2026-08-30T03:00:00Z',
              expires_at: '2026-08-30T04:00:01Z'
            }
          }
        })
      };
    }
  });

  const first = await client.getForecast();
  assert.equal(first.retryAfterMs, 1000);

  currentTime += 500;
  const staleBeforeExpiry = await client.getForecast({ force: true });
  assert.equal(staleBeforeExpiry.status, 'active');
  assert.equal(staleBeforeExpiry.stale, true);
  assert.equal(staleBeforeExpiry.retryAfterMs, 500);

  currentTime += 500;
  const staleAtExpiry = await client.getForecast();
  assert.equal(staleAtExpiry.status, 'inactive');
  assert.equal(staleAtExpiry.stale, true);
  assert.equal(staleAtExpiry.retryAfterMs, 30 * 1000);
});

test('client treats an unrecognized successful response as a short-lived failure', async () => {
  let currentTime = Date.parse('2026-08-30T04:00:00Z');
  let calls = 0;
  const client = createCodexResetForecastClient({
    now: () => currentTime,
    cacheMs: 1000,
    errorCacheMs: 100,
    fetchImpl: async () => ({
      ok: true,
      json: async () => (++calls === 1
        ? { forecast: { reset_chance_percent: 75 } }
        : { ok: true })
    })
  });

  const first = await client.getForecast();
  assert.equal(first.status, 'active');
  assert.equal(first.retryAfterMs, 1000);

  currentTime += 1001;
  const stale = await client.getForecast();
  assert.equal(stale.status, 'active');
  assert.equal(stale.chancePercent, 75);
  assert.equal(stale.stale, true);
  assert.equal(stale.errorKind, 'invalid-response');
  assert.equal(stale.retryAfterMs, 100);

  assert.equal((await client.getForecast()).checkedAt, stale.checkedAt);
  currentTime += 101;
  await client.getForecast();
  assert.equal(calls, 3);
});
