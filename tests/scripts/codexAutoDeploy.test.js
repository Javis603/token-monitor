'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../../scripts/deploy-codex-auto-watch.py');
const capture = path.resolve(__dirname, '../../scripts/deploy-codex-capture-entry.py');
const setup = `
import runpy,sys,pathlib,tempfile,shutil,plistlib,json,hashlib,subprocess
m=runpy.run_path(sys.argv[1],run_name='test_module')
root=pathlib.Path(tempfile.mkdtemp(prefix='tm-auto-install-')).resolve();repo=root/'repo';home=root/'home';repo.mkdir();home.mkdir()
files={'scripts/codex-cloud-auto-watch.js':'module.exports={};','scripts/codex-cloud-engine-usage.js':'module.exports={};','node_modules/undici/package.json':'{"name":"undici"}'}
for name,text in files.items():
 p=repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
shutil.copyfile(sys.argv[2],repo/'scripts/deploy-codex-capture-entry.py')
subprocess.run(['git','init','-q',str(repo)],check=True)
subprocess.run(['git','-C',str(repo),'add','.'],check=True)
subprocess.run(['git','-C',str(repo),'-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-qm','fixture'],check=True)
app=home/'Applications/Token Monitor Usage Test.app';res=app/'Contents/Resources';res.mkdir(parents=True)
(app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'local.chengong.tokenmonitor.usagetest'}))
old={'kind':'token-monitor-usage-test','version':3,'sourceCommit':'fixture-old','nodeExecutable':sys.executable,'files':{}}
name='node_modules/undici/package.json';p=res/name;p.parent.mkdir(parents=True);p.write_bytes((repo/name).read_bytes());old['files'][name]=hashlib.sha256(p.read_bytes()).hexdigest()
(res/'deployment.json').write_text(json.dumps(old))
`;
function check(body) {
  const code = setup + '\ntry:\n' + body.split('\n').map(l => ' '+l).join('\n') + '\nfinally:\n shutil.rmtree(root)\n';
  const result = spawnSync('python3', ['-B', '-c', code, script, capture], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}
test('auto deployment dry-run creates no service, shortcut or data', { skip: process.platform === 'win32' }, () => check(`
p=m['install'](repo,home,False)
assert p['dryRun'] and p['files']==3
assert not (home/'Library').exists()
`));
test('installed launch agent runs the pinned observer without manual IDs or credentials', { skip: process.platform === 'win32' }, () => check(`
p=m['install'](repo,home,True)
a=plistlib.loads(pathlib.Path(p['plist']).read_bytes())
assert a['Label']=='local.chengong.tokenmonitor.cloudauto'
assert a['ProgramArguments'][1].endswith('scripts/codex-cloud-auto-watch.js')
assert '--acknowledge-auto-attach' in a['ProgramArguments'] and '--thread' not in a['ProgramArguments']
assert a['RunAtLoad'] and a['KeepAlive']=={'SuccessfulExit':False} and a['ThrottleInterval']==60
assert set(a['EnvironmentVariables'])=={'HOME','PATH'}
assert pathlib.Path(p['backup']).joinpath(app.name).is_dir()
assert all(pathlib.Path(x).is_file() for x in p['shortcuts'].values())
assert 'bootout' in pathlib.Path(p['shortcuts']['stop']).read_text()
assert 'turn/interrupt' not in pathlib.Path(p['shortcuts']['stop']).read_text()
`));
test('existing service definition is not silently replaced', { skip: process.platform === 'win32' }, () => check(`
p=home/'Library/LaunchAgents/local.chengong.tokenmonitor.cloudauto.plist';p.parent.mkdir(parents=True);p.write_text('existing job')
try:m['install'](repo,home,True);raise AssertionError('overwrote job')
except ValueError as e:assert str(e)=='EXISTING_AUTO_SERVICE_REQUIRES_REVIEW'
assert p.read_text()=='existing job'
`));
test('existing shortcut is not overwritten even before service deployment', { skip: process.platform === 'win32' }, () => check(`
p=home/'Applications/云端Token自动监听-启动.command';p.write_text('keep user entry')
try:m['install'](repo,home,True);raise AssertionError('overwrote shortcut')
except ValueError as e:assert str(e)=='EXISTING_AUTO_SERVICE_REQUIRES_REVIEW'
assert p.read_text()=='keep user entry'
`));
test('modified package fails verification before persistent deployment', { skip: process.platform === 'win32' }, () => check(`
(res/'node_modules/undici/package.json').write_text('changed')
try:m['install'](repo,home,True);raise AssertionError('accepted changed package')
except ValueError as e:assert str(e)=='INSTALLED_SOURCE_CONFLICT'
assert not (home/'Library').exists()
`));
