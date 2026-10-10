'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexSessionFile, findSessionFiles } = require('./sessionFiles');
const { codexResponseItemPrompt } = require('./sessionDetail');
const { protobufFields, readGenerations } = require('./providers/antigravity/throughput');
const { DatabaseSync } = require('node:sqlite');
const cache = new Map();
let timingCache = { key: null, map: new Map() };
const short = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
const ms = (value) => typeof value === 'number' ? value * 1000 : Date.parse(value || '') || 0;

function parseCodexTasks(text) {
  const tasks = [];
  let task = null;
  let output = 0;
  let lastUsage = '';
  let threadId = '';
  function start(id, timestamp, explicit) {
    if (task?.status === 'running') {
      task.status = 'interrupted';
      task.durationMs = Math.max(0, task.lastAt - task.startedAt);
    }
    task = { id, threadId, title: '', startedAt: ms(timestamp), lastAt: ms(timestamp),
      durationMs: null, outputTokens: 0, tokensAvailable: false, status: 'running', explicit };
    tasks.push(task);
  }
  for (const line of String(text).split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    const p = record.payload || {};
    const event = record.type === 'event_msg';
    if (record.type === 'session_meta' && p.id) threadId = p.id;
    if (event && p.type === 'task_started') {
      start(p.turn_id || `task-${tasks.length}`, p.started_at || record.timestamp, true);
      continue;
    }
    const prompt = record.type === 'response_item' ? codexResponseItemPrompt(p)
      : event && p.type === 'user_message' ? p.message || p.text : '';
    if (prompt) {
      if (!task || task.status !== 'running') start(`task-${tasks.length}`, record.timestamp, false);
      if (!task.title) task.title = short(String(prompt).split(/## My request(?: for Codex)?:/).at(-1));
    }
    if (event && p.type === 'token_count') {
      const total = p.info?.total_token_usage?.output_tokens;
      const last = p.info?.last_token_usage;
      let delta = 0;
      if (Number.isFinite(total)) {
        delta = total >= output ? total - output : Number(last?.output_tokens) || 0;
        output = total;
      } else if (last) {
        const signature = JSON.stringify([task?.id, last]);
        if (signature !== lastUsage) delta = Number(last.output_tokens) || 0;
        lastUsage = signature;
      }
      if (task?.status === 'running') {
        task.outputTokens += Math.max(0, delta);
        task.tokensAvailable ||= Number.isFinite(total) || Boolean(last);
        if (delta > 0) task.lastAt = ms(record.timestamp);
      }
    }
    if (event && ['task_complete', 'turn_aborted'].includes(p.type) && task
      && (!p.turn_id || p.turn_id === task.id)) {
      task.lastAt = ms(p.completed_at || record.timestamp);
      task.durationMs = Number.isFinite(p.duration_ms) ? p.duration_ms
        : Math.max(0, task.lastAt - task.startedAt);
      task.status = p.type === 'turn_aborted' ? 'interrupted' : p.error ? 'failed' : 'completed';
    }
  }
  return tasks.filter(task => task.title || task.tokensAvailable);
}

function stamp(file) {
  try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch (_) { return ''; }
}

function readHistoryTasks(id, root) {
  const file = path.join(root, 'thread_history_1.sqlite');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare(`SELECT t.turn_id,t.started_at,t.duration_ms,t.status,i.item_json
      FROM thread_turns t LEFT JOIN thread_items i ON i.thread_id=t.thread_id AND i.item_id=t.first_user_item_id
      WHERE t.thread_id=? ORDER BY t.rollout_ordinal`).all(id).map(row => {
      let item = {};
      try { item = JSON.parse(row.item_json || '{}'); } catch (_) {}
      const title = (item.content || []).filter(p => p.type === 'text').map(p => p.text || '').join(' ');
      return { id: row.turn_id, title: short(title), startedAt: ms(row.started_at),
        durationMs: row.duration_ms, status: row.status === 'inProgress' ? 'running' : row.status,
        outputTokens: 0, tokensAvailable: false };
    });
  } catch (_) { return []; }
  finally { try { db?.close(); } catch (_) {} }
}

function protoTime(fields, number) {
  const value = fields.get(number);
  if (!Buffer.isBuffer(value)) return 0;
  const time = protobufFields(value);
  return Number(time.get(1) || 0n) * 1000 + Number(time.get(2) || 0n) / 1e6;
}

function readAntigravityTasks(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tasks = [];
    let current = null;
    for (const step of db.prepare('SELECT idx,step_type,status,metadata,step_payload FROM steps ORDER BY idx').iterate()) {
      const metadata = step.metadata ? protobufFields(step.metadata) : new Map();
      if (step.step_type === 14) {
        let input = step.step_payload ? protobufFields(step.step_payload) : new Map();
        if (Buffer.isBuffer(input.get(19))) input = protobufFields(input.get(19));
        let title = input.get(1) || input.get(2);
        if (!Buffer.isBuffer(title) && Buffer.isBuffer(input.get(3))) title = protobufFields(input.get(3)).get(1);
        current = { id: String(step.idx), startStepIndex: step.idx,
          title: short(Buffer.isBuffer(title) ? title.toString('utf8') : ''),
          startedAt: protoTime(metadata, 32) || protoTime(metadata, 1), lastAt: 0,
          outputTokens: 0, tokensAvailable: false, status: 'recorded', durationMs: null };
        tasks.push(current);
      }
      if (!current) continue;
      current.lastAt = Math.max(current.lastAt, protoTime(metadata, 8) || protoTime(metadata, 7));
      if ([1, 2, 8, 9, 11].includes(step.status)) current.status = 'running';
    }
    for (const generation of readGenerations(file)) {
      const target = generation.startStepIndex !== null
        ? tasks.findLast(task => task.startStepIndex <= generation.startStepIndex)
        : tasks.findLast(task => task.startedAt <= generation.startedAt);
      if (!target) continue;
      target.outputTokens += generation.output;
      target.tokensAvailable = true;
      target.lastAt = Math.max(target.lastAt, generation.startedAt + generation.durationMs);
    }
    for (const task of tasks) {
      if (task.status !== 'running' && task.lastAt > task.startedAt) task.durationMs = task.lastAt - task.startedAt;
    }
    return tasks;
  } catch (_) { return []; }
  finally { try { db?.close(); } catch (_) {} }
}

function summarize(tasks, now = Date.now()) {
  let outputTokens = 0;
  let durationMs = 0;
  let measuredCount = 0;
  const rows = tasks.map(task => {
    const elapsed = task.status === 'running' ? Math.max(0, now - task.startedAt) : task.durationMs;
    const available = task.tokensAvailable && elapsed > 0;
    if (available && task.status !== 'running' && task.status !== 'unknown') { outputTokens += task.outputTokens; durationMs += elapsed; measuredCount += 1; }
    return { ...task, durationMs: elapsed, speed: available ? task.outputTokens * 1000 / elapsed : null };
  });
  return { tasks: rows, outputTokens, durationMs, measuredCount,
    taskCount: tasks.length, speed: durationMs > 0 ? outputTokens * 1000 / durationMs : null };
}

function historyTimingMap(root) {
  const file = path.join(root, 'thread_history_1.sqlite');
  const key = JSON.stringify([file, stamp(file), stamp(`${file}-wal`)]);
  if (timingCache.key === key) return timingCache.map;
  let db;
  const result = new Map();
  try {
    db = new DatabaseSync(file, { readOnly: true });
    for (const row of db.prepare('SELECT thread_id,turn_id,status,duration_ms FROM thread_turns').iterate()) {
      result.set(`${row.thread_id}:${row.turn_id}`, row);
    }
  } catch (_) {}
  finally { try { db?.close(); } catch (_) {} }
  timingCache = { key, map: result };
  return result;
}

function readTaskSpeedStats({ sessions = [], home = os.homedir(), codexRoot = process.env.CODEX_HOME || path.join(home, '.codex') } = {}) {
  const results = [];
  const timings = historyTimingMap(codexRoot);
  const selected = sessions.slice(0, 2000);
  const directFiles = new Map();
  const fallbackIds = [];
  for (const session of selected) {
    if (session?.client !== 'codex') continue;
    const id = String(session.sessionId || '');
    if (!/^[\w-]+$/.test(id)) continue;
    const direct = codexSessionFile(home, id, { codexHome: codexRoot });
    if (direct) directFiles.set(id, direct);
    else fallbackIds.push(id);
  }
  const liveFiles = findSessionFiles(path.join(codexRoot, 'sessions'), fallbackIds);
  const archivedFiles = findSessionFiles(path.join(codexRoot, 'archived_sessions'), fallbackIds.filter(id => !liveFiles.has(id)));
  for (const session of selected) {
    if (!['codex', 'antigravity'].includes(session.client)) continue;
    const id = String(session.sessionId || '');
    if (!/^[\w-]+$/.test(id)) continue;
    let file = '';
    if (session.client === 'codex') {
      file = directFiles.get(id) || liveFiles.get(id) || archivedFiles.get(id) || '';
    }
    else {
      for (const root of ['antigravity-ide', 'antigravity', 'antigravity-backup']) {
        const candidate = path.join(home, '.gemini', root, 'conversations', `${id}.db`);
        if (stamp(candidate)) { file = candidate; break; }
      }
    }
    const key = `${session.client}:${id}`;
    const fingerprint = file ? `${stamp(file)}|${stamp(`${file}-wal`)}`
      : `${stamp(path.join(codexRoot, 'thread_history_1.sqlite'))}|${stamp(path.join(codexRoot, 'thread_history_1.sqlite-wal'))}`;
    let cached = cache.get(key);
    if (!cached || cached.fingerprint !== fingerprint) {
      let tasks = [];
      try { tasks = session.client === 'codex'
        ? file ? parseCodexTasks(fs.readFileSync(file, 'utf8'))
          : readHistoryTasks(id.match(/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/i)?.[0] || id, codexRoot)
        : file ? readAntigravityTasks(file) : [];
      } catch (_) {}
      cached = { fingerprint, tasks };
      cache.set(key, cached);
    }
    const tasks = cached.tasks.map(task => {
      const timing = timings.get(`${task.threadId}:${task.id}`);
      if (timing?.duration_ms !== null && timing?.duration_ms !== undefined && timing.status !== 'inProgress') {
        return { ...task, status: timing.status, durationMs: timing.duration_ms };
      }
      if (task.status === 'running' && Date.now() - (task.lastAt || task.startedAt) > 5 * 60000) {
        return { ...task, status: 'unknown', durationMs: null };
      }
      return task;
    });
    results.push({ ...session, key, ...summarize(tasks) });
  }
  const seen = new Set();
  const allTasks = results.flatMap(session => session.tasks.filter(task => {
    const key = session.client === 'codex' && /^[a-f\d-]{36}$/i.test(task.id) ? `codex:${task.id}` : `${session.key}:${task.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
  const overall = summarize(allTasks);
  return { sessions: results, overall };
}

module.exports = { parseCodexTasks, summarize, readTaskSpeedStats };
