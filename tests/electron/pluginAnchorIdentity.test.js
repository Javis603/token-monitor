'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Element } = require('../helpers/notchPanel');
const { create } = require('../../src/electron/renderer/pluginContent');
function fixture(t, mode = 'replace') {
  const document = { createElement(tag) {
    const node = new Element(tag, document);
    Object.defineProperties(node, {
      isConnected: { get: () => document.body?.contains(node) || false },
      nextSibling: { get: () => node.parent?.children[node.parent.children.indexOf(node) + 1] }
    });
    node.insertBefore = (child, next) => {
      if (child === next) return;
      child.remove(); const index = next ? node.children.indexOf(next) : node.children.length;
      child.parent = node; node.children.splice(index, 0, child);
    };
    node.moveBefore = (child, next) => {
      if (child === next) return;
      child.parent.children.splice(child.parent.children.indexOf(child), 1);
      const index = next ? node.children.indexOf(next) : node.children.length;
      child.parent = node; node.children.splice(index, 0, child);
    };
    return node;
  } };
  document.body = document.createElement('body');
  const root = document.createElement('main'); document.body.append(root);
  const anchor = label => {
    const node = document.createElement('section'); node.className = 'metric';
    node.dataset.label = label; node.hidden = false; return node;
  };
  const a = anchor('A'), b = anchor('B'); root.append(a, b);
  const instances = new Map(), contexts = new Map(), removed = [];
  let mounts = 0, complete = true;
  const view = { ref: 'fixture/panel', revision: 'one', mode, selector: '.metric', targets: ['main.home.content'] };
  let views = [view];
  const content = create({ document, getViews: () => views, selection: () => view.ref,
    host: { mount(node, _view, context) {
      if (!instances.has(node)) {
        const input = document.createElement('input'); input.value = context.native.dataset.label + ' draft';
        node.append(input); instances.set(node, input); mounts++;
      }
      contexts.set(node, context); if (complete) context.onMountStatus(true);
    }, unmount(node) { removed.push(node); instances.delete(node); } }
  });
  t.after(() => content.dispose());
  return { root, a, b, anchor, content, contexts, removed,
    render: () => content.render('main.home.content', root),
    get mounts() { return mounts; }, set views(value) { views = value; }, set complete(value) { complete = value; }
  };
}

test('inserting an anchor never borrows a surviving anchor outlet at the same index', t => {
  const f = fixture(t); f.render(); const a = f.a.nextSibling, b = f.b.nextSibling;
  const c = f.anchor('C'); f.root.insertBefore(c, f.a); f.render();
  assert.ok(f.a.nextSibling === a); assert.ok(f.b.nextSibling === b);
  assert.ok(c.nextSibling !== a && c.nextSibling !== b);
  assert.equal(a.children[0].value, 'A draft'); assert.equal(b.children[0].value, 'B draft');
  assert.equal(f.contexts.get(a).anchorIndex, 1); assert.equal(f.contexts.get(b).anchorIndex, 2);
  assert.equal(f.mounts, 3); assert.equal(f.removed.length, 0);
});

test('removing the first anchor disposes only its own outlet and restores its visibility', t => {
  const f = fixture(t); f.render(); const a = f.a.nextSibling, b = f.b.nextSibling;
  f.a.remove(); f.render();
  assert.ok(f.b.nextSibling === b); assert.equal(b.children[0].value, 'B draft');
  assert.deepEqual(f.removed, [a]); assert.equal(f.a.hidden, false); assert.equal(f.b.hidden, true);
  assert.equal(f.contexts.get(b).anchorIndex, 0);
  f.views = []; f.render(); assert.equal(f.b.hidden, false); assert.equal(f.removed.length, 2);
});

test('a rebuilt anchor at a moved slot cannot take a surviving anchor draft', t => {
  const f = fixture(t); f.render(); const a = f.a.nextSibling, oldB = f.b.nextSibling;
  f.b.remove(); const rebuilt = f.anchor('rebuilt B'); f.root.insertBefore(rebuilt, f.a); f.render();
  assert.ok(f.a.nextSibling === a); assert.equal(a.children[0].value, 'A draft');
  assert.ok(rebuilt.nextSibling !== a && rebuilt.nextSibling !== oldB, 'ambiguous moved replacement gets a fresh outlet');
  assert.equal(rebuilt.nextSibling.children[0].value, 'rebuilt B draft');
  assert.deepEqual(f.removed, [oldB]); assert.equal(f.b.hidden, false);
});

test('fully rebuilt unchanged slots retain the existing documented positional fallback', t => {
  const f = fixture(t); f.render(); const a = f.a.nextSibling, b = f.b.nextSibling;
  const nextA = f.anchor('next A'), nextB = f.anchor('next B'); f.root.replaceChildren(nextA, nextB); f.render();
  assert.ok(nextA.nextSibling === a); assert.ok(nextB.nextSibling === b);
  assert.equal(a.children[0].value, 'A draft'); assert.equal(b.children[0].value, 'B draft');
  assert.equal(f.mounts, 2); assert.equal(f.removed.length, 0);
  assert.equal(f.a.hidden, false); assert.equal(f.b.hidden, false);
});

test('duplicate logical keys do not exchange surviving native-anchor drafts on reorder', t => {
  const f = fixture(t); f.a.dataset.key = f.b.dataset.key = 'same'; f.render();
  const a = f.a.nextSibling, b = f.b.nextSibling; f.root.moveBefore(f.b, f.a); f.render();
  assert.ok(f.a.nextSibling === a); assert.ok(f.b.nextSibling === b);
  assert.equal(a.children[0].value, 'A draft'); assert.equal(b.children[0].value, 'B draft');
});

for (const mode of ['append', 'decorate', 'replace']) for (const hidden of [false, true])
  test(`logical-key reset preserves native visibility for ${mode}, initially hidden=${hidden}`, t => {
    const f = fixture(t, mode); f.a.hidden = hidden; f.a.dataset.key = 'one'; f.render();
    const a = f.a.nextSibling, staleComplete = f.contexts.get(a).onMountStatus;
    f.a.dataset.key = 'two'; f.render();
    assert.ok(f.a.nextSibling !== a); assert.deepEqual(f.removed, [a]);
    f.views = []; f.render();
    assert.equal(f.a.hidden, hidden, 'reset must not capture the previous replacement-hidden state');
    staleComplete(true); assert.equal(f.a.hidden, hidden, 'obsolete completion cannot hide native after deselection');
  });

test('stale replacement completion after identity-preserving reorder cannot change visibility', t => {
  const f = fixture(t); f.render(); const a = f.a.nextSibling, oldComplete = f.contexts.get(a).onMountStatus;
  f.complete = false; f.root.moveBefore(f.b, f.a); f.render();
  oldComplete(false); assert.equal(f.a.hidden, true);
  f.contexts.get(a).onMountStatus(false); assert.equal(f.a.hidden, false); assert.equal(f.b.hidden, true);
});
