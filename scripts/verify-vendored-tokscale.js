'use strict';

// Integration gate for the Tokscale binary Token Monitor will ship. Listing a
// client or checking `--version` cannot prove its JSON token-bucket semantics.
// Run DSH and registered client sessions through the selected binary, then
// check the fields Token Monitor consumes. These fixtures test the binary-to-
// Token-Monitor contract, regardless of where each parser was implemented.
//
// Fixture values are the vendor pair upstream's own dsh.rs test module cites
// (reasoning_tokens_do_not_inflate_the_additive_output_bucket): raw
// outputTokens 25 with reasoningTokens 23 must report output 2 (25 - 23), not
// 25 — otherwise reasoning tokens get billed twice, once inside "output" and
// once as "reasoning". Same fixture as tokscale's own
// test_dsh_zstd_transcript_counts_identically_cold_and_warm_cache.
//
// This checks DSH and registered client parsing semantics. Whether every DEFAULT_CLIENTS
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
const MUSE_SESSION_ID = 'b1111111-2222-4333-8444-555555555555';
const MUSE_MODEL = 'muse-spark-1.3-contributor';
const FX_SESSION_ID = 'fxsess-0001-aaaa-bbbb-ccccdddddddd';
// Proma and Qoder CN session ids embed a hash of the transcript path, and the
// fixture home is a fresh temp dir, so their sessions are matched by pattern.
const PROMA_SESSION_ID = /^proma:tm-contract@[0-9a-f]{12}$/;
const QODER_CN_SESSION_ID = /^qodercn:qodercn:jsonl:[0-9a-f]{12}:qsess-1$/;
const MCODE_SESSION_ID = 'mvs_0123456789abcdef0123456789abcdef';
// Every Tokscale-parsed client added after the legacy baseline in
// tests/shared/tokscaleTokenContracts.test.js needs a case here. That test
// makes a new catalog id fail locally until its real binary output and Token
// Monitor normalization are both exercised by this release gate.
const TOKEN_CONTRACT_CASES = Object.freeze([
  {
    client: 'muse',
    // Responses usage includes 5105 cached input and 278 reasoning output.
    expectedRow: { model: MUSE_MODEL, input: 21859, output: 101, cacheRead: 5105, reasoning: 278 },
    hasExplicitTotal: false,
    expectedPeriod: { totalTokens: 27343, clientTokens: 27343, clientOutputTokens: 379 },
    expectedSession: { id: MUSE_SESSION_ID, totalTokens: 27343, outputTokens: 379, reasoningTokens: 278 },
    writeFixture(home) {
      const sessionDir = path.join(home, '.local', 'share', 'muse', 'sessions', '2026', '09', '18', MUSE_SESSION_ID);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), `${JSON.stringify({
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
    }
  },
  {
    client: 'fx',
    // fx writes one aggregate snapshot per session at
    // `~/.fx/sessions/<id>/usage-v2.json`; the sibling `session.json` carries
    // the workspace root and `sessions/index.json` the title. Unlike DSH/Muse
    // its `output` stays reasoning-inclusive (the wire schema validates
    // reasoning <= output and the parser emits both verbatim), so `fx` is
    // deliberately NOT in TOKSCALE_DISJOINT_REASONING_CLIENTS — the separate
    // `reasoning` bucket is informational, not additive.
    expectedRow: { model: 'glm-5.2', input: 1200, output: 340, cacheRead: 500, cacheWrite: 80, reasoning: 60 },
    hasExplicitTotal: false,
    expectedPeriod: { totalTokens: 2120, clientTokens: 2120, clientOutputTokens: 340 },
    expectedSession: { id: FX_SESSION_ID, totalTokens: 2120, outputTokens: 340, reasoningTokens: 60 },
    writeFixture(home) {
      const sessionDir = path.join(home, '.fx', 'sessions', FX_SESSION_ID);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'usage-v2.json'), JSON.stringify({
        schema_version: 2,
        session_id: FX_SESSION_ID,
        snapshot: {
          schema_version: 1,
          total_cost: 0.0314,
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_tokens: 500,
          cache_write_tokens: 80,
          reasoning_tokens: 60,
          request_count: 4,
          models: [
            {
              model: 'zai/glm-5.2',
              total_cost: 0.0314,
              input_tokens: 1200,
              output_tokens: 340,
              cache_read_tokens: 500,
              cache_write_tokens: 80,
              reasoning_tokens: 60,
              request_count: 4
            }
          ]
        }
      }));
      fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
        id: FX_SESSION_ID,
        workspace_root: '/tmp/fx-workspace',
        created_at_ms: 1787196900000,
        updated_at_ms: 1787196905040
      }));
      fs.writeFileSync(path.join(home, '.fx', 'sessions', 'index.json'), JSON.stringify({
        sessions: [{ id: FX_SESSION_ID, title: 'Refactor the zig lexer' }]
      }));
    }
  },
  {
    // Fork-only client (crates/tokscale-core/src/token_monitor/proma.rs):
    // Anthropic-shaped usage, so input excludes the cache buckets.
    client: 'proma',
    expectedRow: { model: 'claude-sonnet-4-5', input: 1200, output: 340, cacheRead: 500, cacheWrite: 80, reasoning: 0 },
    hasExplicitTotal: false,
    expectedPeriod: { totalTokens: 2120, clientTokens: 2120, clientOutputTokens: 340 },
    expectedSession: { id: PROMA_SESSION_ID, totalTokens: 2120, outputTokens: 340, reasoningTokens: 0 },
    writeFixture(home) {
      const dir = path.join(home, '.proma', 'agent-sessions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'tm-contract.jsonl'), `${JSON.stringify({
        type: 'assistant',
        _createdAt: '2026-09-18T10:00:00Z',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 500, cache_creation_input_tokens: 80 }
        }
      })}\n`);
    }
  },
  {
    // Fork-only client (crates/tokscale-core/src/token_monitor/qodercn.rs):
    // JSONL input_tokens includes the cached prefix, which is split out into
    // cacheRead, and the qoder-custom-<profile>/ prefix is stripped.
    client: 'qodercn',
    expectedRow: { model: 'openai/gpt-5', input: 400, output: 120, cacheRead: 600, cacheWrite: 0, reasoning: 0 },
    hasExplicitTotal: false,
    expectedPeriod: { totalTokens: 1120, clientTokens: 1120, clientOutputTokens: 120 },
    expectedSession: { id: QODER_CN_SESSION_ID, totalTokens: 1120, outputTokens: 120, reasoningTokens: 0 },
    writeFixture(home) {
      const dir = path.join(home, '.qoder-cn', 'projects', 'ws');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'tm-contract.jsonl'), `${JSON.stringify({
        type: 'assistant',
        sessionId: 'qsess-1',
        cwd: '/tmp/qoder-workspace',
        timestamp: '2026-09-18T10:00:00Z',
        message: {
          id: 'm1',
          model: 'qoder-custom-abc/openai/gpt-5',
          usage: { input_tokens: 1000, cache_read_input_tokens: 600, output_tokens: 120 }
        }
      })}\n`);
    }
  },
  {
    // The fork's `mcode` supplement (crates/tokscale-core/src/token_monitor/
    // mcode.rs) reads MiniMax Code's runtime store. Pi usage keeps cache reads
    // out of `input`, and a message retained across compaction appears in both
    // the snapshot and the active history but is counted once.
    client: 'mcode',
    expectedRow: { model: 'minimax-m2.5', input: 1500, output: 60, cacheRead: 700, cacheWrite: 30, reasoning: 0 },
    hasExplicitTotal: false,
    expectedPeriod: { totalTokens: 2290, clientTokens: 2290, clientOutputTokens: 60 },
    expectedSession: { id: MCODE_SESSION_ID, totalTokens: 2290, outputTokens: 60, reasoningTokens: 0 },
    writeFixture(home) {
      const dir = path.join(home, '.minimax', 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-session_tm-contract');
      fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        sessionId: MCODE_SESSION_ID,
        createdAtMs: 1789725600000
      }));
      const assistant = (messageId, turnId, timestamp, usage) => JSON.stringify({
        message_id: messageId,
        turn_id: turnId,
        message: {
          role: 'assistant',
          api: 'openai-completions',
          provider: 'minimax',
          model: 'MiniMax-M2.5',
          usage: { ...usage, totalTokens: 0, cost: { total: 0 } },
          timestamp
        }
      });
      const first = assistant('msg-a', 'turn-1', 1789725601000, { input: 1000, output: 40, cacheRead: 300, cacheWrite: 30 });
      const second = assistant('msg-b', 'turn-2', 1789725602000, { input: 500, output: 20, cacheRead: 400, cacheWrite: 0 });
      fs.writeFileSync(path.join(dir, 'snapshots', 'g000000000000--compact-1.jsonl'), `${first}\n`);
      fs.writeFileSync(path.join(dir, 'messages.jsonl'), `${first}\n${second}\n`);
    }
  }
]);

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
  for (const contract of TOKEN_CONTRACT_CASES) contract.writeFixture(home);
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
    APPDATA: path.join(home, 'AppData', 'Roaming'), // Qoder CN's database root on Windows
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
  // fixture entirely, since DSH resolves it ahead of `~/.dsh`. The Qoder CN
  // overrides would do the same for the fork-only qodercn client, and the
  // MiniMax data-directory overrides for the fork's mcode supplement.
  for (const key of [
    'NO_PROXY', 'no_proxy', 'TOKSCALE_EXTRA_DIRS', 'DSH_HOME',
    'TOKEN_MONITOR_QODER_CN_DB_PATH', 'TOKEN_MONITOR_QODER_CN_PROJECTS_PATH', 'QODERCN_CONFIG_DIR',
    'MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR', 'TOKSCALE_HEADLESS_DIR'
  ]) {
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

function assertTokenContract(parsed, contract) {
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const entry = entries[0];
  const expectedRow = { client: contract.client, ...contract.expectedRow };
  const mismatches = Object.entries(expectedRow).filter(([key, value]) => entry?.[key] !== value);
  const explicitTotalKeys = ['totalTokens', 'total_tokens', 'totalTokenCount', 'total_token_count', 'tokens', 'tokenCount', 'token_count'];
  const hasExplicitTotal = entry && explicitTotalKeys.some((key) => Object.hasOwn(entry, key));
  if (entries.length !== 1 || mismatches.length > 0 || hasExplicitTotal !== contract.hasExplicitTotal) {
    throw new Error(
      `${contract.client} fixture mismatch — expected one row with ${JSON.stringify(expectedRow)} and ` +
      `hasExplicitTotal=${contract.hasExplicitTotal}, got ${JSON.stringify(entries)}. ` +
      'If Tokscale changes its JSON token contract, update Token Monitor normalization and this fixture together.'
    );
  }
  const usage = extractUsageFromTokscale(parsed);
  const expected = contract.expectedPeriod;
  const sessionId = contract.expectedSession?.id;
  const sessionKey = sessionId instanceof RegExp
    ? Object.keys(usage.sessions).find((key) => sessionId.test(key))
    : `${contract.client}:${sessionId}`;
  const session = contract.expectedSession && usage.sessions[sessionKey];
  const sessionMismatches = contract.expectedSession && Object.entries(contract.expectedSession)
    .filter(([key, value]) => key !== 'id' && session?.[key] !== value);
  if (usage.totalTokens !== expected.totalTokens || usage.clients[contract.client] !== expected.clientTokens ||
      usage.clientOutputs[contract.client] !== expected.clientOutputTokens || sessionMismatches?.length > 0) {
    throw new Error(`${contract.client} normalization mismatch — expected ${JSON.stringify(expected)}, got ${JSON.stringify(usage)}.`);
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
    for (const contract of TOKEN_CONTRACT_CASES) {
      assertTokenContract(runAgainstFixture(binPath, home, 'client,session,model', contract.client), contract);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(
    `Verified ${isUpstream ? 'npm-installed' : 'vendored'} tokscale (${key}): DSH and ${TOKEN_CONTRACT_CASES.length} tracked-client token contract fixture(s) parse correctly, and ${isUpstream ? `'${SESSION_GROUP_BY}' is rejected as the collector's fallback expects` : 'the joined grouping reports session and workspace metadata'}.`
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

module.exports = { main, TOKEN_CONTRACT_CASES };
