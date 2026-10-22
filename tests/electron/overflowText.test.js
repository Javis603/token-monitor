'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { create } = require('../../src/electron/renderer/overflowText');

function harness(distance = 7, options = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const frames = new Map();
  function node() {
    const classes = new Set();
    return {
      children: [], dataset: {}, style: {}, isConnected: true, clientWidth: 200, scrollLeft: 0,
      get childNodes() { return this.children; },
      get textContent() { return this.children.map(child => child.textContent).join(''); },
      set textContent(text) { this.children = [{ textContent: text }]; },
      append(...children) { this.children = children; },
      replaceChildren(...children) { this.children = children; },
      getBoundingClientRect: () => ({ width: 200 + distance, left: 0, right: 200, top: 0, bottom: 20 }),
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
      },
      addEventListener(type, handler) { this[type] = handler; },
      setAttribute(name, value) { this[name] = value; },
      hasAttribute(name) { return Object.hasOwn(this, name); },
      removeAttribute(name) { delete this[name]; }
    };
  }
  const element = node();
  element.textContent = 'Review Token Monitor PR 883';
  const window = {
    addEventListener() {}, performance: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id)
  };
  const document = { createElement: node, querySelectorAll: () => [element] };
  const api = create({ document, window, prefersReducedMotion: () => false, ...options });
  function frame(at) {
    now = at;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(at));
  }
  function hover(event) {
    element.mouseenter(event);
    assert.equal(timers.size, 1, 'hover schedules one delay timer');
    const [id, timer] = [...timers][0];
    assert.equal(timer.delay, 240);
    timers.delete(id);
    timer.callback();
  }
  api.bind(element);
  frame(0);
  return { api, element, node, document, window, frame, hover, frames, timers };
}

test('sync endpoint reuses hover reading and preserves its wrapper across settings pushes', () => {
  let reduced = false;
  const h = harness(100);
  const endpoint = h.node();
  endpoint.id = 'syncConnectionEndpoint';
  endpoint.closest = () => null;
  const document = { activeElement: null, createElement: h.node, querySelectorAll: () => [endpoint] };
  const control = () => ({ contains: () => false });
  const els = Object.fromEntries(['syncConnectionEditor', 'syncDeviceSettings', 'syncConnectionEdit',
    'syncConnectionCancel', 'syncConnectionIdentity', 'syncUploadIntervalRow', 'syncConnectionSaveError']
    .map(id => [id, control()]));
  els.syncConnectionEndpoint = endpoint;
  const state = { settings: { hubMode: 'client', hubUrl: 'https://user:password@long-host.example:8443/private?secret=hidden#token' } };
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const setup = app.slice(app.indexOf('const overflowText ='), app.indexOf('// Two clicks to remove from sync settings'));
  const ui = app.slice(app.indexOf('function syncHubConnectionUi('), app.indexOf('function beginClientConnectionEdit('));
  const context = vm.createContext({
    document, window: { ...h.window, TokenMonitorOverflowText: { create } }, els, state,
    requestAnimationFrame: h.window.requestAnimationFrame, homeSessionRenderPending: false,
    prefersReducedMotion: () => reduced, clientConnectionEditing: false, hubSaveBusy: false, hubSaveError: false,
    clientConnectionHasDraft: () => false, syncDevicePanelApi: require('../../src/electron/renderer/syncDevicePanel'),
    t: () => 'Saved Hub URL'
  });
  vm.runInContext(`${setup}\n${ui}`, context);
  context.syncHubConnectionUi();
  h.frame(0);
  const content = endpoint.children[0];
  assert.equal(endpoint.textContent, 'long-host.example:8443');
  assert.equal(endpoint.classList.contains('is-overflow-enabled'), true);
  assert.equal(endpoint.classList.contains('has-overflow-fade'), true);
  endpoint.mouseenter();
  context.syncHubConnectionUi();
  assert.equal(endpoint.children[0], content, 'background settings updates keep the content wrapper');
  assert.equal(endpoint.classList.contains('is-hover-reading'), true, 'unchanged endpoint keeps the pending hover');
  assert.equal(h.timers.size, 1);
  endpoint.mouseleave();
  assert.equal(h.timers.size, 0);
  reduced = true;
  context.syncHubConnectionUi();
  h.frame(0);
  assert.equal(endpoint.hasAttribute('title'), false);
  assert.equal(endpoint.classList.contains('is-overflow-static'), true);
  state.settings.hubUrl = 'https://next.example/secret';
  context.syncHubConnectionUi();
  assert.equal(endpoint.children[0], content);
  assert.equal(endpoint.textContent, 'next.example');
  assert.equal(endpoint.hasAttribute('title'), false);
  state.settings.hubUrl = 'invalid credential text';
  context.syncHubConnectionUi();
  assert.equal(endpoint.textContent, 'Saved Hub URL');
  assert.equal(endpoint.hasAttribute('title'), false);
});

for (const className of ['detail-ex-title', 'detail-heading']) {
  for (const [midFlight, finalUpdate, earlyLeave] of [[false, false, false], [true, false, false], [true, true, false], [true, true, true]]) {
    test(`${className} reading catches the final detail update on leave (${midFlight ? `read in flight${finalUpdate ? ', final stats update' : ''}${earlyLeave ? ', early leave' : ''}` : 'read not started'})`, async () => {
      const h = harness(400);
      h.element.classList.add(className);
      h.element.closest = () => ({});
      const endpoint = h.node();
      endpoint.id = 'syncConnectionEndpoint';
      endpoint.closest = () => null;
      const document = {
        createElement: h.node,
        querySelectorAll: () => [h.element, endpoint],
        // This harness has one reading target and no tooltip or ancestor holds.
        // Evaluate the production selector against its actual event-driven classes.
        querySelector: selectors => selectors.split(',').some(selector => {
          const rule = selector.trim();
          return !/[ :]/.test(rule) && rule.startsWith('.')
            && rule.slice(1).split('.').every(name => h.element.classList.contains(name));
        }) ? h.element : null
      };
      const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
      const setup = app.slice(app.indexOf('const overflowText ='), app.indexOf('// Two clicks to remove from sync settings'));
      const hold = app.slice(app.indexOf('function sessionTooltipShouldHoldRender()'), app.indexOf('function flushPendingLimitDetailTooltipRender()'));
      const detail = app.slice(app.indexOf('function applySessionDetailResult('), app.indexOf('\nfunction toggleDetailSort'));
      const renders = [];
      let reads = 0;
      let finishRead;
      let defer = false;
      const state = { period: 'today', breakdown: 'session', stats: { periods: { today: {
        sessions: { 'claude:s': { totalTokens: 100, costUsd: 1 } }
      } } } };
      const context = vm.createContext({
        document, state, els: { syncConnectionEndpoint: endpoint },
        window: { ...h.window, TokenMonitorOverflowText: { create }, tokenMonitor: { getSessionDetail: async () => {
          reads += 1;
          if (defer) return new Promise(resolve => { finishRead = resolve; });
          return { found: true, marker: reads };
        } } },
        requestAnimationFrame: h.window.requestAnimationFrame,
        prefersReducedMotion: () => false, homeSessionRenderPending: false,
        visibleStatsSurface: () => 'main', isRendererWindowHidden: () => false,
        statsRenderScheduler: { request() {} }, renderSessionDetail: options => renders.push(options)
      });
      vm.runInContext(`${setup}\n${hold}\n${detail}`, context);
      context.bindHoverMarquee(h.element);
      await context.openSessionDetail({ client: 'claude', sessionId: 's', sessionCost: 1 });
      h.frame(0);
      state.stats.periods.today.sessions['claude:s'] = { totalTokens: 200, costUsd: 2 };
      let reading;
      if (midFlight) {
        defer = true;
        reading = context.refreshOpenSessionDetail();
      }
      h.hover();
      assert.equal(h.element.classList.contains('is-hover-reading'), true);
      assert.equal(context.sessionTooltipShouldHoldRender(), true, 'the real marquee class triggers the real hold selector');
      if (midFlight) {
        if (finalUpdate) {
          state.stats.periods.today.sessions['claude:s'] = { totalTokens: 300, costUsd: 3 };
          await context.refreshOpenSessionDetail();
          assert.equal(reads, 2, 'a final push during the held read must not start another read');
        }
        if (earlyLeave) {
          h.element.mouseleave();
          h.frame(100);
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(reads, 2, 'leave while busy must not start a concurrent read');
          assert.equal(state.openSession.detailLiveBusy, true);
          assert.equal(renders.at(-1).detail.marker, 1);
          defer = false;
        }
        finishRead({ found: true, marker: 2 });
        await reading;
        if (!earlyLeave) {
          assert.equal(state.openSession.detailRenderPending, true);
          assert.equal(state.openSession.liveSignature, JSON.stringify([200, 2, 0]));
        }
      } else {
        await context.refreshOpenSessionDetail();
        assert.equal(reads, 1, 'the held update has not started a read');
      }
      if (!earlyLeave) {
        assert.equal(renders.at(-1).detail.marker, 1);
        defer = false;
        h.element.mouseleave();
        h.frame(100);
      }
      await new Promise(resolve => setImmediate(resolve));
      const finalReads = finalUpdate ? 3 : 2;
      assert.equal(reads, finalReads, 'leave performs exactly the missing read, if any');
      assert.equal(renders.at(-1).detail.marker, finalReads, 'the final update paints without another stats push');
      assert.equal(state.openSession.liveSignature, JSON.stringify(finalUpdate ? [300, 3, 0] : [200, 2, 0]));
      assert.equal(state.openSession.sessionCost, finalUpdate ? 3 : 2);
      assert.deepEqual(renders.filter(render => render.detail).map(render => render.detail.marker), finalUpdate ? [1, 2, 3] : [1, 2]);
      assert.equal(renders.at(-1).preserveScroll, true);
      assert.equal(Boolean(state.openSession.detailRenderPending), false);
      h.element.mouseleave();
      h.frame(101);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, finalReads, 'idle leave does not read again');
    });
  }
}

test('small overflow moves smoothly in fractional pixels and finishes promptly', () => {
  const h = harness();
  h.hover();
  h.frame(16);
  const content = h.element.children[0];
  const offset = -Number(content.style.transform.match(/translate3d\(([^p]+)px/)[1]);
  assert.ok(offset > 0 && offset < 1, 'first frame moves less than one pixel without integer scroll steps');
  assert.equal(h.element.scrollLeft, 0, 'the viewport itself does not scroll');
  h.frame(240);
  assert.equal(content.style.transform, 'translate3d(-7px, 0, 0)');
  assert.equal(h.element.classList.contains('has-overflow-fade'), false);
  h.element.mouseleave();
  assert.equal(content.style.transform, 'translate3d(0px, 0, 0)');
  assert.equal(h.element.classList.contains('has-overflow-fade'), true);
});

for (const distance of [100, 1000, 3000]) {
  test(`${distance}px overflow scrolls at 100 px/s and finishes at its endpoint`, () => {
    const h = harness(distance);
    h.hover();
    h.frame(500);
    assert.equal(h.element.children[0].style.transform, 'translate3d(-50px, 0, 0)', 'speed is independent of text length');
    h.frame(distance * 10 - 1);
    assert.equal(h.frames.size, 1, 'the animation continues until the full distance is covered');
    h.frame(distance * 10);
    assert.equal(h.element.children[0].style.transform, `translate3d(-${distance}px, 0, 0)`, 'the full text arrives on time');
    assert.equal(h.frames.size, 0, 'the animation finishes without a perpetual repaint');
  });
}

test('mouseleave cancels an active long-preview animation', () => {
  const h = harness(3000);
  h.hover();
  h.frame(4000);
  assert.equal(h.element.children[0].style.transform, 'translate3d(-400px, 0, 0)');
  h.element.mouseleave();
  assert.equal(h.frames.size, 0);
  assert.equal(h.element.children[0].style.transform, 'translate3d(0px, 0, 0)');
  h.frame(30_000);
  assert.equal(h.element.children[0].style.transform, 'translate3d(0px, 0, 0)', 'cancelled motion cannot resume');
});

test('unchanged text preserves pending, active and completed hover motion', () => {
  const h = harness(100);
  const content = h.element.children[0];
  h.element.mouseenter();
  assert.equal(h.timers.size, 1, 'reading starts with a scheduled hover delay');
  const delayId = [...h.timers.keys()][0];
  h.api.setText(h.element, h.element.textContent);
  assert.equal(h.timers.size, 1, 'an unchanged title retains exactly one delay timer');
  assert.equal([...h.timers.keys()][0], delayId, 'an update during the hover delay keeps the original timer');
  h.element.mouseleave();
  h.hover();
  h.frame(500);
  const before = content.style.transform;
  h.api.setText(h.element, h.element.textContent);
  assert.equal(h.element.children[0], content);
  assert.equal(content.style.transform, before);
  h.frame(1000);
  assert.notEqual(content.style.transform, before, 'the same animation continues through a data refresh');
  h.frame(2200);
  h.api.setText(h.element, h.element.textContent);
  h.frame(2300);
  assert.equal(content.style.transform, 'translate3d(-100px, 0, 0)');
  h.api.setText(h.element, 'A renamed session');
  assert.equal(content.style.transform, 'translate3d(0px, 0, 0)');
  assert.equal(h.element.textContent, 'A renamed session');
  assert.equal(h.element.hasAttribute('title'), false);
  assert.equal(h.element.classList.contains('is-hover-reading'), false);
});

test('leaving before the delay cancels motion, and reduced motion keeps static overflow reading', () => {
  let reduced = false;
  let releases = 0;
  const h = harness(100, { prefersReducedMotion: () => reduced, onLeave: () => { releases++; } });
  h.element.mouseenter();
  h.element.mouseleave();
  assert.equal(h.timers.size, 0);
  h.frame(1000);
  assert.equal(h.element.children[0].style.transform, 'translate3d(0px, 0, 0)');
  assert.equal(releases, 1);
  reduced = true;
  h.element.mouseenter();
  h.element.mouseleave();
  assert.equal(h.timers.size, 0);
  assert.equal(releases, 1, 'reduced-motion hover exits do not notify a reading release');
  assert.equal(h.element.classList.contains('is-hover-reading'), false);
  assert.equal(h.element.hasAttribute('title'), false);
  assert.equal(h.element.classList.contains('is-overflow-static'), true);
});

test('fitting titles do not notify a reading release on ordinary hover exits', () => {
  let releases = 0;
  const h = harness(0, { onLeave: () => { releases++; } });
  h.element.mouseenter();
  h.element.mouseleave();
  assert.equal(h.timers.size, 0);
  assert.equal(releases, 0);
});

for (const phase of ['pending', 'active', 'completed']) {
  test(`card replacement preserves ${phase} reading motion through commitCard`, () => {
    let releases = 0;
    const h = harness(100, { onLeave: () => { releases++; } });
    h.element.dataset.overflowKey = 'codex:session-1';
    const pointer = { clientX: 50, clientY: 10 };
    if (phase === 'pending') h.element.mouseenter(pointer);
    else {
      h.hover(pointer);
      h.frame(phase === 'active' ? 500 : 2200);
    }
    const before = h.element.children[0].style.transform;
    const delayId = [...h.timers.keys()][0];
    const replacement = h.node();
    replacement.textContent = h.element.textContent;
    replacement.dataset.overflowKey = h.element.dataset.overflowKey;
    replacement.isConnected = false;
    h.api.bind(replacement);
    // A detached replacement has no text geometry until commitCard mounts it.
    const content = replacement.children[0];
    content.getBoundingClientRect = () => ({ width: replacement.isConnected ? 300 : 0 });
    const previousList = { scrollTop: 37, closest: () => null };
    const nextList = { scrollTop: 0, closest: () => null };
    function card(title, list) {
      return {
        dataset: { cellId: 'sessions', breakdownMode: 'session' },
        querySelector: () => list,
        querySelectorAll: selector => selector === '.scroll' ? [list] : selector === '.fade-overflow'
          || (selector === '.fade-overflow.is-hover-reading' && title.classList.contains('is-hover-reading'))
          ? [title] : []
      };
    }
    const previous = card(h.element, previousList);
    const next = card(replacement, nextList);
    const contentLayer = {
      firstElementChild: previous,
      querySelector: () => previous,
      replaceChildren(value) {
        assert.equal(value, next);
        this.firstElementChild = value;
        h.element.isConnected = false;
        replacement.isConnected = true;
        h.document.querySelectorAll = () => [replacement];
      }
    };
    const dock = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
    const start = dock.indexOf('function commitCard(');
    const end = dock.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, 'commitCard source boundaries exist');
    const context = {
      document: h.document,
      contentLayer, overflowText: h.api, CARD_SCROLL_SELECTOR: '.scroll',
      cardResetAnimator: { capture: () => null, animate() {} }
    };
    vm.runInNewContext(`${dock.slice(start, end)}\nglobalThis.commit = commitCard;`, context);
    context.commit(next, 'sessions');
    assert.equal(nextList.scrollTop, 37, 'reading handoff preserves card scroll position');
    assert.equal(content.style.transform, before);
    assert.equal(replacement.classList.contains('is-hover-reading'), true);
    h.element.mouseleave();
    replacement.mouseenter(pointer);
    assert.equal(releases, 0, 'old-node leave does not interrupt the replacement');
    if (phase === 'pending') {
      assert.equal(h.timers.size, 1);
      assert.equal([...h.timers.keys()][0], delayId, 'the original delay continues');
      const timer = h.timers.get(delayId);
      h.timers.delete(delayId);
      timer.callback();
      h.frame(500);
      assert.notEqual(content.style.transform, before);
    } else {
      assert.equal(h.timers.size, 0, 'mouseenter on a replacement does not restart reading');
      h.frame(1000);
      if (phase === 'active') assert.notEqual(content.style.transform, before);
      else assert.equal(content.style.transform, before, 'completed reading remains at the end');
    }
    replacement.mouseleave();
    assert.equal(releases, 1);
    assert.equal(content.style.transform, 'translate3d(0px, 0, 0)');
  });
}

test('reading handoff ignores renamed, different and moved session titles', () => {
  for (const change of ['title', 'key', 'position', 'missing']) {
    const h = harness(100);
    h.element.dataset.overflowKey = 'codex:session-1';
    if (change === 'position') h.hover({ clientX: 50, clientY: 10 });
    else h.hover();
    h.frame(500);
    const replacement = h.node();
    replacement.textContent = change === 'title' ? 'Renamed session' : h.element.textContent;
    replacement.dataset.overflowKey = change === 'key' ? 'codex:session-2' : h.element.dataset.overflowKey;
    h.api.bind(replacement);
    replacement.getBoundingClientRect = () => ({ left: 0, right: 200, top: 40, bottom: 60, width: 200 });
    h.api.preserveReading({ querySelectorAll: () => [h.element] }, {
      querySelectorAll: () => change === 'missing' ? [] : [replacement]
    });
    assert.equal(replacement.classList.contains('is-hover-reading'), false);
    assert.equal(replacement.children[0].style.transform, 'translate3d(0px, 0, 0)');
    assert.equal(h.element.classList.contains('is-hover-reading'), false, 'failed handoff stops the old motion immediately');
    h.element.isConnected = false;
    h.frame(1000);
    assert.equal(h.element.classList.contains('is-hover-reading'), false);
  }
});

for (const phase of ['pending', 'active', 'completed']) {
  for (const width of [180, 240, 320]) {
    test(`${phase} reading reaches the new endpoint after replacement width changes to ${width}px`, () => {
      const h = harness(100);
      const pointer = { clientX: 50, clientY: 10 };
      h.element.dataset.overflowKey = 'codex:session-1';
      if (phase === 'pending') h.element.mouseenter(pointer);
      else {
        h.hover(pointer);
        h.frame(phase === 'active' ? 500 : 2200);
      }
      const before = h.element.children[0].style.transform;
      const replacement = h.node();
      replacement.clientWidth = width;
      replacement.dataset.overflowKey = h.element.dataset.overflowKey;
      replacement.textContent = h.element.textContent;
      h.api.bind(replacement);
      h.api.preserveReading({ querySelectorAll: () => [h.element] }, { querySelectorAll: () => [replacement] });
      h.element.isConnected = false;
      h.document.querySelectorAll = () => [replacement];
      if (width === 180) assert.equal(replacement.children[0].style.transform, before, 'narrowing continues from the existing offset');
      if (phase === 'pending') {
        const [id, timer] = [...h.timers][0];
        h.timers.delete(id);
        timer.callback();
      }
      h.frame(10_000);
      assert.equal(replacement.children[0].style.transform, `translate3d(${-Math.max(0, 300 - width)}px, 0, 0)`);
      assert.equal(replacement.classList.contains('has-overflow-fade'), false, 'the complete tail is visible at the new endpoint');
      assert.equal(h.frames.size, 0, 'the animation finishes without a perpetual repaint');
    });
  }
}

test('static overflow reading follows reduced motion without native tooltips', () => {
  let reduced = false;
  const h = harness(100, { prefersReducedMotion: () => reduced });
  assert.equal(h.element.hasAttribute('title'), false);
  h.api.setText(h.element, 'Renamed title');
  assert.equal(h.element.hasAttribute('title'), false);
  reduced = true;
  h.api.refresh();
  h.frame(0);
  assert.equal(h.element.hasAttribute('title'), false);
  assert.equal(h.element.classList.contains('is-overflow-static'), true);
  h.api.setText(h.element, 'Another title');
  assert.equal(h.element.textContent, 'Another title');
  assert.equal(h.element.hasAttribute('title'), false);
  const reducedTitle = h.node();
  reducedTitle.textContent = 'Bound with reduced motion';
  h.api.bind(reducedTitle);
  assert.equal(reducedTitle.hasAttribute('title'), false);
  assert.equal(reducedTitle.classList.contains('is-overflow-static'), true);
  reduced = false;
  h.api.setText(h.element, h.element.textContent);
  h.frame(0);
  assert.equal(h.element.hasAttribute('title'), false, 'unchanged text also observes the latest preference');
  assert.equal(h.element.classList.contains('is-overflow-static'), false);
  const fitting = harness(0);
  assert.equal(fitting.element.hasAttribute('title'), false, 'fitting text has no tooltip in normal mode');
});

test('manual reduced-motion scrolling exposes the tail and updates its fade without animation', () => {
  const h = harness(100, { prefersReducedMotion: () => true });
  const text = h.element.textContent;
  assert.equal(h.element.classList.contains('has-overflow-fade'), true);
  h.element.scrollLeft = 100;
  h.element.scroll();
  assert.equal(h.element.classList.contains('has-overflow-fade'), false);
  assert.equal(h.element.textContent, text);
  assert.equal(h.element.children[0].style.transform, 'translate3d(0px, 0, 0)');
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.element.hasAttribute('title'), false);
});

test('failed handoff cancels a pending delay immediately', () => {
  const h = harness(100);
  h.element.dataset.overflowKey = 'codex:session-1';
  h.element.mouseenter();
  assert.equal(h.timers.size, 1);
  h.api.preserveReading({ querySelectorAll: () => [h.element] }, { querySelectorAll: () => [] });
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.element.classList.contains('is-hover-reading'), false);
});

test('resizing clamps the offset and detaching a hovered title stops its animation', () => {
  const h = harness(100);
  h.hover();
  h.frame(1000);
  h.element.clientWidth = 280;
  h.api.update(h.element);
  assert.equal(h.element.children[0].style.transform, 'translate3d(-20px, 0, 0)');
  h.element.clientWidth = 320;
  h.api.update(h.element);
  assert.equal(h.element.children[0].style.transform, 'translate3d(0px, 0, 0)');
  assert.equal(h.element.classList.contains('has-overflow-fade'), false);
  h.element.isConnected = false;
  h.frame(1100);
  assert.equal(h.frames.size, 0);
  assert.equal(h.element.classList.contains('is-hover-reading'), false);
});

test('updateRow keeps IDs for untitled sessions and moves them into Details for titled sessions', () => {
  const h = harness();
  const row = h.node();
  const selectors = new Map();
  row.querySelector = selector => {
    if (!selectors.has(selector)) selectors.set(selector, h.node());
    return selectors.get(selector);
  };
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function updateRow(');
  const end = app.indexOf('function applyHomeListMark(');
  let interactive;
  const context = {
    state: { breakdown: 'session' }, rowWidth: () => 50,
    iconKindFor: () => ({ kind: 'dot' }),
    setHoverMarqueeText: h.api.setText, formatNumber: String, formatCost: String,
    rowNumberAnimations: new Map(), cancelRowNumberAnimation() {},
    updateRowContext() {}, updateRowLive() {}, applyBarScale() {},
    sessionRowsApi: { ...require('../../src/electron/renderer/sessionRows'), applyBreakdownRowSemantics(_row, _head, options) { interactive = options.interactive; } },
    t: key => key
  };
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.update = updateRow;`, context);
  for (const [client, sessionDetailAvailable, expectedInteractive] of [
    ['claude', undefined, true], ['codex', undefined, true],
    ['opencode', undefined, true], ['dsh', undefined, true],
    ['cursor', undefined, false], ['copilot', undefined, false], ['zed', undefined, false],
    ['reasonix', false, false], ['reasonix', true, true], ['reasonix', false, false]
  ]) {
    for (const titled of [true, false, true]) {
      context.update(row, { name: titled ? 'Named session' : 'Tool · Model',
        subtitle: titled ? 'Tool · Model' : '12:00 · 2 calls',
        activity: titled ? '12:00 · 2 calls' : undefined,
        detail: 'session-id', kind: 'session', client, sessionDetailAvailable, value: 100 });
      const detail = row.querySelector('.row-detail');
      assert.equal(interactive, expectedInteractive, client);
      const hidden = expectedInteractive && titled;
      assert.equal(detail.textContent, hidden ? '' : 'session-id', client);
      assert.equal(detail.classList.contains('hidden'), hidden, client);
    }
  }
  const { sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');
  const { withoutSessionTitles } = require('../../src/electron/sessionTitleDisplay');
  const sessionId = '019e76fc-dddd-eeee-ffff-222222222222';
  const original = { client: 'codex', sessionId, title: 'Named session', totalTokens: 42,
    models: { 'gpt-5': 42 }, messageCount: 2, lastUsedAt: new Date(2026, 9, 2, 12, 0).toISOString() };
  const visibleLines = () => ['row-title', 'row-subtitle', 'row-activity', 'row-detail']
    .map((name) => row.querySelector(`.${name}`))
    .filter((element) => !element.classList.contains('hidden') && element.textContent)
    .map((element) => element.textContent);
  for (const enabled of [true, false, true]) {
    const sessions = enabled ? { s: original } : withoutSessionTitles({ s: original });
    const [data] = sessionRowsForPeriod({ sessions }, {
      clientLabels: { codex: 'Codex' }, now: new Date(2026, 9, 2, 12, 1)
    });
    context.update(row, data);
    assert.deepEqual(visibleLines(), enabled
      ? ['Named session', 'Codex · gpt-5', '12:00 · 2 calls']
      : ['Codex · gpt-5', '12:00 · 2 calls', sessionId]);
    assert.equal(interactive, true, 'title mode changes preserve detail navigation');
  }
  context.update(row, { name: 'Reviews', detail: '3 runs', kind: 'summary', sessionGroup: 'codex-auto-review', value: 100 });
  assert.equal(interactive, true);
  assert.equal(row.querySelector('.row-detail').textContent, '3 runs');
  assert.equal(row.querySelector('.row-detail').classList.contains('hidden'), false);
});

test('a token and cost update through updateRow keeps the hovered title moving', () => {
  const h = harness(100);
  const selectors = new Map();
  const row = h.node();
  selectors.set('.row-title', h.element);
  row.querySelector = selector => {
    if (!selectors.has(selector)) selectors.set(selector, h.node());
    return selectors.get(selector);
  };
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function updateRow(');
  const end = app.indexOf('function applyHomeListMark(');
  assert.ok(start >= 0 && end > start, 'updateRow source boundaries exist in the expected order');
  const body = app.slice(start, end);
  const context = {
    state: { breakdown: 'session' }, rowWidth: () => 50,
    iconKindFor: () => ({ kind: 'dot' }),
    setHoverMarqueeText: h.api.setText, formatNumber: String, formatCost: String,
    rowNumberAnimations: new Map(), cancelRowNumberAnimation() {},
    updateRowContext() {}, updateRowLive() {}, applyBarScale() {},
    sessionRowsApi: { ...require('../../src/electron/renderer/sessionRows'), applyBreakdownRowSemantics() {} }, t: key => key
  };
  vm.runInNewContext(`${body}\nglobalThis.update = updateRow;`, context);
  const data = { name: h.element.textContent, detail: 'session-id', kind: 'session', client: 'codex', value: 100, cost: 1 };
  context.update(row, data);
  h.frame(0);
  h.hover();
  h.frame(500);
  const content = h.element.children[0];
  const before = content.style.transform;
  context.update(row, { ...data, value: 200, cost: 2 });
  assert.equal(row.querySelector('.row-value').textContent, '200');
  assert.equal(row.querySelector('.row-cost').textContent, '2');
  assert.equal(content.style.transform, before);
  h.frame(1000);
  assert.notEqual(content.style.transform, before);
});


test('actual shared row rendering keeps group availability and binds Auto Review model labels with trailing time', t => {
  // Row construction and the adapter's default date formatter share one local day.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 11, 12, 0).getTime() });
  const h = harness(0);
  const rowsApi = require('../../src/electron/renderer/sessionRows');
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const makeNode = () => {
    const node = h.node();
    node.querySelector = selector => {
      const name = selector.slice(1);
      const find = children => {
        for (const child of children || []) {
          if (child.classList?.contains(name) || String(child.className || '').split(' ').includes(name)) return child;
          const nested = find(child.children); if (nested) return nested;
        }
        return null;
      };
      return find(node.children);
    };
    return node;
  };
  const makeRow = () => {
    const row = makeNode(); const nodes = new Map();
    row.querySelector = selector => { if (!nodes.has(selector)) nodes.set(selector, makeNode()); return nodes.get(selector); };
    return row;
  };
  const bindings = [];
  const context = {
    state: { breakdown: 'session' }, rowWidth: () => 50, iconKindFor: () => ({ kind: 'dot' }),
    setHoverMarqueeText: h.api.setText, overflowText: h.api, formatNumber: String, formatCost: String,
    rowNumberAnimations: new Map(),
    updateRowContext() {}, updateRowLive() {}, applyBarScale() {}, cancelRowNumberAnimation() {},
    document: { createElement: makeNode, createTextNode: text => ({ textContent: text }) },
    limitWindowsView: { setDetailTooltip(node, entries) {
      node.classList.toggle('limit-detail-tooltip-wrap', Boolean(entries));
      if (entries) bindings.push({ node, entries });
    } },
    sessionRowsApi: { ...rowsApi, applyBreakdownRowSemantics() {} }, t: key => key,
    rowTemplate: makeRow, openSessionDetail() {}
  };
  const update = app.slice(app.indexOf('function updateRow('), app.indexOf('function applyHomeListMark('));
  const member = app.slice(app.indexOf('function sessionGroupRunNode('), app.indexOf('function renderSessionGroupDetail('));
  vm.runInNewContext(`${update}\n${member}\nglobalThis.update = updateRow; globalThis.member = sessionGroupRunNode;`, context);
  const now = new Date();
  const accounting = { client: 'codex', sessionId: 'old', t3ThreadId: 'main', totalTokens: 500, costUsd: 2,
    models: { a: 500 }, lastUsedAt: new Date(2026, 9, 11, 8, 0).toISOString() };
  const native = { client: 'claude', sessionId: 'new', t3ThreadId: 'main', tokenDataUnavailable: true,
    totalTokens: 0, lastUsedAt: now.toISOString(), native: true };
  const [group] = rowsApi.groupSessionRows(rowsApi.sessionRowsForPeriod({ sessions: { old: accounting } }, {
    now, nativeSessions: { new: native }, clientLabels: { codex: 'Codex', claude: 'Claude Code' }
  }));
  const row = makeRow(); context.update(row, group);
  assert.equal(group.tokenDataUnavailable, false);
  assert.equal(row.querySelector('.row-value').textContent, '500');
  assert.equal(row.querySelector('.row-cost').textContent, '2');
  assert.equal(row.dataset.tokenDataUnavailable, undefined);
  const [unavailable] = rowsApi.groupSessionRows(rowsApi.sessionRowsForPeriod({ sessions: {} }, {
    now, nativeSessions: { new: native, other: { ...native, sessionId: 'other' } }
  }));
  context.update(row, unavailable);
  assert.equal(row.dataset.tokenDataUnavailable, 'true');
  assert.equal(row.querySelector('.row-cost').textContent, '');
  for (const titled of [true, false]) {
    const [review] = rowsApi.sessionRowsForPeriod({ sessions: { review: { ...accounting,
      sessionId: 'review', sessionKind: 'background-review', title: titled ? 'Review' : '', models: { a: 300, b: 200 }
    } } }, { now, clientLabels: { codex: 'Codex' } });
    bindings.length = 0;
    const rendered = context.member(review, 500, { summary: { sessionGroup: 'codex-auto-review' } });
    assert.equal(bindings.length, 1, 'adapter plus updateRow binds one tooltip');
    assert.equal(bindings[0].node.textContent, '2 models');
    assert.deepEqual(bindings[0].entries, review.modelTooltipEntries);
    assert.equal(rendered.querySelector('.row-title').textContent, '2 models · 08:00');
    assert.equal(rendered.classList.contains('session-group-run'), true, 'existing tooltip repaint guard includes the target');
  }
});
