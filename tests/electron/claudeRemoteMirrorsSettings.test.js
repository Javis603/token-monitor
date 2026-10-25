'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function section(startMarker, endMarker) {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `renderer section: ${startMarker}`);
  return app.slice(start, end);
}

const saveSource = section('async function saveSettings(', '// The resolved settings of a write');
const handlersSource = section("els.claudeRemoteMirrorsInput?.addEventListener('change'", "els.exportAutoInput?.addEventListener('change'");
const syncSource = section('  if (els.claudeRemoteMirrorsInput) els.claudeRemoteMirrorsInput.checked', '  if (els.sessionUsageArchiveInput)');

const scenarios = [
  { name: 'enable mirror exclusion', input: 'claudeRemoteMirrorsInput', mirrors: false, wsl: true,
    checked: true, patch: { claudeRemoteMirrorsExcluded: true, wslScanEnabled: false } },
  { name: 'disable mirror exclusion', input: 'claudeRemoteMirrorsInput', mirrors: true, wsl: false,
    checked: false, patch: { claudeRemoteMirrorsExcluded: false } },
  { name: 'enable WSL fallback', input: 'wslScanInput', mirrors: true, wsl: false,
    checked: true, patch: { wslScanEnabled: true, claudeRemoteMirrorsExcluded: false } },
  { name: 'disable WSL fallback', input: 'wslScanInput', mirrors: false, wsl: true,
    checked: false, patch: { wslScanEnabled: false } }
];

function setup(scenario, { code, reloadFails = false } = {}) {
  const persisted = { claudeRemoteMirrorsExcluded: scenario.mirrors, wslScanEnabled: scenario.wsl };
  const state = { settings: { ...persisted } };
  const error = Object.assign(new Error('Settings write failed'), { code });
  const logged = [];
  const reported = [];
  const patches = [];
  let reloads = 0;
  let renders = 0;
  let successfulWrites = 0;
  const input = () => ({ checked: false, events: {}, addEventListener(name, callback) { this.events[name] = callback; } });
  const els = { claudeRemoteMirrorsInput: input(), wslScanInput: input() };
  const context = {
    state, els, appearancePreview: {}, pendingSettingsPatches: new Set(),
    syncContentForm: { decoratePatch: patch => patch, reportSettingsError: value => reported.push(value) },
    window: { tokenMonitor: {
      updateSettings: async patch => {
        assert.equal(context.pendingSettingsPatches.has(patch), true);
        patches.push(JSON.parse(JSON.stringify(patch)));
        if (code) throw error;
        return { ...persisted, ...patch };
      },
      getSettings: async () => {
        reloads += 1;
        if (reloadFails) throw new Error('Settings reload failed');
        return { ...persisted };
      }
    } },
    setSyncContentEditError() {}, applyEffectiveCurrencyRates() {}, restartTimer() {}, maybeUpdateBarsIcon() {},
    preserveSettingsPanelScroll: callback => callback(),
    isSettingsSurfaceVisible: () => true, render: () => { renders += 1; },
    applyPersistedSettings: next => {
      successfulWrites += 1;
      state.settings = next;
      context.syncSettingsForm();
    },
    console: { error: (...args) => logged.push(args) }
  };
  vm.runInNewContext(`${saveSource}\nfunction syncSettingsForm() {\n${syncSource}\n}\n${handlersSource}`, context);
  context.syncSettingsForm();
  els[scenario.input].checked = scenario.checked;
  return { context, state, els, error, persisted, logged, reported, patches,
    counts: () => ({ reloads, renders, successfulWrites }) };
}

for (const scenario of scenarios) {
  for (const code of ['EACCES', 'EIO']) {
    for (const reloadFails of [false, true]) {
      test(`${scenario.name}: ${code}, settings reload ${reloadFails ? 'fails' : 'succeeds'}`, async () => {
        const h = setup(scenario, { code, reloadFails });
        // Capture rejection so we can check recovery even on the unfixed handler.
        let rejection;
        try { await h.els[scenario.input].events.change(); } catch (error) { rejection = error; }
        assert.deepEqual(h.patches, [scenario.patch]);
        assert.deepEqual(h.state.settings, h.persisted);
        assert.equal(h.els.claudeRemoteMirrorsInput.checked, scenario.mirrors);
        assert.equal(h.els.wslScanInput.checked, scenario.wsl);
        assert.equal(h.context.pendingSettingsPatches.size, 0);
        assert.deepEqual(h.counts(), { reloads: 1, renders: 1, successfulWrites: 0 });
        assert.deepEqual(h.reported, [h.error]);
        assert.equal(h.logged.length, 1, 'central saveSettings reports the error once');
        assert.equal(h.logged[0][1], h.error);
        assert.equal(rejection, undefined, 'DOM change handler must consume the save rejection');
      });
    }
  }

  test(`${scenario.name}: successful save preserves the requested patch`, async () => {
    const h = setup(scenario);
    await assert.doesNotReject(h.els[scenario.input].events.change());
    assert.deepEqual(h.patches, [scenario.patch]);
    const next = { ...h.persisted, ...scenario.patch };
    assert.equal(h.els.claudeRemoteMirrorsInput.checked, next.claudeRemoteMirrorsExcluded);
    assert.equal(h.els.wslScanInput.checked, next.wslScanEnabled && !next.claudeRemoteMirrorsExcluded);
    assert.equal(h.context.pendingSettingsPatches.size, 0);
    assert.deepEqual(h.counts(), { reloads: 0, renders: 0, successfulWrites: 1 });
    assert.equal(h.logged.length, 0);
    assert.equal(h.reported.length, 0);
  });
}
