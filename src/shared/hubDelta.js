'use strict';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object';
const escape = key => key.replace(/~/g, '~0').replace(/\//g, '~1');

// RFC 6902 add/remove/replace only. Arrays of unchanged length are compared by
// index; structural array edits replace the array, avoiding index-shift scripts.
// Compare the JSON representation: undefined object members are not on the wire.
function statsPatch(previous, next) {
  const patch = [];
  function visit(before, after, path) {
    if (before === after) return;
    if (object(before) && object(after) && Array.isArray(before) === Array.isArray(after)) {
      if (Array.isArray(after)) {
        if (before.length !== after.length) { patch.push({ op: 'replace', path, value: after }); return; }
        for (let i = 0; i < after.length; i++) visit(before[i] ?? null, after[i] ?? null, `${path}/${i}`);
      } else {
        for (const key of Object.keys(before)) {
          if (before[key] !== undefined && (!own(after, key) || after[key] === undefined)) patch.push({ op: 'remove', path: `${path}/${escape(key)}` });
        }
        // Sessions/projects are keyed records. Compare their serialized rows
        // atomically instead of walking every unchanged metadata field in JS.
        const rows = path.endsWith('/sessions') || path.endsWith('/projects');
        for (const key of Object.keys(after)) {
          if (after[key] === undefined || (own(before, key) && before[key] === after[key])) continue;
          const child = `${path}/${escape(key)}`;
          if (!own(before, key) || before[key] === undefined) patch.push({ op: 'add', path: child, value: after[key] });
          else if (rows) {
            if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch.push({ op: 'replace', path: child, value: after[key] });
          } else visit(before[key], after[key], child);
        }
      }
    } else patch.push({ op: 'replace', path, value: after });
  }
  visit(previous, next, '');
  return patch;
}

// Copy each affected container once per event. Own-property traversal and data
// property writes let session keys such as "__proto__" stay data, not setters.
// Malformed patches fail atomically; the caller reconnects for a full snapshot.
function applyStatsPatch(stats, patch) {
  if (!Array.isArray(patch)) throw new Error('invalid_stats_patch');
  const copies = new WeakSet();
  function copy(value) {
    if (!object(value)) throw new Error('invalid_stats_patch_parent');
    if (copies.has(value)) return value;
    const result = Array.isArray(value) ? [...value] : { ...value };
    copies.add(result);
    return result;
  }
  const put = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  let result = stats;
  for (const entry of patch) {
    if (!entry || !['add', 'remove', 'replace'].includes(entry.op) || typeof entry.path !== 'string'
      || (entry.op !== 'remove' && !own(entry, 'value'))) throw new Error('invalid_stats_patch');
    if (entry.path === '') {
      if (entry.op === 'remove') throw new Error('invalid_stats_patch_root');
      // Never mutate a value owned by the event if a following operation edits it.
      result = entry.value;
      continue;
    }
    if (!entry.path.startsWith('/') || /~(?![01])/u.test(entry.path)) throw new Error('invalid_stats_pointer');
    const keys = entry.path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    result = copy(result);
    let parent = result;
    for (const key of keys.slice(0, -1)) {
      if (!own(parent, key)) throw new Error('missing_stats_patch_parent');
      const child = copy(parent[key]);
      put(parent, key, child);
      parent = child;
    }
    const key = keys.at(-1);
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : /^(0|[1-9]\d*)$/.test(key) ? Number(key) : NaN;
      if (!Number.isSafeInteger(index) || index > parent.length || (entry.op !== 'add' && index === parent.length)) throw new Error('invalid_stats_patch_index');
      if (entry.op === 'add') parent.splice(index, 0, entry.value);
      else if (entry.op === 'remove') parent.splice(index, 1);
      else parent[index] = entry.value;
    } else {
      if (entry.op !== 'add' && !own(parent, key)) throw new Error('missing_stats_patch_target');
      if (entry.op === 'remove') delete parent[key];
      else put(parent, key, entry.value);
    }
  }
  return result;
}

// A private connection baseline must not be replaced by REST reads or local
// overlays. A dropped/reordered delta reconnects instead of publishing mixed data.
function createStatsStreamReceiver(applyFreshness) {
  let stats = null;
  let revision = null;
  return {
    receive(event, data) {
      if (event === 'snapshot' || event === 'stats') {
        if (!object(data?.stats) || Array.isArray(data.stats)) throw new Error('invalid_stats_snapshot');
        stats = data.stats;
        revision = Number.isSafeInteger(data.revision) ? data.revision : null;
      } else if (event === 'delta') {
        if (!stats || revision === null || data?.baseRevision !== revision || data.revision !== revision + 1) throw new Error('stats_revision_mismatch');
        const next = applyStatsPatch(stats, data.patch);
        if (!object(next) || Array.isArray(next)) throw new Error('invalid_stats_snapshot');
        stats = next;
        revision = data.revision;
      } else if (event === 'freshness') {
        if (!stats || !object(data?.stats) || Array.isArray(data.stats)) throw new Error('invalid_stats_freshness');
        const versioned = Number.isSafeInteger(data?.revision);
        if (versioned && (revision === null || data.baseRevision !== revision || data.revision !== revision + 1)) throw new Error('stats_revision_mismatch');
        stats = applyFreshness(stats, data);
        revision = versioned ? data.revision : null;
      } else return null;
      return stats;
    }
  };
}

module.exports = { statsPatch, applyStatsPatch, createStatsStreamReceiver };
