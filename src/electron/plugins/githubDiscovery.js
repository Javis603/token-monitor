'use strict';
// GitHub topics identify author-submitted projects, never trusted packages.
const fs = require('node:fs');
const path = require('node:path');
const { download } = require('./catalogSources');
const { atomicJson } = require('./managed');
const { readBounded } = require('./package');
const { cleanText } = require('../../shared/plugins/localized');
const TOPIC = 'token-monitor-plugin';
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_BYTES = 1024 * 1024;
const REFRESH_MS = 6 * 60 * 60 * 1000;
function normalizeRepositories(raw) {
  if (!Array.isArray(raw?.items)) throw new Error('Invalid GitHub search response');
  const seen = new Set();
  return raw.items.slice(0, 100).flatMap(repo => {
    const name = repo?.full_name;
    if (typeof name !== 'string' || name.length > 200 || !REPO_RE.test(name) || ['.', '..'].includes(name.split('/')[1]) || seen.has(name.toLowerCase()) || repo.private === true) return [];
    seen.add(name.toLowerCase());
    return [{ id: name, name: cleanText(repo.name, 100) || name, author: name.split('/')[0],
      description: cleanText(repo.description, 500), repository: `https://github.com/${name}`,
      stars: Number.isSafeInteger(repo.stargazers_count) && repo.stargazers_count >= 0 ? repo.stargazers_count : null,
      types: [], origin: { id: 'github-discovery', kind: 'community', label: 'GitHub' }, status: 'repository' }];
  });
}
function createGitHubDiscovery({ root, fetchImpl, now = Date.now, enabled = false }) {
  const file = path.join(root, 'github-discovery.json');
  let entries = [], lastFetched = null, error = '', limited = false, pending = null, attempted = null, disposed = false;
  const controllers = new Set();
  try {
    if (enabled && fs.existsSync(file)) {
      const saved = JSON.parse(readBounded(file, MAX_BYTES));
      entries = normalizeRepositories(saved.raw); limited = Boolean(saved.raw.incomplete_results || saved.raw.total_count > entries.length);
      lastFetched = Number.isFinite(saved.at) ? saved.at : null;
    }
  } catch { error = 'GitHub discovery cache is unavailable'; }
  const list = () => ({ enabled, entries, lastFetched, error, limited, topic: TOPIC });
  async function request(url, limit = MAX_BYTES, signal) {
    if (disposed || signal?.aborted) throw new Error('GitHub discovery is closed');
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000); timer.unref?.();
    try { return await download(fetchImpl, url, limit, controller.signal); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controllers.delete(controller); }
  }
  return {
    list,
    async refresh(force = false) {
      if (!enabled) return list();
      if (pending) return pending;
      if (!force && ((lastFetched !== null && now() - lastFetched < REFRESH_MS) || (attempted !== null && now() - attempted < 300000))) return list();
      attempted = now();
      pending = (async () => {
        try {
          const bytes = await request(`https://api.github.com/search/repositories?q=topic%3A${TOPIC}&sort=stars&order=desc&per_page=100`);
          const raw = JSON.parse(bytes.toString('utf8'));
          const next = normalizeRepositories(raw);
          if (disposed) return list();
          atomicJson(file, { at: now(), raw });
          entries = next; lastFetched = now(); limited = Boolean(raw.incomplete_results || raw.total_count > next.length); error = '';
        } catch (cause) { if (!disposed) error = cleanText(cause.message, 300); }
        return list();
      })();
      try { return await pending; } finally { pending = null; }
    },
    async readme(id, signal) {
      if (!entries.some(entry => entry.id === id)) throw new Error('Unknown GitHub discovery entry');
      return this.repositoryReadme(`https://github.com/${id}`, signal);
    },
    async repositoryReadme(repository, signal) {
      const id = new URL(repository).pathname.replace(/^\/|\/$/g, '');
      if (!REPO_RE.test(id)) throw new Error('Invalid repository');
      const raw = JSON.parse((await request(`https://api.github.com/repos/${id}/readme`, 512 * 1024, signal)).toString('utf8'));
      if (raw.encoding !== 'base64' || typeof raw.content !== 'string') throw new Error('README is unavailable');
      const bytes = Buffer.from(raw.content, 'base64');
      if (bytes.length > 256 * 1024) throw new Error('README is too large');
      const base = new URL(raw.download_url);
      if (base.protocol !== 'https:' || base.hostname !== 'raw.githubusercontent.com' || !base.pathname.toLowerCase().startsWith(`/${id.toLowerCase()}/`) || base.username || base.password) throw new Error('Invalid README location');
      return { readme: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''), baseUrl: base.href };
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); controllers.clear(); }
  };
}
module.exports = { TOPIC, normalizeRepositories, createGitHubDiscovery };
