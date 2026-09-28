'use strict';

(function exposeAccountIdentity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorAccountIdentity = api;
})(typeof window !== 'undefined' ? window : null, function createAccountIdentityApi() {
  function maskEmailAddress(value) {
    const email = String(value || '').trim();
    const at = email.lastIndexOf('@');
    if (at <= 0 || at === email.length - 1) return email;
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const first = local[0] || '';
    const last = local.length > 1 ? local.at(-1) : '';
    return `${first}***${last}@${domain}`;
  }

  function accountEmailOf(account) {
    return String(account?.email || account?.accountEmail || '').trim();
  }

  // The account email as a limits surface may show it: masked when the display
  // setting is on, and disambiguated when the visible form is not unique. Masking
  // collapses distinct addresses (javis@example.com / jonas@example.com both read
  // j***s@example.com), and one address can also hold several workspaces, so peers
  // decide whether the caller's `suffix` has to be appended.
  function accountEmailLabel(account, peers = [account], options = {}) {
    const email = accountEmailOf(account);
    if (!email) return '';
    const maskEmail = options.maskEmail === true;
    const visible = maskEmail ? maskEmailAddress(email) : email;
    const normalized = visible.toLowerCase();
    const collisions = (peers || []).filter((peer) => {
      const peerEmail = accountEmailOf(peer);
      if (!peerEmail) return false;
      const peerVisible = maskEmail ? maskEmailAddress(peerEmail) : peerEmail;
      return peerVisible.toLowerCase() === normalized;
    }).length;
    if (collisions <= 1) return visible;
    const suffix = String(options.suffix || '').trim();
    return suffix ? `${visible} · ${suffix}` : visible;
  }

  function codexAccountWorkspace(account, personalWorkspaceLabel = 'Personal') {
    const workspace = String(account?.workspaceLabel || account?.accountName || '').trim();
    if (workspace) return workspace;
    return account?.workspaceKind === 'personal'
      ? String(personalWorkspaceLabel || '').trim()
      : '';
  }

  function accountStableSeed(account) {
    return String(
      account?.accountKey
      || account?.workspaceAccountId
      || account?.providerAccountId
      || account?.id
      || ''
    ).trim();
  }

  // A short opaque fingerprint, used only to keep otherwise identical rows apart.
  // Keys the collector already hashed are shown as-is; any other key may embed the
  // address itself (Claude's CLI rows key on `email|organization`), so it is hashed
  // here — a disambiguator must never echo the characters masking hides.
  function accountStableFingerprint(account) {
    const seed = accountStableSeed(account);
    if (!seed) return '';
    if (/^sha256:/i.test(seed)) return seed.slice(7).replace(/[^a-z0-9]/gi, '').toLowerCase();
    let hash = 0x811c9dc5;
    for (let index = 0; index < seed.length; index += 1) {
      hash = Math.imul(hash ^ seed.charCodeAt(index), 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function codexAccountBaseDisplayLabel(account, peers, options) {
    const workspace = codexAccountWorkspace(account, options.personalWorkspaceLabel);
    const emailLabel = accountEmailLabel(account, peers, {
      maskEmail: options.maskEmail === true,
      suffix: workspace
    });
    return emailLabel || workspace;
  }

  function accountUniqueStableSuffix(account, peers) {
    const fingerprint = accountStableFingerprint(account);
    if (!fingerprint) return '';
    const peerPrints = peers.map(accountStableFingerprint);
    for (let length = Math.min(6, fingerprint.length); length <= fingerprint.length; length += 1) {
      const prefix = fingerprint.slice(0, length);
      if (peerPrints.filter((candidate) => candidate.slice(0, length) === prefix).length === 1) {
        return prefix;
      }
    }
    // Peers that fingerprint alike (the same key, or a hash collision) cannot be
    // told apart by the key at all, so report no suffix and let the caller fall
    // back to the row index rather than repeat an identical label.
    return '';
  }

  // Two-stage disambiguation, shared by every provider: the descriptive label
  // first, then an opaque fingerprint once descriptions repeat. A workspace or
  // account name is not unique on its own — two masked addresses in the same
  // workspace produce the same descriptive label.
  function uniqueAccountLabel(account, peers, baseLabelFor, options = {}) {
    const label = baseLabelFor(account);
    if (!label) return '';

    const collidingPeers = peers.filter(
      (peer) => baseLabelFor(peer).toLowerCase() === label.toLowerCase()
    );
    if (collidingPeers.length <= 1) return label;
    const stableSuffix = accountUniqueStableSuffix(account, collidingPeers);
    if (stableSuffix) return `${label} · #${stableSuffix}`;
    // Nothing stable to key on. The row index moves when providers reorder, so it
    // is the last resort rather than the default.
    return Number.isInteger(options.index) ? `${label} · #${options.index + 1}` : label;
  }

  function codexAccountDisplayLabel(account, accounts = [], options = {}) {
    const peers = Array.isArray(accounts) && accounts.length > 0 ? accounts : [account];
    return uniqueAccountLabel(
      account,
      peers,
      (peer) => codexAccountBaseDisplayLabel(peer, peers, options),
      { index: options.index }
    );
  }

  // The keys one account can be named by: the key the provider reports today,
  // the browser-session key beside it, and the keys a credential has rotated
  // away from — kept on the record so a subscription bound before the rotation
  // still lands. Trimmed and not lowercased, because keys are hashes and file
  // paths, which is also how the shared matcher reads them.
  function accountKeyFamily(account) {
    return new Set([
      account?.accountKey,
      account?.webAccountKey,
      ...(Array.isArray(account?.accountKeyAliases) ? account.accountKeyAliases : [])
    ].map((key) => String(key === null || key === undefined ? '' : key).trim()).filter(Boolean));
  }

  // Whether two records name one account — the question a list is deduped with
  // and a row asks about the account a record resolved to. The rungs are the
  // subscription matcher's, in its order (subscriptionDisplay.js,
  // matchProviderAccount), so a list deduped here and a binding resolved there
  // cannot disagree about what one account is.
  //
  // The key rung asks whether the two families intersect rather than whether two
  // chosen strings are equal, because a family is a set — the canonical key plus
  // the keys it replaced — and two copies of one account need not carry the same
  // member of it.
  //
  // Two records that both carry keys are decided by them and by nothing else. An
  // address can hold several workspaces — the hub keeps same-email Codex
  // workspaces apart by key (limits/core.js), and so does aggregateLimits — so
  // reading an equal address as evidence of one account would merge two accounts
  // the hub deliberately keeps apart. A key that rotated is recorded in the same
  // family rather than as a second key.
  //
  // The address rung is therefore reached only when at least one side has no key
  // to compare, which is the case it exists for: one account whose two copies do
  // not both know a key.
  //
  // The profile name is deliberately not a rung. The matcher reads it as
  // identity only while it names exactly one account, which is a property of the
  // list rather than of a pair: deduping two same-named accounts would hand the
  // matcher the single candidate it declined to choose between, and put the cost
  // on the wrong row.
  function sameAccount(a, b) {
    if (String(a?.provider || '').trim().toLowerCase() !== String(b?.provider || '').trim().toLowerCase()) {
      return false;
    }
    const keysA = accountKeyFamily(a);
    const keysB = accountKeyFamily(b);
    const emailA = accountEmailOf(a).toLowerCase();
    const emailB = accountEmailOf(b).toLowerCase();
    if (keysA.size > 0 && keysB.size > 0) {
      for (const key of keysA) {
        if (keysB.has(key)) return true;
      }
      return false;
    }
    if (emailA && emailB) return emailA === emailB;
    // Nothing named on either side is not the same question as nothing named on
    // one: an unnamed record is one observation we cannot name, not every
    // unnamed account at once. Merging it with a named one drops the named one
    // out of the list — and a row then asks this same rule about the account a
    // binding resolved to, so the unnamed one would answer for it. Two unnamed
    // observations stay one account, which is what lets the matcher's
    // sole-account fallback heal a re-pasted credential.
    const namedA = keysA.size > 0 || Boolean(emailA);
    const namedB = keysB.size > 0 || Boolean(emailB);
    return !namedA && !namedB;
  }

  // Whether two key families name one account: they are sets, and an account
  // whose key rotated is recorded by both, so an intersection is the test.
  function keyFamiliesIntersect(a, b) {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const key of small) {
      if (large.has(key)) return true;
    }
    return false;
  }

  // One account per connected set of key families, in first-seen order. Two
  // records that share a key are one account, so a record naming both keys
  // bridges the two — the merge has to close over that, or the answer depends on
  // which of the three was read first.
  // Members are held by index rather than by record: the two lists this is read
  // on can carry the same record object (the aggregate holds this device's own
  // records too), and a set of records would then count one account twice.
  function keyedAccountGroups(records, emailOf) {
    const groups = [];
    for (let index = 0; index < records.length; index += 1) {
      const family = accountKeyFamily(records[index]);
      if (family.size === 0) continue;
      const hits = groups.filter((group) => keyFamiliesIntersect(group.keys, family));
      const target = hits.length > 0 ? hits[0] : { survivor: index, keys: new Set(), emails: new Set(), members: [] };
      if (hits.length === 0) groups.push(target);
      target.members.push(index);
      for (const key of family) target.keys.add(key);
      const email = emailOf(records[index]);
      if (email) target.emails.add(email);
      for (const merged of hits.slice(1)) {
        for (const key of merged.keys) target.keys.add(key);
        for (const mergedEmail of merged.emails) target.emails.add(mergedEmail);
        target.members.push(...merged.members);
        groups.splice(groups.indexOf(merged), 1);
      }
    }
    return groups;
  }

  // The list-level half of the rule: which of these records are distinct
  // accounts. `sameAccount` answers about a pair, and a pair cannot answer this —
  // an address is what a keyless record has instead of a key, so a keyless copy
  // of one account reads as the same account as *every* keyed one on that
  // address. Left to the pairwise rule in a list, three records (a keyless copy
  // of member@example.com and the two Codex workspaces on it) dedupe to one
  // account or to two depending on which order they arrive in, and the losing
  // order drops both keyed workspaces — the shape `aggregateLimits` keeps apart
  // on purpose, out of the matcher universe and out of the settings picker.
  //
  // So the rules are stated over the whole list: keys decide, and they decide
  // for every record that has one; a keyless record is never allowed to displace
  // a keyed one, whether the address it carries names one of them or several.
  // Two keyless records with the same address are one account, which is the case
  // the pairwise address rung was written for — one account whose copies do not
  // both know a key. Records that name nothing at all are one account together
  // and never one with a record that names something.
  //
  // Input order is preserved, so a caller that puts this device's own records
  // first still wins the tie on an account both lists name — and a caller whose
  // list is drawn in this order (the settings picker) is not reordered by having
  // been deduped. Records are held by their position rather than by identity,
  // because the two lists can carry the same record object (the aggregate holds
  // this device's own records too) and a set of records would count it twice.
  //
  // One record stands for the whole group, so the union of the members' keys
  // rides out on it. Two copies of one account need not carry the same member of
  // the family: the Hub's collapse keeps the canonical key on the record and the
  // keys it replaced beside it as aliases (limits/core.js), so a device whose own
  // row for that account holds the credential's own hash — an opencode API key
  // with no cookie, whose row is keyed by the key alone — would keep only that
  // one, and a binding made on the device that holds the canonical key would stop
  // resolving. The aliases are the place the producer already records them for
  // exactly this reason (providers/opencode/limits.js). The survivor is copied
  // rather than amended in place: the caller's list is app state.
  function withGroupKeyFamily(record, group) {
    const own = accountKeyFamily(record);
    const missing = [...group.keys].filter((key) => !own.has(key));
    if (missing.length === 0) return record;
    const held = Array.isArray(record.accountKeyAliases) ? record.accountKeyAliases : [];
    return { ...record, accountKeyAliases: [...held, ...missing] };
  }

  function dedupeAccounts(records) {
    const list = (records || []).filter(Boolean);
    const indexesByProvider = new Map();
    for (let index = 0; index < list.length; index += 1) {
      const provider = String(list[index].provider || '').trim().toLowerCase();
      if (!indexesByProvider.has(provider)) indexesByProvider.set(provider, []);
      indexesByProvider.get(provider).push(index);
    }
    const emailOf = (record) => accountEmailOf(record).toLowerCase();
    const survivors = new Map();
    for (const indexes of indexesByProvider.values()) {
      const inProvider = indexes.map((index) => list[index]);
      const groups = keyedAccountGroups(inProvider, emailOf);
      const namedEmails = new Set(groups.flatMap((group) => [...group.emails]));
      // A group keeps its first member in input order, which is what preserves
      // the caller's own priority between two copies of one account.
      for (const group of groups) {
        survivors.set(indexes[group.survivor], withGroupKeyFamily(list[indexes[group.survivor]], group));
      }
      const keptKeylessEmails = new Set();
      let keptAnonymous = false;
      for (let position = 0; position < inProvider.length; position += 1) {
        const record = inProvider[position];
        if (accountKeyFamily(record).size > 0) continue;
        const email = emailOf(record);
        if (!email) {
          if (keptAnonymous) continue;
          keptAnonymous = true;
          survivors.set(indexes[position], record);
          continue;
        }
        if (namedEmails.has(email) || keptKeylessEmails.has(email)) continue;
        keptKeylessEmails.add(email);
        survivors.set(indexes[position], record);
      }
    }
    return list.map((record, index) => survivors.get(index)).filter(Boolean);
  }

  // Default account title for providers that identify accounts by email or name.
  function accountTitleLabel(account, peers = [account], options = {}) {
    const resolvedPeers = Array.isArray(peers) && peers.length > 0 ? peers : [account];
    const baseLabelFor = (peer) => {
      const name = String(peer?.accountName || '').trim();
      return accountEmailLabel(peer, resolvedPeers, {
        maskEmail: options.maskEmail === true,
        suffix: name
      }) || name;
    };
    return uniqueAccountLabel(account, resolvedPeers, baseLabelFor, { index: options.index });
  }

  function codexAccountMatchesProvider(account, provider) {
    if (!account || !provider || provider.provider !== 'codex') return false;
    const accountKey = String(account.accountKey || '').trim();
    const providerKey = String(provider.accountKey || '').trim();
    if (accountKey && providerKey) return accountKey === providerKey;
    const accountEmail = String(account.email || account.accountEmail || '').trim().toLowerCase();
    const providerEmail = String(provider.accountEmail || provider.email || '').trim().toLowerCase();
    return Boolean(accountEmail && providerEmail && accountEmail === providerEmail);
  }

  function codexAccountIdForProvider(accounts, provider) {
    return (accounts || []).find((account) => codexAccountMatchesProvider(account, provider))?.id || '';
  }

  function codexManagedAccountPlanLabel(account, providers = []) {
    const provider = (providers || []).find((candidate) => (
      candidate?.status === 'ok' && codexAccountMatchesProvider(account, candidate)
    ));
    return String(provider?.accountLabel || account?.accountLabel || '').trim();
  }

  function isCodexLiveAccount(provider) {
    return String(provider?.provider || '').trim().toLowerCase() === 'codex'
      && String(provider?.status || '').trim() === 'ok'
      && String(provider?.sourceDetail || '').trim().toLowerCase() !== 'managed';
  }

  function localDeviceLimitsProviders(stats, localDeviceId = '') {
    const devices = stats?.devices;
    if (!Array.isArray(devices)) return null;
    const local = localDeviceId
      ? devices.find((device) => device?.deviceId === localDeviceId)
      : (devices.length === 1 ? devices[0] : null);
    return local?.limits?.providers || [];
  }

  function localLiveCodexProvider(stats, localDeviceId = '') {
    const localProviders = localDeviceLimitsProviders(stats, localDeviceId);
    const providers = localProviders !== null ? localProviders : (stats?.limits?.providers || []);
    return providers.find(isCodexLiveAccount) || null;
  }

  return {
    accountEmailLabel,
    accountKeyFamily,
    accountTitleLabel,
    codexAccountDisplayLabel,
    codexAccountIdForProvider,
    codexAccountMatchesProvider,
    codexManagedAccountPlanLabel,
    dedupeAccounts,
    isCodexLiveAccount,
    localDeviceLimitsProviders,
    localLiveCodexProvider,
    maskEmailAddress,
    sameAccount
  };
});
