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
  function create({ document, container, host, t, openWindow, formatError = error => t('settings.plugins.actionFailed', { error: error.message || String(error) }) }) {
    const retained = new Map(), errors = new WeakMap();
    let selection = null, generation = 0;
    return {
      render(pages, selected) {
        if (selected !== selection) {
          selection = selected; generation++;
          for (const node of retained.values()) {
            errors.delete(node);
            node.querySelector('.plugin-action-error')?.remove();
            node.querySelector('button')?.removeAttribute('aria-describedby');
          }
        }
        const valid = new Set(pages.map(page => page.ref));
        for (const [ref, node] of retained) if (!valid.has(ref)) { node.remove(); retained.delete(ref); }
        for (const node of retained.values()) node.classList.add('hidden');
        const page = pages.find(entry => entry.id === selected);
        container.classList.toggle('hidden', !page);
        if (page) {
          let node = retained.get(page.ref);
          if (!node) {
            node = document.createElement('section'); node.className = 'plugin-main-page'; node.dataset.pluginRef = page.ref;
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
                if (started !== generation || retained.get(page.ref) !== node) return;
                errors.set(node, error);
                const notice = document.createElement('p'); notice.className = 'plugin-action-error';
                notice.id = `plugin-open-error-${encodeURIComponent(page.ref)}`;
                notice.setAttribute('role', 'alert'); notice.setAttribute('aria-atomic', 'true');
                notice.textContent = formatError(error); header.append(notice);
                detach.setAttribute('aria-describedby', notice.id);
              } finally {
                detach.disabled = false; detach.setAttribute('aria-busy', 'false');
                if (restoreFocus && started === generation && retained.get(page.ref) === node
                  && document.activeElement === document.body) detach.focus({ preventScroll: true });
              }
            });
            header.append(heading, detach);
            const content = document.createElement('div'); content.className = 'plugin-main-content';
            node.append(header, content); container.append(node); retained.set(page.ref, node);
            host.mount(content, page.ref, 'page', { retainDrafts: true });
          }
          node.querySelector('h2').textContent = page.title;
          if (errors.has(node)) node.querySelector('.plugin-action-error').textContent = formatError(errors.get(node));
          const detach = node.querySelector('button'); detach.textContent = t('plugins.page.detach');
          detach.setAttribute('aria-label', t('plugins.page.detachNamed', { name: page.title }));
          node.classList.remove('hidden');
        }
        host.refreshDemand();
        return Boolean(page);
      }
    };
  }
  return { entries, create };
});
