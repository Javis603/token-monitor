// @ts-check
'use strict';

(function exposeActivitySkyline3d(root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  /** @type {any} */
  const win = root;
  const api = factory();
  if (isNode) module.exports = api;
  if (win) win.TokenMonitorActivitySkyline3D = api;
})(typeof window !== 'undefined' ? window : null, function createActivitySkyline3dApi() {
  const MIN_PITCH = 0.22;
  const MAX_PITCH = 1.34;
  const MIN_ZOOM = 0.65;
  const MAX_ZOOM = 2.35;

  const MAX_H = 3.55;
  const MIN_H = 0.52;
  const PAD_H = 0.14;
  const HALF_S = 0.39;
  const PIVOT_Y = 1.2;
  const MAX_PAN_X = 320;
  const MAX_PAN_Y = 200;
  const ORBIT_YAW_SPEED = 0.0055;
  const ORBIT_PITCH_SPEED = 0.0048;

  /** @type {Record<string, { yaw: number, pitch: number, zoom: number, panX: number, panY: number }>} */
  const CAMERA_PRESETS = {
    iso: { yaw: 0.26, pitch: 0.54, zoom: 1.0, panX: 0, panY: 0 },
    skyline: { yaw: 0.22, pitch: 0.26, zoom: 1.12, panX: 0, panY: 0 },
    top: { yaw: 0.04, pitch: 1.24, zoom: 1.0, panX: 0, panY: 0 }
  };

  /** @type {Array<{ topA: number, topB: number, zA: number, zB: number, xA: number, xB: number } | null>} */
  const CRYSTAL_LEVELS = [
    null,
    { topA: 0.48, topB: 0.30, zA: 0.32, zB: 0.14, xA: 0.20, xB: 0.08 },
    { topA: 0.78, topB: 0.54, zA: 0.56, zB: 0.28, xA: 0.38, xB: 0.18 },
    { topA: 0.96, topB: 0.80, zA: 0.78, zB: 0.44, xA: 0.56, xB: 0.30 },
    { topA: 1.00, topB: 0.92, zA: 0.90, zB: 0.58, xA: 0.68, xB: 0.38 }
  ];

  /**
   * @typedef {{
   *   date: string,
   *   col: number,
   *   row: number,
   *   intensity?: number,
   *   tokens?: number,
   *   cost?: number,
   *   val?: number,
   *   topClient?: { id?: string, label?: string, color?: string } | null
   * }} SkylineCellInput
   */

  /**
   * @typedef {{ yaw: number, pitch: number, zoom: number, panX?: number, panY?: number }} CameraState
   */

  /**
   * @param {number} value
   * @param {number} min
   * @param {number} max
   */
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** @param {number} yaw */
  function normalizeYaw(yaw) {
    let y = Number(yaw) || 0;
    while (y > Math.PI) y -= Math.PI * 2;
    while (y < -Math.PI) y += Math.PI * 2;
    return y;
  }

  /** @param {Partial<CameraState>} [cam] */
  function clampCamera(cam = {}) {
    const rawPanX = typeof cam.panX === 'number' && Number.isFinite(cam.panX) ? cam.panX : 0;
    const rawPanY = typeof cam.panY === 'number' && Number.isFinite(cam.panY) ? cam.panY : 0;
    const zoom = clamp(Number.isFinite(cam.zoom) ? Number(cam.zoom) : CAMERA_PRESETS.iso.zoom, MIN_ZOOM, MAX_ZOOM);
    const panScale = Math.max(1, zoom);
    const maxPanX = Math.round(MAX_PAN_X * panScale);
    const maxPanY = Math.round(MAX_PAN_Y * panScale);
    return {
      yaw: normalizeYaw(cam.yaw ?? CAMERA_PRESETS.iso.yaw),
      pitch: clamp(Number.isFinite(cam.pitch) ? Number(cam.pitch) : CAMERA_PRESETS.iso.pitch, MIN_PITCH, MAX_PITCH),
      zoom,
      panX: clamp(rawPanX, -maxPanX, maxPanX),
      panY: clamp(rawPanY, -maxPanY, maxPanY)
    };
  }

  /**
   * Applies trackball/turntable drag deltas matching Three.js OrbitControls:
   * dragging right moves front geometry right, dragging down tilts downward.
   *
   * @param {Partial<CameraState>} cam
   * @param {number} dx
   * @param {number} dy
   */
  function applyOrbitDelta(cam, dx, dy) {
    const dYaw = -Number(dx || 0) * ORBIT_YAW_SPEED;
    const dPitch = Number(dy || 0) * ORBIT_PITCH_SPEED;
    return {
      camera: clampCamera({
        ...cam,
        yaw: (Number(cam?.yaw) || 0) + dYaw,
        pitch: (Number(cam?.pitch) || 0) + dPitch
      }),
      dYaw,
      dPitch
    };
  }

  /**
   * Unscaled camera-space perspective projection before viewport auto-fit.
   *
   * @param {number} wx
   * @param {number} wy
   * @param {number} wz
   * @param {CameraState} cam
   * @param {number} weeks
   */
  function projectUnit(wx, wy, wz, cam, weeks) {
    const cosY = Math.cos(cam.yaw);
    const sinY = Math.sin(cam.yaw);
    const cosP = Math.cos(cam.pitch);
    const sinP = Math.sin(cam.pitch);

    const x1 = wx * cosY - wz * sinY;
    const z1 = wx * sinY + wz * cosY;

    const py = wy - PIVOT_Y;
    const y2 = py * cosP - z1 * sinP;
    const z2 = py * sinP + z1 * cosP;

    const camDist = Math.max(96, weeks * 2.2);
    const depth = Math.max(8, camDist - z2);
    const p = camDist / depth;
    return { x: x1 * p, y: -y2 * p, depth, p };
  }

  /** @type {{ key: string, fit: { cx: number, cy: number, baseScale: number } } | null} */
  let cachedHeroFit = null;

  /**
   * Computes symmetric fixed bounding-box scale for `(width, height, weeks)` at `CAMERA_PRESETS.iso`
   * centered around `(0, PIVOT_Y, 0)` so 360° orbit rotates smoothly around its center without wobbling.
   *
   * @param {number} width
   * @param {number} height
   * @param {number} weeks
   */
  function heroViewportFit(width, height, weeks) {
    const key = `${width}:${height}:${weeks}`;
    if (cachedHeroFit && cachedHeroFit.key === key) return cachedHeroFit.fit;

    const bx0 = -weeks / 2 - 0.5;
    const bx1 = weeks / 2 + 0.5;
    const bz0 = -4.0;
    const bz1 = 4.0;
    const heroCam = CAMERA_PRESETS.iso;
    const bounds = [
      [bx0, 0, bz0], [bx1, 0, bz0], [bx1, 0, bz1], [bx0, 0, bz1],
      [bx0, MAX_H, bz0], [bx1, MAX_H, bz0], [bx1, MAX_H, bz1], [bx0, MAX_H, bz1],
      [bx0, 0, 5.2], [bx1, 0, 5.2]
    ];

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y, z] of bounds) {
      const pt = projectUnit(x, y, z, heroCam, weeks);
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }

    const padX = Math.min(20, width * 0.04);
    const padTop = Math.min(14, height * 0.06);
    const padBot = Math.min(30, height * 0.11);
    const availW = Math.max(40, width - padX * 2);
    const availH = Math.max(40, height - padTop - padBot);
    const maxAbsX = Math.max(Math.abs(minX), Math.abs(maxX));
    const maxAbsY = Math.max(Math.abs(minY), Math.abs(maxY));
    const baseScale = Math.min(
      (availW * 0.5) / Math.max(1e-6, maxAbsX),
      (availH * 0.5) / Math.max(1e-6, maxAbsY)
    );
    const fit = {
      cx: width * 0.5,
      cy: padTop + availH * 0.5,
      baseScale
    };
    cachedHeroFit = { key, fit };
    return fit;
  }

  /**
   * Perspective projects world point `(wx, wy, wz)` where `wy` is elevation up,
   * `wx` is week axis, and `wx` / `wz` center the deck at `(0, PIVOT_Y, 0)`.
   *
   * @param {number} wx
   * @param {number} wy
   * @param {number} wz
   * @param {CameraState} cam
   * @param {{ width: number, height: number, weeks?: number }} viewport
   */
  function projectPoint(wx, wy, wz, cam, viewport) {
    const width = Math.max(1, Number(viewport?.width) || 640);
    const height = Math.max(1, Number(viewport?.height) || 310);
    const weeks = Math.max(1, Number(viewport?.weeks) || 53);

    const raw = projectUnit(wx, wy, wz, cam, weeks);
    const fit = heroViewportFit(width, height, weeks);
    const scale = fit.baseScale * cam.zoom;

    return {
      x: fit.cx + raw.x * scale + Number(cam.panX || 0),
      y: fit.cy + raw.y * scale + Number(cam.panY || 0),
      depth: raw.depth,
      scale: raw.p * scale
    };
  }

  /**
   * Analytic back-face culling for axis-aligned vertical box walls under `projectPoint`.
   *
   * @param {number} yaw
   * @returns {{ zFace: '+z' | '-z', xFace: '+x' | '-x' }}
   */
  function visibleSideFaces(yaw) {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    return {
      zFace: cosY >= 0 ? '+z' : '-z',
      xFace: sinY >= 0 ? '+x' : '-x'
    };
  }

  /**
   * Computes camera-space depth of a point `(wx, wy, wz)` for painter's sort.
   * Larger depth means farther from camera.
   *
   * @param {number} wx
   * @param {number} wy
   * @param {number} wz
   * @param {CameraState} cam
   * @param {number} weeks
   */
  function cameraDepth(wx, wy, wz, cam, weeks = 53) {
    const cosY = Math.cos(cam.yaw);
    const sinY = Math.sin(cam.yaw);
    const cosP = Math.cos(cam.pitch);
    const sinP = Math.sin(cam.pitch);
    const z1 = wx * sinY + wz * cosY;
    const py = wy - PIVOT_Y;
    const z2 = py * sinP + z1 * cosP;
    const camDist = Math.max(96, weeks * 2.2);
    return camDist - z2;
  }

  /**
   * Sorts tower descriptors strictly back-to-front (largest depth first).
   *
   * @template {{ wx: number, wz: number, wy?: number }} T
   * @param {T[]} towers
   * @param {CameraState} cam
   * @param {number} [weeks]
   * @returns {T[]}
   */
  function sortTowersBackToFront(towers, cam, weeks = 53) {
    return towers
      .map((tower) => ({
        tower,
        depth: cameraDepth(tower.wx, Number(tower.wy || 0), tower.wz, cam, weeks)
      }))
      .sort((a, b) => b.depth - a.depth)
      .map((entry) => entry.tower);
  }

  /**
   * Point-in-convex/simple polygon test via ray casting.
   *
   * @param {number} px
   * @param {number} py
   * @param {Array<[number, number]>} polygon
   */
  function pointInPolygon(px, py, polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0];
      const yi = polygon[i][1];
      const xj = polygon[j][0];
      const yj = polygon[j][1];
      const intersect = (yi > py) !== (yj > py)
        && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Tests front-to-back polygon groups ordered farthest-to-nearest during paint,
   * returning the data payload of the topmost (last-painted) matching target.
   *
   * @template T
   * @param {number} px
   * @param {number} py
   * @param {Array<{ polygons: Array<Array<[number, number]>>, item: T }>} paintedTargets
   * @returns {T | null}
   */
  function hitTestPolygons(px, py, paintedTargets) {
    for (let i = paintedTargets.length - 1; i >= 0; i -= 1) {
      const target = paintedTargets[i];
      for (const poly of target.polygons) {
        if (pointInPolygon(px, py, poly)) return target.item;
      }
    }
    return null;
  }

  /**
   * @param {string} colorStr
   * @returns {[number, number, number] | null}
   */
  function parseColorRgb(colorStr) {
    const raw = String(colorStr || '').trim();
    const hex = /^#([0-9a-fA-F]{6})$/.exec(raw);
    if (hex) {
      return [
        parseInt(hex[1].slice(0, 2), 16),
        parseInt(hex[1].slice(2, 4), 16),
        parseInt(hex[1].slice(4, 6), 16)
      ];
    }
    const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(raw);
    if (rgb) {
      return [
        Math.round(Number(rgb[1]) || 0),
        Math.round(Number(rgb[2]) || 0),
        Math.round(Number(rgb[3]) || 0)
      ];
    }
    const triplet = /^\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*$/.exec(raw);
    if (triplet) {
      return [
        Math.round(Number(triplet[1]) || 0),
        Math.round(Number(triplet[2]) || 0),
        Math.round(Number(triplet[3]) || 0)
      ];
    }
    return null;
  }

  /**
   * @param {[number, number, number]} rgb
   * @param {number} amount
   */
  function mixWhite(rgb, amount) {
    const t = clamp(amount, 0, 1);
    return /** @type {[number, number, number]} */ ([
      Math.round(rgb[0] + (255 - rgb[0]) * t),
      Math.round(rgb[1] + (255 - rgb[1]) * t),
      Math.round(rgb[2] + (255 - rgb[2]) * t)
    ]);
  }

  /**
   * @param {[number, number, number]} rgb
   * @param {number} factor
   */
  function scaleRgb(rgb, factor) {
    return /** @type {[number, number, number]} */ ([
      Math.round(clamp(rgb[0] * factor, 0, 255)),
      Math.round(clamp(rgb[1] * factor, 0, 255)),
      Math.round(clamp(rgb[2] * factor, 0, 255))
    ]);
  }

  /**
   * @param {[number, number, number]} rgb
   * @param {number} [alpha]
   */
  function rgba(rgb, alpha = 1) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(alpha, 0, 1).toFixed(3)})`;
  }

  /**
   * @param {[number, number, number]} a
   * @param {[number, number, number]} b
   * @param {number} t
   */
  function lerpRgb(a, b, t) {
    return /** @type {[number, number, number]} */ ([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t
    ]);
  }

  /**
   * Mounts an interactive Orbital 3D Glass Skyline canvas inside `hostEl`.
   *
   * @param {HTMLElement} hostEl
   * @param {{
   *   onHover?: (hit: { cell: SkylineCellInput, anchorRect: { left: number, top: number, bottom: number, width: number, height: number } } | null) => void,
   *   onSelect?: (cell: SkylineCellInput) => void,
   *   onInteract?: () => void
   * }} [callbacks]
   */
  function createSkylineController(hostEl, callbacks = {}) {
    const doc = hostEl?.ownerDocument;
    if (!hostEl || !doc) return null;

    const canvas = doc.createElement('canvas');
    canvas.className = 'dash-skyline-canvas';
    canvas.setAttribute('aria-hidden', 'false');
    hostEl.replaceChildren(canvas);

    const rawCtx = canvas.getContext('2d');
    if (!rawCtx) return null;
    /** @type {CanvasRenderingContext2D} */
    const ctx = rawCtx;

    let camera = { ...CAMERA_PRESETS.iso };
    let targetCamera = { ...CAMERA_PRESETS.iso };
    let presetActive = true;
    let velYaw = 0;
    let velPitch = 0;
    /** @type {'orbit' | 'pan' | null} */
    let dragMode = null;
    let dragMoved = false;
    let downX = 0;
    let downY = 0;
    let lastX = 0;
    let lastY = 0;
    let lastMoveTs = 0;

    let hoveredDate = '';
    let peakDate = '';
    let weeks = 53;
    let metric = 'cost';
    let colorMode = 'heat';
    let reducedMotion = false;
    /** @type {(m: any) => string} */
    let monthLabelFn = (m) => String(m?.label || '');
    /** @type {any[]} */
    let monthLabels = [];

    /** @type {Map<string, any>} */
    const towerStateByDate = new Map();
    /** @type {any[]} */
    let activeTowers = [];
    /** @type {Array<{ polygons: Array<Array<[number, number]>>, item: any }>} */
    let lastPaintedTargets = [];

    let width = Math.max(1, hostEl.clientWidth || 640);
    let height = Math.max(1, hostEl.clientHeight || 312);
    let dpr = Math.min(2.5, Math.max(1, Number(doc.defaultView?.devicePixelRatio) || 1));

    let themeCache = readThemePalette();
    let frameId = 0;
    let lastTs = 0;
    let destroyed = false;

    function readThemePalette() {
      const style = doc.defaultView?.getComputedStyle?.(doc.documentElement);
      /**
       * @param {string} varName
       * @param {[number, number, number]} fallback
       * @returns {[number, number, number]}
       */
      const rgbOr = (varName, fallback) => parseColorRgb(style?.getPropertyValue(varName) || '') || fallback;
      const lineRgb = rgbOr('--line-rgb', [255, 255, 255]);
      const overlayRgb = rgbOr('--overlay-rgb', [255, 255, 255]);
      const glassRgb = rgbOr('--glass-rgb', [18, 21, 28]);
      const heat1 = rgbOr('--chart-heat-1-rgb', [90, 170, 255]);
      const heat2 = rgbOr('--chart-heat-2-rgb', [120, 190, 255]);
      const heat3 = rgbOr('--chart-heat-3-rgb', [150, 210, 255]);
      const heat4 = rgbOr('--chart-heat-4-rgb', [180, 230, 255]);
      const bright1 = rgbOr('--chart-heat-bright-1-rgb', mixWhite(heat1, 0.18));
      const bright2 = rgbOr('--chart-heat-bright-2-rgb', mixWhite(heat2, 0.18));
      const bright3 = rgbOr('--chart-heat-bright-3-rgb', mixWhite(heat3, 0.18));
      const bright4 = rgbOr('--chart-heat-bright-4-rgb', mixWhite(heat4, 0.18));
      const textRgb = rgbOr('--text', [235, 241, 248]);
      const isLight = (glassRgb[0] * 0.299 + glassRgb[1] * 0.587 + glassRgb[2] * 0.114) > 140;
      const zeroRgb = /** @type {[number, number, number]} */ (isLight ? [168, 178, 192] : [48, 56, 68]);
      return {
        isLight,
        lineRgb,
        overlayRgb,
        glassRgb,
        textRgb,
        /** @type {Array<[number, number, number]>} */
        levels: [zeroRgb, heat1, heat2, heat3, heat4],
        /** @type {Array<[number, number, number]>} */
        brightLevels: [zeroRgb, bright1, bright2, bright3, bright4],
        bright4
      };
    }

    function syncCanvasSize() {
      const nextW = Math.max(1, Math.round(hostEl.clientWidth || 640));
      const nextH = Math.max(1, Math.round(hostEl.clientHeight || 312));
      const nextDpr = Math.min(2.5, Math.max(1, Number(doc.defaultView?.devicePixelRatio) || 1));
      if (canvas.width !== Math.round(nextW * nextDpr) || canvas.height !== Math.round(nextH * nextDpr)) {
        width = nextW;
        height = nextH;
        dpr = nextDpr;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        return true;
      }
      width = nextW;
      height = nextH;
      return false;
    }

    function requestFrame() {
      if (destroyed || frameId) return;
      frameId = requestAnimationFrame(tick);
    }

    /** @param {number} level @param {any} cell */
    function resolveTargetColor(level, cell) {
      if (level <= 0) return themeCache.levels[0];
      if (colorMode === 'tool' && cell?.topClient?.color) {
        const parsed = parseColorRgb(cell.topClient.color);
        if (parsed) {
          const lift = level >= 4 ? 0.16 : (level === 3 ? 0.06 : 0);
          return lift > 0 ? mixWhite(parsed, lift) : parsed;
        }
      }
      return themeCache.levels[clamp(level, 1, 4)] || themeCache.levels[4];
    }

    /**
     * @param {{
     *   cells?: SkylineCellInput[],
     *   monthLabels?: any[],
     *   weeks?: number,
     *   metric?: 'cost' | 'tokens' | string,
     *   colorMode?: 'heat' | 'tool' | string,
     *   reducedMotion?: boolean,
     *   animateEntry?: boolean,
     *   monthLabel?: (m: any) => string
     * }} data
     */
    function setData(data = {}) {
      syncCanvasSize();
      themeCache = readThemePalette();
      const cells = Array.isArray(data.cells) ? data.cells : [];
      weeks = Math.max(1, Number(data.weeks) || (cells.length ? Math.max(...cells.map((c) => Number(c.col) || 0)) + 1 : 53));
      metric = data.metric === 'tokens' ? 'tokens' : 'cost';
      colorMode = data.colorMode === 'tool' ? 'tool' : 'heat';
      reducedMotion = Boolean(data.reducedMotion);
      if (typeof data.monthLabel === 'function') monthLabelFn = data.monthLabel;
      monthLabels = Array.isArray(data.monthLabels) ? data.monthLabels : [];

      let maxVal = 0;
      let maxDate = '';
      for (const c of cells) {
        const val = metric === 'cost' ? Number(c.cost || 0) : Number(c.tokens || 0);
        if (val > maxVal) {
          maxVal = val;
          maxDate = c.date;
        }
      }
      peakDate = maxDate;

      const animateWave = Boolean(data.animateEntry) && !reducedMotion;

      const nextList = [];
      for (const c of cells) {
        const col = Number(c.col) || 0;
        const row = Number(c.row) || 0;
        const val = metric === 'cost' ? Number(c.cost || 0) : Number(c.tokens || 0);
        const level = clamp(Math.round(Number(c.intensity) || 0), 0, 4);
        const active = level > 0 || val > 0;
        const ratio = active
          ? (maxVal > 0 && val > 0 ? Math.min(1, val / maxVal) : Math.max(0.14, level / 4))
          : 0;
        const targetH = active ? MIN_H + Math.pow(ratio, 0.65) * (MAX_H - MIN_H) : PAD_H;
        const targetRgb = resolveTargetColor(level, c);

        let entry = towerStateByDate.get(c.date);
        const wx = col + 0.5 - weeks / 2;
        const wz = row + 0.5 - 3.5;
        if (!entry) {
          entry = {
            date: c.date,
            col,
            row,
            wx,
            wz,
            wy: 0,
            currentH: reducedMotion || !animateWave ? targetH : PAD_H,
            targetH,
            currentRgb: targetRgb.slice(),
            targetRgb,
            hoverMix: 0,
            delayMs: animateWave ? (col / Math.max(1, weeks)) * 220 : 0,
            level,
            active,
            cell: c
          };
          towerStateByDate.set(c.date, entry);
        } else {
          entry.col = col;
          entry.row = row;
          entry.wx = wx;
          entry.wz = wz;
          entry.level = level;
          entry.active = active;
          entry.cell = c;
          entry.targetH = targetH;
          entry.targetRgb = targetRgb;
          if (animateWave) {
            entry.currentH = PAD_H;
            entry.delayMs = (col / Math.max(1, weeks)) * 220;
          }
          if (reducedMotion) {
            entry.currentH = targetH;
            entry.currentRgb = targetRgb.slice();
            entry.delayMs = 0;
          }
        }
        nextList.push(entry);
      }

      activeTowers = nextList;
      if (reducedMotion) drawFrame();
      else requestFrame();
    }

    function clearHover({ notify = true } = {}) {
      if (hoveredDate) {
        hoveredDate = '';
        drawFrame();
      }
      if (notify) callbacks.onHover?.(null);
    }

    /** @param {string} name */
    function setPreset(name) {
      const preset = CAMERA_PRESETS[name] || CAMERA_PRESETS.iso;
      targetCamera = clampCamera(preset);
      presetActive = true;
      velYaw = 0;
      velPitch = 0;
      clearHover();
      if (reducedMotion) {
        camera = { ...targetCamera };
        drawFrame();
      } else {
        requestFrame();
      }
    }

    /** @param {number} zoom */
    function panLimits(zoom) {
      const z = Math.max(1, Number(zoom) || 1);
      const panScale = z;
      return {
        limX: Math.min(Math.round(MAX_PAN_X * panScale), Math.round(width * (0.42 + (z - 1) * 0.52))),
        limY: Math.min(Math.round(MAX_PAN_Y * panScale), Math.round(height * (0.42 + (z - 1) * 0.52)))
      };
    }

    /** @param {number} delta */
    function zoomBy(delta) {
      const base = presetActive ? targetCamera : camera;
      const clampedZoom = clampCamera({ ...base, zoom: base.zoom + delta });
      const { limX, limY } = panLimits(clampedZoom.zoom);
      targetCamera = clampCamera({
        ...clampedZoom,
        panX: clamp(Number(clampedZoom.panX || 0), -limX, limX),
        panY: clamp(Number(clampedZoom.panY || 0), -limY, limY)
      });
      presetActive = true;
      clearHover();
      if (reducedMotion) {
        camera = { ...targetCamera };
        drawFrame();
      } else {
        requestFrame();
      }
    }

    function resetCamera() {
      setPreset('iso');
    }

    function refreshTheme() {
      themeCache = readThemePalette();
      for (const tower of activeTowers) {
        tower.targetRgb = resolveTargetColor(tower.level, tower.cell);
        if (reducedMotion) tower.currentRgb = tower.targetRgb.slice();
      }
      requestFrame();
    }

    function resize() {
      if (syncCanvasSize()) drawFrame();
    }

    /**
     * @param {Array<[number, number]>} pts
     * @param {string | CanvasGradient} fillStyle
     * @param {string | null} [strokeStyle]
     * @param {number} [lineWidth]
     */
    function fillPoly(pts, fillStyle, strokeStyle = null, lineWidth = 0.7) {
      if (pts.length < 3) return;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = fillStyle;
      ctx.fill();
      if (strokeStyle) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      }
    }

    function drawFrame() {
      if (destroyed) return;
      syncCanvasSize();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const viewport = { width, height, weeks };
      const palette = themeCache;
      const hasHover = Boolean(hoveredDate && towerStateByDate.has(hoveredDate));
      const hoveredTower = hasHover ? towerStateByDate.get(hoveredDate) : null;

      // 1. Hairline Smoked-Glass Deck
      const bx0 = -weeks / 2 - 0.5;
      const bx1 = weeks / 2 + 0.5;
      const bz0 = -4.0;
      const bz1 = 4.0;

      const topCorners = [
        projectPoint(bx0, 0, bz0, camera, viewport),
        projectPoint(bx1, 0, bz0, camera, viewport),
        projectPoint(bx1, 0, bz1, camera, viewport),
        projectPoint(bx0, 0, bz1, camera, viewport)
      ];
      const topPts = topCorners.map((p) => /** @type {[number, number]} */ ([p.x, p.y]));
      const faces = visibleSideFaces(camera.yaw);

      const deckFill = palette.isLight
        ? 'rgba(18, 24, 38, 0.028)'
        : 'rgba(255, 255, 255, 0.022)';
      fillPoly(topPts, deckFill, rgba(palette.lineRgb, palette.isLight ? 0.12 : 0.09), 0.7);

      // Week grid lines & hover crosshair clipped cleanly to deck
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(topPts[0][0], topPts[0][1]);
      for (let i = 1; i < topPts.length; i += 1) ctx.lineTo(topPts[i][0], topPts[i][1]);
      ctx.closePath();
      ctx.clip();

      ctx.strokeStyle = rgba(palette.lineRgb, palette.isLight ? 0.07 : 0.045);
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let w = 0; w <= weeks; w += 4) {
        const wx = w - weeks / 2;
        const a = projectPoint(wx, 0, -3.5, camera, viewport);
        const b = projectPoint(wx, 0, 3.5, camera, viewport);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();

      if (hoveredTower) {
        const c0 = hoveredTower.wx - 0.42;
        const c1 = hoveredTower.wx + 0.42;
        const r0 = hoveredTower.wz - 0.42;
        const r1 = hoveredTower.wz + 0.42;
        const hlFill = rgba(palette.levels[3], 0.12);
        const rowStrip = [
          projectPoint(-weeks / 2, 0, r0, camera, viewport),
          projectPoint(weeks / 2, 0, r0, camera, viewport),
          projectPoint(weeks / 2, 0, r1, camera, viewport),
          projectPoint(-weeks / 2, 0, r1, camera, viewport)
        ].map((p) => /** @type {[number, number]} */ ([p.x, p.y]));
        const colStrip = [
          projectPoint(c0, 0, -3.5, camera, viewport),
          projectPoint(c1, 0, -3.5, camera, viewport),
          projectPoint(c1, 0, 3.5, camera, viewport),
          projectPoint(c0, 0, 3.5, camera, viewport)
        ].map((p) => /** @type {[number, number]} */ ([p.x, p.y]));
        fillPoly(rowStrip, hlFill);
        fillPoly(colStrip, hlFill);
      }
      ctx.restore();

      const sorted = sortTowersBackToFront(activeTowers, camera, weeks);

      // 2. Render 371 Luminous Smoked-Glass Jewel Cubes back-to-front
      /** @type {Array<{ polygons: Array<Array<[number, number]>>, item: any }>} */
      const paintedTargets = [];

      for (let i = 0; i < sorted.length; i += 1) {
        const t = sorted[i];
        const isHovered = hasHover && t.date === hoveredDate;
        const isDimmed = hasHover && !isHovered;
        const isPeak = Boolean(peakDate && t.date === peakDate && t.active);
        const lift = isHovered ? (t.active ? 0.24 : 0.08) : 0;
        const h = t.currentH + lift;

        const x0 = t.wx - HALF_S;
        const x1 = t.wx + HALF_S;
        const z0 = t.wz - HALF_S;
        const z1 = t.wz + HALF_S;

        const t0 = projectPoint(x0, h, z0, camera, viewport);
        const t1 = projectPoint(x1, h, z0, camera, viewport);
        const t2 = projectPoint(x1, h, z1, camera, viewport);
        const t3 = projectPoint(x0, h, z1, camera, viewport);

        const b0 = projectPoint(x0, 0, z0, camera, viewport);
        const b1 = projectPoint(x1, 0, z0, camera, viewport);
        const b2 = projectPoint(x1, 0, z1, camera, viewport);
        const b3 = projectPoint(x0, 0, z1, camera, viewport);

        /** @type {Array<[number, number]>} */
        const topPoly = [[t0.x, t0.y], [t1.x, t1.y], [t2.x, t2.y], [t3.x, t3.y]];

        /** @type {Array<[number, number]>} */
        const zPoly = faces.zFace === '+z'
          ? [[t3.x, t3.y], [t2.x, t2.y], [b2.x, b2.y], [b3.x, b3.y]]
          : [[t0.x, t0.y], [t1.x, t1.y], [b1.x, b1.y], [b0.x, b0.y]];

        /** @type {Array<[number, number]>} */
        const xPoly = faces.xFace === '+x'
          ? [[t1.x, t1.y], [t2.x, t2.y], [b2.x, b2.y], [b1.x, b1.y]]
          : [[t0.x, t0.y], [t3.x, t3.y], [b3.x, b3.y], [b0.x, b0.y]];

        const alphaScale = isDimmed ? (t.active ? 0.38 : 0.32) : 1;

        if (!t.active) {
          /** @type {[number, number, number]} */
          const padRgb = palette.isLight ? [100, 115, 135] : [255, 255, 255];
          const padZA = (palette.isLight ? 0.045 : 0.024) * alphaScale;
          const padXA = (palette.isLight ? 0.028 : 0.015) * alphaScale;
          const padTopA = (palette.isLight ? 0.085 : 0.045) * alphaScale;
          const padStrokeA = (isHovered ? 0.45 : (palette.isLight ? 0.08 : 0.06)) * alphaScale;
          fillPoly(zPoly, rgba(padRgb, padZA));
          fillPoly(xPoly, rgba(padRgb, padXA));
          fillPoly(topPoly, rgba(padRgb, padTopA), rgba(palette.lineRgb, padStrokeA), isHovered ? 0.9 : 0.4);
          const capCenter = projectPoint(t.wx, h, t.wz, camera, viewport);
          paintedTargets.push({
            polygons: [topPoly],
            item: { cell: t.cell, anchor: { x: capCenter.x, y: capCenter.y } }
          });
          continue;
        }

        const lvlIdx = clamp(t.level || 1, 1, 4);
        const crystal = CRYSTAL_LEVELS[lvlIdx] || CRYSTAL_LEVELS[4] || { topA: 1, topB: 0.92, zA: 0.9, zB: 0.58, xA: 0.68, xB: 0.38 };
        const baseRgb = /** @type {[number, number, number]} */ ([
          Math.round(t.currentRgb[0]),
          Math.round(t.currentRgb[1]),
          Math.round(t.currentRgb[2])
        ]);

        const zWallA = crystal.zA * alphaScale;
        const zWallB = crystal.zB * alphaScale;
        const xWallA = crystal.xA * alphaScale;
        const xWallB = crystal.xB * alphaScale;

        const zGrad = ctx.createLinearGradient(zPoly[0][0], zPoly[0][1], zPoly[3][0], zPoly[3][1]);
        zGrad.addColorStop(0, rgba(scaleRgb(baseRgb, 0.94), zWallA));
        zGrad.addColorStop(1, rgba(scaleRgb(baseRgb, 0.88), zWallB));
        fillPoly(zPoly, zGrad);

        const xGrad = ctx.createLinearGradient(xPoly[0][0], xPoly[0][1], xPoly[3][0], xPoly[3][1]);
        xGrad.addColorStop(0, rgba(scaleRgb(baseRgb, 0.78), xWallA));
        xGrad.addColorStop(1, rgba(scaleRgb(baseRgb, 0.72), xWallB));
        fillPoly(xPoly, xGrad);

        const baseBright = colorMode === 'heat'
          ? (palette.brightLevels[lvlIdx] || mixWhite(baseRgb, 0.18))
          : mixWhite(baseRgb, 0.22);
        const topBright = isHovered ? mixWhite(baseBright, 0.28) : baseBright;
        const topA = (isHovered ? Math.min(1, crystal.topA + 0.1) : crystal.topA) * alphaScale;
        const topB = (isHovered ? Math.min(1, crystal.topB + 0.1) : crystal.topB) * alphaScale;
        const topGrad = ctx.createLinearGradient(t0.x, t0.y, t2.x, t2.y);
        topGrad.addColorStop(0, rgba(topBright, topA));
        topGrad.addColorStop(1, rgba(baseRgb, topB));
        fillPoly(topPoly, topGrad);

        if (t.level >= 3 || isHovered || isPeak) {
          const ridgeCornerA = faces.zFace === '+z'
            ? (faces.xFace === '+x' ? t3 : t2)
            : (faces.xFace === '+x' ? t0 : t1);
          const ridgeCornerMid = faces.zFace === '+z'
            ? (faces.xFace === '+x' ? t2 : t3)
            : (faces.xFace === '+x' ? t1 : t0);
          const ridgeCornerB = faces.zFace === '+z'
            ? (faces.xFace === '+x' ? t1 : t0)
            : (faces.xFace === '+x' ? t2 : t3);

          ctx.strokeStyle = isHovered
            ? 'rgba(255, 255, 255, 0.92)'
            : rgba([255, 255, 255], (t.level === 4 || isPeak ? 0.72 : 0.48) * alphaScale);
          ctx.lineWidth = isHovered ? 1.15 : 0.65;
          ctx.beginPath();
          ctx.moveTo(ridgeCornerA.x, ridgeCornerA.y);
          ctx.lineTo(ridgeCornerMid.x, ridgeCornerMid.y);
          ctx.lineTo(ridgeCornerB.x, ridgeCornerB.y);
          ctx.stroke();

          if (isHovered) {
            ctx.strokeStyle = rgba(palette.bright4, 0.9);
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.moveTo(t0.x, t0.y);
            ctx.lineTo(t1.x, t1.y);
            ctx.lineTo(t2.x, t2.y);
            ctx.lineTo(t3.x, t3.y);
            ctx.closePath();
            ctx.stroke();
          }
        }

        const capCenter = projectPoint(t.wx, h, t.wz, camera, viewport);
        paintedTargets.push({
          polygons: [topPoly, zPoly, xPoly],
          item: {
            cell: t.cell,
            anchor: {
              x: capCenter.x,
              y: Math.min(t0.y, t1.y, t2.y, t3.y)
            }
          }
        });
      }

      lastPaintedTargets = paintedTargets;

      // 3. Dynamic Floor Month Labels along whichever Z edge sits lower/closer on screen
      const midPlusZ = projectPoint(0, 0, bz1 + 0.85, camera, viewport);
      const midMinusZ = projectPoint(0, 0, bz0 - 0.85, camera, viewport);
      const labelZ = midPlusZ.y >= midMinusZ.y ? bz1 + 1.0 : bz0 - 1.0;

      const hoveredMonthPrefix = hoveredTower ? String(hoveredTower.date).slice(0, 7) : '';
      const rawFont = doc.defaultView?.getComputedStyle?.(hostEl)?.fontFamily || 'sans-serif';
      ctx.font = `500 10px ${rawFont}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';

      const projectedMonths = monthLabels.map((m) => {
        const wx = Number(m.col || 0) + 1.5 - weeks / 2;
        const p = projectPoint(wx, 0, labelZ, camera, viewport);
        return { m, p };
      });
      if (projectedMonths.length >= 2 && projectedMonths[0].p.x > projectedMonths[projectedMonths.length - 1].p.x) {
        projectedMonths.reverse();
      }
      let lastMonthScreenX = -Infinity;
      for (const entry of projectedMonths) {
        if (entry.p.x - lastMonthScreenX < 30) continue;
        lastMonthScreenX = entry.p.x;
        const activeMonth = hoveredMonthPrefix && String(entry.m.label || '') === hoveredMonthPrefix;
        ctx.fillStyle = activeMonth
          ? rgba(palette.textRgb, 0.94)
          : rgba(palette.lineRgb, palette.isLight ? 0.56 : 0.44);
        ctx.fillText(monthLabelFn(entry.m), entry.p.x, entry.p.y);
      }
    }

    /** @param {number} ts */
    function tick(ts) {
      frameId = 0;
      if (destroyed) return;
      const dtMs = lastTs ? Math.min(48, Math.max(4, ts - lastTs)) : 16;
      lastTs = ts;
      const dt = dtMs / 16.667;
      let needsMore = false;

      if (!dragMode) {
        if (presetActive) {
          const dyaw = Math.atan2(Math.sin(targetCamera.yaw - camera.yaw), Math.cos(targetCamera.yaw - camera.yaw));
          const dpitch = targetCamera.pitch - camera.pitch;
          const dzoom = targetCamera.zoom - camera.zoom;
          const dpanX = Number(targetCamera.panX || 0) - Number(camera.panX || 0);
          const dpanY = Number(targetCamera.panY || 0) - Number(camera.panY || 0);
          if (
            Math.abs(dyaw) > 0.0012
            || Math.abs(dpitch) > 0.0012
            || Math.abs(dzoom) > 0.0012
            || Math.abs(dpanX) > 0.4
            || Math.abs(dpanY) > 0.4
          ) {
            const ease = 1 - Math.pow(0.8, dt);
            camera = clampCamera({
              yaw: camera.yaw + dyaw * ease,
              pitch: camera.pitch + dpitch * ease,
              zoom: camera.zoom + dzoom * ease,
              panX: Number(camera.panX || 0) + dpanX * ease,
              panY: Number(camera.panY || 0) + dpanY * ease
            });
            needsMore = true;
          } else {
            camera = { ...targetCamera };
          }
        } else if (Math.abs(velYaw) > 0.0005 || Math.abs(velPitch) > 0.0005) {
          camera = clampCamera({
            yaw: camera.yaw + velYaw * dt,
            pitch: camera.pitch + velPitch * dt,
            zoom: camera.zoom,
            panX: camera.panX,
            panY: camera.panY
          });
          const damp = Math.pow(0.84, dt);
          velYaw *= damp;
          velPitch *= damp;
          if (Math.abs(velYaw) > 0.0005 || Math.abs(velPitch) > 0.0005) needsMore = true;
          else {
            velYaw = 0;
            velPitch = 0;
          }
        }
      }

      const hEase = 1 - Math.pow(0.82, dt);
      const cEase = 1 - Math.pow(0.82, dt);
      for (let i = 0; i < activeTowers.length; i += 1) {
        const t = activeTowers[i];
        if (t.delayMs > 0) {
          t.delayMs = Math.max(0, t.delayMs - dtMs);
          needsMore = true;
          continue;
        }
        const dh = t.targetH - t.currentH;
        if (Math.abs(dh) > 0.004) {
          t.currentH += dh * hEase;
          needsMore = true;
        } else {
          t.currentH = t.targetH;
        }
        const dc = Math.abs(t.targetRgb[0] - t.currentRgb[0])
          + Math.abs(t.targetRgb[1] - t.currentRgb[1])
          + Math.abs(t.targetRgb[2] - t.currentRgb[2]);
        if (dc > 1.5) {
          t.currentRgb = lerpRgb(t.currentRgb, t.targetRgb, cEase);
          needsMore = true;
        } else {
          t.currentRgb = t.targetRgb.slice();
        }
      }

      drawFrame();
      if (needsMore || dragMode) requestFrame();
      else lastTs = 0;
    }

    /** @param {PointerEvent} ev */
    function emitHoverAt(ev) {
      const rect = canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const hit = hitTestPolygons(px, py, lastPaintedTargets);
      const nextDate = hit?.cell?.date || '';
      if (nextDate !== hoveredDate) {
        hoveredDate = nextDate;
        drawFrame();
      }
      if (hit) {
        callbacks.onHover?.({
          cell: hit.cell,
          anchorRect: {
            left: rect.left + hit.anchor.x - 4,
            top: rect.top + hit.anchor.y - 2,
            bottom: rect.top + hit.anchor.y + 8,
            width: 8,
            height: 8
          }
        });
      } else {
        callbacks.onHover?.(null);
      }
    }

    /** @param {PointerEvent} ev */
    function onPointerDown(ev) {
      const isPan = ev.button === 2 || ev.button === 1 || (ev.button === 0 && ev.shiftKey);
      if (!isPan && ev.button !== 0) return;
      if (isPan) ev.preventDefault();
      dragMode = isPan ? 'pan' : 'orbit';
      dragMoved = false;
      presetActive = false;
      velYaw = 0;
      velPitch = 0;
      downX = ev.clientX;
      downY = ev.clientY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      lastMoveTs = ev.timeStamp || Date.now();
      hostEl.classList.toggle('is-panning', dragMode === 'pan');
      hostEl.classList.toggle('is-dragging', dragMode === 'orbit');
      canvas.setPointerCapture?.(ev.pointerId);
      if (hoveredDate) {
        hoveredDate = '';
        drawFrame();
      }
      callbacks.onHover?.(null);
      requestFrame();
    }

    /** @param {PointerEvent} ev */
    function onPointerMove(ev) {
      if (dragMode) {
        const dx = ev.clientX - lastX;
        const dy = ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;
        lastMoveTs = ev.timeStamp || Date.now();
        if (!dragMoved && Math.hypot(ev.clientX - downX, ev.clientY - downY) >= 4) {
          dragMoved = true;
          callbacks.onInteract?.();
        }
        if (dragMode === 'pan') {
          const { limX, limY } = panLimits(camera.zoom);
          camera = clampCamera({
            yaw: camera.yaw,
            pitch: camera.pitch,
            zoom: camera.zoom,
            panX: clamp(Number(camera.panX || 0) + dx, -limX, limX),
            panY: clamp(Number(camera.panY || 0) + dy, -limY, limY)
          });
          velYaw = 0;
          velPitch = 0;
        } else {
          const stepped = applyOrbitDelta(camera, dx, dy);
          camera = stepped.camera;
          velYaw = stepped.dYaw * 0.42;
          velPitch = stepped.dPitch * 0.38;
        }
        requestFrame();
        return;
      }
      emitHoverAt(ev);
    }

    /** @param {PointerEvent} ev */
    function onPointerUp(ev) {
      if (!dragMode) return;
      const wasMode = dragMode;
      dragMode = null;
      hostEl.classList.remove('is-dragging', 'is-panning');
      try { canvas.releasePointerCapture?.(ev.pointerId); } catch (_) {}
      const releaseTs = ev.timeStamp || Date.now();
      if (releaseTs - lastMoveTs > 55) {
        velYaw = 0;
        velPitch = 0;
      }
      if (!dragMoved && wasMode === 'orbit') {
        const rect = canvas.getBoundingClientRect();
        const hit = hitTestPolygons(ev.clientX - rect.left, ev.clientY - rect.top, lastPaintedTargets);
        if (hit?.cell) callbacks.onSelect?.(hit.cell);
        emitHoverAt(ev);
      } else {
        requestFrame();
      }
    }

    function onPointerLeave() {
      if (dragMode) return;
      if (hoveredDate) {
        hoveredDate = '';
        drawFrame();
      }
      callbacks.onHover?.(null);
    }

    function onDblClick() {
      callbacks.onInteract?.();
      resetCamera();
    }

    /** @param {MouseEvent} ev */
    function onContextMenu(ev) {
      ev.preventDefault();
    }

    /** @param {MouseEvent} ev */
    function onMouseDown(ev) {
      if (ev.button === 1) ev.preventDefault();
    }

    /** @param {MouseEvent} ev */
    function onAuxClick(ev) {
      if (ev.button === 1) ev.preventDefault();
    }

    /** @param {WheelEvent} ev */
    function onWheel(ev) {
      const base = presetActive ? targetCamera : camera;
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        callbacks.onInteract?.();
        const coeff = ev.ctrlKey && !ev.metaKey ? 0.01 : 0.0038;
        const delta = clamp(-ev.deltaY * coeff, -0.18, 0.18);
        const zoomed = clampCamera({ ...base, zoom: base.zoom + delta });
        const { limX, limY } = panLimits(zoomed.zoom);
        targetCamera = clampCamera({
          ...zoomed,
          panX: clamp(Number(zoomed.panX || 0), -limX, limX),
          panY: clamp(Number(zoomed.panY || 0), -limY, limY)
        });
        presetActive = false;
        camera = { ...targetCamera };
        clearHover();
        requestFrame();
        return;
      }

      const modeScale = ev.deltaMode === 1 ? 16 : (ev.deltaMode === 2 ? 120 : 1);
      const normX = (Number(ev.deltaX) || 0) * modeScale;
      const normY = (Number(ev.deltaY) || 0) * modeScale;
      const isZoomedIn = base.zoom > 1.02;
      const isHorizontal = Math.abs(normX) > Math.abs(normY) && Math.abs(normX) > 0;
      const isShiftPan = ev.shiftKey && (Math.abs(normX) > 0 || Math.abs(normY) > 0);
      if (!(isZoomedIn || isHorizontal || isShiftPan)) return;

      ev.preventDefault();
      callbacks.onInteract?.();
      const useShiftAxis = ev.shiftKey && Math.abs(normX) === 0;
      const dx = useShiftAxis ? -normY : -normX;
      const dy = isZoomedIn && !useShiftAxis ? -normY : 0;
      const { limX, limY } = panLimits(base.zoom);
      targetCamera = clampCamera({
        yaw: base.yaw,
        pitch: base.pitch,
        zoom: base.zoom,
        panX: clamp(Number(base.panX || 0) + dx, -limX, limX),
        panY: clamp(Number(base.panY || 0) + dy, -limY, limY)
      });
      presetActive = false;
      velYaw = 0;
      velPitch = 0;
      camera = { ...targetCamera };
      clearHover();
      requestFrame();
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('auxclick', onAuxClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    function destroy() {
      destroyed = true;
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('auxclick', onAuxClick);
      canvas.removeEventListener('wheel', onWheel);
      hostEl.classList.remove('is-dragging', 'is-panning');
      hostEl.replaceChildren();
    }

    return {
      setData,
      setPreset,
      zoomBy,
      resetCamera,
      refreshTheme,
      resize,
      destroy,
      getState: () => ({ camera: { ...camera }, hoveredDate, colorMode, metric, weeks })
    };
  }

  return {
    CAMERA_PRESETS,
    clampCamera,
    applyOrbitDelta,
    projectPoint,
    visibleSideFaces,
    sortTowersBackToFront,
    pointInPolygon,
    hitTestPolygons,
    createSkylineController
  };
});
