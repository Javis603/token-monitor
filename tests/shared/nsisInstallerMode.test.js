'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const packageJson = require('../../package.json');
const installerInclude = fs.readFileSync(
  path.join(ROOT, packageJson.build.nsis.include),
  'utf8'
);
const PINNED_BUILDER = '26.15.3';

function readBuilderFile(relativePath) {
  try {
    return fs.readFileSync(path.join(ROOT, 'node_modules', 'app-builder-lib', relativePath), 'utf8');
  } catch (_) {
    return null;
  }
}

function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} not found upstream`);
  const end = source.indexOf(to, start + from.length);
  return source.slice(start, end === -1 ? source.length : end);
}

test('Windows installer stays assisted, current-user only, and starts at the directory page', () => {
  assert.deepEqual(
    {
      oneClick: packageJson.build.nsis.oneClick,
      perMachine: packageJson.build.nsis.perMachine,
      allowToChangeInstallationDirectory:
        packageJson.build.nsis.allowToChangeInstallationDirectory,
      include: packageJson.build.nsis.include
    },
    {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      include: 'scripts/nsis-installer.nsh'
    }
  );

  assert.match(
    installerInclude,
    /!macro customInstallMode\s+!ifndef BUILD_UNINSTALLER\s+StrCpy \$isForceCurrentInstall "1"\s+!endif\s+!macroend/
  );
  assert.doesNotMatch(installerInclude, /\$isForceMachineInstall/);
  assert.doesNotMatch(installerInclude, /customWelcomePage|MUI_PAGE_WELCOME/);
  assert.doesNotMatch(installerInclude, /MUI_PAGE_CUSTOMFUNCTION|nsDialogs|NSD_/);
});

test('the pinned electron-builder loads and honors the current-user install hook', (t) => {
  const target = readBuilderFile('out/targets/nsis/NsisTarget.js');
  const installModeUi = readBuilderFile('templates/nsis/multiUserUi.nsh');
  if (!target || !installModeUi) return t.skip('electron-builder is not installed');

  assert.equal(packageJson.devDependencies['electron-builder'], PINNED_BUILDER);
  assert.equal(require('app-builder-lib/package.json').version, PINNED_BUILDER);

  assert.match(
    target,
    /getResource\(this\.options\.include, "installer\.nsh"\)/,
    'the configured NSIS include must remain supported upstream'
  );

  const installModePre = slice(
    installModeUi,
    '!macro FUNCTION_INSTALL_MODE_PAGE_FUNCTION',
    '\n\tFunction "${UNINSTALLER_FUNCPREFIX}${LEAVE}"'
  );
  const hook = installModePre.indexOf('!insertmacro customInstallMode');
  const forceCurrent = installModePre.indexOf('${if} $isForceCurrentInstall == "1"');
  assert.ok(hook >= 0, 'customInstallMode hook not found upstream');
  assert.ok(forceCurrent > hook, 'the custom hook must run before force-current is evaluated');
  assert.match(
    installModePre.slice(forceCurrent),
    /\$isForceCurrentInstall == "1"[\s\S]*?!insertmacro setInstallModePerUser[\s\S]*?Abort/,
    'force-current must select the per-user registry context and skip the mode page'
  );

  const assistedInstaller = readBuilderFile('templates/nsis/assistedInstaller.nsh');
  assert.ok(assistedInstaller, 'assisted installer template not found upstream');
  const installMode = assistedInstaller.indexOf('!insertmacro PAGE_INSTALL_MODE');
  const directory = assistedInstaller.indexOf('!insertmacro MUI_PAGE_DIRECTORY');
  assert.ok(
    installMode >= 0 && installMode < directory,
    'the skipped install-mode page must remain immediately before the visible directory page'
  );
});
