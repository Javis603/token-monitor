'use strict';

const os = require('node:os');
const path = require('node:path');
const { findTimestampedSessionFiles, isSafeSessionId } = require('../../sessionFiles');
const { resolveOmpSessionsDir } = require('./paths');
const { findOmpSubagentSessionFiles, readOmpSessionHeader } = require('./subagents');

// Timestamped transcripts carry their id in the file name; task-named ones
// (`/tan`, subagents) only in their header, so look those up by walking.
function findOmpSessionFiles(root, sessionIds) {
  const files = findTimestampedSessionFiles(root, sessionIds);
  const unnamed = [...sessionIds].filter(id => !files.has(id));
  for (const [id, file] of findOmpSubagentSessionFiles(root, unnamed)) files.set(id, file);
  return files;
}

// An OMP fork can disappear from a complete usage report when every response
// was already counted in its parent. Only resolve local OMP identities here;
// absence by itself says nothing about deleted or untracked Pi history.
function resolveOmpForkParents(sessionIds, liveSessions, options = {}) {
  const root = resolveOmpSessionsDir({ homeDir: options.homeDir || os.homedir() });
  const files = findOmpSessionFiles(root, sessionIds);
  const headers = new Map();
  const parentIds = new Set();
  for (const [id, file] of files) {
    const header = readOmpSessionHeader(file);
    if (header?.id !== id || typeof header.parentSession !== 'string') continue;
    headers.set(id, header);
    if (isSafeSessionId(header.parentSession) && liveSessions[`omp:${header.parentSession}`]) {
      parentIds.add(header.parentSession);
    }
  }
  const parentFiles = findOmpSessionFiles(root, parentIds);
  const parents = new Map();
  for (const [id, header] of headers) {
    // OMP versions write either the parent's id or its transcript path. A path
    // must stay under the scanner's root; never follow arbitrary archive input.
    const parentFile = parentFiles.get(header.parentSession)
      || path.resolve(path.dirname(files.get(id)), header.parentSession);
    const relative = path.relative(root, parentFile);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) continue;
    const parent = readOmpSessionHeader(parentFile);
    if (parent?.id && parent.id !== id && liveSessions[`omp:${parent.id}`]) parents.set(id, `omp:${parent.id}`);
  }
  return parents;
}

module.exports = { resolveOmpForkParents };
