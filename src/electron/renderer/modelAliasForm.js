'use strict';

(function exposeModelAliasForm(root, factory) {
  const aliases = typeof module === 'object' && module.exports ? require('./modelAliases') : root.TokenMonitorModelAliases;
  const api = factory(aliases);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorModelAliasForm = api;
})(typeof window !== 'undefined' ? window : null, function createModelAliasFormApi(aliasesApi) {
  function createModelAliasForm({ document, t, getAliases, getBase, getGrouping, saveAliases }) {
    const el = (suffix) => document.getElementById(`modelAliases${suffix}`);
    let editingAlias;
    let displayed;
    let editSnapshot;
    let busy = false;
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
      el('AliasInput').value = alias;
      el('CanonicalInput').value = canonical;
      el('Form').classList.remove('hidden');
      error('');
      el('AliasInput').focus();
    };
    async function persist(next, base) {
      if (busy) return;
      busy = true;
      el('SaveButton').disabled = true;
      error('');
      try {
        await saveAliases(next, base);
        close();
      } catch (_) {
        error('settings.modelAliases.saveError');
      } finally {
        busy = false;
        el('SaveButton').disabled = false;
        render();
      }
    }
    function render() {
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
    el('CancelButton').addEventListener('click', () => { if (!busy) close(); });
    el('SaveButton').addEventListener('click', async () => {
      if (busy) return;
      const next = aliasesApi.upsertModelAlias(editSnapshot?.aliases || displayed.aliases, el('AliasInput').value, el('CanonicalInput').value, editingAlias);
      if (!next) { error('settings.modelAliases.invalid'); return; }
      await persist(next, (editSnapshot || displayed).base);
    });
    render();
    return { syncSettings: render };
  }
  return { createModelAliasForm };
});
