'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) root.TokenMonitorAccountLinkPanel = api;
})(typeof window !== 'undefined' ? window : null, function accountLinkPanelApi() {
  const memberId = (row, key = row.accountKey) => JSON.stringify([row.provider, row.scope, key]);

  function createAccountLinkPanel({ document, t, providerLabel, save, rename }) {
    const root = document.createElement('section');
    root.className = 'settings-subgroup settings-page-card account-link-panel';
    root.hidden = true;
    const tr = (key, params) => t(`settings.slots.accountLink.${key}`, params);
    let input;
    let signature = '';
    let confirmation;
    let pending = false;
    let failed = false;
    let editingNames = false;

    function actionButton(label, action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = pending;
      button.addEventListener('click', action);
      return button;
    }

    async function submit(action) {
      pending = true;
      failed = false;
      render();
      try { failed = !(await action())?.ok; }
      catch (_) { failed = true; }
      pending = false;
      confirmation = undefined;
      render();
      root.querySelector('button, summary')?.focus({ preventScroll: true });
    }

    function render() {
      root.replaceChildren();
      root.hidden = true;
      if (!Number.isSafeInteger(input?.revision)) return;
      const { revision, candidates, links, presentation, devices } = input;
      const members = new Map(candidates.map(row => [memberId(row), row]));
      const occupied = new Set(links.flatMap(pair => pair.keys.map(key => memberId(pair, key))));
      const label = row => presentation[row?.provider]?.labels?.[row?.labelKey] || '';
      const location = row => {
        const device = devices.find(device => device.deviceId === row.deviceId);
        return device?.hostname || row.deviceId;
      };
      const shortKey = key => `#${key.slice(7, 13)}`;
      const title = row => {
        const provider = providerLabel(row.provider);
        return row.region ? `${provider} · ${row.region === 'global' ? 'Global' : row.region.toUpperCase()}` : provider;
      };
      const describe = pair => {
        const accounts = pair.keys.map(key => {
          const row = members.get(memberId(pair, key));
          const name = label(row) || presentation[pair.provider]?.labels?.[key] || shortKey(key);
          return row ? `${name} (${location(row)})` : name;
        });
        const row = pair.keys.map(key => members.get(memberId(pair, key))).find(Boolean);
        return { first: accounts[0], second: accounts[1], provider: row ? title(row) : providerLabel(pair.provider) };
      };
      function line(pair, message, actionLabel, action, cancel) {
        const section = document.createElement('section');
        section.className = 'slot-editor';
        section.dataset.provider = pair.provider;
        const description = document.createElement('p');
        description.className = 'settings-note';
        description.textContent = tr(message, describe(pair));
        const actions = document.createElement('div');
        actions.className = 'settings-actions';
        const primary = actionButton(tr(actionLabel), action);
        actions.append(primary);
        if (cancel) actions.append(actionButton(tr('cancel'), cancel));
        section.append(description, actions);
        root.append(section);
        return primary;
      }
      for (const pair of links) {
        line(pair, 'linked', 'split', () => submit(() => save({ revision, operation: 'split', pair })));
      }
      const lanes = new Map();
      for (const row of candidates) {
        const lane = JSON.stringify([row.provider, row.scope]);
        if (!lanes.has(lane)) lanes.set(lane, []);
        lanes.get(lane).push(row);
      }
      const nameable = [];
      for (const lane of lanes.values()) {
        if (new Set(lane.map(row => row.deviceId)).size < 2) continue;
        nameable.push(...lane);
        const byName = new Map();
        for (const row of lane) {
          const name = label(row).trim().toLowerCase();
          if (!name || occupied.has(memberId(row))) continue;
          if (!byName.has(name)) byName.set(name, []);
          byName.get(name).push(row);
        }
        for (const group of byName.values()) {
          for (const [index, a] of group.entries()) {
            for (const b of group.slice(index + 1)) {
              if (a.deviceId === b.deviceId) continue;
              const pair = { provider: a.provider, scope: a.scope, keys: [a.accountKey, b.accountKey].sort() };
              const id = JSON.stringify(pair);
              if (confirmation === id) {
                const button = line(pair, 'confirm', 'link', () => submit(() => save({ revision, operation: 'link', pair })),
                  () => { confirmation = undefined; render(); root.querySelector('button')?.focus({ preventScroll: true }); });
                button.dataset.confirmLink = '';
              } else {
                line(pair, 'suggestion', 'review', () => {
                  confirmation = id;
                  render();
                  root.querySelector('[data-confirm-link]')?.focus({ preventScroll: true });
                });
              }
            }
          }
        }
      }
      if (nameable.length) {
        const details = document.createElement('details');
        details.className = 'slot-editor';
        details.open = editingNames;
        details.addEventListener('toggle', () => {
          if (details.isConnected) editingNames = details.open;
        });
        const summary = document.createElement('summary');
        summary.textContent = tr('names');
        details.append(summary);
        for (const row of nameable) {
          const form = document.createElement('form');
          form.className = 'settings-item';
          const field = document.createElement('label');
          field.className = 'settings-item-text';
          const caption = document.createElement('span');
          caption.className = 'settings-item-title';
          caption.textContent = `${title(row)} · ${location(row)} · ${shortKey(row.accountKey)}`;
          const name = document.createElement('input');
          name.className = 'credential-input';
          name.maxLength = 80;
          name.value = label(row);
          name.placeholder = tr('name');
          name.disabled = pending;
          field.append(caption, name);
          const actions = document.createElement('div');
          actions.className = 'settings-actions';
          const button = actionButton(tr('save'), () => form.requestSubmit());
          const syncButton = () => { button.disabled = pending || name.value.trim() === label(row); };
          name.addEventListener('input', syncButton);
          syncButton();
          actions.append(button);
          form.addEventListener('submit', event => {
            event.preventDefault();
            if (!button.disabled) void submit(() => rename(row, name.value));
          });
          form.append(field, actions);
          details.append(form);
        }
        root.append(details);
      }
      if (failed) {
        const error = document.createElement('p');
        error.className = 'settings-note';
        error.setAttribute('role', 'alert');
        error.textContent = tr('failed');
        root.append(error);
      }
      if (!root.childElementCount) return;
      const heading = document.createElement('div');
      heading.className = 'settings-group-header';
      heading.textContent = tr('title');
      root.prepend(heading);
      root.hidden = false;
    }

    return {
      element: root,
      update(next) {
        const key = JSON.stringify(next);
        if (key === signature) return;
        if (next.revision !== input?.revision) confirmation = undefined;
        signature = key;
        input = next;
        render();
      }
    };
  }
  return { createAccountLinkPanel };
});
