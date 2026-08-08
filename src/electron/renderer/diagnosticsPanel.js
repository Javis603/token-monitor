'use strict';

(function exposeDiagnosticsPanel(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorDiagnosticsPanel = api;
})(typeof window !== 'undefined' ? window : null, function createDiagnosticsPanelApi(root) {
  const ELEMENT_IDS = {
    toggle: 'diagnosticToggleButton',
    details: 'diagnosticDetails',
    generate: 'generateDiagnosticButton',
    copy: 'copyDiagnosticButton',
    previewButton: 'previewDiagnosticButton',
    status: 'diagnosticStatus',
    preview: 'diagnosticPreview',
    reportText: 'diagnosticReportText',
    regenerate: 'regenerateDiagnosticButton'
  };

  function defaultElements(documentRoot) {
    return Object.fromEntries(Object.entries(ELEMENT_IDS).map(([key, id]) => [key, documentRoot?.getElementById?.(id) || null]));
  }

  function createDiagnosticsPanel(options = {}) {
    const elements = options.elements || defaultElements(options.root || (typeof document !== 'undefined' ? document : null));
    const api = options.api || root?.tokenMonitor;
    const translate = typeof options.translate === 'function' ? options.translate : (key) => key;
    const getLocale = typeof options.getLocale === 'function' ? options.getLocale : () => 'en';
    const state = {
      busy: false,
      detailsOpen: false,
      text: '',
      generatedAt: '',
      previewOpen: false,
      statusKey: '',
      statusTone: ''
    };
    let bound = false;

    function generatedTime() {
      if (!state.generatedAt) return '';
      try {
        return new Date(state.generatedAt).toLocaleTimeString(getLocale(), {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
      } catch (_) {
        return state.generatedAt;
      }
    }

    function statusText() {
      if (!state.statusKey) return '';
      if (state.statusKey === 'settings.about.diagnostics.generated') {
        return translate(state.statusKey, { time: generatedTime() });
      }
      return translate(state.statusKey);
    }

    function render() {
      const { toggle, details, generate, copy, previewButton, status, preview, reportText, regenerate } = elements;
      const hasReport = Boolean(state.text);
      if (!toggle && !details && !generate && !copy && !previewButton && !preview) return state;
      if (toggle) {
        toggle.disabled = state.busy;
        toggle.setAttribute('aria-expanded', String(state.detailsOpen));
      }
      if (details) {
        const hidden = !state.detailsOpen;
        details.classList?.toggle('hidden', hidden);
        details.inert = hidden;
        details.setAttribute('aria-hidden', String(hidden));
      }
      if (generate) {
        generate.hidden = hasReport;
        generate.classList?.toggle('hidden', hasReport);
        generate.disabled = state.busy;
        generate.textContent = state.busy
          ? translate('settings.about.diagnostics.generating')
          : translate('settings.about.diagnostics.generate');
      }
      if (copy) {
        copy.hidden = !hasReport;
        copy.classList?.toggle('hidden', !hasReport);
        copy.disabled = state.busy;
        copy.textContent = translate('settings.about.diagnostics.copy');
      }
      if (previewButton) {
        previewButton.hidden = !hasReport;
        previewButton.classList?.toggle('hidden', !hasReport);
        previewButton.disabled = state.busy;
        previewButton.textContent = state.previewOpen
          ? translate('settings.about.diagnostics.hidePreview')
          : translate('settings.about.diagnostics.preview');
        previewButton.setAttribute('aria-expanded', String(state.previewOpen));
      }
      if (regenerate) {
        regenerate.hidden = !hasReport;
        regenerate.classList?.toggle('hidden', !hasReport);
        regenerate.disabled = state.busy;
      }
      if (status) {
        status.textContent = statusText();
        status.className = `diagnostic-status${state.statusTone ? ` ${state.statusTone}` : ''}`;
      }
      if (reportText) reportText.textContent = state.text;
      if (preview) {
        const hidden = !state.previewOpen || !hasReport;
        preview.classList?.toggle('hidden', hidden);
        preview.hidden = hidden;
        preview.inert = hidden;
        preview.setAttribute('aria-hidden', String(hidden));
      }
      return state;
    }

    function toggleDetails() {
      if (state.busy) return;
      state.detailsOpen = !state.detailsOpen;
      if (!state.detailsOpen) state.previewOpen = false;
      render();
    }

    async function requestReport() {
      if (typeof api?.generateDiagnosticReport !== 'function') throw new Error('unsupported');
      const result = await api.generateDiagnosticReport();
      if (!result?.text) throw new Error('empty');
      return result;
    }

    async function ensureReport({ force = false, openPreview = false } = {}) {
      if (state.busy) return null;
      if (!force && state.text) {
        state.detailsOpen = true;
        if (openPreview) state.previewOpen = true;
        render();
        return state.text;
      }
      state.detailsOpen = true;
      state.busy = true;
      state.statusKey = 'settings.about.diagnostics.generating';
      state.statusTone = '';
      render();
      try {
        const result = await requestReport();
        state.text = String(result.text);
        state.generatedAt = String(result.generatedAt || '');
        state.previewOpen = openPreview;
        state.statusKey = 'settings.about.diagnostics.generated';
        state.statusTone = 'success';
        return state.text;
      } catch (_) {
        state.statusKey = 'settings.about.diagnostics.error';
        state.statusTone = 'error';
        return null;
      } finally {
        state.busy = false;
        render();
      }
    }

    async function copyReport() {
      if (!state.text || state.busy) return false;
      try {
        if (typeof options.copyText === 'function') await options.copyText(state.text);
        else if (typeof api?.copyText === 'function') await api.copyText(state.text);
        else await navigator.clipboard.writeText(state.text);
        state.statusKey = 'settings.about.diagnostics.copied';
        state.statusTone = 'success';
        render();
        return true;
      } catch (_) {
        state.statusKey = 'settings.about.diagnostics.copyError';
        state.statusTone = 'error';
        render();
        return false;
      }
    }

    function togglePreview() {
      if (!state.text || state.busy) return;
      state.previewOpen = !state.previewOpen;
      render();
    }

    function bind() {
      if (bound) return;
      bound = true;
      elements.toggle?.addEventListener('click', toggleDetails);
      elements.generate?.addEventListener('click', () => { void ensureReport({ openPreview: true }); });
      elements.copy?.addEventListener('click', () => { void copyReport(); });
      elements.previewButton?.addEventListener('click', togglePreview);
      elements.regenerate?.addEventListener('click', () => { void ensureReport({ force: true, openPreview: true }); });
    }

    bind();
    return {
      bind,
      render,
      generate: () => ensureReport({ openPreview: true }),
      regenerate: () => ensureReport({ force: true, openPreview: true }),
      copy: copyReport,
      toggleDetails,
      togglePreview,
      getState: () => ({ ...state })
    };
  }

  return { createDiagnosticsPanel };
});
