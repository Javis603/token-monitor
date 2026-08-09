'use strict';

const semver = require('semver');

const GITHUB_REPO = 'Javis603/token-monitor';
const RELEASES_LATEST_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const APP_UPDATE_BACKGROUND_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const APP_UPDATE_OUTDATED_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_RELEASE_BODY_CHARS = 128 * 1024;
const MAX_RELEASE_NOTE_GROUPS = 4;
const MAX_RELEASE_NOTE_ITEMS = 12;
const MAX_RELEASE_NOTE_ITEM_CHARS = 600;
const MAX_RELEASE_NOTE_HTML_MARKUP_CHARS = 1024;
const TRAILING_PULL_REQUEST_REFERENCES_RE = /\s*(?:\(\s*#\d+(?:\s*,\s*#\d+)*\s*\)|（\s*#\d+(?:\s*[、，,]\s*#\d+)*\s*）)\s*$/;
const RELEASE_NOTE_HTML_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i',
  'img', 'ins', 'kbd', 'li', 'main', 'mark', 'ol', 'p', 'picture', 'pre', 'q',
  's', 'samp', 'script', 'section', 'small', 'source', 'span', 'strong', 'style',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time',
  'tr', 'u', 'ul', 'var'
]);
const RELEASE_NOTE_VOID_HTML_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

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

// How long an install attempt may sit unconfirmed before we conclude the
// installer never took over. quitAndInstall() returns void and the failure paths
// emit nothing, so still being alive is the only failure signal there is. The
// bound has to clear a working install by a wide margin: expiring on one would
// hand the quit flags back mid-install, and on macOS it also burns the session's
// one install attempt.
//
// NsisUpdater and AppImageUpdater run install() synchronously and emit the
// hand-off from a setImmediate, so a working install is gone within a tick.
//
// macOS is far slower, for a reason easy to miss. We run with autoInstallOnAppQuit
// off, so MacUpdater does not involve Squirrel at download time (updateDownloaded
// only calls checkForUpdates when that flag is on). quitAndInstall() therefore
// always takes the branch that starts Squirrel from scratch: it pulls the
// already-downloaded zip back through electron-updater's local proxy, validates
// the signature and stages the swap, and only then hands off. The pull is
// localhost and quick; the validation and staging are not. Seconds to tens of
// seconds is normal, so the bound is minutes. At that distance expiry does mean
// something has genuinely stalled, which is why it is reported on every platform.
//
// singleUseAttempt is the other half, and it is a property of the call rather
// than of any outcome. MacUpdater.quitAndInstall() attaches an anonymous
// nativeUpdater 'update-downloaded' listener before it starts Squirrel, and
// nothing ever detaches it: not an error, which only warns and re-emits, and not
// a timeout. So on macOS the first call is the only one this process may safely
// make, however it ends. BaseUpdater instead resets quitAndInstallCalled whenever
// install() returns false or throws, leaving nothing behind, so Windows and Linux
// can retry a failed attempt.
function updateInstallQuitPolicy(platform = process.platform) {
  return platform === 'darwin'
    ? { graceMs: 5 * 60 * 1000, singleUseAttempt: true }
    : { graceMs: 10 * 1000, singleUseAttempt: false };
}

// Which recovery a terminal install failure can honestly advise. Three places ask
// it -- the stall report, an updater error and a synchronous throw -- and letting
// each answer separately is how a stall came to advise a restart on the platforms
// where the guard had already handed the attempt back. Only the guard knows, and
// only once it has ended the attempt, so `spent` is passed in rather than derived.
//
// Restarting is the recovery of last resort: it is the only one where the attempt
// cannot be repeated, and offering it where an install is still one press away
// sends the user the long way round.
function installFailureErrorKind({ spent = false, stalled = false } = {}) {
  if (stalled) return spent ? 'installer-did-not-start-spent' : 'installer-did-not-start';
  return spent ? 'install-spent-by-failure' : null;
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

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"'
  };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(named, lower)) return named[lower];
    const codePoint = lower.startsWith('#x')
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch (_) {
      return match;
    }
  });
}

function isAsciiLetterAt(value, index) {
  const code = value.charCodeAt(index);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlphaNumericAt(value, index) {
  const code = value.charCodeAt(index);
  return isAsciiLetterAt(value, index)
    || (code >= 48 && code <= 57);
}

function isAsciiHtmlWhitespaceAt(value, index) {
  return value[index] === '\t'
    || value[index] === '\n'
    || value[index] === '\f'
    || value[index] === '\r'
    || value[index] === ' ';
}

function htmlMarkupEnd(value, index) {
  let quote = '';
  const limit = Math.min(value.length, index + MAX_RELEASE_NOTE_HTML_MARKUP_CHARS);
  for (let cursor = index + 1; cursor < limit; cursor += 1) {
    if (quote) {
      if (value[cursor] === quote) quote = '';
    } else if (value[cursor] === '"' || value[cursor] === "'") {
      quote = value[cursor];
    } else if (value[cursor] === '>') {
      return cursor;
    }
  }
  return -1;
}

function containsNestedHtmlMarkup(value, index, end) {
  for (let cursor = index + 1; cursor < end; cursor += 1) {
    if (value[cursor] === '<' && startsHtmlMarkup(value, cursor)) return true;
  }
  return false;
}

function hasMatchingHtmlClosingTag(value, index, tagName) {
  const lower = value.toLowerCase();
  const prefix = `</${tagName}`;
  let cursor = index;
  while (cursor < value.length) {
    const markupStart = value.indexOf('<', cursor);
    if (markupStart < 0) return false;
    if (value.startsWith('<!--', markupStart)) {
      const commentEnd = value.indexOf('-->', markupStart + 4);
      if (commentEnd < 0) return false;
      cursor = commentEnd + 3;
      continue;
    }

    if (lower.startsWith(prefix, markupStart)) {
      let closingEnd = markupStart + prefix.length;
      while (isAsciiHtmlWhitespaceAt(value, closingEnd)) closingEnd += 1;
      if (value[closingEnd] === '>') return true;
    }

    const tagLike = isAsciiLetterAt(value, markupStart + 1)
      || (value[markupStart + 1] === '/' && isAsciiLetterAt(value, markupStart + 2))
      || value[markupStart + 1] === '!'
      || value[markupStart + 1] === '?';
    if (!tagLike) {
      cursor = markupStart + 1;
      continue;
    }
    const markupEnd = htmlMarkupEnd(value, markupStart);
    if (markupEnd < 0) return false;
    cursor = markupEnd + 1;
  }
  return false;
}

function startsHtmlMarkup(value, index) {
  if (value[index] !== '<') return false;
  if (value.startsWith('<!--', index)) {
    const commentEnd = value.indexOf('-->', index + 4);
    return commentEnd >= 0 && commentEnd - index < MAX_RELEASE_NOTE_HTML_MARKUP_CHARS;
  }

  const end = htmlMarkupEnd(value, index);
  if (end < 0) return false;
  if (value[index + 1] === '!' || value[index + 1] === '?') return true;

  const closing = value[index + 1] === '/';
  const nameStart = index + (closing ? 2 : 1);
  if (!isAsciiLetterAt(value, nameStart)) return false;
  let nameEnd = nameStart + 1;
  while (isAsciiAlphaNumericAt(value, nameEnd) || value[nameEnd] === '-') nameEnd += 1;
  const tagName = value.slice(nameStart, nameEnd).toLowerCase();
  if (!RELEASE_NOTE_HTML_TAGS.has(tagName) && !RELEASE_NOTE_VOID_HTML_TAGS.has(tagName)) {
    return containsNestedHtmlMarkup(value, index, end);
  }
  if (closing) return true;
  if (RELEASE_NOTE_VOID_HTML_TAGS.has(tagName)) return true;
  return hasMatchingHtmlClosingTag(value, end + 1, tagName);
}

function textOutsideHtmlMarkup(value) {
  const input = String(value || '');
  let output = '';
  let mode = 'text';
  let tagQuote = '';
  for (let index = 0; index < input.length; index += 1) {
    if (mode === 'comment') {
      if (input[index] === '-' && input[index + 1] === '-' && input[index + 2] === '>') {
        mode = 'text';
        index += 2;
      }
      continue;
    }
    if (mode === 'tag') {
      if (tagQuote) {
        if (input[index] === tagQuote) tagQuote = '';
      } else if (input[index] === '"' || input[index] === "'") {
        tagQuote = input[index];
      } else if (input[index] === '>') {
        mode = 'text';
      }
      continue;
    }
    if (startsHtmlMarkup(input, index)) {
      if (input[index + 1] === '!' && input[index + 2] === '-' && input[index + 3] === '-') {
        mode = 'comment';
        index += 3;
      } else {
        mode = 'tag';
        tagQuote = '';
      }
      continue;
    }
    output += input[index];
  }
  return decodeHtmlEntities(output);
}

function plainReleaseNoteText(value, maxChars = MAX_RELEASE_NOTE_ITEM_CHARS) {
  const text = textOutsideHtmlMarkup(value)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
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
  for (const locale of ['en', 'zh', 'zh-TW', 'ko', 'ja']) {
    const section = markedReleaseNoteSection(body, locale);
    const groups = section ? parseReleaseNoteGroups(section) : [];
    if (groups.length > 0) notes[locale] = groups;
  }
  return notes;
}

function parseHtmlReleaseNoteGroups(section) {
  const groups = [];
  let itemCount = 0;
  const headings = Array.from(section.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi));
  for (let index = 0; index < headings.length && groups.length < MAX_RELEASE_NOTE_GROUPS; index += 1) {
    const heading = headings[index];
    const title = plainReleaseNoteText(heading[1], 80);
    if (!title) continue;
    const contentStart = (heading.index || 0) + heading[0].length;
    const contentEnd = index + 1 < headings.length ? headings[index + 1].index : section.length;
    const items = [];
    for (const match of section.slice(contentStart, contentEnd).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      if (itemCount >= MAX_RELEASE_NOTE_ITEMS) break;
      const text = plainReleaseNoteText(match[1]);
      if (!text) continue;
      items.push(text);
      itemCount += 1;
    }
    if (items.length > 0) groups.push({ title, items });
  }
  return groups;
}

function extractHtmlReleaseNotes(value) {
  if (typeof value !== 'string' || !value.trim()) return {};
  const body = value.slice(0, MAX_RELEASE_BODY_CHARS);
  const headings = Array.from(body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi));
  const localeByHeading = new Map([
    ['english', 'en'],
    ['中文', 'zh'],
    ['繁體中文', 'zh-TW'],
    ['한국어', 'ko'],
    ['日本語', 'ja']
  ]);
  const notes = {};
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const title = plainReleaseNoteText(heading[1], 40).toLowerCase();
    const locale = localeByHeading.get(title);
    if (!locale) continue;
    const contentStart = (heading.index || 0) + heading[0].length;
    const contentEnd = index + 1 < headings.length ? headings[index + 1].index : body.length;
    const localeSection = body.slice(contentStart, contentEnd);
    // GitHub strips Markdown comment markers and may omit collapsed <details>
    // content from Atom entirely. Parse only locale headings present in the
    // feed; the renderer owns locale fallback when a section is absent. The
    // first h2 is the app summary and the next begins its download section.
    const sectionHeadings = Array.from(localeSection.matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi));
    if (sectionHeadings.length === 0) continue;
    const summaryStart = (sectionHeadings[0].index || 0) + sectionHeadings[0][0].length;
    const summaryEnd = sectionHeadings[1]?.index ?? localeSection.length;
    const groups = parseHtmlReleaseNoteGroups(localeSection.slice(summaryStart, summaryEnd));
    if (groups.length > 0) notes[locale] = groups;
  }
  return notes;
}

function extractUpdaterReleaseNotes(value, version) {
  let note = value;
  if (Array.isArray(value)) {
    const matching = value.find((entry) => parseTag(entry?.version) === parseTag(version));
    note = matching?.note ?? value[0]?.note;
  }
  if (typeof note !== 'string') return {};
  const marked = extractReleaseNotes(note);
  return Object.keys(marked).length > 0 ? marked : extractHtmlReleaseNotes(note);
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
  const htmlUrl = `https://github.com/${GITHUB_REPO}/releases/tag/${encodeURIComponent(tag)}`;
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

function latestFromUpdaterInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const version = parseTag(info.version);
  if (!version) return null;
  const infoTag = typeof info.tag === 'string' && parseTag(info.tag) === version ? info.tag : '';
  const tag = infoTag || `v${version}`;
  const releaseNotes = extractUpdaterReleaseNotes(info.releaseNotes, version);
  return {
    version,
    tag,
    name: (typeof info.releaseName === 'string' && info.releaseName.trim()) ? info.releaseName : tag,
    htmlUrl: `https://github.com/${GITHUB_REPO}/releases/tag/${encodeURIComponent(tag)}`,
    publishedAt: typeof info.releaseDate === 'string' ? info.releaseDate : '',
    ...(Object.keys(releaseNotes).length > 0 ? { releaseNotes } : {})
  };
}

function providerUpdateCheckAvailability(result, currentVersion) {
  const latest = latestFromUpdaterInfo(result?.updateInfo);
  if (!latest) return { valid: false, newer: false, latest: null, clearLatest: false };
  const current = parseTag(currentVersion);
  const newer = Boolean(result?.isUpdateAvailable === true
    && current
    && semver.gt(latest.version, current));
  const isCurrent = Boolean(current && latest.version === current);
  return {
    valid: true,
    newer,
    latest: newer || isCurrent ? latest : null,
    clearLatest: !newer && !isCurrent
  };
}

function errorDetails(error) {
  const details = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current) && details.length < 4) {
    seen.add(current);
    details.push({
      name: String(current.name || ''),
      code: String(current.code || ''),
      status: Number(current.status || current.statusCode || 0),
      message: current.message || String(current)
    });
    current = current.cause;
  }
  return details;
}

function classifyAppUpdateError(error) {
  const details = errorDetails(error);
  const message = details[0]?.message || 'Update check failed';
  const haystack = details.map((detail) => `${detail.name} ${detail.code} ${detail.message}`).join(' ').toLowerCase();
  const statuses = details.map((detail) => detail.status);
  if (statuses.includes(429) || (statuses.includes(403) && /rate.?limit/.test(haystack)) || /rate.?limit/.test(haystack)) {
    return { kind: 'rateLimited', message };
  }
  if (/abort|timed?[\s_]?out|etimedout/.test(haystack)) {
    return { kind: 'timeout', message };
  }
  if (/enotfound|eai_again|econnrefused|econnreset|fetch failed|network|socket hang up|err_(?:address_unreachable|connection_closed|connection_refused|connection_reset|internet_disconnected|name_not_resolved|network_changed|proxy_connection_failed)/.test(haystack)) {
    return { kind: 'network', message };
  }
  if (statuses.some((status) => status >= 500) || /github responded 5\d\d/.test(haystack)) {
    return { kind: 'githubUnavailable', message };
  }
  if (details.some((detail) => detail.name === 'SyntaxError')
    || /err_updater_(?:channel_file_not_found|invalid_release_feed|latest_version_not_found|no_published_versions)|payload missing|metadata missing|invalid payload/.test(haystack)) {
    return { kind: 'metadata', message };
  }
  return { kind: 'unknown', message };
}

function resolveAppUpdateCheckError(previousError, result, { force = false } = {}) {
  if (result?.ok) return null;
  if (!force) return previousError || null;
  return {
    kind: result?.errorKind || 'unknown',
    message: result?.error || 'Update check failed'
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

function shouldDownloadAutomaticAppUpdate({
  automaticAppUpdates = false,
  updateState = null
} = {}) {
  return Boolean(
    automaticAppUpdates
    && updateState?.hasUpdate
    && updateState.installSupported
    && updateState.dismissedVersion !== updateState.latest?.version
    && !updateState.downloaded
    && !updateState.installBusy
    // A spent attempt can never be installed in this process, so downloading again
    // on every background check would be a repeating download of an artifact
    // nothing can use.
    && !updateState.installRetryBlocked
  );
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
          // GitHub's public web route returns release JSON through content negotiation.
          // electron-updater uses the same route so public checks avoid api.github.com quotas.
          'accept': 'application/json',
          'user-agent': `token-monitor/${currentVersion || '0.0.0'}`
        }
      });
      if (!response.ok) {
        const responseError = new Error(`GitHub responded ${response.status}`);
        responseError.status = response.status;
        throw responseError;
      }
      return response.json();
    });
    const latest = parseLatestReleasePayload(payload);
    if (!latest) {
      return { ok: false, newer: false, latest: null, error: 'Release payload missing or invalid', errorKind: 'metadata', checkedAt };
    }
    const current = semver.valid(currentVersion) ? currentVersion : '0.0.0';
    const newer = semver.gt(latest.version, current);
    return { ok: true, newer, latest, error: null, errorKind: null, checkedAt };
  } catch (error) {
    const classified = classifyAppUpdateError(error);
    return { ok: false, newer: false, latest: null, error: classified.message, errorKind: classified.kind, checkedAt };
  }
}

module.exports = {
  appUpdateInstallSupport,
  installFailureErrorKind,
  updateInstallQuitPolicy,
  parseTag,
  parseLatestReleasePayload,
  latestFromUpdaterInfo,
  providerUpdateCheckAvailability,
  classifyAppUpdateError,
  resolveAppUpdateCheckError,
  shouldSkipAppUpdateCheck,
  downloadedAppUpdateMatchesLatest,
  shouldDownloadAutomaticAppUpdate,
  deriveAppUpdateAvailability,
  extractReleaseNotes,
  extractUpdaterReleaseNotes,
  mergeLatestReleaseMetadata,
  checkLatestRelease,
  RELEASES_LATEST_URL,
  GITHUB_REPO,
  APP_UPDATE_BACKGROUND_COOLDOWN_MS,
  APP_UPDATE_OUTDATED_COOLDOWN_MS
};
