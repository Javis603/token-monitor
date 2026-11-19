'use strict';

// Common presentation for hand-built account panels. Login, discovery and
// profile mutations remain with their providers; only the panel chrome lives here.
(function exposeAccountShell(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorAccountShell = api;
})(typeof window !== 'undefined' ? window : null, function createAccountShellApi() {
  function render({ status, statusText, error, errorText = '', errorTone = 'error', progress, progressText = '' }) {
    if (status && statusText !== undefined) {
      if (status.textContent !== statusText) status.textContent = statusText;
      status.setAttribute('aria-label', statusText);
    }
    if (error) {
      if (error.textContent !== errorText) error.textContent = errorText;
      error.classList.toggle('hidden', !errorText);
      error.classList.toggle('error', errorTone !== 'warning');
      error.classList.toggle('warning', errorTone === 'warning');
    }
    if (progress) {
      if (progress.textContent !== progressText) progress.textContent = progressText;
      progress.classList.toggle('hidden', !progressText);
    }
  }

  function setDisclosureBody(toggle, details, open) {
    if (!open && details.contains(details.ownerDocument?.activeElement)) toggle?.focus({ preventScroll: true });
    details.inert = !open;
    details.classList.toggle('hidden', !open);
  }

  function setExpanded({ toggle, details, group, expanded, onChange }) {
    if (!toggle || !details) return;
    const open = Boolean(expanded);
    toggle.setAttribute('aria-expanded', String(open));
    setDisclosureBody(toggle, details, open);
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

  return { render, setDisclosureBody, setExpanded, createBusyGuard, createRequestGuard };
});
