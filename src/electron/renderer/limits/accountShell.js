'use strict';

// Common presentation for hand-built account panels. Login, discovery and
// profile mutations remain with their providers; only the panel chrome lives here.
(function exposeAccountShell(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorAccountShell = api;
})(typeof window !== 'undefined' ? window : null, function createAccountShellApi() {
  function render({ status, statusText, error, errorText = '', progress, progressText = '' }) {
    if (status && statusText !== undefined) {
      if (status.textContent !== statusText) status.textContent = statusText;
      status.title = statusText;
    }
    if (error) {
      if (error.textContent !== errorText) error.textContent = errorText;
      error.classList.toggle('hidden', !errorText);
    }
    if (progress) {
      if (progress.textContent !== progressText) progress.textContent = progressText;
      progress.classList.toggle('hidden', !progressText);
    }
  }

  function setExpanded({ toggle, details, group, expanded, onChange }) {
    if (!toggle || !details) return;
    const open = Boolean(expanded);
    toggle.setAttribute('aria-expanded', String(open));
    details.classList.toggle('hidden', !open);
    group?.classList.toggle('expanded', open);
    onChange?.(open);
  }

  function createBusyGuard() {
    const pending = new Set();
    return {
      async run(id, button, action) {
        if (pending.has(id)) return;
        pending.add(id);
        if (button) button.disabled = true;
        try {
          return await action();
        } finally {
          pending.delete(id);
          if (button) button.disabled = false;
        }
      }
    };
  }

  // Only the newest response may replace a profile list. Separate keys keep a
  // slow request for one provider from retiring another provider's response.
  function createRequestGuard() {
    const revisions = new Map();
    return {
      begin(id) {
        const revision = (revisions.get(id) || 0) + 1;
        revisions.set(id, revision);
        return () => revisions.get(id) === revision;
      },
      retire(id) { revisions.set(id, (revisions.get(id) || 0) + 1); }
    };
  }

  return { render, setExpanded, createBusyGuard, createRequestGuard };
});
