'use strict';

const { destinationIdentity } = require('./syncContentRuntime');

// Cleanup survives a connection change/restart. Old Hub credentials stay in the
// existing main-process credential store, never preferences or a renderer DTO.
function createSyncContentCredentialQueue(getStore) {
  function read() {
    const records = getStore().readDocument().credentials?.hub?.syncTitleCleanup || {};
    return Object.entries(records).flatMap(([identity, value]) => {
      try {
        if (destinationIdentity(value) !== identity) return [];
        return [[identity, { url: value.url, secret: value.secret, deviceId: value.deviceId, mode: value.mode, identity }]];
      } catch (_) { return []; }
    });
  }
  function save(context) {
    const store = getStore();
    const document = store.readDocument();
    document.credentials.hub ||= {};
    document.credentials.hub.syncTitleCleanup ||= {};
    document.credentials.hub.syncTitleCleanup[context.identity] = {
      url: context.url, secret: context.secret || '', deviceId: context.deviceId, mode: context.mode
    };
    store.writeDocument(document);
  }
  function remove(identity) {
    const store = getStore();
    const document = store.readDocument();
    if (document.credentials.hub?.syncTitleCleanup?.[identity]) {
      delete document.credentials.hub.syncTitleCleanup[identity];
      store.writeDocument(document);
    }
  }
  return { read, save, remove };
}

module.exports = { createSyncContentCredentialQueue };
