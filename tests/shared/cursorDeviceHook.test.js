'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { sharedDataDir } = require('../../src/shared/config');
const {
  HOOK_MARKER,
  appendCursorDeviceRecord,
  cursorDeviceLogPath,
  installCursorDeviceHook,
  recordFromPayload,
  uninstallCursorDeviceHook
} = require('../../src/shared/providers/cursor/deviceHook');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('default Cursor device log lives under sharedDataDir/cursor-device', () => {
  const env = {};
  const home = '/home/alice';
  assert.equal(
    cursorDeviceLogPath({ env, home, platform: 'linux' }),
    path.join(sharedDataDir({ env, homeDir: home, platform: 'linux' }), 'cursor-device', 'usage.jsonl')
  );
});

test('TOKEN_MONITOR_CURSOR_DEVICE_LOG overrides the jsonl path', () => {
  assert.equal(
    cursorDeviceLogPath({ env: { TOKEN_MONITOR_CURSOR_DEVICE_LOG: '/tmp/custom.jsonl' }, home: '/home/alice' }),
    '/tmp/custom.jsonl'
  );
});

test('recordFromPayload keeps Agent stop token counts and drops empty rows', () => {
  assert.equal(recordFromPayload({}), null);
  assert.equal(recordFromPayload({ model: 'cursor-grok-4.6-xhigh' }), null);
  const record = recordFromPayload({
    hook_event_name: 'stop',
    model: 'cursor-grok-4.6-xhigh',
    input_tokens: 100,
    output_tokens: 5,
    cache_read_tokens: 40,
    cache_write_tokens: 10,
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    workspace_roots: ['/Users/alice/src/token-monitor']
  });
  assert.equal(record.v, 1);
  assert.equal(record.event, 'stop');
  assert.equal(record.model, 'cursor-grok-4.6-xhigh');
  assert.equal(record.input_tokens, 100);
  assert.equal(record.output_tokens, 5);
  assert.equal(record.cache_read_tokens, 40);
  assert.equal(record.cache_write_tokens, 10);
  assert.equal(record.conversation_id, 'conv-1');
  assert.equal(record.generation_id, 'gen-1');
  assert.equal(record.project, 'token-monitor');
  assert.ok(record.ts);
});

test('appendCursorDeviceRecord writes jsonl and the hook CLI fail-opens', () => {
  const root = tmpDir('cursor-device-log-');
  const logPath = path.join(root, 'usage.jsonl');
  appendCursorDeviceRecord({
    v: 1,
    event: 'stop',
    ts: '2026-09-15T00:00:00.000Z',
    model: 'cursor-grok-4.6-xhigh',
    input_tokens: 12,
    output_tokens: 3
  }, { logPath });
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).input_tokens, 12);

  const hookPath = require.resolve('../../src/shared/providers/cursor/deviceHook');
  const result = spawnSync(process.execPath, [hookPath], {
    input: 'not-json',
    encoding: 'utf8',
    env: { ...process.env, TOKEN_MONITOR_CURSOR_DEVICE_LOG: logPath }
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '{}');
  assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 1);
});

test('installCursorDeviceHook registers stop hooks without dropping unrelated commands', () => {
  const cursorHome = tmpDir('cursor-home-');
  const sharedDir = tmpDir('token-monitor-shared-');
  fs.writeFileSync(path.join(cursorHome, 'hooks.json'), JSON.stringify({
    version: 1,
    hooks: { stop: [{ command: 'echo keep-me' }] }
  }));
  const env = { TOKEN_MONITOR_SHARED_DIR: sharedDir };
  const result = installCursorDeviceHook({
    cursorHome,
    execPath: '/usr/local/bin/node',
    env
  });
  const hooks = JSON.parse(fs.readFileSync(result.hooksPath, 'utf8'));
  assert.equal(hooks.hooks.stop[0].command, 'echo keep-me');
  assert.match(hooks.hooks.stop[1].command, /token-monitor-cursor-device/);
  assert.match(hooks.hooks.subagentStop[0].command, /token-monitor-cursor-device/);
  assert.match(hooks.hooks.stop[1].command, /HOOK_MARKER|token-monitor-cursor-device/);
  assert.ok(fs.existsSync(result.dest));
  assert.match(fs.readFileSync(result.dest, 'utf8'), new RegExp(HOOK_MARKER));

  installCursorDeviceHook({ cursorHome, execPath: '/usr/local/bin/node', env });
  const again = JSON.parse(fs.readFileSync(result.hooksPath, 'utf8'));
  assert.equal(again.hooks.stop.filter((entry) => String(entry.command || '').includes(HOOK_MARKER)).length, 1);

  uninstallCursorDeviceHook({ cursorHome, env });
  const after = JSON.parse(fs.readFileSync(result.hooksPath, 'utf8'));
  assert.deepEqual(after.hooks.stop, [{ command: 'echo keep-me' }]);
  assert.equal((after.hooks.subagentStop || []).length, 0);
});

test('uninstallCursorDeviceHook does not rewrite hooks.json when our marker is absent', () => {
  const cursorHome = tmpDir('cursor-home-');
  const hooksPath = path.join(cursorHome, 'hooks.json');
  const original = '{"version":1,"hooks":{"stop":[{"command":"echo keep-me"}]}}\n';
  fs.writeFileSync(hooksPath, original);
  const result = uninstallCursorDeviceHook({ cursorHome });
  assert.equal(result.removed, false);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), original);
});
