'use strict';
// Main validates user events against the declared control on the selected view.
const ACTION_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;
const CONTROLS = Object.freeze(['button', 'toggle', 'slider', 'select', 'input']);
function findAction(node, action) {
  if (!node) return null;
  if (node.action === action) return node;
  for (const child of node.children || []) { const found = findAction(child, action); if (found) return found; }
  return null;
}
function validateInteraction(node, event) {
  if (!node || !event || typeof event !== 'object' || Array.isArray(event) || node.disabled === true) return null;
  if (typeof event.action !== 'string' || !ACTION_RE.test(event.action) || node.action !== event.action) return null;
  const out = { action: event.action, type: event.type };
  if (node.type === 'button' && event.type === 'press') return out;
  if (node.type === 'toggle' && event.type === 'change' && typeof event.value === 'boolean') return { ...out, value: event.value };
  if (node.type === 'slider' && event.type === 'change' && typeof event.value === 'number' && Number.isFinite(event.value)) {
    const min = node.min ?? 0, max = node.max ?? 100, step = node.step ?? 1;
    if (event.value < min || event.value > max) return null;
    const value = Math.min(max, min + Math.round((event.value - min) / step) * step);
    return { ...out, value: Math.round(value * 1e6) / 1e6 };
  }
  if (node.type === 'select' && event.type === 'change' && typeof event.value === 'string' && node.options?.some(option => option.value === event.value)) return { ...out, value: event.value };
  if (node.type === 'input' && event.type === 'change' && typeof event.value === 'string' && event.value.length <= (node.maxLength || 256)) return { ...out, value: event.value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') };
  if (node.type === 'draw') {
    if (event.type === 'key' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', ' '].includes(event.key)) return { ...out, key: event.key };
    if (!['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].includes(event.type)) return null;
    if (![event.x, event.y].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
    if (event.x < 0 || event.y < 0 || event.x > (node.width || 100) || event.y > (node.height || 40)) return null;
    return { ...out, x: Math.round(event.x * 100) / 100, y: Math.round(event.y * 100) / 100 };
  }
  return null;
}
module.exports = { ACTION_RE, CONTROLS, findAction, validateInteraction };
