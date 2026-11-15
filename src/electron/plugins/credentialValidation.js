'use strict';
// Explicit user-requested verification, independent of quota demand/last-good data.
function createCredentialValidation({ status, revision, validate, changed }) {
  const entries = new Map();
  const key = (id, moduleId) => `${id}/${moduleId}`;
  function snapshot(id, moduleId, schema) {
    const saved = status(id, moduleId, schema), entry = entries.get(key(id, moduleId));
    const current = entry && entry.revision === saved.revision && entry.code === revision(id);
    return { ...saved, verification: current ? entry.state : 'unverified' };
  }
  function invalidate(id, moduleId) {
    for (const [ref, entry] of entries) if (entry.id === id && (moduleId === undefined || entry.moduleId === moduleId)) entries.delete(ref);
  }
  async function verify(id, moduleId, schema, request) {
    const saved = snapshot(id, moduleId, schema);
    if (request?.expectedRevision !== saved.revision) throw Error('credentials-conflict');
    if (!schema.validation || !saved.configured) throw Error('credentials-validation-unavailable');
    const ref = key(id, moduleId), prior = entries.get(ref);
    if (prior?.state === 'verifying') throw Error('credentials-validation-pending');
    const entry = { id, moduleId, revision: saved.revision, code: revision(id), state: 'verifying' };
    entries.set(ref, entry); changed();
    let state = 'unavailable';
    try {
      const result = await validate(id, { moduleId, revision: saved.revision });
      if (['valid', 'rejected', 'expired', 'unavailable'].includes(result?.status)) state = result.status;
    } catch { /* No author/transport error text reaches the credential status. */ }
    if (entries.get(ref) === entry && entry.code && entry.code === revision(id)
      && status(id, moduleId, schema).revision === entry.revision) { entry.state = state; changed(); }
    return snapshot(id, moduleId, schema);
  }
  return { snapshot, verify, invalidate,
    reject(id, moduleId, schema, expectedRevision) {
      const code = revision(id);
      if (!code || status(id, moduleId, schema).revision !== expectedRevision) return;
      entries.set(key(id, moduleId), { id, moduleId, revision: expectedRevision, code, state: 'rejected' }); changed();
    },
    reconcile() { for (const [ref, entry] of entries) if (!entry.code || entry.code !== revision(entry.id)) entries.delete(ref); },
    dispose() { entries.clear(); }
  };
}
module.exports = { createCredentialValidation };
