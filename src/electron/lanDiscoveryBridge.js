'use strict';

// The mDNS browser lives in the Node hub tree, which is also shipped inside the
// packaged app. Load it lazily and fail soft: an older packaged build without
// the module must still start the widget and keep manual URL + secret sync.
function loadLanDiscovery() {
  try {
    return require('../hub/lanDiscovery');
  } catch (_) {
    return null;
  }
}

let cachedApi = null;

function lanDiscoveryApi() {
  if (cachedApi === null) cachedApi = loadLanDiscovery() || false;
  return cachedApi || null;
}

function createLanBrowser(options) {
  const api = lanDiscoveryApi();
  if (!api || typeof api.createLanBrowser !== 'function') return null;
  return api.createLanBrowser(options);
}

module.exports = { createLanBrowser, lanDiscoveryApi, loadLanDiscovery };
