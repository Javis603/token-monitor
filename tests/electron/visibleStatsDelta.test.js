'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/electron/renderer/index.html'), 'utf8');

test('main sends visible session changes as a delta from a compact fingerprint', () => {
  assert.match(main, /require\('\.\.\/shared\/statsDelta'\)/);
  assert.match(main, /let lastRendererStatsFingerprint = null/);
  assert.match(main, /buildStatsDelta\(lastRendererStatsFingerprint, copy\)/);
  assert.match(main, /data: \{ \.\.\.data, statsDelta: built\.delta \}/);
  assert.match(main, /lastRendererStatsFingerprint = rendererFingerprint/);
  assert.match(main, /const fingerprint = fingerprintStats\(copy\)/);
  assert.match(main, /lastRendererStatsFingerprint = fingerprint/);
  assert.match(main, /event\.sender === mainWindow\.webContents/);
  assert.match(main, /if \(win === mainWindow\) lastRendererStatsFingerprint = null/);
});

test('the renderer applies a delta and falls back to a full read on a base mismatch', () => {
  assert.match(html, /<script src="\.\.\/\.\.\/shared\/statsDelta\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/);
  assert.match(renderer, /window\.TokenMonitorStatsDelta\?\.applyStatsDelta\(state\.stats, payload\.data\.statsDelta\)/);
  assert.match(renderer, /statsDeltaResyncPending/);
  assert.match(renderer, /void refreshStats\(\)\.catch\(\(\) => \{\}\)\.finally/);
});
