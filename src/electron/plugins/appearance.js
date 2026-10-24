'use strict';
const fs = require('node:fs');
const { normalizeAppearance } = require('../../shared/plugins/appearance');
function createPluginAppearance({ file, fsImpl = fs }) {
  let value = normalizeAppearance(), error = '';
  try {
    if (fsImpl.statSync(file).size > 8192) throw new Error('saved plugin style is too large');
    value = normalizeAppearance(JSON.parse(fsImpl.readFileSync(file, 'utf8')));
  } catch (reason) { if (reason.code !== 'ENOENT') error = reason.message; }
  return {
    get: () => structuredClone(value),
    state: () => ({ value: structuredClone(value), error }),
  };
}
module.exports = { createPluginAppearance };
