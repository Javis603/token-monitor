'use strict';

/**
 * Local, on-demand session detail for DeepSeek Harness (`dsh`) logs.
 *
 * The durable log is the source of truth; prompts and per-step usage are read
 * only when the user opens a session in the widget and are never uploaded.
 * Chunk text, tool arguments and tool results stay untouched: a prompt preview
 * comes from `user/message` text blocks, and a turn's token split comes from the
 * same `assistant/message` usage record the collector already reads.
 */

const fs = require('node:fs');
const os = require('node:os');
const { makeTokens, groupEvents, filterExchangesByPeriod, distributeCost } = require('./sessionDetail');
const {
  decodeSessionText,
  dshSessionFiles,
  resolveDshSessionsRoot
} = require('./dshUsage');

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
    let buffer;
    try {
      buffer = fs.readFileSync(filePath);
      const { text } = decodeSessionText(filePath, buffer);
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
  const cacheRead = numberValue(usage?.cacheReadTokens);
  const cacheWrite = numberValue(usage?.cacheWriteTokens);
  const input = numberValue(usage?.inputTokens);
  const output = numberValue(usage?.outputTokens);
  return makeTokens({ input, output, cacheRead, cacheWrite, reasoning: numberValue(usage?.reasoningTokens) });
}

function parseDshDetailEvents(text) {
  const events = [];
  let header = null;
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
      if (record?.type === 'session') header = record;
      continue;
    }
    if (record?.type === 'user/message') {
      const content = record.data?.content;
      const promptText = textFromContent(content);
      if (promptText) events.push({ kind: 'prompt', timestamp: new Date(numberValue(record.time)).toISOString(), text: promptText });
    } else if (record?.type === 'assistant/message') {
      const usage = record.data?.usage;
      if (!usage) continue;
      const tokens = usageTokens(usage);
      if (tokens.total === 0) continue;
      const tools = Array.isArray(record.data?.content)
        ? record.data.content.filter((block) => block && block.type === 'tool-call' && typeof block.name === 'string').map((block) => block.name)
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
    homeDir: home || os.homedir(),
    env: env || process.env,
    platform: platform || process.platform,
    cwdDir: cwdDir || process.cwd(),
    ...(sessionsRoot ? { sessionsRoot } : {})
  };
  const filePath = findDshSessionFile(sessionId, options);
  if (!filePath) {
    return { found: false, client: 'dsh', sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
  }
  let events;
  try {
    const buffer = fs.readFileSync(filePath);
    const { text } = decodeSessionText(filePath, buffer);
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
