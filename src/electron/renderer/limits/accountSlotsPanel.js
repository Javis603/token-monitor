'use strict';

(function expose(root, factory) {
  const menus = typeof module !== 'undefined' ? require('../actionMenu') : root.TokenMonitorActionMenu;
  const dragController = typeof module !== 'undefined' ? require('../rowDragController') : root.TokenMonitorRowDragController;
  const dragSort = typeof module !== 'undefined' ? require('../verticalDragSort') : root.TokenMonitorVerticalDragSort;
  const identity = typeof module !== 'undefined' ? require('../accountIdentity') : root.TokenMonitorAccountIdentity;
  const api = factory(menus, dragController, dragSort, identity);
  if (typeof module !== 'undefined') module.exports = api;
  if (root) root.TokenMonitorAccountSlotsPanel = api;
})(typeof window !== 'undefined' ? window : null, function accountSlotsPanelApi(menus, dragController, dragSort, accountIdentity) {
  function accountName(slot, reading, t = (_key, { fingerprint }) => `Account #${fingerprint}`, presentation = {}) {
    return slot.label || (slot.source === 'remote' ? presentation.labels?.[reading?.accountKey] : '') || reading?.accountName || reading?.accountEmail || reading?.email
      || t('settings.slots.account', { fingerprint: slot.fingerprint });
  }
  function accountStatus(slot, reading) {
    if (!slot.enabled) return 'paused';
    if (reading?.status === 'unauthorized') return 'invalid';
    if (reading?.stale) return 'stale';
    return reading?.status === 'ok' ? 'connected' : 'unavailable';
  }
  // Reorder each provider's positions: local owners first, then remote preferences.
  // Unknown remote keys retain aggregate order.
  // A reading that moved to its resolved key still lists the key it moved from,
  // so a cached slot list that predates the move keeps its owner.
  function slotOwner(slots, accountKey, readingAliases = []) {
    return slots.find(slot => slot.accountKey === accountKey)
      || slots.find(slot => slot.accountKeyAliases?.includes(accountKey))
      || slots.find(slot => readingAliases.includes(slot.accountKey) || slot.accountKeyAliases?.some(key => readingAliases.includes(key)));
  }
  function applyAccountOrder(records, slotsByProvider, localDeviceId = '', presentation = {}) {
    const result = records.map(row => {
      const slots = slotsByProvider[row.provider];
      if (!slots) return row;
      const owner = slotOwner(slots, row.accountKey, row.accountKeyAliases);
      const remote = !owner && row.sourceDeviceId && row.sourceDeviceId !== localDeviceId;
      // Only a name the user chose becomes the display name. Provider names and
      // emails stay in their own fields, so email masking still applies to them.
      const label = owner ? owner.label : remote ? presentation[row.provider]?.labels?.[row.accountKey] : '';
      return label ? { ...row, accountDisplayName: label } : row;
    });
    for (const [provider, slots] of Object.entries(slotsByProvider)) {
      const positions = result.flatMap((row, index) => row.provider === provider ? [index] : []);
      const rank = row => {
        const index = slots.indexOf(slotOwner(slots, row.accountKey, row.accountKeyAliases));
        if (index >= 0) return index;
        // A row without a source device is this device's (local mode), as in #1520.
        if (!row.sourceDeviceId || row.sourceDeviceId === localDeviceId) return slots.length;
        const remoteIndex = row.sourceDeviceId && row.sourceDeviceId !== localDeviceId
          ? (presentation[provider]?.order || []).indexOf(row.accountKey) : -1;
        return slots.length + 1 + (remoteIndex < 0 ? (presentation[provider]?.order || []).length : remoteIndex);
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
    const remoteList = make('div', 'slot-remote-list');
    const editor = make('div', 'slot-editor hidden');
    const message = make('div', 'settings-note slot-message');
    message.setAttribute('role', 'status');
    list.append(editor);
    root.append(list, message);
    let editorOwner;
    const rows = new Map();
    let slots = [];
    let readings = [];
    let remoteSlots = [];
    let remoteReadings = [];
    let presentation = {};
    let devices = [];
    let localDeviceId = '';
    const deviceLabels = typeof module !== 'undefined' ? require('../deviceBreakdown') : window.TokenMonitorDeviceBreakdown;
    let operationLane = Promise.resolve();
    let dragSavePending = false;
    let presentationPending = 0;
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
          if (result.presentation) presentation = result.presentation[form.id] || {};
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
      const remote = remoteSlots.find(slot => slot.id === args[0]);
      if (!remote) {
        // A keyboard/menu move during a live drag would race the drop's measured order.
        if (operation === 'move' && (dragSavePending || rowDrag.isDragging() || remoteDrag.isDragging())) return;
        operationsPending++;
        return enqueue(() => ipc[operation](form.id, ...args)).finally(() => { operationsPending--; });
      }
      if (operation === 'move' && (presentationPending > 0 || rowDrag.isDragging() || remoteDrag.isDragging())) return;
      presentationPending++;
      return enqueue(() => {
        if (operation === 'rename') return ipc.presentation(form.id, remote.accountKey, 'rename', args[1]);
        const order = remoteSlots.map(slot => slot.accountKey);
        const index = order.indexOf(remote.accountKey), target = index + (args[1] === 'up' ? -1 : 1);
        if (target >= 0 && target < order.length) [order[index], order[target]] = [order[target], order[index]];
        return ipc.presentation(form.id, remote.accountKey, 'order', order);
      }).finally(() => { presentationPending--; preserveScroll(render); });
    };
    const createDrag = remote => dragController.createRowDragController({
      dragSort,
      getList: () => remote ? remoteList : list,
      getScrollPanel: () => root.closest('.settings-panel'),
      rowSelector: '.slot-row[data-slot-draggable="true"]',
      idKey: 'slotId',
      dragStartSelector: '.slot-drag-handle',
      dragExcluded: 'input, select, textarea, a',
      preserveScroll,
      mirrorOrder: (order, id) => {
        const group = remote ? remoteAccounts() : slots;
        const previous = group.filter(slot => slot.id !== 'environment').map(slot => slot.id);
        // A push may add/remove an account while the measured rows are frozen.
        // Let the deferred render show that new list instead of saving a stale set.
        if (previous.length !== order.length || previous.some(key => !order.includes(key))) return { steps: 0 };
        const previousSlots = slots;
        const delta = order.indexOf(id) - previous.indexOf(id);
        const byId = new Map(group.map(slot => [slot.id, slot]));
        let index = 0;
        const next = group.map(slot => slot.id === 'environment' ? slot : byId.get(order[index++]));
        const previousOrder = presentation.order;
        // Lock before the controller defers persistence until after paint.
        if (remote) {
          remoteSlots = next;
          presentation = { ...presentation, order: next.map(slot => slot.accountKey) };
          presentationPending++;
        } else {
          slots = next;
          dragSavePending = true;
        }
        preserveScroll(render);
        return { steps: Math.abs(delta), direction: delta < 0 ? 'up' : 'down', previousSlots, previousOrder, locked: true,
          remoteOrder: remote ? next.map(slot => slot.accountKey) : undefined };
      },
      applyOrder: order => {
        for (const id of order) (remote ? remoteList : list).moveBefore(rows.get(id).el, remote ? null : add);
      },
      persistOrder: (_order, id, { steps, direction, previousSlots, previousOrder, remoteOrder, locked }) => {
        if (remote && !steps) {
          // A push can leave the dragged row already in place; release the lock
          // this drop took, but not one an invalidated drop never acquired.
          if (locked) { presentationPending--; preserveScroll(render); }
          return;
        }
        return void enqueue(async () => {
          if (remote) {
            try {
              const result = await ipc.presentation(form.id, rows.get(id).slot.accountKey, 'order', remoteOrder);
              if (result.ok === false) throw new Error('Account presentation save failed');
              return result;
            } catch (failure) {
              presentation = { ...presentation, order: previousOrder };
              preserveScroll(render);
              throw failure;
            }
          }
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
          if (remote) presentationPending--; else dragSavePending = false;
          preserveScroll(render);
        });
      },
      requestRender: () => preserveScroll(render)
    });
    const rowDrag = createDrag(false);
    const remoteDrag = createDrag(true);
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
          if (result.verdict === 'differentAccount') {
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
      const grip = make('span', 'preference-order-handle slot-drag-handle');
      grip.setAttribute('aria-hidden', 'true');
      const copy = make('div', 'slot-copy');
      const name = make('div', 'slot-name');
      const status = make('span', 'slot-status');
      const actions = make('div', 'slot-actions');
      copy.append(name);
      el.append(grip, copy, status, actions);
      el.addEventListener('pointerdown', event => {
        if ((item.slot.source === 'remote' ? presentationPending > 0 : dragSavePending || operationsPending > 0) || id === 'environment' || editorOwner !== undefined
          || [...rows.values()].some(row => row.editing || row.actions.querySelector('.plugin-menu').matches(':popover-open'))) return;
        (item.slot.source === 'remote' ? remoteDrag : rowDrag).startRowDrag(event, id);
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
        const replace = action(cookie ? 'replaceCookie' : 'replaceKey', () => openEditor(item.slot));
        if (id.startsWith('remote:')) {
          shared.appendItems(action('rename', rename), up, down);
          menu.append(localized(make('div', 'settings-note slot-remote-note'), 'settings.slots.remoteNote'));
        } else shared.appendItems(action('rename', rename), replace, pause, separator(), up, down, separator(), remove);
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
    root.insertBefore(remoteList, message);
    function remoteAccounts() {
      return applyAccountOrder(remoteReadings, { [form.id]: slots }, localDeviceId, { [form.id]: presentation })
        .filter(row => row.provider === form.id && row.accountKey && row.sourceDeviceId && row.sourceDeviceId !== localDeviceId && !slotOwner(slots, row.accountKey, row.accountKeyAliases))
        .map(row => ({ id: `remote:${row.accountKey}`, source: 'remote', accountKey: row.accountKey, label: presentation.labels?.[row.accountKey] || '', enabled: true, fingerprint: accountIdentity.accountStableFingerprint(row).slice(0, 12) }));
    }
    function render() {
      if (rowDrag.deferRender() || remoteDrag.deferRender()) return;
      remoteSlots = remoteAccounts();
      const active = [...slots, ...remoteSlots];
      for (const [id, item] of rows) if (!active.some(slot => slot.id === id)) { item.el.remove(); rows.delete(id); }
      active.forEach((slot, index) => {
        const item = rowFor(slot.id);
        item.slot = slot;
        item.el.dataset.slotDraggable = String(slot.id !== 'environment');
        const remote = slot.source === 'remote';
        const reading = remote ? remoteReadings.find(row => row.accountKey === slot.accountKey) : readings.find(row => slotOwner(slots, row.accountKey, row.accountKeyAliases) === slot);
        if (!item.editing) item.name.textContent = accountName(slot, reading, t);
        const status = accountStatus(slot, reading);
        item.el.classList.toggle('slot-paused', !slot.enabled);
        item.status.className = `slot-status slot-${status}`;
        item.status.textContent = `● ${tr(status === 'invalid' ? (cookie ? 'invalidCookie' : 'invalidKey') : status)}`;
        if (item.pause) {
          item.updateRemove();
          localized(item.pause, `settings.slots.${slot.enabled ? 'pause' : 'resume'}`);
          const pending = remote ? presentationPending > 0 : dragSavePending;
          item.up.disabled = pending || (remote ? remoteSlots.indexOf(slot) === 0 : index === 0);
          item.down.disabled = pending || (remote ? remoteSlots.indexOf(slot) === remoteSlots.length - 1 : index === slots.length - 1);
          item.actions.classList.toggle('hidden', slot.source === 'environment');
        }
        item.fix.classList.toggle('hidden', remote || slot.source === 'environment' || !slot.enabled || !['invalid', 'unavailable'].includes(status));
        if (slot.source === 'environment' && !item.environmentNote) {
          item.environmentNote = localized(make('div', 'settings-note'), 'settings.slots.environment');
          item.el.querySelector('.slot-copy').append(item.environmentNote);
        }
        if (item.environmentNote) item.environmentNote.classList.toggle('hidden', slot.source !== 'environment');
        if (remote) {
          if (!item.deviceNote) { item.deviceNote = make('div', 'settings-note'); item.el.querySelector('.slot-copy').append(item.deviceNote); }
          item.deviceNote.textContent = deviceLabels.deviceLabel(devices.find(device => device.deviceId === reading?.sourceDeviceId) || { deviceId: reading?.sourceDeviceId });
        }
        const parent = remote ? remoteList : list;
        const before = [...parent.children].filter(node => node !== editor)[remote ? remoteSlots.indexOf(slot) : index];
        if (before !== item.el) {
          if (item.el.isConnected) parent.moveBefore(item.el, before || null);
          else parent.insertBefore(item.el, before || null);
        }
        item.positionMenu();
      });
      placeEditor();
    }
    return { element: root, update(nextSlots, nextReadings, context = {}) {
      slots = nextSlots; readings = nextReadings;
      remoteReadings = context.records || []; devices = context.devices || []; localDeviceId = context.localDeviceId || ''; presentation = context.presentation || {};
      preserveScroll(render);
    }, openEditor };
  }
  return { accountName, accountStatus, slotOwner, applyAccountOrder, createPanel };
});
