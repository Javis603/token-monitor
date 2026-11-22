'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorDisplaySettings = api;
})(typeof window === 'undefined' ? null : window, () => {
  const SURFACES = [
    { id: 'main', title: 'settings.displayModes.main', short: 'main', thumb: 'main' },
    {
      id: 'edgeDock',
      input: 'edgeDockInput',
      title: 'settings.display.edgeDock',
      short: 'edge',
      thumb: 'edge',
      intro: 'settings.display.edgeDockNote',
      options: ['edgeDockOptions', 'edgeDockComposerRow'],
      cards: [
        { header: 'settings.displayModes.group.placement', ids: ['edgeDockModeLabel', 'edgeDockTriggerRangeRow', 'edgeDockSideLabel'] },
        { header: 'settings.displayModes.group.items', ids: ['edgeDockComposer', 'edgeDockWarnColorsInput', 'edgeDockRunningIndicatorInput'] },
        {
          header: 'settings.displayModes.group.sizingAppearance',
          ids: [
            'edgeDockSizeLabel', 'edgeDockCustomScaleRow',
            'edgeDockBubbleSizeLabel', 'edgeDockBubbleCustomScaleRow',
            'edgeDockWindowsBackdropRow', 'edgeDockMacBackdropRow', 'edgeDockHapticRow'
          ]
        }
      ]
    },
    {
      id: 'notch',
      input: 'notchInput',
      title: 'settings.notch.title',
      short: 'notch',
      thumb: 'notch',
      intro: 'settings.displayModes.notchIntro',
      options: ['notchOptions'],
      cards: [
        {
          header: 'settings.displayModes.group.notchSummary',
          ids: ['notchHoverActionLabel', 'notchHoverDelayRow', 'notchSummaryInput'],
          subblock: {
            toggleId: 'notchSummaryInput',
            ids: ['notchSummaryModeInput', 'notchComposerDetails', 'notchHideSummaryInFullScreenInput']
          }
        },
        {
          header: 'settings.displayModes.group.notchContent',
          selectors: ['.notch-page-settings'],
          ids: ['notchItemsComposer', 'notchRunningIndicatorRow', 'notchWarnColorsInput']
        },
        {
          header: 'settings.displayModes.group.notchAppearance',
          ids: [
            'notchShapeLabel', 'notchSizeLabel', 'notchCustomScaleRow',
            'notchStyleInput', 'notchProgressiveBlurInput', 'notchSwipeGesturesInput', 'notchHapticInput'
          ]
        }
      ]
    },
    {
      id: 'floatingBubble',
      input: 'floatingBubbleInput',
      title: 'settings.display.floatingBubble',
      short: 'bubble',
      thumb: 'bubble',
      intro: 'settings.display.floatingBubbleNote',
      options: ['floatingBubbleOptions'],
      cards: [
        {
          header: 'settings.displayModes.group.bubbleDisplay',
          ids: ['floatingBubbleTriggerRow', 'floatingBubbleContentRow', 'floatingBubbleComposer']
        }
      ]
    },
    {
      id: 'tray',
      input: 'showTrayIconInput',
      title: 'settings.displayModes.trayTitle',
      short: 'tray',
      thumb: 'tray',
      intro: 'settings.displayModes.trayIntro',
      options: ['trayIconOptions'],
      cards: [
        { header: 'settings.displayModes.group.trayDisplay', ids: ['trayContentInput', 'trayComposer', 'showTrayProviderBadgeInput'] },
        { header: 'settings.displayModes.group.trayWindow', ids: ['trayModeInput', 'trayOptions', 'hideAppIconRow', 'hideAppIconOptions'] }
      ]
    }
  ];

  function create({
    document,
    root,
    t,
    platform,
    settings = () => ({}),
    helpPopover,
    cancelScroll,
    stopWindowShortcutRecording
  }) {
    if (!root) return null;
    const make = (tag, className, key) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (key) node.dataset.i18n = key;
      if (tag === 'button') node.type = 'button';
      return node;
    };

    const container = make('div', 'display-settings');
    const dock = make('div', 'display-settings-dock');
    dock.setAttribute('role', 'tablist');
    const pages = make('div', 'display-settings-pages');
    container.append(dock, pages);

    const main = root.querySelector('.settings-window-group');
    const entries = new Map();
    const helpControllers = [];
    let active = 'main';

    function wireArrows(list, select) {
      list.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...list.children].filter((button) => !button.hidden);
        const index = buttons.indexOf(document.activeElement);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length;
        select(buttons[next]);
        buttons[next].focus({ preventScroll: true });
      });
    }

    function createTile(surface, page) {
      const tab = make('button', 'display-settings-tile');
      tab.id = `display-tab-${surface.id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', page.id);
      page.setAttribute('aria-labelledby', tab.id);
      if (surface.input) {
        const dot = make('span', 'display-settings-tile-dot');
        dot.setAttribute('aria-hidden', 'true');
        tab.append(dot);
      }
      const thumb = make('span', `display-settings-thumb display-settings-thumb-${surface.thumb}`);
      thumb.setAttribute('aria-hidden', 'true');
      thumb.append(make('i', ''));
      const label = make('span', 'display-settings-tile-label', `settings.displayModes.${surface.short}`);
      tab.append(thumb, label);
      tab.addEventListener('click', () => open(surface.id));
      dock.append(tab);
      return tab;
    }

    function collectControlPool(surface) {
      const pool = make('div', '');
      for (const id of surface.options || []) {
        const options = document.getElementById(id);
        if (!options) continue;
        const inner = options.querySelector(':scope > .accordion-animation-inner') || options;
        for (const child of [...inner.children]) {
          if (child.id === 'edgeDockMoreOptionsGroup' || child.id === 'notchMoreOptionsGroup') {
            const more = child.querySelector('.cursor-settings-details');
            const moreInner = more?.querySelector(':scope > .accordion-animation-inner') || more;
            if (moreInner) pool.append(...moreInner.children);
            child.hidden = true;
          } else {
            pool.append(child);
          }
        }
      }
      return pool;
    }

    function takeNode(pool, id) {
      const node = pool.querySelector(`#${id}`);
      if (!node) return null;
      return node.closest('.settings-item') || node;
    }

    function createCard(spec, pool) {
      const card = make('div', 'settings-subgroup settings-page-card display-settings-card');
      if (spec.header) {
        const header = make('div', 'settings-group-header');
        header.append(make('span', '', spec.header));
        card.append(header);
      }
      for (const selector of spec.selectors || []) {
        const node = pool.querySelector(selector);
        if (node) card.append(node);
      }
      for (const id of spec.ids || []) {
        const node = takeNode(pool, id);
        if (node) card.append(node);
      }
      let subblock = null;
      if (spec.subblock) {
        const block = make('div', 'display-settings-subblock');
        for (const id of spec.subblock.ids) {
          const node = takeNode(pool, id);
          if (node) block.append(node);
        }
        card.append(block);
        subblock = { toggleId: spec.subblock.toggleId, node: block };
      }
      return { card, subblock };
    }

    // Main Window surface
    const mainSurface = SURFACES[0];
    const mainPage = make('section', 'display-settings-page');
    mainPage.id = 'display-page-main';
    mainPage.setAttribute('role', 'tabpanel');
    const mainCard = make('div', 'settings-subgroup settings-page-card display-settings-card');
    const mainHeader = make('div', 'settings-group-header');
    mainHeader.append(make('span', '', mainSurface.title));
    mainCard.append(mainHeader, main);
    mainPage.append(mainCard);
    pages.append(mainPage);
    const mainTab = createTile(mainSurface, mainPage);
    entries.set('main', { surface: mainSurface, page: mainPage, tab: mainTab });

    // Toggleable surfaces: Edge Dock, Notch, Floating Bubble, Tray
    for (const surface of SURFACES.slice(1)) {
      const input = document.getElementById(surface.input);
      if (!input) continue;
      const page = make('section', 'display-settings-page');
      page.id = `display-page-${surface.id}`;
      page.hidden = true;
      page.setAttribute('role', 'tabpanel');

      const hero = make('div', 'settings-subgroup settings-page-card display-settings-hero');
      const heroText = make('div', 'display-settings-hero-text');
      const heroTitleRow = make('div', 'display-settings-hero-title-row');
      const heroTitle = make('strong', 'display-settings-hero-title', surface.title);
      heroTitleRow.append(heroTitle);

      let helpTrigger = null;
      if (surface.intro && helpPopover?.createHelpPopover) {
        helpTrigger = make('button', 'settings-help-trigger display-settings-hero-help');
        helpTrigger.id = `display-help-trigger-${surface.id}`;
        helpTrigger.innerHTML = '<span aria-hidden="true">i</span>';
        const helpNode = make('div', 'settings-help-popover');
        helpNode.id = `display-help-popover-${surface.id}`;
        helpNode.setAttribute('popover', 'auto');
        helpNode.setAttribute('role', 'tooltip');
        helpNode.dataset.i18n = surface.intro;
        heroTitleRow.append(helpTrigger, helpNode);
        helpControllers.push(helpPopover.createHelpPopover({ trigger: helpTrigger, popover: helpNode, document }));
      }

      const heroSub = make('p', 'display-settings-hero-sub');
      heroText.append(heroTitleRow, heroSub);

      const originalRow = input.closest('.settings-item') || input.closest('label');
      const resetHeading = originalRow?.querySelector('[data-reset-setting]');
      if (resetHeading) {
        heroTitleRow.dataset.resetSetting = resetHeading.dataset.resetSetting;
        heroTitle.classList.add('settings-item-title');
        delete resetHeading.dataset.resetSetting;
      }
      const switchLabel = make('label', 'checkbox-label display-settings-hero-switch');
      switchLabel.append(input);
      if (originalRow) originalRow.hidden = true;

      hero.append(heroText, switchLabel);

      const pool = collectControlPool(surface);
      const cardsWrap = make('div', 'display-settings-cards');
      const subblocks = [];
      for (const spec of surface.cards || []) {
        const { card, subblock } = createCard(spec, pool);
        cardsWrap.append(card);
        if (subblock) subblocks.push(subblock);
      }

      page.append(hero, cardsWrap);
      pages.append(page);
      const tab = createTile(surface, page);
      entries.set(surface.id, {
        surface,
        input,
        page,
        tab,
        heroSub,
        helpTrigger,
        cardsWrap,
        subblocks
      });
    }

    const oldGroup = root.querySelector('.settings-presence-group');
    if (oldGroup) {
      oldGroup.hidden = true;
      oldGroup.style.display = 'none';
    }
    root.append(container);

    wireArrows(dock, (button) => {
      const found = [...entries].find(([, entry]) => entry.tab === button);
      if (found) open(found[0]);
    });

    function available(id) {
      if (id === 'notch') return platform() === 'darwin';
      if (id === 'edgeDock') return ['darwin', 'win32'].includes(platform());
      return true;
    }

    function closeHelp() {
      for (const controller of helpControllers) controller.close();
    }

    function selectedOptionLabel(selectId) {
      const select = document.getElementById(selectId);
      const option = select?.selectedOptions?.[0];
      if (!option) return '';
      return option.dataset?.i18n ? t(option.dataset.i18n) : option.textContent.trim();
    }

    function activeSummary(id) {
      const prefs = settings() || {};
      if (id === 'edgeDock') {
        const mode = prefs.edgeDockMode || 'autoHide';
        const modeKey = `settings.edgeDock.mode.${mode}`;
        const side = prefs.edgeDockSide === 'left' ? 'left' : 'right';
        const parts = [t(modeKey)];
        if (!Number.isFinite(prefs.edgeDockFloatingX)) parts.push(t(`settings.edgeDockSide.${side}`));
        return parts.join(' · ');
      }
      if (id === 'notch') {
        const hoverKey = prefs.notchHoverAction === 'open' ? 'trayMenu.notchHoverOpen' : 'trayMenu.notchHoverPeek';
        const parts = [t(hoverKey)];
        if (prefs.notchSummaryEnabled !== false) {
          const mode = prefs.notchSummaryMode || 'sessions';
          parts.push(t(`settings.notch.summaryMode.${mode}`));
        }
        return parts.join(' · ');
      }
      if (id === 'floatingBubble') {
        const trigger = prefs.floatingBubbleTrigger === 'hover' ? 'hover' : 'click';
        const parts = [t(`settings.floatingBubbleTrigger.${trigger}`)];
        const contentLabel = selectedOptionLabel('floatingBubbleContentInput');
        if (contentLabel) parts.push(contentLabel);
        return parts.join(' · ');
      }
      if (id === 'tray') {
        const parts = [];
        const contentLabel = selectedOptionLabel('trayContentInput');
        if (contentLabel) parts.push(contentLabel);
        if (prefs.trayMode === true) parts.push(t('settings.display.trayMode'));
        return parts.join(' · ');
      }
      return '';
    }

    function open(id) {
      if (!entries.has(id) || !available(id)) return;
      cancelScroll?.();
      closeHelp();
      if (active === 'main' && id !== active) stopWindowShortcutRecording?.();
      active = id;
      for (const [key, entry] of entries) {
        const selected = key === id;
        entry.page.hidden = !selected;
        entry.tab.setAttribute('aria-selected', String(selected));
        entry.tab.tabIndex = selected ? 0 : -1;
      }
    }

    function sync() {
      container.dataset.platform = platform() || 'unknown';
      container.dataset.edgeSide = settings()?.edgeDockSide === 'left' ? 'left' : 'right';
      if (!available(active)) open('main');
      for (const node of container.querySelectorAll('[data-i18n]')) {
        node.textContent = t(node.dataset.i18n);
      }
      for (const [id, entry] of entries) {
        entry.tab.hidden = !available(id);
        if (!entry.input) continue;
        const enabled = entry.input.checked;
        entry.tab.classList.toggle('is-enabled', enabled);
        entry.input.setAttribute('aria-label', t(entry.surface.title));
        entry.cardsWrap.classList.toggle('is-disabled-surface', !enabled);
        const summary = enabled ? activeSummary(id) : '';
        entry.heroSub.textContent = enabled && summary ? summary : t(entry.surface.intro);
        if (entry.helpTrigger) {
          entry.helpTrigger.hidden = !enabled;
          entry.helpTrigger.setAttribute('aria-label', t(entry.surface.title));
        }
        for (const subblock of entry.subblocks) {
          const toggle = document.getElementById(subblock.toggleId);
          if (toggle) subblock.node.hidden = !toggle.checked;
        }
      }
      dock.setAttribute('aria-label', t('settings.displayModes.switch'));
    }

    container.addEventListener('change', () => queueMicrotask(sync));
    open('main');
    sync();

    return {
      open,
      close: closeHelp,
      sync,
      get active() { return active; }
    };
  }

  return { create, SURFACES };
});
