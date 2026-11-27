'use strict';
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function number(value) { return value === null || value === undefined ? '未知' : escapeHtml(value.toLocaleString('en-US')); }
function renderUsageHtml(snapshot, refreshSeconds = 0) {
  const r = snapshot.report;
  const refresh = Number.isInteger(refreshSeconds) && refreshSeconds >= 60 && refreshSeconds <= 86400
    ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : '';
  const rows = (r?.threads || []).map((t) => `<tr><td><code>${escapeHtml(t.threadId)}</code><small>父线程：${escapeHtml(t.parentThreadId || '未确定')}</small></td>
<td>${escapeHtml(t.execution)}<small>${escapeHtml(t.creationSource)}${t.bindingEvidence ? ' · 用户声明' : ''}</small></td>
<td>${number(t.usage?.tokens.totalTokens)}</td><td>${number(t.usage?.tokens.inputTokens)}</td><td>${number(t.usage?.tokens.cachedInputTokens)}</td>
<td>${number(t.usage?.tokens.outputTokens)}</td><td>${escapeHtml(t.status)}</td></tr>`).join('');
  const daily = (r?.account?.report?.dailyUsageBuckets || []).map((d) => `<tr><td>${escapeHtml(d.startDate)}</td><td>${number(d.tokens)}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">${refresh}
<title>Codex · 服务端用量</title><style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif}body{max-width:1280px;margin:40px auto;padding:0 24px;line-height:1.6}
h1{font-size:28px;line-height:1.2}h2{font-size:20px;margin-top:34px}small{display:block;opacity:.7}code{font-size:12px;overflow-wrap:anywhere}
section{padding:20px;border:1px solid #80808055;border-radius:12px;margin:18px 0}.big{font-size:32px;font-weight:650;margin:8px 0}
.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #80808044;vertical-align:top}
.alert{border-left:4px solid #c18420;padding:12px 18px;background:#c1842011}th{white-space:nowrap}.state{font-weight:650}
</style></head><body><small>TOKEN MONITOR · LIVE USAGE READER</small><h1>Codex 服务端用量</h1>
<p class="state">状态：${escapeHtml(snapshot.state)}${snapshot.state === 'stale' ? ' — 已断线，以下是上次成功数据，不是当前读数' : ''}${snapshot.state === 'stopped' ? ' — 采集进程已停止，以下为历史快照' : ''}${snapshot.state === 'unavailable' ? ' — 尚未取得数据，不代表零消耗' : ''}</p>
<small>最近尝试：${escapeHtml(snapshot.attemptedAt)} · 最近成功：${escapeHtml(snapshot.lastSuccessAt || '无')}</small>
${snapshot.errorCode ? `<p class="alert">${escapeHtml(snapshot.errorCode)}</p>` : ''}
<section><small>账户累计 · 服务报告值 · 不是云端专属总量</small><div class="big">${number(r?.account?.report?.summary?.lifetimeTokens)} Token</div><p>不与下方线程值或本地 Tokscale 总数相加。</p></section>
<h2>线程／子线程 · 估算值</h2><p class="alert">未验证父线程是否已包含子线程，故不显示任务加总。云端和 dot 的完整覆盖仍为未知。此页面不会把估算值写入实测账本。</p>
<p>已查询 ${number(r?.inventory?.selectedThreads)} 个线程，有数值 ${number(r?.inventory?.measuredThreads)} 个，缺失 ${number(r?.inventory?.unavailableThreads)} 个。目录状态：${escapeHtml(r?.inventory?.status || 'unavailable')}</p>
<div class="table"><table><thead><tr><th>线程关系</th><th>执行／创建来源</th><th>Total</th><th>Input</th><th>Cached input（包含于 Input）</th><th>Output</th><th>状态</th></tr></thead><tbody>${rows || '<tr><td colspan="7">尚无可展示的线程。提供真实线程 ID，或选择查询连接端目录。</td></tr>'}</tbody></table></div>
<h2>账户每日用量</h2><div class="table"><table><thead><tr><th>服务返回的日期</th><th>Token</th></tr></thead><tbody>${daily || '<tr><td colspan="2">每日明细不可用，不代表零。</td></tr>'}</tbody></table></div>
<h2>采集诊断</h2><p>${escapeHtml((r?.diagnostics || []).map((d) => `${d.scope || 'thread'}: ${d.code}`).join(' · ') || '无额外诊断')}</p>
<small>仅本机文件，无脚本、远程字体或网络请求。成功状态仅表示该快照当时采集成功，不证明进程现在仍在线；请核对最近成功时间。</small></body></html>`;
}
module.exports = { renderUsageHtml, escapeHtml };
