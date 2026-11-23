'use strict';

const { normalizeWorkspaceId, listCodexWorkspaces } = require('../../../shared/providers/codex/workspaces');
const { codexManagedAccountIdentityKey, upgradeCodexManagedAccountIdentity, codexAuthIdentity, preserveCodexManagedHydrationCollisions, codexManagedAccountMatchesIdentity, hashAccountKey, codexAccountKey } = require('../../../shared/providers/codex/auth');
const path = require('node:path');
const { readRegularFileNoFollow } = require('../../../shared/credentialStore');
const fs = require('node:fs');
const { writeCodexAuthFile, readCodexAuthMaterial, liveCodexAuthPath, codexAccountMatchesIdentity, codexAuthMaterialForWorkspace } = require('../../../shared/providers/codex/systemSwitch');
const { runCodexLogin } = require('../../../shared/limits/collector');
const crypto = require('node:crypto');
const { codexLoginUrlFromOutput } = require('../../../shared/providers/codex/login');

/**
 * Owns codex account workflows and process-local state.
 * @param {object} deps Provider-scoped persistence and named host IO capabilities.
 */
function createCodexAccountService(deps) {
  const { getLimitsRuntime, isEnabled, getCodexManagedAccounts, electronProviderDeps, setCodexManagedAccounts, saveSettings, pushSettingsToRenderer, queueLimitInvalidation, getUserDataPath, env = process.env, runLogin = runCodexLogin, listWorkspaces = listCodexWorkspaces } = deps;
  let codexLoginController = null;
  let codexLoginFlowId = '';
  let codexLoginCanCancel = false;
  let codexWorkspaceSelection = null;
  let systemSwitchInFlight = false;
  async function login(request = {}, { ownerId, onStatus }) {
    const flowId = String(request?.flowId || '').trim();
    if (codexLoginController) return { ok: false, error: 'A Codex sign-in is already in progress.', flowId };
    const controller = new AbortController();
    codexLoginController = controller;
    codexLoginFlowId = flowId;
    codexLoginCanCancel = true;
    let streamed = '';
    const sendStatus = (payload) => {
      if (codexLoginController !== controller) return;
      onStatus({ ...payload, flowId });
    };
    try {
      const result = await addCodexManagedAccount((text) => {
        streamed = (streamed + String(text || '')).slice(-8000);
        sendStatus({
          phase: 'output',
          text: String(text || ''),
          loginUrl: codexLoginUrlFromOutput(streamed)
        });
      }, {
        signal: controller.signal,
        selectWorkspace: ({ email, currentWorkspaceId, workspaces }) => new Promise((resolve) => {
          const finish = (workspaceId) => {
            if (codexWorkspaceSelection?.controller === controller) codexWorkspaceSelection = null;
            controller.signal.removeEventListener('abort', onAbort);
            resolve(workspaceId);
          };
          const onAbort = () => finish('');
          codexWorkspaceSelection = {
            controller,
            flowId,
            webContentsId: ownerId,
            workspaceIds: new Set(workspaces.map((workspace) => workspace.id)),
            finish
          };
          controller.signal.addEventListener('abort', onAbort, { once: true });
          sendStatus({
            phase: 'workspaceSelection',
            email,
            currentWorkspaceId,
            workspaces: workspaces.map(({ id, label, workspaceKind }) => ({ id, label, workspaceKind }))
          });
        }),
        onCommit: () => {
          if (codexLoginController === controller) codexLoginCanCancel = false;
        }
      });
      if (codexLoginController !== controller) {
        return { ok: false, error: codexLoginErrorMessage({ outcome: 'cancelled' }), outcome: 'cancelled', flowId };
      }
      return { ...result, flowId };
    } finally {
      if (codexLoginController === controller) {
        if (codexWorkspaceSelection?.controller === controller) codexWorkspaceSelection.finish('');
        codexLoginController = null;
        codexLoginFlowId = '';
        codexLoginCanCancel = false;
      }
    }
  }
  function selectWorkspace(request = {}, ownerId) {
    const flowId = String(request?.flowId || '').trim();
    const workspaceId = normalizeWorkspaceId(request?.workspaceId);
    const pending = codexWorkspaceSelection;
    if (!pending || pending.webContentsId !== ownerId) return { ok: false, stale: true };
    if (flowId && pending.flowId && flowId !== pending.flowId) return { ok: false, stale: true };
    if (!workspaceId || !pending.workspaceIds.has(workspaceId)) {
      return { ok: false, error: 'Unknown Codex workspace.' };
    }
    pending.finish(workspaceId);
    return { ok: true };
  }
  function cancelLogin(request = {}) {
    const flowId = String(request?.flowId || '').trim();
    if (flowId && codexLoginFlowId && flowId !== codexLoginFlowId) return { ok: true, cancelled: false };
    const controller = codexLoginController;
    if (!controller) return { ok: true, cancelled: false };
    if (!codexLoginCanCancel) return { ok: false, cancelled: false, tooLate: true };
    controller?.abort();
    return { ok: true, cancelled: true };
  }
  async function switchSystemAccount(id, publish) {
    if (systemSwitchInFlight) return { ok: false, error: 'A Codex account switch is already in progress.' };
    systemSwitchInFlight = true;
    try {
      const result = await performCodexSystemAccountSwitch(id);
      if (result?.ok) await publish(result);
      return result;
    } finally { systemSwitchInFlight = false; }
  }
  let codexWorkspaceLabelHydrationPromise = null;
  const CODEX_WORKSPACE_LABEL_HYDRATION_CONCURRENCY = 3;
  function normalizeCodexManagedAccounts(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const accounts = [];
    for (const account of value) {
      if (!account || typeof account !== 'object') continue;
      const id = String(account.id || '').trim();
      const homePath = String(account.homePath || '').trim();
      if (!id || !homePath) continue;
      const email = String(account.email || '').trim().toLowerCase();
      const workspaceAccountId = normalizeWorkspaceId(
        account.workspaceAccountId
        || account.providerAccountId
      );
      const rawWorkspaceLabel = String(account.workspaceLabel || '').trim();
      const workspaceKind = account.workspaceKind === 'personal' ? 'personal' : '';
      const accountKey = String(account.accountKey || '').trim();
      const dedupe = codexManagedAccountIdentityKey({
        id,
        accountKey,
        email,
        workspaceAccountId
      });
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      accounts.push({
        id,
        email,
        accountKey,
        accountLabel: String(account.accountLabel || '').trim(),
        workspaceAccountId,
        workspaceLabel: workspaceKind ? '' : rawWorkspaceLabel,
        workspaceKind,
        homePath,
        authPath: String(account.authPath || path.join(homePath, 'auth.json')).trim(),
        addedAt: account.addedAt || new Date().toISOString(),
        updatedAt: account.updatedAt || account.addedAt || new Date().toISOString(),
        enabled: account.enabled !== false
      });
    }
    return accounts;
  }

  function hydrateCodexManagedAccounts(value) {
    const storedAccounts = normalizeCodexManagedAccounts(value);
    const hydratedAccounts = storedAccounts.map((account) => {
      try {
        const auth = JSON.parse(readRegularFileNoFollow(account.authPath, {
          fs,
          description: 'Managed Codex auth',
          encoding: 'utf8'
        }));
        return upgradeCodexManagedAccountIdentity(account, codexAuthIdentity(auth));
      } catch (_) {
        return account;
      }
    });
    const resolvedAccounts = preserveCodexManagedHydrationCollisions(storedAccounts, hydratedAccounts);
    if (resolvedAccounts.some((account, index) => account !== hydratedAccounts[index])) {
      console.warn('[codex] Managed account identity hydration found a collision; preserved stored identities.');
    }
    return resolvedAccounts;
  }

  function hydrateCodexManagedWorkspaceLabels() {
    if (codexWorkspaceLabelHydrationPromise) return codexWorkspaceLabelHydrationPromise;
    if (
      !isEnabled()
    ) return Promise.resolve(false);
    const candidates = normalizeCodexManagedAccounts(getCodexManagedAccounts())
      .filter((account) => (
        account.enabled !== false
        && account.workspaceAccountId
        && !account.workspaceLabel
        && !account.workspaceKind
      ));
    if (candidates.length === 0) return Promise.resolve(false);

    const task = mapWithConcurrency(
      candidates,
      CODEX_WORKSPACE_LABEL_HYDRATION_CONCURRENCY,
      async (account) => {
        try {
          const auth = JSON.parse(readRegularFileNoFollow(account.authPath, {
            fs,
            description: 'Managed Codex auth',
            encoding: 'utf8'
          }));
          const workspaces = await listWorkspaces(auth, electronProviderDeps({ env: env }));
          const workspace = workspaces.find((entry) => entry.id === account.workspaceAccountId);
          return workspace
            ? {
                id: account.id,
                workspaceAccountId: account.workspaceAccountId,
                label: workspace.label,
                workspaceKind: workspace.workspaceKind
              }
            : null;
        } catch (_) {
          return null;
        }
      }
    ).then((results) => {
      const labels = new Map(
        results.filter(Boolean).map((result) => [result.id, result])
      );
      if (labels.size === 0) return false;
      let changed = false;
      const accounts = normalizeCodexManagedAccounts(getCodexManagedAccounts()).map((account) => {
        const resolved = labels.get(account.id);
        if (!resolved || account.enabled === false || account.workspaceAccountId !== resolved.workspaceAccountId) {
          return account;
        }
        const shouldHydrateLabel = !account.workspaceLabel && !account.workspaceKind;
        if (!shouldHydrateLabel) return account;
        changed = true;
        return {
          ...account,
          ...(shouldHydrateLabel ? {
            workspaceLabel: resolved.label,
            workspaceKind: resolved.workspaceKind
          } : {}),
          updatedAt: new Date().toISOString()
        };
      });
      if (!changed) return false;
      setCodexManagedAccounts(accounts);
      saveSettings();
      pushSettingsToRenderer();
      void queueLimitInvalidation({ provider: 'codex' }, 'workspace-label-hydrated');
      return true;
    });

    codexWorkspaceLabelHydrationPromise = task.finally(() => {
      codexWorkspaceLabelHydrationPromise = null;
    });
    return codexWorkspaceLabelHydrationPromise;
  }

  async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }
    const workerCount = Math.min(items.length, Math.max(1, Math.trunc(concurrency) || 1));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  function codexAccountsForRenderer() {
    return normalizeCodexManagedAccounts(getCodexManagedAccounts()).map(({
      id, email, accountKey, accountLabel, workspaceAccountId, workspaceLabel, workspaceKind, addedAt, updatedAt, enabled
    }) => ({
      id,
      email,
      accountKey,
      accountLabel,
      workspaceAccountId,
      workspaceLabel,
      workspaceKind,
      addedAt,
      updatedAt,
      enabled
    }));
  }

  function codexManagedAccountsForCollector() {
    return normalizeCodexManagedAccounts(getCodexManagedAccounts());
  }

  function codexManagedRoot() {
    return path.join(getUserDataPath(), 'managed-codex-homes');
  }

  function codexManagedHomePath(accountId) {
    const resolvedRoot = path.resolve(codexManagedRoot());
    const resolvedHome = path.resolve(resolvedRoot, String(accountId || ''));
    if (resolvedHome === resolvedRoot) return '';
    if (!resolvedHome.startsWith(`${resolvedRoot}${path.sep}`)) return '';
    return resolvedHome;
  }

  function findExistingCodexAccount(accounts, identity) {
    return accounts.find((account) => codexManagedAccountMatchesIdentity(account, identity));
  }

  function codexAccountId(identity, existing) {
    if (existing?.id) return existing.id;
    return `codex-${(identity.accountKey || hashAccountKey(identity.email)).replace(/^sha256:/, '').slice(0, 12)}`;
  }

  async function removeManagedHomeIfSafe(homePath) {
    if (!homePath) return;
    const resolvedHome = path.resolve(homePath);
    const resolvedRoot = path.resolve(codexManagedRoot());
    if (resolvedHome === resolvedRoot) return;
    if (!resolvedHome.startsWith(`${resolvedRoot}${path.sep}`)) return;
    await fs.promises.rm(resolvedHome, { recursive: true, force: true });
  }

  function commitCodexManagedAccount(identity, homePath, existing, options = {}) {
    const now = new Date().toISOString();
    const id = codexAccountId(identity, existing);
    const accounts = normalizeCodexManagedAccounts(getCodexManagedAccounts());
    const record = {
      id,
      email: identity.email,
      accountKey: identity.accountKey || hashAccountKey(identity.email || id),
      accountLabel: identity.accountLabel,
      workspaceAccountId: identity.workspaceAccountId || identity.providerAccountId || '',
      workspaceLabel: String(identity.workspaceLabel || '').trim(),
      workspaceKind: identity.workspaceKind === 'personal' ? 'personal' : '',
      homePath,
      authPath: path.join(homePath, 'auth.json'),
      addedAt: existing?.addedAt || now,
      updatedAt: now,
      enabled: options.enabled ?? true
    };
    setCodexManagedAccounts(normalizeCodexManagedAccounts([
      ...accounts.filter((account) => account.id !== id),
      record
    ]));
    if (options.persist !== false) saveSettings({ throwOnError: true });
    return codexAccountsForRenderer().find((account) => account.id === id);
  }

  function hasCodexIdentity(identity) {
    return Boolean(identity?.accountKey || identity?.email);
  }

  async function snapshotCodexAuthFile(authPath) {
    let parentExisted = true;
    try { await fs.promises.stat(path.dirname(authPath)); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      parentExisted = false;
    }
    try {
      return { authPath, data: await fs.promises.readFile(authPath, 'utf8'), existed: true, parentExisted };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return { authPath, data: '', existed: false, parentExisted };
    }
  }

  async function restoreCodexAuthFileSnapshot(snapshot, options = {}) {
    if (snapshot.existed) {
      await writeCodexAuthFile(snapshot.authPath, snapshot.data);
      return;
    }
    await fs.promises.rm(snapshot.authPath, { force: true });
    if (options.removeNewParent && !snapshot.parentExisted) {
      await removeManagedHomeIfSafe(path.dirname(snapshot.authPath));
    }
  }

  async function preserveLiveCodexAuthAsManagedAccount(targetIdentity) {
    let liveMaterial;
    try {
      liveMaterial = await readCodexAuthMaterial(liveCodexAuthPath(env));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('Could not read live Codex auth before switching accounts:', error?.message || error);
      return null;
    }
    if (!hasCodexIdentity(liveMaterial.identity)) return null;
    if (codexAccountMatchesIdentity(targetIdentity, liveMaterial.identity)) return null;
    const accounts = normalizeCodexManagedAccounts(getCodexManagedAccounts());
    const existing = findExistingCodexAccount(accounts, liveMaterial.identity);
    const homePath = codexManagedHomePath(codexAccountId(liveMaterial.identity, existing));
    if (!homePath) return null;
    const authSnapshot = await snapshotCodexAuthFile(path.join(homePath, 'auth.json'));
    try {
      await writeCodexAuthFile(authSnapshot.authPath, liveMaterial.data);
      const account = commitCodexManagedAccount(liveMaterial.identity, homePath, existing, {
        enabled: existing?.enabled ?? true,
        persist: false,
        restart: false
      });
      return {
        account,
        rollback: () => restoreCodexAuthFileSnapshot(authSnapshot, { removeNewParent: true })
      };
    } catch (error) {
      await restoreCodexAuthFileSnapshot(authSnapshot, { removeNewParent: true }).catch(() => {});
      throw error;
    }
  }

  function codexLoginErrorMessage(result) {
    const detail = result.output ? `\n\n${result.output}` : '';
    switch (result.outcome) {
      case 'missingBinary':
        return 'Codex CLI not found. Install Codex, then try again.';
      case 'launchFailed':
        return `Could not start codex login.${detail}`;
      case 'timedOut':
        return `Sign-in timed out. Finish the browser login, then try again.${detail}`;
      case 'cancelled':
        return 'Sign-in cancelled.';
      default:
        return `codex login failed.${detail}`;
    }
  }

  function cancelledCodexLoginResult() {
    return {
      ok: false,
      error: codexLoginErrorMessage({ outcome: 'cancelled' }),
      outcome: 'cancelled'
    };
  }

  async function rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal) {
    if (movedToFinal) await removeManagedHomeIfSafe(homePath);
    if (backupHomePath) await fs.promises.rename(backupHomePath, homePath);
  }

  async function resolveCodexWorkspaceAfterLogin(auth, _homePath, options = {}) {
    const initialIdentity = codexAuthIdentity(auth);
    let workspaces;
    try {
      workspaces = await listWorkspaces(auth, electronProviderDeps({
        env: env,
        signal: options.signal
      }));
    } catch (error) {
      if (options.signal?.aborted) return { cancelled: true };
      console.warn('Could not list Codex workspaces after sign-in:', error?.message || error);
      return { auth, identity: initialIdentity };
    }
    if (options.signal?.aborted) return { cancelled: true };
    if (workspaces.length === 0) return { auth, identity: initialIdentity };

    const currentWorkspaceId = normalizeWorkspaceId(initialIdentity.workspaceAccountId);
    let selected;
    if (workspaces.length === 1) {
      selected = workspaces[0];
    } else if (typeof options.selectWorkspace === 'function') {
      const selectedId = normalizeWorkspaceId(await options.selectWorkspace({
        email: initialIdentity.email,
        currentWorkspaceId,
        workspaces
      }));
      if (!selectedId || options.signal?.aborted) return { cancelled: true };
      selected = workspaces.find((workspace) => workspace.id === selectedId) || null;
      if (!selected) throw new Error('The selected Codex workspace is no longer available.');
    } else {
      selected = workspaces.find((workspace) => workspace.id === currentWorkspaceId) || null;
    }
    if (!selected) return { auth, identity: initialIdentity };

    const workspaceAccountId = normalizeWorkspaceId(selected.id);
    return {
      auth,
      identity: {
        ...initialIdentity,
        providerAccountId: workspaceAccountId,
        workspaceAccountId,
        accountKey: codexAccountKey(initialIdentity.email, workspaceAccountId),
        workspaceLabel: selected.label,
        workspaceKind: selected.workspaceKind
      }
    };
  }

  async function addCodexManagedAccount(onOutput, options = {}) {
    await fs.promises.mkdir(codexManagedRoot(), { recursive: true });
    const tempHome = path.join(codexManagedRoot(), `pending-${crypto.randomUUID()}`);
    await fs.promises.mkdir(tempHome, { recursive: true });
    let backupHomePath = '';
    let movedToFinal = false;
    let accountCommitted = false;
    try {
      const result = await runLogin({ homePath: tempHome, onOutput, signal: options.signal }, { env: env });
      if (result.outcome !== 'success') {
        return { ok: false, error: codexLoginErrorMessage(result), outcome: result.outcome };
      }
      if (options.signal?.aborted) return cancelledCodexLoginResult();
      let auth;
      try {
        auth = JSON.parse(await fs.promises.readFile(path.join(tempHome, 'auth.json'), 'utf8'));
      } catch (_) {
        return { ok: false, error: 'Sign-in finished but no Codex credentials were written.' };
      }
      const workspaceResult = await resolveCodexWorkspaceAfterLogin(auth, tempHome, options);
      if (workspaceResult.cancelled) return cancelledCodexLoginResult();
      auth = workspaceResult.auth;
      const identity = workspaceResult.identity;
      if (!identity.accountKey && !identity.email) {
        return { ok: false, error: 'Could not identify the Codex account after sign-in.' };
      }
      if (options.signal?.aborted) return cancelledCodexLoginResult();
      const existing = findExistingCodexAccount(normalizeCodexManagedAccounts(getCodexManagedAccounts()), identity);
      const homePath = codexManagedHomePath(codexAccountId(identity, existing));
      if (!homePath) return { ok: false, error: 'The saved Codex account path is invalid.' };
      if (path.resolve(homePath) !== path.resolve(tempHome)) {
        if (options.signal?.aborted) return cancelledCodexLoginResult();
        const candidateBackupPath = `${homePath}.backup-${crypto.randomUUID()}`;
        try {
          await fs.promises.rename(homePath, candidateBackupPath);
          backupHomePath = candidateBackupPath;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (options.signal?.aborted) {
          await rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal);
          backupHomePath = '';
          return cancelledCodexLoginResult();
        }
        try {
          await fs.promises.rename(tempHome, homePath);
          movedToFinal = true;
        } catch (error) {
          await rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal);
          backupHomePath = '';
          throw error;
        }
        if (options.signal?.aborted) {
          await rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal);
          backupHomePath = '';
          movedToFinal = false;
          return cancelledCodexLoginResult();
        }
      }
      if (options.signal?.aborted) {
        await rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal);
        backupHomePath = '';
        movedToFinal = false;
        return cancelledCodexLoginResult();
      }
      const previousAccounts = getCodexManagedAccounts();
      options.onCommit?.();
      let account;
      try {
        account = commitCodexManagedAccount(identity, homePath, existing, { restart: false });
        if (backupHomePath) {
          await removeManagedHomeIfSafe(backupHomePath);
          backupHomePath = '';
        }
        accountCommitted = true;
      } catch (error) {
        setCodexManagedAccounts(previousAccounts);
        try {
          saveSettings();
        } catch (rollbackError) {
          console.warn('Could not restore Codex account settings:', rollbackError?.message || rollbackError);
        }
        await rollbackCodexManagedHome(homePath, backupHomePath, movedToFinal);
        backupHomePath = '';
        movedToFinal = false;
        throw error;
      }
      void queueLimitInvalidation({
        provider: 'codex',
        accountId: account.id,
        accountKey: account.accountKey || ''
      }, 'account-added');
      return { ok: true, account };
    } finally {
      if (!accountCommitted) await removeManagedHomeIfSafe(tempHome).catch(() => {});
    }
  }

  async function removeCodexManagedAccount(id) {
    const accountId = String(id || '').trim();
    const accounts = normalizeCodexManagedAccounts(getCodexManagedAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    setCodexManagedAccounts(accounts.filter((entry) => entry.id !== accountId));
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist account removal' };
    }
    await removeManagedHomeIfSafe(account.homePath);
    void queueLimitInvalidation({ provider: 'codex', accountId, accountKey: account.accountKey || '' }, 'account-removed', {
      clear: true,
      refresh: false
    });
    return { ok: true, accounts: codexAccountsForRenderer() };
  }

  function setCodexManagedAccountEnabled(id, enabled) {
    const accountId = String(id || '').trim();
    const accounts = normalizeCodexManagedAccounts(getCodexManagedAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    account.enabled = Boolean(enabled);
    setCodexManagedAccounts(accounts);
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not persist account state' };
    }
    void queueLimitInvalidation({ provider: 'codex', accountId, accountKey: account.accountKey || '' }, 'account-state', {
      clear: !account.enabled,
      refresh: account.enabled
    });
    return { ok: true, accounts: codexAccountsForRenderer() };
  }

  async function performCodexSystemAccountSwitch(id) {
    const accountId = String(id || '').trim();
    const accounts = normalizeCodexManagedAccounts(getCodexManagedAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    if (account.enabled === false) return { ok: false, error: 'Account is disabled' };

    let targetMaterial;
    try {
      targetMaterial = await readCodexAuthMaterial(account.authPath || path.join(account.homePath, 'auth.json'));
    } catch (error) {
      return { ok: false, error: `Could not read the selected Codex account credentials: ${error?.message || error}` };
    }
    if (!hasCodexIdentity(targetMaterial.identity)) {
      return { ok: false, error: 'Could not identify the selected Codex account credentials.' };
    }
    let selectedMaterial;
    try {
      selectedMaterial = codexAuthMaterialForWorkspace(targetMaterial, account.workspaceAccountId);
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not prepare the selected Codex workspace.' };
    }
    const targetIdentity = {
      ...selectedMaterial.identity,
      workspaceLabel: account.workspaceLabel,
      workspaceKind: account.workspaceKind
    };

    const previousAccounts = normalizeCodexManagedAccounts(getCodexManagedAccounts());
    const liveAuthPath = liveCodexAuthPath(env);
    let liveAuthSnapshot;
    try {
      liveAuthSnapshot = await snapshotCodexAuthFile(liveAuthPath);
    } catch (error) {
      return { ok: false, error: `Could not back up the local Codex account: ${error?.message || error}` };
    }
    let preservedLiveAccount = null;
    try {
      preservedLiveAccount = await preserveLiveCodexAuthAsManagedAccount(targetIdentity);
      await writeCodexAuthFile(liveAuthPath, selectedMaterial.data);
      const refreshedAccounts = normalizeCodexManagedAccounts(getCodexManagedAccounts());
      const refreshed = refreshedAccounts.find((entry) => entry.id === account.id) || account;
      commitCodexManagedAccount(targetIdentity, refreshed.homePath, refreshed, {
        enabled: refreshed.enabled !== false,
        restart: false
      });
      const activeAccountId = codexAccountId(targetIdentity, refreshed);
      const accountsForRenderer = codexAccountsForRenderer();
      return {
        ok: true,
        activeAccountId,
        activeAccount: accountsForRenderer.find((entry) => entry.id === activeAccountId) || null,
        accounts: accountsForRenderer
      };
    } catch (error) {
      setCodexManagedAccounts(previousAccounts);
      const rollbackErrors = [];
      try { await restoreCodexAuthFileSnapshot(liveAuthSnapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      try { await preservedLiveAccount?.rollback?.(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      const rollbackDetail = rollbackErrors.length > 0
        ? ` Rollback also failed: ${rollbackErrors.map((rollbackError) => rollbackError?.message || rollbackError).join('; ')}`
        : '';
      return { ok: false, error: `Could not switch the local Codex account: ${error?.message || error}.${rollbackDetail}` };
    }
  }
  async function refreshCodexManagedAccountLimits(id, reason = 'account-refresh') {
    const accountId = String(id || '').trim();
    const accounts = normalizeCodexManagedAccounts(getCodexManagedAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    if (account.enabled === false) return { ok: false, error: 'Account is disabled' };
    if (!getLimitsRuntime()) return { ok: false, error: 'Limits runtime is not ready' };
    try {
      const result = await getLimitsRuntime().refreshLimits({
        provider: 'codex',
        accountId: account.id,
        accountKey: account.accountKey || ''
      }, reason);
      const summary = result?.snapshot || getLimitsRuntime().getSnapshot()?.limits;
      const providers = (summary?.providers || []).filter((provider) => {
        if (provider?.provider !== 'codex') return false;
        if (account.accountKey) return provider.accountKey === account.accountKey;
        if (account.email) return String(provider.accountEmail || '').toLowerCase() === account.email;
        return provider.sourceDetail === 'managed';
      });
      return {
        ok: true,
        providers
      };
    } catch (error) {
      return { ok: false, error: `Could not refresh Codex account limits: ${error?.message || error}` };
    }
  }

  return { refreshCodexManagedAccountLimits, login, selectWorkspace, cancelLogin, switchSystemAccount, normalizeCodexManagedAccounts, hydrateCodexManagedAccounts, hydrateCodexManagedWorkspaceLabels, mapWithConcurrency, codexAccountsForRenderer, codexManagedAccountsForCollector, codexManagedRoot, codexManagedHomePath, findExistingCodexAccount, codexAccountId, removeManagedHomeIfSafe, commitCodexManagedAccount, hasCodexIdentity, snapshotCodexAuthFile, restoreCodexAuthFileSnapshot, preserveLiveCodexAuthAsManagedAccount, codexLoginErrorMessage, cancelledCodexLoginResult, rollbackCodexManagedHome, resolveCodexWorkspaceAfterLogin, addCodexManagedAccount, removeCodexManagedAccount, setCodexManagedAccountEnabled, performCodexSystemAccountSwitch };
}
module.exports = { createCodexAccountService };
