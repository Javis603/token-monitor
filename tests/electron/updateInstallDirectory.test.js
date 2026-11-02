'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
const { appUpdateInstallSupport } = require('../../src/shared/appUpdater');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const configure = main.slice(main.indexOf('function configureNativeAppUpdater() {'), main.indexOf('async function checkAppUpdateProvider() {'));

function configuredUpdater({ platform = 'win32', isPackaged = true, env = {}, execPath } = {}) {
  const updater = new NsisUpdater(null, { version: '0.84.0', isPackaged });
  const context = vm.createContext({
    app: { isPackaged },
    process: { platform, env, execPath },
    path: platform === 'win32' ? path.win32 : path.posix,
    autoUpdater: updater,
    appUpdateInstallSupport,
    appUpdateNativeConfigured: false,
    require: () => ({ autoUpdater: new EventEmitter() }),
    observeUpdateInstallHandoff: () => true,
    console: { log() {} }
  });
  vm.runInContext(`${configure}\nconfigureNativeAppUpdater();`, context);
  return updater;
}

for (const directory of ['D:\\Token Monitor', 'C:\\Apps\\测试 空格\\Token Monitor']) {
  test(`Windows update passes the running directory to the NSIS installer: ${directory}`, () => {
    const updater = configuredUpdater({ execPath: `${directory}\\Token Monitor.exe` });
    const spawns = [];
    updater.downloadedUpdateHelper = { file: 'C:\\Update cache\\setup.exe', packageFile: null };
    updater.spawnLog = async (file, args) => { spawns.push({ file, args }); };

    assert.equal(updater.doInstall({ isSilent: true, isForceRunAfter: true, isAdminRightsRequired: false }), true);
    assert.deepEqual(spawns, [{
      file: 'C:\\Update cache\\setup.exe',
      args: ['--updated', '/S', '--force-run', `/D=${directory}`]
    }]);
  });
}

for (const options of [
  { platform: 'win32', isPackaged: false, execPath: 'C:\\dev\\electron.exe' },
  { platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Token-Monitor.exe' }, execPath: 'C:\\Temp\\extracted\\Token Monitor.exe' },
  { platform: 'darwin', execPath: '/Applications/Token Monitor.app/Contents/MacOS/Token Monitor' },
  { platform: 'linux', env: { APPIMAGE: '/opt/Token Monitor.AppImage' }, execPath: '/tmp/.mount_token/token-monitor' }
]) {
  test(`does not override installation directory for ${JSON.stringify(options)}`, () => {
    assert.equal(configuredUpdater(options).installDirectory, undefined);
  });
}
