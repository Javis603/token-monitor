// Sandbox verification fixture: blocks its Worker forever on the first tick.
// The host page must notice the missing pong and the process must restart.
tm.onTick(() => {
  tm.publish('alive', Date.now());
  for (;;) { /* never yields */ }
});
