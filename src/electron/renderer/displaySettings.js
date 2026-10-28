'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorDisplaySettings = api;
})(typeof window === 'undefined' ? null : window, () => {
  const SURFACES = [
    { id: 'edgeDock', input: 'edgeDockInput', title: 'settings.display.edgeDock', short: 'edge', options: ['edgeDockOptions', 'edgeDockComposerRow'] },
    { id: 'notch', input: 'notchInput', title: 'settings.notch.title', short: 'notch', options: ['notchOptions'] },
    { id: 'floatingBubble', input: 'floatingBubbleInput', title: 'settings.display.floatingBubble', short: 'bubble', options: ['floatingBubbleOptions'] },
    { id: 'tray', input: 'showTrayIconInput', title: 'settings.display.showTrayIcon', short: 'tray', options: ['trayIconOptions'] }
  ];
  const CATEGORY_IDS = {
    interaction: ['notchHideSummaryInFullScreenInput', 'edgeDockModeLabel', 'notchHoverActionLabel', 'notchHoverDelayRow', 'notchHapticInput', 'edgeDockHapticInput', 'floatingBubbleTriggerRow', 'notchSwipeGesturesInput', 'trayModeInput', 'trayOptions', 'hideAppIconRow', 'hideAppIconOptions'],
    appearance: ['edgeDockSideLabel', 'edgeDockSizeLabel', 'edgeDockCustomScaleRow', 'notchSizeLabel', 'notchCustomScaleRow', 'notchShapeLabel', 'notchStyleInput', 'edgeDockMacBackdropRow', 'edgeDockWindowsBackdropRow', 'notchProgressiveBlurInput']
  };
  function create({ document, root, scrollPanel, t, platform, settings = () => ({}), preview, cancelScroll }) {
    if (!root) return null;
    const make = (tag, className, key) => {
      const node = document.createElement(tag); node.className = className;
      if (key) node.dataset.i18n = key;
      if (tag === 'button') node.type = 'button';
      return node;
    };
    const container = make('div', 'display-settings');
    const overview = make('div', 'display-settings-overview');
    const main = root.querySelector('.settings-window-group');
    overview.append(main);
    const list = make('div', 'display-settings-list'); overview.append(list);
    const detail = make('div', 'display-settings-detail'); detail.hidden = true;
    const back = make('button', 'display-settings-back', 'settings.displayModes.back');
    const quick = make('div', 'display-settings-quick'); quick.setAttribute('role', 'tablist');
    const content = make('div', 'display-settings-pages'); detail.append(back, quick, content);
    const entries = new Map();
    let active = null, overviewScroll = 0;
    const categoryBySurface = new Map();
    function chooseCategory(id, category) {
      categoryBySurface.set(id, category);
      const entry = entries.get(id);
      for (const [name, group] of Object.entries(entry.groups)) group.hidden = entry.flat ? !group.childElementCount : name !== category;
      for (const button of entry.tabs.children) {
        const selected = button.dataset.category === category;
        button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      }
    }
    function wireArrows(list, select) {
      list.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...list.children].filter(button => !button.hidden);
        const index = buttons.indexOf(document.activeElement); if (index < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length;
        select(buttons[next]); buttons[next].focus({ preventScroll: true });
      });
    }
    for (const surface of SURFACES) {
      const input = document.getElementById(surface.input);
      const feature = input.closest('.presence-feature');
      const page = make('section', 'display-settings-page'); page.id = `display-page-${surface.id}`; page.hidden = true;
      page.setAttribute('role', 'tabpanel');
      const flat = ['floatingBubble', 'tray'].includes(surface.id);
      page.classList.toggle('display-settings-page-flat', flat);
      const title = input.closest('label'); title.classList.add('display-settings-title');
      const stage = make('div', 'display-settings-preview');
      const states = make('div', 'display-settings-states'); states.setAttribute('role', 'group');
      const phaseList = surface.id === 'notch' ? ['closed', 'open'] : [];
      states.hidden = phaseList.length === 0;
      for (const phase of phaseList) {
        const button = make('button', '', `settings.displayModes.${phase}`); button.dataset.phase = phase;
        button.setAttribute('aria-pressed', String(phase === 'open'));
        button.addEventListener('click', () => {
          entry.phase = phase;
          for (const other of states.children) other.setAttribute('aria-pressed', String(other === button));
          updatePreview();
        }); states.append(button);
      }
      const note = make('p', 'settings-note display-settings-preview-note', surface.id === 'edgeDock' || surface.id === 'notch' ? 'settings.displayModes.previewNote' : 'settings.displayModes.currentPreview');
      const tabs = make('div', 'display-settings-categories'); tabs.setAttribute('role', 'tablist'); tabs.hidden = flat;
      const groups = {};
      for (const category of ['content', 'interaction', 'appearance']) {
        const button = make('button', '', `settings.displayModes.${category}`); button.dataset.category = category;
        button.id = `display-${surface.id}-${category}-tab`; button.setAttribute('role', 'tab');
        const group = make('div', 'display-settings-fields'); group.id = `display-${surface.id}-${category}`;
        if (!flat) { group.setAttribute('role', 'tabpanel'); group.setAttribute('aria-labelledby', button.id); }
        button.setAttribute('aria-controls', group.id);
        button.addEventListener('click', () => chooseCategory(surface.id, category)); tabs.append(button); groups[category] = group;
      }
      // Move each existing control exactly once. Its listeners, drafts, composer,
      // selection and focus state survive navigation; switching never saves settings.
      for (const id of surface.options) {
        const options = document.getElementById(id);
        const inner = options.querySelector(':scope > .accordion-animation-inner') || options;
        for (const child of [...inner.children]) {
          if (child.id === 'edgeDockMoreOptionsGroup' || child.id === 'notchMoreOptionsGroup') {
            const more = child.querySelector('.cursor-settings-details');
            const moreInner = more.querySelector(':scope > .accordion-animation-inner') || more;
            groups.content.append(...moreInner.children); child.hidden = true;
          } else groups.content.append(child);
        }
      }
      for (const [category, ids] of Object.entries(CATEGORY_IDS)) {
        for (const id of ids) {
          const node = groups.content.querySelector(`#${id}`);
          if (!node) continue;
          groups[category].append(node.closest('.settings-item') || node);
        }
      }
      page.append(title, stage, states, note, tabs, ...Object.values(groups)); content.append(page);
      const row = make('div', 'display-settings-row');
      const openButton = make('button', 'display-settings-open');
      const thumb = make('span', `display-settings-thumb display-settings-thumb-${surface.short}`); thumb.setAttribute('aria-hidden', 'true');
      // Only indicates screen position. Detailed previews use the actual renderer.
      thumb.append(make('i', ''));
      const labels = make('span', 'display-settings-labels');
      labels.append(make('span', 'settings-item-title', surface.title), make('span', 'settings-item-desc', `settings.displayModes.${surface.short}Note`));
      openButton.append(thumb, labels); openButton.addEventListener('click', () => open(surface.id));
      const toggle = make('input', ''); toggle.type = 'checkbox';
      toggle.addEventListener('change', () => { input.checked = toggle.checked; input.dispatchEvent(new Event('change', { bubbles: true })); sync(); });
      const toggleLabel = make('label', 'checkbox-label display-settings-switch'); toggleLabel.append(toggle);
      row.append(openButton, toggleLabel); list.append(row);
      const tab = make('button', '', `settings.displayModes.${surface.short}`); tab.id = `display-tab-${surface.id}`;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', page.id); page.setAttribute('aria-labelledby', tab.id);
      tab.addEventListener('click', () => open(surface.id)); quick.append(tab);
      const entry = { flat, surface, feature, input, page, stage, note, groups, tabs, tab, row, toggle, openButton, phase: 'open' };
      entries.set(surface.id, entry);
      for (const button of tabs.children) button.hidden = !groups[button.dataset.category].childElementCount;
      chooseCategory(surface.id, 'content');
      wireArrows(tabs, button => chooseCategory(surface.id, button.dataset.category));
    }
    const oldGroup = root.querySelector('.settings-presence-group'); oldGroup.hidden = true; oldGroup.style.display = 'none';
    container.append(overview, detail); root.append(container);
    wireArrows(quick, button => open([...entries].find(([, entry]) => entry.tab === button)[0]));
    function available(id) { return id === 'notch' ? platform() === 'darwin' : id !== 'edgeDock' || ['darwin', 'win32'].includes(platform()); }
    function updatePreview(force = false) { if (scrollPanel.classList.contains('hidden') || root.closest('.settings-section-details')?.classList.contains('hidden')) return; if (active) { const entry = entries.get(active); preview?.(active, entry.stage, entry.phase, { force }); } }
    function open(id) {
      if (!entries.has(id) || !available(id)) return;
      cancelScroll?.();
      if (!active) overviewScroll = scrollPanel.scrollTop;
      active = id; overview.hidden = true; detail.hidden = false;
      for (const [key, entry] of entries) {
        entry.page.hidden = key !== id;
        entry.tab.setAttribute('aria-selected', String(key === id)); entry.tab.tabIndex = key === id ? 0 : -1;
      }
      const top = root.getBoundingClientRect().top - scrollPanel.getBoundingClientRect().top + scrollPanel.scrollTop;
      scrollPanel.scrollTop = top;
      entries.get(id).tab.focus({ preventScroll: true });
      updatePreview();
    }
    function close() {
      if (!active) return;
      cancelScroll?.(); const previous = entries.get(active); active = null;
      overview.hidden = false; detail.hidden = true;
      scrollPanel.scrollTop = overviewScroll; previous.openButton.focus({ preventScroll: true });
    }
    back.addEventListener('click', close);
    container.addEventListener('keydown', event => { if (event.key === 'Escape' && active && !event.defaultPrevented) { event.stopPropagation(); close(); } });
    function sync() {
      container.dataset.platform = platform() || 'unknown';
      container.dataset.edgeSide = settings()?.edgeDockSide === 'left' ? 'left' : 'right';
      if (active && !available(active)) close();
      for (const [id, entry] of entries) {
        entry.row.hidden = entry.tab.hidden = !available(id);
        entry.toggle.checked = entry.input.checked; entry.toggle.setAttribute('aria-label', t(entry.surface.title));
        if (id === 'tray') entry.note.dataset.i18n = platform() === 'linux' ? 'settings.displayModes.desktopPreview' : 'settings.displayModes.currentPreview';
      }
      for (const node of container.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
      quick.setAttribute('aria-label', t('settings.displayModes.switch'));
      updatePreview();
    }
    container.addEventListener('change', () => queueMicrotask(sync));
    sync();
    return { open, close, sync, refreshLivePreview() { if (active === 'tray' || active === 'floatingBubble') updatePreview(true); }, get active() { return active; } };
  }
  return { create, SURFACES };
});
