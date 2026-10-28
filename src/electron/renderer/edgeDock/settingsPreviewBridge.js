'use strict';

// The same document/CSS/renderer as the real surfaces, without native actions,
// credentials, polling, or a preload. Only its embedding settings page supplies data.
if (window.parent !== window && new URLSearchParams(location.search).get('settingsPreview') === '1') {
  let receive, key;
  const noop = () => {};
  window.tokenMonitorEdgeDock = {
    isSettingsPreview: true, onRender: callback => { receive = callback; },
    ready: () => window.parent.postMessage({ type: 'display-preview-ready' }, '*'),
    onAnimate: noop, onMotion: noop, reportMotionFrame: noop,
    pointer: noop, press: noop, wheel: noop, click: noop, dragStart: noop, dragEnd: noop,
    reportBubbleSize: noop,
    reportNotchSize: (_height, slots) => { if (slots) window.parent.postMessage({ type: 'display-preview-measured', key, slots }, '*'); }, reportNotchSlots: noop,
    reportNotchSummarySize: noop, reportNotchSummarySlots: noop, peekPainted: noop,
    toggleRateMode: noop, refreshLimits: async () => false
  };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'display-preview-render') return;
    key = event.data.key;
    receive?.(event.data.payload);
  });
}
