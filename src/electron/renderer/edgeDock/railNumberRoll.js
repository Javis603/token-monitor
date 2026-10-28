'use strict';

// The rail's readouts roll their digits as the widget's numbers do. The rail is
// rebuilt on every push, so each readout carries a key, its exact text and its
// value: capture() reads them off the outgoing rail before it is replaced, and
// play() rolls each replacement whose text moved, from the glyphs still on
// screen, so a push mid-roll retargets instead of restarting.
(function exposeEdgeDockRailNumberRoll(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorEdgeDockRailNumberRoll = api;
})(typeof window !== 'undefined' ? window : null, () => {
  const SELECTOR = '[data-roll-key]';
  const DIGIT = /[0-9]/;

  function mark(node, key, value, format) {
    if (format) node._numberFormat = format;
    node.dataset.rollKey = key;
    node.dataset.rollText = node.textContent;
    if (Number.isFinite(value)) node.dataset.rollValue = String(value);
    return node;
  }

  function create({ animation, schedule = (callback, ms) => setTimeout(callback, ms), selector = SELECTOR, mode = () => 'roll' }) {
    const settles = new Map();

    function settle() {
      for (const done of settles.values()) done();
      settles.clear();
    }

    // Settling cancels the outgoing rail's animations, so a replaced readout
    // does not keep compositor layers alive off screen.
    function capture(container) {
      const snapshot = new Map();
      for (const node of container?.querySelectorAll(selector) || []) {
        const key = node.dataset.rollKey;
        snapshot.set(key, snapshot.has(key) ? null : {
          text: node.dataset.rollText,
          value: animation.currentCountValue?.(node) ?? Number(node.dataset.rollValue),
          glyphs: animation.capture(node)
        });
      }
      settle();
      return snapshot;
    }

    // Text without a digit ('—', '--') has nothing to roll: a reading that
    // appears or disappears is swapped, not animated.
    function play(container, snapshot, { skip = () => false } = {}) {
      if (!snapshot?.size) return;
      for (const node of container?.querySelectorAll(selector) || []) {
        const previous = snapshot.get(node.dataset.rollKey);
        const text = node.dataset.rollText;
        if (!previous || previous.text === text || skip(node)) continue;
        if (!DIGIT.test(previous.text) || !DIGIT.test(text)) continue;
        const value = Number(node.dataset.rollValue);
        const increasing = !(Number.isFinite(value) && Number.isFinite(previous.value)) || value > previous.value;
        const counting = mode() === 'count';
        if (counting && (!Number.isFinite(previous.value) || !Number.isFinite(value) || !node._numberFormat)) continue;
        const done = counting
          ? animation.beginCount(node, previous.value, value, node._numberFormat, { toText: text })
          : animation.beginRoll(node, previous.text, text, increasing, null, previous.glyphs);
        settles.set(node, done);
        schedule(() => {
          done();
          if (settles.get(node) === done) settles.delete(node);
        }, animation.duration);
      }
    }

    return { capture, play, settle };
  }

  return { create, mark };
});
