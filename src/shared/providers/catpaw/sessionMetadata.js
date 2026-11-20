// @ts-check
'use strict';

const { shouldReadSessionContext } = require('../../sessionContext');
const { readCatPawSessionContexts } = require('./sessionContext');

/**
 * @param {Iterable<string>} sessionIds
 * @param {Record<string, any>} [context]
 * @returns {Map<string, { contextTokens: number, contextWindow: number }>}
 */
function resolveSessionMetadata(sessionIds, context = {}) {
  const liveIds = [];
  for (const sessionId of sessionIds || []) {
    const key = `catpaw:${sessionId}`;
    const live = Object.values(context.periods || {}).some((period) => (
      shouldReadSessionContext(period?.sessions?.[key]?.lastUsedAt || period?.sessions?.[key]?.startedAt, context.now)
    ));
    if (live) liveIds.push(sessionId);
  }
  return liveIds.length
    ? readCatPawSessionContexts(liveIds, { home: context.home, deps: context.deps })
    : new Map();
}

module.exports = { resolveSessionMetadata };
