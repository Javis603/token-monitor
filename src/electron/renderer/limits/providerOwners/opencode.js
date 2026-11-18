'use strict';
(function expose(root, factory) {
 if (typeof module === 'object' && module.exports) module.exports = { create: factory };
 if (root) root.TokenMonitorOpencodeAccountOwner = { create: factory };
})(typeof window !== 'undefined' ? window : null, /**
 * @param {{document: Document, window: Window & any, initial: object,
 * getSettings: () => object, getAccountContext: () => object,
 * preserveScroll: Function, localProviderStatuses: Function, [capability: string]: any}} host
 * Named host callbacks compose provider state with shared settings publication.
 * The owner retains login/cancellation and editor generations across repaints.
 */ function create(host) {
 let accountList;
 // Host exposes named capabilities, never the application state object.
 const { document, window, setAccountGroupExpanded, isSettingsSurfaceVisible, renderAccountShellError, accountProfileRequests, accountProfileStatuses, t, renderSettingsSummaries, setAccountShellError, accountShellApi, encodeURIComponent, accountProfileSaves } = host;
 const state = {opencodeProfileCount: host.initial.opencodeProfileCount};
 Object.defineProperty(state, 'settings', { get: host.getSettings });
function setOpencodeCookieExpanded(expanded) {
  setAccountGroupExpanded('opencode', expanded, 'opencodeCookieExpanded');
}

function renderOpenCodeProfiles() {
  if (!isSettingsSurfaceVisible()) return;
  const listEl = document.getElementById('opencodeProfileList');
  if (!listEl) return;
  renderAccountShellError('opencode');

  const api = window.tokenMonitor.opencode;

  const isCurrent = accountProfileRequests.begin('opencode');
  api.getProfiles().then(result => {
    const { profiles, hasEnvVar, hasAmbientKey, ambientEnabled = true } = result;
    const { ambientAccountKey } = result;
    if (!isCurrent() || !isSettingsSurfaceVisible() || document.getElementById('opencodeProfileList') !== listEl) return;
    accountProfileStatuses.retire('opencode');
    listEl.replaceChildren();
    const entries = Object.entries(profiles);


    // The auto-detected key counts as an account: it is what the limits card is
    // reading, so leaving it out of the total reports "not set up" next to live
    // quota. It has no delete because Token Monitor does not own that
    // credential — OpenCode does — but naming it does belong here: a name is
    // what lets it join an account, and typing an existing account's name is
    // how a user says the two are the same OpenCode account.
    if (hasAmbientKey) {
      const item = document.createElement('div');
      item.className = 'opencode-profile-item';
      item.dataset.ownerId = 'ambient:';
      // Switchable like any other account, even without a name. Turning it off
      // is a device preference rather than a stored credential, so the row keeps
      // rendering with its box clear instead of disappearing along with the only
      // control that could bring it back.
      const ambientToggle = document.createElement('input');
      ambientToggle.className = 'profile-toggle';
      ambientToggle.type = 'checkbox';
      ambientToggle.checked = ambientEnabled;
      ambientToggle.setAttribute('aria-label', t('settings.opencode.ambientName'));
      ambientToggle.setAttribute('aria-description', t('settings.opencode.ambientDetail'));
      ambientToggle.addEventListener('change', async () => {
        await window.tokenMonitor.opencode.setAmbientEnabled(ambientToggle.checked);
        renderOpenCodeProfiles();
        updateOpenCodeProfilesStatus();
        renderSettingsSummaries();
      });
      const nameBox = document.createElement('span');
      nameBox.className = 'profile-name-box';
      // An editable field rather than a label behind an edit button: this row
      // has no name yet, and naming it is the only thing a user can do here, so
      // hiding that behind a hover-revealed pencil hides the whole feature. The
      // placeholder carries the label the row used to show.
      const nameInput = document.createElement('input');
      nameInput.className = 'profile-name-input is-placeholder';
      nameInput.type = 'text';
      nameInput.placeholder = t('settings.opencode.ambientName');
      nameInput.setAttribute('aria-label', t('settings.opencode.nameAmbient'));

      // Typing an existing account's name binds the auto-detected key into that
      // account. That claim is confirmed, never inferred: the main process
      // refuses it without `merge`, so a blur landing on a name that happens to
      // exist offers the button instead of quietly merging.
      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'credential-merge-btn hidden';
      const offer = opencodeMergeOffer(mergeBtn, (name) => applyNaming(name, true));
      const applyNaming = async (name, merge) => {
        const at = offer.revision();
        // 'ambient' stores a reference rather than the key, so a key rotated
        // inside OpenCode keeps being read live.
        const result = await window.tokenMonitor.opencode.saveProfile(name, '', 'ambient', { merge });
        if (!result.ok) {
          if (result.nameTaken) {
            offer.offer(at, name, t('settings.opencode.mergeInto', { name }));
            return;
          }
          if (offer.stale(at)) return;
          setAccountShellError('opencode', opencodeSaveErrorText(result));
          return;
        }
        setAccountShellError('opencode', '');
        renderOpenCodeProfiles();
        updateOpenCodeProfilesStatus();
        renderSettingsSummaries();
      };
      const endNaming = async (save) => {
        const name = nameInput.value.trim();
        if (!save || !name) {
          nameInput.value = '';
          offer.withdraw();
          return;
        }
        await applyNaming(name, false);
      };
      // Editing the name withdraws the offer: the confirmation names one account,
      // and it must be the one on screen when the user clicks it.
      nameInput.addEventListener('input', () => offer.withdraw());
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') endNaming(true);
        if (e.key === 'Escape') endNaming(false);
      });
      nameInput.addEventListener('blur', () => endNaming(true));

      const detail = document.createElement('span');
      detail.className = 'profile-detail';
      detail.textContent = t('settings.opencode.ambientDetail');
      nameBox.append(nameInput, mergeBtn, detail);

      const rightBox = document.createElement('span');
      rightBox.className = 'profile-right';
      const infoSpan = document.createElement('span');
      infoSpan.className = 'profile-info';
      // Not `opencode-info-<name>`: that shape is generated from user-chosen
      // account names, so a profile named the same as any sentinel would take
      // this row's status.
      infoSpan.id = 'opencodeAmbientInfo';
      infoSpan.textContent = ambientEnabled ? '...' : t('settings.opencode.disabled');
      rightBox.append(infoSpan);
      item.append(ambientToggle, nameBox, rightBox);
      listEl.appendChild(item);
    }

    state.opencodeProfileCount = entries.length + (hasAmbientKey ? 1 : 0);
    renderSettingsSummaries();

    for (const [name, profile] of entries) {
      const item = document.createElement('div');
      item.className = 'opencode-profile-item';
      item.dataset.ownerId = `profile:${name}`;

      const toggle = document.createElement('input');
      toggle.className = 'profile-toggle';
      toggle.type = 'checkbox';
      toggle.checked = profile.enabled;
      toggle.addEventListener('change', () => {
        api.setProfileEnabled(name, toggle.checked).then(() => {
          const info = item.querySelector('.profile-info');
          info.textContent = toggle.checked ? '...' : t('settings.opencode.disabled');
          renderSettingsSummaries();
          updateOpenCodeProfilesStatus();
        });
      });

      const nameBox = document.createElement('span');
      nameBox.className = 'profile-name-box';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'profile-name';
      nameSpan.textContent = name;

      const nameInput = document.createElement('input');
      nameInput.className = 'profile-name-input hidden';
      nameInput.type = 'text';
      nameInput.value = name;

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'profile-rename-btn';
      renameBtn.setAttribute('aria-label', t('settings.opencode.rename'));

      let editing = false;
      function beginRename() {
        if (editing) return;
        editing = true;
        nameSpan.classList.add('hidden');
        nameInput.classList.remove('hidden');
        nameInput.focus();
        nameInput.select();
      }
      // Renaming onto an existing account merges the two, which asserts they are
      // the same OpenCode account. That claim gets a visible button rather than
      // a repeated keypress: confirming should be something the user chooses,
      // not something they discover by pressing Enter again.
      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'credential-merge-btn hidden';
      const offer = opencodeMergeOffer(mergeBtn, (next) => applyRename(next, true));
      const applyRename = async (next, merge) => {
        const at = offer.revision();
        const result = await api.renameProfile(name, next, { merge });
        if (!result.ok) {
          if (result.nameTaken) {
            offer.offer(at, next, t('settings.opencode.mergeInto', { name: next }));
            return;
          }
          if (offer.stale(at)) return;
          setAccountShellError('opencode', opencodeSaveErrorText(result));
          return;
        }
        setAccountShellError('opencode', '');
        renderOpenCodeProfiles();
        updateOpenCodeProfilesStatus();
        renderSettingsSummaries();
      };
      // Retyping withdraws the offer, so the button can only ever confirm the
      // name the user is currently proposing.
      nameInput.addEventListener('input', () => offer.withdraw());
      async function endRename(save) {
        if (!editing) return;
        editing = false;
        nameInput.classList.add('hidden');
        nameSpan.classList.remove('hidden');
        const next = nameInput.value.trim();
        if (!save || !next || next === name) return;
        await applyRename(next, false);
      }
      renameBtn.addEventListener('click', beginRename);
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') endRename(true);
        if (e.key === 'Escape') endRename(false);
      });
      nameInput.addEventListener('blur', () => endRename(true));

      // Which credentials this account holds. Two of them under one name is the
      // user's assertion that they are the same OpenCode account, and that
      // assertion decides which source answers for quota and which identity the
      // account is published under, so it stays visible. Acting on them lives in
      // the expanded section rather than inline: a click that unbinds an account
      // should not sit one pixel from the account's own controls.
      // A reference the collector has stopped using says so on its own row.
      // Otherwise an account that also holds a cookie shows the credential as
      // present, keeps reporting fine from the cookie, and nothing anywhere
      // reveals that its Go quota is no longer coming from the detected key.
      const ambientLabel = profile.ambientStale
        ? `${t('settings.opencode.ambientName')} · ${t('settings.opencode.needsRebind')}`
        : t('settings.opencode.ambientName');
      const credentials = [
        ['ambient', profile.usesAmbientKey, ambientLabel],
        ['api', profile.hasApiKey, t('settings.opencode.kindApi')],
        ['cookie', profile.hasCookie, t('settings.opencode.kindCookie')]
      ].filter(([, present]) => present);

      // The summary line is the control that expands it: clicking the thing you
      // want to see beats a separate chevron stranded between the status text
      // and the delete button.
      const multiCredential = credentials.length > 1;
      const detail = document.createElement(multiCredential ? 'button' : 'span');
      detail.className = 'profile-detail';
      let chevron = null;
      if (multiCredential) {
        detail.type = 'button';
        detail.classList.add('is-expandable');
        detail.setAttribute('aria-expanded', 'false');
        detail.setAttribute('aria-label', t('settings.opencode.showCredentials'));
        // The same disclosure chevron every other group uses, so it animates and
        // reads the same; only the direction differs, pointing right when closed.
        chevron = document.createElement('span');
        chevron.className = 'cursor-disclosure-icon';
        chevron.setAttribute('aria-hidden', 'true');
      }
      detail.textContent = credentials.map(([, , label]) => label).join(' + ');
      if (chevron) detail.append(chevron);

      nameBox.append(nameSpan, nameInput, renameBtn, mergeBtn, detail);

      const rightBox = document.createElement('span');
      rightBox.className = 'profile-right';

      const infoSpan = document.createElement('span');
      infoSpan.className = 'profile-info';
      infoSpan.id = opencodeRowId('opencode-info-', name);
      infoSpan.textContent = profile.enabled ? '...' : t('settings.opencode.disabled');

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'profile-delete';
      deleteBtn.textContent = '✕';
      deleteBtn.setAttribute('aria-label', t('settings.opencode.delete'));
      let confirmingDelete = false;
      deleteBtn.addEventListener('click', async () => {
        if (!confirmingDelete) {
          confirmingDelete = true;
          deleteBtn.classList.add('confirming');
          deleteBtn.textContent = '✓';
          deleteBtn.setAttribute('aria-label', t('settings.opencode.deleteConfirm', { name }));
          return;
        }
        await api.deleteProfile(name);
        renderOpenCodeProfiles();
        updateOpenCodeProfilesStatus();
        renderSettingsSummaries();
      });

      // Expanding is only worth offering once an account holds more than one
      // credential — with a single one the row already says everything.
      let credentialList = null;
      if (multiCredential) {
        credentialList = document.createElement('div');
        credentialList.className = 'opencode-credential-list accordion-animated-container hidden';
        credentialList.id = opencodeRowId('opencode-credentials-', name);
        // The shared accordion squeezes one inner wrapper, so the rows go inside
        // it rather than on the container, which cannot shrink.
        const credentialInner = document.createElement('div');
        credentialInner.className = 'accordion-animation-inner';
        for (const [kind, , label] of credentials) {
          credentialInner.append(opencodeCredentialRow(name, kind, label));
        }
        credentialList.append(credentialInner);
        detail.setAttribute('aria-controls', credentialList.id);
        detail.addEventListener('click', () => {
          const open = credentialList.classList.toggle('hidden') === false;
          detail.setAttribute('aria-expanded', String(open));
          detail.classList.toggle('is-open', open);
        });
      }

      rightBox.append(infoSpan, deleteBtn);
      item.append(toggle, nameBox, rightBox);
      if (credentialList) item.append(credentialList);
      listEl.appendChild(item);
    }

    if (!accountList) {
      const common = document.createElement('div');
      listEl.before(common);
      accountList = window.TokenMonitorLegacyAccountList.create({
      busy: () => document.getElementById('opencodeCookieSubmit')?.disabled === true,
      sourceLabel: account => account.source === 'ambient' ? t('settings.limits.sources.file') : account.source === 'environment' ? t('settings.limits.sources.env') : t('settings.slots.savedSource'),
      editor: { submit: 'opencodeCookieSubmit', nodes: ['opencodeAddDetails', 'opencodeProfileList'], visibility: 'opencodeAddDetails', replaceVisibility: 'opencodeProfileList', cancel: () => setOpenCodeAddExpanded(false) },
        document, provider: 'opencode', label: host.providerLabel || 'OpenCode',
    add: () => setOpenCodeAddExpanded(document.getElementById('opencodeAddDetails')?.classList.contains('hidden')), container: common, t, bridge: window.tokenMonitor,
        getContext: host.getAccountContext, preserveScroll: host.preserveScroll,
        enabled: (account, value) => account.source === 'ambient'
          ? api.setAmbientEnabled(value) : api.setProfileEnabled(account.profileName, value),
        remove: account => api.deleteProfile(account.profileName),
        edit: account => {
          listEl.classList.remove('hidden');
          for (const row of listEl.children) row.classList.toggle('hidden', row.dataset.ownerId !== account.id);
        },
        changed: () => {}, refresh: renderOpenCodeProfiles
      });
    }
    const empty = entries.length === 0 && !hasEnvVar && !hasAmbientKey;
    listEl.classList.toggle('hidden', !empty);
    if (empty) {
      const notice = document.createElement('div');
      notice.className = 'opencode-empty';
      notice.textContent = t('settings.opencode.emptyList');
      listEl.append(notice);
    }
    accountList.update([
      ...(hasAmbientKey ? [{ id: 'ambient:', source: 'ambient', accountKey: ambientAccountKey, accountName: t('settings.opencode.ambientName'), enabled: ambientEnabled, removable: false }] : []),
      ...entries.map(([name, profile]) => ({ id: `profile:${name}`, profileName: name, accountKey: profile.accountKey, accountKeyAliases: profile.accountKeyAliases, accountName: name, enabled: profile.enabled }))
    ], host.localProviderStatuses('opencode'));
    updateOpenCodeProfilesStatus();
  }).catch(() => {
    if (!isCurrent() || !isSettingsSurfaceVisible()) return;
    accountShellApi.render({
      status: document.getElementById('opencodeCookieStatus'),
      statusText: t('settings.opencode.connectFailed')
    });
  });
}

function opencodeSaveErrorText(result) {
  if (result?.credentialConflict) {
    return t('settings.opencode.credentialConflict', {
      kind: t(result.kind === 'cookie' ? 'settings.opencode.kindCookie'
        : result.kind === 'ambient' ? 'settings.opencode.ambientName'
          : 'settings.opencode.kindApi')
    });
  }
  return result?.error || t('settings.opencode.saveFailedShort');
}

function opencodeMergeOffer(button, confirm) {
  let revision = 0;
  let pending = '';
  button.addEventListener('click', () => {
    if (pending !== '') confirm(pending);
  });
  return {
    // Captured before the await, compared after it.
    revision: () => revision,
    stale: (at) => at !== revision,
    withdraw: () => {
      revision += 1;
      pending = '';
      button.classList.add('hidden');
    },
    offer: (at, name, label) => {
      if (at !== revision) return;
      pending = name;
      button.textContent = label;
      button.classList.remove('hidden');
    }
  };
}

function opencodeRowId(prefix, name) {
  return `${prefix}${encodeURIComponent(name)}`;
}

function opencodeCredentialRow(accountName, kind, label) {
  const api = window.tokenMonitor.opencode;
  const refresh = () => {
    renderOpenCodeProfiles();
    updateOpenCodeProfilesStatus();
    renderSettingsSummaries();
  };

  const row = document.createElement('div');
  row.className = 'opencode-credential-row';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'credential-label';
  labelSpan.textContent = label;

  // The account name is shown on every credential rather than hidden behind an
  // edit button, because seeing the same name twice is the explanation for why
  // these are one account. Typing a different one moves that credential out.
  const nameInput = document.createElement('input');
  nameInput.className = 'credential-name-input';
  nameInput.type = 'text';
  nameInput.value = accountName;
  nameInput.setAttribute('aria-label', t('settings.opencode.moveCredential', { kind: label }));
  nameInput.placeholder = t('settings.opencode.profileNamePlaceholder');

  const actions = document.createElement('span');
  actions.className = 'credential-actions';

  // A merge is a claim that two credentials belong to one OpenCode account, so
  // it is confirmed with a visible button rather than by pressing the same key
  // twice and hoping the user reads why.
  const mergeBtn = document.createElement('button');
  mergeBtn.className = 'credential-merge-btn hidden';
  const offer = opencodeMergeOffer(mergeBtn, (target) => finishMove(target, true));

  const finishMove = async (target, merge) => {
    const at = offer.revision();
    const result = await api.moveCredential(accountName, kind, target, { merge });
    if (!result.ok) {
      if (result.nameTaken) {
        offer.offer(at, target, t('settings.opencode.mergeInto', { name: target }));
        return;
      }
      if (offer.stale(at)) return;
      setAccountShellError('opencode', opencodeSaveErrorText(result));
      return;
    }
    setAccountShellError('opencode', '');
    refresh();
  };
  const endMove = async (save) => {
    const target = nameInput.value.trim();
    if (!save || !target || target === accountName) {
      nameInput.value = accountName;
      offer.withdraw();
      return;
    }
    await finishMove(target, false);
  };

  // Same rule as everywhere else: retyping the target withdraws the pending
  // confirmation rather than leaving a button that would move it somewhere the
  // user is no longer proposing.
  nameInput.addEventListener('input', () => offer.withdraw());
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') endMove(true);
    if (e.key === 'Escape') endMove(false);
  });
  nameInput.addEventListener('blur', () => endMove(true));

  const removeBtn = document.createElement('button');
  removeBtn.className = 'profile-delete';
  removeBtn.textContent = '✕';
  removeBtn.setAttribute('aria-label', t('settings.opencode.removeCredential', { kind: label }));
  // Two-step, like deleting an account: unbinding is not undoable from here.
  let confirming = false;
  removeBtn.addEventListener('click', async () => {
    if (!confirming) {
      confirming = true;
      removeBtn.classList.add('confirming');
      removeBtn.textContent = '✓';
      return;
    }
    const result = await api.removeCredential(accountName, kind);
    if (result.ok) refresh();
  });

  actions.append(removeBtn);
  // The merge label carries the target account name and never fits beside the
  // input, so it trails the row and wraps onto its own line when it appears.
  row.append(labelSpan, nameInput, actions, mergeBtn);
  return row;
}

async function updateOpenCodeProfilesStatus() {
  const api = window.tokenMonitor.opencode;
  const isCurrent = accountProfileStatuses.begin('opencode');
  const status = await api.status();
  if (!isCurrent() || !isSettingsSurfaceVisible()) return;
  const profiles = status.profiles || {};

  // The auto-detected key has no account name, so it arrives in its own field
  // and lands on its own element rather than one keyed by a name a user could
  // also type.
  const entries = Object.entries(profiles).map(([name, s]) => [
    opencodeRowId('opencode-info-', name),
    s
  ]);
  if (status.ambient) entries.push(['opencodeAmbientInfo', status.ambient]);

  for (const [elementId, s] of entries) {
    const infoEl = document.getElementById(elementId);
    if (!infoEl) continue;

    if (s.disabled) {
      infoEl.textContent = t('settings.opencode.disabled');
    } else if (s.needsRebind) {
      // Said once, on the credential line, which has room for it and is the
      // thing that needs re-attaching. This cell is a fixed narrow column and
      // would only repeat it truncated.
      infoEl.textContent = '';
    } else if (s.expired) {
      infoEl.textContent = t('settings.opencode.statusExpired');
    } else if (s.linked) {
      const parts = [];
      if (s.go) parts.push('Go');
      if (s.zen) parts.push('Zen');
      let text = '✓ ' + parts.join(' · ');
      if (s.hasBalance && s.balanceUsd != null) {
        text += '  $' + Number(s.balanceUsd).toFixed(2);
      }
      infoEl.textContent = text;
    } else if (s.error) {
      infoEl.textContent = s.error;
    } else {
      infoEl.textContent = t('settings.opencode.connectFailed');
    }
  }

  renderOpenCodeProfilesStatusSummary(profiles, status.ambient);
}

function renderOpenCodeProfilesStatusSummary(profiles, ambient = null) {
  const totalEl = document.getElementById('opencodeCookieStatus');
  if (totalEl) {
    const statuses = [...Object.values(profiles), ...(ambient ? [ambient] : [])];
    const linkedCount = statuses.filter(s => s.linked).length;
    const configuredProfileCount = state.opencodeProfileCount || 0;
    const totalCount = Math.max(statuses.length, configuredProfileCount);
    accountShellApi.render({
      status: totalEl,
      statusText: totalCount > 0
        ? t('settings.opencode.connected', { linked: linkedCount, total: totalCount })
        : t('settings.opencode.statusNotSet')
    });
  }
}
function setOpenCodeAddExpanded(expanded) {
  const next = Boolean(expanded);
  document.getElementById('opencodeAddToggle')?.setAttribute('aria-expanded', String(next));
  document.getElementById('opencodeAddDetails')?.classList.toggle('hidden', !next);
  document.getElementById('opencodeAddForm')?.classList.toggle('expanded', next);
}
function setup() {
  const opencodeToggle = document.getElementById('opencodeSettingsToggle');
  if (opencodeToggle) {
    opencodeToggle.addEventListener('click', () => {
      const expanding = document.getElementById('opencodeSettingsDetails').classList.contains('hidden');
      setOpencodeCookieExpanded(expanding);
      if (expanding) renderOpenCodeProfiles();
    });

    const addToggle = document.getElementById('opencodeAddToggle');
    addToggle?.classList.toggle('hidden', true);
    const addDetails = document.getElementById('opencodeAddDetails');

    addToggle?.addEventListener('click', () => setOpenCodeAddExpanded(addDetails?.classList.contains('hidden')));

    document.getElementById('opencodeOpenBrowser')?.addEventListener('click', () => {
      window.tokenMonitor.openExternal('https://opencode.ai/console');
    });

    // API key is the default: it needs no browser round trip. The cookie stays
    // selectable because it is the only thing that reaches the Zen balance.
    const kindSelect = document.getElementById('opencodeCredentialKind');
    // The merge confirmation is about one specific proposal: this name, this
    // credential. Editing any part of the form makes the offer on screen stale,
    // and a confirmation the user gives has to be a confirmation of what they
    // are looking at, so any edit withdraws it.
    const addMergeButton = document.getElementById('opencodeCredentialMerge');
    // Confirming re-runs the submit handler's own closure, which is what holds
    // the name and credential the offer was made for.
    let confirmOpenCodeMerge = () => {};
    const addMergeOffer = addMergeButton
      ? opencodeMergeOffer(addMergeButton, () => confirmOpenCodeMerge())
      : null;
    const clearOpenCodeMergeOffer = () => addMergeOffer?.withdraw();
    for (const id of ['opencodeProfileName', 'opencodeApiKeyInput', 'opencodeCookieInput']) {
      document.getElementById(id)?.addEventListener('input', clearOpenCodeMergeOffer);
    }
    const applyOpenCodeCredentialKind = () => {
      const isCookie = kindSelect?.value === 'cookie';
      document.getElementById('opencodeApiFields')?.classList.toggle('hidden', isCookie);
      document.getElementById('opencodeCookieFields')?.classList.toggle('hidden', !isCookie);
      // One button for both modes; only what it is fetching differs. The keys
      // page itself lives under a workspace id we do not have, so both land on
      // the console sign-in.
      const browserButton = document.getElementById('opencodeOpenBrowser');
      if (browserButton) {
        const key = isCookie ? 'settings.opencode.openBrowser' : 'settings.opencode.openBrowserKeys';
        browserButton.dataset.i18n = key;
        browserButton.textContent = t(key);
      }
      // Clear the field being hidden so a value typed under one credential type
      // can never be submitted as the other.
      const stale = document.getElementById(isCookie ? 'opencodeApiKeyInput' : 'opencodeCookieInput');
      if (stale) stale.value = '';
      setAccountShellError('opencode', '');
      clearOpenCodeMergeOffer();
    };
    kindSelect?.addEventListener('change', applyOpenCodeCredentialKind);
    applyOpenCodeCredentialKind();

    const profileSubmit = document.getElementById('opencodeCookieSubmit');
    profileSubmit.addEventListener('click', () => accountProfileSaves.run('opencode', profileSubmit, async () => {
      const opencodeCredentialKind = kindSelect?.value === 'cookie' ? 'cookie' : 'api';
      const input = document.getElementById(opencodeCredentialKind === 'cookie'
        ? 'opencodeCookieInput'
        : 'opencodeApiKeyInput');
      const nameInput = document.getElementById('opencodeProfileName');
      const name = (nameInput.value || '').trim();
      const cookie = input.value;

      setAccountShellError('opencode', '');

      // The name is required rather than defaulted. Saving one credential keeps
      // the other under the same name, and the collector reads that as "these
      // are the same account", so a blank name silently becoming `default`
      // could attach one account's key to another account's cookie. Making the
      // user type the name is what keeps the association explicit.
      if (!name) {
        setAccountShellError('opencode', t('settings.opencode.nameRequired'));
        nameInput.focus();
        return;
      }

      // A name that already holds a different credential kind binds the two into
      // one account, so the main process refuses it and the form asks first.
      // The confirmation replaces the submit button rather than appearing beside
      // it: the next click has different consequences from the one just made.
      const submit = async (merge) => {
        const at = addMergeOffer?.revision();
        confirmOpenCodeMerge = () => accountProfileSaves.run('opencode', addMergeButton, () => submit(true));
        const result = await window.tokenMonitor.opencode.saveProfile(
          name,
          cookie,
          opencodeCredentialKind,
          { merge }
        );
        // Whether or not the form still shows this proposal, a save that landed
        // has to reach the list. Only the fields are left alone, so an edit made
        // while the request was in flight is not wiped by its reply.
        const stale = addMergeOffer ? addMergeOffer.stale(at) : false;
        if (result.ok) {
          // Only this proposal's own offer is taken down. Two saves can overlap,
          // and the newer one can answer first: clearing unconditionally let an
          // older success wipe a merge confirmation the user was looking at and
          // that was still correct.
          if (!stale) {
            input.value = '';
            nameInput.value = '';
            addMergeOffer?.withdraw();
          }
          if (!stale) setAccountShellError('opencode', '');
          renderOpenCodeProfiles();
          updateOpenCodeProfilesStatus();
          renderSettingsSummaries();
          return;
        }
        if (stale) return;
        if (result.nameTaken && addMergeOffer) {
          addMergeOffer.offer(at, name, t('settings.opencode.mergeInto', { name }));
          return;
        }
        setAccountShellError('opencode', opencodeSaveErrorText(result));
      };
      await submit(false);
    }));
  }


}
 return { state, setOpencodeCookieExpanded, renderOpenCodeProfiles, opencodeSaveErrorText, opencodeMergeOffer, opencodeRowId, opencodeCredentialRow, updateOpenCodeProfilesStatus, renderOpenCodeProfilesStatusSummary, setup };
});
