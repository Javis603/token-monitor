'use strict';
/* eslint preserve-caught-error: off -- Storage errors must not include secret values. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readRegularFileNoFollow, writePrivateJsonAtomic } = require('../../shared/credentialStore');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_BYTES = 65536;
function createPluginCredentials({ directory, changed = () => {} }) {
  function file(id, moduleId) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)
      || typeof moduleId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(moduleId)) throw Error('credentials-invalid-namespace');
    return path.join(directory, `${id}--${createHash('sha256').update(moduleId).digest('hex')}.json`);
  }
  function checkDirectory() {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('credentials-storage-unavailable');
    } catch (error) { if (error.code !== 'ENOENT') throw Error('credentials-storage-unavailable'); }
  }
  function read(id, moduleId) {
    checkDirectory();
    try {
      const record = JSON.parse(readRegularFileNoFollow(file(id, moduleId), { maxBytes: MAX_BYTES, mode: 0o600 }));
      if (!object(record) || record.formatVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1
        || !object(record.values) || Object.entries(record.values).some(([key, value]) => !/^[a-z][a-zA-Z0-9-]{0,39}$/.test(key) || typeof value !== 'string' || value.length > 16384)) throw Error('invalid');
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
    checkDirectory();
    try { writePrivateJsonAtomic(file(id, moduleId), candidate); }
    catch { throw Error('credentials-storage-unavailable'); }
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
      file(id, 'check'); checkDirectory();
      let files;
      try { files = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') files = []; else throw Error('credentials-storage-unavailable'); }
      try {
        for (const name of files) if (new RegExp(`^${id}--[a-f0-9]{64}\\.json$`).test(name)) {
          const target = path.join(directory, name);
          const record = JSON.parse(readRegularFileNoFollow(target, { maxBytes: MAX_BYTES, mode: 0o600 }));
          if (record.formatVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1
            || !Number.isSafeInteger(record.revision + 1)) throw Error('invalid-record');
          writePrivateJsonAtomic(target, { formatVersion: 1, revision: record.revision + 1, values: {} });
        }
      }
      catch { throw Error('credentials-storage-unavailable'); }
      changed(id, undefined, 'clear');
    }
  };
}
module.exports = { createPluginCredentials };
