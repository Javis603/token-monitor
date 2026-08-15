'use strict';

/**
 * Local, on-demand session detail for DeepSeek Harness (`dsh`) logs.
 *
 * The durable log is the source of truth; prompts and per-step usage are read
 * only when the user opens a session in the widget and are never uploaded.
 *
 * Two things a naive per-line parse gets wrong on real dsh transcripts:
 *
 * - `user/message` events are not all user-typed prompts. `data.source.kind`
 *   is `user` for what the person actually typed, but also `agent-instructions`
 *   (a full AGENTS.md dump), `plugin` (runtime-context snapshots) and
 *   `skill-catalog` (the available-skills list) for harness-injected context.
 *   Only `kind === 'user'` may become a prompt bubble.
 * - A forked session's log is seeded with a byte-for-byte copy of its parent's
 *   events up to `session.seedLength` (the `seq` of the `session/end-seed`
 *   marker). Tokscale's own aggregate leaves that seeded prefix on the parent
 *   and counts only the fork's own new events; Session Detail must match, or
 *   opening a forked session shows more tokens than tokscale's own count for
 *   it (measured up to +52.7% total across a small real sample dominated by
 *   one heavily-forked session).
 */

const fs = require('node:fs');
const { makeTokens, groupEvents, filterExchangesByPeriod, distributeCost } = require('./sessionDetail');
const { decodeSessionText, dshSessionFiles, resolveDshSessionsRoot } = require('./dshSessionFiles');

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textFromContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findDshSessionFile(sessionId, options = {}) {
  const root = options.sessionsRoot || resolveDshSessionsRoot(options);
  for (const filePath of dshSessionFiles(root)) {
    try {
      const buffer = fs.readFileSync(filePath);
      const text = decodeSessionText(filePath, buffer);
      const firstLine = text.split(/\r?\n/).find((line) => line.trim());
      if (!firstLine) continue;
      const header = JSON.parse(firstLine.trim());
      if (header?.type === 'session' && header.id === sessionId) return filePath;
    } catch (_) {
      // unreadable, corrupt, or a torn first frame — try the next candidate
    }
  }
  return null;
}

function usageTokens(usage) {
  return makeTokens({
    input: numberValue(usage?.inputTokens),
    output: numberValue(usage?.outputTokens),
    cacheRead: numberValue(usage?.cacheReadTokens),
    cacheWrite: numberValue(usage?.cacheWriteTokens),
    reasoning: numberValue(usage?.reasoningTokens)
  });
}

function parseDshDetailEvents(text) {
  const events = [];
  let header = null;
  let seedLength = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    if (!header) {
      if (record?.type !== 'session') continue;
      header = record;
      seedLength = Number.isFinite(Number(record.seedLength)) ? Number(record.seedLength) : null;
      continue;
    }
    // A forked session's log is seeded with its parent's events verbatim.
    // Tokscale credits that shared prefix to the parent only, so Session
    // Detail must skip it too, or a fork's total exceeds its own card.
    if (seedLength !== null && numberValue(record?.seq) <= seedLength) continue;
    if (record?.type === 'user/message') {
      if (record.data?.source?.kind !== 'user') continue;
      const promptText = textFromContent(record.data?.content);
      if (promptText) events.push({ kind: 'prompt', timestamp: new Date(numberValue(record.time)).toISOString(), text: promptText });
    } else if (record?.type === 'assistant/message') {
      const usage = record.data?.usage;
      if (!usage) continue;
      const tokens = usageTokens(usage);
      if (tokens.total === 0) continue;
      const tools = Array.isArray(record.data?.message?.content)
        ? record.data.message.content.filter((block) => block && block.type === 'tool-call' && typeof block.name === 'string').map((block) => block.name)
        : [];
      events.push({ kind: 'turn', timestamp: new Date(numberValue(record.time)).toISOString(), tokens, tools });
    }
  }
  return events;
}

function totalsOf(exchanges, sessionCost) {
  const totalTokens = exchanges.reduce((acc, ex) => acc + ex.tokens.total, 0);
  const turnCount = exchanges.reduce((acc, ex) => acc + ex.turnCount, 0);
  return { totalTokens, costUsd: numberValue(sessionCost), exchangeCount: exchanges.length, turnCount };
}

function readDshSessionDetail({ sessionId, period = 'total', sessionCost = 0, home, env, platform, cwdDir, sessionsRoot, deps = {} }) {
  const options = {
    homeDir: home,
    env: env || deps.env || process.env,
    platform: platform || deps.platform || process.platform,
    cwdDir: cwdDir || deps.cwdDir || process.cwd(),
    ...(sessionsRoot ? { sessionsRoot } : {})
  };
  const findFile = deps.findDshSessionFile || findDshSessionFile;
  const filePath = findFile(sessionId, options);
  if (!filePath) {
    return { found: false, client: 'dsh', sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
  }
  let events;
  try {
    const buffer = fs.readFileSync(filePath);
    const text = decodeSessionText(filePath, buffer);
    events = parseDshDetailEvents(text);
  } catch (_) {
    return { found: false, client: 'dsh', sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
  }
  const now = new Date((deps.now || Date.now)());
  const grouped = filterExchangesByPeriod(groupEvents(events), period, now);
  const distributed = distributeCost(grouped, sessionCost);
  return { found: true, client: 'dsh', sessionId, period, exchanges: distributed, totals: totalsOf(distributed, sessionCost) };
}

module.exports = {
  findDshSessionFile,
  parseDshDetailEvents,
  readDshSessionDetail
};
