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
  // One precedence rule for local panels, remote panels and reading overlays.
  // An explicit blank overrides an old credential-slot label after a clear.
  function presentationLabel(slot, accountKey, presentation = {}) {
    return Object.hasOwn(presentation.labels || {}, accountKey) ? presentation.labels[accountKey] : slot?.label || '';
  }
  function accountName(slot, reading, t = (_key, { fingerprint }) => `Account #${fingerprint}`, presentation = {}) {
    return presentationLabel(slot, slot.accountKey || reading?.accountKey, presentation) || reading?.accountEmail || reading?.email || slot.accountEmail
      || reading?.accountName || slot.accountName
      // The app's name is a proper noun; the phrase around it is localized.
      || (slot.sourceName ? t('settings.slots.discoveredName', { source: slot.sourceName }) : '')
      || t('settings.slots.account', { fingerprint: slot.fingerprint });
  }
  function accountStatus(slot, reading) {
    if (!slot.enabled) return 'paused';
    if (reading?.status === 'disabled') return 'disabled';
    if (reading?.status === 'unauthorized') return 'invalid';
    if (reading?.stale) return 'stale';
    return reading?.status === 'ok' ? 'connected' : 'unavailable';
  }
  // Shared keys lead regardless of ownership; unknown local slots then remote
  // readings retain their stored/aggregate order.
  // A reading that moved to its resolved key still lists the key it moved from,
  // so a cached slot list that predates the move keeps its owner.
  function slotOwner(slots, accountKey, readingAliases = []) {
    return slots.find(slot => slot.accountKey === accountKey)
      || slots.find(slot => slot.accountKeyAliases?.includes(accountKey))
      || slots.find(slot => readingAliases.includes(slot.accountKey) || slot.accountKeyAliases?.some(key => readingAliases.includes(key)));
  }
  function applyAccountOrder(records, slotsByProvider, localDeviceId = '', presentation = {}) {
    const result = records.map(row => {
      const slots = slotsByProvider[row.provider] || [];
      const owner = slotOwner(slots, row.accountKey, row.accountKeyAliases);
      // Only a name the user chose becomes the display name. Provider names and
      // emails stay in their own fields, so email masking still applies to them.
      const key = owner?.accountKey || row.accountKey;
      const group = presentation[row.provider];
      const label = presentationLabel(owner, key, group);
      if (label) return { ...row, accountDisplayName: label };
      if (Object.hasOwn(group?.labels || {}, key)) {
        const { accountDisplayName: _previous, ...cleared } = row;
        return cleared;
      }
      return row;
    });
    for (const provider of new Set([...Object.keys(slotsByProvider), ...Object.keys(presentation)])) {
      const slots = slotsByProvider[provider] || [];
      const positions = result.flatMap((row, index) => row.provider === provider ? [index] : []);
      const order = presentation[provider]?.order || [];
      const rank = row => {
        const owner = slotOwner(slots, row.accountKey, row.accountKeyAliases);
        const keys = [owner?.accountKey, ...(owner?.accountKeyAliases || []), row.accountKey, ...(row.accountKeyAliases || [])];
        const canonicalIndex = order.indexOf(owner?.accountKey || row.accountKey);
        const sharedIndex = canonicalIndex >= 0 ? canonicalIndex : order.findIndex(key => keys.includes(key));
        if (sharedIndex >= 0) return sharedIndex;
        if (owner) return order.length + slots.indexOf(owner);
        return order.length + slots.length + (!row.sourceDeviceId || row.sourceDeviceId === localDeviceId ? 0 : 1);
      };
      const ordered = positions.map(index => result[index]).sort((a, b) => rank(a) - rank(b));
      positions.forEach((position, index) => { result[position] = ordered[index]; });
    }
    return result;
  }

  function createPanel({ form, label, loginAction, document, t, ipc, forms, preserveScroll, onChanged, openExternal, maskEmail = value => value, customEditor, onAdd, capabilities = () => ({}), isBusy = () => false, extraActions = () => [], statusReading = (_slot, reading) => reading, secondaryText = () => '', detailText = () => '', hideAdd = false }) {
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
    const editorReveal = make('div', 'accordion-animated-container hidden slot-editor-reveal');
    editorReveal.inert = true;
    const editorInner = make('div', 'accordion-animation-inner');
    const editor = make('div', 'slot-editor');
    editorInner.append(editor); editorReveal.append(editorInner);
    const message = make('div', 'settings-note slot-message');
    message.setAttribute('role', 'status');
    list.append(editorReveal);
    root.append(list, message);
    let cancelLogin;
    let editorOwner;
    const rows = new Map();
    let slots = [];
    let readings = [];
    let remoteReadings = [];
    let presentation = {};
    let devices = [];
    let localDeviceId = '';
    let settings;
    const deviceIcons = typeof module !== 'undefined' ? require('../deviceIcons') : window.TokenMonitorDeviceIcons;
    const deviceLabels = typeof module !== 'undefined' ? require('../deviceBreakdown') : window.TokenMonitorDeviceBreakdown;
    let operationLane = Promise.resolve();
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
    function activeAccounts() {
      const accounts = [...slots, ...remoteAccounts()];
      const byId = new Map(accounts.map(slot => [slot.id, slot]));
      return applyAccountOrder(accounts.map(slot => ({ ...slot, provider: form.id })),
        { [form.id]: slots }, localDeviceId, { [form.id]: presentation }).map(row => byId.get(row.id));
    }
    const run = (operation, ...args) => {
      const slot = activeAccounts().find(slot => slot.id === args[0]);
      const permission = capabilities(slot);
      if (isBusy() || (slot && permission[operation] === false)) return Promise.resolve({ ok: false });
      if (operation === 'move') {
        if (presentationPending || (operationsPending > 0 && remoteAccounts().some(slot => slot.id === args[0])) || rowDrag.isDragging()) return;
        presentationPending++;
        return enqueue(() => {
          const accounts = activeAccounts().filter(account => account.accountKey);
          const index = accounts.findIndex(slot => slot.id === args[0]);
          const target = index + (args[1] === 'up' ? -1 : 1);
          if (index < 0 || target < 0 || target >= accounts.length) return { ok: true };
          const key = accounts[index].accountKey;
          [accounts[index], accounts[target]] = [accounts[target], accounts[index]];
          return ipc.presentation(form.id, key, 'order', [...new Set(accounts.map(slot => slot.accountKey))]);
        }).finally(() => { presentationPending--; preserveScroll(render); });
      }
      const remote = remoteAccounts().find(slot => slot.id === args[0])
        || (operation === 'rename' && slots.find(slot => slot.id === args[0] && slot.source === 'environment'));
      operationsPending++;
      return enqueue(() => remote
        ? ipc.presentation(form.id, remote.accountKey, 'rename', args[1])
        : ipc[operation](form.id, ...args)).finally(() => { operationsPending--; });
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
        const group = activeAccounts().filter(account => account.accountKey);
        const previous = group.map(slot => slot.id);
        if (previous.length !== order.length || previous.some(key => !order.includes(key))) return { changed: false };
        const previousOrder = presentation.order;
        const next = [...new Set(order.map(id => group.find(slot => slot.id === id).accountKey))];
        const changed = order.some((key, index) => key !== previous[index]);
        if (!changed) return { changed: false };
        presentation = { ...presentation, order: next };
        presentationPending++;
        preserveScroll(render);
        return { changed, previousOrder, next, key: group.find(slot => slot.id === id).accountKey };
      },
      applyOrder: order => {
        for (const id of order) list.moveBefore(rows.get(id).el, add);
      },
      persistOrder: (_order, _id, { changed, previousOrder, next, key }) => {
        if (!changed) return;
        return void enqueue(async () => {
          try {
            const result = await ipc.presentation(form.id, key, 'order', next);
            if (result.ok === false) throw new Error('Account presentation save failed');
            return result;
          } catch (failure) {
            presentation = { ...presentation, order: previousOrder };
            preserveScroll(render);
            throw failure;
          }
        }).finally(() => { presentationPending--; preserveScroll(render); });
      },
      requestRender: () => preserveScroll(render)
    });
    function closeEditor(immediate = false) {
      cancelLogin?.();
      cancelLogin = null;
      editorRevision++;
      editorOwner = undefined;
      add?.classList.remove('hidden');
      const revision = editorRevision;
      const clear = () => { if (revision === editorRevision) editor.replaceChildren(); };
      const motion = document.defaultView?.matchMedia;
      if (!immediate && motion && !motion.call(document.defaultView, '(prefers-reduced-motion: reduce)').matches) setTimeout(clear, 250);
      else clear();
      editorPanel = null;
      editorReveal.classList.add('hidden'); editorReveal.inert = true;
    }
    function openEditor(slot) {
      if (customEditor) return customEditor(slot);
      preserveScroll(() => {
        closeEditor(true);
        editorReveal.classList.remove('hidden'); editorReveal.inert = false;
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
              if (result.ok) {
                await run('list');
                if (revision === editorRevision) preserveScroll(closeEditor);
              }
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
      const nameLine = make('div', 'slot-name-line');
      nameLine.append(name);
      copy.append(nameLine);
      el.append(grip, copy, status, actions);
      el.addEventListener('pointerdown', event => {
        if ((presentationPending > 0 || operationsPending > 0) || editorOwner !== undefined
          || isBusy() || capabilities(item.slot).move === false || [...rows.values()].some(row => row.editing || row.actions.querySelector('.plugin-menu').matches(':popover-open'))) return;
        rowDrag.startRowDrag(event, id);
      });
      // Each row owns its rename session, so one row cannot invalidate another's.
      const item = { el, name, status, actions, editing: false, renameRevision: 0, slot: null };
      const rename = () => {
        if (item.editing || isBusy() || capabilities(item.slot).rename === false) return;
        item.editing = true;
        const revision = ++item.renameRevision;
        const input = make('input', 'slot-rename');
        const initialValue = presentationLabel(item.slot, item.slot.accountKey, presentation);
        input.value = initialValue;
        input.placeholder = name.textContent;
        input.setAttribute('aria-label', tr('rename'));
        name.replaceChildren(input);
        nameLine.classList.add('is-editing');
        item.renameButton.classList.add('hidden');
        let saving = false;
        let composing = false;
        const current = () => item.editing && revision === item.renameRevision;
        const finish = () => {
          if (!current()) return;
          const restoreFocus = document.activeElement === input;
          // Invalidate before removing the input: its resulting blur must not save.
          item.renameRevision++;
          item.editing = false;
          preserveScroll(render);
          if (restoreFocus) item.renameButton.focus({ preventScroll: true });
        };
        const save = async () => {
          if (!current() || saving || composing) return;
          if (input.value === initialValue) { finish(); return; }
          saving = true;
          input.readOnly = true;
          const result = await run('rename', id, input.value);
          if (!current()) return;
          saving = false;
          input.readOnly = false;
          if (!result?.ok) {
            input.setAttribute('aria-invalid', 'true');
            return;
          }
          finish();
        };
        input.addEventListener('compositionstart', () => { composing = true; });
        input.addEventListener('compositionend', () => {
          composing = false;
          if (document.activeElement !== input) return save();
        });
        input.addEventListener('blur', save);
        input.addEventListener('keydown', event => {
          // Enter that confirms an IME composition is not a submit.
          if (event.isComposing || event.keyCode === 229) return;
          if (event.key !== 'Enter' && event.key !== 'Escape') return;
          event.preventDefault(); event.stopPropagation();
          return event.key === 'Enter' ? save() : finish();
        });
        input.focus({ preventScroll: true });
        input.select();
      };
      const renameButton = button('', rename);
      renameButton.className = 'slot-rename-button';
      renameButton.dataset.i18nAriaLabel = 'settings.slots.rename';
      renameButton.setAttribute('aria-label', tr('rename'));
      nameLine.append(renameButton);
      item.renameButton = renameButton;
      {
        const shared = menus.create(document, tr('actions'), (text, fn, className) => {
          const node = button(text, fn); node.className = className || ''; return node;
        });
        const { popover: menu, trigger: more, close: closeMenu } = shared;
        item.positionMenu = shared.position;
        item.menuTrigger = more;
        more.dataset.i18nAriaLabel = 'settings.slots.actions';
        const action = (key, fn) => {
          const node = slotButton(key, () => { closeMenu(); return fn(); });
          node.dataset.slotAction = key;
          if (key === 'rename') item.renameAction = node;
          return node;
        };
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
        remove.dataset.slotAction = 'remove';
        const separator = () => { const node = make('hr', 'action-menu-separator'); node.setAttribute('role', 'separator'); return node; };
        const replace = action(`replace${credentialWord}`, () => openEditor(item.slot));
        const additionalActions = extraActions(() => item.slot);
        item.hasExtraActions = additionalActions.length > 0;
        for (const entry of additionalActions) {
          shared.appendItems(button(entry.label, () => { closeMenu(); return entry.run(item.slot); }));
        }
        if (id.startsWith('remote:')) {
          shared.appendItems(action('rename', rename), up, down);
          menu.append(localized(make('div', 'settings-note slot-remote-note'), 'settings.slots.remoteNote'));
        } else shared.appendItems(action('rename', rename), replace, pause, separator(), up, down, separator(), remove);
        item.menu = menu;
        const fix = slotButton(`fix${credentialWord}`, () => openEditor(item.slot));
        fix.className = 'slot-fix plugin-inline-action';
        copy.append(fix);
        item.fix = fix;
        actions.append(shared.element);
        Object.assign(item, { up, down, pause, fix, replace, remove });
        el.addEventListener('keydown', event => {
          if (event.key === 'Escape' && menu.matches(':popover-open')) { closeMenu(); more.focus(); }
          if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
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
      if (before !== editorReveal) list.moveBefore(editorReveal, before || null);
      add.classList.toggle('hidden', editorOwner === null);
    }
    const add = slotButton('add', () => {
      if (isBusy()) return;
      if (!onAdd) return openEditor(null);
      try { return Promise.resolve(onAdd()).catch(error); } catch (_) { error(); }
    }, { provider: label });
    add.className = 'slot-add';
    add.classList.toggle('hidden', hideAdd);
    list.append(add);
    function remoteAccounts() {
      return applyAccountOrder(remoteReadings, { [form.id]: slots }, localDeviceId, { [form.id]: presentation })
        .filter(row => row.provider === form.id && row.accountKey && row.sourceDeviceId && row.sourceDeviceId !== localDeviceId && !slotOwner(slots, row.accountKey, row.accountKeyAliases))
        .map(row => ({ id: `remote:${row.sourceDeviceId}:${row.accountKey}`, source: 'remote', sourceDeviceId: row.sourceDeviceId, accountKey: row.accountKey, accountKeyAliases: row.accountKeyAliases, label: presentation.labels?.[row.accountKey] || '', enabled: true, fingerprint: accountIdentity.accountStableFingerprint(row).slice(0, 12) }));
    }
    function render() {
      if (rowDrag.deferRender()) return;
      const active = activeAccounts();
      add.disabled = Boolean(isBusy());
      for (const [id, item] of rows) if (!active.some(slot => slot.id === id)) { item.el.remove(); rows.delete(id); }
      active.forEach((slot, index) => {
        const item = rowFor(slot.id);
        item.slot = slot;
        item.el.dataset.slotDraggable = 'true';
        const remote = slot.source === 'remote';
        const reading = remote ? remoteReadings.find(row => row.sourceDeviceId === slot.sourceDeviceId && row.accountKey === slot.accountKey)
          : readings.find(row => row.accountKey === slot.accountKey) || readings.find(row => slotOwner(slots, row.accountKey, row.accountKeyAliases) === slot);
        if (!item.editing) item.name.textContent = accountName({ ...slot, accountEmail: maskEmail(slot.accountEmail || '') }, reading ? { ...reading, accountEmail: maskEmail(reading.accountEmail || ''), email: maskEmail(reading.email || '') } : reading, t, presentation);
        const provenance = secondaryText(slot) || slot.sourceName || (slot.source === 'environment' ? t('settings.limits.sources.env') : !slot.source && !customEditor ? tr('savedSource') : '');
        const detail = [provenance, detailText(slot)].filter((value, index, all) => value && all.indexOf(value) === index).join(' · ');
        if (detail && !item.detail) {
          item.detail = make('div', 'settings-note slot-detail');
          item.el.querySelector('.slot-copy').append(item.detail);
        }
        if (item.detail) {
          item.detail.textContent = detail;
          item.detail.classList.toggle('hidden', !detail);
        }
        const permission = capabilities(slot);
        item.menuTrigger.classList.toggle('hidden', !item.hasExtraActions
          && ['rename', 'move', 'replace', 'setEnabled', 'remove'].every(operation => permission[operation] === false));
        item.renameButton.disabled = isBusy();
        item.renameAction?.classList.toggle('hidden', permission.rename === false);
        item.renameButton.classList.toggle('hidden', item.editing || permission.rename === false);
        item.name.parentElement.classList.toggle('is-editing', item.editing);
        const status = accountStatus(slot, statusReading(slot, reading));
        item.el.classList.toggle('slot-paused', !slot.enabled);
        item.status.className = `slot-status slot-${status}`;
        item.status.textContent = `● ${status === 'disabled' ? t('settings.limits.status.disabled') : tr(status === 'invalid' ? (cookie ? 'invalidCookie' : 'invalidKey') : status)}`;
        if (item.pause) {
          item.updateRemove();
          item.pause.dataset.slotAction = slot.enabled ? 'pause' : 'resume';
          localized(item.pause, `settings.slots.${item.pause.dataset.slotAction}`);
          const pending = presentationPending > 0 || isBusy();
          item.pause.disabled = pending; item.replace.disabled = pending; item.remove.disabled = pending;
          item.up.disabled = pending || index === 0;
          item.down.disabled = pending || index === active.length - 1;
          item.replace.classList.toggle('hidden', slot.source === 'environment');
          item.pause.classList.toggle('hidden', slot.source === 'environment');
          item.remove.classList.toggle('hidden', slot.source === 'environment');
          if (slot.source === 'discovered') { item.replace.remove(); item.remove.remove(); }
        }
        item.fix.classList.toggle('hidden', permission.replace === false || Boolean(slot.source) || !slot.enabled || !['invalid', 'unavailable'].includes(status));
        if (slot.source === 'environment' && !item.environmentNote) {
          item.environmentNote = localized(make('div', 'settings-note'), 'settings.slots.environment');
          item.el.querySelector('.slot-copy').append(item.environmentNote);
        }
        if (item.environmentNote) item.environmentNote.classList.toggle('hidden', slot.source !== 'environment');
        if (slot.source === 'discovered' && !item.discoveredNote) {
          item.discoveredNote = localized(make('div', 'settings-note'), 'settings.slots.discovered', { source: slot.sourceName });
          item.el.querySelector('.plugin-menu')?.append(item.discoveredNote);
        }
        if (remote) {
          if (!item.deviceNote) { item.deviceNote = make('div', 'row-device'); item.el.querySelector('.slot-copy').append(item.deviceNote); }
          const device = devices.find(device => device.deviceId === reading?.sourceDeviceId) || { deviceId: reading?.sourceDeviceId };
          item.deviceNote.replaceChildren(deviceIcons.deviceIconNode(document, deviceIcons.deviceIconKind(settings, device)),
            document.createTextNode(deviceLabels.deviceLabel(device)));
        }
        const parent = list;
        const before = [...parent.children].filter(node => node !== editorReveal)[index];
        if (before !== item.el) {
          if (item.el.isConnected) parent.moveBefore(item.el, before || null);
          else parent.insertBefore(item.el, before || null);
        }
        for (const [node, operation] of [[item.up, 'move'], [item.down, 'move'], [item.pause, 'setEnabled'], [item.replace, 'replace'], [item.remove, 'remove']]) {
          node?.classList.toggle('hidden', permission[operation] === false || (['replace', 'setEnabled', 'remove'].includes(operation) && ['remote', 'environment'].includes(slot.source)));
          if (node && isBusy()) node.disabled = true;
        }
        // Separators delimit visible groups, including read-only automatic rows.
        if (item.menu) {
          let groupHasItem = false;
          let pendingSeparator;
          for (const child of item.menu.children) {
            if (child.classList.contains('action-menu-separator')) {
              child.classList.add('hidden');
              if (groupHasItem) pendingSeparator = child;
            } else if (!child.classList.contains('hidden')) {
              if (pendingSeparator) { pendingSeparator.classList.remove('hidden'); pendingSeparator = null; }
              groupHasItem = true;
            }
          }
        }
        item.el.dataset.slotDraggable = String(permission.move !== false && !isBusy());
        item.positionMenu();
      });
      placeEditor();
    }
    return { element: root, update(nextSlots, nextReadings, context = {}) {
      slots = nextSlots; readings = nextReadings; settings = context.settings;
      remoteReadings = context.records || []; devices = context.devices || []; localDeviceId = context.localDeviceId || ''; presentation = context.presentation || {};
      preserveScroll(render);
    }, openEditor };
  }
  return { presentationLabel, accountName, accountStatus, slotOwner, applyAccountOrder, createPanel };
});
