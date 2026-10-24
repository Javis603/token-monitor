'use strict';
(function expose(root) {
  function create({ document, window, api, t, breakdown, update, isActive = () => true }) {
    const container = document.createElement('section'); container.className = 'plugin-page-designs'; container.hidden = true;
    const toolbar = document.createElement('label'); toolbar.className = 'settings-item';
    const label = document.createElement('span'); label.className = 'settings-item-text';
    const select = document.createElement('select'); toolbar.append(label, select);
    const panel = document.createElement('div'); panel.className = 'plugin-web-panel';
    const status = document.createElement('p'); status.className = 'settings-note'; status.setAttribute('role', 'status'); status.hidden = true;
    container.append(toolbar, status); breakdown.before(container);
    const selectControl = window.TokenMonitorSelectControl?.enhance(select);
    let lastCatalog = null, failedReason = '', lastTarget = null, readyRef = '', retryTimer = null, retries = 0;
    let selections = {}, latest = null, key = '', revision = 0, busy = false, failed = false, requestPending = false, queued = false;
    let docs = [], probe = false, advertised = false, lastSync = '', panelRef = '', panelSlot = '';
    const active = () => latest?.visible && !document.hidden && isActive();
    const theme = () => {
      const css = getComputedStyle(document.documentElement);
      const rgb = (name, fallback) => /^\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*$/.test(css.getPropertyValue(name)) ? `rgb(${css.getPropertyValue(name).trim()})` : fallback;
      return { colors: { background: rgb('--glass-rgb', '#17191c'), text: css.getPropertyValue('--text').trim() || '#eee', muted: css.getPropertyValue('--muted').trim() || '#999', accent: css.getPropertyValue('--accent').trim() || '#8aafff', border: getComputedStyle(document.querySelector('.shell') || document.body).borderTopColor }, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches || latest?.reducedMotion, dark: css.colorScheme !== 'light', font: getComputedStyle(document.body).fontFamily };
    };
    function layout(selected) {
      const ready = Boolean(selected && selected.ref === readyRef);
      if (!panel.isConnected) { breakdown.classList.remove('plugin-web-replaced'); return; }
      panel.style.position = ready ? '' : 'absolute';
      const width = ready ? '' : `${container.getBoundingClientRect().width}px`;
      if (panel.style.width !== width) panel.style.width = width;
      panel.style.visibility = ready ? '' : 'hidden';
      breakdown.classList.toggle('plugin-web-replaced', Boolean(ready && selected?.slot === 'replace'));
    }
    async function sync() {
      if (!latest) return;
      if (requestPending) { queued = true; return; }
      requestPending = true;
      const serial = revision, input = latest;
      const selected = docs.find(d => d.ref === selections[input.snapshot.target]);
      const canPresent = Boolean(active() && selected && !failed && panel.isConnected);
      // No documents means no discovery, theme reads or geometry work. A hidden
      // probe is sufficient to recover persisted selections when docs appear.
      if (!canPresent && !advertised && !probe) { clearTimeout(retryTimer); retryTimer = null; requestPending = false; return; }
      const rect = canPresent ? panel.getBoundingClientRect() : null;
      const footer = canPresent ? document.querySelector('.footer')?.getBoundingClientRect() : null;
      const visible = canPresent && rect.y >= 0 && rect.y < (footer?.top || window.innerHeight) && !document.querySelector('[popover]:popover-open');
      if (!visible && readyRef) { readyRef = ''; layout(null); }
      const payload = visible ? { visible: true, snapshot: input.snapshot, rect: { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, (footer?.top || window.innerHeight) - rect.y) }, theme: theme() } : { visible: false };
      const syncKey = JSON.stringify(payload);
      if (!probe && syncKey === lastSync) { requestPending = false; return; }
      clearTimeout(retryTimer); retryTimer = null;
      probe = false; advertised = Boolean(visible);
      try {
        const result = await api.webSync(payload);
        if (serial === revision) {
          lastSync = syncKey;
          const changed = JSON.stringify(selections) !== JSON.stringify(result.selections || {});
          selections = result.selections || {};
          if (result.error) { readyRef = ''; layout(null); failed = true; status.textContent = t('plugins.web.failed'); status.hidden = false; breakdown.classList.remove('plugin-web-replaced'); }
          else if (changed) update();
          else {
            const selected = (latest?.catalog?.plugins || []).filter(p => p.status === 'active').flatMap(p => p.webDocuments || []).find(d => d.ref === selections[input.snapshot.target]);
            const nextReady = visible && result.mounted ? selected?.ref || '' : '';
            const handoff = readyRef !== nextReady;
            readyRef = nextReady; if (handoff) layout(selected);
            if (handoff) { queued = true; retries = 0; }
            else if (visible && selected && !result.mounted && retries++ < 50) retryTimer = setTimeout(() => { lastSync = ''; void sync(); }, 100);
            else retries = 0;
          }
        }
      } catch { if (serial === revision) { readyRef = ''; layout(null); failed = true; status.textContent = t('plugins.web.failed'); status.hidden = false; breakdown.classList.remove('plugin-web-replaced'); } }
      finally { requestPending = false; if (queued) { queued = false; void sync(); } }
    }
    select.addEventListener('change', async () => {
      busy = true; select.disabled = true;
      try { selections = await api.webSelect(latest.snapshot.target, select.value); lastSync = ''; readyRef = ''; panelRef = ''; failed = false; status.hidden = true; }
      catch { status.textContent = t('plugins.web.failed'); status.hidden = false; }
      finally { busy = false; select.disabled = false; update(); }
    });
    api.onWebReady?.(() => { retries = 0; lastSync = ''; void sync(); });
    api.onWebRestore(() => { selections = {}; failed = false; lastSync = ''; update(); (toolbar.querySelector('.select-control-trigger') || select).focus(); });
    api.onWebFailed(reason => { revision++; lastSync = ''; failedReason = reason; readyRef = ''; layout(null); failed = true; status.textContent = t('plugins.web.failed'); status.hidden = false; breakdown.classList.remove('plugin-web-replaced'); });
    window.addEventListener('pagehide', () => { clearTimeout(retryTimer); latest = null; revision++; observer.disconnect(); if (advertised) void api.webSync({ visible: false }).catch(() => {}); }, { once: true });
    window.addEventListener('resize', () => { if (panel.isConnected) layout(docs.find(d => d.ref === selections[latest?.snapshot.target])); void sync(); });
    document.addEventListener('scroll', () => void sync(), true);
    document.addEventListener('visibilitychange', () => void sync());
    document.addEventListener('toggle', () => void sync(), true);
    const observer = new MutationObserver(() => { if (latest) void sync(); });
    observer.observe(document.querySelector('.shell') || document.body, { attributes: true, attributeFilter: ['class'] });
    const settings = document.getElementById('settingsPanel'); if (settings) observer.observe(settings, { attributes: true, attributeFilter: ['class'] });
    return {
      render(input) {
        if (input.snapshot.target !== lastTarget || (input.catalog !== lastCatalog && ['unavailable', 'changed'].includes(failedReason))) { lastSync = ''; failed = false; status.hidden = true; }
        lastTarget = input.snapshot.target; lastCatalog = input.catalog;
        if (!input.visible) readyRef = '';
        latest = input; revision++;
        docs = (input.catalog?.plugins || []).filter(p => p.status === 'active').flatMap(p => (p.webDocuments || []).filter(d => d.target === input.snapshot.target).map(d => ({ ...d, name: `${p.name} · ${d.title}` })));
        // Nothing offered before or now: leave the hidden chooser untouched, so
        // a native render writes no text, options or select state.
        if (!docs.length && key === '[]' && !panel.isConnected && container.hidden) return;
        container.hidden = !input.visible || !docs.length;
        label.textContent = t('plugins.web.design');
        const nextKey = JSON.stringify(docs);
        if (nextKey !== key) { probe = docs.length > 0; lastSync = ''; key = nextKey; select.replaceChildren(); for (const doc of [{ ref: '', name: t('plugins.web.original') }, ...docs]) { const option = document.createElement('option'); option.value = doc.ref; option.textContent = doc.name; select.append(option); } }
        const selected = docs.find(d => d.ref === selections[input.snapshot.target]);
        select.value = selected?.ref || ''; select.disabled = busy; selectControl?.sync();
        if (input.visible && selected && !failed) {
          const anchor = selected.slot === 'after' ? breakdown : container;
          const moved = panel.previousElementSibling !== anchor;
          const height = `${selected.height}px`, resized = panel.style.height !== height;
          if (resized) panel.style.height = height;
          if (moved) anchor.after(panel);
          if (moved || resized || panelRef !== selected.ref || panelSlot !== selected.slot) layout(selected);
          panelRef = selected.ref; panelSlot = selected.slot;
        } else {
          if (panel.isConnected) panel.remove();
          panelRef = ''; panelSlot = '';
          breakdown.classList.remove('plugin-web-replaced');
        }
        void sync();
      }
    };
  }
  root.TokenMonitorPluginPageDesigns = { create };
})(window);
