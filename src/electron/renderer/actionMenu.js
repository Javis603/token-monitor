// @ts-check
'use strict';
(function expose(root, factory) {
  const positionApi = typeof module === 'object' && module.exports ? require('./selectControl') : /** @type {any} */ (root)?.TokenMonitorSelectControl;
  const api = factory(positionApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) /** @type {any} */ (root).TokenMonitorActionMenu = api;
})(typeof window !== 'undefined' ? window : null, /** @param {typeof import("./selectControl")} positionApi */ function actionMenuApi(positionApi) {
  let menuId = 0;
  /** @param {Document} document @param {string} label @param {Function} button */
  function create(document, label, button) {
    const window = /** @type {Window} */ (document.defaultView);
    /** @param {Document} document @param {string} tag @param {string} className */
    const el = (document, tag, className) => { const node = document.createElement(tag); node.className = className; return node; };
    const wrap = el(document, 'div', 'plugin-menu-wrap');
    const popover = el(document, 'div', 'plugin-menu'); popover.id = `action-menu-${++menuId}`; popover.setAttribute('popover', 'auto'); popover.setAttribute('role', 'menu');
    const trigger = button('', () => {}, 'plugin-more'); trigger.setAttribute('aria-label', label);
    trigger.id = `${popover.id}-trigger`;
    trigger.setAttribute('aria-haspopup', 'menu');
    popover.setAttribute('aria-labelledby', trigger.id);
    const icon = el(document, 'span', 'plugin-more-icon'); icon.setAttribute('aria-hidden', 'true'); trigger.append(icon);
    trigger.setAttribute('popovertarget', popover.id); trigger.setAttribute('aria-controls', popover.id); trigger.setAttribute('aria-expanded', 'false');
    let keyboardOpen = false, focusLast = false;
    const menuItems = () => [...popover.querySelectorAll('button:not(:disabled), input:not(:disabled)')].map(node => /** @type {HTMLElement} */ (node));
    trigger.addEventListener('click', /** @param {any} event */ event => { keyboardOpen = event.detail === 0; focusLast = false; });
    trigger.addEventListener('keydown', /** @param {any} event */ event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault(); keyboardOpen = true; focusLast = event.key === 'ArrowUp';
      if (popover.matches(':popover-open')) (focusLast ? menuItems().at(-1) : menuItems()[0])?.focus({ preventScroll: true });
      else popover.showPopover();
    });
    const position = () => {
      if (!popover.isConnected) {
        window.removeEventListener('resize', position);
        document.removeEventListener('scroll', position, true);
        return;
      }
      if (popover.matches(':popover-open')) {
        const rect = trigger.getBoundingClientRect();
        const position = positionApi.popupPosition(rect, { width: window.innerWidth, height: window.innerHeight }, {
          width: popover.offsetWidth, height: popover.scrollHeight + 2, align: 'end', heightLimit: window.innerHeight
        });
        Object.assign(popover.style, { left: `${position.left}px`, top: `${position.top}px`, width: `${position.width}px`, maxHeight: `${position.maxHeight}px` });
      }
    };
    popover.addEventListener('beforetoggle', /** @param {any} event */ event => {
      const open = event.newState === 'open';
      trigger.setAttribute('aria-expanded', String(open));
      if (!open && popover.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    });
    popover.addEventListener('toggle', () => {
      const open = popover.matches(':popover-open');
      position();
      if (open && keyboardOpen) (focusLast ? menuItems().at(-1) : menuItems()[0])?.focus({ preventScroll: true });
      const method = open ? 'addEventListener' : 'removeEventListener';
      window[method]('resize', position);
      document[method]('scroll', position, true);
    });
    popover.addEventListener('keydown', /** @param {KeyboardEvent} event */ (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      const direction = /** @type {Record<string, number | string>} */ ({ ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' })[event.key];
      if (direction === undefined) return;
      event.preventDefault();
      const items = menuItems();
      const next = positionApi.navigate(items, items.indexOf(/** @type {HTMLElement} */ (document.activeElement)), direction);
      items[next]?.focus();
    });

    const close = () => { popover.hidePopover(); trigger.focus({ preventScroll: true }); };
    wrap.append(trigger, popover);
    // Only direct action buttons become menuitems; embedded switch/checkbox rows keep their semantics.
    /** @param {...HTMLElement} items */
    const appendItems = (...items) => {
      for (const item of items) {
        if (item.tagName.toLowerCase() === 'button' && !item.hasAttribute('role')) item.setAttribute('role', 'menuitem');
        popover.append(item);
      }
    };
    return { element: wrap, trigger, popover, position, close, appendItems };
  }
  return { create };
});
