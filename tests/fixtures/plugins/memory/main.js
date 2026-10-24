// Sandbox verification fixture: grows its heap by ~64 MB per tick until the
// host's memory budget (or V8) stops it. Other plugins must keep running.
const held = [];
tm.onTick(() => {
  for (let chunk = 0; chunk < 8; chunk += 1) held.push(new Float64Array(1024 * 1024).fill(chunk + held.length));
  tm.publish('held', held.length * 8);
});
