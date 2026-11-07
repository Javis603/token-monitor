import { messages, resolveLocale } from './i18n.mjs';

export function activate(ctx) {
  return { async mount(container, context) {
    let locale = resolveLocale(document.documentElement.lang), words = messages[locale];
    const labels = new Map();
    function setText(node, key) {
      if (key) labels.set(node, key); else labels.delete(node);
      node.textContent = key ? words[key] : '';
    }
    function updateWords() {
      const next = resolveLocale(document.documentElement.lang);
      if (next === locale) return false;
      locale = next; words = messages[locale];
      for (const [node, key] of labels) node.textContent = words[key];
      return true;
    }
    const root = document.createElement('div'); root.className = 'openai-credit-preferences';
    if (!context.moduleId) {
      const note = document.createElement('p'); note.className = 'settings-note';
      setText(note, 'management');
      root.append(note); container.append(root);
      return { update() { updateWords(); }, dispose() { root.remove(); } };
    }
    root.classList.add('cursor-settings-details-inner');
    const address = document.createElement('label'); address.className = 'settings-field';
    const addressLabel = document.createElement('span'); addressLabel.className = 'settings-field-label'; setText(addressLabel, 'billingUrl');
    const addressInput = document.createElement('input'); addressInput.className = 'credential-input'; addressInput.type = 'url'; addressInput.readOnly = true; addressInput.value = 'https://platform.openai.com/settings/organization/billing/overview'; addressInput.dataset.openaiUrl = '';
    addressInput.addEventListener('click', () => addressInput.select());
    address.append(addressLabel, addressInput);
    const actionsLink = document.createElement('div'); actionsLink.className = 'settings-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'settings-button'; copy.dataset.openaiCopy = '';
    setText(copy, 'copyUrl');
    const copyStatus = document.createElement('p'); copyStatus.className = 'settings-note'; copyStatus.setAttribute('role', 'status'); copyStatus.hidden = true;
    copy.addEventListener('click', async () => {
      try {
        await ctx.app.copyText(addressInput.value);
        setText(copyStatus, 'copied');
      } catch (_) { setText(copyStatus, 'copyFailed'); }
      copyStatus.hidden = false;
    });
    actionsLink.append(copy);
    const guide = document.createElement('p'); guide.className = 'settings-note'; guide.dataset.openaiSetup = '';
    const codeValues = { '{request}': 'credit_grants', '{authorization}': 'Authorization', '{organizationHeader}': 'OpenAI-Organization' };
    function renderGuide() {
      guide.replaceChildren();
      ['step1', 'step2', 'step3', 'step4'].forEach((key, index) => {
        if (index) guide.append(document.createElement('br'));
        const number = document.createElement('strong'); number.textContent = `${index + 1}.`;
        guide.append(number, ' ');
        for (const part of words[key].split(/(\{\w+\})/)) {
          const value = codeValues[part];
          if (value) { const code = document.createElement('code'); code.textContent = value; guide.append(code); }
          else guide.append(part);
        }
      });
    }
    renderGuide();
    const note = document.createElement('p'); note.className = 'settings-note';
    setText(note, 'credentialHelp');
    const instructions = document.createElement('div'); instructions.className = 'cursor-settings-details-inner'; instructions.dataset.openaiInstructions = '';
    instructions.append(address, actionsLink, copyStatus, guide, note); root.append(instructions); container.append(root);
    const credentials = await ctx.native.credentials.mount(root, { moduleId: context.moduleId, onStateChange(state) { instructions.hidden = !state.editing; } });
    const row = document.createElement('label'); row.className = 'settings-item';
    const title = document.createElement('span'); title.className = 'settings-item-text'; setText(title, 'label');
    const select = document.createElement('select'); select.dataset.openaiMode = ''; select.disabled = true;
    for (const value of ['bar', 'balance']) { const option = document.createElement('option'); option.value = value; setText(option, value); select.append(option); }
    row.append(title, select);
    const actions = document.createElement('div'); actions.className = 'settings-actions';
    const save = document.createElement('button'); save.type = 'button'; save.className = 'settings-button'; setText(save, 'save'); save.dataset.openaiSave = '';
    const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'settings-button'; setText(reload, 'reload'); reload.dataset.openaiReload = ''; reload.hidden = true;
    const feedback = document.createElement('p'); feedback.className = 'settings-note'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    actions.append(save, reload); root.append(row, actions, feedback);
    let snapshot, disposed = false, busy = false, recoveryRequired = false;
    function sync() { select.disabled = busy || !snapshot || snapshot.readOnly; save.disabled = select.disabled || recoveryRequired || select.value === snapshot.values.displayMode; reload.disabled = busy; reload.hidden = !recoveryRequired; }
    async function load() {
      busy = true; sync();
      try { const value = await ctx.host.call('settings.get'); if (!disposed) { snapshot = value; select.value = value.values.displayMode ?? ''; setText(feedback); recoveryRequired = false; } }
      catch (_) { if (!disposed) { setText(feedback, 'loadFailed'); recoveryRequired = true; } }
      finally { if (!disposed) { busy = false; sync(); } }
    }
    select.addEventListener('change', () => { if (!recoveryRequired) setText(feedback); sync(); });
    save.addEventListener('click', async () => {
      if (busy || !snapshot || snapshot.readOnly || recoveryRequired) return;
      busy = true; setText(feedback, 'saving'); sync();
      try {
        const value = await ctx.host.call('settings.update', { schemaVersion: snapshot.schemaVersion, expectedRevision: snapshot.revision, patch: { displayMode: select.value } });
        if (!disposed) { snapshot = value; select.value = value.values.displayMode; setText(feedback, 'saved'); }
      } catch (error) { if (!disposed) { recoveryRequired = String(error?.message || error).includes('settings-conflict'); setText(feedback, recoveryRequired ? 'conflict' : 'failed'); } }
      finally { if (!disposed) { busy = false; sync(); } }
    });
    reload.addEventListener('click', () => void load());
    await load();
    return { update(next) { if (updateWords()) renderGuide(); return credentials.update(next); },
      hasUnsavedChanges: () => credentials.hasUnsavedChanges() || Boolean(snapshot && select.value !== snapshot.values.displayMode),
      dispose() { disposed = true; credentials.dispose(); root.remove(); } };
  } };
}
