import { t, resolveLocale } from './i18n.mjs';

export function activate(ctx) {
  return {
    mount(container, context = {}) {
      const root = document.createElement('section'); root.className = 'qa-settings';
      const fields = document.createElement('div'); fields.className = 'qa-fields';
      const actions = document.createElement('div'); actions.className = 'qa-actions settings-actions';
      const testInfo = document.createElement('details'); testInfo.className = 'qa-test-info';
      const testSummary = document.createElement('summary'); testInfo.append(testSummary);
      const controls = new Map(), labels = new Map(), notes = new Map();
      const state = document.createElement('p'); state.className = 'qa-state'; state.setAttribute('role', 'status');
      const feedback = document.createElement('p'); feedback.className = 'qa-feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
      const permission = document.createElement('p'); permission.className = 'qa-note';
      const receipt = document.createElement('p'); receipt.className = 'qa-note';
      const test = document.createElement('button'); test.type = 'button'; test.disabled = true; test.dataset.channel = 'os';
      let testing = false;
      let snapshot, latest = context.data, disposed = false, saving = false, saveTask = Promise.resolve();
      const pending = new Map();
      function field(name, type, parent) {
        const label = document.createElement('label'); label.className = type === 'checkbox' ? 'qa-setting checkbox-label settings-item' : 'qa-setting settings-item';
        const title = document.createElement('span'); title.className = 'settings-item-title settings-item-text'; const input = document.createElement('input');
        input.name = name;
        if (type !== 'checkbox') input.className = 'qa-value'; input.type = type; input.disabled = true;
        if (type === 'checkbox') { input.setAttribute('role', 'switch'); input.className = 'qa-switch'; }
        if (type === 'number') { input.min = '1'; input.max = '99'; input.step = '1'; }
        label.append(title, input); parent.append(label); controls.set(name, input); labels.set(name, title);
        input.addEventListener(type === 'checkbox' ? 'change' : 'blur', () => { void save(name); });
        if (type !== 'checkbox') input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } });
      }
      function note(key, parent) { const node = document.createElement('p'); node.className = 'qa-note'; notes.set(key, node); parent.append(node); }
      test.addEventListener('click', async () => {
        if (testing || disposed || !snapshot) return;
        testing = true; sync();
        try {
          await saveTask;
          if (disposed) return;
          feedback.textContent = text('sending');
          const results = await ctx.backend.call('notification.test');
          if (!disposed) feedback.textContent = results.length ? results.map(r => text(r.status === 'failed' ? 'testFailed' : r.status)).join(' / ') : text('testFailed');
        } catch (_) { if (!disposed) feedback.textContent = text('testFailed'); }
        finally { testing = false; if (!disposed) sync(); }
      });
      root.append(state, fields, actions, testInfo, permission, receipt);
      field('lowQuota', 'checkbox', fields); field('threshold', 'number', fields);
      field('recovery', 'checkbox', fields); note('recoveryHelp', fields);
      actions.append(test, feedback); note('testNotice', testInfo);
      container.append(root);
      const text = (key, args) => t(resolveLocale(document.documentElement.lang || latest?.locale), key, args);
      function sync() {
        for (const [name, input] of controls) {
          const value = pending.has(name) ? pending.get(name) : snapshot?.values[name];
          if (input.type === 'checkbox') { input.checked = value === true; input.setAttribute('aria-checked', String(input.checked)); }
          else if (document.activeElement !== input) input.value = value ?? '';
          input.disabled = testing || !snapshot;
        }
        test.disabled = testing || !snapshot;
      }
      function render(data = latest) {
        if (disposed) return; latest = data;
        for (const [key, node] of labels) node.textContent = text(key);
        for (const [key, node] of notes) node.textContent = text(key);
        testSummary.textContent = text('testInfo');
        test.textContent = text('testOs');
        const active = data?.active || [];
        let stateKey = data?.state || 'starting';
        if (stateKey === 'monitoring') {
          if (data?.background !== true) stateKey = 'foregroundOnly';
          else if (active.length && data?.settings?.lowQuota) stateKey = 'low';
        }
        state.textContent = text(stateKey, { count: active.length, threshold: data?.settings?.threshold });
        permission.textContent = text(data?.background ? 'backgroundAllowed' : 'backgroundRequired');
        receipt.textContent = (data?.receipts || []).map(r => `${r.providerLabel} · ${text(`${r.channel}Channel`)}: ${text(r.status)}`).join(' / ');
      }
      function save(name) {
        if (disposed || testing || !snapshot) return;
        const input = controls.get(name);
        const value = input.type === 'checkbox' ? input.checked : Number(input.value);
        if (Object.is(value, pending.has(name) ? pending.get(name) : snapshot.values[name])) return;
        pending.set(name, value);
        if (!saving) saveTask = flush();
      }
      async function flush() {
        saving = true;
        let failed = false;
        // Keep controls usable through blur → click; serialize writes instead.
        feedback.textContent = text('saving');
        try {
          while (!disposed && pending.size) {
            const [name, value] = pending.entries().next().value;
            if (!Object.is(value, snapshot.values[name])) {
              try {
                snapshot = await ctx.backend.call('preferences.update', { expectedRevision: snapshot.revision, patch: { [name]: value } });
              } catch (_) {
                failed = true;
                // Refresh conflicts without retrying the failed change.
                try { snapshot = await ctx.backend.call('preferences.get'); } catch { /* Keep the last confirmed snapshot. */ }
              }
            }
            // Preserve a newer edit made while this value was being saved.
            if (Object.is(pending.get(name), value)) pending.delete(name);
            if (!disposed) sync();
          }
          if (!disposed) feedback.textContent = text(failed ? 'saveFailed' : 'saved');
        } finally { saving = false; if (!disposed) sync(); }
      }
      const language = new MutationObserver(() => render());
      language.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
      const unsubscribe = ctx.backend.subscribe(render); render();
      ctx.backend.call('preferences.get').then(value => { if (!disposed) { snapshot = value; sync(); } })
        .catch(() => { if (!disposed) feedback.textContent = text('loadFailed'); });
      ctx.backend.call('status').then(value => { if (!latest) render(value); }).catch(() => {});
      return {
        update(next) { render(next.data || latest); },
        hasUnsavedChanges: () => saving || [...controls].some(([name, input]) => snapshot && input.type !== 'checkbox' && String(snapshot.values[name]) !== input.value.trim()),
        dispose() { disposed = true; language.disconnect(); unsubscribe(); root.remove(); }
      };
    }
  };
}
