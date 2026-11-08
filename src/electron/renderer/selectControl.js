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

  function popupPosition(rect, viewport, { width = rect.width, height = 320, align = 'start', heightLimit = 320 } = {}) {
    const gutter = 8;
    const gap = 4;
    const popupWidth = Math.max(0, Math.min(Math.max(rect.width, width), viewport.width - gutter * 2));
    const below = Math.max(0, viewport.height - rect.bottom - gap - gutter);
    const above = Math.max(0, rect.top - gap - gutter);
    const opensAbove = height > below && above > below;
    const maxHeight = Math.min(heightLimit, opensAbove ? above : below);
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
    align = 'start',
    searchable = false,
    searchLabel = () => '',
    emptyLabel = () => ''
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

    const popup = document.createElement('div');
    popup.className = 'select-control-popup';
    popup.setAttribute('popover', 'manual');
    const listbox = searchable ? document.createElement('div') : popup;
    listbox.id = `${id}-listbox`;
    listbox.setAttribute('role', 'listbox');
    const searchInput = searchable ? document.createElement('input') : null;
    const empty = searchable ? document.createElement('div') : null;
    if (searchInput) {
      popup.classList.add('has-search');
      listbox.className = 'select-control-list';
      searchInput.className = 'select-control-search';
      searchInput.type = 'search';
      searchInput.autocomplete = 'off';
      searchInput.spellcheck = false;
      searchInput.setAttribute('role', 'combobox');
      searchInput.setAttribute('aria-autocomplete', 'list');
      searchInput.setAttribute('aria-controls', listbox.id);
      empty.className = 'select-control-empty';
      empty.setAttribute('role', 'status');
      empty.hidden = true;
      popup.append(searchInput, listbox, empty);
    }
    const labels = Array.from(select.labels || []);
    const original = { hidden: select.hidden, tabIndex: select.getAttribute('tabindex'), ariaHidden: select.getAttribute('aria-hidden') };
    const listeners = [];
    const rowListeners = [];
    const openListeners = [];
    let options = [];
    let rows = [];
    let selectedIcon = null;
    let active = -1;
    let hovered = -1;
    let keyboardHighlight = false;
    let opened = false;
    let destroyed = false;
    let frame = null;
    let ancestorObserver = null;
    let resizeObserver = null;
    let search = '';
    let searchAt = 0;
    let filter = '';
    const restoredProperties = [];

    function hasSearch() { return searchable === true || searchable === 'auto' && options.length >= 12; }

    function navigationOptions() {
      return options.map((option, index) => ({ ...option, disabled: option.disabled || rows[index].hidden }));
    }

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
      const name = select.getAttribute('aria-label') || labels.map(label => labelText(label.querySelector?.('.settings-item-title') || label)).join(' ').replace(/\s+/g, ' ').trim();
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
      if (searchInput) {
        if (labelledBy) searchInput.setAttribute('aria-labelledby', labelledBy);
        else searchInput.removeAttribute('aria-labelledby');
        searchInput.setAttribute('aria-label', name || searchLabel());
        searchInput.placeholder = searchLabel();
        empty.textContent = emptyLabel();
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
      row.className = `select-control-option${option.description ? ' has-description' : ''}`;
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
      if (option.fontFamily) title.style.fontFamily = option.fontFamily;
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
      if (option.annotation) {
        const annotation = document.createElement('span');
        annotation.className = 'select-control-annotation';
        annotation.id = `${row.id}-annotation`;
        annotation.textContent = option.annotation;
        row.append(annotation);
        row.setAttribute('aria-describedby', [option.description ? description.id : '', annotation.id].filter(Boolean).join(' '));
      }
      listen(row, 'pointermove', (event) => {
        if (event.pointerType === 'touch' || option.disabled) return;
        hovered = index;
        keyboardHighlight = false;
        updateRows();
      }, false, rowListeners);
      listen(row, 'pointerleave', () => {
        if (hovered !== index) return;
        hovered = -1;
        updateRows();
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
          annotation: String(meta.annotation || ''),
          group: option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement.label : '',
          fontFamily: String(meta.fontFamily || ''),
          icon: typeof meta.icon === 'function' ? meta.icon : null
        };
      });
      const changed = next.length !== options.length || next.some((option, index) =>
        Object.keys(option).some(key => option[key] !== options[index]?.[key]));
      options = next;
      if (changed) {
        hovered = -1;
        rowListeners.splice(0).forEach(remove => remove());
        rows = options.map(createRow);
        const contents = [];
        let previousGroup = '';
        options.forEach((option, index) => {
          if (option.group && option.group !== previousGroup) {
            const heading = document.createElement('div');
            heading.className = 'select-control-group';
            heading.setAttribute('role', 'presentation');
            heading.textContent = option.group;
            contents.push(heading);
          }
          previousGroup = option.group;
          contents.push(rows[index]);
        });
        listbox.replaceChildren(...contents);
      }
      syncName();
      trigger.disabled = select.disabled || !options.some(option => !option.disabled);
      trigger.tabIndex = original.tabIndex === null ? 0 : Number(original.tabIndex);
      trigger.className = `select-control-trigger${select.className ? ` ${select.className}` : ''}`;
      trigger.classList?.toggle('hidden', select.classList?.contains('hidden') || original.hidden);
      if (select.dataset.controlKey) trigger.dataset.controlKey = select.dataset.controlKey;
      for (const name of ['aria-invalid', 'title']) setAttributeFromSource(name);
      if (searchInput) searchInput.hidden = !hasSearch();
      const selected = options.find(option => option.value === select.value);
      valueLabel.textContent = selected?.label || '';
      const nextIcon = selected?.icon || null;
      if (selectedIcon !== nextIcon) {
        selectedIcon = nextIcon;
        setIcon(valueIcon, selectedIcon);
      }
      if (!selectedIcon) valueIcon.hidden = true;
      if (opened) {
        if (trigger.disabled || !anchorVisible()) { close(); return; }
        active = options.findIndex(option => option.value === activeValue && !option.disabled);
        if (active < 0) active = initialIndex();
      }
      applyFilter();
      if (opened) position();
    }

    function initialIndex() {
      const selected = options.findIndex(option => option.value === select.value && !option.disabled);
      return selected < 0 ? navigate(options, -1, 'first') : selected;
    }

    function applyFilter() {
      const query = filter.trim().toLocaleLowerCase();
      rows.forEach((row, index) => {
        const option = options[index];
        row.hidden = Boolean(query && !`${option.label} ${option.description} ${option.annotation} ${option.group}`.toLocaleLowerCase().includes(query));
      });
      // Group headings stay with the first remaining option in each group.
      let heading = null;
      let visible = false;
      for (const child of listbox.children) {
        if (child.className === 'select-control-group') {
          if (heading) heading.hidden = !visible;
          heading = child;
          visible = false;
        } else if (!child.hidden) visible = true;
      }
      if (heading) heading.hidden = !visible;
      if (opened && (active < 0 || rows[active]?.hidden)) active = navigate(navigationOptions(), -1, 'first');
      if (empty) empty.hidden = rows.some(row => !row.hidden);
      updateRows();
    }

    function updateRows() {
      rows.forEach((row, index) => {
        row.dataset.selected = String(options[index].value === select.value);
        row.dataset.highlighted = String(opened && (index === hovered || (hovered < 0 && keyboardHighlight && index === active)));
        row.setAttribute('aria-selected', String(options[index].value === select.value));
      });
      if (opened && rows[active]) trigger.setAttribute('aria-activedescendant', rows[active].id);
      else trigger.removeAttribute('aria-activedescendant');
      if (searchInput) {
        searchInput.setAttribute('aria-expanded', String(opened));
        if (opened && rows[active]) searchInput.setAttribute('aria-activedescendant', rows[active].id);
        else searchInput.removeAttribute('aria-activedescendant');
      }
    }

    function highlight(index, scroll = true) {
      hovered = -1;
      keyboardHighlight = true;
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
      const availableWidth = Math.max(0, window.innerWidth - 16);
      const hasDescriptions = options.some(option => option.description);
      // Measure every kind of picker, including searchable lists. A short
      // selected value must not squeeze its longer choices or the search field.
      popup.style.maxWidth = `${Math.min(360, availableWidth)}px`;
      popup.style.width = hasDescriptions ? `${Math.max(rect.width, minPopupWidth, 220)}px` : 'max-content';
      const width = Math.min(availableWidth, Math.max(
        rect.width, minPopupWidth, hasSearch() ? 220 : 0, popup.getBoundingClientRect().width
      ));
      popup.style.maxWidth = `${availableWidth}px`;
      popup.style.width = `${width}px`;
      const result = popupPosition(rect, { width: window.innerWidth, height: window.innerHeight }, {
        width, height: popup.scrollHeight + popup.offsetHeight - popup.clientHeight, align
      });
      popup.style.left = `${result.left}px`;
      popup.style.top = `${result.top}px`;
      popup.style.maxHeight = `${result.maxHeight}px`;
      if (searchInput) listbox.style.maxHeight = `${Math.max(0, result.maxHeight - (hasSearch() ? searchInput.offsetHeight + 16 : 8))}px`;
      popup.dataset.side = result.opensAbove ? 'top' : 'bottom';
    }

    function schedulePosition(event) {
      if (event && event.target !== window && popup.contains(event.target)) return;
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => { frame = null; position(); });
    }

    function close({ commit = false, restoreFocus = false } = {}) {
      if (!opened) return;
      const choice = commit && !select.disabled && anchorVisible() ? options[active] : null;
      opened = false;
      hovered = -1;
      keyboardHighlight = false;
      activeControls.delete(document);
      openListeners.splice(0).forEach(remove => remove());
      ancestorObserver?.disconnect();
      resizeObserver?.disconnect();
      ancestorObserver = null;
      resizeObserver = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      search = '';
      filter = '';
      if (searchInput) searchInput.value = '';
      trigger.setAttribute('aria-expanded', 'false');
      updateRows();
      if (popup.matches(':popover-open')) popup.hidePopover();
      if ((restoreFocus || searchInput && document.activeElement === searchInput) && trigger.isConnected) trigger.focus({ preventScroll: true });
      if (choice && !choice.disabled && choice.value !== select.value) {
        select.value = choice.value;
        sync();
        select.dispatchEvent(new window.Event('input', { bubbles: true }));
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
    }

    function open({ keyboard = false } = {}) {
      if (opened || destroyed) return;
      sync();
      if (trigger.disabled || !anchorVisible()) return;
      activeControls.get(document)?.close();
      trigger.focus({ preventScroll: true });
      active = initialIndex();
      // A body-level popup is inert while a modal dialog owns this control.
      const host = select.closest('dialog') || document.body;
      if (popup.parentElement !== host) host.append(popup);
      popup.showPopover();
      opened = true;
      activeControls.set(document, api);
      trigger.setAttribute('aria-expanded', 'true');
      position();
      highlight(active);
      keyboardHighlight = keyboard;
      updateRows();
      if (hasSearch()) searchInput.focus({ preventScroll: true });
      listen(document, 'pointerdown', (event) => {
        if (!trigger.contains(event.target) && !popup.contains(event.target)) close();
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
      if (event.isComposing) return;
      if (event.ctrlKey || event.metaKey) return;
      const key = event.key;
      const editing = event.target === searchInput;
      if (key === 'Escape') {
        if (opened) { event.preventDefault(); event.stopPropagation(); close(); }
        return;
      }
      if (key === 'Tab') { close({ commit: keyboardHighlight }); return; }
      if (key === 'Enter' || key === ' ' && !editing) {
        event.preventDefault();
        if (opened) close({ commit: true });
        else open({ keyboard: true });
        return;
      }
      if (key === 'ArrowUp' && event.altKey && opened) {
        event.preventDefault();
        close({ commit: true });
        return;
      }
      if (key === 'ArrowDown' && event.altKey) {
        event.preventDefault();
        open({ keyboard: true });
        return;
      }
      const directions = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last', PageDown: 10, PageUp: -10 };
      if (editing && (key === 'Home' || key === 'End')) return;
      if (key in directions) {
        event.preventDefault();
        const wasOpen = opened;
        open({ keyboard: true });
        if (opened && (wasOpen || (key !== 'ArrowDown' && key !== 'ArrowUp'))) {
          highlight(navigate(navigationOptions(), active, directions[key]));
        }
        return;
      }
      if (!editing && !event.altKey && key.length === 1) {
        event.preventDefault();
        open({ keyboard: true });
        if (!opened) return;
        const now = Date.now();
        search = now - searchAt > 700 ? key : search + key;
        searchAt = now;
        if (hasSearch()) {
          searchInput.value = key;
          filter = key;
          keyboardHighlight = true;
          applyFilter();
          position();
        } else highlight(typeahead(options, active, search));
      }
    }

    select.after(trigger);
    (select.closest('dialog') || document.body).append(popup);
    // Keep labels on the hidden source: only the visible trigger activates the
    // picker. Its accessible name is copied separately by syncName().
    select.hidden = true;
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    listen(trigger, 'click', () => { if (opened) close(); else open(); });
    listen(trigger, 'keydown', handleKey);
    listen(trigger, 'blur', event => {
      if (popup.contains(event.relatedTarget)) return;
      close();
      select.dispatchEvent(new window.Event('blur'));
    });
    listen(listbox, 'pointerdown', event => event.preventDefault());
    if (searchInput) {
      listen(searchInput, 'input', () => {
        filter = searchInput.value;
        active = -1;
        keyboardHighlight = true;
        applyFilter();
        position();
      });
      listen(searchInput, 'keydown', handleKey);
      listen(searchInput, 'blur', event => {
        if (event.relatedTarget === trigger || popup.contains(event.relatedTarget)) return;
        close();
        select.dispatchEvent(new window.Event('blur'));
      });
    }
    listen(select, 'change', sync);
    listen(select.form || document, 'reset', () => window.queueMicrotask?.(sync));
    // value/selectedIndex assignments do not emit DOM mutations or change.
    // Bridge just this source element, leaving the platform prototype alone.
    for (const name of ['value', 'selectedIndex']) {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement?.prototype || {}, name);
      if (!descriptor) continue;
      const own = Object.getOwnPropertyDescriptor(select, name);
      Object.defineProperty(select, name, {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) { descriptor.set.call(this, value); sync(); }
      });
      restoredProperties.push(() => { if (own) Object.defineProperty(select, name, own); else delete select[name]; });
    }
    for (const name of ['focus', 'blur']) {
      const own = Object.getOwnPropertyDescriptor(select, name);
      Object.defineProperty(select, name, { configurable: true, value: (...args) => {
        const target = name === 'blur' && document.activeElement === searchInput ? searchInput : trigger;
        target[name](...args);
      } });
      restoredProperties.push(() => { if (own) Object.defineProperty(select, name, own); else delete select[name]; });
    }
    const observer = window.MutationObserver ? new window.MutationObserver(sync) : null;
    observer?.observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
    const nameObserver = window.MutationObserver ? new window.MutationObserver(records => {
      if (records.some(record => !trigger.contains(record.target))) syncName();
    }) : null;
    for (const label of labels) nameObserver?.observe(label, { childList: true, subtree: true, characterData: true });
    const api = {
      sync,
      close,
      trigger,
      isFocused: () => document.activeElement === trigger || popup.contains(document.activeElement),
      destroy() {
        if (destroyed) return;
        close();
        destroyed = true;
        observer?.disconnect();
        nameObserver?.disconnect();
        listeners.splice(0).forEach(remove => remove());
        rowListeners.splice(0).forEach(remove => remove());
        restoredProperties.splice(0).forEach(restore => restore());
        trigger.remove();
        popup.remove();
        select.hidden = original.hidden;
        for (const [name, value] of [['tabindex', original.tabIndex], ['aria-hidden', original.ariaHidden]]) {
          if (value === null) select.removeAttribute(name);
          else select.setAttribute(name, value);
        }
        instances.delete(select);
      }
    };
    instances.set(select, api);
    sync();
    return api;
  }

  const isFocused = select => instances.get(select)?.isFocused() || select?.ownerDocument?.activeElement === select;
  return { enhance, isFocused, navigate, typeahead, popupPosition };
});
