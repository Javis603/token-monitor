'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Token Monitor's tokscale fork parsed Proma before upstream did. It read only
// `<home>/.proma/agent-sessions/*.jsonl` and keyed each journal as
// `<file stem>@<root namespace>`, the namespace being the first 6 bytes of
// sha256 over the normalized root path. Upstream reads the same journals but
// keys their usage by the records' own session ids, or by the native Pi session
// the index links them to, so a session archived under the fork id would replay
// beside the same usage reported under its upstream id.
const LEGACY_SESSION_ID = /^(.+)@([0-9a-f]{12})$/;
const INDEX_LIMIT_BYTES = 16 * 1024 * 1024;

// The agent-sessions roots a completed full scan has just read, keyed by the
// namespace the fork derived from each.
function legacyPromaRoots(homes, options = {}) {
  const pathApi = options.platform === 'win32' ? path.win32 : path.posix;
  return [...new Set(homes.filter(Boolean))].map((home) => {
    const root = pathApi.normalize(pathApi.join(home, '.proma', 'agent-sessions'));
    return { namespace: crypto.createHash('sha256').update(root).digest('hex').slice(0, 12), root };
  });
}

function parseLegacyPromaSessionId(sessionId) {
  const match = LEGACY_SESSION_ID.exec(String(sessionId || ''));
  return match ? { stem: match[1], namespace: match[2] } : null;
}

function text(value, field) {
  const raw = value?.[field];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed && !trimmed.includes('�') ? trimmed : null;
}

function counter(usage, key) {
  const value = usage[key];
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function linkedSdkSessionId(root, stem, readFileSync, lstatSync) {
  const indexPath = path.join(path.dirname(root), 'agent-sessions.json');
  try {
    const stat = lstatSync(indexPath);
    if (!stat.isFile() || stat.size > INDEX_LIMIT_BYTES) return null;
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const meta = (Array.isArray(index?.sessions) ? index.sessions : []).find((session) => session?.id === stem);
    return text(meta, 'sdkSessionId');
  } catch (_) {
    return null;
  }
}

// The session ids upstream can report this journal's usage under, following
// sessions/proma.rs: a Pi-format journal uses its header id; an SDK-shaped one
// uses each usage-bearing assistant record's session id, else the file stem,
// and the index may hand those records to a linked native session. Null when
// the journal is missing or unreadable, so its fork row stays the only record.
function promaJournalSessionIds(root, stem, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const lstatSync = deps.lstatSync || fs.lstatSync;
  let content;
  try {
    content = readFileSync(path.join(root, `${stem}.jsonl`), 'utf8');
  } catch (_) {
    return null;
  }
  const ids = new Set();
  let first = true;
  for (const line of content.split('\n')) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (first) {
      first = false;
      if (record?.type === 'session') {
        const id = text(record, 'id');
        if (id) ids.add(id);
        return ids;
      }
    }
    const usage = record?.type === 'assistant' ? record.message?.usage : null;
    if (!usage || typeof usage !== 'object' || text(record.message, 'model') === '<synthetic>') continue;
    const tokens = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
      .reduce((sum, key) => sum + counter(usage, key), 0);
    if (tokens > 0) ids.add(text(record, 'session_id') || text(record, 'sessionId') || stem);
  }
  if (ids.size > 0) {
    const linked = linkedSdkSessionId(root, stem, readFileSync, lstatSync);
    if (linked) ids.add(linked);
  }
  return ids;
}

module.exports = { legacyPromaRoots, parseLegacyPromaSessionId, promaJournalSessionIds };
