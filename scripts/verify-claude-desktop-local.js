#!/usr/bin/env node
'use strict';

// Read-only check of what Token Monitor's Claude Desktop local mode would see
// on this machine: the quota samples in Claude Desktop's plan-usage-history.json
// (scheme A) and the token totals of Desktop-started Claude sessions (scheme B).
//
//   node scripts/verify-claude-desktop-local.js \
//     [--dir "~/Library/Application Support/Claude"]... [--claude-config ~/.claude] \
//     [--org <uuid|8-hex>] [--samples 10] [--json]
//
// Guarantees, enforced below before any project code is loaded:
//   - no network: http/https/http2/net/tls/dgram/dns/undici/child_process,
//     worker_threads and cluster cannot be loaded, and fetch/WebSocket throw;
//   - no networked limits code: only the two local readers are required, never
//     limits.js / collector.js;
//   - no credentials and no `claude` command: the only files read are
//     plan-usage-history.json, Desktop session directory names and their
//     local_*.json records, and *.jsonl transcripts under the projects trees.
//     Paths that look like credential stores are refused outright.

const Module = require('node:module');

const BLOCKED_MODULES = new Set([
  'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises',
  'undici', 'child_process', 'worker_threads', 'cluster', 'inspector'
]);
const originalLoad = Module._load;
Module._load = function guardedLoad(request) {
  const name = String(request).replace(/^node:/, '');
  if (BLOCKED_MODULES.has(name)) {
    throw new Error(`verify-claude-desktop-local: refusing to load network/process module "${request}"`);
  }
  if (/[\\/]limits(\.js)?$|[\\/]collector(\.js)?$|[\\/]limits[\\/]/.test(String(request))) {
    throw new Error(`verify-claude-desktop-local: refusing to load networked limits code "${request}"`);
  }
  return originalLoad.apply(this, arguments);
};
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  Object.defineProperty(globalThis, name, {
    configurable: false,
    get() { throw new Error(`verify-claude-desktop-local: ${name} is disabled`); }
  });
}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CREDENTIAL_PATTERN = /credential|keychain|cookies|\.claude\.json$|oauth|token/i;
function guardPath(file) {
  if (CREDENTIAL_PATTERN.test(path.basename(String(file)))) {
    throw new Error(`verify-claude-desktop-local: refusing to read ${file}`);
  }
}
// Every fs read this script or the readers make goes through these wrappers.
const readOnlyFs = {
  ...fs,
  openSync(file, flags = 'r', ...rest) {
    guardPath(file);
    if (flags !== 'r') throw new Error(`verify-claude-desktop-local: refusing to open ${file} with ${flags}`);
    return fs.openSync(file, 'r', ...rest);
  },
  readFileSync(file, ...rest) { guardPath(file); return fs.readFileSync(file, ...rest); },
  writeFileSync() { throw new Error('verify-claude-desktop-local: writes are disabled'); },
  appendFileSync() { throw new Error('verify-claude-desktop-local: writes are disabled'); },
  mkdirSync() { throw new Error('verify-claude-desktop-local: writes are disabled'); },
  rmSync() { throw new Error('verify-claude-desktop-local: writes are disabled'); },
  unlinkSync() { throw new Error('verify-claude-desktop-local: writes are disabled'); }
};

const {
  collectClaudeDesktopPlanUsage,
  claudeDesktopPlanProviderInput
} = require('../src/shared/providers/claude/desktopPlanUsage');
const { createClaudeDesktopSessionIndex } = require('../src/shared/providers/claude/desktopSessions');
const { claudeDesktopUserDataCandidates, variantForDir } = require('../src/shared/providers/claude/desktopPaths');

function expandHome(value) {
  const text = String(value || '');
  return text === '~' ? os.homedir() : text.startsWith('~/') ? path.join(os.homedir(), text.slice(2)) : text;
}

function parseArgs(argv) {
  const args = { dirs: [], claudeConfig: '', org: '', samples: 10, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${arg} needs a value`); return argv[i]; };
    if (arg === '--dir') args.dirs.push(path.resolve(expandHome(next())));
    else if (arg === '--claude-config') args.claudeConfig = path.resolve(expandHome(next()));
    else if (arg === '--org') args.org = next();
    else if (arg === '--samples') args.samples = Math.max(0, Number.parseInt(next(), 10) || 0);
    else if (arg === '--json') args.json = true;
    else if (arg === '-h' || arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function safeReaddir(dir) {
  try { return readOnlyFs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

// Transcript files (*.jsonl) below a projects tree, with the session id
// tokscale would report: the file stem, or the parent session directory for a
// subagent transcript (`<session>/subagents/agent-*.jsonl`).
function transcriptFiles(root, maxDepth = 10, budget = { left: 200000 }) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length && budget.left > 0) {
    const [dir, depth] = stack.pop();
    for (const entry of safeReaddir(dir)) {
      if (--budget.left <= 0) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 < maxDepth && !['node_modules', '.git'].includes(entry.name)) stack.push([full, depth + 1]);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const parts = full.split(path.sep);
        const subagents = parts.lastIndexOf('subagents');
        const sessionId = subagents > 0 ? parts[subagents - 1] : entry.name.slice(0, -'.jsonl'.length);
        out.push({ file: full, sessionId, subagent: subagents > 0 });
      }
    }
  }
  return out;
}

function emptyTotals() {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, messages: 0 };
}

function addUsage(totals, usage) {
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  totals.input += input;
  totals.output += output;
  totals.cacheCreation += cacheCreation;
  totals.cacheRead += cacheRead;
  totals.total += input + output + cacheCreation + cacheRead;
  totals.messages += 1;
}

// Sums assistant usage, de-duplicated by message.id + requestId as Claude Code
// writes one streamed response several times.
function sumTranscripts(files, windows, nowMs) {
  const seen = new Set();
  const totals = Object.fromEntries(Object.keys(windows).map((name) => [name, emptyTotals()]));
  for (const { file } of files) {
    let text;
    try { text = readOnlyFs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let record;
      try { record = JSON.parse(line); } catch (_) { continue; }
      const usage = record?.message?.usage;
      if (record?.type !== 'assistant' || !usage || typeof usage !== 'object') continue;
      const key = `${record.message.id || ''}:${record.requestId || ''}`;
      if (key !== ':' && seen.has(key)) continue;
      seen.add(key);
      const at = Date.parse(record.timestamp || '') || 0;
      for (const [name, sinceMs] of Object.entries(windows)) {
        if (sinceMs === null || at >= nowMs - sinceMs) addUsage(totals[name], usage);
      }
    }
  }
  return totals;
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    return;
  }
  const nowMs = Date.now();
  const roots = (args.dirs.length
    ? args.dirs.map((dir) => ({ dir, variant: variantForDir(dir), source: 'argument' }))
    : claudeDesktopUserDataCandidates({}))
    .filter((root) => { try { return readOnlyFs.statSync(root.dir).isDirectory(); } catch (_) { return false; } });

  // Scheme A: quota samples.
  const collected = collectClaudeDesktopPlanUsage({ claudeDesktopOrgId: args.org }, {
    fs: readOnlyFs, env: {}, now: () => nowMs, claudeDesktopRoots: roots
  });
  const provider = claudeDesktopPlanProviderInput(collected);
  const series = collected.selected?.series || [];

  // Scheme B: Desktop-started sessions and their tokens.
  const claudeConfig = args.claudeConfig || path.join(os.homedir(), '.claude');
  const projectRoots = [path.join(claudeConfig, 'projects')];
  const index = createClaudeDesktopSessionIndex({ fs: readOnlyFs, projectRoots, desktopRoots: roots, env: {} });
  const candidates = [
    ...projectRoots.flatMap((root) => transcriptFiles(root, 4)),
    ...roots.flatMap((root) => ['local-agent-mode-sessions', 'claude-code-sessions']
      .flatMap((tree) => transcriptFiles(path.join(root.dir, tree))))
  ].filter(({ file }) => file.split(path.sep).includes('projects'));
  const byClass = { desktop: [], 'desktop-3p': [], other: [] };
  const sessionsByClass = { desktop: new Set(), 'desktop-3p': new Set(), other: new Set() };
  const seenFiles = new Set();
  for (const candidate of candidates) {
    if (seenFiles.has(candidate.file)) continue;
    seenFiles.add(candidate.file);
    const kind = index.classify(candidate.sessionId) || 'other';
    byClass[kind].push(candidate);
    sessionsByClass[kind].add(candidate.sessionId);
  }
  const windows = { last5h: 5 * 3600 * 1000, last7d: 7 * 24 * 3600 * 1000, allTime: null };
  const tokens = {
    desktop: sumTranscripts(byClass.desktop, windows, nowMs),
    desktop3p: sumTranscripts(byClass['desktop-3p'], windows, nowMs)
  };

  const report = {
    generatedAt: iso(nowMs),
    roots: collected.roots.map((root) => ({
      dir: root.root, variant: root.variant, file: root.file, error: root.error || null,
      version: root.version ?? null, samples: root.samples.length, warnings: root.warnings || []
    })),
    quota: {
      organizations: collected.orgs,
      orgFilter: collected.orgFilter || null,
      warnings: collected.warnings,
      selectedOrg: collected.selected?.org || null,
      selectedRoot: collected.selected?.root || null,
      latestSampleAt: iso(collected.selected?.latest?.t),
      latestUsage: collected.selected?.latest?.usage || null,
      estimatedSessionResetAt: iso(collected.selected?.sessionResetsAt),
      estimatedWeeklyResetAt: iso(collected.selected?.weeklyResetsAt),
      providerRow: provider,
      recentSamples: (args.samples > 0 ? series.slice(-args.samples) : []).map((s) => ({ t: iso(s.t), org: s.org, u: s.usage }))
    },
    sessions: {
      claudeConfig,
      transcriptFiles: candidates.length,
      desktopSessions: sessionsByClass.desktop.size,
      desktopThirdPartySessions: sessionsByClass['desktop-3p'].size,
      otherSessions: sessionsByClass.other.size,
      desktopTokens: tokens.desktop,
      desktopThirdPartyTokens: tokens.desktop3p
    }
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push('Claude Desktop local verification (read-only, no network)');
  lines.push(`generated: ${report.generatedAt}`);
  lines.push('', '== userData roots');
  if (report.roots.length === 0) lines.push('  (none found; pass --dir)');
  for (const root of report.roots) {
    lines.push(`  [${root.variant}] ${root.dir}`);
    lines.push(`      plan-usage-history.json: ${root.error ? `error=${root.error}` : `version=${root.version} samples=${root.samples}`}${root.warnings.length ? ` warnings=${root.warnings.join(',')}` : ''}`);
  }
  lines.push('', '== quota samples (scheme A)');
  lines.push(`  organizations: ${report.quota.organizations.join(', ') || '(none)'}${report.quota.orgFilter ? `  filter=${report.quota.orgFilter}` : ''}`);
  if (report.quota.warnings.length) lines.push(`  warnings: ${report.quota.warnings.join(', ')}`);
  lines.push(`  selected: org=${report.quota.selectedOrg || '-'} root=${report.quota.selectedRoot || '-'}`);
  lines.push(`  latest sample: ${report.quota.latestSampleAt || '-'}  u=${JSON.stringify(report.quota.latestUsage)}`);
  lines.push(`  estimated resets: 5h=${report.quota.estimatedSessionResetAt || 'unknown'}  7d=${report.quota.estimatedWeeklyResetAt || 'unknown'}`);
  lines.push(`  provider row: status=${provider.status} windows=${provider.windows.map((w) => `${w.kind}:${w.usedPercent}%`).join(' ') || '-'}`);
  for (const s of report.quota.recentSamples) lines.push(`    ${s.t}  org=${s.org || '-'}  ${JSON.stringify(s.u)}`);
  lines.push('', '== Desktop sessions (scheme B)');
  lines.push(`  transcripts scanned: ${report.sessions.transcriptFiles} (projects: ${path.join(claudeConfig, 'projects')})`);
  lines.push(`  sessions: desktop=${report.sessions.desktopSessions} desktop-3p=${report.sessions.desktopThirdPartySessions} other=${report.sessions.otherSessions}`);
  for (const [label, totals] of [['claude-desktop', tokens.desktop], ['desktop-3p (stays under claude)', tokens.desktop3p]]) {
    lines.push(`  ${label}:`);
    for (const [name, t] of Object.entries(totals)) {
      lines.push(`    ${name.padEnd(7)} total=${t.total} input=${t.input} output=${t.output} cacheWrite=${t.cacheCreation} cacheRead=${t.cacheRead} messages=${t.messages}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
}
