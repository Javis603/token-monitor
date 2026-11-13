'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorQoderSettingsGroup = api;
})(typeof window !== 'undefined' ? window : null, function createQoderSettingsGroup() {
  function mount({ document, rows, checked, mixed, attention, separate, expanded, filtering, t, onTracking, onSeparate, onExpanded }) {
    const group = document.createElement('details');
    group.className = 'tool-preference-row qoder-settings-group';
    group.dataset.client = 'qoder';
    group.open = expanded || filtering;
    group.classList.toggle('is-filtered-out', rows.every(row => row.classList.contains('is-filtered-out')));
    const summary = document.createElement('summary');
    summary.className = 'qoder-group-summary';
    const track = document.createElement('input');
    track.type = 'checkbox';
    track.id = 'toolTrackGroup-qoder';
    track.checked = checked;
    track.indeterminate = mixed;
    track.setAttribute('aria-label', t('settings.tools.qoder.trackAll'));
    track.addEventListener('click', event => event.stopPropagation());
    track.addEventListener('change', () => onTracking(track.checked));
    const name = document.createElement('span');
    name.className = 'tool-preference-name';
    name.textContent = 'Qoder';
    const status = document.createElement('span');
    status.className = `tool-status-tag tool-status-tag-${attention ? 'warn' : 'ok'}`;
    status.textContent = t(attention ? 'settings.tools.status.attention' : mixed ? 'settings.tools.qoder.partial' : checked ? 'settings.tools.qoder.all' : 'settings.tools.health.sync.notTracked');
    summary.append(track, name, status);
    const chevron = document.createElement('span');
    chevron.className = 'cursor-disclosure-icon';
    chevron.setAttribute('aria-hidden', 'true');
    summary.append(chevron);
    const options = document.createElement('div');
    options.className = 'qoder-version-options';
    for (const row of rows) options.append(row);
    const splitLabel = document.createElement('label');
    splitLabel.className = 'qoder-separate-label';
    const split = document.createElement('input');
    split.type = 'checkbox';
    split.id = 'qoderSeparateDisplay';
    split.checked = separate;
    split.addEventListener('change', () => onSeparate(split.checked));
    const text = document.createElement('span');
    text.textContent = t('settings.tools.qoder.separate');
    splitLabel.append(split, text);
    const hint = document.createElement('p');
    hint.className = 'settings-note';
    hint.textContent = t('settings.tools.qoder.displayOnly');
    options.append(splitLabel, hint);
    group.append(summary, options);
    group.addEventListener('toggle', () => { if (!filtering) onExpanded(group.open); });
    return group;
  }
  return { mount };
});
