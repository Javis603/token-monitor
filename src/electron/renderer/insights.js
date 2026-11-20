'use strict';

// A persistent "what is happening right now" strip under the total. It follows
// the patterns users already keep in Claude Code / Codex / ccusage status lines
// (model, context headroom, spend, cache) and the per-session spend cards from
// dsh-spend, but it is renderer-only: one IPC listener, one DOM subtree, and no
// timers or extra windows.
//
// The strip always describes the latest session, independent of the selected
// period. Opening it shows the same numbers the app already trusts: session
// totals, the per-model component split and the active provider's quota
// windows. Nothing here writes state or starts collection.
(function usageInsights() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const bridge = window.tokenMonitor;
  if (!bridge?.onStatsPush) return;

  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canAnimate = () => !reduceQuery.matches
    && document.documentElement.dataset.reduceMotion !== 'on';

  const COPY = {
    en: {
      ctx: 'ctx',
      cache: 'cache',
      calls: 'calls',
      quota: 'quota',
      tokens: 'Tokens',
      input: 'Input',
      cached: 'Cached input',
      output: 'Output',
      reasoning: 'Reasoning',
      callsLabel: 'Calls',
      avgSpeed: 'Avg output',
      cost: 'Session cost',
      perMillion: 'Cost / 1M tokens',
      contextLabel: 'Context',
      used: 'used',
      remaining: 'remaining',
      started: 'Started',
      updated: 'Updated',
      models: 'Models',
      limits: 'Limits',
      currentSession: 'Current session',
      stale: 'stale',
      reset: 'resets',
      now: 'now',
      ago: 'ago',
      minute: 'm',
      hour: 'h',
      day: 'd',
      noSession: 'No session yet',
      close: 'Close',
      cachedShort: 'cached',
      more: 'more'
    },
    zh: {
      ctx: '上下文',
      cache: '缓存',
      calls: '调用',
      quota: '额度',
      tokens: 'Tokens',
      input: '输入',
      cached: '缓存输入',
      output: '输出',
      reasoning: '推理',
      callsLabel: '调用次数',
      avgSpeed: '平均输出',
      cost: '会话花费',
      perMillion: '每百万 token',
      contextLabel: '上下文',
      used: '已用',
      remaining: '剩余',
      started: '开始于',
      updated: '更新于',
      models: '模型',
      limits: '额度',
      currentSession: '当前会话',
      stale: '快照',
      reset: '重置',
      now: '刚刚',
      ago: '前',
      minute: '分',
      hour: '小时',
      day: '天',
      noSession: '暂无会话',
      close: '关闭',
      cachedShort: '缓存',
      more: '个'
    }
  };

  const CLIENT_LABELS = {
    qoder: 'Qoder',
    qodercn: 'Qoder CN',
    claude: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    dsh: 'DeepSeek Harness',
    deepseek: 'DeepSeek',
    opencode: 'OpenCode',
    workbuddy: 'WorkBuddy',
    antigravity: 'Antigravity',
    copilot: 'Copilot',
    kimi: 'Kimi',
    zai: 'Z.ai',
    minimax: 'MiniMax',
    volcengine: 'Volcengine',
    unknown: 'Other'
  };

  const state = {
    stats: null,
    settings: null,
    open: false,
    row: null
  };
  const refs = {};
  let status = null;
  let card = null;
  let renderFrame = 0;
  let formatterKey = '';
  let formatter = null;
  let lastSessionKey = '';

  function locale() {
    const language = state.settings?.language;
    if (language && language !== 'auto') return language;
    return navigator.language || 'en';
  }

  function copy() {
    return /^zh\b/i.test(locale()) ? COPY.zh : COPY.en;
  }

  function numberFormatter() {
    const key = locale();
    if (formatter && formatterKey === key) return formatter;
    formatterKey = key;
    formatter = new Intl.NumberFormat(key, {
      notation: 'compact',
      maximumFractionDigits: 1
    });
    return formatter;
  }

  function exactFormatter() {
    const key = locale();
    return new Intl.NumberFormat(key, { maximumFractionDigits: 0 });
  }

  function compact(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    const safe = Math.max(0, number);
    return safe >= 1000 ? numberFormatter().format(safe) : exactFormatter().format(Math.round(safe));
  }

  function currencyApi() {
    return window.TokenMonitorCurrency;
  }

  function currencyCode() {
    return currencyApi()?.normalizeCurrency?.(state.settings?.currency) || 'USD';
  }

  function configureCurrency() {
    const api = currencyApi();
    if (api?.configureRates && state.settings?.currencyRatesEffective) {
      api.configureRates(state.settings.currencyRatesEffective);
    }
  }

  function money(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '';
    if (amount === 0) {
      try {
        return new Intl.NumberFormat(locale(), {
          style: 'currency',
          currency: currencyCode(),
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(0);
      } catch (_) {
        return '$0.00';
      }
    }
    try {
      if (currencyApi()?.formatCurrencyFromUsd) {
        return currencyApi().formatCurrencyFromUsd(amount, currencyCode());
      }
    } catch (_) {
      // Fall through to the plain USD form.
    }
    return `$${amount.toFixed(2)}`;
  }

  function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function timeValue(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clientLabel(client) {
    const id = String(client || '').trim().toLowerCase();
    if (CLIENT_LABELS[id]) return CLIENT_LABELS[id];
    return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Other';
  }

  // Session rows are normalized to lowercase ids by the collector; history can
  // also carry Qoder's own display names. Keep a display-ready name as-is and
  // build the common ids back into their public casing.
  function modelLabel(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    if (/^(?:DeepSeek|Qwen|Kimi|GLM|MiniMax|Sonus|Cantus|Auto|Lite|Efficient|Performance|Ultimate)\b/.test(raw)) return raw;
    let out = raw;
    if (/^deepseek/i.test(out)) out = out.replace(/^deepseek/i, 'DeepSeek');
    else if (/^qwen/i.test(out)) out = out.replace(/^qwen/i, 'Qwen');
    else if (/^kimi/i.test(out)) out = out.replace(/^kimi/i, 'Kimi');
    else if (/^glm/i.test(out)) out = out.replace(/^glm/i, 'GLM');
    else if (/^minimax/i.test(out)) out = out.replace(/^minimax/i, 'MiniMax');
    else if (/^sonus/i.test(out)) out = out.replace(/^sonus/i, 'Sonus');
    else if (/^cantus/i.test(out)) out = out.replace(/^cantus/i, 'Cantus');
    return out.replace(/(^|[-\s])([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
  }

  function sessionModels(row) {
    const models = row?.models && typeof row.models === 'object' ? row.models : {};
    return Object.entries(models)
      .map(([name, tokens]) => [name, positive(tokens)])
      .filter(([name, tokens]) => name && tokens > 0)
      .sort((left, right) => right[1] - left[1]);
  }

  function topModel(row) {
    const latest = modelLabel(row?.latestModel);
    if (latest) return latest;
    const models = sessionModels(row);
    return models.length ? modelLabel(models[0][0]) : '';
  }

  function sessionKey(row) {
    return `${row?.client || ''}:${row?.sessionId || ''}`;
  }

  function findSession(stats, periodName, row) {
    const sessions = stats?.periods?.[periodName]?.sessions;
    if (!sessions || !row?.sessionId) return null;
    const direct = sessions[sessionKey(row)];
    if (direct) return direct;
    for (const candidate of Object.values(sessions)) {
      if (candidate?.client === row.client && candidate?.sessionId === row.sessionId) return candidate;
    }
    return null;
  }

  function pickSession(stats) {
    let latest = null;
    for (const periodName of ['today', 'month', 'allTime']) {
      const sessions = stats?.periods?.[periodName]?.sessions;
      if (!sessions || typeof sessions !== 'object') continue;
      for (const key of Object.keys(sessions)) {
        const row = sessions[key];
        if (!row || !row.sessionId) continue;
        const last = timeValue(row.lastUsedAt);
        if (!latest || last > latest.last) latest = { row, last };
      }
      if (latest) break;
    }
    if (!latest) return null;
    // Today's row carries only today's slice of a session that can span days.
    // A status line describes the session, so take the largest same-session row
    // (month or all-time) and borrow the freshest live fields from today.
    const candidates = [latest.row];
    for (const periodName of ['month', 'allTime']) {
      const row = findSession(stats, periodName, latest.row);
      if (row && !candidates.includes(row)) candidates.push(row);
    }
    const base = candidates.reduce((best, row) => (
      positive(row.totalTokens) > positive(best.totalTokens) ? row : best
    ), latest.row);
    return {
      ...base,
      lastUsedAt: latest.row.lastUsedAt || base.lastUsedAt,
      turnEnded: latest.row.turnEnded !== undefined ? latest.row.turnEnded : base.turnEnded,
      liveActivity: latest.row.liveActivity || base.liveActivity,
      contextTokens: positive(latest.row.contextTokens) > 0 ? latest.row.contextTokens : base.contextTokens,
      contextWindow: positive(latest.row.contextWindow) > 0 ? latest.row.contextWindow : base.contextWindow
    };
  }

  function isLive(row) {
    if (!row) return false;
    if (row.turnEnded === false) return true;
    const activity = String(row.liveActivity?.state || '').toLowerCase();
    if (activity === 'running' || activity === 'waiting') return true;
    const last = timeValue(row.lastUsedAt);
    return last > 0 && Date.now() - last < 90 * 1000;
  }

  function quotaFor(client) {
    const wanted = String(client || '').trim().toLowerCase();
    if (!wanted) return null;
    const providers = Array.isArray(state.stats?.limits?.providers) ? state.stats.limits.providers : [];
    const matches = providers.filter((provider) => (
      String(provider?.provider || '').trim().toLowerCase() === wanted
      && Array.isArray(provider.windows)
      && provider.windows.length > 0
    ));
    if (!matches.length) return null;
    let best = null;
    for (const provider of matches) {
      for (const window of provider.windows) {
        const percent = Number(window.remainingPercent);
        if (!Number.isFinite(percent)) continue;
        if (!best || percent < best.percent) best = { provider, window, percent };
      }
    }
    return best;
  }

  function duration(ms) {
    const c = copy();
    const total = Math.max(0, Number(ms) || 0);
    if (total < 60 * 1000) return c.now;
    const minutes = Math.round(total / 60000);
    if (minutes < 60) return `${minutes}${c.minute}`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return rest ? `${hours}${c.hour} ${rest}${c.minute}` : `${hours}${c.hour}`;
    const days = Math.floor(hours / 24);
    const hourRest = hours % 24;
    return hourRest ? `${days}${c.day} ${hourRest}${c.hour}` : `${days}${c.day}`;
  }

  function agoText(ms) {
    const c = copy();
    const value = duration(ms);
    return value === c.now ? c.now : `${value} ${c.ago}`;
  }

  function tokenPair(row) {
    const window = positive(row?.contextWindow);
    const used = positive(row?.contextTokens);
    if (!(window > 0) || !(used > 0)) return null;
    const usedPercent = Math.max(0, Math.min(100, Math.round(used / window * 100)));
    return { window, used, usedPercent };
  }

  function cachePercent(row) {
    const cacheRead = positive(row?.cacheReadTokens);
    const input = positive(row?.inputTokens);
    const total = cacheRead + input;
    if (!(total > 0)) return null;
    return Math.max(0, Math.min(100, Math.round(cacheRead / total * 100)));
  }

  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function chip(kind) {
    const wrap = element('span', `session-status-chip session-status-${kind}`);
    const label = element('span', 'session-status-chip-label');
    const value = element('span', 'session-status-chip-value');
    wrap.append(label, value);
    wrap.hidden = true;
    return { wrap, label, value };
  }

  function buildStatus(panel) {
    status = document.createElement('button');
    status.type = 'button';
    status.className = 'session-status hidden';
    status.setAttribute('aria-haspopup', 'dialog');
    status.setAttribute('aria-expanded', 'false');

    refs.dot = element('span', 'session-status-dot');
    const identity = element('span', 'session-status-identity');
    refs.client = element('span', 'session-status-client');
    refs.model = element('span', 'session-status-model');
    identity.append(refs.client, refs.model);
    refs.project = element('span', 'session-status-project');

    const metrics = element('span', 'session-status-metrics');
    refs.context = chip('context');
    refs.contextBar = element('span', 'session-status-context-bar');
    refs.contextFill = element('i');
    refs.contextBar.append(refs.contextFill);
    refs.context.wrap.insertBefore(refs.contextBar, refs.context.value);
    refs.cache = chip('cache');
    refs.quota = chip('quota');
    refs.calls = chip('calls');
    metrics.append(refs.context.wrap, refs.cache.wrap, refs.quota.wrap, refs.calls.wrap);

    status.append(refs.dot, identity, refs.project, metrics);

    const anchor = panel.querySelector('.total-cost-row') || document.getElementById('cost') || panel.lastElementChild;
    if (anchor) anchor.insertAdjacentElement('afterend', status);
    else panel.append(status);

    card = element('div', 'session-insight-card hidden');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.tabIndex = -1;
    panel.append(card);

    status.addEventListener('click', () => setOpen(!state.open));
    status.addEventListener('animationend', (event) => {
      if (event.animationName === 'session-status-in') {
        status.classList.remove('is-session-entering');
      }
    });
    card.addEventListener('animationend', (event) => {
      if (event.target !== card) return;
      if (event.animationName === 'session-insight-in') {
        card.classList.remove('is-opening');
      } else if (event.animationName === 'session-insight-out') {
        card.classList.add('hidden');
        card.classList.remove('is-closing');
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!state.open) return;
      if (card.contains(event.target) || status.contains(event.target)) return;
      setOpen(false);
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !state.open) return;
      setOpen(false);
      status.focus();
    });
  }

  function setOpen(open) {
    state.open = Boolean(open) && Boolean(state.row);
    status.setAttribute('aria-expanded', String(state.open));
    if (!state.open) {
      if (card.classList.contains('hidden')) {
        card.classList.remove('is-opening', 'is-closing');
        return;
      }
      if (!canAnimate()) {
        card.classList.add('hidden');
        card.classList.remove('is-opening', 'is-closing');
        return;
      }
      // Let the card finish leaving before display:none. The CSS animation
      // owns the timing; animationend keeps this layer free of timers.
      if (card.classList.contains('is-closing')) return;
      card.classList.remove('is-opening');
      card.classList.add('is-closing');
      return;
    }
    card.classList.remove('hidden');
    card.classList.remove('is-closing');
    card.classList.remove('is-opening');
    renderCard();
    if (canAnimate()) {
      void card.offsetWidth;
      card.classList.add('is-opening');
    }
  }

  function setChip(target, labelText, valueText, description) {
    target.label.textContent = labelText;
    target.value.textContent = valueText;
    // Native title tooltips are forbidden in the renderer; keep the extra
    // reading as an accessible description instead.
    target.wrap.setAttribute('aria-label', [labelText, valueText, description || ''].filter(Boolean).join(' '));
    target.wrap.hidden = !valueText;
  }

  function markSessionEntering(row) {
    const key = sessionKey(row);
    if (!canAnimate()) {
      status.classList.remove('is-session-entering');
    } else if (lastSessionKey && lastSessionKey !== key) {
      status.classList.remove('is-session-entering');
      // Restart the keyframes when the latest session changes, not on every
      // value push from the same session.
      void status.offsetWidth;
      status.classList.add('is-session-entering');
    }
    lastSessionKey = key;
  }

  function render() {
    renderFrame = 0;
    const row = pickSession(state.stats);
    state.row = row;
    if (!row) {
      status.classList.add('hidden');
      status.classList.remove('is-session-entering');
      lastSessionKey = '';
      if (state.open) setOpen(false);
      return;
    }
    const c = copy();
    status.classList.remove('hidden');
    status.classList.toggle('is-live', isLive(row));

    refs.client.textContent = clientLabel(row.client);
    refs.model.textContent = topModel(row);
    refs.project.textContent = row.projectLabel || '';
    refs.project.hidden = !refs.project.textContent;

    const context = tokenPair(row);
    if (context) {
      const remainingMode = state.settings?.sessionContextMetric === 'remaining';
      const percent = remainingMode ? 100 - context.usedPercent : context.usedPercent;
      refs.contextFill.style.width = `${percent}%`;
      refs.context.wrap.dataset.tone = context.usedPercent >= 80
        ? 'critical'
        : context.usedPercent >= 60 ? 'low' : '';
      setChip(
        refs.context,
        c.ctx,
        `${percent}%`,
        `${c.contextLabel}: ${compact(context.used)} / ${compact(context.window)} · ${context.usedPercent}% ${c.used}`
      );
    } else {
      refs.context.wrap.hidden = true;
    }

    const cached = cachePercent(row);
    if (cached != null) {
      setChip(
        refs.cache,
        c.cache,
        `${cached}%`,
        `${compact(positive(row.cacheReadTokens))} ${c.cachedShort} / ${compact(positive(row.cacheReadTokens) + positive(row.inputTokens))}`
      );
    } else {
      refs.cache.wrap.hidden = true;
    }

    const messages = positive(row.messageCount);
    if (messages > 0) setChip(refs.calls, c.calls, compact(messages), `${c.callsLabel}: ${exactFormatter().format(messages)}`);
    else refs.calls.wrap.hidden = true;

    const quota = quotaFor(row.client);
    if (quota) {
      refs.quota.wrap.dataset.tone = quota.percent < 20 ? 'critical' : quota.percent < 50 ? 'low' : '';
      refs.quota.wrap.classList.toggle('is-stale', Boolean(quota.provider.stale));
      const resetAt = timeValue(quota.window.resetsAt);
      const resetText = resetAt ? `${c.reset} ${duration(Math.max(0, resetAt - Date.now()))}` : '';
      setChip(
        refs.quota,
        c.quota,
        `${Math.round(quota.percent)}%`,
        [quota.provider.accountLabel, quota.window.label || quota.window.kind, `${Math.round(quota.percent)}% ${c.remaining}`, resetText, quota.provider.stale ? c.stale : '']
          .filter(Boolean).join(' · ')
      );
    } else {
      refs.quota.wrap.hidden = true;
    }

    const last = timeValue(row.lastUsedAt);
    const titleParts = [row.title, row.projectLabel, last ? `${c.updated} ${agoText(Date.now() - last)}` : ''].filter(Boolean);
    status.setAttribute('aria-description', titleParts.join(' · '));
    status.setAttribute('aria-label', [
      clientLabel(row.client),
      topModel(row),
      context ? `${c.ctx} ${context.usedPercent}%` : '',
      cached != null ? `${c.cache} ${cached}%` : '',
      messages > 0 ? `${exactFormatter().format(messages)} ${c.calls}` : ''
    ].filter(Boolean).join(', '));
    markSessionEntering(row);

    if (state.open) renderCard();
  }

  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = window.requestAnimationFrame(render);
  }

  function addStat(grid, label, value, description = '') {
    if (!value) return;
    const item = element('div', 'session-insight-stat');
    if (description) item.setAttribute('aria-description', description);
    item.append(element('span', 'session-insight-stat-label', label), element('strong', 'session-insight-stat-value', value));
    grid.append(item);
  }

  function renderCard() {
    if (!card || !state.row) return;
    const row = state.row;
    const c = copy();
    card.replaceChildren();

    const head = element('div', 'session-insight-head');
    const headText = element('div', 'session-insight-head-text');
    headText.append(
      element('div', 'session-insight-title', row.title || c.currentSession),
      element('div', 'session-insight-sub', [
        clientLabel(row.client),
        topModel(row),
        row.projectLabel
      ].filter(Boolean).join(' · '))
    );
    const close = element('button', 'session-insight-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', c.close);
    close.addEventListener('click', () => setOpen(false));
    head.append(headText, close);
    card.append(head);

    const context = tokenPair(row);
    const cached = cachePercent(row);
    const grid = element('div', 'session-insight-grid');
    addStat(grid, c.tokens, compact(row.totalTokens), exactFormatter().format(positive(row.totalTokens)));
    addStat(grid, c.input, compact(row.inputTokens));
    addStat(grid, c.cached, compact(row.cacheReadTokens));
    addStat(grid, c.output, compact(row.outputTokens));
    addStat(grid, c.reasoning, compact(row.reasoningTokens));
    addStat(grid, c.callsLabel, exactFormatter().format(positive(row.messageCount)));
    const tps = positive(row.timedDurationMs) > 0
      ? Math.round(positive(row.timedOutputTokens) / (positive(row.timedDurationMs) / 1000))
      : 0;
    addStat(grid, c.avgSpeed, tps > 0 ? `${tps} tok/s` : '');
    addStat(grid, c.cost, money(row.costUsd || 0));
    const cost = positive(row.costUsd);
    const tokens = positive(row.totalTokens);
    addStat(grid, c.perMillion, cost > 0 && tokens > 0 ? money(cost / tokens * 1000000) : '');
    if (context) {
      addStat(
        grid,
        c.contextLabel,
        `${context.usedPercent}% ${c.used} · ${compact(context.used)} / ${compact(context.window)}`,
        `${compact(context.window - context.used)} ${c.remaining}`
      );
    }
    if (cached != null) addStat(grid, c.cache, `${cached}%`);
    card.append(grid);

    const models = sessionModels(row);
    if (models.length) {
      card.append(element('div', 'session-insight-section-title', c.models));
      const list = element('div', 'session-insight-rows');
      const components = row.modelTokenComponents && typeof row.modelTokenComponents === 'object'
        ? row.modelTokenComponents
        : {};
      const costs = row.modelCosts && typeof row.modelCosts === 'object' ? row.modelCosts : {};
      for (const [name, tokensValue] of models.slice(0, 6)) {
        const item = element('div', 'session-insight-row');
        const component = components[name] && typeof components[name] === 'object' ? components[name] : null;
        const read = positive(component?.cacheReadTokens);
        const fresh = positive(component?.inputTokens);
        const hit = read + fresh > 0 ? Math.round(read / (read + fresh) * 100) : null;
        item.append(
          element('span', 'session-insight-row-name', modelLabel(name)),
          element('span', 'session-insight-row-meta', hit != null ? `${hit}% ${c.cachedShort}` : ''),
          element('span', 'session-insight-row-value', compact(tokensValue)),
          element('span', 'session-insight-row-cost', money(costs[name] || 0))
        );
        list.append(item);
      }
      if (models.length > 6) {
        list.append(element('div', 'session-insight-row-more', `+${models.length - 6} ${c.more}`));
      }
      card.append(list);
    }

    const quota = quotaFor(row.client);
    if (quota) {
      const providers = (state.stats?.limits?.providers || []).filter((provider) => (
        String(provider?.provider || '').trim().toLowerCase() === String(row.client || '').trim().toLowerCase()
        && Array.isArray(provider.windows)
        && provider.windows.length
      ));
      if (providers.length) {
        card.append(element('div', 'session-insight-section-title', c.limits));
        const list = element('div', 'session-insight-limits');
        for (const provider of providers) {
          for (const window of provider.windows) {
            const percent = Number(window.remainingPercent);
            if (!Number.isFinite(percent)) continue;
            const item = element('div', 'session-insight-limit');
            const line = element('div', 'session-insight-limit-line');
            line.append(
              element('span', 'session-insight-row-name', [
                clientLabel(provider.provider),
                provider.accountLabel,
                window.label || window.kind
              ].filter(Boolean).join(' · ')),
              element('span', 'session-insight-row-value', `${Math.round(percent)}%`)
            );
            const meter = element('div', 'session-insight-meter');
            const fill = element('i');
            fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
            meter.dataset.tone = percent < 20 ? 'critical' : percent < 50 ? 'low' : '';
            meter.append(fill);
            item.append(line, meter);
            const resetAt = timeValue(window.resetsAt);
            const notes = [
              resetAt ? `${c.reset} ${duration(Math.max(0, resetAt - Date.now()))}` : '',
              provider.stale ? c.stale : ''
            ].filter(Boolean);
            if (notes.length) item.append(element('div', 'session-insight-limit-note', notes.join(' · ')));
            list.append(item);
          }
        }
        card.append(list);
      }
    }

    const started = timeValue(row.startedAt);
    const last = timeValue(row.lastUsedAt);
    const footer = element('div', 'session-insight-footer');
    const parts = [];
    if (started) parts.push(`${c.started} ${duration(Math.max(0, last - started))} ${c.ago}`);
    if (last) parts.push(`${c.updated} ${agoText(Date.now() - last)}`);
    footer.textContent = parts.join(' · ');
    card.append(footer);
  }

  function applySettings(next) {
    state.settings = next || state.settings;
    configureCurrency();
    scheduleRender();
  }

  function init() {
    const panel = document.querySelector('.total-panel');
    if (!panel) return;
    buildStatus(panel);
    bridge.onSettingsPush?.((next) => applySettings(next));
    bridge.onStatsPush((payload) => {
      const stats = payload?.data?.stats;
      if (!stats) return;
      state.stats = stats;
      scheduleRender();
    });
    // The settings push is change-only; seed the formatter and the
    // used/remaining preference for the first paint.
    if (typeof bridge.getSettings === 'function') {
      bridge.getSettings().then((settings) => {
        if (settings) applySettings(settings);
      }).catch(() => {});
    }
    // The app's own startup read and cache seed both arrive as stats pushes;
    // listening is enough and avoids a second fetch from this layer.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
