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
  const sources = LIMIT_PROVIDER_REGISTRY.filter(p => p.sources?.length).map(p => ({ id: p.id, sources: p.sources, selection: p.sourceSelection, hasUrl: Boolean(p.form?.openUrl && p.id !== 'claude') }));
  // Exercise every metadata lane with a harmless resolver callback, never a real URL.
  const results = [];
  for (const width of [280, 360, 460]) {
    win.setSize(width, 800);
    for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'es', 'pt-BR']) {
      const metrics = await win.webContents.executeJavaScript(`(async () => {
        const host = document.getElementById('fixture'); host.replaceChildren();
        const t = (k,p) => TokenMonitorI18n.translate(${JSON.stringify(locale)},k,p);
        const metrics = [];
        for (const entry of ${JSON.stringify(sources)}) {
          let savedSelection;
          const create = provider => TokenMonitorConnectionPresentation.createConnectionCard({
            document, t, sources: entry.sources, provider, providerId: entry.id, label: entry.id,
            selection: entry.selection, onSelect: async patch => { savedSelection = patch; return patch[entry.selection.key]; },
            onOpen: entry.hasUrl ? () => { window.opened = (window.opened || 0) + 1; } : undefined
          });
          const choices = entry.sources.filter(source => entry.selection?.sources.includes(source.id) && source.relation === 'alternative');
          const source = choices[0] || entry.sources[0];
          const panel = create({status:'ok',source:source.id}); host.append(panel);
          const card = panel.querySelector('.connection-source-card');
          const select = panel.querySelector('select');
          const link = panel.querySelector('.connection-source-get');
          const before = window.opened || 0; link?.click();
          const stale = create({status:'ok',stale:true,source:source.id});
          const failed = create({status:'error',source:source.id});
          const methodText = node => node.querySelector('.connection-source-method')?.textContent;
          if (select && choices.length) {
            select.value = choices.at(-1).id;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await Promise.resolve();
          }
          const selected = choices.at(-1);
          const bounds = card.getBoundingClientRect();
          metrics.push({ id:entry.id,
            selector: Boolean(select) === Boolean(entry.selection) && (!select ||
              JSON.stringify([...select.options].map(option => option.value)) === JSON.stringify(['auto', ...choices.map(choice => choice.id)])),
            changed: !selected || savedSelection?.[entry.selection.key] === selected.id && select.value === selected.id && !select.disabled,
            descriptions: !select || choices.every((choice, index) => select.options[index + 1].dataset.selectDescription === choice.descriptionKey),
            linkWorks: !link || window.opened === before + 1,
            linkExpected: Boolean(link) === Boolean(entry.hasUrl && entry.sources.some(lane => ['apiKey', 'web'].includes(lane.kind))),
            staleClear: methodText(stale) === methodText(failed),
            overflow: panel.scrollWidth > panel.clientWidth || bounds.right > innerWidth,
            stacked:getComputedStyle(card).flexDirection === 'column'
          });
        }
        return metrics;
      })()`);
      for (const row of metrics) {
        assert.equal(row.overflow, false, `${width}/${locale}/${row.id}: overflow`);
        for (const key of ['selector', 'changed', 'descriptions', 'linkWorks', 'staleClear', 'linkExpected']) assert.equal(row[key], true, `${width}/${locale}/${row.id}: ${key}`);
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
      const entry = entries.find(e=>e.id===id);
      host.append(TokenMonitorConnectionPresentation.createConnectionCard({document,t:(k,p)=>TokenMonitorI18n.translate('zh-TW',k,p),sources:entry.sources,selection:entry.selection,onSelect:async patch=>Object.values(patch)[0],provider:{status:'ok',source:'oauth'},label:id,onOpen:entry.hasUrl ? ()=>{} : undefined}));
    }
  })()`);
  fs.writeFileSync(path.join(output, 'compact.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results,null,2));
  console.log(JSON.stringify({result:'pass',cases:results.reduce((n,r)=>n+r.cases,0),output}));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
