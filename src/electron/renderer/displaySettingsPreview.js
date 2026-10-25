'use strict';

(function expose(root) {
  function create({ bridge, settings, stats, bitmap, t, window, document }) {
    const stages = new Map(), bitmaps = new WeakMap();
    const appearanceKeys = ['language', 'theme', 'themePreset', 'themeColors', 'vendorColors', 'interfaceFontFamily', 'displayFontFamily', 'textSize', 'glassOpacity', 'glassBlur', 'systemGlass', 'currency', 'currencyRate', 'currencyRateOverride', 'currencyRatesEffective', 'showCompactTotalTokens', 'sessionContextMetric', 'tokenNumberAnimation', 'compactTokenUnits', 'showLimitUsed', 'limitsEnabled', 'limitProviders', 'limitProviderOrder', 'showCodexAdditionalLimits', 'limitProviderHiddenItems', 'showTrayProviderBadge', 'maskLimitAccountEmails', 'tokenRateMode', 'contextDisplayMode'];
    function keyFor(surface, phase) {
      const preferences = settings();
      const keys = Object.keys(preferences).filter(key => key.startsWith(surface) || appearanceKeys.includes(key) || surface === 'notch' && key.startsWith('tray'));
      return JSON.stringify([phase, ...keys.sort().map(key => [key, preferences[key]])]);
    }
    function fit(entry) {
      if (!entry.data || !entry.frame || entry.stage.clientWidth <= 0) return;
      const { width, height, previewHeight = height, scale: size = 1, align } = entry.data;
      // One fixed scene scale for the notch so changing its size remains visible.
      const scale = entry.surface === 'notch' ? Math.min(1, entry.stage.clientWidth / 740)
        : Math.min(.9 * size, 220 / height);
      const frame = entry.frame;
      frame.style.width = `${width}px`; frame.style.height = `${height}px`;
      frame.style.transform = `scale(${scale})`;
      frame.style.left = `${align === 'left' ? 0 : align === 'right' ? entry.stage.clientWidth - width * scale : (entry.stage.clientWidth - width * scale) / 2}px`;
      frame.style.top = entry.surface === 'edgeDock' ? `${(entry.stage.clientHeight - height * scale) / 2}px` : '0';
      if (entry.surface === 'notch') entry.stage.style.height = `${Math.max(40, Math.ceil(previewHeight * scale) + 6)}px`;
    }
    function request(entry, slots) {
      return bridge.getDisplayPreview(entry.surface, entry.phase, slots);
    }
    const observer = new window.ResizeObserver(entries => {
      for (const { target } of entries) { const entry = stages.get(target); if (entry) fit(entry); }
    });
    window.addEventListener('message', event => {
      if (!['display-preview-ready', 'display-preview-measured'].includes(event.data?.type)) return;
      for (const entry of stages.values()) {
        const frame = [...entry.frames.values()].find(item => item.contentWindow === event.source);
        if (!frame) continue;
        if (event.data.type === 'display-preview-measured') {
          if (entry.key !== event.data.key || entry.measuredKey === entry.key || entry.frame !== frame) return;
          entry.measuredKey = entry.key;
          const revision = entry.revision;
          Promise.resolve(request(entry, event.data.slots)).then(data => {
            if (revision !== entry.revision || !data) return;
            entry.cache.set(entry.key, data); paint(entry, data);
          }).catch(() => {
            if (revision !== entry.revision) return;
            // Retain the approximate first layout if measuring fails; never
            // leave the real renderer's measurement-only summary invisible.
            const data = { ...entry.data, payload: { ...entry.data.payload, summaryMeasurement: { id: 1, measuring: false } } };
            entry.cache.set(entry.key, data); paint(entry, data);
          });
          return;
        }
        frame.dataset.ready = 'true';
        window.clearTimeout(entry.frameTimers.get(frame));
        entry.frameTimers.delete(frame);
        if (entry.frame === frame && entry.data) paint(entry, entry.data);
      }
    });
    function send(entry) {
      if (entry.frame?.dataset.ready !== 'true') return;
      const payload = entry.data.payload;
      entry.frame.contentWindow.postMessage({ type: 'display-preview-render', key: entry.key, payload }, '*');
    }
    function paint(entry, data) {
      entry.data = data;
      const surface = data.payload.surface;
      let frame = entry.frames.get(surface);
      if (!frame) {
        frame = document.createElement('iframe'); frame.setAttribute('aria-label', t('settings.displayModes.preview')); frame.tabIndex = -1;
        // No preload or navigation capability: the child only paints parent data.
        frame.src = `edgeDock/index.html?surface=${surface}&settingsPreview=1`;
        frame.hidden = true;
        entry.frames.set(surface, frame); entry.stage.append(frame);
        entry.frameTimers.set(frame, window.setTimeout(() => {
          if (frame.dataset.ready === 'true') return;
          entry.frames.delete(surface); entry.frameTimers.delete(frame); frame.remove();
          if (entry.frame !== frame) return;
          entry.frame = null; entry.key = null; entry.status.hidden = false;
          entry.status.textContent = t('settings.displayModes.previewUnavailable');
        }, 3000));
      }
      for (const other of entry.frames.values()) other.hidden = other !== frame || other.dataset.ready !== 'true';
      entry.frame = frame; entry.status.hidden = frame.dataset.ready === 'true';
      if (!entry.status.hidden) entry.status.textContent = t('settings.common.loading');
      fit(entry);
      send(entry);
    }
    function show(surface, stage, phase, { force = false } = {}) {
      stage.dataset.surface = surface; stage.dataset.phase = phase;
      if (surface === 'tray' || surface === 'floatingBubble') {
        const previous = bitmaps.get(stage), key = keyFor(surface, phase), currentStats = stats?.();
        if (!force && previous?.key === key && previous.stats === currentStats) return;
        bitmaps.set(stage, { key, stats: currentStats });
        let node = stage.firstElementChild;
        if (!node) { node = document.createElement('div'); node.className = 'display-settings-bitmap'; stage.append(node); }
        const output = bitmap(surface), src = output?.src || output?.generatedSrc;
        const value = src || output?.text || 'Σ';
        if (node.dataset.value === value) return;
        node.dataset.value = value;
        if (src) { const img = document.createElement('img'); img.alt = ''; img.src = src; node.replaceChildren(img); }
        else node.textContent = value;
        return;
      }
      let entry = stages.get(stage);
      if (!entry) {
        const status = document.createElement('p'); status.className = 'settings-note'; status.textContent = t('settings.common.loading'); stage.append(status);
        entry = { surface, stage, frames: new Map(), frameTimers: new Map(), status, key: null, revision: 0, cache: new Map() };
        stages.set(stage, entry); observer.observe(stage);
      }
      const key = keyFor(surface, phase);
      if (entry.key === key) { fit(entry); return; }
      entry.key = key; entry.phase = phase; entry.measuredKey = null; const revision = ++entry.revision;
      if (entry.cache.has(key)) { paint(entry, entry.cache.get(key)); return; }
      // Navigation is synchronous. A slow IPC result only updates its original
      // preview, never the active page or a newer settings revision.
      Promise.resolve(request(entry)).then(data => {
        if (revision !== entry.revision) return;
        if (!data) throw new Error('Preview unavailable');
        entry.cache.set(key, data);
        if (entry.cache.size > 8) entry.cache.delete(entry.cache.keys().next().value);
        paint(entry, data);
      }).catch(() => {
        if (revision !== entry.revision) return;
        entry.key = null; entry.status.hidden = false;
        entry.status.textContent = t('settings.displayModes.previewUnavailable');
      });
    }
    return { show };
  }
  root.TokenMonitorDisplaySettingsPreview = { create };
})(window);
