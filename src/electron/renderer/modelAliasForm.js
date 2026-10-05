'use strict';

(function exposeModelAliasForm(root, factory) {
  const aliases = typeof module === 'object' && module.exports ? require('./modelAliases') : root.TokenMonitorModelAliases;
  const api = factory(aliases);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorModelAliasForm = api;
})(typeof window !== 'undefined' ? window : null, function createModelAliasFormApi(aliasesApi) {
  function createModelAliasForm({ document, t, getAliases, getBase, getGrouping, getModelIds = () => [], saveAliases }) {
    const el = (suffix) => document.getElementById(`modelAliases${suffix}`);
    let editingAlias;
    let displayed;
    let editSnapshot;
    let busy = false;
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
        // Native select popups close when options are replaced. Apply pending
        // choices on blur so live collection does not interrupt a selection.
        if (busy || (!blurred && document.activeElement === select) || optionsKey === currentOptionsKey()) return;
        const draft = input.value;
        const manual = select.value === '__manual__';
        populate(value(), manual);
        if (manual || select.value !== '__manual__') input.value = draft;
      }
      select.addEventListener('blur', () => refresh(true));
      return {
        value, populate, select, input, refresh,
        focus: () => (select.value === '__manual__' ? input : select).focus()
      };
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
      row.append(field, remove);
      extraSources.push(source);
      el('MoreSources').append(row);
      source.picker.populate('');
      source.picker.focus();
    }
    const error = (key) => {
      el('Error').textContent = key ? t(key) : '';
      el('Error').classList.toggle('hidden', !key);
    };
    const close = () => {
      editingAlias = undefined;
      editSnapshot = null;
      el('Form').classList.add('hidden');
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
      el('Form').classList.remove('hidden');
      error('');
      aliasPicker.focus();
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
      if (!busy && !el('Form').classList.contains('hidden')) {
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
      el('List').replaceChildren();
      for (const [alias, canonical] of entries) {
        const row = document.createElement('div');
        row.className = 'managed-account-row custom-pricing-row';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'managed-account-main custom-pricing-edit';
        edit.title = t('settings.modelAliases.edit');
        edit.disabled = busy;
        const name = document.createElement('div');
        name.className = 'managed-account-email';
        name.textContent = alias;
        const target = document.createElement('div');
        target.className = 'managed-account-meta';
        target.textContent = `→ ${canonical}`;
        edit.append(name, target);
        edit.addEventListener('click', () => open(alias, canonical, snapshot));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'managed-account-remove custom-pricing-remove';
        remove.textContent = t('settings.modelAliases.remove');
        remove.disabled = busy;
        remove.addEventListener('click', () => persist(Object.fromEntries(entries.filter(([key]) => key !== alias)), snapshot.base));
        row.append(edit, remove);
        el('List').append(row);
      }
    }
    el('AddButton').addEventListener('click', () => open());
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
  return { createModelAliasForm };
});
