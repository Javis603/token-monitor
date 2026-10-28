'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginMainPages = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Capability alone never creates navigation. Placement is an explicit choice.
  function entries(catalog) {
    return (catalog?.plugins || []).filter(plugin => plugin.status === 'active').flatMap(plugin =>
      (plugin.views || []).filter(view => view.surfaces.includes('page') && view.placements?.page === true)
        .map(view => ({ ...view, id: `plugin:${view.ref}`, pluginName: plugin.name })));
  }
  function create({ document, container, headingContainer, actionsContainer, host, t, openWindow, formatError = error => t('settings.plugins.actionFailed', { error: error.message || String(error) }) }) {
    const retained = new Map(), errors = new WeakMap();
    let selection = null, generation = 0;
    if (document.defaultView) {
      // Input modality controls the focus ring, never the focused element.
      // OS window switching does not reliably emit renderer key events.
      document.addEventListener('pointerdown', () => document.documentElement.classList.add('plugin-pointer-focus'), true);
      document.addEventListener('keydown', () => document.documentElement.classList.remove('plugin-pointer-focus'), true);
    }
    return {
      render(pages, selected) {
        if (selected !== selection) {
          selection = selected; generation++;
          for (const {node, detach} of retained.values()) {
            errors.delete(node);
            node.querySelector('.plugin-action-error')?.remove();
            detach.removeAttribute('aria-describedby');
          }
        }
        const valid = new Set(pages.map(page => page.ref));
        for (const [ref, {node, content, header, actions}] of retained) if (!valid.has(ref)) { host.unmount(content); node.remove(); header.remove(); actions.remove(); retained.delete(ref); }
        for (const {node, header, actions} of retained.values()) { node.classList.add('hidden'); header.classList.add('hidden'); actions.classList.add('hidden'); }
        const page = pages.find(entry => entry.id === selected);
        container.classList.toggle('hidden', !page);headingContainer.classList.toggle('hidden', !page);actionsContainer.classList.toggle('hidden', !page);
        if (page) {
          let record = retained.get(page.ref);
          if (!record) {
            const node = document.createElement('section'); node.className = 'plugin-main-page'; node.tabIndex = -1; node.dataset.pluginRef = page.ref;
            const header = document.createElement('header'); header.className = 'plugin-main-heading';
            const heading = document.createElement('h2'); heading.tabIndex = -1;
            const detach = document.createElement('button'); detach.type = 'button'; detach.className = 'plugin-main-detach';
            detach.addEventListener('click', async () => {
              if (detach.disabled) return;
              const started = generation, restoreFocus = document.activeElement === detach;
              errors.delete(node); node.querySelector('.plugin-action-error')?.remove();
              detach.removeAttribute('aria-describedby');
              detach.disabled = true; detach.setAttribute('aria-busy', 'true');
              try { await openWindow(page.ref); }
              catch (error) {
                if (started !== generation || retained.get(page.ref)?.node !== node) return;
                errors.set(node, error);
                const notice = document.createElement('p'); notice.className = 'plugin-action-error';
                notice.id = `plugin-open-error-${encodeURIComponent(page.ref)}`;
                notice.setAttribute('role', 'alert'); notice.setAttribute('aria-atomic', 'true');
                notice.textContent = formatError(error); node.append(notice);
                detach.setAttribute('aria-describedby', notice.id);
              } finally {
                detach.disabled = false; detach.setAttribute('aria-busy', 'false');
                if (restoreFocus && started === generation && retained.get(page.ref)?.node === node
                  && document.activeElement === document.body) detach.focus({ preventScroll: true });
              }
            });
            const actions = document.createElement('div'); actions.className = 'plugin-main-actions';
            const headerActions = document.createElement('div'); headerActions.className = 'plugin-header-actions';
            header.append(heading); actions.append(headerActions, detach);
            const content = document.createElement('div'); content.className = 'plugin-main-content';
            node.append(content); container.append(node); headingContainer.append(header); actionsContainer.append(actions);
            record = {node, content, header, heading, detach, actions}; retained.set(page.ref, record);
            host.mount(content, page.ref, 'page', { retainDrafts: true, headerActions });
          }
          const {node, header, heading, detach, actions} = record;
          heading.textContent = page.title;node.setAttribute('aria-label', page.title);
          if (errors.has(node)) node.querySelector('.plugin-action-error').textContent = formatError(errors.get(node));
          if (!detach.children.length) {
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('viewBox', '0 0 24 24');icon.setAttribute('aria-hidden', 'true');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5');
            icon.append(path);detach.append(icon);
          }
          detach.setAttribute('aria-label', t('plugins.page.detachNamed', { name: page.title }));
          node.classList.remove('hidden');header.classList.remove('hidden');actions.classList.remove('hidden');
        }
        host.refreshDemand();
        return Boolean(page);
      }
    };
  }
  return { entries, create };
});
