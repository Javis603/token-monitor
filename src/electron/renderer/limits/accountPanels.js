'use strict';

// A form descriptor is a renderer-safe snapshot from main, never an account
// declaration. The panel is DOM and a busy guard only: saving, clearing and the
// message line belong to the caller, which saves through limits:saveCredential
// and draws the message from state so a stats re-render cannot wipe it.
//
// Layout comes from the form's block lists: `top` sits beside the actions and
// stays visible once the account is linked (a region select), `manual` is the
// paste panel that hides when linked. A block is a note, a numbered step list,
// or one of the form's fields.

function controlId(field) {
  return `${field.key}Input`;
}

function fieldValue(document, key) {
  return document.getElementById(`${key}Input`)?.value || '';
}

// A value that follows a select: `{ byField, values }` picks by the select's
// current value and falls back to its first entry.
function byFieldValue(document, spec) {
  const current = fieldValue(document, spec.byField);
  return spec.values[current] ?? Object.values(spec.values)[0];
}

// The page Open lands on. `byField` follows a select before its change is
// saved; `byStatus` follows the provider's last successful poll (MiniMax's
// region), with `default` until there is one.
function resolveOpenUrl(form, { document, provider }) {
  const { openUrl } = form;
  if (openUrl.url) return openUrl.url;
  if (openUrl.byField) return openUrl.urls[fieldValue(document, openUrl.byField)] || openUrl.default;
  return openUrl.urls[provider?.[openUrl.byStatus]] || openUrl.default;
}

// Selects and plain-text settings mirror what is stored; secrets never do.
// Dependent hints and conditional notes then follow the current values.
function syncCredentialFields(form, { document, settings }) {
  for (const field of form.fields) {
    const control = document.getElementById(controlId(field));
    if (!control) continue;
    if (field.input === 'select') {
      const stored = settings?.[field.key];
      control.value = field.options.some((option) => option.value === stored) ? stored : field.options[0].value;
    } else if (field.prefill && !control.value && document.activeElement !== control) {
      control.value = settings?.[field.key] || '';
    }
  }
  refreshFieldDependents(form, { document });
}

function refreshFieldDependents(form, { document }) {
  for (const hint of document.querySelectorAll?.(`[data-credential-form="${form.id}"][data-by-field]`) || []) {
    const spec = JSON.parse(hint.dataset.byField);
    if (hint.dataset.dependent === 'note') {
      hint.classList.toggle('hidden', !spec.values.includes(fieldValue(document, spec.field)));
    } else {
      hint.textContent = byFieldValue(document, spec);
    }
  }
}

function createCredentialPanel(form, { document, translate, onToggle, onOpen, onClear, onRefresh, onSave, onFieldChange }) {
  const { id } = form;
  const element = (tag, elementId, className = '') => {
    const node = document.createElement(tag);
    if (elementId) node.id = `${id}${elementId}`;
    if (className) node.className = className;
    return node;
  };
  const localized = (node, key) => {
    node.dataset.i18n = key;
    node.textContent = translate(key);
    return node;
  };
  const dependent = (node, kind, spec) => {
    node.dataset.credentialForm = id;
    node.dataset.dependent = kind;
    node.dataset.byField = JSON.stringify(spec);
    return node;
  };

  const group = element('div', 'AccountGroup', 'settings-group cursor-account-group');
  const toggle = element('button', 'SettingsToggle', 'settings-group-header cursor-settings-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', `${id}SettingsDetails`);
  const summary = element('span', '', 'cursor-settings-summary');
  const status = element('span', 'AccountStatus', 'cursor-status-pill');
  status.textContent = translate(form.emptyKey);
  const disclosure = element('span', '', 'cursor-disclosure-icon');
  disclosure.setAttribute('aria-hidden', 'true');
  summary.append(status, disclosure);
  toggle.append(localized(document.createElement('span'), form.titleKey), summary);
  const details = element('div', 'SettingsDetails', 'cursor-settings-details hidden');
  const actions = element('div', '', 'settings-actions');
  const open = localized(element('button', 'OpenBrowser'), form.openKey);
  const clear = localized(element('button', 'LogoutButton', 'hidden'), form.clearKey);
  const refresh = localized(element('button', 'RefreshButton'), 'settings.common.refresh');
  actions.append(open, clear, refresh);

  const stepPart = (part) => {
    if (typeof part === 'string') return localized(document.createElement('span'), part);
    if (part.text) return document.createTextNode(part.text);
    const code = document.createElement('code');
    if (typeof part.code === 'string') code.textContent = part.code;
    else dependent(code, 'code', part.code);
    return code;
  };
  const inputs = new Map();
  const control = (field) => {
    const input = document.createElement(field.input === 'select' || field.input === 'textarea' ? field.input : 'input');
    inputs.set(field, input);
    input.id = controlId(field);
    input.className = 'credential-input';
    if (field.input === 'select') {
      for (const option of field.options) {
        const node = localized(document.createElement('option'), option.labelKey);
        node.value = option.value;
        input.append(node);
      }
      input.addEventListener('change', () => {
        refreshFieldDependents(form, { document });
        onFieldChange?.(form, field, input.value);
      });
      return input;
    }
    if (field.input === 'textarea') input.rows = 3;
    else input.type = field.input;
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (field.placeholderKey) {
      input.dataset.i18nPlaceholder = field.placeholderKey;
      input.placeholder = translate(field.placeholderKey);
    } else if (field.placeholder) {
      input.placeholder = field.placeholder;
    }
    if (field.ariaLabelKey) {
      input.dataset.i18nAriaLabel = field.ariaLabelKey;
      input.setAttribute('aria-label', translate(field.ariaLabelKey));
    }
    return input;
  };
  const block = (spec) => {
    if (spec.note) {
      const note = localized(element('p', '', 'settings-note'), spec.note);
      if (spec.when) dependent(note, 'note', spec.when);
      return note;
    }
    if (spec.steps) {
      const notes = element('p', '', 'settings-note');
      for (const [index, step] of spec.steps.entries()) {
        if (index) notes.append(document.createElement('br'));
        const number = document.createElement('strong');
        number.textContent = `${index + 1}.`;
        notes.append(number);
        for (const part of Array.isArray(step) ? step : [step]) notes.append(' ', stepPart(part));
      }
      return notes;
    }
    const field = form.fields.find((candidate) => candidate.key === spec.field);
    const input = control(field);
    if (!field.labelKey) return input;
    const row = element('div', '', 'settings-row');
    const label = localized(document.createElement('label'), field.labelKey);
    label.setAttribute('for', input.id);
    row.append(label, input);
    return row;
  };

  const manual = element('div', 'ManualPanel', 'credential-manual-panel');
  manual.append(...form.manual.map(block));
  const submitActions = element('div', '', 'settings-actions');
  const submit = localized(element('button', 'CredentialSubmit'), form.saveKey);
  submitActions.append(submit);
  manual.append(submitActions);
  const error = element('div', 'ErrorMessage', 'settings-note error hidden');
  error.setAttribute('role', 'alert');
  details.append(actions, ...form.top.map(block), manual, error);
  group.append(toggle, details);

  toggle.addEventListener('click', () => onToggle(form));
  open.addEventListener('click', () => onOpen(form));
  clear.addEventListener('click', () => onClear(form));
  refresh.addEventListener('click', () => onRefresh(form));
  let saving = false;
  submit.addEventListener('click', async () => {
    if (saving) return;
    saving = true;
    submit.disabled = true;
    submit.textContent = translate('settings.common.checking');
    try {
      const values = Object.fromEntries([...inputs].map(([field, input]) => [field.key, input.value]));
      await onSave(form, values, () => {
        for (const [field, input] of inputs) if (field.secret) input.value = '';
      });
    } finally {
      saving = false;
      submit.disabled = false;
      submit.textContent = translate(form.saveKey);
    }
  });
  return group;
}

const api = { createCredentialPanel, refreshFieldDependents, resolveOpenUrl, syncCredentialFields };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TokenMonitorLimitAccountPanels = api;
