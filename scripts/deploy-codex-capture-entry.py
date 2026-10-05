#!/usr/bin/env python3
"""Upgrade only the existing parallel usage test app and add a desktop capture shortcut."""
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
import tempfile
import uuid

ENTRY = 'scripts/codex-cloud-capture-desktop.js'
SAFE_PREFIXES = ('scripts/', 'src/shared/', 'docs/licenses/', 'node_modules/undici/')


def inside(root, name):
    candidate = root / name
    if not name or Path(name).is_absolute() or '..' in Path(name).parts:
        raise ValueError('UNSAFE_PACKAGE_PATH')
    if candidate.is_symlink() or not candidate.resolve().is_relative_to(root.resolve()):
        raise ValueError('SYMLINK_PACKAGE_PATH')
    return candidate


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def sources(repo):
    seen = set()
    # The observer is a subprocess entry, not a require() edge.
    pending = [repo / ENTRY, repo / 'scripts/codex-cloud-engine-usage.js']
    while pending:
        file = pending.pop()
        if file in seen:
            continue
        if file.is_symlink() or not file.resolve().is_relative_to(repo) or not file.is_file():
            raise ValueError('INVALID_SOURCE_DEPENDENCY')
        seen.add(file)
        for module in re.findall(r'''require\(['"]([^'"]+)['"]\)''', file.read_text()):
            if module.startswith('node:') or module == 'undici':
                continue
            if not module.startswith('.'):
                raise ValueError('UNEXPECTED_EXTERNAL_DEPENDENCY')
            base = (file.parent / module).resolve()
            match = next((p for p in (base, base.with_suffix('.js'), base / 'index.js') if p.is_file()), None)
            if not match:
                raise ValueError('MISSING_SOURCE_DEPENDENCY')
            pending.append(match)
    return {str(p.relative_to(repo)) for p in seen}


def inspect(repo, app):
    repo = repo.resolve()
    if app.name != 'Token Monitor Usage Test.app' or app.is_symlink():
        raise ValueError('NOT_THE_PARALLEL_TEST_APP')
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != 'local.chengong.tokenmonitor.usagetest':
        raise ValueError('UNEXPECTED_BUNDLE_ID')
    resources = app / 'Contents/Resources'
    if resources.is_symlink():
        raise ValueError('SYMLINK_RESOURCES')
    old = json.loads((resources / 'deployment.json').read_text())
    if old.get('kind') != 'token-monitor-usage-test' or not isinstance(old.get('files'), dict) or len(old['files']) > 5000:
        raise ValueError('INVALID_OLD_MANIFEST')
    for name, expected in old['files'].items():
        if not name.startswith(SAFE_PREFIXES) or digest(inside(resources, name)) != expected:
            raise ValueError('INSTALLED_SOURCE_CONFLICT')
    actual = {str(p.relative_to(resources)) for p in resources.rglob('*') if p.is_file()}
    if actual - set(old['files']) - {'deployment.json', '.DS_Store'}:
        raise ValueError('UNMANIFESTED_PACKAGE_CONTENT')
    names = set(old['files']) | sources(repo)
    if not any(n.startswith('node_modules/undici/') for n in names):
        raise ValueError('EXISTING_RUNTIME_REQUIRED')
    for name in names:
        p = inside(repo, name)
        if not name.startswith(SAFE_PREFIXES) or not p.is_file() or p.stat().st_size > 8_000_000:
            raise ValueError('UNSAFE_SOURCE_FILE')
    node = Path(old.get('nodeExecutable', ''))
    if not node.is_absolute() or not node.is_file() or not os.access(node, os.X_OK):
        raise ValueError('EXISTING_NODE_UNAVAILABLE')
    return old, names, node


def install(repo, app, data_root, apply=False):
    repo = repo.resolve()
    old, names, node = inspect(repo, app)
    plan = {'kind': 'desktop-capture-deployment', 'dryRun': not apply, 'app': str(app),
            'previousCommit': old.get('sourceCommit'), 'packageFiles': len(names),
            'entry': ENTRY, 'newNetworkDependencies': 0}
    if not apply:
        return plan
    head = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain'], text=True).strip():
        raise ValueError('COMMIT_SOURCE_BEFORE_DEPLOYMENT')
    if data_root.is_symlink() or not data_root.is_dir():
        raise ValueError('EXISTING_PRIVATE_DATA_DIRECTORY_REQUIRED')
    launcher = app.parent / '云端实时Token监听.command'
    if launcher.exists() or launcher.is_symlink():
        raise ValueError('SHORTCUT_ALREADY_EXISTS')
    backups = data_root / 'backups'
    if backups.is_symlink():
        raise ValueError('SYMLINK_BACKUPS')
    backups.mkdir(mode=0o700, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix='before-desktop-capture-', dir=backups))
    shutil.copytree(app, backup / app.name, symlinks=True)
    stage = Path(tempfile.mkdtemp(prefix='Resources.capture-', dir=app / 'Contents'))
    resources = app / 'Contents/Resources'
    manifest = dict(old)
    manifest.update({'version': max(int(old.get('version', 1)), 3), 'sourceCommit': head, 'sourceDirty': False,
                     'desktopCaptureEntry': ENTRY, 'files': {}})
    previous = app / 'Contents' / ('Resources.before-capture-' + uuid.uuid4().hex)
    replaced = False
    created_launcher = False
    try:
        for name in sorted(names):
            src = inside(repo, name)
            dst = stage / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            dst.chmod(0o600)
            manifest['files'][name] = digest(dst)
        m = stage / 'deployment.json'
        m.write_text(json.dumps(manifest, indent=2) + '\n')
        m.chmod(0o600)
        if subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip() != head or subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain'], text=True).strip():
            raise ValueError('SOURCE_CHANGED_DURING_DEPLOYMENT')
        resources.rename(previous)
        stage.rename(resources)
        replaced = True
        code = '#!/bin/zsh\nset -eu\nprintf "%s\\n" "Codex 云端实时 Token：选择线程后监听 60 秒，结束时打开报告。"\nexec '
        code += shlex.quote(str(node)) + ' ' + shlex.quote(str(resources / ENTRY)) + ' "$@"\n'
        with launcher.open('x') as handle:
            created_launcher = True
            handle.write(code)
        launcher.chmod(0o700)
        plan.update({'sourceCommit': head, 'shortcut': str(launcher), 'backup': str(backup), 'dryRun': False})
        receipt = backup / 'upgrade-receipt.json'
        receipt.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
        receipt.chmod(0o600)
        shutil.move(str(previous), str(backup / 'Resources.previous'))
        return plan
    except Exception:
        if replaced:
            failed = backup / 'Resources.failed'
            resources.rename(failed)
            previous.rename(resources)
        elif previous.exists() and not resources.exists():
            previous.rename(resources)
        if created_launcher and launcher.exists():
            launcher.unlink()
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--app', type=Path, default=Path.home() / 'Applications/Token Monitor Usage Test.app')
    parser.add_argument('--data-root', type=Path, default=Path.home() / 'Library/Application Support/Token Monitor Usage Test')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    print(json.dumps(install(repo, args.app.absolute(), args.data_root.absolute(), args.apply), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        text = str(exc)
        raise SystemExit(text if re.fullmatch(r'[A-Z_]{1,80}', text) else 'CAPTURE_DEPLOYMENT_FAILED') from None
