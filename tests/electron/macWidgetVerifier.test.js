'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  readCodesignMetadata,
  verifyMacWidgetApp
} = require('../../scripts/verify-macos-widget-app');

const APP_ID = 'com.javis.tokenmonitor';
const WIDGET_BUNDLE_ID = 'com.javis.tokenmonitor.widget';
const WIDGET_KIND = 'com.tokenmonitor.dashboard';
const URL_SCHEME = 'token-monitor';

function plistForApp() {
  return {
    CFBundleExecutable: 'Token Monitor',
    CFBundleIdentifier: APP_ID,
    CFBundleURLTypes: [{ CFBundleURLSchemes: [URL_SCHEME] }],
    CFBundleShortVersionString: '0.39.0',
    CFBundleVersion: '0.39.0'
  };
}

function plistForWidget(appGroup) {
  return {
    CFBundleIdentifier: WIDGET_BUNDLE_ID,
    TokenMonitorAppGroup: appGroup,
    TokenMonitorURLScheme: URL_SCHEME,
    TMWidgetKind: WIDGET_KIND,
    CFBundleShortVersionString: '0.39.0',
    CFBundleVersion: '0.39.0'
  };
}

function makeBundle({ appGroup, configAppGroup = appGroup, widgetInfoAppGroup = appGroup } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-widget-verifier-'));
  const appPath = path.join(root, 'Token Monitor.app');
  const contents = path.join(appPath, 'Contents');
  const extension = path.join(contents, 'PlugIns', 'TokenMonitorWidget.appex');
  const extensionContents = path.join(extension, 'Contents');
  const extensionExecutable = path.join(extensionContents, 'MacOS', 'TokenMonitorWidget');
  const reloader = path.join(contents, 'Resources', 'TokenMonitorWidgetReloader');
  const configPath = path.join(contents, 'Resources', 'token-monitor-widget.json');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.dirname(extensionExecutable), { recursive: true });
  fs.mkdirSync(path.dirname(reloader), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), 'fixture');
  fs.writeFileSync(path.join(extensionContents, 'Info.plist'), 'fixture');
  fs.writeFileSync(path.join(contents, 'MacOS', 'Token Monitor'), 'fixture');
  fs.writeFileSync(extensionExecutable, 'fixture');
  fs.writeFileSync(reloader, 'fixture');
  fs.writeFileSync(configPath, `${JSON.stringify({
    appGroup: configAppGroup,
    widgetKind: WIDGET_KIND,
    urlScheme: URL_SCHEME,
    marketingVersion: '0.39.0',
    bundleVersion: '0.39.0'
  })}\n`);
  return {
    root,
    appPath,
    extension,
    reloader,
    appInfo: plistForApp(),
    extensionInfo: plistForWidget(widgetInfoAppGroup)
  };
}

function entitlementXml(appGroup, { app = false, includeGroup = true } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist><dict>
  ${app ? '<key>com.apple.security.cs.allow-jit</key><true/>' : '<key>com.apple.security.app-sandbox</key><true/>'}
  ${includeGroup ? `<key>com.apple.security.application-groups</key><array><string>${appGroup}</string></array>` : ''}
</dict></plist>`;
}

function signatureText(teamIdentifier, authority = true, includeTeamIdentifier = true) {
  return [
    'Identifier=com.javis.tokenmonitor',
    includeTeamIdentifier ? `TeamIdentifier=${teamIdentifier}` : '',
    authority ? 'Authority=Developer ID Application: Example (ABCDE12345)' : ''
  ].filter(Boolean).join('\n');
}

function verifyFixture(bundle, {
  appGroup,
  distributionBuild = false,
  localDevelopmentSigning = !distributionBuild,
  developmentTeam,
  appTeam = 'ABCDE12345',
  widgetTeam = appTeam,
  appEntitlementGroup = appGroup,
  widgetEntitlementGroup = appGroup,
  authority = true,
  includeTeamIdentifier = true
} = {}) {
  const execFileSyncImpl = (command, args) => {
    if (command === 'plutil') {
      return JSON.stringify(args.at(-1) === path.join(bundle.appPath, 'Contents', 'Info.plist')
        ? bundle.appInfo
        : bundle.extensionInfo);
    }
    if (command === 'codesign' && args[0] === '--verify') return '';
    if (command === 'codesign' && args[0] === '-dv') {
      return {
        stdout: '',
        stderr: args.at(-1) === bundle.extension
          ? signatureText(widgetTeam, authority, includeTeamIdentifier)
          : signatureText(appTeam, authority, includeTeamIdentifier)
      };
    }
    if (command === 'spctl') return '';
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  const spawnSyncImpl = (command, args) => {
    if (command === 'lipo') return { status: 0, stdout: 'x86_64\n', stderr: '' };
    if (command === 'codesign') {
      const filePath = args.at(-1);
      if (filePath === bundle.extension) {
        return { status: 0, stdout: '', stderr: entitlementXml(widgetEntitlementGroup, { app: false }) };
      }
      if (filePath === bundle.appPath) {
        return { status: 0, stdout: '', stderr: entitlementXml(appEntitlementGroup, { app: true }) };
      }
      return { status: 0, stdout: '', stderr: entitlementXml(appGroup, { app: false, includeGroup: false }) };
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  return verifyMacWidgetApp({
    appPath: bundle.appPath,
    targetArch: 'x64',
    appGroup,
    widgetBundleId: WIDGET_BUNDLE_ID,
    distributionBuild,
    localDevelopmentSigning,
    developmentTeam,
    distributionChannel: 'developer-id',
    execFileSyncImpl,
    spawnSyncImpl
  });
}

test('parses codesign metadata emitted on stderr', () => {
  const metadata = readCodesignMetadata('/tmp/Token Monitor.app', () => ({
    stdout: '',
    stderr: [
      'Identifier=com.javis.tokenmonitor',
      'TeamIdentifier=ABCDE12345',
      'Authority=Developer ID Application: Example (ABCDE12345)',
      'Authority=Developer ID Certification Authority'
    ].join('\n')
  }));
  assert.deepEqual(metadata, {
    identifier: 'com.javis.tokenmonitor',
    teamIdentifier: 'ABCDE12345',
    authorities: [
      'Developer ID Application: Example (ABCDE12345)',
      'Developer ID Certification Authority'
    ]
  });
});

test('local ad-hoc verification does not require a TeamIdentifier', (t) => {
  const appGroup = 'group.com.example.tokenmonitor';
  const bundle = makeBundle({ appGroup });
  t.after(() => fs.rmSync(bundle.root, { recursive: true, force: true }));
  assert.doesNotThrow(() => verifyFixture(bundle, { appGroup, includeTeamIdentifier: false }));
});

test('cross-checks the expected App Group across config, Info.plist, and signed entitlements', (t) => {
  const appGroup = 'group.com.example.tokenmonitor';
  const bundle = makeBundle({ appGroup });
  t.after(() => fs.rmSync(bundle.root, { recursive: true, force: true }));
  assert.doesNotThrow(() => verifyFixture(bundle, { appGroup }));

  const configMismatch = makeBundle({ appGroup, configAppGroup: 'group.other.tokenmonitor' });
  t.after(() => fs.rmSync(configMismatch.root, { recursive: true, force: true }));
  assert.throws(() => verifyFixture(configMismatch, { appGroup }), /Widget config App Group/);

  const infoMismatch = makeBundle({ appGroup, widgetInfoAppGroup: 'group.other.tokenmonitor' });
  t.after(() => fs.rmSync(infoMismatch.root, { recursive: true, force: true }));
  assert.throws(() => verifyFixture(infoMismatch, { appGroup }), /Widget Info\.plist App Group/);

  assert.throws(() => verifyFixture(bundle, {
    appGroup,
    appEntitlementGroup: 'group.other.tokenmonitor'
  }), /main app entitlements App Group/);
  assert.throws(() => verifyFixture(bundle, {
    appGroup,
    widgetEntitlementGroup: 'group.other.tokenmonitor'
  }), /Widget extension entitlements App Group/);
});

test('formal verification matches signed Teams and requires Developer ID authority', (t) => {
  const appGroup = 'ABCDE12345.dev.example.tokenmonitor';
  const bundle = makeBundle({ appGroup });
  t.after(() => fs.rmSync(bundle.root, { recursive: true, force: true }));
  assert.doesNotThrow(() => verifyFixture(bundle, {
    appGroup,
    distributionBuild: true,
    localDevelopmentSigning: false,
    developmentTeam: 'ABCDE12345'
  }));

  assert.throws(() => verifyFixture(bundle, {
    appGroup,
    distributionBuild: true,
    localDevelopmentSigning: false,
    developmentTeam: 'ABCDE12345',
    appTeam: 'ZZZZZ99999',
    widgetTeam: 'ZZZZZ99999'
  }), /Team-prefixed App Group does not match/);
  assert.throws(() => verifyFixture(bundle, {
    appGroup,
    distributionBuild: true,
    localDevelopmentSigning: false,
    developmentTeam: 'ABCDE12345',
    widgetTeam: 'ZZZZZ99999'
  }), /Widget extension TeamIdentifier differs from main app/);
  assert.throws(() => verifyFixture(bundle, {
    appGroup,
    distributionBuild: true,
    localDevelopmentSigning: false,
    developmentTeam: 'ABCDE12345',
    appTeam: 'ABCDE12345',
    widgetTeam: 'ABCDE12345',
    authority: false
  }), /missing a Developer ID Application authority/);
});

test('formal verification rejects a signed Team that differs from DEVELOPMENT_TEAM', (t) => {
  const appGroup = 'group.com.example.tokenmonitor';
  const bundle = makeBundle({ appGroup });
  t.after(() => fs.rmSync(bundle.root, { recursive: true, force: true }));
  assert.throws(() => verifyFixture(bundle, {
    appGroup,
    distributionBuild: true,
    localDevelopmentSigning: false,
    developmentTeam: 'ZZZZZ99999',
    appTeam: 'ABCDE12345',
    widgetTeam: 'ABCDE12345'
  }), /main app TeamIdentifier ABCDE12345 does not match DEVELOPMENT_TEAM ZZZZZ99999/);
});
