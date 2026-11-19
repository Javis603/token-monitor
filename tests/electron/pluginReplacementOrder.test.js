'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Element } = require('../helpers/notchPanel');
const { createHost } = require('../../src/electron/renderer/pluginUi');
const { create } = require('../../src/electron/renderer/pluginContent');
const tick = () => new Promise(setImmediate);
const descriptor = revision => ({ id: 'panel', ref: 'fixture/panel', pluginId: 'fixture', revision,
  entry: `tm-plugin://fixture/${revision}/ui.mjs` });

function fixture(t, mount) {
  const gates = [], errors = [], events = [];
  const document = { createElement(tag) {
    const node = new Element(tag, document);
    Object.defineProperties(node, {
      isConnected: { get: () => document.body?.contains(node) || false },
      parentNode: { get: () => node.parent },
      nextSibling: { get: () => node.parent?.children[node.parent.children.indexOf(node) + 1] }
    });
    node.insertBefore = (child, next) => {
      if (child === next) return;
      child.remove(); const index = next ? node.children.indexOf(next) : node.children.length;
      child.parent = node; node.children.splice(index, 0, child);
    };
    return node;
  } };
  document.body = document.createElement('body'); document.head = document.createElement('head');
  const container = document.createElement('main'); document.body.append(container);
  function gate() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    gates.push(resolve); return { promise, resolve };
  }
  const host = createHost({ document, window: {}, bridge: {}, onError: error => errors.push(error.message),
    importModule: async url => ({ mount: (node, context) => mount({ node, context, revision: url.split('/')[3], gate, events }) }) });
  t.after(async () => { for (const done of gates) done(); await tick(); await host.dispose(); });
  return { host, container, document, gate, errors, events };
}

for (const phase of ['update', 'dispose', 'mount', 'mount-reject']) {
  test(`replacement waits for old ${phase} DOM writes before mounting new controls`, async t => {
    let entered, finish;
    const started = new Promise(resolve => { entered = resolve; });
    const f = fixture(t, async ({ node, revision, gate, events }) => {
      if (revision !== 'one') { events.push('new mount'); node.textContent = 'NEW DRAFT'; return {}; }
      const write = async () => {
        const wait = gate(); finish = wait.resolve; entered(); await wait.promise;
        events.push('old ' + phase); node.textContent = 'OLD WRITE';
        if (phase === 'mount-reject') throw Error('old mount failed');
      };
      if (phase.startsWith('mount')) await write();
      return { update: phase === 'update' ? write : undefined, dispose: phase === 'dispose' ? write : undefined };
    });
    const old = f.host.mount(f.container, descriptor('one'));
    if (phase.startsWith('mount')) await started;
    else await old;
    if (phase === 'update') f.host.setVisibility(f.container, false);
    const replacement = f.host.mount(f.container, descriptor('two'));
    await started; await tick();
    assert.deepEqual(f.events, [], 'replacement must not enter author code while old work is running');
    finish(); await Promise.all([old, replacement]);
    assert.deepEqual(f.events, ['old ' + phase, 'new mount']);
    assert.equal(f.container.textContent, 'NEW DRAFT');
  });
}

test('rapid revision switches mount only the latest request and preserve its latest context', async t => {
  let finish;
  const contexts = [];
  const f = fixture(t, ({ node, revision, context, gate, events }) => {
    events.push(revision); contexts.push(context.period);
    node.textContent = revision;
    return revision === 'one' ? { dispose() { const wait = gate(); finish = wait.resolve; return wait.promise; } } : {};
  });
  await f.host.mount(f.container, descriptor('one'));
  const second = f.host.mount(f.container, descriptor('two'));
  const third = f.host.mount(f.container, descriptor('three'), { period: 'today' });
  await f.host.mount(f.container, descriptor('three'), { period: 'month' });
  await tick(); assert.deepEqual(f.events, ['one']);
  finish(); await Promise.all([second, third]);
  assert.deepEqual(f.events, ['one', 'three']); assert.equal(contexts.at(-1), 'month');
});

test('explicit unmount cancels a waiting replacement and drains old work without reviving it', async t => {
  let finish;
  const f = fixture(t, ({ node, revision, gate, events }) => {
    events.push(revision); node.textContent = revision;
    return revision === 'one' ? { dispose() { const wait = gate(); finish = wait.resolve; return wait.promise; } } : {};
  });
  await f.host.mount(f.container, descriptor('one'));
  const waiting = f.host.mount(f.container, descriptor('two'));
  f.host.unmount(f.container); await tick(); finish(); await waiting; await tick();
  assert.deepEqual(f.events, ['one']); assert.equal(f.container.children.length, 0);
  await f.host.mount(f.container, descriptor('three'));
  assert.deepEqual(f.events, ['one', 'three']);
});

test('replacement waits across plugin IDs while unrelated containers keep rendering', async t => {
  let finish;
  const f = fixture(t, ({ node, revision, gate, events }) => {
    events.push(revision); node.textContent = revision;
    return revision === 'one' ? { dispose() { const wait = gate(); finish = wait.resolve; return wait.promise; } } : {};
  });
  await f.host.mount(f.container, descriptor('one'));
  const other = { ...descriptor('two'), pluginId: 'other', ref: 'other/panel' };
  const waiting = f.host.mount(f.container, other);
  const independent = f.document.createElement('aside'); f.document.body.append(independent);
  await f.host.mount(independent, descriptor('three'));
  assert.deepEqual(f.events, ['one', 'three']);
  await tick(); finish(); await waiting;
  assert.equal(f.container.textContent, 'two'); assert.equal(independent.textContent, 'three');
});

for (const action of ['release', 'dispose']) test(`${action} cancels waiting mounts and drains cleanup without deadlock`, async t => {
  let finish;
  const f = fixture(t, ({ revision, gate, events }) => {
    events.push(revision);
    return revision === 'one' ? { dispose() { const wait = gate(); finish = wait.resolve; return wait.promise; } } : {};
  });
  await f.host.mount(f.container, descriptor('one'));
  const waiting = f.host.mount(f.container, descriptor('two'));
  let settled = false;
  const released = action === 'release' ? f.host.release(['fixture']) : f.host.dispose();
  void released.then(() => { settled = true; });
  await tick(); assert.equal(settled, false); finish();
  await Promise.all([waiting, released]); assert.deepEqual(f.events, ['one']);
});

test('rejected old cleanup is reported, settles before new mount, and remains a release failure', async t => {
  let finish;
  const f = fixture(t, ({ node, revision, gate, events }) => {
    events.push(revision); node.textContent = revision;
    return revision === 'one' ? { async dispose() {
      const wait = gate(); finish = wait.resolve; await wait.promise;
      node.textContent = 'old cleanup'; throw Error('cleanup failed');
    } } : {};
  });
  await f.host.mount(f.container, descriptor('one'));
  const waiting = f.host.mount(f.container, descriptor('two'));
  await tick(); assert.deepEqual(f.events, ['one']); finish(); await waiting;
  assert.equal(f.container.textContent, 'two'); assert.deepEqual(f.errors, ['cleanup failed']);
  await assert.rejects(f.host.release(['fixture']), /cleanup failed/);
});

test('a mount requested by an unmount callback supersedes the interrupted replacement', async t => {
  const f = fixture(t, ({ revision, events }) => { events.push(revision); return {}; });
  let replacement;
  await f.host.mount(f.container, descriptor('one'), { onMountStatus(ok) {
    if (!ok) replacement = f.host.mount(f.container, descriptor('three'));
  } });
  await f.host.mount(f.container, descriptor('two')); await replacement;
  assert.deepEqual(f.events, ['one', 'three']);
});

for (const target of ['main.tool.content', 'main.model.content', 'main.limits.content',
  'main.status.content', 'notch.home.content', 'edgeDock.stat.content']) {
  for (const mode of ['append', 'decorate', 'replace']) {
    test(`${target} ${mode}: compositor keeps native fallback until container handover completes`, async t => {
      let finish;
      const f = fixture(t, ({ node, revision, gate, events }) => {
        events.push(revision); node.textContent = revision;
        return revision === 'one' ? { async update() {
          const wait = gate(); finish = wait.resolve; await wait.promise; node.textContent = 'OLD UPDATE';
        } } : {};
      });
      const native = f.document.createElement('section'); native.hidden = false; f.document.body.append(native);
      let view = { ...descriptor('one'), targets: [target], mode };
      const content = create({ document: f.document, host: f.host, getViews: () => view ? [view] : [],
        selection: () => view?.ref });
      t.after(() => content.dispose());
      content.render(target, native); await tick();
      const container = native.nextSibling;
      assert.equal(native.hidden, mode === 'replace');
      content.render(target, native);
      view = { ...view, ...descriptor('two') }; content.render(target, native); await tick();
      assert.equal(native.hidden, false, 'pending replacement leaves native content available');
      assert.deepEqual(f.events, ['one']);
      finish(); await tick();
      assert.equal(native.nextSibling, container); assert.equal(container.textContent, 'two');
      assert.equal(native.hidden, mode === 'replace');
      view = null; content.render(target, native); await tick();
      assert.equal(native.hidden, false); assert.equal(container.isConnected, false);
    });
  }
}
