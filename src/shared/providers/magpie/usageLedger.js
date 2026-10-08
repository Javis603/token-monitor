'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { hashKey } = require('../../hashKey');

const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100000;
const CODING_PLANS = new Set(['kimi-code', 'kimi-code-cn', 'opencode-go']);
const API_HOSTS = { openai: 'api.openai.com', anthropic: 'api.anthropic.com', google: 'generativelanguage.googleapis.com',
  gemini: 'generativelanguage.googleapis.com', deepseek: 'api.deepseek.com', openrouter: 'openrouter.ai' };
const cache = new Map();
const clean = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';

// providerAccount is the subscription account that actually answered, after
// routing/failover. providerKeyId identifies a credential, not its billing plan.
// The session creator, selected route and current authentication are irrelevant.
function sourceFromLedger(row) {
  const platform = clean(row?.provider, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(platform)) return null;
  const account = clean(row.providerAccount, 256);
  const key = clean(row.providerKeyId, 256);
  const accountId = account || key ? hashKey('usage-account-v1', platform, account || key) : '';
  const host = clean(row.host, 256).toLowerCase();
  const codingHost = platform === 'opencode-go' ? host === 'opencode.ai'
    : platform === 'kimi-code-cn' ? host === 'api.kimi.com' : host === 'api.kimi.ai';
  const accessType = account || (key && CODING_PLANS.has(platform) && codingHost) ? 'subscription'
    : key && API_HOSTS[platform] === host ? 'api' : 'unknown';
  return { platform, accountId, accountLabel: accountId ? `账号 ${accountId.slice(7, 15)}` : '', accessType };
}

async function readMagpieUsageLedger(options = {}) {
  options.signal?.throwIfAborted();
  const file = options.ledgerPath || path.join(options.homeDir || os.homedir(), '.config', 'magpie', 'usage.jsonl');
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return new Map(); }
  if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) return new Map();
  const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  if (cache.get(file)?.signature === signature) return cache.get(file).rows;
  const rows = new Map();
  if (!stat.size) return rows;
  options.signal?.throwIfAborted();
  const input = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 65536, end: stat.size - 1, signal: options.signal });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (options.signal?.aborted) throw options.signal.reason || new Error('Aborted');
      if (line.length > 1024 * 1024) continue;
      let raw;
      try { raw = JSON.parse(line); } catch (_) { continue; }
      const id = clean(raw.response_id, 512);
      const source = sourceFromLedger(raw);
      if (!id || id !== raw.response_id || !source || !Number.isSafeInteger(raw.in) || raw.in < 0 || !Number.isSafeInteger(raw.out) || raw.out < 0) continue;
      const row = { source, input: raw.in, output: raw.out };
      // A reused response ID with conflicting identity/usage cannot prove a join.
      if (rows.has(id) && JSON.stringify(rows.get(id)) !== JSON.stringify(row)) rows.set(id, null);
      else if (!rows.has(id)) rows.set(id, row);
      if (rows.size > MAX_RECORDS) return new Map();
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return new Map();
  } finally {
    lines.close(); input.destroy();
  }
  let after;
  try { after = fs.statSync(file); } catch (_) { return new Map(); }
  if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') !== signature) return new Map();
  if (cache.size >= 4) cache.delete(cache.keys().next().value);
  cache.set(file, { signature, rows });
  return rows;
}

module.exports = { sourceFromLedger, readMagpieUsageLedger };
