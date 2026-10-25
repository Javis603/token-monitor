'use strict';

// Shared by both retention lanes. Selection changes projection, never the
// stored observations, so disabling the policy can restore archived usage.
function claudeArchivePolicy(summary) {
  const excluded = new Set((summary.excludedSessionKeys || []).map(key => key.toLowerCase()));
  const recovering = summary.claudeMirrorArchiveRecovery === true;
  return (key, session, client = session.client) => client === 'claude' && (
    recovering || (excluded.size > 0 && (excluded.has(key.toLowerCase())
      || ((session.parentClient || client) === 'claude'
        && excluded.has(`claude:${String(session.parentSessionId || '').toLowerCase()}`))))
  );
}

module.exports = { claudeArchivePolicy };
