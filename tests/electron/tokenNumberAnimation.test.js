'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const animationApi = require('../../src/electron/tokenNumberAnimation');
const { MESSAGES } = require('../../src/electron/renderer/i18n');

function element() {
  const attributes = new Map();
  const el = {
    children: [], animations: [], dataset: {}, _text: '',
    style: { setProperty(name, value) { this[name] = value; } },
    ownerDocument: { createElement: element, timeline: { currentTime: 0 },
      defaultView: { getComputedStyle: (node) => ({ fontSize: `${node.fontSize()}px`, lineHeight: `${node.fontSize()}px`, opacity: '1', filter: 'blur(0px)', ...node.visualStyle }) } },
    fontSize() { return parseFloat(this.style.fontSize) || this.parentElement?.fontSize() || 20; },
    width() {
      if (this.className === 'token-number-reading') return 0;
      if (this.className?.includes('outgoing-place') || this.className?.includes('previous')) return 0;
      const scale = this.fontSize() / 20;
      return Array.from(this._text, (char) => char === ',' ? 4 * scale : 10 * scale).reduce((a, b) => a + b, 0)
        + this.children.reduce((sum, child) => sum + child.width(), 0);
    },
    // The mask room is padding cancelled by margin: it widens the box
    // without moving the content.
    overhang(side) { return parseFloat(this.style[`--token-number-overhang-${side}`]) || 0; },
    getBoundingClientRect() {
      if (this.visualRect) return this.visualRect;
      const width = this.width();
      let left = this.parentElement ? this.parentElement.getBoundingClientRect().left
        + this.parentElement.overhang('left') : 100;
      if (this.parentElement) {
        for (const sibling of this.parentElement.children) {
          if (sibling === this) break;
          if (sibling.className !== 'token-number-reading') left += sibling.width();
        }
      } else if (this.rightAligned) left = 300 - width;
      return { left: left - this.overhang('left'), top: 0,
        width: width + this.overhang('left') + this.overhang('right'), height: this.fontSize() };
    },
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); },
    set textContent(value) { this.children = []; this._text = value; },
    setAttribute(key, value) { attributes.set(key, value); },
    getAttribute(key) { return attributes.get(key) ?? null; },
    removeAttribute(key) { attributes.delete(key); },
    append(child) { child.parentElement = this; this.children.push(child); },
    replaceChildren(...children) { this._text = ''; this.children = []; for (const child of children) this.append(child); },
    animate(frames, options) {
      const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };
      this.animations.push(animation);
      return animation;
    }
  };
  return el;
}

function harness(style = 'roll') {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('function easeOutQuart(');
  const end = source.indexOf('const rowNumberAnimations', start);
  const frames = new Map();
  let handle = 0;
  let now = 0;
  const compactValues = [];
  const context = {
    tokenNumberAnimationApi: animationApi,
    state: { settings: { tokenNumberAnimation: style } },
    performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++handle, callback); return handle; },
    cancelAnimationFrame(id) { frames.delete(id); },
    prefersReducedMotion: () => false,
    formatNumber: (value) => Math.round(value).toLocaleString('en-US'),
    updateTotalCompact: (value) => compactValues.push(value)
  };
  const rowStart = source.indexOf('function animateRowNumber(');
  const rowEnd = source.indexOf('function animateBreakdownFrom(', rowStart);
  const settleStart = source.indexOf('function settleRowNumberAnimations(');
  const settleEnd = source.indexOf('function applyReduceMotionPreference(', settleStart);
  vm.runInNewContext(`${source.slice(start, end)}
  const rowNumberAnimations = new Map();
  ${source.slice(rowStart, rowEnd)}
  ${source.slice(settleStart, settleEnd)}
  this.api = {
    animateTotalNumber, cancelNumberAnimation, headlineNumberIsAnimatingTo,
    animateRowNumber, cancelRowNumberAnimation, settleRowNumberAnimations,
    rowMotion: (el) => rowNumberAnimations.get(el),
    value: () => numberAnimValue
  };`, context);
  return {
    context, api: context.api, compactValues,
    tick(time) {
      now = time;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(now);
    }
  };
}

test('missing or unknown animation preferences use digit roll and preserve an explicit counter choice', () => {
  for (const value of [undefined, null, '', 'roll', 'future', {}]) assert.equal(animationApi.normalize(value), 'roll');
  assert.equal(animationApi.normalize('count'), 'count');
});

test('digit roll keeps unchanged places still and exposes only the target to accessibility', () => {
  const el = element();
  const settle = animationApi.beginRoll(el, '1,234', '1,235', true);
  const places = el.children[1].children.filter((child) => child.className === 'token-number-place');
  assert.equal(el.children[0].textContent, '1,235');
  assert.equal(el.children[1].getAttribute('aria-hidden'), 'true');
  assert.deepEqual(places.slice(0, 4).map((place) => place.children.length), [1, 1, 1, 1]);
  const changed = [places[4].children[0], el.children[1].children.find((child) => child.className.includes('previous'))];
  assert.equal(changed[0].textContent, '5');
  assert.equal(changed[1].textContent, '4');
  assert.equal(changed[0].animations[0].options.duration, 650);
  assert.equal(changed[0].animations[0].frames[0].transform, 'translate(0px, 0px) translateY(0.4275em) scale(0.3984375)');
  settle();
  assert.equal(el.textContent, '1,235');
  assert.equal(el.getAttribute('aria-label'), null);
  assert.ok(changed.every((glyph) => glyph.animations[0].cancelled));
  el.textContent = 'new reading';
  settle();
  assert.equal(el.textContent, 'new reading', 'stale cleanup cannot overwrite a newer reading');
});

test('digit roll preserves leading digit identity and rolls separators with the digits', () => {
  for (const [from, to, increasing] of [['999', '1,000', true], ['1,000', '999', false], ['9', '0', false]]) {
    const el = element();
    const settle = animationApi.beginRoll(el, from, to, increasing);
    const places = el.children[1].children.filter((child) => child.className === 'token-number-place');
    assert.equal(places.map((place) => place.children[0].textContent).join(''), to);
    const incoming = places.flatMap((place) => place.children.slice(0, 1)).find((glyph) => glyph.animations.length);
    assert.equal(incoming.animations[0].frames[0].transform, increasing ? 'translate(0px, 0px) translateY(0.4275em) scale(0.3984375)' : 'translate(0px, 0px) translateY(-0.4275em) scale(0.3984375)');
    const separators = places.filter((place) => place.children[0].textContent === ',');
    for (const separator of separators) assert.equal(separator.children[0].animations[0].frames[0].transform, increasing ? 'translate(0px, 0px) translateY(0.4275em) scale(1)' : 'translate(0px, 0px) translateY(-0.4275em) scale(1)');
    const outgoing = el.children[1].children.filter((child) => child.className.includes('previous'));
    assert.ok(outgoing.every((glyph) => from.includes(glyph.textContent)));
    settle();
    assert.equal(el.textContent, to);
  }
});

test('regrouping replaces equal digits at different character positions instead of carrying them sideways', () => {
  for (const [from, to, increasing] of [['1,234', '12,340', true], ['12,340', '1,234', false]]) {
    const el = element();
    const settle = animationApi.beginRoll(el, from, to, increasing);
    const places = el.children[1].children.filter((child) => child.className === 'token-number-place');
    assert.equal(places[0].children[0].animations.length, 0, 'the unchanged leading 1 stays sharp');
    const movedTwo = places.find((place) => place.children[0].textContent === '2');
    assert.equal(movedTwo.children[0].animations.length, 1, 'the same 2 at another position is replaced');
    assert.equal(movedTwo.animations.length, 0, 'no sideways carry from its previous position');
    assert.equal(movedTwo.children[0].animations[0].frames[0].opacity, 0);
    assert.equal(movedTwo.children[0].animations[0].frames[0].transform, `translate(0px, 0px) translateY(${increasing ? '' : '-'}0.4275em) scale(0.3984375)`);
    const oldTwo = el.children[1].children.find((child) => child.className.includes('previous') && child.textContent === '2');
    assert.ok(oldTwo, 'the previous 2 leaves independently');
    settle();
    assert.equal(el.textContent, to);
  }
});

test('equal digits after the first changed character roll as part of the changed suffix', () => {
  const el = element();
  const settle = animationApi.beginRoll(el, '12,345', '54,321', true);
  const places = el.children[1].children.filter((child) => child.className === 'token-number-place');
  for (const index of [0, 1, 3, 4, 5]) assert.equal(places[index].children[0].animations.length, 1);
  assert.equal(places[3].children[0].animations[0].frames[0].opacity, 0, 'the middle 3 is replaced despite being equal');
  assert.equal(places[2].children[0].animations[0].frames[0].transform, 'translate(0px, 0px) translateY(0.4275em) scale(1)', 'the comma rolls without shrinking');
  settle();
});

test('a trailing unit stays sharp and follows the layout while the digits before it roll', () => {
  for (const [from, to] of [['191.8M', '223.4M'], ['99%', '100%']]) {
    const el = element();
    const settle = animationApi.beginRoll(el, from, to, true);
    const wrapper = el.children[1];
    const places = wrapper.children.filter((child) => child.className === 'token-number-place');
    const unitPlace = places.at(-1);
    assert.equal(unitPlace.children[0].animations.length, 0, `${from} → ${to}: the unit does not roll`);
    assert.ok(!wrapper.children.some((child) => child.className.includes('previous') && child.textContent === to.at(-1)),
      `${from} → ${to}: no outgoing copy of the unit`);
    const shift = (to.length - from.length) * 10;
    if (shift) assert.equal(unitPlace.animations[0].frames[0].transform, `translate(${-shift}px, 0px) scale(1)`);
    else assert.equal(unitPlace.animations.length, 0);
    assert.ok(places.slice(0, -1).some((place) => place.children[0].animations.length), 'the digits still roll');
    settle();
    assert.equal(el.textContent, to);
  }
});

test('shrinking places have their final layout before cleanup instead of leaving a leading gap', () => {
  for (const rightAligned of [false, true]) {
    const el = element();
    el.rightAligned = rightAligned;
    const settle = animationApi.beginRoll(el, '38,225,113,098', '533,940,381', false);
    const wrapper = el.children[1];
    const outgoing = wrapper.children.filter((child) => child.className.includes('previous'));
    const firstSurvivor = wrapper.children[0];
    const before = firstSurvivor.getBoundingClientRect().left;
    assert.equal(wrapper.width(), 98, 'removed digits no longer participate in layout');
    assert.ok(outgoing.every((glyph) => glyph.width() === 0));
    assert.equal(firstSurvivor.animations.length, 0, 'a changing place lands in its destination without sliding');
    settle();
    assert.equal(el.width(), 98);
    assert.equal(el.getBoundingClientRect().left, before, 'the first destination glyph stays put on cleanup');
  }
});

test('a kept prefix follows a trailing-aligned layout while changed places stay put', () => {
  const el = element();
  el.rightAligned = true;
  const settle = animationApi.beginRoll(el, '12,345,678', '12,999', false);
  const places = el.children[1].children.filter((child) => child.className === 'token-number-place');
  for (const place of places.slice(0, 3)) {
    assert.equal(place.animations[0].frames[0].transform, 'translate(-34px, 0px) scale(1)');
    assert.equal(place.animations[0].options.duration, animationApi.layoutDuration);
    assert.equal(place.children[0].animations.length, 0, 'kept glyphs stay sharp');
  }
  assert.ok(places.slice(3).every((place) => place.animations.length === 0));
  settle();
});

test('a fitted destination scales from the old font and uses one animation timeline', () => {
  const el = element();
  el.style.fontSize = '15px';
  const settle = animationApi.beginRoll(el, '1,234', '1,299', true, () => { el.style.fontSize = '20px'; });
  const wrapper = el.children[1];
  const places = wrapper.children.filter((child) => child.className === 'token-number-place');
  assert.equal(el.style.fontSize, '20px');
  for (const place of places.slice(0, 3)) {
    assert.match(place.animations[0].frames[0].transform, /scale\(0.75\)$/);
    assert.equal(place.animations[0].frames[1].transform, 'translate(0px, 0px) scale(1)');
  }
  assert.ok(places.slice(3).every((place) => place.animations.length === 0), 'changed places do not grow from the old font');
  assert.ok(wrapper.children.filter((child) => child.className.includes('previous')).every((glyph) => glyph.style.fontSize === '15px'));
  for (const node of wrapper.children) {
    for (const target of [node, ...node.children]) {
      for (const animation of target.animations) assert.equal(animation.startTime, 0);
    }
  }
  settle();
  assert.equal(el.style.fontSize, '20px', 'cleanup does not perform a late font resize');
});

test('a period that adds digits draws each reading at its own size without horizontal travel', () => {
  const el = element();
  const settle = animationApi.beginRoll(el, '999', '1,000', true, () => { el.style.fontSize = '15px'; });
  const wrapper = el.children[1];
  const places = wrapper.children.filter((child) => child.className === 'token-number-place');
  assert.ok(places.every((place) => place.animations.length === 0));
  const outgoing = wrapper.children.filter((child) => child.className.includes('previous'));
  assert.deepEqual(outgoing.map((glyph) => glyph.style.fontSize), ['20px', '20px', '20px']);
  for (const glyph of [...outgoing, ...places.map((place) => place.children[0])]) {
    assert.equal(glyph.animations.length, 1, 'only the roll animates each glyph');
    assert.ok(glyph.animations[0].frames.every((frame) => frame.transform.startsWith('translate(0px, 0px) translateY(')));
  }
  settle();
  assert.equal(el.textContent, '1,000');
});

test('incoming digits keep a small final movement after becoming legible', () => {
  const el = element();
  const settle = animationApi.beginRoll(el, '123', '124', true);
  const glyph = el.children[1].children[2].children[0];
  const frames = glyph.animations[0].frames;
  assert.equal(glyph.animations[0].options.delay, 0, 'a live increment does not wait for unchanged leading digits');
  const crossing = frames.find((frame) => frame.opacity > 0.98 && /translateY\((-[\d.]+)em\)/.test(frame.transform));
  assert.ok(crossing, 'legible digit crosses its baseline before returning to rest');
  assert.equal(frames.at(-1).transform, 'translate(0px, 0px) translateY(0em) scale(1)');
  assert.equal(frames.at(-1).opacity, 1);
  assert.ok(frames.every((frame) => frame.opacity >= 0 && frame.opacity <= 1));
  settle();
});

test('sparse envelopes stay close to the original spring, crossfade and blur at intermediate times', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/tokenNumberAnimation.js'), 'utf8');
  const context = { module: { exports: {} } };
  vm.runInNewContext(source.replace('return { normalize, beginRoll, beginCount, currentCountValue, capture, duration, layoutDuration };',
    'return { glyphFrames };'), context);
  const spring = (seconds, damping, period) => {
    const frequency = 2 * Math.PI / period;
    if (damping === 1) return 1 - (1 + frequency * seconds) * Math.exp(-frequency * seconds);
    const damped = frequency * Math.sqrt(1 - damping ** 2);
    return 1 - Math.exp(-damping * frequency * seconds)
      * (Math.cos(damped * seconds) + damping * frequency / damped * Math.sin(damped * seconds));
  };
  const values = frame => [
    ...frame.transform.match(/translateY\(([^)]+)em\) scale\(([^)]+)\)/).slice(1).map(Number),
    frame.opacity,
    ...['px', 'em'].map(unit => Array.from(frame.filter.matchAll(/blur\(([\d.]+)(px|em)\)/g))
      .filter(match => match[2] === unit).reduce((sum, match) => sum + Number(match[1]), 0))
  ];
  for (const age of [0, 0.05, 0.1, 0.2, 0.4, 0.6, 0.649]) {
    for (const outgoing of [false, true]) {
      if (!outgoing && age) continue;
      const frames = context.module.exports.glyphFrames({ age, outgoing, numeric: true, direction: 1,
        ink: 0.72, opacity: 0.7, filter: 'blur(2px)' });
      assert.ok(frames.length < 49);
      assert.equal(frames[0].offset, 0);
      assert.equal(frames.at(-1).offset, 1);
      const body0 = spring(age, 1, 0.278);
      const position0 = spring(age, 0.55, 0.353);
      const smear0 = Math.min(0.999999, spring(age, 1, 0.22));
      // Compare to each knot of the previously shipped 49-point envelope.
      // Both curves are linear between retained knots, so these include the
      // maximum differences, including the short departure's first blur knot.
      for (let index = 0; index <= 48; index++) {
        const offset = index / 48;
        const seconds = age + offset * (0.65 - age);
        const position = index === 48 ? 1 : spring(seconds, 0.55, 0.353);
        const body = index === 48 ? 1 : spring(seconds, 1, 0.278);
        const blur = index === 48 ? 1 : Math.min(1, spring(seconds, 0.91, 0.398));
        const smear = index === 48 ? 1 : spring(seconds, 1, 0.22);
        const progress = index === 0 ? 0 : Math.max(0, Math.min(1, (smear - smear0) / (1 - smear0)));
        const expected = outgoing ? [-0.4275 * (position - position0),
          (1 - 0.6015625 * body) / (1 - 0.6015625 * body0), 0.7 * (1 - body) / (1 - body0),
          2 * (1 - progress), 0.1152 * progress]
          : [0.4275 * (1 - position), 0.3984375 + 0.6015625 * body, body, 0, 0.1152 * (1 - blur)];
        const end = frames.findIndex(frame => frame.offset >= offset);
        const left = frames[Math.max(0, end - 1)];
        const right = frames[end];
        const fraction = left === right ? 0 : (offset - left.offset) / (right.offset - left.offset);
        const before = values(left);
        const after = values(right);
        for (let channel = 0; channel < expected.length; channel++) {
          const error = Math.abs(before[channel] + fraction * (after[channel] - before[channel]) - expected[channel]);
          assert.ok(error <= [0.00086, 0.00121, 0.002, 0.00401, 0.000231][channel],
            `age ${age}, knot ${index}, channel ${channel}: ${error}`);
        }
      }
    }
  }
});

test('period bars use the layout duration while count mode retains its existing timing', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('function periodBreakdownMotionDuration(');
  const end = source.indexOf('\nfunction animateBarBetween(', start);
  const context = { tokenNumberAnimationApi: animationApi, state: { settings: { tokenNumberAnimation: 'roll' } } };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.periodBreakdownMotionDuration(), 250);
  context.state.settings.tokenNumberAnimation = 'count';
  assert.equal(context.periodBreakdownMotionDuration(), 800);
});

test('retargeting preserves visible incoming and outgoing glyphs with no target flash', () => {
  const el = element();
  const settleOld = animationApi.beginRoll(el, '1', '2', true);
  const incoming = el.children[1].children[0].children[0];
  const outgoing = el.children[1].children.find((child) => child.className.includes('previous'));
  incoming.visualStyle = { opacity: '0.3', filter: 'blur(1px)' };
  outgoing.visualStyle = { opacity: '0.7', filter: 'blur(0.5px)' };
  incoming.visualRect = { left: 100, top: 8, width: 10, height: 20 };
  outgoing.visualRect = { left: 100, top: -4, width: 10, height: 20 };
  const snapshot = animationApi.capture(el);
  assert.deepEqual(snapshot.map(({ char, opacity }) => [char, opacity]), [['2', 0.3], ['1', 0.7]]);
  settleOld();
  const settleNew = animationApi.beginRoll(el, '2', '3', true, null, snapshot);
  const ghosts = el.children[1].children.filter((child) => child.className.includes('previous'));
  assert.equal(ghosts.length, 2, 'both visible layers survive interruption');
  assert.deepEqual(ghosts.map((glyph) => glyph.animations[0].frames[0].opacity), [0.3, 0.7]);
  assert.deepEqual(ghosts.map((glyph) => glyph.style.top), ['8px', '-4px']);
  assert.ok(ghosts.every((glyph) => glyph.animations[0].options.delay === 0));
  settleOld();
  assert.equal(el.children[0].textContent, '3', 'obsolete cleanup does not touch the new transition');
  settleNew();
  assert.equal(el.textContent, '3');
  assert.equal(animationApi.capture(el), null);
});

test('progressive digit transitions retain equal lifetimes and leave unchanged digits sharp', () => {
  const el = element();
  const settle = animationApi.beginRoll(el, '123,456', '123,987', true);
  const places = el.children[1].children.filter((child) => child.className === 'token-number-place');
  for (const place of places.slice(0, 4)) assert.equal(place.children[0].animations.length, 0);
  const timings = places.slice(4).map((place) => place.children[0].animations[0].options);
  assert.ok(timings[0].delay < timings[1].delay && timings[1].delay < timings[2].delay);
  assert.ok(timings.every((timing) => timing.delay <= 150 && timing.duration === 650));
  assert.equal(places[4].children[0].animations[0].frames[0].filter, 'blur(0.1152em)');
  assert.equal(places[4].children[0].animations[0].frames.at(-1).filter, 'blur(0em)');
  const departing = el.children[1].children.find((child) => child.className.includes('previous')).animations[0].frames;
  const em = (frame) => parseFloat(frame.filter.match(/blur\(([\d.]+)em\)/)[1]);
  const arriving = places[4].children[0].animations[0].frames;
  assert.ok(em(departing[4]) > 0.1152 - em(arriving[4]), 'old glyphs smear before new ones sharpen');
  settle();
});

test('live regrouping rolls both readings in place under one spatial wave', () => {
  for (const [from, to] of [['533,940,381', '5,791,220,226'], ['5,791,220,226', '533,940,381']]) {
    for (const rightAligned of [false, true]) {
      const el = element();
      el.rightAligned = rightAligned;
      const settle = animationApi.beginRoll(el, from, to, to.length > from.length);
      const wrapper = el.children[1];
      const left = wrapper.getBoundingClientRect().left;
      const places = wrapper.children.filter((child) => child.className === 'token-number-place');
      const previous = wrapper.children.filter((child) => child.className.includes('previous'));
      assert.ok(places.slice(1).every((place) => place.animations.length === 0), 'no changing place slides sideways');
      const timed = [
        ...places.slice(1).map((place) => {
          const rect = place.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, delay: place.children[0].animations[0].options.delay };
        }),
        ...previous.map((glyph) => ({ x: left + parseFloat(glyph.style.left) + parseFloat(glyph.style.width) / 2,
          delay: glyph.animations[0].options.delay }))
      ].sort((a, b) => a.x - b.x);
      assert.equal(timed[0].delay, 0);
      assert.equal(timed.at(-1).delay, 150);
      for (let index = 1; index < timed.length; index++) {
        assert.ok(timed[index].delay >= timed[index - 1].delay, 'the wave only moves rightward');
        if (timed[index].x === timed[index - 1].x) assert.equal(timed[index].delay, timed[index - 1].delay,
          'an outgoing glyph and the glyph drawn over it change together');
      }
      assert.equal(places[0].children[0].animations.length, 0, 'the shared leading 5 stays sharp');
      settle();
      assert.equal(el.textContent, to);
    }
  }
});

function spatialTimings(el) {
  const wrapper = el.children[1];
  const left = wrapper.getBoundingClientRect().left;
  const places = wrapper.children.filter((child) => child.className === 'token-number-place')
    .filter((place) => place.children[0].animations.length)
    .map((place) => {
      const rect = place.getBoundingClientRect();
      const { delay, duration } = place.children[0].animations[0].options;
      return { x: rect.left + rect.width / 2, delay, end: delay + duration, outgoing: false };
    });
  const previous = wrapper.children.filter((child) => child.className.includes('previous'))
    .map((glyph) => {
      const { delay, duration } = glyph.animations[0].options;
      return { x: left + parseFloat(glyph.style.left) + parseFloat(glyph.style.width) / 2,
        delay, end: delay + duration, outgoing: true, char: glyph.textContent };
    });
  return [...places, ...previous].sort((a, b) => a.x - b.x || a.outgoing - b.outgoing);
}

test('a period switch sweeps the whole reading from its first changed glyph to its last', () => {
  const cases = [
    ['533,940,381', '5,791,220,226'], ['5,791,220,226', '533,940,381'],
    ['38,225,113,098', '533,940,381'], ['533,940,381', '38,225,113,098'],
    ['999', '1,000'], ['1,000', '999'], ['12,345,678', '12,999']
  ];
  for (const [from, to] of cases) {
    for (const rightAligned of [false, true]) {
      const el = element();
      el.rightAligned = rightAligned;
      const increasing = Number(to.replaceAll(',', '')) > Number(from.replaceAll(',', ''));
      const settle = animationApi.beginRoll(el, from, to, increasing, null, null, { period: true });
      const wrapper = el.children[1];
      const previous = wrapper.children.filter((child) => child.className.includes('previous'));
      assert.ok(previous.length > 0);
      if (from.split(',').length > to.split(',').length) {
        assert.ok(previous.some((glyph) => glyph.textContent === ','), 'removed punctuation is part of the sweep');
      }
      const timed = spatialTimings(el);
      assert.equal(timed[0].delay, 0, `${from} → ${to} starts at its first changed glyph`);
      assert.ok(timed.at(-1).delay > 0, `${from} → ${to} does not swap as one block`);
      for (let index = 1; index < timed.length; index++) {
        assert.ok(timed[index].delay >= timed[index - 1].delay, `${from} → ${to}: the sweep only moves rightward`);
        if (timed[index].x === timed[index - 1].x) assert.equal(timed[index].delay, timed[index - 1].delay,
          'an outgoing glyph and the glyph drawn over it change together');
      }
      // One pace for every width: 32ms per em of the 20px test font.
      for (const timing of timed) {
        assert.ok(Math.abs(timing.delay - Math.min(250, 32 * (timing.x - timed[0].x) / 20)) < 1e-9);
      }
      assert.ok(timed.every((timing) => timing.end <= animationApi.duration), 'the caller settles after the last glyph');
      settle();
      assert.equal(el.textContent, to);
    }
  }
});

test('a period sweep keeps the old tail in place until the sweep reaches it', () => {
  // Day → Month grows by two places; Month → Day shrinks. Either way every
  // old glyph stays where it stood, and the glyphs past the shorter reading's
  // edge change last.
  for (const [from, to] of [['533,940,381', '5,791,220,226'], ['5,791,220,226', '533,940,381']]) {
    const el = element();
    const settle = animationApi.beginRoll(el, from, to, to.length > from.length, null, null, { period: true });
    const wrapper = el.children[1];
    const places = wrapper.children.filter((child) => child.className === 'token-number-place');
    assert.ok(places.every((place) => place.animations.length === 0), 'no changing place slides sideways');
    const timed = spatialTimings(el);
    const growing = to.length > from.length;
    const last = timed.at(-1);
    assert.equal(last.outgoing, !growing, `${from} → ${to}: the wider reading owns the right edge`);
    assert.equal(last.delay, Math.max(...timed.map((timing) => timing.delay)), 'the right edge changes last');
    // The old tail is still drawn at full strength until its turn comes.
    const oldTail = wrapper.children.filter((child) => child.className.includes('previous'))
      .sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left)).at(-1);
    assert.ok(oldTail.animations[0].options.delay > 100);
    assert.equal(oldTail.animations[0].frames[0].opacity, 1);
    assert.equal(parseFloat(oldTail.style.left), Array.from(from.slice(0, -1), (char) => char === ',' ? 4 : 10)
      .reduce((a, b) => a + b, 0), 'the old tail stays where it stood');
    settle();
  }
});

test('a period switch interrupting a live wave keeps departing clocks and resweeps waiting glyphs', () => {
  const el = element();
  animationApi.beginRoll(el, '38,225,113,098', '533,940,381', false);
  el.ownerDocument.timeline.currentTime = 60;
  const snapshot = animationApi.capture(el);
  const waiting = snapshot.filter((glyph) => glyph.departedAt > 60);
  const leaving = snapshot.filter((glyph) => glyph.departedAt != null && glyph.departedAt <= 60);
  assert.ok(waiting.length && leaving.length);
  const settle = animationApi.beginRoll(el, '533,940,381', '5,791', false, null, snapshot, { period: true });
  const retained = animationApi.capture(el).filter((glyph) => glyph.departedAt != null);
  for (const glyph of leaving) {
    assert.ok(retained.some((next) => next.key === glyph.key && next.char === glyph.char && next.departedAt === glyph.departedAt),
      'an already departing glyph keeps its deadline');
  }
  for (const glyph of waiting) {
    const next = retained.find((candidate) => candidate.key === glyph.key && candidate.char === glyph.char);
    assert.ok(next.departedAt <= glyph.departedAt, 'the sweep never delays a waiting glyph');
  }
  const timed = spatialTimings(el).filter((timing) => !timing.outgoing);
  assert.equal(timed[0].delay, 0);
  assert.ok(timed.at(-1).delay > 0, 'an interrupting period switch still sweeps');
  for (let index = 1; index < timed.length; index++) assert.ok(timed[index].delay >= timed[index - 1].delay);
  settle();
  assert.equal(el.textContent, '5,791');
});

test('period switches start headline and breakdown together; rows roll as whole readings', () => {
  const { api, tick } = harness();
  const headline = element();
  const row = element();
  api.animateTotalNumber(headline, 533940381, 5791220226, 800, { synchronized: true });
  api.animateRowNumber(row, 533940381, 5791220226, 250, null, { synchronized: true });
  const places = headline.children[1].children.filter((place) => place.className === 'token-number-place');
  assert.ok(places.every((place) => place.animations.length === 0));
  const timed = spatialTimings(headline);
  assert.equal(timed[0].delay, 0);
  assert.ok(timed.at(-1).delay > 0, 'the headline sweeps glyph by glyph');
  // Every row changes every glyph on a period switch; per-glyph layers there
  // made the switch heavy, so a row moves as two layers on the headline's frame.
  const [incoming, outgoing] = row.children[1].children;
  assert.equal(row.children[1].children.length, 2);
  assert.equal(incoming.children[0].textContent, '5,791,220,226');
  assert.equal(outgoing.textContent, '533,940,381');
  assert.equal(incoming.children[0].animations[0].options.delay, 0, 'rows start with the headline');
  assert.equal(outgoing.animations[0].options.delay, 0);
  assert.equal(incoming.children[0].animations[0].frames[0].transform, 'translate(0px, 0px) translateY(0.4275em) scale(1)');
  tick(animationApi.duration);
  assert.equal(row.textContent, '5,791,220,226');
  api.animateTotalNumber(headline, 5791220226, 5791221000);
  api.animateRowNumber(row, 5791220226, 5791221000, 250);
  for (const el of [headline, row]) {
    const places = el.children[1].children.filter((place) => place.className === 'token-number-place');
    assert.ok(places.every((place) => place.animations.length === 0));
    assert.ok(places.some((place) => place.children[0].animations[0]?.options.delay > 0), 'live cascade unchanged');
  }
  tick(animationApi.duration * 2);
});

test('a shorter reading retires its old tail after the wave reaches the surviving places', () => {
  const el = element();
  const settle = animationApi.beginRoll(el, '38,225,113,098', '533,940,381', false);
  const wrapper = el.children[1];
  const places = wrapper.children.filter((child) => child.className === 'token-number-place');
  const lastIncoming = places.at(-1).children[0].animations[0];
  const removedTail = wrapper.children.findLast((child) => child.className.includes('previous') && child.textContent === '8');
  assert.ok(removedTail.animations[0].options.delay > lastIncoming.options.delay,
    'the removed right edge remains visible until the changing suffix reaches it');
  assert.equal(removedTail.animations[0].frames[0].opacity, 1);
  assert.equal(removedTail.animations[0].options.delay + removedTail.animations[0].options.duration, 800,
    'a live wave spans 150ms on top of the 650ms glyph envelope');
  const comma = places.find((place) => place.children[0].textContent === ',');
  assert.ok(comma.children[0].animations[0].options.delay > places[2].children[0].animations[0].options.delay,
    'regrouped punctuation follows its neighbours rather than appearing all at once');
  settle();
  assert.equal(el.textContent, '533,940,381');
});

test('the mask room covers a wider outgoing reading without moving the new one', () => {
  for (const rightAligned of [false, true]) {
    const el = element();
    el.rightAligned = rightAligned;
    // The shared leading 5 is kept, so the old reading's first ghost is its comma.
    const oldComma = (rightAligned ? 300 - 112 : 100) + 10;
    const settle = animationApi.beginRoll(el, '5,791,220,226', '533,940,381', false);
    const wrapper = el.children[1];
    const places = wrapper.children.filter((child) => child.className === 'token-number-place');
    const previous = wrapper.children.filter((child) => child.className.includes('previous'));
    assert.equal(wrapper.overhang(rightAligned ? 'left' : 'right'), 14, `two digits and a comma wider, nothing more (${rightAligned})`);
    assert.equal(wrapper.overhang(rightAligned ? 'right' : 'left'), 0);
    assert.equal(places[0].getBoundingClientRect().left, rightAligned ? 300 - 98 : 100, 'the new reading stays put');
    const box = wrapper.getBoundingClientRect();
    const lefts = previous.map((glyph) => box.left + parseFloat(glyph.style.left)).sort((a, b) => a - b);
    assert.equal(lefts[0], oldComma, 'each old glyph rolls where it stood');
    assert.ok(lefts.every((left) => left >= box.left) && lefts.at(-1) + 10 <= box.left + box.width);
    settle();
  }
});

test('outgoing glyphs roll where they stood while a companion follows the layout', () => {
  const el = element();
  el.rightAligned = true;
  const companion = element();
  let companionLeft = 300;
  companion.getBoundingClientRect = () => ({ left: companionLeft, top: 0, width: 10, height: 20 });
  el.nextElementSibling = companion;
  const settle = animationApi.beginRoll(el, '999', '1,000', true, () => { companionLeft = 320; });
  const wrapper = el.children[1];
  const outgoing = wrapper.children.filter((child) => child.className.includes('previous'))
    .sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left));
  assert.ok(outgoing.every((glyph) => glyph.animations.length === 1));
  assert.ok(outgoing[2].animations[0].options.delay > outgoing[0].animations[0].options.delay);
  assert.deepEqual(companion.animations[0].frames, [{ transform: 'translateX(-20px)' }, { transform: 'translateX(0px)' }]);
  assert.equal(companion.animations[0].options.duration, animationApi.layoutDuration);
  settle();
  assert.ok(outgoing.every((glyph) => glyph.animations.every((animation) => animation.cancelled)));
  assert.ok(companion.animations.every((animation) => animation.cancelled));
});

test('added and removed places roll with the reading and old glyphs crossfade with their replacements', () => {
  const el = element();
  const settle = animationApi.beginRoll(el, '999', '1,000', true);
  const wrapper = el.children[1];
  const places = wrapper.children.filter((child) => child.className === 'token-number-place');
  assert.ok(places[0].children[0].animations[0].frames[0].transform.includes('translateY(0.4275em)'));
  assert.equal(places[4].children[0].animations[0].frames[0].transform, places[0].children[0].animations[0].frames[0].transform,
    'native 999 → 1,000 raises the new rightmost 0 with its neighbours');
  const incoming = places[0].children[0].animations[0];
  const outgoing = wrapper.children.find((child) => child.className.includes('previous')).animations[0];
  for (let index = 0; index < incoming.frames.length; index++) {
    assert.ok(Math.abs(incoming.frames[index].opacity + outgoing.frames[index].opacity - 1) < 1e-12,
      'paired glyphs keep their combined opacity through the crossing');
  }
  settle();
});

test('a period sweep moves every replaced glyph on one vertical track', () => {
  // Digits landing on an old separator, places past the old length and the
  // separators themselves all share one track, so no glyph sits high while
  // its neighbours are still low.
  for (const [from, to, increasing] of [['533,940,381', '5,791,220,226', true], ['5,791,220,226', '533,940,381', false]]) {
    const el = element();
    const settle = animationApi.beginRoll(el, from, to, increasing, null, null, { period: true });
    const wrapper = el.children[1];
    const incoming = wrapper.children.filter((child) => child.className === 'token-number-place')
      .map((place) => place.children[0]).filter((glyph) => glyph.animations.length);
    const outgoing = wrapper.children.filter((child) => child.className.includes('previous'));
    assert.equal(incoming.length, to.length - 1, 'only the unchanged leading 5 stays');
    assert.equal(outgoing.length, from.length - 1);
    for (const layer of [incoming, outgoing]) {
      const tracks = layer.map((glyph) => glyph.animations[0].frames.map((frame) => frame.transform.match(/translateY\(([^)]+)\)/)[1]).join());
      assert.equal(new Set(tracks).size, 1);
    }
    const removedAt = increasing ? -1 : 1;
    assert.equal(outgoing[0].animations[0].frames.at(-1).transform.includes(removedAt > 0 ? 'translateY(0.' : 'translateY(-0.'), true,
      'old glyphs leave the opposite way to the arriving reading');
    settle();
    assert.equal(el.textContent, to);
  }
});

test('already departing layers retain their deadline and direction across reversals', () => {
  const el = element();
  const settle = animationApi.beginRoll(el, '1', '2', true);
  const firstSnapshot = animationApi.capture(el);
  settle();
  el.ownerDocument.timeline.currentTime = 200;
  const settleNext = animationApi.beginRoll(el, '2', '1', false, null, firstSnapshot);
  const oldOne = el.children[1].children.find((child) => child.className.includes('previous') && child.textContent === '1');
  assert.equal(oldOne.animations[0].options.duration, 450, 'an old departure does not restart its 650ms fade');
  const retained = animationApi.capture(el).find((glyph) => glyph.char === '1' && glyph.departedAt === 0);
  assert.equal(retained.exitDirection, 1, 'original increasing direction is retained');
  assert.equal(oldOne.animations[0].frames[0].opacity, firstSnapshot.find((glyph) => glyph.char === '1').opacity);
  settleNext();
});

test('breakdown retargets retain the captured glyphs after metadata replaced the row text', () => {
  const { api, tick } = harness();
  const row = element();
  api.animateRowNumber(row, 1, 2);
  const incoming = row.children[1].children[0].children[0];
  const outgoing = row.children[1].children.find((child) => child.className.includes('previous'));
  incoming.visualStyle = { opacity: '0.3' };
  outgoing.visualStyle = { opacity: '0.7' };
  const snapshot = animationApi.capture(row);
  api.cancelRowNumberAnimation(row);
  row.textContent = '3';
  api.animateRowNumber(row, 2, 3, 420, snapshot);
  const retained = row.children[1].children.filter((child) => child.className.includes('previous'));
  assert.deepEqual(retained.map((glyph) => glyph.animations[0].frames[0].opacity), [0.3, 0.7]);
  tick(animationApi.duration);
  assert.equal(row.textContent, '3');
  assert.equal(api.rowMotion(row), undefined);
});

test('headline roll survives matching rerenders and replaces an interrupted target cleanly', () => {
  const { api, tick, compactValues } = harness();
  const el = element();
  api.animateTotalNumber(el, 999, 1000, 1000);
  assert.equal(api.value(), 1000);
  assert.ok(api.headlineNumberIsAnimatingTo(1000));
  tick(100);
  assert.ok(api.headlineNumberIsAnimatingTo(1000));
  assert.deepEqual(compactValues, [1000]);
  const oldGlyph = el.children[1].children[0].children[0];
  api.animateTotalNumber(el, api.value(), 1001, 1000);
  assert.ok(oldGlyph.animations[0].cancelled);
  tick(100 + animationApi.duration);
  assert.equal(el.textContent, '1,001');
  assert.equal(api.headlineNumberIsAnimatingTo(1001), false);
  assert.deepEqual(compactValues, [1000, 1001, 1001]);
  tick(2000);
  assert.equal(el.textContent, '1,001');
});

test('switching style or enabling reduced motion cancels the roll without stale writes', () => {
  const { api, context, tick, compactValues } = harness();
  const el = element();
  api.animateTotalNumber(el, 1000, 2000, 1000);
  api.cancelNumberAnimation();
  assert.equal(el.textContent, '2,000');
  context.state.settings.tokenNumberAnimation = 'count';
  api.animateTotalNumber(el, 2000, 3000, 1000);
  tick(500);
  assert.equal(el.textContent, '2,938');
  context.prefersReducedMotion = () => true;
  context.state.settings.tokenNumberAnimation = 'roll';
  api.animateTotalNumber(el, api.value(), 0, 1000);
  assert.equal(el.textContent, '0');
  assert.equal(el.children.length, 0);
  tick(2000);
  assert.equal(el.textContent, '0');
  assert.deepEqual(compactValues, [2000, 0]);
});

test('reduced motion lands a period switch at once on headline and breakdown', () => {
  const { api, context } = harness();
  context.prefersReducedMotion = () => true;
  const headline = element();
  const row = element();
  api.animateTotalNumber(headline, 533940381, 5791220226, 800, { synchronized: true });
  api.animateRowNumber(row, 533940381, 5791220226, 250, null, { synchronized: true });
  for (const el of [headline, row]) {
    assert.equal(el.textContent, '5,791,220,226');
    assert.equal(el.children.length, 0, 'no sweep layers are built');
    assert.equal(animationApi.capture(el), null);
  }
});

test('a pushed animation preference settles the current headline before the next reading', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const { api, context, tick, compactValues } = harness();
  const el = element();
  const row = element();
  context.els = { totalTokens: el };
  context.state.currentTotal = 2000;
  let pluginRefreshes = 0;
  context.pluginViewHost = { refreshMotion: () => { pluginRefreshes++; } };
  api.animateTotalNumber(el, 1000, 2000, 1000);
  api.animateRowNumber(row, 100, 200, 600);
  const start = source.indexOf('function setRendererSettings(');
  const end = source.indexOf('\nfunction render()', start);
  vm.runInNewContext(`${source.slice(start, end)}\nthis.setSettings = setRendererSettings;`, context);
  context.setSettings({ tokenNumberAnimation: 'roll' });
  assert.ok(api.headlineNumberIsAnimatingTo(2000), 'matching settings leave the roll running');
  context.setSettings({ tokenNumberAnimation: 'count' });
  assert.equal(pluginRefreshes, 1, 'preference changes also settle plugin readouts');
  assert.equal(api.headlineNumberIsAnimatingTo(2000), false);
  assert.equal(el.textContent, '2,000');
  assert.equal(el.children.length, 0);
  assert.equal(row.textContent, '200');
  assert.equal(api.rowMotion(row), undefined);
  assert.deepEqual(compactValues, [2000, 2000]);
  tick(1000);
  assert.equal(el.textContent, '2,000');
});

test('the same preference rolls headline and independent breakdown rows together', () => {
  const { api, tick } = harness();
  const headline = element();
  const rows = [element(), element()];
  api.animateTotalNumber(headline, 1234, 1334, 1000);
  api.animateRowNumber(rows[0], 234, 334, 600);
  api.animateRowNumber(rows[1], 1000, 999, 600);
  for (const el of [headline, ...rows]) assert.equal(el.getAttribute('data-token-number-animation'), 'roll');
  const glyphs = rows[0].children[1];
  api.animateRowNumber(rows[0], 234, 334, 600);
  assert.strictEqual(rows[0].children[1], glyphs, 'matching row targets keep their existing glyphs');
  tick(animationApi.duration);
  assert.deepEqual([headline, ...rows].map((el) => el.textContent), ['1,334', '334', '999']);
  for (const row of rows) {
    assert.equal(api.rowMotion(row), undefined);
    assert.equal(row.dataset.motionTarget, undefined);
    assert.equal(row.getAttribute('data-token-number-animation'), null);
  }
});

test('row rolls cancel before changed targets, unavailable labels, or reduced motion', () => {
  const { api, context, tick } = harness();
  const row = element();
  api.animateRowNumber(row, 999, 1000);
  const oldGlyph = row.children[1].children[0].children[0];
  tick(100);
  api.animateRowNumber(row, 1000, 2000);
  assert.ok(oldGlyph.animations[0].cancelled);
  assert.equal(row.dataset.motionValue, '2000');
  api.cancelRowNumberAnimation(row);
  row.textContent = 'Unavailable';
  tick(1000);
  assert.equal(row.textContent, 'Unavailable');
  assert.equal(row.dataset.motionTarget, undefined);
  api.animateRowNumber(row, 2000, 3000);
  context.prefersReducedMotion = () => true;
  api.animateRowNumber(row, 2000, 3000);
  assert.equal(row.textContent, '3,000');
  assert.equal(api.rowMotion(row), undefined);
  assert.equal(row.getAttribute('data-token-number-animation'), null);
});

test('the count preference retains numeric tweening for every breakdown row', () => {
  const { api, tick } = harness('count');
  const row = element();
  api.animateRowNumber(row, 1000, 2000, 600);
  tick(300);
  assert.equal(row.textContent, '1,938');
  assert.equal(row.children.length, 0);
  tick(600);
  assert.equal(row.textContent, '2,000');
  assert.equal(api.rowMotion(row), undefined);
});

test('every bundled locale labels both token number animation options', () => {
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    for (const suffix of ['', '.count', '.roll']) {
      assert.ok(messages[`settings.appearance.tokenNumberAnimation${suffix}`], locale);
    }
  }
});


test('shared Count keeps semantic values, retargets and cancels stale frames', () => {
  const el = element(); let now = 0, nextId = 0; const frames = new Map();
  Object.assign(el.ownerDocument.defaultView, { performance: { now: () => now },
    requestAnimationFrame: fn => { frames.set(++nextId, fn); return nextId; }, cancelAnimationFrame: id => frames.delete(id) });
  const tick = time => { now = time; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); };
  const first = animationApi.beginCount(el, 100, 200, value => `${Math.round(value)}%`);
  assert.equal(el.textContent, '100%'); tick(100);
  const visible = animationApi.currentCountValue(el);
  assert.ok(visible > 100 && visible < 200); assert.equal(el.children.length, 0);
  const second = animationApi.beginCount(el, visible, 50, value => `${Math.round(value)}%`);
  first(); tick(200);
  assert.ok(animationApi.currentCountValue(el) < visible && animationApi.currentCountValue(el) > 50);
  second(); assert.equal(el.textContent, '50%'); assert.equal(frames.size, 0);
  tick(2000); assert.equal(el.textContent, '50%'); assert.equal(animationApi.currentCountValue(el), undefined);
});
