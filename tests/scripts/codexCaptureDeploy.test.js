'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const installer = path.resolve(__dirname, '../../scripts/deploy-codex-capture-entry.py');
const setup = `
import runpy,sys,tempfile,pathlib,json,hashlib,plistlib,subprocess
m=runpy.run_path(sys.argv[1],run_name='test_module')
root=pathlib.Path(tempfile.mkdtemp(prefix='tm-package-test-')).resolve()
repo=root/'repo';repo.mkdir()
for name,text in {
 'scripts/codex-cloud-capture-desktop.js':"'use strict';",
 'scripts/codex-cloud-engine-usage.js':"require('../src/shared/providers/codex/cloudLiveMeter');require('undici');",
 'src/shared/providers/codex/cloudLiveMeter.js':"module.exports={};",
 'scripts/old.js':"module.exports={};",
 'node_modules/undici/package.json':'{"name":"undici"}'
}.items():
 p=repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
subprocess.run(['git','init','-q',str(repo)],check=True)
subprocess.run(['git','-C',str(repo),'add','.'],check=True)
subprocess.run(['git','-C',str(repo),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)
app=root/'Token Monitor Usage Test.app';resources=app/'Contents/Resources';resources.mkdir(parents=True)
(app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'local.chengong.tokenmonitor.usagetest'}))
old={'kind':'token-monitor-usage-test','version':2,'sourceCommit':'old-test-commit','nodeExecutable':sys.executable,'files':{}}
for name in ['scripts/old.js','node_modules/undici/package.json']:
 p=resources/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((repo/name).read_bytes());old['files'][name]=hashlib.sha256(p.read_bytes()).hexdigest()
(resources/'deployment.json').write_text(json.dumps(old))
data=root/'data';data.mkdir()
`;
function run(body) {
  const result = spawnSync('python3', ['-B', '-c', setup + '\ntry:\n' + body.split('\n').map((s) => ' '+s).join('\n') + '\nfinally:\n import shutil\n shutil.rmtree(root)\n', installer], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}
test('deployment closure includes the subprocess observer and not just require edges', { skip: process.platform === 'win32' }, () => run(`
p=m['install'](repo,app,data,False)
assert p['packageFiles']==5
assert p['dryRun'] and not (data/'backups').exists()
assert 'scripts/codex-cloud-engine-usage.js' in m['sources'](repo)
`));
test('parallel app upgrade preserves a verified backup and adds only its shortcut', { skip: process.platform === 'win32' }, () => run(`
p=m['install'](repo,app,data,True)
new=json.loads((resources/'deployment.json').read_text())
assert len(new['files'])==5
assert (resources/'scripts/codex-cloud-engine-usage.js').exists()
assert pathlib.Path(p['backup']).joinpath(app.name,'Contents/Resources/deployment.json').exists()
assert pathlib.Path(p['shortcut']).exists()
assert '"$@"' in pathlib.Path(p['shortcut']).read_text()
assert (resources/'scripts/old.js').read_bytes()==(repo/'scripts/old.js').read_bytes()
`));
test('existing app source conflict is rejected before creating a backup', { skip: process.platform === 'win32' }, () => run(`
(resources/'scripts/old.js').write_text('user modification')
try:m['install'](repo,app,data,True);raise AssertionError('accepted conflict')
except ValueError as e:assert str(e)=='INSTALLED_SOURCE_CONFLICT'
assert not (data/'backups').exists()
assert (resources/'scripts/old.js').read_text()=='user modification'
`));
test('unexpected user files in package cannot be silently removed', { skip: process.platform === 'win32' }, () => run(`
(resources/'user-note.txt').write_text('preserve')
try:m['install'](repo,app,data,True);raise AssertionError('accepted custom file')
except ValueError as e:assert str(e)=='UNMANIFESTED_PACKAGE_CONTENT'
assert (resources/'user-note.txt').read_text()=='preserve'
`));
test('production app name cannot be targeted', { skip: process.platform === 'win32' }, () => run(`
try:m['install'](repo,root/'Token Monitor.app',data,True);raise AssertionError('accepted production path')
except ValueError as e:assert str(e)=='NOT_THE_PARALLEL_TEST_APP'
assert not (root/'Token Monitor.app').exists()
`));
test('failed staging leaves old resources and shortcuts untouched', { skip: process.platform === 'win32' }, () => run(`
original=m['shutil'].copyfile
def fail_copy(src,dst,*a,**k):
 if 'Resources.capture-' in str(dst):raise OSError('synthetic staging failure')
 return original(src,dst,*a,**k)
m['shutil'].copyfile=fail_copy
try:m['install'](repo,app,data,True);raise AssertionError('expected failure')
except OSError:pass
finally:m['shutil'].copyfile=original
assert json.loads((resources/'deployment.json').read_text())==old
assert not (app.parent/'云端实时Token监听.command').exists()
`));
test('a concurrently created shortcut survives failed deployment rollback', { skip: process.platform === 'win32' }, () => run(`
original=m['subprocess'].check_output;calls=[0]
shortcut=app.parent/'云端实时Token监听.command'
def interleave(args,*a,**k):
 result=original(args,*a,**k);calls[0]+=1
 if calls[0]==4:shortcut.write_text('another user shortcut')
 return result
m['subprocess'].check_output=interleave
try:m['install'](repo,app,data,True);raise AssertionError('expected collision')
except FileExistsError:pass
finally:m['subprocess'].check_output=original
assert shortcut.read_text()=='another user shortcut'
assert json.loads((resources/'deployment.json').read_text())==old
`));
