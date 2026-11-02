'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { prepareSettings, applySettingsPatch, settingsError } = require('../../shared/plugins/settings');
const MAX_BYTES = 256 * 1024;
const MAX_PUBLIC_BYTES = 56 * 1024;
function publicSettings(value) {
  const { pluginId, schemaVersion, storedSchemaVersion, revision, values, errors, status, readOnly } = value;
  const dto = { pluginId, schemaVersion, storedSchemaVersion, revision, values, errors, status, readOnly };
  if (Buffer.byteLength(JSON.stringify(dto)) > MAX_PUBLIC_BYTES) throw settingsError('settings-payload-too-large');
  return JSON.parse(JSON.stringify(dto));
}
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

// Main-process singleton; callers resolve IDs and schemas from the installed
// registry. No runtime, worker, permissions or generic storage dependency.
function createPluginSettingsStore({ directory, fs = nodeFs }) {
  function fileFor(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw settingsError('invalid-plugin-id');
    return path.join(directory, `${id}.json`);
  }
  function read(id) {
    const file = fileFor(id);
    try {
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw settingsError('invalid-settings-directory');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw settingsError('invalid-settings-store');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || record.formatVersion !== 1 || !Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1
        || !Number.isSafeInteger(record.revision) || record.revision < 1 || !record.values
        || typeof record.values !== 'object' || Array.isArray(record.values)) throw settingsError('invalid-settings-store');
    return record;
  }
  function snapshot(id, schema, stored) {
    if (!schema) throw settingsError('settings-not-declared');
    const prepared = prepareSettings(schema, stored);
    const newer = Boolean(stored && stored.schemaVersion > schema.version);
    return {
      pluginId: id, schema: JSON.parse(JSON.stringify(schema)), schemaVersion: schema.version,
      storedSchemaVersion: stored?.schemaVersion ?? schema.version, revision: stored?.revision ?? 0,
      values: prepared.values, errors: prepared.errors, readOnly: newer,
      status: newer ? 'newer-schema' : Object.keys(prepared.errors).length ? 'invalid' : 'ready'
    };
  }
  function get(id, schema) { return snapshot(id, schema, read(id)); }
  function update(id, schema, request) {
    const stored = read(id);
    if (!schema) throw settingsError('settings-not-declared');
    if (!request || request.schemaVersion !== schema.version || !Number.isSafeInteger(request.expectedRevision)
        || request.expectedRevision !== (stored?.revision ?? 0)) throw settingsError('settings-conflict');
    if (stored && stored.schemaVersion > schema.version) throw settingsError('settings-newer-schema');
    const revision = (stored?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw settingsError('settings-revision-exhausted');
    const candidate = { formatVersion: 1, schemaVersion: schema.version, revision, values: applySettingsPatch(schema, stored, request.patch) };
    const bytes = JSON.stringify(candidate);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw settingsError('settings-quota');
    const result = snapshot(id, schema, candidate);
    publicSettings(result); // Validate transport before the atomic commit, for every writer.
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw settingsError('invalid-settings-directory');
    const file = fileFor(id), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* Original error wins. */ }
      throw error;
    }
    // The atomic rename is the commit point. No live candidate is published
    // before it, and reads have no cache that could survive a failed save.
    return result;
  }
  function remove(id) {
    // Explicit uninstall data removal only. Retaining a package's data must
    // retain this directory entry as well as generic storage.
    const file = fileFor(id);
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function save(id, schema, { revision, values, schemaVersion = schema?.version } = {}) {
    return update(id, schema, { schemaVersion, expectedRevision: revision, patch: values });
  }
  function reset(id, schema, { revision, schemaVersion = schema?.version } = {}) {
    if (!schema) throw settingsError('settings-not-declared');
    return update(id, schema, { schemaVersion, expectedRevision: revision,
      patch: Object.fromEntries(schema.fields.map(field => [field.id, field.default])) });
  }
  return { get, update, save, reset, remove };
}

module.exports = { createPluginSettingsStore, MAX_BYTES, MAX_PUBLIC_BYTES, publicSettings };
