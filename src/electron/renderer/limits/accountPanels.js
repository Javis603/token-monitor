'use strict';

// A form descriptor is a renderer-safe snapshot from main, never an account
// declaration. Saves still go through settings:update, which owns the secret.
function createSingleCredentialPanel(form, { document, translate, onToggle, onOpen, onClear, onRefresh, onSave }) {
  const { id, input: inputKind, field } = form;
  const element = (tag, elementId, className = '') => {
    const node = document.createElement(tag);
    node.id = `${id}${elementId}`;
    if (className) node.className = className;
    return node;
  };
  const localized = (node, key) => {
    node.dataset.i18n = key;
    node.textContent = translate(key);
    return node;
  };
  const group = element('div', 'AccountGroup', 'settings-group cursor-account-group');
  const toggle = element('button', 'SettingsToggle', 'settings-group-header cursor-settings-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', `${id}SettingsDetails`);
  const summary = document.createElement('span');
  summary.className = 'cursor-settings-summary';
  const status = element('span', 'AccountStatus', 'cursor-status-pill');
  status.textContent = translate(form.emptyKey);
  const disclosure = document.createElement('span');
  disclosure.className = 'cursor-disclosure-icon';
  disclosure.setAttribute('aria-hidden', 'true');
  summary.append(status, disclosure);
  toggle.append(localized(document.createElement('span'), form.titleKey), summary);
  const details = element('div', 'SettingsDetails', 'cursor-settings-details hidden');
  const actions = document.createElement('div');
  actions.className = 'settings-actions';
  const open = localized(element('button', 'OpenBrowser'), form.openKey);
  const clear = localized(element('button', 'LogoutButton', 'hidden'), form.clearKey);
  const refresh = localized(element('button', 'RefreshButton'), 'settings.common.refresh');
  actions.append(open, clear, refresh);
  const manual = element('div', 'ManualPanel', 'single-credential-manual-panel');
  const notes = document.createElement('p');
  notes.className = 'settings-note';
  if (form.noteKey) {
    localized(notes, form.noteKey);
  } else {
    for (const [index, key] of form.steps.entries()) {
      if (index) notes.append(document.createElement('br'));
      const number = document.createElement('strong');
      number.textContent = `${index + 1}.`;
      notes.append(number, ' ', localized(document.createElement('span'), key));
    }
  }
  const input = document.createElement(inputKind === 'textarea' ? 'textarea' : 'input');
  input.id = `${field}Input`;
  if (inputKind === 'textarea') input.rows = 3;
  else input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.i18nPlaceholder = form.placeholderKey;
  input.placeholder = translate(form.placeholderKey);
  if (form.ariaLabelKey) {
    input.dataset.i18nAriaLabel = form.ariaLabelKey;
    input.setAttribute('aria-label', translate(form.ariaLabelKey));
  }
  const submitActions = document.createElement('div');
  submitActions.className = 'settings-actions';
  const submit = localized(element('button', inputKind === 'textarea' ? 'CookieSubmit' : 'ApiKeySubmit'), form.saveKey);
  submitActions.append(submit);
  manual.append(notes, input, submitActions);
  const error = element('div', 'ErrorMessage', 'settings-note error hidden');
  error.setAttribute('role', 'alert');
  details.append(actions, manual, error);
  group.append(toggle, details);

  toggle.addEventListener('click', () => onToggle(form));
  open.addEventListener('click', () => onOpen(form));
  clear.addEventListener('click', () => onClear(form));
  refresh.addEventListener('click', () => onRefresh(form));
  let saving = false;
  submit.addEventListener('click', async () => {
    if (saving) return;
    error.classList.add('hidden');
    if (!String(input.value || '').trim()) {
      error.textContent = translate(form.emptyKey);
      error.classList.remove('hidden');
      return;
    }
    saving = true;
    submit.disabled = true;
    if (form.validation) submit.textContent = translate('settings.common.checking');
    try {
      await onSave(form, input.value, () => { input.value = ''; });
    } catch (cause) {
      error.textContent = form.validation && cause?.validationStatus
        ? translate(cause.validationStatus === 'unauthorized' ? form.validation.invalidKey
          : ['rateLimited', 'sourceRateLimited'].includes(cause.validationStatus)
            ? form.validation.rateLimitedKey : form.validation.unavailableKey)
        : translate(form.failedKey, { message: cause.message });
      error.classList.remove('hidden');
    } finally {
      saving = false;
      submit.disabled = false;
      if (form.validation) submit.textContent = translate(form.saveKey);
    }
  });
  return group;
}

const api = { createSingleCredentialPanel };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TokenMonitorLimitAccountPanels = api;
