'use strict';

// Release gate for install-vendored-tokscale.js. Checking `--version` is not
// enough to prove the swap worked: tokscale's Cargo.toml version stays at the
// last tagged release (4.13.0) even on commits far past it, since DSH landed
// without a version bump upstream. So this runs the swapped binary against a
// minimal DSH session fixture and asserts the parsed token buckets match the
// upstream-documented reasoning-accounting fix — proof the binary in place is
// actually the pinned DSH build, not just an executable that runs.
//
// Fixture values are the vendor pair upstream's own dsh.rs test module cites
// (reasoning_tokens_do_not_inflate_the_additive_output_bucket): raw
// outputTokens 25 with reasoningTokens 23 must report output 2 (25 - 23), not
// 25 — otherwise reasoning tokens get billed twice, once inside "output" and
// once as "reasoning". Same fixture as tokscale's own
// test_dsh_zstd_transcript_counts_identically_cold_and_warm_cache.
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
const { loadManifest, resolveManifestEntry, resolveTargetBinPath } = require('./vendoredTokscale');

const FIXTURE_SESSION_ID = '96cf59c9-b347-48b9-b234-a5200913ad05';
const FIXTURE_WORKSPACE_DIR = '-tmp-dsh-workspace';
const FIXTURE_LINES = [
  '{"type":"session","version":0,"id":"96cf59c9-b347-48b9-b234-a5200913ad05","createdAt":1783352134832,"cwd":"/tmp/dsh-workspace","delegationDepth":0}',
  '{"type":"assistant/message","seq":39,"time":1785730448979,"data":{"turn":1,"message":{"id":"7ac2e3d7-d558-4b24-b71e-40fc2f42216d","source":{"kind":"model","provider":"deepseek","model":"deepseek-reasoner"}},"usage":{"inputTokens":2885,"outputTokens":25,"cacheReadTokens":0,"reasoningTokens":23}}}'
];
const EXPECTED = { client: 'dsh', model: 'deepseek-reasoner', input: 2885, output: 2, reasoning: 23, cacheRead: 0 };

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

function runAgainstFixture(binPath, home) {
  const result = spawnSync(binPath, ['--json', '--client', 'dsh', '--group-by', 'client,model', '--no-spinner'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: hermeticEnv(home)
  });
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
        'If this is a legitimate upstream behavior change, update EXPECTED and vendor/tokscale.json together, do not just silence this check.'
    );
  }
}

function main() {
  const manifest = loadManifest();
  const { key, entry } = resolveManifestEntry(manifest);
  const binPath = resolveTargetBinPath(entry);
  if (!fs.existsSync(binPath)) {
    throw new Error(`No binary at ${binPath} for ${key} — run install-vendored-tokscale.js first`);
  }

  const home = writeFixtureHome();
  try {
    const parsed = runAgainstFixture(binPath, home);
    assertExpected(parsed);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`Verified vendored tokscale (${key}): DSH fixture parses with correct reasoning-corrected token buckets.`);
}

try {
  main();
} catch (error) {
  console.error(`verify-vendored-tokscale failed: ${error.message}`);
  process.exit(1);
}
