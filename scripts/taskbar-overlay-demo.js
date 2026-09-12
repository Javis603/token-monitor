'use strict';

/**
 * Taskbar overlay demo — proves that a "weather-style" token counter can live
 * on the left edge of the Windows taskbar.
 *
 * Concept: the native weather button (Widgets) cannot be customized, but a
 * frameless, transparent, always-on-top, click-through window can be placed
 * exactly over that spot. Clicks pass through to the real weather button, so
 * the Widgets board still opens.
 *
 * Run from the repo root:
 *   node_modules/electron/dist/electron.exe scripts/taskbar-overlay-demo.js
 *
 * The demo shows the real allTime total tokens (+ today) using the same
 * tokscale scan and the same extraction the widget uses, then captures a
 * screenshot of the screen to `<repo>/taskbar-overlay-demo.png` and exits.
 */

const { app, BrowserWindow, screen, desktopCapturer } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { DEFAULT_CLIENTS } = require('../src/shared/clientTracking.js');
const { extractUsageFromTokscale } = require('../src/shared/usage.js');

const ALL_TIME_SINCE = process.env.TOKEN_MONITOR_ALL_TIME_SINCE || '2024-01-01';
const SCAN_TIMEOUT_MS = 45_000;
const DEMO_LIFETIME_MS = 9_000; // capture a screenshot, then quit
const WATCHDOG_MS = DEMO_LIFETIME_MS + 30_000; // force exit no matter what
const CAPTURE_TIMEOUT_MS = 12_000;
const OVERLAY_WIDTH = 228;

let win = null;
let statsCache = null;
let scanInFlight = false;

// Stage logs go to a file: piped stdout is not reliable for long-running Electron.
const LOG_FILE = path.join(__dirname, 'taskbar-overlay-demo.log');
function log(line) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
}

function tokscaleBin() {
  // require.resolve returns the resolved main entry — for this package that IS
  // the exe path itself (main: "bin/tokscale.exe").
  const resolved = require.resolve('@tokscale/cli-win32-x64-msvc');
  return resolved.endsWith('tokscale.exe') ? resolved : path.join(path.dirname(resolved), 'bin', 'tokscale.exe');
}

function runTokscale(flags) {
  return new Promise((resolve, reject) => {
    const child = spawn(tokscaleBin(), flags, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`tokscale timed out: ${flags.join(' ')}`));
    }, SCAN_TIMEOUT_MS);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`tokscale exit ${code}: ${stderr.trim().slice(0, 300)}`));
      try { resolve(JSON.parse(stdout)); } catch (_) { reject(new Error(`bad JSON from tokscale: ${stdout.slice(0, 300)}`)); }
    });
  });
}

async function refreshStats() {
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    // Same client filter the widget's collector applies: proma is parsed
    // locally (jsonl), not via tokscale, so tokscale would reject the id.
    const clientFilter = DEFAULT_CLIENTS.split(',').filter((c) => c !== 'proma').join(',');
    const timeout = (p) => Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('scan timeout')), SCAN_TIMEOUT_MS))
    ]);
    const [allTimeJson, todayJson] = await Promise.all([
      timeout(runTokscale(['--json', '--client', clientFilter, '--group-by', 'client,model', '--since', ALL_TIME_SINCE, '--no-spinner'])),
      timeout(runTokscale(['--json', '--client', clientFilter, '--group-by', 'client,model', '--today', '--no-spinner']))
    ]);
    const allTime = extractUsageFromTokscale(allTimeJson);
    const today = extractUsageFromTokscale(todayJson);
    statsCache = {
      allTimeTotal: allTime.totalTokens,
      todayTotal: today.totalTokens,
      scannedAt: new Date().toISOString()
    };
    if (win && !win.isDestroyed()) win.webContents.send('stats', statsCache);
    log('stats: ' + JSON.stringify(statsCache));
  } catch (err) {
    log('scan failed: ' + err.message);
  } finally {
    scanInFlight = false;
  }
}

function taskbarRect() {
  const display = screen.getPrimaryDisplay();
  const { bounds, workArea } = display;
  const taskbarHeight = bounds.y + bounds.height - (workArea.y + workArea.height);
  if (taskbarHeight > 1) {
    // Bottom taskbar: overlay sits on the strip between workArea and screen edge.
    return {
      x: bounds.x,
      y: workArea.y + workArea.height,
      width: OVERLAY_WIDTH,
      height: taskbarHeight,
      display
    };
  }
  // Taskbar is autohidden or elsewhere: fall back to bottom-left, standard height.
  return { x: bounds.x, y: bounds.y + bounds.height - 48, width: OVERLAY_WIDTH, height: 48, display };
}

function overlayHtml() {
  return `<!doctype html><html><head><style>
    :root { --fg: #1a1a1a; --sub: rgba(26,26,26,0.68); --accent: #0067c0; }
    @media (prefers-color-scheme: dark) {
      :root { --fg: #ffffff; --sub: rgba(255,255,255,0.72); --accent: #4cc2ff; }
    }
  </style></head><body style="margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default;">
  <div style="height:100%;display:flex;align-items:center;gap:7px;padding:0 10px;box-sizing:border-box;font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;">
    <svg width="17" height="17" viewBox="0 0 16 16" style="flex:none">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
      <path d="M8 3.5v9M4.8 5.6l6.4 4.8M11.2 5.6l-6.4 4.8" stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    </svg>
    <div style="display:flex;flex-direction:column;justify-content:center;line-height:1.15;">
      <div id="total" style="font-size:12.5px;font-weight:600;color:var(--fg);white-space:nowrap;">—</div>
      <div id="today" style="font-size:10.5px;color:var(--sub);white-space:nowrap;">今日 —</div>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('stats', (e, s) => {
      document.getElementById('total').textContent = formatNumber(s.allTimeTotal) + ' tokens';
      document.getElementById('today').textContent = '今日 ' + formatNumber(s.todayTotal);
    });
    function formatNumber(value) {
      return Math.round(Number(value || 0)).toLocaleString('en-US');
    }
  </script></body></html>`;
}

function positionOverlay() {
  if (!win || win.isDestroyed()) return;
  const r = taskbarRect();
  win.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
  win.setAlwaysOnTop(true, 'screen-saver');
  log('overlay bounds: ' + JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }));
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(what + ' timed out')), ms))
  ]);
}

async function captureViaDesktopCapturer() {
  const display = screen.getPrimaryDisplay();
  const size = display.size;
  const sources = await withTimeout(
    desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: size.width, height: size.height }
    }),
    CAPTURE_TIMEOUT_MS,
    'desktopCapturer'
  );
  const primary = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!primary) throw new Error('no screen source');
  const out = path.join(__dirname, '..', 'taskbar-overlay-demo.png');
  fs.writeFileSync(out, primary.thumbnail.toPNG());
  log('screenshot saved (desktopCapturer): ' + out);
}

function captureViaPowerShell() {
  // Fallback: GDI CopyFromScreen — captures whatever is composited on screen,
  // including the topmost overlay window.
  return new Promise((resolve, reject) => {
    const out = path.join(__dirname, '..', 'taskbar-overlay-demo.png');
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)',
      `$bmp.Save('${out.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose();$bmp.Dispose()'
    ].join(';');
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('powershell capture exit ' + code));
      log('screenshot saved (powershell fallback): ' + out);
      resolve(out);
    });
  });
}

async function captureScreenshot() {
  try {
    await captureViaDesktopCapturer();
  } catch (err) {
    log('desktopCapturer failed (' + err.message + '), falling back to powershell');
    await captureViaPowerShell();
  }
}

app.whenReady().then(async () => {
  process.on('uncaughtException', (e) => {
    log('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
    app.exit(6);
  });
  process.on('unhandledRejection', (e) => {
    log('UNHANDLED REJECTION: ' + (e && e.stack ? e.stack : e));
    app.exit(7);
  });
  try {
    const r = taskbarRect();
    log('display bounds: ' + JSON.stringify(r.display.bounds) + ' workArea: ' + JSON.stringify(r.display.workArea));
    log('taskbar strip: y=' + r.y + ' height=' + r.height);

    win = new BrowserWindow({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: true,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    log('window created');

    win.setAlwaysOnTop(true, 'screen-saver');
    log('alwaysOnTop set');
    win.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through to the real weather button
    log('ignoreMouseEvents set');
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(overlayHtml()));
    log('loadURL called');
    win.once('ready-to-show', () => {
      log('ready-to-show');
      win.show();
    });
    win.webContents.on('did-finish-load', () => {
      log('renderer loaded');
      win.webContents.send('stats', statsCache);
    });

    positionOverlay();
    screen.on('display-metrics-changed', positionOverlay);
    setInterval(positionOverlay, 5000); // cheap sanity re-assert

    // Quit timer scheduled before the (slow) scan: the demo must never outlive
    // its lifetime, even if a scan or capture hangs.
    setTimeout(async () => {
      log('demo end: topmost=' + (win.isAlwaysOnTop()));
      await captureScreenshot();
      app.quit();
    }, DEMO_LIFETIME_MS);
    setTimeout(() => {
      log('watchdog fired — forcing exit');
      app.exit(0);
    }, WATCHDOG_MS);
    log('timers scheduled');

    await refreshStats();
    log('refreshStats done');
  } catch (e) {
    log('WHENREADY-THROW: ' + (e && e.stack ? e.stack : e));
    app.exit(2);
  }
});
