'use strict';

(function occupancyDashboardFactory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OccupancyDashboard = api;
}(typeof window !== 'undefined' ? window : null, function occupancyDashboardModule() {
  const LIGHTS = new Set(['green', 'yellow', 'red', 'gray']);

  function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clampCount(value, fallback = 0) {
    return Math.max(0, Math.floor(finiteNumber(value, fallback)));
  }

  function firstText(...values) {
    for (const value of values) {
      const text = String(value == null ? '' : value).trim();
      if (text) return text;
    }
    return '';
  }

  function unwrapSnapshot(payload) {
    if (!payload || typeof payload !== 'object') return {};
    if (payload.occupancy && typeof payload.occupancy === 'object') return payload.occupancy;
    if (payload.data?.occupancy && typeof payload.data.occupancy === 'object') return payload.data.occupancy;
    if (payload.data && typeof payload.data === 'object') return payload.data;
    return payload;
  }

  function accountList(snapshot) {
    if (Array.isArray(snapshot.accounts)) return snapshot.accounts;
    if (Array.isArray(snapshot.items)) return snapshot.items;
    if (!Array.isArray(snapshot.providers)) return [];
    return snapshot.providers.flatMap((provider) => {
      const accounts = Array.isArray(provider?.accounts) ? provider.accounts : [];
      return accounts.map((account) => ({ ...account, provider: account.provider || provider.id || provider.name }));
    });
  }

  function normalizeTask(task, index) {
    const value = task && typeof task === 'object' ? task : {};
    return {
      id: firstText(value.id, value.taskId, `task-${index + 1}`),
      deviceId: firstText(value.deviceId, value.device),
      deviceName: firstText(value.deviceName, value.hostname, value.deviceId, value.device, '未知设备'),
      taskLabel: firstText(value.taskLabel, value.label, value.taskId, '未命名任务'),
      projectLabel: firstText(value.projectLabel, value.project, value.workspace),
      source: firstText(value.source, 'manual'),
      confidence: firstText(value.confidence),
      startedAt: firstText(value.startedAt, value.createdAt),
      lastHeartbeatAt: firstText(value.lastHeartbeatAt, value.heartbeatAt, value.updatedAt),
      expiresAt: firstText(value.expiresAt)
    };
  }

  function derivedLight(activeCount, capacity, reliability) {
    if (reliability === 'unknown') return 'gray';
    if (activeCount <= 0) return 'green';
    if (activeCount >= capacity) return 'red';
    return 'yellow';
  }

  function normalizeLight(value, activeCount, capacity, reliability) {
    const candidate = firstText(value).toLowerCase();
    if (candidate === 'amber' || candidate === 'orange') return 'yellow';
    if (candidate === 'unknown' || candidate === 'offline' || candidate === 'stale') return 'gray';
    return LIGHTS.has(candidate) ? candidate : derivedLight(activeCount, capacity, reliability);
  }

  function normalizeAccount(account, index) {
    const value = account && typeof account === 'object' ? account : {};
    const tasksSource = Array.isArray(value.tasks)
      ? value.tasks
      : (Array.isArray(value.leases) ? value.leases : (Array.isArray(value.activeTasks) ? value.activeTasks : []));
    const tasks = tasksSource.map(normalizeTask);
    const recentTasks = (Array.isArray(value.recentTasks) ? value.recentTasks : []).map((task, taskIndex) => ({
      ...normalizeTask(task, taskIndex),
      status: firstText(task?.status, 'completed'),
      endedAt: firstText(task?.endedAt)
    }));
    const capacity = Math.max(1, clampCount(value.advisoryThreshold ?? value.capacity ?? value.maxConcurrent ?? value.limit, 1));
    const activeCount = clampCount(value.activeCount ?? value.current ?? value.inUse, tasks.length);
    const remaining = Math.max(0, clampCount(value.remaining ?? value.availableSlots, capacity - activeCount));
    const reliability = firstText(value.reliability, value.fresh === false ? 'unknown' : 'fresh').toLowerCase();
    const provider = firstText(value.provider, value.vendor, 'unknown');
    const light = normalizeLight(value.light ?? value.status, activeCount, capacity, reliability);
    return {
      id: firstText(value.id, value.accountId, `${provider}-${index + 1}`),
      provider,
      alias: firstText(value.alias, value.label, value.name, value.maskedIdentity, `账号 ${index + 1}`),
      maskedIdentity: firstText(value.maskedIdentity, value.identity, value.email),
      quotaLink: value.quotaLink && typeof value.quotaLink === 'object' ? { ...value.quotaLink } : null,
      quota: value.quota && typeof value.quota === 'object' ? { ...value.quota } : null,
      enabled: value.enabled !== false,
      capacity,
      activeCount,
      remaining,
      light,
      reliability: light === 'gray' ? 'unknown' : reliability,
      tasks,
      recentTasks
    };
  }

  function normalizeSnapshot(payload) {
    const snapshot = unwrapSnapshot(payload);
    const accounts = accountList(snapshot).map(normalizeAccount);
    const quotaCandidates = (Array.isArray(snapshot.quotaCandidates) ? snapshot.quotaCandidates : [])
      .filter((candidate) => candidate && typeof candidate === 'object')
      .map((candidate) => ({ ...candidate }));
    return {
      version: finiteNumber(snapshot.version, 1),
      generatedAt: firstText(snapshot.generatedAt, snapshot.updatedAt, payload?.at),
      quotaCandidates,
      accounts
    };
  }

  function snapshotSummary(snapshot) {
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    return accounts.reduce((summary, account) => {
      summary.accounts += 1;
      summary.active += clampCount(account.activeCount);
      if (account.reliability !== 'unknown') summary.available += clampCount(account.remaining);
      if (account.light === 'red' || (account.capacity > 0 && account.activeCount >= account.capacity)) summary.full += 1;
      return summary;
    }, { accounts: 0, active: 0, available: 0, full: 0 });
  }

  function parseSseBlock(block) {
    let event = 'message';
    const data = [];
    for (const rawLine of String(block || '').split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'event') event = value || 'message';
      if (field === 'data') data.push(value);
    }
    if (data.length === 0) return null;
    const rawData = data.join('\n');
    try { return { event, data: JSON.parse(rawData) }; }
    catch (_) { return { event, data: rawData }; }
  }

  async function readSse(response, onEvent, signal) {
    if (!response.body?.getReader) throw new Error('stream_not_supported');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const parsed = parseSseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (parsed) onEvent(parsed);
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  function providerPresentation(provider) {
    const normalized = firstText(provider, 'unknown').toLowerCase();
    const known = {
      anthropic: ['Anthropic', 'AN', '#e9a978', 'rgba(233,169,120,.12)'],
      claude: ['Claude', 'CL', '#e9a978', 'rgba(233,169,120,.12)'],
      openai: ['OpenAI', 'OA', '#72d3ad', 'rgba(114,211,173,.12)'],
      chatgpt: ['ChatGPT', 'CG', '#72d3ad', 'rgba(114,211,173,.12)'],
      codex: ['Codex', 'CX', '#91a3ff', 'rgba(145,163,255,.12)'],
      google: ['Google', 'GO', '#74a8ff', 'rgba(116,168,255,.12)'],
      gemini: ['Gemini', 'GE', '#74a8ff', 'rgba(116,168,255,.12)'],
      cursor: ['Cursor', 'CU', '#d6dcff', 'rgba(214,220,255,.1)'],
      github: ['GitHub', 'GH', '#d9dce2', 'rgba(217,220,226,.1)']
    };
    const match = known[normalized];
    if (match) return { name: match[0], initials: match[1], color: match[2], background: match[3] };
    const display = normalized === 'unknown' ? '其他' : normalized.replace(/(^|[-_\s])\w/g, (part) => part.toUpperCase());
    return { name: display, initials: display.slice(0, 2), color: '#b5bdc9', background: 'rgba(181,189,201,.1)' };
  }

  function loadLeaseCredentials(storage) {
    try {
      const parsed = JSON.parse(storage.getItem('occupancyLeaseCredentials') || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter(([leaseId, value]) => (
        leaseId && value && typeof value === 'object' && firstText(value.fenceToken)
      )));
    } catch (_) {
      return {};
    }
  }

  function apiErrorMessage(error, fallback = '操作失败，请稍后重试') {
    const code = firstText(error?.code, error?.message);
    const messages = {
      unauthorized: 'Hub 密钥无效，请检查连接设置。',
      capacity_exceeded: '旧版 Hub 阻止了这次登记；请升级到纯建议版本。',
      account_full: '旧版 Hub 阻止了这次登记；请升级到纯建议版本。',
      account_disabled: '这个账号已停用，暂时不能占用。',
      account_not_found: '账号不存在，状态可能已被其他设备更新。',
      lease_not_found: '任务已过期或已经被释放。',
      fence_token_invalid: '无法释放：当前浏览器持有的任务凭证已失效。',
      fence_token_required: '无法释放：缺少当前任务的释放凭证。',
      alias_required: '请填写账号别名。',
      provider_required: '请填写服务商。',
      capacity_invalid: '建议切换阈值必须是大于 0 的整数。',
      deviceId_required: '请填写设备 ID。'
    };
    return messages[code] || firstText(error?.serverMessage, fallback);
  }

  function randomClientToken(cryptoApi, prefix) {
    if (typeof cryptoApi?.randomUUID === 'function') return `${prefix}-${cryptoApi.randomUUID()}`;
    if (typeof cryptoApi?.getRandomValues !== 'function') throw new Error('secure_random_unavailable');
    const bytes = cryptoApi.getRandomValues(new Uint8Array(18));
    return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  function pendingLeaseAttempt(storage, cryptoApi, accountId, deviceId) {
    let pending = {};
    try {
      const parsed = JSON.parse(storage.getItem('occupancyPendingLeases') || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) pending = parsed;
    } catch (_) {}
    const key = `${encodeURIComponent(accountId)}:${encodeURIComponent(deviceId)}`;
    if (!pending[key]?.fenceToken || !pending[key]?.idempotencyKey) {
      pending[key] = {
        accountId,
        deviceId,
        fenceToken: randomClientToken(cryptoApi, 'fence'),
        idempotencyKey: randomClientToken(cryptoApi, 'web')
      };
      storage.setItem('occupancyPendingLeases', JSON.stringify(pending));
    }
    return { key, attempt: pending[key] };
  }

  function clearPendingLeaseAttempt(storage, key) {
    let pending;
    try { pending = JSON.parse(storage.getItem('occupancyPendingLeases') || '{}'); }
    catch (_) { return; }
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return;
    delete pending[key];
    if (Object.keys(pending).length > 0) storage.setItem('occupancyPendingLeases', JSON.stringify(pending));
    else storage.removeItem('occupancyPendingLeases');
  }

  function createRuntime(doc, runtimeWindow) {
    const elements = {
      accountGrid: doc.getElementById('accountGrid'),
      emptyState: doc.getElementById('emptyState'),
      providerFilters: doc.getElementById('providerFilters'),
      stateFilter: doc.getElementById('stateFilter'),
      searchInput: doc.getElementById('searchInput'),
      visibleCount: doc.getElementById('visibleCount'),
      updatedAt: doc.getElementById('updatedAt'),
      connectionBadge: doc.getElementById('connectionBadge'),
      connectionText: doc.getElementById('connectionText'),
      refreshButton: doc.getElementById('refreshButton'),
      settingsButton: doc.getElementById('settingsButton'),
      settingsDialog: doc.getElementById('settingsDialog'),
      settingsForm: doc.getElementById('settingsForm'),
      closeSettingsButton: doc.getElementById('closeSettingsButton'),
      clearSecretButton: doc.getElementById('clearSecretButton'),
      secretInput: doc.getElementById('secretInput'),
      addAccountButton: doc.getElementById('addAccountButton'),
      errorBanner: doc.getElementById('errorBanner'),
      errorText: doc.getElementById('errorText'),
      dismissErrorButton: doc.getElementById('dismissErrorButton'),
      accountDialog: doc.getElementById('accountDialog'),
      accountForm: doc.getElementById('accountForm'),
      accountDialogTitle: doc.getElementById('accountDialogTitle'),
      accountIdInput: doc.getElementById('accountIdInput'),
      providerInput: doc.getElementById('providerInput'),
      aliasInput: doc.getElementById('aliasInput'),
      maskedIdentityInput: doc.getElementById('maskedIdentityInput'),
      quotaCandidateInput: doc.getElementById('quotaCandidateInput'),
      capacityInput: doc.getElementById('capacityInput'),
      enabledField: doc.getElementById('enabledField'),
      enabledInput: doc.getElementById('enabledInput'),
      deleteAccountButton: doc.getElementById('deleteAccountButton'),
      saveAccountButton: doc.getElementById('saveAccountButton'),
      leaseDialog: doc.getElementById('leaseDialog'),
      leaseForm: doc.getElementById('leaseForm'),
      leaseAccountIdInput: doc.getElementById('leaseAccountIdInput'),
      leaseAccountName: doc.getElementById('leaseAccountName'),
      deviceIdInput: doc.getElementById('deviceIdInput'),
      deviceNameInput: doc.getElementById('deviceNameInput'),
      taskLabelInput: doc.getElementById('taskLabelInput'),
      projectLabelInput: doc.getElementById('projectLabelInput'),
      acquireLeaseButton: doc.getElementById('acquireLeaseButton'),
      accountCardTemplate: doc.getElementById('accountCardTemplate'),
      metrics: {
        available: doc.getElementById('availableMetric'),
        active: doc.getElementById('activeMetric'),
        accounts: doc.getElementById('accountMetric'),
        full: doc.getElementById('fullMetric')
      }
    };
    const state = {
      snapshot: { generatedAt: '', accounts: [] },
      provider: 'all',
      status: 'all',
      search: '',
      abortController: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      secret: runtimeWindow.sessionStorage.getItem('occupancyHubSecret') || '',
      leaseCredentials: loadLeaseCredentials(runtimeWindow.sessionStorage)
    };

    function persistLeaseCredentials() {
      runtimeWindow.sessionStorage.setItem('occupancyLeaseCredentials', JSON.stringify(state.leaseCredentials));
    }

    function showError(error, fallback) {
      elements.errorText.textContent = apiErrorMessage(error, fallback);
      elements.errorBanner.hidden = false;
      const openDialog = doc.querySelector('dialog[open]');
      if (openDialog) {
        let dialogError = openDialog.querySelector('.dialog-error');
        if (!dialogError) {
          dialogError = doc.createElement('div');
          dialogError.className = 'dialog-error';
          dialogError.setAttribute('role', 'alert');
          openDialog.querySelector('form')?.prepend(dialogError);
        }
        dialogError.textContent = elements.errorText.textContent;
      }
    }

    function clearError() {
      elements.errorBanner.hidden = true;
      elements.errorText.textContent = '';
      for (const dialogError of doc.querySelectorAll('.dialog-error')) dialogError.remove();
    }

    function setConnection(kind, text) {
      elements.connectionBadge.className = `connection is-${kind}`;
      elements.connectionText.textContent = text;
    }

    function formattedTime(value) {
      if (!value) return '刚刚更新';
      const time = new Date(value);
      if (Number.isNaN(time.getTime())) return '刚刚更新';
      return `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time)}`;
    }

    function taskLabel(task) {
      return firstText(task.taskLabel, task.projectLabel, task.source, '未命名任务');
    }

    function appendTaskRows(container, account) {
      if (account.tasks.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'task-empty';
        empty.textContent = account.reliability === 'unknown'
          ? '等待设备上报'
          : (account.activeCount > 0 ? '正在使用，任务详情未上报' : '空闲，可分配新任务');
        container.appendChild(empty);
      } else {
        const ownedTasks = account.tasks.filter((task) => state.leaseCredentials[task.id]);
        const otherTasks = account.tasks.filter((task) => !state.leaseCredentials[task.id]);
        const visibleTasks = [...ownedTasks, ...otherTasks.slice(0, Math.max(0, 3 - ownedTasks.length))];
        for (const task of visibleTasks) {
          const row = doc.createElement('div');
          row.className = 'task-row';
          const main = doc.createElement('span');
          main.className = 'task-main';
          main.textContent = taskLabel(task);
          main.title = [task.taskLabel, task.projectLabel].filter(Boolean).join(' · ');
          const device = doc.createElement('span');
          device.className = 'task-device';
          device.textContent = task.deviceName;
          row.append(main, device);
          const credential = state.leaseCredentials[task.id];
          if (credential) {
            const release = doc.createElement('button');
            release.type = 'button';
            release.className = 'release-button';
            release.dataset.releaseLeaseId = task.id;
            release.textContent = '释放';
            release.title = '释放当前浏览器创建的任务';
            row.appendChild(release);
          }
          container.appendChild(row);
        }
        if (account.tasks.length > visibleTasks.length) {
          const more = doc.createElement('div');
          more.className = 'more-tasks';
          more.textContent = `另有 ${account.tasks.length - visibleTasks.length} 个任务`;
          container.appendChild(more);
        }
      }
      if (account.recentTasks.length > 0) {
        const heading = doc.createElement('div');
        heading.className = 'recent-task-heading';
        heading.textContent = '最近结束';
        container.appendChild(heading);
        const labels = { completed: '已完成', failed: '失败', stopped: '已停止', expired: '上报过期' };
        for (const task of account.recentTasks.slice(0, 3)) {
          const row = doc.createElement('div');
          row.className = `task-row recent-task is-${task.status}`;
          const main = doc.createElement('span');
          main.className = 'task-main';
          main.textContent = `${labels[task.status] || task.status} · ${taskLabel(task)}`;
          const device = doc.createElement('span');
          device.className = 'task-device';
          device.textContent = task.deviceName;
          row.append(main, device);
          container.appendChild(row);
        }
      }
    }

    function cardForAccount(account) {
      const card = elements.accountCardTemplate.content.firstElementChild.cloneNode(true);
      const provider = providerPresentation(account.provider);
      card.dataset.light = account.light;
      card.dataset.accountId = account.id;
      card.classList.toggle('is-disabled', !account.enabled);
      const avatar = card.querySelector('.provider-avatar');
      avatar.textContent = provider.initials;
      avatar.style.setProperty('--avatar-color', provider.color);
      avatar.style.setProperty('--avatar-bg', provider.background);
      card.querySelector('.provider-name').textContent = provider.name;
      card.querySelector('.account-alias').textContent = account.alias;
      const identity = card.querySelector('.masked-identity');
      identity.textContent = account.maskedIdentity || `ID · ${account.id}`;
      card.querySelector('.active-count').textContent = String(account.activeCount);
      card.querySelector('.capacity-total').textContent = `/ ${account.capacity}`;
      const capacityLabel = card.querySelector('.capacity-label');
      capacityLabel.textContent = !account.enabled
        ? '账号已停用'
        : account.reliability === 'unknown'
        ? '状态未知'
        : (account.remaining > 0 ? `距建议阈值 ${account.remaining} · 未实测延迟` : '已达建议切换阈值 · 未实测延迟');
      card.style.setProperty('--capacity-percent', `${Math.min(100, (account.activeCount / account.capacity) * 100)}%`);
      card.querySelector('.task-count').textContent = `${account.tasks.length} 个`;
      const occupyButton = card.querySelector('.occupy-button');
      occupyButton.disabled = !account.enabled;
      occupyButton.textContent = !account.enabled ? '已停用' : (account.remaining <= 0 ? '仍要登记' : '登记占用');
      const quotaSummary = card.querySelector('.quota-summary');
      if (account.quota?.linkState === 'linked' || account.quota?.linkState === 'stale') {
        const remaining = Number(account.quota.minimumRemainingPercent);
        const percent = Number.isFinite(remaining) ? `${remaining}%` : '额度已连接';
        const source = account.quota.sourceDeviceId ? ` · ${account.quota.sourceDeviceId}` : '';
        const stale = account.quota.linkState === 'stale' ? ' · 数据已过期' : '';
        quotaSummary.textContent = `剩余额度 ${percent}${source}${stale}`;
        quotaSummary.dataset.light = account.quota.light || 'gray';
        quotaSummary.hidden = false;
      } else if (account.quota?.linkState === 'ambiguous') {
        quotaSummary.textContent = '额度账号映射不确定，请重新绑定';
        quotaSummary.dataset.light = 'gray';
        quotaSummary.hidden = false;
      } else if (account.quota?.linkState === 'missing') {
        quotaSummary.textContent = '已绑定的额度账号当前未上报';
        quotaSummary.dataset.light = 'gray';
        quotaSummary.hidden = false;
      }
      appendTaskRows(card.querySelector('.task-list'), account);
      const readableStatus = !account.enabled
        ? '已停用'
        : { green: '预计可用', yellow: '可能拥挤', red: '建议切换', gray: '数据不足' }[account.light];
      card.setAttribute('aria-label', `${provider.name} ${account.alias}，${readableStatus}，${account.activeCount}/${account.capacity} 个任务`);
      return card;
    }

    function visibleAccounts() {
      const query = state.search.toLocaleLowerCase('zh-CN');
      const lightOrder = { green: 0, yellow: 1, red: 2, gray: 3 };
      return state.snapshot.accounts.filter((account) => {
        if (state.provider !== 'all' && account.provider.toLowerCase() !== state.provider) return false;
        if (state.status === 'available' && (!account.enabled || account.remaining <= 0)) return false;
        if (state.status === 'busy' && account.activeCount <= 0) return false;
        if (state.status === 'full' && account.light !== 'red') return false;
        if (!query) return true;
        const haystack = [account.provider, account.alias, account.maskedIdentity, account.id,
          ...account.tasks.flatMap((task) => [task.deviceName, task.taskLabel, task.projectLabel])]
          .join(' ').toLocaleLowerCase('zh-CN');
        return haystack.includes(query);
      }).sort((left, right) => {
        const statusDelta = lightOrder[left.light] - lightOrder[right.light];
        if (statusDelta !== 0) return statusDelta;
        const providerDelta = left.provider.localeCompare(right.provider);
        return providerDelta || left.alias.localeCompare(right.alias);
      });
    }

    function renderFilters() {
      const counts = new Map();
      for (const account of state.snapshot.accounts) {
        const key = account.provider.toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      if (state.provider !== 'all' && !counts.has(state.provider)) state.provider = 'all';
      const entries = [['all', '全部', state.snapshot.accounts.length], ...[...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, count]) => [id, providerPresentation(id).name, count])];
      elements.providerFilters.replaceChildren(...entries.map(([id, label, count]) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = `filter-button${state.provider === id ? ' is-active' : ''}`;
        button.dataset.provider = id;
        button.setAttribute('aria-pressed', String(state.provider === id));
        button.append(doc.createTextNode(label));
        const badge = doc.createElement('span');
        badge.className = 'filter-count';
        badge.textContent = String(count);
        button.appendChild(badge);
        return button;
      }));
    }

    function render() {
      const summary = snapshotSummary(state.snapshot);
      for (const [key, value] of Object.entries(summary)) elements.metrics[key].textContent = String(value);
      elements.updatedAt.textContent = formattedTime(state.snapshot.generatedAt);
      renderFilters();
      const accounts = visibleAccounts();
      elements.accountGrid.replaceChildren(...accounts.map(cardForAccount));
      elements.accountGrid.setAttribute('aria-busy', 'false');
      elements.visibleCount.textContent = `${accounts.length} 个`;
      elements.emptyState.hidden = accounts.length !== 0;
      elements.accountGrid.hidden = accounts.length === 0;
    }

    function applyPayload(payload) {
      state.snapshot = normalizeSnapshot(payload);
      const liveLeaseIds = new Set(state.snapshot.accounts.flatMap((account) => account.tasks.map((task) => task.id)));
      let credentialsChanged = false;
      for (const leaseId of Object.keys(state.leaseCredentials)) {
        if (!liveLeaseIds.has(leaseId)) {
          delete state.leaseCredentials[leaseId];
          credentialsChanged = true;
        }
      }
      if (credentialsChanged) persistLeaseCredentials();
      render();
      setConnection('live', '实时连接');
      state.reconnectAttempt = 0;
    }

    async function fetchSnapshot() {
      const headers = state.secret ? { Authorization: `Bearer ${state.secret}` } : {};
      const response = await runtimeWindow.fetch('/api/occupancy', { headers, cache: 'no-store' });
      if (!response.ok) throw new Error(`snapshot_http_${response.status}`);
      applyPayload(await response.json());
    }

    async function apiRequest(pathname, { method = 'GET', body, fenceToken } = {}) {
      const headers = { Accept: 'application/json' };
      if (state.secret) headers.Authorization = `Bearer ${state.secret}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (fenceToken) headers['x-occupancy-fence-token'] = fenceToken;
      const response = await runtimeWindow.fetch(pathname, {
        method,
        headers,
        cache: 'no-store',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      let payload = {};
      try { payload = await response.json(); } catch (_) {}
      if (!response.ok) {
        const error = new Error(firstText(payload.error, `http_${response.status}`));
        error.code = firstText(payload.error, `http_${response.status}`);
        error.serverMessage = firstText(payload.message);
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    function accountById(accountId) {
      return state.snapshot.accounts.find((account) => account.id === accountId);
    }

    function openAccountDialog(account = null) {
      clearError();
      elements.accountForm.reset();
      const editing = Boolean(account);
      elements.accountDialogTitle.textContent = editing ? '编辑账号' : '添加账号';
      elements.accountIdInput.value = account?.id || '';
      elements.providerInput.value = account?.provider || '';
      elements.aliasInput.value = account?.alias || '';
      elements.maskedIdentityInput.value = account?.maskedIdentity || '';
      const quotaOptions = [new Option('不关联额度', '')];
      state.snapshot.quotaCandidates.forEach((candidate, index) => {
        const identity = candidate.maskedEmail || candidate.accountLabel || '已检测账号';
        const device = candidate.sourceDeviceId ? ` · ${candidate.sourceDeviceId}` : '';
        quotaOptions.push(new Option(`${candidate.provider} · ${identity}${device}`, String(index)));
      });
      elements.quotaCandidateInput.replaceChildren(...quotaOptions);
      const link = account?.quotaLink;
      const linkedIndex = link ? state.snapshot.quotaCandidates.findIndex((candidate) => (
        candidate.provider === link.provider
        && ((link.accountKey && candidate.accountKey === link.accountKey)
          || (link.accountEmailHash && candidate.accountEmailHash === link.accountEmailHash))
      )) : -1;
      if (link && linkedIndex < 0) {
        const keep = new Option('保留当前绑定（额度暂不可用）', 'keep');
        elements.quotaCandidateInput.append(keep);
        elements.quotaCandidateInput.value = 'keep';
      } else {
        elements.quotaCandidateInput.value = linkedIndex >= 0 ? String(linkedIndex) : '';
      }
      elements.capacityInput.value = String(account?.capacity || 1);
      elements.enabledInput.checked = account?.enabled !== false;
      elements.enabledField.hidden = !editing;
      elements.deleteAccountButton.hidden = !editing;
      elements.accountDialog.showModal();
      elements.providerInput.focus();
    }

    function openLeaseDialog(account) {
      clearError();
      elements.leaseForm.reset();
      elements.leaseAccountIdInput.value = account.id;
      elements.leaseAccountName.textContent = account.alias;
      elements.deviceIdInput.value = runtimeWindow.sessionStorage.getItem('occupancyDeviceId') || '';
      elements.deviceNameInput.value = runtimeWindow.sessionStorage.getItem('occupancyDeviceName') || '';
      elements.leaseDialog.showModal();
      elements.deviceIdInput.focus();
    }

    async function saveAccount(event) {
      event.preventDefault();
      clearError();
      const accountId = elements.accountIdInput.value;
      const editing = Boolean(accountId);
      const body = {
        provider: elements.providerInput.value.trim(),
        alias: elements.aliasInput.value.trim(),
        maskedIdentity: elements.maskedIdentityInput.value.trim(),
        capacity: Number(elements.capacityInput.value),
        ...(editing ? { enabled: elements.enabledInput.checked } : {})
      };
      const quotaSelection = elements.quotaCandidateInput.value;
      if (quotaSelection !== 'keep') {
        const candidate = state.snapshot.quotaCandidates[Number(quotaSelection)];
        body.quotaLink = candidate ? {
          provider: candidate.provider,
          accountKey: candidate.accountKey || '',
          accountEmailHash: candidate.accountEmailHash || '',
          accountLabel: candidate.accountLabel || ''
        } : null;
      }
      elements.saveAccountButton.disabled = true;
      try {
        const result = await apiRequest(editing
          ? `/api/occupancy/accounts/${encodeURIComponent(accountId)}`
          : '/api/occupancy/accounts', { method: editing ? 'PATCH' : 'POST', body });
        if (result.occupancy) applyPayload(result.occupancy);
        elements.accountDialog.close();
      } catch (error) {
        showError(error, editing ? '账号保存失败' : '账号添加失败');
      } finally {
        elements.saveAccountButton.disabled = false;
      }
    }

    async function deleteAccount() {
      const accountId = elements.accountIdInput.value;
      const account = accountById(accountId);
      if (!account || !runtimeWindow.confirm(`确定删除“${account.alias}”吗？该账号的所有占用记录也会被删除。`)) return;
      elements.deleteAccountButton.disabled = true;
      try {
        const result = await apiRequest(`/api/occupancy/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
        for (const [leaseId, credential] of Object.entries(state.leaseCredentials)) {
          if (credential.accountId === accountId) delete state.leaseCredentials[leaseId];
        }
        persistLeaseCredentials();
        if (result.occupancy) applyPayload(result.occupancy);
        elements.accountDialog.close();
      } catch (error) {
        showError(error, '账号删除失败');
      } finally {
        elements.deleteAccountButton.disabled = false;
      }
    }

    async function acquireLease(event) {
      event.preventDefault();
      clearError();
      const body = {
        accountId: elements.leaseAccountIdInput.value,
        deviceId: elements.deviceIdInput.value.trim(),
        deviceName: elements.deviceNameInput.value.trim(),
        taskLabel: elements.taskLabelInput.value.trim(),
        projectLabel: elements.projectLabelInput.value.trim(),
        source: 'manual'
      };
      elements.acquireLeaseButton.disabled = true;
      try {
        const { key, attempt } = pendingLeaseAttempt(
          runtimeWindow.sessionStorage, runtimeWindow.crypto, body.accountId, body.deviceId
        );
        body.fenceToken = attempt.fenceToken;
        body.idempotencyKey = attempt.idempotencyKey;
        const result = await apiRequest('/api/occupancy/leases', { method: 'POST', body });
        const lease = result.lease || {};
        if (!lease.id || !lease.fenceToken) throw new Error('lease_credentials_missing');
        state.leaseCredentials[lease.id] = { fenceToken: lease.fenceToken, accountId: body.accountId };
        persistLeaseCredentials();
        clearPendingLeaseAttempt(runtimeWindow.sessionStorage, key);
        runtimeWindow.sessionStorage.setItem('occupancyDeviceId', body.deviceId);
        if (body.deviceName) runtimeWindow.sessionStorage.setItem('occupancyDeviceName', body.deviceName);
        if (result.occupancy) applyPayload(result.occupancy);
        elements.leaseDialog.close();
      } catch (error) {
        showError(error, '登记失败，请检查账号状态和设备信息');
      } finally {
        elements.acquireLeaseButton.disabled = false;
      }
    }

    async function releaseLease(leaseId) {
      const credential = state.leaseCredentials[leaseId];
      if (!credential) return;
      clearError();
      try {
        const result = await apiRequest(`/api/occupancy/leases/${encodeURIComponent(leaseId)}`, {
          method: 'DELETE', body: { fenceToken: credential.fenceToken }, fenceToken: credential.fenceToken
        });
        delete state.leaseCredentials[leaseId];
        persistLeaseCredentials();
        if (result.occupancy) applyPayload(result.occupancy);
      } catch (error) {
        if (error.code === 'lease_not_found') {
          delete state.leaseCredentials[leaseId];
          persistLeaseCredentials();
          connect();
        }
        showError(error, '任务释放失败');
      }
    }

    async function heartbeatOwnedLeases() {
      let latestSnapshot = null;
      let credentialsChanged = false;
      for (const [leaseId, credential] of Object.entries(state.leaseCredentials)) {
        try {
          const result = await apiRequest(`/api/occupancy/leases/${encodeURIComponent(leaseId)}/heartbeat`, {
            method: 'POST', body: { fenceToken: credential.fenceToken }, fenceToken: credential.fenceToken
          });
          if (result.occupancy) latestSnapshot = result.occupancy;
        } catch (error) {
          if (error.code === 'lease_not_found' || error.code === 'fence_token_invalid') {
            delete state.leaseCredentials[leaseId];
            credentialsChanged = true;
          }
        }
      }
      if (credentialsChanged) persistLeaseCredentials();
      if (latestSnapshot) applyPayload(latestSnapshot);
    }

    function scheduleReconnect() {
      runtimeWindow.clearTimeout(state.reconnectTimer);
      const delay = Math.min(15000, 1000 * (2 ** state.reconnectAttempt));
      state.reconnectAttempt += 1;
      state.reconnectTimer = runtimeWindow.setTimeout(connect, delay);
    }

    async function openStream(pathname, signal) {
      const headers = { Accept: 'text/event-stream' };
      if (state.secret) headers.Authorization = `Bearer ${state.secret}`;
      const response = await runtimeWindow.fetch(pathname, { headers, cache: 'no-store', signal });
      if (!response.ok) {
        const error = new Error(`stream_http_${response.status}`);
        error.status = response.status;
        throw error;
      }
      await readSse(response, ({ data }) => {
        if (data && typeof data === 'object') applyPayload(data);
      }, signal);
    }

    async function connect() {
      if (state.abortController) state.abortController.abort();
      runtimeWindow.clearTimeout(state.reconnectTimer);
      state.abortController = new AbortController();
      const { signal } = state.abortController;
      setConnection('connecting', '正在连接');
      try {
        await fetchSnapshot();
        try {
          await openStream('/api/occupancy/events', signal);
        } catch (error) {
          if (error.status === 404 && !signal.aborted) await openStream('/api/occupancy/stream', signal);
          else throw error;
        }
        if (!signal.aborted) throw new Error('stream_closed');
      } catch (error) {
        if (signal.aborted) return;
        setConnection('error', error.status === 401 || error.message.includes('401') ? '需要密钥' : '连接中断');
        scheduleReconnect();
      }
    }

    function bindEvents() {
      elements.providerFilters.addEventListener('click', (event) => {
        const button = event.target.closest('[data-provider]');
        if (!button) return;
        state.provider = button.dataset.provider;
        render();
      });
      elements.stateFilter.addEventListener('change', () => { state.status = elements.stateFilter.value; render(); });
      elements.searchInput.addEventListener('input', () => { state.search = elements.searchInput.value.trim(); render(); });
      elements.refreshButton.addEventListener('click', connect);
      elements.addAccountButton.addEventListener('click', () => openAccountDialog());
      elements.dismissErrorButton.addEventListener('click', clearError);
      elements.accountGrid.addEventListener('click', (event) => {
        const card = event.target.closest('[data-account-id]');
        if (!card) return;
        const account = accountById(card.dataset.accountId);
        if (!account) return;
        if (event.target.closest('.edit-account-button')) openAccountDialog(account);
        // The threshold controls only the advisory light. Even a red account
        // can be recorded, so this UI never becomes an enforcement gate.
        if (event.target.closest('.occupy-button') && account.enabled) openLeaseDialog(account);
        const releaseButton = event.target.closest('[data-release-lease-id]');
        if (releaseButton) releaseLease(releaseButton.dataset.releaseLeaseId);
      });
      elements.settingsButton.addEventListener('click', () => {
        elements.secretInput.value = state.secret;
        elements.settingsDialog.showModal();
      });
      elements.closeSettingsButton.addEventListener('click', () => elements.settingsDialog.close());
      elements.clearSecretButton.addEventListener('click', () => { elements.secretInput.value = ''; });
      elements.settingsForm.addEventListener('submit', () => {
        state.secret = elements.secretInput.value.trim();
        if (state.secret) runtimeWindow.sessionStorage.setItem('occupancyHubSecret', state.secret);
        else runtimeWindow.sessionStorage.removeItem('occupancyHubSecret');
        runtimeWindow.setTimeout(connect, 0);
      });
      elements.accountForm.addEventListener('submit', saveAccount);
      elements.deleteAccountButton.addEventListener('click', deleteAccount);
      elements.leaseForm.addEventListener('submit', acquireLease);
      for (const button of doc.querySelectorAll('.dialog-close, .dialog-cancel')) {
        button.addEventListener('click', () => button.closest('dialog').close());
      }
      runtimeWindow.setInterval(heartbeatOwnedLeases, 30_000);
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible' && !state.abortController) connect();
      });
    }

    return { state, connect, render, applyPayload, bindEvents };
  }

  function boot() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;
    const runtime = createRuntime(document, window);
    runtime.bindEvents();
    runtime.connect();
    return runtime;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }

  return {
    apiErrorMessage,
    clearPendingLeaseAttempt,
    loadLeaseCredentials,
    normalizeAccount,
    normalizeSnapshot,
    normalizeTask,
    parseSseBlock,
    pendingLeaseAttempt,
    providerPresentation,
    snapshotSummary,
    unwrapSnapshot
  };
}));
