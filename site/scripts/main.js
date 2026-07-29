/* main.js: wiring + animations. Depends on i18n.js globals. */

function reducedMotion() { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }

/* counts a [data-countup] number from 0 to its target with the full thousands
   separators, like the widget settling after a refresh */
function countUp(el, fromValue) {
  var target = parseInt(el.getAttribute("data-countup"), 10);
  if (isNaN(target)) return;
  var from = Number.isFinite(fromValue) ? fromValue : 0;
  var generation = (el._tmCountGeneration || 0) + 1;
  el._tmCountGeneration = generation;
  if (reducedMotion()) { el.textContent = target.toLocaleString("en-US"); return; }
  var start = null, dur = 1700;
  function frame(ts) {
    if (el._tmCountGeneration !== generation) return;
    if (start === null) start = ts;
    var p = Math.min((ts - start) / dur, 1);
    var eased = 1 - Math.pow(1 - p, 4);
    el.textContent = Math.round(from + (target - from) * eased).toLocaleString("en-US");
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function setupObservers() {
  var counters = document.querySelectorAll("[data-countup]");
  var reveals = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    for (var a = 0; a < counters.length; a++) {
      var n = parseInt(counters[a].getAttribute("data-countup"), 10);
      if (!isNaN(n)) counters[a].textContent = n.toLocaleString("en-US");
    }
    for (var c = 0; c < reveals.length; c++) reveals[c].classList.add("is-visible");
    return;
  }
  document.documentElement.classList.add("js");
  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e.isIntersecting) continue;
      var t = e.target;
      if (t.classList.contains("reveal")) t.classList.add("is-visible");
      if (t.hasAttribute("data-countup")) countUp(t);
      io.unobserve(t);
    }
  }, { threshold: 0.2 });
  for (var x = 0; x < reveals.length; x++) io.observe(reveals[x]);
  for (var y = 0; y < counters.length; y++) io.observe(counters[y]);
}

/* Discord Rich Presence elapsed timer: counts up from the app's first release
   (2026-05-19), formatted HH:MM:SS with hours unbounded, like Discord shows it. */
function setupDiscordClock() {
  var el = document.getElementById("d-elapsed");
  if (!el) return;
  var since = Date.UTC(2026, 4, 19, 0, 0, 0); // month is 0-based: 4 = May
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function tick() {
    var s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    el.textContent = pad(Math.floor(s / 3600)) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
  }
  tick();
  if (!reducedMotion()) setInterval(tick, 1000);
}

/* The menu bar preview uses the visitor's actual local time. Align updates to
   the next minute boundary so the static product mock stays accurate without
   running a per-second timer. */
function setupMenubarClock() {
  var el = document.querySelector("[data-menubar-clock]");
  if (!el) return;
  var localeMap = {
    en: "en-US",
    "zh-TW": "zh-Hant-HK",
    "zh-CN": "zh-Hans-CN"
  };
  var timeoutId = null;
  var languageObserver = null;
  function render() {
    var now = new Date();
    var lang = document.documentElement.lang || "en";
    var locale = localeMap[lang] || lang;
    try {
      el.textContent = new Intl.DateTimeFormat(locale, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit"
      }).format(now);
    } catch (_) {
      el.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    el.setAttribute("datetime", now.toISOString());
  }
  function schedule() {
    render();
    timeoutId = window.setTimeout(schedule, 60020 - (Date.now() % 60000));
  }
  schedule();
  if (typeof MutationObserver !== "undefined") {
    languageObserver = new MutationObserver(render);
    languageObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang"]
    });
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) render();
  });
  window.addEventListener("beforeunload", function () {
    window.clearTimeout(timeoutId);
    if (languageObserver) languageObserver.disconnect();
  });
}

/* Hero pointer-parallax: moving the pointer over the hero gently tilts the Home
   dashboard. Lerped through rAF so it feels weighted, eased back to rest on
   pointerleave. Listeners attach only after the fly-in choreography has landed,
   and never for touch or prefers-reduced-motion. */
function setupHeroTilt() {
  var stage = document.querySelector(".product-stack");
  if (!stage || reducedMotion()) return;
  if (!(window.matchMedia && window.matchMedia("(pointer: fine)").matches)) return;
  var zone = document.querySelector(".hero") || stage;
  var cur = { x: 0, y: 0 }, target = { x: 0, y: 0 }, raf = null;
  function loop() {
    cur.x += (target.x - cur.x) * 0.08;
    cur.y += (target.y - cur.y) * 0.08;
    stage.style.setProperty("--ry", (cur.x * 4).toFixed(2) + "deg");
    stage.style.setProperty("--rx", (-cur.y * 3).toFixed(2) + "deg");
    stage.style.setProperty("--px", (cur.x * 10).toFixed(2) + "px");
    stage.style.setProperty("--py", (cur.y * 8).toFixed(2) + "px");
    if (Math.abs(target.x - cur.x) + Math.abs(target.y - cur.y) > 0.002) raf = requestAnimationFrame(loop);
    else raf = null;
  }
  function kick() { if (raf === null) raf = requestAnimationFrame(loop); }
  setTimeout(function () {
    zone.addEventListener("pointermove", function (e) {
      var r = stage.getBoundingClientRect();
      target.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
      target.y = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
      kick();
    });
    zone.addEventListener("pointerleave", function () { target.x = 0; target.y = 0; kick(); });
  }, 1500);
}

/* Scroll-driven product story. Desktop keeps the app preview pinned while the
   reader moves through each feature; the nearest story beat owns the stage.
   Mobile and reduced-motion layouts move each real scene inline so no content
   depends on sticky positioning or crossfades. */
function setupFeatureStory() {
  var tour = document.querySelector("[data-tour]");
  if (!tour) return;
  var nav = tour.querySelector(".tour-nav");
  var stage = tour.querySelector(".tour-stage");
  if (!nav || !stage) return;
  var steps = Array.prototype.slice.call(nav.querySelectorAll("[data-feature-step]"));
  var screens = Array.prototype.slice.call(tour.querySelectorAll("[data-tour-screen]"));
  var inlineStages = Array.prototype.slice.call(nav.querySelectorAll("[data-tour-inline]"));
  if (steps.length < 2 || steps.length !== screens.length || inlineStages.length !== screens.length) return;
  var progress = tour.querySelector("[data-tour-progress]");
  var media = window.matchMedia("(min-width: 901px)");
  var current = 0;
  var desktopMode = false;
  var raf = 0;

  function activate(i) {
    if (i < 0 || i >= steps.length) return;
    current = i;
    for (var j = 0; j < steps.length; j++) {
      var selected = j === i;
      steps[j].classList.toggle("is-active", selected);
      if (selected) steps[j].setAttribute("aria-current", "step");
      else steps[j].removeAttribute("aria-current");
      screens[j].classList.toggle("is-active", selected);
      screens[j].setAttribute("aria-hidden", selected ? "false" : "true");
    }
    if (progress) progress.style.transform = "scaleY(" + (steps.length > 1 ? i / (steps.length - 1) : 1) + ")";
    var counts = screens[i].querySelectorAll("[data-countup]");
    for (var c = 0; c < counts.length; c++) countUp(counts[c]);
  }

  function updateFromScroll() {
    raf = 0;
    if (!desktopMode) return;
    var readingLine = window.innerHeight * 0.46;
    var nearest = current;
    var distance = Infinity;
    for (var i = 0; i < steps.length; i++) {
      var rect = steps[i].getBoundingClientRect();
      var d = Math.abs(rect.top + rect.height * 0.45 - readingLine);
      if (d < distance) {
        distance = d;
        nearest = i;
      }
    }
    if (nearest !== current) activate(nearest);
  }

  function scheduleUpdate() {
    if (!raf) raf = requestAnimationFrame(updateFromScroll);
  }

  function placeScreens() {
    desktopMode = media.matches && !reducedMotion();
    tour.classList.toggle("is-inline-story", !desktopMode);
    if (desktopMode) {
      stage.removeAttribute("aria-hidden");
      for (var i = 0; i < screens.length; i++) stage.appendChild(screens[i]);
      activate(current);
      scheduleUpdate();
      return;
    }
    stage.setAttribute("aria-hidden", "true");
    for (var j = 0; j < screens.length; j++) {
      screens[j].classList.add("is-active");
      screens[j].setAttribute("aria-hidden", "false");
      inlineStages[j].appendChild(screens[j]);
      steps[j].removeAttribute("aria-current");
    }
    if (progress) progress.style.transform = "scaleY(1)";
  }

  for (var i = 0; i < steps.length; i++) (function (index) {
    steps[index].addEventListener("pointerenter", function () {
      if (desktopMode) activate(index);
    });
    steps[index].addEventListener("focusin", function () {
      if (desktopMode) activate(index);
    });
  })(i);
  window.addEventListener("scroll", scheduleUpdate, { passive: true });
  window.addEventListener("resize", scheduleUpdate, { passive: true });
  if (typeof media.addEventListener === "function") media.addEventListener("change", placeScreens);
  else if (typeof media.addListener === "function") media.addListener(placeScreens);
  placeScreens();
}

/* Usage Dashboard replica: draws the activity heatmap, stacked bars, and
   K-line from one seeded sample series (stable across visits), mirrors the
   app's content-aware stat widths, and wires the Overview/Trends controls. */
function setupDashboard() {
  var frame = document.querySelector("[data-dash]");
  if (!frame) return;
  var heatEl = frame.querySelector("[data-dash-heatmap]");
  var chartEl = frame.querySelector("[data-dash-chart]");
  var legendEl = frame.querySelector("[data-dash-legend]");
  if (!heatEl || !chartEl || !legendEl) return;

  var cardsEl = frame.querySelector(".dash-cards");
  var measureCanvas = document.createElement("canvas");
  function measureText(node) {
    if (!node) return 0;
    var style = window.getComputedStyle(node);
    var context = measureCanvas.getContext("2d");
    context.font = style.fontStyle + " " + style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
    var value = style.textTransform === "uppercase" ? node.textContent.toUpperCase() : node.textContent;
    return context.measureText(value || "").width;
  }
  function statCardColumnWidths(contentWidths, totalWidth) {
    var equalWidth = totalWidth / contentWidths.length;
    var minWidth = 92;
    var required = contentWidths.map(function (width) { return width + 10; });
    var columns = contentWidths.map(function () { return equalWidth; });
    for (var i = 0; i < required.length; i++) if (required[i] > equalWidth) columns[i] = required[i];
    var overflow = columns.reduce(function (sum, width) { return sum + width; }, 0) - totalWidth;
    if (overflow > 0) {
      var capacities = required.map(function (width, index) {
        return Math.max(0, columns[index] - Math.max(width, minWidth));
      });
      var totalCapacity = capacities.reduce(function (sum, width) { return sum + width; }, 0);
      if (totalCapacity > 0) {
        for (var j = 0; j < columns.length; j++) {
          columns[j] -= Math.min(capacities[j], overflow * (capacities[j] / totalCapacity));
        }
      }
    }
    var sum = columns.reduce(function (total, width) { return total + width; }, 0);
    if (sum > totalWidth && sum > 0) {
      var fit = totalWidth / sum;
      for (var k = 0; k < columns.length; k++) columns[k] *= fit;
    }
    return columns.map(function (width) { return Math.round(width * 10) / 10; });
  }
  function balanceStatCards() {
    if (!cardsEl) return;
    var cards = Array.prototype.slice.call(cardsEl.querySelectorAll(".dash-card"));
    if (cards.length < 2 || cardsEl.clientWidth < 760) {
      cardsEl.style.removeProperty("grid-template-columns");
      return;
    }
    var widths = cards.map(function (card) {
      var style = window.getComputedStyle(card);
      var padding = parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0");
      return Math.max(measureText(card.querySelector(".dash-card-v")), measureText(card.querySelector(".dash-card-k"))) + padding;
    });
    var columns = statCardColumnWidths(widths, cardsEl.clientWidth);
    cardsEl.style.gridTemplateColumns = columns.map(function (width) { return width + "px"; }).join(" ");
  }
  if (cardsEl && "ResizeObserver" in window) new ResizeObserver(balanceStatCards).observe(cardsEl);
  else window.addEventListener("resize", balanceStatCards, { passive: true });
  balanceStatCards();

  /* mulberry32: tiny seeded PRNG so the sample data never shifts between loads */
  function prng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var DAYS = 364; /* 52 whole weeks */
  var DENSE = 300; /* active throughout the year, with a stronger recent run */
  var rand = prng(603);
  var daily = [];
  for (var i = 0; i < DAYS; i++) {
    var fromEnd = DAYS - 1 - i;
    var v = 0;
    if (fromEnd < DENSE) {
      var ramp = 0.3 + 0.7 * ((DENSE - fromEnd) / DENSE);
      var weekday = i % 7 === 5 ? 0.42 : i % 7 === 6 ? 0.34 : 1;
      v = ramp * weekday * (0.4 + rand() * 0.95);
      if (rand() < 0.4) v *= 1.55; /* spiky, like real agent days */
      if (fromEnd > 46 && rand() < 0.18) v = 0; /* organic gaps before the current streak */
    } else if (rand() < 0.32) {
      v = 0.08 + rand() * 0.24; /* established early activity, not an empty year */
    }
    daily.push(v);
  }

  /* anchor the series to the rest of the site's data universe: the year sums
     to the 2,217,877,661 all-time total, and one agent-swarm day 11 days ago
     is forced to exactly the 228.6M "Peak day" card */
  var TOTAL = 2217877661, PEAK = 228600000;
  var peakIdx = DAYS - 1 - 11;
  daily[peakIdx] = 0;
  var restSum = daily.reduce(function (a, b) { return a + b; }, 0);
  daily[peakIdx] = (PEAK / (TOTAL - PEAK)) * restSum;
  var scale = TOTAL / (restSum + daily[peakIdx]);

  /* shares mirror the Overview breakdown (Codex 68.1% … Cursor ~0%) */
  var SERIES = {
    client: [
      { name: "Codex", color: "#58bfca", share: 0.6806 },
      { name: "Claude Code", color: "#df8b6d", share: 0.2775 },
      { name: "Hermes", color: "#f1d15f", share: 0.0419 },
      { name: "Cursor", color: "#aab3c0", share: 0.0003 }
    ],
    model: [
      { name: "gpt-5.5", color: "#49a3b0", share: 0.402 },
      { name: "claude-opus-4-8", color: "#cc7c5e", share: 0.29 },
      { name: "gemini-3.5-pro", color: "#4285f4", share: 0.207 },
      { name: "claude-sonnet-4-6", color: "#cc7c5e", share: 0.102 }
    ]
  };

  /* charts cover the dense last 90 days */
  var last90 = daily.slice(-90);
  var splits = { client: [], model: [] };
  ["client", "model"].forEach(function (key) {
    var jit = prng(key === "client" ? 91 : 47);
    for (var d = 0; d < last90.length; d++) {
      var defs = SERIES[key], parts = [], sum = 0;
      for (var s = 0; s < defs.length; s++) {
        var f = defs[s].share * (0.7 + 0.6 * jit());
        parts.push(f); sum += f;
      }
      splits[key].push(parts.map(function (f) { return last90[d] * scale * f / sum; }));
    }
  });

  function fmtCompact(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M"; /* keeps the 228.6M peak consistent with the card */
    if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
    return String(Math.round(v));
  }

  function chartDate(i) {
    return new Date(Date.now() - (last90.length - 1 - i) * 86400000);
  }
  function xLabel(i) {
    return chartDate(i).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  var CW = 760, CH = 280, padL = 46, padR = 6, padT = 10, padB = 24;
  function svgWrap(inner, w, h) {
    return '<svg viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' + inner + "</svg>";
  }

  function axisSvg(maxV) {
    var out = "";
    for (var g = 1; g <= 4; g++) {
      var y = padT + (CH - padT - padB) * (1 - g / 4);
      out += '<line class="grid-line" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (CW - padR) + '" y2="' + y.toFixed(1) + '"></line>'
        + '<text class="axis-label" x="' + (padL - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + fmtCompact(maxV * g / 4) + "</text>";
    }
    out += '<line class="axis-base" x1="' + padL + '" y1="' + (CH - padB) + '" x2="' + (CW - padR) + '" y2="' + (CH - padB) + '"></line>';
    return out;
  }

  function heatmapSvg() {
    var weeks = 52, cell = 12, gap = 3, top = 16;
    var w = weeks * (cell + gap) - gap;
    var h = top + 7 * (cell + gap) - gap;
    /* quartile thresholds over active days, like GitHub, so the one outlier
       peak day doesn't wash every other cell down a level */
    var active = daily.filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
    function q(p) { return active[Math.min(active.length - 1, Math.floor(active.length * p))]; }
    var q1 = q(0.25), q2 = q(0.5), q3 = q(0.75);
    var months = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"];
    var out = "";
    for (var m = 0; m < months.length; m++) {
      out += '<text class="heat-month" x="' + Math.round(m * (weeks / 12) * (cell + gap)) + '" y="10">' + months[m] + "</text>";
    }
    for (var d = 0; d < daily.length; d++) {
      var wk = Math.floor(d / 7), row = d % 7;
      var v = daily[d];
      var lvl = v === 0 ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4;
      out += '<rect class="heat lvl-' + lvl + '" data-i="' + d + '" x="' + wk * (cell + gap) + '" y="' + (top + row * (cell + gap))
        + '" width="' + cell + '" height="' + cell + '" rx="3" style="--d:' + (wk * 14) + 'ms"></rect>';
    }
    return svgWrap(out, w, h);
  }

  function barsSvg(stack) {
    var defs = SERIES[stack];
    var totals = splits[stack].map(function (p) { return p[0] + p[1] + p[2] + p[3]; });
    var maxV = Math.max.apply(null, totals) * 1.08;
    var innerH = CH - padT - padB, baseY = CH - padB;
    var slot = (CW - padL - padR) / last90.length;
    var bw = Math.max(3, slot * 0.62);
    var out = axisSvg(maxV);
    [0, 30, 60, 89].forEach(function (i) {
      out += '<text class="axis-label" x="' + (padL + i * slot + slot / 2).toFixed(1) + '" y="' + (CH - 8) + '" text-anchor="middle">' + xLabel(i) + "</text>";
    });
    for (var d = 0; d < last90.length; d++) {
      var x = (padL + d * slot + (slot - bw) / 2).toFixed(1);
      var y = baseY, segs = "";
      for (var s = 0; s < defs.length; s++) {
        var hgt = innerH * (splits[stack][d][s] / maxV);
        y -= hgt;
        segs += '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, hgt).toFixed(1) + '" fill="' + defs[s].color + '"></rect>';
      }
      out += '<g class="bar-day" style="--d:' + (d * 7) + 'ms">' + segs + "</g>"
        + '<rect class="bar-hover" data-i="' + d + '" x="' + (padL + d * slot).toFixed(1) + '" y="' + padT + '" width="' + slot.toFixed(1) + '" height="' + innerH.toFixed(1) + '"></rect>';
    }
    return svgWrap(out, CW, CH);
  }

  /* 3-day buckets, like the app: O = first day, C = last day, H/L = busiest/quietest */
  var candles = (function () {
    var vals = last90.map(function (v) { return v * scale; });
    var list = [];
    for (var b = 0; b < vals.length; b += 3) {
      var seg = vals.slice(b, b + 3);
      list.push({
        o: seg[0],
        c: seg[seg.length - 1],
        h: Math.max.apply(null, seg),
        l: Math.min.apply(null, seg),
        from: b,
        to: Math.min(last90.length - 1, b + 2)
      });
    }
    return list;
  })();

  function klineSvg() {
    var maxV = Math.max.apply(null, candles.map(function (c) { return c.h; })) * 1.08;
    var innerH = CH - padT - padB, baseY = CH - padB;
    var slot = (CW - padL - padR) / candles.length;
    var bw = slot * 0.5;
    function yOf(v) { return baseY - innerH * (v / maxV); }
    var out = axisSvg(maxV);
    [0, 10, 20, 29].forEach(function (ci) {
      out += '<text class="axis-label" x="' + (padL + ci * slot + slot / 2).toFixed(1) + '" y="' + (CH - 8) + '" text-anchor="middle">' + xLabel(Math.min(last90.length - 1, ci * 3)) + "</text>";
    });
    for (var k = 0; k < candles.length; k++) {
      var c = candles[k];
      var cls = c.c >= c.o ? "candle-up" : "candle-down";
      var x = padL + k * slot + slot / 2;
      var bodyTop = yOf(Math.max(c.o, c.c));
      var bodyH = Math.max(1.5, Math.abs(yOf(c.o) - yOf(c.c)));
      out += '<g class="candle" style="--d:' + (k * 16) + 'ms">'
        + '<line class="candle-wick ' + cls + '" x1="' + x.toFixed(1) + '" y1="' + yOf(c.h).toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + yOf(c.l).toFixed(1) + '"></line>'
        + '<rect class="candle-body ' + cls + '" x="' + (x - bw / 2).toFixed(1) + '" y="' + bodyTop.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bodyH.toFixed(1) + '" rx="1"></rect>'
        + "</g>"
        + '<rect class="bar-hover" data-i="' + k + '" x="' + (padL + k * slot).toFixed(1) + '" y="' + padT + '" width="' + slot.toFixed(1) + '" height="' + innerH.toFixed(1) + '"></rect>';
    }
    return svgWrap(out, CW, CH);
  }

  function legendHtml(stack) {
    var defs = SERIES[stack];
    var sums = defs.map(function (_, s) {
      return splits[stack].reduce(function (a, p) { return a + p[s]; }, 0);
    });
    var total = sums.reduce(function (a, b) { return a + b; }, 0);
    return defs.map(function (def, s) {
      return '<div class="dash-legend-row"><span class="dash-legend-name"><span class="dash-legend-swatch" style="--c:' + def.color + '"></span>' + def.name + "</span>"
        + '<span class="dash-legend-val">' + fmtCompact(sums[s]) + "</span>"
        + '<span class="dash-legend-pct">' + (100 * sums[s] / total).toFixed(1) + "%</span></div>";
    }).join("");
  }

  var state = { mode: "bars", stack: "client" };
  var stackSeg = frame.querySelector("[data-dash-stack]");
  var modeSeg = frame.querySelector("[data-dash-mode]");

  /* cursor tooltip, mirroring the app's dashboard.js: bars show the per-series
     split of the hovered day, candles show OHLC for the 3-day bucket, heat
     cells show that day's tokens and cost */
  var tip = document.createElement("div");
  tip.className = "dash-tooltip hidden";
  tip.setAttribute("aria-hidden", "true");
  /* body-level: the frame's backdrop-filter would make it the containing
     block for position:fixed and throw the viewport coordinates off */
  document.body.appendChild(tip);

  function hideTip() { tip.classList.add("hidden"); }
  function positionTip(ev) {
    tip.classList.remove("hidden");
    var r = tip.getBoundingClientRect(), pad = 14;
    var x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  function fmtCost(v) {
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  var COST_RATE = 1899.60 / TOTAL;

  function showBarTip(i, ev) {
    var defs = SERIES[state.stack], parts = splits[state.stack][i];
    if (!parts) { hideTip(); return; }
    var total = 0, segs = [];
    for (var s = 0; s < defs.length; s++) {
      total += parts[s];
      if (parts[s] > 0) segs.push({ name: defs[s].name, color: defs[s].color, value: parts[s] });
    }
    segs.sort(function (a, b) { return b.value - a.value; });
    tip.innerHTML = '<div class="tt-head">' + xLabel(i) + " · " + fmtCompact(total) + "</div>"
      + segs.map(function (sg) {
        return '<div class="tt-row"><span class="tt-dot" style="--c:' + sg.color + '"></span><span class="tt-name">' + sg.name + '</span><span class="tt-val">' + fmtCompact(sg.value) + "</span></div>";
      }).join("");
    positionTip(ev);
  }

  function showCandleTip(i, ev) {
    var c = candles[i];
    if (!c) { hideTip(); return; }
    var head = c.to > c.from ? xLabel(c.from) + " - " + xLabel(c.to) : xLabel(c.from);
    tip.innerHTML = '<div class="tt-head">' + head + "</div>"
      + [["O", c.o], ["H", c.h], ["L", c.l], ["C", c.c]].map(function (row) {
        return '<div class="tt-row"><span class="tt-name">' + row[0] + '</span><span class="tt-val">' + fmtCompact(row[1]) + "</span></div>";
      }).join("");
    positionTip(ev);
  }

  function showHeatTip(d, ev) {
    var dt = new Date(Date.now() - (DAYS - 1 - d) * 86400000);
    var tokens = daily[d] * scale;
    var html = '<div class="tt-head">' + dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) + "</div>"
      + '<div class="tt-row"><span class="tt-name">Tokens</span><span class="tt-val">' + fmtCompact(tokens) + "</span></div>";
    if (tokens > 0) html += '<div class="tt-row"><span class="tt-name">Cost</span><span class="tt-val">' + fmtCost(tokens * COST_RATE) + "</span></div>";
    tip.innerHTML = html;
    positionTip(ev);
  }

  chartEl.addEventListener("mousemove", function (ev) {
    var hit = ev.target.closest ? ev.target.closest(".bar-hover") : null;
    if (!hit) { hideTip(); return; }
    var i = Number(hit.getAttribute("data-i"));
    if (state.mode === "kline") showCandleTip(i, ev); else showBarTip(i, ev);
  });
  chartEl.addEventListener("mouseleave", hideTip);
  heatEl.addEventListener("mousemove", function (ev) {
    var hit = ev.target.closest ? ev.target.closest(".heat") : null;
    if (!hit) { hideTip(); return; }
    showHeatTip(Number(hit.getAttribute("data-i")), ev);
  });
  heatEl.addEventListener("mouseleave", hideTip);

  function renderChart() {
    chartEl.innerHTML = state.mode === "kline" ? klineSvg() : barsSvg(state.stack);
    legendEl.innerHTML = legendHtml(state.stack);
    legendEl.classList.toggle("is-hidden", state.mode === "kline");
    if (stackSeg) stackSeg.classList.toggle("is-hidden", state.mode === "kline");
    hideTip();
  }

  heatEl.innerHTML = heatmapSvg();
  renderChart();

  function wireSeg(seg, attr, apply) {
    if (!seg) return;
    var btns = seg.querySelectorAll("button");
    for (var b2 = 0; b2 < btns.length; b2++) (function (btn) {
      btn.addEventListener("click", function () {
        if (btn.classList.contains("is-active")) return;
        for (var k = 0; k < btns.length; k++) btns[k].classList.remove("is-active");
        btn.classList.add("is-active");
        apply(btn.getAttribute(attr));
      });
    })(btns[b2]);
  }
  wireSeg(stackSeg, "data-stack", function (v) { state.stack = v; renderChart(); });
  wireSeg(modeSeg, "data-mode", function (v) { state.mode = v; renderChart(); });

  /* Overview / Trends tabs crossfade like the feature tour */
  var tabs = frame.querySelectorAll(".dash-tab");
  var panes = frame.querySelectorAll(".dash-pane");
  function activateTab(i, focus) {
    for (var k = 0; k < tabs.length; k++) {
      var on = k === i;
      tabs[k].classList.toggle("is-active", on);
      tabs[k].setAttribute("aria-selected", on ? "true" : "false");
      if (on) tabs[k].removeAttribute("tabindex"); else tabs[k].setAttribute("tabindex", "-1");
      panes[k].classList.toggle("is-active", on);
      if (on) panes[k].removeAttribute("aria-hidden"); else panes[k].setAttribute("aria-hidden", "true");
    }
    hideTip();
    if (focus) tabs[i].focus();
  }
  for (var t2 = 0; t2 < tabs.length; t2++) (function (i) {
    tabs[i].addEventListener("click", function () { activateTab(i, false); });
  })(t2);
  var tablist = frame.querySelector(".dash-tabs");
  if (tablist) tablist.addEventListener("keydown", function (e) {
    var dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    var cur = 0;
    for (var k = 0; k < tabs.length; k++) if (tabs[k].classList.contains("is-active")) cur = k;
    activateTab((cur + dir + tabs.length) % tabs.length, true);
  });
}

function setupGitHubStars() {
  var el = document.querySelector("[data-github-stars]");
  if (!el || !window.fetch) return;
  var cacheKey = "token-monitor-github-stars";
  var maxAge = 60 * 60 * 1000;

  function formatCount(count) {
    var rounded = Math.round(count);
    return rounded < 10000 ? String(rounded) : rounded.toLocaleString("en-US");
  }
  function reflect(count) {
    if (!Number.isFinite(count) || count < 0) return;
    var formatted = formatCount(count);
    el.textContent = formatted;
    el.title = formatted + " GitHub stars";
  }

  try {
    var cached = JSON.parse(window.localStorage.getItem(cacheKey) || "null");
    if (cached && Number.isFinite(cached.count)) {
      reflect(cached.count);
      if (Date.now() - cached.at < maxAge) return;
    }
  } catch (e) {}

  window.fetch("https://api.github.com/repos/Javis603/token-monitor", {
    headers: { Accept: "application/vnd.github+json" }
  }).then(function (response) {
    if (!response.ok) throw new Error("GitHub returned " + response.status);
    return response.json();
  }).then(function (repo) {
    var count = Number(repo.stargazers_count);
    if (!Number.isFinite(count)) return;
    reflect(count);
    try { window.localStorage.setItem(cacheKey, JSON.stringify({ count: count, at: Date.now() })); } catch (e) {}
  }).catch(function () {
    /* The checked-in four-digit fallback keeps the navigation useful offline. */
  });
}

/* The primary download follows the visitor's OS, then upgrades itself to the
   exact latest GitHub Release asset when the API is reachable. macOS keeps the
   release chooser as its safe fallback because Safari does not reliably expose
   Apple Silicon vs Intel; Chromium's high-entropy architecture hint lets us
   select the correct .dmg without guessing. */
function setupSmartDownloads() {
  var buttons = document.querySelectorAll("[data-smart-download]");
  if (!buttons.length) return;

  var releasePage = "https://github.com/Javis603/token-monitor/releases/latest";
  var apiUrl = "https://api.github.com/repos/Javis603/token-monitor/releases/latest";
  var cacheKey = "token-monitor-latest-release-v1";
  var cacheMaxAge = 60 * 60 * 1000;
  var platform = detectPlatform();
  var architecture = "";
  var assets = [];

  function detectPlatform() {
    var hint = "";
    try {
      hint = String((window.navigator.userAgentData && window.navigator.userAgentData.platform) || window.navigator.platform || window.navigator.userAgent || "").toLowerCase();
    } catch (e) {}
    if (hint.indexOf("win") !== -1) return "windows";
    if (hint.indexOf("mac") !== -1 || hint.indexOf("iphone") !== -1 || hint.indexOf("ipad") !== -1) return "mac";
    if (hint.indexOf("linux") !== -1 || hint.indexOf("x11") !== -1) return "linux";
    return "generic";
  }

  function iconFor(key) {
    if (key === "windows") return "assets/icons/os-windows.svg";
    if (key === "linux") return "assets/icons/os-linux.svg";
    return "assets/icons/os-apple.svg";
  }

  function messageKey(kind) {
    return "cta.download" + (kind ? "." + kind : "") + (platform === "generic" ? ".generic" : "." + platform);
  }

  function translateNode(node) {
    var messages = translations[document.documentElement.lang] || translations.en;
    translateElement(node, messages);
  }

  function assetUrlFor(key) {
    var matches = assets.filter(function (asset) {
      var name = String(asset.name || "");
      if (/\.blockmap$/i.test(name) || /\.ya?ml$/i.test(name)) return false;
      if (key === "windows") return /^Token-Monitor-Setup-.*\.exe$/i.test(name);
      if (key === "linux") return /\.AppImage$/i.test(name);
      if (key !== "mac" || !/\.dmg$/i.test(name)) return false;
      if (architecture === "arm64") return /arm64/i.test(name);
      if (architecture === "x64") return /x64/i.test(name);
      return false;
    });
    return matches.length ? matches[0].url : "";
  }

  function refreshLinks() {
    var platformLinks = document.querySelectorAll("[data-platform-download]");
    for (var i = 0; i < platformLinks.length; i++) {
      var key = platformLinks[i].getAttribute("data-platform-download");
      platformLinks[i].href = assetUrlFor(key) || releasePage;
    }
    var primaryUrl = platform === "generic" ? "" : assetUrlFor(platform);
    for (var j = 0; j < buttons.length; j++) buttons[j].href = primaryUrl || releasePage;
  }

  function refreshButtons() {
    var labelKey = messageKey("");
    var ariaKey = messageKey("aria");
    for (var i = 0; i < buttons.length; i++) {
      var label = buttons[i].querySelector("[data-smart-label]");
      var icon = buttons[i].querySelector("[data-smart-icon]");
      if (label) {
        label.setAttribute("data-i18n", labelKey);
        translateNode(label);
      }
      if (icon) icon.src = iconFor(platform);
      buttons[i].setAttribute("data-i18n-attr", "aria-label:" + ariaKey);
      translateNode(buttons[i]);
    }
    refreshLinks();
  }

  function applyAssets(nextAssets) {
    if (!Array.isArray(nextAssets)) return;
    assets = nextAssets.map(function (asset) {
      return { name: String(asset.name || ""), url: String(asset.browser_download_url || asset.url || "") };
    }).filter(function (asset) { return asset.name && asset.url; });
    refreshLinks();
  }

  document.documentElement.setAttribute("data-platform", platform);
  var cards = document.querySelectorAll("[data-platform-card]");
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].getAttribute("data-platform-card") === platform) cards[i].setAttribute("data-recommended", "true");
    else cards[i].removeAttribute("data-recommended");
  }
  refreshButtons();

  try {
    var uaData = window.navigator.userAgentData;
    if (platform === "mac" && uaData && typeof uaData.getHighEntropyValues === "function") {
      uaData.getHighEntropyValues(["architecture"]).then(function (values) {
        var hint = String(values && values.architecture || "").toLowerCase();
        architecture = /arm|aarch/.test(hint) ? "arm64" : /x86|x64|amd/.test(hint) ? "x64" : "";
        refreshButtons();
      }).catch(function () {});
    }
  } catch (e) {}

  var cached = null;
  try { cached = JSON.parse(window.localStorage.getItem(cacheKey) || "null"); } catch (e) {}
  if (cached && Array.isArray(cached.assets)) applyAssets(cached.assets);
  if (cached && Date.now() - Number(cached.at || 0) < cacheMaxAge) return;
  if (!window.fetch) return;

  window.fetch(apiUrl, { headers: { Accept: "application/vnd.github+json" } })
    .then(function (response) {
      if (!response.ok) throw new Error("GitHub returned " + response.status);
      return response.json();
    })
    .then(function (release) {
      var latestAssets = (release.assets || []).map(function (asset) {
        return { name: asset.name || "", url: asset.browser_download_url || "" };
      });
      applyAssets(latestAssets);
      try {
        window.localStorage.setItem(cacheKey, JSON.stringify({
          at: Date.now(),
          tag: release.tag_name || "",
          assets: latestAssets
        }));
      } catch (e) {}
    })
    .catch(function () {
      /* The releases page remains a valid, architecture-safe fallback. */
    });
}

function setupHeroHome() {
  var demo = document.querySelector("[data-home-demo]");
  if (!demo) return;
  var buttons = demo.querySelectorAll("[data-home-period]");
  var totalEl = demo.querySelector("[data-home-total]");
  var costEl = demo.querySelector("[data-home-cost]");
  var heatmapEl = demo.querySelector("[data-home-heatmap]");
  if (!buttons.length || !totalEl || !costEl) return;

  var periods = {
    day: { total: 119447218, cost: "$99.60" },
    month: { total: 1211540267, cost: "$988.15" },
    total: { total: 2217877661, cost: "$1,899.60" }
  };

  if (heatmapEl && !heatmapEl.children.length) {
    var seed = 5021;
    for (var cell = 0; cell < 196; cell++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      var random = seed / 4294967296;
      var week = Math.floor(cell / 7);
      var weekday = cell % 7;
      var momentum = Math.max(0.12, week / 27);
      var workday = weekday === 0 || weekday === 6 ? 0.55 : 1;
      var active = random < 0.36 + momentum * 0.56;
      var level = active ? Math.min(4, 1 + Math.floor((random + momentum * workday) * 2.35)) : 0;
      var mark = document.createElement("i");
      mark.className = "l" + level;
      mark.style.setProperty("--cell-delay", (week * 9) + "ms");
      heatmapEl.appendChild(mark);
    }
  }

  function activate(index, focus) {
    var button = buttons[index];
    var data = periods[button.getAttribute("data-home-period")];
    if (!data) return;
    var current = parseInt(totalEl.textContent.replace(/,/g, ""), 10);
    totalEl.setAttribute("data-countup", String(data.total));
    countUp(totalEl, Number.isFinite(current) ? current : 0);
    costEl.textContent = data.cost;
    demo.classList.remove("home-demo-pulse");
    void demo.offsetWidth;
    demo.classList.add("home-demo-pulse");
    for (var i = 0; i < buttons.length; i++) {
      var selected = i === index;
      buttons[i].classList.toggle("active", selected);
      buttons[i].setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) buttons[i].removeAttribute("tabindex"); else buttons[i].setAttribute("tabindex", "-1");
    }
    if (focus) button.focus();
  }

  for (var b = 0; b < buttons.length; b++) (function (index) {
    buttons[index].addEventListener("click", function () { activate(index, false); });
  })(b);
  var tablist = demo.querySelector(".home-period-tabs");
  if (tablist) tablist.addEventListener("keydown", function (event) {
    var direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    var current = 0;
    for (var i = 0; i < buttons.length; i++) if (buttons[i].classList.contains("active")) current = i;
    activate((current + direction + buttons.length) % buttons.length, true);
  });
}

/* Language dropdown: hover/focus opens it on desktop, while native <details>
   preserves click and touch operation. A small close delay bridges the visual
   gap between the icon and the floating menu without making it feel sticky. */
function setupLangMenu() {
  var menu = document.querySelector("[data-lang-menu]");
  if (!menu) return;
  var summary = menu.querySelector("summary");
  var hoverQuery = window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)") : null;
  var closeTimer = null;

  function cancelClose() {
    if (closeTimer !== null) window.clearTimeout(closeTimer);
    closeTimer = null;
  }
  function openMenu() {
    cancelClose();
    menu.setAttribute("open", "");
  }
  function closeMenu() {
    cancelClose();
    menu.removeAttribute("open");
  }
  function scheduleClose() {
    cancelClose();
    closeTimer = window.setTimeout(function () {
      if (!menu.matches(":focus-within")) closeMenu();
    }, 140);
  }

  menu.addEventListener("pointerenter", function () {
    if (hoverQuery && hoverQuery.matches) openMenu();
  });
  menu.addEventListener("pointerleave", function () {
    if (hoverQuery && hoverQuery.matches) scheduleClose();
  });
  menu.addEventListener("focusin", openMenu);
  menu.addEventListener("focusout", function () {
    window.setTimeout(function () {
      if (!menu.contains(document.activeElement)) closeMenu();
    }, 0);
  });
  if (summary) {
    summary.addEventListener("click", function (e) {
      if (hoverQuery && hoverQuery.matches && e.detail > 0) {
        e.preventDefault();
        openMenu();
      }
    });
  }
  menu.addEventListener("toggle", function () {
    if (summary) summary.setAttribute("aria-expanded", String(menu.hasAttribute("open")));
  });
  menu.addEventListener("click", function (e) {
    var t = e.target;
    while (t && t !== menu && !t.hasAttribute("data-lang")) t = t.parentElement;
    if (t && t !== menu) closeMenu();
  });
  document.addEventListener("click", function (e) {
    if (menu.hasAttribute("open") && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && menu.hasAttribute("open")) {
      closeMenu();
      if (summary) summary.focus();
    }
  });
}

document.addEventListener("DOMContentLoaded", function () {
  setupLanguageButtons();
  applyLanguage(preferredLanguage());
  setupLangMenu();
  setupSmartDownloads();
  setupGitHubStars();
  setupObservers();
  setupHeroHome();
  setupHeroTilt();
  setupFeatureStory();
  setupDashboard();
  setupDiscordClock();
  setupMenubarClock();
});
