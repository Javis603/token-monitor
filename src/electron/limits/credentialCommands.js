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
const { accountForm, limitsAccountConfig, normalizeAccountField } = require('./accountSettings');

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

function formFields(entry) {
  return accountForm(entry)?.fields || [];
}

function formFieldKeys(entry) {
  return formFields(entry).map(({ key }) => key);
}

function invalid(status, errorCode = '') {
  return { saved: false, verdict: 'invalid', status, errorCode };
}

// The draft as it would be stored. Only fields the caller sent are part of it,
// so one of Kimi's two credential lanes can be saved without blanking the
// other; a select always travels with its form, so it is always sent.
function draftFor(entry, values) {
  const candidate = {};
  for (const field of formFields(entry)) {
    if (!Object.hasOwn(values, field.key)) continue;
    const raw = String(values[field.key] ?? '');
    try {
      candidate[field.key] = normalizeAccountField(field.key, raw);
    } catch (error) {
      return { rejected: invalid('invalidFormat', error?.code || '') };
    }
    // Something was pasted, but nothing usable survived normalization.
    if (field.secret && raw.trim() && !candidate[field.key]) return { rejected: invalid('invalidFormat') };
  }
  const fields = formFields(entry);
  if (fields.some((field) => field.required && !candidate[field.key])
    || !fields.some((field) => field.secret && candidate[field.key])) {
    return { rejected: invalid('required') };
  }
  return { candidate };
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
      if (entry.form && formFieldKeys(entry).some((key) => patch?.[key] !== undefined)) {
        nextRevision(entry.id);
      }
    }
  }

  async function saveCredential(providerId, values) {
    const entry = formEntry(providerId);
    if (!entry || !values || typeof values !== 'object') return invalid('notConfigured');
    const revision = nextRevision(entry.id);
    const { candidate, rejected } = draftFor(entry, values);
    if (rejected) return rejected;

    // The probe sees the draft and nothing it would not store: a credential of
    // this form that is not part of the draft is blanked, so a stored sibling
    // (Kimi's other lane) cannot answer for a bad one, and an empty env keeps
    // the same fallback from vouching through a process variable.
    const options = limitsAccountConfig(getSettings(), { env });
    for (const field of formFields(entry)) {
      if (field.secret && !Object.hasOwn(candidate, field.key)) options[field.key] = '';
    }
    const renewed = {};
    const deps = { ...probeDeps(renewed), env: {} };
    const discover = accountForm(entry).discover;
    let discoveredChoices;
    if (discover) {
      let choices;
      try {
        choices = await entry.limits[discover.fn](candidate[discover.credential], deps);
      } catch (error) {
        if (revisions.get(entry.id) !== revision) {
          return { saved: false, verdict: 'superseded', status: 'superseded', errorCode: '' };
        }
        if (credentialVerdict(error?.status) === 'invalid') return invalid(error.status, error?.code || '');
      }
      if (revisions.get(entry.id) !== revision) {
        return { saved: false, verdict: 'superseded', status: 'superseded', errorCode: '' };
      }
      if (choices?.length) {
        discoveredChoices = choices;
        if (choices.length === 1 && !candidate[discover.selection]) {
          candidate[discover.selection] = choices[0].id;
        } else if (choices.length > 1 && !candidate[discover.selection]) {
          return { saved: false, verdict: 'selectionRequired', status: 'selectionRequired', choices };
        }
        if (!choices.some((choice) => choice.id === candidate[discover.selection])) {
          return { saved: false, verdict: 'selectionRequired', status: 'selectionRequired', choices };
        }
      }
      if (renewed[discover.credential]) candidate[discover.credential] = normalizeAccountField(discover.credential, renewed[discover.credential]);
    }
    let provider = null;
    let status;
    let errorCode = '';
    try {
      provider = await entry.fetchLimits({ ...options, ...candidate }, deps);
      status = provider?.status || 'unavailable';
    } catch (error) {
      status = error?.status || 'unavailable';
      errorCode = error?.code || '';
      if (errorCode === 'CLAUDE_WEB_ORGANIZATION_SELECTION_REQUIRED') discoveredChoices = error.organizationChoices;
    }
    // Any later write for this form retires the whole probe — a stale
    // rejection must not land over a newer credential either.
    if (revisions.get(entry.id) !== revision) {
      return { saved: false, verdict: 'superseded', status: 'superseded', errorCode: '' };
    }
    const verdict = credentialVerdict(status);
    if (discoveredChoices && errorCode === 'CLAUDE_WEB_ORGANIZATION_SELECTION_REQUIRED') {
      return { saved: false, verdict: 'selectionRequired', status: 'selectionRequired', choices: discoveredChoices };
    }
    if (verdict === 'invalid') return invalid(status, errorCode);
    // A probe may rotate the credential it was given (Claude's session key);
    // what gets stored is the value the provider will accept next.
    for (const [key, value] of Object.entries(renewed)) {
      if (Object.hasOwn(candidate, key)) candidate[key] = normalizeAccountField(key, value);
    }
    const remember = accountForm(entry).rememberProbe;
    if (remember && verdict === 'valid') entry.limits[remember.fn](candidate[remember.field], provider);
    const settings = applySettingsPatch({
      ...candidate,
      limitProviders: providerSelectionIncluding(getSettings().limitProviders, entry.id),
      limitsEnabled: true
    });
    return { saved: true, verdict, status, errorCode, settings, ...(discoveredChoices ? { choices: discoveredChoices } : {}) };
  }

  function clearCredential(providerId) {
    const entry = formEntry(providerId);
    if (!entry) return { cleared: false };
    const settings = applySettingsPatch(Object.fromEntries(
      formFields(entry).filter((field) => field.secret || entry.fields.find((item) => item.key === field.key)?.clearWithCredential).map(({ key }) => [key, ''])
    ));
    return { cleared: true, settings };
  }

  async function listOrganizationChoices(providerId) {
    const entry = formEntry(providerId);
    const form = entry && accountForm(entry);
    if (!form?.discover) return { status: 'notConfigured', choices: [] };
    const cookie = limitsAccountConfig(getSettings(), { env })[form.discover.credential];
    if (!cookie) return { status: 'notConfigured', choices: [] };
    const renewed = {};
    try {
      const choices = await entry.limits[form.discover.fn](cookie, { ...probeDeps(renewed), env: {} });
      if (renewed[form.discover.credential] && getSettings()[form.discover.credential] === cookie) {
        applySettingsPatch({ [form.discover.credential]: renewed[form.discover.credential] });
      }
      return { status: 'ok', choices };
    } catch (error) {
      return { status: error?.status || 'unavailable', choices: [] };
    }
  }

  return { saveCredential, clearCredential, listOrganizationChoices, noteSettingsPatch };
}

module.exports = {
  createCredentialCommands,
  credentialVerdict,
  providerSelectionIncluding
};
