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

  function trayProviderBadgeLayout(size = 44) {
    const iconSize = Math.max(16, Math.round(Number(size) || 44));
    const badgeSize = Math.round(iconSize * 0.43);
    const borderWidth = Math.max(2, Math.round(iconSize * 0.045));
    const edgeInset = Math.ceil(borderWidth / 2);
    return {
      iconSize,
      badgeSize,
      x: iconSize - badgeSize - edgeInset,
      y: iconSize - badgeSize - edgeInset,
      radius: Math.round(badgeSize * 0.28),
      borderWidth
    };
  }

  function createTrayProviderIconDeliveryGuard() {
    let latestDeliveryId = 0;
    return {
      begin() {
        latestDeliveryId += 1;
        return latestDeliveryId;
      },
      isCurrent(deliveryId) {
        return deliveryId === latestDeliveryId;
      }
    };
  }

  return { createTrayProviderIconDeliveryGuard, trayProviderIconSources, trayProviderBadgeLayout };
});
