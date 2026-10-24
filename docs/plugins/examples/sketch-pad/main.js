// Personal content lives only in this plugin's private local store.
// Keep at most 160 line segments; storage is one bounded JSON string.
let state = { note: '', color: 'accent', width: 3, grid: true, strokes: [] };
let stroke = null, cursor = { x: 240, y: 120 }, keyboard = false, loaded = false;
const colors = ['accent', 'chart', 'warn', 'default'];
function trim() { while (state.strokes.reduce((n, s) => n + s.length, 0) > 160) state.strokes.shift(); }
function publish(status = '') {
  const list = [];
  if (state.grid) {
    for (let x = 0; x <= 480; x += 24) list.push({ op: 'line', x1: x, y1: 0, x2: x, y2: 240, stroke: 'muted', o: .16 });
    for (let y = 0; y <= 240; y += 24) list.push({ op: 'line', x1: 0, y1: y, x2: 480, y2: y, stroke: 'muted', o: .16 });
  }
  list.push(...state.strokes.flat());
  if (keyboard) list.push({ op: 'circle', cx: cursor.x, cy: cursor.y, r: 4, stroke: 'accent', sw: 1 });
  tm.publish('drawing', list);
  tm.publish('state', { note: state.note, color: state.color, width: state.width, grid: state.grid, empty: !state.strokes.length, status: status || `${state.strokes.length} strokes` });
}
async function save() {
  try { await tm.storage.set('sketch', JSON.stringify(state)); publish(); }
  catch (error) { publish('Save failed — change a control to retry'); tm.warn(error.message); }
}
const ready = (async () => {
  const saved = await tm.storage.get('sketch');
  if (typeof saved === 'string') {
    try {
      const value = JSON.parse(saved);
      if (typeof value.note === 'string' && colors.includes(value.color) && Number.isFinite(value.width) && Array.isArray(value.strokes)) {
        state = { note: value.note.slice(0, 160), color: value.color, width: Math.max(1, Math.min(12, value.width)), grid: value.grid === true, strokes: value.strokes.slice(-160).map(s => Array.isArray(s) ? s.slice(0, 160) : []) }; trim();
      }
    } catch { tm.warn('Saved sketch could not be read'); }
  }
  loaded = true; publish();
})();
tm.onTick(() => { if (loaded) publish(); });
for (const action of ['note', 'color', 'width', 'grid']) tm.onAction(action, async event => { await ready; state[action] = event.value; await save(); });
tm.onAction('undo', async () => { await ready; state.strokes.pop(); stroke = null; await save(); });
tm.onAction('clear', async () => { await ready; state.strokes = []; stroke = null; await save(); });
function begin(x, y) { cursor = { x, y }; stroke = []; state.strokes.push(stroke); }
function move(x, y) {
  if (stroke) {
    if (stroke.length >= 160) { stroke = []; state.strokes.push(stroke); }
    stroke.push({ op: 'line', x1: cursor.x, y1: cursor.y, x2: x, y2: y, stroke: state.color, sw: state.width, cap: 'round' }); trim();
  }
  cursor = { x, y }; publish();
}
tm.onAction('canvas', async event => {
  await ready;
  if (event.type === 'key') {
    keyboard = true;
    if (event.key === 'Enter' || event.key === ' ') { if (stroke) { stroke = null; await save(); } else begin(cursor.x, cursor.y); }
    else if (event.key === 'Escape') { stroke = null; await save(); }
    else { const dx = event.key === 'ArrowLeft' ? -8 : event.key === 'ArrowRight' ? 8 : 0; const dy = event.key === 'ArrowUp' ? -8 : event.key === 'ArrowDown' ? 8 : 0; move(Math.max(0, Math.min(480, cursor.x + dx)), Math.max(0, Math.min(240, cursor.y + dy))); }
    publish(); return;
  }
  keyboard = false;
  if (event.type === 'pointerdown') { begin(event.x, event.y); move(event.x + .01, event.y); }
  else if (event.type === 'pointermove' && stroke) move(event.x, event.y);
  else if (event.type === 'pointerup' || event.type === 'pointercancel') { if (stroke) move(event.x, event.y); stroke = null; await save(); }
});
