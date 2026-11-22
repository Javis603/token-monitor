'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { watchIgnoreMatcher } = require('../../src/shared/watchPolicy');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

installSourceEnvGuard(test);

test('the watcher skips compressed Codex archives but keeps live rollouts', (t) => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-codex-archive-watch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, '.codex', 'sessions', '2026', '10', '12');
  const archived = path.join(home, '.codex', 'archived_sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });

  const ignored = watchIgnoreMatcher('codex', { homeDir: home, env: {} });
  assert.equal(typeof ignored, 'function', 'codex now carries an archive policy');

  assert.equal(ignored(path.join(sessions, 'rollout-live.jsonl')), false);
  assert.equal(ignored(path.dirname(sessions)), false);
  assert.equal(ignored(sessions), false);
  assert.equal(ignored(archived), false);
  assert.equal(ignored(path.join(sessions, 'rollout-old.jsonl.zst')), true);
  assert.equal(ignored(path.join(archived, 'rollout-legacy.jsonl.zst')), true);
});
