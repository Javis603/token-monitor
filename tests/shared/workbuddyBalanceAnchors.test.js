'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readAnchors,
  recordAnchor,
  localDayKey,
  dayKeyToAt,
  round2
} = require('../../src/shared/providers/workbuddy/balanceAnchors');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-anchors-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const storePath = path.join(dir, 'anchors.json');
const deps = {
  workbuddyAnchorStorePath: storePath,
  readJson: (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
  },
  writeJsonAtomic: (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2))
};

// A fixed local afternoon keeps every assertion on the intended local day.
const now = new Date(2026, 10, 10, 15).getTime();

test('recordAnchor writes the official balance for the local day', async () => {
  const days = await recordAnchor({ accountKey: 'acc-1', remaining: 6265.81, now }, deps);
  assert.equal(days[localDayKey(now)].remaining, 6265.81);
  assert.equal(readAnchors('acc-1', now, deps)[localDayKey(now)].remaining, 6265.81);
});

test('recordAnchor keeps accounts separate and overwrites the same day', async () => {
  await recordAnchor({ accountKey: 'acc-2', remaining: 100, now }, deps);
  await recordAnchor({ accountKey: 'acc-2', remaining: 90, now: now + 3_600_000 }, deps);
  assert.equal(readAnchors('acc-2', now, deps)[localDayKey(now)].remaining, 90);
  assert.equal(readAnchors('acc-1', now, deps)[localDayKey(now)].remaining, 6265.81);
});

test('recordAnchor prunes days outside the retention window', async () => {
  await recordAnchor({ accountKey: 'acc-3', remaining: 500, now: now - 60 * 86_400_000 }, deps);
  await recordAnchor({ accountKey: 'acc-3', remaining: 400, now }, deps);
  const days = readAnchors('acc-3', now, deps);
  assert.equal(Object.keys(days).length, 1);
  assert.equal(days[localDayKey(now)].remaining, 400);
});

test('concurrent account collections do not lose each other anchors', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, index) => recordAnchor(
    { accountKey: `concurrent-${index}`, remaining: 1000 + index, now }, deps)));
  for (let index = 0; index < 8; index += 1) {
    assert.equal(readAnchors(`concurrent-${index}`, now, deps)[localDayKey(now)].remaining, 1000 + index);
  }
});

test('invalid observations are rejected without touching the store', async () => {
  assert.equal(await recordAnchor({ accountKey: '', remaining: 10, now }, deps), null);
  assert.equal(await recordAnchor({ accountKey: 'x', remaining: -1, now }, deps), null);
  assert.equal(await recordAnchor({ accountKey: 'x', remaining: 10, now: Number.NaN }, deps), null);
  assert.equal(readAnchors('x', now, deps)[localDayKey(now)], undefined);
});

test('dayKeyToAt uses local noon and round2 caps precision', () => {
  const at = dayKeyToAt('2026-11-10');
  assert.equal(new Date(at).getHours(), 12);
  assert.equal(dayKeyToAt('not-a-day'), null);
  assert.equal(round2(1.234), 1.23);
});
