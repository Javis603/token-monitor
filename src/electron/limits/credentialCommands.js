'use strict';

// The one save path for an account form's credential. Every form goes through
// the same steps, so none of them decides alone whether a key is checked
// before it is stored, whether saving selects the provider, or what a failed
// check means:
//   normalize → probe → verdict → persist (unless invalid) → select provider
// Persisting goes through the injected applySettingsPatch — the settings:update
// body — so a credential lands exactly like any other settings write, including
// the runtime reconfigure and limit invalidation that write already plans, and
// the renderer gets back the same settings projection settings:update returns.

const { parseLimitProviders } = require('../../shared/limits/collector');
const { LIMIT_PROVIDER_REGISTRY, limitProviderEntry } = require('../../shared/limits/registry');
const { limitsAccountConfig, normalizeAccountField } = require('./accountSettings');

// A probe can only prove a credential wrong when the provider itself says so.
// Everything else — throttling, an outage, a timeout, a malformed answer — says
// nothing about the credential, so it is saved and left for the next poll to
// settle. Which HTTP answers count as `unauthorized` is each fetcher's call:
// a provider whose 404 means a wrong key or account reports it as such, which
// keeps this verdict and the account pill reading the same classification.
function credentialVerdict(status) {
  if (status === 'ok') return 'valid';
  if (status === 'unauthorized' || status === 'notConfigured') return 'invalid';
  return 'indeterminate';
}

function formFieldKeys(form) {
  return [form.field];
}

// An unset selection is the historical "every provider"; an explicitly empty
// one means none, so only the saved provider is added to it.
function providerSelectionIncluding(selection, providerId) {
  const selected = new Set(parseLimitProviders(selection));
  selected.add(providerId);
  return LIMIT_PROVIDER_REGISTRY.map(({ id }) => id).filter((id) => selected.has(id)).join(',');
}

function createCredentialCommands({ getSettings, applySettingsPatch, probeDeps, env = process.env }) {
  const revisions = new Map();
  const nextRevision = (providerId) => {
    const revision = (revisions.get(providerId) || 0) + 1;
    revisions.set(providerId, revision);
    return revision;
  };

  // The provider id is untrusted IPC input; only a declared form is accepted.
  function formEntry(providerId) {
    const entry = limitProviderEntry(String(providerId || ''));
    return entry?.form ? entry : null;
  }

  // A settings write that reaches a form's fields through any other path makes
  // an in-flight probe stale, so its result must not land over that write.
  function noteSettingsPatch(patch) {
    for (const entry of LIMIT_PROVIDER_REGISTRY) {
      if (entry.form && formFieldKeys(entry.form).some((key) => patch?.[key] !== undefined)) {
        nextRevision(entry.id);
      }
    }
  }

  async function saveCredential(providerId, values = {}) {
    const entry = formEntry(providerId);
    if (!entry) return { saved: false, verdict: 'invalid', status: 'notConfigured' };
    const revision = nextRevision(entry.id);
    const candidate = {};
    try {
      for (const key of formFieldKeys(entry.form)) {
        candidate[key] = normalizeAccountField(key, values[key]);
      }
    } catch (error) {
      return { saved: false, verdict: 'invalid', status: 'invalidFormat', errorCode: error?.code || '' };
    }
    if (formFieldKeys(entry.form).some((key) => !candidate[key])) {
      return { saved: false, verdict: 'invalid', status: 'invalidFormat', errorCode: '' };
    }

    let status;
    let errorCode = '';
    try {
      const provider = await entry.fetchLimits(
        { ...limitsAccountConfig(getSettings(), { env }), ...candidate },
        probeDeps()
      );
      status = provider?.status || 'unavailable';
    } catch (error) {
      status = error?.status || 'unavailable';
      errorCode = error?.code || '';
    }
    const verdict = credentialVerdict(status);
    if (verdict === 'invalid') return { saved: false, verdict, status, errorCode };
    if (revisions.get(entry.id) !== revision) {
      return { saved: false, verdict: 'superseded', status: 'superseded', errorCode: '' };
    }
    const settings = applySettingsPatch({
      ...candidate,
      limitProviders: providerSelectionIncluding(getSettings().limitProviders, entry.id),
      limitsEnabled: true
    });
    return { saved: true, verdict, status, errorCode, settings };
  }

  function clearCredential(providerId) {
    const entry = formEntry(providerId);
    if (!entry) return { cleared: false };
    const settings = applySettingsPatch(Object.fromEntries(formFieldKeys(entry.form).map((key) => [key, ''])));
    return { cleared: true, settings };
  }

  return { saveCredential, clearCredential, noteSettingsPatch };
}

module.exports = {
  createCredentialCommands,
  credentialVerdict,
  formFieldKeys,
  providerSelectionIncluding
};
