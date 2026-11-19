'use strict';

const crypto = require('node:crypto');
const { destinationBinding, sameDestination } = require('./syncContentRuntime');
const opaque = value => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const legacy = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Identity bindings and cleanup journals live in the canonical main-process
// CredentialStore. Preferences contain only random IDs and non-secret labels.
function createSyncContentCredentialQueue(getStore) {
  let cachedIdentity = null;
  function read() {
    const store = getStore();
    const document = store.readDocument();
    const records = document.credentials.hub?.syncTitleCleanup || {};
    const rows = [];
    let changed = false;
    for (const [key, value] of Object.entries(records)) {
      if (!destinationBinding(value) || (!opaque(key) && !legacy(key))) continue;
      let identity = key;
      if (legacy(key)) {
        identity = crypto.randomUUID();
        records[identity] = { ...value, legacyIdentity: key };
        delete records[key];
        changed = true;
      }
      rows.push([identity, { ...destinationBinding(value), identity,
        ...(legacy(records[identity].legacyIdentity) ? { legacyIdentity: records[identity].legacyIdentity } : {}) }]);
    }
    if (changed) store.writeDocument(document);
    return rows;
  }
  function resolveIdentity(context) {
    const binding = destinationBinding(context);
    if (!binding) return '';
    if (cachedIdentity && sameDestination(cachedIdentity, binding)) return cachedIdentity.identity;
    const store = getStore();
    const document = store.readDocument();
    document.credentials.hub ||= {};
    const active = document.credentials.hub.syncContentIdentity;
    if (opaque(active?.identity) && sameDestination(active, binding)) {
      cachedIdentity = active;
      return active.identity;
    }
    const identity = crypto.randomUUID();
    document.credentials.hub.syncContentIdentity = { ...binding, identity };
    store.writeDocument(document);
    cachedIdentity = document.credentials.hub.syncContentIdentity;
    return identity;
  }
  // Presentation edits must return to the same destination after A → B → A.
  // Optional-sync consent keeps its separate, rotating active identity above.
  function resolvePresentationIdentity(context) {
    const binding = destinationBinding(context);
    if (!binding) return '';
    const store = getStore();
    const document = store.readDocument();
    document.credentials.hub ||= {};
    const hub = document.credentials.hub;
    const identities = hub.accountPresentationIdentities ||= {};
    for (const [identity, destination] of Object.entries(identities)) {
      if (opaque(identity) && sameDestination(destination, binding)) return identity;
    }
    // Preserve journals/cache written with the former shared active identity.
    const active = hub.syncContentIdentity;
    const identity = opaque(active?.identity) && sameDestination(active, binding)
      ? active.identity : crypto.randomUUID();
    identities[identity] = binding;
    store.writeDocument(document);
    return identity;
  }
  function save(context) {
    const binding = destinationBinding(context);
    if (!binding || !opaque(context.identity)) throw new Error('Invalid cleanup context');
    const store = getStore();
    const document = store.readDocument();
    document.credentials.hub ||= {};
    document.credentials.hub.syncTitleCleanup ||= {};
    document.credentials.hub.syncTitleCleanup[context.identity] = binding;
    store.writeDocument(document);
  }
  function remove(identity) {
    const store = getStore();
    const document = store.readDocument();
    if (Object.hasOwn(document.credentials.hub?.syncTitleCleanup || {}, identity)) {
      delete document.credentials.hub.syncTitleCleanup[identity];
      store.writeDocument(document);
    }
  }
  return { read, save, remove, resolveIdentity, resolvePresentationIdentity };
}

module.exports = { createSyncContentCredentialQueue };
