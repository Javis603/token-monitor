'use strict';

const { normalizeLocalized } = require('./localized');
const KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RESERVED = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validKey = key => typeof key === 'string' && KEY.test(key) && !RESERVED.has(key);

function settingsError(code, fields = {}) {
  const error = new Error(code);
  error.code = code; error.fields = fields;
  return error;
}

function validateSetting(field, value) {
  switch (field.type) {
    case 'boolean': return typeof value === 'boolean' ? null : 'boolean';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'number';
      if (field.integer && !Number.isSafeInteger(value)) return 'integer';
      return (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max) ? 'range' : null;
    case 'string':
      if (typeof value !== 'string') return 'string';
      return value.length < field.minLength || value.length > field.maxLength ? 'length' : null;
    case 'select': return field.options.some(option => option.value === value) ? null : 'option';
    default: return 'type';
  }
}

// A data contract, not an executable editor or general-purpose UI schema.
function normalizeSettings(raw) {
  if (raw === undefined || raw === null) return null;
  const fail = () => { throw settingsError('invalid-settings-schema'); };
  if (!object(raw) || !Number.isSafeInteger(raw.version) || raw.version < 1
      || !Array.isArray(raw.fields) || raw.fields.length < 1 || raw.fields.length > 64) fail();
  const seen = new Set();
  const fields = raw.fields.map(entry => {
    if (!object(entry) || !validKey(entry.id) || seen.has(entry.id)) fail();
    seen.add(entry.id);
    const label = normalizeLocalized(entry.label, 120);
    if (!label || !['boolean', 'number', 'string', 'select'].includes(entry.type) || !own(entry, 'default')) fail();
    const field = { id: entry.id, type: entry.type, label, description: normalizeLocalized(entry.description, 400), default: entry.default };
    if (entry.type === 'number') {
      for (const key of ['min', 'max']) {
        if (entry[key] !== undefined) {
          if (typeof entry[key] !== 'number' || !Number.isFinite(entry[key])) fail();
          field[key] = entry[key];
        }
      }
      if (entry.integer !== undefined && typeof entry.integer !== 'boolean') fail();
      field.integer = entry.integer === true;
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) fail();
    }
    if (entry.type === 'string') {
      field.minLength = entry.minLength ?? 0; field.maxLength = entry.maxLength ?? 4096;
      if (![field.minLength, field.maxLength].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 4096)
          || field.minLength > field.maxLength) fail();
    }
    if (entry.type === 'select') {
      if (!Array.isArray(entry.options) || !entry.options.length || entry.options.length > 64) fail();
      const options = new Set();
      field.options = Object.freeze(entry.options.map(option => {
        if (!object(option) || typeof option.value !== 'string' || option.value.length > 256 || options.has(option.value)) fail();
        options.add(option.value);
        const optionLabel = normalizeLocalized(option.label, 120);
        if (!optionLabel) fail();
        return Object.freeze({ value: option.value, label: optionLabel });
      }));
    }
    if (validateSetting(field, field.default)) fail();
    return Object.freeze(field);
  });
  if (raw.migrations !== undefined && (!Array.isArray(raw.migrations) || raw.migrations.length > 64)) fail();
  const versions = new Set();
  const migrations = (raw.migrations || []).map(step => {
    if (!object(step) || !Number.isSafeInteger(step.fromVersion) || step.fromVersion < 1
        || step.fromVersion >= raw.version || versions.has(step.fromVersion) || !object(step.renames)
        || Object.keys(step.renames).length > 64) fail();
    versions.add(step.fromVersion);
    const targets = new Set();
    for (const [from, to] of Object.entries(step.renames)) {
      if (!validKey(from) || typeof to !== 'string' || !validKey(to) || from === to || targets.has(to)) fail();
      targets.add(to);
    }
    return Object.freeze({ fromVersion: step.fromVersion, renames: Object.freeze({ ...step.renames }) });
  }).sort((a, b) => a.fromVersion - b.fromVersion);
  return Object.freeze({ version: raw.version, fields: Object.freeze(fields), migrations: Object.freeze(migrations) });
}

// Never delete obsolete keys. They remain private compatibility data, including
// rename sources, and cannot be written through the public patch interface.
function prepareSettings(schema, stored) {
  const values = { ...(stored?.values || {}) };
  if (stored && stored.schemaVersion < schema.version) {
    for (const step of schema.migrations) {
      if (step.fromVersion < stored.schemaVersion) continue;
      const before = { ...values };
      for (const [from, to] of Object.entries(step.renames)) {
        if (own(before, from) && !own(before, to)) values[to] = before[from];
      }
    }
  }
  const exposed = {}, errors = {};
  for (const field of schema.fields) {
    if (!own(values, field.id)) values[field.id] = field.default;
    const error = validateSetting(field, values[field.id]);
    if (error) errors[field.id] = error;
    // Invalid old objects are retained on disk, never sent to the editor.
    exposed[field.id] = error ? null : values[field.id];
  }
  return { retained: values, values: exposed, errors };
}

function applySettingsPatch(schema, stored, patch) {
  if (!object(patch) || Object.keys(patch).length > 64) throw settingsError('invalid-settings-patch');
  const fields = new Map(schema.fields.map(field => [field.id, field]));
  const errors = Object.create(null);
  for (const [id, value] of Object.entries(patch)) {
    const error = fields.has(id) ? validateSetting(fields.get(id), value) : 'unknown';
    if (error) errors[id] = error;
  }
  if (Object.keys(errors).length) throw settingsError('invalid-settings-values', errors);
  const candidate = prepareSettings(schema, stored);
  for (const [id, value] of Object.entries(patch)) candidate.retained[id] = value;
  const checked = prepareSettings(schema, { schemaVersion: schema.version, values: candidate.retained });
  if (Object.keys(checked.errors).length) throw settingsError('invalid-settings-values', checked.errors);
  return checked.retained;
}

module.exports = { normalizeSettings, validateSetting, prepareSettings, applySettingsPatch, settingsError };
