'use strict';

// Enabling a plugin selects its replacements. A saved choice between that
// plugin's own views survives off/on; another plugin's selection is replaced.
function enableContentPatch(settings, id, views) {
  const choices = new Map();
  for (const view of views) {
    if (view.mode !== 'replace') continue;
    for (const target of view.targets) {
      if (!choices.has(target)) choices.set(target, []);
      choices.get(target).push(view.ref || `${id}/${view.id}`);
    }
  }
  if (!choices.size) return {};
  const next = { ...settings.pluginContentSelections };
  for (const [target, refs] of choices) {
    if (!refs.includes(next[target])) next[target] = refs[0];
  }
  if (Object.keys(next).length > 128) throw new Error('Too many content selections');
  return { pluginContentSelections: next };
}

function updateContentPatch(settings, id, views, previousViews) {
  const previousTargets = new Set(previousViews.filter(view => view.mode === 'replace').flatMap(view => view.targets));
  // Updates retain existing content choices. Select newly added targets and
  // repair a removed selected view only when this plugin already owns the slot.
  return enableContentPatch(settings, id, views.map(view => ({ ...view,
    targets: view.targets.filter(target => !previousTargets.has(target) || settings.pluginContentSelections?.[target]?.startsWith(`${id}/`))
  })));
}

module.exports = { enableContentPatch, updateContentPatch };
