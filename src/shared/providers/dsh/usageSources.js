'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readDshTranscriptRecords } = require('./transcriptReader');
const { parseDshDetailRecords } = require('./sessionDetail');
const { dshSessionFiles, resolveDshSessionsRoot } = require('./sessionFiles');
const { normalizeModelNameForClient } = require('../../usage');
const { readMagpieUsageLedger } = require('../magpie/usageLedger');

const eventCache = new Map();
const indexCache = new Map();
function directoryFingerprint(directory) {
  try {
    const stat = fs.statSync(directory, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (_) { return ''; }
}
async function sourceIndex(root, sessionIds, signal) {
  const cached = indexCache.get(root);
  if (cached && sessionIds.every(id => cached.index.has(id))
    && [...cached.directories].every(([directory, fingerprint]) => directoryFingerprint(directory) === fingerprint)) {
    return cached.index;
  }
  const index = new Map();
  const directories = new Map();
  // Capture every directory before enumerating it, including empty projects.
  // A generation arriving during discovery invalidates this index next time.
  const files = dshSessionFiles(root, { onDirectory: directory => {
    signal?.throwIfAborted();
    directories.set(directory, directoryFingerprint(directory));
  } });
  for (const filePath of files) {
    signal?.throwIfAborted();
    const directory = path.dirname(filePath);
    let id = path.basename(directory);
    try {
      for await (const header of readDshTranscriptRecords(filePath, {
        headerOnly: true, signal, maxDecodedBytes: MAX_HEADER_BYTES, maxRecords: 1
      })) {
        if (header?.type === 'session' && typeof header.id === 'string') id = header.id;
        break;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === 'AbortError') throw error;
    }
    if (id && !index.has(id)) index.set(id, { filePath });
  }
  // A stable native directory index is shared by every period and later ticks.
  // Content appends use readEvents' file signature; discovery reruns only when
  // a directory changes (including a new transcript generation).
  if (indexCache.size >= 16) indexCache.delete(indexCache.keys().next().value);
  indexCache.set(root, { index, directories });
  return index;
}
const MAX_EVENTS = 50000;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const clean = value => typeof value === 'string' ? value.trim() : '';
function scanWindow(flags = [], now = new Date()) {
  let start = 0;
  if (flags.includes('--today')) start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  else if (flags.includes('--month')) start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  else if (flags.includes('--since')) {
    const value = flags[flags.indexOf('--since') + 1];
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (match) start = new Date(+match[1], +match[2] - 1, +match[3]).getTime();
  }
  // Native period scans use complete calendar dates, including an append that
  // happened while the scan ran. The snapshot's captured date owns the window.
  return { start, end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() };
}
async function readEvents(file, signal) {
  signal?.throwIfAborted();
  const stat = fs.statSync(file);
  if (stat.size > MAX_DECODED_BYTES) return [];
  const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  const cached = eventCache.get(file);
  if (cached?.signature === signature) return cached.events;
  const records = [];
  for await (const record of readDshTranscriptRecords(file, {
    includeUsageSource: true, signal, maxDecodedBytes: MAX_DECODED_BYTES, maxRecords: MAX_EVENTS
  })) records.push(record);
  signal?.throwIfAborted();
  const events = parseDshDetailRecords(records, { includeUsageSource: true, sessionId: path.basename(path.dirname(file)) }).filter(row => row.kind === 'turn')
    .map(row => ({ at: Date.parse(row.timestamp), input: row.tokens.input, output: row.tokens.output, source: row.usageSource }));
  const after = fs.statSync(file);
  if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') !== signature) return [];
  if (eventCache.size >= 256) eventCache.delete(eventCache.keys().next().value);
  eventCache.set(file, { signature, events });
  return events;
}

// Attach identity references only. tokscale remains the sole token/duration
// authority; Magpie's request ms must never become a native speed sample.
async function applyDshUsageSources(json, options = {}) {
  const rows = (Array.isArray(json?.entries) ? json.entries : []).filter(row => clean(row?.client).toLowerCase() === 'dsh');
  if (!rows.length) return;
  options.signal?.throwIfAborted();
  const env = options.homeDir ? {} : options.env || process.env;
  const roots = [options.sessionsRoot || resolveDshSessionsRoot({ ...options, env }), ...(options.customScanPaths?.dsh || [])];
  const index = new Map();
  const sessionIds = [...new Set(rows.map(row => clean(row.sessionId ?? row.session_id)))];
  for (const root of new Set(roots.map(value => path.resolve(value)))) {
    for (const [id, entry] of await sourceIndex(root, sessionIds, options.signal)) {
      if (!index.has(id)) index.set(id, entry);
    }
  }
  const ledger = await readMagpieUsageLedger(options);
  const window = scanWindow(options.flags, options.now);
  const sessions = new Map();
  for (const row of rows) {
    if (options.signal?.aborted) throw options.signal.reason || new Error('Aborted');
    const id = clean(row.sessionId ?? row.session_id), file = index.get(id)?.filePath;
    if (!file) continue;
    let events = sessions.get(id);
    if (!events) {
      try { events = await readEvents(file, options.signal); } catch (error) {
        options.signal?.throwIfAborted();
        if (error.name === 'AbortError') throw error;
        events = [];
      }
      sessions.set(id, events);
    }
    const model = normalizeModelNameForClient(row.model, 'dsh');
    const references = new Map();
    for (const event of events) {
      if (!Number.isFinite(event.at) || event.at < window.start || event.at >= window.end || event.output <= 0
        || normalizeModelNameForClient(event.source?.model, 'dsh') !== model) continue;
      const proof = ledger.get(event.source?.responseId);
      const platform = clean(event.source?.provider).toLowerCase();
      // ID, provider and exact inclusive output must agree. Input may include
      // cache in different schemas, so it is deliberately not used as a key.
      const usageSource = proof && proof.output === event.output && proof.source.platform === platform
        ? proof.source : { platform, accountId: '', accountLabel: '', accessType: 'unknown' };
      const key = JSON.stringify(usageSource), previous = references.get(key);
      references.set(key, { usageSource, outputTokens: (previous?.outputTokens || 0) + event.output,
        lastUsedAt: new Date(Math.max(event.at, Date.parse(previous?.lastUsedAt) || 0)).toISOString() });
    }
    if (references.size) row.usageSourceReferences = [...references.values()];
  }
}

module.exports = { applyDshUsageSources, scanWindow };
