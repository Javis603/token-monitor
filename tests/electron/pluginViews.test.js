'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Element } = require('../helpers/notchPanel');
const { createHost } = require('../../src/electron/renderer/pluginUi');
const { create } = require('../../src/electron/renderer/pluginContent');
function dom() {
  const document = { createElement: tag => {
    const node = new Element(tag, document);
    Object.defineProperties(node, { isConnected: { get: () => document.body?.contains(node) || document.head?.contains(node) || false }, parentNode: { get: () => node.parent }, nextSibling: { get: () => node.parent?.children[node.parent.children.indexOf(node) + 1] } });
    node.insertBefore = (child, next) => { if (child === next) return; child.remove(); const index = next ? node.children.indexOf(next) : node.children.length; child.parent = node; node.children.splice(index, 0, child); };
    return node;
  } };
  document.body = document.createElement('body'); document.head = document.createElement('head'); return document;
}
const descriptor = { id: 'panel', ref: 'fixture/panel', pluginId: 'fixture', revision: 'one', entry: 'tm-plugin://fixture/one/ui.mjs', targets: ['main.home.content'], mode: 'replace' };
test('same-page mount retains DOM/drafts, updates context, and activation runs once across surfaces', async () => {
  const document = dom(); let activations = 0, disposals = 0, latest;
  const host = createHost({ document, window: {}, bridge: {}, importModule: async () => ({ activate() { activations++; return { mount(container, context) {
    const input = document.createElement('input'); container.append(input); latest = context;
    return { update(value) { latest = value; }, dispose() { disposals++; }, hasUnsavedChanges: () => Boolean(input.value) };
  } }; } }) });
  const a = document.createElement('div'), b = document.createElement('div'); document.body.append(a, b);
  await host.mount(a, descriptor, { surface: 'home', period: 'today' }); const input = a.children[0]; input.value = 'draft';
  await host.mount(a, descriptor, { period: 'month', source: 'remote' });
  assert.equal(a.children[0], input); assert.equal(input.value, 'draft'); assert.equal(latest.period, 'month'); assert.equal(latest.source, 'remote');
  await host.mount(b, descriptor, { surface: 'notch' }); assert.equal(activations, 1); assert.equal(host.hasUnsavedChanges(), true);
  host.setVisibility(a, false); assert.equal(latest.visible, false);
  await host.dispose(); assert.equal(disposals, 2); assert.equal(document.head.children.length, 0);
});
test('replacement hides native only after success; failure and removal restore native', async () => {
  const document = dom(); const native = document.createElement('div'); native.hidden = false; document.body.append(native);
  let views = [descriptor], complete;
  const host = { mount(_container, _view, context) { complete = context.onMountStatus; }, unmount() {} };
  const content = create({ document, host, getViews: () => views, selection: () => descriptor.ref });
  content.render('main.home.content', native); assert.equal(native.hidden, false);
  complete(true); assert.equal(native.hidden, true); complete(false); assert.equal(native.hidden, false);
  complete(true); views = []; content.render('main.home.content', native); assert.equal(native.hidden, false); assert.equal(document.body.children.length, 1);
});
test('append/decorate coexist in stable order and only user-selected replacement mounts', () => {
  const document = dom(), native = document.createElement('div'); document.body.append(native); const refs = [];
  const views = ['first', 'second', 'third'].map((id, i) => ({ ...descriptor, ref: `fixture/${id}`, mode: i === 2 ? 'replace' : 'append' }));
  const content = create({ document, host: { mount(node, view) { node.textContent = view.ref; refs.push(view.ref); }, unmount() {} }, getViews: () => views });
  content.render('main.home.content', native); assert.deepEqual(refs, ['fixture/first', 'fixture/second']);
  assert.deepEqual(document.body.children.slice(1).map(node => node.textContent), refs);
});
test('activation failure is inline and does not remove host native content', async () => {
  const document = dom(), node = document.createElement('div'); document.body.append(node); let ok, error;
  const host = createHost({ document, window: {}, bridge: {}, onError: value => { error = value; }, importModule: async () => { throw Error('fixture error'); } });
  await host.mount(node, descriptor, { onMountStatus: value => { ok = value; } });
  assert.equal(ok, false); assert.match(node.textContent, /fixture error/); assert.equal(error.message, 'fixture error'); await host.dispose();
});
test('pending activation cannot mount after its owner is removed', async () => {
  const document = dom(), node = document.createElement('div'); document.body.append(node); let resolve, mounted = 0;
  const host = createHost({ document, window: {}, bridge: {}, importModule: () => new Promise(r => { resolve = r; }) });
  const pending = host.mount(node, descriptor); host.unmount(node); resolve({ mount() { mounted++; } }); await pending;
  assert.equal(mounted, 0); await host.dispose();
});
test('failed update restores native replacement and never reports a successful mount', async () => {
  const document = dom(), node = document.createElement('div'); document.body.append(node); const states = [];
  const host = createHost({ document, window: {}, bridge: {}, importModule: async () => ({ mount() { return { update() { throw Error('update failed'); } }; } }) });
  const options = { onMountStatus: value => states.push(value) };
  await host.mount(node, descriptor, options); await host.mount(node, descriptor, options);
  assert.deepEqual(states, [true, false]); assert.match(node.textContent, /update failed/); await host.dispose();
});
test('a failed update stays failed across data pushes until the view is remounted', async () => {
  const document = dom(), node = document.createElement('div'); document.body.append(node);
  const states = []; let updates = 0, disposed = 0;
  const host = createHost({ document, window: {}, bridge: {}, importModule: async () => ({ mount(container) {
    container.append(document.createElement('input'));
    return { update() { if (++updates === 1) throw Error('one failed update'); }, dispose() { disposed++; } };
  } }) });
  const options = { onMountStatus: value => states.push(value) };
  await host.mount(node, descriptor, options); await host.mount(node, descriptor, options);
  await host.mount(node, descriptor, options);
  assert.equal(states.at(-1), false); assert.equal(updates, 1);
  assert.match(node.textContent, /one failed update/);
  host.unmount(node); await host.mount(node, descriptor, options);
  assert.equal(states.at(-1), true); assert.equal(node.children[0].tagName, 'INPUT');
  await host.dispose(); assert.equal(disposed, 2);
});
for (const trigger of ['visibility', 'resize']) test(`synchronous ${trigger} update failure is contained and restores native content`, async () => {
  const document = dom(), node = document.createElement('div'); document.body.append(node);
  let resize, error; const states = [];
  class ResizeObserver { constructor(callback) { resize = callback; } observe() {} disconnect() {} }
  const host = createHost({ document, window: { ResizeObserver }, bridge: {}, onError: cause => { error = cause; },
    importModule: async () => ({ mount() { return { update() { throw Error('author update failed'); } }; } }) });
  await host.mount(node, descriptor, { onMountStatus: value => states.push(value) });
  assert.doesNotThrow(() => trigger === 'visibility' ? host.setVisibility(node, false) : resize([{ contentRect: { width: 100, height: 80 } }]));
  await new Promise(setImmediate);
  assert.equal(error.message, 'author update failed'); assert.equal(states.at(-1), false);
  assert.match(node.textContent, /author update failed/); await host.dispose();
});
test('context changed while async mount is pending reaches the mounted instance', async () => {
  const document = dom(), node = document.createElement('div'); document.body.append(node); let finish, latest;
  const host = createHost({ document, window: {}, bridge: {}, importModule: async () => ({ mount: () => new Promise(resolve => { finish = () => resolve({ update(value) { latest = value; } }); }) }) });
  const pending = host.mount(node, descriptor, { period: 'today' });
  await new Promise(setImmediate); await host.mount(node, descriptor, { period: 'month' }); finish(); await pending;
  assert.equal(latest.period, 'month'); await host.dispose();
});
test('pending data subscription is released when the host is disposed', async () => {
  const document = dom(); let context, resolve, off = 0; const removed = [];
  const host = createHost({ document, window: {}, bridge: { onData: () => () => { off++; }, subscribeData: () => new Promise(r => { resolve = r; }), unsubscribeData: async id => removed.push(id) },
    importModule: async () => ({ activate(ctx) { context = ctx; return { mount() {} }; } }) });
  await host.load(descriptor); const pending = context.data.subscribe({}, () => {});
  await host.dispose(); resolve('sub-1'); await pending;
  assert.deepEqual(removed, ['sub-1']); assert.ok(off >= 1);
});
test('no active extension leaves native surface wrapping unnecessary', () => {
  const content = create({ document: dom(), host: {}, getViews: () => [] });
  assert.equal(content.hasTarget('notch.home.content'), false);
});
test('a throwing Tray drawing falls back without throwing through App composition', async () => {
  const document = dom(); let errors = 0;
  const host = createHost({ document, window: {}, bridge: {}, onError() { errors++; }, importModule: async () => ({ renderTray() { throw Error('bad drawing'); } }) });
  await host.load(descriptor);
  assert.equal(host.renderTray(descriptor, {}, {}), false);
  assert.equal(host.renderTray(descriptor, {}, {}), false);
  assert.equal(errors, 1); await host.dispose();
});
test('section/inline selectors follow rebuilt native anchors, preserve drafts and restore replacements', () => {
  const document = dom(), native = document.createElement('div'); document.body.append(native);
  const row = () => { const node = document.createElement('span'); node.className = 'metric'; node.hidden = false; return node; };
  const first = row(), second = row(); native.append(first, second);
  let views = [{ ...descriptor, selector: '.metric' }];
  const mounted = [], removed = [];
  const host = { mount(node, view, context) { mounted.push({ node, view, context }); if (!node.children.length) { const own = row(); node.append(own); } context.onMountStatus(true); }, unmount(node) { removed.push(node); } };
  const content = create({ document, host, getViews: () => views, selection: () => descriptor.ref });
  content.render('main.home.content', native);
  assert.equal(mounted.length, 2); assert.equal(first.hidden, true); assert.equal(native.hidden, undefined);
  const container = mounted[0].node; container.children[0].value = 'draft';
  content.render('main.home.content', native);
  assert.equal(mounted.length, 4, 'own author descendants are not selector anchors');
  assert.equal(mounted[2].node, container);
  const rebuilt = row(); native.replaceChildren(rebuilt);
  content.render('main.home.content', native);
  assert.equal(mounted.at(-1).node, container); assert.equal(container.children[0].value, 'draft');
  assert.equal(mounted.at(-1).context.native, rebuilt); assert.equal(mounted.at(-1).context.root, native);
  assert.equal(first.hidden, false); assert.equal(second.hidden, false); assert.equal(removed.length, 1);
  views = []; content.render('main.home.content', native);
  assert.equal(rebuilt.hidden, false); assert.equal(native.children.length, 1);
});
test('user order applies to additive views and invalid selectors cannot hide native content', t => {
  const document = dom(), native = document.createElement('div'); document.body.append(native); native.hidden = false;
  const calls = [];
  const views = ['a', 'b'].map((id, index) => ({ ...descriptor, ref: `fixture/${id}`, mode: 'append', contentOrder: { 'main.home.content': 1 - index } }));
  const content = create({ document, host: { mount(node, view) { calls.push(view.ref); }, unmount() {} }, getViews: () => views });
  content.render('main.home.content', native); assert.deepEqual(calls, ['fixture/b', 'fixture/a']);
  views.splice(0, 2, { ...descriptor, selector: '[' });
  native.querySelectorAll = () => { throw Error('bad selector'); };
  t.mock.method(console, 'error', () => {});
  const bad = create({ document, host: { mount() { assert.fail('invalid selector must not mount'); }, unmount() {} }, getViews: () => views, selection: () => descriptor.ref });
  bad.render('main.home.content', native); assert.equal(native.hidden, false);
});

test('overlapping selectors keep the selected additive order at the same native anchor', () => {
  const document = dom(), native = document.createElement('div'), value = document.createElement('span');
  value.className = 'metric'; native.append(value); document.body.append(native);
  const views = ['.metric','span'].map((selector,index) => ({ ...descriptor, ref:`fixture/v${index}`, selector, mode:'append', contentOrder:{ 'main.home.content':index } }));
  const content = create({ document, host:{mount(node,view){node.textContent=view.ref;},unmount(){}}, getViews:()=>views });
  content.render('main.home.content',native);
  assert.deepEqual(native.children.slice(1).map(node=>node.textContent),['fixture/v0','fixture/v1']);
  let moves = 0;
  const insert = native.insertBefore;
  native.insertBefore = (...args) => { moves++; return insert(...args); };
  content.render('main.home.content',native);
  assert.equal(moves, 0, 'unchanged final order must never detach a focused author descendant');
  views[0].contentOrder['main.home.content']=2;
  content.render('main.home.content',native);
  assert.deepEqual(native.children.slice(1).map(node=>node.textContent),['fixture/v1','fixture/v0']);
});

test('ended data subscriptions release cleanup records; teardown drains every live subscription', async () => {
  const document = dom(); let next = 0, listeners = 0; const removed = [];
  const host = createHost({ document, window: {}, bridge: {
    onData() { listeners++; return () => listeners--; }, subscribeData: async () => ++next,
    unsubscribeData: async id => removed.push(id)
  }, importModule: async () => ({ mount() {} }) });
  const loaded = await host.load(descriptor), initial = loaded.cleanup.length;
  for (let i = 0; i < 100; i++) (await loaded.ctx.data.subscribe({}, () => {}))();
  assert.equal(loaded.cleanup.length, initial); assert.equal(listeners, 0);
  for (let i = 0; i < 3; i++) await loaded.ctx.data.subscribe({}, () => {});
  await host.dispose(); assert.equal(listeners, 0); assert.equal(new Set(removed).size, 103);
});

test('initial view requests coalesce, cannot overwrite pushes or revive a disposed host, and rejection is contained', async t => {
  const { createPluginViewHost } = require('../../src/electron/renderer/pluginViews');
  const document = dom(); document.addEventListener = document.removeEventListener = () => {};
  let resolve, reject, calls = 0, paints = 0;
  const window = { requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    tokenMonitorTrustedPlugins: { views: () => { calls++; return new Promise((yes,no) => { resolve=yes; reject=no; }); } },
    TokenMonitorPluginUi: { createHost: () => ({ mount(){paints++;},unmount(){},sweep(){},setVisibility(){},dispose(){} }) } };
  const host = createPluginViewHost({ document, window });
  const mount = surface => { const node=document.createElement('div'); node.style.removeProperty=()=>{}; host.mount(node,descriptor.ref,surface); };
  mount('home'); mount('home'); await new Promise(setImmediate); assert.equal(calls,1);
  host.update({surface:'home',views:{[descriptor.ref]:descriptor}});
  resolve({views:{[descriptor.ref]:{...descriptor,revision:'old'}}}); await new Promise(setImmediate);
  assert.equal(host.state('home',descriptor.ref).revision,descriptor.revision);
  let errors=0; t.mock.method(console,'error',()=>errors++);
  mount('page'); await new Promise(setImmediate); reject(Error('IPC failure')); await new Promise(setImmediate); assert.equal(errors,1);
  mount('page'); await new Promise(setImmediate); await host.dispose(); const before=paints;
  resolve({views:{[descriptor.ref]:descriptor}}); await new Promise(setImmediate); assert.equal(paints,before); assert.equal(host.state('page',descriptor.ref),null);
});


test('native partial redraw reconciles selectors without an App render and ignores author-only mutations', () => {
  const document = dom(), native = document.createElement('div'); document.body.append(native);
  const observers = [];
  document.defaultView = { MutationObserver: class {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe(node) { this.node = node; this.active = true; }
    disconnect() { this.active = false; }
  } };
  const row = () => { const node = document.createElement('span'); node.className = 'metric'; return node; };
  const first = row(); native.append(first);
  let mounts = 0;
  const host = { mount(node, view, context) { mounts++; context.onMountStatus(true); }, unmount() {} };
  const content = create({ document, host, getViews: () => [{ ...descriptor, selector: '.metric' }], selection: () => descriptor.ref });
  content.render('main.home.content', native);
  assert.equal(observers.length, 1);
  const container = native.children[1]; container.value = 'draft';
  observers[0].callback(); assert.equal(mounts, 1, 'own mount mutations do not cause an update loop');
  const second = row(); native.replaceChildren(second);
  observers[0].callback();
  assert.equal(native.children[1], container); assert.equal(container.value, 'draft');
  assert.equal(second.hidden, true); assert.equal(first.hidden, undefined);
  assert.equal(mounts, 2);
  container.remove(); observers[0].callback();
  assert.equal(native.children[1], container, 'a partial renderer may retain the anchor but remove its extension sibling');
  observers[0].callback(); assert.equal(mounts, 3);
  content.retain([]); assert.equal(observers[0].active, false);
  assert.equal(second.hidden, undefined); assert.equal(native.children.length, 1);
});

test('selector observation exists only for active targets and can discover initially absent anchors', () => {
  const document = dom(), native = document.createElement('div'); document.body.append(native);
  const observers = [];
  document.defaultView = { MutationObserver: class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.active = true; } disconnect() { this.active = false; }
  } };
  let views = [], mounts = 0;
  const content = create({ document, host: { mount() { mounts++; }, unmount() {} }, getViews: () => views });
  content.render('main.home.content', native); assert.equal(observers.length, 0);
  views = [{ ...descriptor, mode: 'append' }]; content.render('main.home.content', native);
  assert.equal(observers.length, 0, 'whole-root content needs no subtree observer');
  views = [{ ...descriptor, mode: 'append', selector: '.metric' }]; content.render('main.home.content', native);
  const row = document.createElement('span'); row.className = 'metric'; native.append(row);
  observers[0].callback(); assert.equal(mounts, 2);
  views = []; content.render('main.home.content', native); assert.equal(observers[0].active, false);
  views = [{ ...descriptor, mode: 'append', selector: '.metric' }]; content.render('main.home.content', native);
  content.dispose(); assert.equal(observers[1].active, false);
});


test('per-plugin release drains async mounts, subscriptions, styles and disposal, leaving other modules intact', async () => {
  const document=dom();let lifecycle,off=0,disposed=0,activated=0,finish;
  const a=document.createElement('div'),b=document.createElement('div');document.body.append(a,b);
  const host=createHost({document,window:{},bridge:{onLifecycle(fn){lifecycle=fn;return ()=>{};},subscribe(){return ()=>off++;}},
    importModule:async()=>({activate(ctx){activated++;ctx.onDispose(async()=>{await new Promise(setImmediate);disposed++;});return {mount(container){container.append(document.createElement('input'));return {dispose:()=>new Promise(resolve=>{finish=resolve;})};}};}})});
  await host.mount(a,{...descriptor,css:['fixture.css']});
  await host.load({...descriptor,pluginId:'other',revision:'two'});
  assert.equal((await lifecycle({action:'inspect',ids:['fixture']})).loaded,true);
  const release=host.release(['fixture']);await new Promise(setImmediate);
  assert.equal(disposed,0);finish();await release;
  assert.equal(disposed,1);assert.equal(off,1);assert.equal(document.head.children.length,0);assert.equal(a.children.length,0);
  assert.equal((await lifecycle({action:'inspect',ids:['other']})).loaded,true);
  await lifecycle({action:'resume',ids:['fixture']});await host.load(descriptor);assert.equal(activated,3);
  await host.dispose();assert.equal(disposed,3);assert.equal(off,3);
});
test('pending activation is cleaned on disable without ever mounting; cleanup failures propagate for recovery', async () => {
  const document=dom(),node=document.createElement('div');document.body.append(node);let resolve,mounted=0,cleaned=0;
  const host=createHost({document,window:{},bridge:{},importModule:()=>new Promise(r=>{resolve=r;})});
  const mount=host.mount(node,descriptor);const release=host.release(['fixture']);
  resolve({mount(){mounted++;},dispose(){cleaned++;}});await mount;await release;
  assert.equal(mounted,0);assert.equal(cleaned,1);await host.dispose();
  const bad=createHost({document,window:{},bridge:{},importModule:async()=>({mount(){return {dispose:async()=>{throw Error('async disposal failure');}};}})});
  await bad.mount(node,descriptor);await assert.rejects(bad.release(['fixture']),/async disposal failure/);await bad.dispose();
});
test('unsaved checks are per plugin, before cleanup, including retained hidden drafts', async () => {
  const document=dom(),node=document.createElement('div');document.body.append(node);let lifecycle;
  const host=createHost({document,window:{},bridge:{onLifecycle(fn){lifecycle=fn;}},importModule:async()=>({mount(){return {hasUnsavedChanges:()=>true};}})});
  await host.mount(node,descriptor);
  assert.equal((await lifecycle({action:'inspect',ids:['fixture']})).unsaved,true);
  assert.equal((await lifecycle({action:'inspect',ids:['other']})).unsaved,false);await host.dispose();
});


test('disable waits for an asynchronous visibility update before disposing its resources', async () => {
  const document=dom(),node=document.createElement('div');document.body.append(node);let finish;const order=[];
  const host=createHost({document,window:{},bridge:{},importModule:async()=>({mount(){return {
    update:()=>new Promise(resolve=>{finish=()=>{order.push('update finished');resolve();};}),dispose(){order.push('disposed');}
  };}})});
  await host.mount(node,descriptor);host.setVisibility(node,false);
  host.unmount(node); // descriptor removal can arrive before the lifecycle release IPC
  const release=host.release(['fixture']);await new Promise(setImmediate);assert.deepEqual(order,[]);
  finish();await release;assert.deepEqual(order,['update finished','disposed']);await host.dispose();
});


test('unmounted async redraw is cleared after release, including a connected page container', async () => {
  const document = dom(), node = document.createElement('div'); document.body.append(node);
  let finish, disposals = 0;
  const host = createHost({ document, window: {}, bridge: {}, importModule: async () => ({ mount(container) { return {
    update: () => new Promise(resolve => { finish = () => { container.append(document.createElement('input')); resolve(); }; }),
    dispose() { disposals++; }
  }; } }) });
  await host.mount(node, descriptor); host.setVisibility(node, false); host.unmount(node);
  const released = host.release(['fixture']); await new Promise(setImmediate); finish(); await released;
  assert.equal(node.isConnected, true); assert.equal(disposals, 1); assert.equal(node.children.length, 0);
  await host.dispose();
});
test('old asynchronous disposal never clears a newer mount in the same container', async () => {
  const document = dom(), node = document.createElement('div'); document.body.append(node);
  let finish;
  const host = createHost({ document, window: {}, bridge: {}, importModule: async url => ({ mount(container) {
    container.append(document.createElement('input'));
    return url.includes('/one/') ? { dispose: () => new Promise(resolve => { finish = resolve; }) } : {};
  } }) });
  await host.mount(node, descriptor); host.unmount(node);
  await host.mount(node, { ...descriptor, revision: 'two', entry: 'tm-plugin://fixture/two/ui.mjs' });
  const replacement = node.children[0]; finish(); await new Promise(setImmediate);
  assert.equal(node.children[0], replacement); assert.equal(node.children.length, 1); await host.dispose();
});
test('host announces plugin ownership before import and again after release/resume', async () => {
  const events = []; let lifecycle;
  const host = createHost({ document: dom(), window: {}, bridge: {
    uiLoading: id => events.push(['loading', id]), onLifecycle(fn) { lifecycle = fn; }
  }, importModule: async () => { events.push(['import']); return { mount() {} }; } });
  await host.load(descriptor); await host.load(descriptor);
  assert.deepEqual(events, [['loading', 'fixture'], ['import']]);
  await host.release(['fixture']); await lifecycle({ action: 'resume', ids: ['fixture'] }); await host.load(descriptor);
  assert.deepEqual(events, [['loading', 'fixture'], ['import'], ['loading', 'fixture'], ['import']]); await host.dispose();
});

for (const outcome of ['resolve', 'reject', 'dispose-reject']) test(`removed pending mount clears late DOM after ${outcome}`, async () => {
  const document = dom(), node = document.createElement('div'); document.body.append(node);
  let finish, entered, disposals = 0, lifecycle;
  const started = new Promise(resolve => { entered = resolve; });
  const host = createHost({ document, window: {}, bridge: { onLifecycle(fn) { lifecycle = fn; } }, importModule: async () => ({
    async mount(container) {
      entered(); await new Promise(resolve => { finish = resolve; });
      container.append(document.createElement('input'));
      if (outcome === 'reject') throw Error('mount rejected');
      return { dispose() { disposals++; if (outcome === 'dispose-reject') throw Error('dispose rejected'); } };
    }
  }) });
  const mounted = host.mount(node, descriptor); await started; host.unmount(node);
  let settled = false;
  const released = host.release(['fixture']);
  const checked = outcome === 'dispose-reject' ? assert.rejects(released, /dispose rejected/) : released;
  void checked.then(() => { settled = true; });
  await new Promise(setImmediate); assert.equal(settled, false);
  finish(); await mounted; await checked;
  assert.equal(node.isConnected, true); assert.equal(node.children.length, 0);
  assert.equal(disposals, outcome === 'reject' ? 0 : 1);
  assert.equal((await lifecycle({ action: 'inspect', ids: ['fixture'] })).loaded, false);
  await host.dispose();
});
for (const rejected of [false, true]) test(`stale pending mount ${rejected ? 'rejection' : 'disposal'} preserves newer owner`, async () => {
  const document = dom(), node = document.createElement('div'); document.body.append(node);
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const host = createHost({ document, window: {}, bridge: {}, importModule: async url => ({ async mount(container) {
    if (url.includes('/one/')) {
      entered(); await new Promise(resolve => { finish = resolve; });
      if (rejected) throw Error('stale mount rejected');
      return { dispose() {} };
    }
    container.append(document.createElement('input')); return {};
  } }) });
  const old = host.mount(node, descriptor); await started; host.unmount(node);
  await host.mount(node, { ...descriptor, revision: 'two', entry: 'tm-plugin://fixture/two/ui.mjs' });
  const replacement = node.children[0]; replacement.value = 'new draft';
  finish(); await old;
  assert.equal(node.children.length, 1); assert.equal(node.children[0], replacement); assert.equal(replacement.value, 'new draft');
  await host.dispose();
});

test('per-container activity parks native-page demand without disposing retained controls', async () => {
  const { createPluginViewHost } = require('../../src/electron/renderer/pluginViews');
  const document = dom(); document.addEventListener = document.removeEventListener = () => {};
  let frame, disposed = 0; const demands = [], visibility = new Map();
  const window = { requestAnimationFrame: fn => { frame = fn; return 1; }, cancelAnimationFrame() {},
    TokenMonitorPluginUi: { createHost: () => ({ mount() {}, unmount() { disposed++; }, sweep() {}, setVisibility(node, visible) { visibility.set(node, visible); }, dispose() {} }) } };
  const host = createPluginViewHost({ document, window, onDemand: (_surface, refs) => demands.push(refs), isSurfaceActive: (_surface, node) => node.active });
  host.update({ surface: 'notch', views: { [descriptor.ref]: descriptor } });
  const nodes = [true, false].map(active => {
    const node = document.createElement('div'); node.style.removeProperty = () => {}; node.getClientRects = () => [{}]; node.active = active;
    document.body.append(node); host.mount(node, descriptor.ref, 'notch'); return node;
  });
  frame(); assert.deepEqual(demands.at(-1), [descriptor.ref]);
  nodes[0].active = false; host.refreshDemand(); frame(); assert.deepEqual(demands.at(-1), []);
  assert.equal(visibility.get(nodes[0]), false); assert.equal(disposed, 0);
  nodes[1].active = true; host.refreshDemand(); frame(); assert.deepEqual(demands.at(-1), [descriptor.ref]);
  nodes[0].active = true; nodes[1].active = false; host.refreshDemand(); frame(); assert.deepEqual(demands.at(-1), [descriptor.ref]);
  await host.dispose();
});

test('navigation artwork is static metadata and decode errors restore the named fallback', () => {
  const document = dom(); document.createElementNS = (_namespace, tag) => document.createElement(tag);
  const { navigationIcon } = require('../../src/electron/renderer/pluginViews');
  const icon = navigationIcon(document, { identityIcon: 'data:image/png;base64,bad', icon: 'cpu' }, 15);
  const image = icon.querySelector('img');
  assert.equal(image.src, 'data:image/png;base64,bad');
  assert.equal(image.alt, '');
  assert.equal(image.width, 15);
  image.fire('error');
  assert.equal(icon.querySelector('img'), null);
  assert.deepEqual(icon.querySelector('path').attributes,
    navigationIcon(document, { icon: 'cpu' }, 15).querySelector('path').attributes);
});


test('main navigation uses the named icon even without identity artwork', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
  const body = source.slice(source.indexOf('function viewSwitcherIcon('), source.indexOf('function clearViewSwitcherLongPress('));
  const document = dom(); document.createElementNS = (_namespace, tag) => document.createElement(tag);
  const views = require('../../src/electron/renderer/pluginViews');
  const page = { id: 'plugin:fixture/panel', icon: 'cpu' };
  const context = { document, window: { TokenMonitorPluginViews: views }, pluginPageOptions: () => [page], VIEW_ICON_CLASSES: {}, pluginPlacementsApi: { isHomeToken: () => true } };
  vm.runInNewContext(body + ';this.icon=viewSwitcherIcon("plugin:fixture/panel")', context);
  assert.ok(context.icon.querySelector('path'));
  assert.deepEqual(context.icon.querySelector('path').attributes, views.navigationIcon(document, page, 14).querySelector('path').attributes);
});

test('header slots isolate late mounts and release actions on update failure', async () => {
  const document = dom(), node = document.createElement('div'), actions = document.createElement('div');
  document.body.append(node, actions);
  let finish;
  const host = createHost({ document, window: {}, bridge: {}, importModule: async () => ({ mount(_node, context) {
    if (context.ref === descriptor.ref) return new Promise(resolve => { finish = () => {
      context.headerActions.append(document.createElement('button')); resolve({});
    }; });
    context.headerActions.append(document.createElement('button'));
    return { update() { throw Error('header update failed'); } };
  } }) });
  const pending = host.mount(node, descriptor, { headerActions: actions }); await new Promise(setImmediate);
  host.unmount(node); assert.equal(actions.children.length, 0);
  const next = { ...descriptor, ref: 'fixture/next' };
  await host.mount(node, next, { headerActions: actions }); const owned = actions.children[0];
  finish(); await pending;
  assert.equal(actions.children.length, 1); assert.equal(actions.children[0], owned);
  await host.mount(node, next, {}); assert.equal(actions.children.length, 0);
  await host.dispose();
});

test('reused mounts move header controls without replacing drafts and remove omitted slots', async () => {
  const document = dom(), node = document.createElement('div'), a = document.createElement('div'), b = document.createElement('div');
  document.body.append(node, a, b);
  let latest;
  const host = createHost({ document, window: {}, bridge: {}, importModule: async () => ({ mount(container, context) {
    latest = context;
    context.headerActions.append(document.createElement('button'));
    container.append(document.createElement('input'));
    return { update(value) { latest = value; } };
  } }) });
  await host.mount(node, descriptor, { headerActions: a });
  const mount = latest.headerActions, button = mount.children[0], input = node.children[0]; input.value = 'draft';
  await host.mount(node, descriptor, { headerActions: b });
  assert.equal(a.children.length, 0); assert.equal(b.children[0], mount); assert.equal(mount.children[0], button);
  assert.equal(latest.headerActions, mount); assert.equal(node.children[0], input); assert.equal(input.value, 'draft');
  await host.mount(node, descriptor, {});
  assert.equal(b.children.length, 0); assert.equal(latest.headerActions, undefined);
  await host.mount(node, descriptor, { headerActions: a });
  assert.equal(a.children[0], latest.headerActions); assert.notEqual(latest.headerActions, mount);
  await host.dispose(); assert.equal(a.children.length, 0);
});


test('shared plugin host shows keyboard cues only after input and never moves native-restored focus', async () => {
  const document = dom(), handlers = {}, windowHandlers = {};
  document.documentElement = document.createElement('html');
  document.addEventListener = (name, fn) => { handlers[name] = fn; };
  document.removeEventListener = (name, fn) => { assert.equal(handlers[name], fn); delete handlers[name]; };
  const window = {
    addEventListener(name, fn) { windowHandlers[name] = fn; },
    removeEventListener(name, fn) { assert.equal(windowHandlers[name], fn); delete windowHandlers[name]; }
  };
  const host = createHost({ document, window, bridge: {}, importModule: async () => ({ mount(_node, context) {
    context.headerActions.append(document.createElement('button')); return {};
  } }) });
  const keyboard = () => document.documentElement.classList.contains('plugin-keyboard-focus');
  assert.equal(keyboard(), false, 'initial native autofocus has no keyboard cue');
  for (const surface of ['page', 'notch', 'edgeDock']) {
    const node = document.createElement('div'), actions = document.createElement('div'); document.body.append(node, actions);
    await host.mount(node, { ...descriptor, ref: `fixture/${surface}` }, { surface, headerActions: actions });
    const button = actions.children[0].children[0]; button.focus();
    for (const key of ['Tab', 'ArrowRight', 'Enter']) {
      handlers.keydown({ key }); assert.equal(keyboard(), true);
      windowHandlers.blur?.(); assert.equal(keyboard(), true, 'keyboard cues survive OS switching');
      assert.equal(document.activeElement, button, 'window switching preserves the focused control');
    }
    for (const name of ['pointerdown', 'pointermove']) {
      handlers.keydown({ key: 'Tab' }); handlers[name](); assert.equal(keyboard(), false);
      assert.equal(document.activeElement, button);
    }
    const editor = document.createElement('input'); node.append(editor); editor.focus();
    handlers.pointerdown(); windowHandlers.blur?.(); assert.equal(document.activeElement, editor);
  }
  await host.dispose();
  assert.deepEqual(handlers, {}); assert.deepEqual(windowHandlers, {});
});
