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

/* Interface language -> formatting locale. The dictionaries collapse regional
   variants (en-GB -> en), so a date formatter needs the mapped locale and not the
   raw lang tag. Route every locale-aware date through this: a formatter that skips
   it renders English dates in every language, which is invisible in English. */
function dateLocale() {
  var lang = document.documentElement.lang;
  return {
    en: "en-US",
    "zh-TW": "zh-Hant-HK",
    "zh-CN": "zh-Hans-CN",
    ko: "ko-KR",
    ja: "ja-JP",
    "pt-BR": "pt-BR"
  }[lang] || "en-US";
}

/* The menu bar preview uses the visitor's actual local time. Align updates to
   the next minute boundary so the static product mock stays accurate without
   running a per-second timer. */
function setupMenubarClock() {
  var el = document.querySelector("[data-menubar-clock]");
  if (!el) return;
  var timeoutId = null;
  var languageObserver = null;
  function render() {
    var now = new Date();
    var locale = dateLocale();
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

/* Hovering the supported-tools strip should preserve its sense of motion.
   Ease the Web Animations playback rate down instead of snapping to a stop,
   then let it return to full speed more gradually on pointerleave. */
function setupToolMarquee() {
  var marquee = document.querySelector(".tool-marquee");
  var track = marquee && marquee.querySelector(".tool-track");
  if (!marquee || !track || reducedMotion()) return;
  if (!(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches)) return;
  if (typeof track.getAnimations !== "function") {
    marquee.classList.add("marquee-css-fallback");
    return;
  }

  var frame = 0;
  var rate = 1;
  function easeRate(target, duration) {
    cancelAnimationFrame(frame);
    var animations = track.getAnimations();
    var animation = animations.length ? animations[0] : null;
    if (!animation) {
      marquee.classList.add("marquee-css-fallback");
      return;
    }
    var from = rate;
    var started = performance.now();
    function step(now) {
      var progress = Math.min(1, (now - started) / duration);
      var eased = 1 - Math.pow(1 - progress, 4);
      rate = from + (target - from) * eased;
      if (typeof animation.updatePlaybackRate === "function") animation.updatePlaybackRate(rate);
      else animation.playbackRate = rate;
      if (progress < 1) frame = requestAnimationFrame(step);
    }
    frame = requestAnimationFrame(step);
  }

  marquee.addEventListener("pointerenter", function () { easeRate(0.22, 450); });
  marquee.addEventListener("pointerleave", function () { easeRate(1, 700); });
}

/* The feature mockups use the same compact footer switcher as the Electron
   widget: the disclosure opens on mouse hover or keyboard focus, stays open
   while crossing into the menu, and closes shortly after the pointer leaves. */
function setupWidgetViewSwitchers() {
  var viewOptions = [
    { id: "home", label: "Home" },
    { id: "limits", label: "Limits" },
    { id: "tool", label: "Tools" },
    { id: "model", label: "Models" },
    { id: "device", label: "Devices" },
    { id: "session", label: "Sessions" },
    { id: "project", label: "Projects" },
    { id: "trends", label: "Trends" },
    { id: "status", label: "Status" }
  ];
  var tourTargets = {
    model: "tour-tab-live",
    limits: "tour-tab-limits",
    session: "tour-tab-session",
    status: "tour-tab-status"
  };
  var switchers = document.querySelectorAll("[data-widget-view-switcher]");

  for (var i = 0; i < switchers.length; i++) (function wireSwitcher(root) {
    var current = root.getAttribute("data-current-view") || "home";
    var disclosure = root.querySelector(".tm-view-disclosure");
    var menu = root.querySelector(".tm-view-menu");
    if (!disclosure || !menu) return;
    var closeTimer = 0;

    menu.innerHTML = viewOptions.map(function renderViewOption(view) {
      var active = view.id === current;
      return '<button class="' + (active ? "is-current" : "") + '" type="button" role="menuitem" data-widget-view="' + view.id + '">'
        + '<span class="app-view-icon view-icon-' + view.id + '" aria-hidden="true"></span>'
        + "<span>" + view.label + "</span>"
        + "</button>";
    }).join("");

    function cancelClose() {
      if (closeTimer) window.clearTimeout(closeTimer);
      closeTimer = 0;
    }
    function reflect(open) {
      root.classList.toggle("is-open", open);
      disclosure.setAttribute("aria-expanded", open ? "true" : "false");
      menu.setAttribute("aria-hidden", open ? "false" : "true");
    }
    function openMenu() {
      cancelClose();
      reflect(true);
    }
    function closeMenu() {
      cancelClose();
      reflect(false);
    }
    function scheduleClose() {
      cancelClose();
      closeTimer = window.setTimeout(function closeAfterExit() {
        if (!root.matches(":focus-within")) closeMenu();
      }, 160);
    }

    disclosure.addEventListener("pointerenter", openMenu);
    disclosure.addEventListener("focus", openMenu);
    disclosure.addEventListener("click", openMenu);
    root.addEventListener("pointerenter", cancelClose);
    root.addEventListener("pointerleave", scheduleClose);
    root.addEventListener("focusout", function () {
      window.setTimeout(function () {
        if (!root.contains(document.activeElement)) closeMenu();
      }, 0);
    });
    menu.addEventListener("click", function (event) {
      var button = event.target.closest("[data-widget-view]");
      if (!button) return;
      closeMenu();
      var target = document.getElementById(tourTargets[button.getAttribute("data-widget-view")] || "");
      if (target) target.click();
    });
    root.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeMenu();
        disclosure.focus();
      }
    });
  })(switchers[i]);
}

/* Pinned product story. The rail follows the document's real scroll progress
   through the sticky viewport; the active screen changes only when that
   continuous progress crosses the midpoint between two steps. */
function setupFeatureStory() {
  var tour = document.querySelector("[data-tour]");
  if (!tour) return;
  var viewport = tour.querySelector(".tour-viewport");
  var nav = tour.querySelector(".tour-nav");
  var stage = tour.querySelector(".tour-stage");
  if (!viewport || !nav || !stage) return;
  var steps = Array.prototype.slice.call(nav.querySelectorAll("[data-feature-step]"));
  var screens = Array.prototype.slice.call(tour.querySelectorAll("[data-tour-screen]"));
  if (steps.length < 2 || steps.length !== screens.length) return;
  var rail = tour.querySelector(".tour-progress-rail");
  var progress = tour.querySelector("[data-tour-progress]");
  var scrollMedia = window.matchMedia("(min-width: 901px)");
  var scrollFrame = 0;
  var current = 0;

  function setProgress(value) {
    if (!progress) return;
    progress.style.transform = "scaleY(" + Math.max(0, Math.min(1, value)) + ")";
  }

  function alignProgressRail() {
    if (!rail) return;
    var firstIndex = steps[0].querySelector(".tour-index");
    var lastIndex = steps[steps.length - 1].querySelector(".tour-index");
    if (!firstIndex || !lastIndex) return;
    var navRect = nav.getBoundingClientRect();
    var firstRect = firstIndex.getBoundingClientRect();
    var lastRect = lastIndex.getBoundingClientRect();
    nav.style.setProperty("--tour-rail-top", (firstRect.top + firstRect.height / 2 - navRect.top) + "px");
    nav.style.setProperty("--tour-rail-bottom", (navRect.bottom - (lastRect.top + lastRect.height / 2)) + "px");
  }

  function activate(i, moveFocus, selectedProgress) {
    if (i < 0 || i >= steps.length) return;
    current = i;
    for (var j = 0; j < steps.length; j++) {
      var selected = j === i;
      steps[j].classList.toggle("is-active", selected);
      steps[j].setAttribute("aria-selected", selected ? "true" : "false");
      steps[j].setAttribute("tabindex", selected ? "0" : "-1");
      screens[j].classList.toggle("is-active", selected);
      screens[j].setAttribute("aria-hidden", selected ? "false" : "true");
    }
    if (typeof selectedProgress === "number") setProgress(selectedProgress);
    if (moveFocus) steps[i].focus();
  }

  for (var i = 0; i < steps.length; i++) (function (index) {
    steps[index].addEventListener("focus", function () {
      activate(index, false, index / (steps.length - 1));
    });
    steps[index].addEventListener("click", function () {
      activate(index, false, index / (steps.length - 1));
    });
    steps[index].addEventListener("keydown", function (event) {
      var next = current;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (current + 1) % steps.length;
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (current - 1 + steps.length) % steps.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = steps.length - 1;
      else return;
      event.preventDefault();
      activate(next, true, next / (steps.length - 1));
    });
  })(i);

  function updateScrollSelection() {
    scrollFrame = 0;
    if (!scrollMedia.matches || reducedMotion()) return;
    var rect = tour.getBoundingClientRect();
    var tourTop = window.scrollY + rect.top;
    var stickyTop = parseFloat(window.getComputedStyle(viewport).top) || 0;
    var start = tourTop - stickyTop;
    var end = Math.max(start + 1, tourTop + tour.offsetHeight - window.innerHeight);
    var amount = Math.max(0, Math.min(1, (window.scrollY - start) / (end - start)));
    var nearest = Math.min(steps.length - 1, Math.round(amount * (steps.length - 1)));
    setProgress(amount);
    if (nearest !== current) activate(nearest);
  }

  function scheduleScrollSelection() {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(updateScrollSelection);
  }

  window.addEventListener("scroll", scheduleScrollSelection, { passive: true });
  window.addEventListener("resize", function realignStory() {
    alignProgressRail();
    scheduleScrollSelection();
  }, { passive: true });
  if (typeof scrollMedia.addEventListener === "function") scrollMedia.addEventListener("change", scheduleScrollSelection);
  else if (typeof scrollMedia.addListener === "function") scrollMedia.addListener(scheduleScrollSelection);
  alignProgressRail();
  activate(0, false, 0);
  scheduleScrollSelection();
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
    var fittedTotal = columns.reduce(function (total, width) { return total + width; }, 0);
    if (columns.length && Math.abs(totalWidth - fittedTotal) > 0.01) {
      columns[columns.length - 1] = Math.max(0, columns[columns.length - 1] + totalWidth - fittedTotal);
    }
    return columns.map(function (width) { return Math.round(width * 10) / 10; });
  }
  function balanceStatCards() {
    if (!cardsEl) return;
    var cards = Array.prototype.slice.call(cardsEl.querySelectorAll(".dash-card"));
    cardsEl.style.setProperty("--stat-count", String(Math.max(1, cards.length)));
    if (cards.length < 2 || window.matchMedia("(max-width: 900px)").matches) {
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
  var DENSE = 364; /* active throughout the year, with a stronger recent run */
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
      if (fromEnd > 90 && rand() < 0.18) v = 0; /* organic gaps before the 97-day current streak */
    } else if (rand() < 0.32) {
      v = 0.08 + rand() * 0.24; /* established early activity, not an empty year */
    }
    daily.push(v);
  }

  /* anchor the series to the rest of the site's data universe: the year sums
     to the 38,420,000,000 all-time total, and one agent-swarm day 11 days ago
     is forced to exactly the 430.2M "Peak day" card */
  var TOTAL = 38420000000, PEAK = 430200000;
  var peakIdx = DAYS - 1 - 11;
  daily[peakIdx] = 0;
  var restSum = daily.reduce(function (a, b) { return a + b; }, 0);
  daily[peakIdx] = (PEAK / (TOTAL - PEAK)) * restSum;
  var scale = TOTAL / (restSum + daily[peakIdx]);

  /* shares mirror the Overview breakdown (Codex 65.0% … Cursor 2.3%) */
  var SERIES = {
    client: [
      { name: "Codex", color: "#58bfca", share: 0.65 },
      { name: "Claude Code", color: "#df8b6d", share: 0.256 },
      { name: "Hermes", color: "#f1d15f", share: 0.071 },
      { name: "Cursor", color: "#aab3c0", share: 0.023 }
    ],
    model: [
      { name: "gpt-5.6-sol", color: "#49a3b0", share: 0.411 },
      { name: "claude-fable-5", color: "#cc7c5e", share: 0.284 },
      { name: "kimi-k3", color: "#4285f4", share: 0.178 },
      { name: "glm-5.2", color: "#8ea7bd", share: 0.127 }
    ]
  };

  function buildChartData(days) {
    var chartDays = daily.slice(-days), splits = { client: [], model: [] };
    ["client", "model"].forEach(function (key) {
      var jit = prng(key === "client" ? 91 : 47);
      for (var d = 0; d < chartDays.length; d++) {
        var defs = SERIES[key], parts = [], sum = 0;
        for (var s = 0; s < defs.length; s++) {
          var f = defs[s].share * (0.7 + 0.6 * jit());
          parts.push(f); sum += f;
        }
        splits[key].push(parts.map(function (f) { return chartDays[d] * scale * f / sum; }));
      }
    });
    var vals = chartDays.map(function (v) { return v * scale; });
    var candles = [];
    for (var b = 0; b < vals.length; b += 3) {
      var seg = vals.slice(b, b + 3);
      candles.push({
        o: seg[0],
        c: seg[seg.length - 1],
        h: Math.max.apply(null, seg),
        l: Math.min.apply(null, seg),
        from: b,
        to: Math.min(chartDays.length - 1, b + 2)
      });
    }
    return { days: chartDays, splits: splits, candles: candles };
  }

  /* Bars and model breakdowns stay compact; K-line switches to the app's 90-day view. */
  var chartData = buildChartData(30);
  var chartDays = chartData.days;
  var splits = chartData.splits;
  var candles = chartData.candles;

  function fmtCompact(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M"; /* keeps the 228.6M peak consistent with the card */
    if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
    return String(Math.round(v));
  }

  function chartDate(i) {
    return new Date(Date.now() - (chartDays.length - 1 - i) * 86400000);
  }
  function xLabel(i) {
    return chartDate(i).toLocaleDateString(dateLocale(), { month: "short", day: "numeric" });
  }
  function chartTickIndexes(length) {
    if (length <= 1) return [0];
    var last = length - 1;
    return [0, Math.round(last / 3), Math.round(last * 2 / 3), last].filter(function (value, index, values) {
      return values.indexOf(value) === index;
    });
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
    var gridHeight = 7 * (cell + gap) - gap;
    var monthY = top + gridHeight + 17;
    var h = monthY + 4;
    /* quartile thresholds over active days, like GitHub, so the one outlier
       peak day doesn't wash every other cell down a level */
    var active = daily.filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
    function q(p) { return active[Math.min(active.length - 1, Math.floor(active.length * p))]; }
    var q1 = q(0.25), q2 = q(0.5), q3 = q(0.75);
    var monthFormatter = new Intl.DateTimeFormat(dateLocale(), { month: "short", timeZone: "UTC" });
    var months = [];
    for (var month = 0; month < 12; month++) months.push(monthFormatter.format(new Date(Date.UTC(2026, 6 + month, 1))));
    var out = "";
    for (var m = 0; m < months.length; m++) {
      out += '<text class="heat-month" x="' + Math.round(m * (weeks / 12) * (cell + gap)) + '" y="' + monthY + '">' + months[m] + "</text>";
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
    var slot = (CW - padL - padR) / chartDays.length;
    var bw = Math.max(3, slot * 0.62);
    var out = axisSvg(maxV);
    chartTickIndexes(chartDays.length).forEach(function (i) {
      out += '<text class="axis-label" x="' + (padL + i * slot + slot / 2).toFixed(1) + '" y="' + (CH - 8) + '" text-anchor="middle">' + xLabel(i) + "</text>";
    });
    for (var d = 0; d < chartDays.length; d++) {
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

  function klineSvg() {
    var maxV = Math.max.apply(null, candles.map(function (c) { return c.h; })) * 1.08;
    var innerH = CH - padT - padB, baseY = CH - padB;
    var slot = (CW - padL - padR) / candles.length;
    var bw = slot * 0.5;
    function yOf(v) { return baseY - innerH * (v / maxV); }
    var out = axisSvg(maxV);
    chartTickIndexes(candles.length).forEach(function (ci) {
      out += '<text class="axis-label" x="' + (padL + ci * slot + slot / 2).toFixed(1) + '" y="' + (CH - 8) + '" text-anchor="middle">' + xLabel(candles[ci].from) + "</text>";
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
  var rangeSeg = frame.querySelector(".dash-ranges");

  function setChartRange(days) {
    chartData = buildChartData(days);
    chartDays = chartData.days;
    splits = chartData.splits;
    candles = chartData.candles;
    if (rangeSeg) {
      var ranges = rangeSeg.querySelectorAll("[data-range]");
      for (var r = 0; r < ranges.length; r++) {
        ranges[r].classList.toggle("is-active", ranges[r].getAttribute("data-range") === String(days));
      }
    }
  }

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
  var COST_RATE = 31864.70 / TOTAL;

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
    var html = '<div class="tt-head">' + dt.toLocaleDateString(dateLocale(), { month: "short", day: "numeric", year: "numeric" }) + "</div>"
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

  function renderHeatmap() {
    heatEl.innerHTML = heatmapSvg();
  }
  renderHeatmap();
  window.addEventListener("token-monitor-languagechange", renderHeatmap);
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
  wireSeg(modeSeg, "data-mode", function (v) {
    state.mode = v;
    setChartRange(v === "kline" ? 90 : 30);
    renderChart();
  });

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
    day: { total: 165164772, cost: "$136.08" },
    month: { total: 8611540267, cost: "$7,177.64" },
    total: { total: 38420000000, cost: "$31,864.70" }
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

/* Edge Dock replica. The DOM is the app renderer's own output; the geometry
   below is a verbatim port of src/electron/renderer/edgeDock/shapes.js
   (railCommands / bubbleCommands / toSvgPath, side:"right") and the placement
   math of src/electron/edgeDock/geometry.js (edgeDockCellLayout /
   edgeDockBubbleBounds), so the silhouette, tail and cell alignment match the
   app to the pixel. */
var ED_METRICS = {
  railWidth: 64,
  railRadius: 20,
  shoulder: 28,
  bubbleWidth: 280,
  bubbleTail: 12,
  bubbleNeck: 18,
  bubbleRadius: 18,
  bubbleGap: 4,
  screenMargin: 8
};
// edgeDockCellLayout for [stat, provider, provider, stat] at full density.
var ED_CELL_TOPS = [32, 90, 162, 234];
var ED_CELL_HEIGHTS = [56, 70, 70, 56];
var ED_RAIL_LENGTH = 322;
var ED_ARC = 0.448;

function edRound(value) { return Math.round(value * 100) / 100; }
function edPath(commands) {
  return commands.map(function (c) { return c[0] + c.slice(1).map(edRound).join(" "); }).join(" ");
}
function edRailPath(width, height, shoulder, radius) {
  var w = width, h = height;
  var s = Math.max(0, Math.min(shoulder, h / 2));
  var spread = Math.min(w * 0.53, w - radius);
  var r = Math.max(0, Math.min(radius, (h - 2 * s) / 2, w - spread));
  return edPath([
    ["M", w, 0],
    ["C", w, s * 0.76, w - w * 0.25, s, w - spread, s],
    ["L", r, s],
    ["C", r * ED_ARC, s, 0, s + r * ED_ARC, 0, s + r],
    ["L", 0, h - s - r],
    ["C", 0, h - s - r * ED_ARC, r * ED_ARC, h - s, r, h - s],
    ["L", w - spread, h - s],
    ["C", w - w * 0.25, h - s, w, h - s * 0.76, w, h],
    ["Z"]
  ]);
}
function edBubblePath(width, height, tailY) {
  var bw = width - ED_METRICS.bubbleTail;
  var tipX = Math.max(bw, width - 1);
  var h = height;
  var r = Math.max(0, Math.min(ED_METRICS.bubbleRadius, h / 2, bw / 2));
  var n = Math.max(0, Math.min(ED_METRICS.bubbleNeck, (h - 2 * r) / 2));
  var ty = Math.max(r + n, Math.min(h - r - n, Number(tailY) || h / 2));
  return edPath([
    ["M", r, 0],
    ["L", bw - r, 0],
    ["C", bw - r * ED_ARC, 0, bw, r * ED_ARC, bw, r],
    ["L", bw, ty - n],
    ["C", bw, ty - n * 0.4, bw + ED_METRICS.bubbleTail * 0.5, ty - 1.5, tipX, ty],
    ["C", bw + ED_METRICS.bubbleTail * 0.5, ty + 1.5, bw, ty + n * 0.4, bw, ty + n],
    ["L", bw, h - r],
    ["C", bw, h - r * ED_ARC, bw - r * ED_ARC, h, bw - r, h],
    ["L", r, h],
    ["C", r * ED_ARC, h, 0, h - r * ED_ARC, 0, h - r],
    ["L", 0, r],
    ["C", 0, r * ED_ARC, r * ED_ARC, 0, r, 0],
    ["Z"]
  ]);
}

/* Rail cells open their hover cards. Until the visitor interacts, the card
   auto-cycles Usage -> Codex limits -> Sessions once the stage scrolls into
   view; reduced motion pins the Usage card statically. */
function setupEdgeDock() {
  var stage = document.querySelector("[data-ed-stage]");
  if (!stage) return;
  var scene = stage.querySelector("[data-ed-scene]");
  var railWin = stage.querySelector(".ed-rail-win");
  var rail = stage.querySelector("[data-ed-rail]");
  if (!scene || !railWin || !rail) return;
  var m = ED_METRICS;
  var sceneW = m.bubbleWidth + m.bubbleTail + m.bubbleGap + m.railWidth;
  var cells = Array.prototype.slice.call(rail.querySelectorAll("[data-ed-item]"));
  var bubbles = {};
  var bubbleList = Array.prototype.slice.call(scene.querySelectorAll("[data-ed-card]"));
  bubbleList.forEach(function (b) { bubbles[b.getAttribute("data-ed-card")] = b; });
  var cycle = ["stat:today", "codex", "stat:sessions"];
  var cycleIndex = 0;
  var interacted = false;
  var inView = false;
  var timer = null;
  var sceneH = ED_RAIL_LENGTH;

  function paintShape(root, d) {
    var paths = root.querySelectorAll(".edge-dock-shape path");
    for (var i = 0; i < paths.length; i++) paths[i].setAttribute("d", d);
  }

  /* Measure each card the way the app measures its bubble window, then place
     the rail and cards with the controller's math (edgeDockBubbleBounds). */
  function layout() {
    var heights = {};
    var maxCard = 0;
    bubbleList.forEach(function (b) {
      var card = b.querySelector(".edge-dock-card");
      var h = card ? Math.round(card.getBoundingClientRect().height || card.offsetHeight) : 0;
      heights[b.getAttribute("data-ed-card")] = h;
      if (h > maxCard) maxCard = h;
    });
    sceneH = Math.max(ED_RAIL_LENGTH, maxCard + m.screenMargin * 2);
    scene.style.height = sceneH + "px";
    var railTop = Math.round((sceneH - ED_RAIL_LENGTH) / 2);
    railWin.style.left = (sceneW - m.railWidth) + "px";
    railWin.style.top = railTop + "px";
    railWin.style.width = m.railWidth + "px";
    railWin.style.height = ED_RAIL_LENGTH + "px";
    paintShape(railWin, edRailPath(m.railWidth, ED_RAIL_LENGTH, m.shoulder, m.railRadius));
    cells.forEach(function (cell) {
      var index = Number(cell.getAttribute("data-index"));
      var bubble = bubbles[cell.getAttribute("data-ed-item")];
      if (!bubble || !Number.isInteger(index)) return;
      var h = Math.max(40, heights[cell.getAttribute("data-ed-item")] || 0);
      var cellCenter = railTop + ED_CELL_TOPS[index] + ED_CELL_HEIGHTS[index] / 2;
      var minY = m.screenMargin;
      var maxY = Math.max(minY, sceneH - h - m.screenMargin);
      var y = Math.round(Math.max(minY, Math.min(maxY, cellCenter - h / 2)));
      var w = m.bubbleWidth + m.bubbleTail;
      bubble.style.left = (sceneW - m.railWidth - m.bubbleGap - w) + "px";
      bubble.style.top = y + "px";
      bubble.style.width = w + "px";
      bubble.style.height = h + "px";
      var svg = bubble.querySelector(".edge-dock-shape");
      if (svg) svg.setAttribute("viewBox", "0 0 " + w + " " + h);
      paintShape(bubble, edBubblePath(w, h, cellCenter - y));
    });
    applyScale();
  }

  /* Under 768px the fixed-width scene scales down as one composition; the
     stage height hugs the scaled scene (see edgedock.css). */
  function applyScale() {
    var mobile = window.matchMedia("(max-width: 768px)").matches;
    var avail = stage.clientWidth - (mobile ? 14 : 0);
    var scale = mobile ? Math.min(1, avail / sceneW) : 1;
    stage.style.setProperty("--ed-scale", String(Math.max(0.2, scale)));
    stage.style.setProperty("--ed-scene-h", sceneH + "px");
  }

  function open(id) {
    for (var i = 0; i < cells.length; i++) {
      var active = cells[i].getAttribute("data-ed-item") === id;
      cells[i].classList.toggle("is-focused", active);
      cells[i].setAttribute("aria-expanded", active ? "true" : "false");
    }
    bubbleList.forEach(function (b) {
      var show = b.getAttribute("data-ed-card") === id;
      var was = b.classList.contains("is-open");
      b.classList.toggle("is-open", show);
      b.setAttribute("aria-hidden", String(!show));
      if (show && !was && !reducedMotion()) {
        b.classList.remove("is-card-changed");
        void b.offsetWidth;
        b.classList.add("is-card-changed");
      }
    });
  }

  function stopCycling() {
    interacted = true;
    if (timer) { window.clearInterval(timer); timer = null; }
  }

  for (var i = 0; i < cells.length; i++) (function (cell) {
    function activate() {
      stopCycling();
      open(cell.getAttribute("data-ed-item"));
    }
    cell.addEventListener("pointerenter", activate);
    cell.addEventListener("focus", activate);
    cell.addEventListener("click", activate);
  })(cells[i]);

  bubbleList.forEach(function (b) {
    b.addEventListener("pointerenter", stopCycling);
    b.addEventListener("focusin", stopCycling);
  });

  var switchButtons = Array.prototype.slice.call(stage.querySelectorAll(".edge-dock-breakdown-option"));
  switchButtons.forEach(function (button) {
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      stopCycling();
      var mode = button.getAttribute("data-ed-mode");
      switchButtons.forEach(function (other) {
        var on = other === button;
        other.classList.toggle("is-active", on);
        other.setAttribute("aria-pressed", on ? "true" : "false");
      });
      Array.prototype.slice.call(stage.querySelectorAll("[data-ed-rows]")).forEach(function (rows) {
        rows.hidden = rows.getAttribute("data-ed-rows") !== mode;
      });
      var card = stage.querySelector(".edge-dock-card[data-breakdown-mode]");
      if (card) card.setAttribute("data-breakdown-mode", mode);
    });
  });

  layout();
  open("stat:today");
  window.addEventListener("resize", applyScale);
  if ("ResizeObserver" in window) new ResizeObserver(applyScale).observe(stage);
  window.addEventListener("token-monitor-languagechange", layout);
  if (reducedMotion() || !("IntersectionObserver" in window)) return;
  var io = new IntersectionObserver(function (entries) {
    inView = entries[0].isIntersecting;
    if (inView && !interacted && !timer) {
      timer = window.setInterval(function () {
        if (!inView) return;
        cycleIndex = (cycleIndex + 1) % cycle.length;
        open(cycle[cycleIndex]);
      }, 4000);
    } else if (!inView && timer) {
      window.clearInterval(timer);
      timer = null;
    }
  }, { threshold: 0.35 });
  io.observe(stage);
}

/* The Activity widgets' heatmaps are generated so the replica stays compact;
   the pattern is deterministic sample data, like the rest of the page. The
   grid itself ports WidgetHeatmapLayoutCalculator + HeatmapMonthLabels: a
   Sunday-first grid ending in the current week, weekCount = min(maxWeeks,
   coverageWeeks, widthCapacity) and cell = min(maxCell, widthFit, heightFit),
   with future cells left clear. */
var WDG_HEAT_PROFILES = {
  full: { maxWeeks: 26, minCell: 5.5, maxCell: 9.5, spacing: 2.5, vPad: 42 },
  mini: { maxWeeks: 16, minCell: 5, maxCell: 7.5, spacing: 2.25, fixedHeight: 64 }
};

function wdgHeatLayout(availW, availH, profile, coverageWeeks) {
  var spacing = profile.spacing;
  var widthCapacity = Math.max(0, Math.floor((availW + spacing) / (profile.minCell + spacing)));
  var weekCount = Math.min(profile.maxWeeks, coverageWeeks, widthCapacity);
  if (weekCount <= 0) return null;
  var widthFit = (availW - (weekCount - 1) * spacing) / weekCount;
  var heightFit = (availH - 6 * spacing) / 7;
  var cell = Math.min(profile.maxCell, widthFit, heightFit);
  if (cell <= 0) return null;
  return {
    weekCount: weekCount,
    cell: cell,
    spacing: spacing,
    renderedW: weekCount * cell + (weekCount - 1) * spacing
  };
}

function wdgSunday(date) {
  var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function setupWidgetHeat() {
  var heats = document.querySelectorAll("[data-wdg-heat]");
  if (!heats.length) return;
  var seed = 7;
  function next() {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  }
  var today = new Date();
  var todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  var referenceSunday = wdgSunday(today);
  // The sample data spans a year, so coverage never bounds the week count.
  var coverageWeeks = 53;
  var layouts = {};
  Array.prototype.slice.call(heats).forEach(function (heat) {
    var mini = heat.getAttribute("data-wdg-heat") === "mini";
    var profile = mini ? WDG_HEAT_PROFILES.mini : WDG_HEAT_PROFILES.full;
    var holder = heat.parentElement;
    var wdg = heat.closest(".wdg");
    if (!holder || !wdg) return;
    var wdgStyle = window.getComputedStyle(wdg);
    var availW = mini
      ? holder.clientWidth
      : wdg.clientWidth - parseFloat(wdgStyle.paddingLeft) - parseFloat(wdgStyle.paddingRight);
    var availH = mini
      ? profile.fixedHeight
      : Math.max(60, wdg.clientHeight - parseFloat(wdgStyle.paddingTop) - parseFloat(wdgStyle.paddingBottom) - profile.vPad);
    var layout = wdgHeatLayout(availW, availH, profile, coverageWeeks);
    if (!layout) return;
    layouts[heat.getAttribute("data-wdg-heat")] = layout;
    var gridStart = new Date(referenceSunday);
    gridStart.setDate(gridStart.getDate() - (layout.weekCount - 1) * 7);
    heat.style.gridTemplateRows = "repeat(7, " + layout.cell + "px)";
    heat.style.gridAutoColumns = layout.cell + "px";
    heat.style.gap = layout.spacing + "px";
    heat.style.width = layout.renderedW + "px";
    var months = holder.querySelector(".wdg-months");
    if (months) months.style.width = layout.renderedW + "px";
    for (var week = 0; week < layout.weekCount; week++) {
      for (var day = 0; day < 7; day++) {
        var date = new Date(gridStart);
        date.setDate(date.getDate() + week * 7 + day);
        var cell = document.createElement("i");
        var future = date > todayMidnight;
        var roll = next();
        var level = 0;
        // Weekends sit quieter; older weeks are sparse and dark.
        var weekend = day === 0 || day === 6;
        var recency = week / layout.weekCount;
        if (roll < (weekend ? 0.72 : 0.4) - recency * 0.3) level = 0;
        else if (roll < 0.6) level = 1;
        else if (roll < 0.82) level = 2;
        else if (roll < 0.94) level = 3;
        else level = 4;
        if (!future) cell.setAttribute("data-l", String(level));
        else cell.setAttribute("data-f", "1");
        cell.setAttribute("data-date", date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0"));
        cell.style.setProperty("--d", week * 20 + day * 7 + "ms");
        heat.appendChild(cell);
      }
    }
  });

  /* HeatmapMonthLabels: a marker for the first week in each new month, offset
     week * pitch, capped so the label fits inside the rendered width. */
  var monthBlocks = document.querySelectorAll("[data-wdg-months]");
  function renderMonths() {
    var fmt;
    try {
      fmt = new Intl.DateTimeFormat(dateLocale(), { month: "short" });
    } catch (_) {
      fmt = new Intl.DateTimeFormat("en-US", { month: "short" });
    }
    Array.prototype.slice.call(monthBlocks).forEach(function (months) {
      var heat = months.parentElement && months.parentElement.querySelector("[data-wdg-heat]");
      var layout = heat && layouts[heat.getAttribute("data-wdg-heat")];
      months.innerHTML = "";
      if (!heat || !layout) return;
      var cells = heat.querySelectorAll("i");
      var previousMonth = null;
      for (var w = 0; w < layout.weekCount; w++) {
        var firstKey = null;
        var monthKey = null;
        for (var d = 0; d < 7; d++) {
          var cellEl = cells[w * 7 + d];
          if (!cellEl) continue;
          var key = cellEl.getAttribute("data-date").slice(0, 7);
          if (firstKey === null) firstKey = key;
          if (previousMonth !== null && key !== previousMonth) { monthKey = monthKey || key; }
        }
        if (monthKey === null) monthKey = previousMonth === null ? firstKey : null;
        if (monthKey === null || monthKey === previousMonth) continue;
        previousMonth = monthKey;
        var parts = monthKey.split("-");
        var label = document.createElement("span");
        label.textContent = fmt.format(new Date(Number(parts[0]), Number(parts[1]) - 1, 1));
        label.style.left = Math.min(w * (layout.cell + layout.spacing), Math.max(0, layout.renderedW - 22)) + "px";
        months.appendChild(label);
      }
    });
  }
  renderMonths();
  window.addEventListener("token-monitor-languagechange", renderMonths);
}

/* The widget wall keeps the real WidgetKit point sizes (170 / 364x170 /
   364x382, 24pt desktop spacing). Above ~820px of stage width the desktop
   cluster renders as-is and scales down as one scene; below that the widgets
   stack vertically at the same real sizes, smalls side by side. */
var WDG_LAYOUTS = {
  cluster: {
    sceneW: 1140, sceneH: 382,
    pos: {
      dash: [0, 0, 364, 382],
      activity: [388, 0, 364, 170],
      quota: [388, 194, 364, 170],
      breakdown: [776, 0, 364, 170],
      "small-a": [776, 194, 170, 170],
      "small-b": [970, 194, 170, 170]
    }
  },
  stack: {
    sceneW: 364, sceneH: 1142,
    pos: {
      dash: [0, 0, 364, 382],
      activity: [0, 398, 364, 170],
      quota: [0, 584, 364, 170],
      breakdown: [0, 770, 364, 170],
      "small-a": [0, 956, 170, 170],
      "small-b": [194, 956, 170, 170]
    }
  }
};

function setupWidgetScene() {
  var wall = document.querySelector("[data-wdg-wall]");
  if (!wall) return;
  var scene = wall.querySelector("[data-wdg-scene]");
  if (!scene) return;
  function layout() {
    var pad = wall.clientWidth < 620 ? 16 : 24;
    var availW = Math.max(0, wall.clientWidth - pad * 2);
    var stack = availW < 820;
    var def = stack ? WDG_LAYOUTS.stack : WDG_LAYOUTS.cluster;
    wall.classList.toggle("is-stack", stack);
    var scale = Math.min(1, availW / def.sceneW);
    scene.style.setProperty("--wdg-scale", String(scale));
    wall.style.setProperty("--wdg-wall-h", Math.ceil(def.sceneH * scale + pad * 2) + "px");
    var widgets = scene.querySelectorAll("[data-wdg]");
    for (var i = 0; i < widgets.length; i++) {
      var p = def.pos[widgets[i].getAttribute("data-wdg")];
      if (!p) continue;
      widgets[i].style.left = p[0] + "px";
      widgets[i].style.top = p[1] + "px";
      widgets[i].style.width = p[2] + "px";
      widgets[i].style.height = p[3] + "px";
    }
  }
  layout();
  var raf = 0;
  window.addEventListener("resize", function () {
    if (raf) return;
    raf = window.requestAnimationFrame(function () { raf = 0; layout(); });
  }, { passive: true });
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
  setupToolMarquee();
  setupFeatureStory();
  setupWidgetViewSwitchers();
  setupDashboard();
  setupEdgeDock();
  setupWidgetScene();
  setupWidgetHeat();
  setupDiscordClock();
  setupMenubarClock();
});
