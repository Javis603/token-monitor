// @ts-check
'use strict';
(function expose(root, factory) {
  const legacy = typeof module === 'object' && module.exports ? require('./legacyAccountList') : /** @type {any} */ (root).TokenMonitorLegacyAccountList;
  const api = factory(legacy);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) /** @type {any} */ (root).TokenMonitorAutomaticAccountList = api;
})(typeof window !== 'undefined' ? window : null, /** @param {any} legacy */ function automaticAccountList(legacy) {
  /**
   * The collector owns identity. Display names and source locations never prove
   * that observations belong to the same account. Keyless rows are local UI
   * observations only; their IDs are never sent to account presentation.
   * @param {string} provider
   * @param {any[]} readings Already restricted to the local device by the host.
   * @param {{represented?: any[], localDeviceId?: string, label?: string, sourceName?: (row: any) => string}} [options]
   */
  function accountsFromReadings(provider, readings, { represented = [], localDeviceId = '', label = provider, sourceName = row => row.sourceDetail || row.source || '' } = {}) {
    const local = readings.filter(row => (!row.provider || row.provider === provider)
      && (!row.sourceDeviceId || row.sourceDeviceId === localDeviceId)
      && !row.removed && row.status !== 'notConfigured'
      && (row.accountKey || row.status === 'ok')
      && (provider !== 'claude' || ['oauth', 'cli'].includes(row.source)));
    // Prefer the current canonical reading when it explicitly resolves an old
    // key. Ambiguous/cyclic aliases cannot choose between different accounts.
    const keyed = new Map();
    for (const row of local.filter(row => row.accountKey)) {
      const previous = keyed.get(row.accountKey);
      if (!previous || previous.stale && !row.stale) keyed.set(row.accountKey, row);
    }
    const claims = new Map();
    for (const row of keyed.values()) for (const alias of row.accountKeyAliases || []) {
      if (alias === row.accountKey) continue;
      const owners = claims.get(alias) || [];
      owners.push(row.accountKey);
      claims.set(alias, owners);
    }
    const accounts = [...keyed.values(), ...local.filter(row => !row.accountKey)].filter(row => {
      if (!row.accountKey) return true;
      // Only collapse a chain that reaches one unambiguous canonical root.
      // A cycle of any length cannot establish which identity supersedes another.
      const visited = new Set();
      let key = row.accountKey;
      while (!visited.has(key)) {
        visited.add(key);
        const owners = claims.get(key) || [];
        if (!owners.length) {
          if (key !== row.accountKey) return false;
          break;
        }
        if (owners.length !== 1) break;
        key = owners[0];
      }
      if (represented.some(account => account.accountKey === row.accountKey)) return false;
      const linked = represented.filter(account => {
        const resolvesSaved = row.accountKeyAliases?.includes(account.accountKey);
        const resolvesReading = account.accountKeyAliases?.includes(row.accountKey);
        return Boolean(resolvesSaved) !== Boolean(resolvesReading);
      });
      return linked.length !== 1;
    });
    return accounts.map((row, index) => ({
      id: row.accountKey ? `automatic:${row.accountKey}` : `observation:${row.source || 'local'}:${index}`,
      accountKey: row.accountKey || '', accountKeyAliases: row.accountKeyAliases || [],
      accountName: row.accountName || (!row.accountEmail ? label : ''),
      accountEmail: row.accountKey ? row.accountEmail || '' : '', sourceName: sourceName(row),
      source: 'automatic', enabled: true, canReplace: false, canPause: false, removable: false,
      observation: row
    }));
  }
  /**
   * Automatic sources reuse the account row/presentation controls, without
   * exposing credential management owned by the external app.
   * @param {{document: Document, provider: string, label: string, container: HTMLElement, t: Function, bridge: any, getContext: Function, preserveScroll: Function, sources: any[]}} options
   */
  function create(options) {
    const list = legacy.create({ ...options,
      changed: () => {}, refresh: () => {},
      statusReading: (/** @type {any} */ account, /** @type {any} */ reading) => account.observation || reading,
      secondaryText: (/** @type {any} */ account) => account.sourceName
    });
    /** @param {any[]} readings */
    function update(readings) {
      const context = options.getContext();
      const accounts = accountsFromReadings(options.provider, readings, {
        localDeviceId: context.localDeviceId, label: options.label,
        sourceName: row => {
          // Name the lane the quota came through; `managed` only says Token
          // Monitor holds the login, so it falls through to the source itself.
          if (row.sourceDetail === 'unknown') return '';
          const source = row.sourceDetail === 'app'
            ? options.sources.find(source => source.kind === 'desktop')
            : options.sources.find(source => source.id === row.sourceDetail)
              || options.sources.find(source => source.id === row.source);
          return source ? options.t(source.labelKey) : '';
        }
      });
      // Keyless source observations own status only, never an account match.
      list.update(accounts, readings.filter(row => row.accountKey));
    }
    return { update };
  }
  return { accountsFromReadings, create };
});
