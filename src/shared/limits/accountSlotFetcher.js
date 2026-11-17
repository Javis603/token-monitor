// @ts-check
'use strict';

const { hashKey } = require('../hashKey');
const { nowIso, providerStatusFromError } = require('./providerHelpers');
const { accountSlotKey, normalizeAccountSlots, defaultAccountValues, accountValuesFingerprint } = require('./accountSlots');

/**
 * @typedef {import('./accountSlots').AccountSlot} AccountSlot
 * @typedef {Omit<import('./accounts').AccountDeclaration, 'fields'> & {fetchLimits: (options: SlotOptions, deps: SlotDeps) => any, fields: any[], limits?: Record<string, any>}} SlotEntry
 * @typedef {Record<string, any>} SlotOptions Flat provider config, previousLimits and optional limitRefreshScope.
 * @typedef {{accountKey: string, accountKeyAliases: string[]}} SlotIdentity
 * @typedef {Record<string, any> & {providerRuntimeState?: Map<string, any>, onAccountSlotResolved?: (provider: string, slotId: string, identity: SlotIdentity, values: Record<string, string>) => void}} SlotDeps Injected transport/env/signal and optional identity persistence hook.
 * @typedef {object} SlotAccount One account of a dispatch: the default account (`values: null`) or an enabled slot.
 * @property {string} id
 * @property {string} label
 * @property {Record<string, string> | null} values
 * @property {string} provisional The key it is filed under until its fetch reports a real one.
 * @property {boolean} known Whether a row has already been filed under `accountKey`.
 * @property {boolean} serverIdentity Whether the stored key was proven to be a server account.
 * @property {string} accountKey
 * @property {string[]} accountKeyAliases
 */

// What a slot's fetch keeps of the environment: where shared data is stored
// (`sharedDataDir`), so a slot's derived history sits beside the default
// account's. Everything else is dropped, because a slot never takes a
// credential from the environment: that is the default account's lane.
const SLOT_ENV_KEYS = ['TOKEN_MONITOR_SHARED_DIR', 'APPDATA', 'XDG_CONFIG_HOME'];
/** @param {Record<string, string | undefined>} env */
function slotEnv(env) {
  return Object.fromEntries(SLOT_ENV_KEYS.filter((name) => env[name]).map((name) => [name, env[name]]));
}

/** @param {any} row @param {string} key */
function reportsKey(row, key) {
  return row?.accountKey === key || (Array.isArray(row?.accountKeyAliases) && row.accountKeyAliases.includes(key));
}

/** @typedef {{key: string, keyless: boolean} | null} ScopeCheck */

// What an answer to an account-scoped refresh must show before the runtime files
// it under the scope key. Every rendered row has a refresh, including rows
// another device reported, and that device may still use a key this one has
// moved away from, so an answer that reports another key is never filed under
// it. A keyless answer (a failure that could not name its account) is kept only
// for a key a local row holds.
/** @param {SlotEntry} entry @param {SlotOptions} options @param {string} scopeKey */
function scopeCheck(entry, options, scopeKey) {
  const held = (options.previousLimits?.providers || [])
    .some((/** @type {any} */ row) => row.provider === entry.id && reportsKey(row, scopeKey));
  return { key: scopeKey, keyless: held };
}

/** @param {any} row @param {ScopeCheck} check */
function answersScope(row, check) {
  if (!check) return true;
  return row.accountKey ? reportsKey(row, check.key) : check.keyless;
}

// Slots and the default account are namespaced apart, whatever a slot is called.
/** @param {{id: string, values: Record<string, string> | null}} account */
function accountNamespace(account) {
  return account.values ? `slot:${account.id}` : 'default';
}

/** @param {SlotEntry} entry @param {SlotOptions} options @param {SlotDeps} deps */
function slotAccounts(entry, options, deps) {
  const state = deps.providerRuntimeState;
  const previousKeys = new Set((options.previousLimits?.providers || [])
    .filter((/** @type {any} */ row) => row.provider === entry.id && row.accountKey)
    .map((/** @type {any} */ row) => String(row.accountKey)));

  // An account's identity is what this runtime remembers, else what the slot
  // record stores, else its provisional key if a row was already filed under it.
  /** @param {{id: string, label: string, values: Record<string, string> | null, accountKey: string, accountKeyAliases: string[], serverIdentity?: boolean}} account @returns {SlotAccount} */
  const describe = (account) => {
    const provisional = hashKey(entry.id, 'account-slot', accountNamespace(account));
    /** @type {SlotIdentity | null} */
    const identity = state?.get(`account-slot:${entry.id}:${accountNamespace(account)}:${accountValuesFingerprint(account.values || defaultAccountValues(entry, options, deps.env || process.env))}`)
      || (account.accountKey ? { accountKey: account.accountKey, accountKeyAliases: account.accountKeyAliases } : null)
      || (previousKeys.has(provisional) ? { accountKey: provisional, accountKeyAliases: [] } : null);
    return {
      id: account.id, label: account.label, values: account.values, provisional, known: Boolean(identity), serverIdentity: account.serverIdentity === true,
      accountKey: identity?.accountKey || provisional, accountKeyAliases: identity?.accountKeyAliases || []
    };
  };

  const slots = normalizeAccountSlots(entry, options[accountSlotKey(entry)]);
  const enabled = slots.filter(slot => slot.enabled).map(slot => describe(slot));
  const values = defaultAccountValues(entry, options, deps.env || process.env);
  const primary = entry.status?.credential;
  const all = [...(values[primary || ''] ? [describe({ id: 'environment', label: '', values: null, accountKey: '', accountKeyAliases: [] })] : []), ...enabled];
  // A key one account moved away from may be another account's key now; it is
  // that account's identity, not an alias of this one.
  const current = new Set(all.map((account) => account.accountKey));
  const accounts = all.map((account) => ({ ...account, accountKeyAliases: account.accountKeyAliases.filter((alias) => !current.has(alias)) }));

  const scope = options.limitRefreshScope;
  const scopeKey = scope?.provider === entry.id && scope.accountKey ? String(scope.accountKey) : '';
  if (!scopeKey) return { accounts, scopeKey, previousKeys, check: /** @type {ScopeCheck} */ (null) };
  const check = scopeCheck(entry, options, scopeKey);
  // A provisional key no fetch can report: a held one is recovered in place (the
  // next provider-wide pass moves it), and one no local row holds is another
  // device's account that happens to share the namespace.
  const provisional = accounts.find((account) => account.provisional === scopeKey);
  if (provisional) return { accounts: [provisional], scopeKey, previousKeys, check: check.keyless ? null : check };
  // A remembered or stored key can be stale until a provider-wide pass, so an
  // exact match still has to report it.
  const exact = accounts.find((account) => account.accountKey === scopeKey);
  if (exact) return { accounts: [exact], scopeKey, previousKeys, check };
  // A key an account moved away from can still be live on another device; this
  // account answers for it only by reporting it again.
  const moved = accounts.find((account) => account.accountKeyAliases.includes(scopeKey));
  if (moved) return { accounts: [moved], scopeKey, previousKeys, check: { key: scopeKey, keyless: false } };
  // No account answers to this key. It can still be the default account's when
  // this process has not seen that account answer yet; a default account whose
  // key is known and different is not what was asked for.
  return { accounts: accounts.filter((account) => !account.values && !account.known), scopeKey, previousKeys, check };
}

/** @param {SlotEntry} entry @param {SlotOptions} options @param {SlotDeps} deps */
function accountSlotJobs(entry, options, deps) {
  return normalizeAccountSlots(entry, options[accountSlotKey(entry)]).length ? Math.max(1, slotAccounts(entry, options, deps).accounts.length) : 1;
}

/** @param {SlotEntry} entry */
function createAccountSlotFetcher(entry) {
  const key = accountSlotKey(entry);
  const form = entry.form;
  const requiredSecrets = form?.field ? [form.field] : (form?.fields || [])
    .filter((field) => field.required && (field.secret ?? field.input !== 'select')).map((field) => field.key);

  // One account's raw fetch, with nothing of any other account in reach.
  /** @param {SlotAccount} account @param {Set<string>} owned @param {SlotOptions} options @param {SlotDeps} deps */
  async function fetchAccount(account, owned, options, deps) {
    const callOptions = { ...options };
    delete callOptions[key];
    if (account.values) {
      for (const field of entry.fields) if (field.key !== key) callOptions[field.key] = '';
      Object.assign(callOptions, account.values);
    }
    callOptions.previousLimits = {
      providers: (options.previousLimits?.providers || [])
        .filter((/** @type {any} */ row) => row.provider === entry.id && owned.has(row.accountKey))
    };
    const updatedAt = nowIso((deps.now || Date.now)());
    if (account.values && requiredSecrets.some((field) => !String(callOptions[field] || '').trim())) {
      return [{ provider: entry.id, status: 'notConfigured', windows: [], updatedAt }];
    }
    try {
      const result = await entry.fetchLimits(callOptions, account.values ? { ...deps, env: slotEnv(deps.env || process.env) } : deps);
      return (Array.isArray(result) ? result : [result]).filter(Boolean);
    } catch (error) {
      deps.noteLimitFailure?.(error);
      return [{ provider: entry.id, status: providerStatusFromError(error), windows: [], updatedAt }];
    }
  }

  /** @param {SlotOptions} options @param {SlotDeps} deps */
  return function fetchAccountSlots(options = {}, deps = {}) {
    if (!normalizeAccountSlots(entry, options[key]).length) {
      const dispatchedValues = defaultAccountValues(entry, options, deps.env || process.env);
      let result = entry.fetchLimits(options, deps);
      if (deps.onAccountSlotResolved) result = Promise.resolve(result).then(raw => {
        if (!deps.signal?.aborted) for (const row of Array.isArray(raw) ? raw : [raw]) {
          if (row?.accountKey && !row.removed) deps.onAccountSlotResolved?.(entry.id, 'environment', { accountKey: row.accountKey, accountKeyAliases: row.accountKeyAliases || [] }, dispatchedValues);
        }
        return raw;
      });
      const scope = options.limitRefreshScope;
      if (!scope?.accountKey || scope.provider !== entry.id) return result;
      return Promise.resolve(result).then(raw => (Array.isArray(raw) ? raw : [raw]).filter(row => row && !row.removed && answersScope(row, scopeCheck(entry, options, String(scope.accountKey)))));
    }
    return collect();

    async function collect() {
      const { accounts, scopeKey, previousKeys, check } = slotAccounts(entry, options, deps);
      /** @type {{account: SlotAccount, values: Record<string, string>, row: any, accountKey: string, moved: boolean}[]} */
      const answered = [];
      let complete = true;
      for (const account of accounts) {
        if (deps.signal?.aborted) { complete = false; break; }
        const owned = new Set([account.accountKey, account.provisional, ...account.accountKeyAliases]);
        // The adapter decides retirement below, so a fetch's own removal rows are dropped.
        const values = account.values || defaultAccountValues(entry, options, deps.env || process.env);
        const answers = (await fetchAccount(account, owned, options, deps))
          .filter((row) => !row.removed && answersScope(row, check));
        if (!answers.length && check && !check.keyless) continue;
        if (!answers.length) answers.push({ provider: entry.id, status: 'unavailable', windows: [], updatedAt: nowIso((deps.now || Date.now)()) });
        for (const row of answers) {
          // The runtime files every row of an account-scoped dispatch under the
          // scope identity, so a scoped answer stays on that key and changes
          // nothing remembered; a held provisional key's recovery moves on the
          // next provider-wide dispatch.
          const accountKey = scopeKey || row.accountKey || account.accountKey;
          answered.push({ account, values, row, accountKey, moved: account.known && accountKey !== account.accountKey });
        }
      }
      if (deps.signal?.aborted) complete = false;

      // Aliases are settled once every account has answered: a key that is some
      // account's identity in this pass is never another account's alias.
      const live = new Set(answered.map((answer) => answer.accountKey));
      const rows = [];
      /** @type {Map<string, number>} */
      const emitted = new Map();
      const provesServer = entry.serverAccountKey && entry.limits?.[entry.serverAccountKey];
      for (const { account, values, row, accountKey, moved } of answered) {
        // A slot whose stored key was a proven server account, now answering as a
        // different proven server account (a credential replaced while offline),
        // is a different account: it takes nothing of the old identity, which the
        // snapshot then retires, so the old account's history is not handed on.
        // The proof is kept through an unproven answer, and a key the slot has
        // been before is its own account coming back.
        const separate = Boolean(moved && account.values && account.serverIdentity && provesServer
          && !account.accountKeyAliases.includes(accountKey)
          && provesServer(accountKey, account.values, row.accountKeyAliases || []));
        // Separated, nothing of the previous identity may come back through the
        // fetch's own aliases either (Qoder reports its cookie hash as one).
        const previous = new Set(separate ? [account.accountKey, ...account.accountKeyAliases] : []);
        const reported = (row.accountKeyAliases || []).filter((/** @type {string} */ alias) => !previous.has(alias));
        const aliases = [...new Set([...(separate ? [] : account.accountKeyAliases), ...reported, ...(moved && !separate ? [account.accountKey] : [])])]
          .filter((alias) => !live.has(alias)).slice(-8);
        // Like retirement, a remembered identity only advances on a pass the
        // runtime can accept whole.
        if (!scopeKey && complete) {
          const identity = { accountKey, accountKeyAliases: aliases };
          deps.providerRuntimeState?.set(`account-slot:${entry.id}:${accountNamespace(account)}:${accountValuesFingerprint(values)}`, identity);
          if (!account.known || moved || aliases.join('\n') !== account.accountKeyAliases.join('\n')) {
            // Environment identities stay in memory; local identities update their slot.
            deps.onAccountSlotResolved?.(entry.id, account.id, identity, values);
          }
        }
        const { accountKeyAliases: _reported, ...answer } = row;
        if (complete && !scopeKey && row.status === 'ok') deps.providerRuntimeState?.set(`account-name:${entry.id}:${accountKey}`, row.accountName || '');
        // A slot's local name is its accountName (the runtime projects the same
        // rule onto retained readings); the provider's accountLabel carries the plan.
        if (account.label) delete answer.accountName;
        const emit = {
          ...answer, accountKey,
          ...(aliases.length ? { accountKeyAliases: aliases } : {}),
          ...(account.label ? { accountName: account.label } : {})
        };
        // A second account reporting an identity already answered in this pass
        // is the same upstream account: one row, the first reading that worked,
        // so a stale duplicate credential cannot hide a working one.
        const index = emitted.get(accountKey);
        if (index === undefined) { emitted.set(accountKey, rows.length); rows.push(emit); }
        else if (rows[index].status !== 'ok' && emit.status === 'ok') rows[index] = emit;
      }
      // A provider-wide pass that reached every account is a full snapshot: an
      // identity the runtime still holds that no account answered under (a key
      // an account moved away from, a disabled or duplicate slot, a row a scoped
      // dispatch left under an old key) is retired. Reading it from the rows the
      // runtime accepted, not from what earlier passes meant to retire, means a
      // superseded pass loses nothing: the next one sees the same leftovers.
      if (!scopeKey && complete) {
        for (const accountKey of previousKeys) {
          if (!live.has(accountKey)) rows.push({ provider: entry.id, accountKey, removed: true });
        }
      }
      return rows;
    }
  };
}

module.exports = { createAccountSlotFetcher, accountSlotJobs };
