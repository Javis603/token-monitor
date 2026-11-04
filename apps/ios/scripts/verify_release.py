#!/usr/bin/env python3
"""Check the actual iOS archive before export; never uploads anything.

This catches this project's known private WidgetKit bridge and packaging
mistakes. It is not a replacement for App Review or an exhaustive API audit.
"""

import argparse
import plistlib
import subprocess
import sys
from pathlib import Path


APP_GROUP = "group.com.javis.tokenmonitor.ios"
PRIVATE_MARKERS = (
    b"CHSWidgetDescriptor",
    b"CHSBaseDescriptor",
    b"_TtCC9WidgetKit24WidgetExtensionXPCServer14ExportedObject",
    b"_TtC9WidgetKit21DescriptorFetchResult",
    b"getAllCurrentDescriptorsWithCompletion:",
    b"setPreferredBackgroundStyle:",
    b"TokenMonitorWidgetHostSurface",
)


def load_plist(path):
    with path.open("rb") as stream:
        return plistlib.load(stream)


def verify(product, allow_unsigned=False, distribution=False):
    errors = []
    notes = []
    archive = None if product.suffix == ".app" else product
    apps = [product] if archive is None else list((archive / "Products/Applications").glob("*.app"))
    if len(apps) != 1:
        return ["Expected one app under Products/Applications."], notes
    app = apps[0]
    extensions = list((app / "PlugIns").glob("*.appex"))
    if len(extensions) != 1:
        errors.append("Expected one embedded Widget/Live Activity extension.")

    app_info = load_plist(app / "Info.plist")
    version = (app_info.get("CFBundleShortVersionString"), app_info.get("CFBundleVersion"))
    if not all(version):
        errors.append("App version and build number must be set.")
    notes.append(f"App: {app_info.get('CFBundleIdentifier')} {version[0]} ({version[1]})")
    if app_info.get("DTPlatformName") != "iphoneos":
        errors.append("Archive must contain an iOS device build, not a Simulator build.")
    if "ITSAppUsesNonExemptEncryption" not in app_info:
        notes.append("Export-compliance answer is unset; confirm it in App Store Connect before distribution.")

    for bundle in [app] + extensions:
        info = load_plist(bundle / "Info.plist")
        executable = bundle / info["CFBundleExecutable"]
        binary = executable.read_bytes()
        found = [marker.decode() for marker in PRIVATE_MARKERS if marker in binary]
        if found:
            errors.append(f"{bundle.name}: private WidgetKit bridge present: {', '.join(found)}")
        manifest = bundle / "PrivacyInfo.xcprivacy"
        if not manifest.is_file():
            errors.append(f"{bundle.name}: missing bundled PrivacyInfo.xcprivacy.")
        else:
            privacy = load_plist(manifest)
            if privacy.get("NSPrivacyTracking") is not False:
                errors.append(f"{bundle.name}: reviewed build must explicitly disable tracking.")
            for key in ["NSPrivacyTrackingDomains", "NSPrivacyCollectedDataTypes", "NSPrivacyAccessedAPITypes"]:
                if not isinstance(privacy.get(key), list):
                    errors.append(f"{bundle.name}: {key} must be an array.")
            if bundle == app:
                defaults_reasons = {
                    reason
                    for entry in privacy.get("NSPrivacyAccessedAPITypes", [])
                    if entry.get("NSPrivacyAccessedAPIType") == "NSPrivacyAccessedAPICategoryUserDefaults"
                    for reason in entry.get("NSPrivacyAccessedAPITypeReasons", [])
                }
                if "CA92.1" not in defaults_reasons:
                    errors.append("App manifest must declare its own preferences UserDefaults use (CA92.1).")
        if bundle != app:
            if (info.get("CFBundleShortVersionString"), info.get("CFBundleVersion")) != version:
                errors.append(f"{bundle.name}: version/build differs from app.")
            point = info.get("NSExtension", {}).get("NSExtensionPointIdentifier")
            if point != "com.apple.widgetkit-extension":
                errors.append(f"{bundle.name}: unexpected extension point.")
        if archive is not None and not (archive / "dSYMs" / f"{bundle.name}.dSYM").is_dir():
            errors.append(f"{bundle.name}: missing archive dSYM.")
        if allow_unsigned:
            continue
        signature = subprocess.run(
            ["codesign", "--verify", "--strict", str(bundle)], capture_output=True
        )
        if signature.returncode:
            errors.append(f"{bundle.name}: signature verification failed.")
            continue
        entitlements = subprocess.run(
            ["codesign", "-d", "--entitlements", ":-", str(bundle)], capture_output=True
        )
        try:
            values = plistlib.loads(entitlements.stdout)
        except (plistlib.InvalidFileException, ValueError):
            errors.append(f"{bundle.name}: cannot read signing entitlements.")
            continue
        if APP_GROUP not in values.get("com.apple.security.application-groups", []):
            errors.append(f"{bundle.name}: missing App Group signing entitlement.")
        if not distribution:
            continue
        if values.get("get-task-allow") is True:
            errors.append(f"{bundle.name}: development debugging entitlement remains enabled.")
        if not values.get("application-identifier"):
            errors.append(f"{bundle.name}: missing distribution application identifier.")
        if not (bundle / "embedded.mobileprovision").is_file():
            errors.append(f"{bundle.name}: missing provisioning profile.")
        if bundle == app and values.get("aps-environment") != "production":
            errors.append("App: production APNs signing entitlement is required.")

    frameworks = app.rglob("*.framework")
    for framework in frameworks:
        info = load_plist(framework / "Info.plist")
        executable = framework / info["CFBundleExecutable"]
        if any(marker in executable.read_bytes() for marker in PRIVATE_MARKERS):
            errors.append(f"{framework.name}: private WidgetKit bridge present.")
    return errors, notes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", type=Path, help="Path to a device .xcarchive or an exported .app")
    parser.add_argument("--distribution", action="store_true", help="Also require production signing on the exported app")
    parser.add_argument("--allow-unsigned", action="store_true", help="Packaging checks only; cannot certify distribution signing")
    args = parser.parse_args()
    if args.distribution and args.allow_unsigned:
        parser.error("--distribution cannot be combined with --allow-unsigned")
    try:
        errors, notes = verify(args.product, args.allow_unsigned, args.distribution)
    except (OSError, ValueError, KeyError, TypeError, plistlib.InvalidFileException) as error:
        print(f"FAIL: archive could not be inspected: {error}", file=sys.stderr)
        return 1
    for note in notes:
        print(f"NOTE: {note}")
    for error in errors:
        print(f"FAIL: {error}")
    if args.allow_unsigned:
        print("NOTE: signing was skipped; this does not establish upload readiness.")
    if not args.distribution:
        print("NOTE: final export/distribution signing is not certified by this run.")
    if errors:
        return 1
    print("PASS: archive checks passed; account setup, device/APNs acceptance and App Review remain separate.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
