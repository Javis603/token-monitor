'use strict';

// Integration gate for the Tokscale binary Token Monitor will ship. Listing a
// client or checking `--version` cannot prove its JSON token-bucket semantics.
// Run DSH and Muse sessions through the selected binary, then check the fields
// Token Monitor consumes. Muse parsing comes from upstream; this fixture tests
// the binary-to-Token-Monitor contract, not a fork-specific parser change.
//
// Fixture values are the vendor pair upstream's own dsh.rs test module cites
// (reasoning_tokens_do_not_inflate_the_additive_output_bucket): raw
// outputTokens 25 with reasoningTokens 23 must report output 2 (25 - 23), not
// 25 — otherwise reasoning tokens get billed twice, once inside "output" and
// once as "reasoning". Same fixture as tokscale's own
// test_dsh_zstd_transcript_counts_identically_cold_and_warm_cache.
//
// This checks DSH and Muse parsing semantics. Whether every DEFAULT_CLIENTS
// entry is a client the vendored binary recognizes at all is a separate,
// generic concern — see verify-vendored-tokscale-clients.js.
//
// mode "override" (the default): verify the pinned fork build installed by
// ensure-vendored-tokscale.js. mode "upstream": verify the npm-installed binary
// instead. Both must preserve the same output contract when changing sources.
//
// The child process must be hermetic: without pinning HOME/XDG_*/config dirs
// and clearing scan-path env vars, a run on a machine (or CI runner) that
// happens to have its own tokscale config, DSH_HOME, or TOKSCALE_EXTRA_DIRS
// set could read real data instead of the fixture and pass or fail for the
// wrong reason, or hit the network for pricing and flake on a slow/blocked
// runner. This mirrors tokscale's own cmd_with_home()/prime_pricing_cache()
// in crates/tokscale-cli/tests/cli_tests.rs — same guarantees, ported to JS.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadManifest, manifestMode, resolveManifestEntry, resolveTargetBinPath } = require('./vendoredTokscale');
const { extractUsageFromTokscale } = require('../src/shared/usage');

const FIXTURE_CLIENT = 'dsh';
const FIXTURE_SESSION_ID = '96cf59c9-b347-48b9-b234-a5200913ad05';
const FIXTURE_WORKSPACE_DIR = '-tmp-dsh-workspace';
const FIXTURE_LINES = [
  '{"type":"session","version":0,"id":"96cf59c9-b347-48b9-b234-a5200913ad05","createdAt":1783352134832,"cwd":"/tmp/dsh-workspace","delegationDepth":0}',
  '{"type":"assistant/message","seq":39,"time":1785730448979,"data":{"turn":1,"message":{"id":"7ac2e3d7-d558-4b24-b71e-40fc2f42216d","source":{"kind":"model","provider":"deepseek","model":"deepseek-reasoner"}},"usage":{"inputTokens":2885,"outputTokens":25,"cacheReadTokens":0,"reasoningTokens":23}}}'
];
const EXPECTED = { client: FIXTURE_CLIENT, model: 'deepseek-reasoner', input: 2885, output: 2, reasoning: 23, cacheRead: 0 };
// Muse's Responses usage reports input 26964 including 5105 cached tokens,
// and output 379 including 278 reasoning tokens. Tokscale splits both into
// disjoint JSON buckets; Token Monitor folds reasoning back into public output.
const MUSE_SESSION_ID = 'b1111111-2222-4333-8444-555555555555';
const MUSE_MODEL = 'muse-spark-1.3-contributor';
const MUSE_EXPECTED = { client: 'muse', model: MUSE_MODEL, input: 21859, output: 101, cacheRead: 5105, reasoning: 278 };

// Second capability this fixture proves: the collector asks for the fork's
// workspace-joined grouping so one scan can attribute sessions to projects. A
// pin that quietly loses that patch would still parse DSH correctly and still
// report the right totals — the collector would just fall back and projects
// would go back to being re-derived by reopening every transcript, which no
// other test can see. Under `upstream` mode the assertion inverts: the binary
// is not expected to carry a downstream patch, so what gets pinned instead is
// the rejection the fallback keys on.
const SESSION_GROUP_BY = 'client,workspace,session,model';
const EXPECTED_SESSION = {
  client: FIXTURE_CLIENT,
  sessionId: FIXTURE_SESSION_ID,
  firstActiveMs: 1785730448979,
  lastActiveMs: 1785730448979
};
const EXPECTED_WORKSPACE = { workspaceKey: '/tmp/dsh-workspace', label: 'dsh-workspace' };
// isUnknownTokscaleGroupByError() in src/shared/collector.js matches this.
const GROUP_BY_REJECTION = /invalid group-by value/i;

// Guaranteed-unreachable loopback port (nothing listens on 9/discard), used
// as an offline guarantee for pricing lookups even if TOKSCALE_PRICING_CACHE_ONLY
// is ever bypassed by a future code path — same technique tokscale's own
// harness uses.
const BLACKHOLE_PROXY = 'http://127.0.0.1:9';

function writeFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-fixture-'));
  const sessionDir = path.join(home, '.dsh', 'sessions', FIXTURE_WORKSPACE_DIR, FIXTURE_SESSION_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  // Plain-text session.jsonl (no zstd framing needed): DSH's `compression:
  // none` backend writes this exact spelling, and the scanner/parser both
  // sniff the frame magic rather than assume compression, so this and a
  // zstd-compressed session.jsonl.zstd are equivalent inputs.
  fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), `${FIXTURE_LINES.join('\n')}\n`);
  const museSessionDir = path.join(home, '.local', 'share', 'muse', 'sessions', '2026', '09', '18', MUSE_SESSION_ID);
  fs.mkdirSync(museSessionDir, { recursive: true });
  fs.writeFileSync(path.join(museSessionDir, 'session.jsonl'), `${JSON.stringify({
    schema_version: 1,
    stream: { kind: 'session', id: MUSE_SESSION_ID },
    sequence: 39,
    recorded_at: 1789790455896395,
    record_type: 'event',
    payload_type: 'runtime.session',
    payload_schema_version: 1,
    payload: {
      kind: 'run',
      run_id: 'c1111111-2222-4333-8444-555555555555',
      event: {
        kind: 'model_completed',
        usage: {
          input_tokens: 26964,
          output_tokens: 379,
          cached_tokens: 5105,
          cache_write_tokens: 0,
          cache_read_tokens: 5105,
          reasoning_tokens: 278
        },
        duration_ms: 5819,
        finish_reason: 'tool_calls',
        model: MUSE_MODEL
      }
    }
  })}\n`);
  return home;
}

// Empty-but-fresh pricing cache: TOKSCALE_PRICING_CACHE_ONLY=1 stops the
// pricing service from fetching, but it still needs *some* non-stale cache
// file to read instead of treating the cache as missing. Content is
// deliberately empty — this fixture doesn't assert on cost, only on the
// token buckets — matching tokscale's own prime_pricing_cache() fixture.
function primePricingCache(configDir) {
  const cacheDir = path.join(configDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const empty = JSON.stringify({ timestamp: now, data: {} });
  fs.writeFileSync(path.join(cacheDir, 'pricing-litellm.json'), empty);
  fs.writeFileSync(path.join(cacheDir, 'pricing-openrouter.json'), empty);
  fs.writeFileSync(path.join(cacheDir, 'pricing-models-dev.json'), empty);
}

function hermeticEnv(home) {
  const configDir = path.join(home, '.config', 'tokscale');
  primePricingCache(configDir);

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home, // Windows equivalent of HOME for path resolution
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TOKSCALE_CONFIG_DIR: configDir,
    TOKSCALE_PRICING_CACHE_ONLY: '1',
    HTTP_PROXY: BLACKHOLE_PROXY,
    HTTPS_PROXY: BLACKHOLE_PROXY,
    ALL_PROXY: BLACKHOLE_PROXY,
    http_proxy: BLACKHOLE_PROXY,
    https_proxy: BLACKHOLE_PROXY,
    all_proxy: BLACKHOLE_PROXY
  };
  // Scan-path overrides that must not leak in from the runner/dev shell —
  // DSH_HOME in particular would otherwise redirect the scan away from the
  // fixture entirely, since DSH resolves it ahead of `~/.dsh`.
  for (const key of ['NO_PROXY', 'no_proxy', 'TOKSCALE_EXTRA_DIRS', 'DSH_HOME']) {
    delete env[key];
  }
  return env;
}

function spawnFixture(binPath, home, groupBy, client = FIXTURE_CLIENT) {
  return spawnSync(binPath, ['--json', '--client', client, '--group-by', groupBy, '--no-spinner'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: hermeticEnv(home)
  });
}

function runAgainstFixture(binPath, home, groupBy = 'client,model', client = FIXTURE_CLIENT) {
  const result = spawnFixture(binPath, home, groupBy, client);
  if (result.error) throw new Error(`Fixture run failed to execute: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Fixture run exited ${result.status}: ${result.stderr || result.stdout}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Fixture run did not produce valid JSON:\n${result.stdout}`, { cause: error });
  }
  return parsed;
}

function assertExpected(parsed) {
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  if (entries.length !== 1) {
    throw new Error(`Expected exactly 1 fixture entry, got ${entries.length}: ${JSON.stringify(parsed)}`);
  }
  const entry = entries[0];
  const mismatches = Object.entries(EXPECTED).filter(([key, value]) => entry[key] !== value);
  if (mismatches.length > 0) {
    throw new Error(
      `DSH fixture mismatch — expected ${JSON.stringify(EXPECTED)}, got ${JSON.stringify(entry)}. ` +
        'If this is a legitimate upstream behavior change, update EXPECTED and scripts/vendor/tokscale.json together, do not just silence this check.'
    );
  }
}

function assertMuseContract(parsed) {
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const entry = entries[0];
  const mismatches = Object.entries(MUSE_EXPECTED).filter(([key, value]) => entry?.[key] !== value);
  const explicitTotalKeys = ['totalTokens', 'total_tokens', 'totalTokenCount', 'total_token_count', 'tokens', 'tokenCount', 'token_count'];
  if (entries.length !== 1 || mismatches.length > 0 || explicitTotalKeys.some((key) => Object.hasOwn(entry, key))) {
    throw new Error(
      `Muse fixture mismatch — expected one row with ${JSON.stringify(MUSE_EXPECTED)} and no explicit total, got ${JSON.stringify(entries)}. ` +
      'If Tokscale changes its JSON token contract, update the Token Monitor normalization and this fixture together.'
    );
  }
  const usage = extractUsageFromTokscale(parsed);
  const session = usage.sessions[`muse:${MUSE_SESSION_ID}`];
  if (usage.totalTokens !== 27343 || usage.clients.muse !== 27343 || usage.clientOutputs.muse !== 379 ||
      session?.totalTokens !== 27343 || session.outputTokens !== 379 || session.reasoningTokens !== 278) {
    throw new Error(`Muse normalization mismatch — expected 27343 total and 379 output including 278 reasoning, got ${JSON.stringify(usage)}.`);
  }
}

function assertSessionMetadata(parsed) {
  const entry = (Array.isArray(parsed.entries) ? parsed.entries : [])[0];
  if (!entry || entry.sessionId !== FIXTURE_SESSION_ID || entry.workspaceKey !== EXPECTED_WORKSPACE.workspaceKey) {
    throw new Error(
      `Expected the joined grouping to put both the session id and its workspace on the row, got ${JSON.stringify(entry)}.`
    );
  }
  const session = (Array.isArray(parsed.sessions) ? parsed.sessions : [])[0];
  const sessionMismatches = Object.entries(EXPECTED_SESSION).filter(([key, value]) => session?.[key] !== value);
  if (sessionMismatches.length > 0) {
    throw new Error(
      `Session metadata mismatch — expected ${JSON.stringify(EXPECTED_SESSION)}, got ${JSON.stringify(session)}.`
    );
  }
  const workspace = (Array.isArray(parsed.workspaces) ? parsed.workspaces : [])[0];
  const workspaceMismatches = Object.entries(EXPECTED_WORKSPACE).filter(([key, value]) => workspace?.[key] !== value);
  if (workspaceMismatches.length > 0) {
    throw new Error(
      `Workspace metadata mismatch — expected ${JSON.stringify(EXPECTED_WORKSPACE)}, got ${JSON.stringify(workspace)}.`
    );
  }
}

function assertGroupByRejected(result) {
  const output = `${result.stderr || ''}${result.stdout || ''}`;
  if (result.status === 0 || !GROUP_BY_REJECTION.test(output)) {
    throw new Error(
      `Expected an upstream binary to reject '${SESSION_GROUP_BY}' with the message the collector's fallback matches, ` +
        `got exit ${result.status}: ${output.trim() || '(no output)'}. If upstream now accepts it, the collector's ` +
        'fallback and this check should be revisited together.'
    );
  }
}

function main() {
  const manifest = loadManifest();
  const isUpstream = manifestMode(manifest) === 'upstream';
  const { key, entry } = resolveManifestEntry(manifest);
  const binPath = resolveTargetBinPath(entry);
  if (!fs.existsSync(binPath)) {
    throw new Error(
      isUpstream
        ? `No binary at ${binPath} for ${key} — is the tokscale npm dependency installed?`
        : `No binary at ${binPath} for ${key} — run ensure-vendored-tokscale.js first`
    );
  }

  const home = writeFixtureHome();
  try {
    const parsed = runAgainstFixture(binPath, home);
    assertExpected(parsed);
    if (isUpstream) {
      assertGroupByRejected(spawnFixture(binPath, home, SESSION_GROUP_BY));
    } else {
      assertSessionMetadata(runAgainstFixture(binPath, home, SESSION_GROUP_BY));
    }
    assertMuseContract(runAgainstFixture(binPath, home, isUpstream ? 'client,session,model' : SESSION_GROUP_BY, 'muse'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(
    `Verified ${isUpstream ? 'npm-installed' : 'vendored'} tokscale (${key}): DSH and Muse fixtures parse with correct ` +
      `reasoning-corrected token buckets, Muse normalizes to the public token totals, and ${isUpstream ? `'${SESSION_GROUP_BY}' is rejected as the collector's fallback expects` : 'the joined grouping reports session and workspace metadata'}.`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`verify-vendored-tokscale failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { main };
