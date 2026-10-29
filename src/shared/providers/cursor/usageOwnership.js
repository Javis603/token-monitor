'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cursorCacheDir } = require('./usageEvents');
const { hashKey } = require('../../hashKey');

const owners = new Map();

function cacheOwner(file, stat) {
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (owners.get(file)?.signature === signature) return owners.get(file).owner;
  const fd = fs.openSync(file, 'r');
  let owner = null;
  try {
    const head = Buffer.alloc(Math.min(1024, stat.size));
    const tail = Buffer.alloc(Math.min(1024, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
    const prefix = head.toString('utf8');
    const suffix = tail.toString('utf8');
    if (prefix.startsWith('{"_owner":') || suffix.includes(',"zzTokscaleOwner":')) {
      const header = JSON.parse(prefix.match(/^\{"_owner":(\{[^}]*\})/)?.[1] || 'null');
      const footer = JSON.parse(suffix.match(/,"zzTokscaleOwner":(\{[^}]*\})\}\s*$/)?.[1] || 'null');
      const metadata = JSON.parse(prefix.match(/,"_tokscale":(\{[^}]*\})/)?.[1] || 'null');
      const id = metadata?.accountId;
      if (metadata?.version === 1 && /^user_[A-Za-z0-9_]+$/.test(id)
        && header?.version === 1 && footer?.version === 1 && header.generation
        && header.generation === footer.generation
        && header.ownerHash === crypto.createHash('sha256').update(id).digest('hex')) owner = id;
    } else {
      // Older owned caches need one full parse, cached by their file signature.
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value._owner && !value.zzTokscaleOwner && value._tokscale?.version === 1
        && /^user_[A-Za-z0-9_]+$/.test(value._tokscale.accountId)) owner = value._tokscale.accountId;
    }
  } finally { fs.closeSync(fd); }
  if (owners.size >= 256) owners.clear();
  owners.set(file, { signature, owner });
  return owner;
}

// Read producer ownership, never the current Limits selection. A logout keeps
// old usage readable, so credentials alone cannot describe a scanner snapshot.
function readCursorUsageOwnership(options = {}) {
  const dir = options.cacheDir || cursorCacheDir(options);
  const files = [];
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /^usage.*\.(json|csv)$/.test(entry.name)) files.push(file);
    }
  }
  try {
    visit(dir);
    if (!files.length) return null;
    const accountKeys = new Set();
    let observedAt = 0;
    const signatures = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) return null;
      const stat = fs.statSync(file);
      const owner = cacheOwner(file, stat);
      if (!owner) return null;
      const key = hashKey('cursor', owner);
      accountKeys.add(key);
      observedAt = Math.max(observedAt, stat.mtimeMs);
      signatures.push(`${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
    }
    const keys = [...accountKeys].sort();
    const accountKey = keys.length === 1 ? keys[0] : hashKey('cursor-usage-accounts', ...keys);
    return { accountKey, observedAt: new Date(observedAt).toISOString(), signature: signatures.join('\n') };
  } catch (_) {
    return null;
  }
}

module.exports = { readCursorUsageOwnership };
