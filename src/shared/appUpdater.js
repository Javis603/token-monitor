'use strict';

const semver = require('semver');

const GITHUB_REPO = 'Javis603/token-monitor';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const APP_UPDATE_BACKGROUND_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const APP_UPDATE_OUTDATED_COOLDOWN_MS = 60 * 60 * 1000;

function parseTag(tag) {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^v/i, '');
  return semver.valid(stripped) ? stripped : null;
}

function parseLatestReleasePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const tag = typeof payload.tag_name === 'string' ? payload.tag_name : '';
  const version = parseTag(tag);
  if (!version) return null;
  const htmlUrl = typeof payload.html_url === 'string' ? payload.html_url : '';
  if (!htmlUrl.startsWith('https://')) return null;
  return {
    version,
    tag,
    name: (typeof payload.name === 'string' && payload.name.trim()) ? payload.name : tag,
    htmlUrl,
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : ''
  };
}

function shouldSkipAppUpdateCheck({
  force = false,
  lastCheckedAt,
  latest,
  dismissedVersion,
  currentVersion,
  nowMs = Date.now()
} = {}) {
  if (force || !lastCheckedAt) return false;
  const last = Date.parse(lastCheckedAt);
  if (!Number.isFinite(last)) return false;
  const latestVersion = latest?.version;
  const current = semver.valid(currentVersion);
  const cachedUpdate = semver.valid(latestVersion)
    && current
    && semver.gt(latestVersion, current)
    && latestVersion !== dismissedVersion;
  const cooldownMs = cachedUpdate ? APP_UPDATE_OUTDATED_COOLDOWN_MS : APP_UPDATE_BACKGROUND_COOLDOWN_MS;
  return nowMs - last < cooldownMs;
}

async function withTimeout(ms, task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function checkLatestRelease(currentVersion) {
  const checkedAt = new Date().toISOString();
  try {
    const payload = await withTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
      const response = await fetch(RELEASES_LATEST_URL, {
        signal,
        headers: {
          'accept': 'application/vnd.github+json',
          'user-agent': `token-monitor/${currentVersion || '0.0.0'}`,
          'x-github-api-version': '2022-11-28'
        }
      });
      if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
      return response.json();
    });
    const latest = parseLatestReleasePayload(payload);
    if (!latest) {
      return { ok: false, newer: false, latest: null, error: 'Release payload missing or invalid', checkedAt };
    }
    const current = semver.valid(currentVersion) ? currentVersion : '0.0.0';
    const newer = semver.gt(latest.version, current);
    return { ok: true, newer, latest, error: null, checkedAt };
  } catch (error) {
    return { ok: false, newer: false, latest: null, error: error.message || String(error), checkedAt };
  }
}

module.exports = {
  parseTag,
  parseLatestReleasePayload,
  shouldSkipAppUpdateCheck,
  checkLatestRelease,
  RELEASES_LATEST_URL,
  GITHUB_REPO,
  APP_UPDATE_BACKGROUND_COOLDOWN_MS,
  APP_UPDATE_OUTDATED_COOLDOWN_MS
};
