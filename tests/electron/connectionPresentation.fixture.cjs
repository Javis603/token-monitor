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
  fs.writeFileSync(fixture, `<!doctype html><html><head><link rel="stylesheet" href="${pathToFileURL(path.join(renderer, 'styles.css')).href}"></head><body><div id="fixture" style="padding:16px"></div></body></html>`);
  await win.loadFile(fixture);
  for (const script of ['i18n.js', 'limits/connectionPresentation.js']) await win.webContents.executeJavaScript(fs.readFileSync(path.join(renderer, script), 'utf8'));
  const sources = LIMIT_PROVIDER_REGISTRY.filter(p => p.sources?.length).map(p => ({ id: p.id, sources: p.sources, hasUrl: Boolean(p.account?.form?.openUrl) }));
  // Exercise every metadata lane with a harmless resolver callback, never a real URL.
  const results = [];
  for (const width of [280, 360, 460]) {
    win.setSize(width, 800);
    for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'es', 'pt-BR']) {
      const metrics = await win.webContents.executeJavaScript(`(() => {
        const host = document.getElementById('fixture'); host.replaceChildren();
        const t = (k,p) => TokenMonitorI18n.translate(${JSON.stringify(locale)},k,p);
        const metrics = [];
        for (const entry of ${JSON.stringify(sources)}) {
          const create = provider => TokenMonitorConnectionPresentation.createConnectionCard({ document, t, sources: entry.sources, provider, label: entry.id, onOpen: () => { window.opened = (window.opened || 0) + 1; } });
          const panel = create({status:'ok',source:entry.sources[0].id}); host.append(panel);
          const card = panel.querySelector('.connection-source-card'), details = panel.querySelector('details');
          const closedHeight = panel.offsetHeight;
          details.querySelector('summary').click();
          const expanded = details.open && panel.offsetHeight > closedHeight;
          const descriptions = entry.sources.every(source => details.textContent.includes(t(source.descriptionKey)));
          details.open = false;
          const link = panel.querySelector('button');
          const before = window.opened || 0; link?.click();
          const linkWorks = !link || window.opened === before + 1;
          const current = panel.querySelector('.connection-source-actions .settings-item-desc');
          const stale = create({status:'ok',stale:true,source:entry.sources[0].id});
          const failed = create({status:'error',source:entry.sources[0].id});
          const bounds = card.getBoundingClientRect();
          metrics.push({ id:entry.id, expanded, descriptions, linkWorks,
            noSelector:!panel.querySelector('select,[role=combobox]'),
            staleClear:!stale.querySelector('.connection-source-actions .settings-item-desc'),
            failedClear:!failed.querySelector('.connection-source-actions .settings-item-desc'),
            overflow: panel.scrollWidth > panel.clientWidth || bounds.right > innerWidth,
            stacked:getComputedStyle(card).flexDirection === 'column',
            exclusive:!current || entry.sources.some(s => s.relation === 'alternative' && s.id === entry.sources[0].id),
            linkExpected: !['deepseek','openrouter'].includes(entry.id) || !!link
          });
        }
        return metrics;
      })()`);
      for (const row of metrics) {
        assert.equal(row.overflow, false, `${width}/${locale}/${row.id}: overflow`);
        for (const key of ['expanded', 'descriptions', 'linkWorks', 'noSelector', 'staleClear', 'failedClear', 'exclusive', 'linkExpected']) assert.equal(row[key], true, `${width}/${locale}/${row.id}: ${key}`);
      }
      results.push({width,locale,cases:metrics.length,stacked:metrics[0].stacked});
    }
  }
  // A compact visual sheet using the real styles and representative cards.
  win.setSize(360, 800);
  await win.webContents.executeJavaScript(`(() => {
    const host=document.getElementById('fixture'); host.replaceChildren();
    const entries=${JSON.stringify(sources)};
    for(const id of ['claude','deepseek','codex','cursor']) {
      const heading=document.createElement('h3'); heading.textContent=id; host.append(heading);
      host.append(TokenMonitorConnectionPresentation.createConnectionCard({document,t:(k,p)=>TokenMonitorI18n.translate('zh-TW',k,p),sources:entries.find(e=>e.id===id).sources,provider:{status:'ok',source:'oauth'},label:id,onOpen:()=>{}}));
    }
    host.querySelectorAll('summary')[1].click();
  })()`);
  fs.writeFileSync(path.join(output, 'compact.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results,null,2));
  console.log(JSON.stringify({result:'pass',cases:results.reduce((n,r)=>n+r.cases,0),output}));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
