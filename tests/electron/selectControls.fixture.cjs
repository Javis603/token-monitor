'use strict';

// Run with Electron, not node:test: this checks actual DOM property setters,
// popovers, focus and pointer hit-testing with isolated application data.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const renderer = path.resolve(__dirname, '../../src/electron/renderer');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-selects-'));
app.setPath('userData', path.join(output, 'profile'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 500, height: 720, webPreferences: { sandbox: true } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error(event.message); } });
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const fixture = path.join(output, 'fixture.html');
  await win.loadURL('about:blank');
  // Parse the trusted app document inertly, then remove its boot scripts before
  // loading the fixture. HTML parsing handles tag case and malformed markup.
  const fixtureHtml = await win.webContents.executeJavaScript(`(()=>{
    const source=new DOMParser().parseFromString(${JSON.stringify(html)},'text/html');
    for(const script of source.querySelectorAll('script')) script.remove();
    const base=source.createElement('base');
    base.href=${JSON.stringify(pathToFileURL(`${renderer}/`).href)};
    source.head.prepend(base);
    return '<!doctype html>'+source.documentElement.outerHTML;
  })()`);
  fs.writeFileSync(fixture, fixtureHtml);
  await win.loadFile(fixture);
  for (const name of ['i18n.js', '../../shared/fontSettings.js', '../../shared/deviceKind.js', 'selectControl.js', 'deviceIcons.js', 'appSelects.js']) {
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(renderer, name), 'utf8'));
  }
  const run = source => win.webContents.executeJavaScript('(()=>{try{return (' + source + ')}catch(error){console.error(error.stack);throw error}})()');
  const settle = () => run('new Promise(resolve => setTimeout(resolve, 60))');
  const capture = async name => {
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await settle();
    fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  let point;
  const move = async selector => {
    point = await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector).replace(/</g, '\\u003c')}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await settle();
  };
  const click = async selector => {
    await move(selector);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await settle();
  };
  const key = async keyCode => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await settle();
  };

  // Exercise discovery against the entire real document before extracting the
  // representative controls for readable, comparable screenshots.
  const coverage = await run(`(()=>{
    const t = key => TokenMonitorI18n.translate('zh-TW', key);
    TokenMonitorI18n.applyTranslations(document, 'zh-TW');
    window.selectFixtureManager = TokenMonitorAppSelects.mount({document,t,fonts:TokenMonitorFontSettings});
    // App discovery runs before syncHubDraftFields initializes this specialist.
    const device=document.getElementById('deviceIconInput');
    const genericOwned=Boolean(device.nextElementSibling?.classList.contains('select-control-trigger'));
    const inspectDevice=kind=>{
      TokenMonitorDeviceIcons.populateDeviceIconSelect(device,t,kind);
      device.value=kind==='computer'?'desktop':kind;
      const trigger=device.nextElementSibling;
      const popup=document.getElementById(trigger.getAttribute('aria-controls'));
      return {icon:!trigger.querySelector('.select-control-icon').hidden,
        annotations:[...popup.querySelectorAll('.select-control-annotation')].map(node=>node.textContent)};
    };
    const detected=inspectDevice('laptop');
    const fallback=inspectDevice('computer');
    return {sources:document.querySelectorAll('select').length, triggers:document.querySelectorAll('.select-control-trigger').length,
      visibleNative:[...document.querySelectorAll('select')].filter(select=>!select.hidden).map(select=>select.id),
      genericOwned,detected,fallback,detectedLabel:t('devices.icon.detected'),defaultLabel:t('devices.icon.default')};
  })()`);
  assert.equal(coverage.genericOwned, false, 'generic discovery leaves the device icon picker to its specialist');
  assert.deepEqual(coverage.detected, {icon:true,annotations:[coverage.detectedLabel]});
  assert.deepEqual(coverage.fallback, {icon:true,annotations:[coverage.defaultLabel]});
  assert.equal(coverage.sources, coverage.triggers);
  assert.deepEqual(coverage.visibleNative, []);

  await run(`(()=>{
    selectFixtureManager.destroy();
    const device=document.getElementById('deviceIconInput');
    TokenMonitorDeviceIcons.destroyDeviceIconSelect(device);
    if(device.hidden || device.nextElementSibling?.classList.contains('select-control-trigger')) throw new Error('device icon specialist did not clean up');
    window.subscriptionCurrencyTemplate=document.getElementById('subscriptionCurrencyInput').cloneNode(true);
    const fields = ['languageInput','windowBehaviorInput','interfaceFontPreset','modelAliasesAliasSelect','syncUploadIntervalInput'];
    const clones = fields.map(id=>(document.getElementById(id).closest('label, .settings-font-field, .settings-field') || document.getElementById(id).parentElement).cloneNode(true));
    document.body.replaceChildren();
    const shell=document.createElement('main'); shell.className='shell settings-open';
    const panel=document.createElement('section'); panel.className='settings-panel'; panel.id='fixturePanel';
    clones.forEach(node=>node.hidden=false); panel.append(...clones); shell.append(panel); document.body.append(shell);
    const model=document.getElementById('modelAliasesAliasSelect');
    model.replaceChildren(...Array.from({length:50},(_,i)=>new Option('Model '+String(i).padStart(2,'0'), 'model-'+i)));
    const style=document.createElement('style');
    style.textContent='body{background:#10141a}.shell{width:100%;height:100%;padding:24px;box-sizing:border-box}.settings-panel{position:static;display:grid;gap:20px;overflow:auto;max-height:100%;margin:0}.settings-font-field{padding:0}.settings-font-custom-row{display:none}';
    document.head.append(style);
  })()`);
  await capture('before');
  await run(`void(window.selectFixtureManager=TokenMonitorAppSelects.mount({document,t:key=>TokenMonitorI18n.translate('zh-TW',key),fonts:TokenMonitorFontSettings}))`);
  await settle();
  await capture('after');

  // Label and empty row space must not forward hover or activation.
  const normal = await run(`getComputedStyle(document.querySelector('#languageInput + button')).backgroundColor`);
  await move('#languageInput'); // hidden source is deliberately not a hit target
  await click('#languageInput');
  await click('#fixturePanel > label:first-child .settings-item-title');
  assert.equal(await run(`document.querySelector('#languageInput + button').getAttribute('aria-expanded')`), 'false');
  assert.equal(await run(`getComputedStyle(document.querySelector('#languageInput + button')).backgroundColor`), normal);
  await click('#languageInput + button');
  assert.equal(await run(`document.querySelector('#languageInput + button').getAttribute('aria-expanded')`), 'true');
  const languageGeometry = await run(`(()=>{
    const trigger=document.querySelector('#languageInput + button').getBoundingClientRect();
    const popup=document.querySelector('.select-control-popup:popover-open');
    return {rightOffset:Math.abs(popup.getBoundingClientRect().right-trigger.right),
      heights:[...popup.querySelectorAll('[role="option"]')].map(row=>row.getBoundingClientRect().height)};
  })()`);
  assert.ok(languageGeometry.rightOffset <= 1, 'inline picker aligns to the trigger right edge');
  assert.ok(languageGeometry.heights.every(height=>height <= 28), 'single-line choices remain compact');
  await capture('language');
  await key('Escape');
  await click('#windowBehaviorInput + button');
  assert.deepEqual(await run(`(()=>{
    const popup=document.querySelector('.select-control-popup:popover-open');
    const trigger=document.querySelector('#windowBehaviorInput + button');
    const description=popup.querySelector('.select-control-description:not([hidden])');
    return {hasDescription:Boolean(description),
      wrapped:description.getBoundingClientRect().height>parseFloat(getComputedStyle(description).lineHeight),
      bounded:popup.getBoundingClientRect().width<=Math.max(trigger.getBoundingClientRect().width,220)+1};
  })()`), {hasDescription:true,wrapped:true,bounded:true});
  await capture('descriptions');
  await key('Escape');
  await click('#interfaceFontPreset + button');
  await capture('fonts');
  await key('Escape');

  await click('#syncUploadIntervalInput + button');
  const frequencyGeometry = await run(`(()=>{
    const popup=document.querySelector('.select-control-popup:popover-open');
    return {width:popup.getBoundingClientRect().width,
      wraps:[...popup.querySelectorAll('.select-control-option-label')].some(label=>label.getBoundingClientRect().height>20)};
  })()`);
  assert.ok(frequencyGeometry.width < 130, 'short choices do not inherit a wide popup minimum');
  assert.equal(frequencyGeometry.wraps, false, 'longest short choice fits without wrapping');
  await capture('frequency');
  await key('Escape');

  // Direct assignments repaint immediately, without creating a save event.
  assert.deepEqual(await run(`(()=>{
    const select=document.getElementById('languageInput'); let changes=0;
    select.addEventListener('change',()=>changes++);
    select.value='ja'; const value=select.nextElementSibling.querySelector('.select-control-value').textContent;
    select.selectedIndex=1;
    return {value,selected:select.value,changes};
  })()`), { value: '日本語', selected: 'en', changes: 0 });

  await click('#modelAliasesAliasSelect + button');
  assert.equal(await run(`document.activeElement.className`), 'select-control-search');
  await run(`(()=>{window.modelBlurCount=0;document.getElementById('modelAliasesAliasSelect').addEventListener('blur',()=>modelBlurCount++)})()`);
  await win.webContents.insertText('no matching model');
  await settle();
  await click('.select-control-popup:popover-open .select-control-empty');
  assert.deepEqual(await run(`({open:document.querySelector('#modelAliasesAliasSelect + button').getAttribute('aria-expanded'),focused:document.activeElement.className,blurs:modelBlurCount})`),
    {open:'true',focused:'select-control-search',blurs:0}, 'empty-state clicks retain search focus and keep the picker open');
  await click('.select-control-popup:popover-open .select-control-search');
  await run(`document.activeElement.select()`);
  await win.webContents.insertText('Model 42');
  await settle();
  assert.deepEqual(await run(`[...document.querySelectorAll('.select-control-popup:popover-open [role="option"]')].filter(row=>!row.hidden).map(row=>row.getAttribute('aria-label'))`), ['Model 42']);
  await capture('search');
  await key('Return');
  assert.equal(await run(`document.getElementById('modelAliasesAliasSelect').value`), 'model-42');
  assert.equal(await run(`TokenMonitorSelectControl.isFocused(document.getElementById('modelAliasesAliasSelect'))`), true);

  // The subscription editor moves the same currency source between plan and
  // top-up slots, then hides the old slot. The visible control must follow it.
  await run(`(()=>{
    const row=document.createElement('div');row.id='currencyRelocation';
    row.innerHTML='<div id="currencyPlanSlot"></div><div id="currencyTopUpSlot"></div>';
    subscriptionCurrencyTemplate.replaceChildren(new Option('USD','USD'),new Option('HKD','HKD'));
    row.querySelector('#currencyPlanSlot').append(subscriptionCurrencyTemplate);
    document.getElementById('fixturePanel').append(row);
  })()`);
  await settle();
  await run(`(()=>{
    const select=document.getElementById('subscriptionCurrencyInput');
    window.currencyTrigger=select.nextElementSibling;select.value='USD';
    window.currencyChanges=0;select.addEventListener('change',()=>currencyChanges++);
    document.getElementById('currencyTopUpSlot').append(select);
    document.getElementById('currencyPlanSlot').hidden=true;
  })()`);
  await settle();
  assert.equal(await run(`(()=>{const select=document.getElementById('subscriptionCurrencyInput');return select.nextElementSibling===currencyTrigger && currencyTrigger.getBoundingClientRect().height>0 && select.value==='USD'})()`), true,
    'currency trigger follows its source into the visible top-up slot');
  await run(`currencyTrigger.scrollIntoView({block:'nearest'})`);
  await settle();
  await click('#subscriptionCurrencyInput + button');
  await key('Down');
  await key('Return');
  assert.deepEqual(await run(`({value:document.getElementById('subscriptionCurrencyInput').value,changes:currencyChanges})`), {value:'HKD',changes:1});
  await run(`(()=>{
    document.getElementById('currencyPlanSlot').append(document.getElementById('subscriptionCurrencyInput'));
    document.getElementById('currencyPlanSlot').hidden=false;
    document.getElementById('currencyTopUpSlot').hidden=true;
  })()`);
  await settle();
  assert.equal(await run(`document.getElementById('subscriptionCurrencyInput').nextElementSibling===currencyTrigger && currencyTrigger.getBoundingClientRect().height>0`), true);
  await run(`document.getElementById('currencyRelocation').remove()`);
  await settle();

  // Dynamic host fields, disabled states and cleanup use real MutationObservers.
  await run(`(()=>{
    const row=document.createElement('div'); row.id='dynamic'; row.className='settings-item';
    row.innerHTML='<label for="dynamicSelect">Account</label><select id="dynamicSelect"><option value="one">First account</option><option value="two">Second account</option></select>';
    document.getElementById('fixturePanel').append(row);
  })()`);
  await settle();
  assert.equal(await run(`document.querySelectorAll('#dynamic .select-control-trigger').length`), 1);
  await run(`document.getElementById('dynamicSelect').disabled=true`);
  await settle();
  assert.equal(await run(`document.querySelector('#dynamicSelect + button').disabled`), true);
  const popups = await run(`document.querySelectorAll('.select-control-popup').length`);
  await run(`document.getElementById('dynamic').remove()`);
  await settle();
  assert.equal(await run(`document.querySelectorAll('.select-control-popup').length`), popups - 1);

  // Popovers inside a native modal must stay interactive rather than becoming inert.
  await run(`(()=>{const dialog=document.createElement('dialog');dialog.id='modal';dialog.innerHTML='<label>Mode<select id="modalSelect"><option>One</option><option>Two</option></select></label>';document.body.append(dialog);dialog.showModal()})()`);
  await settle();
  await click('#modalSelect + button');
  assert.equal(await run(`Boolean(document.querySelector('#modal .select-control-popup:popover-open'))`), true);
  await key('Down');
  await key('Return');
  assert.equal(await run(`document.getElementById('modalSelect').value`), 'Two');
  await run(`document.getElementById('modal').remove()`);
  await settle();
  await run(`selectFixtureManager.destroy()`);
  assert.equal(await run(`document.querySelectorAll('.select-control-popup, .select-control-trigger').length`), 0);
  if (process.argv.includes('--examples')) {
    await run(`(()=>{
      window.exampleSource=new DOMParser().parseFromString(${JSON.stringify(html)},'text/html');
      window.selectFixtureManager=TokenMonitorAppSelects.mount({document,t:key=>TokenMonitorI18n.translate('zh-TW',key),fonts:TokenMonitorFontSettings});
    })()`);
    for (const [name, id, value] of [
      ['windows', 'windowsBackdropInput', 'accent'],
      ['notch', 'notchSummaryModeInput', 'sessions'],
      ['adaptive', 'limitsRefreshInput', 'adaptive'],
      ['font', 'interfaceFontPreset', 'app'],
      ['display-font', 'displayFontPreset', 'follow'],
      ['collection', 'collectionCadenceInput', 'smart']
    ]) {
      await run(`(()=>{
        const select=exampleSource.getElementById(${JSON.stringify(id)});
        const field=(select.closest('label, .settings-font-field, .settings-field')||select.parentElement).cloneNode(true);
        field.hidden=false;field.classList.remove('hidden');
        document.getElementById('fixturePanel').replaceChildren(field);
        TokenMonitorI18n.applyTranslations(field,'zh-TW');
        field.querySelector('select').value=${JSON.stringify(value)};
      })()`);
      await settle();
      await click(`#${id} + button`);
      assert.ok(await run(`Boolean(document.querySelector('.select-control-popup:popover-open .select-control-description:not([hidden])'))`));
      assert.equal(await run(`Boolean(document.querySelector('.select-control-popup:popover-open .select-control-search:not([hidden])'))`), false);
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const bounds = await run(`(()=>{const popup=document.querySelector('.select-control-popup:popover-open').getBoundingClientRect();return {x:0,y:0,width:innerWidth,height:Math.min(innerHeight,Math.ceil(popup.bottom+18))}})()`);
      fs.writeFileSync(path.join(output, `example-${name}.png`), (await win.webContents.capturePage(bounds)).toPNG());
      await key('Escape');
    }
    await run('selectFixtureManager.destroy()');
  }
  if (process.argv.includes('--audit')) {
    await run(`(()=>{
      const source=new DOMParser().parseFromString(${JSON.stringify(html)},'text/html');
      window.auditSelectTemplates=[...source.querySelectorAll('select')].filter(select=>select.options.length && !select.multiple);
      const accounts=document.createElement('select');accounts.id='accountFixtureSelect';
      accounts.add(new Option('A','a'));
      for(let i=0;i<20;i++) accounts.add(new Option('Work account '+i+' — personal workspace','account-'+i));
      auditSelectTemplates.push(accounts);
      window.auditLocale='zh-TW';
      window.selectFixtureManager=TokenMonitorAppSelects.mount({document,t:key=>TokenMonitorI18n.translate(auditLocale,key),fonts:TokenMonitorFontSettings});
    })()`);
    const audit = [];
    for (const [width, scale, locale] of [[380, 1, 'zh-TW'], [500, 1, 'en'], [380, 1.2, 'pt-BR']]) {
      win.setContentSize(width, 720);
      await run(`(()=>{window.auditLocale=${JSON.stringify(locale).replace(/</g, '\\u003c')};document.documentElement.style.setProperty('--ui-text-scale',${scale})})()`);
      const count = await run('auditSelectTemplates.length');
      for (let index = 0; index < count; index++) {
        const id = await run(`(()=>{
          const select=auditSelectTemplates[${index}].cloneNode(true);
          select.hidden=false; select.disabled=false; select.classList.remove('hidden');
          select.setAttribute('aria-label',select.id); select.removeAttribute('aria-labelledby');
          TokenMonitorI18n.applyTranslations({querySelectorAll:selector=>select.querySelectorAll(selector)},auditLocale);
          const shortest=[...select.options].filter(option=>!option.disabled).sort((a,b)=>a.textContent.length-b.textContent.length)[0];
          if(shortest) select.value=shortest.value;
          const row=document.createElement('div');row.className='settings-item';
          const title=document.createElement('span');title.className='settings-item-text';title.textContent=select.id;
          row.append(title,select); document.getElementById('fixturePanel').replaceChildren(row);
          return select.id;
        })()`);
        await settle();
        const metrics = await run(`(()=>{
          const select=document.getElementById(${JSON.stringify(id).replace(/</g, '\\u003c')}), trigger=select.nextElementSibling;
          trigger.click();
          const popup=document.querySelector('.select-control-popup:popover-open');
          if(!popup) return {id:select.id,unavailable:true};
          const bounds=popup.getBoundingClientRect(), input=popup.querySelector('.select-control-search');
          const searchable=input && !input.hidden;
          const selected=popup.querySelector('[data-selected="true"]'), list=popup.querySelector('.select-control-list')||popup;
          const selection=selected?.getBoundingClientRect(), listBounds=list.getBoundingClientRect();
          return {id:select.id,width:bounds.width,searchable,
            crampedSearch:searchable && bounds.width<Math.min(220,innerWidth-16),
            outside:bounds.left<7 || bounds.right>innerWidth-7 || bounds.top<7 || bounds.bottom>innerHeight-7,
            selectedClipped:selection && (selection.top<listBounds.top-1 || selection.bottom>listBounds.bottom+1),
            rows:popup.querySelectorAll('[role="option"]').length};
        })()`);
        audit.push({ viewport: width, scale, locale, ...metrics });
        if (id === 'trayContentInput' && locale === 'zh-TW') await capture('tray-audit');
        await key('Escape');
      }
    }
    fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(audit, null, 2));
    const failures = audit.filter(item => item.crampedSearch || item.outside || item.selectedClipped
      || ['trayContentInput', 'floatingBubbleContentInput'].includes(item.id) && item.searchable);
    console.log(JSON.stringify({ auditCases: audit.length, failures, output }));
    assert.equal(failures.length, 0, 'all static pickers fit across viewport, language and text-size cases');
    await run('selectFixtureManager.destroy()');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', coverage, output }));
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
