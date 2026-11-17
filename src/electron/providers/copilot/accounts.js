'use strict';

const limits = require('../../../shared/providers/copilot/limits');

// Compatibility API and main-only producer for the shared login action.
function createCopilotAccounts({ getSettings, service, probeDeps, env = process.env }) {
  return {
    getAccounts() {
      return service.list('copilot').accounts.map(item => ({ ...item, external: Boolean(item.source) }));
    },
    async addAccount(rawToken, isCurrent = () => true, signal, authorizedHost, label = '') {
      const result = await service.loginAction('copilot', async () => {
        const host = () => limits.normalizedEnterpriseHost(getSettings().copilotEnterpriseHost
          || env.COPILOT_ENTERPRISE_HOST || env.GITHUB_ENTERPRISE_HOST);
        const initialHost = host();
        const enterpriseHost = authorizedHost === undefined ? host() : limits.normalizedEnterpriseHost(authorizedHost);
        const current = () => isCurrent() && !signal?.aborted && host() === initialHost;
        if (!current()) throw new Error('GitHub Copilot sign-in was cancelled.');
        const token = limits.copilotToken({}, { copilotApiToken: rawToken });
        if (!token) throw new Error('A GitHub Copilot token is required.');
        const probe = probeDeps();
        const signals = [probe.signal, signal].filter(Boolean);
        const deps = { ...probe, copilotEnterpriseHost: enterpriseHost, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] };
        const identity = await limits.fetchGitHubIdentity(token, deps);
        const row = await limits.fetchCopilotAccountLimits({ copilotApiToken: token, copilotEnterpriseHost: enterpriseHost }, deps);
        if (row.status === 'unauthorized') throw new Error('The token does not have GitHub Copilot access.');
        if (!current()) throw new Error('GitHub Copilot sign-in was cancelled.');
        return { label, values: { copilotApiToken: token, copilotEnterpriseHost: enterpriseHost },
          identity: { ...row, accountName: identity.login || row.accountName,
            accountKey: limits.copilotAccountKey(identity.login || String(identity.id), enterpriseHost) }, isCurrent: current };
      });
      return { ok: Boolean(result.saved), ...(!result.saved ? { errorCode: result.errorCode || result.verdict } : {}) };
    },
    setEnabled: (id, enabled) => service.setEnabled('copilot', id, enabled),
    removeAccount: id => service.remove('copilot', id)
  };
}
module.exports = { createCopilotAccounts };
