'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { notchSummaryMode } = require('../../src/electron/notch/data');

const rendererDir = path.join(__dirname, '../../src/electron/renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');

function controls(platform, enabled) {
  const node = () => ({ checked: false, hidden: false, classList: { toggle(_key, hidden) { this.hidden = hidden; } } });
  const els = { edgeDockInput: node(), notchFeature: node(), notchOptions: node(), notchInput: node(),
    notchWarnColorsInput: node(), edgeDockWarnColorsInput: node(),
    notchShapeInputs: [], edgeDockModeInputs: [], edgeDockSideInputs: [] };
  const state = { appInfo: { platform }, settings: { notchEnabled: enabled } };
  const patches = [];
  const context = { els, state, edgeDockAvailable: () => platform !== 'linux',
    t: key => key,
    renderNotchPageChoices() {}, syncDockSizeControls() {}, syncEdgeDockMacBackdropInput() {}, syncNotchStyleInput() {}, syncNotchCapabilities() {}, syncNotchHoverControls() {},
    saveSettings: patch => patches.push(JSON.parse(JSON.stringify(patch))), refreshTrayComposers() {}, notchItemsComposer: null, edgeDockComposer: null };
  const source = app.slice(app.indexOf('function syncDockControls()'), app.indexOf('function createDockItemsComposer('));
  vm.runInNewContext(source, context);
  return { ...context, patches };
}

test('Notch has one opt-in switch under Window alongside the other floating surfaces', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const windowSettings = html.slice(html.indexOf('id="windowSettingsDetails"'), html.indexOf('id="appearanceSettingsDetails"'));
  assert.equal((html.match(/id="notchInput"/g) || []).length, 1);
  assert.match(windowSettings, /id="edgeDockFeature"[\s\S]*id="notchFeature"[\s\S]*id="floatingBubbleOptions"/);
  assert.match(windowSettings, /settings\.notch\.title/);
  assert.match(windowSettings, /id="notchInput"[\s\S]*id="notchOptions"/);
  assert.doesNotMatch(html, /experimentalFeaturesGroup|notchExperimentalNote|settings\.notch\.experimentalTitle/);
});

test('Notch entry is macOS-only and detailed controls require explicit enablement', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const enabled of [undefined, false, true]) {
      const f = controls(platform, enabled);
      f.syncDockControls();
      const active = platform === 'darwin' && enabled === true;
      assert.equal(f.els.notchFeature.classList.hidden, platform !== 'darwin');
      assert.equal(f.els.notchOptions.classList.hidden, !active);
      assert.equal(f.els.notchInput.checked, active);
      assert.equal(f.state.settings.notchEnabled, enabled, 'visibility never rewrites saved preferences');
      assert.equal(f.patches.length, 0);
    }
  }
});

test('the Notch switch uses the existing preference and immediately shows or hides its details', () => {
  const f = controls('darwin', false);
  let change;
  f.els.notchInput.addEventListener = (event, handler) => { assert.equal(event, 'change'); change = handler; };
  const start = app.indexOf("els.notchInput?.addEventListener('change'");
  vm.runInNewContext(app.slice(start, app.indexOf('for (const input of els.notchShapeInputs)', start)), f);
  for (const enabled of [true, false, true]) {
    f.els.notchInput.checked = enabled;
    change();
    assert.equal(f.els.notchOptions.classList.hidden, !enabled);
    assert.deepEqual(f.patches.at(-1), { notchEnabled: enabled });
  }
});

test('Notch warning colour control defaults off and saves independently of the side dock', () => {
  const f = controls('darwin', true);
  f.state.settings.edgeDockWarnColors = true;
  f.syncDockControls();
  assert.equal(f.els.notchWarnColorsInput.checked, false);
  assert.equal(f.els.edgeDockWarnColorsInput.checked, true);
  let change;
  f.els.notchWarnColorsInput.addEventListener = (_event, handler) => { change = handler; };
  const start = app.indexOf("els.notchWarnColorsInput?.addEventListener('change'");
  vm.runInNewContext(app.slice(start, app.indexOf('els.notchHideSummaryInFullScreenInput?', start)), f);
  for (const enabled of [true, false]) {
    f.els.notchWarnColorsInput.checked = enabled; change();
    assert.deepEqual(f.patches.at(-1), { notchWarnColors: enabled });
    Object.assign(f.state.settings, f.patches.at(-1));
    f.els.notchWarnColorsInput.checked = !enabled;
    f.syncDockControls();
    assert.equal(f.els.notchWarnColorsInput.checked, enabled, 'a settings push restores the saved value');
    assert.equal(f.els.edgeDockWarnColorsInput.checked, true);
  }
});

test('collapsed content choices save sessions-only mode and describe only the selected behaviour', () => {
  const f = controls('darwin', true);
  let change;
  f.els.notchSummaryModeInput = { value: '', addEventListener: (_event, handler) => { change = handler; } };
  f.els.notchSummaryModeNote = { dataset: {} };
  const start = app.indexOf("els.notchSummaryModeInput?.addEventListener('change'");
  vm.runInNewContext(app.slice(start, app.indexOf('els.edgeDockInput?', start)), f);
  for (const mode of ['sessions', 'tray', 'custom', 'auto']) {
    f.els.notchSummaryModeInput.value = mode;
    change();
    assert.deepEqual(f.patches.at(-1), { notchSummaryMode: mode });
    f.syncDockControls();
    const key = mode === 'auto' ? 'settings.notch.summaryModeNote' : `settings.notch.summaryMode.${mode}Note`;
    assert.equal(f.els.notchSummaryModeNote.dataset.i18n, key);
    assert.equal(f.els.notchSummaryModeNote.textContent, key);
  }
});

test('sessions is the default in settings loading, patching and the collapsed-content control', () => {
  const main = fs.readFileSync(path.join(rendererDir, '../main.js'), 'utf8');
  const defaults = main.slice(main.indexOf('function defaultSettings()'), main.indexOf('function readSettings()'));
  assert.match(defaults, /notchSummaryMode: 'sessions'/);
  const readStart = main.indexOf('    merged.notchSummaryMode =');
  const read = main.slice(readStart, main.indexOf('    merged.notchSummaryEnabled =', readStart));
  const patchStart = main.indexOf('      notchSummaryMode:', main.indexOf('function applySettingsPatch('));
  const patchSource = main.slice(patchStart, main.indexOf('      notchSummaryEnabled:', patchStart));
  for (const saved of [{}, { notchFollowTray: false }, { notchFollowTray: true },
    { notchSummaryMode: 'unknown' }, ...['auto', 'sessions', 'tray', 'custom'].map(notchSummaryMode => ({ notchSummaryMode }))]) {
    const expected = ['auto', 'sessions', 'tray', 'custom'].includes(saved.notchSummaryMode) ? saved.notchSummaryMode : 'sessions';
    const context = { merged: { notchSummaryMode: 'sessions', ...saved }, notchSummaryMode };
    vm.runInNewContext(read, context);
    assert.equal(context.merged.notchSummaryMode, expected);
    const next = vm.runInNewContext(`({${patchSource}})`, { settings: context.merged,
      patch: { notchFollowTray: false }, notchSummaryMode });
    assert.equal(next.notchSummaryMode, expected, 'an old flag does not rewrite the current choice');
  }
  const f = controls('darwin', true);
  f.els.notchSummaryModeInput = { value: '' };
  f.syncDockControls();
  assert.equal(f.els.notchSummaryModeInput.value, 'sessions');
});

test('floating Edge Dock leaves both edge radios available for an explicit docking choice', () => {
  for (const side of ['left', 'right']) {
    const f = controls('darwin', false);
    f.els.edgeDockSideInputs = ['left', 'right'].map(value => ({ value, checked: false }));
    f.state.settings.edgeDockSide = side;
    for (const floatingX of [0, 0.5, 1]) {
      f.state.settings.edgeDockFloatingX = floatingX;
      f.syncDockControls();
      assert.ok(f.els.edgeDockSideInputs.every(input => !input.checked), 'either radio can change while floating');
    }
    for (const floatingX of [null, undefined]) {
      f.state.settings.edgeDockFloatingX = floatingX;
      f.syncDockControls();
      assert.equal(f.els.edgeDockSideInputs.find(input => input.checked).value, side);
    }
  }
});
