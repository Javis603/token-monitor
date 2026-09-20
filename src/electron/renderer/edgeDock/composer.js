'use strict';

// Settings composer for the edge dock's contents. It borrows the tray
// composer's idea (a live strip you drag to reorder, click to configure and
// extend with +) but is laid out for the dock: a vertical miniature rail on the
// left, the selected item's options on the right.
(function exposeEdgeDockComposer(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorEdgeDockComposer = api;
})(typeof window !== 'undefined' ? window : null, function createEdgeDockComposerApi() {
  function createEdgeDockComposer(deps) {
    const {
      root,
      t,
      itemsApi,
      presentationApi,
      getSettings,
      getStats,
      save,
      providerLabel,
      providerColor,
      hasProviderMark,
      maskEmail,
      createRowDrag
    } = deps;

    // Selection and the open add menu live here rather than in the DOM, because
    // every settings save repaints the whole form.
    const ui = { selected: '', menuOpen: false };
    let drag = null;

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function storedItems() {
      return itemsApi.normalizeEdgeDockItems(getSettings()?.edgeDockItems);
    }

    function isAutomatic() {
      return storedItems() === null;
    }

    function limitOptions() {
      const settings = getSettings() || {};
      return {
        limitsEnabled: settings.limitsEnabled !== false,
        limitProviders: settings.limitProviders,
        limitProviderOrder: settings.limitProviderOrder
      };
    }

    function connectedProviders() {
      return presentationApi.connectedLimitProviders(getStats(), limitOptions());
    }

    // What the dock shows right now: the stored list, or the automatic default
    // materialized from the current stats.
    function effectiveItems() {
      return storedItems() ?? itemsApi.defaultEdgeDockItems(connectedProviders());
    }

    function persist(items) {
      return save({ edgeDockItems: items });
    }

    function updateItem(id, change) {
      const items = effectiveItems().map((item) => (itemsApi.itemId(item) === id ? { ...item, ...change } : item));
      return persist(items);
    }

    function accountsFor(provider) {
      const providers = Array.isArray(getStats()?.limits?.providers) ? getStats().limits.providers : [];
      const seen = new Set();
      return providers
        .filter((record) => String(record?.provider || '').toLowerCase() === provider && record.accountKey)
        .filter((record) => {
          if (seen.has(record.accountKey)) return false;
          seen.add(record.accountKey);
          return true;
        });
    }

    function itemLabel(item) {
      if (item.type === 'stat') {
        if (item.metric === 'liveRate') return t('edgeDock.stat.liveRate');
        if (item.metric === itemsApi.SESSIONS_METRIC) return t('edgeDock.sessions');
        return t(`edgeDock.period.${item.metric}`);
      }
      return providerLabel(item.provider);
    }

    function markFor(item, className = 'edge-dock-composer-mark') {
      const mark = el('span', className);
      if (item.type === 'stat') {
        mark.classList.add('is-stat');
        mark.textContent = item.metric === 'liveRate'
          ? t('edgeDock.statGlyph.liveRate')
          : item.metric === itemsApi.SESSIONS_METRIC
            ? t('edgeDock.statGlyph.sessions')
            : t(`edgeDock.periodShort.${item.metric}`);
        return mark;
      }
      if (hasProviderMark(item.provider)) mark.classList.add(`row-icon-${item.provider}`);
      else mark.classList.add('is-fallback');
      mark.style.setProperty('--composer-color', providerColor(item.provider));
      return mark;
    }

    function railItem(item, count) {
      const id = itemsApi.itemId(item);
      const button = el('button', 'edge-dock-composer-item');
      button.type = 'button';
      button.dataset.itemId = id;
      button.classList.toggle('is-selected', ui.selected === id);
      button.classList.toggle('is-stat', item.type === 'stat');
      button.title = itemLabel(item);
      button.setAttribute('aria-label', itemLabel(item));
      button.setAttribute('aria-pressed', String(ui.selected === id));
      button.append(markFor(item));
      button.addEventListener('click', () => {
        ui.selected = ui.selected === id ? '' : id;
        ui.menuOpen = false;
        render();
      });
      if (count > 1) button.addEventListener('pointerdown', (event) => drag?.startRowDrag(event, id));
      return button;
    }

    function addMenu(items) {
      const menu = el('div', 'edge-dock-composer-menu');
      const present = new Set(items.map((item) => itemsApi.itemId(item)));
      const section = (titleKey, entries) => {
        if (!entries.length) return;
        const group = el('div', 'edge-dock-composer-menu-group');
        group.append(el('div', 'edge-dock-composer-menu-title', t(titleKey)));
        for (const item of entries) {
          const option = el('button', 'edge-dock-composer-menu-option');
          option.type = 'button';
          // Usage entries are named in full here, so their rail glyph would only repeat it.
          if (item.type === 'limit') option.append(markFor(item, 'edge-dock-composer-mark is-small'));
          option.append(el('span', '', itemLabel(item)));
          option.addEventListener('click', () => {
            ui.menuOpen = false;
            ui.selected = itemsApi.itemId(item);
            void persist([...items, item]);
          });
          group.append(option);
        }
        menu.append(group);
      };
      section('settings.edgeDock.addLimits', connectedProviders()
        .map((provider) => ({ type: 'limit', provider, hiddenAccounts: [], showUsage: true }))
        .filter((item) => !present.has(itemsApi.itemId(item))));
      section('settings.edgeDock.addUsage', itemsApi.STAT_METRICS
        .filter((metric) => metric !== itemsApi.SESSIONS_METRIC)
        .map((metric) => ({ type: 'stat', metric }))
        .filter((item) => !present.has(itemsApi.itemId(item))));
      // Sessions is its own section rather than another usage figure: it lists
      // the tracked clients' work, not a period's spend, and it is the only
      // item that can show a client with no limits provider.
      section('settings.edgeDock.addSessions', present.has(itemsApi.itemId({ type: 'stat', metric: itemsApi.SESSIONS_METRIC }))
        ? []
        : [{ type: 'stat', metric: itemsApi.SESSIONS_METRIC, runningOnly: false, groupBy: 'none' }]);
      if (!menu.childElementCount) menu.append(el('div', 'edge-dock-composer-empty', t('settings.edgeDock.nothingToAdd')));
      return menu;
    }

    function switchRow(titleKey, checked, onChange) {
      const label = el('label', 'checkbox-label settings-item edge-dock-composer-switch');
      const text = el('span', 'settings-item-text');
      text.append(el('span', 'settings-item-title', t(titleKey)));
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      label.append(text, input);
      return label;
    }

    function choiceRow(titleKey, value, choices, onChange) {
      const row = el('div', 'settings-item edge-dock-composer-choice');
      const text = el('span', 'settings-item-text');
      text.append(el('span', 'settings-item-title', t(titleKey)));
      const options = el('span', 'inline-options');
      for (const choice of choices) {
        const label = el('label', 'inline-option');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `edgeDock-${ui.selected}-${titleKey}`;
        input.value = choice.value;
        input.checked = value === choice.value;
        input.addEventListener('change', () => {
          if (input.checked) onChange(input.value);
        });
        label.append(input, el('span', '', t(choice.labelKey)));
        options.append(label);
      }
      row.append(text, options);
      return row;
    }

    function detail(items) {
      const pane = el('div', 'edge-dock-composer-detail');
      if (ui.menuOpen) {
        pane.append(addMenu(items));
        return pane;
      }
      const item = items.find((entry) => itemsApi.itemId(entry) === ui.selected);
      if (!item) {
        pane.append(el('p', 'edge-dock-composer-hint', t(isAutomatic()
          ? 'settings.edgeDock.automaticHint'
          : (items.length ? 'settings.edgeDock.selectHint' : 'settings.edgeDock.emptyHint'))));
        return pane;
      }
      const id = itemsApi.itemId(item);
      const head = el('div', 'edge-dock-composer-detail-head');
      head.append(markFor(item, 'edge-dock-composer-mark is-small'), el('span', 'edge-dock-composer-detail-title', itemLabel(item)));
      const remove = el('button', 'edge-dock-composer-remove', t('settings.edgeDock.remove'));
      remove.type = 'button';
      remove.addEventListener('click', () => {
        ui.selected = '';
        void persist(items.filter((entry) => itemsApi.itemId(entry) !== id));
      });
      head.append(remove);
      pane.append(head);

      if (item.type === 'stat') {
        if (item.metric === itemsApi.SESSIONS_METRIC) {
          pane.append(el('p', 'edge-dock-composer-hint', t('settings.edgeDock.statNote.sessions')));
          pane.append(switchRow('settings.edgeDock.runningOnly', item.runningOnly === true, (checked) => {
            void updateItem(id, { runningOnly: checked });
          }));
          pane.append(choiceRow('settings.edgeDock.groupBy', item.groupBy === 'client' ? 'client' : 'none', [
            { value: 'none', labelKey: 'settings.edgeDock.groupBy.none' },
            { value: 'client', labelKey: 'settings.edgeDock.groupBy.client' }
          ], (groupBy) => {
            void updateItem(id, { groupBy });
          }));
          // What the rail cell's third line carries. Only the cell changes: the
          // card is the same list either way, which is why this is named after the
          // rail rather than the item.
          pane.append(choiceRow('settings.edgeDock.cellDetail', item.cellDetail === 'rate' ? 'rate' : 'clients', [
            { value: 'clients', labelKey: 'settings.edgeDock.cellDetail.clients' },
            { value: 'rate', labelKey: 'settings.edgeDock.cellDetail.rate' }
          ], (cellDetail) => {
            void updateItem(id, { cellDetail });
          }));
          return pane;
        }
        const noteKey = item.metric === 'liveRate'
          ? 'settings.edgeDock.statNote.liveRate'
          : itemsApi.DERIVED_PERIODS.includes(item.metric)
            ? 'settings.edgeDock.statNote.derived'
            : 'settings.edgeDock.statNote.usage';
        pane.append(el('p', 'edge-dock-composer-hint', t(noteKey)));
        return pane;
      }
      pane.append(switchRow('settings.edgeDock.showUsage', item.showUsage !== false, (checked) => {
        void updateItem(id, { showUsage: checked });
      }));
      pane.append(switchRow('settings.edgeDock.showSessions', item.showSessions !== false, (checked) => {
        void updateItem(id, { showSessions: checked });
      }));
      if (item.provider === 'codex') {
        pane.append(choiceRow('settings.edgeDock.limitValue', item.accountMode === 'lowest' ? 'lowest' : 'active', [
          { value: 'active', labelKey: 'trayComposer.account.active' },
          { value: 'lowest', labelKey: 'trayComposer.account.lowest' }
        ], (accountMode) => {
          void updateItem(id, { accountMode });
        }));
      }
      const accounts = accountsFor(item.provider);
      if (accounts.length > 1) {
        const hidden = new Set(item.hiddenAccounts || []);
        const group = el('div', 'edge-dock-composer-accounts');
        group.append(el('div', 'edge-dock-composer-menu-title', t('settings.edgeDock.accounts')));
        for (const account of accounts) {
          const label = el('label', 'edge-dock-composer-account');
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = !hidden.has(account.accountKey);
          input.addEventListener('change', () => {
            const next = new Set(item.hiddenAccounts || []);
            if (input.checked) next.delete(account.accountKey);
            else next.add(account.accountKey);
            void updateItem(id, { hiddenAccounts: [...next] });
          });
          const name = account.accountName || maskEmail(account.accountEmail) || account.planLabel || providerLabel(item.provider);
          const text = el('span', 'edge-dock-composer-account-name', name);
          const plan = account.planLabel && name !== account.planLabel ? el('span', 'edge-dock-composer-account-plan', account.planLabel) : null;
          label.append(input, text);
          if (plan) label.append(plan);
          group.append(label);
        }
        pane.append(group);
      }
      return pane;
    }

    function render() {
      if (!root) return;
      if (drag?.deferRender()) return;
      const items = effectiveItems();
      if (ui.selected && !items.some((item) => itemsApi.itemId(item) === ui.selected)) ui.selected = '';

      const heading = el('div', 'edge-dock-composer-heading');
      heading.append(el('span', '', t('settings.edgeDock.items')));
      const actions = el('span', 'edge-dock-composer-heading-actions');
      actions.append(el('span', 'edge-dock-composer-heading-hint', t('settings.edgeDock.itemsHint')));
      if (!isAutomatic()) {
        const reset = el('button', 'edge-dock-composer-reset', t('settings.edgeDock.reset'));
        reset.type = 'button';
        reset.addEventListener('click', () => {
          ui.selected = '';
          ui.menuOpen = false;
          void persist(null);
        });
        actions.append(reset);
      }
      heading.append(actions);

      const body = el('div', 'edge-dock-composer-body');
      const rail = el('div', 'edge-dock-composer-rail');
      for (const item of items) rail.append(railItem(item, items.length));
      const add = el('button', 'edge-dock-composer-add', '+');
      add.type = 'button';
      add.title = t('settings.edgeDock.add');
      add.setAttribute('aria-label', t('settings.edgeDock.add'));
      add.setAttribute('aria-expanded', String(ui.menuOpen));
      add.classList.toggle('is-open', ui.menuOpen);
      add.addEventListener('click', () => {
        ui.menuOpen = !ui.menuOpen;
        if (ui.menuOpen) ui.selected = '';
        render();
      });
      rail.append(add);
      body.append(rail, detail(items));
      root.replaceChildren(heading, body);
    }

    drag = createRowDrag({
      getList: () => root.querySelector('.edge-dock-composer-rail'),
      rowSelector: '.edge-dock-composer-item[data-item-id]',
      idKey: 'itemId',
      dragExcluded: '.edge-dock-composer-add',
      // Ids come back lower-cased from the drag sort; see reorderEdgeDockItems.
      applyOrder: (order) => {
        const rail = root.querySelector('.edge-dock-composer-rail');
        const add = rail?.querySelector('.edge-dock-composer-add');
        const nodes = new Map([...(rail?.querySelectorAll('[data-item-id]') || [])]
          .map((node) => [node.dataset.itemId.toLowerCase(), node]));
        for (const id of order) {
          const node = nodes.get(String(id).toLowerCase());
          if (node) rail.insertBefore(node, add);
        }
      },
      persistOrder: (order) => {
        void persist(itemsApi.reorderEdgeDockItems(effectiveItems(), order));
      },
      requestRender: () => render()
    });

    return { render };
  }

  return { createEdgeDockComposer };
});
