'use strict';

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

function contentSecurityPolicyForRequest() {
  return CSP_HEADER;
}

module.exports = { CSP_HEADER, contentSecurityPolicyForRequest };
