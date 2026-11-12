'use strict';

const { toPolygons } = require('./renderer/edgeDock/shapes');
const { rasterizeMask } = require('./edgeDock/mask');
const { applyVibrancyMask } = require('./edgeDock/macVibrancyMask');

function maskCardMaterial(win, commands, width, height, scale) {
  return applyVibrancyMask(win, rasterizeMask(toPolygons(commands), width, height, scale), width, height);
}

// Window screenshots and window pickers use native bounds, including transparent
// pixels. Keep the host fitted to the painted card throughout its spring motion.
function cardCanvasBounds(frame, target = frame) {
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height,
    cardY: 0, cardHeight: frame.height,
    contentY: target.y - frame.y, contentHeight: target.height };
}

function createCardPointerRouting({ platform, screen, getWindow, getFrame, isVisible, primaryButtonDown = () => false }) {
  let mode = null;
  function sync() {
    const win = getWindow();
    if (platform !== 'darwin' || !win || win.isDestroyed()) return;
    const frame = getFrame(), point = screen.getCursorScreenPoint();
    const inside = frame && point.x >= frame.x && point.x < frame.x + frame.width
      && point.y >= frame.y && point.y < frame.y + frame.height;
    const capture = isVisible() && (inside || mode === 'capture' && primaryButtonDown() === true);
    const next = capture ? 'capture' : isVisible() ? 'forward' : 'ignore';
    if (next === mode) return;
    mode = next;
    if (mode === 'forward') win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(!capture);
  }
  return { sync, reset() { mode = null; } };
}

module.exports = { cardCanvasBounds, createCardPointerRouting, maskCardMaterial };
