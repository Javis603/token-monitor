'use strict';
const { cleanText } = require('../../shared/plugins/localized');

// Desktop display DTOs only. No HTML, URLs, raw response or wire extension.
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('Invalid plugin quota detail text');
  const cleaned = cleanText(value, max);
  if (!cleaned) throw Error('Invalid plugin quota detail text');
  return cleaned;
}
function detailValue(value) {
  if (typeof value === 'string') return text(value, 160);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isFinite(value.amount) || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) throw Error('Invalid plugin quota detail value');
  return { amount: value.amount, currency: value.currency };
}
function infoRows(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 12) throw Error('Invalid plugin quota infoRows');
  return value.map(row => ({ label: text(row?.label, 80), value: detailValue(row?.value) }));
}
function normalizeNotes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 8) throw Error('Invalid plugin quota notes');
  return value.map(note => ({ label: text(note?.label, 80),
    ...(note?.value === undefined ? {} : { value: detailValue(note.value) }),
    ...(note?.infoRows === undefined ? {} : { infoRows: infoRows(note.infoRows) }) }));
}
function windowDetails(input) {
  if (input.span !== undefined && input.span !== 1 && input.span !== 2) throw Error('Invalid plugin quota span');
  return { ...(input.span === undefined ? {} : { span: input.span }),
    ...(input.infoRows === undefined ? {} : { infoRows: infoRows(input.infoRows) }) };
}
module.exports = { windowDetails, normalizeNotes };
