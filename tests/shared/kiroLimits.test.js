'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseKiroUsage,
  displayPlanName,
  parseResetDate,
  existingKiroCli,
  runKiroUsageCli,
  fetchKiroLimits
} = require('../../src/shared/kiroLimits');
const { parseLimitProviders, fetchKiroLimits: fetchKiroLimitsViaCollector } = require('../../src/shared/limitCollector');

const LEGACY_BASIC = [
  '| KIRO FREE                                          |',
  '████████████████████████████████████████████████████ 25%',
  '(12.50 of 50 covered in plan), resets on 01/15'
].join('\n');

const LEGACY_BONUS = [
  '| KIRO PRO                                           |',
  '████████████████████████████████████████████████████ 80%',
  '(40.00 of 50 covered in plan), resets on 02/01',
  'Bonus credits: 5.00/10 credits used, expires in 7 days'
].join('\n');

const ANSI_OUTPUT = [
  '\x1b[32m| KIRO FREE                                          |\x1b[0m',
  '\x1b[38;5;11m████████████████████████████████████████████████████\x1b[0m 50%',
  '(25.00 of 50 covered in plan), resets on 03/15'
].join('\n');

const OVERAGE_OUTPUT = [
  '| KIRO PRO                                           |',
  '████████████████████████████████████████████████████ 100%',
  '(50.00 of 50 covered in plan), resets on 02/01',
  'Overages: enabled',
  'Credits used: 12.50',
  'Est. cost: $3.20 USD'
].join('\n');

// Boxed layout from CodexBar docs/kiro.md: the "Bonus credits:" label and its
// number land on separate lines, with box-drawing borders in between.
const BOXED_OUTPUT = [
  '┃                                                          | KIRO FREE      ┃',
  '┃ Monthly credits:                                                          ┃',
  '┃ ████████████████████████████████████████ 100% (resets on 01/01)          ┃',
  '┃                              (0.00 of 50 covered in plan)                 ┃',
  '┃ Bonus credits:                                                            ┃',
  '┃ 0.00/100 credits used, expires in 88 days                                 ┃'
].join('\n');

const MANAGED_NEW_FORMAT = [
  'Plan: Q Developer Pro',
  'Your plan is managed by admin',
  '',
  'Tip: to see context window usage, run /context'
].join('\n');

test('parseKiroUsage reads the legacy free-tier output', () => {
  const parsed = parseKiroUsage(LEGACY_BASIC);
  assert.equal(parsed.planName, 'KIRO FREE');
  assert.equal(parsed.displayPlanName, 'Kiro Free');
  assert.equal(parsed.creditsPercent, 25);
  assert.equal(parsed.creditsUsed, 12.5);
  assert.equal(parsed.creditsTotal, 50);
  assert.equal(parsed.hasMetrics, true);
  assert.equal(parsed.bonus, null);
  assert.ok(parsed.resetsAt, 'reset date parsed');
});

test('parseKiroUsage reads bonus credits with expiry', () => {
  const parsed = parseKiroUsage(LEGACY_BONUS);
  assert.equal(parsed.planName, 'KIRO PRO');
  assert.equal(parsed.creditsPercent, 80);
  assert.deepEqual(parsed.bonus, { used: 5, total: 10, expiryDays: 7 });
});

test('parseKiroUsage reads bonus from the boxed multi-line layout', () => {
  const parsed = parseKiroUsage(BOXED_OUTPUT);
  assert.equal(parsed.planName, 'KIRO FREE');
  assert.equal(parsed.creditsPercent, 100);
  assert.deepEqual(parsed.bonus, { used: 0, total: 100, expiryDays: 88 });
});

test('parseKiroUsage falls back to credits ratio when no percent bar', () => {
  const parsed = parseKiroUsage('| KIRO FREE |\n(12.50 of 50 covered in plan), resets on 01/15');
  assert.equal(parsed.creditsPercent, 25);
});

test('parseKiroUsage strips ANSI escape codes', () => {
  const parsed = parseKiroUsage(ANSI_OUTPUT);
  assert.equal(parsed.planName, 'KIRO FREE');
  assert.equal(parsed.creditsPercent, 50);
  assert.equal(parsed.creditsUsed, 25);
});

test('parseKiroUsage parses overages when enabled', () => {
  const parsed = parseKiroUsage(OVERAGE_OUTPUT);
  assert.deepEqual(parsed.overage, { creditsUsed: 12.5, estimatedCostUsd: 3.2 });
});

test('parseKiroUsage reports no overage when disabled or absent', () => {
  assert.equal(parseKiroUsage(LEGACY_BASIC).overage, null);
  assert.equal(parseKiroUsage(`${LEGACY_BASIC}\nOverages: disabled`).overage, null);
});

test('parseKiroUsage handles a managed Q Developer plan with no metrics', () => {
  const parsed = parseKiroUsage(MANAGED_NEW_FORMAT);
  assert.equal(parsed.planName, 'Q Developer Pro');
  assert.equal(parsed.managed, true);
  assert.equal(parsed.hasMetrics, false);
  assert.equal(parsed.creditsPercent, 0);
});

test('parseKiroUsage throws notConfigured when logged out', () => {
  assert.throws(() => parseKiroUsage('Not logged in\nRun kiro-cli login to continue'), (err) => {
    assert.equal(err.status, 'notConfigured');
    return true;
  });
});

test('parseKiroUsage throws unavailable when no usage markers are present', () => {
  assert.throws(() => parseKiroUsage('| KIRO FREE |'), (err) => {
    assert.equal(err.status, 'unavailable');
    return true;
  });
});

test('displayPlanName title-cases KIRO plans and keeps Q Developer naming', () => {
  assert.equal(displayPlanName('KIRO FREE'), 'Kiro Free');
  assert.equal(displayPlanName('KIRO PRO'), 'Kiro Pro');
  assert.equal(displayPlanName('Q Developer Pro'), 'Q Developer Pro');
});

test('parseResetDate parses ISO and MM/DD (rolling to a future date)', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  assert.equal(parseResetDate('2026-07-01', now), new Date('2026-07-01T00:00:00').toISOString());
  // 01/15 is in the past for a June anchor -> next year.
  const mmdd = parseResetDate('01/15', now);
  assert.ok(mmdd && new Date(mmdd).getTime() > now.getTime(), 'MM/DD rolls to a future date');
});

test('existingKiroCli returns null when nothing is found', () => {
  const result = existingKiroCli({ PATH: '/nope' }, 'linux', { existsSync: () => false });
  assert.equal(result, null);
});

test('existingKiroCli honours TOKEN_MONITOR_KIRO_COMMAND', () => {
  const result = existingKiroCli({ TOKEN_MONITOR_KIRO_COMMAND: '/custom/kiro-cli' }, 'linux', { existsSync: () => false });
  assert.equal(result, '/custom/kiro-cli');
});

test('existingKiroCli prefers a PATH hit over a known install location', () => {
  // Both a PATH entry and the known fallbacks resolve; PATH must win so the
  // user's installed/updated binary is used, not a stale known path.
  const result = existingKiroCli({ PATH: '/custom/bin' }, 'linux', { existsSync: () => true });
  assert.equal(result, require('node:path').join('/custom/bin', 'kiro-cli'));
});

test('existingKiroCli finds a standard Windows install that is not on PATH', () => {
  const path = require('node:path');
  const localAppData = 'C:\\Users\\me\\AppData\\Local';
  const expected = path.join(localAppData, 'Programs', 'Kiro', 'kiro-cli.exe');
  const result = existingKiroCli(
    { LOCALAPPDATA: localAppData, PATH: 'C:\\nope' },
    'win32',
    { existsSync: (p) => p === expected }
  );
  assert.equal(result, expected);
});

test('fetchKiroLimits maps a healthy scan to a billing window', async () => {
  const provider = await fetchKiroLimits({}, {
    runKiroUsageCli: async () => LEGACY_BASIC,
    now: () => Date.parse('2026-06-01T00:00:00Z')
  });
  assert.equal(provider.provider, 'kiro');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'cli');
  // The row is already named "Kiro", so the plan label drops the redundant
  // prefix and shows just the tier (matches Cursor's "Free"/"Pro+").
  assert.equal(provider.accountLabel, 'Free');
  assert.ok(provider.accountKey, 'accountKey set');
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].kind, 'billing');
  assert.equal(provider.windows[0].label, 'Credits');
  assert.equal(provider.windows[0].usedPercent, 25);
  // Absolute credit count rides along so the renderer can show "remaining/total".
  assert.equal(provider.windows[0].used, 12.5);
  assert.equal(provider.windows[0].limit, 50);
});

test('fetchKiroLimits adds a second window for bonus credits', async () => {
  const provider = await fetchKiroLimits({}, {
    runKiroUsageCli: async () => LEGACY_BONUS,
    now: () => Date.parse('2026-06-01T00:00:00Z')
  });
  assert.equal(provider.windows.length, 2);
  const labels = provider.windows.map((w) => w.label).sort();
  assert.deepEqual(labels, ['Bonus', 'Credits']);
  const bonus = provider.windows.find((w) => w.label === 'Bonus');
  assert.equal(bonus.usedPercent, 50);
  assert.equal(bonus.used, 5);
  assert.equal(bonus.limit, 10);
});

test('fetchKiroLimits adds an Overage note row when overage billing is on', async () => {
  const provider = await fetchKiroLimits({}, {
    runKiroUsageCli: async () => OVERAGE_OUTPUT,
    now: () => Date.parse('2026-06-01T00:00:00Z')
  });
  const overage = provider.windows.find((w) => w.label === 'Overage');
  assert.ok(overage, 'overage row present');
  assert.equal(overage.showMeter, false);
  assert.equal(overage.used, 12.5); // overage credits used
  assert.equal(overage.remaining, 3.2); // est. cost (USD), rendered as a $ value
});

test('fetchKiroLimits omits the Overage row when overage billing is off', async () => {
  const provider = await fetchKiroLimits({}, {
    runKiroUsageCli: async () => LEGACY_BASIC,
    now: () => Date.parse('2026-06-01T00:00:00Z')
  });
  assert.equal(provider.windows.some((w) => w.label === 'Overage'), false);
});

test('fetchKiroLimits reports a managed plan as ok with no meter', async () => {
  const provider = await fetchKiroLimits({}, {
    runKiroUsageCli: async () => MANAGED_NEW_FORMAT,
    now: () => Date.parse('2026-06-01T00:00:00Z')
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Q Developer Pro');
  assert.equal(provider.windows.length, 0);
});

test('fetchKiroLimits returns notConfigured when kiro-cli is absent', async () => {
  const provider = await fetchKiroLimits({}, {
    env: { PATH: '/nope' },
    platform: 'linux',
    existsSync: () => false
  });
  assert.equal(provider.provider, 'kiro');
  assert.equal(provider.status, 'notConfigured');
});

test('fetchKiroLimits surfaces a logged-out scan as notConfigured', async () => {
  const provider = await fetchKiroLimits({}, {
    runKiroUsageCli: async () => 'Not logged in. Run kiro-cli login first.'
  });
  assert.equal(provider.status, 'notConfigured');
  assert.equal(provider.windows.length, 0);
});

test('parseLimitProviders includes kiro by default and accepts it explicitly', () => {
  assert.ok(parseLimitProviders('').includes('kiro'), 'kiro is collected by default');
  assert.deepEqual(parseLimitProviders('kiro'), ['kiro']);
});

test('limitCollector re-exports fetchKiroLimits', async () => {
  const provider = await fetchKiroLimitsViaCollector({}, {
    runKiroUsageCli: async () => LEGACY_BASIC
  });
  assert.equal(provider.provider, 'kiro');
  assert.equal(provider.status, 'ok');
});

test('runKiroUsageCli terminates immediately when the parent probe is aborted', async () => {
  const { EventEmitter } = require('node:events');
  const controller = new AbortController();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let kills = 0;
  child.kill = () => { kills += 1; };

  const pending = runKiroUsageCli({
    signal: controller.signal,
    spawn: () => child,
    kiroCliTimeoutMs: 60_000
  });
  controller.abort(new Error('runtime stopped'));

  await assert.rejects(pending, /runtime stopped/);
  assert.equal(kills, 1);
});
