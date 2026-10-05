'use strict';

// Automatic discovery + viewer attachment. This transport cannot create turns.
const { CloudTransport, MAX_BYTES } = require('./cloudTransport');
const { CloudLiveMeter } = require('./cloudLiveMeter');
const { SOURCE_KINDS, page, identifier, error } = require('./cloudUsage');
const { escapeHtml } = require('./usageView');
const ALLOWED = new Set(['initialize', 'thread/list', 'thread/read', 'thread/resume', 'thread/unsubscribe']);
const EVENT_METHODS = new Set(['thread/tokenUsage/updated', 'thread/status/changed', 'thread/started', 'turn/started', 'turn/completed']);
const safeCode = (e) => /^[A-Z_]{1,80}$/.test(e?.code || '') ? e.code : 'CLOUD_READ_FAILED';

class AutoCloudConnection extends CloudTransport {
  constructor(options = {}, deps = {}) {
    super({ ...options, budgetMs: 180000 }, deps);
    this.eventSink = null;
  }
  send(method, params) {
    if (!ALLOWED.has(method)) return Promise.reject(error('AUTO_WRITE_DENIED'));
    if (method === 'thread/resume' && (Object.keys(params).sort().join(',') !== 'excludeTurns,threadId' || params.excludeTurns !== true)) return Promise.reject(error('AUTO_OVERRIDE_DENIED'));
    if (method === 'thread/read' && params.includeTurns !== false) return Promise.reject(error('MESSAGE_CONTENT_DENIED'));
    return super.send(method, params);
  }
  renewLease() {
    this.assertIdentity(); clearTimeout(this.timer);
    this.deadline = Date.now() + 180000;
    this.timer = setTimeout(() => this.fail('HEARTBEAT_TIMEOUT'), 180000);
  }
  onMessage(data) {
    super.onMessage(data);
    if (this.closed || !this.eventSink) return;
    const bytes = typeof data === 'string' ? Buffer.from(data) : data instanceof ArrayBuffer ? Buffer.from(data) : null;
    if (!bytes || bytes.length > MAX_BYTES) return;
    let event;
    try { event = JSON.parse(bytes.toString('utf8')); } catch (_) { return; }
    if (event.id !== undefined || !EVENT_METHODS.has(event.method)) return;
    try { this.assertIdentity(); this.eventSink(event); }
    catch (e) { this.fail(safeCode(e)); }
  }
}
function statusOf(raw) {
  const value = raw?.status?.type;
  return ['active', 'idle', 'notLoaded', 'systemError'].includes(value) ? value : 'unknown';
}
function metadata(raw, now) {
  const id = identifier(raw.id);
  const source = raw.source?.subAgent || raw.source?.subagent;
  const edge = source?.thread_spawn || source?.threadSpawn;
  const parent = raw.parentThreadId ?? edge?.parent_thread_id ?? edge?.parentThreadId;
  const seconds = (n) => Number.isFinite(n) && n >= 0 && n <= now / 1000 + 300 ? Math.trunc(n * 1000) : null;
  return { threadId: id, engineParentId: parent == null ? null : identifier(parent),
    delegationParentId: null, kind: typeof raw.threadSource === 'string' && /^[a-zA-Z_]{1,60}$/.test(raw.threadSource) ? raw.threadSource : source ? 'subagent' : 'unknown',
    runtimeStatus: statusOf(raw), createdMs: seconds(raw.createdAt), updatedMs: seconds(raw.updatedAt) };
}

class AutoCloudMonitor {
  constructor({ maxListening = 32, maxKnown = 1000, maxPages = 3, idleGraceMs = 60000, recentMs = 120000, now = Date.now, onSample = () => {}, onState = () => {} } = {}) {
    if (![maxListening, maxKnown, maxPages, idleGraceMs, recentMs].every(Number.isSafeInteger) || maxListening < 1 || maxListening > 128 || maxKnown < maxListening || maxKnown > 5000 || maxPages < 1 || maxPages > 20 || idleGraceMs < 0 || recentMs < 0) throw error('INVALID_AUTO_LIMIT');
    Object.assign(this, { maxListening, maxKnown, maxPages, idleGraceMs, recentMs, now, onSample, onState });
    this.rows = new Map(); this.listening = new Set(); this.pending = new Set(); this.retryAfter = new Map();
    this.scopeFingerprint = null; this.connection = null; this.connectionNumber = 0; this.lastDiscoveryAt = null;
    this.discoveryComplete = false; this.diagnostics = []; this.runningCycle = false; this.recycle = false; this.scans = 0; this.state = 'starting';
  }
  diagnose(code, threadId = null) {
    this.diagnostics.push({ code, threadId, at: new Date(this.now()).toISOString() });
    if (this.diagnostics.length > 50) this.diagnostics.shift();
  }
  connect(rpc) {
    if (!/^[a-f0-9]{64}$/.test(rpc.scopeFingerprint || '')) throw error('MISSING_ACCOUNT_SCOPE');
    if (this.scopeFingerprint && this.scopeFingerprint !== rpc.scopeFingerprint) throw error('ACCOUNT_SCOPE_CHANGED');
    this.scopeFingerprint = rpc.scopeFingerprint; this.connection = rpc; this.connectionNumber += 1;
    for (const row of this.rows.values()) row.runtimeStatus = 'unknown';
    this.listening.clear(); this.pending.clear(); this.retryAfter.clear(); this.recycle = false; this.state = 'discovering';
    rpc.eventSink = (event) => this.observe(event); this.onState(this.report());
  }
  disconnect(code = 'CLOUD_CLOSED') {
    if (this.connection) this.connection.eventSink = null;
    this.connection = null; this.listening.clear(); this.pending.clear(); this.state = 'reconnecting';
    this.diagnose(code); this.onState(this.report());
  }
  upsert(meta) {
    const prior = this.rows.get(meta.threadId);
    if (!prior && this.rows.size >= this.maxKnown) { this.discoveryComplete = false; this.diagnose('KNOWN_THREAD_LIMIT'); return null; }
    const row = prior || { threadId: meta.threadId, detectedAt: new Date(this.now()).toISOString(), meter: new CloudLiveMeter(meta.threadId, { maxSamples: 16 }), lastActiveMs: 0, attachedAt: null, lastAttachedConnection: null, attachAttempts: 0, gapCount: 0, parentConflict: false };
    if (row.engineParentId && meta.engineParentId && row.engineParentId !== meta.engineParentId) row.parentConflict = true;
    const delegation = row.delegationParentId;
    Object.assign(row, meta);
    row.delegationParentId ||= delegation || null;
    if (row.parentConflict) row.engineParentId = null;
    if (meta.runtimeStatus === 'active') row.lastActiveMs = this.now();
    row.lastSeenMs = this.now(); this.rows.set(meta.threadId, row); return row;
  }
  observe(event) {
    if (!this.connection) return;
    const params = event.params || {};
    if (event.method === 'thread/started') {
      try { this.upsert(metadata(params.thread, this.now())); } catch (_) {}
      return;
    }
    const row = this.rows.get(params.threadId);
    if (!row || (!this.listening.has(row.threadId) && !this.pending.has(row.threadId))) return;
    if (event.method === 'thread/tokenUsage/updated') {
      // Identity is checked in the transport before persistence, never after.
      this.connection.assertIdentity();
      const sample = row.meter.observe(event, new Date(this.now()).toISOString());
      row.lastActiveMs = this.now();
      if (sample) this.onSample({ scopeFingerprint: this.scopeFingerprint, connectionNumber: this.connectionNumber, sample });
      if (row.meter.problem) this.diagnose(row.meter.problem, row.threadId);
    } else if (event.method === 'turn/started') { row.runtimeStatus = 'active'; row.lastActiveMs = this.now(); }
    else if (event.method === 'turn/completed') { row.runtimeStatus = 'idle'; row.lastActiveMs = this.now(); }
    else if (event.method === 'thread/status/changed') { row.runtimeStatus = statusOf({ status: params.status }); if (row.runtimeStatus === 'active') row.lastActiveMs = this.now(); }
  }
  candidate(row) {
    if (row.archived) return row.runtimeStatus === 'active';
    if (row.runtimeStatus === 'active') return true;
    // Attach a recently created warm thread before its next request. Never cold
    // load historical notLoaded entries merely because they appear in a list.
    return row.runtimeStatus === 'idle' && row.createdMs !== null && row.createdMs >= this.now() - this.recentMs;
  }
  async discover(rpc, { archived = false } = {}) {
    let complete = true; let successfulPages = 0; const discovered = new Map();
    for (const filtered of [false, true]) {
      let cursor = null; const cursors = new Set(); let done = false;
      try {
        for (let n = 0; n < this.maxPages; n += 1) {
          rpc.assertIdentity();
          const params = { limit: 100, archived, sortKey: 'updated_at', sortDirection: 'desc' };
          if (filtered) params.sourceKinds = SOURCE_KINDS;
          if (cursor) params.cursor = cursor;
          const result = page(await rpc.request('thread/list', params)); successfulPages += 1;
          for (const raw of result.data) {
            try { const value = metadata(raw, this.now()); discovered.set(value.threadId, { ...value, archived }); }
            catch (_) { complete = false; this.diagnose('INVALID_DISCOVERY_ROW'); }
          }
          if (!result.cursor) { done = true; break; }
          if (cursors.has(result.cursor)) throw error('REPEATED_DISCOVERY_CURSOR');
          cursors.add(result.cursor); cursor = result.cursor;
        }
      } catch (e) {
        complete = false; this.diagnose(safeCode(e));
        if (['LOGIN_CHANGED', 'CLOUD_CLOSED', 'CLOUD_CONNECT_FAILED', 'DEADLINE', 'HEARTBEAT_TIMEOUT'].includes(safeCode(e))) throw e;
      }
      if (!done) complete = false;
    }
    return { discovered, complete, successfulPages };
  }
  async cycle({ includeArchived = false, seedReferences = [] } = {}) {
    if (this.runningCycle) throw error('OVERLAPPING_AUTO_SCAN');
    const rpc = this.connection;
    if (!rpc || rpc.closed) throw error('CLOUD_CLOSED');
    this.runningCycle = true;
    try {
      this.discoveryComplete = true;
      const regular = await this.discover(rpc);
      if (!regular.successfulPages) throw error('DISCOVERY_UNAVAILABLE');
      this.discoveryComplete = regular.complete;
      for (const value of regular.discovered.values()) this.upsert(value);
      if (includeArchived) {
        const archived = await this.discover(rpc, { archived: true }); this.discoveryComplete &&= archived.complete;
        for (const value of archived.discovered.values()) if (!regular.discovered.has(value.threadId)) this.upsert(value);
      }
      for (const seed of seedReferences) {
        const row = this.rows.get(seed.threadId);
        if (row && seed.bindingEvidence === 'cache-account-and-user-matched') {
          if (seed.delegationParentId) { try { row.delegationParentId = identifier(seed.delegationParentId); } catch (_) {} }
        }
      }
      this.lastDiscoveryAt = new Date(this.now()).toISOString(); this.scans += 1;
      // Detach idlers without touching the model task. If the hosted backend
      // cannot unsubscribe, recycle this viewer connection instead.
      for (const id of [...this.listening]) {
        const row = this.rows.get(id);
        if (row.runtimeStatus === 'active' || this.candidate(row) || this.now() - row.lastActiveMs < this.idleGraceMs) continue;
        try {
          const response = await rpc.send('thread/unsubscribe', { threadId: id });
          if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(response?.status)) throw error('DETACH_UNSUPPORTED');
          this.listening.delete(id);
        } catch (_) { this.recycle = true; this.diagnose('VIEWER_RECYCLE_FOR_DETACH'); break; }
      }
      const candidates = [...this.rows.values()].filter((r) => this.candidate(r) && !this.listening.has(r.threadId))
        .sort((a, b) => Number(b.runtimeStatus === 'active') - Number(a.runtimeStatus === 'active') || (b.updatedMs || 0) - (a.updatedMs || 0));
      for (const row of candidates) {
        if (this.recycle || this.listening.size >= this.maxListening) break;
        if ((this.retryAfter.get(row.threadId) || 0) > this.now()) continue;
        if (rpc.closed) throw error('CLOUD_CLOSED');
        this.pending.add(row.threadId); row.attachAttempts += 1;
        try {
          const response = await rpc.send('thread/resume', { threadId: row.threadId, excludeTurns: true });
          if (response?.thread?.id !== row.threadId) throw error('AUTO_THREAD_MISMATCH');
          if (row.lastAttachedConnection !== null && row.lastAttachedConnection !== this.connectionNumber) row.gapCount += 1;
          row.lastAttachedConnection = this.connectionNumber; row.attachedAt = new Date(this.now()).toISOString();
          row.lastActiveMs = this.now(); this.listening.add(row.threadId);
        } catch (e) { this.retryAfter.set(row.threadId, this.now() + 60000); this.diagnose(safeCode(e), row.threadId); }
        finally { this.pending.delete(row.threadId); }
      }
      rpc.renewLease?.(); this.state = 'listening'; this.onState(this.report());
      return this.report();
    } finally { this.runningCycle = false; }
  }
  report() {
    const threads = [...this.rows.values()].map((r) => {
      const meter = r.meter.report();
      return { threadId: r.threadId, kind: r.kind, engineParentId: r.engineParentId || null, delegationParentId: r.delegationParentId || null,
        runtimeStatus: r.runtimeStatus, discoveredAt: r.detectedAt, createdMs: r.createdMs, updatedMs: r.updatedMs, archived: !!r.archived,
        listening: this.listening.has(r.threadId), attachedAt: r.attachedAt, attachAttempts: r.attachAttempts, gapCount: r.gapCount,
        status: meter.status, total: meter.total, lastRequest: meter.lastRequest, lastTurnId: meter.lastTurnId,
        observedAt: meter.observedAt, problem: meter.problem, receivedEvents: meter.coverage.receivedEvents, duplicateEvents: meter.coverage.duplicateEvents };
    });
    return { version: 1, kind: 'codex-cloud-auto-watch', source: 'hosted-engine-token-notification', state: this.state,
      observedAt: new Date(this.now()).toISOString(), lastDiscoveryAt: this.lastDiscoveryAt, scopeFingerprint: this.scopeFingerprint,
      connectionNumber: this.connectionNumber, scans: this.scans, discoveryComplete: this.discoveryComplete,
      knownThreads: threads.length, listeningThreads: this.listening.size, measuredThreads: threads.filter((t) => t.total !== null).length,
      waitingForSlot: threads.filter((t) => this.candidate(t) && !t.listening).length,
      taskTotalTokens: null, accountCloudCoverage: 'unknown', completeRequestHistory: false, canCombineWithLocal: false,
      threads, diagnostics: this.diagnostics.map((d) => ({ ...d })) };
  }
}
function renderAutoHtml(report) {
  const e = escapeHtml; const n = (v) => v == null ? '未知' : e(v.toLocaleString('en-US'));
  const rows = [...report.threads].sort((a, b) => Number(b.listening) - Number(a.listening) || (b.total?.totalTokens || 0) - (a.total?.totalTokens || 0));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Codex 云端自动监听</title><style>body{font:15px/1.6 system-ui;max-width:1440px;margin:32px auto;padding:0 24px;color:#182233;background:#f6f8fb}h1{font-size:28px}.cards{display:flex;gap:14px;flex-wrap:wrap}.card{padding:18px;background:white;border:1px solid #d5dfe9;border-radius:12px;min-width:170px}.big{font-size:30px;font-weight:700}.note{padding:16px;border-left:4px solid #b87c10;background:#fff3d5}.table{overflow:auto}table{width:100%;border-collapse:collapse;background:white}td,th{text-align:left;padding:10px;border-bottom:1px solid #dfe5ed}code{font-size:11px;overflow-wrap:anywhere}small{display:block;color:#617085}</style></head><body><small>TOKEN MONITOR · AUTOMATIC CLOUD OBSERVER</small><h1>Codex 云端自动发现与监听</h1><p>状态：<strong>${e(report.state)}</strong> · 最近扫描 ${e(report.lastDiscoveryAt || '尚未完成')} · 报告更新 ${e(report.observedAt)}</p><div class="cards"><div class="card">发现线程<div class="big">${n(report.knownThreads)}</div></div><div class="card">当前监听<div class="big">${n(report.listeningThreads)}</div></div><div class="card">已取得计数<div class="big">${n(report.measuredThreads)}</div></div><div class="card">等待空位<div class="big">${n(report.waitingForSlot)}</div></div></div><p class="note">自动发现正在运行的任务，并监听其真实引擎 token 事件；不会启动模型轮次。短于扫描间隔的任务、离线期间及历史任务可能漏采，未知不为零。各线程是累计快照；父子覆盖未经证实，故不显示相加总量。页面每 5 秒刷新，但请核对报告时间，旧文件不代表进程仍在线。</p><div class="table"><table><thead><tr><th>线程 / 类型</th><th>运行 / 监听</th><th>输入</th><th>缓存输入</th><th>输出</th><th>累计 Token</th><th>最近计数 / 缺口</th></tr></thead><tbody>${rows.map((t) => `<tr><td><code>${e(t.threadId)}</code><small>${e(t.kind)} · 父级 ${e(t.engineParentId || t.delegationParentId || '未知')}</small></td><td>${e(t.runtimeStatus)}<small>${t.listening ? '正在监听' : '未监听'} · ${e(t.status)}</small></td><td>${n(t.total?.inputTokens)}</td><td>${n(t.total?.cachedInputTokens)}</td><td>${n(t.total?.outputTokens)}</td><td><strong>${n(t.total?.totalTokens)}</strong></td><td>${e(t.observedAt || '未收到')}<small>重连缺口 ${n(t.gapCount)}</small></td></tr>`).join('') || '<tr><td colspan="7">等待自动发现云端任务。</td></tr>'}</tbody></table></div><p>目录分页完成：${report.discoveryComplete ? '是（仅本次目录）' : '否 / 尚未完成'} · 会话连接 ${n(report.connectionNumber)} · ${e(report.diagnostics.slice(-5).map((d) => d.code).join(' / '))}</p></body></html>`;
}
module.exports = { AutoCloudConnection, AutoCloudMonitor, renderAutoHtml, metadata, safeCode };
