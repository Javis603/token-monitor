'use strict';

const path = require('node:path');
const { createProjectsResolver } = require('../codebuddy/sessionMetadata');

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

module.exports = {
  resolveSessionMetadata: createProjectsResolver(projectsRoots)
};
