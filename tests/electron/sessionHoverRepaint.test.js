'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const domApi = require('../../src/electron/renderer/domReconcile');
const { Element } = require('../helpers/notchPanel');

function fixture() {
  const document = { activeElement: null };
  const node = (key, text, className = 'row') => {
    const element = new Element('div', document);
    element.dataset.key = key; element.className = className; element.textContent = text;
    return element;
  };
  const root = new Element('main', document);
  return { document, node, root, dom: domApi.create() };
}

test('keyed pushes preserve focused rows, handler state and scroll while text changes', () => {
  const { document, node, root, dom } = fixture();
  const row = node('session', '100');
  dom.reconcileChildren(root, [row]); row.focus();
  row.classList.add('is-hover-reading'); row.style.setProperty('transform', 'translateX(-12px)'); root.scrollTop = 70;
  for (const amount of ['200', '300']) {
    dom.reconcileChildren(root, [node('session', amount)]);
    assert.equal(root.children[0], row); assert.equal(row.textContent, amount);
    assert.equal(document.activeElement, row); assert.equal(root.scrollTop, 70);
    assert.ok(row.classList.contains('is-hover-reading'));
    assert.equal(row.style.transform, 'translateX(-12px)');
  }
});

test('ranking and selected-state changes retain logical controls, insertion/removal retires only obsolete keys', () => {
  const { document, node, root, dom } = fixture();
  const a = node('a', 'A'), b = node('b', 'B');
  dom.reconcileChildren(root, [a, b]); b.focus();
  dom.reconcileChildren(root, [node('b', 'B2', 'selected'), node('new', 'New'), node('a', 'A2')]);
  assert.equal(root.children[0], b); assert.equal(root.children[2], a); assert.equal(document.activeElement, b);
  dom.reconcileChildren(root, [node('b', 'B3', 'selected')]);
  assert.equal(root.children[0], b); assert.equal(a.parentNode, null);
});

test('retained listeners read current DTOs and changed control capability installs fresh listeners', () => {
  const { node, root, dom } = fixture();
  const plain = node('model', 'one model'); dom.reconcileChildren(root, [plain]);
  let value;
  const tooltip = node('model', 'two models'); tooltip.dataset.domKind = 'tooltip';
  domApi.data(tooltip, { tokens: 100 });
  tooltip.addEventListener('focus', event => { value = domApi.data(event.currentTarget).tokens; });
  dom.reconcileChildren(root, [tooltip]); assert.notEqual(root.children[0], plain);
  const next = node('model', 'two models'); next.dataset.domKind = 'tooltip'; domApi.data(next, { tokens: 200 });
  dom.reconcileChildren(root, [next]); tooltip.fire('focus');
  assert.equal(root.children[0], tooltip); assert.equal(value, 200);
  assert.equal(dom.resolve(next), tooltip, 'layout callbacks can resolve their staged node to the live node');
});

test('native updates preserve plugin outlets beside retained anchors', () => {
  const { node, root } = fixture();
  const anchor = node('native', '100'), outlet = node('author', 'unsaved draft');
  const dom = domApi.create({ nodesFor: element => element === anchor ? [outlet] : [] });
  dom.reconcileChildren(root, [anchor]); root.append(outlet);
  dom.reconcileChildren(root, [node('native', '200')]);
  assert.deepEqual(root.children, [anchor, outlet]); assert.equal(outlet.textContent, 'unsaved draft');
});

test('nested account, session and family scroll containers survive independently', () => {
  const { node, root, dom } = fixture();
  const build = amount => {
    const accounts = node('accounts', ''), sessions = node('sessions', ''), family = node('family', '');
    accounts.append(node('account', amount)); family.append(node('child', amount)); sessions.append(family);
    return [accounts, sessions];
  };
  dom.reconcileChildren(root, build('100'));
  const [accounts, sessions] = root.children, family = sessions.children[0];
  accounts.scrollTop = 25; sessions.scrollTop = 150; family.scrollTop = 60;
  for (const amount of ['200', '300']) {
    dom.reconcileChildren(root, build(amount));
    assert.equal(root.children[0], accounts); assert.equal(root.children[1], sessions);
    assert.equal(sessions.children[0], family);
    assert.deepEqual([accounts.scrollTop, sessions.scrollTop, family.scrollTop], [25, 150, 60]);
  }
  dom.clear(root); assert.equal(root.children.length, 0);
  dom.reconcileChildren(root, build('400')); assert.notEqual(root.children[0], accounts);
});
