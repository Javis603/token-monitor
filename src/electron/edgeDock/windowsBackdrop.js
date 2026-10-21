'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function helperPathFor(app, resourcesPath = process.resourcesPath) {
  return app.isPackaged
    ? path.join(resourcesPath, 'windows-dock', 'TokenMonitor.DockBackdrop.exe')
    : path.resolve(__dirname, '../../..', 'build/windows-dock/TokenMonitor.DockBackdrop.exe');
}

// HostBackdrop is one native Windows material, independent of the main window's
// Acrylic/Accent choice. This service owns one helper, not one CLR per surface.
function createWindowsDockBackdrop({
  app, screen, logger = () => {}, platform = process.platform, release = os.release(),
  helperPath = helperPathFor(app), spawnHelper = spawn, exists = fs.existsSync
}) {
  const supported = platform === 'win32' && Number(release.split('.')[2]) >= 22000;
  const surfaces = new Map();
  let child = null;
  let ready = false;
  let failed = false;
  let nextId = 0;
  let startupTimer = null;
  let flushScheduled = false;
  let blocked = false;
  const pending = new Map();

  function fail(error) {
    if (failed) return;
    failed = true;
    ready = false;
    clearTimeout(startupTimer);
    pending.clear();
    const previous = child;
    child = null;
    previous?.stdin.destroy();
    previous?.kill();
    logger(`[edge-dock] Windows HostBackdrop unavailable: ${error.message}; using tinted surfaces`);
    for (const surface of surfaces.values()) surface.onMaterial(false);
  }

  function flush() {
    flushScheduled = false;
    if (!ready || !child || blocked) return;
    for (const [id, message] of pending) {
      pending.delete(id);
      try {
        if (!child.stdin.write(JSON.stringify(message) + '\n')) { blocked = true; break; }
      } catch (error) { fail(error); break; }
    }
  }

  function enqueue(id, message) {
    if (failed) return;
    pending.set(id, message);
    if (!flushScheduled) { flushScheduled = true; queueMicrotask(flush); }
  }

  function start() {
    if (child || failed) return;
    if (!supported || !exists(helperPath)) {
      fail(new Error(supported ? 'native helper is not built' : 'Windows 11 is required'));
      return;
    }
    try { child = spawnHelper(helperPath, [String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { fail(error); return; }
    const current = child;
    let buffer = '';
    let stderr = '';
    current.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2048); });
    current.stdin.on('error', (error) => { if (child === current) fail(error); });
    current.stdin.on('drain', () => { if (child === current) { blocked = false; flush(); } });
    current.on('error', (error) => { if (child === current) fail(error); });
    current.on('exit', (code) => {
      if (child === current) fail(new Error(`helper exited (${code})${stderr ? ': ' + stderr : ''}`));
    });
    current.stdout.on('data', (chunk) => {
      if (child !== current) return;
      buffer += chunk;
      if (buffer.length > 65536) { fail(new Error('invalid helper response')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready' && message.protocol === 1) {
            clearTimeout(startupTimer);
            ready = true;
            flush();
          } else if (message.type === 'attached') {
            const surface = surfaces.get(message.id);
            if (surface && !surface.win.isDestroyed()) surface.onMaterial(true);
          } else if (message.type === 'error') { fail(new Error(message.message)); return; }
          else throw new Error('unexpected helper response');
        } catch (error) { fail(error); return; }
      }
    });
    startupTimer = setTimeout(() => fail(new Error('helper startup timed out')), 5000);
    startupTimer.unref?.();
  }

  function stop() {
    clearTimeout(startupTimer);
    const previous = child;
    child = null;
    ready = false;
    blocked = false;
    // Retry only after every old surface is gone, never on live failed updates.
    failed = false;
    pending.clear();
    // EOF requests graceful native cleanup; kill is bounded if its UI thread
    // stopped responding. The helper also watches its parent independently.
    if (previous) {
      previous.stdin.end();
      const timer = setTimeout(() => previous.kill(), 1000);
      timer.unref?.();
      previous.once('exit', () => clearTimeout(timer));
    }
  }

  return {
    attach(win, onMaterial) {
      const id = String(++nextId);
      let shape = null;
      let opacity = 0;
      let disposed = false;
      let lastState = '';
      const surface = { win, onMaterial };
      surfaces.set(id, surface);
      start();
      const send = (force = false) => {
        if (disposed || failed || !shape || win.isDestroyed()) return;
        try {
          const bounds = win.getBounds();
          const pixels = screen.dipToScreenRect(null, bounds);
          // getBounds() rounds back to DIPs. Do not stretch curves using those
          // rounded dimensions: Chromium still paints at the monitor's scale.
          // The helper reads GetWindowRect for authoritative pixel placement.
          const scale = screen.getDisplayMatching?.(bounds)?.scaleFactor || pixels.width / bounds.width;
          const commands = shape.commands.map(([op, ...values]) => [op, ...values.map((value) => value * scale)]);
          const handle = win.getNativeWindowHandle();
          const hwnd = handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
          const message = { op: 'update', id, hwnd: String(hwnd), ...pixels,
            shapeKey: `${shape.key}:${scale}`, commands,
            opacity: win.isVisible() ? opacity : 0 };
          const serialized = JSON.stringify(message);
          if (!force && serialized === lastState) return;
          lastState = serialized;
          enqueue(id, message);
        } catch (error) { fail(error); }
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const event of ['show', 'hide', 'move', 'resize']) win.removeListener(event, windowChanged);
        win.removeListener('closed', dispose);
        surfaces.delete(id);
        enqueue(id, { op: 'dispose', id });
        if (!surfaces.size) stop();
      };
      // A native move may be smaller than getBounds()'s DIP rounding. Always
      // let the helper re-read GetWindowRect for actual window events.
      const windowChanged = () => send(true);
      for (const event of ['show', 'hide', 'move', 'resize']) win.on(event, windowChanged);
      win.once('closed', dispose);
      return {
        update(value) { shape = value; send(); },
        setOpacity(value) { opacity = value; send(); },
        reorder() { send(true); },
        dispose
      };
    }
  };
}

module.exports = { createWindowsDockBackdrop, helperPathFor };
