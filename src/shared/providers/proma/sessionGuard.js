'use strict';

// Token Monitor's tokscale fork read Proma before upstream did and keyed each
// Agent journal as `<file stem>@<12 hex root namespace>`. Proma names journals
// after randomUUID() session ids, so the stem never contains `@`, and upstream
// reports the same usage under Proma, SDK or Pi session ids instead. The two
// cannot be matched from archived aggregates, so fork-era rows stay in the
// session archive untouched but are no longer replayed into totals; a journal
// upstream rescans is then counted once. History that exists only in such a row
// is no longer part of the totals (docs/providers/proma.md).
const FORK_SESSION_ID = /^[^@]+@[0-9a-f]{12}$/;

function isForkEraPromaSession(client, sessionId) {
  return client === 'proma' && FORK_SESSION_ID.test(String(sessionId || ''));
}

module.exports = { isForkEraPromaSession };
