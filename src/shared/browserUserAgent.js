'use strict';

// Several web-session providers reject clients that don't present as a browser —
// claude.ai answers anything else with a Cloudflare challenge — so their requests
// carry a browser agent rather than the honest `token-monitor/<version>` one. It
// lives here so bumping the version is a single edit instead of a hunt through
// every collector, and so a stale copy can't survive in one of them.
//
// A provider that genuinely needs a different agent should declare its own
// instead of widening this one: `cursorProbe` and `mimoLimits` already send
// their own, older strings.
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

module.exports = { BROWSER_USER_AGENT };
