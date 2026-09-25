'use strict';

// The row-icon rules the renderer ends up with: styles.css plus the vendor
// masks rowIconMasks.js installs from the vendor presentation table. Written
// with the same icon base styles.css uses, so a check that resolves a url()
// relative to the stylesheet reads both kinds of rule the same way.

const fs = require('node:fs');
const path = require('node:path');
const { rowIconMaskRules } = require('../../src/electron/renderer/rowIconMasks');

const STYLES_PATH = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'styles.css');
const ICON_BASE = '../../../assets/icons/';

function installedRowIconRules() {
  return rowIconMaskRules(ICON_BASE);
}

function rendererStyles() {
  return `${fs.readFileSync(STYLES_PATH, 'utf8')}\n${installedRowIconRules()}\n`;
}

module.exports = { STYLES_PATH, installedRowIconRules, rendererStyles };
