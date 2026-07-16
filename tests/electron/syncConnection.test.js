'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { classifyStreamFailure } = require('../../src/electron/syncConnection');

test('eof maps to disconnected', () => {
  assert.deepEqual(classifyStreamFailure({ eof: true }), { reason: 'disconnected', detail: null });
});

test('401 and 403 map to unauthorized', () => {
  assert.deepEqual(classifyStreamFailure({ status: 401 }), { reason: 'unauthorized', detail: null });
  assert.deepEqual(classifyStreamFailure({ status: 403 }), { reason: 'unauthorized', detail: null });
});

test('other HTTP status maps to server_error with the code as detail', () => {
  assert.deepEqual(classifyStreamFailure({ status: 500 }), { reason: 'server_error', detail: '500' });
  assert.deepEqual(classifyStreamFailure({ status: 503 }), { reason: 'server_error', detail: '503' });
});

test('network errnos map to their reason', () => {
  assert.deepEqual(classifyStreamFailure({ errorCode: 'ECONNREFUSED' }), { reason: 'refused', detail: null });
  assert.deepEqual(classifyStreamFailure({ errorCode: 'ETIMEDOUT' }), { reason: 'timeout', detail: null });
  assert.deepEqual(classifyStreamFailure({ errorCode: 'ENOTFOUND' }), { reason: 'dns', detail: null });
  assert.deepEqual(classifyStreamFailure({ errorCode: 'EAI_AGAIN' }), { reason: 'dns', detail: null });
  assert.deepEqual(classifyStreamFailure({ errorCode: 'EHOSTUNREACH' }), { reason: 'unreachable', detail: null });
  assert.deepEqual(classifyStreamFailure({ errorCode: 'ENETUNREACH' }), { reason: 'unreachable', detail: null });
});

test('unknown errno falls back to network with the code as detail', () => {
  assert.deepEqual(classifyStreamFailure({ errorCode: 'ECONNRESET' }), { reason: 'network', detail: 'ECONNRESET' });
});

test('no recognizable signal falls back to network with the message as detail', () => {
  assert.deepEqual(classifyStreamFailure({ message: 'fetch failed' }), { reason: 'network', detail: 'fetch failed' });
  assert.deepEqual(classifyStreamFailure({}), { reason: 'network', detail: null });
});

test('local stats overlays do not clear a disconnected Hub stream state', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const statsPush = app.match(/window\.tokenMonitor\.onStatsPush\?\.\(\(payload\) => \{[\s\S]*?\n\}\);/)?.[0] || '';

  assert.match(statsPush, /if \(payload\.data\?\.reason !== 'local'\) \{\s*state\.streamConnected = true;\s*state\.streamFailure = null;\s*\}/);
});
