'use strict';
(function expose(root, factory) {
  const placements = typeof module === 'object' && module.exports ? require('../../../shared/plugins/placements') : root.TokenMonitorPluginPlacements;
  const api = factory(placements);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorNotchPageSettings = api;
})(typeof window !== 'undefined' ? window : null, (placements) => {
  const builtin = ['home', 'limits', 'sessions', 'breakdown'];
  // The same names the Notch tab row paints, so a chip reads like its tab.
  const BUILTIN_ICONS = { home: 'home', limits: 'limits', sessions: 'session', breakdown: 'model' };
  function entries(settings = {}, catalog, t) {
    const chosen = Array.isArray(settings.notchBuiltinPages) ? settings.notchBuiltinPages : builtin;
    const list = [
      ...builtin.map(id => ({ id, label: t(`notch.tab.${id}`), title: t(`notch.tab.${id}`),
        icon: { kind: 'builtin', name: BUILTIN_ICONS[id] }, checked: chosen.includes(id) })),
      ...(settings.pluginsEnabled === false || catalog?.enabled === false ? [] : catalog?.plugins || []).filter(plugin => plugin.status === 'active').flatMap(plugin => (plugin.views || []).filter(view => view.surfaces.includes('notch')).map(view => ({
        id: `plugin:${view.ref}`, ref: view.ref, label: view.title,
        title: plugin.name === view.title ? view.title : `${plugin.name} · ${view.title}`,
        icon: { kind: 'plugin', name: view.icon || 'dot', identityIcon: plugin.identityIcon },
        checked: view.placements?.notch === true
      })))
    ];
    const preferred = settings.notchPageOrder?.length ? settings.notchPageOrder
      : [...builtin, ...(settings.notchPluginPages || []).map(ref => `plugin:${ref}`)];
    const byId = new Map(list.map(entry => [entry.id, entry]));
    return placements.orderNotchPages(list.map(entry => entry.id), preferred).map(id => byId.get(id));
  }
  const errors = new WeakMap();
  const contexts = new WeakMap(), controllers = new WeakMap(), resetButtons = new WeakSet();
  function clearError(container) {
    errors.delete(container);
    contexts.get(container)?.resetButton?.removeAttribute('aria-describedby');
    container.querySelector('.plugin-action-error')?.remove();
    for (const chip of container.querySelectorAll('button')) chip.removeAttribute('aria-describedby');
  }
  function applyOrder(container, order, document) {
    const focus = document.activeElement;
    const byId = new Map([...container.querySelectorAll('button')].map(node => [node.dataset.page, node]));
    container.append(...order.map(id => byId.get(id)).filter(Boolean));
    if (byId.get(focus?.dataset?.page) === focus && document.activeElement !== focus) focus.focus({ preventScroll: true });
  }
  async function persistOrder(container, order, id, reset = false) {
    const options = contexts.get(container), { document } = options;
    clearError(container);
    container.dataset.saving = 'true'; container.setAttribute('aria-busy', 'true');
    const restoreFocus = container.contains(document.activeElement) || document.activeElement === options.resetButton || document.activeElement === document.body;
    for (const control of container.querySelectorAll('button')) control.disabled = true;
    if (options.resetButton) options.resetButton.disabled = true;
    try { await options.save({ notchPageOrder: reset ? [] : placements.mergeNotchPageOrder(options.settings.notchPageOrder, order) }); }
    catch (error) { errors.set(container, { error, id, reset }); }
    finally {
      delete container.dataset.saving; container.setAttribute('aria-busy', 'false');
      const canRestore = restoreFocus && (document.activeElement === document.body || document.activeElement === options.resetButton || container.contains(document.activeElement));
      render(contexts.get(container));
      if (canRestore) {
        const resetTarget = errors.get(container)?.reset && contexts.get(container).resetButton;
        const target = resetTarget && !resetTarget.hidden && !resetTarget.disabled ? resetTarget
          : [...container.querySelectorAll('button')].find(node => node.dataset.page === id);
        target?.focus({ preventScroll: true });
      }
    }
  }
  function render(options) {
    const { document, container, settings, catalog, t, save, place, pluginIcon } = options;
    if (!container) return;
    contexts.set(container, options);
    if (options.resetButton) {
      const customOrder = placements.normalizeNotchPageOrder(settings.notchPageOrder).length > 0;
      options.resetButton.hidden = !customOrder;
      options.resetButton.disabled = container.dataset.saving === 'true' || !customOrder;
      if (!resetButtons.has(options.resetButton)) {
        resetButtons.add(options.resetButton);
        options.resetButton.addEventListener('click', () => {
          const current = contexts.get(container);
          if (container.dataset.saving === 'true' || controllers.get(container)?.isDragging()
            || !placements.normalizeNotchPageOrder(current.settings.notchPageOrder).length) return;
          const first = entries({ ...current.settings, notchPageOrder: [] }, current.catalog, current.t)[0]?.id;
          void persistOrder(container, [], first, true);
        });
      }
    }
    if (controllers.get(container)?.deferRender() || container.dataset.saving === 'true') return;
    if (options.createRowDrag && !controllers.has(container)) {
      controllers.set(container, options.createRowDrag({
        axis: 'grid', getList: () => container, rowSelector: '.notch-page-chip', idKey: 'page', dragExcluded: '[data-ignore-drag]',
        applyOrder: order => applyOrder(container, order, document),
        mirrorOrder: () => { container.dataset.saving = 'true'; },
        persistOrder: (order, id) => void persistOrder(container, order, id),
        requestRender: () => render(contexts.get(container))
      }));
    }
    const focused = container.contains(document.activeElement) ? document.activeElement?.dataset.page : null;
    const chips = entries(settings, catalog, t).map(entry => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'notch-page-chip';
      chip.dataset.page = entry.id;
      chip.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+Home Alt+End');
      chip.setAttribute('aria-description', t('settings.notch.reorderKeys'));
      chip.addEventListener('pointerdown', event => {
        if (container.dataset.saving !== 'true') controllers.get(container)?.startRowDrag(event, entry.id);
      });
      chip.addEventListener('keydown', event => {
        if (!event.altKey || container.dataset.saving === 'true') return;
        const ids = entries(contexts.get(container).settings, contexts.get(container).catalog, t).map(item => item.id);
        const index = ids.indexOf(entry.id);
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
          : event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'ArrowRight' ? Math.min(ids.length - 1, index + 1) : -1;
        if (target < 0) return;
        event.preventDefault();
        if (target === index) return;
        ids.splice(target, 0, ...ids.splice(index, 1)); applyOrder(container, ids, document);
        void persistOrder(container, ids, entry.id);
      });
      chip.setAttribute('aria-pressed', String(entry.checked));
      if (entry.title !== entry.label) { chip.setAttribute('aria-label', entry.title); }
      const icon = entry.icon?.kind === 'plugin' && typeof pluginIcon === 'function' ? pluginIcon(entry.icon.name, entry.icon.identityIcon)
        : entry.icon?.kind === 'builtin' ? document.createElement('span') : null;
      if (entry.icon?.kind === 'builtin') {
        icon.className = `view-switcher-icon view-icon-${entry.icon.name}`;
        icon.setAttribute('aria-hidden', 'true');
      }
      const label = document.createElement('span');
      label.textContent = entry.label;
      chip.append(...(icon ? [icon] : []), label);
      chip.addEventListener('click', async () => {
        if (container.dataset.saving === 'true') return;
        clearError(container);
        const restoreFocus = document.activeElement === chip;
        const next = !entry.checked;
        chip.setAttribute('aria-pressed', String(next));
        container.dataset.saving = 'true'; container.setAttribute('aria-busy', 'true');
        for (const control of container.querySelectorAll('button')) control.disabled = true;
        if (options.resetButton) options.resetButton.disabled = true;
        try {
          if (entry.ref) await place(entry.ref, next);
          else {
            const chosen = entries(settings, catalog, t).filter(e => !e.ref && (e.id === entry.id ? next : e.checked)).map(e => e.id);
            await save({ notchBuiltinPages: chosen });
          }
        } catch (error) { chip.setAttribute('aria-pressed', String(entry.checked)); errors.set(container, { error, id: entry.id }); }
        finally {
          delete container.dataset.saving; container.setAttribute('aria-busy', 'false');
          const canRestore = restoreFocus && (document.activeElement === document.body || container.contains(document.activeElement));
          render(contexts.get(container));
          if (canRestore) [...container.querySelectorAll('button')].find(control => control.dataset.page === entry.id)?.focus({ preventScroll: true });
        }
      });
      return chip;
    });
    const failure = errors.get(container);
    options.resetButton?.removeAttribute('aria-describedby');
    const affected = failure && (failure.reset ? options.resetButton : chips.find(chip => chip.dataset.page === failure.id));
    const notice = affected ? document.createElement('p') : null;
    if (notice) {
      notice.className = 'plugin-action-error'; notice.id = `${container.id || 'notch-pages'}-action-error`;
      notice.setAttribute('role', 'alert'); notice.setAttribute('aria-atomic', 'true');
      notice.textContent = options.formatError ? options.formatError(failure.error)
        : t('settings.plugins.actionFailed', { error: failure.error.message || String(failure.error) });
      affected.setAttribute('aria-describedby', notice.id);
    } else errors.delete(container);
    container.replaceChildren(...chips, ...(notice ? [notice] : []));
    if (focused) [...container.querySelectorAll('button')].find(chip => chip.dataset.page === focused)?.focus({ preventScroll: true });
  }
  return { entries, render };
});
