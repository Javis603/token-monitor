'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) root.TokenMonitorAccountLinkPanel = api;
})(typeof window !== 'undefined' ? window : null, function accountLinkPanelApi() {
  const memberId = (scope, key) => JSON.stringify([scope, key]);

  function createAccountLinkPanel({ document, t, provider, label, save }) {
    const root = document.createElement('div');
    root.className = 'account-link-panel';
    root.hidden = true;
    const tr = (key, params) => t(`settings.slots.accountLink.${key}`, params);
    let input;
    let signature = '';
    let pending = false;
    let failed = false;

    async function submit(operation, pair, button) {
      if (pending) return;
      pending = true;
      failed = false;
      render();
      try {
        failed = !(await save({ revision: input.revision, operation, pair }))?.ok;
      } catch (_) {
        failed = true;
      }
      pending = false;
      render();
      if (document.activeElement === document.body) {
        const action = [...root.querySelectorAll('button')].find(next => next.dataset.pair === button.dataset.pair);
        action?.focus({ preventScroll: true });
      }
    }

    function render() {
      root.replaceChildren();
      root.hidden = true;
      if (!Number.isSafeInteger(input?.revision)) return;
      const { candidates, links, labels, devices } = input;
      const members = new Map(candidates.map(row => [memberId(row.scope, row.accountKey), row]));
      const occupied = new Set(links.flatMap(pair => pair.keys.map(key => memberId(pair.scope, key))));
      const deviceNames = new Map(devices.map(({ deviceId, name }) => [deviceId, name]));
      const location = row => deviceNames.get(row.deviceId) || row.deviceId;
      const shortKey = key => `#${key.slice(7, 13)}`;
      const nameOf = row => labels[row.labelKey]?.trim() || '';
      const describe = pair => {
        const rows = pair.keys.map(key => members.get(memberId(pair.scope, key)));
        const accounts = pair.keys.map((key, index) => {
          const row = rows[index];
          if (!row) return labels[key] || shortKey(key);
          const name = nameOf(row) || shortKey(key);
          const device = location(row);
          const ambiguous = candidates.some(other => other !== row && other.scope === row.scope
            && location(other) === device && nameOf(other).toLowerCase() === name.toLowerCase());
          return `${name} (${device}${ambiguous ? ` · ${shortKey(key)}` : ''})`;
        });
        const region = rows.find(Boolean)?.region;
        const site = region === 'global' ? 'Global' : region?.toUpperCase();
        return { first: accounts[0], second: accounts[1], provider: site ? `${label} · ${site}` : label };
      };
      function line(pair, operation) {
        const item = document.createElement('div');
        item.className = 'account-link-action';
        const description = document.createElement('p');
        description.className = 'settings-note';
        description.textContent = tr(operation === 'link' ? 'confirm' : 'linked', describe(pair));
        const actions = document.createElement('div');
        actions.className = 'settings-actions';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = tr(operation);
        button.disabled = pending;
        button.dataset.pair = JSON.stringify([pair.scope, pair.keys]);
        button.setAttribute('aria-description', description.textContent);
        button.addEventListener('click', () => submit(operation, pair, button));
        actions.append(button);
        item.append(description, actions);
        root.append(item);
      }
      for (const pair of links) line(pair, 'split');
      const groups = new Map();
      for (const row of candidates) {
        const name = nameOf(row).toLowerCase();
        if (!name || occupied.has(memberId(row.scope, row.accountKey))) continue;
        const group = JSON.stringify([row.scope, name]);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(row);
      }
      for (const rows of groups.values()) {
        for (const [index, a] of rows.entries()) {
          for (const b of rows.slice(index + 1)) {
            if (a.deviceId === b.deviceId) continue;
            line({ provider, scope: a.scope, keys: [a.accountKey, b.accountKey].sort() }, 'link');
          }
        }
      }
      if (failed) {
        const error = document.createElement('p');
        error.className = 'settings-note';
        error.setAttribute('role', 'alert');
        error.textContent = tr('failed');
        root.append(error);
      }
      root.hidden = !root.childElementCount;
    }

    return {
      element: root,
      update(next) {
        const key = JSON.stringify(next);
        if (key === signature) return;
        signature = key;
        input = next;
        render();
      }
    };
  }
  return { createAccountLinkPanel };
});
