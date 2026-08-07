/*!
 * Side Rays adapted from React Bits.
 * Copyright (c) 2026 David Haz.
 * MIT + Commons Clause License Condition v1.0.
 * Full notice: THIRD_PARTY_NOTICES.md
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { Mesh, Program, Renderer, Triangle } from "ogl";
import DarkVeil from "./darkVeil.jsx";

const VERTEX_SHADER = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;

uniform float iTime;
uniform vec2 iResolution;
uniform float iSpeed;
uniform vec3 iRayColor1;
uniform vec3 iRayColor2;
uniform float iIntensity;
uniform float iSpread;
uniform float iFlipX;
uniform float iFlipY;
uniform float iTilt;
uniform float iSaturation;
uniform float iBlend;
uniform float iFalloff;
uniform float iOpacity;

float rayStrength(vec2 raySource, vec2 rayRefDirection, vec2 coord, float seedA, float seedB, float speed) {
  vec2 sourceToCoord = coord - raySource;
  float cosAngle = dot(normalize(sourceToCoord), rayRefDirection);
  return clamp(
    (0.45 + 0.15 * sin(cosAngle * seedA + iTime * speed)) +
    (0.3 + 0.2 * cos(-cosAngle * seedB + iTime * speed)),
    0.0, 1.0
  ) * clamp((iResolution.x - length(sourceToCoord)) / iResolution.x, 0.5, 1.0);
}

void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  if (iFlipX > 0.5) fragCoord.x = iResolution.x - fragCoord.x;
  if (iFlipY > 0.5) fragCoord.y = iResolution.y - fragCoord.y;

  vec2 coord = vec2(fragCoord.x, iResolution.y - fragCoord.y);
  vec2 rayPos = vec2(iResolution.x * 1.1, -0.5 * iResolution.y);

  float tiltRad = iTilt * 3.14159265 / 180.0;
  float cs = cos(tiltRad);
  float sn = sin(tiltRad);
  vec2 rel = coord - rayPos;
  vec2 tiltedCoord = vec2(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs) + rayPos;

  float halfSpread = iSpread * 0.275;
  vec2 rayRefDir1 = normalize(vec2(cos(0.785398 + halfSpread), sin(0.785398 + halfSpread)));
  vec2 rayRefDir2 = normalize(vec2(cos(0.785398 - halfSpread), sin(0.785398 - halfSpread)));

  vec4 rays1 = vec4(iRayColor1, 1.0) * rayStrength(rayPos, rayRefDir1, tiltedCoord, 36.2214, 21.11349, iSpeed);
  vec4 rays2 = vec4(iRayColor2, 1.0) * rayStrength(rayPos, rayRefDir2, tiltedCoord, 22.3991, 18.0234, iSpeed * 0.2);
  vec4 color = rays1 * (1.0 - iBlend) * 0.9 + rays2 * iBlend * 0.9;

  float distanceToLight = length(fragCoord.xy - vec2(rayPos.x, iResolution.y - rayPos.y)) / iResolution.y;
  float brightness = iIntensity * 0.4 / pow(max(distanceToLight, 0.001), iFalloff);
  color.rgb *= brightness;

  float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  color.rgb = mix(vec3(gray), color.rgb, iSaturation);
  color.a = max(color.r, max(color.g, color.b)) * iOpacity;
  gl_FragColor = color;
}`;

function hexToRgb(hex) {
  var match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return match
    ? [parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255]
    : [1, 1, 1];
}

function SideRays({
  speed = 0.55,
  rayColor1 = "#f4f8ff",
  rayColor2 = "#4f91ff",
  intensity = 2,
  spread = 2,
  saturation = 1.15,
  blend = 0.75,
  falloff = 1.6,
  opacity = 1
}) {
  var containerRef = useRef(null);
  var [visible, setVisible] = useState(true);

  useEffect(function observeVisibility() {
    var container = containerRef.current;
    if (!container || typeof IntersectionObserver !== "function") return undefined;
    var observer = new IntersectionObserver(function update(entries) {
      setVisible(Boolean(entries[0] && entries[0].isIntersecting));
    }, { threshold: 0.05 });
    observer.observe(container);
    return function cleanup() { observer.disconnect(); };
  }, []);

  useEffect(function renderRays() {
    var container = containerRef.current;
    if (!container || !visible) return undefined;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      container.classList.add("is-static");
      return undefined;
    }

    var renderer;
    var frame = 0;
    var resizeObserver;
    try {
      renderer = new Renderer({
        dpr: Math.min(window.devicePixelRatio || 1, 1.5),
        alpha: true,
        antialias: false
      });
    } catch (error) {
      container.classList.add("is-static");
      return undefined;
    }

    var gl = renderer.gl;
    gl.canvas.style.display = "block";
    gl.canvas.style.width = "100%";
    gl.canvas.style.height = "100%";
    container.replaceChildren(gl.canvas);

    var uniforms = {
      iTime: { value: 0 },
      iResolution: { value: [1, 1] },
      iSpeed: { value: speed },
      iRayColor1: { value: hexToRgb(rayColor1) },
      iRayColor2: { value: hexToRgb(rayColor2) },
      iIntensity: { value: intensity },
      iSpread: { value: spread },
      iFlipX: { value: 0 },
      iFlipY: { value: 0 },
      iTilt: { value: 0 },
      iSaturation: { value: saturation },
      iBlend: { value: blend },
      iFalloff: { value: falloff },
      iOpacity: { value: opacity }
    };
    var geometry = new Triangle(gl);
    var program = new Program(gl, {
      vertex: VERTEX_SHADER,
      fragment: FRAGMENT_SHADER,
      uniforms: uniforms
    });
    var mesh = new Mesh(gl, { geometry: geometry, program: program });

    function resize() {
      var width = Math.max(1, container.clientWidth);
      var height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height);
      uniforms.iResolution.value = [width * renderer.dpr, height * renderer.dpr];
    }

    function loop(time) {
      uniforms.iTime.value = time * 0.001;
      renderer.render({ scene: mesh });
      frame = requestAnimationFrame(loop);
    }

    resize();
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);
    } else {
      window.addEventListener("resize", resize);
    }
    frame = requestAnimationFrame(loop);

    return function cleanup() {
      cancelAnimationFrame(frame);
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener("resize", resize);
      try {
        var loseContext = gl.getExtension("WEBGL_lose_context");
        if (loseContext) loseContext.loseContext();
      } catch (error) {}
      container.replaceChildren();
    };
  }, [visible, speed, rayColor1, rayColor2, intensity, spread, saturation, blend, falloff, opacity]);

  return <div className="side-rays-container" ref={containerRef} />;
}

var HERO_PERIODS = {
  day: { total: 165164772, cost: 136.08 },
  month: { total: 8611540267, cost: 7177.64 },
  total: { total: 38420000000, cost: 31864.70 }
};

var HERO_PERIOD_IDS = Object.keys(HERO_PERIODS);
var HERO_LIVE_INTERVAL_MS = 10000;
var HERO_LIVE_STEP = 220000;
var HERO_COST_PER_TOKEN = HERO_PERIODS.day.cost / HERO_PERIODS.day.total;
var WIDGET_VIEWS = [
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

var HERO_LIMITS = [
  {
    id: "claude",
    name: "Claude",
    windows: [
      { label: "Session", value: "99% left", reset: "Reset 1h 59m" },
      { label: "Weekly", value: "35% left", reset: "Reset 2d 21h" }
    ]
  },
  {
    id: "codex",
    name: "Codex",
    windows: [
      { label: "Session", value: "76% left", reset: "Reset 3h 42m" },
      { label: "Weekly", value: "88% left", reset: "Reset 6d 21h" }
    ]
  }
];

var HERO_MODELS = [
  { id: "codex", name: "gpt-5.6-sol", value: 67900000, share: 0.41, shareLabel: "41%" },
  { id: "claude", name: "claude-fable-5", value: 46900000, share: 0.28, shareLabel: "28%" },
  { id: "kimi", name: "kimi-k3", value: 29400000, share: 0.18, shareLabel: "18%" },
  { id: "zai", name: "glm-5.2", value: 21000000, share: 0.13, shareLabel: "13%" }
];

var HERO_DEVICES = [
  { id: "mac", name: "mac-studio", icon: "assets/icons/os-apple.svg", value: 165100000, share: 0.998, you: true },
  { id: "windows", name: "windows-workstation", icon: "assets/icons/os-windows.svg", value: 16700, share: 0.002 }
];

function heroHeatLevel(index) {
  var column = Math.floor(index / 7);
  var row = index % 7;
  var seed = (column * 37 + row * 19 + column * row * 7 + 11) % 101;
  var activityChance = 0.22 + (column / 31) * 0.64;
  if (seed / 100 > activityChance) return 0;
  var strength = ((seed * 13 + column * 11 + row * 3) % 100) / 100;
  return 1 + Math.min(3, Math.floor(strength * (1.3 + (column / 31) * 2.7)));
}

var HERO_HEAT_CELL_COUNT = 224;
var HERO_HEAT_END_DATE = Date.UTC(2026, 6, 31);
var HERO_HEAT_TOKEN_BASES = [0, 12000000, 52000000, 142000000, 275700000];

function heroHeatDate(index) {
  return new Date(HERO_HEAT_END_DATE - (HERO_HEAT_CELL_COUNT - 1 - index) * 86400000)
    .toISOString()
    .slice(0, 10);
}

function heroHeatTokens(index, level) {
  if (!level) return 0;
  var variance = ((index * 17 + level * 23) % 15 - 7) / 100;
  return Math.round((HERO_HEAT_TOKEN_BASES[level] * (1 + variance)) / 100000) * 100000;
}

var HERO_HEAT_CELLS = Array.from({ length: HERO_HEAT_CELL_COUNT }, function heatCell(_, index) {
  var level = heroHeatLevel(index);
  return { date: heroHeatDate(index), level: level, tokens: heroHeatTokens(index, level) };
});

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function easeOutQuart(value) {
  return 1 - Math.pow(1 - value, 4);
}

function formatHeroCompact(value) {
  var absolute = Math.abs(value);
  if (absolute >= 1000000000) return `${(value / 1000000000).toFixed(1)}B`;
  if (absolute >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (absolute >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

function AnimatedNumber({ value, currency = false, format }) {
  var valueRef = useRef(value);
  var frameRef = useRef(0);
  var [displayValue, setDisplayValue] = useState(value);

  useEffect(function animateValue() {
    var from = valueRef.current;
    var to = value;
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (prefersReducedMotion() || from === to) {
      valueRef.current = to;
      setDisplayValue(to);
      return undefined;
    }

    var startedAt = performance.now();
    var duration = currency ? 620 : 1000;
    function frame(now) {
      var progress = Math.min(1, (now - startedAt) / duration);
      var next = from + (to - from) * easeOutQuart(progress);
      valueRef.current = next;
      setDisplayValue(next);
      if (progress < 1) frameRef.current = requestAnimationFrame(frame);
      else frameRef.current = 0;
    }
    frameRef.current = requestAnimationFrame(frame);
    return function cleanup() {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [currency, value]);

  if (currency) {
    return `$${Number(displayValue).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }
  if (format) return format(displayValue);
  return Math.round(displayValue).toLocaleString("en-US");
}

function ViewIcon({ id, className = "" }) {
  return <span className={`app-view-icon view-icon-${id} ${className}`.trim()} aria-hidden="true"></span>;
}

function HeroViewSwitcher() {
  var [open, setOpen] = useState(false);
  var rootRef = useRef(null);
  var closeTimerRef = useRef(0);

  function cancelClose() {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = 0;
  }
  function openMenu() {
    cancelClose();
    setOpen(true);
  }
  function closeMenu() {
    cancelClose();
    setOpen(false);
  }
  function scheduleClose() {
    cancelClose();
    closeTimerRef.current = window.setTimeout(function closeAfterPointerLeaves() {
      if (!rootRef.current || !rootRef.current.matches(":focus-within")) closeMenu();
    }, 160);
  }

  useEffect(function bindDismissal() {
    function onPointerDown(event) {
      if (open && rootRef.current && !rootRef.current.contains(event.target)) closeMenu();
    }
    function onKeyDown(event) {
      if (event.key === "Escape" && open) closeMenu();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return function cleanup() {
      cancelClose();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      className={`hero-dashboard-view-control ${open ? "is-open" : ""}`}
      ref={rootRef}
      onPointerEnter={cancelClose}
      onPointerLeave={scheduleClose}
      onFocus={cancelClose}
      onBlur={function closeAfterBlur(event) {
        if (!event.currentTarget.contains(event.relatedTarget)) closeMenu();
      }}
    >
      <button type="button" aria-label="Home view">
        <ViewIcon id="home" />
        <span>Home</span>
      </button>
      <button
        type="button"
        aria-label="Choose view"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerEnter={openMenu}
        onFocus={openMenu}
        onClick={openMenu}
      >
        <span className="hero-dashboard-chevron" aria-hidden="true"></span>
      </button>
      <div className="hero-dashboard-view-menu" role="menu" aria-hidden={!open}>
        {WIDGET_VIEWS.map(function renderView(view) {
          var active = view.id === "home";
          return (
            <button
              className={active ? "is-current" : ""}
              key={view.id}
              type="button"
              role="menuitem"
              onClick={closeMenu}
            >
              <ViewIcon id={view.id} />
              <span>{view.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HeroDashboard() {
  var [period, setPeriod] = useState("day");
  var [liveTick, setLiveTick] = useState(0);
  var [hoveredHeat, setHoveredHeat] = useState(null);
  var [focusedHeatIndex, setFocusedHeatIndex] = useState(0);
  var dashboardRef = useRef(null);
  var heatmapRef = useRef(null);
  var heatCellRefs = useRef([]);
  var heatTooltipRef = useRef(null);
  var periodData = HERO_PERIODS[period];
  var periodIndex = HERO_PERIOD_IDS.indexOf(period);
  var liveTotal = periodData.total + liveTick * HERO_LIVE_STEP;
  var liveCost = periodData.cost + liveTick * HERO_LIVE_STEP * HERO_COST_PER_TOKEN;

  useEffect(function startLiveTicker() {
    if (prefersReducedMotion()) return undefined;
    var timer = window.setInterval(function advanceLiveSample() {
      setLiveTick(function incrementLiveTick(value) { return value + 1; });
    }, HERO_LIVE_INTERVAL_MS);
    return function cleanupLiveTicker() {
      window.clearInterval(timer);
    };
  }, []);

  function selectPeriod(id) {
    if (HERO_PERIODS[id]) setPeriod(id);
  }

  function updateHeatTooltip(index, target) {
    var dashboard = dashboardRef.current;
    var tooltip = heatTooltipRef.current;
    if (!dashboard || !target || !tooltip) return;
    var dashboardRect = dashboard.getBoundingClientRect();
    var cellRect = target.getBoundingClientRect();
    var tooltipRect = tooltip.getBoundingClientRect();
    var gap = 9;
    var pad = 6;
    var desiredX = cellRect.left + cellRect.width / 2;
    var minCenterX = dashboardRect.left + pad + tooltipRect.width / 2;
    var maxCenterX = dashboardRect.right - pad - tooltipRect.width / 2;
    var left = Math.max(
      minCenterX,
      Math.min(maxCenterX, desiredX),
    );
    var aboveTop = cellRect.top - tooltipRect.height - gap;
    var belowTop = cellRect.bottom + gap;
    var minTop = dashboardRect.top + pad;
    var maxTop = dashboardRect.bottom - pad - tooltipRect.height;
    var aboveFits = aboveTop >= minTop;
    var belowFits = belowTop <= maxTop;
    var top = aboveFits
      ? aboveTop
      : belowFits
        ? belowTop
        : Math.max(minTop, Math.min(maxTop, aboveTop));
    var placement = aboveFits ? "above" : "below";
    setHoveredHeat(function keepStablePosition(current) {
      if (current && current.index === index
        && Math.abs(current.left - left) < 0.5
        && Math.abs(current.top - top) < 0.5
        && current.placement === placement) return current;
      return { index: index, left: left, top: top, placement: placement };
    });
  }

  function hideHeatTooltip() {
    setHoveredHeat(null);
  }

  function handleHeatmapLeave() {
    if (!heatmapRef.current || !heatmapRef.current.contains(document.activeElement)) hideHeatTooltip();
  }

  function moveHeatFocus(index, event) {
    var row = index % 7;
    var column = Math.floor(index / 7);
    var next = index;
    if (event.key === "ArrowUp") next = row === 0 ? index + 6 : index - 1;
    else if (event.key === "ArrowDown") next = row === 6 ? index - 6 : index + 1;
    else if (event.key === "ArrowLeft") next = column === 0 ? 31 * 7 + row : index - 7;
    else if (event.key === "ArrowRight") next = column === 31 ? row : index + 7;
    else if (event.key === "Home") next = row;
    else if (event.key === "End") next = 31 * 7 + row;
    else return;
    event.preventDefault();
    setFocusedHeatIndex(next);
    var target = heatCellRefs.current[next];
    if (target) target.focus();
  }

  useEffect(function keepHeatTooltipAnchored() {
    if (!hoveredHeat) return undefined;
    function refreshPosition() {
      var target = heatCellRefs.current[hoveredHeat.index];
      if (target) updateHeatTooltip(hoveredHeat.index, target);
    }
    refreshPosition();
    window.addEventListener("resize", refreshPosition, { passive: true });
    window.addEventListener("scroll", refreshPosition, { passive: true });
    return function cleanup() {
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition);
    };
  }, [hoveredHeat ? hoveredHeat.index : -1, liveTick]);

  return (
    <div className="hero-dashboard" ref={dashboardRef} aria-label="Interactive Token Monitor Home dashboard">
      <header className="hero-dashboard-titlebar">
        <div className="hero-dashboard-mark" aria-label="Token Monitor">
          <span aria-hidden="true">Σ</span>
          <i aria-hidden="true"></i>
        </div>
        <div
          className="hero-dashboard-tabs"
          role="tablist"
          aria-label="Usage period"
          style={{ "--period-index": periodIndex }}
          onKeyDown={function movePeriod(event) {
            var direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!direction) return;
            event.preventDefault();
            var next = (periodIndex + direction + HERO_PERIOD_IDS.length) % HERO_PERIOD_IDS.length;
            selectPeriod(HERO_PERIOD_IDS[next]);
          }}
        >
          <i className="hero-dashboard-tab-indicator" aria-hidden="true"></i>
          {HERO_PERIOD_IDS.map(function renderPeriod(id) {
            var active = period === id;
            return (
              <button
                className={active ? "is-active" : ""}
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={function selectPeriodButton() { selectPeriod(id); }}
              >
                {id.toUpperCase()}
              </button>
            );
          })}
        </div>
      </header>

      <section className="hero-dashboard-total" aria-live="polite">
        <span>TOTAL TOKENS</span>
        <strong><AnimatedNumber value={liveTotal} /></strong>
        <small><AnimatedNumber value={liveCost} currency /></small>
      </section>

      <div className="hero-dashboard-rule"></div>

      <section className="hero-dashboard-module hero-dashboard-limits" aria-labelledby="hero-limits-title">
        <div className="hero-dashboard-module-head">
          <strong id="hero-limits-title">LIMITS</strong>
          <ViewIcon id="limits" />
        </div>
        {HERO_LIMITS.map(function renderLimit(row) {
          return (
            <div className="hero-dashboard-limit-row" key={row.id}>
              <div className="hero-dashboard-provider">
                <img src={`assets/icons/${row.id}.svg`} alt="" />
                <strong>{row.name}</strong>
              </div>
              <div className="hero-dashboard-windows">
                {row.windows.map(function renderWindow(window, index) {
                  return (
                    <div className="hero-dashboard-window" key={`${row.id}-${index}`}>
                      <span>{window.label}</span>
                      <strong>{window.value}</strong>
                      <small>{window.reset}</small>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </section>

      <div className="hero-dashboard-rule"></div>

      <section className="hero-dashboard-module" aria-labelledby="hero-devices-title">
        <div className="hero-dashboard-module-head">
          <strong id="hero-devices-title">DEVICES</strong>
          <ViewIcon id="device" />
        </div>
        {HERO_DEVICES.map(function renderDevice(device) {
          return (
            <div className="hero-dashboard-device-row" key={device.id}>
              <img src={device.icon} alt="" />
              <span className={device.you ? "hero-dashboard-device-label" : ""}>
                <span>{device.name}</span>
                {device.you ? <em>YOU</em> : null}
              </span>
              <strong><AnimatedNumber value={device.value + liveTick * HERO_LIVE_STEP * device.share} format={formatHeroCompact} /></strong>
            </div>
          );
        })}
      </section>

      <div className="hero-dashboard-rule"></div>

      <section className="hero-dashboard-module hero-dashboard-models" aria-labelledby="hero-models-title">
        <div className="hero-dashboard-module-head">
          <strong id="hero-models-title">MODELS</strong>
          <ViewIcon id="model" />
        </div>
        {HERO_MODELS.map(function renderModel(model, index) {
          return (
            <div className="hero-dashboard-model-row" key={`${model.name}-${index}`}>
              <img src={`assets/icons/${model.id}.svg`} alt="" />
              <span>{model.name}</span>
              <strong><AnimatedNumber value={model.value + liveTick * HERO_LIVE_STEP * model.share} format={formatHeroCompact} /></strong>
              <em>{model.shareLabel}</em>
            </div>
          );
        })}
      </section>

      <div className="hero-dashboard-rule"></div>

      <section className="hero-dashboard-module hero-dashboard-activity" aria-labelledby="hero-activity-title">
        <div className="hero-dashboard-module-head">
          <strong id="hero-activity-title">ACTIVITY</strong>
          <span className="hero-dashboard-activity-summary">121 active days <ViewIcon id="trends" /></span>
        </div>
        <div className="hero-dashboard-activity-scroll">
          <div className="hero-dashboard-activity-canvas">
            <div
              className="hero-dashboard-heatmap"
              ref={heatmapRef}
              role="group"
              aria-label="Token activity by day"
              onPointerLeave={handleHeatmapLeave}
            >
              {HERO_HEAT_CELLS.map(function renderHeat(cell, index) {
                var tooltipActive = hoveredHeat && hoveredHeat.index === index;
                var cellLabel = `${cell.date}: ${formatHeroCompact(cell.tokens)} tokens`;
                return (
                  <button
                    className={`hero-dashboard-heat-cell level-${cell.level}`}
                    key={cell.date}
                    ref={function keepHeatCellRef(node) { heatCellRefs.current[index] = node; }}
                    type="button"
                    tabIndex={focusedHeatIndex === index ? 0 : -1}
                    aria-label={cellLabel}
                    aria-describedby={tooltipActive ? "hero-activity-tooltip" : undefined}
                    onPointerEnter={function showHeatOnPointerEnter(event) { updateHeatTooltip(index, event.currentTarget); }}
                    onPointerMove={function moveHeatWithPointer(event) { updateHeatTooltip(index, event.currentTarget); }}
                    onFocus={function showHeatOnFocus(event) {
                      setFocusedHeatIndex(index);
                      updateHeatTooltip(index, event.currentTarget);
                    }}
                    onBlur={function hideHeatOnBlur(event) {
                      if (!heatmapRef.current || !heatmapRef.current.contains(event.relatedTarget)) hideHeatTooltip();
                    }}
                    onKeyDown={function moveHeatWithKeyboard(event) { moveHeatFocus(index, event); }}
                  ></button>
                );
              })}
            </div>
            <div className="hero-dashboard-months" aria-hidden="true">
              <span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span><span>Jul</span>
            </div>
          </div>
        </div>
        <div className="hero-dashboard-trend-head">
          <strong>TREND</strong>
          <span>Peak 430.2M</span>
        </div>
        <div className="hero-dashboard-trend" aria-hidden="true">
          <svg viewBox="0 0 360 74" preserveAspectRatio="none">
            <defs>
              <linearGradient id="hero-trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#78c7ff" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#78c7ff" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              className="hero-dashboard-trend-fill"
              d="M2 64 C10 70 14 20 23 46 S42 51 52 43 S67 56 79 35 S93 61 104 44 S116 55 128 39 S145 62 158 45 S176 58 188 34 S203 42 217 30 S232 55 245 32 S260 48 274 27 S291 54 306 39 S322 12 334 35 S348 8 358 29 L358 74 L2 74 Z"
            />
            <path
              className="hero-dashboard-trend-line"
              d="M2 64 C10 70 14 20 23 46 S42 51 52 43 S67 56 79 35 S93 61 104 44 S116 55 128 39 S145 62 158 45 S176 58 188 34 S203 42 217 30 S232 55 245 32 S260 48 274 27 S291 54 306 39 S322 12 334 35 S348 8 358 29"
            />
          </svg>
        </div>
        <div className="hero-dashboard-trend-dates" aria-hidden="true">
          <span>6/15</span><span>7/7</span><span>7/29</span>
        </div>
      </section>

      <footer className="hero-dashboard-footer">
        <HeroViewSwitcher />
        <button className="hero-dashboard-settings" type="button" aria-label="Settings">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.7 2.1h2.6l.4 1.4c.4.2.8.4 1.1.7l1.4-.4 1.3 2.2-1 1c0 .4 0 .9-.1 1.3l1 1-1.3 2.2-1.4-.4c-.3.3-.7.5-1.1.7l-.4 1.4H6.7l-.4-1.4c-.4-.2-.8-.4-1.1-.7l-1.4.4-1.3-2.2 1-1c-.1-.4-.1-.9 0-1.3l-1-1 1.3-2.2 1.4.4c.3-.3.7-.5 1.1-.7l.4-1.4Z" />
            <circle cx="8" cy="7.65" r="2.1" />
          </svg>
        </button>
      </footer>
      {typeof document !== "undefined" ? createPortal(
        <div
          id="hero-activity-tooltip"
          ref={heatTooltipRef}
          className={`hero-dashboard-heat-tooltip is-${hoveredHeat ? hoveredHeat.placement : "hidden"}`}
          data-visible={hoveredHeat ? "true" : "false"}
          aria-hidden={hoveredHeat ? "false" : "true"}
          role="tooltip"
          style={hoveredHeat ? { left: `${hoveredHeat.left}px`, top: `${hoveredHeat.top}px` } : undefined}
        >
          <span className="hero-dashboard-heat-tooltip-row">
            <strong>{formatHeroCompact(HERO_HEAT_CELLS[hoveredHeat ? hoveredHeat.index : 0].tokens)}</strong>
            <span>tokens</span>
          </span>
          <span className="hero-dashboard-heat-tooltip-date">
            {HERO_HEAT_CELLS[hoveredHeat ? hoveredHeat.index : 0].date}
          </span>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

var islandRegistry = {
  "dark-veil": function mountDarkVeil(node) {
    createRoot(node).render(<DarkVeil />);
  },
  "side-rays": function mountSideRays(node) {
    createRoot(node).render(<SideRays />);
  },
  "hero-dashboard": function mountHeroDashboard(node) {
    createRoot(node).render(<HeroDashboard />);
  }
};

document.querySelectorAll("[data-react-island]").forEach(function mount(node) {
  var name = node.getAttribute("data-react-island");
  if (islandRegistry[name]) islandRegistry[name](node);
});
