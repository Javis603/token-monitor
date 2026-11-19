'use strict';

const DEFAULT_RESERVED_NAMES = ['__proto__', 'prototype', 'constructor'];
const MAX_NAMED_PROFILE_INPUT_LENGTH = 256;

function normalizeNamedProfileName(value, options = {}) {
  const raw = String(value || '').trim();
  if (
    !raw
    || raw.length > MAX_NAMED_PROFILE_INPUT_LENGTH
    || raw.includes('@')
    || /^https?:\/\//i.test(raw)
  ) return '';
  const clean = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const reserved = new Set(
    [...DEFAULT_RESERVED_NAMES, ...(options.reservedNames || [])]
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
