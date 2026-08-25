'use strict';

// The developer's own shell is an input to every assertion about source roots.
// The collector follows tokscale in honouring XDG_DATA_HOME, CODEX_HOME, the
// CLINE_* family and friends, so a machine that exports any of them resolves
// fixture roots somewhere else and fails these tests on a correct build — seven
// of them did, on a branch whose CI was green because no runner exports these.
//
// Clearing them per test keeps the assertions exact. Widening the assertions
// instead would drop the coverage they exist for, and is the tempting fix for
// whoever hits this next.
const SOURCE_ENV_KEYS = Object.freeze([
  'XDG_DATA_HOME',
  'COPILOT_OTEL_FILE_EXPORTER_PATH',
  'CODEX_HOME',
  'TOKSCALE_HEADLESS_DIR',
  'CLINE_SESSION_DATA_DIR',
  'CLINE_DATA_DIR',
  'CLINE_DIR',
  'GROK_HOME',
  'KIMI_CODE_HOME',
  'GEMINI_CLI_HOME',
  'HERMES_HOME'
]);

// Applied to a whole file rather than case by case, so a test added later is
// hermetic by default instead of by remembering. A case that wants one of these
// set assigns it inside the test; the real value is restored afterwards.
function installSourceEnvGuard(test, keys = SOURCE_ENV_KEYS) {
  let saved = null;
  test.beforeEach(() => {
    saved = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
  });
  test.afterEach(() => {
    for (const [key, previous] of saved || []) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    saved = null;
  });
}

module.exports = { SOURCE_ENV_KEYS, installSourceEnvGuard };
