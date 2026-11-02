'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CLAUDE_DESKTOP_APP_ROOTS } = require('../../clientSourceRegistration');

// Claude Desktop keeps each Code session's sidebar title in its own store,
// `claude-code-sessions/<account>/<org>/local_<id>.json`, linked to the CLI
// transcript by `cliSessionId`. Sessions spawned through Remote Control never
// get that title written back into the transcript as a `custom-title` record.
// Parsed entries are reused while a file's size and mtime are unchanged; each
// root's map is rebuilt per read, so removed sessions drop out.
const rootCache = new Map();

function childDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch (_) {
    return [];
  }
}

function sessionFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^local_.+\.json$/.test(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch (_) {
    return [];
  }
}

function readEntry(file, previous) {
  try {
    const stat = fs.statSync(file);
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) return previous;
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      cliSessionId: typeof session?.cliSessionId === 'string' ? session.cliSessionId : '',
      title: typeof session?.title === 'string' ? session.title : ''
    };
  } catch (_) {
    // The app rewrites these files in place; a torn read keeps the last good entry.
    return previous;
  }
}

function readDesktopSessionTitles(homeDir, sessionIds) {
  const titles = new Map();
  for (const appRoot of CLAUDE_DESKTOP_APP_ROOTS) {
    const root = path.join(homeDir, ...appRoot.split('/'), 'claude-code-sessions');
    const previous = rootCache.get(root) || new Map();
    const next = new Map();
    for (const orgDir of childDirs(root).flatMap(childDirs)) {
      for (const file of sessionFiles(orgDir)) {
        const entry = readEntry(file, previous.get(file));
        if (!entry) continue;
        next.set(file, entry);
        if (entry.title && sessionIds.has(entry.cliSessionId)) titles.set(entry.cliSessionId, entry.title);
      }
    }
    if (next.size) rootCache.set(root, next);
    else rootCache.delete(root);
  }
  return titles;
}

module.exports = { readDesktopSessionTitles };
