'use strict';

(function exposeModelAliasForm(root, factory) {
  const aliases = typeof module === 'object' && module.exports ? require('./modelAliases') : root.TokenMonitorModelAliases;
  const api = factory(aliases);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorModelAliasForm = api;
})(typeof window !== 'undefined' ? window : null, function createModelAliasFormApi(aliasesApi) {
  function createModelAliasForm({ document, t, getAliases, saveAliases }) {
    const el = (suffix) => document.getElementById(`modelAliases${suffix}`);
    let editingAlias;
    let busy = false;
    const error = (key) => {
      el('Error').textContent = key ? t(key) : '';
      el('Error').classList.toggle('hidden', !key);
    };
    const close = () => {
      editingAlias = undefined;
      el('Form').classList.add('hidden');
      error('');
    };
    const open = (alias = '', canonical = '') => {
      if (busy) return;
      editingAlias = alias || undefined;
      el('AliasInput').value = alias;
      el('CanonicalInput').value = canonical;
      el('Form').classList.remove('hidden');
      error('');
      el('AliasInput').focus();
    };
    async function persist(next) {
      if (busy) return;
      busy = true;
      el('SaveButton').disabled = true;
      error('');
      try {
        await saveAliases(next);
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
      const entries = Object.entries(aliasesApi.normalizeModelAliases(getAliases()));
      el('Status').textContent = entries.length ? t('settings.modelAliases.count', { count: entries.length }) : t('settings.modelAliases.none');
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
        edit.addEventListener('click', () => open(alias, canonical));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'managed-account-remove custom-pricing-remove';
        remove.textContent = t('settings.modelAliases.remove');
        remove.disabled = busy;
        remove.addEventListener('click', () => persist(Object.fromEntries(Object.entries(getAliases()).filter(([key]) => key !== alias))));
        row.append(edit, remove);
        el('List').append(row);
      }
    }
    el('AddButton').addEventListener('click', () => open());
    el('CancelButton').addEventListener('click', () => { if (!busy) close(); });
    el('SaveButton').addEventListener('click', async () => {
      if (busy) return;
      const next = aliasesApi.upsertModelAlias(getAliases(), el('AliasInput').value, el('CanonicalInput').value, editingAlias);
      if (!next) { error('settings.modelAliases.invalid'); return; }
      await persist(next);
    });
    render();
    return { syncSettings: render };
  }
  return { createModelAliasForm };
});
