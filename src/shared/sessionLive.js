'use strict';

// The two display facts about a session that more than one surface has to
// agree on: whether it is still being written to, and how much of its context
// window is left. Both derive from the session record the scan produced, so
// they live here rather than in either renderer - the Sessions list and an
// Edge Dock card show the same session, and a session that reads as running in
// one and not the other is a bug the user can see.
//
// These are deliberately NOT the collector's decisions. src/shared/
// sessionContext.js owns when a transcript is worth reading (a wider window,
// so a session that pauses mid-task keeps its reading) and what a valid pair
// looks like; this module owns what the UI does with the answer.
(function exposeSessionLive(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSessionLive = api;
})(typeof window !== 'undefined' ? window : null, function createSessionLiveApi() {
  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function timestampMs(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function nowMs(value) {
    if (value instanceof Date) return value.getTime();
    const number = Number(value);
    return Number.isFinite(number) ? number : Date.now();
  }

  // How recently a session's transcript must have been written to for it to
  // count as running. Sized to outlast one model turn: the collector's watcher
  // reacts to a transcript write within seconds, so nothing here waits on a
  // poll, and a mid-turn pause does not blink the row out.
  const RUNNING_WINDOW_MS = 10 * 60 * 1000;

  // An archived session is never running whatever its timestamp says: the
  // source it was read from is gone, so nothing can still be appending to it.
  function isArchivedSession(session) {
    return session?.archived === true || session?.deleted === true || session?.sourceDeleted === true;
  }

  function isRunningSession(session, now = Date.now()) {
    // Delegates rather than repeating the window check: a session that reported
    // its turn finished is not running, and two predicates answering that
    // differently is exactly the drift this module exists to prevent.
    return sessionActivityState(session, now) === 'running';
  }

  // Three states, not two. A live session's transcript says whether the agent
  // is still working on a turn, and reading that is strictly better than a
  // timeout for the clients that report it: the run ends when it ends, not up
  // to ten minutes later. `turnEnded` is that report, set by the provider
  // readers when the last thing the transcript did was finish a turn.
  //
  //   running - transcript moved recently AND no turn-end after it
  //   ended   - the transcript said the turn finished
  //   idle    - quiet for longer than the window; nothing claims it is live
  //
  // `ended` matters because it is the difference between "the agent is
  // generating" and "the window is still open" — which is the distinction the
  // single dot could not make, and why a finished run used to keep its green
  // for the rest of the window.
  function sessionActivityState(session, now = Date.now()) {
    if (isArchivedSession(session)) return 'idle';
    const last = timestampMs(session?.lastUsedAt);
    if (!last) return 'idle';
    const recent = nowMs(now) - last <= RUNNING_WINDOW_MS;
    if (session?.turnEnded === true) return recent ? 'ended' : 'idle';
    return recent ? 'running' : 'idle';
  }

  // Both halves come from the client's own transcript and only for a session
  // recent enough to still be open, so their absence is the normal case (every
  // client whose transcript we do not read, and every session that has gone
  // quiet) rather than an error worth showing.
  function sessionContextWindow(session) {
    const contextTokens = finiteNumber(session?.contextTokens);
    const contextWindow = finiteNumber(session?.contextWindow);
    if (contextTokens <= 0 || contextWindow <= 0) return null;
    // A transcript reporting more than its window fits means the two disagree;
    // report no headroom rather than a negative one.
    const percentLeft = Math.max(0, Math.round(((contextWindow - contextTokens) / contextWindow) * 100));
    // Derived rather than rounded a second time, so the two readings of the
    // same gauge can never disagree by a point at a .5 boundary.
    return { contextTokens, contextWindow, percentLeft, percentUsed: 100 - percentLeft };
  }

  // Colour is reserved for headroom that is actually running out. A gauge that
  // is coloured while healthy spends most of a window's life saying nothing -
  // and on a running row it would be the same green as the live dot beside it,
  // so one colour would carry two unrelated meanings. Neutral until it matters
  // leaves green meaning exactly one thing in a list: this session is alive.
  //
  // 'low' is where a client stops merely being tight: Codex auto-compacts at
  // model_auto_compact_token_limit, which its own tooling defaults to a tenth
  // of the window. 'caution' is the heads-up before that.
  const CONTEXT_TONES = [
    { tone: 'low', maxPercentLeft: 10 },
    { tone: 'caution', maxPercentLeft: 30 }
  ];

  function contextTone(percentLeft) {
    for (const { tone, maxPercentLeft } of CONTEXT_TONES) {
      if (percentLeft <= maxPercentLeft) return tone;
    }
    return '';
  }

  function sessionContextRow(session) {
    const context = sessionContextWindow(session);
    if (!context) return undefined;
    return { ...context, tone: contextTone(context.percentLeft) };
  }

  // Whether a row should show its headroom reading, decided in one place because
  // two surfaces render the same session and disagreeing about this is visible:
  // the dock card was showing a gauge for a session the Sessions list had already
  // stopped showing one for.
  //
  // The reading is current while the session is still within the recency window,
  // so it survives the moment a turn ends - a gauge that vanishes the instant
  // work stops is worse than one that stays until the session goes quiet. Once
  // idle, nothing about the reading is still actionable and the row drops it.
  function sessionContextForRow(session, now = Date.now()) {
    if (sessionActivityState(session, now) === 'idle') return undefined;
    return sessionContextRow(session);
  }

  // The three state glyphs, as markup, so both renderers draw the same shapes
  // and only name their CSS classes differently. Six spokes with one leading at
  // full opacity read as rotation even in a still frame, which is why the
  // spinner needs no image asset.
  // The check is drawn here as a stroked circle plus a stroked tick, replacing a
  // filled check-circle artwork: a filled ring scaled from a 16px viewBox down to
  // 10px leaves its inner and outer edges about half a pixel apart, which is the
  // roughness that prompted this. Strokes stay crisp at this size and match the
  // repo's other action icons, which are all stroke-based. Nothing here is copied
  // from an icon set, so there is no third-party notice to add.
  const CHECK_PATHS = ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18', 'm8.7 12.2 2.1 2.1 4.5-4.6'];

  function sessionStateMarkup(classes = {}) {
    const turn = String(classes.spin || 'spin');
    const check = String(classes.check || 'check');
    const idle = String(classes.idle || 'idle');
    const tick = CHECK_PATHS.map((d) => `<path d="${d}"/>`).join('');
    // The spinner is an empty hook: its shape comes from the repo's own
    // `icons/actions/spinner.svg` applied as a CSS mask, exactly as the
    // refresh button already does, so the one loader asset is not redrawn here.
    return `<span class="${turn}"></span>`
      + `<svg class="${check}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
      + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${tick}</svg>`
      + `<span class="${idle}"></span>`;
  }

  return {
    CONTEXT_TONES,
    RUNNING_WINDOW_MS,
    contextTone,
    isArchivedSession,
    isRunningSession,
    sessionActivityState,
    sessionContextForRow,
    sessionContextRow,
    sessionContextWindow,
    sessionStateMarkup
  };
});
