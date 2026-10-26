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
    node.insertBefore = (child, next) => { child.remove(); const index = next ? node.children.indexOf(next) : node.children.length; child.parent = node; node.children.splice(index, 0, child); };
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
