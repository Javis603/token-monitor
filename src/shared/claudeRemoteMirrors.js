'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { sharedDataDir, writeJsonAtomic } = require('./config');
const { claudeSessionRoots } = require('./providers/claude/paths');

const MIRROR_NAME = /^ssh-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function claudeRemoteMirrorRoot(options = {}) {
  return path.resolve(claudeSessionRoots({ homeDir: options.homeDir || os.homedir(), env: options.env }).projects);
}

// This is an explicit SSH-mirror policy, not automatic proof of WSL ownership.
// Keep selections after a mirror disappears, since Tokscale and the session
// archive retain observed usage. No transcript content is stored here.
function claudeRemoteMirrors(options = {}) {
  if (options.claudeRemoteMirrorsExcluded !== true) return { sessionKeys: [] };
  const root = claudeRemoteMirrorRoot(options);
  const file = options.mirrorStatePath || path.join(sharedDataDir(), 'claude-remote-mirrors.json');
  let state = { roots: {} };
  let bytes;
  try {
    bytes = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let corrupt = false;
  if (bytes !== undefined) {
    try {
      state = JSON.parse(bytes);
      if (!state?.roots || typeof state.roots !== 'object' || Array.isArray(state.roots)
        || Object.values(state.roots).some(names => !Array.isArray(names)
          || names.some(name => typeof name !== 'string' || !MIRROR_NAME.test(name)))
        || (state.recoveryRequired !== undefined && typeof state.recoveryRequired !== 'boolean')) {
        throw new SyntaxError('invalid mirror selection state');
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      corrupt = true;
      // Lost names cannot be reconstructed after a mirror was deleted. Keep
      // live scans running, but do not replay unclassified Claude archive rows.
      state = { roots: {}, recoveryRequired: true };
    }
  }
  const previous = Array.isArray(state.roots[root]) ? state.roots[root].filter(name => MIRROR_NAME.test(name)) : [];
  const names = new Set(previous);
  try {
    for (const name of fs.readdirSync(root)) if (MIRROR_NAME.test(name)) names.add(name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Source ownership must survive one-shot collectors too. Anchor snapshots
  // are only a scan optimization and have a separate persistence lifecycle.
  if ((corrupt || names.size !== previous.length) && options.mirrorStatePersistenceEnabled !== false) {
    // Copy before replacement: a crash between these operations leaves the
    // corrupt original detectable, never a missing file mistaken for new state.
    if (corrupt) fs.writeFileSync(`${file}.${randomUUID()}.corrupt`, bytes, { flag: 'wx', mode: 0o600 });
    state.roots[root] = [...names].sort();
    writeJsonAtomic(file, state);
  }
  return {
    root,
    ...(state.recoveryRequired ? { recoveryRequired: true } : {}),
    sessionKeys: [...names].sort().map(name => `claude:${name.slice(4).toLowerCase()}`)
  };
}

module.exports = { claudeRemoteMirrors, claudeRemoteMirrorRoot };
