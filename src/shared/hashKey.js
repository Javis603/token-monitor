'use strict';

const crypto = require('node:crypto');

function hashKey(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(String(part || '')).update('\0');
  return `sha256:${hash.digest('hex')}`;
}

module.exports = { hashKey };
