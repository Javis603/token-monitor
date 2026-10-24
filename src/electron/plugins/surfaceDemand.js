'use strict';
const { isRef } = require('../../shared/plugins/placements');
function createSurfaceDemand(publish) {
  const owners = new Map();
  function refs(surface) {
    return [...new Set([...owners.values()].flatMap(demands => demands.get(surface) || []))];
  }
  return {
    set(owner, surface, values) {
      if (!owners.has(owner)) owners.set(owner, new Map());
      const selected = Array.isArray(values) ? [...new Set(values.filter(isRef))].slice(0, 32) : [];
      owners.get(owner).set(surface, selected);
      publish(surface, refs(surface));
    },
    remove(owner) {
      const removed = owners.get(owner); owners.delete(owner);
      for (const surface of removed?.keys() || []) publish(surface, refs(surface));
    }
  };
}
module.exports = { createSurfaceDemand };
