// @ts-check
'use strict';
(function expose(root, factory) {
  const panel = typeof module === 'object' && module.exports ? require('./accountSlotsPanel') : /** @type {any} */ (root).TokenMonitorAccountSlotsPanel;
  const accountIdentity = typeof module === 'object' && module.exports ? require('../accountIdentity') : /** @type {any} */ (root).TokenMonitorAccountIdentity;
  const api = factory(panel, accountIdentity);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) /** @type {any} */ (root).TokenMonitorLegacyAccountList = api;
})(typeof window !== 'undefined' ? window : null, /** @param {any} panel @param {any} accountIdentity */ function legacyAccountList(panel, accountIdentity) {
  /**
   * Metadata-only adapter. `id` belongs to the provider authority; accountKey
   * belongs to quota/history. Presentation commands never rename a store key.
   * @typedef {{id: string, accountKey?: string, accountKeyAliases?: string[], enabled?: boolean, label?: string, accountEmail?: string, accountName?: string, email?: string, source?: string, removable?: boolean}} Account
   */
  /** @param {Account} account @param {any[]} readings */
  function readingFor(account, readings) {
    if (!account.accountKey) return undefined;
    const exact = readings.find(row => row.accountKey === account.accountKey);
    // A resolved reading explicitly owns this credential alias. Prefer that
    // canonical key over a cached observation still filed under the fallback.
    const resolved = readings.filter(row => row.accountKey !== account.accountKey
      && row.accountKeyAliases?.includes(account.accountKey));
    if (resolved.length === 1) return resolved[0];
    if (exact) return exact;
    const keys = [account.accountKey, ...(account.accountKeyAliases || [])];
    const candidates = readings.filter(row => row.accountKey &&
      [row.accountKey, ...(row.accountKeyAliases || [])].some(key => keys.includes(key)));
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  /**
   * @param {{document: Document, provider: string, label?: string, add?: Function, container: HTMLElement, t: Function, bridge: any, getContext: Function, preserveScroll: Function, refresh: Function, changed: Function, enabled?: Function, remove?: Function, edit?: Function, sourceLabel?: Function, busy?: Function, editor?: {nodes: string[], submit?: string, visibility?: string, replaceVisibility?: string, allowBusyCancel?: boolean, isOpen?: Function, retryAvailable?: Function, cancel?: Function}, actions?: Function, statusReading?: Function, secondaryText?: Function, detailText?: Function, blocked?: Function}} options
   */
  function create(options) {
    let accounts = /** @type {any[]} */ ([]);
    let readings = /** @type {any[]} */ ([]);
    const { provider, bridge } = options;
    /** @type {ReturnType<typeof mountEditor>} */
    let sharedEditor;
    /** @param {Function | undefined} command @param {any} [account] */
    const open = (command, account = undefined) => {
      if (options.blocked?.()) return;
      if (!account && !options.editor?.retryAvailable?.() && sharedEditor?.toggle()) return;
      if (options.busy?.()) return;
      sharedEditor?.open(Boolean(account));
      const result = command?.(account);
      sharedEditor?.sync();
      sharedEditor?.focus();
      return result;
    };
    const permission = (/** @type {any} */ account) => ({
      rename: Boolean(account?.accountKey), move: Boolean(account?.accountKey),
      replace: Boolean(options.edit) && account?.canReplace !== false && account?.source !== 'environment' && account?.source !== 'remote',
      setEnabled: Boolean(options.enabled) && account?.canPause !== false,
      remove: Boolean(options.remove) && account?.removable !== false
    });
    /** @param {Function | undefined} command @param {string} id @param {any} [value] */
    const mutate = async (command, id, value) => {
      if (!command) return { ok: false };
      const account = accounts.find(row => row.id === id);
      if (!account) return { ok: false };
      const result = await command(account, value);
      if (result?.ok === false) return result;
      await options.changed(result);
      await options.refresh();
      return { ok: true };
    };
    const list = panel.createPanel({
      form: { id: provider, fields: [] }, label: options.label || provider,
      document: options.document, t: options.t, hideAdd: !options.add, onAdd: options.add ? () => open(options.add) : undefined,
      addCanToggle: () => sharedEditor?.hasDraft() || false, addBlocked: options.blocked,
      customEditor: (/** @type {any} */ row) => open(options.edit, accounts.find(account => account.id === row?.id)),
      capabilities: permission, isBusy: options.busy || (() => false),
      extraActions: options.actions || (() => []),
      statusReading: options.statusReading, sourceText: (/** @type {any} */ account, /** @type {any} */ reading) => account.source === 'remote' ? '' : options.sourceLabel?.(account, reading) || account.sourceName || '', secondaryText: options.secondaryText, detailText: options.detailText,
      ipc: {
        /** @param {string} _provider @param {string} id @param {string} value */
        rename: (_provider, id, value) => bridge.limits.accountSlots.presentation(provider, accounts.find(row => row.id === id)?.accountKey, 'rename', value),
        /** @param {string} _provider @param {string} id @param {boolean} value */
        setEnabled: (_provider, id, value) => mutate(options.enabled, id, value),
        /** @param {string} _provider @param {string} id */
        remove: (_provider, id) => mutate(options.remove, id),
        /** @param {any[]} args */
        presentation: (...args) => bridge.limits.accountSlots.presentation(...args)
      },
      forms: {}, preserveScroll: options.preserveScroll,
      onChanged: () => {}, openExternal: (/** @type {string} */ url) => bridge.openExternal(url),
      maskEmail: (/** @type {string} */ value) => options.getContext().settings?.maskLimitAccountEmails === true ? accountIdentity.maskEmailAddress(value) : value
    });
    options.container.replaceChildren(list.element);
    if (options.editor) sharedEditor = mountEditor({ ...options, editor: options.editor }, list.element);

    return {
      summary: list.summary,
      /** Refresh status without replacing provider-owned account controls. @param {any[]} nextReadings */
      updateReadings(nextReadings) {
        readings = nextReadings;
        sharedEditor?.sync();
        const context = options.getContext();
        list.update(accounts, readings, { ...context, presentation: context.settings?.limitAccountPresentation?.[provider] || {} });
      },
      /** @param {any[]} next @param {any[]} nextReadings */
      update(next, nextReadings) {
        readings = nextReadings;
        sharedEditor?.sync();
        const context = options.getContext();
        const presentation = context.settings?.limitAccountPresentation?.[provider] || {};
        accounts = next.map(account => {
          const reading = readingFor(account, readings);
          // Only an explicit alias from the quota authority can resolve a
          // credential key to its workspace. A shared name/email proves nothing.
          const accountKey = reading?.accountKeyAliases?.includes(account.accountKey)
            ? reading.accountKey : account.accountKey;
          const aliases = reading ? [...new Set([...(account.accountKeyAliases || []),
            account.accountKey, ...(reading.accountKeyAliases || [])].filter(key => key && key !== accountKey))] : account.accountKeyAliases;
          const labelKey = [accountKey, ...(aliases || [])].find(key => Object.hasOwn(presentation.labels || {}, key));
          const label = labelKey ? presentation.labels[labelKey] : account.label || '';
          return { ...account, accountKey, accountKeyAliases: aliases,
            accountEmail: account.accountEmail || account.email, enabled: account.enabled !== false,
            fingerprint: account.id, label, accountName: account.accountName || account.accountLabel || (account.email || account.accountEmail ? '' : account.id) };
        });
        list.update(accounts, readings, { ...context, presentation: context.settings?.limitAccountPresentation?.[provider] || {} });
      }
    };
  }
  /** Provider-owned nodes and callbacks remain live across expansion and status updates.
   * @param {{document: Document, editor: {nodes: string[], submit?: string, visibility?: string, replaceVisibility?: string, allowBusyCancel?: boolean, isOpen?: Function, retryAvailable?: Function, cancel?: Function}, t: Function, label?: string, provider: string, busy?: Function}} options @param {HTMLElement} root
   */
  function mountEditor(options, root) {
    const { document, editor: config, t } = options;
    const nodes = config.nodes.map(id => document.getElementById(id)).filter(node => node !== null);
    if (!nodes.length) return;
    const reveal = document.createElement('div');
    reveal.className = 'accordion-animated-container hidden legacy-editor-reveal';
    const inner = document.createElement('div');
    inner.className = 'accordion-animation-inner';
    const card = document.createElement('div');
    card.className = 'slot-editor legacy-slot-editor';
    const title = document.createElement('strong');
    card.append(title);
    let actionGroup;
    for (const node of nodes) {
      if (node.tagName.toLowerCase() === 'button') {
        if (!actionGroup) { actionGroup = document.createElement('div'); actionGroup.className = 'settings-actions'; card.append(actionGroup); }
        actionGroup.append(node);
      } else { actionGroup = null; card.append(node); }
    }
    const actions = document.createElement('div');
    actions.className = 'settings-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.dataset.i18n = 'settings.common.cancel';
    cancel.textContent = t(cancel.dataset.i18n);
    actions.append(cancel); card.append(actions);
    // Owners identify their mutation boundary; the shell owns Cancel and places
    // it beside that action without rebuilding controls or touching listeners.
    const submitActions = config.submit ? card.querySelector(`#${config.submit}`)?.closest('.settings-actions') : null;
    inner.append(card); reveal.append(inner); /** @type {HTMLElement} */ (root.querySelector('.slot-list')).append(reveal);
    let ownerOpen = false;
    let collapsed = false;
    const toggle = panel.createEditorToggle(root.querySelector('.slot-add'), reveal, `${options.provider}LegacySlotEditor`);
    let replacing = false;
    const visibility = config.visibility ? document.getElementById(config.visibility) : null;
    const replacement = config.replaceVisibility ? document.getElementById(config.replaceVisibility) : null;
    if (visibility) visibility.classList.add('legacy-editor-content');
    if (replacement) replacement.classList.add('legacy-replacement-content');
    /** @param {boolean} value */
    const setOpen = value => {
      ownerOpen = value;
      if (!value) collapsed = false;
      toggle.setExpanded(value && !collapsed);
    };
    const sync = () => {
      const active = replacing && replacement ? replacement : visibility;
      const footer = !(replacing && replacement) && submitActions ? submitActions : actions;
      if (cancel.parentElement !== footer) footer.append(cancel);
      if (actions.classList.contains('hidden') !== (footer !== actions)) actions.classList.toggle('hidden', footer !== actions);
      if (config.isOpen) setOpen(Boolean(config.isOpen()));
      else if (active) setOpen(!active.classList.contains('hidden'));
      const disabled = Boolean(options.busy?.()) && !config.allowBusyCancel;
      // Cancel can live inside an observed owner form. Rewriting a present
      // boolean attribute queues another mutation even when its value is equal.
      if (cancel.disabled !== disabled) cancel.disabled = disabled;
    };
    const close = () => {
      if (options.busy?.() && !config.allowBusyCancel) return;
      const cancellingLogin = config.allowBusyCancel && options.busy?.();
      config.cancel?.();
      if (cancellingLogin) return;
      visibility?.classList.add('hidden');
      if (replacing) replacement?.classList.add('hidden');
      setOpen(false);
      /** @type {HTMLButtonElement | null} */ (root.querySelector('.slot-add'))?.focus({ preventScroll: true });
    };
    cancel.addEventListener('click', close);
    reveal.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(); }
    });
    const Observer = document.defaultView?.MutationObserver;
    if (Observer) {
      const observer = new Observer(sync);
      for (const node of nodes) observer.observe(node, { attributes: true, subtree: true, attributeFilter: ['class', 'disabled'] });
    }
    title.dataset.i18n = 'settings.slots.addTitle';
    title.dataset.i18nParams = JSON.stringify({ provider: options.label || options.provider });
    title.textContent = t(title.dataset.i18n, { provider: options.label || options.provider });
    sync();
    return { sync, hasDraft: () => ownerOpen, toggle() {
      sync();
      if (!ownerOpen) return false;
      collapsed = !collapsed;
      setOpen(true);
      return true;
    }, focus() {
      if (reveal.contains(document.activeElement)) return;
      const target = [.../** @type {NodeListOf<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>} */ (card.querySelectorAll('input, textarea, select, button'))].find(node => !node.disabled && !node.closest('.hidden'));
      target?.focus();
    },
    /** @param {boolean} replace */
    open(replace) {
      replacing = replace;
      card.classList.toggle('is-replacing', Boolean(replace && replacement));
      title.dataset.i18n = `settings.slots.${replace ? 'replaceTitle' : 'addTitle'}`;
      title.dataset.i18nParams = JSON.stringify({ provider: options.label || options.provider });
      title.textContent = t(title.dataset.i18n, { provider: options.label || options.provider });
      collapsed = false;
      setOpen(true);
    } };
  }
  return { create, readingFor };
});
