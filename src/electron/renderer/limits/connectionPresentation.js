// @ts-check
'use strict';

(function exposeConnectionPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorConnectionPresentation = api;
})(typeof window !== 'undefined' ? /** @type {any} */ (window) : null, function createConnectionPresentationApi() {
  /**
   * Only declared capability options may select a provider-owned read lane.
   * Complements remain discoverable even when the primary method is manual.
   * @param {{ document: Document, t: (key: string, params?: Record<string, string>) => string,
   * sources: import('../../../shared/limits/accounts').AccountSource[],
   * provider: {status?: string, stale?: boolean, source?: string, sourceDetail?: string},
   * label: string, onOpen?: () => void,
   * selection?: {key: string, sources: string[]}, preference?: string,
   * onSelect?: (patch: Record<string, string>) => Promise<string> }} options
   */
  function createConnectionCard({ document, t, sources, provider, label, onOpen, selection, preference = 'auto', onSelect }) {
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
    const automaticSummary = t(automatic
      ? alternatives.length > 1 ? 'settings.limits.sources.auto' : 'settings.limits.sources.detectSummary'
      : primary.kind === 'apiKey' ? 'settings.limits.sources.manualApi' : 'settings.limits.sources.manualWeb');
    const summary = node('span', 'settings-item-desc', automaticSummary);
    copy.append(summary);
    const actions = node('div', 'connection-source-actions');
    if (selection && onSelect) {
      const select = document.createElement('select');
      select.className = 'settings-select connection-source-method';
      select.setAttribute('aria-label', t('settings.limits.connection.title'));
      const choices = sources.filter(source => selection.sources.includes(source.id) && source.relation === 'alternative');
      for (const choice of [{ id: 'auto', labelKey: 'settings.limits.connection.autoDetect' }, ...choices]) {
        const option = document.createElement('option');
        option.value = choice.id;
        option.textContent = t(choice.labelKey);
        select.append(option);
      }
      let accepted = choices.some(source => source.id === preference) ? preference : 'auto';
      const updateSummary = () => {
        const selected = choices.find(source => source.id === accepted);
        summary.textContent = selected
          ? t('settings.limits.sources.selected', { source: t(selected.labelKey) }) : automaticSummary;
      };
      select.value = accepted;
      updateSummary();
      const error = node('span', 'settings-item-desc');
      error.setAttribute('role', 'status');
      select.addEventListener('change', async () => {
        select.disabled = true;
        error.textContent = '';
        try {
          accepted = await onSelect({ [selection.key]: select.value });
        } catch (_) {
          error.textContent = t('settings.limits.sources.saveFailed');
        } finally {
          select.value = accepted;
          updateSummary();
          select.disabled = false;
        }
      });
      actions.append(select, error);
    } else {
      actions.append(node('span', 'connection-source-method', automatic
        ? t('settings.limits.connection.autoDetect') : t(primary.labelKey)));
    }
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
