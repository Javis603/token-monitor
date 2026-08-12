'use strict';

(function exposeTrayComposer(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTrayComposer = api;
})(typeof window !== 'undefined' ? window : null, function createTrayComposerApi() {
  const STYLE_GROUPS = [
    { id: 'icons', styles: ['appIcon', 'providerIcon'] },
    { id: 'bars', styles: ['singleBar', 'doubleBar', 'doublePercent', 'doubleReset'] },
    { id: 'text', styles: ['percent', 'percentReset', 'reset', 'tokens', 'cost', 'doubleInfo', 'customText', 'doubleCustomText'] },
    { id: 'spacing', styles: ['spacer', 'separatorDot'] }
  ];

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function button(className, text, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    if (text) el.textContent = text;
    if (onClick) el.addEventListener('click', onClick);
    return el;
  }

  function image(src, className = '') {
    const el = new Image();
    el.alt = '';
    el.className = className;
    if (src) el.src = src;
    return el;
  }

  function sourceForItem(item, rowIndex = 0) {
    if (Array.isArray(item?.rows)) return item.rows[rowIndex] || {};
    return item?.source || {};
  }

  function sourcePatch(item, rowIndex, patch) {
    if (Array.isArray(item.rows)) {
      const rows = item.rows.map((source, index) => index === rowIndex ? { ...source, ...patch } : source);
      return { ...item, rows };
    }
    return { ...item, source: { ...item.source, ...patch } };
  }

  function periodItemPatch(item, rowIndex, period) {
    if (Array.isArray(item.rows)) return sourcePatch(item, rowIndex, { period });
    return { ...item, period };
  }

  function costDisplayPatch(item, rowIndex, patch) {
    return Array.isArray(item?.rows)
      ? sourcePatch(item, rowIndex, patch)
      : { ...item, ...patch };
  }

  function usageScopePatch(item, rowIndex, usageScope) {
    return Array.isArray(item?.rows)
      ? sourcePatch(item, rowIndex, { usageScope })
      : { ...item, usageScope };
  }

  function accountModeSourcePatch(source, accounts, accountMode) {
    if (accountMode !== 'specific') {
      return { accountMode, accountKey: '', window: source.window };
    }
    const currentAccount = accounts.find((account) => account.value === source.accountKey);
    const firstAccount = accounts.find((account) => !account.disabled);
    return {
      accountMode,
      accountKey: currentAccount?.value || firstAccount?.value || '',
      window: 'primary'
    };
  }

  function duplicateTrayLayoutItem(layoutApi, currentLayout, itemId, options = {}) {
    const current = layoutApi.normalizeTrayLayout(currentLayout);
    const item = current.items.find((entry) => entry.id === itemId);
    if (!item || current.items.length >= layoutApi.MAX_ITEMS) return current;
    const appended = layoutApi.appendTrayLayoutItem(current, item.style, options);
    const appendedItem = appended.items[current.items.length];
    if (!appendedItem) return current;
    return layoutApi.replaceTrayLayoutItem(appended, appendedItem.id, {
      ...item,
      id: appendedItem.id
    });
  }

  function moveTrayLayoutItemByKey(layoutApi, currentLayout, itemId, key) {
    const current = layoutApi.normalizeTrayLayout(currentLayout);
    if (!['ArrowLeft', 'ArrowRight'].includes(key)) return { layout: current, moved: false };
    const index = current.items.findIndex((item) => item.id === itemId);
    if (index < 0) return { layout: current, moved: false };
    const nextIndex = clamp(index + (key === 'ArrowLeft' ? -1 : 1), 0, current.items.length - 1);
    if (nextIndex === index) return { layout: current, moved: false };
    return {
      layout: layoutApi.moveTrayLayoutItem(current, itemId, nextIndex),
      moved: true
    };
  }

  function handlePickerDocumentScroll(picker, eventTarget, actions = {}) {
    if (picker?.menu?.contains?.(eventTarget)) return 'ignore';
    if (!picker?.owner?.isConnected || !picker?.trigger?.isConnected) {
      actions.close?.();
      return 'close';
    }
    actions.reposition?.();
    return 'reposition';
  }

  function syncTrayComposerSurfaces(surfaces, composers, createComposer) {
    for (const surface of surfaces) {
      surface.root?.classList.toggle('hidden', !surface.visible);
      if (!surface.visible && composers[surface.id]) {
        composers[surface.id].destroy();
        delete composers[surface.id];
      } else if (surface.visible && !composers[surface.id]) {
        composers[surface.id] = createComposer(surface.id);
      }
    }
    return surfaces.some((surface) => surface.visible);
  }

  function createTrayComposer(options) {
    const {
      root,
      surface,
      layoutApi,
      getLayout,
      getStylePreview,
      getFontStylePreview,
      renderItem,
      getPreview,
      isEditable,
      onCustomize,
      onLayoutChange,
      providerChoices,
      accountChoices,
      windowChoices,
      label
    } = options;
    if (!root) return null;

    let selectedId = '';
    let addPopover = null;
    let itemPopover = null;
    let itemPopoverId = '';
    let activePicker = null;
    let suppressClick = false;
    let drag = null;
    let textCommitTimer = null;

    function l(key, fallback, params) {
      const value = label?.(key, params);
      return value && value !== key ? value : fallback;
    }

    function layout() {
      return layoutApi.normalizeTrayLayout(getLayout());
    }

    function editing() {
      return isEditable?.() !== false;
    }

    function emit(nextLayout, commit = true) {
      onLayoutChange(layoutApi.normalizeTrayLayout(nextLayout), { commit, surface });
    }

    function styleTitle(style) {
      const fallback = {
        appIcon: 'Token Monitor icon',
        providerIcon: 'AI tool icon',
        singleBar: 'Single quota bar',
        doubleBar: 'Double quota bar',
        doublePercent: 'Double percentage',
        doubleReset: 'Double reset time',
        doubleInfo: 'Two-line information',
        percent: 'Percentage',
        percentReset: 'Percentage + reset',
        reset: 'Reset time',
        tokens: 'Tokens',
        cost: 'Cost',
        account: 'Account',
        customText: 'Custom text',
        doubleCustomText: 'Double custom text',
        spacer: 'Spacer',
        separatorDot: 'Separator dot'
      };
      return l(`trayComposer.style.${style}`, fallback[style] || style);
    }

    function itemTitle(item) {
      return styleTitle(item.style);
    }

    function closePopover(popover) {
      if (!popover) return;
      try { popover.hidePopover(); } catch (_) { popover.removeAttribute('open'); }
    }

    function removePopover(popover) {
      if (!popover) return;
      if (activePicker?.owner === popover) closePickerMenu({ restoreFocus: false });
      closePopover(popover);
      popover.remove();
    }

    function positionPopover(popover, anchor) {
      if (!popover?.isConnected || !anchor?.isConnected) return;
      const anchorRect = anchor.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const gutter = 10;
      let left = anchorRect.left + (anchorRect.width - popoverRect.width) / 2;
      let top = anchorRect.bottom + 8;
      left = clamp(left, gutter, window.innerWidth - popoverRect.width - gutter);
      if (top + popoverRect.height > window.innerHeight - gutter) {
        top = Math.max(gutter, anchorRect.top - popoverRect.height - 8);
      }
      popover.style.left = `${Math.round(left)}px`;
      popover.style.top = `${Math.round(top)}px`;
    }

    function showPopover(popover, anchor) {
      document.body.append(popover);
      try { popover.showPopover(); } catch (_) { popover.setAttribute('open', ''); }
      requestAnimationFrame(() => positionPopover(popover, anchor));
    }

    function makePopover(className) {
      const popover = document.createElement('div');
      popover.className = `tray-composer-popover ${className}`;
      popover.setAttribute('popover', 'auto');
      popover.addEventListener('toggle', (event) => {
        if (event.newState === 'closed') {
          if (activePicker?.owner === popover) closePickerMenu({ restoreFocus: false });
          if (popover === addPopover) addPopover = null;
          if (popover === itemPopover) {
            itemPopover = null;
            itemPopoverId = '';
            selectedId = '';
            render();
          }
          popover.remove();
        }
      });
      return popover;
    }

    function popoverHeader(title, popover) {
      const header = document.createElement('div');
      header.className = 'tray-composer-popover-head';
      const heading = document.createElement('strong');
      heading.textContent = title;
      const close = button('tray-composer-close', '×', () => closePopover(popover));
      close.setAttribute('aria-label', l('trayComposer.close', 'Close'));
      header.append(heading, close);
      return header;
    }

    function openAddPopover(anchor) {
      removePopover(itemPopover);
      removePopover(addPopover);
      const popover = makePopover('tray-composer-gallery');
      addPopover = popover;
      popover.append(popoverHeader(l('trayComposer.addTitle', 'Add to display'), popover));
      const intro = document.createElement('p');
      intro.className = 'tray-composer-popover-note';
      intro.textContent = l('trayComposer.addHint', 'Choose an appearance first. You can set its data after it is added.');
      popover.append(intro);

      for (const group of STYLE_GROUPS) {
        const section = document.createElement('section');
        section.className = 'tray-composer-gallery-group';
        const heading = document.createElement('h4');
        const fallbackGroup = {
          icons: 'Icons',
          bars: 'Quota',
          text: 'Text',
          spacing: 'Spacing'
        }[group.id];
        heading.textContent = l(`trayComposer.group.${group.id}`, fallbackGroup);
        const grid = document.createElement('div');
        grid.className = 'tray-composer-gallery-grid';
        for (const style of group.styles) {
          const choice = button('tray-composer-gallery-choice', '', () => {
            const next = layoutApi.appendTrayLayoutItem(layout(), style);
            selectedId = next.items.at(-1)?.id || '';
            emit(next, true);
            closePopover(popover);
          });
          choice.setAttribute('aria-label', styleTitle(style));
          const preview = document.createElement('span');
          preview.className = 'tray-composer-gallery-preview';
          preview.append(image(getStylePreview(style), 'tray-composer-preview-image'));
          const name = document.createElement('span');
          name.className = 'tray-composer-gallery-name';
          name.textContent = styleTitle(style);
          choice.append(preview, name);
          grid.append(choice);
        }
        section.append(heading, grid);
        popover.append(section);
      }
      showPopover(popover, anchor);
    }

    function positionPickerMenu() {
      if (!activePicker?.menu?.isConnected || !activePicker.trigger?.isConnected) return;
      const { menu, trigger } = activePicker;
      const triggerRect = trigger.getBoundingClientRect();
      const gutter = 8;
      const gap = 4;
      const width = Math.min(
        Math.max(triggerRect.width, activePicker.hasDetails ? 224 : 184),
        window.innerWidth - gutter * 2
      );
      menu.style.width = `${Math.round(width)}px`;
      const below = window.innerHeight - triggerRect.bottom - gap - gutter;
      const above = triggerRect.top - gap - gutter;
      const openAbove = below < 140 && above > below;
      const available = Math.max(96, Math.min(260, openAbove ? above : below));
      menu.style.setProperty('--picker-max-height', `${Math.floor(available)}px`);
      const menuRect = menu.getBoundingClientRect();
      const left = clamp(triggerRect.right - width, gutter, window.innerWidth - width - gutter);
      const top = openAbove
        ? Math.max(gutter, triggerRect.top - gap - Math.min(menuRect.height, available))
        : triggerRect.bottom + gap;
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
      menu.classList.toggle('opens-above', openAbove);
    }

    function closePickerMenu({ restoreFocus = true } = {}) {
      const picker = activePicker;
      if (!picker) return;
      activePicker = null;
      document.removeEventListener('pointerdown', picker.onOutsidePointerDown, true);
      document.removeEventListener('keydown', picker.onDocumentKeyDown, true);
      document.removeEventListener('scroll', picker.onDocumentScroll, true);
      picker.trigger.setAttribute('aria-expanded', 'false');
      try { picker.menu.hidePopover(); } catch (_) { picker.menu.removeAttribute('open'); }
      picker.menu.remove();
      if (restoreFocus && picker.trigger.isConnected) picker.trigger.focus();
    }

    function openPickerMenu(owner, trigger, fieldLabel, choices, selectedValue, onPick) {
      if (!owner) return;
      if (activePicker?.trigger === trigger) {
        closePickerMenu();
        return;
      }
      closePickerMenu({ restoreFocus: false });
      trigger.setAttribute('aria-expanded', 'true');

      const menu = document.createElement('div');
      menu.className = 'tray-composer-picker-menu';
      menu.setAttribute('popover', 'manual');
      menu.setAttribute('aria-label', fieldLabel);
      const list = document.createElement('div');
      list.className = 'tray-composer-picker-list';
      list.setAttribute('role', 'listbox');

      const renderChoices = (query = '') => {
        const normalizedQuery = String(query).trim().toLocaleLowerCase();
        const matches = choices.filter((choice) => (
          !normalizedQuery
          || `${choice.label || ''} ${choice.detail || ''}`.toLocaleLowerCase().includes(normalizedQuery)
        ));
        list.replaceChildren();
        for (const choice of matches) {
          const option = button('tray-composer-picker-option', '', () => {
            if (choice.disabled) return;
            closePickerMenu({ restoreFocus: false });
            onPick(choice.value);
          });
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', String(choice.value) === String(selectedValue) ? 'true' : 'false');
          option.disabled = Boolean(choice.disabled);
          if (choice.icon) option.append(image(choice.icon, 'tray-composer-picker-icon'));
          if (choice.preview) option.append(image(choice.preview, 'tray-composer-picker-preview'));
          const copy = document.createElement('span');
          copy.className = 'tray-composer-picker-option-copy';
          const choiceLabel = document.createElement('span');
          choiceLabel.textContent = choice.label;
          copy.append(choiceLabel);
          if (choice.detail) {
            const detail = document.createElement('small');
            detail.textContent = choice.detail;
            copy.append(detail);
          }
          option.append(copy);
          if (String(choice.value) === String(selectedValue)) {
            const check = document.createElement('span');
            check.className = 'tray-composer-picker-check';
            check.textContent = '✓';
            option.append(check);
          }
          list.append(option);
        }
        if (!matches.length) {
          const empty = document.createElement('p');
          empty.className = 'tray-composer-picker-empty';
          empty.textContent = l('trayComposer.noMatches', 'No matching options');
          list.append(empty);
        }
      };

      let search = null;
      if (choices.length > 8) {
        search = document.createElement('input');
        search.type = 'search';
        search.className = 'tray-composer-picker-search';
        search.placeholder = l('trayComposer.search', 'Search options');
        search.setAttribute('aria-label', search.placeholder);
        search.addEventListener('input', () => renderChoices(search.value));
        menu.append(search);
      }
      menu.append(list);

      const focusOption = (direction) => {
        const options = [...list.querySelectorAll('.tray-composer-picker-option:not(:disabled)')];
        if (!options.length) return;
        const currentIndex = options.indexOf(document.activeElement);
        const nextIndex = currentIndex < 0
          ? (direction > 0 ? 0 : options.length - 1)
          : (currentIndex + direction + options.length) % options.length;
        options[nextIndex].focus();
      };
      menu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closePickerMenu();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          focusOption(event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const options = [...list.querySelectorAll('.tray-composer-picker-option:not(:disabled)')];
          options[event.key === 'Home' ? 0 : options.length - 1]?.focus();
        }
      });
      renderChoices();

      const onOutsidePointerDown = (event) => {
        if (menu.contains(event.target) || trigger.contains(event.target)) return;
        closePickerMenu({ restoreFocus: false });
      };
      const onDocumentKeyDown = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        closePickerMenu();
      };
      const onDocumentScroll = (event) => {
        // Stats updates can adjust the settings page's scroll position while a
        // picker is open. Keep the in-progress control stable and follow its
        // connected trigger instead of treating that layout correction as an
        // outside dismissal.
        handlePickerDocumentScroll(activePicker, event.target, {
          close: () => closePickerMenu({ restoreFocus: false }),
          reposition: positionPickerMenu
        });
      };
      activePicker = {
        owner,
        menu,
        trigger,
        hasDetails: choices.some((choice) => choice.detail),
        onOutsidePointerDown,
        onDocumentKeyDown,
        onDocumentScroll
      };
      owner.append(menu);
      try { menu.showPopover(); } catch (_) { menu.setAttribute('open', ''); }
      document.addEventListener('pointerdown', onOutsidePointerDown, true);
      document.addEventListener('keydown', onDocumentKeyDown, true);
      document.addEventListener('scroll', onDocumentScroll, true);
      requestAnimationFrame(() => {
        positionPickerMenu();
        const selected = list.querySelector('[aria-selected="true"]:not(:disabled)');
        (search || selected || list.querySelector('.tray-composer-picker-option:not(:disabled)'))?.focus();
      });
    }

    function picker(fieldLabel, choices, currentValue, onPick, options = {}) {
      const field = document.createElement('div');
      field.className = 'tray-composer-field';
      const heading = document.createElement('span');
      heading.className = 'tray-composer-field-label';
      heading.textContent = fieldLabel;
      const current = choices.find((choice) => String(choice.value) === String(currentValue)) || choices[0];
      const selectedValue = current?.value;
      const trigger = button('tray-composer-picker', '');
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      if (current?.icon) trigger.append(image(current.icon, 'tray-composer-picker-icon'));
      if (current?.preview) trigger.append(image(current.preview, 'tray-composer-picker-preview'));
      const value = document.createElement('span');
      value.className = 'tray-composer-picker-value';
      value.textContent = current?.label || String(currentValue || '');
      const chevron = document.createElement('span');
      chevron.className = 'tray-composer-picker-chevron';
      chevron.textContent = '⌄';
      trigger.append(value, chevron);
      trigger.addEventListener('click', () => {
        openPickerMenu(
          field.closest('.tray-composer-popover'),
          trigger,
          fieldLabel,
          choices,
          selectedValue,
          onPick
        );
      });
      trigger.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        openPickerMenu(
          field.closest('.tray-composer-popover'),
          trigger,
          fieldLabel,
          choices,
          selectedValue,
          onPick
        );
      });
      if (options.wide) field.classList.add('wide');
      field.append(heading, trigger);
      return field;
    }

    function updateItem(item, patch) {
      const next = layoutApi.replaceTrayLayoutItem(layout(), item.id, patch);
      emit(next, true);
      renderItemPopover(item.id);
    }

    function reflectItemPreview(item) {
      const src = renderItem(item);
      const selector = `[data-item-id="${CSS.escape(item.id)}"] .tray-composer-preview-image`;
      const stripImage = root.querySelector(selector);
      if (stripImage) stripImage.src = src;
      const editorImage = itemPopover?.querySelector('.tray-composer-editor-preview .tray-composer-preview-image');
      if (editorImage) editorImage.src = src;
    }

    function updateTextItem(item, patch, commit = false) {
      const next = layoutApi.replaceTrayLayoutItem(layout(), item.id, { ...item, ...patch });
      const nextItem = next.items.find((entry) => entry.id === item.id);
      if (!nextItem) return;
      Object.assign(item, nextItem);
      emit(next, commit);
      reflectItemPreview(nextItem);
    }

    function queueTextItemUpdate(item, patch) {
      updateTextItem(item, patch, false);
      clearTimeout(textCommitTimer);
      textCommitTimer = setTimeout(() => {
        textCommitTimer = null;
        updateTextItem(item, {}, true);
      }, 300);
    }

    function commitTextItemUpdate(item, patch) {
      clearTimeout(textCommitTimer);
      textCommitTimer = null;
      updateTextItem(item, patch, true);
    }

    function textInput(fieldLabel, value, onEdit) {
      const field = document.createElement('label');
      field.className = 'tray-composer-field';
      const heading = document.createElement('span');
      heading.className = 'tray-composer-field-label';
      heading.textContent = fieldLabel;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tray-composer-text-input';
      input.maxLength = 40;
      input.value = value || '';
      input.placeholder = l('trayComposer.customText.placeholder', 'Enter text');
      input.addEventListener('input', () => onEdit(input.value, false));
      input.addEventListener('change', () => onEdit(input.value, true));
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        input.blur();
      });
      field.append(heading, input);
      return field;
    }

    function customTextEditor(item) {
      if (item.type === 'stack') {
        const fields = document.createDocumentFragment();
        const labels = [
          l('trayComposer.customText.top', 'Top text'),
          l('trayComposer.customText.bottom', 'Bottom text')
        ];
        for (let index = 0; index < 2; index += 1) {
          fields.append(textInput(labels[index], item.lines?.[index], (value, commit) => {
            const lines = [...(item.lines || ['', ''])];
            lines[index] = value;
            if (commit) commitTextItemUpdate(item, { lines });
            else queueTextItemUpdate(item, { lines });
          }));
        }
        return fields;
      }
      return textInput(
        l('trayComposer.customText.single', 'Text'),
        item.text,
        (text, commit) => {
          if (commit) commitTextItemUpdate(item, { text });
          else queueTextItemUpdate(item, { text });
        }
      );
    }

    function textMetricChoices() {
      return [
        { value: 'percent', style: 'percent' },
        { value: 'percentReset', style: 'percentReset' },
        { value: 'reset', style: 'reset' },
        { value: 'tokens', style: 'tokens' },
        { value: 'cost', style: 'cost' }
      ].map((entry) => ({ ...entry, label: styleTitle(entry.style) }));
    }

    function periodChoices() {
      return [
        { value: 'today', label: l('trayComposer.period.today', 'Today') },
        { value: 'month', label: l('trayComposer.period.month', 'This month') },
        { value: 'allTime', label: l('trayComposer.period.allTime', 'All time') }
      ];
    }

    function costDisplayEditors(item, rowIndex = 0) {
      const source = Array.isArray(item.rows) ? sourceForItem(item, rowIndex) : item;
      return [
        picker(
          l('trayComposer.costFormat', 'Cost format'),
          [
            { value: 'compact', label: l('trayComposer.costFormat.compact', 'Compact') },
            { value: 'full', label: l('trayComposer.costFormat.full', 'Full number') }
          ],
          source.costFormat,
          (costFormat) => updateItem(item, costDisplayPatch(item, rowIndex, { costFormat }))
        ),
        picker(
          l('trayComposer.costDecimals', 'Decimal places'),
          [
            { value: 'auto', label: l('trayComposer.costDecimals.auto', 'Automatic') },
            ...[0, 1, 2, 3, 4].map((value) => ({ value, label: String(value) }))
          ],
          source.costDecimals,
          (costDecimals) => updateItem(item, costDisplayPatch(item, rowIndex, {
            costDecimals: costDecimals === 'auto' ? 'auto' : Number(costDecimals)
          }))
        )
      ];
    }

    function usageScopeEditor(item, rowIndex = 0) {
      const source = Array.isArray(item.rows) ? sourceForItem(item, rowIndex) : item;
      return picker(
        l('trayComposer.usageScope', 'Usage source'),
        [
          { value: 'all', label: l('trayComposer.usageScope.all', 'All AI tools') },
          { value: 'recent', label: l('trayComposer.usageScope.recent', 'Most recently active tool') }
        ],
        source.usageScope,
        (usageScope) => updateItem(item, usageScopePatch(item, rowIndex, usageScope))
      );
    }

    function sourceEditor(item, rowIndex, title = '', options = {}) {
      const source = sourceForItem(item, rowIndex);
      const section = document.createElement('section');
      section.className = 'tray-composer-source-editor';
      if (title) {
        const heading = document.createElement('h4');
        heading.textContent = title;
        section.append(heading);
      }
      const metric = options.includeMetric === true ? source.metric : item.metric;
      if (options.includeMetric === true) {
        const metrics = textMetricChoices();
        section.append(picker(
          l('trayComposer.textMetric', 'Text'),
          metrics,
          metric,
          (nextMetric) => updateItem(item, sourcePatch(item, rowIndex, { metric: nextMetric }))
        ));
      }

      if (metric === 'tokens' || metric === 'cost') {
        const currentPeriod = Array.isArray(item.rows) ? source.period : item.period;
        section.append(usageScopeEditor(item, rowIndex));
        section.append(picker(
          l('trayComposer.period', 'Period'),
          periodChoices(),
          currentPeriod,
          (period) => updateItem(item, periodItemPatch(item, rowIndex, period))
        ));
        if (metric === 'cost') section.append(...costDisplayEditors(item, rowIndex));
        return section;
      }

      let providers = providerChoices(source.provider, {
        includeAll: options.includeAllProviders === true
      });
      if (options.includeAutoCondition === true) {
        providers = providers.map((choice) => (
          choice.value === 'auto'
            ? { ...choice, detail: l('trayComposer.provider.autoConfigDetail', 'Choose a condition below') }
            : choice
        ));
      }
      section.append(picker(
        l('trayComposer.provider', 'AI tool'),
        providers,
        source.provider,
        (provider) => updateItem(item, sourcePatch(item, rowIndex, {
          provider,
          accountMode: 'lowest',
          accountKey: '',
          window: 'primary'
        }))
      ));

      if (options.includeAutoCondition === true && source.provider === 'auto') {
        const autoModes = [
          {
            value: 'lowestLimit',
            label: l('trayComposer.icon.auto.lowestLimit', 'Lowest remaining quota')
          },
          {
            value: 'recent',
            label: l('trayComposer.icon.auto.recent', 'Most recently active tool')
          },
          {
            value: 'tokens',
            label: l('trayComposer.icon.auto.tokens', 'Highest Tokens')
          },
          {
            value: 'cost',
            label: l('trayComposer.icon.auto.cost', 'Highest cost')
          }
        ];
        section.append(picker(
          l('trayComposer.icon.auto', 'Automatic condition'),
          autoModes,
          item.autoMode,
          (autoMode) => updateItem(item, { ...item, autoMode })
        ));
        if (item.autoMode === 'tokens' || item.autoMode === 'cost') {
          section.append(picker(
            l('trayComposer.period', 'Period'),
            periodChoices(),
            item.period,
            (period) => updateItem(item, { ...item, period })
          ));
        }
      }

      const includeAccount = options.includeAccount !== false;
      const accounts = includeAccount && source.provider !== 'auto'
        ? accountChoices(source.provider)
        : [];
      if (includeAccount && source.provider !== 'auto' && (accounts.length > 1 || source.accountMode !== 'lowest')) {
        const modes = [
          { value: 'lowest', label: l('trayComposer.account.lowest', 'Lowest remaining') },
          { value: 'active', label: l('trayComposer.account.active', 'Current account') },
          { value: 'specific', label: l('trayComposer.account.specific', 'Specific account') }
        ];
        section.append(picker(
          l('trayComposer.account', 'Account'),
          modes,
          source.accountMode,
          (accountMode) => updateItem(
            item,
            sourcePatch(item, rowIndex, accountModeSourcePatch(source, accounts, accountMode))
          )
        ));
      }

      if (includeAccount && source.accountMode === 'specific') {
        const hasSelectedAccount = accounts.some((account) => account.value === source.accountKey);
        const unavailableAccount = {
          value: source.accountKey || '',
          label: l('trayComposer.account.none', 'No matching account'),
          disabled: true
        };
        const accountOptions = hasSelectedAccount
          ? accounts
          : [unavailableAccount, ...accounts];
        section.append(picker(
          l('trayComposer.account.specificLabel', 'Choose account'),
          accountOptions,
          source.accountKey,
          (accountKey) => updateItem(item, sourcePatch(item, rowIndex, {
            accountKey,
            window: 'primary'
          }))
        ));
      }

      if (options.includeWindow !== false) {
        const windows = windowChoices(source);
        section.append(picker(
          l('trayComposer.window', 'Quota window'),
          windows,
          source.window,
          (window) => updateItem(item, sourcePatch(item, rowIndex, { window }))
        ));
      }

      if (options.includeValue !== false) {
        const values = [
          { value: 'remaining', label: l('trayComposer.value.remaining', 'Remaining') },
          { value: 'used', label: l('trayComposer.value.used', 'Used') }
        ];
        section.append(picker(
          l('trayComposer.value', 'Display'),
          values,
          source.valueMode,
          (valueMode) => updateItem(item, sourcePatch(item, rowIndex, { valueMode }))
        ));
      }
      return section;
    }

    function barIconEditor(item) {
      const providers = providerChoices(item.rows.map((source) => source.provider));
      const app = providers.find((entry) => entry.value === 'auto');
      const choiceForRow = (index) => {
        const source = item.rows[index] || {};
        const provider = providers.find((entry) => entry.value === source.provider);
        return {
          value: index === 0 ? 'first' : 'second',
          label: item.rows.length === 1
            ? l('trayComposer.icon.provider', 'AI tool icon')
            : l('trayComposer.icon.row', `Value ${index + 1} AI tool`, { number: index + 1 }),
          icon: provider?.icon
        };
      };
      const choices = [{
        value: 'app',
        label: l('trayComposer.icon.app', 'Token Monitor'),
        icon: app?.icon
      }, choiceForRow(0)];
      if (item.rows.length > 1) choices.push(choiceForRow(1));
      choices.push({ value: 'none', label: l('trayComposer.icon.none', 'No icon') });
      return picker(
        l('trayComposer.icon', 'Icon'),
        choices,
        item.icon,
        (icon) => updateItem(item, { ...item, icon })
      );
    }

    function fontStyleEditor(item) {
      const choices = [
        {
          value: 'normal',
          label: l('trayComposer.fontStyle.normal', 'Standard')
        },
        {
          value: 'condensed',
          label: l('trayComposer.fontStyle.condensed', 'Condensed')
        },
        {
          value: 'menubar',
          label: l('trayComposer.fontStyle.menubar', 'Menu bar')
        },
        {
          value: 'compactMono',
          label: l('trayComposer.fontStyle.compactMono', 'Compact mono')
        }
      ].map((choice) => ({
        ...choice,
        preview: getFontStylePreview?.(item, choice.value)
      }));
      return picker(
        l('trayComposer.fontStyle', 'Typeface'),
        choices,
        item.fontStyle,
        (fontStyle) => updateItem(item, { ...item, fontStyle })
      );
    }

    function renderItemPopover(id) {
      const item = layout().items.find((entry) => entry.id === id);
      if (!item) {
        removePopover(itemPopover);
        return;
      }
      const anchor = root.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
      const existingAnchor = anchor || root.querySelector('.tray-composer-add');
      removePopover(itemPopover);
      const popover = makePopover('tray-composer-editor');
      itemPopover = popover;
      itemPopoverId = id;
      popover.append(popoverHeader(itemTitle(item), popover));
      const hero = document.createElement('div');
      hero.className = 'tray-composer-editor-preview';
      hero.append(image(renderItem(item), 'tray-composer-preview-image'));
      popover.append(hero);

      if (item.type === 'icon') {
        const iconTypes = [
          { value: 'app', label: l('trayComposer.icon.app', 'Token Monitor'), icon: providerChoices('auto').find((choice) => choice.value === 'auto')?.icon },
          { value: 'provider', label: l('trayComposer.icon.provider', 'AI tool icon') }
        ];
        popover.append(picker(
          l('trayComposer.icon', 'Icon'),
          iconTypes,
          item.icon,
          (icon) => updateItem(item, {
            ...item,
            icon,
            style: icon === 'app' ? 'appIcon' : 'providerIcon',
            source: { ...item.source, provider: icon === 'app' ? 'auto' : item.source.provider }
          })
        ));
        if (item.icon === 'provider') {
          popover.append(sourceEditor(item, 0, '', {
            includeAccount: false,
            includeAllProviders: true,
            includeAutoCondition: true,
            includeValue: false,
            includeWindow: false
          }));
        }
      } else if (item.metric === 'custom') {
        popover.append(customTextEditor(item));
        popover.append(fontStyleEditor(item));
        if (item.type === 'stack') {
          const alignments = [
            { value: 'left', label: l('trayComposer.alignment.left', 'Left') },
            { value: 'right', label: l('trayComposer.alignment.right', 'Right') }
          ];
          popover.append(picker(
            l('trayComposer.alignment', 'Alignment'),
            alignments,
            item.alignment,
            (alignment) => updateItem(item, { ...item, alignment, alignmentCustomized: true })
          ));
        }
      } else if (item.type === 'bars' || item.type === 'stack') {
        popover.append(barIconEditor(item));
        if (item.type === 'stack') {
          if (item.metric !== 'mixed') {
            const stackMetrics = [
              { value: 'percent', label: styleTitle('doublePercent') },
              { value: 'reset', label: styleTitle('doubleReset') }
            ];
            popover.append(picker(
              l('trayComposer.stackMetric', 'Values'),
              stackMetrics,
              item.metric,
              (metric) => updateItem(item, {
                ...item,
                metric,
                style: metric === 'reset' ? 'doubleReset' : 'doublePercent',
                alignment: metric === 'reset' ? 'left' : 'right',
                alignmentCustomized: false
              })
            ));
          }
          popover.append(fontStyleEditor(item));
          const alignments = [
            { value: 'left', label: l('trayComposer.alignment.left', 'Left') },
            { value: 'right', label: l('trayComposer.alignment.right', 'Right') }
          ];
          popover.append(picker(
            l('trayComposer.alignment', 'Alignment'),
            alignments,
            item.alignment,
            (alignment) => updateItem(item, { ...item, alignment, alignmentCustomized: true })
          ));
        }
        item.rows.forEach((_, index) => {
          popover.append(sourceEditor(
            item,
            index,
            item.type === 'bars' && item.rows.length === 1
              ? l('trayComposer.bar', 'Quota bar')
              : item.type === 'bars'
                ? l('trayComposer.barNumber', `Bar ${index + 1}`, { number: index + 1 })
                : l('trayComposer.valueNumber', `Value ${index + 1}`, { number: index + 1 }),
            {
              includeMetric: item.metric === 'mixed',
              includeValue: item.type === 'bars'
                || item.metric === 'percent'
                || sourceForItem(item, index).metric === 'percent'
                || sourceForItem(item, index).metric === 'percentReset'
            }
          ));
        });
      } else if (item.type === 'spacer') {
        const variants = [
          { value: 'space', label: styleTitle('spacer') },
          { value: 'dot', label: styleTitle('separatorDot') }
        ];
        popover.append(picker(
          l('trayComposer.spacer.variant', 'Style'),
          variants,
          item.variant,
          (variant) => updateItem(item, {
            ...item,
            variant,
            style: variant === 'dot' ? 'separatorDot' : 'spacer'
          })
        ));
        const sizes = [
          { value: 'narrow', label: l('trayComposer.spacer.narrow', 'Narrow') },
          { value: 'regular', label: l('trayComposer.spacer.regular', 'Regular') },
          { value: 'wide', label: l('trayComposer.spacer.wide', 'Wide') }
        ];
        popover.append(picker(
          l('trayComposer.spacer.size', 'Spacing'),
          sizes,
          item.size,
          (size) => updateItem(item, { ...item, size })
        ));
      } else {
        const metrics = textMetricChoices();
        if (item.metric === 'account') metrics.push({ value: 'account', style: 'account' });
        const metricChoices = metrics.map((entry) => ({
          ...entry,
          label: entry.label || styleTitle(entry.style)
        }));
        popover.append(picker(
          l('trayComposer.textMetric', 'Text'),
          metricChoices,
          item.metric,
          (metric) => {
            const selected = metricChoices.find((entry) => entry.value === metric);
            updateItem(item, { ...item, metric, style: selected?.style || metric });
          }
        ));
        popover.append(fontStyleEditor(item));
        if (item.metric === 'tokens' || item.metric === 'cost') {
          popover.append(usageScopeEditor(item));
          popover.append(picker(
            l('trayComposer.period', 'Period'),
            periodChoices(),
            item.period,
            (period) => updateItem(item, { ...item, period })
          ));
          if (item.metric === 'cost') popover.append(...costDisplayEditors(item));
        } else {
          popover.append(sourceEditor(item, 0, '', {
            includeValue: item.metric === 'percent' || item.metric === 'percentReset'
          }));
        }
      }

      const footer = document.createElement('div');
      footer.className = 'tray-composer-editor-actions';
      footer.append(
        button('tray-composer-secondary', l('trayComposer.duplicate', 'Duplicate'), () => {
          const next = duplicateTrayLayoutItem(layoutApi, layout(), item.id);
          emit(next, true);
          closePopover(popover);
        }),
        button('tray-composer-danger', l('trayComposer.remove', 'Remove'), () => {
          emit(layoutApi.removeTrayLayoutItem(layout(), item.id), true);
          closePopover(popover);
        })
      );
      popover.append(footer);
      showPopover(popover, existingAnchor);
    }

    function openItemPopover(id) {
      selectedId = id;
      render();
      renderItemPopover(id);
    }

    function beginDrag(event, itemEl, id) {
      if (event.button !== 0) return;
      if (drag) endDrag(null, false);
      const items = [...root.querySelectorAll('.tray-composer-item')];
      const sourceIndex = items.indexOf(itemEl);
      if (sourceIndex < 0) return;
      const itemRects = items.map((el) => el.getBoundingClientRect());
      const itemsContainer = root.querySelector('.tray-composer-items');
      const containerStyle = itemsContainer ? getComputedStyle(itemsContainer) : null;
      const gap = Number.parseFloat(containerStyle?.columnGap || containerStyle?.gap || '0') || 0;
      const initialLayout = layout();
      drag = {
        id,
        itemEl,
        items,
        itemRects,
        pointerId: event.pointerId,
        startX: event.clientX,
        sourceIndex,
        targetIndex: sourceIndex,
        shiftWidth: itemRects[sourceIndex].width + gap,
        started: false,
        initialLayout,
        layout: initialLayout
      };
      window.addEventListener('pointermove', moveDrag, true);
      window.addEventListener('pointerup', endDrag, true);
      window.addEventListener('pointercancel', cancelDrag, true);
      // Not capture: see the note on the limit provider drag. A capture `blur`
      // listener on `window` also catches every element's blur, so the press
      // moving focus off the last-clicked control killed the drag immediately.
      window.addEventListener('blur', cancelDrag);
      itemEl.addEventListener('lostpointercapture', cancelDrag, { once: true });
      try { itemEl.setPointerCapture?.(event.pointerId); } catch (_) {}
    }

    function updateDragSpacing() {
      const { items, itemEl, sourceIndex, targetIndex, shiftWidth } = drag;
      items.forEach((el, index) => {
        if (el === itemEl) return;
        let shift = 0;
        if (sourceIndex < targetIndex && index > sourceIndex && index <= targetIndex) {
          shift = -shiftWidth;
        } else if (targetIndex < sourceIndex && index >= targetIndex && index < sourceIndex) {
          shift = shiftWidth;
        }
        el.style.setProperty('--drag-shift', `${shift}px`);
      });
    }

    function moveDrag(event) {
      if (!drag) return;
      if (event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      if (!drag.started && Math.abs(dx) < 4) return;
      if (!drag.started) {
        drag.started = true;
        suppressClick = true;
        drag.itemEl.classList.add('dragging');
        root.classList.add('drag-active');
      }
      event.preventDefault();
      drag.itemEl.style.setProperty('--drag-x', `${dx}px`);
      const draggedRect = drag.itemRects[drag.sourceIndex];
      const draggedCenter = draggedRect.left + draggedRect.width / 2 + dx;
      let targetIndex = 0;
      for (let index = 0; index < drag.items.length; index += 1) {
        if (index === drag.sourceIndex) continue;
        const rect = drag.itemRects[index];
        if (draggedCenter > rect.left + rect.width / 2) targetIndex += 1;
      }
      targetIndex = clamp(targetIndex, 0, drag.items.length - 1);
      if (targetIndex === drag.targetIndex) return;
      drag.targetIndex = targetIndex;
      drag.layout = layoutApi.moveTrayLayoutItem(drag.initialLayout, drag.id, targetIndex);
      updateDragSpacing();
    }

    function cancelDrag(event) {
      endDrag(event, false);
    }

    function endDrag(event, commit = true) {
      if (!drag) return;
      if (event?.pointerId != null && event.pointerId !== drag.pointerId) return;
      const completed = drag.started;
      const { itemEl, items, pointerId } = drag;
      itemEl.classList.remove('dragging');
      itemEl.style.removeProperty('--drag-x');
      items.forEach((el) => el.style.removeProperty('--drag-shift'));
      root.classList.remove('drag-active');
      const next = drag.layout;
      drag = null;
      window.removeEventListener('pointermove', moveDrag, true);
      window.removeEventListener('pointerup', endDrag, true);
      window.removeEventListener('pointercancel', cancelDrag, true);
      window.removeEventListener('blur', cancelDrag);
      itemEl.removeEventListener('lostpointercapture', cancelDrag);
      try {
        if (itemEl.hasPointerCapture?.(pointerId)) itemEl.releasePointerCapture(pointerId);
      } catch (_) {}
      if (completed && commit) {
        emit(next, true);
        render();
        setTimeout(() => { suppressClick = false; }, 0);
      } else {
        suppressClick = false;
      }
    }

    function keyboardMove(event, id) {
      const movement = moveTrayLayoutItemByKey(layoutApi, layout(), id, event.key);
      if (!movement.moved) return;
      event.preventDefault();
      emit(movement.layout, true);
      render();
      requestAnimationFrame(() => root.querySelector(`[data-item-id="${CSS.escape(id)}"]`)?.focus());
    }

    function render() {
      const editable = editing();
      const current = layout();
      const heading = document.createElement('div');
      heading.className = 'tray-composer-heading';
      const title = document.createElement('span');
      title.textContent = l('trayComposer.preview', 'Live preview');
      if (editable) {
        const hint = document.createElement('span');
        hint.textContent = l('trayComposer.dragHint', 'Drag to reorder · Click to configure');
        heading.append(title, hint);
      } else {
        const customize = button('tray-composer-customize', l('settings.tray.custom', 'Customize…'), onCustomize);
        heading.append(title, customize);
      }

      const strip = document.createElement('div');
      strip.className = 'tray-composer-strip';
      const items = document.createElement('div');
      items.className = 'tray-composer-items';
      if (!editable) {
        const preview = getPreview?.() || {};
        const content = document.createElement('span');
        content.className = 'tray-composer-live-preview';
        if (preview.generatedSrc) {
          content.classList.add('is-menubar');
          content.append(image(preview.generatedSrc, 'tray-composer-menubar-generated'));
        } else if (preview.src) {
          content.append(image(preview.src, 'tray-composer-preview-image'));
        } else {
          content.classList.add('is-text');
          content.textContent = preview.text || 'Σ';
        }
        items.append(content);
      } else if (!current.items.length) {
        const empty = document.createElement('span');
        empty.className = 'tray-composer-empty';
        empty.textContent = l('trayComposer.empty', 'Add your first item');
        items.append(empty);
      } else {
        current.items.forEach((item) => {
          const itemEl = button('tray-composer-item', '');
          itemEl.dataset.itemId = item.id;
          itemEl.title = itemTitle(item);
          itemEl.setAttribute('aria-label', `${itemTitle(item)}. ${l('trayComposer.itemHint', 'Drag to reorder; click to configure.')}`);
          itemEl.classList.toggle('selected', selectedId === item.id);
          itemEl.classList.toggle('is-spacer', item.type === 'spacer');
          itemEl.append(image(renderItem(item), 'tray-composer-preview-image'));
          itemEl.addEventListener('pointerdown', (event) => beginDrag(event, itemEl, item.id));
          itemEl.addEventListener('click', () => {
            if (suppressClick) return;
            openItemPopover(item.id);
          });
          itemEl.addEventListener('keydown', (event) => keyboardMove(event, item.id));
          items.append(itemEl);
        });
      }
      strip.append(items);
      if (editable) {
        const add = button('tray-composer-add', '+', () => openAddPopover(add));
        add.setAttribute('aria-label', l('trayComposer.add', 'Add display item'));
        strip.append(add);
      }
      root.replaceChildren(heading, strip);
      root.classList.toggle('is-editing', editable);
      root.classList.toggle('is-empty', editable && current.items.length === 0);
    }

    function refresh() {
      // Do not replace controls underneath an active pointer gesture or open
      // picker/popover. Periodic stats/reset refreshes may update the real tray,
      // but an editor the user is operating must keep stable DOM and focus.
      if (drag || addPopover || itemPopover) return;
      render();
    }

    function destroy() {
      clearTimeout(textCommitTimer);
      textCommitTimer = null;
      endDrag(null, false);
      closePickerMenu({ restoreFocus: false });
      removePopover(addPopover);
      removePopover(itemPopover);
      window.removeEventListener('resize', repositionOpenPopovers);
      root.replaceChildren();
    }

    function repositionOpenPopovers() {
      if (addPopover) positionPopover(addPopover, root.querySelector('.tray-composer-add'));
      if (itemPopover) positionPopover(itemPopover, root.querySelector(`[data-item-id="${CSS.escape(itemPopoverId)}"]`));
      positionPickerMenu();
    }

    window.addEventListener('resize', repositionOpenPopovers);

    render();
    return { destroy, refresh, render };
  }

  return {
    accountModeSourcePatch,
    costDisplayPatch,
    createTrayComposer,
    duplicateTrayLayoutItem,
    handlePickerDocumentScroll,
    moveTrayLayoutItemByKey,
    periodItemPatch,
    syncTrayComposerSurfaces,
    usageScopePatch
  };
});
