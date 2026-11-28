// @ts-check
'use strict';

/**
 * Canvas light for the dashboard flow topology. The SVG keeps the static rails;
 * this layer sweeps a soft waveguide pulse along each live link on the same
 * document clock as the card sweeps (`--topo-dur`, animations pinned to
 * startTime 0), so the pulse hands over to each card's CSS border sweep.
 */
(function exposeTopologyBeams(root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  /** @type {any} */
  const win = root;
  const api = factory();
  if (isNode) module.exports = api;
  if (win) win.TokenMonitorTopologyBeams = api;
})(typeof window !== 'undefined' ? window : null, function createTopologyBeamsApi() {
  // Local-cycle timing: the crest leaves at 0 and reaches the receiving port at 0.22
  // (38% / 84% of --topo-dur after hop delays), then overshoots slightly during fade-out.
  const TRAVEL_END = 0.22;
  const FADE_IN_END = 0.025;
  const BEAM_END = 0.25;
  // Peak of waveProfile(u) sits at u = 0.5^(1/0.88); offset center so `crest` hits u = peak.
  const CREST_OFFSET = Math.pow(0.5, 1 / 0.88) - 0.5;
  const WHITE = [255, 255, 255];
  const BLACK = [0, 0, 0];

  /** @param {number} x */
  function mod1(x) {
    return ((x % 1) + 1) % 1;
  }

  /** @param {number} a @param {number} b @param {number} x */
  function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /**
   * CSS cubic-bezier(p1x, p1y, p2x, p2y) evaluated at progress t.
   * @param {number} p1x @param {number} p1y @param {number} p2x @param {number} p2y @param {number} t
   */
  function cubicBezierEase(p1x, p1y, p2x, p2y, t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 6; i++) {
      const iu = 1 - u;
      const x = 3 * iu * iu * u * p1x + 3 * iu * u * u * p2x + u * u * u;
      const dx = 3 * iu * iu * p1x + 6 * iu * u * (p2x - p1x) + 3 * u * u * (1 - p2x);
      if (Math.abs(dx) < 1e-6) break;
      u = Math.max(0, Math.min(1, u - (x - t) / dx));
    }
    const iu = 1 - u;
    return 3 * iu * iu * u * p1y + 3 * iu * u * u * p2y + u * u * u;
  }

  /** Pulse length multiplier for a live token rate. @param {number} rate */
  function waveLength(rate) {
    return 0.85 + 0.3 * smoothstep(0, 160, Math.max(0, Number(rate) || 0));
  }

  /** Brightness multiplier for a live token rate. @param {number} rate */
  function waveEnergy(rate) {
    return 0.82 + 0.3 * smoothstep(0, 160, Math.max(0, Number(rate) || 0));
  }

  /**
   * Pulse centre and envelope at local cycle phase `lp`. The crest reaches `length`
   * at `TRAVEL_END` (0.22) so short and long links arrive with their target card sweep,
   * then glides slightly past the port while fading out.
   * @param {number} lp
   * @param {number} length path length in px
   * @param {number} span pulse length in px
   */
  function waveState(lp, length, span) {
    if (!(lp > 0 && lp < BEAM_END)) return null;
    if (lp <= TRAVEL_END) {
      const eased = cubicBezierEase(0.32, 0.04, 0.22, 1, lp / TRAVEL_END);
      const crest = eased * length;
      return {
        center: crest - CREST_OFFSET * span,
        envelope: Math.max(0, Math.min(1, lp < FADE_IN_END ? lp / FADE_IN_END : 1))
      };
    }
    const t = (lp - TRAVEL_END) / (BEAM_END - TRAVEL_END);
    const overshoot = cubicBezierEase(0, 0, 0.58, 1, t) * span * 0.23;
    return {
      center: length + overshoot - CREST_OFFSET * span,
      envelope: Math.max(0, Math.min(1, 1 - t))
    };
  }

  /**
   * Skewed bell across the pulse: u = 0 at its trailing edge, 1 at its front.
   * @param {number} u
   */
  function waveProfile(u) {
    if (u <= 0 || u >= 1) return 0;
    return Math.pow(Math.sin(Math.PI * Math.pow(u, 0.88)), 1.65);
  }

  /** @param {string} value @returns {number[]} */
  function parseColor(value) {
    const text = String(value || '').trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(text);
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
    const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(text);
    if (rgb) return [rgb[1], rgb[2], rgb[3]].map((c) => Math.max(0, Math.min(255, Math.round(Number(c)))));
    return [106, 180, 240];
  }

  /** @param {number[]} a @param {number[]} b @param {number} t */
  function mix(a, b, t) {
    return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
  }

  /** @param {number[]} c @param {number} alpha */
  function rgba(c, alpha) {
    return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
  }

  /**
   * Arc-length table for the cubic used by layoutTopologyLinks.
   * @param {{ x: number, y: number }} p1
   * @param {{ x: number, y: number }} p2
   */
  function buildPathLut(p1, p2, steps = 48) {
    const dx = Math.max(24, (p2.x - p1.x) * 0.48);
    const c1 = { x: p1.x + dx, y: p1.y };
    const c2 = { x: p2.x - dx, y: p2.y };
    const pts = [];
    let length = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const it = 1 - t;
      const x = it * it * it * p1.x + 3 * it * it * t * c1.x + 3 * it * t * t * c2.x + t * t * t * p2.x;
      const y = it * it * it * p1.y + 3 * it * it * t * c1.y + 3 * it * t * t * c2.y + t * t * t * p2.y;
      const prev = pts[pts.length - 1];
      if (prev) length += Math.hypot(x - prev.x, y - prev.y);
      pts.push({ x, y, dist: length });
    }
    return { p1, p2, c1, c2, pts, length };
  }

  /** @param {ReturnType<typeof buildPathLut>} lut @param {number} dist */
  function pointAt(lut, dist) {
    const pts = lut.pts;
    if (dist <= 0) return pts[0];
    if (dist >= lut.length) return pts[pts.length - 1];
    let lo = 0;
    let hi = pts.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].dist <= dist) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const f = (dist - a.dist) / (b.dist - a.dist || 1);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, dist };
  }

  /**
   * Strokes the [d0, d1] slice with a gradient laid
   * from the slice's start to its end. Edges run left to right, so the chord
   * is a faithful stand-in for arc position over a short slice.
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof buildPathLut>} lut
   * @param {number} d0 @param {number} d1 @param {number} width
   * @param {Array<[number, string]>} stops
   */
  function strokeSlice(ctx, lut, d0, d1, width, stops) {
    if (d1 - d0 < 0.5) return;
    const n = Math.max(4, Math.min(24, Math.ceil((d1 - d0) / 3)));
    const a = pointAt(lut, d0);
    const b = pointAt(lut, d1);
    const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    for (const [pos, color] of stops) gradient.addColorStop(pos, color);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const p = pointAt(lut, d0 + (d1 - d0) * (i / n));
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = gradient;
    ctx.stroke();
  }

  /**
   * @typedef {{
   *   id: string,
   *   p1: { x: number, y: number },
   *   p2: { x: number, y: number },
   *   color: string,
   *   width: number,
   *   rate: number,
   *   delay: number,
   *   vis: number
   * }} BeamEdge
   */

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *   now?: () => number,
   *   edgeAlpha?: (id: string) => number,
   *   paused?: () => boolean,
   *   requestFrame?: (cb: FrameRequestCallback) => number,
   *   cancelFrame?: (id: number) => void
   * }} [options]
   */
  function createTopologyBeamRenderer(canvas, options = {}) {
    const now = options.now || (() => Number(document.timeline?.currentTime ?? performance.now()));
    const edgeAlpha = options.edgeAlpha || (() => 1);
    const paused = options.paused || (() => false);
    const requestFrame = options.requestFrame || ((cb) => requestAnimationFrame(cb));
    const cancelFrame = options.cancelFrame || ((id) => cancelAnimationFrame(id));
    const ctx = canvas.getContext('2d');
    /** @type {Array<any>} */
    let edges = [];
    let width = 0;
    let durationMs = 2900;
    let dark = true;
    let frame = 0;
    /** @type {ReturnType<typeof setTimeout> | 0} */
    let timer = 0;
    let painted = false;
    let inView = true;
    let destroyed = false;

    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          inView = entries.some((entry) => entry.isIntersecting);
          if (inView) start();
          else stop(false);
        })
      : null;
    observer?.observe(canvas);

    /**
     * @param {BeamEdge[]} nextEdges
     * @param {{ width: number, height: number, durationMs: number, dark: boolean, dpr?: number }} view
     */
    function update(nextEdges, view) {
      if (destroyed || !ctx) return;
      const dpr = Math.max(1, Math.min(3, view.dpr || 1));
      const pixelWidth = Math.round(view.width * dpr);
      const pixelHeight = Math.round(view.height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      width = view.width;
      durationMs = view.durationMs > 0 ? view.durationMs : 2900;
      dark = view.dark;
      edges = nextEdges.map((edge) => {
        const rgb = parseColor(edge.color);
        const rate = Math.max(0, Number(edge.rate) || 0);
        return {
          ...edge,
          rgb,
          lut: buildPathLut(edge.p1, edge.p2),
          lengthScale: waveLength(rate),
          energy: waveEnergy(rate),
          crest: dark ? WHITE : BLACK
        };
      });
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
      if (edges.length) start();
      else stop(true);
    }

    function start() {
      if (frame || timer || destroyed || !inView || !edges.length) return;
      frame = requestFrame(tick);
    }

    function stop(clear = false) {
      if (frame) cancelFrame(frame);
      if (timer) clearTimeout(timer);
      frame = 0;
      timer = 0;
      if (clear) clearCanvas();
    }

    function clearCanvas() {
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      painted = false;
    }

    /** Milliseconds until any link's next pulse begins; 0 while one is in flight. @param {number} timeMs */
    function msUntilNextWave(timeMs) {
      const cycle = timeMs / durationMs;
      let wait = Infinity;
      for (const edge of edges) {
        const lp = mod1(cycle - edge.delay);
        if (lp < BEAM_END) return 0;
        wait = Math.min(wait, (1 - lp) * durationMs);
      }
      return wait;
    }

    function tick() {
      frame = 0;
      if (destroyed || !inView || !canvas.isConnected) return;
      if (paused()) {
        stop(true);
        return;
      }
      const time = now();
      const idleMs = msUntilNextWave(time);
      if (idleMs > 0) {
        // Pulses occupy a quarter of each link's cycle; sleep through the gaps
        // instead of repainting an empty canvas every frame.
        if (painted) clearCanvas();
        timer = setTimeout(() => {
          timer = 0;
          start();
        }, Math.max(0, idleMs - 20));
        return;
      }
      draw(time);
      frame = requestFrame(tick);
    }

    /** @param {number} timeMs */
    function draw(timeMs) {
      if (!ctx) return;
      const dpr = width > 0 ? canvas.width / width : 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      const cycle = timeMs / durationMs;
      for (const edge of edges) {
        const alpha = edge.vis * edgeAlpha(edge.id);
        if (alpha <= 0.01) continue;
        ctx.globalAlpha = alpha;
        drawEdge(edge, cycle - edge.delay);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      painted = true;
    }

    /**
     * Waveguide sweep: stacked strokes from a wide faint halo to a bright crest,
     * all shaped by the same bell, give the pulse depth without a blur filter
     * (and so without a filter region to clip it).
     * The layers scale with the rail width, which encodes the link's share.
     * @param {any} edge @param {number} cycle
     */
    function drawEdge(edge, cycle) {
      if (!ctx) return;
      const { lut, rgb } = edge;
      const L = lut.length;
      const span = Math.max(54, L * 0.86) * edge.lengthScale;
      const wave = waveState(mod1(cycle), L, span);
      if (!wave) return;
      const start = wave.center - span / 2;
      const d0 = Math.max(0, start);
      const d1 = Math.min(L, wave.center + span / 2);
      if (d1 < d0 + 0.8) return;
      const env = wave.envelope * edge.energy;
      const rail = edge.width > 0 ? edge.width : 1.4;
      /** @type {number[]} */
      const profile = [];
      for (let i = 0; i <= 10; i++) profile.push(waveProfile((d0 + (d1 - d0) * (i / 10) - start) / span));
      /** @param {(w: number) => string} color @returns {Array<[number, string]>} */
      const stops = (color) => profile.map((w, i) => [i / 10, color(w)]);
      strokeSlice(ctx, lut, d0, d1, rail + 7, stops((w) => rgba(rgb, w * (dark ? 0.06 : 0.04) * env)));
      strokeSlice(ctx, lut, d0, d1, rail + 3.6, stops((w) => rgba(rgb, w * (dark ? 0.13 : 0.08) * env)));
      strokeSlice(ctx, lut, d0, d1, rail + 1, stops((w) => rgba(rgb, w * (dark ? 0.5 : 0.36) * env)));
      strokeSlice(ctx, lut, d0, d1, Math.max(1.25, rail * 0.75),
        stops((w) => rgba(mix(rgb, edge.crest, w * (dark ? 0.55 : 0.3)), w * (dark ? 0.95 : 0.88) * env)));
    }

    function destroy() {
      destroyed = true;
      stop(true);
      observer?.disconnect();
      edges = [];
    }

    return { canvas, update, stop, destroy, draw };
  }

  return {
    waveLength,
    waveEnergy,
    waveState,
    waveProfile,
    parseColor,
    buildPathLut,
    pointAt,
    createTopologyBeamRenderer
  };
});
