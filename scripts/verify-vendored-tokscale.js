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
// once as "reasoning".

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

function runAgainstFixture(binPath, home) {
  const result = spawnSync(binPath, ['--home', home, '--json', '--client', 'dsh', '--group-by', 'client,model'], {
    encoding: 'utf8',
    timeout: 15_000
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
  const entry = Array.isArray(parsed.entries) ? parsed.entries[0] : null;
  if (!entry) throw new Error(`Fixture run produced no entries: ${JSON.stringify(parsed)}`);
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
