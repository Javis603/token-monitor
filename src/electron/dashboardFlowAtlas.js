// @ts-check
'use strict';

const path = require('node:path');

/** @typedef {{stroke:string,width:number}} AtlasStroke */
/** @typedef {{x:number,y:number,scale:number,width:number,height:number,d:string,strokes:AtlasStroke[],duration:number}} AtlasBeam */
/** @typedef {{png:string,left:number,top:number,width:number,height:number,columns:number,rows:number,frameCount:number,stop:number,step:number}} BeamAtlas */

const pathPattern = /^M-?\d+(\.\d+)?,-?\d+(\.\d+)? C-?\d+(\.\d+)?,-?\d+(\.\d+)? -?\d+(\.\d+)?,-?\d+(\.\d+)? -?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
const colorPattern = /^(?:#[\da-f]{3,8}|rgba?\([\d., %]+\)|color\(srgb [\d. %/]+\))$/i;

/** @param {unknown} input @returns {input is AtlasBeam[]} */
function validAtlasBatch(input) {
  if (!Array.isArray(input) || !input.length || input.length > 4) return false;
  let pixels = 0;
  for (const beam of input) {
    if (!beam || typeof beam !== 'object' ||
        ![beam.x, beam.y].every(value => Number.isFinite(value) && Math.abs(value) < 10000) ||
        !Number.isFinite(beam.scale) || beam.scale < .5 || beam.scale > 4 ||
        ![beam.width, beam.height].every(value => Number.isInteger(value) && value > 0 && value <= 1024) ||
        !Number.isFinite(beam.duration) || beam.duration < 1000 || beam.duration > 3000 ||
        typeof beam.d !== 'string' || beam.d.length > 140 || !pathPattern.test(beam.d) ||
        !Array.isArray(beam.strokes) || beam.strokes.length !== 4 ||
        !beam.strokes.every((/** @type {AtlasStroke} */ stroke) => stroke && typeof stroke.stroke === 'string' && stroke.stroke.length <= 90 &&
          colorPattern.test(stroke.stroke) && Number.isFinite(stroke.width) && stroke.width > 0 && stroke.width <= 10)) return false;
    pixels += beam.width * beam.height * 64;
  }
  return pixels <= 8 * 1024 * 1024;
}

/** @param {typeof import('electron').BrowserWindow} BrowserWindow */
function createDashboardFlowAtlasBuilder(BrowserWindow) {
  /** @type {import('electron').BrowserWindow | null} */
  let active = null;

  /** @param {unknown} input @param {import('electron').WebContents} owner @returns {Promise<(BeamAtlas|null)[] | null>} */
  return async function build(input, owner) {
    if (active || !validAtlasBatch(input) || owner.isDestroyed()) return null;
    const win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      webPreferences: {
        // The app uses process-per-site. An isolated, in-memory session gives
        // this temporary rasterizer its own renderer and image decode caches.
        partition: 'dashboard-flow-atlas',
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false
      }
    });
    active = win;
    const destroy = () => { if (!win.isDestroyed()) win.destroy(); };
    owner.once('destroyed', destroy);
    const timer = setTimeout(destroy, 5000);
    try {
      win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
      win.webContents.on('will-navigate', event => event.preventDefault());
      await win.loadFile(path.join(__dirname, 'renderer/dashboard/flowAtlasBuilder.html'));
      const beams = input.map(({x,y,scale,width,height,d,strokes,duration}) => ({
        x,y,scale,width,height,d,duration,strokes:strokes.map(({stroke,width}) => ({stroke,width}))
      }));
      return await win.webContents.executeJavaScript(`buildFlowAtlases(${JSON.stringify(beams)})`);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      owner.removeListener('destroyed', destroy);
      destroy();
      active = null;
    }
  };
}

module.exports = { createDashboardFlowAtlasBuilder, validAtlasBatch };
