'use strict';

const path = require('node:path');
const { createProjectsResolver } = require('../codebuddy/sessionMetadata');
const { shouldReadSessionContext } = require('../../sessionContext');
const { readWorkbuddySessionUsage } = require('./sessionContext');

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

// Occupancy rides on the same recency rule as the Codex reader: it is a current
// fact, and reading it for every historical session would add a database open
// per session per tick for a value nobody can see. `fileSessionMetadata` has
// to run first, because the timestamp it stamps is what decides the question.
function resolveSessionMetadata(sessionIds, context) {
  const result = resolveBaseMetadata(sessionIds, context);
  const wanted = [];
  for (const [sessionId, meta] of result) {
    if (shouldReadSessionContext(meta.lastUsedAt, context.now)) wanted.push(sessionId);
  }
  if (wanted.length === 0) return result;
  const usage = readWorkbuddySessionUsage(wanted, context);
  for (const sessionId of wanted) {
    const meta = result.get(sessionId);
    const sessionContext = usage.rows.get(sessionId);
    if (sessionContext) {
      result.set(sessionId, { ...meta, ...sessionContext });
    } else if (usage.misses.has(sessionId)) {
      // A definite miss means this session has no usable pair; clearing it
      // stops the previous tick's badge from outliving the session that owned
      // it. A transient read failure leaves the reading alone.
      result.set(sessionId, { ...meta, contextTokens: 0, contextWindow: 0 });
    }
  }
  return result;
}

module.exports = {
  resolveSessionMetadata
};
