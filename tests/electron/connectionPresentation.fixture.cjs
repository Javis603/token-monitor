'use strict';
// Isolated hidden Electron DOM regression: no real profile, provider fetch or app boot.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { LIMIT_PROVIDER_REGISTRY } = require('../../src/shared/limits/registry');
const renderer = path.resolve(__dirname, '../../src/electron/renderer');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-connections-'));
app.setPath('userData', path.join(output, 'profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 500, height: 800, webPreferences: { sandbox: true } });
  const fixture = path.join(output, 'fixture.html');
  fs.writeFileSync(fixture, `<!doctype html><html><head><link rel="stylesheet" href="${pathToFileURL(path.join(renderer, 'styles.css')).href}"></head><body class="settings-panel"><div id="fixture" style="padding:16px"></div></body></html>`);
  await win.loadFile(fixture);
  for (const script of ['i18n.js', 'limits/connectionPresentation.js']) await win.webContents.executeJavaScript(fs.readFileSync(path.join(renderer, script), 'utf8'));
  const sources = LIMIT_PROVIDER_REGISTRY.filter(p => p.sources?.length).map(p => ({ id: p.id, sources: p.sources }));
  // Every provider renders with no readings (all names) and with its first lane live.
  const results = [];
  for (const width of [280, 360, 460]) {
    win.setSize(width, 800);
    for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'es', 'pt-BR']) {
      const metrics = await win.webContents.executeJavaScript(`(() => {
        const host = document.getElementById('fixture'); host.replaceChildren();
        const t = (k,p) => TokenMonitorI18n.translate(${JSON.stringify(locale)},k,p);
        const metrics = [];
        for (const entry of ${JSON.stringify(sources)}) for (const readings of [[], [{ status: 'ok', source: entry.sources[0].id }]]) {
          const panel = TokenMonitorConnectionPresentation.createConnectionCard({ document, t, sources: entry.sources, readings });
          host.append(panel);
          const card = panel.querySelector('.connection-source-card');
          const bounds = card.getBoundingClientRect();
          metrics.push({ id: entry.id, live: readings.length > 0,
            noSelect: !panel.querySelector('select, button'),
            overflow: panel.scrollWidth > panel.clientWidth || bounds.right > innerWidth,
            iconsPainted: [...panel.querySelectorAll('.connection-source-icon-glyph')].every(icon => getComputedStyle(icon).maskImage.startsWith('url(')) });
        }
        return metrics;
      })()`);
      for (const row of metrics) {
        assert.equal(row.overflow, false, `${width}/${locale}/${row.id}/${row.live}: overflow`);
        assert.equal(row.noSelect, true, `${width}/${locale}/${row.id}: control`);
        assert.equal(row.iconsPainted, true, `${width}/${locale}/${row.id}: icon mask`);
      }
      results.push({ width, locale, cases: metrics.length });
    }
  }
  // A compact visual sheet using the real styles and representative states.
  const sheet = [
    ['codex', 'reading', [{ status: 'ok', source: 'oauth' }, { status: 'ok', source: 'rpc', sourceDetail: 'app' }]],
    ['codex', 'no accounts', []],
    ['claude', 'reading', [{ status: 'ok', source: 'oauth' }, { status: 'ok', source: 'web' }]],
    ['claude', 'credential failed', [{ status: 'unauthorized', source: 'oauth' }]],
    ['antigravity', 'reading', [{ status: 'ok', source: 'oauth' }]],
    ['cursor', 'rows attribute both lanes', [{ status: 'ok', source: 'web' }], ['desktop', 'manual']],
    ['ollama', 'no accounts', []],
    ['zed', 'disabled', []],
    ['copilot', 'reading', [{ status: 'ok', source: 'api' }]]
  ];
  for (const [width, locale, part] of [[360, 'zh-TW', 0], [360, 'zh-TW', 1], [280, 'zh-TW', 0], [280, 'zh-TW', 1], [360, 'en', 0], [360, 'en', 1]]) {
    win.setSize(width, 760);
    await win.webContents.executeJavaScript(`(() => {
      const host=document.getElementById('fixture'); host.replaceChildren();
      const entries=${JSON.stringify(sources)};
      for(const [id, state, readings, liveSourceIds = []] of ${JSON.stringify(sheet)}.slice(${part} * 5, ${part} * 5 + 5)) {
        const heading=document.createElement('div'); heading.textContent=id + ' · ' + state;
        heading.style.cssText='font:500 10px ui-monospace,monospace;color:var(--muted);margin:10px 2px 4px';
        host.append(heading);
        const entry = entries.find(e=>e.id===id);
        host.append(TokenMonitorConnectionPresentation.createConnectionCard({document,t:(k,p)=>TokenMonitorI18n.translate(${JSON.stringify(locale)},k,p),sources:entry.sources,readings,liveSourceIds}));
      }
    })()`);
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(output, `sheet-${width}-${locale}-${part}.png`), image.toPNG());
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ result: 'pass', cases: results.reduce((n, r) => n + r.cases, 0), output }));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
