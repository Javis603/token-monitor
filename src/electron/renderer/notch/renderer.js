'use strict';

// The top entry owns its layout, measurements and animation state, while
// sharing quota/session semantics and formatting with the dock renderer.
(function exposeNotchRenderer(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorNotchRenderer = api;
})(typeof window !== 'undefined' ? window : null, function createNotchRendererApi() {
  // Optical proportions live in the space below the physical camera band.
  // Motion frames already include content zoom; applying zoom again here would
  // change the balance as panels grow, shrink or hit the screen's height limit.
  const NOTCH_GLASS_PROFILE = Object.freeze({ cap: 0.24, fade: 0.50 });
  function notchGlassGeometry(cameraHeight, bodyHeight) {
    const camera = Number.isFinite(cameraHeight) ? Math.max(0, cameraHeight) : 0;
    const body = Number.isFinite(bodyHeight) ? Math.max(0, bodyHeight) : 0;
    return {
      capEnd: camera + body * NOTCH_GLASS_PROFILE.cap,
      fadeEnd: camera + body * (NOTCH_GLASS_PROFILE.cap + NOTCH_GLASS_PROFILE.fade),
      rimTop: camera,
      rimBottom: camera + body
    };
  }

  function createNotchRenderer({ document, window, bridge, state, root, shapeLayer, contentLayer, shared }) {
    const {
      el, t, appearance, prefersReducedMotion, providerLabel, limitProviderColor, readableColor, limitAccountTitle,
      markNode, hasMask, providerCellNode, formatTokens, formatCardTokens, formatBreakdownTokens, formatCost, usageCostNode, formatRate, overflowText, limitWindowsView,
      captureRingResetMotion, animateRingResets, updateShape, ensureRefreshButton, paintRefreshButton, resetRefreshVisit, pluginHost, pluginContent
    } = shared;
    const presentation = window.TokenMonitorEdgeDockPresentation;
    const numberAnimation = window.TokenMonitorTokenNumberAnimation;
    const runningSessionSummary = presentation.runningSessionSummary;
    const trayLayoutApi = window.TokenMonitorTrayLayout;
    const trayTypographyApi = window.TokenMonitorTrayTypography;
    const trayBarsApi = window.TokenMonitorTrayBars;
    const compactMoneyApi = window.TokenMonitorCompactMoney;
    const balanceDisplay = window.TokenMonitorLimitBalanceDisplay;
    const accountIdentityApi = window.TokenMonitorAccountIdentity;
    const { clientColors } = window.TokenMonitorUsageCharts;
    const panelApi = window.TokenMonitorNotchPanel;
    const panel = panelApi.createNotchPanel({ document, window, el, t, state, bridge, shared: {
      markNode, hasMask, providerLabel, limitProviderColor, formatTokens, formatCardTokens, formatBreakdownTokens, formatCost, usageCostNode, formatRate,
      appearance, prefersReducedMotion, ensureRefreshButton, readableColor, limitAccountTitle, overflowText, limitWindowsView, pluginHost, pluginContent
    } });

    // ---- Top notch ------------------------------------------------------------

    const notchNumbers = new Map();
    let lastNotchSlots = '';
    let lastNotchSize = '';
    let notchHeaderKey = '';
    let notchExpanded = false;
    let panelPainted = false;
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

    function stopNotchNumber(held) {
      cancelAnimationFrame(held.handle); clearTimeout(held.timer);
      held.settleRoll?.();
      held.handle = held.timer = held.settleRoll = held.pending = null;
    }

    function settleNotchNumbers() {
      for (const held of notchNumbers.values()) {
        stopNotchNumber(held); held.value = held.target; held.node.textContent = held.format(held.target);
      }
    }

    function notchNumber(key, row, used) {
      const measure = row.measure;
      if (!measure || !Number.isFinite(measure.value)) return el('span', '', row.text || '—');
      // Source, units and locale changes establish a new numeric baseline.
      const semantic = JSON.stringify([key, { ...measure, value: null }, appearance().currency, appearance().compactTokenUnits, state.locale]);
      used.add(semantic);
      let held = notchNumbers.get(semantic);
      if (!held) {
        held = { node: el('span', 'notch-number'), value: measure.value, target: measure.value, handle: null };
        notchNumbers.set(semantic, held);
      }
      const format = held.format = (value) => notchMeasureText(measure, value);
      const mode = numberAnimation.normalize(appearance().tokenNumberAnimation);
      const changed = held.target !== measure.value;
      const visible = !state.payload.expanded && !state.payload.summaryMeasurement?.measuring;
      if (changed || held.mode !== mode || prefersReducedMotion() || !visible) {
        const glyphs = mode === 'roll' ? numberAnimation.capture(held.node) : null;
        const from = held.value;
        stopNotchNumber(held);
        held.target = measure.value;
        if (!visible || prefersReducedMotion() || !changed || held.mode && held.mode !== mode) held.value = held.target;
        else if (mode === 'roll') {
          held.value = held.target;
          held.pending = { from, to: held.target, fromText: format(from), toText: format(held.target), glyphs };
        } else {
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
      held.mode = mode;
      if (!held.settleRoll) held.node.textContent = format(held.value);
      return held.node;
    }

    // Shared glyph animation measures connected, fitted nodes. A clipped reading
    // keeps its native ellipsis instead of replacing it with an atomic glyph group.
    function animateNotchNumbers() {
      for (const held of notchNumbers.values()) {
        if (!held.pending && !held.settleRoll && !held.handle) continue;
        const run = held.node.closest('.notch-text-run');
        if (!held.node.isConnected || held.node.closest('[hidden]') || run.style.maxWidth !== 'none' && run.scrollWidth > run.clientWidth + 1) {
          stopNotchNumber(held); held.value = held.target; held.node.textContent = held.format(held.target);
          continue;
        }
        const pending = held.pending;
        if (!pending) continue;
        held.pending = null;
        held.settleRoll = numberAnimation.beginRoll(held.node, pending.fromText, pending.toText, pending.to > pending.from, null, pending.glyphs);
        held.timer = setTimeout(() => {
          held.settleRoll?.(); held.settleRoll = held.timer = null;
        }, numberAnimation.duration);
      }
    }

    function notchIcon(item) {
      if (item.providerCell && state.payload.geometry.summaryRingSize > 0) {
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
      head.style.setProperty('--notch-native-left', payload.geometry.gapWidth > 0 ? `${offset}px` : 'minmax(0, 1fr)');
      head.style.setProperty('--notch-camera-gap', `${payload.geometry.gapWidth}px`);
      head.style.setProperty('--notch-plugin-clearance', payload.geometry.gapWidth > 0 ? `${offset + payload.geometry.gapWidth}px` : '0px');
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
    const notchSummaryObserver = new ResizeObserver((entries) => {
      for (const { target } of entries) {
        if (target.classList.contains('notch-text-run')) fitNotchTypeface(target);
      }
      const head = contentLayer.querySelector('.notch-summary');
      if (head) { reportNotchSlots(head); animateNotchNumbers(); }
    });

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
      if (['custom', 'account'].includes(row.metric || item.metric)) run.setAttribute('aria-label', row.text || '');
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

    function notchSessionActivity(block, item, mixed) {
      block.classList.add('notch-session-activity');
      const labels = [];
      if (item.running) labels.push(t('notch.runningCount', { count: item.running }));
      if (item.waiting) labels.push(t('edgeDock.waitingCount', { count: item.waiting }));
      block.setAttribute('aria-label', labels.join(' · '));
      if (item.running === 1 && !item.waiting) {
        const wave = el('span', 'notch-wave');
        wave.setAttribute('aria-hidden', 'true');
        for (let index = 0; index < 5; index += 1) wave.append(el('i'));
        block.append(wave);
        return;
      }
      if (item.running) {
        const count = el('span', 'notch-activity-count', String(item.running));
        count.classList.toggle('is-mixed', mixed);
        block.append(count);
      }
      if (item.waiting) {
        const badge = el('span', 'notch-waiting-badge');
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 16 16');
        icon.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3.5 3v-3A1.5 1.5 0 0 1 2 9V4A1.5 1.5 0 0 1 4 2.5ZM5.5 6.5h5');
        icon.append(path);
        badge.append(icon, el('span', 'notch-waiting-count', String(item.waiting)));
        block.append(badge);
      }
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
      const sessionOnly = payload.summary?.sessionOnly === true;
      head.classList.toggle('is-light-session-summary', sessionOnly && payload.style !== 'black' && !payload.geometry.notched
        && window.TokenMonitorThemePresets?.isLightHex(payload.appearance?.themeColors?.bg) === true);
      const activityProviders = new Set((payload.summary?.items || []).filter(item => item.type === 'icon').map(item => item.provider));
      for (const item of payload.summary?.items || []) {
        if (item.type === 'plugin') {
          const canvas = el('canvas', 'notch-plugin-bitmap');
          canvas.dataset.pluginRef = item.ref;
          canvas.width = canvas.height = 40;
          parts.push(canvas);
          continue;
        }
        const iconProvider = item.type === 'icon' ? item.provider : item.iconProvider;
        const mark = iconProvider ? notchIcon({ ...item, provider: iconProvider }) : null;
        if (mark) mark.setAttribute('aria-label', iconProvider === 'app' ? 'Token Monitor' : providerLabel(iconProvider));
        if (item.type === 'icon') { parts.push(mark); continue; }
        const block = el('span', 'notch-reading');
        let iconGap;
        block.dataset.notchSpacer = String(item.type === 'spacer');
        const roomyRing = payload.geometry.gapWidth === 0 && payload.geometry.summaryRingSize > 0;
        const fontSize = item.type === 'stack' ? (roomyRing ? 10 : 9) : Math.max(9, Math.min(16, (roomyRing ? 14 : 12) * (Number(item.scale) || 1)));
        block.style.font = trayTypographyApi.font(item, fontSize, item.type === 'stack' ? 600 : 500);
        block.style.fontVariantNumeric = 'tabular-nums';
        if (item.type === 'spacer') {
          block.textContent = item.variant === 'dot' ? '·' : ' ';
          block.style.width = `${trayTypographyApi.spacerWidth(item, 20)}px`;
        } else if (item.type === 'bars') {
          const layout = trayBarsApi.trayBarsLayout(20);
          iconGap = layout.barsX - layout.iconSize;
          block.classList.add('notch-bars');
          block.style.gap = `${layout.barGap}px`;
          for (const row of item.rows) {
            const track = el('span', 'notch-bar');
            track.style.width = `${layout.barsWidth}px`;
            track.style.height = `${layout.barHeight}px`;
            track.style.borderRadius = `${layout.radius}px`;
            track.setAttribute('aria-label', row.selection ? providerLabel(row.selection.provider) : '—');
            const fill = el('span', 'notch-bar-fill');
            fill.style.width = `${Math.max(0, Math.min(100, row.percent || 0))}%`;
            track.append(fill); block.append(track);
          }
        } else if (item.type === 'stack') {
          iconGap = trayTypographyApi.iconGap(20);
          block.classList.add('notch-stack');
          block.style.alignItems = item.alignment === 'left' ? 'flex-start' : 'flex-end';
          item.rows.forEach((row, i) => block.append(notchText(item, row, `${item.id}:${i}:${JSON.stringify(row.source || row.selection?.source)}`, used)));
        } else if (item.type === 'activity') {
          block.classList.add('notch-activity');
          block.style.setProperty('--notch-accent', clientColors[item.provider] || limitProviderColor(item.provider));
          if (sessionOnly) {
            notchSessionActivity(block, item, activityProviders.size > 1);
          } else if (item.running === 1 && !item.waiting) {
            const wave = el('span', 'notch-wave');
            for (let index = 0; index < 5; index += 1) wave.append(el('i'));
            block.append(wave);
            block.setAttribute('aria-label', t('notch.runningCount', { count: 1 }));
          } else {
            if (item.waiting) block.append(el('span', 'notch-waiting-dot'));
            if (item.running) {
              block.append(el('span', 'notch-activity-count', String(item.running)), el('span', 'notch-reading-unit', t('notch.runningUnit')));
              block.setAttribute('aria-label', t('notch.runningCount', { count: item.running }));
            } else {
              block.append(el('span', 'notch-activity-waiting', t('notch.waiting')));
            }
          }
        } else {
          block.append(notchText(item, item, `${item.id}:${item.period}:${JSON.stringify(item.source)}`, used));
          if (item.unit) block.append(el('span', 'notch-reading-unit', t(`notch.${item.unit}`)));
          if (item.tone) block.dataset.tone = item.tone;
        }
        const field = mark ? el('span', 'notch-summary-field') : block;
        if (mark) {
          if (iconGap !== undefined) field.style.gap = `${iconGap}px`;
          field.append(mark, block);
        }
        parts.push(field);
      }
      const allocation = allocateNotchSummary(payload.summary?.items || [], payload.geometry.gapWidth > 0);
      if (allocation.primary !== null) parts[allocation.primary].dataset.notchPrimary = 'true';
      rightContent.dataset.notchOptional = String(allocation.optionalRight);
      if (sessionOnly && allocation.left.length > 1) {
        // One measured group preserves the overlap and keeps marks out of the camera gap.
        const icons = el('span', 'notch-session-icons');
        allocation.left.forEach((index, order) => {
          const icon = el('span', 'notch-session-icon');
          icon.style.zIndex = String(allocation.left.length - order);
          icon.append(parts[index]); icons.append(icon);
        });
        leftContent.append(icons);
      } else leftContent.append(...allocation.left.map(index => parts[index]));
      rightContent.append(...allocation.right.map(index => parts[index]));
      for (const [key, held] of notchNumbers) {
        if (used.has(key)) continue;
        stopNotchNumber(held);
        notchNumbers.delete(key);
      }
      head.append(left, gap, right);
      positionNotchSummary(head, payload);
      return head;
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
      const pluginNodes = [...head.children].filter(node => node.classList.contains('plugin-content'));
      const pluginWidth = pluginNodes.reduce((sum, node) => sum + Math.min(Number.isFinite(budget) ? budget : head.clientWidth, node.scrollWidth), 0);
      const nativeBudget = Math.max(0, budget - pluginWidth);
      const leftContent = head.querySelector('.notch-left .notch-slot-content');
      const rightContent = head.querySelector('.notch-right .notch-slot-content');
      // Hover transforms are visual only. Fit at rest so live pushes and
      // clock repaints cannot feed enlarged widths back into native layout.
      const transforms = [leftContent.style.transform, rightContent.style.transform];
      leftContent.style.transform = rightContent.style.transform = 'none';
      try {
        const gap = 12 * (Number(state.payload.appearance.zoomFactor) || 1);
        const primaryRight = compact ? Math.min(nativeBudget, fitNotchSlot(rightContent, Infinity).minimum) : 0;
        const left = fitNotchSlot(leftContent, compact ? Math.max(0, nativeBudget - primaryRight - gap) : budget);
        const right = fitNotchSlot(rightContent, compact ? Math.max(0, nativeBudget - left.width - gap) : nativeBudget);
        const firstBlock = [...leftContent.children].find(node => !node.hidden);
        const firstIcon = firstBlock?.classList.contains('notch-summary-field') ? firstBlock.firstElementChild : firstBlock;
        const firstMark = firstIcon?.querySelector('.edge-dock-mark');
        const iconInset = firstMark ? notchLogicalPoint(Math.max(0, firstMark.getBoundingClientRect().left - leftContent.getBoundingClientRect().left)) : 0;
        head.dataset.notchIconInset = iconInset;
        const slots = { left: Math.ceil(notchLogicalPoint(left.width)), right: Math.ceil(notchLogicalPoint(right.width + pluginWidth)), iconInset };
        const key = JSON.stringify([slots, measurement?.measuring ? measurement.id : null]);
        if (key !== lastNotchSlots) {
          lastNotchSlots = key;
          bridge.reportNotchSize(0, slots, measurement?.measuring ? { id: measurement.id } : undefined);
        }
      } finally {
        leftContent.style.transform = transforms[0];
        rightContent.style.transform = transforms[1];
      }
    }
    // The open panel has a fixed height; only the shell shape decides it.
    function reportNotchContentSize() {
      const geometry = state.payload?.geometry;
      if (!geometry) return;
      const zoom = Number(state.payload.appearance.zoomFactor) || 1;
      const height = panelApi.panelContentHeight({ attached: geometry.notched === true && geometry.gapWidth > 0, zoom });
      const key = JSON.stringify([height]);
      if (key !== lastNotchSize) { lastNotchSize = key; bridge.reportNotchSize(height); }
    }

    // Shape-only frames never reconstruct the summary, provider rows or numbers.
    // Persistent summary nodes keep equal outer margins on this same frame.
    function paintHardwareShade(frame) {
      if (!state.payload?.geometry?.notched) return;
      let shade = shapeLayer.querySelector('.notch-hardware-shade');
      if (!shade) {
        const svg = (name) => document.createElementNS('http://www.w3.org/2000/svg', name);
        const defs = svg('defs'), gradient = svg('linearGradient');
        gradient.id = 'notch-hardware-gradient';
        gradient.setAttribute('gradientUnits', 'userSpaceOnUse');
        gradient.setAttribute('x1', '0'); gradient.setAttribute('x2', '0');
        for (const [index, offset] of [0, 0.35, 0.72, 1].entries()) {
          const stop = svg('stop');
          stop.setAttribute('offset', offset);
          stop.setAttribute('stop-color', '#000');
          stop.setAttribute('class', `notch-hardware-stop-${index}`);
          gradient.append(stop);
        }
        const rimGradient = svg('linearGradient');
        rimGradient.id = 'notch-rim-gradient';
        rimGradient.setAttribute('gradientUnits', 'userSpaceOnUse');
        rimGradient.setAttribute('x1', '0'); rimGradient.setAttribute('x2', '0');
        for (const [offset, opacity] of [[0, 0], [0.45, 0.025], [0.8, 0.1], [1, 0.22]]) {
          const stop = svg('stop');
          stop.setAttribute('offset', offset);
          stop.setAttribute('stop-color', '#fff');
          stop.setAttribute('stop-opacity', opacity);
          rimGradient.append(stop);
        }
        defs.append(gradient, rimGradient);
        shade = svg('path'); shade.setAttribute('class', 'notch-hardware-shade');
        shade.setAttribute('fill', 'url(#notch-hardware-gradient)');
        const rim = svg('path'); rim.setAttribute('class', 'notch-glass-rim');
        rim.setAttribute('stroke', 'url(#notch-rim-gradient)');
        shapeLayer.append(defs, shade, rim);
      }
      // The same frame drives the shade and rim, including live resizing,
      // interrupted motion and spring overshoot. Rest/peek stays opaque in CSS.
      const profile = notchGlassGeometry(state.payload.geometry.height, frame.bodyHeight);
      const gradient = shapeLayer.querySelector('#notch-hardware-gradient');
      gradient.setAttribute('y1', profile.capEnd);
      gradient.setAttribute('y2', profile.fadeEnd);
      shade.setAttribute('d', frame.shape.d);
      const rimGradient = shapeLayer.querySelector('#notch-rim-gradient');
      rimGradient.setAttribute('y1', profile.rimTop);
      rimGradient.setAttribute('y2', profile.rimBottom);
      shapeLayer.querySelector('.notch-glass-rim').setAttribute('d', frame.shape.d);
    }

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
      paintHardwareShade(frame);
      // Content shows early while opening and is gone before the shell settles
      // when closing; its size follows the shell's width, overshoot included.
      root.style.setProperty('--notch-content-opacity', Math.max(0, Math.min(1, frame.progress * 1.4 - 0.2)));
      root.style.setProperty('--notch-content-scale', Number.isFinite(frame.contentScale) ? frame.contentScale : 1);
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
        const summaryScale = Number.isFinite(frame.summaryScale) ? frame.summaryScale : 1;
        // Anchor the outer content edges to equal insets. Different glyph widths
        // cannot alter the mirrored margins, including interrupted motion.
        left.style.transform = `translateX(${((frame.summaryEdges?.left ?? restingLeft) - restingLeft + (frame.summaryIconInset || 0) - (Number(header.dataset.notchIconInset) || 0)) / summaryZoom}px) scale(${summaryScale})`;
        right.style.transform = `translateX(${((frame.summaryEdges?.right ?? restingRight) - restingRight) / summaryZoom}px) scale(${summaryScale})`;
      }
      const body = contentLayer.querySelector('.notch-body');
      if (body) {
        body.inert = frame.progress < 1;
        if (frame.bodyBox) { body.style.left = `${frame.bodyBox.x}px`; body.style.width = `${frame.bodyBox.width}px`; }
      }
    }

    function renderNotchPanel(payload, opening) {
      // Fresh reveal content is mounted before it fades in. Later pushes wait
      // for the current shell motion to settle.
      const moving = payload.motion?.progress > 0 && payload.motion.progress < 1;
      if (moving && !opening && contentLayer.querySelector('.notch-body')) { notchRowsPending = true; return; }
      let body = contentLayer.querySelector('.notch-body');
      if (!body) {
        body = el('div', 'notch-body');
        body.append(panel.node);
        contentLayer.append(body);
      }
      panel.place(payload.geometry, Number(payload.appearance.zoomFactor) || 1);
      // Render once while closed so the first reveal measures real content.
      if (payload.expanded || opening || !panelPainted) { panel.render(payload, { opening }); panelPainted = true; }
    }

    function renderNotch(payload) {
      const bitmapRefs = (payload.summary?.items || []).filter(item => item.type === 'plugin').map(item => item.ref);
      pluginHost?.setExplicitDemand('notch', bitmapRefs);
      const opening = payload.expanded === true && !notchExpanded;
      if (!payload.expanded) panel.suspend();
      notchExpanded = payload.expanded === true;
      if (payload.expanded || payload.summaryMeasurement?.measuring) settleNotchNumbers();
      if (opening) notchClock++;
      // A hidden/removed action starts a new visit; late replies cannot repaint it.
      if (!payload.expanded || !payload.refreshEnabled) {
        resetRefreshVisit();
      }
      paintRefreshButton();
      root.classList.toggle('is-notch-open', payload.expanded === true);
      root.classList.toggle('is-notch-attached', payload.geometry.notched === true);
      root.style.setProperty('--notch-zoom', Number(payload.appearance.zoomFactor) || 1);
      const headerActivity = (payload.summary?.items || []).map((item) => item.providerCell ? [
        runningSessionSummary(item.providerCell.sessions).count,
        presentation.waitingSessionSummary(item.providerCell.sessions).count
      ] : 0);
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
        const target = 'notch.summary.content';
        if (pluginContent && (pluginContent.hasTarget(target) || summary.querySelector('.plugin-native-content'))) {
          let native = summary.querySelector('.plugin-native-content');
          if (!native) { native = el('div', 'plugin-native-content'); native.append(...summary.childNodes); summary.append(native); }
          pluginContent.render(target, native, { surface: 'notch', surfaceVariant: 'summary', nativeData: payload });
          for (const node of summary.children) if (node.classList.contains('plugin-content')) notchSummaryObserver.observe(node);
        }
        summary.style.visibility = payload.summaryMeasurement?.measuring ? 'hidden' : '';
        positionNotchSummary(summary, payload); reportNotchSlots(summary);
        paintSummaryPlugins();
        animateNotchNumbers();
      }
      renderNotchPanel(payload, opening);
      applyNotchMotion(payload.motion);
      reportNotchContentSize();
      // The native window can appear only after this measured shape and header
      // have been applied together, not when the raw width report reaches main.
      if (payload.summaryMeasurement?.measuring === false) bridge.reportNotchSize(0, null, { id: payload.summaryMeasurement.id, ready: true });
    }
    function paintSummaryPlugins() {
      for (const canvas of contentLayer.querySelectorAll('.notch-plugin-bitmap')) {
        const view = pluginHost?.state('notch', canvas.dataset.pluginRef);
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        if (view?.entry) pluginHost.renderTray(view, canvas, { height: 40, textColor: getComputedStyle(canvas).color, trackColor: 'rgba(255,255,255,.2)' });
      }
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


    window.addEventListener('pagehide', () => {
      for (const held of notchNumbers.values()) stopNotchNumber(held);
    }, { once: true });

    return {
      render: renderNotch,
      applyMotion: applyNotchMotion,
      applyAppearance(payload) {
        // Material ownership must update even when a tooltip holds the panel's
        // content render; otherwise a failed native scrim leaves the SVG hidden.
        root.classList.toggle('has-native-hardware-shade', payload.nativeHardwareShade === true);
        document.documentElement.classList.toggle('notch-black', payload.style === 'black');
        document.documentElement.classList.toggle('notch-hardware-light', payload.style !== 'black' && payload.geometry?.notched === true
          && window.TokenMonitorThemePresets?.isLightHex(payload.appearance?.themeColors?.bg) === true);
      },
      sessionCells() {
        return [...(state.payload?.expanded ? state.payload.cells || [] : []), ...(state.payload?.summary?.items || []).map(item => item.providerCell).filter(Boolean)];
      },
      needsClock() {
        return Boolean(state.payload?.summary?.needsClock
          || state.payload?.expanded);
      },
      repaint() { notchClock++; renderNotch(state.payload); },
      paintSummaryPlugins,
      pluginViewsChanged() { panel.pluginViewsChanged(); if (state.payload) renderNotch(state.payload); }
    };
  }
  return { createNotchRenderer, notchGlassGeometry };
});
