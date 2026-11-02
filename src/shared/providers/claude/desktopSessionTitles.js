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
  } catch (error) {
    // A file deleted since it was listed is gone; any other failure is a torn
    // read of a file the app rewrites in place, which keeps the last good entry.
    return error?.code === 'ENOENT' ? undefined : previous;
  }
}

// Windows MSIX builds keep this store outside the app roots, under
// `%LOCALAPPDATA%\Claude-Data\claude_<publisher id>\` (seen on 4.4212.0.0).
// The caller passes the host's LocalAppData, or none for a scoped home.
function sessionRoots(homeDir, localAppData) {
  const msixData = path.join(localAppData || path.join(homeDir, 'AppData', 'Local'), 'Claude-Data');
  return [
    ...CLAUDE_DESKTOP_APP_ROOTS.map((appRoot) => path.join(homeDir, ...appRoot.split('/'))),
    ...childDirs(msixData).filter((dir) => path.basename(dir).startsWith('claude_'))
  ].map((dir) => path.join(dir, 'claude-code-sessions'));
}

function readDesktopSessionTitles(homeDir, sessionIds, localAppData) {
  const titles = new Map();
  for (const root of sessionRoots(homeDir, localAppData)) {
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
