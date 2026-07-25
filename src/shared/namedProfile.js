'use strict';

function normalizeNamedProfileName(value, options = {}) {
  const raw = String(value || '').trim().normalize('NFC');
  if (!raw || raw.includes('@') || /^https?:\/\//i.test(raw)) return '';
  const clean = raw.replace(/\s+/gu, ' ').trim();
  const reserved = new Set(
    (options.reservedNames || [])
      .map((name) => String(name || '').trim().toLocaleLowerCase('en-US'))
      .filter(Boolean)
  );
  if (
    !clean
    || [...clean].length > 64
    || !/^[\p{L}\p{M}\p{N} ._-]+$/u.test(clean)
    || reserved.has(clean.toLocaleLowerCase('en-US'))
  ) return '';
  return clean;
}

module.exports = {
  normalizeNamedProfileName
};
