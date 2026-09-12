'use strict';

/**
 * Real-screen verification: places the REAL taskbar widget window exactly where
 * production puts it (taskbarWidgetBounds on the primary display), loads the
 * REAL widget page, then captures the screen via PowerShell GDI and crops the
 * taskbar strip region for pixel analysis.
 *
 * Run from the repo root:
 *   node_modules/electron/dist/electron.exe scripts/verify-taskbar-real.js
 */

const { app, BrowserWindow, screen, desktopCapturer } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { taskbarWidgetBounds } = require('../src/electron/taskbarWidget');

const OUT_SCREEN = path.join(__dirname, '..', 'taskbar-real-screen.png');
const OUT_STRIP = path.join(__dirname, '..', 'taskbar-real-strip.png');
const LOG_FILE = path.join(__dirname, 'verify-taskbar-real.log');

function log(line) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  process.stdout.write(line + '\n');
}

function captureScreen() {
  return new Promise((resolve, reject) => {
    const display = screen.getPrimaryDisplay();
    const size = display.size;
    desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: size.width, height: size.height }
    }).then((sources) => {
      const primary = sources.find((s) => s.display_id === String(display.id)) || sources[0];
      if (!primary) return reject(new Error('no screen source'));
      fs.writeFileSync(OUT_SCREEN, primary.thumbnail.toPNG());
      resolve();
    }).catch(reject);
  });
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  log('display: ' + JSON.stringify({ bounds: display.bounds, workArea: display.workArea, size: display.size, scaleFactor: display.scaleFactor }));
  const b = taskbarWidgetBounds(display);
  log('widget bounds (DIP): ' + JSON.stringify(b));

  const win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on('console-message', (_e, level, message) => log('renderer console [' + level + ']: ' + message));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load: ' + code + ' ' + desc + ' ' + url));
  await win.loadFile(path.join(__dirname, '..', 'src', 'electron', 'renderer', 'taskbarWidget.html'));
  log('loadFile done');
  win.show();
  // Let the first paint and font loading settle, then re-assert bounds like
  // production does 300ms after showing.
  await new Promise((r) => setTimeout(r, 700));
  win.setBounds(taskbarWidgetBounds(screen.getPrimaryDisplay()));
  win.setAlwaysOnTop(true, 'screen-saver');
  await win.webContents.executeJavaScript(
    `document.getElementById('total').textContent = '2,000,000,000 tokens';
     const period = document.getElementById('period') || document.getElementById('today');
     if (period) period.textContent = '今日 29,000,000';`
  );
  await new Promise((r) => setTimeout(r, 1500));
  log('window actual bounds (DIP): ' + JSON.stringify(win.getBounds()));
  await captureScreen();

  // The PowerShell GDI capture runs DPI-virtualized (not DPI aware), so the
  // bitmap is in DIP space: crop with DIP coordinates directly.
  const stripY = Math.round(display.workArea.y + display.workArea.height);
  const stripX = Math.round(display.bounds.x);
  const stripW = Math.round(display.bounds.width);
  const stripH = Math.round(display.bounds.y + display.bounds.height) - stripY;
  log('strip crop (DIP): x=' + stripX + ' y=' + stripY + ' w=' + stripW + ' h=' + stripH);
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$src=New-Object System.Drawing.Bitmap('${OUT_SCREEN.replace(/'/g, "''")}')`,
    `$dst=New-Object System.Drawing.Bitmap(${stripW},${stripH})`,
    '$g=[System.Drawing.Graphics]::FromImage($dst)',
    `$g.DrawImage($src,(New-Object System.Drawing.Rectangle(0,0,${stripW},${stripH})),(New-Object System.Drawing.Rectangle(${stripX},${stripY},${stripW},${stripH})),[System.Drawing.GraphicsUnit]::Pixel)`,
    `$dst.Save('${OUT_STRIP.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose();$src.Dispose();$dst.Dispose()'
  ].join(';');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
  log('strip saved: ' + OUT_STRIP);
  app.exit(0);
}).catch((e) => {
  log('FATAL: ' + (e && e.stack ? e.stack : e));
  app.exit(1);
});
