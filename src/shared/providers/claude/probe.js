'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { sharedDataDir } = require('../../config');
const execFileAsync = promisify(execFile);

// Parent layouts may be shared or redirected. Load trusted user settings only:
// a project found above the private cwd must not supply startup configuration.
const CLAUDE_PROBE_ARGS = Object.freeze([
  '--allowed-tools', '',
  '--setting-sources', 'user',
  '--settings', '{"disableAllHooks":true,"disableDeepLinkRegistration":"disable"}',
  '--strict-mcp-config'
]);

function claudeProbeDir(deps = {}) {
  if ((deps.platform || process.platform) === 'win32') {
    // os.userInfo reads the OS profile, unlike environment-controlled homedir
    // or app-data overrides. This path relies on the normal profile's ACLs.
    try {
      const home = os.userInfo().homedir;
      if (!home || !path.isAbsolute(home) || /^[\\/]{2}/.test(home)) return null;
      return path.join(home, 'AppData', 'Local', 'Token Monitor', 'claude-probe');
    } catch (_) { return null; } // No shared/temp fallback when the profile is unavailable.
  }
  return deps.claudeProbeDir || path.join(sharedDataDir(deps), 'claude-probe');
}

function unsafeProbeDir(cause) {
  const error = new Error('Claude probe directory is unavailable or unsafe', { cause });
  error.status = 'unavailable';
  Object.defineProperty(error, 'code', { value: 'CLAUDE_UNSAFE_PROBE_DIR' });
  return error;
}

function macAlias(dir) {
  if (process.platform !== 'darwin') return dir;
  return dir.replace(/^\/(var|tmp)(?=\/|$)/, '/private/$1');
}

function hasPrivatePosixPermissions(stat) {
  // Inherited setgid does not grant group/other access; compare rwx bits only.
  return Number(stat.uid) === process.getuid() && (Number(stat.mode) & 0o777) === 0o700;
}

async function prepareClaudeProbeDir(deps = {}) {
  try {
    const selected = claudeProbeDir(deps);
    if (!selected) throw unsafeProbeDir();
    const requested = path.resolve(selected);
    const parent = path.dirname(requested);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const dir = path.join(fs.realpathSync(parent), path.basename(requested));
    let stat;
    try { stat = fs.lstatSync(dir, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stat) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(dir, { bigint: true });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafeProbeDir();
    if (process.platform !== 'win32') {
      if (!hasPrivatePosixPermissions(stat)) throw unsafeProbeDir();
      if (process.platform === 'darwin') {
        // A leaf ACL can grant access despite 0700; no ancestor ACL walk is needed.
        const { stdout } = await execFileAsync('/bin/ls', ['-lde', dir], { encoding: 'utf8', timeout: 3000 });
        if (stdout.split('\n').some((line) => /^\s*\d+: .* allow /.test(line))) throw unsafeProbeDir();
      }
    }
    // Return the inspected leaf identity. The POSIX PTY reopens without
    // following links and compares it before accepting workspace trust.
    return { dir, identity: { dev: String(stat.dev), ino: String(stat.ino) } };
  } catch (error) { throw unsafeProbeDir(error); }
}

function canonicalPath(dir) {
  try { return fs.realpathSync(dir); }
  catch (_) { return macAlias(path.resolve(dir)); }
}

function isClaudeProbeCwd(cwd, probeDir = claudeProbeDir()) {
  if (typeof cwd !== 'string' || !cwd) return false;
  // The legacy shared name may now be a hostile link to a real project.
  const legacy = path.join(os.tmpdir(), 'token-monitor-claude-probe');
  const lexicalCwd = macAlias(path.resolve(cwd));
  if (lexicalCwd === macAlias(path.resolve(legacy))) return true;
  if (typeof probeDir !== 'string' || !probeDir) return false;
  const requested = path.resolve(probeDir);
  try {
    const stat = fs.lstatSync(requested);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (process.platform !== 'win32' && !hasPrivatePosixPermissions(stat)) return false;
    // Resolve parent aliases, never a replacement leaf's target: even a link
    // swapped in after lstat must not turn an unrelated project into the probe.
    const current = path.join(canonicalPath(path.dirname(requested)), path.basename(requested));
    return path.relative(current, canonicalPath(cwd)) === '';
  } catch (error) {
    return error.code === 'ENOENT' && lexicalCwd === macAlias(requested);
  }
}

module.exports = { CLAUDE_PROBE_ARGS, claudeProbeDir, prepareClaudeProbeDir, isClaudeProbeCwd };
