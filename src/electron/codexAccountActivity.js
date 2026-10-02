'use strict';

const path = require('node:path');
const { readJson, sharedDataDir, writeJsonAtomic } = require('../shared/config');
const { readCodexAccountActivity } = require('../shared/collector');
const { readLiveCodexIdentity } = require('../shared/providers/codex/limits');
const { normalizeAccountActivity, selectAccountActivity } = require('../shared/providers/codex/accountActivity');

const REFRESH_MS = 15 * 60 * 1000;

function createCodexAccountActivity(options = {}) {
  const filePath = options.filePath || path.join(sharedDataDir(), 'codex-account-activity.json');
  const readIdentity = options.readIdentity || readLiveCodexIdentity;
  const readActivity = options.readActivity || readCodexAccountActivity;
  const notify = options.onChange || (() => {});
  const stored = readJson(filePath, { version: 1, accounts: {} });
  const accounts = stored?.version === 1 && stored.accounts && typeof stored.accounts === 'object'
    ? { ...stored.accounts } : {};
  const observedKeys = new Set([
    ...Object.keys(accounts),
    ...(Array.isArray(stored?.observedAccountKeys) ? stored.observedAccountKeys.filter((key) => typeof key === 'string' && key) : [])
  ]);
  const attempts = new Map();
  let inFlight = null;
  let scopePersistenceFailed = false;

  function persist() {
    try {
      writeJsonAtomic(filePath, { version: 1, accounts, observedAccountKeys: [...observedKeys] });
      scopePersistenceFailed = false;
    } catch (error) {
      scopePersistenceFailed = true;
      throw error;
    }
  }

  function liveKey() {
    const key = readIdentity().accountKey;
    if (key && !observedKeys.has(key)) {
      observedKeys.add(key);
      try { persist(); } catch (error) {
        scopePersistenceFailed = true;
        options.onError?.(error);
      }
    }
    return key;
  }

  function snapshot() {
    const key = liveKey();
    const saved = key && accounts[key];
    if (!saved) return null;
    if (saved.dailyUsageBuckets != null && !Array.isArray(saved.dailyUsageBuckets)) return null;
    return normalizeAccountActivity({ codexAccountActivity: {
      status: 'available',
      source: saved.source,
      fetchedAt: saved.fetchedAt,
      lifetimeTokens: saved.lifetimeTokens,
      dailyUsageBuckets: saved.dailyUsageBuckets?.map((bucket) => ({ startDate: bucket?.date, tokens: bucket?.tokens }))
    } }, key);
  }

  function refresh({ force = false } = {}) {
    const key = liveKey();
    if (!key) return Promise.resolve(null);
    if (inFlight) return inFlight;
    const now = Date.now();
    if (!force && now - (attempts.get(key) || 0) < REFRESH_MS) return Promise.resolve(snapshot());
    attempts.set(key, now);
    inFlight = (async () => {
      try {
        const raw = await readActivity();
        if (liveKey() !== key) return null;
        let incoming = normalizeAccountActivity(raw, key);
        if (!incoming) return snapshot();
        const current = snapshot();
        let correctionConfirmed = false;
        if (current && incoming.lifetimeTokens < current.lifetimeTokens) {
          const confirmation = normalizeAccountActivity(await readActivity(), key);
          if (liveKey() !== key) return null;
          correctionConfirmed = Boolean(incoming.dailyCoverageComplete && confirmation
            && confirmation.lifetimeTokens === incoming.lifetimeTokens
            && confirmation.dailyCoverageComplete
            && JSON.stringify(confirmation.dailyUsageBuckets) === JSON.stringify(incoming.dailyUsageBuckets));
          if (correctionConfirmed) incoming = confirmation;
        }
        const { snapshot: selected, conflict } = selectAccountActivity(current, incoming, { correctionConfirmed });
        if (conflict) {
          options.onConflict?.({ accountKey: key, existing: selected.lifetimeTokens, incoming: incoming.lifetimeTokens });
          return selected;
        }
        accounts[key] = selected;
        persist();
        notify(selected);
        return selected;
      } catch (error) {
        options.onError?.(error);
        return snapshot();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { snapshot, refresh, observe: liveKey, multipleAccounts: () => observedKeys.size > 1 || scopePersistenceFailed };
}

module.exports = { createCodexAccountActivity };
