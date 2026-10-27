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
  const scrollApi = (typeof module === 'object' && module.exports) ? require('./scrollGesture') : window.TokenMonitorNotchScroll;
  const { swipeDestination } = scrollApi;
  // Logical points inside the zoomed panel. The band shares the camera row on
  // an attached shell and becomes the first row of a capsule.
  const PANEL_METRICS = Object.freeze({ band: 34, pages: 176, gap: 6, bottom: 18, padding: 24 });
  const PAGES = Object.freeze(['home', 'limits', 'sessions', 'breakdown']);
  const LIMIT_COLUMNS = 3;
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
    const { markNode, hasMask, providerLabel, limitProviderColor, formatTokens, formatCardTokens, formatBreakdownTokens, usageCostNode: usageCost, formatRate,
      appearance, prefersReducedMotion, readableColor = color => color, limitAccountTitle, overflowText, limitWindowsView } = shared;
    const presentation = window.TokenMonitorEdgeDockPresentation;
    const trayText = window.TokenMonitorTrayText;
    const balance = window.TokenMonitorLimitBalanceDisplay;
    const windowLabels = window.TokenMonitorLimitWindowLabels;
    const windowText = window.TokenMonitorLimitWindowText;
    const resetMotion = window.TokenMonitorLimitResetMotion;
    const sessionRows = window.TokenMonitorSessionRows;
    const sessionLive = window.TokenMonitorSessionLive;
    const { clientColors, modelColor } = window.TokenMonitorUsageCharts;
    const { CLIENT_LABELS } = window.TokenMonitorClientCatalog;
    const { activateOnPress } = window.TokenMonitorPressActivation;
    const homeOverview = window.TokenMonitorHomeOverview;
    const usageItems = window.TokenMonitorLimitUsageItems;
    const limitPresentation = window.TokenMonitorLimitProviderPresentation;

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
    let sessionScroll = { active: 0, recent: 0 };
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
      if (title) node.setAttribute('aria-label', title);
      return node;
    }
    function fitTokenFigure(number, size) {
      number.style.fontSize = `${size}px`;
      if (number.clientWidth > 0 && number.scrollWidth > number.clientWidth) {
        number.style.fontSize = `${Math.max(18, Math.floor(size * number.clientWidth / number.scrollWidth))}px`;
      }
    }

    // ---- Band -----------------------------------------------------------------

    function commitPage(page) {
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

    let gesture = null;
    let shown = true;
    function clearPageMotion() {
      for (const pageNode of pageNodes.values()) {
        pageNode.style.opacity = '';
        pageNode.style.transform = '';
        pageNode.style.filter = '';
      }
      if (pages.classList.contains('is-handoff')) {
        // CSS transitions resume only after resting styles are committed.
        void pages.offsetWidth;
        pages.classList.remove('is-handoff');
        tabPill.style.transition = '';
      }
    }
    function dropGesture() {
      gesture = null;
      const strip = node.querySelector('.notch-limits');
      strip?.classList.remove('is-handoff');
    }
    function selectPage(page) {
      if (!PAGES.includes(page) || view.page === page) return;
      dropGesture();
      clearPageMotion();
      commitPage(page);
    }
    // An empty page must not overwrite the last scroll positions.
    function captureSessionScroll(pageNode) {
      if (pageNode.childElementCount) {
        sessionScroll = {
          active: pageNode.querySelector('.notch-active-list')?.scrollTop || 0,
          recent: pageNode.querySelector('.notch-recent-list')?.scrollTop || 0
        };
      }
      return sessionScroll;
    }
    function dropHiddenPages() {
      for (const [page, pageNode] of pageNodes) {
        if (page === view.page) continue;
        if (page === 'sessions') captureSessionScroll(pageNode);
        pageNode.replaceChildren();
        pageKeys.delete(page);
      }
    }
    function showDrag(origin, target, amount) {
      if (origin === target) amount = 0;
      const travel = Math.min(1, Math.abs(amount));
      pages.classList.add('is-handoff');
      PAGES.forEach((page, index) => {
        const pageNode = pageNodes.get(page);
        const shift = index === origin ? -amount : Math.sign(target - origin) * (1 - travel);
        pageNode.style.opacity = index === origin || index === target ? '1' : '0';
        pageNode.style.transform = `translateX(${shift * gesture.pageStep}px)`;
        pageNode.style.filter = 'none';
      });
      placeTabs(origin + (target - origin) * travel, { track: true });
    }
    // Tab springs are disabled during native tracking.
    function placeTabs(position, { track = false } = {}) {
      const clamped = Math.max(0, Math.min(PAGES.length - 1, position));
      const nearest = Math.round(clamped);
      if (track) tabPill.style.transition = 'none';
      else if (tabPill.style.transition === 'none' && !pages.classList.contains('is-handoff')) {
        tabPill.style.transition = '';
        void tabPill.offsetWidth;
      }
      tabPill.style.transform = `translateX(${((track ? clamped : nearest) * 36).toFixed(2)}px)`;
      for (const [page, button] of tabButtons) {
        const on = page === PAGES[nearest];
        button.classList.toggle('is-selected', on);
        button.setAttribute('aria-selected', String(on));
        if (!track) button.tabIndex = on ? 0 : -1;
      }
    }

    function paintTabs() {
      tabs.setAttribute('aria-label', t('settings.notch.title'));
      for (const [page, button] of tabButtons) {
        const selected = page === view.page;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        button.setAttribute('aria-label', t(`notch.tab.${page}`));
      }
      placeTabs(PAGES.indexOf(view.page));
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
          const icon = el('span', 'notch-rate-icon');
          icon.setAttribute('aria-hidden', 'true');
          reading.append(icon, text('notch-rate-value', ''), text('notch-rate-unit', ''));
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
      const description = `${t(!hasSample ? 'edgeDock.rate.noSample' : idle ? 'edgeDock.rate.idle' : 'edgeDock.rate.live')} · ${t('notch.rateToggle')}`;
      reading.setAttribute('aria-label', `${value} ${unit} · ${description}`);
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
      return { days, max, total, cost, clients: week.todayClients || [], complete: week.complete, nowMs };
    }

    function quotaReadings(entry, nowMs = Date.now()) {
      return accountReadings(headlineRecord(entry), nowMs);
    }

    // An account's windows, led by the pair Home's limits card shows: the same
    // compact pick (Antigravity's tightest per model group, Codex's canonical
    // windows) in the same shortest-cycle-first order. The rest follow in the
    // collector's order, so a third window is one window page away.
    function orderedWindows(record) {
      const windows = limitWindows(record);
      const lead = new Set(limitPresentation.limitProviderCompactWindows(record, windows));
      const rank = (value) => homeOverview.compactWindowRank(record.provider, value);
      return [...windows.filter((value) => lead.has(value)).sort((a, b) => rank(a) - rank(b)),
        ...windows.filter((value) => !lead.has(value))];
    }

    function accountReadings(record, nowMs = Date.now()) {
      if (!record) return [];
      return orderedWindows(record).map((windowValue) => {
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
      const label = el('span');
      if (!running && live) label.append(text('', `${t('notch.waiting')} · `));
      label.append(text('', clientLabel(row.client)));
      if (sessionRows.sessionModelMetadataLabel(row)) label.append(text('', ' · '), sessionModelMetadata(row));
      const time = running ? duration(row.startedAt, nowMs) : !live ? relativeAgo(row.lastUsedAt, nowMs) : '';
      if (time) label.append(text('', ` · ${time}`));
      meta.append(label);
      const extra = (running ? waitingCount : Math.max(0, waitingCount - 1));
      if (extra > 0) meta.append(text('notch-waiting-note', t('notch.moreWaiting', { count: extra })));
      body.append(meta);
      const value = el('div', 'notch-now-value');
      const tokens = sessionTokens(row, 'notch-now-tokens', false);
      tokens.setAttribute('aria-label', `${t(live ? 'notch.thisSession' : 'notch.lastSession')} · ${formatCardTokens(row.totalTokens)}`);
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
        item.setAttribute('aria-label', `${providerLabel(entry.provider)} · ${label}`);
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
      more.setAttribute('aria-label', t('notch.tab.limits'));
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
      const bars = el('div', 'notch-week-bars');
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
        column.append(bar);
        // A day without data keeps a small baseline mark, so it does not read as a quiet day.
        if (day.tokens === null) column.classList.add('is-unknown');
        column.setAttribute('aria-label', `${day.date} · ${day.tokens === null ? '—' : formatTokens(day.tokens)}`);
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
      // Keep the total plain; the shared info icon makes incomplete history
      // discoverable without turning the number itself into a hover target.
      const partial = week.complete === false || week.days.some((day) => day.tokens === null);
      const total = el('div', 'notch-week-summary');
      const weekTokens = text('notch-week-tokens notch-strong', formatTokens(week.total));
      weekTokens.setAttribute('aria-label', `${t('notch.totalUsage')}: ${weekTokens.textContent}`);
      total.append(weekTokens);
      if (partial) {
        const info = limitWindowsView.limitDetailInfoNode([{ full: t('notch.partialHistory') }], 'notch-week-info', t('notch.partialHistory'));
        info.querySelector('.limit-detail-tooltip').classList.add('is-centered');
        info.querySelector('.limit-detail-tooltip-trigger').dataset.focusKey = 'week:history-info';
        total.append(info);
      }
      foot.append(total);
      if (week.cost > 0 || week.days.some(day => day.unpricedTokens > 0)) {
        const cost = el('div', 'notch-week-summary notch-week-cost');
        const value = usageCost('notch-week-cost-value', { costUsd: week.cost, unpricedTokens: week.days.reduce((sum, day) => sum + day.unpricedTokens, 0) });
        value.setAttribute('aria-label', `${t('notch.totalCost')}: ${value.textContent}`);
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
        cost.replaceChildren(...costReading.children);
        cost.classList.toggle('edge-dock-cost-reading', Boolean(reading));
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

    // Windows the user hid on the Limits page stay hidden here, before the
    // compact pick, exactly as Home and the Edge Dock card apply them.
    function limitWindows(record) {
      const options = { showCodexAdditionalLimits: appearance().showCodexAdditionalLimits };
      const hidden = appearance().limitProviderHiddenItems;
      return (record?.windows || []).filter((value) => value
        && !(record.provider === 'codex' && value.additional === true && options.showCodexAdditionalLimits === false)
        && !usageItems.isLimitWindowHidden(hidden, record.provider, value));
    }

    // One column per visible account, in the collector's order (as the Limits
    // view lists them), so a provider with several logins shows every one of
    // them rather than only its headline. A provider with nothing to report
    // keeps one column for its status.
    function limitColumns() {
      return providerCells().flatMap((entry) => {
        const records = (entry.accounts || []).map((account) => account.record).filter(Boolean);
        if (!records.length) return [{ entry, account: null, record: null, records, key: entry.id }];
        return (entry.accounts || []).filter((account) => account.record).map((account, index) => ({
          entry, account, record: account.record, records,
          key: `${entry.id}:${resetMotion.providerKey(account.record) || index}`
        }));
      });
    }

    function limitColumn({ entry, account, record, records, key }, nowMs) {
      const column = el('div', 'notch-limit');
      // The plan sits beside the name, as on the Limits view; fitLimitPlans()
      // moves it to the line below only where it would cut the name short.
      const head = el('div', 'notch-limit-head');
      const name = text('notch-limit-name', providerLabel(entry.provider));
      name.dataset.overflowKey = JSON.stringify(['notch', 'limits', key, 'name']);
      overflowText.bind(name);
      head.append(mark(entry.provider), name);
      const usable = record && (record.status === 'ok' || record.stale);
      // The Limits view's own plan text: Claude and Codex keep the plan in
      // accountLabel, which planLabel alone never sees.
      const plan = usable ? String(limitWindowsView.limitAccountPlan(record, { grouped: records.length > 1 }) || '').trim() : '';
      if (plan) head.append(text('notch-chip', plan));
      const sub = el('div', 'notch-limit-sub');
      if (records.length > 1) {
        const shown = limitAccountTitle(entry.provider, record, records.indexOf(record), records);
        const accountName = text('notch-limit-account', shown || t('settings.codex.nAccounts', { count: records.length }), shown);
        accountName.dataset.overflowKey = JSON.stringify(['notch', 'limits', key, 'account']);
        overflowText.bind(accountName);
        sub.append(accountName);
        if (account?.active) {
          const live = text('notch-limit-active', '✓', t('limits.codex.activeAccountHint'));
          live.setAttribute('aria-label', t('limits.codex.activeAccountHint'));
          sub.append(live);
        }
      }
      // The Limits view's freshness reading, so an offline cached row says
      // Stale rather than passing for a fresh one.
      const freshness = record ? limitPresentation.limitProviderFreshness(record, { nowMs }) : null;
      if (freshness?.tone === 'stale') column.dataset.tone = 'stale';
      if (records.length > 1) {
        // The Limits view's own word: its freshness line is English on every
        // locale, and the translated status tag belongs to Settings.
        if (freshness?.tone === 'stale') sub.append(text('notch-limit-stale', 'Stale', freshness.text));
      } else if (freshness) {
        sub.append(text('notch-limit-updated', freshness.text));
      }
      column.append(head, sub);
      // The column fits up to four windows, drawing them tighter as there are
      // more, so Command Code's grant or Antigravity's second group need no
      // page of their own. Only a longer list pages, three at a time beside
      // its page button.
      const allReadings = usable ? accountReadings(record, nowMs) : [];
      const perPage = allReadings.length > 4 ? 3 : 4;
      const windowCount = Math.ceil(allReadings.length / perPage);
      const windowPage = Math.min(windowPages.get(key) || 0, Math.max(0, windowCount - 1));
      const readings = allReadings.slice(windowPage * perPage, windowPage * perPage + perPage);
      const list = el('div', 'notch-limit-windows');
      list.dataset.count = String(Math.max(1, readings.length + (windowCount > 1 ? 1 : 0)));
      for (const reading of readings) {
        const row = el('div', 'notch-limit-window');
        const tone = appearance().notchWarnColors === true ? severity(reading.remaining) : '';
        if (tone) row.dataset.tone = tone;
        // Long labels (Antigravity's "Claude/GPT 5-hour") fade and scroll into
        // view on hover, as session titles do, instead of ending in an ellipsis.
        const label = text('notch-limit-label', windowLabels.limitWindowLabel(entry.provider, reading.window, t('notch.quota')));
        label.dataset.overflowKey = JSON.stringify(['notch', 'limits', key, 'window', windowPage, readings.indexOf(reading)]);
        overflowText.bind(label);
        const value = el('span', 'notch-limit-value');
        const description = windowText.limitWindowText(reading.record, reading.window, { showLimitUsed: appearance().showLimitUsed, formatCompact: formatTokens });
        const note = String(reading.window.detail || '').toLowerCase() === 'unlimited'
          ? t('settings.thirdparty.unlimited') : description.value || (reading.remaining === null ? reading.window.detail : '');
        // Money leads only where the Limits view leads with it: a balance with
        // no allowance. A grant measured against one reads as its percentage,
        // with the amounts on hover, as the Limits view prints them.
        if (description.detail) value.setAttribute('aria-label', description.detail);
        if (reading.credits && !description.percentLeads) {
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
        // The Limits view's own boundary line: an expiring grant says Expires
        // and a mixed one Changes in, never a Reset that implies a refill.
        row.append(label, value, text('notch-limit-reset', limitPresentation.limitBoundaryText(reading.window)));
        list.append(row);
      }
      if (!readings.length) {
        const stale = record ? record.status === 'stale' : entry.status === 'stale';
        list.append(text('notch-limit-note', t(stale ? 'settings.limits.status.stale' : 'edgeDock.unavailable')));
      }
      column.append(list);
      if (windowCount > 1) {
        const more = el('button', 'notch-window-page', `${windowPage + 1} / ${windowCount}`);
        more.type = 'button';
        more.dataset.focusKey = `windows:${key}`;
        more.setAttribute('aria-label', `${providerLabel(entry.provider)} · ${t('notch.pageLabel', { page: (windowPage + 1) % windowCount + 1, count: windowCount })}`);
        activateOnPress(more, () => { windowPages.set(key, (windowPage + 1) % windowCount); renderPage('limits', { force: true }); });
        column.append(more);
      }
      return column;
    }

    const limitWheel = { sum: 0, stepped: false, timer: null };

    function limitPageWidth(strip) {
      const starts = strip.querySelectorAll('.is-page-start');
      return starts.length > 1 ? starts[1].offsetLeft - starts[0].offsetLeft : 0;
    }

    // A name that does not fit beside its plan keeps the full width; the plan
    // drops to the line below. Measured, so a short name keeps the chip up.
    let fitLimitPlans = () => {};

    function renderLimits(pageNode, nowMs) {
      const columns = limitColumns();
      const pageCount = Math.max(1, Math.ceil(columns.length / LIMIT_COLUMNS));
      view.limitPage = Math.min(view.limitPage, pageCount - 1);
      const strip = el('div', 'notch-limits');
      strip.classList.toggle('is-paged', pageCount > 1);
      columns.forEach((column, index) => {
        const node = limitColumn(column, nowMs);
        if (index % LIMIT_COLUMNS === 0) node.classList.add('is-page-start');
        strip.append(node);
      });
      // Fillers complete the last page, and the tail spacer gives back the
      // peek, so every page - the last one too - can snap flush to the left.
      if (pageCount > 1) {
        for (let index = columns.length; index < pageCount * LIMIT_COLUMNS; index += 1) strip.append(el('div', 'notch-limit notch-limit-filler'));
        strip.append(el('div', 'notch-limits-tail'));
      }
      if (!columns.length) strip.append(text('notch-empty', t('notch.noLimits')));
      pageNode.replaceChildren(strip);
      fitLimitPlans = () => {
        for (const column of strip.querySelectorAll('.notch-limit')) {
          const head = column.querySelector('.notch-limit-head');
          const name = column.querySelector('.notch-limit-name');
          const chip = column.querySelector('.notch-chip');
          if (!head || !name || !chip || !(name.clientWidth > 0)) continue;
          if (chip.parentNode !== head) head.append(chip);
          if (name.scrollWidth > name.clientWidth + 1) column.querySelector('.notch-limit-sub').append(chip);
        }
      };
      fitLimitPlans();
      if (pageCount <= 1) return;
      const pager = el('div', 'notch-pager');
      const dots = [];
      const goTo = (index) => {
        const page = Math.max(0, Math.min(pageCount - 1, index));
        strip.scrollTo({ left: page * limitPageWidth(strip), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      };
      const sync = () => {
        // A strip that is not laid out (the panel is closed) keeps its page.
        const width = limitPageWidth(strip);
        if (width > 0) view.limitPage = Math.max(0, Math.min(pageCount - 1, Math.round(strip.scrollLeft / width)));
        dots.forEach((dot, index) => {
          dot.classList.toggle('is-selected', index === view.limitPage);
          dot.setAttribute('aria-pressed', String(index === view.limitPage));
        });
        strip.classList.toggle('has-after', view.limitPage < pageCount - 1);
      };
      for (let index = 0; index < pageCount; index += 1) {
        const dot = el('button');
        dot.type = 'button';
        dot.setAttribute('aria-label', t('notch.pageLabel', { page: index + 1, count: pageCount }));
        dot.dataset.focusKey = `limits:${index}`;
        activateOnPress(dot, () => goTo(index));
        dots.push(dot);
        pager.append(dot);
      }
      pageNode.append(pager);
      strip.scrollLeft = view.limitPage * limitPageWidth(strip);
      sync();
      strip.addEventListener('scroll', sync, { passive: true });
      strip.addEventListener('wheel', (event) => {
        if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
        event.preventDefault();
        clearTimeout(limitWheel.timer);
        limitWheel.timer = setTimeout(() => { limitWheel.sum = 0; limitWheel.stepped = false; }, 180);
        if (limitWheel.stepped) return;
        limitWheel.sum += event.deltaY;
        if (Math.abs(limitWheel.sum) < 24) return;
        limitWheel.stepped = true;
        goTo(view.limitPage + Math.sign(limitWheel.sum));
      }, { passive: false });
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

    function sessionModelMetadata(row) {
      return sessionRows.sessionModelMetadataNode(document, row, {
        translate: t, view: limitWindowsView, formatTokens: formatBreakdownTokens,
        unattributedLabel: t('dashboard.tooltip.unclassified')
      });
    }

    function activeRow(row, stateName, nowMs) {
      const node = el('div', `notch-active is-${stateName}`);
      node.setAttribute('role', 'listitem');
      node.style.setProperty('--notch-accent', clientColor(row.client));
      const body = el('div', 'notch-active-body');
      body.append(sessionHeading(row, 'notch-active-title'));
      const meta = el('div', 'notch-active-meta');
      if (stateName === 'running') meta.append(wave());
      else meta.append(text('notch-pill', t('notch.waiting')));
      const label = el('span');
      label.append(text('', clientLabel(row.client)));
      if (sessionRows.sessionModelMetadataLabel(row)) label.append(text('', ' · '), sessionModelMetadata(row));
      const time = duration(row.startedAt, nowMs);
      if (time) label.append(text('', ` · ${time}`));
      meta.append(label);
      body.append(meta);
      const value = el('div', 'notch-active-value');
      value.append(sessionTokens(row, 'notch-active-tokens', false));
      const status = sessionStatus(row, nowMs);
      if (status) value.append(status);
      node.append(body, value);
      return node;
    }

    function renderSessions(pageNode, nowMs, scroll = {}) {
      const sessions = cell('stat:sessions')?.sessions || [];
      const states = sessions.map((row) => presentation.sessionActivityState(row, nowMs));
      // The shared session projection already orders these rows. Partition the
      // columns without changing the relative order inside either one.
      const active = sessions.map((row, index) => ({ row, state: states[index] }))
        .filter((entry) => entry.state === 'running' || entry.state === 'waiting');
      const recent = sessions.filter((_row, index) => states[index] !== 'running' && states[index] !== 'waiting');
      const left = el('div', 'notch-sessions-active');
      const leftHead = el('div', 'notch-section-head');
      leftHead.append(text('notch-kicker', t('notch.active')), text('notch-section-count', active.length ? t('notch.activeCount', { count: active.length }) : ''));
      left.append(leftHead);
      let activeList;
      if (active.length) {
        activeList = el('div', 'notch-active-list');
        activeList.setAttribute('role', 'list');
        activeList.setAttribute('aria-label', t('notch.active'));
        activeList.tabIndex = 0;
        activeList.dataset.focusKey = 'active:list';
        for (const entry of active) activeList.append(activeRow(entry.row, entry.state, nowMs));
        left.append(activeList);
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
        const meta = el('span', 'notch-recent-meta');
        meta.append(sessionModelMetadata(row));
        const age = relativeAgo(row.lastUsedAt, nowMs);
        if (age) meta.append(text('', `${sessionRows.sessionModelMetadataLabel(row) ? ' · ' : ''}${age}`));
        body.append(sessionHeading(row, 'notch-recent-title'), meta);
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
      if (activeList) activeList.scrollTop = scroll.active || 0;
      list.scrollTop = scroll.recent || 0;
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
      if (page === 'limits') return JSON.stringify([...base, providerCells().map((entry) => [entry.id, entry.status, entry.accounts?.map((account) => [account.record, account.active])])]);
      if (page === 'sessions') return JSON.stringify([...base, cell('stat:sessions')?.sessions, status]);
      return JSON.stringify([...base, view.breakdownPeriod, cell(`stat:${view.breakdownPeriod}`)]);
    }

    function renderPage(page, { force = false } = {}) {
      const nowMs = Date.now();
      const key = pageKey(page, nowMs);
      if (!force && pageKeys.get(page) === key) return;
      // Hover readings belong to the DOM they were made on; a rebuild under
      // the pointer would otherwise drop the scrubbed day mid-gesture; a swipe
      // likewise owns the limits strip it measured.
      if (page === 'home' && view.scrub && !force) return;
      if (page === 'limits' && gesture?.strip && !force) return;
      if (pageKeys.has(page)) node.classList.remove('is-entering');
      pageKeys.set(page, key);
      const pageNode = pageNodes.get(page);
      const focused = pageNode.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : null;
      const scroll = page === 'sessions' ? captureSessionScroll(pageNode) : null;
      const snapshot = page === view.page ? captureRolls(pageNode) : new Map();
      const previous = el('div');
      previous.append(...pageNode.children);
      if (page === 'home') renderHome(pageNode, nowMs);
      else if (page === 'limits') renderLimits(pageNode, nowMs);
      else if (page === 'sessions') renderSessions(pageNode, nowMs, scroll);
      else renderBreakdown(pageNode, nowMs);
      overflowText.preserveReading(previous, pageNode);
      overflowText.refresh();
      playRolls(pageNode, snapshot);
      if (focused) [...pageNode.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === focused)?.focus({ preventScroll: true });
    }

    function scrollEnv(hit) {
      const stripNode = node.querySelector('.notch-limits');
      const strip = hit === 'strip' && stripNode?.classList.contains('is-paged') ? {
        origin: view.limitPage,
        pageWidth: limitPageWidth(stripNode),
        pageCount: stripNode.querySelectorAll('.is-page-start').length
      } : null;
      return { page: PAGES.indexOf(view.page), strip };
    }
    function hitFromPoint(record) {
      const target = document.elementFromPoint?.(record.x, record.y);
      return view.page === 'limits' && target?.closest('.notch-page-limits') ? 'strip' : 'page';
    }
    function finishSwipe() {
      if (!gesture) return;
      const { destination, decision = 0, strip: held } = gesture;
      const page = destination?.lane === 'outer' && decision ? PAGES[destination.target] : view.page;
      if (gesture.strip) {
        const strip = node.querySelector('.notch-limits');
        view.limitPage = destination?.lane === 'strip' && decision ? destination.target : gesture.strip.origin;
        if (strip) strip.scrollLeft = view.limitPage * gesture.strip.pageWidth;
      }
      dropGesture();
      if (page !== view.page) commitPage(page);
      else {
        paintTabs();
        if (held) renderPage('limits');
      }
      clearPageMotion();
    }
    function paintSwipe() {
      const { destination, amount } = gesture;
      if (!destination) return;
      const strip = gesture.strip && node.querySelector('.notch-limits');
      if (strip) {
        strip.classList.add('is-handoff');
        const position = destination.lane === 'strip'
          ? destination.origin + (destination.target - destination.origin) * Math.abs(amount) : gesture.strip.origin;
        strip.scrollLeft = position * gesture.strip.pageWidth;
      }
      showDrag(gesture.page, destination.lane === 'outer' ? destination.target : gesture.page, amount);
    }
    function applyScroll(record) {
      if (!shown || !record) return;
      if (record.phase === 'began') {
        finishSwipe();
        const env = scrollEnv(hitFromPoint(record));
        const style = window.getComputedStyle(pages);
        gesture = { id: record.id, ...env,
          pageStep: parseFloat(style.width) + parseFloat(style.getPropertyValue('--notch-page-gap')) };
      }
      if (!gesture || gesture.id !== record.id) return;
      const amount = Math.max(-1, Math.min(1, record.amount));
      if (amount) {
        const previous = gesture.destination;
        const destination = swipeDestination(gesture.page, PAGES.length, gesture.strip, amount);
        if (destination.lane === 'outer' && destination.target !== gesture.page
          && (previous?.lane !== 'outer' || previous.target !== destination.target)) renderPage(PAGES[destination.target]);
        gesture.destination = destination;
      }
      if (record.phase === 'ended' || record.phase === 'cancelled') {
        gesture.decision = record.phase === 'ended' ? Math.sign(amount) : 0;
        if (prefersReducedMotion()) { finishSwipe(); return; }
      }
      gesture.amount = amount;
      paintSwipe();
      if (record.complete) finishSwipe();
    }

    function render(next, { opening = false } = {}) {
      shown = true;
      payload = next;
      node.classList.toggle('is-reduced-motion', prefersReducedMotion());
      if (opening) {
        view.scrub = null;
        dropHiddenPages();
        pageKeys = new Map();
        // Entrance motion plays once per reveal, never on a data push.
        node.classList.add('is-entering');
        clearTimeout(enteringTimer);
        enteringTimer = setTimeout(() => node.classList.remove('is-entering'), 1200);
      }
      paintTabs();
      paintStatus();
      // The visible page owns the hover reading.
      const preview = gesture?.destination;
      if (preview?.lane === 'outer' && preview.target !== preview.origin) renderPage(PAGES[preview.target]);
      renderPage(view.page);
      if (gesture) paintSwipe();
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
      shown = false;
      clearTimeout(limitWheel.timer);
      Object.assign(limitWheel, { sum: 0, stepped: false, timer: null });
      settleRolls();
      stopTitleReading();
      clearTimeout(enteringTimer);
      dropGesture();
      clearPageMotion();
      node.classList.remove('is-entering');
      view.scrub = null;
      dropHiddenPages();
    }
    const fuelObserver = typeof window.ResizeObserver === 'function'
      ? new window.ResizeObserver(() => { fitHomeFuel(); fitLimitPlans(); }) : null;
    fuelObserver?.observe(pageNodes.get('home'));
    fuelObserver?.observe(pageNodes.get('limits'));
    const removeScroll = bridge.onScroll?.(applyScroll);
    window.addEventListener('pagehide', () => { suspend(); removeScroll?.(); fuelObserver?.disconnect(); }, { once: true });
    paintTabs();
    return { node, render, place, selectPage, suspend, contentHeight: panelContentHeight, view };
  }

  return { PANEL_METRICS, PAGES, breakdownRows, createNotchPanel, panelContentHeight };
});
