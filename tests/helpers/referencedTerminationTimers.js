'use strict';

// Production termination timers are deliberately unref'ed so a stuck child
// cannot keep the app alive. Tests that await the terminal fallback need an
// explicit referenced clock; otherwise Node 22 can end the test process while
// the Promise is still pending.
function referencedTerminationOptions(options = {}) {
  return {
    ...options,
    setTimeout(callback, delay) {
      return { timer: setTimeout(callback, delay) };
    },
    clearTimeout(handle) {
      clearTimeout(handle?.timer);
    }
  };
}

module.exports = { referencedTerminationOptions };
