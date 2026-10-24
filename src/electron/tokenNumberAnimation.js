'use strict';

(function exposeTokenNumberAnimation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTokenNumberAnimation = api;
})(typeof window !== 'undefined' ? window : null, () => {
  const active = new WeakMap();
  const counts = new WeakMap();
  // Every glyph runs a 650ms sampled envelope (iOS 26.5 capture resolves
  // around 700ms); the caller settles once the latest-starting glyph is done.
  const glyphDuration = 650;
  // Companion layout follows the SwiftUI transaction: easeOut 250ms.
  const layoutDuration = 250;
  const easing = 'cubic-bezier(0, 0, 0.58, 1)';
  // numericText changes a reading from its first changed glyph to its last.
  // Live updates cross the changing span in a fixed ~150ms. A period switch
  // replaces the whole reading, so it sweeps at the native pace instead:
  // the 40pt Day/Month captures start the first changed digit ~70ms and the
  // last ~270ms in, ~200ms across ~6em, i.e. about 32ms per em.
  const wave = 150;
  const periodPace = 32;
  const periodWave = 250;
  const duration = periodWave + glyphDuration;
  // A period retarget carries at most this many glyphs per place, and drops
  // all but the strongest once they are three-quarters faded.
  const retargetLayers = 2;
  const retargetFloor = 0.25;
  function inkRatio(document, el) {
    const style = document.defaultView.getComputedStyle(el);
    const context = document.createElement('canvas').getContext?.('2d');
    if (!context) return 0.72;
    context.font = `${style.fontWeight || 'normal'} 100px ${style.fontFamily || 'sans-serif'}`;
    const metrics = context.measureText('0');
    const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
    return height > 0 ? height / 100 : 0.72;
  }
  // Separate second-order responses follow the measured native channels:
  // https://github.com/AmatoGiulio/react-native-numeric-text/blob/main/docs/ARCHITECTURE.md
  // Sample once per transition; WAAPI interpolates without frame layout reads.
  function response(seconds, damping, period) {
    const w = 2 * Math.PI / period;
    if (damping === 1) return 1 - (1 + w * seconds) * Math.exp(-w * seconds);
    const wd = w * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-damping * w * seconds)
      * (Math.cos(wd * seconds) + damping * w / wd * Math.sin(wd * seconds));
  }
  let initialSamples;
  function sampleIndices(age) {
    if (age === 0 && initialSamples) return initialSamples;
    const initialBody = response(age, 1, 0.278);
    const initialSmear = Math.min(0.999999, response(age, 1, 0.22));
    const samples = Array.from({ length: 49 }, (_, index) => {
      const seconds = age + index / 48 * Math.max(0, 0.65 - age);
      const end = index === 48;
      return [
        end ? 1 : response(seconds, 0.55, 0.353),
        ((end ? 1 : response(seconds, 1, 0.278)) - initialBody) / (1 - initialBody),
        end ? 1 : Math.min(1, response(seconds, 0.91, 0.398)),
        index === 0 ? 0 : Math.max(0, Math.min(1, ((end ? 1 : response(seconds, 1, 0.22)) - initialSmear) / (1 - initialSmear)))
      ];
    });
    // Keep the original piecewise-linear envelope within 0.002 per channel,
    // including its rebound and forced final endpoint. Short interrupted
    // departures get their own samples; only the common initial curve is cached.
    const selected = new Set([0, 48]);
    const intervals = [[0, 48]];
    while (intervals.length) {
      const [first, last] = intervals.pop();
      let error = 0.002;
      let split = 0;
      for (let index = first + 1; index < last; index++) {
        const progress = (index - first) / (last - first);
        for (let channel = 0; channel < 4; channel++) {
          const value = samples[first][channel] + (samples[last][channel] - samples[first][channel]) * progress;
          const distance = Math.abs(samples[index][channel] - value);
          if (distance > error) { error = distance; split = index; }
        }
      }
      if (split) {
        selected.add(split);
        intervals.push([first, split], [split, last]);
      }
    }
    const indices = [...selected].sort((a, b) => a - b);
    if (age === 0) initialSamples = indices;
    return indices;
  }
  function glyphFrames({ outgoing = false, numeric, direction, ink, opacity = 1,
    filter = 'blur(0px)', matching = false, age = 0 }) {
    const initialBlur = Math.sqrt(Array.from(filter.matchAll(/blur\(([\d.]+)px\)/g), (match) => Number(match[1]) ** 2)
      .reduce((sum, value) => sum + value, 0));
    const initialBody = response(age, 1, 0.278);
    const initialPosition = response(age, 0.55, 0.353);
    // Departing glyphs smear almost at once; arrivals sharpen over the slower
    // channel. Separators blur too: a sharp comma reads as a stray mark.
    const initialBlurProgress = Math.min(0.999999, response(age, 1, 0.22));
    const blurEm = 0.16 * ink;
    return sampleIndices(age).map((index) => {
      const offset = index / 48;
      const seconds = age + offset * Math.max(0, 0.65 - age);
      const position = index === 48 ? 1 : response(seconds, 0.55, 0.353);
      const body = index === 48 ? 1 : response(seconds, 1, 0.278);
      const blur = index === 48 ? 1 : Math.min(1, response(seconds, 0.91, 0.398));
      const smear = index === 48 ? 1 : Math.min(1, response(seconds, 1, 0.22));
      const blurProgress = Math.max(0, Math.min(1, (smear - initialBlurProgress) / (1 - initialBlurProgress)));
      // Every replaced glyph travels the same way, including added or removed
      // places and separators: native 999 → 1,000 raises the new trailing 0
      // and the comma with the rest. Exempting them left those glyphs on the
      // baseline while their neighbours rolled, so the reading looked jagged.
      const travel = matching ? 0 : direction * 0.59375 * ink;
      const scale = numeric && !matching ? outgoing ? (1 - 0.6015625 * body) / (1 - 0.6015625 * initialBody)
        : 0.3984375 + 0.6015625 * body : 1;
      const y = outgoing ? -travel * (position - initialPosition) : travel * (1 - position);
      return {
        offset,
        transform: `translate(0px, 0px) translateY(${y}em) scale(${scale})`,
        opacity: outgoing ? opacity * (1 - body) / (1 - initialBody) : matching ? opacity + (1 - opacity) * body : body,
        filter: outgoing ? index === 0 ? filter : `blur(${initialBlur * (1 - blurProgress)}px) blur(${blurEm * blurProgress}em)`
          : matching ? `blur(${initialBlur * (1 - blur)}px)` : `blur(${blurEm * (1 - blur)}em)`
      };
    });
  }
  function normalize(value) { return value === 'count' ? 'count' : 'roll'; }

  // Match formatted character positions, as observed in native numericText.
  // Only the unchanged prefix stays sharp; the suffix rolls even when it
  // contains an equal digit. Skipping separators would carry equal digits
  // sideways across a regrouping (1,234 → 12,340).
  // Keep digits and separators separate so neither can roll into the other.
  // A trailing unit (191.8M, 43%) is keyed from the end instead, so it stays
  // sharp and follows the layout when the digits before it change.
  function parts(text) {
    const chars = Array.from(text);
    let unit = chars.length;
    while (unit > 0 && !/[0-9]/.test(chars[unit - 1])) unit--;
    if (unit === 0) unit = chars.length;
    return chars.map((char, index) => {
      const numeric = /[0-9]/.test(char);
      if (index >= unit) return { char, numeric, key: `unit:${chars.length - index}:${char}` };
      return { char, numeric, key: numeric ? `digit:${index}` : `symbol:${index}:${char}` };
    });
  }

  function capture(el) {
    const motion = active.get(el);
    if (!motion) return null;
    const view = el.ownerDocument.defaultView;
    return motion.glyphs.map(({ glyph, key, char, numeric, departedAt, exitDirection }) => {
      const style = view.getComputedStyle(glyph);
      const rect = glyph.getBoundingClientRect();
      const fontSize = parseFloat(style.fontSize);
      const height = parseFloat(style.lineHeight) || glyph.offsetHeight || rect.height;
      return { key, char, numeric, rect, fontSize: fontSize * rect.height / height,
        opacity: Number(style.opacity), filter: style.filter, departedAt, exitDirection };
    }).filter((glyph) => glyph.opacity > 0.001);
  }

  // The existing Notch Count transition, shared with plugin readouts. Keep
  // numeric state separately: formatted text may contain units or locale digits.
  function currentCountValue(el) { return counts.get(el)?.value; }
  function beginCount(el, from, to, format, { toText = format(to), milliseconds = duration } = {}) {
    counts.get(el)?.settle();
    active.get(el)?.settle();
    const view = el.ownerDocument.defaultView;
    const started = view.performance.now();
    const record = { value: from, frame: 0, settle: null };
    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      view.cancelAnimationFrame(record.frame);
      if (counts.get(el) !== record) return;
      counts.delete(el);
      el.textContent = toText;
    }
    record.settle = settle;
    counts.set(el, record);
    el.textContent = format(from);
    function step(now) {
      if (settled || counts.get(el) !== record) return;
      const progress = Math.max(0, Math.min(1, (now - started) / milliseconds));
      record.value = from + (to - from) * (1 - (1 - progress) ** 4);
      el.textContent = format(record.value);
      if (progress < 1) record.frame = view.requestAnimationFrame(step);
      else settle();
    }
    record.frame = view.requestAnimationFrame(step);
    return settle;
  }

  // Native numericText never slides a changing glyph sideways: outgoing glyphs
  // roll away where they stood, incoming glyphs roll in where they land, and
  // one left-to-right wave keyed by x crosses both readings, so the old tail
  // keeps its place until the wave reaches it. Only the unchanged prefix keeps
  // its identity and follows the layout (alignment, font fit). Retargets keep
  // every visible layer in place with its own clock.
  function beginRoll(el, fromText, toText, increasing, prepare = null, snapshot = null,
    { period = false, whole = false } = {}) {
    counts.get(el)?.settle();
    // A whole reading rolls as one unit: two layers instead of one per glyph
    // and place. Breakdown rows take it on a period switch, where every glyph
    // changes at once and per-glyph layers made the switch heavy.
    const split = whole ? (text) => [{ char: text, numeric: false, key: 'reading:0' }] : parts;
    const document = el.ownerDocument;
    const view = document.defaultView;
    let previous = snapshot || capture(el);
    const interrupted = Boolean(previous);
    // Rapid period retargets would stack every earlier reading's leaving
    // glyphs, each its own layer. Keep the strongest few per place and drop
    // the ones already nearly gone.
    if (period && previous?.length) {
      const byPlace = new Map();
      for (const glyph of previous) byPlace.set(glyph.key, [...(byPlace.get(glyph.key) || []), glyph]);
      const kept = [...byPlace.values()].flatMap((glyphs) => glyphs.sort((a, b) => b.opacity - a.opacity)
        .slice(0, retargetLayers).filter((glyph, index) => index === 0 || glyph.opacity >= retargetFloor));
      previous = kept;
    }
    const fontSize = parseFloat(view.getComputedStyle(el).fontSize);
    const companion = prepare ? el.nextElementSibling : null;
    const companionLeft = companion?.getBoundingClientRect().left;
    if (!previous) {
      const old = document.createElement('span');
      old.className = 'token-number-glyphs';
      const oldParts = split(fromText);
      for (const part of oldParts) {
        const glyph = document.createElement('span');
        glyph.textContent = part.char;
        old.append(glyph);
      }
      el.replaceChildren(old);
      previous = oldParts.map((part, index) => ({ ...part, fontSize,
        rect: old.children[index].getBoundingClientRect(), opacity: 1, filter: 'blur(0px)' }));
    }
    active.get(el)?.settle();
    if (prepare) prepare();
    const wrapper = document.createElement('span');
    wrapper.className = 'token-number-glyphs';
    wrapper.setAttribute('aria-hidden', 'true');
    const before = split(fromText);
    const after = split(toText);
    let unchangedPrefix = 0;
    while (unchangedPrefix < Math.min(before.length, after.length)
      && before[unchangedPrefix].char === after[unchangedPrefix].char) unchangedPrefix++;
    const transitions = after.map((part) => {
      const place = document.createElement('span');
      place.className = 'token-number-place';
      const next = document.createElement('span');
      next.className = 'token-number-glyph';
      next.textContent = part.char;
      place.append(next);
      wrapper.append(place);
      return { ...part, place, next };
    });
    const reading = document.createElement('span');
    reading.className = 'token-number-reading';
    reading.textContent = toText;
    el.setAttribute('data-token-number-animation', 'roll');
    el.replaceChildren(reading, wrapper);
    // Two endpoint measurements per number; no layout reads during frames.
    const box = wrapper.getBoundingClientRect();
    const rects = transitions.map(({ place }) => place.getBoundingClientRect());
    // The wrapper's mask paints only inside its padding; widen that, without
    // moving layout, by however far the outgoing reading overhangs.
    const overhangLeft = Math.max(0, box.left - Math.min(...previous.map((glyph) => glyph.rect.left)));
    const overhangRight = Math.max(0, Math.max(...previous.map(({ rect }) => rect.left + rect.width)) - box.left - box.width);
    if (overhangLeft) wrapper.style.setProperty('--token-number-overhang-left', `${overhangLeft}px`);
    if (overhangRight) wrapper.style.setProperty('--token-number-overhang-right', `${overhangRight}px`);
    const origin = { left: box.left - overhangLeft, top: box.top };
    const destinationFontSize = parseFloat(view.getComputedStyle(el).fontSize);
    const startTime = document.timeline?.currentTime;
    const animations = [];
    const glyphs = [];
    // Increasing values enter from below; travel uses ink height, not the CSS
    // line box.
    const direction = increasing ? 1 : -1;
    const ink = inkRatio(document, el);
    const indexOf = (glyph) => Number(glyph.key.split(':')[1]);
    const isUnit = (key) => key.startsWith('unit:');
    const center = (rect) => rect.left + rect.width / 2;
    const changing = (index) => index >= unchangedPrefix;
    // The wave is spatial, so an outgoing glyph and the incoming glyph drawn
    // over it change together even when grouping moved their indices apart.
    const centers = [
      ...previous.filter((glyph) => !isUnit(glyph.key) && changing(indexOf(glyph))).map((glyph) => center(glyph.rect)),
      ...rects.filter((_, index) => !isUnit(transitions[index].key) && changing(index)).map(center)
    ];
    const waveStart = Math.min(...centers);
    const waveSpan = Math.max(...centers) - waveStart;
    // A period sweep keeps its pace even when it interrupts another motion:
    // swapping the whole reading on one frame reads as a block, not a change
    // from first digit to last. Interrupted live ticks stay immediate.
    const delayAt = (rect) => {
      if (whole) return 0;
      const distance = Math.max(0, center(rect) - waveStart);
      if (period) return Math.min(periodWave, periodPace * distance / (destinationFontSize || fontSize || 16));
      return interrupted || !(waveSpan > 0) ? 0 : wave * Math.min(1, distance / waveSpan);
    };
    function animate(node, frames, delay = 0, sampled = false, remaining = glyphDuration) {
      const animation = node.animate(frames, { duration: sampled ? remaining : layoutDuration, delay,
        easing: sampled ? 'linear' : easing, fill: 'both' });
      if (startTime != null) animation.startTime = startTime;
      animations.push(animation);
    }
    function appendOutgoing(old) {
      const glyph = document.createElement('span');
      glyph.className = 'token-number-glyph token-number-previous';
      glyph.textContent = old.char;
      glyph.style.left = `${old.rect.left - origin.left}px`;
      glyph.style.top = `${old.rect.top - origin.top}px`;
      glyph.style.width = `${old.rect.width}px`;
      glyph.style.height = `${old.rect.height}px`;
      glyph.style.fontSize = `${old.fontSize}px`;
      wrapper.append(glyph);
      const clock = startTime ?? view.performance?.now?.() ?? 0;
      // A period sweep may pull a glyph still waiting on an earlier wave
      // forward to where the sweep reaches it; ones already leaving keep
      // their clocks.
      const departedAt = period ? Math.min(old.departedAt ?? Infinity, clock + delayAt(old.rect))
        : old.departedAt ?? clock + delayAt(old.rect);
      const age = Math.min(0.649, Math.max(0, (clock - departedAt) / 1000));
      const exitDirection = old.exitDirection ?? direction;
      animate(glyph, glyphFrames({ outgoing: true, numeric: old.numeric, direction: exitDirection, ink,
        opacity: old.opacity, filter: old.filter, age }), Math.max(0, departedAt - clock), true, glyphDuration - age * 1000);
      glyphs.push({ glyph, key: old.key, char: old.char, numeric: old.numeric, departedAt, exitDirection });
    }
    transitions.forEach(({ key, char, numeric, place, next }, index) => {
      const rect = rects[index];
      const candidates = previous.filter((glyph) => glyph.key === key);
      const matching = index < unchangedPrefix || isUnit(key)
        ? candidates.filter((glyph) => glyph.char === char).sort((a, b) => b.opacity - a.opacity)[0] : null;
      if (matching) {
        // A kept glyph follows the layout transaction; font fitting scales it
        // from its top-left so it lands exactly on its destination place.
        const scale = rect.height > 0 ? matching.rect.height / rect.height : fontSize / destinationFontSize;
        const dx = matching.rect.left - rect.left;
        const dy = matching.rect.top - rect.top;
        if (dx || dy || scale !== 1) animate(place, [
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
          { transform: 'translate(0px, 0px) scale(1)' }
        ]);
      }
      if (!matching || matching.opacity < 0.999 || matching.filter !== 'blur(0px)') animate(next,
        glyphFrames({ numeric, direction, ink, matching: Boolean(matching),
          opacity: matching?.opacity ?? 0, filter: matching?.filter }), matching ? 0 : delayAt(rect), true);
      glyphs.push({ glyph: next, key, char, numeric });
      for (const old of candidates) {
        if (old !== matching) appendOutgoing(old);
      }
    });
    const keys = new Set(transitions.map((part) => part.key));
    previous.filter((glyph) => !keys.has(glyph.key)).forEach(appendOutgoing);
    if (companion && Number.isFinite(companionLeft)) {
      const dx = companionLeft - companion.getBoundingClientRect().left;
      if (dx) animate(companion, [
        { transform: `translateX(${dx}px)` },
        { transform: 'translateX(0px)' }
      ]);
    }
    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      for (const animation of animations) animation.cancel();
      if (active.get(el)?.settle !== settle) return;
      active.delete(el);
      el.textContent = toText;
      el.removeAttribute('data-token-number-animation');
    }
    active.set(el, { glyphs, settle });
    return settle;
  }

  return { normalize, beginRoll, beginCount, currentCountValue, capture, duration, layoutDuration };
});
