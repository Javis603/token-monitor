(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorChartMotion = api;
})(typeof window !== 'undefined' ? window : null, function() {
  'use strict';
  const playing = new WeakMap();
  // One time-axis reveal for the whole SVG: the line and its fill share the
  // same front. Path-length dashes restart at gaps and depend on scaled stroke
  // coordinates; a viewport clip does neither and survives live resizing.
  function reveal(svg, { duration = 920, reducedMotion = false } = {}) {
    if (!svg?.animate || reducedMotion) return null;
    const existing = playing.get(svg);
    if (existing && (existing.pending || existing.playState === 'running')) return existing;
    const animation = svg.animate([
      { clipPath: 'inset(0 100% 0 0)' },
      { clipPath: 'inset(0 0% 0 0)' }
    ], { duration, easing: 'linear', fill: 'backwards' });
    playing.set(svg, animation);
    const forget = () => { if (playing.get(svg) === animation) playing.delete(svg); };
    animation.finished.then(forget, forget);
    return animation;
  }
  function running(animation) { return Boolean(animation && (animation.pending || animation.playState === 'running')); }
  return { reveal, running };
});
