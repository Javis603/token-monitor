'use strict';

const semver = require('semver');

const GITHUB_REPO = 'Javis603/token-monitor';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const APP_UPDATE_BACKGROUND_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const APP_UPDATE_OUTDATED_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_RELEASE_BODY_CHARS = 128 * 1024;
const MAX_RELEASE_NOTE_GROUPS = 4;
const MAX_RELEASE_NOTE_ITEMS = 12;
const MAX_RELEASE_NOTE_ITEM_CHARS = 600;
const TRAILING_PULL_REQUEST_REFERENCES_RE = /\s*(?:\(\s*#\d+(?:\s*,\s*#\d+)*\s*\)|（\s*#\d+(?:\s*[、，,]\s*#\d+)*\s*）)\s*$/;

function appUpdateInstallSupport({
  isPackaged = false,
  platform = process.platform,
  env = process.env
} = {}) {
  if (!isPackaged) return { supported: false, reason: 'unpackaged' };
  if (platform === 'darwin') return { supported: true, reason: '' };
  if (platform === 'win32') {
    return env?.PORTABLE_EXECUTABLE_FILE
      ? { supported: false, reason: 'windows-portable' }
      : { supported: true, reason: '' };
  }
  if (platform === 'linux') {
    return env?.APPIMAGE ? { supported: true, reason: '' } : { supported: false, reason: 'linux-not-appimage' };
  }
  return { supported: false, reason: 'unsupported-platform' };
}

function parseTag(tag) {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^v/i, '');
  return semver.valid(stripped) ? stripped : null;
}

function truncateReleaseNoteText(value, maxChars) {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return value;
  return `${characters.slice(0, maxChars - 1).join('').trimEnd()}…`;
}

function plainReleaseNoteText(value, maxChars = MAX_RELEASE_NOTE_ITEM_CHARS) {
  const text = String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/([：。！？])\s+/g, '$1')
    .trim()
    .replace(TRAILING_PULL_REQUEST_REFERENCES_RE, '')
    .trimEnd();
  return truncateReleaseNoteText(text, maxChars);
}

function markedReleaseNoteSection(body, locale) {
  const startMarker = `<!-- app-update-notes:${locale}:start -->`;
  const endMarker = `<!-- app-update-notes:${locale}:end -->`;
  const start = body.indexOf(startMarker);
  if (start < 0) return '';
  const contentStart = start + startMarker.length;
  const end = body.indexOf(endMarker, contentStart);
  return end < 0 ? '' : body.slice(contentStart, end);
}

function parseReleaseNoteGroups(section) {
  const groups = [];
  let current = null;
  let itemCount = 0;

  function finishCurrent() {
    if (!current?.title || current.items.length === 0 || groups.length >= MAX_RELEASE_NOTE_GROUPS) return;
    groups.push(current);
  }

  for (const line of section.split(/\r?\n/)) {
    const heading = /^\s*###\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      finishCurrent();
      current = groups.length < MAX_RELEASE_NOTE_GROUPS
        ? { title: plainReleaseNoteText(heading[1], 80), items: [] }
        : null;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!bullet || !current || itemCount >= MAX_RELEASE_NOTE_ITEMS) continue;
    const text = plainReleaseNoteText(bullet[1]);
    if (!text) continue;
    current.items.push(text);
    itemCount += 1;
  }
  finishCurrent();
  return groups;
}

function extractReleaseNotes(value) {
  if (typeof value !== 'string' || !value.trim()) return {};
  const body = value.slice(0, MAX_RELEASE_BODY_CHARS);
  const notes = {};
  for (const locale of ['en', 'zh']) {
    const section = markedReleaseNoteSection(body, locale);
    const groups = section ? parseReleaseNoteGroups(section) : [];
    if (groups.length > 0) notes[locale] = groups;
  }
  return notes;
}

function mergeLatestReleaseMetadata(existing, incoming) {
  if (!incoming || typeof incoming !== 'object') return null;
  if (!existing || existing.version !== incoming.version) return incoming;
  const releaseNotes = incoming.releaseNotes || existing.releaseNotes;
  return {
    ...existing,
    ...incoming,
    ...(releaseNotes ? { releaseNotes } : {})
  };
}

function parseLatestReleasePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const tag = typeof payload.tag_name === 'string' ? payload.tag_name : '';
  const version = parseTag(tag);
  if (!version) return null;
  const htmlUrl = typeof payload.html_url === 'string' ? payload.html_url : '';
  if (!htmlUrl.startsWith('https://')) return null;
  const releaseNotes = extractReleaseNotes(payload.body);
  return {
    version,
    tag,
    name: (typeof payload.name === 'string' && payload.name.trim()) ? payload.name : tag,
    htmlUrl,
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : '',
    ...(Object.keys(releaseNotes).length > 0 ? { releaseNotes } : {})
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
  const availability = deriveAppUpdateAvailability({ currentVersion, latest, dismissedVersion });
  const cachedUpdate = availability.hasUpdate && !availability.dismissed;
  const cooldownMs = cachedUpdate ? APP_UPDATE_OUTDATED_COOLDOWN_MS : APP_UPDATE_BACKGROUND_COOLDOWN_MS;
  return nowMs - last < cooldownMs;
}

function downloadedAppUpdateMatchesLatest({
  phase,
  downloadedVersion,
  latest
} = {}) {
  if (phase !== 'downloaded') return false;
  const version = semver.valid(downloadedVersion);
  const latestVersion = semver.valid(latest?.version);
  return Boolean(version && latestVersion && version === latestVersion);
}

function deriveAppUpdateAvailability({
  currentVersion,
  latest,
  dismissedVersion,
  phase,
  downloadedVersion
} = {}) {
  const current = semver.valid(currentVersion);
  const latestVersion = semver.valid(latest?.version);
  const hasUpdate = Boolean(current && latestVersion && semver.gt(latestVersion, current));
  const dismissed = Boolean(hasUpdate && latestVersion === dismissedVersion);
  const downloaded = downloadedAppUpdateMatchesLatest({ phase, downloadedVersion, latest });
  return {
    hasUpdate,
    dismissed,
    downloaded,
    showUpdateNotice: downloaded || (hasUpdate && !dismissed)
  };
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
  appUpdateInstallSupport,
  parseTag,
  parseLatestReleasePayload,
  shouldSkipAppUpdateCheck,
  downloadedAppUpdateMatchesLatest,
  deriveAppUpdateAvailability,
  extractReleaseNotes,
  mergeLatestReleaseMetadata,
  checkLatestRelease,
  RELEASES_LATEST_URL,
  GITHUB_REPO,
  APP_UPDATE_BACKGROUND_COOLDOWN_MS,
  APP_UPDATE_OUTDATED_COOLDOWN_MS
};
