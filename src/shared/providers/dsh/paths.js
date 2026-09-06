'use strict';

// DeepSeek Harness (DSH) resolves its home directory from `DSH_HOME`, falling
// back to `~/.dsh`, and stores one zstd-compressed JSONL transcript per session
// under `<dshHome>/sessions/<encoded-cwd>/<session-id>/session.jsonl.zstd`.
// This mirrors tokscale's `PathRoot::EnvVar` resolution in clients.rs, so a
// relocated DSH home is picked up the same way tokscale reads it.
//
// Keep this module free of Node built-ins so it can be vendored into the Worker
// shared closure without making the Worker filesystem-aware.
const DSH_CLIENT = 'dsh';
const DSH_SOURCE_CHECK_ID = 'dsh-sessions';

function nonEmpty(value) {
  const text = String(value ?? '').trim();
  return text || '';
}

function joinPath(platform, root, ...parts) {
  const separator = platform === 'win32' ? '\\' : '/';
  let current = nonEmpty(root);
  for (const part of parts) {
    const next = nonEmpty(part);
    if (!next) continue;
    current = current
      ? `${current.replace(/[\\/]+$/, '')}${separator}${next.replace(/^[\\/]+/, '')}`
      : next;
  }
  return current;
}

function homeDirFor({ env = {}, homeDir = '', platform = '' } = {}) {
  const configured = nonEmpty(homeDir);
  if (configured) return configured;
  if (platform === 'win32') {
    return nonEmpty(env.USERPROFILE)
      || nonEmpty(env.HOME)
      || joinPath(platform, env.HOMEDRIVE, env.HOMEPATH);
  }
  return nonEmpty(env.HOME);
}

function resolveDshHome(options = {}) {
  const env = options.env || {};
  const configured = nonEmpty(env.DSH_HOME);
  if (configured) return configured;
  return joinPath(options.platform || '', homeDirFor(options), '.dsh');
}

function resolveDshSessionsDir(options = {}) {
  return joinPath(options.platform || '', resolveDshHome(options), 'sessions');
}

module.exports = {
  DSH_CLIENT,
  DSH_SOURCE_CHECK_ID,
  resolveDshHome,
  resolveDshSessionsDir
};
