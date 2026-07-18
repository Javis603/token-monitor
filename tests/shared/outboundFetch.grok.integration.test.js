'use strict';

/**
 * Live integration: only runs when GROK live credentials + proxy env exist.
 * Skips cleanly otherwise so CI stays green without secrets.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { resolveProxyUrl } = require('../../src/shared/outboundFetch');
const { fetchGrokLimits, grokCredential, resolveGrokHome } = require('../../src/shared/grokLimits');

function hasLiveGrokAuth() {
  try {
    const p = path.join(resolveGrokHome(process.env), 'auth.json');
    if (!fs.existsSync(p)) return false;
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Object.values(doc || {}).some((v) => v && typeof v.key === 'string' && v.key.trim());
  } catch (_) {
    return false;
  }
}

const canRun = Boolean(resolveProxyUrl(process.env) && hasLiveGrokAuth());

test(
  'live Grok billing via env proxy returns Weekly/Monthly window',
  { skip: canRun ? false : 'needs HTTPS_PROXY + ~/.grok/auth.json' },
  async () => {
    const cred = grokCredential(process.env);
    assert.ok(cred && cred.token);
    const result = await fetchGrokLimits(
      {},
      {
        env: process.env,
        // Skip RPC: stdio surface is Method not found on current grok builds.
        fetchRpcBilling: async () => {
          const err = new Error('Method not found');
          err.status = 'unavailable';
          throw err;
        },
        fetchTimeoutMs: 20000
      }
    );
    assert.equal(result.provider, 'grok');
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.ok(Array.isArray(result.windows) && result.windows.length >= 1);
    const win = result.windows[0];
    assert.ok(win.label === 'Weekly' || win.label === 'Monthly' || win.label === 'Billing', win.label);
    assert.ok(Number.isFinite(win.usedPercent));
    assert.ok(win.usedPercent >= 0 && win.usedPercent <= 100);
  }
);
