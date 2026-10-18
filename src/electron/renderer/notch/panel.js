'use strict';

// The open top entry: a fixed-height panel with four pages, built from the
// cells the main process projects (limits, today, month, sessions, live rate)
// and the panel facts it adds (the last seven days). It shares the widget's
// typography and colours but owns its own layout; no card or list styles from
// the Edge Dock or the Home view are reused here.
(function exposeNotchPanel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorNotchPanel = api;
})(typeof window !== 'undefined' ? window : null, function createNotchPanelApi() {
  // Logical points inside the zoomed panel. The band shares the camera row on
  // an attached shell and becomes the first row of a capsule.
  const PANEL_METRICS = Object.freeze({ band: 34, pages: 176, gap: 6, bottom: 18, padding: 24 });
  const PAGES = Object.freeze(['home', 'limits', 'sessions', 'breakdown']);
  const LIMIT_COLUMNS = 3;
  const ACTIVE_ROWS = 2;
  const BREAKDOWN_ROWS = 4;

  // Content height the controller sizes the open shell from, in screen points.
  function panelContentHeight({ attached, zoom = 1 }) {
    const rows = PANEL_METRICS.gap + PANEL_METRICS.pages + PANEL_METRICS.bottom;
    return Math.ceil((attached ? rows : PANEL_METRICS.band + rows) * zoom);
  }

  // Top rows plus one remainder row, so the shares always sum to the total.
  function breakdownRows(entries, limit = BREAKDOWN_ROWS) {
    const rows = entries.filter((entry) => entry.tokens > 0);
    if (rows.length <= limit) return rows;
    const head = rows.slice(0, limit - 1);
    const rest = rows.slice(limit - 1).reduce((sum, entry) => sum + entry.tokens, 0);
    return [...head, { key: 'other', other: true, tokens: rest }];
  }

  function createNotchPanel({ document, window, el, t, state, bridge, shared }) {
    const { markNode, hasMask, providerLabel, limitProviderColor, formatTokens, formatCardTokens, formatBreakdownTokens, formatCost, formatRate,
      appearance, prefersReducedMotion, readableColor = color => color, limitAccountTitle, overflowText, limitWindowsView } = shared;
    const presentation = window.TokenMonitorEdgeDockPresentation;
    const trayText = window.TokenMonitorTrayText;
    const trayLayout = window.TokenMonitorTrayLayout;
    const balance = window.TokenMonitorLimitBalanceDisplay;
    const windowLabels = window.TokenMonitorLimitWindowLabels;
    const windowText = window.TokenMonitorLimitWindowText;
    const resetMotion = window.TokenMonitorLimitResetMotion;
    const sessionRows = window.TokenMonitorSessionRows;
    const sessionLive = window.TokenMonitorSessionLive;
    const { clientColors, modelColor } = window.TokenMonitorUsageCharts;
    const { CLIENT_LABELS } = window.TokenMonitorClientCatalog;
    const { activateOnPress } = window.TokenMonitorPressActivation;

    const view = { page: 'home', limitPage: 0, breakdownPeriod: 'today', scrub: null };
    const node = el('div', 'notch-panel');
    const band = el('div', 'notch-band');
    const tabs = el('div', 'notch-tabs');
    tabs.setAttribute('role', 'tablist');
    const tabPill = el('span', 'notch-tab-pill');
    tabs.append(tabPill);
    const status = el('div', 'notch-status');
    band.append(tabs, el('div', 'notch-band-gap'), status);
    const pages = el('div', 'notch-pages');
    const pageNodes = new Map(PAGES.map((page) => [page, el('section', `notch-page notch-page-${page}`)]));
    for (const [page, pageNode] of pageNodes) {
      pageNode.dataset.page = page;
      pageNode.setAttribute('role', 'tabpanel');
      pageNode.id = `notch-page-${page}`;
      pageNode.setAttribute('aria-labelledby', `notch-tab-${page}`);
      pages.append(pageNode);
    }
    node.append(band, pages);
    const tabButtons = new Map();
    const TAB_ICONS = {
      home: 'home', limits: 'limits', sessions: 'session', breakdown: 'model'
    };
    for (const page of PAGES) {
      const button = el('button', 'notch-tab');
      button.type = 'button';
      button.dataset.page = page;
      button.setAttribute('role', 'tab');
      button.id = `notch-tab-${page}`;
      button.setAttribute('aria-controls', `notch-page-${page}`);
      const icon = el('span', `view-switcher-icon view-icon-${TAB_ICONS[page]}`);
      icon.setAttribute('aria-hidden', 'true');
      button.append(icon, el('span', 'notch-tab-badge'));
      activateOnPress(button, () => selectPage(page));
      tabButtons.set(page, button);
      tabs.append(button);
    }
    tabs.addEventListener('keydown', (event) => {
      const current = PAGES.indexOf(view.page);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? PAGES.length - 1
        : event.key === 'ArrowRight' ? (current + 1) % PAGES.length
          : event.key === 'ArrowLeft' ? (current + PAGES.length - 1) % PAGES.length : -1;
      if (index < 0) return;
      event.preventDefault();
      selectPage(PAGES[index]);
      tabButtons.get(PAGES[index]).focus({ preventScroll: true });
    });

    let payload = null;
    let pageKeys = new Map();
    let enteringTimer = null;
    let fitHomeFuel = () => {};
    const numberAnimation = window.TokenMonitorTokenNumberAnimation;
    const rolls = new Map();
    const rollFormats = new WeakMap();
    let statusKey = '';
    const windowPages = new Map();

    function settleRolls() {
      for (const held of rolls.values()) { clearTimeout(held.timer); held.settle(); }
      rolls.clear();
    }

    // Live figures keep the widget's rolling digits across page rebuilds: the
    // previous node's glyphs are captured before the page is replaced.
    function captureRolls(pageNode) {
      const snapshot = new Map();
      for (const node of pageNode.querySelectorAll('[data-roll-key]')) {
        snapshot.set(node.dataset.rollKey, { text: node.dataset.rollText, value: Number(node.dataset.rollValue), glyphs: numberAnimation.capture(node) });
      }
      settleRolls();
      return snapshot;
    }
    function playRolls(pageNode, snapshot) {
      if (prefersReducedMotion()) return;
      for (const node of pageNode.querySelectorAll('[data-roll-key]')) {
        const previous = snapshot.get(node.dataset.rollKey);
        const next = node.textContent;
        if (!previous || previous.text === next || !/[0-9]/.test(previous.text) || !/[0-9]/.test(next)) continue;
        const value = Number(node.dataset.rollValue);
        let settle;
        if (numberAnimation.normalize(appearance().tokenNumberAnimation) === 'roll') {
          settle = numberAnimation.beginRoll(node, previous.text, next, !(value < previous.value), null, previous.glyphs);
        } else {
          const started = performance.now();
          let frame;
          const step = (now) => {
            const progress = Math.min(1, (now - started) / numberAnimation.duration);
            node.textContent = rollFormats.get(node)(previous.value + (value - previous.value) * (1 - (1 - progress) ** 4));
            if (progress < 1) frame = requestAnimationFrame(step);
          };
          frame = requestAnimationFrame(step);
          settle = () => { cancelAnimationFrame(frame); node.textContent = next; };
        }
        const timer = setTimeout(() => { settle(); rolls.delete(node); }, numberAnimation.duration);
        rolls.set(node, { settle, timer });
      }
    }
    function rolling(node, key, value, format = formatCardTokens) {
      node.dataset.rollKey = key;
      node.dataset.rollValue = String(value ?? '');
      node.dataset.rollText = node.textContent;
      rollFormats.set(node, format);
      return node;
    }

    function cell(id) {
      return (payload?.cells || []).find((entry) => entry.id === id) || null;
    }
    function providerCells() {
      return (payload?.cells || []).filter((entry) => entry.kind === 'provider');
    }
    function locale() {
      return state.locale || 'en';
    }
    function relativeAgo(value, nowMs = Date.now()) {
      const ms = Date.parse(value || '');
      if (!Number.isFinite(ms)) return '';
      const minutes = Math.round(Math.max(0, nowMs - ms) / 60000);
      if (minutes < 1) return t('edgeDock.agoNow');
      if (minutes < 60) return t('edgeDock.agoMinutes', { count: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t('edgeDock.agoHours', { count: hours });
      return t('edgeDock.agoDays', { count: Math.round(hours / 24) });
    }
    function duration(fromValue, nowMs = Date.now()) {
      const ms = Date.parse(fromValue || '');
      if (!Number.isFinite(ms)) return '';
      const minutes = Math.max(0, Math.round((nowMs - ms) / 60000));
      if (minutes < 60) return t('notch.durationMinutes', { minutes });
      return t('notch.durationHours', { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, '0') });
    }
    function clientLabel(id) {
      return CLIENT_LABELS[id] || providerLabel(id);
    }
    // The rail's own severity scale, so the panel and the collapsed alert agree.
    function severity(remaining) {
      const level = presentation.remainingSeverity(remaining);
      return level === 'critical' || level === 'low' ? level : '';
    }
    function clientColor(id) {
      return readableColor(clientColors[id] || limitProviderColor(id) || clientColors.default);
    }
    function mark(id, className = '') {
      const node = markNode(id);
      if (className) node.classList.add(className);
      return node;
    }
    function text(className, value, title) {
      const node = el('span', className, value);
      if (title) node.title = title;
      return node;
    }
    function usageCost(className, usage) {
      return text(className, usage?.unpricedTokens > 0 ? '—' : formatCost(usage?.costUsd), usage?.unpricedTokens > 0
        ? t('usage.excludedFromCost', { tokens: formatCardTokens(usage.unpricedTokens) }) : '');
    }
    function fitTokenFigure(number, size) {
      number.style.fontSize = `${size}px`;
      if (number.clientWidth > 0 && number.scrollWidth > number.clientWidth) {
        number.style.fontSize = `${Math.max(18, Math.floor(size * number.clientWidth / number.scrollWidth))}px`;
      }
    }

    // ---- Band -----------------------------------------------------------------

    function selectPage(page) {
      if (!PAGES.includes(page) || view.page === page) return;
      const previous = PAGES.indexOf(view.page);
      settleRolls();
      stopTitleReading();
      view.scrub = null;
      view.page = page;
      for (const [name, pageNode] of pageNodes) {
        pageNode.classList.toggle('is-before', PAGES.indexOf(name) < PAGES.indexOf(page));
      }
      pages.dataset.direction = PAGES.indexOf(page) > previous ? 'forward' : 'back';
      paintTabs();
      renderPage(page);
    }

    function paintTabs() {
      tabs.setAttribute('aria-label', t('settings.notch.experimentalTitle'));
      for (const [page, button] of tabButtons) {
        const selected = page === view.page;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        button.title = t(`notch.tab.${page}`);
        button.setAttribute('aria-label', button.title);
      }
      tabPill.style.transform = `translateX(${PAGES.indexOf(view.page) * 36}px)`;
      for (const [page, pageNode] of pageNodes) {
        pageNode.classList.toggle('is-selected', page === view.page);
        pageNode.inert = page !== view.page;
        pageNode.setAttribute('aria-hidden', String(page !== view.page));
      }
    }

    // The reading is rebuilt only when its structure changes. Live samples
    // update the existing button in place, so keyboard focus survives pushes.
    function paintStatus() {
      const rate = cell('stat:liveRate');
      const waiting = presentation.waitingSessionSummary(cell('stat:sessions')?.sessions || []).count;
      tabButtons.get('sessions').classList.toggle('has-badge', waiting > 0);
      const key = JSON.stringify([Boolean(rate), payload?.refreshEnabled, state.appearanceKey, state.locale]);
      if (statusKey !== key) {
        statusKey = key;
        status.replaceChildren();
        if (rate) {
          const reading = el('button', 'notch-rate');
          reading.type = 'button';
          reading.append(el('span', 'notch-live-dot'), text('notch-rate-value', ''), text('notch-rate-unit', ''));
          activateOnPress(reading, () => bridge.toggleRateMode());
          status.append(reading);
        }
        if (payload?.refreshEnabled) {
          if (status.childElementCount) status.append(el('span', 'notch-status-rule'));
          status.append(shared.ensureRefreshButton());
        }
      }
      const reading = status.querySelector('.notch-rate');
      if (!rate || !reading) return;
      const hasSample = Number.isFinite(rate.rate);
      const idle = !hasSample || rate.idle === true;
      const value = hasSample ? formatRate(rate.rate) : '—';
      const unit = t(rate.rateMode === 'burn' ? 'edgeDock.rate.burnUnit' : 'edgeDock.rate.speedUnit');
      reading.classList.toggle('is-idle', idle);
      reading.querySelector('.notch-rate-value').textContent = value;
      reading.querySelector('.notch-rate-unit').textContent = unit;
      reading.title = `${t(!hasSample ? 'edgeDock.rate.noSample' : idle ? 'edgeDock.rate.idle' : 'edgeDock.rate.live')} · ${t('notch.rateToggle')}`;
      reading.setAttribute('aria-label', `${value} ${unit} · ${reading.title}`);
    }

    // ---- Home -----------------------------------------------------------------

    function weekModel(nowMs) {
      const week = payload?.panel?.week || { days: [], todayClients: [] };
      const today = cell('stat:today');
      const days = week.days.map((day, index) => {
        const last = index === week.days.length - 1;
        return { ...day, tokens: last && today?.available ? today.totalTokens : day.tokens,
          costUsd: last && today?.available ? today.costUsd : day.costUsd,
          unpricedTokens: last && today?.available ? today.unpricedTokens || 0 : day.unpricedTokens || 0, today: last };
      });
      const max = Math.max(1, ...days.map((day) => day.tokens || 0));
      const total = days.reduce((sum, day) => sum + (day.tokens || 0), 0);
      const cost = days.reduce((sum, day) => sum + (day.costUsd || 0), 0);
      return { days, max, total, cost, clients: week.todayClients || [], nowMs };
    }

    function quotaReadings(entry, nowMs = Date.now()) {
      const record = headlineRecord(entry);
      if (!record) return [];
      return limitWindows(record).map((windowValue) => {
        const remaining = trayText.remainingPercent(windowValue, record);
        return { window: windowValue, record, remaining: remaining === null ? null : Math.round(remaining),
          credits: balance.isCreditsWindow(windowValue), nowMs };
      });
    }

    function percentText(remaining) {
      if (remaining === null) return '—';
      return `${appearance().showLimitUsed ? 100 - remaining : remaining}%`;
    }

    function homeNowRow(nowMs) {
      const sessions = cell('stat:sessions')?.sessions || [];
      const states = sessions.map((row) => presentation.sessionActivityState(row, nowMs));
      const activeIndex = states.findIndex((stateName) => stateName === 'running');
      const waitingCount = states.filter((stateName) => stateName === 'waiting').length;
      const index = activeIndex >= 0 ? activeIndex : states.findIndex((stateName) => stateName === 'waiting');
      const row = index >= 0 ? sessions[index] : sessions[0];
      const wrap = el('div', 'notch-now');
      if (!row) {
        wrap.classList.add('is-empty');
        wrap.append(text('notch-now-empty', t('notch.noSessions')));
        return wrap;
      }
      const live = index >= 0;
      const running = live && states[index] === 'running';
      wrap.classList.toggle('is-live', live);
      wrap.style.setProperty('--notch-accent', clientColor(row.client));
      const body = el('div', 'notch-now-body');
      body.append(sessionHeading(row, 'notch-now-title'));
      const meta = el('div', 'notch-now-meta');
      if (running) meta.append(wave());
      const parts = [clientLabel(row.client), sessionRows.sessionModelLabel(row)];
      if (running) parts.push(duration(row.startedAt, nowMs));
      else if (!live) parts.push(relativeAgo(row.lastUsedAt, nowMs));
      else parts.unshift(t('notch.waiting'));
      meta.append(text('', parts.filter(Boolean).join(' · ')));
      const extra = (running ? waitingCount : Math.max(0, waitingCount - 1));
      if (extra > 0) meta.append(text('notch-waiting-note', t('notch.moreWaiting', { count: extra })));
      body.append(meta);
      const value = el('div', 'notch-now-value');
      const tokens = sessionTokens(row, 'notch-now-tokens', false);
      tokens.title = `${t(live ? 'notch.thisSession' : 'notch.lastSession')} · ${formatCardTokens(row.totalTokens)}`;
      tokens.setAttribute('aria-label', tokens.title);
      value.append(tokens);
      const status = sessionStatus(row, nowMs);
      if (status) value.append(status);
      wrap.append(body, value);
      return wrap;
    }

    function homeFuel(nowMs) {
      const row = el('div', 'notch-fuel');
      const allProviders = providerCells();
      const label = t(appearance().showLimitUsed ? 'notch.limitsUsed' : 'notch.limitsLeft');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', label);
      const items = [];
      for (const entry of allProviders) {
        const readings = quotaReadings(entry, nowMs).slice(0, 2);
        if (!readings.length) continue;
        const item = el('span', 'notch-fuel-item');
        item.title = `${providerLabel(entry.provider)} · ${label}`;
        item.append(mark(entry.provider));
        readings.forEach((reading, index) => {
          if (index) item.append(text('notch-fuel-dot', '·'));
          const value = text('notch-fuel-value', reading.credits
            ? balance.formatCompactMoney(balance.creditsAmount(reading.record, reading.window), balance.creditsCurrency(reading.record, reading.window), appearance().compactTokenUnits, locale())
            : percentText(reading.remaining));
          const tone = appearance().notchWarnColors === true ? severity(reading.remaining) : '';
          if (tone) value.dataset.tone = tone;
          item.append(value);
        });
        items.push(item);
      }
      const more = el('button', 'notch-fuel-more');
      more.type = 'button';
      more.title = t('notch.tab.limits');
      more.setAttribute('aria-label', more.title);
      more.dataset.focusKey = 'home:limits';
      activateOnPress(more, () => selectPage('limits'));
      function show(count) {
        row.replaceChildren(...items.slice(0, count));
        const hidden = items.length - count;
        if (hidden > 0) {
          more.textContent = `+${hidden}`;
          row.append(more);
        }
        if (!row.childElementCount) row.append(text('notch-fuel-empty', t('notch.noLimits')));
      }
      show(items.length);
      fitHomeFuel = () => {
        if (!(row.clientWidth > 0)) return;
        const focused = document.activeElement === more;
        let count = items.length;
        show(count);
        // Reserve the actual +N width as well as complete provider groups.
        while (count > 0 && row.scrollWidth > row.clientWidth) show(--count);
        if (focused && row.contains(more)) more.focus({ preventScroll: true });
      };
      return row;
    }

    function renderHome(pageNode, nowMs) {
      const today = cell('stat:today');
      const week = weekModel(nowMs);
      const left = el('div', 'notch-home-main');
      const kicker = el('div', 'notch-kicker-row');
      const label = text('notch-kicker', t('notch.today'));
      const scrubDate = text('notch-scrub-date', '');
      kicker.append(label, scrubDate);
      const big = rolling(text('notch-big total-number', today?.available ? formatCardTokens(today.totalTokens) : '—'), 'today', today?.totalTokens);
      const cost = today?.available ? usageCost('notch-cost', today) : text('notch-cost', '');
      left.append(kicker, big, cost, homeNowRow(nowMs), homeFuel(nowMs));

      const right = el('div', 'notch-week');
      const head = el('div', 'notch-week-head');
      // Seven days can cross a month boundary; name both months then.
      const monthName = new Intl.DateTimeFormat(locale(), { month: 'long', timeZone: 'UTC' });
      const months = [...new Set([week.days[0]?.date, week.days.at(-1)?.date].filter(Boolean)
        .map((date) => monthName.format(new Date(`${date.slice(0, 7)}-01T00:00:00Z`))))];
      head.append(text('notch-week-title', months.length ? months.join('–') : new Intl.DateTimeFormat(locale(), { month: 'long' }).format(new Date(nowMs))),
        text('notch-week-caption', t('notch.last7')));
      const bars = el('div', 'notch-bars');
      const names = el('div', 'notch-week-names');
      const dates = el('div', 'notch-week-dates');
      const weekday = new Intl.DateTimeFormat(locale(), { weekday: 'narrow', timeZone: 'UTC' });
      week.days.forEach((day, index) => {
        const column = el('button', 'notch-day');
        column.type = 'button';
        column.dataset.focusKey = `day:${day.date}`;
        column.classList.toggle('is-today', day.today);
        column.style.setProperty('--i', index);
        const bar = el('div', 'notch-day-bar');
        bar.style.height = `${day.tokens ? Math.max(8, day.tokens / week.max * 100) : 0}%`;
        const clients = day.today ? week.clients : day.clients || [];
        if (clients.length) {
          for (const entry of clients) {
            const part = el('i');
            part.style.flex = String(entry.tokens);
            part.style.background = clientColor(entry.client);
            bar.append(part);
          }
          // Unattributed usage keeps its share, so tool colours are not stretched.
          const remainder = (day.tokens || 0) - clients.reduce((sum, entry) => sum + entry.tokens, 0);
          if (remainder > 0) {
            const part = el('i', 'is-unattributed');
            part.style.flex = String(remainder);
            bar.append(part);
          }
        }
        if (day.today && !clients.length) bar.classList.add('is-plain');
        if (day.tokens === null) column.classList.add('is-unknown');
        column.append(bar);
        column.title = `${day.date} · ${day.tokens === null ? '—' : formatTokens(day.tokens)}`;
        column.setAttribute('aria-label', column.title);
        column.addEventListener('pointerenter', () => {
          if (day.today || day.tokens === null) { scrub(null); return; }
          scrub({ day, label: weekday.format(new Date(`${day.date}T00:00:00Z`)) });
        });
        column.addEventListener('focus', () => { if (!day.today && day.tokens !== null) scrub({ day, label: weekday.format(new Date(`${day.date}T00:00:00Z`)) }); });
        column.addEventListener('blur', () => scrub(null));
        bars.append(column);
        names.append(text(day.today ? 'is-today' : '', weekday.format(new Date(`${day.date}T00:00:00Z`))));
        dates.append(text(day.today ? 'is-today' : '', String(Number(day.date.slice(8, 10)))));
      });
      bars.addEventListener('pointerleave', () => scrub(null));
      const foot = el('div', 'notch-week-foot');
      const partial = week.days.some((day) => day.tokens === null);
      const total = el('div', 'notch-week-summary');
      if (partial) total.append(text('notch-summary-label', t('notch.recorded')));
      const weekTokens = text('notch-week-tokens notch-strong', formatTokens(week.total));
      weekTokens.setAttribute('aria-label', `${t(partial ? 'notch.recorded' : 'notch.totalUsage')}: ${weekTokens.textContent}`);
      total.append(weekTokens);
      foot.append(total);
      if (week.cost > 0 || week.days.some(day => day.unpricedTokens > 0)) {
        const cost = el('div', 'notch-week-summary notch-week-cost');
        const value = usageCost('notch-week-cost-value', { costUsd: week.cost, unpricedTokens: week.days.reduce((sum, day) => sum + day.unpricedTokens, 0) });
        value.setAttribute('aria-label', `${t(partial ? 'notch.recordedCost' : 'notch.totalCost')}: ${value.textContent}`);
        cost.append(value);
        foot.append(cost);
      }
      right.append(head, bars, names, dates, foot);
      if (!payload?.panel?.week?.available) right.classList.add('is-partial');

      function scrub(value) {
        const leaving = view.scrub && !value;
        view.scrub = value;
        kicker.classList.toggle('is-scrubbing', Boolean(value));
        label.textContent = value ? value.label : t('notch.today');
        scrubDate.textContent = value ? `${Number(value.day.date.slice(5, 7))}/${Number(value.day.date.slice(8, 10))}` : '';
        const snapshot = captureRolls(pageNode);
        const amount = value ? value.day.tokens : today?.totalTokens;
        big.textContent = value ? formatCardTokens(amount) : today?.available ? formatCardTokens(amount) : '—';
        rolling(big, 'today', amount);
        fitBig();
        playRolls(pageNode, snapshot);
        const reading = value ? value.day : today?.available ? today : null;
        const costReading = reading ? usageCost('', reading) : text('', '');
        cost.textContent = costReading.textContent;
        cost.title = costReading.title || '';
        if (leaving) renderPage('home');
      }
      pageNode.replaceChildren(left, right);
      function fitBig() {
        fitTokenFigure(big, 40);
      }
      fitBig();
      fitHomeFuel();
    }

    // ---- Limits ---------------------------------------------------------------

    // The headline may sit past the card's account cap, so it is looked up in
    // every record. A fallback only ever picks a visible account: the wider list
    // also holds accounts the user hid from this provider.
    function headlineRecord(entry) {
      const visible = (entry.accounts || []).map((account) => account.record).filter(Boolean);
      const headline = entry.headlineAccount
        ? [...visible, ...(entry.subscriptionAccounts || [])].find((record) => record && resetMotion.providerKey(record) === entry.headlineAccount)
        : null;
      return headline || visible.find((record) => record.status === 'ok') || visible[0] || null;
    }

    function limitWindows(record) {
      const options = { showCodexAdditionalLimits: appearance().showCodexAdditionalLimits };
      return (record?.windows || []).filter((value) => value
        && !(record.provider === 'codex' && value.additional === true && options.showCodexAdditionalLimits === false));
    }

    function limitColumn(entry, nowMs) {
      const column = el('div', 'notch-limit');
      const record = headlineRecord(entry);
      const head = el('div', 'notch-limit-head');
      head.append(mark(entry.provider), text('notch-limit-name', providerLabel(entry.provider)));
      const plan = String(record?.planLabel || '').trim();
      if (plan) head.append(text('notch-chip', plan));
      const sub = el('div', 'notch-limit-sub');
      if ((entry.accountCount || 0) > 1) {
        const peers = (entry.accounts || []).map(account => account.record).filter(Boolean);
        if (record && !peers.includes(record)) peers.push(record);
        const shown = record ? limitAccountTitle(entry.provider, record, peers.indexOf(record), peers) : '';
        sub.append(text('notch-limit-account', shown || t('settings.codex.nAccounts', { count: entry.accountCount }), shown));
      } else if (record?.updatedAt) {
        sub.append(text('', t('notch.updated', { time: relativeAgo(record.updatedAt, nowMs) })));
      }
      column.append(head, sub);
      const allReadings = record ? quotaReadings(entry, nowMs) : [];
      const windowCount = Math.ceil(allReadings.length / 2);
      const windowPage = Math.min(windowPages.get(entry.id) || 0, Math.max(0, windowCount - 1));
      const readings = allReadings.slice(windowPage * 2, windowPage * 2 + 2);
      const list = el('div', 'notch-limit-windows');
      for (const reading of readings) {
        const row = el('div', 'notch-limit-window');
        const tone = appearance().notchWarnColors === true ? severity(reading.remaining) : '';
        if (tone) row.dataset.tone = tone;
        const label = el('span', 'notch-limit-label');
        label.append(text('', windowLabels.limitWindowLabel(entry.provider, reading.window, t('notch.quota'))));
        const value = el('span', 'notch-limit-value');
        const description = windowText.limitWindowText(reading.record, reading.window, { showLimitUsed: appearance().showLimitUsed, formatCompact: formatTokens });
        const note = String(reading.window.detail || '').toLowerCase() === 'unlimited'
          ? t('settings.thirdparty.unlimited') : description.value || (reading.remaining === null ? reading.window.detail : '');
        if (reading.credits) {
          const amount = balance.creditsAmount(reading.record, reading.window);
          value.append(text('notch-limit-money', balance.formatCompactMoney(amount, balance.creditsCurrency(reading.record, reading.window),
            appearance().compactTokenUnits, locale())));
        } else if (note) {
          value.append(text('notch-limit-detail', note));
        } else {
          const shown = reading.remaining === null ? null : appearance().showLimitUsed ? 100 - reading.remaining : reading.remaining;
          value.append(text('notch-limit-number', shown === null ? '—' : String(shown)));
          if (shown !== null) value.append(text('notch-limit-percent', '%'));
        }
        const reset = trayLayout.formatResetCountdown(reading.window.resetsAt, nowMs);
        row.append(label, value, text('notch-limit-reset', reset ? t('notch.resetIn', { time: reset }) : ''));
        list.append(row);
      }
      if (!readings.length || entry.status !== 'ok') list.append(text('notch-limit-note', t(entry.status === 'stale' ? 'settings.limits.status.stale' : 'edgeDock.unavailable')));
      column.append(list);
      if (windowCount > 1) {
        const more = el('button', 'notch-window-page', `${windowPage + 1} / ${windowCount}`);
        more.type = 'button';
        more.dataset.focusKey = `windows:${entry.id}`;
        more.setAttribute('aria-label', `${providerLabel(entry.provider)} · ${t('notch.pageLabel', { page: (windowPage + 1) % windowCount + 1, count: windowCount })}`);
        activateOnPress(more, () => { windowPages.set(entry.id, (windowPage + 1) % windowCount); renderPage('limits', { force: true }); });
        column.append(more);
      }
      return column;
    }

    function renderLimits(pageNode, nowMs) {
      const entries = providerCells();
      const pageCount = Math.max(1, Math.ceil(entries.length / LIMIT_COLUMNS));
      view.limitPage = Math.min(view.limitPage, pageCount - 1);
      const grid = el('div', 'notch-limits');
      for (const entry of entries.slice(view.limitPage * LIMIT_COLUMNS, (view.limitPage + 1) * LIMIT_COLUMNS)) grid.append(limitColumn(entry, nowMs));
      if (!entries.length) grid.append(text('notch-empty', t('notch.noLimits')));
      pageNode.replaceChildren(grid);
      if (pageCount > 1) {
        const pager = el('div', 'notch-pager');
        for (let index = 0; index < pageCount; index += 1) {
          const dot = el('button', index === view.limitPage ? 'is-selected' : '');
          dot.type = 'button';
          dot.setAttribute('aria-label', t('notch.pageLabel', { page: index + 1, count: pageCount }));
          dot.setAttribute('aria-pressed', String(index === view.limitPage));
          dot.dataset.focusKey = `limits:${index}`;
          activateOnPress(dot, () => { view.limitPage = index; renderPage('limits'); });
          pager.append(dot);
        }
        pageNode.append(pager);
      }
    }

    // ---- Sessions -------------------------------------------------------------

    function sessionTitle(row) {
      return sessionRows.sessionTitleForDisplay(row) || row.projectLabel || String(row.sessionId || '').slice(0, 12) || '—';
    }

    function sessionHeading(row, className) {
      const heading = el('div', 'notch-session-heading');
      const title = text(className, sessionTitle(row));
      title.dataset.overflowKey = JSON.stringify(['notch', view.page, row.key || `${row.client}:${row.sessionId}`]);
      overflowText.bind(title);
      heading.append(mark(row.client), title);
      return heading;
    }

    function sessionTokens(row, className, compact = true) {
      const format = compact ? formatBreakdownTokens : formatCardTokens;
      return rolling(text(`${className} row-value notch-session-tokens`, format(row.totalTokens), formatCardTokens(row.totalTokens)),
        `session:${view.page}:${row.key || `${row.client}:${row.sessionId}`}`, row.totalTokens, format);
    }

    // The same status node the Home list and Edge Dock card draw.
    function sessionStatus(row, nowMs) {
      return sessionRows.sessionStatusNode(document, row, { prefix: 'notch-session', translate: t, view: limitWindowsView,
        showUsed: appearance().sessionContextMetric !== 'remaining', now: nowMs });
    }

    function activeRow(row, stateName, nowMs) {
      const node = el('div', `notch-active is-${stateName}`);
      node.style.setProperty('--notch-accent', clientColor(row.client));
      const body = el('div', 'notch-active-body');
      body.append(sessionHeading(row, 'notch-active-title'));
      const meta = el('div', 'notch-active-meta');
      if (stateName === 'running') meta.append(wave());
      else meta.append(text('notch-pill', t('notch.waiting')));
      meta.append(text('', [clientLabel(row.client), sessionRows.sessionModelLabel(row), duration(row.startedAt, nowMs)].filter(Boolean).join(' · ')));
      body.append(meta);
      const value = el('div', 'notch-active-value');
      value.append(sessionTokens(row, 'notch-active-tokens', false));
      const status = sessionStatus(row, nowMs);
      if (status) value.append(status);
      node.append(body, value);
      return node;
    }

    function renderSessions(pageNode, nowMs, scrollTop = 0) {
      const sessions = cell('stat:sessions')?.sessions || [];
      const states = sessions.map((row) => presentation.sessionActivityState(row, nowMs));
      const active = sessions.map((row, index) => ({ row, state: states[index] }))
        .filter((entry) => entry.state === 'running' || entry.state === 'waiting')
        .sort((a, b) => Number(a.state === 'running') - Number(b.state === 'running'));
      const recent = sessions.filter((_row, index) => states[index] !== 'running' && states[index] !== 'waiting');
      const left = el('div', 'notch-sessions-active');
      const leftHead = el('div', 'notch-section-head');
      leftHead.append(text('notch-kicker', t('notch.active')), text('notch-section-count', active.length ? t('notch.activeCount', { count: active.length }) : ''));
      left.append(leftHead);
      if (active.length) {
        for (const entry of active.slice(0, ACTIVE_ROWS)) left.append(activeRow(entry.row, entry.state, nowMs));
        if (active.length > ACTIVE_ROWS) left.append(text('notch-more', t('notch.moreActive', { count: active.length - ACTIVE_ROWS })));
      } else {
        const empty = el('div', 'notch-sessions-empty');
        empty.append(text('notch-empty-title', t('notch.idle')));
        const time = relativeAgo(sessions[0]?.lastUsedAt, nowMs);
        if (time) empty.append(text('', t('notch.lastActive', { time })));
        left.append(empty);
      }
      const right = el('div', 'notch-sessions-recent');
      const rightHead = el('div', 'notch-section-head');
      rightHead.append(text('notch-kicker', t('notch.recent')));
      if (recent.length) rightHead.append(text('notch-section-count', String(recent.length)));
      right.append(rightHead);
      const list = el('div', 'notch-recent-list');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', t('notch.recent'));
      if (recent.length) list.tabIndex = 0;
      list.dataset.focusKey = 'recent:list';
      for (const row of recent) {
        const line = el('div', 'notch-recent');
        line.setAttribute('role', 'listitem');
        const body = el('div', 'notch-recent-body');
        body.append(sessionHeading(row, 'notch-recent-title'),
          text('notch-recent-meta', [sessionRows.sessionModelLabel(row), relativeAgo(row.lastUsedAt, nowMs)].filter(Boolean).join(' · ')));
        const value = el('div', 'notch-recent-value');
        value.append(sessionTokens(row, 'notch-recent-tokens'));
        const status = sessionStatus(row, nowMs);
        if (status) value.append(status);
        line.append(body, value);
        list.append(line);
      }
      if (!recent.length) list.append(text('notch-empty', t('notch.noSessions')));
      right.append(list);
      pageNode.replaceChildren(left, el('div', 'notch-rule'), right);
      list.scrollTop = scrollTop;
    }

    // ---- Breakdown --------------------------------------------------------------

    function segmented(className, options, selected, onSelect) {
      const group = el('div', `notch-segmented ${className}`);
      const pill = el('span', 'notch-segmented-pill');
      group.append(pill);
      for (const [value, label] of options) {
        const button = el('button', value === selected ? 'is-selected' : '', label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(value === selected));
        button.dataset.focusKey = `${className}:${value}`;
        activateOnPress(button, () => onSelect(value));
        group.append(button);
      }
      requestAnimationFrame(() => {
        const on = group.querySelector('button.is-selected');
        if (!on) return;
        pill.style.width = `${on.offsetWidth}px`;
        pill.style.transform = `translateX(${on.offsetLeft - 2}px)`;
      });
      return group;
    }

    function breakdownColumn(by, period) {
      const column = el('section', `notch-breakdown-column notch-breakdown-${by}`);
      column.setAttribute('aria-label', t(by === 'tool' ? 'notch.tools' : 'notch.models'));
      const heading = el('div', 'notch-breakdown-column-head');
      heading.append(el('h3', 'notch-breakdown-label', t(by === 'tool' ? 'notch.tools' : 'notch.models')));
      column.append(heading);
      const entries = by === 'tool'
        ? (period?.clients || []).map((entry) => ({ key: entry.client, tokens: entry.tokens, client: entry.client, unattributed: entry.unattributed }))
        : (period?.models || []).map((entry) => ({ key: entry.model, tokens: entry.tokens, model: entry.model, unattributed: entry.unattributed }));
      const rows = breakdownRows(entries);
      // Both columns describe this same period, rather than separate subtotals.
      const total = period?.totalTokens || 0;
      const colorFor = (row) => row.other || row.unattributed ? 'var(--notch-faint)' : row.client ? clientColor(row.client) : readableColor(modelColor(row.model));
      const labelFor = (row) => row.other ? t('notch.other') : row.unattributed ? t('dashboard.tooltip.unclassified') : row.client ? clientLabel(row.client) : row.model;
      const spectrum = el('div', 'notch-spectrum');
      spectrum.setAttribute('aria-hidden', 'true');
      const rank = el('div', 'notch-rank');
      rank.setAttribute('role', 'list');
      rows.forEach((row, index) => {
        const color = colorFor(row);
        const segment = el('i');
        segment.style.flex = String(row.tokens);
        segment.style.background = color;
        segment.dataset.index = index;
        spectrum.append(segment);
        const line = el('div', 'notch-rank-row');
        line.dataset.index = index;
        line.dataset.focusKey = JSON.stringify(['breakdown', by, row.other === true, row.key]);
        line.tabIndex = 0;
        line.setAttribute('role', 'listitem');
        if (row.client && !row.unattributed && hasMask(row.client)) line.append(mark(row.client));
        else {
          const swatch = el('span', 'notch-swatch');
          swatch.style.background = color;
          line.append(swatch);
        }
        line.append(text('notch-rank-name', labelFor(row), labelFor(row)), text('notch-rank-tokens row-value', formatBreakdownTokens(row.tokens)),
          text('notch-rank-share', total > 0 ? `${Math.round(row.tokens / total * 100)}%` : ''));
        line.addEventListener('pointerenter', () => highlight(index));
        line.addEventListener('pointerleave', () => highlight(null));
        line.addEventListener('focus', () => highlight(index));
        line.addEventListener('blur', () => highlight(null));
        rank.append(line);
      });
      function highlight(index) {
        spectrum.classList.toggle('is-hovering', index !== null);
        rank.classList.toggle('is-hovering', index !== null);
        for (const node of [...spectrum.children, ...rank.children]) node.classList.toggle('is-highlighted', Number(node.dataset.index) === index);
      }
      column.append(...(rows.length ? [spectrum, rank]
        : [text('notch-empty', t(period?.available ? 'notch.noUsage' : 'edgeDock.unavailable'))]));
      return column;
    }

    function renderBreakdown(pageNode) {
      const period = cell(`stat:${view.breakdownPeriod}`);
      const head = el('div', 'notch-breakdown-head');
      const total = el('div', 'notch-breakdown-total');
      const tokens = rolling(text('notch-breakdown-tokens total-number', period?.available ? formatCardTokens(period.totalTokens) : '—'), `breakdown:${view.breakdownPeriod}`, period?.totalTokens);
      total.append(tokens, text('sr-only', t('dashboard.heatmap.tokens')),
        period?.available ? usageCost('notch-breakdown-cost', period) : text('notch-breakdown-cost', ''));
      head.append(total, segmented('notch-breakdown-period', [['today', t('notch.today')], ['month', t('notch.month')]], view.breakdownPeriod,
        (value) => { view.breakdownPeriod = value; renderPage('breakdown'); }));
      const columns = el('div', 'notch-breakdown-columns');
      const rule = el('div', 'notch-rule');
      rule.setAttribute('aria-hidden', 'true');
      columns.append(breakdownColumn('tool', period), rule, breakdownColumn('model', period));
      pageNode.replaceChildren(head, columns);
      fitTokenFigure(tokens, 30);
    }

    // ---- Shared ---------------------------------------------------------------

    function wave() {
      const node = el('span', 'notch-wave');
      node.setAttribute('aria-hidden', 'true');
      for (let index = 0; index < 5; index += 1) node.append(el('i'));
      return node;
    }

    // Each page rebuilds only when what it draws changes. Live counters still
    // move with each push because tokens are part of the page key.
    function pageKey(page, nowMs) {
      const minute = Math.floor(nowMs / 60000);
      const sessions = cell('stat:sessions')?.sessions || [];
      const status = sessions.map(row => [presentation.sessionActivityState(row, nowMs),
        sessionLive.sessionPromptCacheForRow(row.groupRows?.[0] || row, nowMs)?.minutes || 0]);
      const base = [state.appearanceKey, state.locale, minute];
      if (page === 'home') return JSON.stringify([...base, cell('stat:today'), cell('stat:sessions')?.sessions, payload?.panel?.week,
        status, providerCells().map((entry) => [entry.id, entry.remainingPercent, entry.headlineAccount, entry.accounts?.map((account) => account.record)])]);
      if (page === 'limits') return JSON.stringify([...base, view.limitPage, providerCells().map((entry) => [entry.id, entry.status, entry.headlineAccount, entry.accountCount, entry.accounts?.map((account) => account.record), headlineRecord(entry)])]);
      if (page === 'sessions') return JSON.stringify([...base, cell('stat:sessions')?.sessions, status]);
      return JSON.stringify([...base, view.breakdownPeriod, cell(`stat:${view.breakdownPeriod}`)]);
    }

    function renderPage(page, { force = false } = {}) {
      const nowMs = Date.now();
      const key = pageKey(page, nowMs);
      if (!force && pageKeys.get(page) === key) return;
      // Hover readings belong to the DOM they were made on; a rebuild under
      // the pointer would otherwise drop the scrubbed day mid-gesture.
      if (page === 'home' && view.scrub && !force) return;
      if (pageKeys.has(page)) node.classList.remove('is-entering');
      pageKeys.set(page, key);
      const pageNode = pageNodes.get(page);
      const focused = pageNode.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : null;
      const recentScroll = pageNode.querySelector('.notch-recent-list')?.scrollTop || 0;
      const snapshot = page === view.page ? captureRolls(pageNode) : new Map();
      const previous = el('div');
      previous.append(...pageNode.children);
      if (page === 'home') renderHome(pageNode, nowMs);
      else if (page === 'limits') renderLimits(pageNode, nowMs);
      else if (page === 'sessions') renderSessions(pageNode, nowMs, recentScroll);
      else renderBreakdown(pageNode, nowMs);
      overflowText.preserveReading(previous, pageNode);
      overflowText.refresh();
      playRolls(pageNode, snapshot);
      if (focused) [...pageNode.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === focused)?.focus({ preventScroll: true });
    }

    function render(next, { opening = false } = {}) {
      payload = next;
      node.classList.toggle('is-reduced-motion', prefersReducedMotion());
      if (opening) {
        view.scrub = null; pageKeys = new Map();
        // Entrance motion plays once per reveal, never on a data push.
        node.classList.add('is-entering');
        clearTimeout(enteringTimer);
        enteringTimer = setTimeout(() => node.classList.remove('is-entering'), 1200);
      }
      paintTabs();
      paintStatus();
      // Hidden pages refresh when selected; only the visible one tracks pushes.
      renderPage(view.page);
    }

    function place(geometry, zoom) {
      const attached = geometry?.notched === true && geometry.gapWidth > 0;
      node.style.setProperty('--notch-band-height', `${attached ? geometry.height / zoom : PANEL_METRICS.band}px`);
      node.style.setProperty('--notch-gap-width', `${attached ? geometry.gapWidth / zoom : 0}px`);
      node.classList.toggle('is-attached', attached);
    }

    node.addEventListener('pointerleave', () => { if (view.scrub) { view.scrub = null; renderPage('home', { force: true }); } });
    function stopTitleReading() {
      for (const title of node.querySelectorAll('.fade-overflow')) overflowText.stop(title);
    }
    function suspend() {
      settleRolls();
      stopTitleReading();
      clearTimeout(enteringTimer);
      node.classList.remove('is-entering');
      view.scrub = null;
    }
    const fuelObserver = typeof window.ResizeObserver === 'function'
      ? new window.ResizeObserver(() => fitHomeFuel()) : null;
    fuelObserver?.observe(pageNodes.get('home'));
    window.addEventListener('pagehide', () => { suspend(); fuelObserver?.disconnect(); }, { once: true });
    paintTabs();
    return { node, render, place, selectPage, suspend, contentHeight: panelContentHeight, view };
  }

  return { PANEL_METRICS, PAGES, breakdownRows, createNotchPanel, panelContentHeight };
});
