'use strict';

const { ID_RE } = require('../../shared/plugins/manifest');
const TARGET_RE = /^[a-zA-Z][a-zA-Z0-9.-]{0,119}$/;

function normalizeContentDefaults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, targets]) => ID_RE.test(id) && Array.isArray(targets))
    .map(([id, targets]) => [id, [...new Set(targets.filter(target => typeof target === 'string' && TARGET_RE.test(target)))].slice(0, 128)]));
}

function contentChoices(id, views) {
  const choices = new Map();
  for (const view of views) {
    if (view.mode !== 'replace') continue;
    for (const target of view.targets) {
      if (!choices.has(target)) choices.set(target, []);
      choices.get(target).push(view.ref || `${id}/${view.id}`);
    }
  }
  return choices;
}

function markContentTargets(settings, id, targets) {
  const defaults = settings.pluginContentDefaults || {};
  const applied = new Set(Object.hasOwn(defaults, id) ? defaults[id] : []);
  for (const target of targets) applied.add(target);
  if (applied.size > 128) throw new Error('Too many content defaults');
  return { ...defaults, [id]: [...applied] };
}

function initializeContentPatch(settings, id, views, updating) {
  const choices = contentChoices(id, views);
  if (!choices.size) return {};
  const defaults = settings.pluginContentDefaults || {};
  const applied = new Set(Object.hasOwn(defaults, id) ? defaults[id] : []);
  const configured = new Set(Object.values(defaults).flat());
  const next = { ...settings.pluginContentSelections };
  for (const [target, refs] of choices) {
    const selected = next[target];
    // A removed view may be replaced only while its plugin still owns the slot.
    if (selected?.startsWith(`${id}/`) && !refs.includes(selected)) next[target] = refs[0];
    if (applied.has(target)) continue;
    // No ref plus a processed target is an intentional native-content choice.
    // Updates also leave another plugin's existing selection alone.
    if ((!selected && configured.has(target)) || (updating && selected)) continue;
    next[target] = refs.includes(selected) ? selected : refs[0];
  }
  if (Object.keys(next).length > 128) throw new Error('Too many content selections');
  return { pluginContentSelections: next, pluginContentDefaults: markContentTargets(settings, id, choices.keys()) };
}

function enableContentPatch(settings, id, views) {
  return initializeContentPatch(settings, id, views, false);
}

function updateContentPatch(settings, id, views) {
  return initializeContentPatch(settings, id, views, true);
}

module.exports = { normalizeContentDefaults, markContentTargets, enableContentPatch, updateContentPatch };
