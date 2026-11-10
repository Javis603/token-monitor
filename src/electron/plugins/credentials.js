'use strict';
/* eslint preserve-caught-error: off -- Storage errors must not include secret values. */
const fs = require('node:fs');
const path = require('node:path');
const { isPortableCredentialId } = require('../../shared/plugins/credentials');
const { readRegularFileNoFollow, writePrivateJsonAtomic } = require('../../shared/credentialStore');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_BYTES = 65536;
function createPluginCredentials({ directory, changed = () => {} }) {
  // A live editor may hold an older revision even if its file later corrupts.
  // Remember observed revisions so repair never resets that editor's fence.
  const revisions = new Map();
  function file(id, moduleId) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)
      || typeof moduleId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(moduleId)
      || !isPortableCredentialId(id) || !isPortableCredentialId(moduleId)) throw Error('credentials-invalid-namespace');
    return path.join(directory, id, `${moduleId}.json`);
  }
  function checkDirectory(target) {
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('invalid directory');
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw Error('credentials-storage-unavailable');
    }
  }
  function pluginDirectory(id) {
    const target = path.dirname(file(id, 'check'));
    checkDirectory(directory); checkDirectory(target);
    return target;
  }
  function read(id, moduleId) {
    pluginDirectory(id);
    try {
      const record = JSON.parse(readRegularFileNoFollow(file(id, moduleId), { maxBytes: MAX_BYTES, mode: 0o600 }));
      if (!object(record) || record.formatVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1
        || !object(record.values) || Object.entries(record.values).some(([key, value]) => !/^[a-z][a-zA-Z0-9-]{0,39}$/.test(key) || typeof value !== 'string' || value.length > 16384)) throw Error('invalid');
      revisions.set(file(id, moduleId), record.revision);
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return { revision: 0, values: {} };
      throw Error('credentials-storage-unavailable');
    }
  }
  function statusOf(schema, record) {
    const fields = Object.fromEntries(schema.fields.map(field => [field.id, Object.hasOwn(record.values, field.id) && Boolean(record.values[field.id])]));
    return { declaration: schema, revision: record.revision, fields, configured: schema.fields.every(field => !field.required || fields[field.id]) && Object.values(fields).some(Boolean) };
  }
  function status(id, moduleId, schema) { return statusOf(schema, read(id, moduleId)); }
  function commit(id, moduleId, schema, request, clear) {
    const record = read(id, moduleId);
    if (!request || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== record.revision) throw Error('credentials-conflict');
    const values = clear ? Object.create(null) : Object.assign(Object.create(null), Object.fromEntries(schema.fields.filter(field => Object.hasOwn(record.values, field.id)).map(field => [field.id, record.values[field.id]])));
    if (!clear) {
      if (!object(request.patch) || Object.keys(request.patch).some(key => !schema.fields.some(field => field.id === key))) throw Error('credentials-invalid-patch');
      for (const [key, value] of Object.entries(request.patch)) {
        const field = schema.fields.find(field => field.id === key);
        if (typeof value !== 'string' || value.length > 16384 || field.required && !value.trim()) throw Error('credentials-invalid-value');
        if (value === '') delete values[key]; else values[key] = value;
      }
    }
    const candidate = { formatVersion: 1, revision: record.revision + 1, values };
    if (!Number.isSafeInteger(candidate.revision) || Buffer.byteLength(JSON.stringify(candidate)) > MAX_BYTES - 2048) throw Error('credentials-quota');
    const target = pluginDirectory(id);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); fs.chmodSync(target, 0o700); }
      writePrivateJsonAtomic(file(id, moduleId), candidate);
    }
    catch { throw Error('credentials-storage-unavailable'); }
    revisions.set(file(id, moduleId), candidate.revision);
    changed(id, moduleId, clear ? 'clear' : 'update');
    return statusOf(schema, candidate);
  }
  return { status,
    update: (id, moduleId, schema, request) => commit(id, moduleId, schema, request, false),
    clear: (id, moduleId, schema, request) => commit(id, moduleId, schema, request, true),
    read(id, moduleId, schema, request) {
      const record = read(id, moduleId);
      if (request?.expectedRevision !== undefined && request.expectedRevision !== record.revision) throw Error('credentials-conflict');
      return Object.fromEntries(schema.fields.filter(field => Object.hasOwn(record.values, field.id)).map(field => [field.id, record.values[field.id]]));
    },
    forget(id) {
      const folder = pluginDirectory(id);
      let files = [], failed = false;
      try { files = fs.readdirSync(folder); } catch (error) { if (error.code !== 'ENOENT') failed = true; }
      for (const name of files) if (/^[a-z][a-z0-9-]{0,31}\.json$/.test(name) && isPortableCredentialId(name.slice(0, -5))) {
        const target = path.join(folder, name);
        let revision = revisions.get(target) || 0;
        try {
          const record = JSON.parse(readRegularFileNoFollow(target, { maxBytes: MAX_BYTES, mode: 0o600 }));
          if (Number.isSafeInteger(record?.revision) && record.revision > revision) revision = record.revision;
        } catch {
          // Corrupt records are still explicitly clearable. Replace their bytes
          // with a secret-free tombstone; unlink symlinks without following them.
        }
        try {
          if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
          if (!Number.isSafeInteger(revision + 1)) throw Error('invalid-revision');
          writePrivateJsonAtomic(target, { formatVersion: 1, revision: revision + 1, values: {} });
          revisions.set(target, revision + 1);
        } catch { failed = true; }
      }
      changed(id, undefined, 'clear');
      if (failed) throw Error('credentials-storage-unavailable');
    }
  };
}
module.exports = { createPluginCredentials };
