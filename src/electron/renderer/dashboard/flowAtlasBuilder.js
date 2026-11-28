// @ts-check
'use strict';


const svgNamespace = 'http://www.w3.org/2000/svg';
const beamClasses = ['topo-edge-aura', 'topo-beam-tail', 'topo-beam-body', 'topo-beam-head'];
const filterNames = ['dashTopoAmbientGlow', 'dashTopoBeamGlow', 'dashTopoBeamGlow', null];
const animatedProperties = ['stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'opacity'];

/**
 * @typedef {{ stroke: string, width: number }} Stroke
 * @typedef {{ x: number, y: number, scale: number, width: number, height: number,
 *   d: string, strokes: Stroke[], duration: number }} Beam
 */

/** @param {string} markup @param {CanvasRenderingContext2D} context @param {number} x @param {number} y */
async function rasterBeamFrame(markup, context, x, y) {
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    context.drawImage(image, x, y);
  } finally {
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

/** @param {Beam} beam @param {string} filters */
async function renderBeamAtlas(beam, filters) {
  const svg = document.createElementNS(svgNamespace, 'svg');
  const group = document.createElementNS(svgNamespace, 'g');
  group.style.setProperty('--topo-phase-offset', '0ms');
  group.style.setProperty('--topo-hop-delay', '0ms');
  svg.style.setProperty('--topo-dur', `${beam.duration}ms`);
  svg.append(group);
  const paths = beamClasses.map((name, index) => {
    const shape = document.createElementNS(svgNamespace, 'path');
    shape.setAttribute('class', name);
    shape.setAttribute('d', beam.d);
    shape.setAttribute('stroke', beam.strokes[index].stroke);
    shape.setAttribute('stroke-width', String(beam.strokes[index].width));
    if (index > 0) shape.setAttribute('pathLength', '100');
    group.append(shape);
    return shape;
  });
  document.body.append(svg);

  const step = 1000 / 60;
  const stop = beam.duration * .3;
  const frameCount = Math.ceil(stop / step) + 1;
  const columns = Math.ceil(Math.sqrt(frameCount));
  const rows = Math.ceil(frameCount / columns);
  const sheet = document.createElement('canvas');
  sheet.width = beam.width * columns;
  sheet.height = beam.height * rows;
  const ctx = sheet.getContext('2d', {willReadFrequently:true});
  if (!ctx) throw new Error('Canvas unavailable');
  const frames = [];
  try {
    const animations = svg.getAnimations({ subtree: true });
    if (animations.length !== paths.length) throw new Error('Live Flow animations unavailable');
    for (const animation of animations) animation.pause();
    for (let i = 0; i < frameCount; i++) {
      const time = Math.min(i * step, stop);
      for (const animation of animations) animation.currentTime = time;
      const layers = paths.map((shape, index) => {
        const copy = /** @type {SVGPathElement} */ (shape.cloneNode(false));
        copy.removeAttribute('class');
        copy.setAttribute('fill', 'none');
        copy.setAttribute('stroke-linecap', 'round');
        const computed = getComputedStyle(shape);
        for (const property of animatedProperties) copy.setAttribute(property, computed.getPropertyValue(property));
        const filter = filterNames[index];
        if (filter) copy.setAttribute('filter', `url(#${filter})`);
        return copy.outerHTML;
      });
      const view = [beam.x, beam.y, beam.width / beam.scale, beam.height / beam.scale].join(' ');
      frames.push(`<svg xmlns="${svgNamespace}" width="${beam.width}" height="${beam.height}" viewBox="${view}">${filters}${layers.join('')}</svg>`);
    }
  } finally {
    svg.remove();
  }

  for (const [i, frame] of frames.entries()) {
    await rasterBeamFrame(frame, ctx, i % columns * beam.width, Math.floor(i / columns) * beam.height);
  }
  const pixels = ctx.getImageData(0, 0, sheet.width, sheet.height).data;
  let left = beam.width, top = beam.height, right = 0, bottom = 0;
  for (let y = 0, p = 3; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++, p += 4) {
      if (!pixels[p]) continue;
      const tx = x % beam.width, ty = y % beam.height;
      left = Math.min(left, tx); top = Math.min(top, ty);
      right = Math.max(right, tx + 1); bottom = Math.max(bottom, ty + 1);
    }
  }
  if (right <= left || bottom <= top) return null;
  // Leave a transparent pixel where possible so filtering cannot bleed into another cell.
  left = Math.max(0, left - 1); top = Math.max(0, top - 1);
  right = Math.min(beam.width, right + 1); bottom = Math.min(beam.height, bottom + 1);
  const width = right - left, height = bottom - top;
  const compact = document.createElement('canvas');
  compact.width = width * columns;
  compact.height = height * rows;
  const target = compact.getContext('2d', {willReadFrequently:true});
  if (!target) throw new Error('Canvas unavailable');
  for (let i = 0; i < frameCount; i++) {
    const col = i % columns, row = Math.floor(i / columns);
    target.drawImage(sheet, col * beam.width + left, row * beam.height + top, width, height, col * width, row * height, width, height);
  }
  sheet.width = sheet.height = 0;
  return { png: compact.toDataURL('image/png'), left, top, width, height, columns, rows, frameCount, stop, step };
}

/** @param {Beam[]} beams */
async function buildFlowAtlases(beams) {
  const filters = /** @type {{dashboardFlowAtlasFilters:string}} */ (/** @type {unknown} */ (window)).dashboardFlowAtlasFilters;
  const results = [];
  for (const beam of beams) results.push(await renderBeamAtlas(beam, filters));
  return results;
}

Object.assign(window, { buildFlowAtlases });
