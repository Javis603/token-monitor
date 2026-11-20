// @ts-check
'use strict';

(function exposeConnectionPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorConnectionPresentation = api;
})(typeof window !== 'undefined' ? /** @type {any} */ (window) : null, function createConnectionPresentationApi() {
  /** @typedef {import('../../../shared/limits/accounts').AccountSource} AccountSource */
  /** @typedef {{status?: string, stale?: boolean, source?: string, sourceDetail?: string}} Reading */

  const MANUAL_KINDS = ['apiKey', 'web'];


  /** @param {Reading} reading */
  function isFresh(reading) {
    return reading?.status === 'ok' && !reading.stale;
  }

  /**
   * The declared source a reading came through, or null when its provenance
   * does not name one. `sourceDetail` is the finer lane (Codex RPC reports
   * `app` or `cli` there), so it wins over `source`.
   * @param {AccountSource[]} sources @param {Reading | null | undefined} reading
   */
  function sourceForReading(sources, reading) {
    if (!reading) return null;
    if (sources.length === 1) return sources[0];
    if (!reading.source && !reading.sourceDetail) return null;
    const detail = String(reading.sourceDetail || '').toLowerCase();
    const source = String(reading.source || '').toLowerCase();
    return (detail && sources.find(entry => entry.id === detail)) || sources.find(entry => entry.id === source) || null;
  }

  /**
   * Read-only summary of where a provider's quota comes from. Collection is
   * always automatic; the card names the sources and marks those that fresh
   * readings on this device actually came through.
   * @param {{ document: Document, t: (key: string, params?: Record<string, string>) => string,
   * sources: AccountSource[], readings?: Reading[], liveSourceIds?: Iterable<string> }} options
   * `liveSourceIds` are lanes the account rows attribute to connected accounts.
   */
  function createConnectionCard({ document, t, sources, readings = [], liveSourceIds = [] }) {
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
    const alternatives = sources.filter(source => source.relation !== 'complement');
    const complements = sources.filter(source => source.relation === 'complement');
    const manual = sources.filter(source => MANUAL_KINDS.includes(source.kind));
    // A required API lane with optional Web enrichment is still a manual method,
    // not a pair of ordered fallbacks (DeepSeek, for example).
    const primary = manual.find(source => source.kind === 'apiKey') || (sources.length === 1 ? manual[0] : null);
    const automatic = !primary || alternatives.length > 1 || sources.some(source => !MANUAL_KINDS.includes(source.kind));
    const mixed = automatic && complements.length > 0 && alternatives.length <= 1;
    copy.append(node('span', 'settings-item-desc', t(mixed ? 'settings.limits.sources.mixedSummary' : automatic
      ? alternatives.length > 1 ? 'settings.limits.sources.auto' : 'settings.limits.sources.detectSummary'
      : primary?.kind === 'apiKey' ? 'settings.limits.sources.manualApi' : 'settings.limits.sources.manualWeb')));

    const fresh = readings.filter(isFresh);
    const live = new Set([...fresh.map(reading => sourceForReading(sources, reading)?.id), ...liveSourceIds]
      .filter(id => id && sources.some(source => source.id === id)));
    // Connected through a lane the readings cannot name: list every source
    // without claiming one. Only an absence of fresh readings greys them out.
    const list = node('span', `connection-source-list${fresh.length || live.size ? '' : ' is-idle'}`);
    const ordered = [...alternatives, ...complements];
    /** @type {string[]} */
    const spoken = [];
    ordered.forEach((source, index) => {
      const name = t(source.labelKey);
      // A joint travels with the source after it, so a wrapped line starts
      // with "› CLI" instead of leaving a separator dangling.
      const segment = node('span', 'connection-source-segment');
      if (index > 0) {
        const joint = source.relation === 'complement' ? '+' : '›';
        segment.append(node('span', 'connection-source-joint', joint));
        spoken.push(joint);
      }
      const isLive = live.has(source.id);
      const item = node('span', `connection-source-item${isLive ? ' is-live' : ''}`);
      item.dataset.kind = source.kind;
      item.append(node('span', 'connection-source-icon-glyph'));
      // With a live source, the others shrink to their icon; every name stays
      // in the list's accessible label.
      if (!live.size || isLive) item.append(node('span', 'connection-source-name', name));
      segment.append(item);
      list.append(segment);
      spoken.push(name);
    });
    list.setAttribute('role', 'img');
    // The highlight is visual only, so the label names the lanes being read.
    const liveNames = ordered.filter(source => live.has(source.id)).map(source => t(source.labelKey));
    list.setAttribute('aria-label', [spoken.join(' '), ...(liveNames.length
      ? [t('settings.limits.sources.reading', { sources: liveNames.join(', ') })] : [])].join(' · '));
    const actions = node('div', 'connection-source-actions');
    actions.append(list);
    card.append(copy, actions);
    panel.append(card);
    return panel;
  }
  return { createConnectionCard, isFresh, sourceForReading };
});
