'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { claudeSessionRoots } = require('./providers/claude/paths');
const { codebuddyProjectsRoot } = require('./providers/codebuddy/paths');

// 5.5 moved the WorkBuddy home to ~/.workbuddy-ai and tokscale still scans
// both, so a session reported from either root resolves from either.
function workbuddyProjectsRoots(home) {
  return [path.join(home, '.workbuddy', 'projects'), path.join(home, '.workbuddy-ai', 'projects')];
}

function isSafeSessionId(sessionId) {
  const id = String(sessionId || '');
  if (!id || id === '.' || id === '..') return false;
  if (id.includes('\0')) return false;
  // A single path segment only — separators would let path.join walk out.
  if (/[\\/]/.test(id)) return false;
  return path.basename(id) === id;
}

function isPathInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function findSessionFiles(root, sessionIds) {
  const wanted = new Set();
  for (const sessionId of sessionIds) {
    if (!isSafeSessionId(sessionId)) continue;
    wanted.add(`${sessionId}.jsonl`);
  }
  const found = new Map();
  if (wanted.size === 0) return found;

  function walk(dir) {
    if (found.size >= wanted.size) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (found.size >= wanted.size) return;
      const nextPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath);
      } else if (entry.isFile() && wanted.has(entry.name)) {
        found.set(entry.name.slice(0, -'.jsonl'.length), nextPath);
      }
    }
  }

  walk(root);
  return found;
}

function codexHomeDir(home, options = {}) {
  const env = options.env || process.env;
  const configured = options.useEnvRoots !== false ? String(env.CODEX_HOME || '').trim() : '';
  return configured ? path.resolve(configured) : path.join(home, '.codex');
}

function codexSessionFile(home, sessionId, options = {}) {
  if (!isSafeSessionId(sessionId)) return '';
  const match = String(sessionId).match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) return '';
  const codexHome = options.codexHome || codexHomeDir(home, options);
  const sessionsRoot = path.join(codexHome, 'sessions');
  const filePath = path.join(sessionsRoot, match[1], match[2], match[3], `${sessionId}.jsonl`);
  if (!isPathInside(sessionsRoot, filePath)) return '';
  try { return fs.statSync(filePath).isFile() ? filePath : ''; } catch (_) { return ''; }
}

function resolveSessionFile(client, sessionId, home, options = {}) {
  const id = String(sessionId || '');
  if (!isSafeSessionId(id)) return '';
  if (client === 'claude') {
    const { projects, transcripts } = claudeSessionRoots({
      homeDir: home,
      env: options.env,
      useEnvRoots: options.useEnvRoots
    });
    const projectFile = findSessionFiles(projects, [id]).get(id);
    if (projectFile) return projectFile;
    return findSessionFiles(transcripts, [id]).get(id) || '';
  }
  if (client === 'codebuddy') {
    return findSessionFiles(codebuddyProjectsRoot({ homeDir: home }), [id]).get(id) || '';
  }
  if (client === 'workbuddy') {
    for (const root of workbuddyProjectsRoots(home)) {
      const found = findSessionFiles(root, [id]).get(id);
      if (found) return found;
    }
    return '';
  }
  if (client === 'codex') {
    const codexHome = options.codexHome || codexHomeDir(home, options);
    const direct = codexSessionFile(home, id, { codexHome });
    if (direct) return direct;
    return findSessionFiles(path.join(codexHome, 'sessions'), [id]).get(id) || '';
  }
  return '';
}

module.exports = { findSessionFiles, codexSessionFile, resolveSessionFile, isSafeSessionId };
