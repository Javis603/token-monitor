// @ts-check
'use strict';

const dashboardFlowAtlas = (() => {
  /** @typedef {import('../../dashboardFlowAtlas').AtlasBeam} AtlasBeam */
  /** @typedef {import('../../dashboardFlowAtlas').BeamAtlas} BeamAtlas */
  /** @typedef {{overlay:SVGForeignObjectElement, animation:Animation, bytes:number}} Playback */
  /** @typedef {{beam:AtlasBeam, edge:SVGGElement, delay:number, key:string, playback?:Playback, blockedBytes?:number}} Plan */
  /** @type {Map<SVGGElement, Plan>} */
  const current = new Map();
  /** @type {Set<Plan>} */
  const pending = new Set();
  const maxPlaybackBytes = 12 * 1024 * 1024;
  let playbackBytes = 0;
  let busy = false;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;

  /** @param {Plan} plan */
  function retire(plan) {
    current.delete(plan.edge);
    pending.delete(plan);
    if (!plan.playback) return;
    const {overlay, animation, bytes} = plan.playback;
    plan.playback = undefined;
    playbackBytes -= bytes;
    animation.cancel();
    overlay.remove();
    plan.edge.removeAttribute('data-atlas');
    for (const original of plan.edge.getAnimations({subtree:true})) {
      if ('animationName' in original) original.startTime = 0;
    }
  }

  function clear() {
    clearTimeout(timer);
    timer = undefined;
    for (const plan of current.values()) retire(plan);
  }

  /** @param {Plan} plan @param {BeamAtlas} atlas */
  async function prepare(plan, atlas) {
    const {width,height,rows,columns,frameCount,left,top,stop,step,png} = atlas;
    const {x,y,scale,duration} = plan.beam;
    const w = width / scale, h = height / scale;
    const image = new Image();
    image.src = png;
    await image.decode();
    // Keep the frames inside their SVG edge so cached and live links paint in the same order.
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    overlay.setAttribute('class', 'dash-topo-atlas-frame');
    overlay.dataset.edgeId = plan.edge.dataset.edgeId;
    overlay.setAttribute('x', String(x + left / scale));
    overlay.setAttribute('y', String(y + top / scale));
    overlay.setAttribute('width', String(w));
    overlay.setAttribute('height', String(h));
    Object.assign(image.style, {width:`${w * columns}px`, height:`${h * rows}px`});
    overlay.append(image);
    const frames = Array.from({length:frameCount}, (_,i) => ({
      offset: i ? (Math.min(i * step, stop) + (i - 1) * step) / (2 * duration) : 0,
      easing:'steps(1, end)',
      transform:`translate(${-(i % columns) * w}px,${-Math.floor(i / columns) * h}px)`
    }));
    frames.push({...frames[frames.length-1], offset:1});
    return {overlay,image,frames};
  }

  /** @param {(beams:AtlasBeam[]) => Promise<(BeamAtlas|null)[]|null>} build */
  function schedule(build) {
    if (timer !== undefined || busy || !pending.size) return;
    timer = setTimeout(async () => {
      timer = undefined;
      const plans = [...pending];
      pending.clear();
      if (!plans.length) return;
      busy = true;
      try {
        const atlases = await build(plans.map(plan => plan.beam));
        if (!atlases) return;
        for (const [index,plan] of plans.entries()) {
          const atlas = atlases[index];
          if (!atlas || current.get(plan.edge) !== plan) continue;
          const bytes = atlas.width * atlas.height * atlas.columns * atlas.rows * 4;
          if (playbackBytes + bytes > maxPlaybackBytes) {
            plan.blockedBytes = bytes;
            continue;
          }
          try {
            const {overlay,image,frames} = await prepare(plan, atlas);
            if (current.get(plan.edge) !== plan || !plan.edge.isConnected) continue;
            const animation = image.animate(frames, {duration:plan.beam.duration, delay:plan.delay, iterations:Infinity, fill:'both'});
            animation.startTime = 0;
            plan.edge.append(overlay);
            plan.edge.setAttribute('data-atlas', 'true');
            plan.playback = {overlay,animation,bytes};
            playbackBytes += bytes;
          } catch {
            // This edge keeps its live SVG if decoding or playback fails.
          }
        }
      } catch {
        // The live SVG stays in use if preparing an image or its worker fails.
      } finally {
        busy = false;
        schedule(build);
      }
    }, 180);
  }

  /**
   * @param {HTMLElement} canvas @param {SVGSVGElement} svg
   * @param {boolean} enabled @param {boolean} stagger
   * @param {(beams:AtlasBeam[]) => Promise<(BeamAtlas|null)[]|null>} build
   */
  function update(canvas, svg, enabled, stagger, build) {
    if (!enabled || !build) {
      if (current.size) clear();
      return;
    }
    const bounds = svg.getBoundingClientRect();
    const view = svg.viewBox.baseVal;
    const scale = Math.min(bounds.width / view.width, bounds.height / view.height) * devicePixelRatio;
    const duration = parseFloat(getComputedStyle(canvas).getPropertyValue('--topo-dur')) * 1000;
    /** @type {Plan[]} */
    const plans = [];
    let pixels = 0;
    for (const el of svg.querySelectorAll('.topo-edge.is-active:not(.is-offscreen)')) {
      if (plans.length === 4) break;
      const edge = /** @type {SVGGElement} */ (el);
      // Partially clipped links fade as a single SVG group, including the base.
      if (edge.style.getPropertyValue('--edge-vis') !== '1') continue;
      const paths = [...edge.querySelectorAll('.topo-edge-aura,.topo-beam-tail,.topo-beam-body,.topo-beam-head')];
      if (paths.length !== 4) continue;
      const shape = /** @type {SVGPathElement|null} */ (edge.querySelector('.topo-edge-base'));
      if (!shape) continue;
      const {x,y,width,height} = shape.getBBox();
      const left = Math.max(0,Math.floor(x-width*.4-18));
      const top = Math.max(0,Math.floor(y-height*.4-18));
      const right = Math.min(view.width,Math.ceil(x+width*1.4+18));
      const bottom = Math.min(view.height,Math.ceil(y+height*1.4+18));
      const w = Math.ceil((right-left)*scale);
      const h = Math.ceil((bottom-top)*scale);
      if (!Number.isFinite(w*h*duration) || w<=0 || h<=0 || w>1024 || h>1024 || pixels+w*h*64>8*1024*1024) continue;
      pixels += w*h*64;
      const phase = stagger ? Number(edge.dataset.flowPhase || 0) : 0;
      const beam = {x:left,y:top,width:w,height:h,scale,duration,d:shape.getAttribute('d') || '',
        strokes:paths.map(path=>({stroke:getComputedStyle(path).stroke,width:Number(path.getAttribute('stroke-width'))}))};
      const delay = duration * (phase + (edge.classList.contains('topo-edge--hop1') ? .16 : .62));
      const key = JSON.stringify([beam, delay]);
      plans.push({beam, edge, delay, key});
    }
    for (const plan of current.values()) {
      if (!plans.some(next => next.edge === plan.edge && next.key === plan.key)) retire(plan);
    }
    for (const plan of plans) {
      const retained = current.get(plan.edge);
      if (retained) {
        if (retained.blockedBytes && playbackBytes + retained.blockedBytes <= maxPlaybackBytes) {
          retained.blockedBytes = undefined;
          pending.add(retained);
        }
        continue;
      }
      current.set(plan.edge, plan);
      pending.add(plan);
    }
    schedule(build);
  }

  return {update,clear};
})();

Object.assign(window, { dashboardFlowAtlas });
