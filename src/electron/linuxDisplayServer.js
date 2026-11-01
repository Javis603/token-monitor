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
// the switch while the browser itself stays on Wayland. main.js therefore
// relaunches with a real argv switch before creating a window, spawning the
// AppImage itself ($APPIMAGE) rather than process.execPath, which points into
// the runtime's transient mount. The explicit switch prevents a relaunch loop
// and still lets users select native Wayland.
function shouldUseXWayland({ platform = process.platform, env = process.env, argv = process.argv } = {}) {
  if (platform !== 'linux') return false;
  if (!env.WAYLAND_DISPLAY) return false;
  if (!env.DISPLAY) return false;
  return !argv.some((arg) => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='));
}

module.exports = { shouldUseXWayland };
