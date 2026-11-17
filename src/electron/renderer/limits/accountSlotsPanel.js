'use strict';

(function expose(root, factory) {
  const menus = typeof module !== 'undefined' ? require('../actionMenu') : root.TokenMonitorActionMenu;
  const api = factory(menus);
  if (typeof module !== 'undefined') module.exports = api;
  if (root) root.TokenMonitorAccountSlotsPanel = api;
})(typeof window !== 'undefined' ? window : null, function accountSlotsPanelApi(menus) {
  function accountName(slot, reading, t) {
    return slot.label || reading?.accountName || reading?.accountEmail || reading?.email
      || t('settings.slots.account', { fingerprint: slot.fingerprint });
  }
  function accountStatus(slot, reading) {
    if (!slot.enabled) return 'paused';
    if (reading?.status === 'unauthorized') return 'invalid';
    if (reading?.stale) return 'stale';
    return reading?.status === 'ok' ? 'connected' : 'unavailable';
  }
  // Reorder only each provider's existing positions, leaving other providers and
  // remote accounts in their original relative order. Local defaults lead.
  // A reading that moved to its resolved key still lists the key it moved from,
  // so a cached slot list that predates the move keeps its owner.
  function slotOwner(slots, accountKey, readingAliases = []) {
    return slots.find(slot => slot.accountKey === accountKey)
      || slots.find(slot => slot.accountKeyAliases?.includes(accountKey))
      || slots.find(slot => readingAliases.includes(slot.accountKey));
  }
  function applyAccountOrder(records, slotsByProvider, _localDeviceId = '') {
    const result = [...records];
    for (const [provider, slots] of Object.entries(slotsByProvider)) {
      const positions = result.flatMap((row, index) => row.provider === provider ? [index] : []);
      const rank = row => {
        const index = slots.indexOf(slotOwner(slots, row.accountKey, row.accountKeyAliases));
        if (index >= 0) return index;
        return slots.length;
      };
      const ordered = positions.map(index => result[index]).sort((a, b) => rank(a) - rank(b));
      positions.forEach((position, index) => { result[position] = ordered[index]; });
    }
    return result;
  }

  function createPanel({ form, label, document, t, ipc, forms, preserveScroll, onChanged, openExternal }) {
    const make = (tag, className = '', text) => {
      const el = document.createElement(tag);
      el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const button = (text, action) => {
      const el = make('button', '', text);
      el.type = 'button';
      el.addEventListener('click', action);
      return el;
    };
    const tr = (key, params) => t(`settings.slots.${key}`, params);
    const localized = (node, key, params) => {
      node.dataset.i18n = key;
      if (params) node.dataset.i18nParams = JSON.stringify(params);
      node.textContent = t(key, params);
      return node;
    };
    const slotButton = (key, fn, params) => localized(button(tr(key, params), fn), `settings.slots.${key}`, params);
    const cookie = form.fields.some(field => /cookie/i.test(field.key));
    const root = make('div', 'slot-panel');
    const list = make('div', 'slot-list');
    const editor = make('div', 'slot-editor hidden');
    const message = make('div', 'settings-note slot-message');
    message.setAttribute('role', 'status');
    list.append(editor);
    root.append(list, message);
    let editorOwner;
    const rows = new Map();
    let slots = [];
    let readings = [];
    let operationLane = Promise.resolve();
    let editorPanel;
    let editorRevision = 0;
    const error = () => { message.textContent = tr('failed'); };
    const run = (operation, ...args) => {
      const task = operationLane.then(async () => {
        try {
          const result = await ipc[operation](form.id, ...args);
          if (result.ok === false) { error(); return result; }
          if (result.accounts) {
            slots = result.accounts;
            preserveScroll(render);
            onChanged(slots);
          }
          return result;
        } catch (_) { error(); }
      });
      operationLane = task.catch(() => {});
      return task;
    };
    function closeEditor() {
      editorRevision++;
      editorOwner = undefined;
      add?.classList.remove('hidden');
      editor.replaceChildren();
      editorPanel = null;
      editor.classList.add('hidden');
    }
    function openEditor(slot) {
      preserveScroll(() => {
        closeEditor();
        editor.classList.remove('hidden');
        editorOwner = slot?.id ?? null;
        placeEditor();
        const revision = editorRevision;
        const prefix = `${form.id}SlotDraft`;
        const keys = new Map(form.fields.map(field => [field.key, `${prefix}${field.key}`]));
        const remap = value => typeof value === 'string' ? (keys.get(value) || value)
          : Array.isArray(value) ? value.map(remap)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, val]) => [key, remap(val)])) : value;
        const draftForm = remap(form);
        draftForm.id = prefix;
        draftForm.fields.forEach(field => { field.submitWithCredential = true; });
        const title = localized(make('strong'), `settings.slots.${slot ? 'replaceTitle' : 'addTitle'}`, { provider: label });
        const name = make('input', 'credential-input');
        name.dataset.i18nPlaceholder = 'settings.slots.optionalName';
        name.dataset.i18nAriaLabel = 'settings.slots.optionalName';
        name.placeholder = tr('optionalName');
        name.setAttribute('aria-label', tr('optionalName'));
        const verdict = make('div', 'settings-note');
        verdict.setAttribute('role', 'status');
        const choices = make('div', 'settings-actions');
        const submit = async (values, clearInput, asNew = false) => {
          const original = Object.fromEntries([...keys].map(([key, mapped]) => [key, values[mapped]]));
          const result = await run(slot && !asNew ? 'replace' : 'add', ...(slot && !asNew ? [slot.id, original] : [original, name.value]));
          if (!result || revision !== editorRevision) return;
          choices.replaceChildren();
          if (result.verdict === 'duplicate') {
            verdict.textContent = tr('duplicate');
          } else if (result.verdict === 'differentAccount') {
            verdict.textContent = tr('differentAccount');
            // One add per confirmation: a second press would save the same account twice.
            let adding = false;
            const addDifferent = slotButton('addDifferent', () => {
              if (adding) return;
              adding = addDifferent.disabled = true;
              return submit(values, clearInput, true).finally(() => { adding = addDifferent.disabled = false; });
            });
            choices.append(addDifferent);
          } else if (result.saved) {
            clearInput();
            preserveScroll(closeEditor);
            message.textContent = result.verdict === 'valid' ? '' : t('settings.common.credentialSavedUnconfirmed', { provider: label });
          } else {
            const key = result.status === 'required' ? 'credentialRequired' : result.status === 'invalidFormat' ? 'credentialInvalidFormat' : 'credentialRejected';
            verdict.textContent = result.ok === false ? tr('failed') : t(`settings.common.${key}`, { provider: label });
          }
        };
        editorPanel = forms.createCredentialPanel(draftForm, {
          document, translate: t, onToggle() {}, onClear() {}, onRefresh() {},
          onOpen: () => openExternal(forms.resolveOpenUrl(draftForm, { document })),
          onSave: (_form, values, clearInput) => submit(values, clearInput)
        });
        editor.append(title, ...(!slot ? [name] : []), editorPanel, verdict, choices);
        editorPanel.querySelector('.credential-manual-panel').querySelector('.settings-actions').append(slotButton('cancel', () => preserveScroll(closeEditor)));
        for (const field of form.fields.filter(field => !field.secret)) {
          const input = editorPanel.querySelector(`#${prefix}${field.key}Input`);
          if (input && slot?.formValues && Object.hasOwn(slot.formValues, field.key)) input.value = slot.formValues[field.key];
        }
        forms.refreshFieldDependents?.(draftForm, { document });
        editorPanel.querySelector(`#${prefix}CredentialSubmit`).classList.add('slot-save');
        editorPanel.querySelector(`#${prefix}CredentialSubmit`).classList.add('slot-save');
        editorPanel.querySelector('.settings-group-header').classList.add('hidden');
        editorPanel.querySelector('.cursor-settings-details').classList.remove('hidden');
        editorPanel.querySelector(`#${prefix}LogoutButton`).classList.add('hidden');
        editorPanel.querySelector(`#${prefix}RefreshButton`).classList.add('hidden');
      });
    }
    function rowFor(id) {
      if (rows.has(id)) return rows.get(id);
      const el = make('div', 'slot-row');
      el.tabIndex = 0;
      el.dataset.slotId = id;
      const copy = make('div', 'slot-copy');
      const name = make('div', 'slot-name');
      const status = make('span', 'slot-status');
      const actions = make('div', 'slot-actions');
      copy.append(name);
      el.append(copy, status, actions);
      // Each row owns its rename session, so one row cannot invalidate another's.
      const item = { el, name, status, actions, editing: false, renameRevision: 0, slot: null };
      const rename = () => {
        if (item.editing) return;
        item.editing = true;
        const revision = ++item.renameRevision;
        const input = make('input', 'slot-rename');
        input.value = item.slot.label || '';
        input.setAttribute('aria-label', tr('rename'));
        name.replaceChildren(input);
        input.addEventListener('keydown', async event => {
          // Enter that confirms an IME composition is not a submit.
          if (event.isComposing || event.keyCode === 229) return;
          if (event.key !== 'Enter' && event.key !== 'Escape') return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Enter') {
            const result = await run('rename', id, input.value);
            if (!result?.ok || revision !== item.renameRevision) return;
          }
          const restoreFocus = document.activeElement === input;
          item.renameRevision++;
          item.editing = false;
          preserveScroll(render);
          if (restoreFocus) el.focus({ preventScroll: true });
        });
        input.focus({ preventScroll: true });
        input.select();
      };
      {
        const shared = menus.create(document, tr('actions'), (text, fn, className) => {
          const node = button(text, fn); node.className = className || ''; return node;
        });
        const { popover: menu, trigger: more, close: closeMenu } = shared;
        item.positionMenu = shared.position;
        more.dataset.i18nAriaLabel = 'settings.slots.actions';
        const action = (key, fn) => slotButton(key, () => { closeMenu(); return fn(); });
        const up = action('up', () => run('move', id, 'up'));
        const down = action('down', () => run('move', id, 'down'));
        const pause = action('pause', () => run('setEnabled', id, !item.slot.enabled));
        let confirmingRemove = false;
        const updateRemove = () => {
          localized(remove, `settings.slots.${confirmingRemove ? 'confirmRemove' : 'remove'}`);
          remove.dataset.i18nAriaLabel = remove.dataset.i18n;
          remove.setAttribute('aria-label', remove.textContent);
          remove.classList.toggle('confirming', confirmingRemove);
        };
        const remove = slotButton('remove', () => {
          if (!confirmingRemove) {
            confirmingRemove = true;
            updateRemove();
            remove.focus({ preventScroll: true });
            return;
          }
          closeMenu();
          return run('remove', id);
        });
        menu.addEventListener('beforetoggle', event => {
          if (event.newState === 'closed') { confirmingRemove = false; updateRemove(); }
        });
        item.updateRemove = updateRemove;
        remove.className = 'menu-destructive';
        const separator = () => { const node = make('hr', 'action-menu-separator'); node.setAttribute('role', 'separator'); return node; };
        const replace = action(cookie ? 'replaceCookie' : 'replaceKey', () => openEditor(item.slot));
        shared.appendItems(action('rename', rename), replace, pause, separator(), up, down, separator(), remove);
        const fix = slotButton(cookie ? 'fixCookie' : 'fixKey', () => openEditor(item.slot));
        fix.className = 'slot-fix plugin-inline-action';
        copy.append(fix);
        item.fix = fix;
        actions.append(shared.element);
        Object.assign(item, { up, down, pause, fix, replace, remove });
        el.addEventListener('keydown', event => {
          if (event.key === 'Escape' && menu.matches(':popover-open')) { closeMenu(); more.focus(); }
          if (item.slot.source !== 'environment' && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            void run('move', id, event.key === 'ArrowUp' ? 'up' : 'down');
          }
        });
      }
      rows.set(id, item);
      return item;
    }
    function placeEditor() {
      if (editorOwner === undefined) return;
      const owner = rows.get(editorOwner);
      const before = owner ? list.children[[...list.children].indexOf(owner.el) + 1] : add;
      if (before !== editor) list.moveBefore(editor, before || null);
      add.classList.toggle('hidden', editorOwner === null);
    }
    const add = slotButton('add', () => openEditor(null), { provider: label });
    add.className = 'slot-add';
    list.append(add);
    function render() {
      const active = slots;
      for (const [id, item] of rows) if (!active.some(slot => slot.id === id)) { item.el.remove(); rows.delete(id); }
      active.forEach((slot, index) => {
        const item = rowFor(slot.id);
        item.slot = slot;
        const reading = readings.find(row => slotOwner(slots, row.accountKey, row.accountKeyAliases) === slot);
        if (!item.editing) item.name.textContent = accountName(slot, reading, t);
        const status = accountStatus(slot, reading);
        item.el.classList.toggle('slot-paused', !slot.enabled);
        item.status.className = `slot-status slot-${status}`;
        item.status.textContent = `● ${tr(status === 'invalid' ? (cookie ? 'invalidCookie' : 'invalidKey') : status)}`;
        if (item.pause) {
          item.updateRemove();
          localized(item.pause, `settings.slots.${slot.enabled ? 'pause' : 'resume'}`);
          item.up.disabled = index === 0;
          item.down.disabled = index === active.length - 1;
          item.actions.classList.toggle('hidden', slot.source === 'environment');
        }
        item.fix.classList.toggle('hidden', slot.source === 'environment' || !slot.enabled || !['invalid', 'unavailable'].includes(status));
        if (slot.source === 'environment' && !item.environmentNote) {
          item.environmentNote = localized(make('div', 'settings-note'), 'settings.slots.environment');
          item.el.querySelector('.slot-copy').append(item.environmentNote);
        }
        if (item.environmentNote) item.environmentNote.classList.toggle('hidden', slot.source !== 'environment');
        const before = [...list.children].filter(node => node !== editor)[index];
        if (before !== item.el) {
          if (item.el.isConnected) list.moveBefore(item.el, before || null);
          else list.insertBefore(item.el, before || null);
        }
        item.positionMenu();
      });
      placeEditor();
    }
    return { element: root, update(nextSlots, nextReadings) {
      slots = nextSlots; readings = nextReadings;
      preserveScroll(render);
    }, openEditor };
  }
  return { accountName, accountStatus, slotOwner, applyAccountOrder, createPanel };
});
