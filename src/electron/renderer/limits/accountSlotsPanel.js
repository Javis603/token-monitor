'use strict';

(function expose(root, factory) {
  const menus = typeof module !== 'undefined' ? require('../actionMenu') : root.TokenMonitorActionMenu;
  const dragController = typeof module !== 'undefined' ? require('../rowDragController') : root.TokenMonitorRowDragController;
  const dragSort = typeof module !== 'undefined' ? require('../verticalDragSort') : root.TokenMonitorVerticalDragSort;
  const identity = typeof module !== 'undefined' ? require('../accountIdentity') : root.TokenMonitorAccountIdentity;
  const presentationApi = typeof module !== 'undefined' ? require('./providerPresentation') : root.TokenMonitorLimitProviderPresentation;
  const windowLabels = typeof module !== 'undefined' ? require('../../../shared/limits/windowLabels') : root.TokenMonitorLimitWindowLabels;
  const scope = typeof module !== 'undefined' ? require('../../../shared/limits/accountScope') : root.TokenMonitorLimitAccountScope;
  const connection = typeof module !== 'undefined' ? require('./connectionPresentation') : root.TokenMonitorConnectionPresentation;
  const api = factory(menus, dragController, dragSort, identity, presentationApi, windowLabels, scope, connection);
  if (typeof module !== 'undefined') module.exports = api;
  if (root) root.TokenMonitorAccountSlotsPanel = api;
})(typeof window !== 'undefined' ? window : null, function accountSlotsPanelApi(menus, dragController, dragSort, accountIdentity, presentationApi, windowLabels, scope, connection) {
  // One precedence rule for local panels, remote panels and reading overlays.
  // An explicit blank overrides an old credential-slot label after a clear.
  function presentationLabel(slot, accountKey, presentation = {}) {
    return Object.hasOwn(presentation.labels || {}, accountKey) ? presentation.labels[accountKey] : slot?.label || '';
  }
  function selectionKey(provider, slot, key = slot?.accountKey) {
    return scope.accountSelectionKey(provider, key, provider === 'alibaba' && slot ? alibabaVariant(slot) : '');
  }
  function accountName(slot, reading, t = (_key, { fingerprint } = {}) => `Account #${fingerprint}`, presentation = {}) {
    return presentationLabel(slot, slot.presentationKey || slot.accountKey || reading?.accountKey, presentation) || reading?.accountEmail || reading?.email || slot.accountEmail
      || reading?.accountName || slot.accountName
      // The app's name is a proper noun; the phrase around it is localized.
      || (slot.sourceName ? t('settings.slots.discoveredName', { source: slot.sourceName }) : '')
      || (slot.source === 'environment' ? t('settings.limits.sources.env') : '')
      || t('settings.slots.account', { fingerprint: slot.fingerprint });
  }
  function renderAccountName(document, node, name) {
    if (node.textContent === name) return;
    const email = /^([^\s@]+)(@[^\s@]+)(.*)$/.exec(name);
    if (!email) {
      node.textContent = name;
      return;
    }
    // Prefer email boundaries when there is room. Keep the text intact for
    // assistive technology and the rename placeholder.
    const parts = [...email[1].split(/(?<=[._+-])/), email[2] + email[3]];
    node.replaceChildren(...parts.flatMap((part, index) => [
      ...(index ? [document.createElement('wbr')] : []), document.createTextNode(part)
    ]));
  }
  // Plans describe the subscription, never the account's identity or rename.
  function accountPlan(provider, slot, reading) {
    const row = reading || { provider, planLabel: slot.planLabel };
    const owned = presentationApi.limitProviderPlanValue(row, { mimoProductLabel: windowLabels.mimoProductLabel });
    const value = owned !== undefined ? owned : String(row.planLabel || '').trim() || presentationApi.limitProviderLegacyPlanLabel(row);
    if (!value) return '';
    const identities = [slot.accountEmail, slot.accountName, row.accountEmail, row.email, row.accountName];
    if (identities.some(identity => identity && String(identity).toLowerCase() === String(value).toLowerCase())) return '';
    return presentationApi.limitProviderPlanDisplayLabel(row, value);
  }
  // `probing` says a refresh that will answer for this account is in flight.
  // Without a reading, that is a check still running, not a failed one.
  function accountStatus(slot, reading, providerEnabled = true, probing = false) {
    if (!slot.enabled) return 'paused';
    if (!providerEnabled) return 'disabled';
    if (reading?.status === 'disabled') return 'disabled';
    if (reading?.status === 'unauthorized') return 'invalid';
    if (reading?.status === 'rateLimited') return 'limited';
    if (reading?.status === 'sourceRateLimited') return 'usageApiLimited';
    if (reading?.stale) return 'stale';
    if (!reading) return probing ? 'checking' : 'unavailable';
    return reading.status === 'ok' ? 'connected' : 'unavailable';
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
  function alibabaVariant(slot) {
    return slot.region || slot.formValues?.alibabaVariant || 'cn';
  }
  function readingOwner(slots, row) {
    const candidates = row.provider === 'alibaba'
      ? slots.filter(slot => alibabaVariant(slot) === row.region) : slots;
    const owner = slotOwner(candidates, row.accountKey, row.accountKeyAliases);
    return owner?.credentialFor ? candidates.find(slot => slot.id === owner.credentialFor) : owner;
  }
  function applyAccountOrder(records, slotsByProvider, localDeviceId = '', presentation = {}) {
    const result = records.map(row => {
      const slots = slotsByProvider[row.provider] || [];
      const owner = readingOwner(slots, row);
      // Only a name the user chose becomes the display name. Provider names and
      // emails stay in their own fields, so email masking still applies to them.
      const key = selectionKey(row.provider, owner || row, owner?.accountKey || row.accountKey);
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
        const owner = readingOwner(slots, row);
        const keys = [owner?.accountKey, ...(owner?.accountKeyAliases || []), row.accountKey, ...(row.accountKeyAliases || [])]
          .filter(Boolean).map(key => selectionKey(provider, row, key));
        const canonicalIndex = order.indexOf(selectionKey(provider, owner || row, owner?.accountKey || row.accountKey));
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

  // Both editor owners use the existing grid accordion. Collapse only changes
  // presentation: the same controls and pending operations remain mounted.
  function createEditorToggle(button, reveal, id) {
    reveal.id = id;
    button.setAttribute('aria-controls', id);
    let expanded = false;
    return {
      get expanded() { return expanded; },
      setExpanded(value) {
        expanded = value;
        if (reveal.classList.contains('hidden') === value) reveal.classList.toggle('hidden', !value);
        if (reveal.inert !== !value) reveal.inert = !value;
        const aria = String(value);
        if (button.getAttribute?.('aria-expanded') !== aria) button.setAttribute('aria-expanded', aria);
      }
    };
  }

  function createPanel({ form, label, loginAction, document, t, ipc, forms, preserveScroll, onChanged, openExternal, maskEmail = value => value, customEditor, onAdd, addCanToggle = () => false, addBlocked = () => false, capabilities = () => ({}), isBusy = () => false, extraActions = () => [], statusReading = (_slot, reading) => reading, sourceText = () => '', secondaryText = () => '', detailText = () => '', hideAdd = false }) {
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
    const apiCredential = form.fields.some(field => /apikey/i.test(field.key)) ? 'Key'
      : form.fields.some(field => /token/i.test(field.key)) ? 'Token' : '';
    const credentialWord = cookie ? 'Cookie' : apiCredential || 'Key';
    function credentialKind(slot, reading) {
      if (!customEditor) return reading?.source === 'api' && apiCredential ? apiCredential : credentialWord;
      if (form.id === 'minimax') return 'Key';
      if (form.id === 'claude') return 'Cookie';
      if (form.id === 'thirdparty') return slot?.adapter === 'newapi-account' || slot?.adapter === 'sub2api' ? 'Token'
        : slot?.adapter === 'newapi-token' ? 'Key' : '';
      if (form.id === 'mimo' && reading?.source === 'api') return 'Key';
      return '';
    }
    function statusLabel(status, slot, reading) {
      if (['disabled', 'limited', 'usageApiLimited'].includes(status)) return t(`settings.limits.status.${status}`);
      if (status !== 'invalid') return tr(status);
      if (form.id === 'antigravity' && reading?.actionRequired === 'accountVerification') {
        return t('settings.antigravity.verificationRequired');
      }
      const kind = credentialKind(slot, reading);
      if (kind === 'Token') return tr('fixToken');
      return kind === 'Cookie' || kind === 'Key' ? tr(`invalid${kind}`) : t('settings.limits.status.signInAgain');
    }
    const root = make('div', 'slot-panel');
    const list = make('div', 'slot-list');
    const editorReveal = make('div', 'accordion-animated-container hidden slot-editor-reveal');
    editorReveal.inert = true;
    editorReveal.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing || editorOwner === undefined) return;
      event.stopPropagation();
      preserveScroll(() => closeEditor());
      add.focus({ preventScroll: true });
    });
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
    let providerEnabled = true;
    // Limits probes in flight, from the host's context like the readings.
    let probes = [];
    const deviceIcons = typeof module !== 'undefined' ? require('../deviceIcons') : window.TokenMonitorDeviceIcons;
    const deviceLabels = typeof module !== 'undefined' ? require('../deviceBreakdown') : window.TokenMonitorDeviceBreakdown;
    let operationLane = Promise.resolve();
    let presentationPending = 0;
    // Account operations still awaiting IPC (moves, removals, pauses, saves): a
    // drag measured now would persist steps from an account list they are about
    // to change, so no drag starts until they settle.
    let operationsPending = 0;
    let editorPanel;
    let editorOpenUrl;
    let editorRevision = 0;
    const error = () => { message.textContent = tr('failed'); };
    const enqueue = operation => {
      const task = operationLane.then(async () => {
        try {
          const result = await operation();
          if (result.ok === false) {
            if (result.errorCode !== 'slotLimit') error();
            return result;
          }
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
      const ordered = applyAccountOrder(accounts.map(slot => ({
        ...slot, provider: form.id, region: form.id === 'alibaba' ? alibabaVariant(slot) : undefined
      })),
        { [form.id]: slots }, localDeviceId, { [form.id]: presentation }).map(row => byId.get(row.id));
      if (!ordered.some(slot => slot.credentialFor)) return ordered;
      return ordered.filter(slot => !slot.credentialFor).flatMap(slot => [slot, ...ordered.filter(account => account.credentialFor === slot.id)]);
    }
    const presentationOrder = accounts => [...new Set(accounts.filter(slot => !slot.credentialFor)
      .map(slot => selectionKey(form.id, slot)).filter(Boolean))];
    const permissions = slot => slot?.credentialFor ? { ...capabilities(slot), rename: false, move: false } : capabilities(slot);
    function rowStatus(slot, reading) {
      return accountStatus(slot, statusReading(slot, reading),
        slot.source === 'remote' || providerEnabled,
        probes.some(probe => scope.probeCoversRow(probe, { ...slot, provider: form.id, region: form.id === 'alibaba' ? alibabaVariant(slot) : slot.region })));
    }
    const run = (operation, ...args) => {
      const slot = activeAccounts().find(slot => slot.id === args[0]);
      const permission = permissions(slot);
      if (isBusy() || (slot && permission[operation] === false)) return Promise.resolve({ ok: false });
      if (operation === 'move') {
        if (presentationPending || (operationsPending > 0 && remoteAccounts().some(slot => slot.id === args[0])) || rowDrag.isDragging()) return;
        presentationPending++;
        return enqueue(() => {
          const keys = presentationOrder(activeAccounts());
          const key = selectionKey(form.id, slot);
          const index = keys.indexOf(key);
          const target = index + (args[1] === 'up' ? -1 : 1);
          if (index < 0 || target < 0 || target >= keys.length) return { ok: true };
          [keys[index], keys[target]] = [keys[target], keys[index]];
          return ipc.presentation(form.id, key, 'order', keys);
        }).finally(() => { presentationPending--; preserveScroll(render); });
      }
      const remote = remoteAccounts().find(slot => slot.id === args[0])
        || (operation === 'rename' && slots.find(slot => slot.id === args[0] && slot.source === 'environment'));
      operationsPending++;
      preserveScroll(render);
      return enqueue(() => remote
        ? ipc.presentation(form.id, selectionKey(form.id, remote), 'rename', args[1])
        : ipc[operation](form.id, ...args)).finally(() => { operationsPending--; preserveScroll(render); });
    };
    const rowDrag = dragController.createRowDragController({
      dragSort,
      getList: () => list,
      getScrollPanel: () => root.closest('.settings-panel'),
      rowSelector: '.slot-row[data-slot-draggable="true"]',
      idKey: 'slotId',
      dragStartSelector: '.slot-drag-handle',
      dragExcluded: 'input, select, textarea, a, .slot-device-toggle, .slot-device-list',
      preserveScroll,
      mirrorOrder: (order, id) => {
        const group = activeAccounts().filter(account => account.accountKey && !account.credentialFor);
        const previous = group.map(slot => slot.id);
        if (previous.length !== order.length || previous.some(key => !order.includes(key))) return { changed: false };
        const previousOrder = presentation.order;
        const next = [...new Set(order.map(id => selectionKey(form.id, group.find(slot => slot.id === id))))];
        const changed = order.some((key, index) => key !== previous[index]);
        if (!changed) return { changed: false };
        presentation = { ...presentation, order: next };
        presentationPending++;
        preserveScroll(render);
        return { changed, previousOrder, next, key: selectionKey(form.id, group.find(slot => slot.id === id)) };
      },
      applyOrder: order => {
        const credentials = slots.filter(slot => slot.credentialFor);
        for (const id of order) {
          list.moveBefore(rows.get(id).el, add);
          for (const slot of credentials) if (slot.credentialFor === id) list.moveBefore(rows.get(slot.id).el, add);
        }
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
      editorToggle.setExpanded(false);
      const revision = editorRevision;
      const clear = () => { if (revision === editorRevision) editor.replaceChildren(); };
      const motion = document.defaultView?.matchMedia;
      if (!immediate && motion && !motion.call(document.defaultView, '(prefers-reduced-motion: reduce)').matches) setTimeout(clear, 250);
      else clear();
      editorPanel = null;
      editorOpenUrl = null;
      editorReveal.classList.add('hidden'); editorReveal.inert = true;
    }
    function openEditor(slot) {
      if (customEditor) return customEditor(slot);
      if (editorOwner !== undefined && editorOwner === (slot?.id ?? null)) {
        return preserveScroll(() => editorToggle.setExpanded(true));
      }
      preserveScroll(() => {
        closeEditor(true);
        editorToggle.setExpanded(true);
        editorOwner = slot?.id ?? null;
        placeEditor();
        const revision = editorRevision;
        const prefix = `${form.id}SlotDraft`;
        // New Volcengine accounts use one credential set per slot. Existing
        // slots can still replace credentials saved for a separate Agent Plan.
        const hideAgentFields = !slot && form.id === 'volcengine';
        const fields = hideAgentFields ? form.fields.filter(field => !field.key.startsWith('volcengineAgent')) : form.fields;
        const keys = new Map(fields.map(field => [field.key, `${prefix}${field.key}`]));
        const remap = value => typeof value === 'string' ? (keys.get(value) || (value === form.credentialChoice?.key ? `${prefix}${value}` : value))
          : Array.isArray(value) ? value.map(remap)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, val]) => [key, remap(val)])) : value;
        const manual = hideAgentFields ? form.manual.filter(block => !block.field || keys.has(block.field)) : form.manual;
        const draftForm = remap({ ...form, fields, manual });
        draftForm.id = prefix;
        draftForm.fields.forEach(field => { field.submitWithCredential = true; });
        const title = localized(make('strong'), `settings.slots.${slot ? 'replaceTitle' : 'addTitle'}`, { provider: label });
        const name = make('input', 'credential-input');
        name.dataset.i18nPlaceholder = 'settings.slots.optionalName';
        name.dataset.i18nAriaLabel = 'settings.slots.optionalName';
        name.placeholder = tr('optionalName');
        name.setAttribute('aria-label', tr('optionalName'));
        const verdict = make('div', 'settings-note error');
        verdict.setAttribute('role', 'alert');
        verdict.id = `${prefix}Verdict`;
        const choices = make('div', 'settings-actions');
        const submit = async (values, clearInput, asNew = false) => {
          const original = Object.fromEntries([...keys].map(([key, mapped]) => [key, values[mapped]]));
          const result = await run(slot && !asNew ? 'replace' : 'add', ...(slot && !asNew ? [slot.id, original] : [original, name.value]));
          if (!result || revision !== editorRevision) return;
          choices.replaceChildren();
          const credentialInput = fields.filter(field => field.secret).map(field => field.key)
            .map(key => document.getElementById(`${keys.get(key)}Input`)).find(input => input && !input.closest('.hidden'));
          if (result.saved) credentialInput?.removeAttribute('aria-invalid');
          else if (['required', 'invalidFormat', 'unauthorized'].includes(result.status)) {
            credentialInput?.setAttribute('aria-invalid', 'true');
            credentialInput?.setAttribute('aria-describedby', verdict.id);
            credentialInput?.focus();
          }
          if (result.errorCode === 'slotLimit') {
            verdict.textContent = tr('slotLimit', { limit: result.limit });
          } else if (result.verdict === 'duplicate') {
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
            preserveScroll(() => { closeEditor(); add.focus({ preventScroll: true }); });
            message.textContent = result.verdict === 'valid' ? '' : t('settings.common.credentialSavedUnconfirmed', { provider: label });
          } else {
            const key = result.status === 'required' ? 'credentialRequired' : result.status === 'invalidFormat' ? 'credentialInvalidFormat' : 'credentialRejected';
            verdict.textContent = result.ok === false ? tr('failed') : t(`settings.common.${key}`, { provider: label });
          }
        };
        editorOpenUrl = draftForm.openUrl ? () => forms.resolveOpenUrl(draftForm, { document }) : null;
        editorPanel = forms.createCredentialPanel(draftForm, {
          document, translate: t, onToggle() {}, onClear() {},
          onOpen: () => { if (editorOpenUrl) openExternal(editorOpenUrl()); },
          onSave: (_form, values, clearInput) => submit(values, clearInput)
        });
        editor.append(title, ...(!slot ? [name] : []), editorPanel, verdict, choices);
        editorPanel.addEventListener('input', event => {
          event.target.removeAttribute?.('aria-invalid');
          if (event.target.getAttribute?.('aria-describedby') === verdict.id) event.target.removeAttribute('aria-describedby');
        });
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
        for (const field of fields.filter(field => !field.secret)) {
          const input = editorPanel.querySelector(`#${prefix}${field.key}Input`);
          if (input && slot?.formValues && Object.hasOwn(slot.formValues, field.key)) input.value = slot.formValues[field.key];
        }
        forms.refreshFieldDependents?.(draftForm, { document });
        editorPanel.querySelector(`#${prefix}CredentialSubmit`).classList.add('slot-save');
        editorPanel.querySelector(`#${prefix}CredentialSubmit`).classList.add('slot-save');
        editorPanel.querySelector('.settings-group-header').classList.add('hidden');
        editorPanel.querySelector('.cursor-settings-details').classList.remove('hidden');
        editorPanel.querySelector(`#${prefix}LogoutButton`).classList.add('hidden');
      });
    }
    // The declared source a row reads through: an owner-supplied `sourceId`,
    // then the reading's provenance, then, for a detected login, the one
    // declared non-manual source. A pasted credential can be either kind (Trae's
    // IDE token), and a paired credential shares its detected row's reading,
    // so neither is guessed.
    function rowSource(slot, reading) {
      const declared = settings?.limitConnectionSources
        ? presentationApi.connectionSources(form.id, settings.limitConnectionSources) : presentationApi.connectionSources(form.id);
      const byId = slot.sourceId && declared.find(source => source.id === slot.sourceId);
      if (byId) return byId;
      if (slot.credentialFor) return null;
      const read = connection.sourceForReading(declared, reading);
      if (read || declared.length === 1) return read || declared[0];
      if (slot.source !== 'discovered') return null;
      const fits = declared.filter(source => !['apiKey', 'web'].includes(source.kind));
      return fits.length === 1 ? fits[0] : null;
    }
    function rowFor({ id, source }) {
      if (rows.has(id)) return rows.get(id);
      const el = make('div', 'slot-row');
      el.tabIndex = 0;
      el.dataset.slotId = id;
      const grip = make('span', 'preference-order-handle slot-drag-handle');
      grip.setAttribute('aria-hidden', 'true');
      // Shares the grip's cell; the grip replaces it while the row is grabbable.
      const sourceIcon = make('span', 'slot-source-icon');
      sourceIcon.setAttribute('aria-hidden', 'true');
      const copy = make('div', 'slot-copy');
      const name = make('div', 'slot-name');
      const status = make('span', 'slot-status');
      const actions = make('div', 'slot-actions');
      const nameLine = make('div', 'slot-name-line');
      nameLine.append(name);
      copy.append(nameLine);
      el.append(grip, sourceIcon, copy, status, actions);
      el.addEventListener('pointerdown', event => {
        if ((presentationPending > 0 || operationsPending > 0) || editorOwner !== undefined
          || isBusy() || permissions(item.slot).move === false || [...rows.values()].some(row => row.editing || row.actions.querySelector('.plugin-menu').matches(':popover-open'))) return;
        rowDrag.startRowDrag(event, id);
      });
      // Each row owns its rename session, so one row cannot invalidate another's.
      const item = { el, name, status, sourceIcon, actions, editing: false, renameRevision: 0, slot: null };
      const rename = () => {
        if (item.editing || isBusy() || permissions(item.slot).rename === false) return;
        item.editing = true;
        const revision = ++item.renameRevision;
        const input = make('input', 'slot-rename');
        const initialValue = presentationLabel(item.slot, selectionKey(form.id, item.slot), presentation);
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
        if (source === 'remote') {
          shared.appendItems(action('rename', rename), up, down);
          menu.append(localized(make('div', 'settings-note slot-remote-note'), 'settings.slots.remoteNote'));
        } else shared.appendItems(action('rename', rename), replace, pause, separator(), up, down, separator(), remove);
        item.menu = menu;
        const fix = slotButton('replaceTitle', () => openEditor(item.slot));
        fix.className = 'slot-fix plugin-inline-action';
        copy.append(fix);
        item.fix = fix;
        actions.append(shared.element);
        Object.assign(item, { up, down, pause, fix, replace, remove });
        el.addEventListener('keydown', event => {
          if (event.key === 'Escape' && menu.matches(':popover-open')) { closeMenu(); more.focus(); }
          if (!item.editing && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
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
      const anchor = owner?.el || add;
      const before = list.children[[...list.children].indexOf(anchor) + 1];
      if (before !== editorReveal) list.moveBefore(editorReveal, before || null);
    }
    function revealAddInput() {
      const target = editor.querySelector('.credential-input');
      if (!target) return;
      target.focus?.({ preventScroll: true });
      const frame = document.defaultView?.requestAnimationFrame?.bind(document.defaultView);
      frame?.(() => {
        const animations = editorReveal.getAnimations?.() || [];
        void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
          if (editorOwner === null && editorToggle.expanded && document.activeElement === target) {
            const panel = root.closest('.settings-panel')?.getBoundingClientRect();
            const input = target.getBoundingClientRect();
            if (panel && (input.bottom > panel.bottom || input.top < panel.top)) {
              target.scrollIntoView({ block: 'center' });
            }
          }
        });
      });
    }
    const add = slotButton('add', () => {
      if (addBlocked()) return;
      if (!onAdd && editorOwner !== undefined) {
        preserveScroll(() => editorToggle.setExpanded(!editorToggle.expanded));
        if (editorOwner === null && editorToggle.expanded) revealAddInput();
        return;
      }
      if (isBusy() && !onAdd) return;
      if (!onAdd) {
        openEditor(null);
        revealAddInput();
        return;
      }
      try { return Promise.resolve(onAdd()).catch(error); } catch (_) { error(); }
    }, { provider: label });
    add.className = 'slot-add';
    add.classList.toggle('hidden', hideAdd);
    const editorToggle = createEditorToggle(add, editorReveal, `${form.id}SlotEditor`);
    editorToggle.setExpanded(false);
    list.append(add);
    function remoteAccounts() {
      return applyAccountOrder(remoteReadings, { [form.id]: slots }, localDeviceId, { [form.id]: presentation })
        .filter(row => row.provider === form.id && row.accountKey && row.sourceDeviceId && row.sourceDeviceId !== localDeviceId && !readingOwner(slots, row))
        .map(row => {
          const variant = form.id === 'alibaba' ? row.region : undefined;
          return {
            id: `remote:${row.sourceDeviceId}:${row.accountKey}${variant ? `:${variant}` : ''}`,
            source: 'remote', sourceDeviceId: row.sourceDeviceId, accountKey: row.accountKey,
            accountKeyAliases: row.accountKeyAliases, region: variant, presentationKey: selectionKey(form.id, row),
            label: presentation.labels?.[selectionKey(form.id, row)] || '',
            enabled: true, fingerprint: accountIdentity.accountStableFingerprint(row).slice(0, 12)
          };
        });
    }
    function localReading(slot) {
      // Alibaba keeps one account key across plans; both readings and alias
      // owners must belong to this slot's variant. Legacy saved slots use cn.
      const variant = form.id === 'alibaba' ? alibabaVariant(slot) : null;
      const candidates = variant ? readings.filter(row => row.region === variant) : readings;
      const owners = variant ? slots.filter(owner => alibabaVariant(owner) === variant) : slots;
      return candidates.find(row => row.accountKey === slot.accountKey)
        || candidates.find(row => readingOwner(owners, row) === slot);
    }
    function matchingObservation(slot, row) {
      if (slot.credentialFor || row.provider !== form.id || row.removed || !row.accountKey) return false;
      const owners = slot.source === 'remote' ? [slot] : slots;
      return readingOwner(owners, row) === slot;
    }
    function renderDevices(item, slot, reading, status, source, permission) {
      const remote = slot.source === 'remote';
      const observed = new Map();
      const selected = remoteReadings.find(row => matchingObservation(slot, row));
      for (const device of devices) {
        if (device.deviceId === localDeviceId) continue;
        const candidates = (device.limits?.providers || []).filter(row => matchingObservation(slot, row));
        // Prefer the lane used by the displayed account when a device has several.
        const candidate = candidates.find(row => row.source === reading?.source) || candidates[0];
        if (candidate) observed.set(device.deviceId, { ...candidate, stale: Boolean(candidate.stale || device.stale) });
      }
      // Older snapshots may carry only the aggregate observation.
      for (const row of remoteReadings) {
        if (row.sourceDeviceId && row.sourceDeviceId !== localDeviceId
          && matchingObservation(slot, row) && !observed.has(row.sourceDeviceId)) observed.set(row.sourceDeviceId, row);
      }
      const members = [...(!remote && observed.size ? [{ deviceId: localDeviceId, reading, local: true }] : []),
        ...[...observed].map(([deviceId, observation]) => ({ deviceId, reading: observation, local: false }))];
      const multiple = members.length > 1;
      if (!members.length) {
        item.deviceNote?.remove(); item.deviceNote = null;
        item.deviceList?.classList.add('hidden'); item.devicesExpanded = false;
        if (item.deviceList) item.deviceList.inert = true;
        item.el.classList.remove('slot-devices-expanded');
        item.status.setAttribute('aria-hidden', 'false');
        return;
      }
      if (!item.deviceNote || item.deviceMultiple !== multiple) {
        item.deviceNote?.remove();
        item.deviceNote = multiple ? button('', () => preserveScroll(() => {
          item.devicesExpanded = !item.devicesExpanded; render();
        })) : make('div');
        item.deviceNote.className = `row-device slot-device-summary${multiple ? ' slot-device-toggle' : ''}`;
        item.el.insertBefore(item.deviceNote, item.deviceList || null);
        item.deviceMultiple = multiple;
      }
      if (!multiple) item.devicesExpanded = false;
      const expanded = Boolean(item.devicesExpanded);
      item.el.classList.toggle('slot-devices-expanded', expanded);
      item.status.setAttribute('aria-hidden', String(expanded));
      const deviceName = member => member.local ? t('settings.sync.panel.thisDevice')
        : deviceLabels.deviceLabel(devices.find(device => device.deviceId === member.deviceId) || { deviceId: member.deviceId });
      const deviceToken = member => {
        const device = devices.find(device => device.deviceId === member.deviceId) || { deviceId: member.deviceId };
        const token = make('span', 'slot-device-token');
        token.append(deviceIcons.deviceIconNode(document, deviceIcons.deviceIconKind(settings, device)), document.createTextNode(deviceName(member)));
        return token;
      };
      item.deviceNote.replaceChildren(...members.map(deviceToken));
      if (multiple) {
        item.deviceNote.setAttribute('aria-expanded', String(expanded));
        item.deviceNote.setAttribute('aria-label', `${tr(expanded ? 'hideDevices' : 'showDevices')}: ${members.map(deviceName).join(', ')}`);
      }
      if (!item.deviceList && multiple) {
        item.deviceList = make('div', 'slot-device-list accordion-animated-container hidden');
        item.deviceList.inert = true;
        item.deviceList.id = `slot-devices-${form.id}-${encodeURIComponent(slot.id)}`;
        item.deviceListInner = make('div', 'accordion-animation-inner');
        item.deviceList.append(item.deviceListInner);
        item.el.append(item.deviceList); item.deviceRows = new Map();
      }
      if (!item.deviceList) return;
      item.deviceList.classList.toggle('hidden', !expanded);
      item.deviceList.inert = !expanded;
      if (multiple) item.deviceNote.setAttribute('aria-controls', item.deviceList.id);
      if (!expanded) return;
      for (const [id, row] of item.deviceRows) if (!members.some(member => member.deviceId === id)) { row.element.remove(); item.deviceRows.delete(id); }
      for (const member of members) {
        let row = item.deviceRows.get(member.deviceId);
        if (!row) {
          const element = make('div', 'slot-device-row');
          const name = make('span', 'slot-device-name'), state = make('span'), note = make('div', 'slot-device-note');
          const fix = slotButton('replaceTitle', () => openEditor(item.slot));
          fix.className = 'slot-device-fix plugin-inline-action';
          element.append(name, state, note, fix);
          row = { element, name, state, note, fix }; item.deviceRows.set(member.deviceId, row); item.deviceListInner.append(element);
        }
        row.name.replaceChildren(deviceToken(member));
        const memberStatus = member.local ? status : accountStatus({ enabled: true }, member.reading);
        const memberSource = member.local ? source : presentationApi.limitProviderSourceLabel(member.reading) || '';
        const statusText = statusLabel(memberStatus, slot, member.reading);
        row.state.className = `slot-status slot-${memberStatus}`;
        row.state.textContent = memberStatus === 'connected' ? memberSource || statusText : statusText;
        row.state.setAttribute('aria-label', [statusText, memberSource].filter(Boolean).join(' · '));
        const updated = new Date(member.reading?.updatedAt || NaN);
        let time = '';
        if (Number.isFinite(updated.getTime())) {
          const seconds = Math.max(0, (Date.now() - updated.getTime()) / 1000);
          const unit = seconds < 60 ? 'second' : seconds < 3600 ? 'minute' : seconds < 86400 ? 'hour' : 'day';
          const divisor = { second: 1, minute: 60, hour: 3600, day: 86400 }[unit];
          time = new Intl.RelativeTimeFormat(document.documentElement?.lang || 'en', { numeric: 'auto' }).format(-Math.floor(seconds / divisor), unit);
        }
        const current = selected?.sourceDeviceId === member.deviceId && selected.status === 'ok' && !selected.stale && !member.reading?.stale;
        row.note.textContent = [time ? tr('deviceUpdated', { time }) : '', current ? tr('quotaSource') : ''].filter(Boolean).join(' · ');
        row.note.classList.toggle('hidden', !row.note.textContent);
        row.fix.classList.toggle('hidden', !member.local || permission.replace === false || Boolean(slot.source) || !slot.enabled || memberStatus !== 'invalid');
      }
    }
    function accountReading(slot) {
      return slot.source === 'remote'
        ? remoteReadings.find(row => row.provider === form.id && row.sourceDeviceId === slot.sourceDeviceId
          && row.accountKey === slot.accountKey && (form.id !== 'alibaba' || row.region === slot.region))
        : localReading(slot);
    }
    function render() {
      if (rowDrag.deferRender()) return;
      const active = activeAccounts();
      const ordering = presentationOrder(active);
      if (editorOwner != null && !active.some(slot => slot.id === editorOwner)) closeEditor(true);
      add.disabled = Boolean(addBlocked()) || (editorOwner === undefined && !addCanToggle() && Boolean(isBusy()));
      for (const [id, item] of rows) if (!active.some(slot => slot.id === id)) { item.el.remove(); rows.delete(id); }
      const displayed = active.map(slot => {
        const reading = accountReading(slot);
        const accountDisplayName = accountName({ ...slot, accountEmail: maskEmail(slot.accountEmail || '') },
          reading ? { ...reading, accountEmail: maskEmail(reading.accountEmail || ''), email: maskEmail(reading.email || '') } : reading,
          t, presentation);
        return { id: slot.id, accountKey: selectionKey(form.id, slot), accountDisplayName, reading, slot, status: rowStatus(slot, reading) };
      });
      const statuses = new Map(displayed.map(({ id, status }) => [id, status]));
      const peersByName = new Map();
      for (const account of displayed) {
        const name = account.accountDisplayName.toLowerCase();
        if (!peersByName.has(name)) peersByName.set(name, []);
        peersByName.get(name).push(account);
      }
      const liveIds = new Set();
      displayed.forEach((account, index) => {
        const { slot, reading, status } = account;
        const item = rowFor(slot);
        item.slot = slot;
        item.el.dataset.slotDraggable = 'true';
        if (!item.editing) {
          const name = accountIdentity.accountTitleLabel(account, peersByName.get(account.accountDisplayName.toLowerCase()), { index });
          renderAccountName(document, item.name, name);
        }
        const primaryStatus = statuses.get(slot.credentialFor);
        const sharesStatus = primaryStatus && !['paused', 'disabled'].includes(status);
        const source = !slot.source && slot.credentialFor ? tr('savedSource')
          : sourceText(slot, reading) || slot.sourceName || presentationApi.limitProviderSourceLabel(reading) || '';
        const secondary = secondaryText(slot);
        // A pasted credential is the default origin and needs no label; only
        // environment rows (and paired saved credentials above) say where they came from.
        const provenance = secondary && secondary !== source ? secondary : !source && slot.source === 'environment'
          ? t('settings.limits.sources.env') : '';
        const detail = [...(!slot.credentialFor ? [maskEmail(accountPlan(form.id, slot, reading))] : []),
          status !== 'connected' || sharesStatus ? source : '', provenance, detailText(slot)]
          .filter((value, index, all) => value && all.indexOf(value) === index).join(' · ');
        if (detail && !item.detail) {
          item.detail = make('div', 'settings-note slot-detail');
          item.el.querySelector('.slot-copy').insertBefore(item.detail, item.fix);
        }
        if (item.detail) {
          item.detail.textContent = detail;
          item.detail.classList.toggle('hidden', !detail);
        }
        const permission = permissions(slot);
        item.menuTrigger.classList.toggle('hidden', !item.hasExtraActions
          && ['rename', 'move', 'replace', 'setEnabled', 'remove'].every(operation => permission[operation] === false));
        item.renameButton.disabled = isBusy();
        item.renameAction?.classList.toggle('hidden', permission.rename === false);
        item.renameButton.classList.toggle('hidden', item.editing || permission.rename === false);
        item.name.parentElement.classList.toggle('is-editing', item.editing);
        item.el.classList.toggle('slot-paused', !slot.enabled);
        item.status.className = sharesStatus ? 'slot-status' : `slot-status slot-${status}`;
        const lane = rowSource(slot, reading);
        const iconKind = slot.sourceIconKind || lane?.kind;
        if (iconKind) item.sourceIcon.dataset.kind = iconKind;
        else delete item.sourceIcon.dataset.kind;
        const quota = reading ?? slot.observation;
        const liveLane = lane && lane.kind === iconKind && status === 'connected'
          && connection.isFresh(quota) ? lane : null;
        item.sourceIcon.classList.toggle('is-live', Boolean(liveLane));
        if (liveLane && slot.source !== 'remote' && (!quota.sourceDeviceId || quota.sourceDeviceId === localDeviceId)) {
          liveIds.add(liveLane.id);
        }
        const statusText = statusLabel(status, slot, reading);
        item.status.textContent = sharesStatus ? '' : status === 'connected' ? source || statusText : statusText;
        if (sharesStatus) item.status.removeAttribute('aria-label');
        else item.status.setAttribute('aria-label', [statusText, source].filter(Boolean).join(' · '));
        if (item.pause) {
          const kind = credentialKind(slot, reading);
          localized(item.replace, `settings.slots.${kind ? `replace${kind}` : 'replaceTitle'}`);
          item.updateRemove();
          item.pause.dataset.slotAction = slot.enabled ? 'pause' : 'resume';
          localized(item.pause, `settings.slots.${item.pause.dataset.slotAction}`);
          const pending = presentationPending > 0 || operationsPending > 0 || isBusy();
          item.pause.disabled = pending; item.replace.disabled = pending; item.remove.disabled = pending;
          const position = ordering.indexOf(selectionKey(form.id, slot));
          item.up.disabled = pending || position <= 0;
          item.down.disabled = pending || position < 0 || position === ordering.length - 1;
          item.replace.classList.toggle('hidden', slot.source === 'environment');
          item.pause.classList.toggle('hidden', slot.source === 'environment');
          item.remove.classList.toggle('hidden', slot.source === 'environment');
          if (slot.source === 'discovered') { item.replace.remove(); item.remove.remove(); }
        }
        item.fix.classList.toggle('hidden', Boolean(sharesStatus) || permission.replace === false || Boolean(slot.source) || !slot.enabled || status !== 'invalid');
        if (slot.source === 'discovered' && !item.discoveredNote) {
          item.discoveredNote = localized(make('div', 'settings-note'), 'settings.slots.discovered', { source: slot.sourceName });
          item.el.querySelector('.plugin-menu')?.append(item.discoveredNote);
        }
        renderDevices(item, slot, reading, status, source, permission);
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
      publishLiveSources(form.id, root, liveIds);
      placeEditor();
    }
    return { element: root, update(nextSlots, nextReadings, context = {}) {
      slots = nextSlots; readings = nextReadings; settings = context.settings;
      providerEnabled = context.providerEnabled !== false;
      remoteReadings = context.records || []; devices = context.devices || []; localDeviceId = context.localDeviceId || ''; presentation = context.presentation || {};
      probes = context.probes || [];
      preserveScroll(render);
    }, summary() {
      const accounts = activeAccounts();
      const linked = new Set(accounts.filter(slot => rowStatus(slot, accountReading(slot)) === 'connected')
        .map(slot => slot.credentialFor || slot.id)).size;
      return { total: accounts.filter(slot => !slot.credentialFor).length, linked };
    }, openEditor };
  }
  // Rows know their lane even when readings cannot tell lanes apart (Cursor
  // reads desktop and manual accounts through one Web API). The connection
  // card unions these with its own reading-based attribution.
  const liveSourcesByProvider = new Map();
  const liveListeners = new Set();
  // Compared against what listeners last heard: pruning a replaced panel while
  // computing "before" would otherwise swallow the lanes it took with it.
  const lastPublished = new Map();
  function publishLiveSources(providerId, panelRoot, ids) {
    const panels = liveSourcesByProvider.get(providerId) || new Map();
    panels.set(panelRoot, ids);
    liveSourcesByProvider.set(providerId, panels);
    const after = [...liveSourceIds(providerId)].sort().join(',');
    if (after === (lastPublished.get(providerId) ?? '')) return;
    lastPublished.set(providerId, after);
    for (const listener of liveListeners) listener(providerId);
  }
  // A replaced panel leaves the document; its last rows must not keep a lane lit.
  function liveSourceIds(providerId) {
    const panels = liveSourcesByProvider.get(providerId);
    if (!panels) return new Set();
    for (const panelRoot of panels.keys()) if (panelRoot.isConnected === false) panels.delete(panelRoot);
    return new Set([...panels.values()].flatMap(ids => [...ids]));
  }
  function onLiveSourcesChange(listener) {
    liveListeners.add(listener);
    return () => liveListeners.delete(listener);
  }
  return { presentationLabel, accountName, accountStatus, slotOwner, applyAccountOrder, createPanel, createEditorToggle, liveSourceIds, onLiveSourcesChange };
});
