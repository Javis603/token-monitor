// @ts-check
'use strict';

/** @param {any} root @param {any} factory */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (root) (root.TokenMonitorProviderWindows ||= {}).mimo = factory;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis), /** @param {Record<string, any>} deps */ function createWindows(deps) {
  const { isCreditsWindow, limitWindowNode, providerWindowLabel, t, tagUsageItem, usageItems, creditsAmount, creditsCurrency, optionalFiniteNumber, formatMoney, creditsMeterPercent, document, limitDetailInfoNode, providerSpendNode, mimoProductLabel, mimoAccountGroups, limitAccountDefaultTitle, accountIdentity, limitAccountEmailsMasked, limitAccountRowPolicy, limitAccountTitle, renderLimitProviderRow, settings, subscriptionForProvider, limitProviderUsageItems, subscriptionsForProviderGroup, renderLimitProviderGroupFrame, renderLimitProviderHead } = deps;

  /** @param {any} provider @param {any} color @param {any} windows @returns {any} */ function renderWindows(provider, color, windows) {
    windows.classList.add('limit-windows-mimo');
    // Token Plan and membership quotas reuse the shared labels and wide rows.
    const quotaWindows = (provider.windows || []).filter(/** @param {any} window @returns {any} */ (window) => !isCreditsWindow(window));
    for (const quotaWindow of quotaWindows) {
      const node = limitWindowNode(providerWindowLabel(provider, quotaWindow), quotaWindow, color, 0.68);
      node.classList.add('limit-window-wide');
      if (!quotaWindow.resetsAt && !quotaWindow.resetDescription) node.classList.add('limit-window-no-reset');
      windows.append(node);
    }
    const balance = provider.balance || null;
    // Older Console records may carry Token Plan data only in balance.
    // Credits windows are money, so they must not suppress this fallback.
    if (!quotaWindows.some(/** @param {any} window @returns {any} */ (window) => String(window?.label || '').trim())) {
      const tokenPlan = mimoTokenPlanWindowFromBalance(balance);
      if (tokenPlan) {
        const node = limitWindowNode(tokenPlan.label || 'Token Plan', tokenPlan, color, 0.68);
        node.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(node);
      } else if (balance?.planStatus === 'expired') {
        const node = limitWindowNode('Token Plan', { showMeter: false }, color, 0.68, t('limits.mimo.planExpired'));
        tagUsageItem(node, usageItems.limitUsageItemId({ kind: 'billing', label: 'Token Plan' }), 'Token Plan');
        node.classList.add('limit-window-wide', 'limit-window-no-reset');
        windows.append(node);
      }
    }
    const creditsWindow = (provider.windows || []).find(isCreditsWindow) || null;
    const amount = creditsAmount(provider, creditsWindow);
    const currency = creditsCurrency(provider, creditsWindow);
    const giftBalance = optionalFiniteNumber(balance?.giftBalance);
    const cashBalance = optionalFiniteNumber(balance?.cashBalance);
    if (amount !== null || giftBalance !== null || cashBalance !== null) {
      const details = [];
      if (giftBalance !== null) details.push(['Gift', formatMoney(giftBalance, currency)]);
      if (cashBalance !== null) details.push(['Cash', formatMoney(cashBalance, currency)]);
      const balanceText = formatMoney(amount, currency) || '—';
      // Reuse the shared display-only balance meter; do not put it on the wire.
      const meterPercent = creditsMeterPercent(provider, creditsWindow);
      const balanceNode = limitWindowNode(
        'Balance',
        meterPercent === null ? { showMeter: false } : { remainingPercent: meterPercent },
        color,
        0.68,
        balanceText
      );
      if (details.length) {
        const value = balanceNode.querySelector('.limit-window-text').children[1];
        const right = document.createElement('span');
        right.className = 'limit-spend-right';
        value.replaceWith(right);
        const info = limitDetailInfoNode(details);
        info.addEventListener('click', /** @param {any} event @returns {any} */ event => event.stopPropagation());
        right.append(value, info);
      }
      tagUsageItem(balanceNode, 'credits', 'Balance');
      balanceNode.classList.add('limit-window-wide', 'limit-window-no-reset');
      windows.append(balanceNode);
      const spendNode = providerSpendNode(balance);
      if (spendNode) windows.append(spendNode);
    }
  }

  /** @param {any} balance @returns {any} */ function mimoTokenPlanWindowFromBalance(balance) {
    if (!balance) return null;
    if (balance.planStatus === 'expired') return null;
    const used = optionalFiniteNumber(balance.planUsed);
    const limit = optionalFiniteNumber(balance.planLimit);
    const percent = optionalFiniteNumber(balance.planPercent);
    const hasUsed = used !== null;
    const hasLimit = limit !== null;
    const hasPercent = percent !== null;
    if (!hasUsed && !hasLimit && !hasPercent) return null;
    const resolvedPercent = hasPercent
      ? Math.max(0, Math.min(100, percent))
      : (hasUsed && hasLimit && limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : null);
    return {
      kind: 'billing',
      label: 'Token Plan',
      used: hasUsed ? used : null,
      limit: hasLimit ? limit : null,
      remaining: hasUsed && hasLimit ? Math.max(0, limit - used) : null,
      usedPercent: resolvedPercent,
      remainingPercent: resolvedPercent == null ? null : Math.max(0, Math.min(100, 100 - resolvedPercent)),
      showMeter: true
    };
  }

  /** @param {any} groups @returns {any} */ function mimoAccountRepresentatives(groups) {
    return groups.map(/** @param {any} group @returns {any} */ group => group.find(/** @param {any} row @returns {any} */ row => row.accountEmail) || group[0]);
  }

  /** @param {any} provider @param {any} index @param {any} providers @returns {any} */ function mimoAccountTitle(provider, index, providers) {
    const product = mimoProductLabel(provider);
    if (product) {
      const groups = mimoAccountGroups(providers || [provider]);
      const representatives = mimoAccountRepresentatives(groups);
      const groupIndex = groups.findIndex(/** @param {any} group @returns {any} */ group => group.includes(provider));
      const identity = limitAccountDefaultTitle(representatives[groupIndex], groupIndex, representatives);
      return `${identity} · ${product}`;
    }
    // Compatibility for rows from versions that put the product in accountName
    // and the plan in accountLabel.
    const peers = (providers || [provider]).map(/** @param {any} row @returns {any} */ (row) => ({
      ...row,
      accountName: String(row?.accountName || row?.accountLabel || '').trim()
    }));
    return accountIdentity.accountTitleLabel(peers[index], peers, {
      maskEmail: limitAccountEmailsMasked(),
      index
    }) || `Account ${index + 1}`;
  }

  /** @param {any} list @param {any} providers @param {any} color @returns {any} */ function appendMimoAccountProducts(list, providers, color) {
    providers.forEach(/** @param {any} provider @param {any} index @returns {any} */ (provider, index) => {
      const policy = limitAccountRowPolicy('mimo', provider, color, { grouped: true, sharedFamily: null });
      // Product titles share the account heading layout; legacy failures retain their identity fallback.
      const product = mimoProductLabel(provider);
      const title = product === 'Console' ? 'Console' : product ? 'Desktop'
        : provider.status && provider.status !== 'ok' && !provider.stale
          ? limitAccountTitle('mimo', provider, index, providers) : '';
      list.append(renderLimitProviderRow('mimo', title, provider, policy.color, {
        accountRow: true,
        ...policy.options
      }));
    });
  }

  /** @param {any} label @param {any} providers @param {any} color @returns {any} */ function renderMimoProviderGroup(label, providers, color) {
    const hidden = usageItems.hiddenUsageItemSet(settings()?.limitProviderHiddenItems, 'mimo');
    const groups = mimoAccountGroups(providers);
    const representatives = mimoAccountRepresentatives(groups);
    const visibleGroups = groups.map(/** @param {any} group @param {any} index @returns {any} */ (group, index) => ({
      index,
      providers: group.filter(/** @param {any} provider @returns {any} */ provider => {
        if (hidden.size === 0 || provider.status !== 'ok' || provider.stale || subscriptionForProvider(provider)) return true;
        const items = limitProviderUsageItems([provider]);
        return items.length === 0 || items.some(/** @param {any} item @returns {any} */ item => !hidden.has(item.id));
      })
    })).filter(/** @param {any} group @returns {any} */ group => group.providers.length > 0);
    const visible = visibleGroups.flatMap(/** @param {any} group @returns {any} */ group => group.providers);
    const recorded = subscriptionsForProviderGroup('mimo', visible);
    const oneAccount = groups.length === 1;
    const { row, list, groupProvider } = renderLimitProviderGroupFrame('mimo', label, visible, color, {
      count: oneAccount ? 0 : visibleGroups.length
    });
    if (visible.length === 0 && recorded.length > 0) {
      row.children[0].replaceWith(renderLimitProviderHead('mimo', label, groupProvider, color, {
        planText: t('settings.subscriptions.title'), hideMeta: true
      }));
    }
    if (visible.length === 0 && recorded.length === 0) {
      row.style.display = 'none';
      return row;
    }
    if (oneAccount && visibleGroups.length === 1) {
      appendMimoAccountProducts(list, visibleGroups[0].providers, color);
    } else {
      visibleGroups.forEach(/** @param {any} options0 @returns {any} */ ({ providers: productsForAccount, index }) => {
        const account = document.createElement('div');
        account.className = 'limit-row limit-account-row';
        const products = document.createElement('div');
        products.className = 'limit-account-list';
        appendMimoAccountProducts(products, productsForAccount, color);
        account.append(renderLimitProviderHead('mimo',
          limitAccountDefaultTitle(representatives[index], index, representatives), representatives[index], color, {
            showIcon: false,
            accountRow: true,
            planText: '',
            hideMeta: true
          }), products);
        list.append(account);
      });
    }
    return row;
  }

  const rowPolicy = /** @param {any} provider @param {any} color @param {any} options2 @returns {any} */ (provider, color, { grouped }) => ({
    options: { accountTitle: true, ...(grouped ? { showIcon: false } : {}) }
  });

  const accountTitle = /** @param {any} provider @param {any} index @param {any} providers @returns {any} */ (provider, index, providers) => mimoAccountTitle(provider, index, providers);

  /** @param {any} label @param {any} provider @param {any} color @returns {any} */ function renderSolo(label, provider, color) { return mimoProductLabel(provider) ? renderMimoProviderGroup(label, [provider], color) : null; }

  /** @param {any} row @returns {any} */ function historyHoverBlocked(row) { return Boolean(row.querySelector('[data-usage-item="credits"] .limit-detail-tooltip-wrap:hover')); }
  /** @param {any} row @param {any} cancel @param {any} schedule @returns {any} */ function bindHistoryHover(row, cancel, schedule) {
    row.addEventListener('pointerover', /** @param {any} event @returns {any} */ event => {
      if (event.target.closest('[data-usage-item="credits"] .limit-detail-tooltip-wrap')) cancel();
    });
    row.addEventListener('pointerout', /** @param {any} event @returns {any} */ event => {
      const detail = event.target.closest('[data-usage-item="credits"] .limit-detail-tooltip-wrap');
      if (!detail || detail.contains(event.relatedTarget)) return;
      if (settings()?.limitsHistoryOpenMode !== 'click' && row.matches(':hover')) schedule();
    });
  }

  return { renderWindows, mimoTokenPlanWindowFromBalance, mimoAccountRepresentatives, mimoAccountTitle, appendMimoAccountProducts, renderMimoProviderGroup, rowPolicy, accountTitle, renderSolo, renderGroup: renderMimoProviderGroup, historyHoverBlocked, bindHistoryHover };
});
