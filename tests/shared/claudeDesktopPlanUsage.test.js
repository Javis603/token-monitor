'use strict';

// Claude Desktop local-only limits: parsing plan-usage-history.json from fake
// userData roots. Every fixture is synthetic and lives in a temp directory; no
// test here reads a real Claude directory, a credential or the network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  claudeDesktopUserDataCandidates,
  claudeDesktopUserDataRoots,
  variantForDir
} = require('../../src/shared/providers/claude/desktopPaths');
const {
  accountKeyFor,
  claudeDesktopPlanProviderInput,
  collectClaudeDesktopPlanUsage,
  desktopOrgAccounts,
  estimateSessionReset,
  estimateWeeklyReset,
  parsePlanUsageHistory,
  selectPlanUsage
} = require('../../src/shared/providers/claude/desktopPlanUsage');
const { hashKey } = require('../../src/shared/hashKey');
const { normalizeLimitProvider } = require('../../src/shared/limits/core');

const ORG = '11111111-2222-4333-8444-555555555555';
const ORG_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACCOUNT = '99999999-8888-4777-8666-555555555555';
const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function tempDir(prefix = 'tm-claude-desktop-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeHistory(root, document) {
  fs.mkdirSync(root, { recursive: true });
  const text = typeof document === 'string' ? document : JSON.stringify(document);
  fs.writeFileSync(path.join(root, 'plan-usage-history.json'), text);
}

function sample(t, fh, sd, org = ORG, extra = {}) {
  return { t, org, u: { fh, sd, ...extra } };
}

test('candidates cover macOS, Windows (APPDATA, MSIX, Claude-Data) and Linux, for 1p and 3p', () => {
  const mac = claudeDesktopUserDataCandidates({ platform: 'darwin', homeDir: '/Users/u', env: {} });
  assert.deepEqual(mac.map(({ dir, variant }) => [dir, variant]), [
    ['/Users/u/Library/Application Support/Claude', '1p'],
    ['/Users/u/Library/Application Support/Claude-3p', '3p']
  ]);

  const win = claudeDesktopUserDataCandidates({
    platform: 'win32',
    homeDir: 'C:\\Users\\u',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
  }).map(({ dir }) => dir);
  assert.ok(win.includes('C:\\Users\\u\\AppData\\Roaming\\Claude'));
  assert.ok(win.includes('C:\\Users\\u\\AppData\\Roaming\\Claude-3p'));
  assert.ok(win.some((dir) => /Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude$/.test(dir)), 'MSIX root');
  assert.ok(win.some((dir) => /Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude-3p$/.test(dir)), 'MSIX 3p root');

  const linux = claudeDesktopUserDataCandidates({ platform: 'linux', homeDir: '/home/u', env: { XDG_CONFIG_HOME: '/xdg' } });
  assert.deepEqual(linux.map(({ dir }) => dir), ['/xdg/Claude', '/xdg/Claude-3p']);

  const override = claudeDesktopUserDataCandidates({
    platform: 'linux', homeDir: '/home/u', env: { TOKEN_MONITOR_CLAUDE_DESKTOP_DIR: '/a:/b-3p' }
  });
  assert.deepEqual(override.slice(0, 2).map(({ dir, variant }) => [dir, variant]), [['/a', '1p'], ['/b-3p', '3p']]);
  assert.equal(variantForDir('/x/Claude-3p/'), '3p');
  assert.equal(variantForDir('/x/Claude'), '1p');
});

test('a Windows home keeps Windows separators when a macOS or Linux layout is simulated', () => {
  // CI runs the fixture tests on Windows with platform 'linux'/'darwin' and a
  // real C:\\ temp dir; path.posix would turn it into a path that never exists.
  const linux = claudeDesktopUserDataCandidates({ platform: 'linux', homeDir: 'C:\\Temp\\h', env: {} });
  assert.deepEqual(linux.map(({ dir }) => dir), ['C:\\Temp\\h\\.config\\Claude', 'C:\\Temp\\h\\.config\\Claude-3p']);
  const mac = claudeDesktopUserDataCandidates({ platform: 'darwin', homeDir: 'D:\\a\\home', env: {} });
  assert.equal(mac[0].dir, 'D:\\a\\home\\Library\\Application Support\\Claude');
  assert.equal(mac[1].variant, '3p');
});

test('only existing roots are returned', () => {
  const home = tempDir();
  fs.mkdirSync(path.join(home, '.config', 'Claude'), { recursive: true });
  const roots = claudeDesktopUserDataRoots({ platform: 'linux', homeDir: home, env: {} });
  assert.deepEqual(roots.map(({ dir }) => dir), [path.join(home, '.config', 'Claude')]);
});

test('a well-formed v2 file parses, sorts and de-duplicates samples', () => {
  const parsed = parsePlanUsageHistory(JSON.stringify({
    version: 2,
    samples: [sample(NOW - 10 * MIN, 30, 40), sample(NOW - 20 * MIN, 20, 39), sample(NOW - 10 * MIN, 30, 40)]
  }), { nowMs: NOW });
  assert.equal(parsed.knownVersion, true);
  assert.deepEqual(parsed.samples.map(({ t }) => t), [NOW - 20 * MIN, NOW - 10 * MIN]);
  assert.deepEqual(parsed.samples[1].usage, { fh: 30, sd: 40 });
  assert.equal(parsed.samples[1].org, ORG);
  assert.deepEqual(parsed.warnings, []);
});

test('parsing tolerates BOM, empty files, unknown versions, missing fields and bad samples', () => {
  assert.deepEqual(parsePlanUsageHistory('', { nowMs: NOW }).samples, []);
  assert.ok(parsePlanUsageHistory('', { nowMs: NOW }).warnings.includes('empty-file'));

  const bom = parsePlanUsageHistory(`\uFEFF${JSON.stringify({ version: 2, samples: [sample(NOW, 1, 2)] })}`, { nowMs: NOW });
  assert.equal(bom.samples.length, 1);

  const future = parsePlanUsageHistory(JSON.stringify({
    version: 7,
    samples: [
      sample(NOW - MIN, 5, 6),
      { t: NOW - MIN },                       // no usage
      { u: { fh: 1 } },                       // no time
      sample(NOW + 3 * 24 * HOUR, 9, 9),      // implausibly in the future
      { t: NOW - 2 * MIN, org: ORG, u: { fh: 'x', sd: -1 } }, // nothing usable
      { t: (NOW - 3 * MIN) / 1000, org: ORG, u: { fh: '12', extra: 3 } } // seconds + string number
    ]
  }), { nowMs: NOW });
  assert.equal(future.knownVersion, false);
  assert.ok(future.warnings.includes('unknown-version:7'));
  assert.ok(future.warnings.some((warning) => warning.startsWith('skipped-samples:')));
  assert.deepEqual(future.samples.map(({ usage }) => usage), [{ fh: 12, extra: 3 }, { fh: 5, sd: 6 }]);

  const noVersion = parsePlanUsageHistory(JSON.stringify({ samples: [sample(NOW, 1, 1)] }), { nowMs: NOW });
  assert.ok(noVersion.warnings.includes('missing-version'));
  assert.equal(noVersion.samples.length, 1);

  const array = parsePlanUsageHistory(JSON.stringify([sample(NOW, 3, 4)]), { nowMs: NOW });
  assert.equal(array.samples.length, 1);

  for (const text of ['null', '42', '"text"', '{}', '{"version":2}']) {
    const result = parsePlanUsageHistory(text, { nowMs: NOW });
    assert.deepEqual(result.samples, [], text);
  }
});

test('a half-written file keeps every complete sample', () => {
  const full = JSON.stringify({
    version: 2,
    samples: [sample(NOW - 2 * MIN, 10, 20), sample(NOW - MIN, 11, 21, ORG, { note: 'a } brace' }), sample(NOW, 12, 22)]
  });
  const truncated = full.slice(0, full.lastIndexOf('{') + 12);
  const parsed = parsePlanUsageHistory(truncated, { nowMs: NOW });
  assert.ok(parsed.warnings.includes('salvaged-partial-file'));
  assert.deepEqual(parsed.samples.map(({ usage }) => usage.fh), [10, 11]);
});

test('weekly reset is the last observed drop plus seven days, rolled past the latest sample', () => {
  const samples = [
    { t: NOW - 9 * 24 * HOUR, usage: { sd: 80 } },
    { t: NOW - 8 * 24 * HOUR, usage: { sd: 2 } },
    { t: NOW, usage: { sd: 30 } }
  ];
  assert.equal(estimateWeeklyReset(samples, samples[2]), NOW - 8 * 24 * HOUR + 14 * 24 * HOUR);
  assert.equal(estimateWeeklyReset([{ t: NOW, usage: { sd: 3 } }], { t: NOW, usage: { sd: 3 } }), null);
});

test('session reset needs a contiguous run that starts after a zero or a drop', () => {
  const run = [
    { t: NOW - 70 * MIN, usage: { fh: 0 } },
    { t: NOW - 60 * MIN, usage: { fh: 4 } },
    { t: NOW - 50 * MIN, usage: { fh: 9 } },
    { t: NOW - 40 * MIN, usage: { fh: 15 } }
  ];
  assert.equal(estimateSessionReset(run, run[3]), NOW - 60 * MIN + 5 * HOUR);
  const gap = [run[0], { t: NOW - 10 * MIN, usage: { fh: 4 } }];
  assert.equal(estimateSessionReset(gap, gap[1]), null, 'a gap longer than 20 minutes cannot date the window');
  const noStart = run.slice(1);
  assert.equal(estimateSessionReset(noStart, noStart[2]), null, 'history that never shows the start is unknown');
});

test('selection prefers first-party roots, supports an org filter and warns on several orgs', () => {
  const roots = [
    { root: '/3p', variant: '3p', samples: [{ t: NOW, org: ORG_B, usage: { fh: 90, sd: 90 } }] },
    { root: '/1p', variant: '1p', samples: [
      { t: NOW - 2 * MIN, org: ORG, usage: { fh: 10, sd: 20 } },
      { t: NOW - MIN, org: ORG_B, usage: { fh: 50, sd: 60 } }
    ] }
  ];
  const latest = selectPlanUsage(roots);
  assert.equal(latest.selected.org, ORG_B);
  assert.equal(latest.selected.root, '/1p');
  assert.ok(latest.warnings.includes('multiple-orgs'));

  const filtered = selectPlanUsage(roots, { orgId: ORG.slice(0, 8) });
  assert.equal(filtered.selected.org, ORG);
  assert.equal(filtered.selected.latest.usage.fh, 10);

  const none = selectPlanUsage(roots, { orgId: 'deadbeef' });
  assert.equal(none.selected, null);
  assert.ok(none.warnings.includes('org-filter-matched-nothing'));

  const thirdPartyOnly = selectPlanUsage([roots[0]]);
  assert.equal(thirdPartyOnly.selected.variant, '3p');
  assert.ok(thirdPartyOnly.warnings.includes('third-party-build-only'));
});

test('collect builds a normalized local provider keyed like the OAuth/Web lanes', () => {
  const home = tempDir();
  const root = path.join(home, 'Library', 'Application Support', 'Claude');
  writeHistory(root, {
    version: 2,
    samples: [
      sample(NOW - 30 * MIN, 0, 79),
      sample(NOW - 20 * MIN, 6, 3),
      sample(NOW - 10 * MIN, 12, 5)
    ]
  });
  fs.mkdirSync(path.join(root, 'claude-code-sessions', ACCOUNT, ORG), { recursive: true });
  assert.equal(desktopOrgAccounts(root).get(ORG), ACCOUNT);

  const collected = collectClaudeDesktopPlanUsage({}, { homeDir: home, platform: 'darwin', env: {}, now: () => NOW });
  const provider = normalizeLimitProvider(claudeDesktopPlanProviderInput(collected));
  assert.equal(provider.provider, 'claude');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'local');
  assert.equal(provider.sourceDetail, 'app');
  assert.equal(provider.accountKey, hashKey('claude-account', `account:${ACCOUNT}:organization:${ORG}`));
  assert.equal(provider.updatedAt, new Date(NOW - 10 * MIN).toISOString());
  const session = provider.windows.find((window) => window.kind === 'session');
  const weekly = provider.windows.find((window) => window.kind === 'weekly');
  assert.equal(session.usedPercent, 12);
  assert.equal(session.windowMinutes, 300);
  assert.equal(Date.parse(session.resetsAt), NOW - 20 * MIN + 5 * HOUR);
  assert.equal(weekly.usedPercent, 5);
  assert.equal(weekly.windowMinutes, 10080);
  assert.equal(Date.parse(weekly.resetsAt), NOW - 20 * MIN + 7 * 24 * HOUR);
});

test('collect reports notConfigured without a file and unavailable with an unusable one', () => {
  const empty = tempDir();
  const none = claudeDesktopPlanProviderInput(collectClaudeDesktopPlanUsage({}, {
    homeDir: empty, platform: 'linux', env: {}, now: () => NOW
  }));
  assert.equal(none.status, 'notConfigured');
  assert.deepEqual(none.windows, []);

  const home = tempDir();
  writeHistory(path.join(home, '.config', 'Claude'), '{"version":2,"samples":[{"t":');
  const broken = claudeDesktopPlanProviderInput(collectClaudeDesktopPlanUsage({}, {
    homeDir: home, platform: 'linux', env: {}, now: () => NOW
  }));
  assert.equal(broken.status, 'unavailable');
  assert.equal(normalizeLimitProvider(broken).status, 'unavailable');
});

test('the org filter comes from options first, then the env var', () => {
  const home = tempDir();
  writeHistory(path.join(home, '.config', 'Claude'), {
    version: 2, samples: [sample(NOW - 2 * MIN, 10, 10, ORG), sample(NOW - MIN, 70, 70, ORG_B)]
  });
  const deps = { homeDir: home, platform: 'linux', now: () => NOW };
  const fromEnv = collectClaudeDesktopPlanUsage({}, { ...deps, env: { TOKEN_MONITOR_CLAUDE_DESKTOP_ORG_ID: ORG } });
  assert.equal(fromEnv.selected.org, ORG);
  const fromOption = collectClaudeDesktopPlanUsage({ claudeDesktopOrgId: ORG_B }, { ...deps, env: { TOKEN_MONITOR_CLAUDE_DESKTOP_ORG_ID: ORG } });
  assert.equal(fromOption.selected.org, ORG_B);
});

test('account keys degrade gracefully without a full account/org pair', () => {
  assert.equal(accountKeyFor('', ORG), hashKey('claude-account', `organization:${ORG}`));
  assert.equal(accountKeyFor('', 'abcd1234'), hashKey('claude-desktop', 'organization:abcd1234'));
  assert.equal(accountKeyFor('', ''), 'claude-desktop-local');
});
