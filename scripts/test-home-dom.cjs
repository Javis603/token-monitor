'use strict';
// Real Chromium DOM, real Home builders; synthetic production-shaped usage data.
// Run: env -u ELECTRON_RUN_AS_NODE electron scripts/test-home-dom.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const espree = require('espree');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-home-dom-'));
app.setPath('userData', path.join(scratch, 'profile'));
const source = process.env.TM_HOME_BASE
  ? execFileSync('git', ['show', `${process.env.TM_HOME_BASE}:src/electron/renderer/app.js`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest' });
const names = ['homeModuleShell', 'homeLimitWindowLabel', 'renderHomeLimitModule', 'renderHomeToolModule', 'renderHomeModelModule', 'homeSessionAgo', 'renderHomeSessionModule', 'renderHomeDeviceModule', 'dailyWithHeatIntensity', 'applyHomeActivityScroll', 'setupHomeActivityScroller', 'homeActivityTooltipEl', 'moveHomeActivityTooltip', 'setupHomeActivityHover', 'hideHomeActivityTooltip', 'renderHomeTrendsModule', 'renderHome', 'updateHomeActivity', 'stopHomeSessionRepaint', 'scheduleHomeSessionRepaint', 'animateHomeHistoryVisuals'];
const functions = names.map(name => ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name)).filter(Boolean).map(n => source.slice(n.start, n.end)).join('\n') + '\n' + ast.body.filter(n => n.type === 'VariableDeclaration' && n.declarations.some(d => ['HOME_HISTORY_MOTION_MS', 'HOME_HEATMAP_MOTION_MS', 'HOME_HEAT_CELL_MOTION_MS'].includes(d.id.name))).map(n => source.slice(n.start, n.end)).join('\n');
const deadline = setTimeout(() => { console.error('Home fixture timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 450, height: 900, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  const page = path.join(scratch, 'fixture.html');
  fs.writeFileSync(page, '<!doctype html><html><head></head><body></body></html>');
  await win.loadFile(page);
  // Exercise DOM focus independently of desktop activation on CI/locked hosts.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  win.focus();
  const setup = fs.readFileSync(path.join(root, 'tests/fixtures/home-dom-renderer.cjs'), 'utf8');
  const result = await win.webContents.executeJavaScript(`(async () => { const root = ${JSON.stringify(root)}; const baseline = ${Boolean(process.env.TM_HOME_BASE)}; const assertPreservation = ${!process.env.TM_HOME_BASE || Boolean(process.env.TM_HOME_ASSERT)}; ${setup}\n${functions}\nreturn await check(); })()`);
  result.runtime = { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model };
  console.log(JSON.stringify(result, null, 2));
  clearTimeout(deadline); win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
