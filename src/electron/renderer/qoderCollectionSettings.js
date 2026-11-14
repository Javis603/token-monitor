'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorQoderCollectionSettings = api;
})(typeof window !== 'undefined' ? window : null, function createQoderCollectionSettings() {
  function create({ document, t, editions, clients, separate, hidden, pinned, visibilityIcon, pinIcon, onTrack, onSeparate, onVisibility, onPin, formatTime }) {
    const container = document.createElement('div');
    container.className = 'qoder-collection-settings';
    const tracked = new Set(String(clients || '').split(','));
    const states = [...new Set(editions.filter(edition => tracked.has(edition.id)).map(edition => edition.collection.state))];
    if (states.length <= 1) {
      const summary = document.createElement('div');
      summary.className = 'tool-health-group-summary';
      summary.textContent = t(`settings.tools.health.sync.${states[0] || 'notTracked'}`);
      container.append(summary);
    }
    const toggle = (id, label, checked, onChange) => {
      const row = document.createElement('label');
      row.className = 'checkbox-label codex-dots-setting';
      const text = document.createElement('span');
      text.textContent = label;
      const input = document.createElement('input');
      input.id = id;
      input.type = 'checkbox';
      input.checked = checked;
      input.addEventListener('change', async () => {
        input.disabled = true;
        const next = input.checked;
        try { await onChange(next); }
        catch (_) { input.checked = !next; }
        finally { input.disabled = false; }
      });
      row.append(text, input);
      return row;
    };
    for (const edition of editions) {
      const { id } = edition;
      const name = id === 'qoder' ? t('settings.tools.qoder.global') : 'CN';
      const line = document.createElement('div');
      line.className = 'qoder-edition-control';
      const label = states.length > 1 && tracked.has(id) ? `${name} · ${t(`settings.tools.health.sync.${edition.collection.state}`)}` : name;
      const track = toggle(`toolTrackEnabled-${id}`, label, tracked.has(id), checked => onTrack(id, checked));
      const actions = document.createElement('div');
      actions.className = 'qoder-edition-controls';
      const action = (kind, selected, icon, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = `qoderEdition${kind === 'visibility' ? 'Visibility' : 'Pin'}-${id}`;
        button.className = kind === 'visibility' ? `tool-visibility-button${selected ? ' is-hidden' : ''}` : `tool-pin-button${selected ? ' is-pinned' : ''}`;
        button.setAttribute('aria-label', t(kind === 'visibility'
          ? selected ? 'settings.tools.showClient' : 'settings.tools.hideClient'
          : selected ? 'settings.tools.unpinClient' : 'settings.tools.pinClient', { name: `Qoder ${name}` }));
        button.setAttribute('aria-pressed', String(kind === 'visibility' ? !selected : selected));
        button.append(icon);
        button.addEventListener('click', () => onClick(id));
        return button;
      };
      actions.append(action('visibility', hidden.has(id), visibilityIcon(hidden.has(id)), onVisibility), action('pin', pinned.has(id), pinIcon(), onPin));
      line.append(track, actions);
      const editionRow = document.createElement('div');
      editionRow.className = 'qoder-edition';
      editionRow.append(line);
      for (const [field, key] of [['lastAttemptAt', 'settings.tools.health.lastAttempt'], ['lastSuccessAt', 'settings.tools.health.lastSuccess']]) {
        const stamp = edition.collection[field];
        if (!stamp) continue;
        const meta = document.createElement('div');
        meta.className = 'tool-health-group-meta';
        meta.textContent = t(key, { time: formatTime(stamp) });
        editionRow.append(meta);
      }
      container.append(editionRow);
    }
    container.append(toggle('qoderSeparateDisplay', t('settings.tools.qoder.separate'), separate, onSeparate));
    const hint = document.createElement('p');
    hint.className = 'settings-note';
    hint.textContent = t('settings.tools.qoder.displayOnly');
    container.append(hint);
    return container;
  }
  return { create };
});
