'use strict';

(function exposeTrayProviderIcons(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTrayProviderIcons = api;
})(typeof window !== 'undefined' ? window : null, function createTrayProviderIconsApi() {
  const SPECIAL_ICON_SOURCES = {
    claude: '../../../assets/icons/tray-claude.svg',
    'claude-brand': '../../../assets/icons/claude.svg',
    codex: '../../../assets/icons/tray-codex.svg',
    chatgpt: '../../../assets/icons/codex.svg',
    hermes: '../../../assets/icons/hermes-agent.svg',
    kimi: '../../../assets/icons/kimi.svg',
    mimo: '../../../assets/icons/xiaomi.svg',
    grok: '../../../assets/icons/grok.svg',
    micode: '../../../assets/icons/xiaomi.svg',
    zcode: '../../../assets/icons/zai.svg',
    zaiteam: '../../../assets/icons/zai.svg',
    thirdparty: '../../../assets/icons/newapi.svg'
  };

  function trayProviderIconSources(clientIds) {
    const sources = {};
    for (const id of clientIds || []) {
      sources[id] = SPECIAL_ICON_SOURCES[id] || `../../../assets/icons/${id}.svg`;
    }
    return sources;
  }

  // Whether every visible pixel of a rasterized mark is the same single ink.
  // Both halves are needed: achromatic alone would also accept a greyscale
  // artwork with real shading, and re-inking that would flatten it onto one
  // tone. Anti-aliasing is free to vary the alpha — drawing onto a transparent
  // canvas moves the coverage, not the colour channels — so soft edges still
  // read as flat. An image with nothing opaque has no ink to match: false, i.e.
  // leave it alone.
  function isFlatInkPixels(pixels, options = {}) {
    if (!pixels || typeof pixels.length !== 'number') return false;
    const alphaThreshold = Number.isFinite(options.alphaThreshold) ? options.alphaThreshold : 12;
    // Tolerance, not equality: rasterization leaves a channel off by a hair.
    const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : 12;
    let level = -1;
    for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
      if (pixels[offset + 3] <= alphaThreshold) continue;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > tolerance) return false;
      const pixelLevel = (r + g + b) / 3;
      if (level < 0) level = pixelLevel;
      else if (Math.abs(pixelLevel - level) > tolerance) return false;
    }
    return level >= 0;
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

  function trayProviderOpticalLayout(bounds, size = 44, opticalRatio = 0.78) {
    const boxSize = Math.max(1, Number(size) || 44);
    const width = Math.max(1, Number(bounds?.width) || 1);
    const height = Math.max(1, Number(bounds?.height) || 1);
    const ratio = Math.max(0.5, Math.min(1, Number(opticalRatio) || 0.78));
    const scale = (boxSize * ratio) / Math.max(width, height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    return {
      x: (boxSize - drawWidth) / 2,
      y: (boxSize - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight
    };
  }

  function trayProviderOpticalRatio(providerId) {
    // Claude Code's intentionally wide mark already uses the full horizontal
    // viewBox with balanced vertical breathing room. Cropping it into the
    // shared square optical box makes it noticeably smaller than its peers.
    return providerId === 'claude' ? 1 : 0.78;
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

  return {
    createTrayProviderIconDeliveryGuard,
    isFlatInkPixels,
    trayProviderIconSources,
    trayProviderBadgeLayout,
    trayProviderOpticalLayout,
    trayProviderOpticalRatio
  };
});
