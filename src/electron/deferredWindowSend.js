'use strict';

// A renderer that has not finished loading silently drops anything sent to it,
// and a cold start publishes before the window is up. Deliveries that have to
// survive that one boundary wait for did-finish-load. Everything else sends
// straight through on purpose: the renderer pulls current state itself once it
// initialises, so queueing every frame against a slow load would only stack
// listeners and then replay a burst of superseded data.
//
// `isStillCurrent` is what keeps the wait honest. By the time a slow load
// finishes, a real collection may already have published newer numbers, and
// delivering the queued snapshot then would move the UI backwards until the
// next push, which in a connected session can be minutes away.
function sendWhenRendererReady(contents, channel, payload, isStillCurrent) {
  if (!contents || contents.isDestroyed?.()) return;
  const deliver = () => {
    if (contents.isDestroyed?.()) return;
    if (typeof isStillCurrent === 'function' && !isStillCurrent()) return;
    try { contents.send(channel, payload); } catch (_) {}
  };
  if (contents.isLoading()) contents.once('did-finish-load', deliver);
  else deliver();
}

module.exports = {
  sendWhenRendererReady
};
