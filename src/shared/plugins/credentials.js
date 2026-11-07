'use strict';
const { normalizeLocalized } = require('./localized');
const FIELD_ID = /^[a-z][a-zA-Z0-9-]{0,39}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function normalizeCredentials(raw) {
  if (raw === undefined) return null;
  if (!object(raw) || Object.keys(raw).some(key => key !== 'fields') || !Array.isArray(raw.fields)
    || !raw.fields.length || raw.fields.length > 16) throw Error('invalid credential declaration');
  const ids = new Set();
  const fields = raw.fields.map(field => {
    const label = normalizeLocalized(field?.label, 80);
    if (!object(field) || typeof field.id !== 'string' || !FIELD_ID.test(field.id) || ids.has(field.id) || !label
      || Object.keys(field).some(key => !['id', 'label', 'control', 'required'].includes(key))
      || field.required !== undefined && typeof field.required !== 'boolean'
      || field.control !== undefined && !['input', 'textarea'].includes(field.control)) throw Error('invalid credential field');
    ids.add(field.id);
    return Object.freeze({ id: field.id, label, control: field.control || 'input', required: field.required === true });
  });
  return Object.freeze({ fields: Object.freeze(fields) });
}
module.exports = { normalizeCredentials };
