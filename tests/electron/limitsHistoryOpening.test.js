'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('history opening reports its size without paint callbacks; visible switches still wait for paint', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/limits/history.js'), 'utf8');
  const content = source.slice(source.indexOf('  function renderContent('), source.indexOf('  reducedMotionMedia.addEventListener('));
  const sizing = source.slice(source.indexOf('  const cardLayout ='), source.indexOf('  new ResizeObserver(() => scheduleSize())'));
  const frames = new Map(), reports = [];
  let sequence = 0;
  const context = vm.createContext({
    payload: { renderToken: 5 },
    window: { addEventListener() {} },
    bridge: { resize: (...args) => reports.push(args) },
    reduceMotion: () => false,
    $: () => ({ getBoundingClientRect: () => ({ height: 320 }), animate: () => ({ finished: Promise.resolve(), cancel() {} }) }),
    getComputedStyle: () => ({ paddingTop: '12px', paddingBottom: '12px', borderTopWidth: '1px', borderBottomWidth: '1px' }),
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: id => frames.delete(id)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/cardLayout.js'), 'utf8'), context);
  vm.runInContext(`let contentAnimation = null, animateMeasurement = false;
    function render() {}
    ${content}\n${sizing}`, context);
  const paint = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback());
  };

  vm.runInContext('renderContent(true, true)', context);
  assert.deepEqual(reports, [[346, 5, false, false]], 'a hidden window must not depend on a paint to become visible');
  assert.equal(frames.size, 0, 'opening cancels its pending measurement frame');

  vm.runInContext('payload.renderToken = 6; renderContent(true, false)', context);
  assert.equal(reports.length, 1, 'a visible switch waits for the new content to paint');
  paint();
  assert.equal(reports.length, 1);
  paint();
  assert.deepEqual(reports[1], [346, 6, true, false]);

  vm.runInContext('payload.renderToken = 7; renderContent(true, false); renderContent(true, true)', context);
  assert.deepEqual(reports[2], [346, 7, false, false], 'reopening also releases an already queued measurement');
  assert.equal(frames.size, 0);
});
