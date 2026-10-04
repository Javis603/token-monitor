'use strict';

// Numeric-only projection of events actually delivered by the cloud engine.
// A total is a cumulative snapshot, never an additive per-turn ledger.
const { normalizeUsage } = require('./taskUsage');
const { identifier, error } = require('./cloudUsage');
const { escapeHtml } = require('./usageView');

class CloudLiveMeter {
  constructor(threadId, { maxSamples = 1024 } = {}) {
    this.threadId = identifier(threadId);
    if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 4096) throw error('INVALID_SAMPLE_LIMIT');
    this.maxSamples = maxSamples; this.samples = []; this.latest = null;
    this.received = 0; this.duplicates = 0; this.truncated = false; this.problem = null;
  }
  observe(message, observedAt = new Date().toISOString()) {
    if (message?.method !== 'thread/tokenUsage/updated' || message.id !== undefined || message.params?.threadId !== this.threadId) return null;
    const p = message.params;
    let turnId;
    try { turnId = identifier(p.turnId); } catch (_) { this.problem = 'INVALID_TURN_ID'; return null; }
    const total = normalizeUsage(p.tokenUsage?.total), last = normalizeUsage(p.tokenUsage?.last);
    if (!total || !last || last.totalTokens > total.totalTokens || last.inputTokens > total.inputTokens || last.outputTokens > total.outputTokens) {
      this.problem = 'INVALID_ENGINE_USAGE'; return null;
    }
    if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) throw error('INVALID_OBSERVATION_TIME');
    this.received += 1;
    const key = JSON.stringify([turnId, total, last]);
    if (this.latest?.key === key) { this.duplicates += 1; return null; }
    if (this.latest && ['inputTokens', 'outputTokens', 'totalTokens'].some((f) => total[f] < this.latest.total[f])) this.problem = 'NONMONOTONIC_COUNTER';
    const sample = { threadId: this.threadId, turnId, total, last, observedAt };
    this.latest = { ...sample, key };
    if (this.samples.length < this.maxSamples) this.samples.push(sample); else this.truncated = true;
    return sample;
  }
  report() {
    return { version: 1, kind: 'codex-cloud-live-token-count', source: 'hosted-engine-token-notification',
      threadId: this.threadId, measurement: this.latest ? 'engine-reported-cumulative' : 'unavailable',
      status: this.problem ? 'ambiguous' : this.latest ? 'observed' : 'no-usage-notification',
      total: this.problem ? null : this.latest?.total || null,
      lastRequest: this.latest?.last || null, lastTurnId: this.latest?.turnId || null,
      observedAt: this.latest?.observedAt || null, samples: this.samples.map((s) => ({ ...s })),
      coverage: { receivedEvents: this.received, duplicateEvents: this.duplicates,
        retainedSamples: this.samples.length, sampleHistoryTruncated: this.truncated,
        completeRequestHistory: false, historicalBackfill: false, accountCloudCoverage: 'unknown' },
      problem: this.problem, includesDescendants: 'unknown', canCombineWithLocal: false };
  }
}
function renderCloudLiveHtml(report) {
  const num = (n) => n === null || n === undefined ? '未知' : escapeHtml(n.toLocaleString('en-US'));
  const counts = report.total;
  const rows = (report.samples || []).map((s) => `<tr><td><code>${escapeHtml(s.turnId)}</code></td><td>${num(s.total.inputTokens)}</td><td>${num(s.total.outputTokens)}</td><td>${num(s.total.totalTokens)}</td><td>${escapeHtml(s.observedAt)}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Codex 云端实时 Token</title><style>body{font:16px/1.6 system-ui;max-width:1200px;margin:40px auto;padding:0 24px;color:#172033;background:#f6f8fc}h1{font-size:30px}section{background:white;border:1px solid #dbe2ec;border-radius:12px;padding:22px;margin:20px 0}.big{font-size:40px;font-weight:750}.note{padding:16px;border-left:4px solid #b67a10;background:#fff4da}.table{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #dbe2ec}code{font-size:12px;overflow-wrap:anywhere}small{color:#59677e}</style></head><body><small>TOKEN MONITOR · HOSTED ENGINE EVENTS</small><h1>Codex 云端实时 Token</h1>
<p>线程：<code>${escapeHtml(report.threadId)}</code></p><p>状态：<strong>${escapeHtml(report.status)}</strong> · 最近计数：${escapeHtml(report.observedAt || '尚未收到')}</p>
${report.testOnly ? '<p class="note">这是已完成的隔离云端验证任务，不是你的历史项目或全账户总量。</p>' : ''}
<section><small>该线程最新的引擎累计快照 · 未将多次上报相加</small><div class="big">${num(counts?.totalTokens)} Token</div><p>输入 ${num(counts?.inputTokens)} · 输出 ${num(counts?.outputTokens)} · 缓存输入 ${num(counts?.cachedInputTokens)}（包含于输入）· 推理输出 ${num(counts?.reasoningOutputTokens)}（包含于输出）</p></section>
<p class="note">数据来自真正的云端引擎用量事件，不是 credits、额度比例或费用换算。这里只记录连接期间实际收到的计数；未补回历史逐请求记录，也未验证父线程是否含子代理用量。不能与本地日志、账户总量重复相加。</p>
<h2>收到的累计快照</h2><div class="table"><table><thead><tr><th>轮次 ID</th><th>累计输入</th><th>累计输出</th><th>累计总量</th><th>接收时间</th></tr></thead><tbody>${rows || '<tr><td colspan="5">没有收到 token 通知；未知不代表零。已结束且不再产生事件的任务通常不会在此窗口出数。</td></tr>'}</tbody></table></div>
<p>接收 ${num(report.coverage?.receivedEvents)} 次，忽略连续重复 ${num(report.coverage?.duplicateEvents)} 次。${report.problem ? escapeHtml(report.problem) : ''}</p>
<small>本地静态报告，不会继续采集。重新接入已有线程会加载其运行状态，可能连接工作环境；监听入口不发送新模型轮次或配置修改。</small></body></html>`;
}
module.exports = { CloudLiveMeter, renderCloudLiveHtml };
