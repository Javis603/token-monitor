'use strict';

// Strong references are intentional, but only the most recently read values
// survive. Callers retain immutable inputs separately so eviction is harmless.
function createBoundedCache(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('cache limit must be a positive integer');
  const entries = new Map();
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    clear() { entries.clear(); }
  };
}

module.exports = { createBoundedCache };
