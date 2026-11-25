'use strict';

// This on-demand ledger is deliberately separate from Tokscale's period totals.
// Input/cache and output/reasoning are overlapping buckets, not four addends.
const FIELDS = {
  inputTokens: 'input_tokens', cachedInputTokens: 'cached_input_tokens',
  cacheWriteInputTokens: 'cache_write_input_tokens', outputTokens: 'output_tokens',
  reasoningOutputTokens: 'reasoning_output_tokens', totalTokens: 'total_tokens'
};
const OPTIONAL = new Set(['cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens']);
const MAX_THREADS = 50000;
const MAX_REQUESTS = 500000;

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : null;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, snake] of Object.entries(FIELDS)) {
    if (raw[key] !== undefined && raw[snake] !== undefined && raw[key] !== raw[snake]) return null;
    const v = raw[key] ?? raw[snake];
    if (v === undefined || v === null) {
      if (OPTIONAL.has(key) || key === 'totalTokens') { out[key] = null; continue; }
      return null;
    }
    if (!Number.isSafeInteger(v) || v < 0) return null;
    out[key] = v;
  }
  const total = out.inputTokens + out.outputTokens;
  if (!Number.isSafeInteger(total) || (out.totalTokens !== null && out.totalTokens !== total)) return null;
  if (out.cachedInputTokens > out.inputTokens || out.reasoningOutputTokens > out.outputTokens) return null;
  out.totalTokens = total;
  return out;
}

function sumUsage(values) {
  const rows = values.filter(Boolean);
  if (!rows.length) return null;
  const out = {};
  for (const key of Object.keys(FIELDS)) {
    if (rows.some((r) => r[key] === null)) { out[key] = null; continue; }
    const value = rows.reduce((n, r) => n + r[key], 0);
    if (!Number.isSafeInteger(value)) throw new RangeError('usage-total-overflow');
    out[key] = value;
  }
  return out;
}

function sameUsage(a, b) {
  return Object.keys(FIELDS).every((key) => a[key] === b[key]);
}

function sourceInfo(value) {
  let v = value;
  if (typeof v === 'string' && v.startsWith('{')) {
    try { v = JSON.parse(v); } catch (_) { return { kind: 'unknown', parent: null }; }
  }
  const sub = v && typeof v === 'object' ? (v.subagent || v.subAgent) : null;
  if (sub) return {
    kind: 'subagent',
    parent: identifier(sub.thread_spawn?.parent_thread_id || sub.threadSpawn?.parentThreadId)
  };
  const allowed = ['cli', 'exec', 'vscode', 'subAgent', 'subAgentThreadSpawn', 'subAgentReview', 'subAgentCompact', 'subAgentOther'];
  return { kind: allowed.includes(v) ? v : 'unknown', parent: null };
}

class TaskUsageLedger {
  constructor() {
    this.threads = new Map();
    this.requests = new Map();
    this.diagnostics = new Map();
  }

  diagnose(code, threadId = null) {
    const key = `${code}:${threadId || ''}`;
    const prev = this.diagnostics.get(key);
    if (prev) prev.count += 1;
    else if (this.diagnostics.size < 1000) this.diagnostics.set(key, { code, threadId, count: 1 });
    const thread = this.threads.get(threadId);
    if (thread) thread.issues.add(code);
  }

  thread(id) {
    id = identifier(id);
    if (!id) { this.diagnose('invalid-thread-id'); return null; }
    if (!this.threads.has(id)) {
      if (this.threads.size >= MAX_THREADS) throw new RangeError('thread-limit-exceeded');
      this.threads.set(id, { id, parentThreadId: null, sourceKind: 'unknown', model: null,
        modelProvider: null, executionEnvironment: 'unknown', taskId: null, dotId: null,
        forked: false, issues: new Set(), evidence: new Set(), snapshots: new Set(), snapshot: null });
    }
    return this.threads.get(id);
  }

  metadata(meta, evidence = 'event-import') {
    if (!meta || typeof meta !== 'object') return;
    const t = this.thread(meta.id || meta.threadId || meta.thread_id);
    if (!t) return;
    t.evidence.add(evidence);
    const src = sourceInfo(meta.source);
    if (src.kind !== 'unknown') t.sourceKind = src.kind;
    const parent = identifier(meta.parentThreadId || meta.parent_thread_id) || src.parent;
    if (parent) {
      this.thread(parent);
      if (t.parentThreadId && t.parentThreadId !== parent) this.diagnose('conflicting-parent', t.id);
      else t.parentThreadId = parent;
    }
    for (const [key, value] of Object.entries({ model: meta.model, modelProvider: meta.modelProvider || meta.model_provider,
      taskId: meta.taskId, dotId: meta.dotId })) {
      const clean = typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : null;
      if (clean) {
        if (t[key] && t[key] !== clean) this.diagnose(`multiple-${key}`, t.id);
        t[key] = clean;
      }
    }
    if (['local', 'cloud'].includes(meta.executionEnvironment)) {
      if (t.executionEnvironment !== 'unknown' && t.executionEnvironment !== meta.executionEnvironment) this.diagnose('conflicting-environment', t.id);
      else t.executionEnvironment = meta.executionEnvironment;
    }
    if (meta.forked_from_id || meta.forkedFromId) { t.forked = true; this.diagnose('forked-history', t.id); }
  }

  addSnapshot(id, raw, evidence, observedAt = null) {
    const t = this.thread(id);
    if (!t) return;
    t.evidence.add(evidence);
    const u = normalizeUsage(raw);
    if (!u) { this.diagnose('invalid-usage', id); return; }
    const time = typeof observedAt === 'string' && Number.isFinite(Date.parse(observedAt)) ? observedAt : 'no-timestamp';
    const key = `${time}:${JSON.stringify(u)}`;
    // Replaying an export (including its earlier snapshots) is a no-op.
    if (t.snapshots.has(key)) return;
    t.snapshots.add(key);
    if (t.snapshots.size > MAX_REQUESTS) throw new RangeError('snapshot-limit-exceeded');
    if (t.snapshot && ['inputTokens', 'outputTokens', 'totalTokens'].some((k) => u[k] < t.snapshot[k])) {
      this.diagnose('nonmonotonic-snapshot', id);
    }
    if (!t.snapshot || u.totalTokens >= t.snapshot.totalTokens) t.snapshot = u;
  }

  addRequest(body, evidence) {
    const id = identifier(body.thread_id || body.threadId);
    const requestId = identifier(body.response_id || body.responseId);
    const t = this.thread(id);
    if (!t) return;
    t.evidence.add(evidence);
    const u = normalizeUsage(body.usage);
    if (!requestId || !u) { this.diagnose('invalid-request-record', id); return; }
    const prior = this.requests.get(requestId);
    if (prior) {
      if (prior.threadId !== id || !sameUsage(prior.usage, u)) {
        prior.conflict = true;
        this.diagnose('conflicting-request', prior.threadId);
        this.diagnose('conflicting-request', id);
      }
      return;
    }
    if (this.requests.size >= MAX_REQUESTS) throw new RangeError('request-limit-exceeded');
    this.requests.set(requestId, { threadId: id, usage: u, conflict: false });
  }

  ingest(event, { threadId = null, evidence = 'event-import' } = {}) {
    if (!event || typeof event !== 'object') { this.diagnose('invalid-event', threadId); return; }
    const body = event.payload || {};
    if (event.type === 'session_meta') {
      const actual = identifier(body.id);
      if (threadId && actual && threadId !== actual) {
        this.diagnose('rollout-identity-mismatch', threadId);
        return;
      }
      this.metadata(body, evidence);
    } else if (event.type === 'token_usage_record') {
      this.addRequest(body, evidence);
    } else if (event.type === 'event_msg' && body.type === 'token_count') {
      if (body.info?.total_token_usage) this.addSnapshot(threadId, body.info.total_token_usage, evidence, event.timestamp);
    } else if (event.method === 'thread/tokenUsage/updated') {
      const p = event.params || {};
      this.addSnapshot(p.threadId, p.tokenUsage?.total, evidence, event.timestamp);
    } else if (event.method === 'thread/started') {
      this.metadata(event.params?.thread, evidence);
    } else if (event.type === 'token-monitor.task-manifest' && event.version === 1) {
      // Our explicit import contract, NOT an official Codex cloud export API.
      for (const meta of Array.isArray(event.threads) ? event.threads : []) this.metadata(meta, 'manifest');
    }
  }

  descendants(id) {
    const selected = new Set([id]);
    const queue = [id];
    const children = new Map();
    for (const t of this.threads.values()) {
      if (!children.has(t.parentThreadId)) children.set(t.parentThreadId, []);
      children.get(t.parentThreadId).push(t.id);
    }
    for (let i = 0; i < queue.length; i += 1) {
      for (const child of children.get(queue[i]) || []) {
        if (!selected.has(child)) { selected.add(child); queue.push(child); }
      }
    }
    return selected;
  }

  report(root = null) {
    if (root && !this.threads.has(root)) { this.thread(root); this.diagnose('thread-not-found', root); }
    const selected = root ? this.descendants(root) : new Set(this.threads.keys());
    const requestsByThread = new Map();
    for (const request of this.requests.values()) {
      if (request.conflict) continue;
      if (!requestsByThread.has(request.threadId)) requestsByThread.set(request.threadId, []);
      requestsByThread.get(request.threadId).push(request.usage);
    }
    const rows = [];
    for (const id of selected) {
      const t = this.threads.get(id);
      const chain = new Set([id]);
      let p = t.parentThreadId;
      while (p && this.threads.has(p)) {
        if (chain.has(p)) { this.diagnose('parent-cycle', id); break; }
        chain.add(p); p = this.threads.get(p).parentThreadId;
      }
      const records = requestsByThread.get(id) || [];
      const recordsUsage = sumUsage(records);
      let ownUsage = recordsUsage;
      let status = recordsUsage ? 'request-records' : 'unknown';
      if (recordsUsage && t.snapshot) {
        if (sameUsage(recordsUsage, t.snapshot)) status = 'reconciled';
        else { status = 'partial'; this.diagnose('records-snapshot-mismatch', id); }
      } else if (!recordsUsage && t.snapshot && !t.forked && !t.issues.has('nonmonotonic-snapshot') && !t.issues.has('rollout-identity-mismatch')) {
        ownUsage = t.snapshot; status = 'snapshot-only';
      }
      if (t.issues.size && ownUsage) status = 'partial';
      rows.push({ threadId: id, parentThreadId: t.parentThreadId, sourceKind: t.sourceKind,
        model: t.model, modelProvider: t.modelProvider, executionEnvironment: t.executionEnvironment,
        taskId: t.taskId, dotId: t.dotId, ownUsage, reportedLifetimeUsage: t.snapshot,
        uniqueRequests: records.length, status, evidence: [...t.evidence].sort(), issues: [...t.issues].sort() });
    }
    const knownUsage = sumUsage(rows.map((r) => r.ownUsage));
    const covered = rows.filter((r) => r.ownUsage !== null).length;
    return {
      version: 1, scope: 'observed-thread-lifetime', rootThreadId: root,
      accountCloudCoverage: 'unknown', knownUsage,
      rootOwnUsage: root ? rows.find((r) => r.threadId === root)?.ownUsage || null : null,
      descendantsKnownUsage: root ? sumUsage(rows.filter((r) => r.threadId !== root).map((r) => r.ownUsage)) : null,
      coverage: { knownThreads: rows.length, measuredThreads: covered, missingUsageThreads: rows.length - covered,
        reconciledThreads: rows.filter((r) => r.status === 'reconciled').length,
        snapshotOnlyThreads: rows.filter((r) => r.status === 'snapshot-only').length,
        partialThreads: rows.filter((r) => r.status === 'partial').length },
      threads: rows.sort((a, b) => a.threadId.localeCompare(b.threadId)),
      diagnostics: [...this.diagnostics.values()].filter((d) => !d.threadId || selected.has(d.threadId)),
      warnings: ['Observed usage only; absent cloud tasks and undiscovered children are not zero.',
        'Snapshot-only usage lacks per-request deduplication evidence; do not add this report to Tokscale totals.',
        'Cached input is included in input; reasoning is included in output. No daily or billing claim.']
    };
  }
}

module.exports = { TaskUsageLedger, normalizeUsage, sumUsage, sourceInfo, identifier };
