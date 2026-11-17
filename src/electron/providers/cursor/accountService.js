'use strict';

const cursorAuth = require('../../../shared/providers/cursor/auth');
const { normalizeCursorDisabledAccountIds, normalizeCursorAccountIds } = require('../../runtimeConfig');
const cursorProbe = require('../../../shared/providers/cursor/probe');
const { isCursorDetectedAccountCurrent } = require('../../../shared/providers/cursor/account');

/**
 * Owns cursor account workflows and process-local state.
 * @param {object} deps Provider-scoped persistence and named host IO capabilities.
 */
function createCursorAccountService(deps) {
  const { isExternalAgentActive, getCursorDisabledAccountIds, getCursorManualAccountIds, setCursorDisabledAccountIds, setCursorManualAccountIds, saveSettings, reconfigureLimits, queueLimitInvalidation, refreshUsage, auth = cursorAuth, probe = cursorProbe } = deps;
  let cursorStatusCache = { value: null, at: 0 };
  const CURSOR_STATUS_TTL_MS = 30 * 1000;
  const CURSOR_EXTERNAL_AGENT_ERROR = 'Stop the headless agent before managing Cursor accounts.';
  const normalizeManualCookie = input => auth.normalizeCursorSessionToken(input);
  async function cursorStatusValue({ discover = false } = {}) {
    const managementBlocked = isExternalAgentActive();
    let accounts = auth.listAccounts();
    if (discover && !managementBlocked) {
      try { await auth.runCursorDiscover(); } catch (_) { /* signed-out or unavailable Cursor app */ }
      accounts = auth.listAccounts();
    }
    const disabled = new Set(normalizeCursorDisabledAccountIds(getCursorDisabledAccountIds()));
    const manual = new Set(normalizeCursorAccountIds(getCursorManualAccountIds()));
    const desktop = auth.readCursorDesktopSignIn();
    const listedAccounts = await Promise.all(accounts.map(async (account) => {
      const probeResult = await probe.probe(account.sessionToken);
      const expired = !probeResult.ok && probeResult.error?.kind === 'unauthorized';
      // Desktop-detected accounts follow the desktop sign-in; manual ones stay
      // until removed. Hidden accounts keep their credentials and usage history.
      if (!manual.has(account.id) && !isCursorDetectedAccountCurrent({
        desktop,
        userId: auth.canonicalCursorUserId(account.userId || account.id),
        unauthorized: expired
      })) return null;
      return {
        id: account.id,
        enabled: !disabled.has(account.id),
        removable: manual.has(account.id),
        email: probeResult.ok ? probeResult.user?.email || '' : '',
        label: account.label || '',
        membershipType: probeResult.ok ? probeResult.usage.membershipType || '' : '',
        expired,
        error: probeResult.ok ? '' : probeResult.error?.message || ''
      };
    }));
    const safeAccounts = listedAccounts.filter(Boolean);
    return {
      loggedIn: safeAccounts.length > 0,
      accounts: safeAccounts,
      linkedCount: safeAccounts.filter((account) => account.enabled && !account.expired && !account.error).length,
      managementBlocked
    };
  }

  async function loginManual(raw) {
      if (isExternalAgentActive()) {
        return { ok: false, code: 'EXTERNAL_AGENT_ACTIVE', error: CURSOR_EXTERNAL_AGENT_ERROR };
      }
      const token = normalizeManualCookie(raw);
      if (!token) return { ok: false, error: 'Empty or malformed token' };
      try {
        const probeResult = await probe.probe(token);
        if (!probeResult.ok) return { ok: false, error: probeResult.error?.message || 'Cursor rejected the token' };
        const accountId = await auth.runCursorLogin(token);
        const disabled = normalizeCursorDisabledAccountIds(getCursorDisabledAccountIds())
          .filter((id) => id !== accountId);
        setCursorDisabledAccountIds(disabled);
        setCursorManualAccountIds(normalizeCursorAccountIds([
          ...getCursorManualAccountIds(),
          accountId
        ]));
        saveSettings({ throwOnError: true });
        reconfigureLimits();
        cursorStatusCache = { value: null, at: 0 };
        void queueLimitInvalidation({ provider: 'cursor' }, 'login', { clear: true });
        refreshUsage();
        return { ok: true, email: probeResult.user.email, status: await cursorStatusValue() };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

  async function setAccountEnabled(accountId, enabled) {
      try {
        const id = String(accountId || '').trim();
        if (!id || !auth.listAccounts().some((account) => account.id === id)) {
          return { ok: false, error: 'Cursor account not found' };
        }
        const disabled = new Set(normalizeCursorDisabledAccountIds(getCursorDisabledAccountIds()));
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        setCursorDisabledAccountIds([...disabled]);
        saveSettings({ throwOnError: true });
        cursorStatusCache = { value: null, at: 0 };
        reconfigureLimits();
        void queueLimitInvalidation({ provider: 'cursor' }, 'account-toggle', { clear: true });
        return { ok: true, status: await cursorStatusValue() };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

  async function logout(accountId) {
      if (isExternalAgentActive()) {
        return { ok: false, code: 'EXTERNAL_AGENT_ACTIVE', error: CURSOR_EXTERNAL_AGENT_ERROR };
      }
      try {
        const removeId = String(accountId || '').trim();
        const manual = new Set(normalizeCursorAccountIds(getCursorManualAccountIds()));
        if (!removeId || !manual.has(removeId)) {
          return { ok: false, error: 'Only manually added Cursor accounts can be removed' };
        }
        await auth.runCursorLogout({ accountId: removeId });
        const disabled = normalizeCursorDisabledAccountIds(getCursorDisabledAccountIds())
          .filter((id) => id !== removeId);
        setCursorDisabledAccountIds(disabled);
        setCursorManualAccountIds([...manual].filter((id) => id !== removeId));
        saveSettings({ throwOnError: true });
        reconfigureLimits();
        cursorStatusCache = { value: null, at: 0 };
        void queueLimitInvalidation({ provider: 'cursor' }, 'logout', { clear: true });
        refreshUsage();
        return { ok: true, status: await cursorStatusValue() };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

  async function status(options = {}) {
      const now = Date.now();
      if (options?.force !== true && options?.discover !== true && cursorStatusCache.value && now - cursorStatusCache.at < CURSOR_STATUS_TTL_MS) {
        return cursorStatusCache.value;
      }
      const value = await cursorStatusValue({ discover: options?.discover === true });
      cursorStatusCache = { value, at: now };
      return value;
    }
  return { cursorStatusValue, loginManual, setAccountEnabled, logout, status };
}
module.exports = { createCursorAccountService };
