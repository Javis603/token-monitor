'use strict';

(function exposeSyncContentForm(root, factory) {
  const helpApi = typeof module === 'object' && module.exports ? require('./helpPopover') : root.TokenMonitorHelpPopover;
  const api = factory(helpApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSyncContentForm = api;
})(typeof window !== 'undefined' ? window : null, function createSyncContentFormApi(helpApi) {
  const KINDS = ['sessionTitles', 'modelAliases', 'customPricing'];
  const SETTINGS_KINDS = { modelAliases: 'modelAliases', modelAliasGrouping: 'modelAliases', customModelPricing: 'customPricing' };

  function snapshotBase(status) {
    return { identity: status?.identity || '', revisions: { ...status?.revisions } };
  }

  function decorateSettingsPatch(patch, status, base = snapshotBase(status)) {
    if (!Object.keys(patch).some(key => status?.enabled?.[SETTINGS_KINDS[key]] === true)) return patch;
    return { ...patch, syncContentBase: snapshotBase(base) };
  }

  function isConflictError(error) {
    return error?.error === 'conflict' || error?.code === 'conflict' || error?.status === 409
      || /\b409\b|\bconflict\b|shared settings changed/i.test(String(error?.message || error || ''));
  }

  function createSyncContentForm({ document, bridge, t, saveSettings, getSettings }) {
    const el = suffix => document.getElementById(`syncContent${suffix}`);
    const inputs = Object.fromEntries(KINDS.map(kind => [kind, el(kind)]));
    let status = null;
    let settings = getSettings() || {};
    let connection = '';
    let busy = false;
    let request = null;
    let generation = 0;
    let disclosureGeneration = 0;
    let pushRevision = 0;
    let decision = null;
    let message = '';
    const text = (key, params) => t(`settings.sync.content.${key}`, params);
    const errorKey = error => ['unsupported', 'unreachable', 'conflict', 'cleanup_pending', 'hub_changed', 'unauthorized'].includes(error) ? error : 'unreachable';
    const available = () => Boolean(status?.supported && status.identity && !['unreachable', 'unsupported', 'unauthorized', 'hub_changed'].includes(status.error));

    function closeDecision() {
      const focus = decision?.focus;
      decision = null;
      if (el('Dialog').open) el('Dialog').close();
      focus?.focus({ preventScroll: true });
    }

    const help = helpApi.createHelpPopover({ trigger: el('TitleHelp'), popover: el('TitleHelpPopover'), document });
    const closeHelp = () => help.close();

    function render() {
      const mode = settings?.hubMode || 'local';
      const shared = mode === 'host' || mode === 'client';
      el('Options').hidden = !shared;
      el('LocalNote').hidden = shared;
      el('HostRow').hidden = mode !== 'host';
      el('HostPermission').checked = settings?.hubSyncSessionTitles === true;
      el('HostPermission').disabled = busy;
      for (const kind of KINDS) {
        inputs[kind].checked = status?.enabled?.[kind] === true;
        inputs[kind].disabled = busy || !status?.identity || (!inputs[kind].checked && (!available()
          || (kind === 'sessionTitles' && (!status.serverTitlesEnabled || status.pendingTitleCleanup))));
      }
      el('TitleUnavailable').hidden = !shared || !status || status.serverTitlesEnabled || !status.supported;
      el('TitleNote').hidden = !el('TitleUnavailable').hidden;
      el('TitleHelp').hidden = el('TitleUnavailable').hidden;
      if (el('TitleUnavailable').hidden) closeHelp();
      el('Cleanup').hidden = !status?.pendingTitleCleanup;
      el('CleanupRetry').disabled = busy || !available();
      const issue = message || (shared && (!status || status.error) ? (status ? errorKey(status.error) : 'checking') : '');
      el('Status').textContent = issue ? text(issue) : '';
      el('Status').hidden = !issue;
      el('Notice').hidden = !issue || issue === 'cleanup_pending';
      el('DialogStatus').textContent = message ? text(message) : '';
      el('DialogStatus').hidden = !message;
      el('Retry').hidden = !shared || !issue || issue === 'checking' || issue === 'cleanup_pending';
      el('Retry').disabled = busy || Boolean(request);
      for (const suffix of ['Confirm', 'UseServer', 'Publish']) el(suffix).disabled = busy || message === 'conflict' || message === 'hub_changed';
      el('DialogRetry').hidden = !message;
      el('DialogRetry').disabled = busy;
      el('Cancel').disabled = busy;
    }

    function applyStatus(next) {
      if (!next) return;
      if (decision && (next.identity !== decision.identity || next.destination !== decision.destination || !next.supported
          || (decision.kind === 'sessionTitles' && !next.serverTitlesEnabled))) {
        closeDecision();
        message = 'hub_changed';
      }
      if (status?.identity !== next.identity) closeHelp();
      status = next;
      render();
    }

    function refresh(refreshServer = true) {
      if (request) return request;
      const epoch = generation;
      const revision = pushRevision;
      const pending = (async () => {
        try {
          const next = await bridge.getSyncContentStatus(refreshServer !== false);
          if (epoch === generation && revision === pushRevision) {
            message = '';
            applyStatus(next);
          }
        } catch (_) {
          if (epoch === generation && revision === pushRevision) {
            message = 'unreachable';
            if (status) status = { ...status, error: 'unreachable' };
          }
        }
      })();
      request = pending;
      render();
      return pending.finally(() => {
        if (request === pending) request = null;
        render();
      });
    }

    function showDecision(kind, preview) {
      closeHelp();
      decision = { kind, preview, identity: status.identity, destination: status.destination, focus: inputs[kind] };
      const titles = kind === 'sessionTitles';
      el('DialogTitle').textContent = text(titles ? 'titleWarning' : kind);
      el('DialogCopy').textContent = text(titles ? 'titleWarningBody' : 'chooseSource', { destination: status.destination });
      el('Counts').hidden = titles;
      el('Counts').textContent = titles ? '' : text('counts', { local: preview.localCount, server: preview.serverCount });
      el('NoShared').hidden = titles || preview.hasServerValue;
      el('Confirm').hidden = !titles;
      el('UseServer').hidden = titles;
      el('Publish').hidden = titles;
      el('Dialog').showModal();
      el('Cancel').focus();
      render();
    }

    async function configure(kind, enabled, extra = {}) {
      const epoch = generation;
      const identity = status.identity;
      const result = await bridge.configureSyncContent({ kind, enabled, identity, ...extra });
      if (epoch !== generation || status?.identity !== identity) { message = 'hub_changed'; return result; }
      applyStatus(result.status);
      if (result.ok) {
        message = '';
        closeDecision();
      } else {
        message = errorKey(result.error || result.status?.error);
      }
      render();
      return result;
    }

    async function run(action) {
      if (busy) return;
      busy = true;
      message = '';
      render();
      try { await action(); } catch (_) { message = 'unreachable'; } finally {
        busy = false;
        render();
        if (decision && document.activeElement === el('Dialog')) el('Cancel').focus();
      }
    }

    async function toggle(kind, enabled) {
      // A native change event has already flipped the input. Restore the confirmed
      // value before awaiting any IPC, including the privacy confirmation.
      render();
      const epoch = generation;
      const disclosureEpoch = disclosureGeneration;
      return run(async () => {
        if (!enabled) {
          if (status?.identity) await configure(kind, false);
          return;
        }
        await refresh();
        if (disclosureEpoch !== disclosureGeneration) return;
        if (epoch !== generation) { message = 'hub_changed'; return; }
        if (!available()) return;
        if (kind === 'sessionTitles') {
          if (!status.serverTitlesEnabled || status.pendingTitleCleanup) return;
          if (!status.destination) { message = 'unreachable'; return; }
          showDecision(kind);
          return;
        }
        const identity = status.identity;
        const preview = await bridge.previewSyncContent(kind);
        if (disclosureEpoch !== disclosureGeneration) return;
        if (epoch !== generation || status?.identity !== identity) { message = 'hub_changed'; return; }
        if (!preview.ok) { applyStatus(preview.status); message = errorKey(preview.error); return; }
        if (preview.identity !== identity) { message = 'hub_changed'; return; }
        if (preview.equal) {
          await configure(kind, true, { source: 'server', revision: preview.revision, localFingerprint: preview.localFingerprint });
        } else {
          showDecision(kind, preview);
        }
      });
    }

    async function confirm(source) {
      const saved = decision;
      if (!saved) return;
      return run(async () => {
        await refresh();
        if (decision !== saved || !available()) return;
        await configure(saved.kind, true, saved.kind === 'sessionTitles'
          ? { confirmed: true, identity: saved.identity }
          : { source, identity: saved.identity, revision: saved.preview.revision, localFingerprint: saved.preview.localFingerprint });
      });
    }

    for (const kind of KINDS) inputs[kind].addEventListener('change', () => toggle(kind, inputs[kind].checked));
    function setExpanded(expanded) {
      disclosureGeneration += 1;
      if (expanded) void refresh();
      else { closeHelp(); closeDecision(); }
    }
    el('Retry').addEventListener('click', refresh);
    el('DialogRetry').addEventListener('click', () => {
      const kind = decision?.kind;
      closeDecision();
      return kind ? toggle(kind, true) : refresh();
    });
    el('Confirm').addEventListener('click', () => confirm());
    el('UseServer').addEventListener('click', () => confirm('server'));
    el('Publish').addEventListener('click', () => confirm('local'));
    el('Cancel').addEventListener('click', () => { if (!busy) closeDecision(); });
    el('Dialog').addEventListener('cancel', event => { event.preventDefault(); if (!busy) closeDecision(); });
    el('CleanupRetry').addEventListener('click', () => run(async () => {
      const result = await bridge.retrySyncContentCleanup();
      applyStatus(result.status);
      message = result.ok ? '' : errorKey(result.error || 'cleanup_pending');
    }));
    el('HostPermission').addEventListener('change', () => {
      const enabled = el('HostPermission').checked;
      render();
      return run(async () => {
        await saveSettings({ hubSyncSessionTitles: enabled });
        settings = getSettings() || {};
        await refresh();
      });
    });
    const unsubscribe = bridge.onSyncContentPush?.(next => {
      pushRevision += 1;
      message = '';
      applyStatus(next);
    });

    function syncSettings() {
      settings = getSettings() || {};
      const next = JSON.stringify([settings.hubMode, settings.hubUrl, settings.secret, settings.hubHostPort, settings.hubHostSecret, settings.deviceId]);
      if (next !== connection) {
        closeHelp();
        connection = next;
        generation += 1;
        request = null;
        status = null;
        if (decision) { closeDecision(); message = 'hub_changed'; }
        if (!el('Details').classList.contains('hidden')) void refresh();
      }
      render();
    }
    syncSettings();
    return {
      refresh, syncSettings, setExpanded, closeHelp, status: () => status, base: () => snapshotBase(status),
      decoratePatch: (patch, base) => decorateSettingsPatch(patch, status, base),
      reportSettingsError: error => { if (isConflictError(error)) { message = 'conflict'; render(); } },
      dispose: () => { generation += 1; unsubscribe?.(); help.dispose(); closeDecision(); }
    };
  }
  return { createSyncContentForm, snapshotBase, decorateSettingsPatch, isConflictError };
});
