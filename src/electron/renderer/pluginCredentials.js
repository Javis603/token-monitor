'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginCredentials = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Both host-default and author-composed forms use this exact controller.
  function create({ document, call, t, localize }) {
    async function mount(container, { moduleId }) {
      let snapshot = await call('credentials.status', { moduleId });
      let disposed = false, pending = false, generation = 0, conflict = false;
      const dirty = new Set(), controls = new Map();
      const wrapper = document.createElement('div'); wrapper.className = 'plugin-author-settings';
      const form = document.createElement('div'); form.className = 'plugin-credential-form plugin-author-form';
      const feedback = document.createElement('p'); feedback.className = 'settings-note plugin-author-status'; feedback.setAttribute('role', 'status');
      const error = document.createElement('p'); error.className = 'plugin-author-error'; error.setAttribute('role', 'alert');
      const buttons = document.createElement('div'); buttons.className = 'settings-actions';
      const save = document.createElement('button'), clear = document.createElement('button'), reload = document.createElement('button');
      for (const [button, key] of [[save, 'save'], [clear, 'clear'], [reload, 'reload']]) { button.type = 'button'; button.className = 'settings-button'; button.textContent = t(`plugins.credentials.${key}`); buttons.append(button); }
      for (const field of snapshot.declaration.fields) {
        const label = document.createElement('label'); label.className = 'plugin-author-field';
        const title = document.createElement('span'); title.className = 'plugin-author-label'; title.textContent = localize(field.label);
        const input = document.createElement(field.control === 'textarea' ? 'textarea' : 'input');
        if (field.control === 'input') input.type = 'password'; else input.rows = 4;
        input.className = 'plugin-author-input'; input.autocomplete = 'off'; input.spellcheck = false;
        input.maxLength = 16384; input.dataset.credentialField = field.id;
        input.addEventListener('input', () => { dirty.add(field.id); error.textContent = ''; error.hidden = true; });
        controls.set(field.id, input); label.append(title, input); form.append(label);
      }
      const note = document.createElement('p'); note.className = 'settings-note'; note.textContent = t('plugins.credentials.storage');
      form.prepend(feedback); form.append(buttons, error, note); wrapper.append(form); container.append(wrapper);
      function paint() {
        feedback.textContent = t(snapshot.configured ? 'plugins.credentials.configured' : 'plugins.credentials.notConfigured');
        for (const [id, input] of controls) input.placeholder = t(snapshot.fields[id] ? 'plugins.credentials.present' : 'plugins.credentials.empty');
        error.hidden = !error.textContent; reload.hidden = !conflict;
        save.disabled = pending; clear.disabled = pending; reload.disabled = pending;
        for (const input of controls.values()) input.disabled = pending;
      }
      async function run(clearAll) {
        if (pending || disposed) return;
        pending = true; generation++; error.textContent = ''; paint();
        try {
          const patch = Object.fromEntries([...dirty].map(id => [id, controls.get(id).value]));
          const next = await call(clearAll ? 'credentials.clear' : 'credentials.update', { moduleId, expectedRevision: snapshot.revision, ...(clearAll ? {} : { patch }) });
          if (disposed) return;
          snapshot = next; dirty.clear(); conflict = false;
          for (const input of controls.values()) input.value = '';
        } catch (cause) {
          if (!disposed) {
            conflict = String(cause?.message || cause).includes('credentials-conflict');
            error.textContent = t(conflict ? 'plugins.credentials.conflict' : 'plugins.credentials.saveError');
          }
        } finally { pending = false; if (!disposed) paint(); }
      }
      save.addEventListener('click', () => void run(false)); clear.addEventListener('click', () => void run(true));
      reload.addEventListener('click', async () => {
        if (pending || disposed) return;
        pending = true; generation++; paint();
        try {
          const next = await call('credentials.status', { moduleId });
          if (!disposed) { snapshot = next; conflict = false; error.textContent = ''; }
        } catch { if (!disposed) error.textContent = t('plugins.credentials.saveError'); }
        finally { pending = false; if (!disposed) paint(); }
      });
      paint();
      return {
        async update(context) {
          // Never silently replace an editor's base revision or its drafts.
          if (context?.visible === false || dirty.size || pending || disposed) return;
          const current = ++generation;
          const next = await call('credentials.status', { moduleId });
          if (current === generation && !disposed && !dirty.size && !pending) { snapshot = next; paint(); }
        },
        hasUnsavedChanges: () => dirty.size > 0 || pending,
        dispose() { disposed = true; wrapper.remove(); }
      };
    }
    return { mount };
  }
  return { create };
});
