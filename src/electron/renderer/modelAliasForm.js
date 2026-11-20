'use strict';

(function exposeModelAliasForm(root, factory) {
  const aliases = typeof module === 'object' && module.exports ? require('./modelAliases') : root.TokenMonitorModelAliases;
  const menus = typeof module === 'object' && module.exports ? require('./actionMenu') : root.TokenMonitorActionMenu;
  const accountShell = typeof module === 'object' && module.exports ? require('./limits/accountShell') : root.TokenMonitorAccountShell;
  const api = factory(aliases, menus, accountShell);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorModelAliasForm = api;
})(typeof window !== 'undefined' ? window : null, function createModelAliasFormApi(aliasesApi, menus, accountShell) {
  function createModelSettingsMenu(document, { label, editLabel, removeLabel, edit, remove, disabled = false }) {
    function button(text, click, className) {
      const control = document.createElement('button');
      control.type = 'button';
      control.className = className || '';
      control.textContent = text;
      control.disabled = disabled;
      control.addEventListener('click', click);
      return control;
    }
    const menu = menus.create(document, label, button);
    const action = (text, kind, run, className) => {
      const item = button(text, () => {
        if (menu.popover.matches(':popover-open')) menu.close();
        return run();
      }, className);
      item.setAttribute('data-slot-action', kind);
      return item;
    };
    menu.appendItems(action(editLabel, 'rename', edit), action(removeLabel, 'remove', remove, 'menu-destructive'));
    return menu.element;
  }

  function createModelEditorDisclosure(form, addButton) {
    const editButtons = new Map();
    let editingModel;
    return {
      setOpen(open, model) {
        const previousEditButton = editButtons.get(editingModel);
        previousEditButton?.setAttribute('aria-expanded', 'false');
        editingModel = open ? model : undefined;
        addButton.setAttribute('aria-expanded', String(open && model === undefined));
        editButtons.get(editingModel)?.setAttribute('aria-expanded', 'true');
        accountShell.setDisclosureBody(previousEditButton ?? addButton, form, open);
      },
      resetRows() { editButtons.clear(); },
      trackRow(model, button) {
        editButtons.set(model, button);
        button.setAttribute('aria-controls', form.id);
        button.setAttribute('aria-expanded', String(model === editingModel));
      }
    };
  }

  function createModelAliasForm({ document, t, getAliases, getBase, getGrouping, getModelIds = () => [], saveAliases }) {
    const el = (suffix) => document.getElementById(`modelAliases${suffix}`);
    const form = el('Form');
    const addButton = el('AddButton');
    const disclosure = createModelEditorDisclosure(form, addButton);
    let editingAlias;
    let displayed;
    let editSnapshot;
    let busy = false;
    let renderedRowsKey;
    let sourceId = 0;
    const extraSources = [];
    const choices = () => aliasesApi.modelAliasChoices(getModelIds(), getAliases());
    function picker(select, input, label, caption) {
      function translate() {
        caption.textContent = t(label);
        select.setAttribute('aria-label', t(label));
        input.setAttribute('aria-label', t(label));
      }
      function syncMode() {
        const manual = select.value === '__manual__';
        input.classList.toggle('hidden', !manual);
        caption.setAttribute('for', manual ? input.id : select.id);
      }
      translate();
      let optionsKey;
      const currentOptionsKey = () => JSON.stringify([choices(), t('settings.customPricing.selectModel'), t('settings.customPricing.manualEntry'), t(label)]);
      const value = () => select.value === '__manual__' ? input.value : select.value.slice(6);
      function populate(id, manual = false) {
        translate();
        const ids = choices();
        optionsKey = currentOptionsKey();
        select.replaceChildren();
        const option = (key, text) => {
          const opt = document.createElement('option');
          opt.value = key;
          opt.textContent = text;
          select.append(opt);
        };
        option('', t('settings.customPricing.selectModel'));
        for (const model of ids) option(`model:${model}`, model);
        option('__manual__', t('settings.customPricing.manualEntry'));
        select.value = manual || (id && !ids.includes(id)) ? '__manual__' : id ? `model:${id}` : '';
        input.value = id;
        syncMode();
      }
      select.addEventListener('change', () => {
        syncMode();
        if (select.value === '__manual__') input.focus();
        error('');
      });
      function refresh(blurred = false) {
        translate();
        // Keep live collection from replacing choices while the picker is used.
        if (busy || (!blurred && (document.defaultView?.TokenMonitorSelectControl?.isFocused(select) || document.activeElement === select)) || optionsKey === currentOptionsKey()) return;
        const draft = input.value;
        const manual = select.value === '__manual__';
        populate(value(), manual);
        if (manual || select.value !== '__manual__') input.value = draft;
      }
      select.addEventListener('blur', () => refresh(true));
      const activeControl = () => select.value === '__manual__' ? input : select;
      return { value, populate, select, input, refresh, activeControl };
    }
    const aliasPicker = picker(el('AliasSelect'), el('AliasInput'), 'settings.modelAliases.alias', el('AliasLabel'));
    const canonicalPicker = picker(el('CanonicalSelect'), el('CanonicalInput'), 'settings.modelAliases.canonical', el('CanonicalLabel'));
    const allPickers = () => [aliasPicker, ...extraSources.map(source => source.picker), canonicalPicker];
    function addSource() {
      if (busy) return;
      const row = document.createElement('div');
      row.className = 'model-alias-source';
      const field = document.createElement('div');
      field.className = 'model-alias-field';
      const title = document.createElement('label');
      title.setAttribute('data-i18n', 'settings.modelAliases.alias');
      const select = document.createElement('select');
      const input = document.createElement('input');
      const id = `modelAliasesSource${++sourceId}`;
      select.id = `${id}Select`;
      input.id = `${id}Input`;
      input.type = 'text';
      input.maxLength = 256;
      input.spellcheck = false;
      input.placeholder = el('AliasInput').placeholder;
      field.append(title, select, input);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = t('settings.modelAliases.remove');
      remove.setAttribute('data-i18n', 'settings.modelAliases.remove');
      const source = { row, picker: picker(select, input, 'settings.modelAliases.alias', title), remove };
      remove.addEventListener('click', () => {
        if (busy) return;
        extraSources.splice(extraSources.indexOf(source), 1);
        row.remove();
        el('AddSourceButton').focus();
      });
      const actions = document.createElement('div');
      actions.className = 'settings-actions';
      actions.append(remove);
      row.append(field, actions);
      extraSources.push(source);
      el('MoreSources').append(row);
      source.picker.populate('');
      source.picker.activeControl().focus();
    }
    const error = (key) => {
      el('Error').textContent = key ? t(key) : '';
      el('Error').classList.toggle('hidden', !key);
    };
    const close = () => {
      editingAlias = undefined;
      editSnapshot = null;
      disclosure.setOpen(false);
      error('');
    };
    const open = (alias = '', canonical = '', snapshot = displayed) => {
      if (busy) return;
      editingAlias = alias || undefined;
      editSnapshot = snapshot;
      extraSources.length = 0;
      el('MoreSources').replaceChildren();
      aliasPicker.populate(alias);
      canonicalPicker.populate(canonical);
      const titleKey = editingAlias ? 'settings.modelAliases.edit' : 'settings.modelAliases.add';
      el('FormTitle').setAttribute('data-i18n', titleKey);
      el('FormTitle').textContent = t(titleKey);
      disclosure.setOpen(true, editingAlias);
      error('');
      accountShell.focusDisclosureControl(form, aliasPicker.activeControl());
    };
    async function persist(next, base) {
      if (busy) return;
      busy = true;
      for (const field of allPickers()) { field.select.disabled = true; field.input.disabled = true; }
      for (const source of extraSources) source.remove.disabled = true;
      for (const suffix of ['SaveButton', 'CancelButton', 'AddSourceButton']) el(suffix).disabled = true;
      render();
      error('');
      try {
        await saveAliases(next, base);
        close();
      } catch (_) {
        error('settings.modelAliases.saveError');
      } finally {
        busy = false;
        for (const field of allPickers()) { field.select.disabled = false; field.input.disabled = false; }
        for (const source of extraSources) source.remove.disabled = false;
        for (const suffix of ['SaveButton', 'CancelButton', 'AddSourceButton']) el(suffix).disabled = false;
        render();
      }
    }
    function render() {
      for (const source of extraSources) {
        source.remove.textContent = t('settings.modelAliases.remove');
        source.picker.input.placeholder = el('AliasInput').placeholder;
      }
      if (!busy && !form.classList.contains('hidden')) {
        for (const field of allPickers()) field.refresh();
      }
      // Pair the displayed collection and its revision once. A later status
      // push must not retarget a button or an already open edit to a newer base.
      const snapshot = { aliases: aliasesApi.normalizeModelAliases(getAliases()), base: getBase?.() };
      displayed = snapshot;
      const entries = Object.entries(snapshot.aliases);
      // The pill names the grouping mode rather than claiming "automatic", which read
      // as active even with grouping off and no aliases — the default state.
      const grouping = typeof getGrouping === 'function' ? getGrouping() : 'off';
      el('Status').textContent = entries.length
        ? t('settings.modelAliases.count', { count: entries.length })
        : t(`settings.modelAliases.grouping${grouping === 'prefix' ? 'Prefix' : grouping === 'duplicates' ? 'Duplicates' : 'Off'}`);
      const editLabel = t('settings.common.edit');
      const editDescription = t('settings.modelAliases.edit');
      const removeLabel = t('settings.modelAliases.remove');
      const rowsKey = JSON.stringify([entries, busy, snapshot.base?.identity, snapshot.base?.revisions?.modelAliases,
        editLabel, editDescription, removeLabel, t('settings.collection.modelActions')]);
      if (rowsKey === renderedRowsKey) return;
      renderedRowsKey = rowsKey;
      el('List').replaceChildren();
      disclosure.resetRows();
      for (const [alias, canonical] of entries) {
        const row = document.createElement('div');
        row.className = 'managed-account-row custom-pricing-row';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'managed-account-main custom-pricing-edit';
        edit.setAttribute('aria-description', editDescription);
        edit.disabled = busy;
        disclosure.trackRow(alias, edit);
        const name = document.createElement('div');
        name.className = 'managed-account-email';
        name.textContent = alias;
        const target = document.createElement('div');
        target.className = 'managed-account-meta';
        target.textContent = `→ ${canonical}`;
        const openEditor = () => open(alias, canonical, snapshot);
        edit.append(name, target);
        edit.addEventListener('click', openEditor);
        const menu = createModelSettingsMenu(document, {
          label: t('settings.collection.modelActions', { model: alias }),
          editLabel,
          removeLabel,
          edit: openEditor,
          remove: () => persist(Object.fromEntries(entries.filter(([key]) => key !== alias)), snapshot.base),
          disabled: busy
        });
        row.append(edit, menu);
        el('List').append(row);
      }
    }
    addButton.addEventListener('click', () => {
      if (busy) return;
      if (!editingAlias && !form.classList.contains('hidden')) close();
      else open();
    });
    el('AddSourceButton').addEventListener('click', addSource);
    el('CancelButton').addEventListener('click', () => { if (!busy) close(); });
    el('SaveButton').addEventListener('click', async () => {
      if (busy) return;
      const sources = [aliasPicker, ...extraSources.map(source => source.picker)].map(field => field.value());
      const snapshot = editSnapshot || displayed;
      const next = aliasesApi.upsertModelAliasBatch(snapshot.aliases, sources, canonicalPicker.value(), editingAlias);
      if (!next) { error('settings.modelAliases.invalid'); return; }
      await persist(next, snapshot.base);
    });
    render();
    return { syncSettings: render };
  }
  return { createModelAliasForm, createModelSettingsMenu, createModelEditorDisclosure };
});
