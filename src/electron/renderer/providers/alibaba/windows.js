// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).alibaba = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { windowForKind, limitWindowNode, providerWindowLabel, t } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    // Alibaba Team / StepFun Token Plan return one credit window; their
    // rolling plans return 5-hour and weekly windows. The payload shape
    // decides the layout, including on a device receiving a synced row.
    const billing = windowForKind(provider, 'billing');
    const session = windowForKind(provider, 'session');
    const weekly = windowForKind(provider, 'weekly');
    if (billing) {
      const node = limitWindowNode(providerWindowLabel(provider, billing), billing, color, 0.68);
      node.classList.add('limit-window-wide');
      windows.append(node);
    }
    if (session) {
      const node = limitWindowNode(providerWindowLabel(provider, session), session, color, 0.95);
      if (!weekly) node.classList.add('limit-window-wide');
      windows.append(node);
    }
    if (weekly) windows.append(limitWindowNode(providerWindowLabel(provider, weekly), weekly, color, 0.68));
  }

  /** @type {Record<string, string>} */
  const variantLabelKeys = {
    cn: 'planCn', intl: 'planIntl',
    'cn-personal': 'planCnPersonal', 'intl-personal': 'planIntlPersonal'
  };

  const rowPolicy = /** @param {any} provider @param {any} _color @param {any} context */ (provider, _color, { grouped }) => {
    const key = variantLabelKeys[provider?.region];
    return { options: grouped && key ? { planText: t(`settings.alibaba.${key}`) } : {} };
  };

  return { renderWindows, rowPolicy };
});
