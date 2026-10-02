'use strict';

(function exposeSelectControl(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSelectControl = api;
})(typeof window !== 'undefined' ? window : null, function createSelectControlApi() {
  const instances = new WeakMap();
  const activeControls = new WeakMap();
  let nextId = 0;

  function navigate(options, current, direction) {
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
    if (!enabled.length) return -1;
    if (direction === 'first') return enabled[0];
    if (direction === 'last') return enabled[enabled.length - 1];
    const position = enabled.indexOf(current);
    if (position < 0) return direction < 0 ? enabled[enabled.length - 1] : enabled[0];
    return enabled[Math.max(0, Math.min(enabled.length - 1, position + direction))];
  }

  function typeahead(options, current, text) {
    const query = text.toLocaleLowerCase();
    const repeated = [...query].every(char => char === query[0]);
    const prefix = repeated ? query[0] : query;
    for (let step = repeated ? 1 : 0; step < options.length + (repeated ? 1 : 0); step += 1) {
      const index = (Math.max(0, current) + step) % options.length;
      if (!options[index].disabled && options[index].label.toLocaleLowerCase().startsWith(prefix)) return index;
    }
    return current;
  }

  function popupPosition(rect, viewport, { width = rect.width, height = 320, align = 'start' } = {}) {
    const gutter = 8;
    const gap = 4;
    const popupWidth = Math.max(0, Math.min(Math.max(rect.width, width), viewport.width - gutter * 2));
    const below = Math.max(0, viewport.height - rect.bottom - gap - gutter);
    const above = Math.max(0, rect.top - gap - gutter);
    const opensAbove = height > below && above > below;
    const maxHeight = Math.min(320, opensAbove ? above : below);
    const actualHeight = Math.min(height, maxHeight);
    const left = Math.max(gutter, Math.min(
      align === 'end' ? rect.right - popupWidth : rect.left,
      viewport.width - popupWidth - gutter
    ));
    return { left, top: opensAbove ? rect.top - gap - actualHeight : rect.bottom + gap, width: popupWidth, maxHeight, opensAbove };
  }

  function labelText(node) {
    if (node.nodeType === 3) return node.textContent;
    if (['SELECT', 'BUTTON', 'INPUT', 'TEXTAREA', 'SVG'].includes(node.tagName?.toUpperCase())) return '';
    return Array.from(node.childNodes || [], labelText).join(' ');
  }

  function enhance(select, {
    document = select?.ownerDocument,
    window = document?.defaultView,
    getOptionMeta = () => ({}),
    minPopupWidth = 0,
    align = 'start'
  } = {}) {
    if (instances.has(select)) return instances.get(select);
    if (!select || !document || !window || select.multiple || select.size > 1
      || typeof window.HTMLElement?.prototype.showPopover !== 'function') return null;

    const id = `select-control-${++nextId}`;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = `${id}-trigger`;
    trigger.className = 'select-control-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${id}-listbox`);
    const valueIcon = document.createElement('span');
    valueIcon.className = 'select-control-icon';
    valueIcon.setAttribute('aria-hidden', 'true');
    const valueLabel = document.createElement('span');
    valueLabel.className = 'select-control-value';
    const arrow = document.createElement('span');
    arrow.className = 'select-control-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    trigger.append(valueIcon, valueLabel, arrow);

    const listbox = document.createElement('div');
    listbox.id = `${id}-listbox`;
    listbox.className = 'select-control-popup';
    listbox.setAttribute('popover', 'manual');
    listbox.setAttribute('role', 'listbox');
    const labels = Array.from(select.labels || []);
    const original = { hidden: select.hidden, tabIndex: select.getAttribute('tabindex'), ariaHidden: select.getAttribute('aria-hidden') };
    const labelTargets = labels.map(label => label.getAttribute('for'));
    const listeners = [];
    const rowListeners = [];
    const openListeners = [];
    let options = [];
    let rows = [];
    let selectedIcon = null;
    let active = -1;
    let opened = false;
    let destroyed = false;
    let frame = null;
    let ancestorObserver = null;
    let resizeObserver = null;
    let search = '';
    let searchAt = 0;

    function listen(target, type, handler, capture = false, collection = listeners) {
      target.addEventListener(type, handler, capture);
      collection.push(() => target.removeEventListener(type, handler, capture));
    }

    function setAttributeFromSource(name) {
      const value = select.getAttribute(name);
      if (value) trigger.setAttribute(name, value);
      else trigger.removeAttribute(name);
    }

    function syncName() {
      setAttributeFromSource('aria-labelledby');
      setAttributeFromSource('aria-describedby');
      const name = select.getAttribute('aria-label') || labels.map(labelText).join(' ').replace(/\s+/g, ' ').trim();
      if (name) trigger.setAttribute('aria-label', name);
      else trigger.removeAttribute('aria-label');
      const labelledBy = trigger.getAttribute('aria-labelledby');
      if (labelledBy) {
        listbox.setAttribute('aria-labelledby', labelledBy);
        listbox.removeAttribute('aria-label');
      } else {
        listbox.removeAttribute('aria-labelledby');
        listbox.setAttribute('aria-label', name);
      }
    }

    function setIcon(container, factory) {
      container.replaceChildren();
      container.hidden = !factory;
      if (factory) container.append(factory(document));
    }

    function createRow(option, index) {
      const row = document.createElement('div');
      row.id = `${id}-option-${index}`;
      row.className = 'select-control-option';
      row.setAttribute('role', 'option');
      const icon = document.createElement('span');
      icon.className = 'select-control-icon';
      icon.setAttribute('aria-hidden', 'true');
      setIcon(icon, option.icon);
      const text = document.createElement('span');
      text.className = 'select-control-option-text';
      const title = document.createElement('span');
      title.className = 'select-control-option-label';
      title.textContent = option.label;
      const description = document.createElement('span');
      description.className = 'select-control-description';
      description.id = `${row.id}-description`;
      description.textContent = option.description;
      description.hidden = !option.description;
      row.setAttribute('aria-label', option.label);
      if (option.description) row.setAttribute('aria-describedby', description.id);
      row.setAttribute('aria-disabled', String(option.disabled));
      text.append(title, description);
      row.append(icon, text);
      listen(row, 'pointermove', (event) => {
        if (event.pointerType !== 'touch' && !option.disabled) highlight(index, false);
      }, false, rowListeners);
      listen(row, 'click', () => {
        if (option.disabled) return;
        highlight(index, false);
        close({ commit: true, restoreFocus: true });
      }, false, rowListeners);
      return row;
    }

    function sync() {
      if (destroyed) return;
      const activeValue = options[active]?.value;
      const next = Array.from(select.options, (option) => {
        const meta = getOptionMeta(option) || {};
        return {
          value: option.value,
          label: option.textContent.trim(),
          disabled: Boolean(option.disabled || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled),
          description: String(meta.description || ''),
          icon: typeof meta.icon === 'function' ? meta.icon : null
        };
      });
      const changed = next.length !== options.length || next.some((option, index) =>
        Object.keys(option).some(key => option[key] !== options[index]?.[key]));
      options = next;
      if (changed) {
        rowListeners.splice(0).forEach(remove => remove());
        rows = options.map(createRow);
        listbox.replaceChildren(...rows);
      }
      syncName();
      trigger.disabled = select.disabled || !options.some(option => !option.disabled);
      trigger.tabIndex = original.tabIndex === null ? 0 : Number(original.tabIndex);
      const selected = options.find(option => option.value === select.value);
      valueLabel.textContent = selected?.label || '';
      if (selectedIcon !== (selected?.icon || null)) {
        selectedIcon = selected?.icon || null;
        setIcon(valueIcon, selectedIcon);
      }
      if (!selectedIcon) valueIcon.hidden = true;
      if (opened) {
        if (trigger.disabled || !anchorVisible()) { close(); return; }
        active = options.findIndex(option => option.value === activeValue && !option.disabled);
        if (active < 0) active = initialIndex();
      }
      updateRows();
      if (opened) position();
    }

    function initialIndex() {
      const selected = options.findIndex(option => option.value === select.value && !option.disabled);
      return selected < 0 ? navigate(options, -1, 'first') : selected;
    }

    function updateRows() {
      rows.forEach((row, index) => {
        row.dataset.selected = String(options[index].value === select.value);
        row.dataset.highlighted = String(opened && index === active);
        row.setAttribute('aria-selected', String(options[index].value === select.value));
      });
      if (opened && rows[active]) trigger.setAttribute('aria-activedescendant', rows[active].id);
      else trigger.removeAttribute('aria-activedescendant');
    }

    function highlight(index, scroll = true) {
      active = index;
      updateRows();
      if (scroll) rows[active]?.scrollIntoView({ block: 'nearest' });
    }

    function anchorVisible() {
      if (!trigger.isConnected || trigger.closest('[hidden], .hidden, [aria-hidden="true"]')) return false;
      const rect = trigger.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
      for (let node = trigger; node; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        if (node !== trigger && /(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
          const bounds = node.getBoundingClientRect();
          if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) return false;
        }
      }
      return true;
    }

    function position() {
      if (!opened) return;
      if (!anchorVisible()) { close(); return; }
      const rect = trigger.getBoundingClientRect();
      listbox.style.width = `${Math.min(Math.max(rect.width, minPopupWidth), window.innerWidth - 16)}px`;
      const result = popupPosition(rect, { width: window.innerWidth, height: window.innerHeight }, {
        width: minPopupWidth, height: listbox.scrollHeight + listbox.offsetHeight - listbox.clientHeight, align
      });
      listbox.style.left = `${result.left}px`;
      listbox.style.top = `${result.top}px`;
      listbox.style.maxHeight = `${result.maxHeight}px`;
      listbox.dataset.side = result.opensAbove ? 'top' : 'bottom';
    }

    function schedulePosition(event) {
      if (event && listbox.contains(event.target)) return;
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => { frame = null; position(); });
    }

    function close({ commit = false, restoreFocus = false } = {}) {
      if (!opened) return;
      const choice = commit && !select.disabled && anchorVisible() ? options[active] : null;
      opened = false;
      activeControls.delete(document);
      openListeners.splice(0).forEach(remove => remove());
      ancestorObserver?.disconnect();
      resizeObserver?.disconnect();
      ancestorObserver = null;
      resizeObserver = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      search = '';
      trigger.setAttribute('aria-expanded', 'false');
      updateRows();
      if (listbox.matches(':popover-open')) listbox.hidePopover();
      if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
      if (choice && !choice.disabled && choice.value !== select.value) {
        select.value = choice.value;
        sync();
        select.dispatchEvent(new window.Event('input', { bubbles: true }));
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
    }

    function open() {
      if (opened || destroyed) return;
      sync();
      if (trigger.disabled || !anchorVisible()) return;
      activeControls.get(document)?.close();
      trigger.focus({ preventScroll: true });
      active = initialIndex();
      listbox.showPopover();
      opened = true;
      activeControls.set(document, api);
      trigger.setAttribute('aria-expanded', 'true');
      position();
      highlight(active);
      listen(document, 'pointerdown', (event) => {
        if (!trigger.contains(event.target) && !listbox.contains(event.target)) close({ commit: true });
      }, true, openListeners);
      listen(document, 'scroll', schedulePosition, true, openListeners);
      listen(window, 'resize', schedulePosition, false, openListeners);
      listen(window, 'blur', () => close(), false, openListeners);
      listen(document, 'visibilitychange', () => { if (document.hidden) close(); }, false, openListeners);
      if (window.MutationObserver) {
        ancestorObserver = new window.MutationObserver(() => {
          if (!anchorVisible()) close();
          else schedulePosition();
        });
        for (let node = trigger.parentElement; node; node = node.parentElement) {
          ancestorObserver.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'], childList: true });
        }
      }
      if (window.ResizeObserver) {
        resizeObserver = new window.ResizeObserver(schedulePosition);
        for (let node = trigger; node; node = node.parentElement) resizeObserver.observe(node);
      }
    }

    function handleKey(event) {
      if (event.ctrlKey || event.metaKey) return;
      const key = event.key;
      if (key === 'Escape') {
        if (opened) { event.preventDefault(); event.stopPropagation(); close(); }
        return;
      }
      if (key === 'Tab') { close({ commit: true }); return; }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        if (opened) close({ commit: true });
        else open();
        return;
      }
      if (key === 'ArrowUp' && event.altKey && opened) {
        event.preventDefault();
        close({ commit: true });
        return;
      }
      if (key === 'ArrowDown' && event.altKey) {
        event.preventDefault();
        open();
        return;
      }
      const directions = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last', PageDown: 10, PageUp: -10 };
      if (key in directions) {
        event.preventDefault();
        const wasOpen = opened;
        open();
        if (opened && (wasOpen || key !== 'ArrowDown')) {
          highlight(navigate(options, active, !wasOpen && key === 'ArrowUp' ? 'first' : directions[key]));
        }
        return;
      }
      if (!event.altKey && key.length === 1) {
        event.preventDefault();
        open();
        if (!opened) return;
        const now = Date.now();
        search = now - searchAt > 700 ? key : search + key;
        searchAt = now;
        highlight(typeahead(options, active, search));
      }
    }

    select.after(trigger);
    document.body.append(listbox);
    labels.forEach(label => { if (label.getAttribute('for') === select.id) label.setAttribute('for', trigger.id); });
    select.hidden = true;
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    listen(trigger, 'click', () => { if (opened) close(); else open(); });
    listen(trigger, 'keydown', handleKey);
    listen(trigger, 'blur', (event) => close({ commit: Boolean(event.relatedTarget) }));
    listen(listbox, 'pointerdown', event => event.preventDefault());
    listen(select, 'change', sync);
    const observer = window.MutationObserver ? new window.MutationObserver(sync) : null;
    observer?.observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
    const api = {
      sync,
      close,
      destroy() {
        if (destroyed) return;
        close();
        destroyed = true;
        observer?.disconnect();
        listeners.splice(0).forEach(remove => remove());
        rowListeners.splice(0).forEach(remove => remove());
        trigger.remove();
        listbox.remove();
        select.hidden = original.hidden;
        for (const [name, value] of [['tabindex', original.tabIndex], ['aria-hidden', original.ariaHidden]]) {
          if (value === null) select.removeAttribute(name);
          else select.setAttribute(name, value);
        }
        labels.forEach((label, index) => {
          if (labelTargets[index] === null) label.removeAttribute('for');
          else label.setAttribute('for', labelTargets[index]);
        });
        instances.delete(select);
      }
    };
    instances.set(select, api);
    sync();
    return api;
  }

  return { enhance, navigate, typeahead, popupPosition };
});
