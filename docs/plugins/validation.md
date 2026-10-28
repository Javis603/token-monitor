# Plugin platform validation

Run `npm run verify` for lint and Node tests. `npm run verify:plugins` exercises the optional Node process and actual runtime installation/enablement. Native acceptance requires a usable desktop session and the repository's existing Electron build; it must not install third-party code or read a personal profile.

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-plugin-trusted.cjs
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-plugin-trusted-runtime.cjs
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-plugin-trusted-app.cjs
# Keep the synthetic App open after assertions for a manual look (never the real profile):
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-plugin-trusted-app.cjs --demo
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-plugin-trusted-surfaces.cjs
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-plugin-trusted-runtime.cjs --plugins-safe-mode
# macOS: local unsigned ASAR/native-addon smoke
node scripts/test-plugin-trusted-packaged.cjs
```

Fixtures use self-authored minimal modules and scratch data. The engine fixture covers shared process identity, local file IO, loopback network, host calls and teardown. The runtime fixture uses real management and preload IPC. The App fixture loads production index.html, app.js, styles and preload with real plugin runtime; non-plugin collector/account IPC is synthetic. It enumerates all current native main-page targets, session detail, section/inline selectors, navigation ordering, native row reuse, custom author settings, Tray callback and actual cooperative disable/native restoration. The secondary fixture covers all four native Notch pages, compact summary and Dock rail/card. It is not full-main, packaged or physical Notch acceptance. Keep these distinctions in reports.

Acceptance must cover installation without execution, explicit revision trust, one backend across surfaces, no-demand shutdown, source/period updates, retained drafts, original-content selection, native fallback, update/rollback, removal retention and external safe mode. With no active plugins, verify that the host adds no continuous plugin sampling, process or projection work. This does not promise identical RAM bytes, and arbitrary trusted author timers remain the author's responsibility.

For compact surfaces, exercise actual Notch and Dock renderers and their host-owned geometry/hit regions. A tray bitmap supports painting, not DOM controls. Verify native keyboard/mouse behavior on the target OS, including hide/minimize and multiple visible consumers. Full main/packaged and Windows/Linux checks are separate from source-mode fixtures.

For packaging, exercise the utility-process entry from an ASAR and package-local modules outside it. Native addons depend on OS, architecture, Electron ABI and signing/library restrictions. Test a known local fixture where feasible; never infer universal native-addon support. Do not disable OS protection to force a result.

Validate the current same-page UI and local backend through their production paths. Record the exact tested revision, failures, environment limitations and before/after captures. Keep logs and screenshots in local/CI artifacts rather than embedding changing counts in this contract.
