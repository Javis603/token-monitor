'use strict';

// The read-only Mac verification script, run against synthetic fixtures.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'verify-claude-desktop-local.js');
const ORG = '11111111-2222-4333-8444-555555555555';
const ACCOUNT = '99999999-8888-4777-8666-555555555555';

function assistant(id, requestId, usage, timestamp) {
  return JSON.stringify({ type: 'assistant', requestId, timestamp, message: { id, role: 'assistant', usage } });
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-verify-desktop-'));
  const desktop = path.join(home, 'Claude');
  fs.mkdirSync(path.join(desktop, 'claude-code-sessions', ACCOUNT, ORG), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(desktop, 'plan-usage-history.json'), JSON.stringify({
    version: 2,
    samples: [{ t: now - 120_000, org: ORG, u: { fh: 10, sd: 30 } }, { t: now - 60_000, org: ORG, u: { fh: 12, sd: 31 } }]
  }));
  const projects = path.join(home, 'dot-claude', 'projects', '-proj');
  fs.mkdirSync(projects, { recursive: true });
  const ts = new Date(now - 3600_000).toISOString();
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 };
  fs.writeFileSync(path.join(projects, 'desk.jsonl'), [
    JSON.stringify({ type: 'user', entrypoint: 'claude-desktop', timestamp: ts }),
    assistant('m1', 'r1', usage, ts),
    assistant('m1', 'r1', usage, ts), // streamed duplicate
    assistant('m2', 'r2', usage, ts)
  ].join('\n'));
  fs.writeFileSync(path.join(projects, 'cli.jsonl'), [
    JSON.stringify({ type: 'user', entrypoint: 'cli', timestamp: ts }),
    assistant('m3', 'r3', usage, ts)
  ].join('\n'));
  // A credential-looking file next to the data must never be read.
  fs.writeFileSync(path.join(home, 'dot-claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fake"}}');
  return { home, desktop, claudeConfig: path.join(home, 'dot-claude') };
}

const childEnv = () => ({ PATH: process.env.PATH, HOME: os.tmpdir() });

test('the verification script prints quota samples and Desktop token totals', () => {
  const { desktop, claudeConfig } = fixture();
  const run = spawnSync(process.execPath, [SCRIPT, '--dir', desktop, '--claude-config', claudeConfig, '--json'], {
    encoding: 'utf8', env: childEnv(), timeout: 20_000
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.quota.selectedOrg, ORG);
  assert.deepEqual(report.quota.latestUsage, { fh: 12, sd: 31 });
  assert.equal(report.quota.providerRow.status, 'ok');
  assert.equal(report.sessions.desktopSessions, 1);
  assert.equal(report.sessions.otherSessions, 1);
  assert.equal(report.sessions.desktopTokens.allTime.total, 40, 'two unique responses of 20 tokens');
  assert.equal(report.sessions.desktopTokens.last5h.messages, 2);

  const text = spawnSync(process.execPath, [SCRIPT, '--dir', desktop, '--claude-config', claudeConfig], {
    encoding: 'utf8', env: childEnv(), timeout: 20_000
  });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /provider row: status=ok windows=session:12% weekly:31%/);
});

test('the verification script loads no network or networked-limits module', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual(requires.sort(), [
    '../src/shared/providers/claude/desktopPaths',
    '../src/shared/providers/claude/desktopPlanUsage',
    '../src/shared/providers/claude/desktopSessions',
    'node:fs',
    'node:module',
    'node:os',
    'node:path'
  ]);
  // Once the script has loaded, network modules and fetch stay blocked.
  const probe = spawnSync(process.execPath, ['-e', `
    process.argv = [process.argv[0], ${JSON.stringify(SCRIPT)}, '--help'];
    require(${JSON.stringify(SCRIPT)});
    try { require('node:https'); console.log('loaded'); } catch (e) { console.log('blocked'); }
    try { fetch('https://example.invalid'); console.log('fetched'); } catch (e) { console.log('no-fetch'); }
  `], { encoding: 'utf8', env: childEnv(), timeout: 20_000 });
  assert.match(probe.stdout, /blocked/);
  assert.match(probe.stdout, /no-fetch/);
});

test('--help lists every option and --samples 0 prints no samples', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', env: childEnv(), timeout: 20_000 });
  assert.equal(help.status, 0, help.stderr);
  for (const flag of ['--dir', '--claude-config', '--org', '--samples', '--json']) assert.match(help.stdout, new RegExp(flag));
  const { desktop, claudeConfig } = fixture();
  const run = spawnSync(process.execPath, [SCRIPT, '--dir', desktop, '--claude-config', claudeConfig, '--json', '--samples', '0'], {
    encoding: 'utf8', env: childEnv(), timeout: 20_000
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).quota.recentSamples, []);
});
