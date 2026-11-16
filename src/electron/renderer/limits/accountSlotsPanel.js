'use strict';

(function expose(root, factory) {
  const menus = typeof module !== 'undefined' ? require('../actionMenu') : root.TokenMonitorActionMenu;
  const dragController = typeof module !== 'undefined' ? require('../rowDragController') : root.TokenMonitorRowDragController;
  const dragSort = typeof module !== 'undefined' ? require('../verticalDragSort') : root.TokenMonitorVerticalDragSort;
  const api = factory(menus, dragController, dragSort);
  if (typeof module !== 'undefined') module.exports = api;
  if (root) root.TokenMonitorAccountSlotsPanel = api;
})(typeof window !== 'undefined' ? window : null, function accountSlotsPanelApi(menus, dragController, dragSort) {
  function accountName(slot, reading, t) {
    return slot.label || reading?.accountName || reading?.accountEmail || reading?.email
      || slot.accountName || slot.accountEmail
      // The app's name is a proper noun; the phrase around it is localized.
      || (slot.sourceName ? t('settings.slots.discoveredName', { source: slot.sourceName }) : '')
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

  function createPanel({ form, label, loginAction, document, t, ipc, forms, preserveScroll, onChanged, openExternal, maskEmail = value => value }) {
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
    // Bearer and session tokens (Copilot, Devin, Manus) are not API keys.
    const credentialWord = cookie ? 'Cookie' : form.fields.some(field => /apikey/i.test(field.key)) ? 'Key'
      : form.fields.some(field => /token/i.test(field.key)) ? 'Token' : 'Key';
    const root = make('div', 'slot-panel');
    const list = make('div', 'slot-list');
    const editor = make('div', 'slot-editor hidden');
    const message = make('div', 'settings-note slot-message');
    message.setAttribute('role', 'status');
    list.append(editor);
    root.append(list, message);
    let cancelLogin;
    let editorOwner;
    const rows = new Map();
    let slots = [];
    let readings = [];
    let operationLane = Promise.resolve();
    let dragSavePending = false;
    // Account operations still awaiting IPC (moves, removals, pauses, saves): a
    // drag measured now would persist steps from an account list they are about
    // to change, so no drag starts until they settle.
    let operationsPending = 0;
    let editorPanel;
    let editorRevision = 0;
    const error = () => { message.textContent = tr('failed'); };
    const enqueue = operation => {
      const task = operationLane.then(async () => {
        try {
          const result = await operation();
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
    const run = (operation, ...args) => {
      // A keyboard/menu move during a live drag would race the drop's measured order.
      if (operation === 'move' && (dragSavePending || rowDrag.isDragging())) return;
      operationsPending++;
      return enqueue(() => ipc[operation](form.id, ...args)).finally(() => { operationsPending--; });
    };
    const rowDrag = dragController.createRowDragController({
      dragSort,
      getList: () => list,
      getScrollPanel: () => root.closest('.settings-panel'),
      rowSelector: '.slot-row[data-slot-draggable="true"]',
      idKey: 'slotId',
      dragStartSelector: '.slot-drag-handle',
      dragExcluded: 'input, select, textarea, a',
      preserveScroll,
      mirrorOrder: (order, id) => {
        const previous = slots.filter(slot => slot.id !== 'environment').map(slot => slot.id);
        // A push may add/remove an account while the measured rows are frozen.
        // Let the deferred render show that new list instead of saving a stale set.
        if (previous.length !== order.length || previous.some(key => !order.includes(key))) return { steps: 0 };
        const previousSlots = slots;
        const delta = order.indexOf(id) - previous.indexOf(id);
        const byId = new Map(slots.map(slot => [slot.id, slot]));
        let index = 0;
        slots = slots.map(slot => slot.id === 'environment' ? slot : byId.get(order[index++]));
        // Lock before the controller defers persistence until after paint.
        dragSavePending = true;
        preserveScroll(render);
        return { steps: Math.abs(delta), direction: delta < 0 ? 'up' : 'down', previousSlots };
      },
      applyOrder: order => {
        for (const id of order) list.moveBefore(rows.get(id).el, add);
      },
      persistOrder: (_order, id, { steps, direction, previousSlots }) => void enqueue(async () => {
        let result = { ok: true, accounts: slots };
        let confirmed = previousSlots || slots;
        try {
          for (let step = 0; step < steps; step++) {
            result = await ipc.move(form.id, id, direction);
            if (result.ok === false) throw new Error('Account move failed');
            confirmed = result.accounts;
          }
          return result;
        } catch (failure) {
          // Earlier steps may already be stored even if a later move fails.
          slots = confirmed;
          try {
            const current = await ipc.list(form.id);
            if (current.ok !== false) slots = current.accounts;
          } catch (_) { /* Keep the last confirmed order if reload also fails. */ }
          preserveScroll(render);
          onChanged(slots);
          throw failure;
        }
      }).finally(() => {
        dragSavePending = false;
        preserveScroll(render);
      }),
      requestRender: () => preserveScroll(render)
    });
    function closeEditor() {
      cancelLogin?.();
      cancelLogin = null;
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
        const remap = value => typeof value === 'string' ? (keys.get(value) || (value === form.credentialChoice?.key ? `${prefix}${value}` : value))
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
        if (!slot && form.loginAction && loginAction) {
          let flowId;
          let unsubscribe;
          const signIn = button(t(form.loginAction.labelKey), async () => {
            if (flowId) return;
            flowId = `${form.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const current = flowId;
            signIn.disabled = true;
            cancelLogin = () => {
              if (flowId) void loginAction.cancelSignIn({ flowId });
              flowId = null;
              unsubscribe?.();
            };
            unsubscribe = loginAction.onLoginStatus?.(status => {
              if (status.flowId !== flowId || revision !== editorRevision) return;
              verdict.textContent = status.phase === 'authorize'
                ? t(`settings.${form.id}.authorize`, { code: status.userCode || '' })
                : status.phase === 'error' ? status.error : t(`settings.${form.id}.polling`);
            });
            const values = Object.fromEntries(form.fields.filter(field => !field.secret).map(field => [field.key, editorPanel.querySelector(`#${prefix}${field.key}Input`)?.value || '']));
            try {
              const result = await loginAction.signIn({ flowId, values, label: name.value });
              if (flowId !== current || revision !== editorRevision) return;
              unsubscribe?.();
              flowId = null;
              cancelLogin = null;
              if (result.ok) { await run('list'); preserveScroll(closeEditor); }
              else verdict.textContent = result.error || tr('failed');
            } catch (_) { if (revision === editorRevision) verdict.textContent = tr('failed'); }
            finally { if (flowId === current) { unsubscribe?.(); flowId = null; cancelLogin = null; } signIn.disabled = false; }
          });
          const loginChoices = make('div', 'settings-actions');
          loginChoices.append(signIn);
          editor.insertBefore(loginChoices, editorPanel);
          editorPanel.querySelector(`#${prefix}OpenBrowser`).classList.add('hidden');
        }

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
      const grip = make('span', 'preference-order-handle slot-drag-handle');
      grip.setAttribute('aria-hidden', 'true');
      const copy = make('div', 'slot-copy');
      const name = make('div', 'slot-name');
      const status = make('span', 'slot-status');
      const actions = make('div', 'slot-actions');
      copy.append(name);
      el.append(grip, copy, status, actions);
      el.addEventListener('pointerdown', event => {
        if (dragSavePending || operationsPending > 0 || id === 'environment' || editorOwner !== undefined
          || [...rows.values()].some(row => row.editing || row.actions.querySelector('.plugin-menu').matches(':popover-open'))) return;
        rowDrag.startRowDrag(event, id);
      });
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
        const replace = action(`replace${credentialWord}`, () => openEditor(item.slot));
        shared.appendItems(action('rename', rename), replace, pause, separator(), up, down, separator(), remove);
        const fix = slotButton(`fix${credentialWord}`, () => openEditor(item.slot));
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
      if (rowDrag.deferRender()) return;
      const active = slots;
      for (const [id, item] of rows) if (!active.some(slot => slot.id === id)) { item.el.remove(); rows.delete(id); }
      active.forEach((slot, index) => {
        const item = rowFor(slot.id);
        item.slot = slot;
        item.el.dataset.slotDraggable = String(slot.id !== 'environment');
        const reading = readings.find(row => slotOwner(slots, row.accountKey, row.accountKeyAliases) === slot);
        if (!item.editing) item.name.textContent = accountName({ ...slot, accountEmail: maskEmail(slot.accountEmail || '') }, reading ? { ...reading, accountEmail: maskEmail(reading.accountEmail || ''), email: maskEmail(reading.email || '') } : reading, t);
        const status = accountStatus(slot, reading);
        item.el.classList.toggle('slot-paused', !slot.enabled);
        item.status.className = `slot-status slot-${status}`;
        item.status.textContent = `● ${tr(status === 'invalid' ? (cookie ? 'invalidCookie' : 'invalidKey') : status)}`;
        if (item.pause) {
          item.updateRemove();
          localized(item.pause, `settings.slots.${slot.enabled ? 'pause' : 'resume'}`);
          item.up.disabled = dragSavePending || index === 0;
          item.down.disabled = dragSavePending || index === active.length - 1;
          item.actions.classList.toggle('hidden', slot.source === 'environment');
          if (slot.source === 'discovered') { item.replace.remove(); item.remove.remove(); }
        }
        item.fix.classList.toggle('hidden', Boolean(slot.source) || !slot.enabled || !['invalid', 'unavailable'].includes(status));
        if (slot.source === 'environment' && !item.environmentNote) {
          item.environmentNote = localized(make('div', 'settings-note'), 'settings.slots.environment');
          item.el.querySelector('.slot-copy').append(item.environmentNote);
        }
        if (item.environmentNote) item.environmentNote.classList.toggle('hidden', slot.source !== 'environment');
        if (slot.source === 'discovered' && !item.discoveredNote) {
          item.discoveredNote = localized(make('div', 'settings-note'), 'settings.slots.discovered', { source: slot.sourceName });
          item.el.querySelector('.plugin-menu')?.append(item.discoveredNote);
        }
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
