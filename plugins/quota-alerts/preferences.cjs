'use strict';
const fs = require('node:fs');
const path = require('node:path');
const schema = require('./settings-schema.json');
const defaults = Object.fromEntries(schema.fields.map(field => [field.id, field.default]));
function validate(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length !== schema.fields.length
      || Object.keys(values).some(key => !Object.hasOwn(defaults, key))) throw Error('Invalid preference fields');
  for (const field of schema.fields) {
    const value = values[field.id];
    if (field.type === 'boolean' && typeof value !== 'boolean') throw Error('Invalid preference');
    if (field.type === 'number' && (!Number.isInteger(value) || value < field.min || value > field.max)) throw Error('Invalid threshold');
  }
}
function createPreferences(directory) {
  const file = path.join(directory, 'preferences.json');
  let record = { version: 1, revision: 0, values: { ...defaults } };
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 0) throw Error('Invalid preference record');
    validate(record.values);
  } catch (error) { if (error.code !== 'ENOENT') throw Error('Cannot load preferences', { cause: error }); }
  const get = () => ({ revision: record.revision, values: { ...record.values }, status: 'ready' });
  return { get, update({ expectedRevision, patch } = {}) {
    if (expectedRevision !== record.revision) throw Error('Preferences changed elsewhere');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some(key => !Object.hasOwn(defaults, key))) throw Error('Invalid preference patch');
    const values = { ...record.values, ...patch }; validate(values);
    const next = { version: 1, revision: record.revision + 1, values };
    if (!Number.isSafeInteger(next.revision)) throw Error('Preference revision exhausted');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    record = next; return get();
  } };
}
module.exports = { createPreferences, schema, defaults };
