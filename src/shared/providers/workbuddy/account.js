'use strict';

// WorkBuddy limits account wiring. Leaf module: no requires.
// The desktop widget auto-detects the WorkBuddy app's local sign-in state.
// These fields remain available to headless/CLI deployments but are never
// writable through settings:update and never cross to the renderer; the
// desktop-session lanes in limitsConfigFromSettings stay hand-written there.
module.exports = {
  id: 'workbuddy',
  fetch: 'fetchWorkbuddyLimits',
  fields: [
    { key: 'workbuddyAccessToken', kind: 'credential', persist: 'never', rendererOmit: true, initial: null, config: false },
    { key: 'workbuddyUserId', kind: 'setting', persist: 'never', rendererOmit: true, initial: null, config: false },
    { key: 'workbuddyEnterpriseId', kind: 'setting', persist: 'never', rendererOmit: true, initial: null, config: false },
    { key: 'workbuddyLocale', kind: 'setting', persist: 'never', rendererOmit: true, initial: null, config: false },
    { key: 'workbuddyDomain', kind: 'setting', persist: 'never', rendererOmit: true, initial: null, config: false },
    { key: 'workbuddyDepartmentInfo', kind: 'setting', persist: 'never', rendererOmit: true, initial: null, config: false }
  ],
  fetchDep: 'workbuddyFetch'
};
