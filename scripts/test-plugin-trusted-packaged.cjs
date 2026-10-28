'use strict';
// Local unsigned macOS fixture, reusing the installed Electron and dependencies.
// This exercises ASAR utilityProcess startup, not release signing/notarization.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
async function main() {
  if (process.platform !== 'darwin') throw new Error('This local packaged fixture requires macOS');
  const root = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-package-'));
  const evidence = process.env.TM_PLUGIN_EVIDENCE || scratch;
  fs.mkdirSync(evidence, { recursive: true });
  const bundle = path.join(scratch, 'Trusted Fixture.app');
  execFileSync('/usr/bin/ditto', [path.join(root, 'node_modules/electron/dist/Electron.app'), bundle]);
  // Electron identifies the development runner by its executable name.
  // Match packaging's renamed main executable rather than mocking isPackaged.
  fs.renameSync(path.join(bundle, 'Contents/MacOS/Electron'), path.join(bundle, 'Contents/MacOS/TrustedFixture'));
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleExecutable TrustedFixture', path.join(bundle, 'Contents/Info.plist')]);
  const source = path.join(scratch, 'app'); fs.mkdirSync(source);
  for (const file of ['backend.js', 'backendHost.cjs']) fs.copyFileSync(path.join(root, 'src/electron/plugins', file), path.join(source, file));
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'trusted-platform-fixture', version: '1.0.0', main: 'main.cjs' }));
  const entry = path.join(scratch, 'plugin.cjs');
  fs.writeFileSync(entry, `const koffi=require(${JSON.stringify(require.resolve('koffi'))});
exports.activate=()=>({call:()=>({pid:process.pid,nativePid:koffi.load(null).func('int getpid()')(),node:process.versions.node,modules:process.versions.modules})});`);
  fs.writeFileSync(path.join(source, 'main.cjs'), `const {app,utilityProcess}=require('electron');
const fs=require('node:fs'),assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(path.join(scratch, 'profile'))});
const timeout=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{
assert.equal(app.isPackaged,true);
const backend=require('./backend').createPluginBackends({fork:utilityProcess.fork,hostCall:async()=>null,onError:console.error,log:console.log});
await backend.start('fixture',${JSON.stringify(entry)},${JSON.stringify(path.join(scratch, 'data'))});
const result=await backend.call('fixture','probe');assert.equal(result.pid,result.nativePid);
await backend.dispose();assert.equal(backend.size(),0);
fs.writeFileSync(${JSON.stringify(path.join(evidence, 'packaged-results.json'))},JSON.stringify({isPackaged:app.isPackaged,asar:__dirname.includes('app.asar'),electron:process.versions.electron,...result,scope:'unsigned local macOS ASAR utility process and existing Koffi native addon; not arbitrary ABI or signed release acceptance'},null,2));
console.log('PASS packaged ASAR utilityProcess, external plugin and existing native addon');clearTimeout(timeout);app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});`);
  const resources = path.join(bundle, 'Contents/Resources');
  await require('@electron/asar').createPackage(source, path.join(resources, 'app.asar'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(path.join(bundle, 'Contents/MacOS/TrustedFixture'), [], { env, encoding: 'utf8', timeout: 45000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, result.error?.message || 'packaged fixture failed');
  fs.rmSync(bundle, { recursive: true, force: true });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
