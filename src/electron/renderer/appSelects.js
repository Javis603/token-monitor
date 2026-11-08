'use strict';

(function exposeAppSelects(root, factory) {
  const controls = typeof module === 'object' && module.exports ? require('./selectControl') : root.TokenMonitorSelectControl;
  const api = factory(controls);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorAppSelects = api;
})(typeof window !== 'undefined' ? window : null, function createAppSelectsApi(controls) {
  function mount({ document, t, fonts, providerIcon = () => null }) {
    const window = document.defaultView;
    const managed = new Map();
    const root = document.body;

    function optionsFor(select) {
      const models = /^(modelAliases.*Select|customPricingModelSelect)$/.test(select.id);
      const displayPresets = select.id === 'trayContentInput' || select.id === 'floatingBubbleContentInput';
      return {
        searchable: models ? true : displayPresets ? false : 'auto',
        searchLabel: () => t('trayComposer.search'),
        emptyLabel: () => t('settings.search.noMatches'),
        minPopupWidth: models ? 260 : 0,
        align: 'end',
        getOptionMeta(option) {
          const descriptionKey = option.dataset.selectDescription;
          const font = /^(interfaceFontPreset|displayFontPreset)$/.test(select.id);
          return {
            description: descriptionKey ? t(descriptionKey) : '',
            fontFamily: font ? fonts.fontFamilyForPreset(option.value, '', select.id === 'displayFontPreset' ? 'display' : 'interface') : '',
            annotation: select.id === 'languageInput' && option.value !== 'auto' ? option.value : '',
            icon: select.id === 'subscriptionProviderInput' ? providerIcon(option.value) : null
          };
        }
      };
    }

    function add(select) {
      const existing = managed.get(select);
      if (existing) {
        // Subscription forms move their currency select between visible slots.
        if (select.nextElementSibling !== existing.trigger) select.after(existing.trigger);
        return;
      }
      // Third-party content owns its own controls. Host-rendered plugin settings
      // still participate, along with the rest of the app's form controls.
      // The local device icon picker is initialized later by deviceIcons.js.
      if (select.id === 'deviceIconInput' || select.closest('.plugin-content') || select.multiple || select.size > 1) return;
      const focused = document.activeElement === select;
      const control = controls.enhance(select, optionsFor(select));
      if (control) {
        managed.set(select, control);
        if (focused) select.focus({ preventScroll: true });
      }
    }

    function scan(node) {
      if (node.nodeType !== 1) return;
      if (node.tagName === 'SELECT') add(node);
      for (const select of node.querySelectorAll('select')) add(select);
    }

    scan(root);
    const observer = new window.MutationObserver(records => {
      if (records.some(record => record.removedNodes.length)) {
        for (const [select, control] of managed) {
          if (!root.contains(select)) { control.destroy(); managed.delete(select); }
        }
      }
      for (const record of records) for (const node of record.addedNodes) scan(node);
    });
    observer.observe(root, { childList: true, subtree: true });
    return {
      destroy() {
        observer.disconnect();
        for (const control of managed.values()) control.destroy();
        managed.clear();
      }
    };
  }
  return { mount };
});
