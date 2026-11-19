'use strict';

// Several web-session providers reject clients that don't present as a browser —
// claude.ai answers anything else with a Cloudflare challenge — so their requests
// carry a browser agent rather than the honest `token-monitor/<version>` one. It
// lives here so bumping the version is a single edit instead of a hunt through
// every collector, and so a stale copy can't survive in one of them.
//
// This is the only browser agent in the tree, and a test keeps it that way. A
// provider that identifies as a specific client rather than a browser — Codex,
// Grok and Copilot each name their own — is a different thing and does not
// belong here.
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

// The user-agent alone is not enough for Cloudflare's managed challenge: the
// same cookie is refused unless the request also carries the client-hint
// headers a real browser sends. Keep the version in step with the agent above.
const BROWSER_CLIENT_HINTS = Object.freeze({
  'sec-ch-ua': '"Chromium";v="143", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Accept-Language': 'en-US,en;q=0.9'
});

module.exports = { BROWSER_USER_AGENT, BROWSER_CLIENT_HINTS };
