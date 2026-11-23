// @ts-check
'use strict';

const REPOSITORY_API_URL = 'https://api.github.com/repos/Javis603/token-monitor';
const REQUEST_TIMEOUT_MS = 10 * 1000;
// The count only decorates the About card's GitHub button, so it is asked for
// when General settings opens and then reused. Unauthenticated REST calls share
// a 60-an-hour quota per IP, so a whole office behind one address stays far
// below it.
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 60 * 1000;

/**
 * @param {unknown} payload
 * @returns {number | null}
 */
function starsFromPayload(payload) {
  const stars = payload && typeof payload === 'object'
    ? /** @type {{ stargazers_count?: unknown }} */ (payload).stargazers_count
    : undefined;
  return typeof stars === 'number' && Number.isSafeInteger(stars) && stars >= 0 ? stars : null;
}

/**
 * @param {{ userAgent: string, fetchImpl?: typeof fetch, now?: () => number }} options
 */
function createRepositoryStars({ userAgent, fetchImpl = fetch, now = Date.now }) {
  /** @type {{ stars: number | null, expiresAt: number } | null} */
  let cached = null;
  /** @type {Promise<number | null> | null} */
  let pending = null;

  /** @returns {Promise<number | null>} */
  async function request() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(REPOSITORY_API_URL, {
        signal: controller.signal,
        headers: { accept: 'application/vnd.github+json', 'user-agent': userAgent }
      });
      if (!response.ok) return null;
      return starsFromPayload(await response.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** @returns {Promise<number | null>} */
  function get() {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.stars);
    if (!pending) {
      pending = request().then((stars) => {
        // A failed refresh keeps showing the last count rather than dropping it.
        cached = stars === null
          ? { stars: cached?.stars ?? null, expiresAt: now() + FAILURE_TTL_MS }
          : { stars, expiresAt: now() + SUCCESS_TTL_MS };
        pending = null;
        return cached.stars;
      });
    }
    return pending;
  }

  return { get };
}

module.exports = {
  REPOSITORY_API_URL,
  SUCCESS_TTL_MS,
  FAILURE_TTL_MS,
  createRepositoryStars,
  starsFromPayload
};
