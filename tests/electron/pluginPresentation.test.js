'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { rectangle } = require('../../src/electron/renderer/pluginPresentationWeb');
function fixture() {
  const box = { x: 30, y: 40, left: 30, top: 40, right: 230, bottom: 190, width: 200, height: 150 };
  const css = { display: 'block', visibility: 'visible', opacity: '1', clipPath: 'none', overflowX: 'visible', overflowY: 'visible' };
  const parent = { parentElement: null, clientLeft: 2, clientTop: 2, clientWidth: 296, clientHeight: 296, getBoundingClientRect: () => ({ x: 0, y: 0 }), getAnimations: () => [] };
  const node = { parentElement: parent, isConnected: true, getBoundingClientRect: () => box, getAnimations: () => [], contains: target => target === node };
  const doc = { hidden: false, querySelectorAll: () => [], elementFromPoint: () => node };
  const win = { innerWidth: 400, innerHeight: 400, getComputedStyle: () => css };
  return { node, doc, win, css, box, parent, rect: () => rectangle(node, doc, win) };
}
test('presentation admission rejects hidden, moving, clipped and covered card rectangles', () => {
  const f = fixture(); assert.deepEqual(f.rect(), { x: 30, y: 40, width: 200, height: 150 });
  f.doc.hidden = true; assert.equal(f.rect(), null); f.doc.hidden = false;
  f.node.getAnimations = () => [{ playState: 'running' }]; assert.equal(f.rect(), null); f.node.getAnimations = () => [];
  f.css.overflowY = 'auto'; f.parent.clientHeight = 180; assert.equal(f.rect(), null); f.parent.clientHeight = 296;
  f.doc.elementFromPoint = () => ({}); assert.equal(f.rect(), null); f.doc.elementFromPoint = () => f.node;
  f.doc.querySelectorAll = () => [{ getBoundingClientRect: () => ({ left: 80, top: 80, right: 90, bottom: 90, width: 10, height: 10 }) }];
  assert.equal(f.rect(), null, 'small host dialog between sampled points still blocks the whole card');
});
test('presentation rejects partial viewport bounds and arbitrary clipping paths', () => {
  const f = fixture(); f.box.right = 401; assert.equal(f.rect(), null); f.box.right = 230;
  f.css.clipPath = 'circle(50%)'; assert.equal(f.rect(), null); f.css.clipPath = 'none';
  f.node.isConnected = false; assert.equal(f.rect(), null);
});
