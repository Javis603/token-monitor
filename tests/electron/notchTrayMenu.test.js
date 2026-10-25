'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { buildTrayMenuTemplate } = require('../../src/electron/tray');
const { translate } = require('../../src/electron/renderer/i18n');
const controller = require('../../src/electron/notch/controller');

const electronDir = path.join(__dirname, '../../src/electron');
const read = file => fs.readFileSync(path.join(electronDir, file), 'utf8');
const functionSource = (source, name, next) => source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
const notchMenu = (state = {}, options = {}) => buildTrayMenuTemplate({
  platform: 'darwin', state: { notchSupported: true, ...state }, ...options
}).find(item => item.label === 'Notch Panel');

test('Notch tray settings remain configurable while disabled and use runtime defaults', () => {
  const menu = notchMenu();
  assert.ok(menu?.submenu);
  assert.equal(menu.type, undefined);
  assert.equal(menu.submenu[0].checked, false);
  assert.deepEqual(menu.submenu.map(item => item.label || item.type), [
    'Show Notch Panel', 'separator', 'Hover to grow', 'Hover to open', 'separator',
    'Show collapsed summary', 'Hide summary in full screen', 'separator', 'Settings…'
  ]);
  assert.equal(menu.submenu.some(item => item.submenu), false);
  assert.deepEqual(menu.submenu.filter(item => item.type === 'radio').map(item => item.checked), [true, false]);
  assert.deepEqual(notchMenu({ notchHoverAction: 'open' }).submenu.filter(item => item.type === 'radio').map(item => item.checked), [false, true]);
  for (const platform of ['win32', 'linux']) {
    assert.equal(buildTrayMenuTemplate({ platform, state: { notchSupported: true } }).some(item => item.label === 'Notch Panel'), false);
  }
  assert.equal(buildTrayMenuTemplate({ platform: 'darwin' }).some(item => item.label === 'Notch Panel'), false);
});

test('Notch tray actions persist through main and update the next menu without altering custom content', () => {
  const settings = { notchEnabled: false, notchHoverDelay: 400, notchShape: 'pill', notchSize: 'custom', notchStyle: 'black', notchSummaryMode: 'custom', notchCustomScale: 1.15, notchCustomLayout: { items: ['saved'] }, notchItems: ['codex'], edgeDockEnabled: true };
  const events = [];
  const main = read('main.js');
  const context = {
    settings, ...controller,
    parseBoolean: (value, fallback) => typeof value === 'boolean' ? value : fallback,
    saveSettings: () => events.push('save'), pushSettingsToRenderer: () => events.push('sync')
  };
  vm.runInNewContext(functionSource(main, 'setNotchFromMenu', 'setWindowPresentationFromMenu'), context);
  const menu = notchMenu(settings, { onSetNotch: context.setNotchFromMenu });
  menu.submenu[0].click();
  menu.submenu.find(item => item.label === 'Hover to open').click();
  for (const item of menu.submenu.filter(item => item.type === 'checkbox').slice(1)) item.click();
  assert.equal(settings.notchEnabled, true);
  assert.equal(settings.notchHoverAction, 'open');
  assert.equal(settings.notchHoverDelay, 400);
  assert.equal(settings.notchShape, 'pill');
  assert.equal(settings.notchSize, 'custom');
  assert.equal(settings.notchStyle, 'black');
  assert.equal(settings.notchSummaryMode, 'custom');
  assert.equal(settings.notchSummaryEnabled, false);
  assert.equal(settings.notchHideSummaryInFullScreen, false);
  assert.equal(settings.notchCustomScale, 1.15);
  assert.deepEqual(settings.notchCustomLayout, { items: ['saved'] });
  assert.deepEqual(settings.notchItems, ['codex']);
  assert.equal(settings.edgeDockEnabled, true);
  assert.deepEqual(events, Array.from({ length: 4 }, () => ['save', 'sync']).flat());
  const rebuilt = notchMenu(settings);
  assert.equal(rebuilt.submenu[0].checked, true);
  assert.deepEqual(rebuilt.submenu.filter(item => item.type === 'radio').map(item => item.checked), [false, true]);
  context.setNotchFromMenu({ notchHoverAction: 'bad', notchShape: 'bad', notchSummaryMode: 'bad', notchSize: 'bad', edgeDockEnabled: false });
  assert.equal(settings.notchHoverAction, 'peek');
  assert.equal(settings.notchShape, 'pill');
  assert.equal(settings.notchSummaryMode, 'custom');
  assert.equal(settings.notchSize, 'custom');
  assert.equal(settings.edgeDockEnabled, true);
});

test('Notch quick settings translate every menu level in all supported locales', () => {
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'pt-BR']) {
    const keys = [];
    const menu = buildTrayMenuTemplate({ platform: 'darwin', state: { notchSupported: true }, translate: (key, params) => {
      keys.push(key);
      const label = translate(locale, key, params);
      assert.notEqual(label, key, `${locale}: ${key}`);
      return label;
    } });
    assert.ok(menu.some(item => item.label === translate(locale, 'settings.notch.title') && item.submenu));
    assert.ok(keys.includes('trayMenu.notchShow'));
  }
});

test('Notch Settings command reaches the renderer through the registered preload listener', () => {
  const ipcRenderer = new EventEmitter();
  const rendererWindow = {};
  vm.runInNewContext(read('preload.js'), {
    require: name => {
      assert.equal(name, 'electron');
      return {
        ipcRenderer,
        contextBridge: { exposeInMainWorld: (key, api) => { rendererWindow[key] = api; } }
      };
    }
  });

  const events = [];
  const element = () => ({ classList: { remove() {}, add() {} }, style: {} });
  const context = {
    window: rendererWindow,
    els: { settingsPanel: element(), shell: element(), notchFeature: { scrollIntoView: () => events.push('scroll') }, notchInput: { focus: () => events.push('focus') } },
    displaySettings: { open: id => events.push(['display', id]) },
    state: {}, syncSettingsForm: () => events.push('sync'), ensureServiceStatusTicker() {},
    setSettingsSectionExpanded: (...args) => events.push(args),
    setSettingsAccordionExpanded: (...args) => events.push(args.at(-1)),
    requestAnimationFrame: callback => callback()
  };
  const renderer = read('renderer/app.js');
  const registration = renderer.split('\n').find(line => line.startsWith('window.tokenMonitor.onOpenSettings?.('));
  assert.ok(registration, 'renderer must register its settings-open handler');
  vm.runInNewContext(`${functionSource(renderer, 'openSettingsPanel', 'openViewFromTray')}\n${registration}`, context);
  assert.equal(ipcRenderer.listenerCount('settings:open'), 1);

  const sent = [];
  const mainContext = {
    focusExistingWindow: () => sent.push('focus'),
    sendMainWindowEvent: (channel, section) => {
      sent.push([channel, section]);
      ipcRenderer.emit(channel, {}, section);
    }
  };
  vm.runInNewContext(functionSource(read('main.js'), 'openSettingsFromTray', 'openViewFromTray'), mainContext);
  notchMenu({}, { onOpenSettings: mainContext.openSettingsFromTray }).submenu.at(-1).click();
  assert.deepEqual(sent, ['focus', ['settings:open', 'notch']]);
  assert.deepEqual(events, ['sync', ['window', true], ['display', 'notch']]);

  events.length = 0;
  mainContext.openSettingsFromTray();
  assert.deepEqual(events, ['sync']);
});
