'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { projectSessionDeviceSessions, projectSessionDeviceStats } = require('../../src/electron/sessionDeviceSources');
const { rendererStats } = require('../../src/electron/statsPublisher');
const { sessionRowsForPeriod, sessionSubtitleForDisplay, groupSessionRows } = require('../../src/electron/renderer/sessionRows');

const session = { client: 'codex', sessionId: 'a', title: 'Review', totalTokens: 10, models: { model: 10 } };
const sessions = { 'codex:a': session };
const device = { deviceId: 'macbook', hostname: 'host', platform: 'darwin', periods: { today: { sessions } } };

test('source survives device-map stripping and session row projection without mutating accounting', () => {
  const stats = { periods: { today: { sessions } }, devices: [device] };
  const before = structuredClone(stats);
  const visible = rendererStats(projectSessionDeviceStats(stats, 'macbook'));
  assert.equal(visible.devices[0].periods.today.sessions, undefined);
  const [row] = sessionRowsForPeriod(visible.periods.today);
  assert.deepEqual(row.sourceDevice, { deviceId: 'macbook', name: 'macbook', platform: 'darwin', deviceKind: 'computer' });
  assert.deepEqual(stats, before);
  assert.equal(row.value, 10);
});

test('all-time completion resolves remote month baselines and captured local history separately', () => {
  const remote = { deviceId: 'vps', periods: { month: { sessions: { 'codex:r': { ...session, sessionId: 'r' } } } } };
  const capturedLocal = { deviceId: 'macbook', allTime: { sessions } };
  const all = { ...sessions, ...remote.periods.month.sessions };
  const result = projectSessionDeviceSessions(all, [remote, capturedLocal], ['month', 'allTime']);
  assert.equal(result['codex:r'].sourceDevice.name, 'vps');
  assert.equal(result['codex:a'].sourceDevice.name, 'macbook');
  assert.equal(projectSessionDeviceSessions(sessions, [remote], ['month'])['codex:a'].sourceDevice, undefined);
});

test('repeated periods on one device keep the owner; conflicting device evidence never guesses', () => {
  const repeated = { ...device, periods: { today: { sessions }, month: { sessions } } };
  assert.equal(projectSessionDeviceSessions(sessions, [repeated], ['today', 'month'])['codex:a'].sourceDevice.deviceId, 'macbook');
  const conflicting = { ...device, deviceId: 'other' };
  assert.equal(projectSessionDeviceSessions(sessions, [device, conflicting], ['today'])['codex:a'].sourceDevice, undefined);
});

test('native-only sessions use the explicit local device, not the first remote device', () => {
  const stats = { devices: [{ deviceId: 'vps' }, device], nativeSessions: { today: sessions } };
  const projected = projectSessionDeviceStats(stats, 'macbook');
  assert.equal(projected.nativeSessions.today['codex:a'].sourceDevice.deviceId, 'macbook');
  assert.equal(projectSessionDeviceStats(stats, 'absent').nativeSessions.today['codex:a'].sourceDevice, undefined);
});

test('subtitle omits the tool name only when its icon is visible, retaining model, effort and activity', () => {
  const row = { client: 'codex', clientLabel: 'Codex', sourceDevice: { name: 'MacBook' } };
  assert.equal(sessionSubtitleForDisplay(row, 'Codex · gpt-6.1-sol · high'), 'gpt-6.1-sol · high');
  assert.equal(sessionSubtitleForDisplay(row, '12:00 · 3 calls'), '12:00 · 3 calls');
  assert.equal(sessionSubtitleForDisplay(row, ''), '');
  assert.equal(sessionSubtitleForDisplay(row, 'Codex'), '');
  assert.equal(sessionSubtitleForDisplay(row, 'Codex · model', { keepClient: true }), 'Codex · model');
  assert.equal(sessionSubtitleForDisplay({ client: 'codex', clientLabel: 'Codex' }, 'Codex · model'), 'model');
});

test('subagent summary and its children retain the individual session source', () => {
  const sourced = { ...session, sourceDevice: { name: 'MacBook', deviceId: 'macbook' } };
  const rows = sessionRowsForPeriod({ sessions: { 'codex:a': sourced,
    'codex:b': { ...sourced, sessionId: 'b', parentSessionId: 'a' } } });
  const [group] = groupSessionRows(rows);
  assert.equal(group.sourceDevice.name, 'MacBook');
  assert.ok(group.groupRows.every(row => row.sourceDevice.name === 'MacBook'));
});
