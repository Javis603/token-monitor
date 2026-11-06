'use strict';
// Isolated production plugin runtime/renderer adapter, synthetic limits, no real collectors.
const { app, BrowserWindow, ipcMain, session, utilityProcess, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
// Fixture-only host model; package.json on disk and production checks stay unchanged.
const fixtureApp = require('../package.json');
fixtureApp.version = '0.82.0';
const { createPluginRuntime, registerPluginScheme } = require('../src/electron/plugins/runtime');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-quota-alerts-ui-'));
const evidence = path.join(root, 'artifacts/quota-alerts/0.1.0');
const archive = path.join(scratch, 'quota-alerts.tmplugin');
require('./build-plugin-package').main([path.join(root, 'plugins/quota-alerts'), archive]);
app.setPath('userData', path.join(scratch, 'profile'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
registerPluginScheme(protocol);
app.on('window-all-closed', () => {});
let runtime;
const notices = [], errors = [], checks = [];
const deadline = setTimeout(() => { console.error('Quota alerts fixture deadline'); app.exit(1); }, 60000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 120; i++) { if (await check()) return; await pause(40); }
  throw Error(`Timed out: ${label}`);
}
function record(label) { checks.push(label); console.log(`PASS ${label}`); }
async function finish(code) {
  await runtime?.dispose();
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  clearTimeout(deadline);
  fs.rmSync(scratch, { recursive: true, force: true });
  app.exit(code);
}
app.whenReady().then(async () => {
  let settings = { pluginsEnabled: true, pluginStates: {}, language: 'en', reduceMotion: 'off' };
  const control = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'src/electron/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  app.on('web-contents-created', (_event, contents) => contents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning') && !message.includes('Autofill.')) errors.push(message);
  }));
  const fixtureSession = { defaultSession: session.defaultSession, fromPartition: () => ({
    fetch: async () => new Response(JSON.stringify({ format: 1, title: 'Fixture catalog', plugins: [] }))
  }) };
  runtime = createPluginRuntime({ electron: { BrowserWindow, ipcMain, session: fixtureSession, utilityProcess,
    Notification: class extends EventEmitter { static isSupported() { return true; } constructor(value) { super(); this.value = value; } show() { notices.push(this.value); queueMicrotask(() => this.emit('show')); } },
    dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: false, filePaths: [archive] }) } },
    userDataDir: scratch, getSettings: () => settings, getAppSettings: () => settings, getLocale: () => settings.language, getContext: () => ({ source: 'synthetic-fixture' }),
    isMainSender: event => event.sender === control.webContents,
    persistPluginStates: pluginStates => { settings = { ...settings, pluginStates }; },
    persistManagementSettings: patch => { settings = { ...settings, ...patch }; },
    applySettingsPatch: patch => { settings = { ...settings, ...patch }; }, env: {}, log: console.log });
  await runtime.start(); await control.loadURL('about:blank');
  const js = source => control.webContents.executeJavaScript(source);
  const preview = await js("tokenMonitor.plugins.importPackage('file')");
  await js(`tokenMonitor.plugins.install(${JSON.stringify(preview.token)})`);
  assert.equal(runtime.manager.backendCount(), 0);
  const installed = await js('tokenMonitor.plugins.list()');
  assert.equal(installed.plugins[0].status, process.argv.includes('--plugins-safe-mode') ? 'safeMode' : 'disabled');
  await js("tokenMonitor.plugins.setEnabled('quota-alerts',true,{background:false})");
  assert.equal(runtime.manager.backendCount(), 0);
  record('package installs disabled; explicit enable without demand stays idle');
  if (process.argv.includes('--plugins-safe-mode')) {
    await assert.rejects(js("tokenMonitorTrustedPlugins.call('quota-alerts','status')"));
    assert.equal(runtime.manager.backendCount(), 0);
    record('external safe mode prevents plugin execution');
    await finish(0); return;
  }
  let lastObservation = Date.now();
  const observationTime = () => new Date(lastObservation = Math.max(Date.now(), lastObservation + 1)).toISOString();
  const publish = (remaining, second = 65) => runtime.publishStats({ updatedAt: new Date().toISOString(), limits: { providers: [
    { provider: 'codex', accountKey: 'synthetic-A', accountLabel: 'Fixture account A', status: 'ok', updatedAt: observationTime(), windows: [
      { kind: 'session', remainingPercent: remaining, resetsAt: new Date(Date.now() + 7200000).toISOString() },
      { kind: 'weekly', remainingPercent: 48, resetsAt: new Date(Date.now() + 86400000).toISOString() }] },
    { provider: 'claude', accountKey: 'synthetic-B', status: 'ok', updatedAt: observationTime(), windows: [
      { kind: 'session', remainingPercent: second, resetsAt: new Date(Date.now() + 3600000).toISOString() }] }
  ] } });
  publish(7);
  // A minimal settings shell uses the production same-page author adapter.
  // Full native plugin-management click-through is separate acceptance.
  const fixtureHtml = path.join(scratch, 'settings.html');
  fs.writeFileSync(fixtureHtml, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quota settings fixture</title></head><body style="font:14px system-ui;color:#eee;background:#24272c"><main id="mount"></main></body></html>');
  await control.loadFile(fixtureHtml); control.setSize(520, 820); control.show();
  await js(fs.readFileSync(path.join(root, 'src/electron/renderer/pluginUi.js'), 'utf8'));
  await js(`window.fixtureHost=TokenMonitorPluginUi.createHost({document,window,bridge:tokenMonitorTrustedPlugins,onError:error=>console.error(error.message)});
    tokenMonitor.plugins.setDemand('settings',['quota-alerts/panel']);
    tokenMonitorTrustedPlugins.views('settings').then(payload=>fixtureHost.mount(document.getElementById('mount'),payload.views['quota-alerts/panel'],{surface:'settings'}));`);
  await waitFor(() => js("document.querySelector('[name=lowQuota]')?.disabled===false"), 'settings preferences');
  fs.mkdirSync(evidence, { recursive: true });
  const screenshot = async name => {
    // DOM language updates can precede Chromium's submitted frame.
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(evidence, name), (await control.webContents.capturePage()).toPNG());
  };
  assert.equal(await js("document.querySelector('[name=lowQuota]').getAttribute('role')"), 'switch');
  assert.equal(await js("document.querySelectorAll('.qa-settings input').length"), 3);
  assert.equal(await js("document.querySelectorAll('.qa-settings button').length"), 1);
  await screenshot('before.png');
  assert.equal(await js("document.querySelector('[data-channel=os]').disabled"), false);
  const beforeTest = await js("tokenMonitorTrustedPlugins.call('quota-alerts','preferences.get')");
  await js("document.querySelector('[data-channel=os]').click()");
  await waitFor(() => notices.length === 1, 'manual test with both automatic alerts off');
  await waitFor(() => js("document.querySelector('[data-channel=os]').disabled===false"), 'manual test completion');
  assert.deepEqual(await js("tokenMonitorTrustedPlugins.call('quota-alerts','preferences.get')"), beforeTest);
  record('manual test works with both alerts off and does not change preferences');
  await js("document.querySelector('[name=lowQuota]').click()");
  await waitFor(async () => (await js("tokenMonitorTrustedPlugins.call('quota-alerts','preferences.get')")).values.lowQuota, 'immediate save');
  await screenshot('after.png');
  await waitFor(() => notices.length === 2, 'low-quota opt-in delivers without an extra switch');
  record('desktop-only settings autosave; low-quota opt-in immediately delivers through mock notify');
  const { messages } = await import('../plugins/quota-alerts/i18n.mjs');
  for (const [locale, dictionary] of Object.entries(messages)) {
    await js(`document.documentElement.lang=${JSON.stringify(locale)}`);
    await waitFor(() => js(`document.querySelector('[name=recovery]').parentElement.textContent.includes(${JSON.stringify(dictionary.recovery)})`), locale);
    await screenshot(`locale-${locale}.png`);
  }
  await js("document.documentElement.lang='en'");
  const patchPreferences = async patch => {
    const prefs = await js("tokenMonitorTrustedPlugins.call('quota-alerts','preferences.get')");
    return js(`tokenMonitorTrustedPlugins.call('quota-alerts','preferences.update',${JSON.stringify({ expectedRevision: prefs.revision, patch })})`);
  };
  await waitFor(() => notices.length === 2, 'intercepted OS notification');
  await js("tokenMonitorTrustedPlugins.call('quota-alerts','refresh')"); assert.equal(notices.length, 2);
  publish(10); await js("tokenMonitorTrustedPlugins.call('quota-alerts','refresh')");
  publish(2); await js("tokenMonitorTrustedPlugins.call('quota-alerts','refresh')"); assert.equal(notices.length, 3);
  await patchPreferences({ lowQuota: false, recovery: true });
  publish(99); await js("tokenMonitorTrustedPlugins.call('quota-alerts','refresh')"); assert.equal(notices.length, 4);
  publish(100); await js("tokenMonitorTrustedPlugins.call('quota-alerts','refresh')"); assert.equal(notices.length, 5);
  await js("tokenMonitorTrustedPlugins.call('quota-alerts','refresh')"); assert.equal(notices.length, 5);
  await screenshot('recovery-settings.png');
  fs.writeFileSync(path.join(evidence, 'notification-examples.json'), JSON.stringify({ mocked: true, notices }, null, 2));
  record('six settings locales; formal notify mocked; independent recovery/full transitions and repeated-reading dedup');
  await js("tokenMonitor.plugins.setBackground('quota-alerts',true)");
  await js("fixtureHost.dispose().then(()=>tokenMonitor.plugins.setDemand('settings',[]))");
  control.hide(); await pause(100); assert.equal(runtime.manager.backendCount(), 1);
  await js("tokenMonitor.plugins.setBackground('quota-alerts',false)");
  await waitFor(() => runtime.manager.backendCount() === 0, 'background opt-out');
  await js("tokenMonitor.plugins.setEnabled('quota-alerts',false)");
  assert.equal(runtime.manager.backendCount(), 0);
  assert.deepEqual(errors, []);
  record('background is host-controlled; settings adapter disposal and final demand stop');
  fs.writeFileSync(path.join(evidence, 'ui-checks.json'), JSON.stringify({ fixture: 'production runtime and author adapter in a synthetic settings shell', fixtureAppVersion: fixtureApp.version, checks, mockedOsNotifications: notices.length, realOutboundNotifications: 0 }, null, 2));
  await finish(0);
}).catch(async error => { console.error(error); await finish(1); });
