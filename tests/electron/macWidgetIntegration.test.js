'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(root, 'src', 'electron', 'main.js'), 'utf8');
const widgetSource = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'TokenMonitorWidget.swift'),
  'utf8'
);
const widgetBundleSource = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'TokenMonitorWidgetBundle.swift'),
  'utf8'
);
const widgetIntentSource = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetConfigurationIntent.swift'),
  'utf8'
);
const widgetTimelineSource = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetTimelineProvider.swift'),
  'utf8'
);
const widgetViewModelSource = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetViewModel.swift'),
  'utf8'
);
const widgetDashboardSource = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetDashboardViews.swift'),
  'utf8'
);
const widgetInfo = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'Info.plist'),
  'utf8'
);
const widgetProject = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget.xcodeproj', 'project.pbxproj'),
  'utf8'
);
const widgetBuildSource = fs.readFileSync(path.join(root, 'scripts', 'build-macos-widget.js'), 'utf8');
const widgetReloaderSource = fs.readFileSync(
  path.join(root, 'scripts', 'TokenMonitorWidgetReloader.swift'),
  'utf8'
);
const widgetLocalization = JSON.parse(fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'Localizable.xcstrings'),
  'utf8'
));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const {
  DEFAULT_APP_GROUP,
  DEFAULT_WIDGET_BUNDLE_ID,
  packageVersion,
  widgetBundleVersion,
  widgetVersions,
  resolveWidgetArchitecture,
  validateDistributionIdentifiers
} = require('../../scripts/build-macos-widget');
const {
  createBuilderConfig,
  widgetArtifactPaths
} = require('../../scripts/macos-packaging');
const { normalizeWidgetURLScheme } = require('../../src/shared/macWidgetConfig');
const {
  MAC_APP_MIN_VERSION,
  MAC_WIDGET_MIN_VERSION
} = require('../../src/shared/macSystemRequirements');
const { projectLimitStatsForDisplay } = require('../../src/electron/limitStatsPresentation');

function functionSource(name, nextName) {
  const start = mainSource.indexOf(`function ${name}(`);
  const end = mainSource.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} should precede ${nextName}`);
  return mainSource.slice(start, end);
}

function createWidgetArtifactRoot() {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-widget-artifacts-'));
  const paths = widgetArtifactPaths(artifactRoot);
  fs.mkdirSync(path.dirname(paths.extensionExecutable), { recursive: true });
  for (const filePath of [paths.entitlements, paths.extensionExecutable, paths.config, paths.reloader, paths.extensionEntitlements, paths.reloaderEntitlements]) {
    fs.writeFileSync(filePath, 'test');
  }
  return artifactRoot;
}

test('publishes projected stats to the macOS Widget on collection and presentation changes', () => {
  const start = mainSource.indexOf('function sendPush(payload, options = {})');
  const end = mainSource.indexOf('\nfunction statsHistoryRevision', start);
  assert.ok(start >= 0 && end > start, 'sendPush function should exist');
  const sendPush = mainSource.slice(start, end);
  assert.match(sendPush, /latestStats = payload\.data\.stats;\s+const visibleStats = electronPresentationStats\(latestStats\);/);
  assert.match(sendPush, /scheduleMacWidgetSnapshot\(visibleStats, options\.widgetProducerOwner\);/);
  assert.equal((mainSource.match(/scheduleMacWidgetSnapshot\(visibleStats, options\.widgetProducerOwner\)/g) || []).length, 1);
  const refreshStart = mainSource.indexOf('function refreshLimitStatsPresentation()');
  const refreshEnd = mainSource.indexOf('\nfunction sendMimoAccountsPush', refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, 'presentation refresh function should exist');
  assert.match(
    mainSource.slice(refreshStart, refreshEnd),
    /scheduleMacWidgetSnapshot\(visibleStats, captureMacWidgetProducerOwner\(\)\);/
  );
  assert.match(mainSource, /compactTokenUnits: settings\?\.compactTokenUnits/);
});

test('Widget producers carry lifetime ownership through the sendPush outlet', () => {
  for (const signature of [
    'function startSyncCollector()',
    'function startHostStats()',
    'function startLocalCollector()',
    'async function startStatsStream(options = {})',
    'async function refreshFromTray()'
  ]) {
    const start = mainSource.indexOf(signature);
    const end = mainSource.indexOf('\nfunction ', start + signature.length);
    assert.ok(start >= 0, `${signature} should exist`);
    const source = mainSource.slice(start, end === -1 ? mainSource.length : end);
    assert.match(source, /const widgetProducerOwner = captureMacWidgetProducerOwner\(\);/);
    assert.match(source, /sendPush\([\s\S]*\{ widgetProducerOwner \}\)/);
  }
});

test('Widget ownership advances producer lifetime only for mode transitions', () => {
  assert.match(
    mainSource,
    /function startMode\(\) \{\s*hubModeGeneration \+= 1;\s*advanceMacWidgetProducerAndSourceEpoch\(\);/
  );
  assert.match(
    mainSource,
    /const widgetHistorySourceChanged = previousRuntimeSettings\.historyEnabled !== settings\.historyEnabled;\s*if \(widgetHistorySourceChanged && !runtimeChange\.modeStructural\) \{\s*refreshMacWidgetHistorySource\(\);/
  );
  assert.match(
    mainSource,
    /reloadSnapshot: \(work, options\) => requestMacWidgetReload\(\{\s*widgetKind: work\.widgetKind,\s*isCurrent: options\.isCurrent,/
  );
});

test('production persisted history I/O forwards store warnings to the main-process logger', () => {
  const start = mainSource.indexOf('resolveHistory: (work) => resolveMacWidgetHistory({');
  const end = mainSource.indexOf('\n    prepareSnapshot:', start);
  assert.ok(start >= 0 && end > start, 'Widget history resolver wiring should exist');
  const resolverSource = mainSource.slice(start, end);
  assert.match(
    resolverSource,
    /loadCachedHistory: \(\) => readMacWidgetHistoryCache\(\s*work\.historyCachePath,\s*work\.owner\.sourceKey,\s*\{ logger: \(message\) => console\.warn\(message\) \}\s*\),/
  );
  assert.match(
    resolverSource,
    /saveCachedHistory: \(history\) => writeMacWidgetHistoryCache\(\s*work\.historyCachePath,\s*work\.owner\.sourceKey,\s*history,\s*\{ logger: \(message\) => console\.warn\(message\) \}\s*\)/
  );
});

function executeMacWidgetDemandWiring() {
  const demandStart = mainSource.indexOf('function ensureMacWidgetDemand()');
  const demandEnd = mainSource.indexOf('\nfunction captureMacWidgetWork(', demandStart);
  assert.ok(demandStart >= 0 && demandEnd > demandStart, 'ensureMacWidgetDemand should exist');
  const demandSource = mainSource.slice(demandStart, demandEnd);

  const state = {
    startCalls: 0,
    start() { this.startCalls += 1; }
  };
  const captured = [];
  const calls = { scheduled: [] };
  const {
    WIDGET_DEMAND_MARKER,
    WIDGET_DEMAND_PROVISIONAL_MARKER
  } = require('../../src/electron/macWidgetDemand');
  const context = vm.createContext({
    process: { platform: 'darwin' },
    path: path.posix,
    WIDGET_DEMAND_MARKER,
    WIDGET_DEMAND_PROVISIONAL_MARKER,
    macWidgetDemand: null,
    macWidgetConfiguration: () => ({
      snapshotPath: '/Users/acceptance/Library/Group Containers/group.com.tokenmonitor/snapshot.json'
    }),
    createMacWidgetDemandState: (options) => {
      captured.push(options);
      return state;
    },
    electronPresentationStats: (stats) => ({ projected: true, ...stats }),
    latestStats: { limits: { providers: [] } },
    scheduleMacWidgetSnapshot: (stats, producerOwner) => { calls.scheduled.push({ stats, producerOwner }); },
    captureMacWidgetProducerOwner: () => ({ epoch: 7 }),
    console
  });
  vm.runInContext(demandSource, context);
  vm.runInContext('ensureMacWidgetDemand()', context);
  return { context, captured, calls, state };
}

test('main wiring arms Widget demand from the app-group marker and gates snapshot work', () => {
  const execution = executeMacWidgetDemandWiring();
  assert.equal(execution.captured.length, 1);
  assert.equal(
    execution.captured[0].markerPath,
    '/Users/acceptance/Library/Group Containers/group.com.tokenmonitor/widget-demand'
  );
  assert.equal(
    execution.captured[0].provisionalMarkerPath,
    '/Users/acceptance/Library/Group Containers/group.com.tokenmonitor/widget-demand-provisional'
  );
  assert.equal(execution.state.startCalls, 1);

  vm.runInContext('ensureMacWidgetDemand()', execution.context);
  assert.equal(execution.captured.length, 1, 'second ensure must reuse the armed state');

  execution.captured[0].onActivation();
  assert.equal(execution.calls.scheduled.length, 1);
  assert.deepEqual(execution.calls.scheduled[0].producerOwner, { epoch: 7 });
  assert.equal(execution.calls.scheduled[0].stats.projected, true);
});

test('Widget demand gate, startup arm and quit stop are wired into the snapshot path', () => {
  const captureStart = mainSource.indexOf('function captureMacWidgetWork(');
  const captureEnd = mainSource.indexOf('\nfunction ensureMacWidgetSnapshotController', captureStart);
  const captureSource = mainSource.slice(captureStart, captureEnd);
  assert.match(captureSource, /if \(macWidgetDemand && !macWidgetDemand\.isInstalled\(\)\) return null;/);
  assert.match(captureSource, /activeCodexAccount: macWidgetActiveCodexAccount\(\),/);
  assert.match(mainSource, /activeCodexAccount: work\.activeCodexAccount,/);

  const demandStart = mainSource.indexOf('function ensureMacWidgetDemand()');
  const demandEnd = mainSource.indexOf('\nfunction captureMacWidgetWork', demandStart);
  const demandSource = mainSource.slice(demandStart, demandEnd);
  assert.match(demandSource, /const markerDirectory = path\.dirname\(widget\.snapshotPath\);/);
  assert.match(
    demandSource,
    /markerPath: path\.join\(markerDirectory, WIDGET_DEMAND_MARKER\),/
  );
  assert.match(
    demandSource,
    /provisionalMarkerPath: path\.join\(markerDirectory, WIDGET_DEMAND_PROVISIONAL_MARKER\),/
  );
  assert.match(
    demandSource,
    /onActivation: \(\) => \{\s*const visibleStats = electronPresentationStats\(latestStats\);\s*scheduleMacWidgetSnapshot\(visibleStats, captureMacWidgetProducerOwner\(\)\);/
  );
  assert.match(demandSource, /macWidgetDemand\.start\(\);/);

  const readyStart = mainSource.indexOf('app.whenReady().then(() => {');
  const readyEnd = mainSource.indexOf("ipcMain.handle('settings:get'", readyStart);
  const readySource = mainSource.slice(readyStart, readyEnd);
  assert.match(readySource, /ensureMacWidgetDemand\(\);\s*startMode\(\);/);

  const stopStart = mainSource.indexOf('function stopAll()');
  const stopEnd = mainSource.indexOf('\nfunction ', stopStart + 'function stopAll()'.length);
  const stopSource = mainSource.slice(stopStart, stopEnd === -1 ? mainSource.length : stopEnd);
  assert.match(stopSource, /macWidgetDemand\.stop\(\);\s*macWidgetDemand = null;/);
});

test('starts the runtime immediately and holds only Widget publication until host registration settles', () => {
  const readyStart = mainSource.indexOf('app.whenReady().then(() => {');
  const readyEnd = mainSource.indexOf("ipcMain.handle('settings:get'", readyStart);
  assert.ok(readyStart >= 0 && readyEnd > readyStart, 'ready callback should exist');
  const readySource = mainSource.slice(readyStart, readyEnd);
  const settingsIndex = readySource.indexOf('ensureSettingsLoaded();');
  const supportIndex = readySource.indexOf('const widgetRuntime = macWidgetRuntimeSupport({');
  const recoveryStartIndex = readySource.indexOf('const widgetRecovery = widgetRuntimeSupported');
  const windowIndex = readySource.indexOf('createWindow();');
  const modeIndex = readySource.indexOf('startMode();');
  const recoveryCompletionIndex = readySource.indexOf('void widgetRecovery.finally(() => {');
  assert.ok(settingsIndex >= 0 && supportIndex > settingsIndex && recoveryStartIndex > supportIndex);
  assert.ok(windowIndex > recoveryStartIndex);
  assert.ok(modeIndex > windowIndex && recoveryCompletionIndex > modeIndex);
  assert.doesNotMatch(readySource, /await widgetRecovery/);
  assert.match(
    readySource,
    /startMode\(\);\s*void widgetRecovery\.finally\(\(\) => \{\s*if \(widgetRecoveryAbort\) app\.removeListener\('before-quit', abortWidgetRecovery\);\s*if \(!widgetRecoveryAbort\?\.signal\.aborted\) \{\s*macWidgetPublicationReady = true;\s*macWidgetSnapshotController\?\.resume\(\);\s*\}\s*\}\);/
  );
  assert.match(mainSource, /let macWidgetPublicationReady = false;/);
  assert.match(
    mainSource,
    /createMacWidgetSnapshotController\(\{\s*startPaused: !macWidgetPublicationReady,/
  );
  assert.match(readySource, /platform: process\.platform/);
  assert.match(readySource, /runtimeSupported: true/);
  assert.match(readySource, /isPackaged: app\.isPackaged/);
  assert.match(readySource, /resourcesPath: process\.resourcesPath/);
  assert.match(readySource, /userDataPath: app\.getPath\('userData'\)/);
});

function executeMacWidgetRecoveryWiring(runtimeSupported = true) {
  const bootstrapStart = mainSource.indexOf('const widgetRuntime = macWidgetRuntimeSupport({');
  const recoveryCallEnd = mainSource.indexOf('\n  session.defaultSession', bootstrapStart);
  assert.ok(bootstrapStart >= 0 && recoveryCallEnd > bootstrapStart, 'recovery bootstrap should exist');
  const finallyStart = mainSource.indexOf('void widgetRecovery.finally(() => {');
  const finallyEnd = mainSource.indexOf('\n  });', finallyStart) + '\n  });'.length;
  assert.ok(finallyStart >= 0 && finallyEnd > finallyStart, 'recovery settle should exist');
  const script = `${mainSource.slice(bootstrapStart, recoveryCallEnd)}\n${mainSource.slice(finallyStart, finallyEnd)}`;

  let resolveRecovery;
  const recoveryPromise = new Promise((resolve) => { resolveRecovery = resolve; });
  const calls = { once: [], removeListener: [], resumed: 0 };
  let beforeQuitHandler;
  const context = vm.createContext({
    AbortController,
    Promise,
    console: { warn() {} },
    os: { release: () => (runtimeSupported ? '23.0.0' : '22.0.0') },
    process: { platform: 'darwin', resourcesPath: '/acceptance/resources' },
    app: {
      isPackaged: true,
      getPath: (name) => (name === 'userData' ? '/acceptance/user-data' : undefined),
      once: (event, handler) => { calls.once.push(event); beforeQuitHandler = handler; },
      removeListener: (event) => { calls.removeListener.push(event); }
    },
    recoverMacWidgetLaunchServicesRegistration: (options) => {
      calls.recoveryOptions = options;
      return recoveryPromise;
    },
    macWidgetRuntimeSupport: () => ({
      supported: runtimeSupported,
      reason: runtimeSupported ? null : 'unsupported-os'
    }),
    macWidgetPublicationReady: false,
    macWidgetSnapshotController: { resume: () => { calls.resumed += 1; } }
  });
  vm.runInContext(script, context);
  return {
    calls,
    context,
    fireBeforeQuit: () => beforeQuitHandler(),
    resolveRecovery,
    assertRecoveryOptions() {
      const options = calls.recoveryOptions;
      assert.ok(options, 'recovery should be invoked with the packaged wiring options');
      assert.equal(options.platform, 'darwin');
      assert.equal(options.runtimeSupported, true);
      assert.equal(options.isPackaged, true);
      assert.equal(options.resourcesPath, '/acceptance/resources');
      assert.equal(options.userDataPath, '/acceptance/user-data');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(typeof options.logger, 'function');
    }
  };
}

test('main wiring resumes Widget publication when host registration settles on any outcome', async () => {
  for (const outcome of [
    { status: 'completed' },
    { status: 'failed', reason: 'launch-failed' },
    { status: 'failed', reason: 'timed-out' },
    { status: 'skipped', reason: 'already-completed' }
  ]) {
    const execution = executeMacWidgetRecoveryWiring();
    execution.assertRecoveryOptions();
    assert.deepEqual(execution.calls.once, ['before-quit']);
    execution.resolveRecovery(outcome);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(execution.context.macWidgetPublicationReady, true, `${outcome.status} settle should unblock Widget publication`);
    assert.equal(execution.calls.resumed, 1, `${outcome.status} settle should resume the snapshot controller`);
    assert.deepEqual(execution.calls.removeListener, ['before-quit']);
  }
});

test('main wiring does not initialize Widget recovery below macOS 14', async () => {
  const execution = executeMacWidgetRecoveryWiring(false);
  assert.equal(execution.calls.recoveryOptions, undefined);
  assert.deepEqual(execution.calls.once, []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(execution.context.macWidgetPublicationReady, true);
  assert.equal(execution.calls.resumed, 1);
  assert.deepEqual(execution.calls.removeListener, []);
});

test('main wiring holds Widget publication when the app quits before registration settles', async () => {
  const execution = executeMacWidgetRecoveryWiring();
  execution.fireBeforeQuit();
  execution.resolveRecovery({ status: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(execution.context.macWidgetPublicationReady, false);
  assert.equal(execution.calls.resumed, 0);
  assert.deepEqual(execution.calls.removeListener, ['before-quit']);
});

test('Widget demand lease marker contract stays aligned between Swift and Electron', () => {
  const widgetDemandSource = fs.readFileSync(
    path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetDemandMarker.swift'),
    'utf8'
  );
  const providerSource = fs.readFileSync(
    path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetTimelineProvider.swift'),
    'utf8'
  );
  const {
    WIDGET_DEMAND_MARKER,
    WIDGET_DEMAND_PROVISIONAL_MARKER
  } = require('../../src/electron/macWidgetDemand');

  // The marker filenames are the one cross-process contract: Electron lstat's
  // them from the app group container and the extension writes them. They may
  // not drift.
  assert.match(widgetDemandSource, /static let fileName = "widget-demand"/);
  assert.equal(WIDGET_DEMAND_MARKER, 'widget-demand');
  assert.match(widgetDemandSource, /static let provisionalFileName = "widget-demand-provisional"/);
  assert.equal(WIDGET_DEMAND_PROVISIONAL_MARKER, 'widget-demand-provisional');

  // timeline() always records the full lease; snapshot() only writes the short
  // provisional lease outside the gallery preview; placeholder() must never
  // write either or a gallery browse would keep a nonexistent Widget's pipeline
  // warm forever.
  const factory = providerSource.slice(
    providerSource.indexOf('private enum WidgetTimelineFactory'),
    providerSource.indexOf('struct SummaryWidgetTimelineProvider')
  );
  assert.match(factory, /if let demandFileName \{[\s\S]*WidgetDemandMarker\.noteRequested\([\s\S]*fileName: demandFileName/);
  assert.match(factory, /static func timeline[\s\S]*demandFileName: WidgetDemandMarker\.fileName/);
  for (const provider of ['SummaryWidgetTimelineProvider', 'BreakdownWidgetTimelineProvider', 'DashboardWidgetTimelineProvider']) {
    const start = providerSource.indexOf(`struct ${provider}`);
    const end = providerSource.indexOf('\nstruct ', start + 8);
    const source = providerSource.slice(start, end < 0 ? undefined : end);
    const placeholder = source.slice(source.indexOf('func placeholder('), source.indexOf('func snapshot('));
    assert.doesNotMatch(placeholder, /WidgetDemandMarker/);
    assert.match(source, /demandFileName: context\.isPreview \? nil : WidgetDemandMarker\.provisionalFileName/);
  }

  // The marker compiles into both the extension and its test target.
  assert.match(widgetProject, /100000000000000000000010 \/\* WidgetDemandMarker\.swift in Sources \*\//);
  assert.match(widgetProject, /100000000000000000000011 \/\* WidgetDemandMarker\.swift in Sources \*\//);
});

test('LaunchServices recovery delegates current-host registration to the public native API', () => {
  const recoverySource = fs.readFileSync(
    path.join(root, 'src', 'electron', 'macWidgetLaunchServicesRecovery.js'),
    'utf8'
  );
  assert.match(recoverySource, /const REGISTER_HOST_ARGUMENTS = Object\.freeze\(\['--mode', 'register-host'\]\);/);
  assert.match(recoverySource, /REGISTER_HOST_ARGUMENTS/);
  assert.doesNotMatch(recoverySource, /lsregister|chronod|killall|pkill|\['-u'|\b-reset\b|\b-kill\b/);
  assert.match(widgetReloaderSource, /LSRegisterURL\(hostAppURL as CFURL, true\)/);
  assert.match(widgetReloaderSource, /Array\(CommandLine\.arguments\.dropFirst\(\)\) == \["--mode", "register-host"\]/);
  assert.match(widgetReloaderSource, /resourcesURL\.lastPathComponent == "Resources"/);
  assert.match(widgetReloaderSource, /contentsURL\.lastPathComponent == "Contents"/);
});

test('a history setting refresh projects local OpenCode quota before scheduling the Widget', () => {
  const rawStats = {
    limits: {
      providers: [{
        provider: 'opencode',
        accountKey: 'local-db',
        source: 'local',
        sourceDeviceId: 'local-device',
        status: 'ok',
        updatedAt: '2026-08-10T00:00:00.000Z',
        windows: [{ kind: 'session', source: 'local', usedPercent: 25 }]
      }]
    }
  };
  const owner = { epoch: 7 };
  let scheduled;
  const context = vm.createContext({
    advanceMacWidgetSourceEpoch() {},
    captureMacWidgetProducerOwner: () => owner,
    electronPresentationStats: (stats) => projectLimitStatsForDisplay(stats, {
      localDeviceId: 'local-device',
      syncActive: true,
      opencodeLocalLimitsEnabled: false
    }),
    latestStats: rawStats,
    scheduleMacWidgetSnapshot: (stats, producerOwner) => {
      scheduled = { stats, producerOwner };
    }
  });
  vm.runInContext(
    functionSource('refreshMacWidgetHistorySource', 'scheduleMacWidgetSnapshot'),
    context
  );
  vm.runInContext('refreshMacWidgetHistorySource()', context);

  assert.equal(scheduled.producerOwner, owner);
  assert.equal(scheduled.stats.limits.providers[0].status, 'disabled');
  assert.deepEqual(scheduled.stats.limits.providers[0].windows, []);
});

test('keeps Widget packaging opt-in and injects artifacts only after a successful build', () => {
  const normal = createBuilderConfig({
    baseConfig: packageJson.build,
    env: { TOKEN_MONITOR_WIDGET_ENABLED: '0' },
    root
  }).mac;
  assert.equal(normal.entitlements, undefined);
  assert.equal(normal.sign, undefined);
  assert.equal(normal.extraFiles, undefined);
  assert.equal(normal.extraResources, undefined);
  assert.equal(normal.extendInfo.CFBundleURLTypes, undefined);
  assert.equal(normal.minimumSystemVersion, MAC_APP_MIN_VERSION);
  assert.equal(packageJson.scripts.predistMac, undefined);
  assert.equal(packageJson.scripts['predist:mac'], undefined);

  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-widget-missing-'));
  assert.throws(() => createBuilderConfig({
    baseConfig: packageJson.build,
    env: { TOKEN_MONITOR_WIDGET_ENABLED: '1' },
    root: missingRoot
  }), /missing before electron-builder/);
  fs.rmSync(missingRoot, { recursive: true, force: true });

  const artifactRoot = createWidgetArtifactRoot();
  const widget = createBuilderConfig({
    baseConfig: packageJson.build,
    env: { TOKEN_MONITOR_WIDGET_ENABLED: '1' },
    root: artifactRoot
  }).mac;
  fs.rmSync(artifactRoot, { recursive: true, force: true });

  const mac = widget;
  assert.equal(mac.minimumSystemVersion, MAC_APP_MIN_VERSION);
  assert.deepEqual(mac.extendInfo.CFBundleURLTypes[0].CFBundleURLSchemes, ['token-monitor']);
  assert.equal(mac.extraFiles[0].to, 'PlugIns/TokenMonitorWidget.appex');
  assert.equal(mac.extraResources[0].to, 'token-monitor-widget.json');
  assert.equal(mac.extraResources[1].to, 'TokenMonitorWidgetReloader');
  assert.equal(mac.sign, 'scripts/sign-macos-with-widget.js');
  assert.match(packageJson.scripts['pack'], /electron-builder --config scripts\/electron-builder\.config\.js/);
  assert.match(packageJson.scripts['dist:mac:widget'], /TOKEN_MONITOR_WIDGET_DISTRIBUTION=1 TOKEN_MONITOR_WIDGET_ARCH=arm64 node scripts\/macos-packaging\.js/);
  assert.match(packageJson.scripts['dist:mac:widget'], /TOKEN_MONITOR_WIDGET_ENABLED=1 TOKEN_MONITOR_WIDGET_DISTRIBUTION=1 TOKEN_MONITOR_WIDGET_ARCH=arm64 electron-builder/);
  assert.match(packageJson.scripts['dist:mac:widget:x64'], /TOKEN_MONITOR_WIDGET_ARCH=x64/);
  assert.match(packageJson.scripts['pack:mac:widget:x64'], /--mac --x64 --dir/);
  assert.equal(packageJson.build.mac.minimumSystemVersion, MAC_APP_MIN_VERSION);
  assert.match(widgetProject, new RegExp(`MACOSX_DEPLOYMENT_TARGET = ${MAC_WIDGET_MIN_VERSION.replace('.', '\\.')}\\;`));
});

test('uses an Apple Development identity for Team App Groups in local Widget builds', () => {
  const artifactRoot = createWidgetArtifactRoot();
  try {
    const mac = createBuilderConfig({
      baseConfig: packageJson.build,
      env: {
        TOKEN_MONITOR_WIDGET_ENABLED: '1',
        TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING: '1',
        TOKEN_MONITOR_APP_GROUP: 'ABCDE12345.tokenmonitor',
        DEVELOPMENT_TEAM: 'ABCDE12345'
      },
      root: artifactRoot
    }).mac;
    assert.equal(mac.identity, 'Apple Development');

    const explicit = createBuilderConfig({
      baseConfig: packageJson.build,
      env: {
        TOKEN_MONITOR_WIDGET_ENABLED: '1',
        TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING: '1',
        TOKEN_MONITOR_APP_GROUP: 'ABCDE12345.tokenmonitor',
        DEVELOPMENT_TEAM: 'ABCDE12345',
        TOKEN_MONITOR_MAC_DEVELOPMENT_IDENTITY: 'Apple Development: Example'
      },
      root: artifactRoot
    }).mac;
    assert.equal(explicit.identity, 'Apple Development: Example');
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('preserves generic macOS packaging config and fails fast on signing ownership conflicts', () => {
  const baseMac = {
    minimumSystemVersion: '14.0',
    entitlements: 'build/base.entitlements',
    sign: 'scripts/base-sign.js',
    extraFiles: [{ from: 'base-file', to: 'base-file' }],
    extraResources: [{ from: 'base-resource', to: 'base-resource' }],
    extendInfo: { ExistingKey: 'kept' }
  };
  const disabled = createBuilderConfig({
    baseConfig: { mac: baseMac },
    env: { TOKEN_MONITOR_WIDGET_ENABLED: '0' },
    root
  }).mac;
  assert.deepEqual(disabled, baseMac);

  assert.throws(() => createBuilderConfig({
    baseConfig: { mac: baseMac },
    env: { TOKEN_MONITOR_WIDGET_ENABLED: '1' },
    root
  }), /owns entitlements and sign/);

  const artifactRoot = createWidgetArtifactRoot();
  try {
    const enabled = createBuilderConfig({
      baseConfig: {
        mac: {
          extraFiles: baseMac.extraFiles,
          extraResources: baseMac.extraResources,
          extendInfo: baseMac.extendInfo
        }
      },
      env: { TOKEN_MONITOR_WIDGET_ENABLED: '1' },
      root: artifactRoot
    }).mac;
    assert.equal(enabled.extendInfo.ExistingKey, 'kept');
    assert.deepEqual(enabled.extraFiles.map((entry) => entry.to), ['base-file', 'PlugIns/TokenMonitorWidget.appex']);
    assert.deepEqual(enabled.extraResources.map((entry) => entry.to), ['base-resource', 'token-monitor-widget.json', 'TokenMonitorWidgetReloader']);
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('supports an isolated local Widget URL scheme without changing the release default', () => {
  assert.match(mainSource, /parseMacWidgetDeepLink\(url, urlScheme\)/);
  assert.match(widgetSource, /static let urlScheme: String/);
  assert.match(widgetInfo, /<key>TokenMonitorURLScheme<\/key>/);
  assert.match(packageJson.scripts['pack:mac:widget'], /TOKEN_MONITOR_WIDGET_ENABLED=1/);
});

test('canonicalizes Widget URL schemes and rejects unsafe values', () => {
  assert.equal(normalizeWidgetURLScheme('Token-Monitor+Preview'), 'token-monitor+preview');
  assert.equal(normalizeWidgetURLScheme(''), 'token-monitor');
  assert.throws(() => normalizeWidgetURLScheme('https://example.test'), /unsupported characters/);
  assert.throws(() => normalizeWidgetURLScheme('widget scheme'), /unsupported characters/);
});

test('uses AppIntent configuration and page-specific deep links', () => {
  assert.match(widgetSource, /AppIntentConfiguration\(/);
  assert.match(widgetSource, /url\(for: entry\.page\)/);
  assert.match(widgetSource, /StaticConfiguration\(kind: TokenMonitorWidgetConfiguration\.activityKind/);
  assert.match(widgetSource, /AppIntentConfiguration\(kind: TokenMonitorWidgetConfiguration\.quotaKind, intent: QuotaWidgetIntent\.self/);
  assert.doesNotMatch(widgetBundleSource, /TokenMonitorLegacyQuotaWidget/);
  assert.match(widgetBundleSource, /TokenMonitorQuotaWidget\(\)/);
  assert.match(widgetSource, /static let legacyQuotaKind = "\\\(kind\)\.quota"/);
  assert.match(widgetSource, /static let quotaKind = "\\\(kind\)\.quota\.v2"/);
  assert.match(widgetReloaderSource, /"\\\(kind\)\.quota\.v2"/);
  assert.match(widgetSource, /com\.tokenmonitor\.dashboard/);
});

test('each Widget configuration exposes only choices that its composition supports', () => {
  const summaryIntent = widgetIntentSource.slice(
    widgetIntentSource.indexOf('struct UsageSummaryWidgetIntent'),
    widgetIntentSource.indexOf('struct BreakdownWidgetIntent')
  );
  const breakdownIntent = widgetIntentSource.slice(
    widgetIntentSource.indexOf('struct BreakdownWidgetIntent'),
    widgetIntentSource.indexOf('struct TrendWidgetIntent')
  );
  const dashboardIntent = widgetIntentSource.slice(
    widgetIntentSource.indexOf('struct DashboardWidgetIntent'),
    widgetIntentSource.indexOf('enum WidgetPeriod')
  );
  const periodEnum = widgetIntentSource.slice(
    widgetIntentSource.indexOf('enum WidgetPeriod'),
    widgetIntentSource.indexOf('enum WidgetPeriodPolicy')
  );
  assert.match(summaryIntent, /@Parameter\(title: "Period", default: \.day\)/);
  assert.doesNotMatch(summaryIntent, /Display Page|Breakdown/);
  assert.match(breakdownIntent, /@Parameter\(title: "Breakdown", default: \.tools\)/);
  assert.match(breakdownIntent, /@Parameter\(title: "Period", default: \.day\)/);
  assert.doesNotMatch(breakdownIntent, /Display Page/);
  assert.match(dashboardIntent, /@Parameter\(title: "Breakdown", default: \.models\)/);
  assert.match(dashboardIntent, /@Parameter\(title: "Period", default: \.day\)/);
  assert.match(dashboardIntent, /@Parameter\(title: "Quota 1"\)/);
  assert.match(dashboardIntent, /@Parameter\(title: "Quota 2"\)/);
  const quotaIntent = widgetIntentSource.slice(
    widgetIntentSource.indexOf('struct QuotaWidgetIntent'),
    widgetIntentSource.indexOf('struct WidgetQuotaSelection')
  );
  assert.match(quotaIntent, /var primaryQuota: WidgetQuotaSelection\?/);
  assert.match(quotaIntent, /var secondaryQuota: WidgetSecondaryQuotaSelection\?/);
  assert.match(widgetIntentSource, /func defaultResult\(\) async -> WidgetQuotaSelection\?/);
  assert.match(widgetIntentSource, /func defaultResult\(\) async -> WidgetSecondaryQuotaSelection\?/);
  assert.match(widgetIntentSource, /filter \{ \$0\.id != WidgetQuotaSelectionID\.currentCodexAccount \}[\s\S]*\.dropFirst\(\)[\s\S]*\.first/);
  const quotaCatalog = widgetIntentSource.slice(
    widgetIntentSource.indexOf('private enum WidgetQuotaSelectionCatalog'),
    widgetIntentSource.indexOf('enum WidgetPeriod')
  );
  assert.match(quotaCatalog, /providerCounts\[provider\.provider, default: 0\] > 1/);
  assert.match(quotaCatalog, /if let accountLabel = provider\.accountLabel, !accountLabel\.isEmpty/);
  assert.match(quotaCatalog, /codexProviders\.count > 1/);
  assert.match(quotaCatalog, /String\(localized: "Current Account"\)/);
  assert.match(widgetIntentSource, /WidgetQuotaSelectionID\.currentCodexAccount/);
  assert.match(widgetViewModelSource, /\$0\.isCurrentAccount/);
  assert.match(periodEnum, /\.day: DisplayRepresentation\(title: "Day"\)/);
  assert.match(periodEnum, /\.month: DisplayRepresentation\(title: "Month"\)/);
  assert.match(periodEnum, /\.total: DisplayRepresentation\(title: "Total"\)/);
  assert.doesNotMatch(periodEnum, /subtitle:/);
  assert.match(widgetTimelineSource, /configuration\.breakdown\.page/);
  assert.doesNotMatch(widgetSource, /CycleWidgetPeriodIntent|SetWidgetPeriodIntent/);
  assert.doesNotMatch(widgetSource, /onTapGesture/);
  assert.doesNotMatch(widgetSource, /TOKEN_MONITOR_WIDGET_KIND.*v4|v3-temp|dev/);
});

test('Widget page empty states are scoped to the selected page', () => {
  const contentStart = widgetSource.indexOf('private func content(_ snapshot: WidgetSnapshot)');
  const contentEnd = widgetSource.indexOf('\n    private func small', contentStart);
  const contentSource = widgetSource.slice(contentStart, contentEnd);
  assert.doesNotMatch(contentSource, /snapshot\.isEmpty/);

  const overviewStart = widgetSource.indexOf('private func overview(');
  const overviewEnd = widgetSource.indexOf('\n    private func quota(', overviewStart);
  const overviewSource = widgetSource.slice(overviewStart, overviewEnd);
  assert.match(overviewSource, /snapshot\.overview\.totalTokens == 0/);
  assert.match(overviewSource, /snapshot\.models\.isEmpty/);
  assert.match(overviewSource, /snapshot\.activity\.activeDays == 0/);

  const quotaStart = widgetSource.indexOf('private func quota(');
  const quotaEnd = widgetSource.indexOf('\n    private func models(', quotaStart);
  assert.match(widgetSource.slice(quotaStart, quotaEnd), /snapshot\.quota\.count/);
  const modelsStart = widgetSource.indexOf('private func models(');
  const modelsEnd = widgetSource.indexOf('\n    private func activity(', modelsStart);
  assert.match(widgetSource.slice(modelsStart, modelsEnd), /snapshot\.models\.count/);
  const activityStart = widgetSource.indexOf('private func activity(');
  const activityEnd = widgetSource.indexOf('\n    private func trend(', activityStart);
  assert.ok(activityEnd > activityStart);
  assert.match(widgetSource, /No activity data/);
  const trendStart = widgetSource.indexOf('private func trend(');
  const trendEnd = widgetSource.indexOf('\n    private func statusState', trendStart);
  assert.ok(trendEnd > trendStart);
  assert.match(widgetSource, /snapshot\.trend\.points\.isEmpty/);
});

test('Widget canvas omits brand and navigation chrome', () => {
  assert.doesNotMatch(widgetSource, /Text\("Σ"\)/);
  assert.doesNotMatch(widgetSource, /struct WidgetPageControl: View/);
  assert.doesNotMatch(widgetIntentSource, /struct CycleWidgetPageIntent: AppIntent/);
  assert.doesNotMatch(widgetSource, /Image\(systemName: "arrow\.up\.right"\)/);
  assert.match(widgetSource, /Text\(page\.title\)/);
  assert.match(widgetSource, /\.widgetURL\(TokenMonitorWidgetConfiguration\.url\(for: entry\.page\)\)/);
});

test('each Widget family has a purpose-built composition', () => {
  assert.match(widgetSource, /SmallUsageWidgetView\(snapshot: snapshot, period: entry\.period\)/);
  assert.match(widgetSource, /MediumUsageWidgetView\(/);
  assert.match(widgetSource, /LargeDashboardWidgetView\(/);
  assert.match(widgetDashboardSource, /struct SmallUsageWidgetView: View/);
  assert.match(widgetDashboardSource, /struct MediumUsageWidgetView: View/);
  assert.match(widgetDashboardSource, /struct LargeDashboardWidgetView: View/);
  assert.match(widgetDashboardSource, /SmoothTrendChart\(points: snapshot\.trend\.points\)/);
  assert.match(widgetDashboardSource, /DashboardActivityModule\(/);
  assert.match(widgetDashboardSource, /ActivityHeatmapWithMonthLabels\(/);
  assert.match(widgetDashboardSource, /maxWeeks: 26/);
  assert.match(widgetDashboardSource, /DashboardQuotaProviderRow\([\s\S]{0,160}provider: provider,[\s\S]{0,160}showAccountLabel:/);
  assert.match(widgetDashboardSource, /selectedIDs: selectedProviderIDs,\s*limit: 2/);
  assert.match(widgetDashboardSource, /WidgetVendorMark\(vendorID: row\.vendorID/);
  assert.match(widgetDashboardSource, /QuotaWindowCell\(window: window/);
  const mediumBreakdownSource = widgetDashboardSource.slice(
    widgetDashboardSource.indexOf('struct MediumBreakdownModule'),
    widgetDashboardSource.indexOf('struct BreakdownRow')
  );
  assert.match(mediumBreakdownSource, /ForEach\(0\.\.<4/);
  assert.match(mediumBreakdownSource, /let rowHeight = proxy\.size\.height \/ 4/);
  assert.match(mediumBreakdownSource, /visibleRows\.indices\.contains\(index\)/);
  assert.doesNotMatch(mediumBreakdownSource, /Spacer\(/);
  assert.match(widgetDashboardSource, /Text\(WidgetFormat\.tokens\(snapshot\.overview\.totalTokens[\s\S]{0,180}weight: \.semibold\)\)[\s\S]{0,80}\.monospacedDigit\(\)/);
  const smallUsageSource = widgetDashboardSource.slice(
    widgetDashboardSource.indexOf('struct SmallUsageWidgetView'),
    widgetDashboardSource.indexOf('struct MediumUsageWidgetView')
  );
  assert.match(smallUsageSource, /size: 37, weight: \.semibold/);
  assert.match(widgetDashboardSource, /\(width\|height\)=\["'\]1em\["'\]/);
});

test('macOS Widget packaging keeps the canonical Token Monitor app identity', () => {
  assert.equal(packageJson.scripts['mac:local'], undefined);
  assert.equal(packageJson.scripts['mac:local:open'], undefined);
  assert.equal(packageJson.productName, 'Token Monitor');
  assert.equal(packageJson.build.productName, 'Token Monitor');
});

test('Widget build provenance fields are injected into the extension Info.plist', () => {
  for (const key of [
    'TMWidgetGitRevision',
    'TMWidgetBuildTimestamp',
    'TMWidgetSchemaVersion',
    'TMWidgetUIVersion',
    'TMWidgetKind'
  ]) {
    assert.match(widgetInfo, new RegExp(`<key>${key}</key>`));
  }
  assert.match(widgetProject, /TOKEN_MONITOR_WIDGET_KIND = com\.tokenmonitor\.dashboard;/);
  assert.match(widgetProject, /TOKEN_MONITOR_WIDGET_GIT_REVISION = unknown;/);
  assert.match(widgetBuildSource, /const WIDGET_UI_VERSION = 32;/);
  assert.match(widgetBuildSource, /const WIDGET_SCHEMA_VERSION = 8;/);
  assert.equal(packageVersion(), packageJson.version);
  assert.match(widgetProject, /MARKETING_VERSION = "\$\(TOKEN_MONITOR_MARKETING_VERSION\)";/);
  assert.match(widgetProject, /CURRENT_PROJECT_VERSION = "\$\(TOKEN_MONITOR_BUNDLE_VERSION\)";/);
  assert.match(widgetBuildSource, /xcconfigLine\('MARKETING_VERSION', versions\.marketingVersion\)/);
  assert.match(widgetInfo, /<key>TMWidgetSchemaVersion<\/key>\s*<string>8<\/string>/);
  assert.match(widgetInfo, /<key>TMWidgetUIVersion<\/key>\s*<string>\$\(TOKEN_MONITOR_WIDGET_UI_VERSION\)<\/string>/);
  assert.match(widgetProject, /TOKEN_MONITOR_WIDGET_UI_VERSION = 0;/);
  assert.match(widgetBuildSource, /xcconfigLine\('TOKEN_MONITOR_WIDGET_UI_VERSION', WIDGET_UI_VERSION\)/);
});

test('keeps marketing and bundle versions numeric across release channels', () => {
  for (const version of ['1.2.3', '1.2.3-beta.4', '1.2.3-rc.1', '1.2.3+build.9']) {
    assert.deepEqual(widgetVersions(version), {
      packageVersion: version,
      marketingVersion: '1.2.3',
      bundleVersion: '1.2.3'
    });
  }
});

test('uses the Widget UI revision as the local build number so WidgetKit reindexes descriptors', () => {
  assert.equal(widgetBundleVersion({
    distributionBuild: false,
    releaseBundleVersion: '0.54.0',
    uiVersion: 28
  }), '28');
  assert.equal(widgetBundleVersion({
    distributionBuild: true,
    releaseBundleVersion: '0.54.0',
    uiVersion: 28
  }), '0.54.0');
  assert.match(widgetBuildSource, /xcconfigLine\('CURRENT_PROJECT_VERSION', localWidgetBundleVersion\)/);
  assert.match(widgetBuildSource, /xcconfigLine\('TOKEN_MONITOR_BUNDLE_VERSION', localWidgetBundleVersion\)/);
  assert.match(widgetBuildSource, /bundleVersion: versions\.bundleVersion/);
  assert.match(widgetBuildSource, /widgetBundleVersion: localWidgetBundleVersion/);
});

test('distribution Widget builds reject implicit example identifiers', () => {
  assert.throws(() => validateDistributionIdentifiers({
    appGroup: DEFAULT_APP_GROUP,
    bundleId: DEFAULT_WIDGET_BUNDLE_ID,
    distributionBuild: true
  }), /TOKEN_MONITOR_APP_GROUP/);
  assert.doesNotThrow(() => validateDistributionIdentifiers({
    appGroup: 'group.org.example-project.tokenmonitor',
    bundleId: 'org.example-project.tokenmonitor.widget',
    distributionBuild: false
  }));
});

test('maps the Electron target architecture to both Widget build products', () => {
  assert.deepEqual(resolveWidgetArchitecture('arm64'), {
    name: 'arm64', xcodeArch: 'arm64', swiftArch: 'arm64'
  });
  assert.deepEqual(resolveWidgetArchitecture('x64'), {
    name: 'x64', xcodeArch: 'x86_64', swiftArch: 'x86_64'
  });
  assert.throws(() => resolveWidgetArchitecture('universal'), /TOKEN_MONITOR_WIDGET_ARCH/);
  assert.match(widgetBuildSource, /ARCHS=\$\{architecture\.xcodeArch\}/);
  assert.match(widgetBuildSource, /\$\{architecture\.swiftArch\}-apple-macos14\.0/);
  assert.match(widgetBuildSource, /assertWidgetArchitecture\(stagedExtension, helperBinary, architecture\)/);
});

test('Widget user-facing strings are localized in five languages', () => {
  const swiftSources = [widgetSource, widgetIntentSource, widgetViewModelSource, widgetDashboardSource];
  const snapshotSource = fs.readFileSync(
    path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetSnapshot.swift'),
    'utf8'
  );
  swiftSources.push(snapshotSource);
  assert.doesNotMatch(swiftSources.join('\n'), /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/);
  assert.equal(widgetLocalization.sourceLanguage, 'en');
  for (const [key, entry] of Object.entries(widgetLocalization.strings)) {
    assert.deepEqual(
      Object.keys(entry.localizations).sort(),
      ['en', 'ja', 'ko', 'zh-Hans', 'zh-Hant'],
      `missing localization for ${key}`
    );
    assert.ok(Object.values(entry.localizations).every((localization) => (
      localization.stringUnit?.state === 'translated' && localization.stringUnit.value
    )), `incomplete localization for ${key}`);
  }
  assert.ok(Object.values(widgetLocalization.strings.Unlimited.localizations).every((localization) => (
    localization.stringUnit.value === 'Unlimited'
  )));
});

test('Widget layout uses system margins and a title-content scaffold without changing kind', () => {
  assert.match(widgetViewModelSource, /struct WidgetLayoutMetrics/);
  assert.match(widgetViewModelSource, /struct WidgetScaffoldGeometry/);
  assert.match(widgetViewModelSource, /static let small = WidgetLayoutMetrics/);
  assert.match(widgetViewModelSource, /static let medium = WidgetLayoutMetrics/);
  assert.match(widgetViewModelSource, /static let large = WidgetLayoutMetrics/);
  assert.equal((widgetViewModelSource.match(/outerTopInset: 0/g) || []).length, 3);
  assert.equal((widgetViewModelSource.match(/outerBottomInset: 0/g) || []).length, 3);
  assert.equal((widgetViewModelSource.match(/horizontalInset: 0/g) || []).length, 3);
  assert.match(widgetViewModelSource, /contentGap: WidgetDesignTokens\.largeGap/);
  assert.match(widgetSource, /VStack\(spacing: metrics\.contentGap\)/);
  assert.match(widgetSource, /\.padding\(metrics\.outerInsets\)/);
  assert.doesNotMatch(widgetSource, /\.contentMarginsDisabled\(\)/);
  assert.match(widgetSource, /ViewThatFits\(in: \.vertical\)/);
  assert.doesNotMatch(widgetSource, /\.clipped\(\)/);
  assert.match(widgetSource, /\.frame\(maxWidth: \.infinity, maxHeight: \.infinity, alignment: \.topLeading\)/);
  assert.match(widgetSource, /measureWidgetLayoutRegion\(\.header\)/);
  assert.match(widgetSource, /measureWidgetLayoutRegion\(\.content\)/);
  assert.doesNotMatch(widgetSource, /measureWidgetLayoutRegion\(\.footer\)/);
  assert.doesNotMatch(widgetViewModelSource, /footerHeight|pageControlWidth/);
  assert.match(widgetInfo, /<key>TMWidgetSchemaVersion<\/key>\s*<string>8<\/string>/);
  assert.match(widgetProject, /TOKEN_MONITOR_WIDGET_KIND = com\.tokenmonitor\.dashboard;/);
});

test('Widget scaffold keeps the title outside page content switches', () => {
  const scaffoldStart = widgetSource.indexOf('private func scaffold<Header: View, Content: View>');
  const scaffoldEnd = widgetSource.indexOf('\n    private var familyScope', scaffoldStart);
  assert.ok(scaffoldStart >= 0 && scaffoldEnd > scaffoldStart, 'scaffold should exist');
  const scaffoldSource = widgetSource.slice(scaffoldStart, scaffoldEnd);
  const pageBodyStart = widgetSource.indexOf('private func pageBody');
  const pageBodyEnd = widgetSource.indexOf('\n    private func overview', pageBodyStart);
  const pageBodySource = widgetSource.slice(pageBodyStart, pageBodyEnd);

  assert.match(scaffoldSource, /header[\s\S]*\.measureWidgetLayoutRegion\(\.header\)/);
  assert.match(scaffoldSource, /VStack\(spacing: metrics\.contentGap\)/);
  assert.doesNotMatch(pageBodySource, /header\(/);
  assert.match(pageBodySource, /GeometryReader \{ proxy in/);
  assert.doesNotMatch(widgetSource, /fixedSize\s*\([^)]*vertical:\s*true/);
  assert.doesNotMatch(widgetSource, /\.offset\(y:\s*-/);
  assert.match(widgetSource, /TokenMonitorSummaryWidget[\s\S]*\.supportedFamilies\(\[\.systemSmall\]\)/);
  assert.match(widgetSource, /TokenMonitorBreakdownWidget[\s\S]*\.supportedFamilies\(\[\.systemMedium\]\)/);
  assert.match(widgetSource, /TokenMonitorWidget: Widget[\s\S]*\.supportedFamilies\(\[\.systemLarge\]\)/);
});

test('Activity layout adapts density and heatmap size without clipping the scaffold', () => {
  const activityStart = widgetSource.indexOf('private func activity(_ snapshot: WidgetSnapshot, context: WidgetContentContext)');
  const activityEnd = widgetSource.indexOf('\n    private func trend', activityStart);
  assert.ok(activityStart >= 0 && activityEnd > activityStart, 'activity view should exist');
  const activitySource = widgetSource.slice(activityStart, activityEnd);
  assert.match(activitySource, /adaptiveContent \{/);
  assert.match(widgetSource, /private func activityLayout\(/);
  assert.match(widgetSource, /case \.small: 16/);
  assert.match(widgetSource, /case \.medium: 14/);
  assert.match(widgetSource, /case \.large: 26/);
  assert.match(widgetSource, /private func mediumActivityView\(/);
  assert.match(widgetSource, /WidgetMediumActivityLayoutPlan\.make\(availableSize: context\.size\)/);
  assert.match(widgetSource, /HStack\(alignment: \.center, spacing: plan\.spacing\)/);
  assert.match(widgetSource, /CGSize\(width: plan\.heatmapWidth, height: context\.size\.height\)/);
  assert.match(widgetSource, /WidgetHeatmapLayoutCalculator\.make\(/);
  assert.match(widgetSource, /Text\(WidgetL10n\.format\("%lld days", spec\.activeDays\)\)/);
  assert.match(widgetSource, /struct ActivityHeatmap: View/);
  assert.match(widgetSource, /Grid\(horizontalSpacing: layout\.spacing, verticalSpacing: layout\.spacing\)/);
  assert.match(widgetSource, /ForEach\(0\.\.<7, id: \\.self\)/);
  assert.match(widgetSource, /GridRow \{/);
  assert.match(widgetSource, /\.frame\(width: layout\.renderedWidth, height: layout\.renderedHeight/);
  assert.match(widgetViewModelSource, /let cellWidth: CGFloat/);
  assert.match(widgetViewModelSource, /let cellHeight: CGFloat/);
  assert.match(widgetViewModelSource, /struct WidgetMediumActivityLayoutPlan: Equatable/);
  assert.match(widgetViewModelSource, /let summaryWidth: CGFloat/);
  assert.match(widgetViewModelSource, /let heatmapWidth: CGFloat/);
  assert.match(widgetSource, /width: layout\.cellWidth,[\s\S]*height: layout\.cellHeight/);
  assert.doesNotMatch(widgetSource, /minimumWidthRatio:\s*0\.65/);
  assert.doesNotMatch(widgetSource, /allowsVerticalOverflow:\s*true/);
  assert.doesNotMatch(widgetSource, /LazyVGrid/);
  assert.doesNotMatch(widgetSource, /\.offset\(x:\s*-/);
  assert.doesNotMatch(widgetSource, /\.padding\(\.leading,\s*-/);
  assert.doesNotMatch(widgetSource, /rotationEffect/);
});

test('Medium and Large activity cells are App Intent buttons with stable selection details', () => {
  const heatmapStart = widgetSource.indexOf('struct ActivityHeatmap: View');
  assert.ok(heatmapStart >= 0, 'activity heatmap should exist');
  const heatmapSource = widgetSource.slice(heatmapStart);
  const mediumStart = widgetSource.indexOf('private func mediumActivityView(');
  const mediumEnd = widgetSource.indexOf('\n    private func selectedDayDetail(', mediumStart);
  const mediumSource = widgetSource.slice(mediumStart, mediumEnd);

  assert.match(widgetIntentSource, /struct SelectActivityDayIntent: AppIntent/);
  assert.match(widgetIntentSource, /static var openAppWhenRun: Bool \{ false \}/);
  assert.match(widgetIntentSource, /widget\.presentation\.activity-day/);
  assert.match(heatmapSource, /Button\(intent: SelectActivityDayIntent\(family: family, date: cell\.date\)\)/);
  assert.match(heatmapSource, /if let family, cell\.isSelectable/);
  assert.doesNotMatch(heatmapSource, /hasActivityData/);
  assert.match(heatmapSource, /\.buttonStyle\(\.plain\)/);
  assert.match(heatmapSource, /\.overlay \{[\s\S]*\.strokeBorder\(\.primary, lineWidth: 2\)/);
  assert.doesNotMatch(heatmapSource, /Link\(/, 'cell buttons must not be nested in links');
  assert.match(widgetSource, /context\.layout == \.large \? \.large : nil/);
  assert.match(widgetSource, /ActivityHeatmap\(layout: spec, family: \.medium, selectedDate: entry\.selectedActivityDate\)/);
  assert.match(mediumSource, /selectedDayDetail\(snapshot\)[\s\S]*\.frame\(height: 32/);
  assert.match(widgetSource, /context\.layout == \.large \{[\s\S]*secondary\(largeActivityCaptionText\(snapshot, layout: spec\)\)/);
  assert.match(widgetSource, /private func largeActivityCaptionText\([\s\S]*return activityDateRangeText\(layout\)/);
  assert.doesNotMatch(widgetSource, /selectedDayDetailLine/);
  assert.match(widgetSource, /WidgetFormat\.tokens\(day\.totalTokens, style: snapshot\.presentation\.numberStyle, presentation: snapshot\.presentation\)/);
  assert.match(widgetSource, /WidgetActivitySelection\.detailDay\(/);
  assert.doesNotMatch(widgetSource, /onHover|@State/);
});

test('Large overview quota and model rows share the same row component', () => {
  const largeOverviewStart = widgetSource.indexOf('private func largeOverview(');
  const largeOverviewEnd = widgetSource.indexOf('\n    private func quotaSummary', largeOverviewStart);
  const largeOverviewSource = widgetSource.slice(largeOverviewStart, largeOverviewEnd);
  const modelRowsStart = widgetSource.indexOf('private func modelOverviewRows');
  const modelRowsEnd = widgetSource.indexOf('\n    private func summaryLinkRow', modelRowsStart);
  const modelRowsSource = widgetSource.slice(modelRowsStart, modelRowsEnd);

  assert.match(widgetSource, /private struct LargeOverviewListRow: View/);
  assert.match(widgetSource, /struct Model: Equatable/);
  assert.match(widgetSource, /private let rowHeight: CGFloat = 16/);
  assert.match(widgetSource, /private let fontSize: CGFloat = 10/);
  assert.match(largeOverviewSource, /ViewThatFits\(in: \.vertical\)/);
  assert.match(largeOverviewSource, /quotaLimit: 3, modelLimit: 2, showsMoreRows: true/);
  assert.match(largeOverviewSource, /quotaLimit: 2, modelLimit: 2, showsMoreRows: true/);
  assert.match(largeOverviewSource, /quotaLimit: 1, modelLimit: 1, showsMoreRows: false/);
  assert.match(widgetSource, /\.font\(\.system\(size: fontSize, weight: \.medium\)\)/);
  assert.match(widgetSource, /\.font\(\.system\(size: fontSize, weight: \.medium, design: \.monospaced\)\)/);
  assert.match(widgetSource, /\.frame\(height: rowHeight, alignment: \.center\)/);
  assert.match(largeOverviewSource, /LargeOverviewListRow\(label: row\.label, value: row\.value, style: row\.style\)/);
  assert.ok((widgetSource.match(/LargeOverviewListRow\(/g) || []).length >= 3);
  assert.match(modelRowsSource, /LargeOverviewListRow\.Model/);
  assert.doesNotMatch(modelRowsSource, / · /);
});

test('Quota and model pages derive row density from measured content height', () => {
  const quotaStart = widgetSource.indexOf('private func quota(_ snapshot: WidgetSnapshot, context: WidgetContentContext)');
  const quotaEnd = widgetSource.indexOf('\n    private func models', quotaStart);
  const modelStart = widgetSource.indexOf('private func models(_ snapshot: WidgetSnapshot, context: WidgetContentContext)');
  const modelEnd = widgetSource.indexOf('\n    private func activity', modelStart);
  const quotaPageSource = widgetSource.slice(quotaStart, quotaEnd);
  const modelPageSource = widgetSource.slice(modelStart, modelEnd);

  assert.match(widgetViewModelSource, /enum WidgetListCapacity/);
  assert.match(widgetViewModelSource, /for density in \[WidgetContentDensity\.regular, \.compact, \.summary\]/);
  assert.match(widgetViewModelSource, /availableForRows/);
  assert.equal((widgetSource.match(/WidgetListCapacity\.plan\(/g) || []).length, 2);
  assert.equal((widgetSource.match(/availableHeight: context\.size\.height/g) || []).length, 3);
  assert.doesNotMatch(quotaPageSource, /quotaLimit|modelLimit/);
  assert.doesNotMatch(modelPageSource, /quotaLimit|modelLimit/);
});

test('macOS Widget integration leaves non-macOS packaging sections unchanged', () => {
  assert.ok(packageJson.build.win);
  assert.ok(packageJson.build.linux);
  assert.equal(packageJson.build.win.extraFiles, undefined);
  assert.equal(packageJson.build.linux.extraFiles, undefined);
});
