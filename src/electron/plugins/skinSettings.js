'use strict';
const { normalizeAppearance } = require('../../shared/plugins/appearance');

function prepareSkinSettings(current, skin) {
  return {
    authorSkin: { ref: skin.ref, appearance: normalizeAppearance(skin.appearance || {}) },
    patch: {
      themeColors: { ...current.themeColors, ...skin.colors },
      vendorColors: { ...current.vendorColors, ...skin.vendorColors }
    }
  };
}
module.exports = { prepareSkinSettings };
