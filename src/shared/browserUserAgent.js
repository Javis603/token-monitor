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

module.exports = { BROWSER_USER_AGENT };
