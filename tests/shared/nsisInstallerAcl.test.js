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
const mainProcess = fs.readFileSync(path.join(ROOT, 'src', 'electron', 'main.js'), 'utf8');
const PINNED_BUILDER = '26.15.3';

function readBuilderFile(relativePath) {
  try {
    return fs.readFileSync(path.join(ROOT, 'node_modules', 'app-builder-lib', relativePath), 'utf8');
  } catch (_) {
    return null;
  }
}

// Assert against the macro body alone: the surrounding comment names the SID's
// display name and the flags it avoids, so whole-file matching would pass on
// prose instead of on the command that actually runs.
function macroBody(source, name) {
  const start = source.indexOf(`!macro ${name}\n`);
  assert.ok(start >= 0, `${name} is not defined in the installer include`);
  const end = source.indexOf('!macroend', start);
  assert.ok(end > start, `${name} is not terminated`);
  return source.slice(start, end);
}

test('the installer grants AppContainer read access to its own install directory', () => {
  const body = macroBody(installerInclude, 'customInstall');

  assert.match(
    body,
    /nsExec::ExecToLog '"\$SYSDIR\\icacls\.exe" "\$INSTDIR" \/grant "\*S-1-15-2-2:\(OI\)\(CI\)\(RX\)"'/,
    'the grant must stay scoped to $INSTDIR and inheritable read/execute for S-1-15-2-2'
  );

  // The absolute $SYSDIR path keeps a stray icacls.exe earlier on PATH from
  // running elevated-adjacent during install.
  assert.doesNotMatch(body, /nsExec::\w+ '(?!")/, 'the executable must be an absolute quoted path');
  // The display name is localized; only the SID literal resolves everywhere.
  assert.doesNotMatch(body, /ALL RESTRICTED APPLICATION PACKAGES/);
  // Anything that replaces rather than adds would discard the entries the
  // install directory already inherits.
  assert.doesNotMatch(body, /\/grant:r|\/reset|\/remove|\/deny|\/setowner|\/inheritance/);
  // A failed grant is a missing workaround, never a failed install.
  assert.doesNotMatch(body, /\bAbort\b|\bQuit\b|SetErrorLevel/);
  assert.match(body, /\n\s*Pop \$0\b/, 'the exec result must be popped so the stack is left clean');
});

test('the pinned electron-builder runs the install hook after the app files are written', (t) => {
  const installSection = readBuilderFile('templates/nsis/installSection.nsh');
  if (!installSection) return t.skip('electron-builder is not installed');

  assert.equal(packageJson.devDependencies['electron-builder'], PINNED_BUILDER);
  assert.equal(require('app-builder-lib/package.json').version, PINNED_BUILDER);

  assert.match(
    installSection,
    /!ifmacrodef customInstall\s+!insertmacro customInstall/,
    'the customInstall hook must remain supported upstream'
  );

  const files = installSection.indexOf('!insertmacro installApplicationFiles');
  const hook = installSection.indexOf('!insertmacro customInstall');
  const startApp = installSection.indexOf('!macro doStartApp');
  assert.ok(files >= 0 && startApp >= 0, 'install section landmarks not found upstream');
  // icacls propagates an inheritable ACE to children that already exist, so the
  // hook has to run after the payload is written to pick up the app's files,
  // and before the installer offers to launch it.
  assert.ok(hook > files, 'the hook must run after the application files are installed');
  assert.ok(hook < startApp, 'the hook must run before the app can be started');
});

test('the app keeps both Chromium sandboxes enabled', () => {
  // #487 was fixed by widening the install directory's DACL instead. Relaxing
  // either sandbox would make the same symptom disappear while permanently
  // lowering the process boundary, so neither may come back as a workaround.
  assert.doesNotMatch(mainProcess, /sandbox\s*:\s*false/);
  assert.doesNotMatch(mainProcess, /disable-gpu-sandbox|no-sandbox/);
});
