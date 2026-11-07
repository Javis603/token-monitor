'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginCredentials = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Both host-default and author-composed forms use this exact controller.
  function create({ document, call, t, localize }) {
    async function mount(container, { moduleId, onStateChange = () => {} }) {
      let snapshot = await call('credentials.status', { moduleId });
      let disposed = false, pending = false, generation = 0, conflict = false;
      let editing = snapshot.verification !== 'valid', manualEditing = false;
      const hasSaved = () => Object.values(snapshot.fields).some(Boolean);
      const dirty = new Set(), controls = new Map();
      const wrapper = document.createElement('div'); wrapper.className = 'plugin-native-credentials plugin-credential-form';
      const form = document.createElement('div'); form.className = 'plugin-credential-editor opencode-credential-fields';
      const summary = document.createElement('div'); summary.className = 'settings-actions plugin-credential-summary';
      const edit = document.createElement('button'), verify = document.createElement('button'), cancel = document.createElement('button');
      for (const [button, key] of [[edit, 'edit'], [verify, 'verify'], [cancel, 'cancel']]) { button.type = 'button'; button.dataset.credentialAction = key; button.textContent = t(`plugins.credentials.${key}`); }
      const feedback = document.createElement('p'); feedback.className = 'settings-note'; feedback.setAttribute('role', 'status');
      const error = document.createElement('p'); error.className = 'settings-note error plugin-credential-error'; error.setAttribute('role', 'alert');
      const buttons = document.createElement('div'); buttons.className = 'settings-actions';
      const save = document.createElement('button'), clear = document.createElement('button'), reload = document.createElement('button');
      for (const [button, key] of [[save, 'save'], [clear, 'clear'], [reload, 'reload']]) { button.type = 'button'; button.dataset.credentialAction = key; button.className = 'settings-button'; button.textContent = t(`plugins.credentials.${key}`); buttons.append(button); }
      for (const field of snapshot.declaration.fields) {
        const label = document.createElement('label'); label.className = 'settings-field';
        const title = document.createElement('span'); title.className = 'settings-field-label'; title.textContent = localize(field.label);
        const input = document.createElement(field.control === 'textarea' ? 'textarea' : 'input');
        if (field.control === 'input') input.type = 'password'; else input.rows = 4;
        input.className = 'credential-input'; input.autocomplete = 'off'; input.spellcheck = false;
        input.maxLength = 16384; input.dataset.credentialField = field.id;
        input.addEventListener('input', () => { dirty.add(field.id); error.textContent = ''; error.hidden = true; verify.disabled = true; cancel.hidden = false; });
        controls.set(field.id, input); label.append(title, input); form.append(label);
      }
      const note = document.createElement('p'); note.className = 'settings-note'; note.textContent = t('plugins.credentials.storage');
      buttons.append(cancel); form.append(buttons, note); summary.append(feedback, edit, verify, clear); wrapper.append(summary, form, error); container.append(wrapper);
      function paint() {
        const verification = snapshot.verification || 'unverified';
        feedback.textContent = t(!hasSaved() ? 'plugins.credentials.notConfigured' : verification === 'unverified'
          ? snapshot.configured ? 'plugins.credentials.configured' : 'plugins.credentials.partial'
          : `plugins.credentials.${verification}`);
        form.hidden = !editing;
        edit.hidden = editing; edit.disabled = pending;
        verify.hidden = !snapshot.configured || !snapshot.declaration.validation || verification === 'valid';
        verify.disabled = pending || dirty.size > 0 || verification === 'verifying';
        clear.hidden = !hasSaved(); cancel.hidden = !hasSaved() && dirty.size === 0; cancel.disabled = pending;
        for (const [id, input] of controls) input.placeholder = t(snapshot.fields[id] ? 'plugins.credentials.present' : 'plugins.credentials.empty');
        error.hidden = !error.textContent; reload.hidden = !conflict;
        save.disabled = pending; clear.disabled = pending; reload.disabled = pending;
        for (const input of controls.values()) input.disabled = pending;
        onStateChange({ editing, hasSaved: hasSaved(), configured: snapshot.configured, verification, pending, revision: snapshot.revision });
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
          manualEditing = false;
          if (clearAll) editing = true;
          else if (snapshot.configured && snapshot.declaration.validation) {
            snapshot = { ...snapshot, verification: 'verifying' }; paint();
            snapshot = await call('credentials.verify', { moduleId, expectedRevision: snapshot.revision });
            if (disposed) return;
            editing = snapshot.verification !== 'valid';
          }
        } catch (cause) {
          if (!disposed) {
            conflict = String(cause?.message || cause).includes('credentials-conflict');
            error.textContent = t(conflict ? 'plugins.credentials.conflict' : 'plugins.credentials.saveError');
          }
        } finally { pending = false; if (!disposed) paint(); }
      }
      edit.addEventListener('click', () => { editing = true; manualEditing = true; paint(); });
      cancel.addEventListener('click', async () => {
        if (pending || disposed) return;
        pending = true; generation++; paint();
        try {
          const next = await call('credentials.status', { moduleId });
          if (disposed) return;
          snapshot = next; dirty.clear(); conflict = false; error.textContent = '';
          for (const input of controls.values()) input.value = '';
          manualEditing = false; editing = !hasSaved();
        } catch { if (!disposed) error.textContent = t('plugins.credentials.saveError'); }
        finally { pending = false; if (!disposed) paint(); }
      });
      verify.addEventListener('click', async () => {
        if (pending || disposed || dirty.size) return;
        pending = true; generation++; paint();
        try {
          snapshot = { ...snapshot, verification: 'verifying' }; paint();
          snapshot = await call('credentials.verify', { moduleId, expectedRevision: snapshot.revision });
          if (!manualEditing && snapshot.verification === 'valid') editing = false;
        } catch { if (!disposed) error.textContent = t('plugins.credentials.saveError'); }
        finally { pending = false; if (!disposed) paint(); }
      });
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
          if (context?.visible === false || dirty.size || conflict || pending || disposed) return;
          const current = ++generation;
          try {
            const next = await call('credentials.status', { moduleId });
            if (current === generation && !disposed && !dirty.size && !conflict && !pending) { snapshot = next; if (!manualEditing && snapshot.verification === 'valid') editing = false; paint(); }
          } catch {
            if (current === generation && !disposed) { error.textContent = t('plugins.credentials.saveError'); paint(); }
          }
        },
        hasUnsavedChanges: () => dirty.size > 0 || pending,
        dispose() { disposed = true; wrapper.remove(); }
      };
    }
    return { mount };
  }
  return { create };
});
