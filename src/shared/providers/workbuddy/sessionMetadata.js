'use strict';

const path = require('node:path');
const { createProjectsResolver } = require('../codebuddy/sessionMetadata');
const { shouldReadSessionContext } = require('../../sessionContext');
const { readWorkBuddySessionContexts } = require('./sessionContext');

// WorkBuddy writes the same transcript family as CodeBuddy Code — same record
// types, the same ai-title/custom-title/status fields, usage on the response's
// messageId — under its own projects roots. 5.5 moved the home from
// `~/.workbuddy` to `~/.workbuddy-ai` while tokscale still scans both, so both
// stay resolvable and the first hit wins.
//
// There is deliberately no extension-store fallback here: the CodeBuddy
// reader's fallback walks the VS Code extension's own Data tree, which is not
// where WorkBuddy keeps anything.
function projectsRoots({ home }) {
  return [
    path.join(home, '.workbuddy', 'projects'),
    path.join(home, '.workbuddy-ai', 'projects')
  ];
}

const resolveBaseMetadata = createProjectsResolver(projectsRoots);

function resolveSessionMetadata(sessionIds, context = {}) {
  const wanted = sessionIds instanceof Set ? sessionIds : new Set(sessionIds || []);
  const result = resolveBaseMetadata(wanted, context);
  const liveIds = [];
  for (const sessionId of wanted) {
    const meta = result.get(sessionId);
    const key = `workbuddy:${sessionId}`;
    const live = shouldReadSessionContext(meta?.lastUsedAt || meta?.startedAt, context.now)
      || Object.values(context.periods || {}).some((period) => (
        shouldReadSessionContext(period?.sessions?.[key]?.lastUsedAt || period?.sessions?.[key]?.startedAt, context.now)
      ));
    if (live) liveIds.push(sessionId);
  }
  if (!liveIds.length) return result;

  for (const [sessionId, sessionContext] of readWorkBuddySessionContexts(liveIds, { home: context.home, deps: context.deps })) {
    const existing = result.get(sessionId);
    result.set(sessionId, existing ? { ...existing, ...sessionContext } : sessionContext);
  }
  return result;
}

module.exports = {
  resolveSessionMetadata
};
