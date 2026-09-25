'use strict';

// Installs the `.row-icon-<id>` mask rules from the vendor presentation table,
// so a mark added there needs no stylesheet edit. styles.css keeps the sizing
// (`.row-icon`, `.limit-icon`) and the few masks that are not vendor marks.
//
// The rules go into their own adopted stylesheet. Adopted sheets cascade after
// the document's, which is harmless here: the one styles.css rule that
// overrides a vendor mask (`.limit-icon.row-icon-grok`) is more specific than a
// single class. Load after vendorPresentation.js and before any script that
// paints a mark.
(function exposeRowIconMasks(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('../../shared/vendorPresentation') : root?.TokenMonitorVendorPresentation);
  if (node) module.exports = api;
  if (root) {
    root.TokenMonitorRowIconMasks = api;
    // Resolved against this script rather than the page, because the edge dock
    // loads it from a subdirectory. It sits beside styles.css, so the relative
    // path is the one the stylesheet used.
    const script = root.document?.currentScript;
    if (script && root.CSSStyleSheet) {
      api.installRowIconMasks(root.document, new URL('../../../assets/icons/', script.src).href);
    }
  }
})(typeof window !== 'undefined' ? window : null, function createRowIconMasksApi(vendorPresentation) {
  function rowIconMaskRules(iconBaseUrl) {
    // Unquoted like the rules in styles.css; ids and file stems are
    // [a-z0-9-] (vendorPresentation.test.js), so nothing needs escaping.
    return Object.entries(vendorPresentation.ROW_ICON_MASKS).map(([id, file]) => {
      const url = `${iconBaseUrl}${file}.svg`;
      return `.row-icon-${id} { -webkit-mask-image: url(${url}); mask-image: url(${url}); }`;
    }).join('\n');
  }

  function installRowIconMasks(document, iconBaseUrl) {
    const sheet = new document.defaultView.CSSStyleSheet();
    sheet.replaceSync(rowIconMaskRules(iconBaseUrl));
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return sheet;
  }

  return { installRowIconMasks, rowIconMaskRules };
});
