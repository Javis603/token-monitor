'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { findSessionFiles, isSafeSessionId, resolveSessionFile } = require('../../src/shared/sessionFiles');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-home-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

test('resolves a claude session file by walking projects', () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.claude', 'projects', '-some-project');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'abc-123.jsonl');
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('claude', 'abc-123', home), file);
  } finally { cleanup(home); }
});

test('resolves a claude session file from the alternate transcripts root', () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.claude', 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'alternate-123.jsonl');
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('claude', 'alternate-123', home), file);
  } finally { cleanup(home); }
});

test('resolves Claude sessions from CLAUDE_CONFIG_DIR', () => {
  const home = tmpHome();
  const configDir = path.join(home, 'relocated-claude');
  try {
    const dir = path.join(configDir, 'projects', '-some-project');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'configured-123.jsonl');
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('claude', 'configured-123', home, {
      env: { CLAUDE_CONFIG_DIR: configDir }
    }), file);
  } finally { cleanup(home); }
});

test('an explicit scoped home ignores the host CLAUDE_CONFIG_DIR', () => {
  const home = tmpHome();
  const hostConfigDir = path.join(home, 'host-claude');
  try {
    const dir = path.join(home, '.claude', 'projects', '-scoped-home');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'scoped-123.jsonl');
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('claude', 'scoped-123', home, {
      env: { CLAUDE_CONFIG_DIR: hostConfigDir },
      useEnvRoots: false
    }), file);
  } finally { cleanup(home); }
});

test('resolves a codex rollout via the dated path', () => {
  const home = tmpHome();
  try {
    const id = 'rollout-2026-05-30T11-44-50-019e76fc-0d58';
    const dir = path.join(home, '.codex', 'sessions', '2026', '05', '30');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('codex', id, home), file);
  } finally { cleanup(home); }
});

test('resolves a codex session via the walk fallback when the id is not a dated rollout', () => {
  const home = tmpHome();
  try {
    const id = 'legacy-session-xyz';
    const dir = path.join(home, '.codex', 'sessions', 'archive');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('codex', id, home), file);
  } finally { cleanup(home); }
});

test('resolves Codex sessions from CODEX_HOME and ignores it for a scoped home', () => {
  const home = tmpHome();
  const configured = path.join(home, 'configured-codex');
  try {
    const id = 'custom-codex-session';
    const dir = path.join(configured, 'sessions', '2026', '09', '10');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, '{}\n');

    assert.equal(resolveSessionFile('codex', id, home, {
      env: { CODEX_HOME: configured },
      useEnvRoots: true
    }), file);
    assert.equal(resolveSessionFile('codex', id, home, {
      env: { CODEX_HOME: configured },
      useEnvRoots: false
    }), '');
  } finally { cleanup(home); }
});

test('resolves a codebuddy session by walking the projects tree', () => {
  // CodeBuddy stores one transcript per session in a directory named after the
  // working directory it ran in, so the id alone does not say where it lives.
  const home = tmpHome();
  try {
    const dir = path.join(home, '.codebuddy', 'projects', 'd-some-project');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '01a07fd0-dc59-7af6-afa5-ef402c7a91ff.jsonl');
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('codebuddy', '01a07fd0-dc59-7af6-afa5-ef402c7a91ff', home), file);
  } finally { cleanup(home); }
});

test('ignores CODEBUDDY_CONFIG_DIR, which the scan does not read either', () => {
  // The CLI itself honours the variable, but tokscale declares no override for
  // this client. Following the client instead of the scan would let the readers
  // answer for sessions nothing reported, so the scoped home stays
  // authoritative and a relocated config directory resolves to nothing.
  const home = tmpHome();
  const configured = path.join(home, 'relocated-codebuddy');
  try {
    const dir = path.join(configured, 'projects', 'd-some-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'relocated-1.jsonl'), '{}\n');
    assert.equal(resolveSessionFile('codebuddy', 'relocated-1', home, {
      env: { CODEBUDDY_CONFIG_DIR: configured },
      useEnvRoots: true
    }), '');
  } finally { cleanup(home); }
});

test('returns empty string when not found or unknown client', () => {
  const home = tmpHome();
  try {
    assert.equal(resolveSessionFile('claude', 'missing', home), '');
    assert.equal(resolveSessionFile('codebuddy', 'missing', home), '');
    assert.equal(resolveSessionFile('hermes', 'whatever', home), '');
  } finally { cleanup(home); }
});

test('isSafeSessionId allows a single segment and rejects empty or parent refs', () => {
  assert.equal(isSafeSessionId('abc-123'), true);
  assert.equal(isSafeSessionId('rollout-2026-05-30T11-44-50-019e76fc-0d58'), true);
  assert.equal(isSafeSessionId('legacy-session-xyz'), true);
  assert.equal(isSafeSessionId('.hidden-id'), true);
  assert.equal(isSafeSessionId('..not-parent'), true);
  assert.equal(isSafeSessionId(''), false);
  assert.equal(isSafeSessionId(undefined), false);
  assert.equal(isSafeSessionId(null), false);
  assert.equal(isSafeSessionId('.'), false);
  assert.equal(isSafeSessionId('..'), false);
  assert.equal(isSafeSessionId('../secret'), false);
  assert.equal(isSafeSessionId('foo/bar'), false);
  assert.equal(isSafeSessionId('foo\\bar'), false);
  assert.equal(isSafeSessionId('foo/../bar'), false);
  assert.equal(isSafeSessionId('/etc/passwd'), false);
  assert.equal(isSafeSessionId('\\Windows\\system32'), false);
  assert.equal(isSafeSessionId('C:\\Windows\\secret'), false);
  assert.equal(isSafeSessionId('foo\0bar'), false);
});

test('resolveSessionFile rejects empty, absolute, and parent-segment ids', () => {
  const home = tmpHome();
  try {
    assert.equal(resolveSessionFile('codex', '', home), '');
    assert.equal(resolveSessionFile('codex', '.', home), '');
    assert.equal(resolveSessionFile('codex', '..', home), '');
    assert.equal(resolveSessionFile('codex', '/etc/passwd', home), '');
    assert.equal(resolveSessionFile('claude', '/tmp/secret', home), '');
    assert.equal(resolveSessionFile('codex', path.join(home, 'secret'), home), '');
    assert.equal(resolveSessionFile('claude', null, home), '');
    assert.equal(resolveSessionFile('claude', undefined, home), '');
  } finally { cleanup(home); }
});

test('rejects a sessionId that would leave the session root', () => {
  const home = tmpHome();
  try {
    const outside = path.join(home, 'secret.jsonl');
    fs.writeFileSync(outside, '{}\n');
    const escaped = 'rollout-2026-05-30T../../../../../secret';
    assert.equal(resolveSessionFile('codex', escaped, home), '');
    assert.equal(resolveSessionFile('codex', '../secret', home), '');
    assert.equal(resolveSessionFile('codex', '..\\secret', home), '');
    assert.equal(resolveSessionFile('codex', 'foo/../secret', home), '');
    assert.equal(resolveSessionFile('claude', '../secret', home), '');
    assert.equal(resolveSessionFile('claude', '..\\secret', home), '');
    assert.equal(resolveSessionFile('claude', 'proj/../secret', home), '');
  } finally { cleanup(home); }
});

test('findSessionFiles skips unsafe ids even when a sibling file exists', () => {
  const home = tmpHome();
  try {
    const root = path.join(home, '.codex', 'sessions');
    fs.mkdirSync(root, { recursive: true });
    const safe = path.join(root, 'keep.jsonl');
    fs.writeFileSync(safe, '{}\n');
    fs.writeFileSync(path.join(home, 'secret.jsonl'), '{}\n');
    const found = findSessionFiles(root, ['keep', '../secret', '/etc/passwd', '.', '..', '']);
    assert.deepEqual([...found.keys()], ['keep']);
    assert.equal(found.get('keep'), safe);
  } finally { cleanup(home); }
});
