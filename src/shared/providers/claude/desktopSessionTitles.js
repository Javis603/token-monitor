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
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sessionFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^local_.+\.json$/.test(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function readEntry(file, previous, onReadError) {
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
    // Missing files confirm removal; other failures cannot invalidate a saved
    // title, including after restart when no parsed entry is cached yet.
    if (error?.code === 'ENOENT') return undefined;
    onReadError();
    return previous;
  }
}

// Windows MSIX builds keep this store outside the app roots, under
// `%LOCALAPPDATA%\Claude-Data\claude_<publisher id>\` (seen on 4.4212.0.0).
// The caller passes the host's LocalAppData, or none for a scoped home.
function sessionRoots(homeDir, localAppData, onReadError) {
  const msixData = path.join(localAppData || path.join(homeDir, 'AppData', 'Local'), 'Claude-Data');
  let publishers;
  try { publishers = childDirs(msixData); } catch (_) { onReadError(); }
  const msixRoots = publishers
    ? publishers.filter(dir => path.basename(dir).startsWith('claude_')).map(dir => path.join(dir, 'claude-code-sessions'))
    : [...rootCache.keys()].filter(root => path.dirname(path.dirname(root)) === msixData);
  return [
    ...CLAUDE_DESKTOP_APP_ROOTS.map((appRoot) => path.join(homeDir, ...appRoot.split('/'), 'claude-code-sessions')),
    ...msixRoots
  ];
}

function readDesktopSessionTitles(homeDir, sessionIds, localAppData) {
  const titles = new Map();
  const removedSessionIds = new Set();
  let complete = true;
  let hasStore = false;
  const onReadError = () => { complete = false; };
  for (const root of sessionRoots(homeDir, localAppData, onReadError)) {
    const previous = rootCache.get(root) || new Map();
    let entries = previous;
    try {
      const accounts = childDirs(root);
      if (accounts) {
        hasStore = true;
        const next = new Map();
        for (const orgDir of accounts.flatMap(account => childDirs(account) || [])) {
          for (const file of sessionFiles(orgDir)) {
            const entry = readEntry(file, previous.get(file), onReadError);
            if (entry) next.set(file, entry);
          }
        }
        for (const [file, entry] of previous) {
          if (next.get(file)?.cliSessionId !== entry.cliSessionId) removedSessionIds.add(entry.cliSessionId);
        }
        entries = next;
        if (next.size) rootCache.set(root, next);
        else rootCache.delete(root);
      } else if (previous.size) {
        onReadError();
      }
    } catch (_) {
      // An incomplete directory walk keeps this root's last successful scan.
      onReadError();
    }
    for (const entry of entries.values()) {
      if (sessionIds.has(entry.cliSessionId)) titles.set(entry.cliSessionId, entry.title);
    }
  }
  // No accessible store is not evidence that a previously saved title is gone.
  // A successfully listed root can still confirm removal of a known file even
  // when an unrelated file is unreadable. Never revive those removed entries.
  const unavailableSessionIds = complete && hasStore ? new Set()
    : new Set([...sessionIds].filter(id => !removedSessionIds.has(id)));
  return { titles, unavailableSessionIds };
}

module.exports = { readDesktopSessionTitles };
