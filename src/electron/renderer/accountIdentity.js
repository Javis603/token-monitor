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
    accountTitleLabel,
    codexAccountDisplayLabel,
    codexAccountIdForProvider,
    codexAccountMatchesProvider,
    codexManagedAccountPlanLabel,
    isCodexLiveAccount,
    localDeviceLimitsProviders,
    localLiveCodexProvider,
    maskEmailAddress
  };
});
