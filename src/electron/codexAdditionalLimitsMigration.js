'use strict';

const usageItems = require('../shared/limits/usageItems');

// `showCodexAdditionalLimits: false` predates the visible-usage-items
// checklist, where each additional Codex pool is an item of its own. A pool's
// item id comes from its payload, so the switch can only be carried over once
// the pools are known: the first presentation that carries any writes their
// ids into the hidden half and turns the switch back on. Until then the card,
// Home and the dock picker keep honouring the switch.
function codexAdditionalLimitsMigrationPatch(settings, stats) {
  if (settings?.showCodexAdditionalLimits !== false) return null;
  const ids = (stats?.limits?.providers || [])
    .filter((provider) => provider?.provider === 'codex')
    .flatMap((provider) => provider.windows || [])
    .filter((window) => window?.additional === true)
    .map((window) => usageItems.limitUsageItemId(window, 'codex'))
    .filter(Boolean);
  if (ids.length === 0) return null;
  let hiddenItems = settings.limitProviderHiddenItems;
  for (const id of ids) hiddenItems = usageItems.setUsageItemHidden(hiddenItems, 'codex', id, true);
  return { limitProviderHiddenItems: hiddenItems, showCodexAdditionalLimits: true };
}

function applyCodexAdditionalLimitsMigration(stats, deps = {}) {
  const patch = codexAdditionalLimitsMigrationPatch(deps.settings, stats);
  if (!patch) return false;
  const previous = {
    limitProviderHiddenItems: deps.settings.limitProviderHiddenItems,
    showCodexAdditionalLimits: deps.settings.showCodexAdditionalLimits
  };
  Object.assign(deps.settings, patch);
  try {
    if (deps.saveSettings?.() !== true) {
      Object.assign(deps.settings, previous);
      return false;
    }
  } catch (error) {
    Object.assign(deps.settings, previous);
    throw error;
  }
  deps.onPersisted?.();
  return true;
}

module.exports = {
  applyCodexAdditionalLimitsMigration,
  codexAdditionalLimitsMigrationPatch
};
