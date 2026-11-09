'use strict';

// Linux display-server selection for the widget window.
//
// Electron on a Wayland session runs the widget as a native Wayland client,
// and Wayland lets only the compositor place toplevel windows. The x/y passed
// to BrowserWindow and setPosition() are then ignored (KWin centers the
// widget instead), getBounds() reports a synthesized origin rather than the
// real position, and 'moved' never fires — so neither half of the
// windowBounds save/restore in main.js works, and every launch reopens the
// widget mid-screen. Routing the widget through XWayland restores the X11
// placement semantics that code was written against. KDE and GNOME both keep
// XWayland available, and Plasma hands X11 apps the fractional scale through
// Xft.dpi ("apps apply scaling themselves"), so rendering stays sharp.
//
// The historical opt-outs (ELECTRON_OZONE_PLATFORM_HINT and
// --ozone-platform-hint) are gone: Electron ignores them and forces Wayland
// whenever WAYLAND_DISPLAY is set. Appending --ozone-platform through
// app.commandLine is also too late for the browser process: its children get
// the switch while the browser itself stays on Wayland. launch.js therefore
// relaunches with a real argv switch before creating a window, spawning the
// AppImage itself ($APPIMAGE) in packaged builds rather than process.execPath,
// which points into the runtime's transient mount. The explicit switch prevents a relaunch loop
// and still lets users select native Wayland.
function switchArguments(argv) {
  const end = argv.indexOf('--');
  return end === -1 ? argv : argv.slice(0, end);
}

function shouldUseXWayland({ platform = process.platform, env = process.env, argv = process.argv } = {}) {
  if (platform !== 'linux') return false;
  if (!env.WAYLAND_DISPLAY) return false;
  if (!env.DISPLAY) return false;
  return !switchArguments(argv).some((arg) => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='));
}

function canPositionWindow({ platform = process.platform, env = process.env, argv = process.argv } = {}) {
  if (platform !== 'linux') return true;
  const switches = switchArguments(argv);
  const index = switches.indexOf('--ozone-platform');
  const backend = index === -1
    ? switches.find((arg) => arg.startsWith('--ozone-platform='))?.split('=')[1]
    : switches[index + 1];
  if (backend === 'wayland') return false;
  return !env.WAYLAND_DISPLAY || backend === 'x11';
}

function startWithXWayland({
  app, start,
  spawn = require('node:child_process').spawn,
  platform = process.platform,
  env = process.env,
  argv = process.argv,
  execPath = process.execPath,
  warn = console.warn
}) {
  if (!shouldUseXWayland({ platform, env, argv })) return start();
  const packaged = app.isPackaged;
  const executable = packaged && env.APPIMAGE ? env.APPIMAGE : execPath;
  let spawned = false;
  const failed = (error) => {
    warn(`[display] XWayland relaunch failed: ${error.message}`);
    if (!spawned) start();
  };
  const args = argv.slice(1);
  const end = args.indexOf('--');
  args.splice(end === -1 ? args.length : end, 0, '--ozone-platform=x11');
  let child;
  try {
    child = spawn(executable, args, {
      detached: packaged,
      stdio: packaged ? 'ignore' : 'inherit'
    });
  } catch (error) {
    failed(error);
    return;
  }
  child.once('error', failed);
  child.once('spawn', () => {
    spawned = true;
    if (packaged) {
      child.unref();
      app.exit(0);
    }
  });
  // Keep the development command alive so npm owns the app until it finishes.
  if (!packaged) child.once('exit', (code) => { if (spawned) app.exit(code ?? 1); });
}

module.exports = { shouldUseXWayland, canPositionWindow, startWithXWayland };
