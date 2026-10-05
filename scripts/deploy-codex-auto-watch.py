#!/usr/bin/env python3
"""Install the verified automatic cloud observer into the parallel test app only."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import tempfile
import uuid

LABEL = 'local.chengong.tokenmonitor.cloudauto'
ENTRY = 'scripts/codex-cloud-auto-watch.js'


def installer_module(repo):
    spec = importlib.util.spec_from_file_location('capture_installer', repo / 'scripts/deploy-codex-capture-entry.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ENTRY = ENTRY
    return module


def build_plist(node, entry, data, home):
    return {'Label': LABEL, 'ProgramArguments': [str(node), str(entry), '--acknowledge-auto-attach', '--data-dir', str(data)],
            'RunAtLoad': True, 'KeepAlive': {'SuccessfulExit': False}, 'ThrottleInterval': 60,
            'ProcessType': 'Background', 'Umask': 63, 'WorkingDirectory': str(home),
            'EnvironmentVariables': {'HOME': str(home), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
            'StandardOutPath': str(data / 'service.log'), 'StandardErrorPath': str(data / 'service-error.log')}


def install(repo, home, apply=False):
    repo, home = repo.resolve(), home.resolve()
    module = installer_module(repo)
    app = home / 'Applications/Token Monitor Usage Test.app'
    old, names, node = module.inspect(repo, app)
    data = home / 'Library/Application Support/Token Monitor Usage Test'
    auto = data / 'auto-cloud'
    agents = home / 'Library/LaunchAgents'
    plist = agents / (LABEL + '.plist')
    paths = {kind: home / 'Applications' / name for kind, name in {
        'start': '云端Token自动监听-启动.command', 'stop': '云端Token自动监听-停止.command', 'view': '云端Token自动监听-查看.command'}.items()}
    if plist.exists() or plist.is_symlink() or any(p.exists() or p.is_symlink() for p in paths.values()):
        raise ValueError('EXISTING_AUTO_SERVICE_REQUIRES_REVIEW')
    plan = {'kind': 'codex-auto-watch-deployment', 'dryRun': not apply, 'app': str(app), 'files': len(names),
            'label': LABEL, 'plist': str(plist), 'data': str(auto), 'shortcuts': {k: str(p) for k, p in paths.items()}}
    if not apply:
        return plan
    head = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain'], text=True).strip():
        raise ValueError('COMMIT_SOURCE_BEFORE_DEPLOYMENT')
    for directory in [data, auto, agents, data / 'backups']:
        if directory.is_symlink():
            raise ValueError('SYMLINK_DEPLOYMENT_DIRECTORY')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = Path(tempfile.mkdtemp(prefix='before-auto-watch-', dir=data / 'backups'))
    shutil.copytree(app, backup / app.name, symlinks=True)
    stage = Path(tempfile.mkdtemp(prefix='Resources.autowatch-', dir=app / 'Contents'))
    resource = app / 'Contents/Resources'
    previous = app / 'Contents' / ('Resources.before-auto-' + uuid.uuid4().hex)
    manifest = dict(old)
    manifest.update({'version': 4, 'sourceCommit': head, 'sourceDirty': False, 'autoWatchEntry': ENTRY, 'files': {}})
    replaced = False
    created = []
    try:
        for name in sorted(names):
            src = module.inside(repo, name)
            dst = stage / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            dst.chmod(0o600)
            manifest['files'][name] = module.digest(dst)
        (stage / 'deployment.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (stage / 'deployment.json').chmod(0o600)
        if subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip() != head or subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain'], text=True).strip():
            raise ValueError('SOURCE_CHANGED_DURING_DEPLOYMENT')
        resource.rename(previous)
        stage.rename(resource)
        replaced = True
        definition = build_plist(node, resource / ENTRY, auto, home)
        with plist.open('xb') as handle:
            created.append(plist)
            handle.write(plistlib.dumps(definition))
        plist.chmod(0o600)
        prefix = '#!/bin/zsh\nset -eu\nDOMAIN="gui/$(id -u)"\nLABEL=' + shlex.quote(LABEL) + '\nPLIST=' + shlex.quote(str(plist)) + '\n'
        scripts = {
            'start': prefix + '/bin/launchctl enable "$DOMAIN/$LABEL"\nif /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then /bin/launchctl kickstart "$DOMAIN/$LABEL"; else /bin/launchctl bootstrap "$DOMAIN" "$PLIST"; fi\necho "自动发现和监听已启用，无需填写线程 ID。"\n',
            'stop': prefix + '/bin/launchctl disable "$DOMAIN/$LABEL"\n/bin/launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true\necho "自动监听已停止；不会中断云端任务。"\n',
            'view': '#!/bin/zsh\nset -eu\nREPORT=' + shlex.quote(str(auto / 'report.html')) + '\nif [ -f "$REPORT" ]; then /usr/bin/open "$REPORT"; else echo "首次目录读取尚未完成，请稍后再打开。"; fi\n'
        }
        for kind, text in scripts.items():
            with paths[kind].open('x') as handle:
                created.append(paths[kind])
                handle.write(text)
            paths[kind].chmod(0o700)
        for filename in ['service.log', 'service-error.log']:
            file = auto / filename
            if not file.exists():
                with file.open('x') as handle:
                    handle.write('')
                file.chmod(0o600)
        plan.update({'sourceCommit': head, 'backup': str(backup), 'dryRun': False})
        (backup / 'upgrade-receipt.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
        (backup / 'upgrade-receipt.json').chmod(0o600)
        shutil.move(str(previous), str(backup / 'Resources.previous'))
        return plan
    except Exception:
        for p in reversed(created):
            p.unlink(missing_ok=True)
        if replaced:
            resource.rename(backup / 'Resources.failed')
            previous.rename(resource)
        elif previous.exists() and not resource.exists():
            previous.rename(resource)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    print(json.dumps(install(repo, Path.home(), args.apply), ensure_ascii=False))


if __name__ == '__main__':
    main()
