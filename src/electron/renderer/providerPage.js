'use strict';

(function exposeProviderPage(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('../../shared/limits/providers') : root.TokenMonitorLimitProviders);
  if (node) module.exports = api;
  if (root) root.TokenMonitorProviderPage = api;
})(typeof window !== 'undefined' ? window : null, function createProviderPageApi(catalog) {
  // Provider here means the tracked product, never the vendor of a model used
  // inside it. A quota account cannot be inferred from a session's client id.
  function providerForClient(client) { return catalog.limitProviderForClient(client) || client; }
  function providerOptions({ providers, clients, enabledIds, stats }) {
    const ids = new Set(enabledIds);
    for (const period of Object.values(stats?.periods || {})) {
      for (const client of Object.keys(period.clients || {})) ids.add(providerForClient(client));
    }
    const entries = new Map(providers.map(p => [p.id, { id: p.id, label: p.label }]));
    for (const client of clients) {
      const id = providerForClient(client.id);
      if (!entries.has(id)) entries.set(id, { id, label: client.label || client.name || id });
    }
    return [...entries.values()].filter(p => ids.has(p.id));
  }
  function providerUsage(period, id, modelRows) {
    const clients = new Set(Object.keys(period?.clients || {}).concat(Object.keys(period?.clientCosts || {}))
      .filter(client => providerForClient(client) === id));
    const available = clients.size > 0;
    const totalTokens = [...clients].reduce((sum, client) => sum + (period.clients?.[client] || 0), 0);
    const costUsd = [...clients].reduce((sum, client) => sum + (period.clientCosts?.[client] || 0), 0);
    const unpricedTokens = [...clients].reduce((sum, client) => sum + (period.clientUnpricedTokens?.[client] || 0), 0);
    const models = new Map();
    for (const client of clients) for (const row of modelRows(period, client)) {
      const previous = models.get(row.key) || { ...row, value: 0, cost: 0, unpricedTokens: 0 };
      previous.value += row.value;
      previous.cost += row.cost;
      previous.unpricedTokens += row.unpricedTokens || 0;
      models.set(row.key, previous);
    }
    const sessions = Object.values(period?.sessions || {}).filter(row => providerForClient(row.client) === id)
      .sort((a, b) => Date.parse(b.lastUsedAt || b.startedAt || 0) - Date.parse(a.lastUsedAt || a.startedAt || 0));
    // Project totals come only from scoped sessions; a mixed-client rollup has
    // no per-client cost/model breakdown and must not leak the other clients.
    const projects = new Map();
    for (const row of sessions) {
      if (!row.projectLabel) continue;
      const key = row.projectLabel;
      projects.set(key, (projects.get(key) || 0) + (row.totalTokens || 0));
    }
    return { available, totalTokens, costUsd, unpricedTokens, sessions,
      models: [...models.values()].sort((a, b) => b.value - a.value),
      projects: [...projects].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value) };
  }

  function projectActivityGroups(rows, sessions) {
    const groups = new Map();
    function projectFor(row) { return String(sessions[row.key?.replace(/^session:/, '')]?.projectLabel || '').trim().normalize('NFC'); }
    for (const row of rows) {
      // A family belongs to its main conversation. Global review/bot groups
      // spanning projects stay together rather than being split and recounted.
      const projects = new Set((row.groupRows || [row]).map(projectFor).filter(Boolean));
      const name = row.subagentGroup ? projectFor(row.groupRows[0]) : projects.size === 1 ? [...projects][0] : '';
      const key = name ? `project:${name}` : projects.size > 1 ? 'multiple' : 'unknown';
      if (!groups.has(key)) groups.set(key, { key, name, multiple: projects.size > 1 && !name, rows: [], value: 0, cost: 0, unpricedTokens: 0, sortTime: 0 });
      const group = groups.get(key);
      group.rows.push(row);
      group.value += row.value || 0;
      group.cost += row.cost || 0;
      group.unpricedTokens += row.unpricedTokens || 0;
      group.sortTime = Math.max(group.sortTime, row.sortTime || 0);
    }
    return [...groups.values()].sort((a, b) => b.sortTime - a.sortTime || b.value - a.value);
  }

  function createProviderPage({ document, root, translate: t, formatTokens, formatCost, mark, onSelect,
    quotaNode, deferQuotaRender, readQuotaHistory, modelRows, detailRows, rowNode, openDetail, modelColor, statusLabel, openExternal }) {
    let selected = '';
    let usagePeriod = 'today';
    const selectedAccounts = new Map();
    let currentAccounts = [];
    let optionSignature = '';
    let contentSignature = '';
    let contentSource = '';

    const header = root.querySelector('#providerHeader');
    const content = root.querySelector('#providerContent');
    const rail = document.getElementById('providerRail');
    function el(tag, cls, text) {
      const node = document.createElement(tag);
      node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    let serviceName = '';
    const accountTabs = el('div', 'service-accounts');
    accountTabs.setAttribute('role', 'group');
    const status = el('button', 'provider-status');
    status.type = 'button';

    const metrics = el('div', 'provider-metrics');
    const tokens = el('span', 'provider-token-total');
    const cost = el('span', 'provider-cost-total');
    metrics.append(tokens, cost);
    const scope = el('span', 'provider-scope');
    header.append(accountTabs);
    const previous = el('button', 'session-tool-scroll');
    const next = el('button', 'session-tool-scroll session-tool-scroll-next');
    for (const button of [previous, next]) {
      button.type = 'button';
      button.append(el('span', 'session-page-icon'));
    }
    const strip = el('div', 'provider-tabs');
    strip.setAttribute('role', 'group');
    rail.append(previous, strip, next, status);
    function scrollState() {
      rail.classList.toggle('has-overflow', strip.scrollWidth > strip.clientWidth + 1);
      previous.disabled = strip.scrollLeft <= 1;
      next.disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
    }
    strip.addEventListener('scroll', scrollState, { passive: true });
    previous.addEventListener('click', () => strip.scrollBy({ left: -120 }));
    next.addEventListener('click', () => strip.scrollBy({ left: 120 }));
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(scrollState).observe(strip);
    strip.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...strip.children];
      let index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = buttons.length - 1;
      else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index].focus({ preventScroll: true });
      buttons[index].click();
      buttons[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    function section(title, key) {
      const node = el('section', 'provider-section');
      node.dataset.section = key;
      node.append(el('h2', 'provider-section-title', title));
      return node;
    }
    const history = window.TokenMonitorInlineQuotaHistory.createInlineHistory({
      document, model: window.TokenMonitorLimitsHistoryModel,
      labels: window.TokenMonitorLimitWindowLabels, translate: t, read: readQuotaHistory
    });
    function render(input) {
      const options = providerOptions(input);
      if (!options.some(p => p.id === selected)) selected = options[0]?.id || '';
      const nextOptions = JSON.stringify([options, input.locale]);
      if (nextOptions !== optionSignature) {
        const focused = strip.contains(document.activeElement) ? document.activeElement.dataset.provider : null;
        strip.replaceChildren(...options.map(p => {
          const button = el('button', 'provider-tab');
          button.type = 'button';
          button.dataset.provider = p.id;
          button.setAttribute('aria-description', p.label);
          button.setAttribute('aria-label', p.label);
          const icon = el('span', ''); mark(icon, p.id); icon.setAttribute('aria-hidden', 'true');
          button.append(icon, el('span', 'provider-tab-label', p.label));
          button.addEventListener('click', () => {
            if (selected === p.id) return;
            selected = p.id;
            contentSignature = '';
            content.scrollTop = 0;
            onSelect();
            button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          });
          return button;
        }));
        optionSignature = nextOptions;
        if (focused) [...strip.children].find(n => n.dataset.provider === focused)?.focus({ preventScroll: true });
      }
      for (const button of strip.children) {
        button.setAttribute('aria-pressed', String(button.dataset.provider === selected));
        button.tabIndex = button.dataset.provider === selected ? 0 : -1;
      }
      strip.setAttribute('aria-label', t('provider.choose'));
      previous.setAttribute('aria-label', t('sessions.toolsPrevious'));
      next.setAttribute('aria-label', t('sessions.toolsNext'));
      scrollState();
      const usage = providerUsage(input.period, selected, modelRows);
      serviceName = options.find(p => p.id === selected)?.label || t('views.provider');
      tokens.textContent = usage.available ? `${formatTokens(usage.totalTokens)} ${t('provider.tokens')}` : '—';
      cost.textContent = usage.available ? formatCost(usage.costUsd, usage.unpricedTokens) : '—';
      metrics.setAttribute('aria-description', t('provider.attribution'));
      scope.textContent = t('provider.allAccounts');
      const service = input.status.find(p => p.id === (selected === 'codex' ? 'openai' : selected));
      status.hidden = !service;
      if (service) {
        status.className = `provider-status service-status-${service.status}`;
        status.textContent = '';
        status.setAttribute('aria-label', statusLabel(service.status));
        status.setAttribute('aria-description', service.incidentTitle || service.description || statusLabel(service.status));
        status.onclick = () => openExternal(service.pageUrl);
      }
      const allAccounts = input.enabledIds.includes(selected)
        ? input.quotaAccounts.filter(a => a.provider.provider === selected) : [];
      currentAccounts = allAccounts;
      const choices = [...new Map(allAccounts.map(account => [account.selectionKey || account.key, account])).values()];
      let accountKey = selectedAccounts.get(selected);
      if (!choices.some(a => (a.selectionKey || a.key) === accountKey)) accountKey = choices[0]?.selectionKey || choices[0]?.key;
      selectedAccounts.set(selected, accountKey);
      const accounts = allAccounts.filter(a => (a.selectionKey || a.key) === accountKey);
      const focusedAccount = accountTabs.contains(document.activeElement) ? document.activeElement.dataset.serviceAccount : null;
      const accountScroll = accountTabs.scrollLeft;
      accountTabs.hidden = choices.length < 2;
      accountTabs.setAttribute('aria-label', t('provider.historyAccount'));
      const accountSignature = JSON.stringify([choices.map(a => [a.selectionKey || a.key, a.name]), accountKey, input.locale]);
      if (accountTabs.dataset.signature !== accountSignature) {
        accountTabs.dataset.signature = accountSignature;
        accountTabs.replaceChildren(...choices.map(account => {
          const key = account.selectionKey || account.key;
          const button = el('button', '', account.name);
          button.type = 'button'; button.dataset.serviceAccount = key;
          button.setAttribute('aria-pressed', String(key === accountKey));
          button.addEventListener('click', () => { selectedAccounts.set(selected, key); onSelect(); });
          return button;
        }));
        accountTabs.scrollLeft = accountScroll;
        if (focusedAccount) [...accountTabs.children].find(n => n.dataset.serviceAccount === focusedAccount)?.focus({ preventScroll: true });
      }
      const nextContent = JSON.stringify([selected, accountKey, input.source, input.period, input.periodId, input.locale,
        input.status, input.detailUnavailable, input.sessionsIncomplete,
        accounts, input.quotaVersion, input.sessionSources, input.projectsEnabled, input.historyEnabled, input.enabledIds, formatCost(1)]);
      history.update({ accounts, source: input.source, provider: selected, locale: input.locale,
        version: JSON.stringify([accounts.map(account => account.provider), input.locale, input.historyVersion]) });
      if (contentSignature === nextContent) return;
      // Keep an open quota tooltip and keyboard reading stable during pushes.
      if (contentSignature && contentSource === input.source && (deferQuotaRender() || content.querySelector('.limit-detail-tooltip-wrap:hover, .limit-detail-tooltip-wrap:focus-within'))) return;
      contentSignature = nextContent;
      contentSource = input.source;
      if (!selected) { content.replaceChildren(el('p', 'provider-empty', t('provider.empty'))); return; }
      const nodes = [];
      if (service?.status === 'outage' || service?.status === 'degraded') nodes.push(el('p', 'provider-incident', service.incidentTitle || service.description));
      const quota = el('section', 'provider-quota');
      quota.dataset.section = 'quota';
      if (accounts.length) quota.append(quotaNode(selected, serviceName, accounts, choices.length > 1));
      else quota.append(el('p', 'provider-empty', t(input.enabledIds.includes(selected) ? 'home.noLimits' : 'provider.noLimits')));
      nodes.push(quota);
      if (accounts.length) nodes.push(history.root);
      const usageSection = section(t('provider.usage'), 'usage');
      const usageHead = usageSection.querySelector('h2');
      const periodTabs = el('div', 'provider-periods');
      periodTabs.setAttribute('role', 'group'); periodTabs.setAttribute('aria-label', t('provider.usage'));
      for (const period of ['today', 'month', 'allTime']) {
        const button = el('button', '', t(`edgeDock.period.${period}`)); button.type = 'button';
        button.dataset.usagePeriod = period;
        button.setAttribute('aria-pressed', String(usagePeriod === period));
        button.addEventListener('click', () => { usagePeriod = period; onSelect(); });
        periodTabs.append(button);
      }
      const usageTop = el('div', 'provider-usage-top');
      usageTop.append(usageHead, periodTabs);
      usageSection.append(usageTop, metrics, scope);
      const models = detailRows(input.period, selected, 'model', usage);
      if (models.length) {
        const distribution = el('div', 'provider-model-distribution');
        distribution.setAttribute('aria-label', t('home.models'));
        const total = Math.max(1, usage.totalTokens);
        for (const model of models) {
          if (!(model.value > 0)) continue;
          const part = el('span', '');
          part.style.flex = String(model.value / total);
          part.style.background = modelColor(model.key);
          part.setAttribute('aria-label', `${model.name} · ${formatTokens(model.value)}`);
          distribution.append(part);
        }
        const legend = el('div', 'provider-model-ledger');
        legend.dataset.section = 'model';
        for (const model of models) {
          const item = el('div', 'provider-model-entry');
          const dot = el('span', 'provider-model-dot'); dot.style.background = modelColor(model.key);
          dot.setAttribute('aria-hidden', 'true');
          const title = el('span', 'provider-model-name', model.name);
          const value = el('span', 'provider-model-amount', formatTokens(model.value));
          const cost = el('span', 'provider-model-cost', formatCost(model.cost, model.unpricedTokens));
          item.append(dot, title, value, cost);
          item.setAttribute('aria-description', `${model.name} · ${formatTokens(model.value)} · ${cost.textContent}`);
          legend.append(item);
        }
        usageSection.append(distribution, legend);
      }
      const rows = detailRows(input.period, selected, 'session', usage);
      const projects = projectActivityGroups(rows, input.projectsEnabled ? input.sessionSources : {});
      const activity = el('div', 'provider-project-activity');
      activity.dataset.section = 'activity';
      for (const project of projects) {
        const group = el('section', 'provider-project-group');
        group.dataset.project = project.key;
        const heading = el('div', 'provider-project-heading');
        const title = el('h3', '', project.name || t(project.multiple ? 'provider.multipleProjects' : 'provider.unassignedProject'));
        const totals = el('span', 'provider-project-total', formatTokens(project.value));
        const label = el('div', 'provider-project-label');
        if (project.name) { const icon = el('span', 'view-switcher-icon view-icon-project'); icon.setAttribute('aria-hidden', 'true'); label.append(icon); }
        label.append(title);
        heading.append(label, totals);
        const list = el('div', 'provider-native-details');
        const max = Math.max(1, ...project.rows.map(row => row.value || 0));
        for (const row of project.rows) list.append(rowNode(row, 'session', max, () => openDetail(row, 'session', usagePeriod)));
        group.append(heading, list);
        activity.append(group);
      }
      if (!rows.length) activity.append(el('p', 'provider-empty', t('home.noSessions')));
      if (input.sessionsIncomplete) activity.append(el('p', 'provider-note', t('sessions.incomplete')));
      usageSection.append(activity);
      if (!usage.available) usageSection.append(el('p', 'provider-note', t('provider.noUsage')));
      nodes.push(usageSection);
      const active = content.contains(document.activeElement) ? document.activeElement : null;
      const focusedPeriod = active?.dataset.usagePeriod;
      const scroll = content.scrollTop;
      content.replaceChildren(...nodes);
      const restored = focusedPeriod ? [...content.querySelectorAll('[data-usage-period]')].find(n => n.dataset.usagePeriod === focusedPeriod)
        : active;
      if (restored?.isConnected) restored.focus({ preventScroll: true });
      content.scrollTop = scroll;
    }
    return { render, selectedId: () => selected, usagePeriod: () => usagePeriod, selectHistoryAccount: key => { const account = currentAccounts.find(a => a.key === key); if (account) { selectedAccounts.set(selected, account.selectionKey || key); onSelect(); history.selectAccount(key); } } };
  }
  return { providerForClient, providerOptions, providerUsage, projectActivityGroups, createProviderPage };
});
