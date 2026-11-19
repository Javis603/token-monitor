'use strict';

(function exposeDeviceKind(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorDeviceKind = api;
})(typeof window !== 'undefined' ? window : null, function createDeviceKindApi() {
  const DEVICE_KINDS = Object.freeze(['computer', 'server', 'cloud', 'linux', 'desktop', 'laptop', 'mini', 'workstation']);
  function normalizeDeviceKind(value) {
    return DEVICE_KINDS.includes(value) ? value : 'computer';
  }
  return { DEVICE_KINDS, normalizeDeviceKind };
});
