'use strict';

const DISABLED_STATUS = Object.freeze({
  appInstalled: false,
  authenticated: false,
  status: 'disabled',
  checkedAt: null
});

function disabledStatus() {
  return { ...DISABLED_STATUS };
}

function createWorkbuddyLocalAccess({ auth, isEnabled } = {}) {
  if (!auth || typeof isEnabled !== 'function') {
    throw new TypeError('WorkBuddy local access requires an auth adapter and enablement predicate');
  }

  function enabled() {
    return isEnabled() === true;
  }

  function status() {
    return enabled() ? auth.status() : disabledStatus();
  }

  function getSessionInfo() {
    return enabled() ? auth.getSessionInfo() : {};
  }

  async function openApp() {
    if (!enabled()) throw new Error('WorkBuddy local app monitoring is not enabled');
    return auth.openApp();
  }

  return {
    enabled,
    getSessionInfo,
    openApp,
    status
  };
}

module.exports = {
  createWorkbuddyLocalAccess,
  disabledStatus
};
