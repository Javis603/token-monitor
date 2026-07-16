'use strict';

(function exposeOccupancyPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorOccupancyPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createOccupancyPresentationApi() {
  const LIGHTS = new Set(['green', 'yellow', 'red', 'gray']);

  function text(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
  }

  function count(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
  }

  function normalizedLight(value, activeCount, threshold, enabled) {
    if (!enabled) return 'gray';
    const explicit = text(value).toLowerCase();
    if (explicit === 'grey') return 'gray';
    if (LIGHTS.has(explicit)) return explicit;
    if (activeCount === 0) return 'green';
    return activeCount >= threshold ? 'red' : 'yellow';
  }

  function normalizeTask(raw, index) {
    const task = raw && typeof raw === 'object' ? raw : {};
    return {
      id: text(task.id ?? task.taskId, `task-${index + 1}`),
      deviceName: text(task.deviceName ?? task.hostname ?? task.deviceId, ''),
      taskLabel: text(task.taskLabel ?? task.label ?? task.taskId, ''),
      projectLabel: text(task.projectLabel ?? task.project, ''),
      source: text(task.source, 'manual'),
      reliability: text(task.reliability, '')
    };
  }

  function normalizeQuota(raw) {
    const quota = raw && typeof raw === 'object' ? raw : {};
    const remaining = Number(quota.minimumRemainingPercent);
    return {
      linkState: text(quota.linkState, 'unlinked'),
      matchBasis: text(quota.matchBasis, 'none'),
      provider: text(quota.provider, ''),
      accountLabel: text(quota.accountLabel, ''),
      status: text(quota.status, ''),
      updatedAt: text(quota.updatedAt, ''),
      sourceDeviceId: text(quota.sourceDeviceId, ''),
      stale: quota.stale === true,
      minimumRemainingPercent: Number.isFinite(remaining) ? Math.max(0, Math.min(100, remaining)) : null,
      light: normalizedLight(quota.light, 0, 1, quota.linkState === 'linked')
    };
  }

  function normalizeAccount(raw, index) {
    const account = raw && typeof raw === 'object' ? raw : {};
    const taskValues = Array.isArray(account.tasks)
      ? account.tasks
      : (Array.isArray(account.leases) ? account.leases : []);
    const tasks = taskValues.map(normalizeTask);
    const recentTasks = (Array.isArray(account.recentTasks) ? account.recentTasks : []).map((task, taskIndex) => ({
      ...normalizeTask(task, taskIndex),
      status: text(task?.status, 'completed'),
      endedAt: text(task?.endedAt, '')
    }));
    const threshold = Math.max(1, count(
      account.advisoryThreshold ?? account.capacity ?? account.maxConcurrent ?? account.maxConcurrency,
      1
    ));
    const activeCount = count(account.activeCount ?? account.currentConcurrency, tasks.length);
    const enabled = account.enabled !== false;
    return {
      id: text(account.id ?? account.accountId, `account-${index + 1}`),
      provider: text(account.provider ?? account.vendor, 'unknown'),
      alias: text(account.alias ?? account.label ?? account.name, `Account ${index + 1}`),
      maskedIdentity: text(account.maskedIdentity ?? account.identity, ''),
      threshold,
      activeCount,
      enabled,
      light: normalizedLight(account.light ?? account.status, activeCount, threshold, enabled),
      reliability: text(account.reliability, 'estimated'),
      quota: normalizeQuota(account.quota),
      tasks,
      recentTasks
    };
  }

  function normalizeSnapshot(value) {
    const snapshot = value?.occupancy && typeof value.occupancy === 'object' ? value.occupancy : value;
    if (!snapshot || typeof snapshot !== 'object') return null;
    const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts.map(normalizeAccount) : [];
    return {
      generatedAt: text(snapshot.generatedAt ?? snapshot.updatedAt, ''),
      accounts
    };
  }

  function occupancySummary(snapshot) {
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    return accounts.reduce((summary, account) => {
      summary.accounts += 1;
      summary.activeTasks += count(account.activeCount);
      if (account.light === 'red') summary.advisory += 1;
      return summary;
    }, { accounts: 0, activeTasks: 0, advisory: 0 });
  }

  function viewKind(hubMode, snapshot) {
    if (String(hubMode || 'local') === 'local') return 'local';
    if (!snapshot) return 'unavailable';
    return snapshot.accounts.length === 0 ? 'empty' : 'accounts';
  }

  return { normalizeAccount, normalizeQuota, normalizeSnapshot, occupancySummary, viewKind };
});
