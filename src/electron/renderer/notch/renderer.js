'use strict';

// The top entry owns its layout, measurements and animation state. Cards and
// quota/session semantics are supplied by the shared dock renderer.
(function exposeNotchRenderer(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorNotchRenderer = api;
})(typeof window !== 'undefined' ? window : null, function createNotchRendererApi() {
  function createNotchRenderer({ document, window, bridge, surface, state, root, shapeLayer, contentLayer, shared }) {
    const {
      el, t, appearance, prefersReducedMotion, readableColor, providerLabel, limitProviderColor,
      markNode, providerCellNode, statCellNode, statLabel, statShortLabel, formatTokens, formatCardTokens,
      createCardWindowsView, fitCardTotal, captureRingResetMotion, animateRingResets, cardResetAnimator,
      overflowText, updateShape, ensureRefreshButton, paintRefreshButton, resetRefreshVisit
    } = shared;
    const presentation = window.TokenMonitorEdgeDockPresentation;
    const runningSessionSummary = presentation.runningSessionSummary;
    const trayLayoutApi = window.TokenMonitorTrayLayout;
    const trayTypographyApi = window.TokenMonitorTrayTypography;
    const compactMoneyApi = window.TokenMonitorCompactMoney;
    const balanceDisplay = window.TokenMonitorLimitBalanceDisplay;
    const accountIdentityApi = window.TokenMonitorAccountIdentity;
    const limitResetMotionApi = window.TokenMonitorLimitResetMotion;
    const limitPresentationApi = window.TokenMonitorLimitProviderPresentation;
    const { activateOnPress } = window.TokenMonitorPressActivation;

    // A pure-black entry can coexist with a light app theme. Resolve adaptive ink
    // before the shared builder derives the translucent track from the bar color.
    function notchQuotaColor(color) {
      return readableColor(color) === 'var(--text)'
        ? getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || color
        : color;
    }

    function notchOverviewRecords(cell) {
      const records = cell.accounts.filter((account) => account.record).map((account) => account.record);
      // Every provider follows the shared EdgeDock headline. Only Codex has a
      // local-login selector; the others retain their existing representative rule.
      // The headline may sit beyond the detail's 50-row cap.
      const headline = [...records, ...(cell.subscriptionAccounts || [])].find((record) => (
        limitResetMotionApi.providerKey(record) === cell.headlineAccount
      ));
      // No usable headline: keep the first reportable row's original status.
      // Failed records without old quotas belong to the detail, not a fake meter.
      const fallback = records.find((record) => !record.status || record.status === 'ok' || record.windows?.length);
      return headline ? [headline] : fallback ? [fallback] : [];
    }

    function notchOverviewCard(cell, view) {
      const card = el('section', 'edge-dock-card notch-overview');
      const records = notchOverviewRecords(cell);
      const peers = cell.accounts.filter((account) => account.record).map((account) => account.record);
      const grouped = (cell.accountCount ?? peers.length) > 1;
      for (const [index, record] of records.entries()) {
        const account = el('div', 'home-limit-account limit-row');
        account.classList.toggle('stale', record.stale === true);
        account.dataset.limitMotionKey = limitResetMotionApi.providerKey(record);
        const head = el('div', 'home-limit-account-head');
        const color = limitProviderColor(cell.provider);
        const visual = cell.provider === 'thirdparty'
          ? limitPresentationApi.thirdPartyAdapterVisual(record, color) : { markId: cell.provider, color };
        head.append(view.renderLimitProviderMark(visual.markId, visual.color));
        const accountPeers = peers.includes(record) ? peers : [...peers, record];
        const accountIndex = Math.max(index, accountPeers.indexOf(record));
        const name = grouped
          ? `${providerLabel(cell.provider)} · ${view.limitAccountTitle(cell.provider, record, accountIndex, accountPeers)}`
          : providerLabel(cell.provider);
        const nameNode = el('span', 'home-list-name', name);
        nameNode.title = name;
        head.append(nameNode);
        const plan = view.limitAccountPlan(record, { grouped });
        const count = cell.provider === 'codex' && grouped ? t('settings.codex.nAccounts', { count: cell.accountCount ?? peers.length }) : '';
        const freshness = record.stale ? limitPresentationApi.limitProviderStatusLabel(record).label : '';
        if (plan || count || freshness) head.append(el('span', 'home-limit-plan', [plan, freshness, count].filter(Boolean).join(' · ')));
        const windows = view.renderProviderWindows(record, notchQuotaColor(visual.color));
        const quotas = new Set(notchQuotaRows(windows));
        for (const row of windows.querySelectorAll('.limit-window')) {
          if (!quotas.has(row)) row.remove();
        }
        for (const tooltip of windows.querySelectorAll('.limit-detail-tooltip-wrap')) tooltip.remove();
        account.append(head, windows);
        card.append(account);
      }
      if (!records.length) {
        const head = el('div', 'home-limit-account-head');
        head.append(view.renderLimitProviderMark(cell.provider, limitProviderColor(cell.provider)),
          el('span', 'home-list-name', providerLabel(cell.provider)));
        card.append(head, el('div', 'edge-dock-note', t('edgeDock.unavailable')));
      }
      return card;
    }

    // Preserve the original detail card and omit only the quota rows already
    // drawn above. Notes, account controls and forecasts keep their DOM.
    function notchQuotaRows(container) {
      return [...container.querySelectorAll('.limit-window')].filter((row) => (
        !row.classList.contains('limit-window-note') || row.querySelector('.limit-meter')
        || (row.dataset.usageItem && !['resets', 'spend'].includes(row.dataset.usageItem))
      ));
    }
    function omitNotchQuotaRows(card, cell) {
      const keys = cell ? new Set(notchOverviewRecords(cell).map((record) => limitResetMotionApi.providerKey(record))) : null;
      const scopes = keys ? [...card.querySelectorAll('.limit-row')].filter((row) => keys.has(row.dataset.limitMotionKey)) : [card];
      for (const quota of scopes.flatMap(notchQuotaRows)) {
        const info = [...quota.querySelectorAll('.limit-detail-tooltip-wrap')];
        if (info.length) {
          const note = el('div', 'limit-window limit-window-wide limit-window-note');
          const label = quota.querySelector('.limit-window-text > span')?.textContent;
          if (label) note.append(el('span', 'limit-note', label));
          note.append(...info);
          quota.replaceWith(note);
        } else quota.remove();
      }
      for (const container of card.querySelectorAll('.limit-window-group, .limit-windows')) {
        if (!container.querySelector('.limit-window')) container.remove();
      }
      return card;
    }

    // The shared popover escapes card overflow, but cannot escape a native window.
    // Keep this viewport accommodation local to the top entry's detail surface.
    function fitNotchTooltip(tooltip) {
      if (surface !== 'bubble' || !state.payload?.omitQuotaBars || !tooltip.matches('.limit-detail-tooltip')) return;
      tooltip.style.translate = 'none';
      const rect = tooltip.getBoundingClientRect();
      const zoom = rect.width / tooltip.offsetWidth || 1;
      const x = Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8));
      const y = Math.max(8, Math.min(rect.top, innerHeight - rect.height - 8));
      tooltip.style.translate = `${(x - rect.left) / zoom}px ${(y - rect.top) / zoom}px`;
    }
    root.addEventListener('toggle', (event) => {
      if (event.newState === 'open') requestAnimationFrame(() => fitNotchTooltip(event.target));
    }, true);

    // ---- Top notch ------------------------------------------------------------

    const notchNumbers = new Map();
    let lastNotchSlots = '';
    let lastNotchSize = '';
    let notchHeaderKey = '';
    let notchRowsKey = '';
    const notchRowNodes = new Map();
    let notchExpanded = false;
    let notchClock = 0;
    let notchRowsPending = false;
    function notchMeasureText(measure, value) {
      if (measure.metric === 'tokens') return formatTokens(value);
      if (measure.metric === 'percent') return `${Math.round(value)}%`;
      if (measure.metric === 'balance') return balanceDisplay.formatCompactMoney(value, measure.currency, appearance().compactTokenUnits, state.locale);
      if (measure.metric === 'rate') return `${window.TokenMonitorTrayText.formatCompactNumber(value, { compactTokenUnits: appearance().compactTokenUnits, locale: state.locale })} ${measure.rateMode === 'burn' ? 'TPM' : 'tok/s'}`;
      return compactMoneyApi.formatCompactCurrencyFromUsd(value, appearance().currency || 'USD', appearance().compactTokenUnits, state.locale, {
        compact: measure.costFormat !== 'full', fractionDigits: measure.costDecimals ?? 2
      });
    }

    function notchNumber(key, row, used) {
      const measure = row.measure;
      if (!measure || !Number.isFinite(measure.value)) return el('span', '', row.text || '—');
      // Unit/source changes establish a new baseline; updates in the same reading
      // continue from the current tween, just like the home number's 1000ms quart.
      const semantic = JSON.stringify([key, { ...measure, value: null }, appearance().currency, appearance().compactTokenUnits, state.locale]);
      used.add(semantic);
      let held = notchNumbers.get(semantic);
      if (!held) {
        held = { node: el('span', 'notch-number'), value: measure.value, target: measure.value, handle: null };
        notchNumbers.set(semantic, held);
      }
      const format = (value) => notchMeasureText(measure, value);
      if (held.target !== measure.value || prefersReducedMotion()) {
        cancelAnimationFrame(held.handle);
        held.target = measure.value;
        if (prefersReducedMotion()) held.value = held.target;
        else {
          const from = held.value;
          const started = performance.now();
          const step = (now) => {
            const t = Math.min(1, (now - started) / 1000);
            held.value = from + (held.target - from) * (1 - (1 - t) ** 4);
            held.node.textContent = format(held.value);
            if (t < 1) held.handle = requestAnimationFrame(step);
            else held.handle = null;
          };
          held.handle = requestAnimationFrame(step);
        }
      }
      held.node.textContent = format(held.value);
      return held.node;
    }

    function notchIcon(item) {
      if (item.providerCell && appearance().edgeDockRunningIndicatorEnabled === true) {
        const node = providerCellNode(item.providerCell);
        node.classList.add('notch-provider-icon');
        node.querySelector('.edge-dock-value').remove();
        node.querySelector('.edge-dock-mark').replaceWith(markNode(item.provider));
        return node;
      }
      return ['app', '?'].includes(item.provider) ? el('span', 'notch-app-mark', item.provider === 'app' ? 'Σ' : '?') : markNode(item.provider);
    }

    function positionNotchSummary(head, payload) {
      head.style.height = `${payload.geometry.height}px`;
      const width = payload.geometry.headerWidth;
      head.style.left = `${payload.geometry.headerX}px`;
      head.style.width = `${width}px`;
      const offset = payload.geometry.notched ? payload.geometry.gapOffset : (width - payload.geometry.gapWidth) / 2;
      head.style.gridTemplateColumns = `${offset}px ${payload.geometry.gapWidth}px ${width - offset - payload.geometry.gapWidth}px`;
      head.style.setProperty('--notch-shoulder', `${payload.geometry.shoulder}px`);
      head.style.setProperty('--notch-summary-zoom', payload.geometry.summaryZoom);
      head.style.setProperty('--notch-ring-size', `${payload.geometry.summaryRingSize || 28}px`);
      head.querySelector('.notch-gap').style.width = `${payload.geometry.gapWidth}px`;
    }

    function notchDisplayRow(row) {
      let text = row.text;
      if (row.clock) {
        const reset = trayLayoutApi.formatResetCountdown(row.clock.resetsAt, Date.now());
        text = [row.clock.headline, reset].filter(Boolean).join(' · ') || '--';
      }
      if (row.metric === 'account' && appearance().maskLimitAccountEmails === true) text = accountIdentityApi.maskEmailAddress(text);
      return { ...row, text };
    }

    function fitNotchTypeface(run) {
      const scale = Number(run.dataset.horizontalScale) || 1;
      run.parentElement.style.width = `${Math.ceil(run.offsetWidth * scale)}px`;
    }
    const notchSummaryObserver = surface === 'notch' ? new ResizeObserver((entries) => {
      for (const { target } of entries) {
        if (target.classList.contains('notch-text-run')) fitNotchTypeface(target);
      }
      const head = contentLayer.querySelector('.notch-summary');
      if (head) reportNotchSlots(head);
    }) : null;

    function notchText(item, row, key, used) {
      row = notchDisplayRow(row);
      const wrapper = el('span', 'notch-text-layout');
      const run = el('span', 'notch-text-run');
      const scale = trayTypographyApi.horizontalScale(item);
      run.dataset.horizontalScale = String(scale);
      run.style.transform = `scaleX(${scale})`;
      if (trayTypographyApi.spaceScale(item) !== 1) run.style.wordSpacing = '-.45ch';
      run.classList.toggle('is-unavailable', row.available === false);
      run.append(notchNumber(key, row, used));
      if (['custom', 'account'].includes(row.metric || item.metric)) run.title = row.text || '';
      wrapper.append(run);
      return wrapper;
    }

    // Sources have already been resolved by the shared tray layout. Only item order
    // and camera clearance affect the split; a stack or embedded mark is one item.
    function allocateNotchSummary(items, cameraGap) {
      const readings = items.map((item, index) => item.type !== 'icon' && item.type !== 'spacer' ? index : -1).filter(index => index >= 0);
      const distributed = cameraGap && readings.length > 1;
      const split = readings.length ? readings[0] + Number(distributed) : items.length;
      const indices = items.map((_item, index) => index);
      const left = indices.slice(0, split), right = indices.slice(split);
      if (cameraGap) {
        while (left.length && items[left.at(-1)].type === 'spacer') left.pop();
        while (right.length && items[right[0]].type === 'spacer') right.shift();
      }
      return { left, right, primary: distributed ? readings[0] : null, optionalRight: Boolean(distributed) };
    }

    function notchSummary(payload) {
      const head = el('div', 'notch-summary');
      const left = el('div', 'notch-slot notch-left');
      const gap = el('div', 'notch-gap');
      gap.style.width = `${payload.geometry.gapWidth}px`;
      const right = el('div', 'notch-slot notch-right');
      const leftContent = el('div', 'notch-slot-content');
      const rightContent = el('div', 'notch-slot-content');
      left.append(leftContent); right.append(rightContent);
      const used = new Set();
      const parts = [];
      for (const item of payload.summary?.items || []) {
        const iconProvider = item.type === 'icon' ? item.provider : item.iconProvider;
        const mark = iconProvider ? notchIcon({ ...item, provider: iconProvider }) : null;
        if (mark) mark.title = iconProvider === 'app' ? 'Token Monitor' : providerLabel(iconProvider);
        if (item.type === 'icon') { parts.push(mark); continue; }
        const block = el('span', 'notch-reading');
        block.dataset.notchSpacer = String(item.type === 'spacer');
        const roomyRing = payload.geometry.gapWidth === 0 && payload.geometry.summaryRingSize > 0;
        const fontSize = item.type === 'stack' ? (roomyRing ? 10 : 9) : Math.max(9, Math.min(16, (roomyRing ? 14 : 12) * (Number(item.scale) || 1)));
        block.style.font = trayTypographyApi.font(item, fontSize, item.type === 'stack' ? 600 : 500);
        block.style.fontVariantNumeric = 'tabular-nums';
        if (item.type === 'spacer') {
          block.textContent = item.variant === 'dot' ? '·' : ' ';
          block.style.width = `${trayTypographyApi.spacerWidth(item, 20)}px`;
        } else if (item.type === 'bars') {
          block.classList.add('notch-bars');
          for (const row of item.rows) {
            const track = el('span', 'notch-bar');
            track.title = row.selection ? providerLabel(row.selection.provider) : '—';
            const fill = el('span', 'notch-bar-fill');
            fill.style.width = `${Math.max(0, Math.min(100, row.percent || 0))}%`;
            track.append(fill); block.append(track);
          }
        } else if (item.type === 'stack') {
          block.classList.add('notch-stack');
          block.style.alignItems = item.alignment === 'left' ? 'flex-start' : 'flex-end';
          item.rows.forEach((row, i) => block.append(notchText(item, row, `${item.id}:${i}:${JSON.stringify(row.source || row.selection?.source)}`, used)));
        } else block.append(notchText(item, item, `${item.id}:${item.period}:${JSON.stringify(item.source)}`, used));
        const field = mark ? el('span', 'notch-summary-field') : block;
        if (mark) field.append(mark, block);
        parts.push(field);
      }
      const allocation = allocateNotchSummary(payload.summary?.items || [], payload.geometry.gapWidth > 0);
      if (allocation.primary !== null) parts[allocation.primary].dataset.notchPrimary = 'true';
      rightContent.dataset.notchOptional = String(allocation.optionalRight);
      leftContent.append(...allocation.left.map(index => parts[index]));
      rightContent.append(...allocation.right.map(index => parts[index]));
      for (const [key, held] of notchNumbers) {
        if (used.has(key)) continue;
        cancelAnimationFrame(held.handle);
        notchNumbers.delete(key);
      }
      head.append(left, gap, right);
      positionNotchSummary(head, payload);
      return head;
    }


    // Reuse the rail's existing count, period, marks and rate semantics, laid out
    // horizontally. Rich breakdowns and session rows remain in the original card.
    function notchStatOverviewCard(cell) {
      const card = el('section', 'edge-dock-card notch-stat-overview');
      const readout = statCellNode(cell);
      readout.querySelector('.edge-dock-stat-label').textContent = statLabel(cell.metric);
      const reading = el('span', 'notch-stat-reading');
      reading.append(readout.querySelector('.edge-dock-stat-value'));
      if (window.TokenMonitorEdgeDockItems.USAGE_PERIODS.includes(cell.metric)) {
        card.classList.add('is-usage');
        reading.classList.add('edge-dock-total-row');
        const value = reading.firstElementChild;
        const exact = el('strong', 'edge-dock-stat-value', cell.available ? formatCardTokens(cell.totalTokens) : '—');
        exact.dataset.fullText = exact.textContent;
        exact.dataset.compactText = value.textContent;
        value.replaceWith(exact);
        readout.setAttribute('aria-label', `${statLabel(cell.metric)} ${exact.textContent} ${readout.querySelector('.edge-dock-stat-cost')?.textContent || ''}`.trim());
      }
      if (cell.metric === 'liveRate') {
        reading.classList.add('is-rate', 'edge-dock-cell-rate');
        reading.append(el('span', 'edge-dock-cell-rate-unit', statShortLabel(cell)));
        activateOnPress(readout, () => bridge.toggleRateMode());
      }
      reading.title = [...reading.children].map(node => node.textContent).join(' ');
      readout.append(reading);
      const marks = readout.querySelector('.edge-dock-cell-marks');
      if (marks) marks.dataset.clientCount = marks.querySelectorAll('.edge-dock-mark').length
        + Number(marks.querySelector('.edge-dock-cell-more')?.textContent || 0);
      card.append(readout);
      return card;
    }

    // Keep full-size tool marks inside the middle column. Only the drawing is
    // bounded; the count, accessible tool names and detail sessions stay complete.
    function fitNotchMarks(row) {
      const icons = [...row.querySelectorAll('.edge-dock-mark')];
      const total = Number(row.dataset.clientCount);
      const scale = row.clientHeight ? row.getBoundingClientRect().height / row.clientHeight : 1;
      const available = row.getBoundingClientRect().width;
      const gap = (parseFloat(getComputedStyle(row).columnGap) || 0) * scale;
      const iconWidth = icons.length ? parseFloat(getComputedStyle(icons[0]).width) * scale : 0;
      let more = row.querySelector('.edge-dock-cell-more');
      if (!more) { more = el('span', 'edge-dock-cell-more'); row.append(more); }
      let visible = icons.length;
      while (visible >= 0) {
        const rest = total - visible;
        more.textContent = rest > 0 ? `+${rest}` : '';
        more.hidden = rest === 0;
        const count = visible + (rest > 0 ? 1 : 0);
        const width = visible * iconWidth + (rest > 0 ? more.getBoundingClientRect().width : 0) + Math.max(0, count - 1) * gap;
        if (width <= available + 0.1 || visible === 0) break;
        visible--;
      }
      icons.forEach((icon, index) => { icon.hidden = index >= visible; });
    }
    function fitNotchStatReadouts(changed = null) {
      for (const row of contentLayer.querySelectorAll('.notch-stat-overview .edge-dock-cell-marks')) {
        if (!changed || changed.has(row.closest('.edge-dock-card'))) fitNotchMarks(row);
      }
      for (const card of contentLayer.querySelectorAll('.notch-stat-overview.is-usage')) {
        if (changed && !changed.has(card)) continue;
        const cell = card.querySelector('.edge-dock-cell');
        const label = cell.querySelector('.edge-dock-stat-label');
        const cost = cell.querySelector('.edge-dock-stat-cost');
        const gap = parseFloat(getComputedStyle(cell).columnGap) || 0;
        const scale = cell.getBoundingClientRect().width / cell.clientWidth || 1;
        const naturalWidth = (node) => {
          if (!node) return 0;
          node.style.maxWidth = 'none';node.style.width = 'max-content';
          const width = Math.ceil(node.getBoundingClientRect().width / scale) + 1;
          node.style.maxWidth = '';node.style.width = '';
          return width;
        };
        // scrollWidth rounds to whole pixels and can clip even "本周" or "$64.5".
        const side = Math.min(Math.max(naturalWidth(label), naturalWidth(cost)), Math.max(0, (cell.clientWidth - 2 * gap) / 3));
        cell.style.gridTemplateColumns = `${side}px minmax(0, 1fr) ${side}px`;
        const value = card.querySelector('.edge-dock-stat-value');
        value.style.fontSize = '';
        value.textContent = value.dataset.fullText;
        // Reuse the detail headline's fitting rule; never widen the outer shell.
        value.style.maxWidth = 'none';
        fitCardTotal(card, scale);
        value.style.maxWidth = '';
        if (value.scrollWidth > value.parentElement.clientWidth + 1) {
          value.textContent = value.dataset.compactText;
          value.style.fontSize = '';
        }
      }
    }

    // Measure complete fields before fitting optional items; hidden fields remain live
    // nodes, so fitting never replaces counters or changes their numeric facts.
    function zoomForNotchText(run) {
      const content = run.closest('.notch-slot-content');
      return (Number(getComputedStyle(content).zoom) || 1) * (Number(run.dataset.horizontalScale) || 1);
    }
    // The primary field has priority; all other fields keep their configured order.
    // Text may shrink to its ellipsis. Marks and bars retain their full width.
    function fitNotchSummaryItems(items, { budget, gap, overflowWidth, primary = -1, optional = false }) {
      const first = items.findIndex(item => !item.spacer);
      const required = primary >= 0 ? primary : optional ? -1 : first;
      const limit = Math.max(0, budget);
      const widths = items.map(item => item.width);
      const visible = [];
      const widthFor = indices => indices.reduce((total, index) => total + widths[index], 0) + Math.max(0, indices.length - 1) * gap;
      if (required >= 0 && items[required].minimum <= limit) {
        widths[required] = Math.min(widths[required], limit);
        visible.push(required);
      }
      for (let index = 0; index < items.length; index++) {
        if (index === required) continue;
        const next = [...visible, index].sort((a, b) => a - b);
        if (widthFor(next) > limit) break;
        visible.splice(0, visible.length, ...next);
      }
      while (visible.length && items[visible.at(-1)].spacer) visible.pop();
      const textEllipsis = visible.some(index => widths[index] < items[index].width);
      const omitted = items.some((item, index) => !item.spacer && !visible.includes(index));
      const overflow = omitted && !textEllipsis && widthFor(visible) + (visible.length ? gap : 0) + overflowWidth <= limit;
      return { visible, widths, minimum: required >= 0 ? items[required].width : 0, overflow };
    }

    function fitNotchSlot(content, budget) {
      const zoom = Number(getComputedStyle(content).zoom) || 1;
      content.style.maxWidth = Number.isFinite(budget) ? `${Math.max(0, budget) / zoom}px` : 'none';
      content.style.overflow = 'hidden';
      let overflow = content.querySelector('.notch-overflow');
      if (!overflow) {
        overflow = el('span', 'notch-reading notch-overflow', '⋯');
        overflow.style.fontSize = '12px';
        content.append(overflow);
      }
      const blocks = [...content.children].filter(node => node !== overflow);
      for (const block of blocks) {
        block.hidden = false;
        for (const run of block.querySelectorAll('.notch-text-run')) { run.style.maxWidth = 'none'; fitNotchTypeface(run); }
      }
      overflow.hidden = false;
      const overflowWidth = overflow.getBoundingClientRect().width;
      overflow.hidden = true;
      const gap = (parseFloat(getComputedStyle(content).gap) || 0) * zoom;
      const markerStyle = overflow.style.cssText;
      const items = blocks.map(node => {
        const width = node.getBoundingClientRect().width;
        const reading = node.classList.contains('notch-summary-field') ? node.querySelector('.notch-reading') : node;
        const run = node.querySelector('.notch-text-run');
        let minimum = width;
        if (run) {
          const font = getComputedStyle(run);
          overflow.style.font = `${font.fontStyle} ${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
          overflow.textContent = '…';
          overflow.hidden = false;
          const ellipsis = overflow.getBoundingClientRect().width * zoomForNotchText(run) / zoom;
          minimum = Math.min(width, width - reading.getBoundingClientRect().width + ellipsis);
        }
        return { width, minimum, spacer: node.dataset.notchSpacer === 'true' };
      });
      overflow.style.cssText = markerStyle;
      overflow.textContent = '⋯'; overflow.hidden = true;
      const fitted = fitNotchSummaryItems(items, { budget, gap, overflowWidth,
        primary: blocks.findIndex(node => node.dataset.notchPrimary === 'true'), optional: content.dataset.notchOptional === 'true' });
      blocks.forEach((node, index) => {
        node.hidden = !fitted.visible.includes(index);
        if (node.hidden || fitted.widths[index] >= items[index].width) return;
        const reading = node.classList.contains('notch-summary-field') ? node.querySelector('.notch-reading') : node;
        const fixed = items[index].width - reading.getBoundingClientRect().width;
        for (const run of node.querySelectorAll('.notch-text-run')) {
          run.style.maxWidth = `${Math.max(0, fitted.widths[index] - fixed) / zoomForNotchText(run)}px`;
          fitNotchTypeface(run);
        }
      });
      overflow.hidden = !fitted.overflow;
      return { width: content.getBoundingClientRect().width, minimum: fitted.minimum };
    }
    // Transform coordinate noise must not become another logical window point.
    function notchLogicalPoint(value) { return Math.round(value * 1000) / 1000; }
    function reportNotchSlots(head) {
      // An empty header has no widths to replace the last measured summary with.
      if (!state.payload?.summary) return;
      const measurement = state.payload.summaryMeasurement;
      const geometry = state.payload?.geometry;
      const compact = geometry?.gapWidth === 0;
      const budget = geometry.summaryBudget;
      const leftContent = head.querySelector('.notch-left .notch-slot-content');
      const rightContent = head.querySelector('.notch-right .notch-slot-content');
      const gap = 12 * (Number(state.payload.appearance.zoomFactor) || 1);
      const primaryRight = compact ? Math.min(budget, fitNotchSlot(rightContent, Infinity).minimum) : 0;
      const left = fitNotchSlot(leftContent, compact ? Math.max(0, budget - primaryRight - gap) : budget);
      const right = fitNotchSlot(rightContent, compact ? Math.max(0, budget - left.width - gap) : budget);
      const firstBlock = [...leftContent.children].find(node => !node.hidden);
      const firstIcon = firstBlock?.classList.contains('notch-summary-field') ? firstBlock.firstElementChild : firstBlock;
      const firstMark = firstIcon?.querySelector('.edge-dock-mark');
      const iconInset = firstMark ? notchLogicalPoint(Math.max(0, firstMark.getBoundingClientRect().left - leftContent.getBoundingClientRect().left)) : 0;
      head.dataset.notchIconInset = iconInset;
      const slots = { left: Math.ceil(notchLogicalPoint(left.width)), right: Math.ceil(notchLogicalPoint(right.width)), iconInset };
      const key = JSON.stringify([slots, measurement?.measuring ? measurement.id : null]);
      if (key !== lastNotchSlots) {
        lastNotchSlots = key;
        bridge.reportNotchSize(0, slots, null, measurement?.measuring ? { id: measurement.id } : undefined);
      }
    }
    const notchProviderObserver = surface === 'notch' ? new ResizeObserver(() => { fitNotchStatReadouts(); reportNotchContentSize(); }) : null;
    function reportNotchContentSize() {
      const rows = contentLayer.querySelector('.notch-provider-list');
      const list = contentLayer.querySelector('.notch-providers');
      if (!rows || !list) return;
      const zoom = Number(state.payload?.appearance.zoomFactor) || 1;
      const height = Math.ceil(notchLogicalPoint(rows.getBoundingClientRect().height + parseFloat(getComputedStyle(list).paddingBottom) * zoom));
      const origin = root.getBoundingClientRect();
      const rects = [...rows.children].filter((row) => row.dataset.cellId).map((row) => {
        const r = row.getBoundingClientRect();
        return { id: row.dataset.cellId, x: notchLogicalPoint(r.x - origin.x), y: notchLogicalPoint(r.y - origin.y), width: notchLogicalPoint(r.width), height: notchLogicalPoint(r.height) };
      });
      const key = JSON.stringify([height, rects]);
      if (key !== lastNotchSize) { lastNotchSize = key; bridge.reportNotchSize(height, null, rects); }
    }

    // Shape-only frames never reconstruct the summary, provider rows or numbers.
    // Persistent summary nodes keep equal outer margins on this same frame.
    function applyNotchMotion(frame) {
      if (!frame?.shape) return;
      const shape = frame.shape;
      if (!shapeLayer.firstChild) updateShape({ shape });
      shapeLayer.dataset.key = shape.key;
      shapeLayer.setAttribute('viewBox', `0 0 ${shape.width} ${shape.height}`);
      shapeLayer.querySelector('.edge-dock-shape-fill').setAttribute('d', shape.d);
      shapeLayer.querySelector('.edge-dock-shape-line').setAttribute('d', shape.d);
      root.style.setProperty('--notch-body-height', `${frame.bodyHeight}px`);
      root.style.setProperty('--notch-header-height', `${frame.headerHeight}px`);
      root.style.setProperty('--notch-progress', frame.progress);
      // Shell and content share one progress value.
      const contentProgress = Math.max(0, Math.min(1, frame.progress));
      root.style.setProperty('--notch-content-progress', contentProgress);
      root.style.setProperty('--notch-summary-opacity', 1 - contentProgress);
      const header = contentLayer.querySelector('.notch-summary');
      const geometry = state.payload?.geometry;
      if (header && geometry) {
        if (Number.isFinite(frame.summaryHeight)) header.style.height = `${frame.summaryHeight}px`;
        const left = header.querySelector('.notch-left .notch-slot-content');
        const right = header.querySelector('.notch-right .notch-slot-content');
        const restingLeft = geometry.headerX + geometry.shoulder + 8;
        const restingRight = geometry.headerX + geometry.headerWidth - geometry.shoulder - 8;
        // The same value positions the summary; reading computed style after the
        // shape writes would force a style update on every animation frame.
        const summaryZoom = geometry.summaryZoom;
        // Anchor the outer content edges to equal insets. Different glyph widths
        // cannot alter the mirrored margins, including interrupted motion.
        left.style.transform = `translateX(${((frame.summaryEdges?.left ?? restingLeft) - restingLeft + (frame.summaryIconInset || 0) - (Number(header.dataset.notchIconInset) || 0)) / summaryZoom}px)`;
        right.style.transform = `translateX(${((frame.summaryEdges?.right ?? restingRight) - restingRight) / summaryZoom}px)`;
      }
      const body = contentLayer.querySelector('.notch-body');
      if (body) {
        body.inert = frame.progress < 1;
        if (frame.bodyBox) { body.style.left = `${frame.bodyBox.x}px`; body.style.width = `${frame.bodyBox.width}px`; }
      }
    }

    function notchRowKey(cell) {
      const data = cell.kind === 'stat' ? cell : { ...cell, usage: null, sessions: null, forecast: null };
      const sessions = cell.metric === presentation.SESSIONS_METRIC ? runningSessionSummary(cell.sessions) : null;
      return JSON.stringify([data, state.appearanceKey, cell.kind !== 'stat' ? notchClock : null,
        sessions && [sessions.count, sessions.clients]]);
    }

    function renderNotchRows(payload, opening) {
      // Hidden rows retain their nodes; the next reveal uses the latest payload.
      // Initial rows are measured once so the first expansion has a natural height.
      if (!payload.expanded && notchRowNodes.size) return;
      const cells = payload.cells || [];
      const keys = cells.map(notchRowKey);
      const key = JSON.stringify([keys, state.appearanceKey, payload.refreshEnabled]);
      if (key === notchRowsKey) return;
      const moving = payload.motion?.progress > 0 && payload.motion.progress < 1;
      // Fresh reveal content is mounted before it fades in. Later pushes wait
      // for the current shell motion to settle.
      if (moving && !opening) { notchRowsPending = true; return; }
      notchRowsKey = key;
      let body = contentLayer.querySelector('.notch-body');
      if (!body) {
        body = el('div', 'notch-body');
        const list = el('div', 'notch-providers');
        const rows = el('div', 'notch-provider-list');
        list.append(rows); body.append(list); contentLayer.append(body);
        list.addEventListener('scroll', reportNotchContentSize);
        notchProviderObserver.observe(rows);
      }
      const list = body.querySelector('.notch-providers');
      const rows = body.querySelector('.notch-provider-list');
      const scrollTop = list.scrollTop;
      const focused = document.activeElement?.closest('.edge-dock-card')?.dataset.cellId;
      const resetSnapshot = cardResetAnimator.capture(contentLayer);
      const next = [], replaced = [], changed = new Set();
      for (const [index, cell] of cells.entries()) {
        let held = notchRowNodes.get(cell.id);
        if (held?.key !== keys[index]) {
          const view = createCardWindowsView(() => cell, () => cell.forecast || null);
          const card = cell.kind === 'stat' ? notchStatOverviewCard(cell) : notchOverviewCard(cell, view);
          card.dataset.cellId = cell.id; card.tabIndex = 0;
          changed.add(card);
          if (held) replaced.push([held.node, card]);
          held = { key: keys[index], node: card };
          notchRowNodes.set(cell.id, held);
        }
        next.push(held.node);
      }
      const ids = new Set(cells.map(cell => cell.id));
      for (const id of notchRowNodes.keys()) if (!ids.has(id)) notchRowNodes.delete(id);
      if (!next.length) {
        const empty = el('section', 'edge-dock-card notch-empty');
        empty.append(el('div', 'edge-dock-note', t('settings.notch.empty')));
        next.push(empty);
      }
      if (payload.refreshEnabled) {
        const footer = rows.querySelector('.notch-refresh-footer') || el('div', 'notch-refresh-footer');
        if (!footer.firstChild) footer.append(ensureRefreshButton());
        next.push(footer);
      }
      next.forEach((node, index) => { if (rows.children[index] !== node) rows.insertBefore(node, rows.children[index] || null); });
      const keep = new Set(next);
      for (const node of [...rows.children]) if (!keep.has(node)) node.remove();
      list.scrollTop = scrollTop;
      if (focused) next.find(card => card.dataset.cellId === focused)?.focus({ preventScroll: true });
      fitNotchStatReadouts(changed); overflowText.refresh();
      for (const [previous, card] of replaced) overflowText.preserveReading(previous, card);
      cardResetAnimator.animate(list, resetSnapshot);
    }

    function renderNotch(payload) {
      const opening = payload.expanded === true && !notchExpanded;
      notchExpanded = payload.expanded === true;
      if (opening) notchClock++;
      // A hidden/removed action starts a new visit; late replies cannot repaint it.
      if (!payload.expanded || !payload.refreshEnabled) {
        resetRefreshVisit();
      }
      paintRefreshButton();
      root.classList.toggle('is-notch-open', payload.expanded === true);
      root.classList.toggle('is-notch-attached', payload.geometry.notched === true);
      root.style.setProperty('--notch-zoom', Number(payload.appearance.zoomFactor) || 1);
      const headerActivity = (payload.summary?.items || []).map((item) => item.providerCell ? runningSessionSummary(item.providerCell.sessions).count : 0);
      // Camera clearance changes grouping even when the readings stay the same.
      const headerKey = JSON.stringify([payload.summary, headerActivity, payload.geometry.gapWidth > 0, payload.geometry.summaryRingSize > 0, state.appearanceKey, payload.summary?.needsClock ? notchClock : 0]);
      if (headerKey !== notchHeaderKey) {
        notchHeaderKey = headerKey;
        const previousHead = contentLayer.querySelector('.notch-summary');
        const ringSnapshot = captureRingResetMotion(previousHead);
        const head = notchSummary(payload);
        head.style.visibility = payload.summaryMeasurement?.measuring ? 'hidden' : '';
        previousHead?.remove();
        contentLayer.prepend(head);
        animateRingResets(ringSnapshot, head);
        notchSummaryObserver.disconnect();
        if (payload.summary) {
          for (const run of head.querySelectorAll('.notch-text-run')) notchSummaryObserver.observe(run);
          for (const slot of head.querySelectorAll('.notch-slot-content')) notchSummaryObserver.observe(slot);
        }
      }
      const summary = contentLayer.querySelector('.notch-summary');
      if (summary) {
        summary.style.visibility = payload.summaryMeasurement?.measuring ? 'hidden' : '';
        positionNotchSummary(summary, payload); reportNotchSlots(summary);
      }
      renderNotchRows(payload, opening);
      applyNotchMotion(payload.motion);
      reportNotchContentSize();
      // The native window can appear only after this measured shape and header
      // have been applied together, not when the raw width report reaches main.
      if (payload.summaryMeasurement?.measuring === false) bridge.reportNotchSize(0, null, null, { id: payload.summaryMeasurement.id, ready: true });
    }
    let notchAnimation = null;
    function startNotchAnimation(config) {
      if (notchAnimation) cancelAnimationFrame(notchAnimation.handle);
      notchAnimation = null;
      if (!(config.duration > 0)) return;
      const animation = { id: config.id, started: performance.now(), handle: null };
      notchAnimation = animation;
      const tick = (now) => {
        if (notchAnimation !== animation) return;
        // One frame in flight. Native masking cannot build a queue of old shapes.
        bridge.reportMotionFrame(animation.id, Math.max(0, now - animation.started));
      };
      animation.tick = tick;
      animation.handle = requestAnimationFrame(tick);
    }
    if (surface === 'notch') {
      bridge.onAnimate(startNotchAnimation);
      bridge.onMotion((frame) => {
        if (state.payload) state.payload.motion = frame;
        applyNotchMotion(frame);
        if (notchAnimation && notchAnimation.id === frame.motionId) {
          if (frame.done) { cancelAnimationFrame(notchAnimation.handle); notchAnimation = null; }
          else notchAnimation.handle = requestAnimationFrame(notchAnimation.tick);
        }
        if (frame.done) reportNotchContentSize();
        if (notchRowsPending && (frame.progress === 0 || frame.progress === 1) && state.payload) {
          notchRowsPending = false;
          renderNotch(state.payload);
        }
      });
    }


    return {
      render: renderNotch,
      applyMotion: applyNotchMotion,
      omitQuotaRows: omitNotchQuotaRows,
      applyAppearance(payload) {
        document.documentElement.classList.toggle('notch-black', payload.style === 'black');
        root.classList.toggle('is-notch-detail', surface === 'bubble');
      },
      sessionCells() {
        return [...(state.payload?.expanded ? state.payload.cells || [] : []), ...(state.payload?.summary?.items || []).map(item => item.providerCell).filter(Boolean)];
      },
      needsClock() {
        return Boolean(state.payload?.summary?.needsClock
          || state.payload?.expanded && state.payload.cells?.some(cell => cell.kind !== 'stat'));
      },
      repaint() { notchClock++; renderNotch(state.payload); }
    };
  }
  return { createNotchRenderer };
});
