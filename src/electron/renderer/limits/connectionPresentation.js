// @ts-check
'use strict';

(function exposeConnectionPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorConnectionPresentation = api;
})(typeof window !== 'undefined' ? /** @type {any} */ (window) : null, function createConnectionPresentationApi() {
  /**
   * Display metadata never selects a collector or changes fallback order.
   * Complements remain discoverable even when the primary method is manual.
   * @param {{ document: Document, t: (key: string, params?: Record<string, string>) => string,
   * sources: import('../../../shared/limits/accounts').AccountSource[],
   * provider: {status?: string, stale?: boolean, source?: string, sourceDetail?: string},
   * label: string, onOpen?: () => void }} options
   */
  function createConnectionCard({ document, t, sources, provider, label, onOpen }) {
    /** @param {string} tag @param {string} className @param {string} [text] */
    const node = (tag, className, text = '') => {
      const el = document.createElement(tag);
      el.className = className;
      el.textContent = text;
      return el;
    };
    const panel = node('div', 'limit-provider-connection-sources');
    const card = node('div', 'connection-source-card');
    const copy = node('div', 'connection-source-copy');
    copy.append(node('span', 'settings-item-title', t('settings.limits.connection.title')));
    const alternatives = sources.filter(source => source.relation === 'alternative');
    const manual = sources.filter(source => ['apiKey', 'web'].includes(source.kind));
    // A required API lane with optional Web enrichment is still a manual method,
    // not a pair of mutually exclusive choices (DeepSeek, for example).
    const primary = manual.find(source => source.kind === 'apiKey') || (sources.length === 1 ? manual[0] : null);
    const automatic = !primary || alternatives.length > 1 || sources.some(source => !['apiKey', 'web'].includes(source.kind));
    copy.append(node('span', 'settings-item-desc', t(automatic
      ? alternatives.length > 1 ? 'settings.limits.sources.auto' : 'settings.limits.sources.detectSummary'
      : primary.kind === 'apiKey' ? 'settings.limits.sources.manualApi' : 'settings.limits.sources.manualWeb')));
    const actions = node('div', 'connection-source-actions');
    actions.append(node('span', 'connection-source-method', automatic
      ? t('settings.limits.connection.autoDetect') : t(primary.labelKey)));
    // Only fresh successful alternative readings prove a current lane. A Web
    // complement is never reported as the exclusive source of a combined read.
    const current = alternatives.length > 1 && provider.status === 'ok' && !provider.stale
      ? alternatives.find(source => source.id === (provider.sourceDetail || provider.source))
        || alternatives.find(source => source.id === provider.source) : null;
    if (current) actions.append(node('span', 'settings-item-desc', t('settings.limits.sources.using', { source: t(current.labelKey) })));
    if (onOpen && manual.length) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'inline-link connection-source-get';
      link.append(document.createTextNode(t('settings.limits.sources.getLink', { source: label })));
      const icon = document.createElement('span');
      icon.className = 'connection-source-icon';
      icon.setAttribute('aria-hidden', 'true');
      link.append(icon);
      link.addEventListener('click', onOpen);
      actions.append(link);
    }
    card.append(copy, actions);
    panel.append(card);
    const details = document.createElement('details');
    details.className = 'connection-source-details';
    details.append(node('summary', 'inline-link', t('settings.limits.sources.details')));
    for (const source of sources) {
      details.append(node('p', 'settings-item-desc', `${t(source.labelKey)} · ${t(source.descriptionKey)}`));
    }
    panel.append(details);
    return panel;
  }
  return { createConnectionCard };
});
