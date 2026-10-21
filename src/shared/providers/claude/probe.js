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
  return deps.claudeProbeDir || path.join(sharedDataDir(deps), 'claude-probe');
}

function unsafeProbeDir(cause) {
  const error = new Error('Claude probe directory is not private; it must be owned and not a link', { cause });
  error.status = 'unavailable';
  return error;
}

function macAlias(dir) {
  if (process.platform !== 'darwin') return dir;
  return dir.replace(/^\/(var|tmp)(?=\/|$)/, '/private/$1');
}

async function prepareWindowsDirectory(dir) {
  // POSIX modes cannot establish Windows privacy. Protect a new leaf's DACL;
  // inspect existing leaves without rewriting their ACL or deleting their data.
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
$target = $env:TOKEN_MONITOR_PRIVATE_PROBE_DIR
if (![IO.Directory]::Exists($target)) {
  $private = New-Object Security.AccessControl.DirectorySecurity
  $private.SetOwner($sid)
  $private.SetAccessRuleProtection($true, $false)
  foreach ($id in $trusted) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new($id), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $private.AddAccessRule($rule)
  }
  [IO.Directory]::CreateDirectory($target, $private) | Out-Null
}
$item = Get-Item -LiteralPath $target -Force
if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked probe directory' }
$acl = Get-Acl -LiteralPath $target
$raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
if ($null -eq $raw.DiscretionaryAcl -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unowned probe directory' }
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and !($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and $trusted -notcontains $rule.IdentityReference.Value) { throw 'Shared probe directory' }
}
`;
  // pwsh 7 -> Node -> Windows PowerShell bypasses pwsh's module-path cleanup.
  // Let 5.1 rebuild its own paths instead of autoloading incompatible PS7 modules.
  const env = { ...process.env, TOKEN_MONITOR_PRIVATE_PROBE_DIR: dir };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env, windowsHide: true, timeout: 10000
  });
}

async function prepareClaudeProbeDir(deps = {}) {
  try {
    const requested = path.resolve(claudeProbeDir(deps));
    const parent = path.dirname(requested);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const dir = path.join(fs.realpathSync(parent), path.basename(requested));
    let stat;
    try { stat = fs.lstatSync(dir, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && !stat.isDirectory()) throw unsafeProbeDir();
    if (process.platform === 'win32') {
      await prepareWindowsDirectory(dir);
      stat = fs.lstatSync(dir, { bigint: true });
    } else {
      if (!stat) {
        try { fs.mkdirSync(dir, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        stat = fs.lstatSync(dir, { bigint: true });
      }
      if (!stat.isDirectory() || Number(stat.uid) !== process.getuid()
        || Number(stat.mode & 0o777n) !== 0o700) throw unsafeProbeDir();
      if (process.platform === 'darwin') {
        // A leaf ACL can grant access despite 0700; no ancestor ACL walk is needed.
        const { stdout } = await execFileAsync('/bin/ls', ['-lde', dir], { encoding: 'utf8', timeout: 3000 });
        if (stdout.split('\n').some((line) => /^\s*\d+: .* allow /.test(line))) throw unsafeProbeDir();
      }
    }
    // Capture identity with the privacy check, before any subsequent await or
    // caller stat. The PTY reopens without following links and compares it.
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
  return macAlias(path.resolve(cwd)) === macAlias(path.resolve(legacy))
    || canonicalPath(cwd) === canonicalPath(probeDir);
}

module.exports = { CLAUDE_PROBE_ARGS, claudeProbeDir, prepareClaudeProbeDir, isClaudeProbeCwd };
