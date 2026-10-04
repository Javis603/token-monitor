#!/usr/bin/env python3
"""Install an isolated, source-only macOS usage-report test app. Never replace the widget."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import subprocess


def dependencies(repo):
    pending = [repo / 'scripts' / name for name in (
        'codex-task-usage.js', 'codex-live-usage.js', 'codex-usage-desktop.js')]
    files = set()
    while pending:
        file = pending.pop().resolve()
        if file in files:
            continue
        if not file.is_relative_to(repo) or not file.is_file():
            raise ValueError('Dependency outside repository or missing')
        files.add(file)
        for module in re.findall(r'''require\(['"]([^'"]+)['"]\)''', file.read_text()):
            if module.startswith('node:'):
                continue
            if module == 'undici':
                continue  # Existing pinned runtime is verified and copied below.
            if not module.startswith('.'):
                raise ValueError('Non-builtin dependency: ' + module)
            candidate = (file.parent / module).resolve()
            choices = [candidate, candidate.with_suffix('.js'), candidate / 'index.js']
            target = next((p for p in choices if p.is_file()), None)
            if target is None:
                raise ValueError('Unresolved dependency: ' + module)
            pending.append(target)
    return sorted(files)


def runtime_files(repo):
    root = repo / 'node_modules/undici'
    package = json.loads((root / 'package.json').read_text())
    if package.get('name') != 'undici' or package.get('dependencies'):
        raise ValueError('Unexpected undici runtime dependency graph')
    if not (root / 'LICENSE').is_file():
        raise ValueError('Missing undici license')
    files = sorted(p for p in root.rglob('*') if p.is_file())
    if any(p.is_symlink() for p in files):
        raise ValueError('Symlink runtime dependency is not bundled')
    return files


def install(repo, destination, node, thread_ids=()):
    repo = repo.resolve()
    destination = destination.expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError('Destination exists; refusing to replace any installed app')
    if destination.name != 'Token Monitor Usage Test.app':
        raise ValueError('Only the separate test app name is allowed')
    if not node.is_file() or not os.access(node, os.X_OK):
        raise ValueError('Node executable is unavailable')
    if any(not re.fullmatch(r'[A-Za-z0-9_.:-]{1,200}', t) for t in thread_ids):
        raise ValueError('Invalid thread identifier')
    source = dependencies(repo) + runtime_files(repo) + [repo / 'docs/licenses/planmeter.txt']
    commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    dirty = bool(subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain'], text=True).strip())
    data = Path.home() / 'Library/Application Support/Token Monitor Usage Test'
    if data.is_symlink():
        raise ValueError('Refusing a symlink data directory')
    settings = data / 'settings.json'
    if settings.exists():
        raise ValueError('Existing test settings require manual reconciliation')
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.mkdir(mode=0o700)
    resources = destination / 'Contents/Resources'
    macos = destination / 'Contents/MacOS'
    resources.mkdir(parents=True, mode=0o700)
    macos.mkdir(mode=0o700)
    manifest = {'kind': 'token-monitor-usage-test', 'version': 1, 'sourceCommit': commit,
                'sourceDirty': dirty, 'nodeExecutable': str(node), 'files': {}}
    for file in source:
        rel = file.relative_to(repo)
        target = resources / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
        target.chmod(0o600)
        manifest['files'][str(rel)] = hashlib.sha256(target.read_bytes()).hexdigest()
    plist = {'CFBundleIdentifier': 'local.chengong.tokenmonitor.usagetest',
             'CFBundleName': 'Token Monitor Usage Test',
             'CFBundleDisplayName': 'Token Monitor Usage Test',
             'CFBundleExecutable': 'UsageTest', 'CFBundlePackageType': 'APPL',
             'CFBundleShortVersionString': '0.1.0', 'CFBundleVersion': '1',
             'LSUIElement': True, 'NSHighResolutionCapable': True}
    (destination / 'Contents/Info.plist').write_bytes(plistlib.dumps(plist))
    launcher = macos / 'UsageTest'
    launcher.write_text('#!/bin/zsh\nset -eu\nRESOURCES="$(cd "$(dirname "$0")/../Resources" && pwd)"\n'
                        + 'exec ' + shlex.quote(str(node))
                        + ' "$RESOURCES/scripts/codex-usage-desktop.js" "$@"\n')
    launcher.chmod(0o700)
    data.mkdir(parents=True, mode=0o700, exist_ok=True)
    settings.write_text(json.dumps({'threadIds': list(dict.fromkeys(thread_ids))}, indent=2) + '\n')
    settings.chmod(0o600)
    manifest_path = resources / 'deployment.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    manifest_path.chmod(0o600)
    command = data / '本地线程统计.command'
    command.write_text('#!/bin/zsh\nset -eu\nexec ' + shlex.quote(str(launcher)) + ' --local\n')
    command.chmod(0o700)
    readme = data / '使用说明.txt'
    readme.write_text('双击 ~/Applications/Token Monitor Usage Test.app：读取账户和所选线程的服务端用量，打开本地报表。\n'
                      '双击 本地线程统计.command：读取 settings.json 中一个根线程及全部已知后代的本地累计用量。\n'
                      'settings.json 的 threadIds 可放真实引擎线程 ID；空数组只读账户。不要将任务卡片 ID 当成引擎线程 ID。\n'
                      '本地日志实测、服务端线程估算和账户累计是不同口径，不能直接相加。\n'
                      '本测试版不更改原 Token Monitor，不安装自启动，不启动新的模型任务。\n'
                      '卸载：退出测试查询后，将独立测试 app 移入废纸篓即可。报告保留于本目录 reports/，按需另行删除。\n', encoding='utf-8')
    readme.chmod(0o600)
    return {'app': str(destination), 'data': str(data), 'sourceCommit': commit,
            'sourceDirty': dirty, 'fileCount': len(source), 'bytes': sum(f.stat().st_size for f in source)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=Path.home() / 'Applications/Token Monitor Usage Test.app')
    parser.add_argument('--node', type=Path, default=Path('/opt/homebrew/bin/node'))
    parser.add_argument('--thread', action='append', default=[])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    if not args.apply:
        files = dependencies(repo)
        print(json.dumps({'dryRun': True, 'destination': str(args.destination), 'files': len(files)}, ensure_ascii=False))
        return
    print(json.dumps(install(repo, args.destination, args.node, args.thread), ensure_ascii=False))


if __name__ == '__main__':
    main()
