'use strict';

(function exposeTrayProviderIcons(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTrayProviderIcons = api;
})(typeof window !== 'undefined' ? window : null, function createTrayProviderIconsApi() {
  const SPECIAL_ICON_SOURCES = {
    claude: '../../../assets/icons/tray-claude.svg',
    codex: '../../../assets/icons/tray-codex.svg',
    hermes: '../../../assets/icons/hermes-agent.svg',
    kimi: '../../../assets/icons/moonshot.svg',
    mimo: '../../../assets/icons/xiaomi.svg',
    grok: '../../../assets/icons/grok.svg',
    micode: '../../../assets/icons/xiaomi.svg',
    zcode: '../../../assets/icons/zai.svg'
  };

  function trayProviderIconSources(clientIds) {
    const sources = {};
    for (const id of clientIds || []) {
      sources[id] = SPECIAL_ICON_SOURCES[id] || `../../../assets/icons/${id}.svg`;
    }
    return sources;
  }

  return { trayProviderIconSources };
});
