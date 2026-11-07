'use strict';
const { parseBalance } = require('./balance.cjs');
const CREDIT_BALANCE_URL = 'https://api.openai.com/v1/dashboard/billing/credit_grants';
function createBackend({ host }, { now = Date.now } = {}) {
  return { async call(method, args) {
    const validating = method === 'credentials.validate';
    if ((!validating && method !== 'limits.collect') || args?.moduleId !== 'credits'
      || (validating && (!Number.isSafeInteger(args.revision) || args.revision < 0))) throw Error('Unknown credit operation');
    const failure = status => validating ? { status: status === 'unauthorized' || status === 'error' ? 'rejected' : 'unavailable' } : { status, windows: [] };
    let response, settings;
    try {
      if (!validating) {
        const status = await host.call('credentials.status', { moduleId: 'credits' });
        if (!status.configured) return failure('notConfigured');
      }
      const saved = await host.call('credentials.read', { moduleId: 'credits', ...(validating ? { expectedRevision: args.revision } : {}) });
      const token = String(saved.sessionBearer || '').trim().replace(/^Bearer\s+/i, '');
      const organization = String(saved.organization || '').trim();
      if (!token || /\s|[\x00-\x1f\x7f]/.test(token) || !organization || /[\x00-\x1f\x7f]/.test(organization)) return failure('error');
      if (!validating) settings = await host.call('settings.get');
      response = await host.call('network.request', { moduleId: 'credits', requestId: validating ? 'credential-check' : 'credit-balance',
        url: CREDIT_BALANCE_URL, method: 'GET', timeoutMs: 15000,
        headers: { Authorization: `Bearer ${token}`, 'OpenAI-Organization': organization, Accept: 'application/json' } });
    } catch (_) { return failure('unavailable'); }
    if ([401, 403].includes(response.status)) return failure('unauthorized');
    if (response.status === 429) return failure('rateLimited');
    if (response.status !== 200) return failure('unavailable');
    try {
      const balance = parseBalance(JSON.parse(response.body), now());
      if (validating) return { status: 'valid' };
      const grants = balance.usableGrants;
      const showDetails = grants.length > 1 && grants.length <= 12
        && new Set(grants.map(grant => grant.expiresAt)).size > 1;
      let infoRows;
      if (showDetails) {
        const { resolveLocale, t } = await import('./i18n.mjs');
        const appSettings = await host.call('app.settings');
        const locale = resolveLocale(appSettings.locale || (appSettings.language === 'auto' ? Intl.DateTimeFormat().resolvedOptions().locale : appSettings.language));
        infoRows = grants.map(grant => ({
          label: grant.expiresAt ? t(locale, 'expires', { time: grant.expiresAt.slice(0, 16).replace('T', ' ') }) : t(locale, 'noExpiry'),
          value: { amount: grant.remaining, currency: balance.currency }
        }));
      }
      return { status: 'ok', windows: [{ kind: 'billing', metric: 'credits', label: 'API credits',
        creditsDisplay: settings.values.displayMode === 'bar' ? 'percent' : 'balance',
        remaining: balance.available, limit: balance.meterTotal, currency: balance.currency, ...(infoRows ? { infoRows } : {}),
        boundaryKind: 'expiry', resetsAt: balance.expiresAt }] };
    } catch (_) { return validating ? { status: 'unavailable' } : failure('error'); }
  } };
}
exports.createBackend = createBackend;
exports.activate = async context => createBackend(context);
