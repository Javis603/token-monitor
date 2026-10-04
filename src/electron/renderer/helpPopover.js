'use strict';

(function exposeHelpPopover(root, factory) {
  const positionApi = typeof module === 'object' && module.exports ? require('./selectControl') : root.TokenMonitorSelectControl;
  const api = factory(positionApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorHelpPopover = api;
})(typeof window !== 'undefined' ? window : null, function createHelpPopoverApi(positionApi) {
  const active = new WeakMap();

  // Pair an accessible info button with a popover containing caller-owned text.
  // The caller may close it on semantic changes (e.g. a different sync server).
  function createHelpPopover({ trigger, popover, document = trigger.ownerDocument,
    window = document.defaultView, maxWidth = 280, align = 'end', closeDelay = 150 }) {
    const listeners = [];
    let closeTimer = null;
    let observer = null;
    let disposed = false;
    let pointerInPopover = false;
    const isOpen = () => popover.matches(':popover-open');
    const cancelClose = () => { clearTimeout(closeTimer); closeTimer = null; };
    const listen = (target, type, handler, capture = false) => {
      if (!target?.addEventListener) return;
      target.addEventListener(type, handler, capture);
      listeners.push(() => target.removeEventListener?.(type, handler, capture));
    };
    const unavailable = () => disposed || trigger.hidden || trigger.disabled
      || trigger.isConnected === false || Boolean(trigger.closest('[hidden], [inert], .hidden'));

    function close() {
      cancelClose();
      pointerInPopover = false;
      if (isOpen()) popover.hidePopover();
      trigger.setAttribute('aria-expanded', 'false');
      observer?.disconnect();
      observer = null;
      if (active.get(document) === controller) active.delete(document);
    }

    function position() {
      if (!window) return;
      const width = Math.max(0, Math.min(maxWidth, window.innerWidth - 16));
      popover.style.width = `${width}px`;
      // Clear a previous height constraint before measuring fresh content.
      popover.style.maxHeight = '';
      const result = positionApi.popupPosition(trigger.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        { width, height: popover.scrollHeight + popover.offsetHeight - popover.clientHeight, align, heightLimit: window.innerHeight });
      Object.assign(popover.style, { left: `${result.left}px`, top: `${result.top}px`, maxHeight: `${result.maxHeight}px` });
    }

    function open() {
      cancelClose();
      if (unavailable()) return;
      const previous = active.get(document);
      if (previous && previous !== controller) previous.close();
      if (!isOpen()) popover.showPopover();
      active.set(document, controller);
      position();
      trigger.setAttribute('aria-expanded', 'true');
      if (!observer && window?.MutationObserver) {
        observer = new window.MutationObserver(() => { if (unavailable()) close(); });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true,
          attributeFilter: ['hidden', 'inert', 'class', 'disabled'] });
      }
    }

    function leave(event) {
      if (trigger.contains(document.activeElement) || popover.contains(document.activeElement) || trigger.contains(event.relatedTarget)
        || popover.contains(event.relatedTarget)) return;
      cancelClose();
      closeTimer = setTimeout(close, closeDelay);
    }
    const inside = node => trigger.contains(node) || popover.contains(node);
    function blur(event) {
      // Selectable plain text is not a focus target: pointerdown inside the
      // popover can blur the trigger with relatedTarget=null (or body).
      if (inside(event.relatedTarget) || (pointerInPopover && (!event.relatedTarget || event.relatedTarget === document.body))) return;
      close();
    }
    const escape = event => { if (event.key === 'Escape' && isOpen()) { close(); event.preventDefault(); } };
    const controller = { open, close, isOpen, dispose() { close(); disposed = true; listeners.splice(0).forEach(remove => remove()); } };
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', popover.id);
    trigger.setAttribute('aria-describedby', popover.id);
    listen(trigger, 'pointerenter', open);
    listen(trigger, 'focus', open);
    listen(trigger, 'click', open);
    listen(trigger, 'pointerleave', leave);
    listen(trigger, 'blur', blur);
    listen(trigger, 'keydown', escape);
    listen(popover, 'pointerenter', cancelClose);
    listen(popover, 'focusout', blur);
    listen(popover, 'pointerleave', leave);
    listen(popover, 'toggle', event => {
      trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
      if (event.newState === 'closed' && !isOpen()) close();
    });
    listen(document, 'pointerdown', event => {
      pointerInPopover = popover.contains(event.target);
      if (!inside(event.target)) close();
      else cancelClose();
    }, true);
    listen(document, 'pointerup', () => { pointerInPopover = false; }, true);
    listen(document, 'focusin', event => {
      if (inside(event.target)) cancelClose();
      else if (!(pointerInPopover && event.target === document.body)) close();
    });
    listen(document, 'keydown', escape);
    listen(document, 'scroll', event => { if (!popover.contains(event.target)) close(); }, true);
    listen(window, 'resize', close);
    listen(window, 'blur', close);
    return controller;
  }
  return { createHelpPopover };
});
