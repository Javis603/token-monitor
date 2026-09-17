'use strict';

(function exposeCodexAccountControl(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCodexAccountControl = api;
})(typeof window !== 'undefined' ? window : null, function createCodexAccountControlApi() {
  // The Limits view and Edge Dock both expose the same Codex account action.
  // Keep its DOM, hover lifetime, global in-flight lock and failure state here;
  // each surface only supplies the switch transport and its post-switch update.
  function createCodexAccountControl(options = {}) {
    const documentRef = options.document;
    const translate = typeof options.translate === 'function' ? options.translate : (key) => key;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const requestFrame = typeof options.requestAnimationFrame === 'function'
      ? options.requestAnimationFrame
      : (callback) => callback();
    const controlState = {
      switchingAccountId: '',
      errorAccountId: '',
      error: '',
      popoverHasOpened: false,
      popoverActive: false,
      renderPending: false
    };
    const hoverSelector = [
      '.limit-account-switch-zone:hover',
      '.limit-account-switch-zone:focus-within',
      '.limit-account-active-zone:hover',
      '.limit-account-active-zone:focus-within'
    ].join(', ');

    function flushPendingRender() {
      if (!controlState.renderPending) return;
      controlState.renderPending = false;
      requestRender();
    }

    function releasePopover(zone) {
      requestFrame(() => {
        if (zone.matches(':hover, :focus-within')) return;
        controlState.popoverActive = false;
        flushPendingRender();
      });
    }

    function wirePopoverLifetime(zone, options = {}) {
      const markOpened = () => {
        controlState.popoverActive = true;
        if (options.rememberOpened !== false) {
          controlState.popoverHasOpened = true;
          zone.classList.add('has-opened');
        }
      };
      const release = () => releasePopover(zone);
      zone.addEventListener('pointerenter', markOpened);
      zone.addEventListener('focusin', markOpened);
      zone.addEventListener('pointerleave', release);
      zone.addEventListener('focusout', release);
    }

    function activeControl(titleNode) {
      const zone = documentRef.createElement('span');
      const badge = documentRef.createElement('span');
      const popover = documentRef.createElement('span');
      const hint = translate('limits.codex.activeAccountHint');
      zone.className = 'limit-account-active-zone';
      zone.tabIndex = 0;
      zone.setAttribute('aria-label', hint);
      badge.className = 'limit-live-badge';
      badge.textContent = '\u2713';
      popover.className = 'limit-account-active-popover';
      popover.textContent = hint;
      wirePopoverLifetime(zone, { rememberOpened: false });
      zone.append(titleNode, badge, popover);
      return zone;
    }

    function failureMessage(resultOrError) {
      return resultOrError?.error || resultOrError?.message || translate('limits.codex.switchFailed');
    }

    async function runSwitch(event, switchAccount) {
      event?.stopPropagation?.();
      if (controlState.switchingAccountId) return;
      const accountId = String(switchAccount?.id || '').trim();
      if (!accountId) return;
      controlState.switchingAccountId = accountId;
      controlState.errorAccountId = '';
      controlState.error = '';
      controlState.popoverActive = false;
      requestRender();

      let result;
      try {
        result = await options.switchAccount(accountId);
      } catch (error) {
        result = { ok: false, error: failureMessage(error) };
      }

      if (!result?.ok) {
        const message = failureMessage(result);
        controlState.errorAccountId = accountId;
        controlState.error = message;
        options.onSwitchFailure?.(message, accountId);
      } else {
        try {
          await options.onSwitchSuccess?.(result, accountId);
        } catch (error) {
          options.onPostSwitchError?.(error, accountId);
        }
      }
      controlState.switchingAccountId = '';
      requestRender();
    }

    function switchControl(titleNode, switchAccount, accountLabel) {
      const accountId = String(switchAccount?.id || '').trim();
      if (!accountId || typeof options.switchAccount !== 'function') return titleNode;
      const zone = documentRef.createElement('span');
      const popover = documentRef.createElement('span');
      const button = documentRef.createElement('button');
      const switching = controlState.switchingAccountId === accountId;
      const failed = controlState.errorAccountId === accountId && controlState.error;
      zone.className = 'limit-account-switch-zone';
      zone.classList.toggle('has-opened', controlState.popoverHasOpened);
      zone.classList.toggle('is-switching', switching);
      zone.classList.toggle('is-error', Boolean(failed));
      popover.className = 'limit-account-switch-popover';
      button.type = 'button';
      button.className = 'limit-account-switch-button';
      button.disabled = Boolean(controlState.switchingAccountId);
      button.title = failed || translate('limits.codex.switchAccountTitle', {
        account: accountLabel || translate('settings.codex.unnamedAccount')
      });
      button.setAttribute('aria-label', button.title);
      button.textContent = switching
        ? translate('limits.codex.switching')
        : failed
          ? translate('limits.codex.switchFailedShort')
          : translate('limits.codex.switchAccount');
      wirePopoverLifetime(zone);
      button.addEventListener('click', (event) => runSwitch(event, switchAccount));
      popover.append(button);
      zone.append(titleNode, popover);
      return zone;
    }

    function render({ titleNode, active = false, switchAccount = null, accountLabel = '' } = {}) {
      if (!titleNode) return null;
      if (active) return activeControl(titleNode);
      return switchControl(titleNode, switchAccount, accountLabel);
    }

    function deferRender(container) {
      if (!controlState.popoverActive || !container?.querySelector) return false;
      if (!container.querySelector(hoverSelector)) {
        controlState.popoverActive = false;
        return false;
      }
      controlState.renderPending = true;
      return true;
    }

    function stateSignature() {
      return [
        controlState.switchingAccountId,
        controlState.errorAccountId,
        controlState.error
      ];
    }

    return { deferRender, render, stateSignature };
  }

  return { createCodexAccountControl };
});
