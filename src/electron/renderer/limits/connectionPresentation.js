// @ts-check
'use strict';

(function exposeConnectionPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorConnectionPresentation = api;
})(typeof window !== 'undefined' ? /** @type {any} */ (window) : null, function createConnectionPresentationApi() {
  /**
   * Only declared capability options may select a provider-owned read lane.
   * Source descriptions use the shared select menu; credential setup stays in account forms.
   * @param {{ document: Document, t: (key: string, params?: Record<string, string>) => string,
   * sources: import('../../../shared/limits/accounts').AccountSource[],
   * provider: {status?: string, stale?: boolean, source?: string, sourceDetail?: string},
   * providerId?: string, label: string, onOpen?: () => void,
   * selection?: {key: string, sources: string[], autoLabelKey?: string, autoDescriptionKey?: string}, preference?: string,
   * onSelect?: (patch: Record<string, string>) => Promise<string> }} options
   */
  function createConnectionCard({ document, t, sources, provider, providerId, label, onOpen, selection, preference = 'auto', onSelect }) {
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
    const showGetLink = onOpen && manual.length > 0;
    const hasComplement = sources.some(source => source.relation === 'complement');
    const mixed = automatic && hasComplement && alternatives.length <= 1 && !(selection && onSelect);
    const automaticSummary = t(selection?.autoLabelKey || (mixed ? 'settings.limits.sources.mixedSummary' : automatic
      ? alternatives.length > 1 ? 'settings.limits.sources.auto' : 'settings.limits.sources.detectSummary'
      : primary.kind === 'apiKey' ? 'settings.limits.sources.manualApi' : 'settings.limits.sources.manualWeb'));
    // Setup instructions belong to the account editor; this card is a summary.
    const summaryText = automaticSummary;
    const summary = node('span', 'settings-item-desc', summaryText);
    copy.append(summary);
    // A fresh alternative reading can annotate Auto without adding another row.
    const current = alternatives.length > 1 && provider.status === 'ok' && !provider.stale
      ? alternatives.find(source => source.id === (provider.sourceDetail || provider.source))
        || alternatives.find(source => source.id === provider.source) : null;
    const autoLabel = selection?.autoLabelKey ? t(selection.autoLabelKey) : current
      ? `${t('settings.limits.capability.auto')} · ${t(current.labelKey)}`
      : t('settings.limits.connection.autoDetect');
    const actions = node('div', 'connection-source-actions');
    if (selection && onSelect) {
      const select = document.createElement('select');
      select.className = 'settings-select connection-source-method';
      if (providerId) select.id = `limit-connection-source-${providerId}`;
      select.setAttribute('aria-label', [t('settings.limits.connection.title'), label].filter(Boolean).join(' · '));
      const choices = sources.filter(source => selection.sources.includes(source.id) && source.relation === 'alternative');
      for (const choice of [{ id: 'auto', labelKey: 'settings.limits.connection.autoDetect', descriptionKey: 'settings.limits.sources.auto' }, ...choices]) {
        const option = document.createElement('option');
        option.value = choice.id;
        option.textContent = choice.id === 'auto' ? autoLabel : t(choice.labelKey);
        // appSelects already renders localized descriptions below menu options.
        if (choice.id === 'auto') option.dataset.tmSelectDescription = [selection.autoDescriptionKey ? t(selection.autoDescriptionKey) : automaticSummary,
          ...sources.filter(source => source.relation === 'complement').map(source => `${t(source.labelKey)} · ${t(source.descriptionKey)}`)
        ].join(' ');
        else option.dataset.selectDescription = choice.descriptionKey;
        select.append(option);
      }
      let accepted = choices.some(source => source.id === preference) ? preference : 'auto';
      const updateSummary = () => {
        const selected = choices.find(source => source.id === accepted);
        summary.textContent = selected
          ? t('settings.limits.sources.selected', { source: t(selected.labelKey) }) : summaryText;
      };
      select.value = accepted;
      updateSummary();
      const error = node('span', 'settings-item-desc');
      error.setAttribute('role', 'status');
      select.addEventListener('change', async () => {
        const focused = document.activeElement;
        const restoreFocus = select.id && (focused === select || focused?.id === `${select.id}-trigger`);
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
          if (restoreFocus) document.defaultView?.requestAnimationFrame(() => {
            if (document.activeElement === document.body) {
              document.getElementById(`${select.id}-trigger`)?.focus({ preventScroll: true });
            }
          });
        }
      });
      actions.append(select, error);
    } else if (automatic || !showGetLink) {
      actions.append(node('span', 'connection-source-method', automatic
        ? (mixed ? t('settings.limits.sources.mixed') : autoLabel) : t(primary.labelKey)));
    }
    if (showGetLink && onOpen) {
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
    return panel;
  }
  return { createConnectionCard };
});
