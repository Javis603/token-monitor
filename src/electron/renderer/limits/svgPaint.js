'use strict';

// Quota-history SVG paint goes through the CSSOM: the renderer CSP
// (style-src 'self') rejects inline style="" attributes, which silently
// discarded every series colour while legend swatches kept theirs.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitSvgPaint = api;
})(typeof window !== 'undefined' ? window : null, function createSvgPaintApi() {
  function paint(node, styles) {
    for (const [property, value] of Object.entries(styles || {})) {
      if (value !== null && value !== undefined && value !== '') node.style.setProperty(property, String(value));
    }
    return node;
  }

  return { paint };
});
