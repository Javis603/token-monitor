# Dependency patches

`npm ci` and `npm install` apply these patches through `patch-package --error-on-fail`. Keep `patch-package` in production dependencies so headless installs with `--omit=dev` receive the same fix. An install with `--ignore-scripts` must run `npm run postinstall` before running the collector or packaging the app.

## chokidar 4.0.3

Windows does not guarantee an updated last-write time until the writing handle closes ([File Times](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times)). With an open session log whose access time is newer than its unchanged modification time, chokidar's access-only filter also suppresses real appends and truncations. Include file size in that filter, preserving the suppression of access-only notifications. Patch both CommonJS and ESM builds and both fresh-stat and supplied-stat paths.

The dependency is pinned so an upgrade explicitly reviews this patch. This keeps the existing watcher backend, ignore rules, write-stability handling and debounce; an app-level raw-event workaround would duplicate those responsibilities. Remove the patch and tooling when upgrading to a version verified to handle size-only writes. `node --test tests/shared/watcherSizeChanges.test.js` exercises the installed dependency and fails without the patch.
