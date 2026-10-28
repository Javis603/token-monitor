'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' tm-plugin:",
  "style-src 'self' tm-plugin:",
  "img-src 'self' tm-plugin: data: blob:",
  "font-src 'self' tm-plugin:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const previewDocument = pathToFileURL(path.join(__dirname, 'renderer', 'edgeDock', 'index.html'));
const previewUrls = new Set(['notch', 'rail', 'peek'].map(surface => {
  const url = new URL(previewDocument);
  url.search = new URLSearchParams({ surface, settingsPreview: '1' }).toString();
  return url.href;
}));

function contentSecurityPolicyForRequest(details) {
  // Only the read-only local display preview can be embedded. Main, dashboard,
  // native dock documents and all remote responses retain the embedding ban.
  return details.resourceType === 'subFrame' && previewUrls.has(details.url)
    ? CSP_HEADER.replace("frame-ancestors 'none'", "frame-ancestors 'self'")
    : CSP_HEADER;
}

module.exports = { CSP_HEADER, contentSecurityPolicyForRequest };
