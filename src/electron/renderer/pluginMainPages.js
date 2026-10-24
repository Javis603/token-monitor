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
  function create({ document, container, host, t, openWindow }) {
    const retained = new Map();
    return {
      render(pages, selected) {
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
            detach.addEventListener('click', () => openWindow(page.ref));
            header.append(heading, detach);
            const content = document.createElement('div'); content.className = 'plugin-main-content';
            node.append(header, content); container.append(node); retained.set(page.ref, node);
            host.mount(content, page.ref, 'page', { retainDrafts: true });
          }
          node.querySelector('h2').textContent = page.title;
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
