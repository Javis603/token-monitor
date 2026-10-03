'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { codebuddyExtensionDataRoots } = require('./paths');

// The VS Code extension's conversation store. One tree per install and per
// editor, and inside it one directory per workspace with two levels of index:
//
//   <history>/<workspace>/index.json            conversations[]: id, name, timestamps
//   <history>/<workspace>/<conversation>/index.json
//        messages[]: {id, role, isComplete}     the reply order
//        requests[]: {id, messages, state, startedAt, usage}   one model call each
//   <history>/<workspace>/<conversation>/messages/<message-id>.json
//        {role, message: "<json>", extra: "<json>", createdAt}
//
// Two things about this store shape the reader. Usage is per request, and the
// client reports a request's `extra.traceId` — not the conversation id — as
// the session id tokscale keys on, so one conversation with three requests is
// three reported sessions, and Session Detail for a traceId is that one
// request's exchange. And both the message payload and its metadata arrive as
// JSON strings inside the JSON file, so they are parsed twice.

const conversationCache = new Map();
const workspaceCache = new Map();

function nonBlank(value) {
  return String(value ?? '').trim();
}

function parseJsonObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function listDirectories(dir, fsApi) {
  try {
    return fsApi.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch (_) {
    return [];
  }
}

// The history root sits a fixed depth under the Data dir in the observed
// layout (`Data/<install>/VSCode/<uuid>/history` — four levels), but the two
// intermediate levels are ids whose names are not a contract, so the walk
// matches on the directory name and a bounded depth rather than on their
// shape.
function collectHistoryDirs(dataRoots, fsApi) {
  const found = [];
  for (const base of dataRoots) {
    let level = [base];
    for (let depth = 0; depth < 4 && level.length > 0; depth += 1) {
      const next = [];
      for (const dir of level) {
        for (const child of listDirectories(dir, fsApi)) {
          if (path.basename(child) === 'history') found.push(child);
          else next.push(child);
        }
      }
      level = next;
    }
  }
  return found;
}

function statKey(file, fsApi) {
  try {
    const stat = fsApi.statSync(file);
    return `${stat.dev ?? ''}:${stat.ino ?? ''}:${stat.mtimeMs}:${stat.ctimeMs ?? ''}:${stat.size ?? 0}`;
  } catch (_) {
    return '';
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' ? nonBlank(block.text) : nonBlank(block)))
    .filter(Boolean)
    .join(' ');
}

function cleanTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= 96
    ? text
    : `${chars.slice(0, 95).join('')}…`;
}

// Titles live one level up, in the workspace index's `conversations[]`, not in
// the conversation the trace id points at.
function conversationTitle(workspaceDir, conversationId, fsApi) {
  const key = statKey(path.join(workspaceDir, 'index.json'), fsApi);
  const cached = workspaceCache.get(workspaceDir);
  let titles;
  if (cached && cached.key === key) {
    titles = cached.titles;
  } else {
    if (!key) return '';
    try {
      const index = JSON.parse(fsApi.readFileSync(path.join(workspaceDir, 'index.json'), 'utf8'));
      const conversations = Array.isArray(index?.conversations) ? index.conversations : [];
      titles = new Map();
      for (const entry of conversations) {
        if (entry?.id && !titles.has(entry.id)) titles.set(entry.id, cleanTitle(entry.name));
      }
    } catch (_) {
      titles = new Map();
    }
    workspaceCache.set(workspaceDir, { key, titles });
  }
  return titles.get(conversationId) || '';
}

// Index rewrites and message additions/rewrites do not change the parent
// conversation directory's mtime. Check the files themselves, keeping parsed
// state cached while unchanged. Titles have their own workspace-index cache.
function readConversation(dir, fsApi) {
  const indexPath = path.join(dir, 'index.json');
  const indexKey = statKey(indexPath, fsApi);
  if (!indexKey) return null;
  const files = readdirFiles(messagesDir(dir), fsApi).sort();
  const key = JSON.stringify([
    indexKey,
    statKey(messagesDir(dir), fsApi),
    files.map((file) => [file, statKey(path.join(messagesDir(dir), file), fsApi)])
  ]);
  const cached = conversationCache.get(dir);
  if (cached && cached.key === key) return cached.data;

  let index;
  try {
    index = JSON.parse(fsApi.readFileSync(indexPath, 'utf8'));
  } catch (_) {
    return null;
  }
  const requests = Array.isArray(index?.requests) ? index.requests : [];

  const byMessageId = new Map();
  let workspaceFolder = '';
  for (const file of files) {
    let record;
    try {
      record = JSON.parse(fsApi.readFileSync(path.join(messagesDir(dir), file), 'utf8'));
    } catch (_) {
      continue;
    }
    const id = nonBlank(record?.id) || file.slice(0, -'.json'.length);
    const extra = parseJsonObject(record?.extra);
    const message = parseJsonObject(record?.message);
    const text = contentText(message.content);
    if (!workspaceFolder) {
      const matched = /Workspace Folder: (.+)/.exec(text);
      if (matched) workspaceFolder = matched[1].trim();
    }
    byMessageId.set(id, {
      role: record?.role,
      traceId: nonBlank(extra.traceId),
      // The displayed prompt the client keeps beside the context-wrapped
      // payload; falls back to the payload text when it is absent.
      displayText: (Array.isArray(extra.sourceContentBlocks) ? extra.sourceContentBlocks : [])
        .map((block) => nonBlank(block?.text))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      text: text.replace(/\s+/g, ' ').trim(),
      createdAt: record?.createdAt
    });
  }

  const byTrace = new Map();
  requests.forEach((request, requestIndex) => {
    for (const messageId of Array.isArray(request?.messages) ? request.messages : []) {
      const entry = byMessageId.get(messageId);
      const traceId = entry?.traceId || nonBlank(messageId);
      // One trace id answers to the first request carrying it; a conversation
      // replays an earlier trace only if the client itself does.
      if (entry && traceId && !byTrace.has(traceId)) {
        byTrace.set(traceId, { requestIndex, request, messages: request.messages });
      }
    }
  });

  const data = {
    dir,
    requests,
    byTrace,
    byMessageId,
    workspaceFolder
  };
  conversationCache.set(dir, { key, data });
  return data;
}

function messagesDir(dir) {
  return path.join(dir, 'messages');
}

function readdirFiles(dir, fsApi) {
  try {
    return fsApi.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (_) {
    return [];
  }
}

// The trace id a reported session carries. Nothing about a conversation the
// store has no requests for can be answered — an empty directory resolves to
// no conversation rather than to an empty one.
function findExtensionSessions(sessionIds, options = {}) {
  const wanted = new Set(Array.from(sessionIds || [], nonBlank).filter(Boolean));
  const result = new Map();
  if (wanted.size === 0) return result;
  const fsApi = options.fs || fs;
  const homeDir = nonBlank(options.homeDir)
    || nonBlank(options.env?.USERPROFILE)
    || nonBlank(options.env?.HOME)
    || nonBlank(process.env.USERPROFILE)
    || nonBlank(process.env.HOME);
  const dataRoots = options.dataRoots
    || codebuddyExtensionDataRoots({ homeDir, env: options.env, platform: options.platform });

  for (const historyDir of collectHistoryDirs(dataRoots, fsApi)) {
    for (const workspaceDir of listDirectories(historyDir, fsApi)) {
      for (const conversationDir of listDirectories(workspaceDir, fsApi)) {
        const conversation = readConversation(conversationDir, fsApi);
        if (!conversation) continue;
        let title;
        for (const [id, match] of conversation.byTrace) {
          if (!wanted.has(id) || result.has(id)) continue;
          title ??= conversationTitle(workspaceDir, path.basename(conversationDir), fsApi);
          const entries = (match.messages || [])
            .map((messageId) => conversation.byMessageId.get(messageId))
            .filter(Boolean);
          result.set(id, {
            title,
            workspaceFolder: conversation.workspaceFolder,
            state: nonBlank(match.request?.state),
            startedAt: match.request?.startedAt,
            usage: match.request?.usage && typeof match.request.usage === 'object' ? match.request.usage : {},
            entries
          });
          if (result.size === wanted.size) return result;
        }
      }
    }
  }
  return result;
}

function findExtensionSession(sessionId, options = {}) {
  const id = nonBlank(sessionId);
  return findExtensionSessions([id], options).get(id) || null;
}

function clearExtensionCaches() {
  conversationCache.clear();
  workspaceCache.clear();
}

module.exports = {
  clearExtensionCaches,
  collectHistoryDirs,
  findExtensionSession,
  findExtensionSessions
};
