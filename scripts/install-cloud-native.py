#!/usr/bin/env python3
"""Install the locally built Token Monitor and migrate its existing cloud service.
Default: validate only. --apply creates a rollback backup before any replacement.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import tempfile
import time

LABEL = 'local.chengong.tokenmonitor.cloudauto'
APP_ID = 'com.javis.tokenmonitor'
VERSION = '0.66.0-cloud.2'


def invoke(args, check=True, timeout=30):
    return subprocess.run(args, capture_output=True, text=True, check=check, timeout=timeout)


def restore_service(domain, plist):
    target = f'{domain}/{LABEL}'
    invoke(['/bin/launchctl', 'enable', target])
    last = None
    for attempt in range(4):
        loaded = invoke(['/bin/launchctl', 'print', target], check=False)
        if loaded.returncode == 0:
            break
        result = invoke(['/bin/launchctl', 'bootstrap', domain, str(plist)], check=False)
        if result.returncode == 0:
            break
        last = result
        time.sleep(1 + attempt)
    else:
        raise RuntimeError('Service bootstrap failed: ' + str(last.returncode))
    started = invoke(['/bin/launchctl', 'kickstart', target], check=False)
    state = invoke(['/bin/launchctl', 'print', target], check=False)
    if started.returncode and state.returncode:
        raise RuntimeError('Service start failed: ' + str(started.returncode))


def running_app_pids(executable):
    result = invoke(['/bin/ps', '-axo', 'pid=,comm=']).stdout
    return [int(parts[0]) for line in result.splitlines()
            if len(parts := line.strip().split(None, 1)) == 2 and parts[1] == str(executable)]


def inspect(repo, home, target):
    built = repo / 'dist/cloud-native/mac-arm64/Token Monitor.app'
    old = plistlib.loads((target / 'Contents/Info.plist').read_bytes())
    new = plistlib.loads((built / 'Contents/Info.plist').read_bytes())
    if target.is_symlink() or old.get('CFBundleIdentifier') != APP_ID or new.get('CFBundleIdentifier') != APP_ID or new.get('CFBundleShortVersionString') != VERSION:
        raise ValueError('Unexpected application identity/version')
    invoke(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(built)])
    relative = 'Contents/Resources/cloud-observer/scripts/codex-cloud-auto-watch.js'
    if (built / relative).read_bytes() != (repo / 'scripts/codex-cloud-auto-watch.js').read_bytes():
        raise ValueError('Packaged observer differs from validated source')
    plist = home / 'Library/LaunchAgents' / (LABEL + '.plist')
    spec = plistlib.loads(plist.read_bytes())
    args = spec.get('ProgramArguments', [])
    data = home / 'Library/Application Support/Token Monitor Usage Test/auto-cloud'
    if spec.get('Label') != LABEL or len(args) < 5 or '--data-dir' not in args or args[args.index('--data-dir') + 1] != str(data):
        raise ValueError('Unexpected service configuration; migration refused')
    if Path(args[1]).name != 'codex-cloud-auto-watch.js' or not Path(args[0]).is_file():
        raise ValueError('Unexpected observer executable')
    report = data / 'report.json'
    if report.is_symlink() or report.stat().st_size > 8 * 1024 * 1024:
        raise ValueError('Unsafe old report')
    raw = json.loads(report.read_text())
    if raw.get('kind') != 'codex-cloud-auto-watch':
        raise ValueError('Unexpected report schema')
    return built, old, plist, spec, data, relative


def install(apply=False):
    repo = Path(__file__).resolve().parent.parent
    home = Path.home()
    target = Path('/Applications/Token Monitor.app')
    built, old, plist, spec, data, relative = inspect(repo, home, target)
    plan = {'app': str(target), 'previousVersion': old.get('CFBundleShortVersionString'), 'version': VERSION,
            'serviceLabel': LABEL, 'dataPreservedAt': str(data), 'dryRun': not apply}
    if not apply:
        return plan
    if invoke(['git', '-C', str(repo), 'status', '--porcelain']).stdout.strip():
        raise ValueError('Commit and validate the source before installation')
    backup_root = home / 'Library/Application Support/Token Monitor Cloud Integration/backups'
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if backup_root.is_symlink():
        raise ValueError('Unsafe backup directory')
    backup = Path(tempfile.mkdtemp(prefix='before-native-', dir=backup_root))
    backup.chmod(0o700)
    invoke(['/usr/bin/ditto', str(target), str(backup / 'Token Monitor.app')], timeout=120)
    shutil.copy2(plist, backup / plist.name)
    for directory in ['token-monitor', 'Token Monitor']:
        settings = home / 'Library/Application Support' / directory / 'settings.json'
        if settings.is_file() and not settings.is_symlink():
            shutil.copy2(settings, backup / (directory + '-settings.json'))
    retained = data / 'native-previous-report.json'
    if retained.is_symlink():
        raise ValueError('Unsafe prior snapshot destination')
    if retained.exists():
        shutil.copy2(retained, backup / 'previous-native-report.json')
    domain = f'gui/{os.getuid()}'
    state = invoke(['/bin/launchctl', 'print', f'{domain}/{LABEL}'], check=False).stdout
    was_running = 'state = running' in state
    staging = target.parent / ('Token Monitor.native-staging-' + backup.name + '.app')
    replaced = False
    service_changed = False
    service_unloaded = False
    try:
        if staging.exists():
            raise ValueError('Unexpected staging collision')
        invoke(['/usr/bin/ditto', str(built), str(staging)], timeout=120)
        invoke(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(staging)])
        for pid in running_app_pids(target / 'Contents/MacOS/Token Monitor'):
            os.kill(pid, signal.SIGTERM)
        until = time.monotonic() + 15
        while running_app_pids(target / 'Contents/MacOS/Token Monitor') and time.monotonic() < until:
            time.sleep(.2)
        if running_app_pids(target / 'Contents/MacOS/Token Monitor'):
            raise ValueError('Application did not quit; original is unchanged')
        target.rename(backup / 'Installed-original.app')
        staging.rename(target)
        replaced = True
        # Keep a same-account last-known snapshot for native display, not a sum.
        shutil.copy2(data / 'report.json', backup / 'pre-migration-report.json')
        current_report = json.loads((data / 'report.json').read_text())
        try:
            previous_report = json.loads(retained.read_text())
        except (OSError, ValueError):
            previous_report = None
        # An earlier rollback may have restarted the collector. Preserve valid
        # previous values until a new per-thread event replaces them; never add.
        if isinstance(previous_report, dict) and previous_report.get('scopeFingerprint') == current_report.get('scopeFingerprint'):
            old_rows = {r.get('threadId'): r for r in previous_report.get('threads', []) if isinstance(r, dict) and r.get('total') is not None and r.get('status') == 'observed' and not r.get('problem')}
            for index, row in enumerate(current_report.get('threads', [])):
                if row.get('total') is None and row.get('status') == 'no-usage-notification' and row.get('threadId') in old_rows:
                    current_report['threads'][index] = old_rows[row['threadId']]
        retained.write_text(json.dumps(current_report, ensure_ascii=False, indent=2) + '\n')
        retained.chmod(0o600)
        invoke(['/bin/launchctl', 'bootout', f'{domain}/{LABEL}'], check=False)
        service_unloaded = True
        # launchd removal and process exit can outlast bootout's return.
        until = time.monotonic() + 10
        while invoke(['/bin/launchctl', 'print', f'{domain}/{LABEL}'], check=False).returncode == 0 and time.monotonic() < until:
            time.sleep(.2)
        spec['ProgramArguments'][1] = str(target / relative)
        temporary = plist.with_suffix('.new')
        with temporary.open('xb') as handle:
            handle.write(plistlib.dumps(spec))
        temporary.chmod(0o600)
        temporary.replace(plist)
        service_changed = True
        if was_running:
            restore_service(domain, plist)
        plan.update({'dryRun': False, 'backup': str(backup), 'serviceRestarted': was_running,
                     'runtimeScript': spec['ProgramArguments'][1],
                     'sourceCommit': invoke(['git', '-C', str(repo), 'rev-parse', 'HEAD']).stdout.strip(),
                     'appAsarSha256': hashlib.sha256((target / 'Contents/Resources/app.asar').read_bytes()).hexdigest()})
        record = backup / 'installation.json'
        record.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
        record.chmod(0o600)
        return plan
    except Exception as exc:
        diagnostic = {'errorType': type(exc).__name__}
        if isinstance(exc, subprocess.CalledProcessError):
            diagnostic.update({'command': exc.cmd, 'returnCode': exc.returncode, 'stderr': (exc.stderr or '')[-2000:]})
        (backup / 'install-failure.json').write_text(json.dumps(diagnostic, indent=2))
        if service_changed:
            invoke(['/bin/launchctl', 'bootout', f'{domain}/{LABEL}'], check=False)
            shutil.copy2(backup / plist.name, plist)
        if replaced:
            target.rename(backup / 'Failed-new.app')
            (backup / 'Installed-original.app').rename(target)
        elif not target.exists() and (backup / 'Installed-original.app').exists():
            (backup / 'Installed-original.app').rename(target)
        if was_running and service_unloaded:
            restore_service(domain, plist)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.apply), ensure_ascii=False))
    except Exception as exc:
        raise SystemExit('Native installation not completed: ' + type(exc).__name__) from None
