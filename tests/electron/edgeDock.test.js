'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// This suite reaches into the renderer for the dock's own row/paint rules.
const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

const {
  EDGE_DOCK_METRICS,
  EDGE_DOCK_TIMING,
  createEdgeDockIntent,
  edgeDockBubbleBounds,
  edgeDockCellAt,
  edgeDockCellLayout,
  edgeDockCorridorBounds,
  edgeDockPeekBounds,
  edgeDockPlacementForDrop,
  edgeDockRailBounds,
  edgeDockTriggerBounds,
  normalizeEdgeDockDisplayId,
  normalizeEdgeDockOffset,
  normalizeEdgeDockSide,
  railLength
} = require('../../src/electron/edgeDock/geometry');
const { canUseEdgeDock } = require('../../src/electron/edgeDock/controller');
const { bubbleCommands, railCommands, toPolygons, toSvgPath } = require('../../src/electron/renderer/edgeDock/shapes');
const { rasterizeMask, shapeRectsFromPolygons } = require('../../src/electron/edgeDock/mask');
const { DEFAULT_LIMIT_COUNT, normalizeEdgeDockItems, reorderEdgeDockItems } = require('../../src/electron/renderer/edgeDock/items');
const { SESSIONS_METRIC } = require('../../src/electron/renderer/edgeDock/presentation');
const edgeDockPresentation = require('../../src/electron/renderer/edgeDock/presentation');
// The predicate the projection, the rail and the card all answer with, so these
// tests assert the same reading a surface would.
const sessionLive = require('../../src/shared/sessionLive');
const verticalDragSort = require('../../src/electron/renderer/verticalDragSort');
const { matchProviderAccount } = require('../../src/shared/subscriptionDisplay');
const accountIdentity = require('../../src/electron/renderer/accountIdentity');
const {
  buildEdgeDockCells,
  displayPercent,
  edgeDockCellSignature,
  remainingSeverity
} = require('../../src/electron/renderer/edgeDock/presentation');

const workArea = { x: 0, y: 25, width: 1440, height: 875 };
const displayBounds = { x: 0, y: 0, width: 1440, height: 900 };

test('every renderer stylesheet is brace-balanced', () => {
  // A splice that leaves an orphaned rule tail unbalances the file, and a stray
  // closing brace makes every later rule parse as part of a bogus block. That is
  // what silently stripped the Codex card's account-row rules and pushed the plan
  // label onto its own line: nothing failed, one brace was just off.
  for (const name of ['styles.css', path.join('edgeDock', 'dock.css')]) {
    const css = readRendererFile(name);
    let depth = 0;
    let firstUnbalanced = 0;
    let line = 1;
    for (const char of css) {
      if (char === '\n') line += 1;
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth < 0 && !firstUnbalanced) firstUnbalanced = line;
      }
    }
    assert.equal(firstUnbalanced, 0, `${name} closes a block that was never opened (line ${firstUnbalanced})`);
    assert.equal(depth, 0, `${name} ends with ${depth} unclosed block(s)`);
  }
});

test('the card edge spends none of the quota row separator the page needs', () => {
  const css = readRendererFile(path.join('edgeDock', 'dock.css'));
  const rule = css.match(/\.edge-dock-accounts > \.limit-row:last-child\s*\{([^}]*)\}/);
  assert.ok(rule, 'the last row in a card must reset what the shared row brings');
  // A `.limit-row` ends with a rule and 13px under it, which is the *inter-card*
  // separator on the page: the panel goes on below the row, so the rule marks
  // where the next card starts and the padding is the room it gets. The card ends
  // at the row, so both are spent on nothing — the rule becomes a line drawn under
  // the last thing the card says, and the padding pushed the section below it to
  // 23px against the card's own 10px gap (319px against the pre-refactor card's
  // 307px, for the same account and nothing else changed).
  assert.match(rule[1], /border-bottom: 0;/);
  assert.match(rule[1], /padding-bottom: 0;/);
});

test('the card takes the forecast separator from the page instead of redrawing it', () => {
  // The rule above the reset forecast belongs to the Limits view — styles.css
  // draws it for both of the shapes the forecast is appended to — and the card
  // is built on that same row in a document that loads that stylesheet, so the
  // card needs no rule of its own. A second copy is only a thing to drift: the
  // page's rule used to be scoped to `.limit-row-group`, and the card's own copy
  // existed to cover the single-account shape that scoping left out.
  const css = readRendererFile(path.join('edgeDock', 'dock.css')).replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.doesNotMatch(css, /\.codex-reset-forecast::before/);
  assert.match(
    readRendererFile(path.join('edgeDock', 'index.html')),
    /<link rel="stylesheet" href="\.\.\/styles\.css" \/>/
  );
});

test('the Sessions list uses a plain dot, not the dock card glyph stack', () => {
  // This row already leads with the client's own icon, so a spinner or check
  // drawn at its corner reads as part of that logo. The card has no such icon,
  // which is why the richer states live there and the old dot idiom stays here.
  const app = readRendererFile('app.js');
  const styles = readRendererFile('styles.css');
  assert.match(app, /rowLiveMarkup = '<span class="row-live-dot"><\/span>'/);
  assert.doesNotMatch(app, /sessionStateMarkup\(\{/);
  assert.doesNotMatch(styles, /row-live-spin|row-live-check|row-live-idle/);
  assert.match(styles, /\.row-live-dot\s*\{[\s\S]*?background: var\(--success\)/);
  // The dot is drawn only while the agent works, so a quiet row shows nothing.
  assert.match(app, /dot\.classList\.toggle\('is-active', active\)/);
  assert.match(app, /const active = activityState === 'running'/);
});

test('both surfaces decide the context readout with one shared gate', () => {
  // The dock card was showing a gauge for a session the Sessions list had
  // already dropped it from, because the two gated on different states.
  const sessionLive = require('../../src/shared/sessionLive');
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  const fresh = new Date(now - 30_000).toISOString();
  const old = new Date(now - sessionLive.RUNNING_WINDOW_MS - 1).toISOString();
  const withContext = (extra) => ({ contextTokens: 150_000, contextWindow: 200_000, ...extra });
  // Working: shown.
  assert.equal(sessionLive.sessionContextForRow(withContext({ lastUsedAt: fresh }), now).percentUsed, 75);
  // Turn just ended: still shown. The reading outlives the run, so the gauge
  // does not blink away the moment an answer lands.
  assert.ok(sessionLive.sessionContextForRow(withContext({ lastUsedAt: fresh, turnEnded: true }), now));
  // Gone quiet: dropped. Nothing about it is current any more.
  assert.equal(sessionLive.sessionContextForRow(withContext({ lastUsedAt: old }), now), undefined);
  assert.equal(sessionLive.sessionContextForRow(withContext({ lastUsedAt: old, turnEnded: true }), now), undefined);
  // Both renderers call it rather than gating on the running boolean.
  const rows = readRendererFile('sessionRows.js');
  const presentation = readRendererFile(path.join('edgeDock', 'presentation.js'));
  assert.match(rows, /context: sessionContextForRow\(session, now\)/);
  assert.match(presentation, /context: sessionLive\.sessionContextForRow\(session\)/);
});
test('the dock state mark uses the repo loader asset and a stroked check', () => {
  const markup = require('../../src/shared/sessionLive').sessionStateMarkup({
    spin: 'edge-dock-session-spin',
    check: 'edge-dock-session-check',
    idle: 'edge-dock-session-idle'
  });
  // The spin element is an empty hook for the CSS mask; drawing spokes inline
  // again would be a second loader that can drift from icons/actions/spinner.svg.
  assert.match(markup, /<span class="edge-dock-session-spin"><\/span>/);
  assert.doesNotMatch(markup, /<line /);
  // The check is stroked, not filled: a filled ring scaled down to 10px leaves
  // its edges about half a pixel apart, which reads as roughness.
  assert.match(markup, /<svg class="edge-dock-session-check"[^>]*fill="none"[^>]*stroke="currentColor"/);
  assert.doesNotMatch(markup, /fill="currentColor"/);
  assert.match(markup, /<span class="edge-dock-session-idle"><\/span>/);
});
test('the dock keeps the token total, adds headroom, and dots running rows instead of recolouring them', () => {
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const css = readRendererFile(path.join('edgeDock', 'dock.css'));
  const app = readRendererFile('app.js');
  // The token total must survive: headroom is additional, not a replacement for
  // the figure the row already carried.
  assert.match(dock, /el\('span', 'edge-dock-session-tokens', formatTokens\(session\.totalTokens\)\)/);
  // ...and both live on the same row, with the context reading appended to the
  // meta line rather than taking the token column.
  const sessions = dock.slice(dock.indexOf('function sessionsNode('), dock.indexOf('function providerCard('));
  assert.match(sessions, /edge-dock-session-meta/);
  assert.match(sessions, /if \(context\) meta\.append\(context\)/);
  // Running is a dot beside the name, not a recoloured title.
  assert.match(sessions, /nameNode\.append\(stateMark\(session, key, state\)\)/);
  assert.match(sessions, /nameNode\.append\(document\.createTextNode\(name\)\)/);
  assert.doesNotMatch(css, /\.edge-dock-session\.is-running \.edge-dock-session-name\s*\{[^}]*color/);
  // Three states: a spinner while working, a check once the transcript said the
  // turn finished, and a faint dot for a session that has gone quiet. The
  // running glyph is monochrome like the other two — its spokes animate, so the
  // state is already being said — but it wears the card's primary ink rather
  // than `--muted`, so the live row is not weighed the same as the finished one.
  assert.match(css, /\.edge-dock-session-spin \{\n {2}background: currentColor;\n {2}color: var\(--text\);/);
  assert.doesNotMatch(css, /\.edge-dock-session-spin \{[^}]*--success/);
  assert.match(css, /\.edge-dock-session-check\s*\{[\s\S]*?color: var\(--muted\)/);
  assert.match(css, /\.edge-dock-session-idle::before/);
  assert.match(css, /edge-dock-session-dot\[data-state="running"\] \.edge-dock-session-spin/);
  assert.match(css, /edge-dock-session-dot\[data-state="ended"\] \.edge-dock-session-check/);
  assert.match(css, /edge-dock-session-dot\[data-state="idle"\] \.edge-dock-session-idle/);
  // The spinner is the repo's own loader asset applied as a mask, not a second
  // loader drawn by hand. It carries NO CSS rotation: that file animates its own
  // spokes, and rotating the masked copy as well would spin it twice, with the
  // glyph's 45-degree symmetry aliasing a rigid rotation to ~8x the rate.
  assert.match(css, /\.edge-dock-session-spin\s*\{[\s\S]*?mask: url\("\.\.\/icons\/actions\/spinner\.svg"\)/);
  assert.doesNotMatch(css, /animation:\s*edge-dock-session-spin/);
  assert.doesNotMatch(css, /@keyframes edge-dock-session-spin/);
  // The asset itself has to keep the SMIL that mask relies on.
  assert.match(readRendererFile(path.join('icons', 'actions', 'spinner.svg')), /<animate attributeName="opacity"/);
  // The slot is reserved on EVERY row and only painted while running, so the
  // titles of running and idle rows start at the same x.
  assert.match(sessions, /const state = stateByKey\.get\(key\) \|\| 'idle'/);
  // The flare is one-shot, so an idle card animates nothing.
  // The flare rides along with the spin rather than replacing it, and adds no
  // `infinite` of its own: a flare always means a write.
  assert.match(css, /\.edge-dock-session-dot\.pulse \.edge-dock-session-spin \{/);
  // Its glow is neutral too, so the flare cannot be the loudest green thing in a
  // card whose running state no longer uses green at all.
  assert.match(css, /@keyframes edge-dock-session-pulse \{[\s\S]*?rgba\(var\(--overlay-rgb\), 0\.62\)/);
  assert.doesNotMatch(css, /@keyframes edge-dock-session-pulse \{[^}]*--success-rgb/);
  // Reduced motion swaps the spinner for a still dot, and it is the card's ink
  // rather than a hue too: a solid dot beside the quiet rows' faint one is the
  // reading, so the dock spends no colour on the running state anywhere.
  assert.match(css, /data-state="running"\] \.edge-dock-session-idle::before,\n[\s\S]*?background: var\(--text\)/);
  assert.doesNotMatch(css, /edge-dock-session-(spin|idle)[^;]*--success/);
  // The context reading carries a bar plus the number, and the tone rule is
  // keyed on headroom so a healthy reading stays neutral.
  assert.match(css, /edge-dock-session-context-meter/);
  assert.match(css, /edge-dock-session-context\[data-tone="low"\]/);
  // `calls` stays English on purpose, matching the Limits view's fixed wording:
  // it is a billing unit, and every Chinese candidate reads as a different
  // measure (closer to "invocations") than to billable calls.
  assert.match(readRendererFile('sessionRows.js'), /formatNumber\(count\)\} \$\{count === 1 \? 'call' : 'calls'\}/);
  assert.doesNotMatch(app, /callsLabel/);
  const i18n = readRendererFile('i18n.js');
  assert.doesNotMatch(i18n, /'session\.calls':/);
  assert.doesNotMatch(i18n, /'session\.callsOne':/);
});

test('running sessions are never truncated by the recent cap, and the count matches the rows', () => {
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 90 * 60_000).toISOString();
  const session = (id, lastUsedAt, extra = {}) => ({ client: 'codex', sessionId: id, lastUsedAt, totalTokens: 10, models: { 'gpt-5': 10 }, ...extra });
  const stats = {
    periods: {
      month: { sessions: {
        'codex:run1': session('run1', nowIso, { contextTokens: 281_012, contextWindow: 950_000, title: 'live one' }),
        'codex:run2': session('run2', nowIso),
        'codex:run3': session('run3', nowIso),
        'codex:run4': session('run4', nowIso),
        'codex:quiet1': session('quiet1', oldIso),
        'codex:quiet2': session('quiet2', oldIso)
      } },
      today: { sessions: {} }
    },
    limits: { providers: [provider('codex')] }
  };
  const [codex] = buildEdgeDockCells(stats, {});
  // Four running sessions exceed the recent cap of three, so all four appear and
  // the list scrolls: the cap must never hide live work. No quiet row fits in
  // the budget they consume.
  assert.deepEqual(codex.sessions.map((entry) => entry.sessionId), ['run1', 'run2', 'run3', 'run4']);
  assert.equal(codex.sessions.filter((entry) => entry.running).length, 4);
  // Context rides the row for a session whose transcript stated a window, and
  // is absent (not zero) for one that has gone quiet.
  assert.deepEqual(codex.sessions[0].context, { contextTokens: 281_012, contextWindow: 950_000, percentLeft: 70, percentUsed: 30, tone: '' });
  // Nothing running is a real answer, not a missing one.
  const [quietOnly] = buildEdgeDockCells({
    periods: { month: { sessions: { 'codex:q': session('q', oldIso) } }, today: { sessions: {} } },
    limits: { providers: [provider('codex')] }
  }, {});
  assert.equal(quietOnly.sessions.filter((entry) => entry.running).length, 0);
  // A quiet row has no reading to carry, which is a distinct fact from having
  // one that rounds to nothing.
  assert.equal(quietOnly.sessions[0].context, null);
});

test('the session cap is a total budget, so one going live does not add a row', () => {
  // The card showed three idle rows and then four the moment one of them started
  // running, because the running rows were added on top of a full quiet list.
  // The cap bounds the whole list; running rows are kept preferentially and the
  // tail fills only what they leave.
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 90 * 60_000).toISOString();
  const session = (id, lastUsedAt) => ({ client: 'codex', sessionId: id, lastUsedAt, totalTokens: 10, models: { 'gpt-5': 10 } });
  const build = (sessions) => buildEdgeDockCells({
    periods: { month: { sessions }, today: { sessions: {} } },
    limits: { providers: [provider('codex')] }
  }, {})[0];

  // Three quiet sessions: three rows, as before.
  const quiet = build({
    'codex:q1': session('q1', oldIso),
    'codex:q2': session('q2', oldIso),
    'codex:q3': session('q3', oldIso),
    'codex:q4': session('q4', oldIso)
  });
  assert.deepEqual(quiet.sessions.map((entry) => entry.sessionId), ['q1', 'q2', 'q3']);

  // The same list with one of them running still totals three, not four: the
  // session that started was already one of the three.
  const oneLive = build({
    'codex:q1': session('q1', nowIso),
    'codex:q2': session('q2', oldIso),
    'codex:q3': session('q3', oldIso),
    'codex:q4': session('q4', oldIso)
  });
  assert.equal(oneLive.sessions.length, 3, 'one live session must not grow the list');
  assert.deepEqual(oneLive.sessions.map((entry) => entry.sessionId), ['q1', 'q2', 'q3']);
  assert.equal(oneLive.sessions.filter((entry) => entry.running).length, 1);
  assert.equal(oneLive.sessions.filter((entry) => !entry.running).length, 2);

  // Two live: one quiet row is left to fill the remaining slot.
  const twoLive = build({
    'codex:q1': session('q1', nowIso),
    'codex:q2': session('q2', nowIso),
    'codex:q3': session('q3', oldIso),
    'codex:q4': session('q4', oldIso)
  });
  assert.deepEqual(twoLive.sessions.map((entry) => entry.sessionId), ['q1', 'q2', 'q3']);
  assert.equal(twoLive.sessions.filter((entry) => entry.running).length, 2);

  // Exactly the cap running: no quiet row fits.
  const threeLive = build({
    'codex:q1': session('q1', nowIso),
    'codex:q2': session('q2', nowIso),
    'codex:q3': session('q3', nowIso),
    'codex:q4': session('q4', oldIso)
  });
  assert.deepEqual(threeLive.sessions.map((entry) => entry.sessionId), ['q1', 'q2', 'q3']);
  assert.equal(threeLive.sessions.filter((entry) => !entry.running).length, 0);

  // Fewer sessions than the cap are all shown.
  const small = build({ 'codex:q1': session('q1', oldIso), 'codex:q2': session('q2', nowIso) });
  assert.equal(small.sessions.length, 2);
});
test('an archived session never counts as running on a dock card', () => {
  const nowIso = new Date().toISOString();
  const stats = {
    periods: {
      month: { sessions: { 'codex:a': { client: 'codex', sessionId: 'a', lastUsedAt: nowIso, totalTokens: 10, models: { 'gpt-5': 10 }, archived: true } } },
      today: { sessions: {} }
    },
    limits: { providers: [provider('codex')] }
  };
  const [codex] = buildEdgeDockCells(stats, {});
  assert.equal(codex.sessions[0].running, false);
});

// The grouped layout and the timeline put the running count in different places,
// and printing it in both is the bug this locks: with one tool running, the
// section's "1 running" and the card's "1 running" were literally the same
// number twice. The rule is one statement of the count per layout, not per card.
test('the running count is stated once per layout, and the group header centers its mark', () => {
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const css = readRendererFile(path.join('edgeDock', 'dock.css'));
  const card = dock.slice(dock.indexOf('function sessionsCard('), dock.indexOf('// Cards are built in a hidden staging layer'));
  // Ungrouped: the card head states the total, and the list under it stays quiet.
  assert.match(card, /if \(running\.length > 0 && cell\.groupBy !== 'client'\) \{/);
  assert.match(card, /sessionsContainer\(sessions, \{ showClientMark: true, showCount: false \}\)/);
  // Grouped: each section states its own, and only when it has one - a per-tool
  // "0 running" on every idle tool would be noise, not information.
  assert.match(card, /if \(liveCount > 0\) groupHead\.append/);
  assert.doesNotMatch(card, /edge-dock-card-status[\s\S]{0,400}groupBy === 'client'/);
  // A mask-drawn mark has no text baseline, so a baseline-aligned header row
  // floats it above its own label. The group header is its own centered row.
  assert.match(card, /const groupHead = el\('div', 'edge-dock-session-group-head'\)/);
  assert.doesNotMatch(card, /groupHead = el\('div', 'edge-dock-section-head'\)/);
  assert.match(css, /\.edge-dock-session-group-head \{[\s\S]*?align-items: center;/);
  assert.doesNotMatch(css, /\.edge-dock-session-group-head \{[^}]*align-items: baseline/);
  // The name yields space so a long tool name ellipsizes instead of pushing the
  // count off the row, and the mark never shrinks.
  assert.match(css, /\.edge-dock-session-group-head \.edge-dock-section-title \{[\s\S]*?text-overflow: ellipsis;/);
  assert.match(css, /\.edge-dock-session-group-head \.edge-dock-mark \{[\s\S]*?flex: 0 0 auto;/);
});


// The Sessions item exists for the clients no quota card can show. A cell whose
// rows all came from providers would be the same per-provider list again, one
// level up, and would leave those clients with no surface at all.
test('the sessions item lists every tracked client, including one with no limits provider', () => {
  const nowIso = new Date().toISOString();
  const session = (client, id, extra = {}) => ({
    client, sessionId: id, lastUsedAt: nowIso, totalTokens: 10, models: { 'some-model': 10 }, ...extra
  });
  const stats = {
    periods: {
      month: { sessions: {
        'codex:r1': session('codex', 'r1', { title: 'Dock work' }),
        'kilo:r2': session('kilo', 'r2'),
        'lmstudio:r3': session('lmstudio', 'r3')
      } },
      today: { sessions: { 'dsh:r4': session('dsh', 'r4') } }
    },
    // Only Codex has a quota record; the other three clients have none at all.
    limits: { providers: [provider('codex')] }
  };
  const [cell] = buildEdgeDockCells(stats, { items: [{ type: 'stat', metric: SESSIONS_METRIC }] });
  assert.equal(cell.kind, 'stat');
  assert.equal(cell.metric, SESSIONS_METRIC);
  assert.deepEqual(cell.sessions.map((row) => row.client), ['codex', 'kilo', 'lmstudio', 'dsh']);
  // Every row names its own tool, because this list mixes them.
  assert.deepEqual([...new Set(cell.sessions.map((row) => row.client))].sort(), ['codex', 'dsh', 'kilo', 'lmstudio']);
  // The rail's reading is derived from these rows at paint time rather than frozen
  // into the cell, so what the cell owes its renderer is the rows plus the moment
  // that reading changes (see the expiry test below).
  const summary = edgeDockPresentation.runningSessionSummary(cell.sessions);
  assert.equal(summary.count, 4);
  assert.deepEqual(summary.clients, ['codex', 'kilo', 'lmstudio', 'dsh']);
  assert.equal(summary.clientCount, 4);
  assert.equal(cell.runningExpiresAt > Date.now(), true);
});

// The standalone item repeats none of a provider card's job, so its two options
// have to change what it lists without changing what running means.
test('the sessions item honours runningOnly and groupBy without changing the run predicate', () => {
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 90 * 60_000).toISOString();
  const session = (client, id, lastUsedAt) => ({ client, sessionId: id, lastUsedAt, totalTokens: 10, models: { m: 10 } });
  const stats = {
    periods: {
      month: { sessions: {
        'codex:live': session('codex', 'live', nowIso),
        'kilo:quiet': session('kilo', 'quiet', oldIso),
        'dsh:live2': session('dsh', 'live2', nowIso)
      } },
      today: { sessions: {} }
    },
    limits: { providers: [] }
  };
  const build = (item) => buildEdgeDockCells(stats, { items: [item] })[0];

  // The timeline keeps the quiet row, and the running count is the same number
  // the rail shows, from one derivation.
  const timeline = build({ type: 'stat', metric: SESSIONS_METRIC });
  assert.deepEqual(timeline.sessions.map((row) => row.sessionId), ['live', 'live2', 'quiet']);
  assert.equal(edgeDockPresentation.runningSessionSummary(timeline.sessions).count, 2);
  assert.equal(timeline.runningOnly, false);
  assert.equal(timeline.groupBy, 'none');

  // runningOnly is a list filter, not a second definition of running: the quiet
  // row is gone and the counting is untouched.
  const onlyRunning = build({ type: 'stat', metric: SESSIONS_METRIC, runningOnly: true });
  assert.deepEqual(onlyRunning.sessions.map((row) => row.sessionId), ['live', 'live2']);
  assert.equal(edgeDockPresentation.runningSessionSummary(onlyRunning.sessions).count, 2);
  assert.equal(onlyRunning.runningOnly, true);

  // An empty running list is a real answer, not a missing one: still no rows.
  const quietStats = {
    periods: { month: { sessions: { 'codex:q': session('codex', 'q', oldIso) } }, today: { sessions: {} } },
    limits: { providers: [] }
  };
  const [empty] = buildEdgeDockCells(quietStats, { items: [{ type: 'stat', metric: SESSIONS_METRIC, runningOnly: true }] });
  assert.deepEqual(empty.sessions, []);
  assert.equal(edgeDockPresentation.runningSessionSummary(empty.sessions).count, 0);

  // groupBy is carried to the card, which is what draws one section per tool.
  const grouped = build({ type: 'stat', metric: SESSIONS_METRIC, groupBy: 'client' });
  assert.equal(grouped.groupBy, 'client');
});

// Running rows are selected ahead of quiet ones, but the list is still a timeline: it
// prints newest activity first. Composing the selection as running-then-quiet hoisted
// every running row above every quiet one, so a session active nine minutes ago was
// listed above one active a minute ago - and the grouped layout inherited that as its
// group order, since groups form from first appearance.
test('the timeline keeps newest-first order even when a quiet row is the newer one', () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const stats = {
    periods: {
      month: { sessions: {
        // Active a minute ago, but its turn ended: quiet, and the newer of the two.
        'codex:newer-quiet': { client: 'codex', sessionId: 'newer-quiet', lastUsedAt: iso(now - 60_000),
          totalTokens: 20, models: { m: 20 }, turnEnded: true },
        // Active nine minutes ago and still inside the running window: older, running.
        'kilo:older-running': { client: 'kilo', sessionId: 'older-running', lastUsedAt: iso(now - 9 * 60_000),
          totalTokens: 10, models: { m: 10 } }
      } },
      today: { sessions: {} }
    },
    limits: { providers: [] }
  };
  const [cell] = buildEdgeDockCells(stats, { items: [{ type: 'stat', metric: SESSIONS_METRIC }] });
  // The quiet one is newer, so it leads - the running row is not hoisted.
  assert.deepEqual(cell.sessions.map((row) => row.sessionId), ['newer-quiet', 'older-running']);
  assert.equal(cell.sessions[0].running, false);
  assert.equal(cell.sessions[1].running, true);
  // And the running reading itself is unchanged by the ordering: it counts, not sorts.
  assert.equal(edgeDockPresentation.runningSessionSummary(cell.sessions).count, 1);
  // The cap still prefers running rows: with room for one, the running row is kept even
  // though it is the older one, and it is printed at its own position in the timeline.
  const [capped] = buildEdgeDockCells(stats, { items: [{ type: 'stat', metric: SESSIONS_METRIC, runningOnly: true }] });
  assert.deepEqual(capped.sessions.map((row) => row.sessionId), ['older-running']);
  // A provider card keeps the running-first order it has always had. The timeline is the
  // Sessions item's own order, so the shared selection cannot hand it to both: the same
  // fixture through a provider card must come out the other way round.
  // Both rows belong to Codex here: a provider card only lists its own clients, so the
  // fixture above (one codex row, one kilo row) would leave it a single row to order.
  const codexOnly = {
    periods: {
      month: { sessions: {
        'codex:newer-quiet': stats.periods.month.sessions['codex:newer-quiet'],
        'codex:older-running': { ...stats.periods.month.sessions['kilo:older-running'], client: 'codex' }
      } },
      today: { sessions: {} }
    },
    limits: { providers: [{ provider: 'codex', status: 'ok', accountKey: 'k', windows: [] }] }
  };
  const [provider] = buildEdgeDockCells(codexOnly, { items: [{ type: 'limit', provider: 'codex' }] });
  assert.deepEqual(
    provider.sessions.map((row) => row.sessionId),
    ['older-running', 'newer-quiet'],
    'a provider card stays running-first'
  );
});

// A running-only card re-applies its filter as it paints, because the renderer repaints
// from the payload it holds the moment a running window expires - before the main
// process re-projects. Filtering only at projection time left a row that had just gone
// idle sitting in a card titled "only show running sessions", until the next push.
test('a running-only card drops a row the moment its window expires', () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const stats = {
    periods: {
      month: { sessions: {
        'codex:soon-quiet': { client: 'codex', sessionId: 'soon-quiet', lastUsedAt: iso(now - 9 * 60_000),
          totalTokens: 20, models: { m: 20 } }
      } },
      today: { sessions: {} }
    },
    limits: { providers: [] }
  };
  const [cell] = buildEdgeDockCells(stats, { items: [{ type: 'stat', metric: SESSIONS_METRIC, runningOnly: true }] });
  assert.equal(cell.runningOnly, true);
  assert.deepEqual(cell.sessions.map((row) => row.sessionId), ['soon-quiet']);
  // The projection carried it because it was running then; this is the payload the card
  // repaints from after the window passes, with no new push.
  const atExpiry = edgeDockPresentation.runningSessionSummary(cell.sessions, cell.runningExpiresAt).rows;
  assert.deepEqual(atExpiry, [], 'the window this cell reported is the one that empties it');
  // Re-applying the filter at paint time is what the card does with that.
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const card = dock.slice(dock.indexOf('function sessionsCard('), dock.indexOf('// Cards are built in a hidden staging layer'));
  assert.match(card, /const sessions = cell\.runningOnly === true \? running : pushed;/);
  // And the empty state it then renders is the running-only wording, not the generic one.
  assert.match(card, /cell\.runningOnly \? 'edgeDock\.sessionsNoneRunning' : 'edgeDock\.sessionsNone'/);
});

// The rail cell's third line is the item's own choice. Showing the live rate there
// must not disturb the card, and the sample has to ride the cell: the dock window
// holds no settings and no stats, so it cannot derive a rate for itself.
test('a sessions item can put the live rate on its rail cell instead of tool marks', () => {
  const nowIso = new Date().toISOString();
  const session = (client, id) => ({ client, sessionId: id, lastUsedAt: nowIso, totalTokens: 10, models: { m: 10 } });
  const stats = {
    periods: { month: { sessions: { 'codex:a': session('codex', 'a') } }, today: { sessions: {} } },
    limits: { providers: [] }
  };
  const liveRate = { speed: 184, burn: 11_040, deviceCount: 1, idle: false };
  const cells = (item, options) => buildEdgeDockCells(stats, { items: [item], liveRate, ...options });

  // Default: the cell names the working tools and carries no rate at all.
  const [marks] = cells({ type: 'stat', metric: SESSIONS_METRIC });
  assert.equal(marks.cellDetail, 'clients');
  assert.deepEqual(edgeDockPresentation.runningSessionSummary(marks.sessions).clients, ['codex']);
  assert.equal(marks.rate, null);

  // Opt-in: the same cell carries the sample, in the mode the item is in.
  const [rate] = cells({ type: 'stat', metric: SESSIONS_METRIC, cellDetail: 'rate' });
  assert.equal(rate.cellDetail, 'rate');
  assert.equal(rate.rate, 184);
  assert.equal(rate.rateMode, 'speed');
  assert.equal(rate.rateIdle, false);
  // The marks still ride the cell, because the card and the item's other
  // surfaces read the same projection; only which one the rail draws changes.
  assert.deepEqual(edgeDockPresentation.runningSessionSummary(rate.sessions).clients, ['codex']);

  // Burn mode reads the other figure, from the same sample.
  const [burn] = cells({ type: 'stat', metric: SESSIONS_METRIC, cellDetail: 'rate' }, { tokenRateMode: 'burn' });
  assert.equal(burn.rate, 11_040);
  assert.equal(burn.rateMode, 'burn');

  // No sample is an absence, not a zero: the cell draws its placeholder and
  // reports idle, rather than a confident 0 tok/s.
  const [none] = buildEdgeDockCells(stats, { items: [{ type: 'stat', metric: SESSIONS_METRIC, cellDetail: 'rate' }] });
  assert.equal(none.rate, null);
  assert.equal(none.rateIdle, true);

  // A plain sessions item keeps the old stored shape exactly: adding this option
  // must not rewrite what an existing item normalizes to beyond the new field.
  assert.deepEqual(normalizeEdgeDockItems([{ type: 'stat', metric: 'sessions' }])[0], {
    type: 'stat', metric: 'sessions', runningOnly: false, groupBy: 'none', cellDetail: 'clients'
  });
  assert.equal(normalizeEdgeDockItems([{ type: 'stat', metric: 'sessions', cellDetail: 'nope' }])[0].cellDetail, 'clients');
});

// Blocker: the projection dropped the archive flags, so a row that reads idle in
// the rail's own derivation came back running in the card, which re-derives state
// from the projected row. `sessionActivityState` reads those flags first, and its
// archived rule is absolute, so losing them is a predicate violation rather than a
// display difference. The old test only checked the projection's own boolean, which
// is exactly the reading the renderer does not use.
test('a projected session row keeps the archive flags the card re-derives state from', () => {
  const nowIso = new Date().toISOString();
  const base = { lastUsedAt: nowIso, totalTokens: 10, models: { 'gpt-5': 10 } };
  const stats = {
    periods: {
      month: { sessions: {
        // Fresh timestamp, no turnEnded: running by time alone, and idle only
        // because it is archived.
        'codex:arch': { client: 'codex', sessionId: 'arch', ...base, archived: true },
        'codex:gone': { client: 'codex', sessionId: 'gone', ...base, deleted: true },
        'codex:src': { client: 'codex', sessionId: 'src', ...base, sourceDeleted: true },
        'codex:live': { client: 'codex', sessionId: 'live', ...base }
      } },
      today: { sessions: {} }
    },
    limits: { providers: [] }
  };
  const [cell] = buildEdgeDockCells(stats, { items: [{ type: 'stat', metric: SESSIONS_METRIC }] });
  const byId = new Map(cell.sessions.map((row) => [row.sessionId, row]));
  // The projection's own reading is 1 running, and the renderer must agree with it
  // on every single row - the disagreements were the bug.
  assert.equal(cell.sessions.filter((row) => row.running).length, 1);
  for (const id of ['arch', 'gone', 'src']) {
    assert.equal(sessionLive.sessionActivityState(byId.get(id)), 'idle', `${id} must stay idle after projection`);
  }
  assert.equal(sessionLive.sessionActivityState(byId.get('live')), 'running');
  // All three flags ride the row: the predicate reads three separate fields, so
  // carrying one alias would leave the other two able to resurrect a session.
  assert.deepEqual(
    [byId.get('arch').archived, byId.get('gone').deleted, byId.get('src').sourceDeleted],
    [true, true, true]
  );
  assert.deepEqual(
    [byId.get('live').archived, byId.get('live').deleted, byId.get('live').sourceDeleted],
    [false, false, false]
  );
  // And the shared summary the rail draws from must agree with the projection too.
  assert.equal(edgeDockPresentation.runningSessionSummary(cell.sessions).count, 1);
});

// Blocker: running expires on a clock, so a count frozen at projection time goes
// stale on a rail that nothing re-projects - the cell would claim a running session
// and the card it opened would show none. These lock the two halves: the reading is
// derived at the clock it is asked about, and the cell says when it must be asked
// again.
test('a sessions cell re-derives running at the clock it is asked, and reports when that changes', () => {
  const { RUNNING_WINDOW_MS } = sessionLive;
  // A real clock, not a fixed date: `buildEdgeDockCells()` computes
  // `runningExpiresAt` from `Date.now()`, so pinning the sessions to an absolute
  // timestamp made this test pass only until the wall clock reached that date.
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const stats = {
    periods: {
      month: { sessions: {
        'codex:a': { client: 'codex', sessionId: 'a', lastUsedAt: iso(now - 60_000), totalTokens: 10, models: { m: 10 } },
        'codex:b': { client: 'codex', sessionId: 'b', lastUsedAt: iso(now - 9 * 60_000), totalTokens: 10, models: { m: 10 } }
      } },
      today: { sessions: {} }
    },
    limits: { providers: [] }
  };
  const [cell] = buildEdgeDockCells(stats, { items: [{ type: 'stat', metric: SESSIONS_METRIC }] });
  // Both were inside the window when the cell was built.
  assert.equal(edgeDockPresentation.runningSessionSummary(cell.sessions, now).count, 2);
  assert.deepEqual(edgeDockPresentation.runningSessionSummary(cell.sessions, now).clients, ['codex']);
  // `b` expires first, one minute before `a`. The expiry is the first millisecond at
  // which the row is NOT running, so the inclusive predicate's boundary (`last +
  // window`, still running) is one millisecond before it.
  const bBoundary = Date.parse(iso(now - 9 * 60_000)) + RUNNING_WINDOW_MS;
  assert.equal(cell.runningExpiresAt, bBoundary + 1);
  assert.equal(sessionLive.sessionActivityState(cell.sessions.find((row) => row.sessionId === 'b'), bBoundary), 'running');
  assert.equal(sessionLive.sessionActivityState(cell.sessions.find((row) => row.sessionId === 'b'), bBoundary + 1), 'idle');
  // So a scheduler that wakes exactly at the reported moment sees the drop, which is
  // the whole point of reporting it: waking at the boundary itself would re-project a
  // cell that still counts the row.
  assert.equal(edgeDockPresentation.runningSessionSummary(cell.sessions, cell.runningExpiresAt).count, 1);
  assert.equal(edgeDockPresentation.runningSessionSummary(cell.sessions, bBoundary).count, 2);
  // Past both they read none, which is the state the rail has to stop contradicting.
  const afterAll = now + RUNNING_WINDOW_MS;
  assert.equal(edgeDockPresentation.runningSessionSummary(cell.sessions, afterAll).count, 0);
  assert.equal(cell.runningExpiresAt <= afterAll, true);
  // Nothing running is 0 rather than a time, so a scheduler reading it cannot arm a
  // timer for a row that can only get quieter.
  const [quiet] = buildEdgeDockCells({
    // Relative to the real clock the projection reads, not to this test's fixed
    // `now`: `runningExpiresAt` is computed at projection time.
    periods: { month: { sessions: { 'codex:q': { client: 'codex', sessionId: 'q', lastUsedAt: new Date(Date.now() - RUNNING_WINDOW_MS - 1).toISOString(), totalTokens: 5, models: { m: 5 } } } }, today: { sessions: {} } },
    limits: { providers: [] }
  }, { items: [{ type: 'stat', metric: SESSIONS_METRIC }] });
  assert.equal(quiet.runningExpiresAt, 0);
  assert.equal(edgeDockPresentation.runningSessionSummary(quiet.sessions).count, 0);
});

// The expiry a cell reports has to be the first millisecond at which the row is NOT
// running. Reporting the inclusive boundary (`last + window`, still running) let a
// stats push land on exactly that millisecond, re-project a cell that still counted
// the row, and carry no next expiry for it - so the reading stuck until the next real
// push, which in running-only mode is a row that should not be there.
test('a reported expiry is the first millisecond the row is not running', () => {
  const { RUNNING_WINDOW_MS } = sessionLive;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const last = now - 9 * 60_000;
  const stats = {
    periods: {
      month: { sessions: { 'codex:x': { client: 'codex', sessionId: 'x', lastUsedAt: iso(last), totalTokens: 5, models: { m: 5 } } } },
      today: { sessions: {} }
    },
    limits: { providers: [] }
  };
  const [cell] = buildEdgeDockCells(stats, { items: [{ type: 'stat', metric: SESSIONS_METRIC }] });
  const boundary = last + RUNNING_WINDOW_MS;
  const row = cell.sessions[0];
  // The predicate is inclusive at the boundary, so that instant still counts.
  assert.equal(sessionLive.sessionActivityState(row, boundary), 'running');
  assert.equal(sessionLive.sessionActivityState(row, boundary + 1), 'idle');
  // And the reported expiry is the other side of it, so waking there sees the drop.
  assert.equal(cell.runningExpiresAt, boundary + 1);
  assert.equal(edgeDockPresentation.runningSessionSummary(cell.sessions, cell.runningExpiresAt).count, 0);
  assert.equal(edgeDockPresentation.runningSessionSummary(cell.sessions, cell.runningExpiresAt - 1).count, 1);
});

// The client mark is a mask-painted span with no text, so the tool it names is
// invisible to assistive technology. The mixed list is exactly where that matters:
// naming the tool is the feature's whole point, and a screen reader saw only the
// session title. Asserted on the source, since the marks are painted in Electron.
test('the sessions rail and mixed rows name their tools for assistive technology', () => {
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  // The rail cell's accessible name is built from the same summary the marks are
  // drawn from, so the spoken tools and the drawn ones cannot disagree - and read
  // from the rows rather than a frozen field, so it ages with them.
  const statCell = dock.slice(dock.indexOf('function statCellNode('), dock.indexOf('let railNode = null;'));
  assert.match(statCell, /runningSessionSummary\(cell\.sessions\)\.clients\.map\(\(client\) => clientLabel\(client\)\)/);
  assert.match(statCell, /node\.setAttribute\('aria-label', spoken\)/);
  // A mixed row states its own client in text, and does so only when it draws the
  // mark: a provider card's rows are all one client and the card header names it.
  const container = dock.slice(dock.indexOf('function sessionsContainer('), dock.indexOf('function providerCard('));
  assert.match(container, /nameNode\.append\(el\('span', 'sr-only', `\$\{clientLabel\(session\.client\)\} `\)\)/);
  assert.match(container, /if \(options\.showClientMark && session\.client\) \{/);
  // The label is the client's own display name, not its raw id.
  assert.doesNotMatch(container, /sr-only', `\$\{session\.client\}/);
});

// The tooltip was wrong twice over: its wording belonged to the live-rate item, whose
// readout really does toggle on click, and a `title` needs the pointer to rest while
// hovering this cell opens a card after 70ms. It is gone, and the toggle wording stays
// with the readout that toggles.
test('the sessions rate line carries no unreachable tooltip', () => {
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const controller = fs.readFileSync(path.join(rendererDir, '..', 'edgeDock', 'controller.js'), 'utf8');
  const rateNode = dock.slice(dock.indexOf('function cellRateNode('), dock.indexOf('// The tools with a session running'));
  // No tooltip at all on this line. A `title` needs the pointer to rest, but hovering
  // this cell opens its card after bubbleDelayMs (70ms in EDGE_DOCK_TIMING), so a
  // tooltip here is unreachable - and the wording it would carry belongs to the
  // live-rate item, whose readout really does toggle while this cell opens its card.
  assert.doesNotMatch(rateNode, /node\.title =/);
  assert.doesNotMatch(rateNode, /edgeDock\.rate\.(switch|reading)/);
  // The toggle wording is still used by the cell that really does toggle, so this
  // is a scoping fix rather than a removal of the affordance.
  const liveRateCard = dock.slice(dock.indexOf('function appendLiveRate('), dock.indexOf('function statCard('));
  assert.match(liveRateCard, /t\('edgeDock\.rate\.switch'\)/);
  const toggle = controller.slice(controller.indexOf("ipcMain.on('edgeDock:click'"), controller.indexOf("ipcMain.on('edgeDock:dragStart'"));
  assert.match(toggle, /metric === 'liveRate'/);
  assert.doesNotMatch(toggle, /cellDetail/);
  // And the retired key is gone from every locale rather than left as dead copy.
  const i18n = readRendererFile('i18n.js');
  assert.doesNotMatch(i18n, /'edgeDock\.rate\.reading'/);
});

// A repaint rebuilds the card and restores the scroll of the container that scrolls.
// That container differs by card: a provider card and the grouped Sessions card use
// `.edge-dock-accounts`, while the ungrouped Sessions card's list is
// `.edge-dock-session-list` - and that is the one which overflows there, because running
// rows are never capped. Reading only the first selector meant every clock repaint of
// that card reset it to the top, mid-read.
test('a repainted card restores the scroll container it actually uses', () => {
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const css = readRendererFile(path.join('edgeDock', 'dock.css'));
  const commit = dock.slice(dock.indexOf('function commitCard('), dock.indexOf('function renderBubble('));
  assert.match(commit, /querySelector\(CARD_SCROLL_SELECTOR\)/);
  assert.match(commit, /list\.scrollTop = scrollTop;/);
  // Both containers are named, read from the declaration so a third cannot be added to
  // the card without this failing.
  const declaration = dock.match(/const CARD_SCROLL_SELECTOR = '([^']+)';/);
  assert.ok(declaration, 'the scroll containers are declared once');
  const selectors = declaration[1].split(',').map((part) => part.trim());
  assert.deepEqual(selectors, ['.edge-dock-accounts', '.edge-dock-session-list']);
  // And each really scrolls, which is why it has to be restored.
  for (const selector of selectors) {
    // Plain string search: these selectors carry a leading dot and a hyphen, and
    // escaping them into a RegExp literal inside this file is what broke the first
    // version of this assertion.
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, `${selector} should be styled`);
    const body = css.slice(start, css.indexOf('}', start));
    assert.match(body, /overflow-y: auto;/, `${selector} should be the scrolling element`);
  }
});

// The self-repaint scheduler replaced the card's fixed 30s interval, and its first
// shape changed behaviour it had no business touching: the card fell back to 60s (a
// regression against the period reset countdowns are drawn at) and the rail, which was
// push-driven, started rebuilding its children every minute for nothing. Per surface,
// because the two wake for different reasons.
test('the self-repaint cadence matches what each surface actually needs', () => {
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const period = dock.slice(dock.indexOf('const BUBBLE_REPAINT_MS'), dock.indexOf('function repaintSelf('));
  // The card keeps the 30s it always had.
  assert.match(period, /const BUBBLE_REPAINT_MS = 30_000;/);
  assert.match(period, /const period = surface === 'bubble' \? BUBBLE_REPAINT_MS : 0;/);
  // A rail only wakes for a sessions expiry, and reports 0 when there is none - which
  // is what leaves its timer unarmed rather than polling it.
  assert.match(period, /if \(!surfacesShowingSessions\(\)\) return 0;/);
  assert.match(period, /if \(!soonest\) return 0;/);
  assert.match(period, /return waits\.length \? Math\.min\(\.\.\.waits\) : 0;/);
  // An expiry may shorten a wait but never lower the period after it: the shortest of
  // the two applies to this one wake only, and the timer re-arms from a fresh read.
  // Sliced to the end of the function body rather than to the first call of it, which
  // is the recursive one inside and cut the slice before the lines under test.
  const scheduler = dock.slice(dock.indexOf('function scheduleSelfRepaint('), dock.indexOf('bridge.ready();'));
  assert.match(scheduler, /if \(!delay\) return;/);
  assert.match(scheduler, /repaintSelf\(\);/);
  assert.match(scheduler, /scheduleSelfRepaint\(\);/);
  // The old fixed interval is gone, so nothing repaints a surface on a blind period.
  assert.doesNotMatch(dock, /setInterval\(/);
});

// The wait has to be recomputed from the rows, not read off the cell. `runningExpiresAt`
// describes the payload as it was projected and a repaint does not re-project, so once
// the soonest expiry passed that field stayed in the past: the surface woke once and then
// stopped, and a second session's expiry never fired. Measured on the real renderer
// before the fix - two sessions expiring at 2s and 6s produced one repaint in eight
// seconds and left the cell claiming a session that had gone quiet.
test('the session wait is recomputed from the rows so every expiry wakes the surface', () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const stats = {
    periods: {
      month: { sessions: {
        'codex:a': { client: 'codex', sessionId: 'a', lastUsedAt: iso(now - 60_000), totalTokens: 10, models: { m: 10 } },
        'kilo:b': { client: 'kilo', sessionId: 'b', lastUsedAt: iso(now - 5 * 60_000), totalTokens: 10, models: { m: 10 } }
      } },
      today: { sessions: {} }
    },
    limits: { providers: [] }
  };
  const [cell] = buildEdgeDockCells(stats, { items: [{ type: 'stat', metric: SESSIONS_METRIC }] });
  // The cell reports the first expiry, which is what the surface wakes on...
  assert.equal(cell.runningExpiresAt, edgeDockPresentation.nextRunningExpiryAt(cell.sessions, now));
  // ...and asking the same rows again after it passes answers with the second one, which
  // reading the cell's own field could not do.
  const second = edgeDockPresentation.nextRunningExpiryAt(cell.sessions, cell.runningExpiresAt + 1);
  assert.ok(second > cell.runningExpiresAt, 'a later expiry should be found after the first passes');
  assert.equal(edgeDockPresentation.runningSessionSummary(cell.sessions, cell.runningExpiresAt + 1).count, 1);
  // And the scheduler asks the rows, not the cell.
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const scheduler = dock.slice(dock.indexOf('function sessionsExpiryDelayMs('), dock.indexOf('function repaintSelf('));
  assert.match(scheduler, /presentation\.nextRunningExpiryAt\(cell\.sessions, now\)/);
  assert.doesNotMatch(scheduler, /cell\.runningExpiresAt/);
});

// The flare cache keeps one entry per session it has seen, so a long-lived card has
// to prune it against the whole list. Pruning per group would delete every other
// group's entries, which is why this asserts the call sits in sessionsCard().
test('the standalone sessions card prunes the activity cache against its whole list', () => {
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const card = dock.slice(dock.indexOf('function sessionsCard('), dock.indexOf('// Cards are built in a hidden staging layer'));
  // The grouped branch is the leak: it renders one section per tool, so the prune
  // must happen before the split rather than inside it.
  const beforeSplit = card.slice(0, card.indexOf('const groups = new Map()'));
  // Pruned against everything the card was handed rather than the list it will draw: a
  // row that is merely quiet keeps its flare entry, so it flares on its next write
  // instead of being treated as newly seen when it starts running again.
  assert.match(card, /pruneActivity\(pushed\);/);
  assert.doesNotMatch(card, /pruneActivity\(rows\);/);
  assert.match(beforeSplit, /pruneActivity\(pushed\);/);
});

// The main process only keeps the live-rate tracker alive for items that show a
// rate. A sessions item in rate mode is one of those, and missing it left the cell
// permanently blank - the cell existed but nothing ever computed its sample.
test('the live-rate tracker is kept alive by a rate-mode sessions item', () => {
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const gate = main.slice(main.indexOf('function edgeDockShowsLiveRate()'), main.indexOf('function edgeDockLiveRateSample('));
  assert.match(gate, /item\.metric === 'liveRate'/);
  assert.match(gate, /item\.metric === 'sessions' && item\.cellDetail === 'rate'/);
});

// The cell already prints one number above this line (the running count), so a
// stacked figure-over-unit made the rate read as a second, unrelated number. The
// unit has to sit on the same line as the figure it belongs to.
test('the rail cell rate is one line at one size, below the count it sits under', () => {
  const css = readRendererFile(path.join('edgeDock', 'dock.css'));
  const row = css.match(/\.edge-dock-cell-rate \{([^}]*)\}/);
  assert.ok(row, 'the rate row should be styled');
  assert.match(row[1], /display: flex;/);
  assert.match(row[1], /align-items: baseline;/);
  assert.doesNotMatch(row[1], /display: grid;/);
  assert.doesNotMatch(row[1], /flex-direction: column;/);
  assert.match(row[1], /font-family: var\(--display-font/);
  const value = css.match(/\.edge-dock-cell-rate-value \{([^}]*)\}/);
  assert.ok(value, 'the rate figure should be styled');
  assert.match(value[1], /font-weight: 650;/);
  const unit = css.match(/\.edge-dock-cell-rate-unit \{([^}]*)\}/);
  assert.ok(unit, 'the rate unit should be styled');
  // The figure and its unit share ONE size, and neither may reintroduce a size of its
  // own. That is the reading this line is for: it sits under the running count, so a
  // larger figure reads as a second headline beside that count rather than as the
  // reading under it. The live-rate cell below is the opposite case and keeps its own
  // larger number, which is why this is asserted as sameness rather than a value.
  const size = row[1].match(/font-size: ([\d.]+px);/);
  assert.ok(size, 'the rate row owns the size both parts share');
  assert.doesNotMatch(value[1], /font-size:/);
  assert.doesNotMatch(unit[1], /font-size:/);
  // The unit still carries the hierarchy the size no longer does.
  // The unit IS the live-rate cell's label treatment, because it names the same unit
  // for the same measurement: same size, weight and colour as that cell's `tok/s`.
  // Read from that cell's own rule so this is an agreement rather than a value typed
  // twice - the failure this replaced was the unit being restyled in passing.
  const liveLabel = css.match(/\.edge-dock-stat-label \{([^}]*)\}/);
  assert.ok(liveLabel, 'the live-rate cell keeps its own label style');
  // Size lives on the row (both parts inherit it); weight and colour are the unit's
  // own. Compared property by property against the label's declarations.
  const liveSize = liveLabel[1].match(/font-size: ([^;]+);/)[1];
  assert.equal(size[1], liveSize, 'the rate line should use the live-rate label size');
  for (const property of ['font-weight', 'color']) {
    const expected = liveLabel[1].match(new RegExp(`${property}: ([^;]+);`))[1];
    assert.ok(
      new RegExp(`${property}: ${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`).test(unit[1]),
      `the rate unit should keep the live-rate label's ${property} (${expected})`
    );
  }
  // And the live-rate cell keeps its own scale: it is the headline of its cell, so the
  // two must not be pulled to one number.
  const liveValue = css.match(/\.edge-dock-stat-value \{([^}]*)\}/);
  assert.ok(liveValue, 'the live-rate cell keeps its own type scale');
  const liveFigureSize = liveValue[1].match(/font-size: ([\d.]+px);/);
  assert.ok(liveFigureSize, 'the live-rate figure is sized');
  assert.notEqual(liveFigureSize[1], size[1]);
});

// A stored item round-trips through its own normalizer, or the choice the user
// made in the composer is silently reset the next time the dock is rebuilt.
test('a sessions item normalizes its options and defaults them off', () => {
  const item = (raw) => normalizeEdgeDockItems([{ type: 'stat', metric: 'sessions', ...raw }])[0];
  assert.deepEqual(item({}), { type: 'stat', metric: 'sessions', runningOnly: false, groupBy: 'none', cellDetail: 'clients' });
  assert.deepEqual(item({ runningOnly: true, groupBy: 'client', cellDetail: 'rate' }), {
    type: 'stat', metric: 'sessions', runningOnly: true, groupBy: 'client', cellDetail: 'rate'
  });
  // Unknown values fall back rather than surviving into the renderer.
  assert.deepEqual(item({ runningOnly: 'yes', groupBy: 'provider', cellDetail: 'maybe' }), {
    type: 'stat', metric: 'sessions', runningOnly: false, groupBy: 'none', cellDetail: 'clients'
  });
  // Every other stat metric stays exactly as it was: no options are invented.
  assert.deepEqual(normalizeEdgeDockItems([{ type: 'stat', metric: 'today' }])[0], { type: 'stat', metric: 'today' });
});

test('edge dock is opt-in and limited to macOS and Windows', () => {
  assert.equal(canUseEdgeDock({}, 'darwin'), false);
  assert.equal(canUseEdgeDock({ edgeDockEnabled: true }, 'darwin'), true);
  assert.equal(canUseEdgeDock({ edgeDockEnabled: true }, 'win32'), true);
  assert.equal(canUseEdgeDock({ edgeDockEnabled: true }, 'linux'), false);
});

test('placement settings normalize to a known side and a 0..1 offset', () => {
  assert.equal(normalizeEdgeDockSide('left'), 'left');
  assert.equal(normalizeEdgeDockSide('top'), 'right');
  assert.equal(normalizeEdgeDockOffset(null), 0.3);
  assert.equal(normalizeEdgeDockOffset('0.5'), 0.5);
  assert.equal(normalizeEdgeDockOffset(4), 1);
  assert.equal(normalizeEdgeDockOffset(-1), 0);
  assert.equal(normalizeEdgeDockDisplayId(null), null);
  assert.equal(normalizeEdgeDockDisplayId(42), '42');
  assert.equal(normalizeEdgeDockDisplayId('  secondary  '), 'secondary');
});

test('rail hugs the chosen edge and its peek handle is flush with it', () => {
  const right = edgeDockRailBounds({ workArea, side: 'right', offset: 0, cellCount: 3 });
  assert.equal(right.x + right.width + EDGE_DOCK_METRICS.edgeInset, workArea.width);
  assert.equal(right.y, workArea.y + EDGE_DOCK_METRICS.screenMargin);
  assert.equal(right.height, railLength(3));
  const peek = edgeDockPeekBounds({ workArea, side: 'right', railBounds: right });
  assert.equal(peek.x + peek.width, workArea.width);

  const left = edgeDockRailBounds({ workArea, side: 'left', offset: 1, cellCount: 3 });
  assert.equal(left.x, EDGE_DOCK_METRICS.edgeInset);
  assert.equal(left.y + left.height, workArea.y + workArea.height - EDGE_DOCK_METRICS.screenMargin);
  assert.equal(edgeDockPeekBounds({ workArea, side: 'left', railBounds: left }).x, 0);
});

test('trigger strip reaches the physical display edge past a side Dock', () => {
  const narrowed = { x: 0, y: 25, width: 1380, height: 875 };
  const rail = edgeDockRailBounds({ workArea: narrowed, side: 'right', offset: 0.5, cellCount: 2 });
  const trigger = edgeDockTriggerBounds({ workArea: narrowed, displayBounds, side: 'right', railBounds: rail });
  assert.equal(trigger.x, 1380 - EDGE_DOCK_METRICS.triggerDepth);
  assert.equal(trigger.x + trigger.width, 1440);
  assert.equal(trigger.y, rail.y);
  assert.equal(trigger.height, rail.height);
});

test('cursor resolves to the cell under it, including the gap below a cell', () => {
  const rail = edgeDockRailBounds({ workArea, side: 'right', offset: 0, cellCount: 3 });
  const { shoulder, padding, cellHeight, cellGap } = EDGE_DOCK_METRICS;
  const top = shoulder + padding;
  const at = (dy) => edgeDockCellAt({ x: rail.x + 10, y: rail.y + dy }, rail, 3);
  // The shoulders belong to the rail window but hold no cell.
  assert.equal(at(shoulder / 2), null);
  assert.equal(at(top - 1), null);
  assert.equal(at(top + 1), 0);
  assert.equal(at(top + cellHeight + cellGap / 2), 0);
  assert.equal(at(top + cellHeight + cellGap + 1), 1);
  assert.equal(edgeDockCellAt({ x: rail.x - 1, y: rail.y + top + 1 }, rail, 3), null);
});

test('only the column around the marks is a hover target, not the screen edge', () => {
  const rail = edgeDockRailBounds({ workArea, side: 'right', offset: 0, cellCount: 2 });
  const y = rail.y + EDGE_DOCK_METRICS.shoulder + EDGE_DOCK_METRICS.padding + 20;
  const centerX = rail.x + rail.width / 2;
  assert.equal(edgeDockCellAt({ x: centerX, y }, rail, 2), 0);
  assert.equal(edgeDockCellAt({ x: centerX + EDGE_DOCK_METRICS.hitRadius, y }, rail, 2), 0);
  assert.equal(edgeDockCellAt({ x: rail.x + rail.width - 1, y }, rail, 2), null);
});

test('the leave corridor is only the gap between card and rail, not their bounding box', () => {
  const rail = { x: 1376, y: 100, width: 64, height: 700 };
  const bubble = { x: 1080, y: 120, width: 292, height: 200 };
  const corridor = edgeDockCorridorBounds(rail, bubble);
  assert.deepEqual(corridor, { x: 1366, y: 120, width: 16, height: 200 });
  // A point below the card and left of the rail is outside, not "between".
  const below = { x: 1200, y: 600 };
  assert.equal(below.x >= corridor.x && below.x < corridor.x + corridor.width && below.y >= corridor.y && below.y < corridor.y + corridor.height, false);
  const left = edgeDockCorridorBounds({ x: 0, y: 0, width: 64, height: 700 }, { x: 68, y: 50, width: 292, height: 100 });
  assert.deepEqual(left, { x: 58, y: 50, width: 16, height: 100 });
});

test('stat readouts are shorter than rings and the layout compresses before overflowing', () => {
  const m = EDGE_DOCK_METRICS;
  const mixed = edgeDockCellLayout(workArea, ['stat', 'provider']);
  assert.deepEqual(mixed.heights, [m.statHeight, m.cellHeight]);
  assert.equal(mixed.tops[1], m.shoulder + m.padding + m.statHeight + m.cellGap);
  const rail = edgeDockRailBounds({ workArea, side: 'right', offset: 0, cellKinds: ['stat', 'provider'] });
  assert.equal(edgeDockCellAt({ x: rail.x + 32, y: rail.y + mixed.tops[1] + 5 }, rail, 2), 1);
  const crowded = edgeDockCellLayout(workArea, Array.from({ length: 14 }, () => 'provider'));
  assert.equal(crowded.compact, true);
  assert.equal(crowded.heights[0], m.minCellHeight);
});

test('an explicit empty cell list keeps the rail empty instead of reserving a cell', () => {
  const empty = edgeDockCellLayout(workArea, []);
  assert.deepEqual(empty.kinds, []);
  assert.deepEqual(empty.tops, []);
  // Only the chrome above and below the cells remains.
  assert.equal(empty.length, EDGE_DOCK_METRICS.shoulder * 2 + EDGE_DOCK_METRICS.padding * 2);
  const rail = edgeDockRailBounds({ workArea, side: 'right', offset: 0, cellKinds: [] });
  assert.equal(rail.cells.kinds.length, 0);
  assert.equal(rail.height, empty.length);
  // A count fallback still synthesizes providers when no list is supplied.
  assert.equal(edgeDockCellLayout(workArea, null).kinds.length, 1);
});

test('intent: always-visible mode reveals once and only lets the card go', () => {
  const intent = createEdgeDockIntent();
  assert.deepEqual(intent.setAlways(true), [{ type: 'reveal' }]);
  intent.focusCell(1);
  assert.deepEqual(intent.tick({}, 0), []);
  assert.deepEqual(intent.tick({}, EDGE_DOCK_TIMING.hideDelayMs), [{ type: 'bubble', cell: null }]);
  assert.deepEqual(intent.tick({}, 60_000), []);
  assert.equal(intent.snapshot().revealed, true);
  assert.deepEqual(intent.retract(), []);
  assert.equal(intent.snapshot().revealed, true);
});

test('bubble opens inward with its tail aimed at the cell, even when clamped', () => {
  const m = EDGE_DOCK_METRICS;
  const rail = edgeDockRailBounds({ workArea, side: 'right', offset: 0.5, cellCount: 3 });
  const bubble = edgeDockBubbleBounds({ railBounds: rail, cellIndex: 1, height: 120, workArea, side: 'right' });
  assert.equal(bubble.width, m.bubbleWidth + m.bubbleTail);
  assert.equal(bubble.x + bubble.width + m.bubbleGap, rail.x);
  const cellCenter = rail.y + m.shoulder + m.padding + m.cellHeight + m.cellGap + m.cellHeight / 2;
  assert.equal(bubble.y + bubble.height / 2, cellCenter);
  assert.equal(bubble.y + bubble.tailY, cellCenter);

  const top = edgeDockRailBounds({ workArea, side: 'left', offset: 0, cellCount: 3 });
  const tall = edgeDockBubbleBounds({ railBounds: top, cellIndex: 0, height: 600, workArea, side: 'left' });
  assert.equal(tall.x, top.x + top.width + m.bubbleGap);
  assert.equal(tall.y, workArea.y + m.screenMargin);
  assert.equal(tall.y + tall.tailY, top.y + m.shoulder + m.padding + m.cellHeight / 2);
});

test('rail silhouette starts and ends on the screen edge and mirrors for the left', () => {
  const right = railCommands({ width: 64, height: 300, side: 'right', shoulder: 28, radius: 20 });
  assert.deepEqual(right[0], ['M', 64, 0]);
  assert.deepEqual(right.at(-2).slice(-2), [64, 300]);
  assert.deepEqual(right.at(-1), ['Z']);
  // The open outline never strokes along the display edge.
  assert.notDeepEqual(railCommands({ width: 64, height: 300, shoulder: 28, radius: 20, open: true }).at(-1), ['Z']);
  const left = railCommands({ width: 64, height: 300, side: 'left', shoulder: 28, radius: 20 });
  assert.deepEqual(left[0], ['M', 0, 0]);
  assert.match(toSvgPath(right), /^M64 0 C/);
});

test('bubble tail tip lands on tailY and stays clear of the corners', () => {
  const tip = (commands) => commands.find(([op, ...p]) => op === 'C' && p[4] === 291);
  const right = bubbleCommands({ width: 292, height: 160, side: 'right', tail: 12, tailY: 90, neck: 18, radius: 18 });
  assert.equal(tip(right)[6], 90);
  const clamped = bubbleCommands({ width: 292, height: 160, side: 'right', tail: 12, tailY: 2, neck: 18, radius: 18 });
  assert.equal(tip(clamped)[6], 36);
  const left = bubbleCommands({ width: 292, height: 160, side: 'left', tail: 12, tailY: 90, neck: 18, radius: 18 });
  assert.ok(left.some(([op, ...p]) => op === 'C' && p[4] === 1 && p[5] === 90));
});

test('mask rasterizes the silhouette with soft edges and empty outside corners', () => {
  const commands = railCommands({ width: 64, height: 200, side: 'right', shoulder: 28, radius: 20 });
  const { buffer, pixelWidth, pixelHeight } = rasterizeMask(toPolygons(commands), 64, 200, 2);
  assert.equal(pixelWidth, 128);
  assert.equal(pixelHeight, 400);
  const alpha = (x, y) => buffer[(y * pixelWidth + x) * 4 + 3];
  assert.equal(alpha(64, 200), 255);  // body
  assert.equal(alpha(2, 2), 0);       // above the top shoulder, away from the edge
  assert.equal(alpha(127, 30), 255);  // the shoulder widens into the screen edge
  // The shoulder's curved boundary is anti-aliased rather than stair-stepped.
  const row = Array.from({ length: pixelWidth }, (_, x) => alpha(x, 30));
  assert.ok(row.some((value) => value > 0 && value < 255));
});

test('Windows shape regions follow the silhouette without one rectangle per pixel', () => {
  const commands = railCommands({ width: 64, height: 200, side: 'right', shoulder: 28, radius: 20 });
  const rects = shapeRectsFromPolygons(toPolygons(commands), 64, 200);
  assert.ok(rects.length > 1);
  assert.ok(rects.length < 100);
  assert.ok(rects.every((rect) => rect.width > 0 && rect.height > 0));
  assert.ok(rects.some((rect) => rect.x > 0), 'the outer corner remains outside the native region');
  assert.ok(rects.some((rect) => rect.x + rect.width === 64), 'the region still reaches the screen edge');
});

test('dropping a dragged rail picks the nearer side and a normalized offset', () => {
  const placement = edgeDockPlacementForDrop({ workArea, pointer: { x: 100, y: 500 }, grabOffsetY: 30, cellCount: 2 });
  assert.equal(placement.side, 'left');
  assert.ok(placement.offset > 0 && placement.offset < 1);
  const back = edgeDockRailBounds({ workArea, side: placement.side, offset: placement.offset, cellCount: 2 });
  assert.ok(Math.abs(back.y - 470) <= 1);
  assert.equal(edgeDockPlacementForDrop({ workArea, pointer: { x: 1400, y: 0 }, grabOffsetY: 0, cellCount: 2 }).offset, 0);
});

test('intent: a brief touch of the edge does not reveal; a dwell does', () => {
  const intent = createEdgeDockIntent();
  assert.deepEqual(intent.tick({ inTrigger: true }, 0), []);
  assert.deepEqual(intent.tick({}, 50), []);
  assert.deepEqual(intent.tick({ inTrigger: true }, 100), []);
  assert.deepEqual(intent.tick({ inTrigger: true }, 100 + EDGE_DOCK_TIMING.revealDelayMs), [{ type: 'reveal' }]);
});

test('intent: hovering a cell opens its card after a delay, then switches instantly', () => {
  const intent = createEdgeDockIntent();
  intent.reveal();
  assert.deepEqual(intent.tick({ inRail: true, cellIndex: 0 }, 0), []);
  assert.deepEqual(intent.tick({ inRail: true, cellIndex: 0 }, EDGE_DOCK_TIMING.bubbleDelayMs), [{ type: 'bubble', cell: 0 }]);
  assert.deepEqual(intent.tick({ inRail: true, cellIndex: 1 }, EDGE_DOCK_TIMING.bubbleDelayMs + 10), [{ type: 'bubble', cell: 1 }]);
  // Moving into the card keeps it open.
  assert.deepEqual(intent.tick({ inBubble: true }, 1000), []);
});

test('intent: leaving retracts after the grace period unless pinned', () => {
  const intent = createEdgeDockIntent();
  intent.reveal();
  intent.tick({ inRail: true, cellIndex: 0 }, 0);
  intent.tick({ inRail: true, cellIndex: 0 }, EDGE_DOCK_TIMING.bubbleDelayMs);
  assert.deepEqual(intent.tick({}, 200), []);
  assert.deepEqual(intent.tick({ inCorridor: true }, 300), []);
  assert.deepEqual(intent.tick({}, 400), []);
  assert.deepEqual(
    intent.tick({}, 400 + EDGE_DOCK_TIMING.hideDelayMs),
    [{ type: 'bubble', cell: null }, { type: 'retract' }]
  );

  const pinned = createEdgeDockIntent();
  pinned.reveal({ pinned: true });
  pinned.focusCell(0);
  assert.deepEqual(pinned.tick({}, 0), []);
  // The pin keeps the rail but lets the card go once the pointer has left.
  assert.deepEqual(pinned.tick({}, EDGE_DOCK_TIMING.hideDelayMs), [{ type: 'bubble', cell: null }]);
  assert.equal(pinned.snapshot().revealed, true);
  assert.deepEqual(pinned.togglePin(), []);
  assert.deepEqual(pinned.tick({}, 5000), []);
  assert.deepEqual(pinned.tick({}, 5000 + EDGE_DOCK_TIMING.hideDelayMs), [{ type: 'retract' }]);
});

test('intent: a drag never retracts and a shrinking cell list closes a stale card', () => {
  const intent = createEdgeDockIntent();
  intent.reveal();
  intent.focusCell(2);
  assert.deepEqual(intent.tick({ dragging: true }, 0), []);
  assert.deepEqual(intent.tick({ dragging: true }, 10_000), []);
  assert.deepEqual(intent.clampCell(2), [{ type: 'bubble', cell: null }]);
});

function provider(id, overrides = {}) {
  return {
    provider: id,
    status: 'ok',
    stale: false,
    windows: [
      { kind: 'session', label: '', remainingPercent: 40, resetsAt: '2026-09-17T12:00:00.000Z' },
      { kind: 'weekly', label: 'Weekly', remainingPercent: 70 }
    ],
    ...overrides
  };
}

test('automatic items follow the limits order and enabled set, capped at the default count', () => {
  const stats = {
    periods: { today: { totalTokens: 1200, costUsd: 2.5, clients: { codex: 200, claude: 1000 }, clientCosts: { claude: 2 } } },
    limits: { providers: ['claude', 'codex', 'cursor', 'grok', 'kimi', 'zai'].map((id) => provider(id)) }
  };
  const cells = buildEdgeDockCells(stats, { limitProviders: 'codex,claude', limitProviderOrder: 'codex,claude,cursor' });
  assert.equal(edgeDockCellSignature(cells), 'codex,claude');
  assert.equal(cells[0].remainingPercent, 40);
  assert.equal(cells[0].windowKind, 'session');
  const all = buildEdgeDockCells(stats, {});
  assert.equal(all.length, DEFAULT_LIMIT_COUNT);
  assert.equal(edgeDockCellSignature(buildEdgeDockCells(stats, { limitsEnabled: false })), '');
});

test('explicit items keep their order, their empty providers, and add usage readouts', () => {
  const stats = {
    periods: {
      today: { totalTokens: 1200, costUsd: 2.5, clients: { codex: 200, claude: 1000, droid: 50 }, clientCosts: { claude: 2, codex: 0.5 } },
      month: { totalTokens: 9000, costUsd: 30, clients: { claude: 9000 }, clientCosts: { claude: 30 } }
    },
    limits: { providers: [provider('claude'), provider('factory')] }
  };
  const items = normalizeEdgeDockItems([
    { type: 'stat', metric: 'monthCost' },
    { type: 'limit', provider: 'codex' },
    { type: 'limit', provider: 'factory', showUsage: true },
    { type: 'limit', provider: 'claude', showUsage: false },
    { type: 'stat', metric: 'bogus' },
    { type: 'limit', provider: 'claude' }
  ]);
  assert.equal(items.length, 4);
  const cells = buildEdgeDockCells(stats, { items });
  // A legacy tokens/cost metric folds into its period.
  assert.deepEqual(cells.map((cell) => cell.id), ['stat:month', 'codex', 'factory', 'claude']);
  const [month, codex, factory, claude] = cells;
  assert.equal(month.kind, 'stat');
  assert.equal(month.available, true);
  assert.equal(month.totalTokens, 9000);
  assert.equal(month.costUsd, 30);
  assert.deepEqual(month.clients.map((client) => client.client), ['claude']);
  // A chosen provider with nothing to report still holds its slot.
  assert.equal(codex.remainingPercent, null);
  assert.equal(codex.status, 'error');
  // Tokens are attributed through the catalog's client→provider mapping.
  assert.deepEqual(factory.usage.today, { tokens: 50, costUsd: 0 });
  assert.equal(claude.usage, null);
});

test('provider cards list the newest sessions of their own clients this month', () => {
  const session = (client, id, lastUsedAt, extra = {}) => ({ client, sessionId: id, lastUsedAt, totalTokens: 10, models: { 'gpt-5': 10 }, ...extra });
  const stats = {
    periods: {
      month: {
        sessions: {
          'codex:a': session('codex', 'a', '2026-09-10T00:00:00Z'),
          'codex:b': session('codex', 'b', '2026-09-16T00:00:00Z', { projectLabel: 'token-monitor' }),
          'claude:c': session('claude', 'c', '2026-09-17T00:00:00Z'),
          'codex:r': session('codex', 'r', '2026-09-17T01:00:00Z', { sessionKind: 'background-review' }),
          'codex:d': session('codex', 'd', '2026-09-15T00:00:00Z'),
          'codex:e': session('codex', 'e', '2026-09-01T00:00:00Z')
        }
      },
      today: { sessions: { 'codex:t': session('codex', 't', '2026-09-17T02:00:00Z', { title: 'Fix dock' }) } }
    },
    limits: { providers: [provider('codex')] }
  };
  const [codex] = buildEdgeDockCells(stats, {});
  assert.deepEqual(codex.sessions.map((entry) => entry.sessionId), ['t', 'b', 'd']);
  assert.equal(codex.sessions[0].title, 'Fix dock');
  assert.equal(codex.sessions[1].projectLabel, 'token-monitor');
  assert.equal(codex.sessions[1].model, 'gpt-5');
  // The rows are the rail's activity reading as well as this card's list, so hiding
  // the list is a choice the cell carries rather than one it applies: the rows stay.
  const [hidden] = buildEdgeDockCells(stats, { items: [{ type: 'limit', provider: 'codex', showSessions: false }] });
  assert.equal(hidden.showSessions, false);
  assert.deepEqual(hidden.sessions.map((entry) => entry.sessionId), ['t', 'b', 'd']);
});

// The card's list and the rail's breathing mark read the same rows, so a switch
// labelled "Show recent sessions in card" is a choice about the card. Emptying the
// cell instead made it an off switch for the mark - a reading the label never
// mentions, and one the card was never asked about.
test('hiding a card\'s session list leaves the rail its running mark', () => {
  const live = { client: 'codex', sessionId: 'live', lastUsedAt: new Date().toISOString(), totalTokens: 10, models: { 'gpt-5': 10 } };
  const stats = {
    periods: {
      month: { sessions: { 'codex:live': live } },
      today: { sessions: { 'codex:live': live } }
    },
    limits: { providers: [provider('codex')] }
  };
  const [cell] = buildEdgeDockCells(stats, { items: [{ type: 'limit', provider: 'codex', showSessions: false }] });

  assert.equal(cell.showSessions, false);
  // The mark is what the rail paints from, and these rows are also what arms the
  // rail's own repaint clock (dock.js's `cellReadsSessions`), so both have to
  // survive the card's list being switched off.
  assert.equal(edgeDockPresentation.runningSessionSummary(cell.sessions).count, 1);
  // And the switch lands on the card alone: the rows stay on the cell, and the
  // list is simply not drawn.
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const card = dock.slice(dock.indexOf('function providerCard('), dock.indexOf('function appendLiveRate('));
  assert.match(card, /const sessions = cell\.showSessions === false \? null : sessionsNode\(cell\.sessions\);/);
});

test('the live Codex account is marked from this device only', () => {
  const records = [
    provider('codex', { accountKey: 'sha256:a', sourceDetail: 'managed' }),
    provider('codex', { accountKey: 'sha256:b' })
  ];
  const stats = {
    limits: { providers: records },
    devices: [
      { deviceId: 'here', limits: { providers: [provider('codex', { accountKey: 'sha256:b' })] } },
      { deviceId: 'there', limits: { providers: [provider('codex', { accountKey: 'sha256:a' })] } }
    ]
  };
  const [codex] = buildEdgeDockCells(stats, { localDeviceId: 'here' });
  assert.deepEqual(codex.accounts.map((account) => account.active), [false, true]);
  assert.equal(codex.remainingPercent, 40, 'the current account supplies the default rail value');
});

test('Codex rail defaults to the current account and can opt into lowest remaining', () => {
  const records = [
    provider('codex', {
      accountKey: 'sha256:a',
      accountEmail: 'a@example.com',
      windows: [{ kind: 'session', remainingPercent: 5 }]
    }),
    provider('codex', {
      accountKey: 'sha256:b',
      accountEmail: 'b@example.com',
      windows: [{ kind: 'session', remainingPercent: 70 }]
    })
  ];
  const stats = {
    limits: { providers: records },
    devices: [{ deviceId: 'here', limits: { providers: [records[1]] } }]
  };
  const [current] = buildEdgeDockCells(stats, { localDeviceId: 'here' });
  assert.equal(current.remainingPercent, 70);

  const [lowest] = buildEdgeDockCells(stats, {
    localDeviceId: 'here',
    items: [{ type: 'limit', provider: 'codex', accountMode: 'lowest' }]
  });
  assert.equal(lowest.remainingPercent, 5);
});

test('an optimistic Codex account selection moves the active rail value before refreshed stats arrive', () => {
  const records = [
    provider('codex', { accountKey: 'sha256:a', windows: [{ kind: 'session', remainingPercent: 5 }] }),
    provider('codex', { accountKey: 'sha256:b', windows: [{ kind: 'session', remainingPercent: 70 }] })
  ];
  const stats = {
    limits: { providers: records },
    devices: [{ deviceId: 'here', limits: { providers: [records[0]] } }]
  };
  const [codex] = buildEdgeDockCells(stats, {
    localDeviceId: 'here',
    activeCodexAccountId: 'managed-b',
    codexManagedAccounts: [
      { id: 'managed-a', accountKey: 'sha256:a' },
      { id: 'managed-b', accountKey: 'sha256:b' }
    ]
  });
  assert.deepEqual(codex.accounts.map((account) => account.active), [false, true]);
  assert.equal(codex.remainingPercent, 70);
});

test('codex card rows resolve a switchable managed account, and never the live one', () => {
  const records = [
    provider('codex', { accountKey: 'sha256:a', accountEmail: 'a@example.com' }),
    provider('codex', { accountKey: 'sha256:b', accountEmail: 'b@example.com' })
  ];
  const stats = {
    limits: { providers: records },
    devices: [{ deviceId: 'here', limits: { providers: [provider('codex', { accountKey: 'sha256:b', accountEmail: 'b@example.com' })] } }]
  };
  const codexManagedAccounts = [
    { id: 'managed-a', accountKey: 'sha256:a', email: 'a@example.com' },
    { id: 'managed-b', accountKey: 'sha256:b', email: 'b@example.com' },
    { id: 'managed-disabled', accountKey: 'sha256:c', email: 'c@example.com', enabled: false }
  ];
  const [codex] = buildEdgeDockCells(stats, { localDeviceId: 'here', codexManagedAccounts });
  // a is not the live account here, so it can be switched to; b is live, so it
  // offers no switch meaning the button never appears on the account in use.
  assert.deepEqual(codex.accounts.map((account) => account.switchAccountId), ['managed-a', '']);
  // A row whose identity matches only a disabled managed login offers nothing,
  // even though it is not the live account.
  const [withDisabled] = buildEdgeDockCells(
    {
      limits: { providers: [provider('codex', { accountKey: 'sha256:b' }), provider('codex', { accountKey: 'sha256:c' })] },
      devices: [{ deviceId: 'here', limits: { providers: [provider('codex', { accountKey: 'sha256:b' })] } }]
    },
    { localDeviceId: 'here', codexManagedAccounts }
  );
  assert.deepEqual(withDisabled.accounts.map((account) => account.switchAccountId), ['', '']);
  // Providers other than Codex never carry the switch affordance.
  const [claude] = buildEdgeDockCells({ limits: { providers: [provider('claude')] } }, { codexManagedAccounts });
  assert.equal(claude.accounts[0].switchAccountId, '');
});

test('a lone Codex account still offers a switch onto the local login', () => {
  const stats = { limits: { providers: [provider('codex', { accountKey: 'sha256:a', accountEmail: 'a@example.com' })] } };
  const [codex] = buildEdgeDockCells(stats, {
    codexManagedAccounts: [{ id: 'managed-a', accountKey: 'sha256:a', email: 'a@example.com' }]
  });
  assert.equal(codex.accounts.length, 1);
  assert.equal(codex.accounts[0].switchAccountId, 'managed-a');
});

test('automatic items default to three providers', () => {
  const stats = { limits: { providers: ['claude', 'codex', 'cursor', 'grok', 'kimi'].map((id) => provider(id)) } };
  const cells = buildEdgeDockCells(stats, {});
  assert.equal(DEFAULT_LIMIT_COUNT, 3);
  assert.equal(cells.length, 3);
});

test('hidden accounts are left out of the headline and the card', () => {
  const stats = {
    limits: {
      providers: [
        provider('codex', { accountKey: 'sha256:a', windows: [{ kind: 'session', remainingPercent: 5 }] }),
        provider('codex', { accountKey: 'sha256:b', windows: [{ kind: 'session', remainingPercent: 70 }] })
      ]
    }
  };
  const items = [{ type: 'limit', provider: 'codex', hiddenAccounts: ['sha256:a'], showUsage: true }];
  const [codex] = buildEdgeDockCells(stats, { items });
  assert.equal(codex.remainingPercent, 70);
  assert.deepEqual(codex.accounts.map((account) => account.accountKey), ['sha256:b']);
  // Hidden is about what the card draws. The subscription matcher is handed both
  // accounts, or a record bound to the one off screen would fall through
  // matchProviderAccount()'s sole-account fallback onto the one on it.
  assert.deepEqual(codex.subscriptionAccounts.map((account) => account.accountKey), ['sha256:a', 'sha256:b']);
});

test('an account the rail drops for reporting nothing still binds its subscription', () => {
  // The rail only lists accounts that report something, but a subscription is
  // bound to the account: a failing one with no last-known windows is still the
  // account the user recorded, and a matcher that cannot see it reads the one
  // account left as "no ambiguity" and puts its record on that row instead.
  const stats = {
    limits: {
      providers: [
        provider('codex', { accountKey: 'sha256:a', windows: [{ kind: 'session', remainingPercent: 5 }] }),
        provider('codex', { accountKey: 'sha256:b', status: 'error', windows: [] })
      ]
    }
  };
  const [codex] = buildEdgeDockCells(stats, {
    items: [{ type: 'limit', provider: 'codex', showUsage: true }]
  });
  assert.deepEqual(codex.accounts.map((account) => account.accountKey), ['sha256:a']);
  assert.deepEqual(codex.subscriptionAccounts.map((account) => account.accountKey), ['sha256:a', 'sha256:b']);
});

test('a provider with nothing to report still carries its accounts to the matcher', () => {
  const stats = {
    limits: { providers: [provider('codex', { accountKey: 'sha256:a', status: 'error', windows: [] })] }
  };
  const [codex] = buildEdgeDockCells(stats, {
    items: [{ type: 'limit', provider: 'codex', showUsage: true }]
  });
  assert.equal(codex.accounts.length, 0);
  assert.deepEqual(codex.subscriptionAccounts.map((account) => account.accountKey), ['sha256:a']);
});

// The rail's provider list is the *aggregate*, and the aggregate drops an
// account the moment the same provider has a fresh one (limits/core.js collapses
// by provider name, and one login hashes differently per platform). A record
// bound to a dropped account is one the matcher cannot see, so it falls through
// matchProviderAccount()'s sole-account fallback onto the account left on
// screen — which is why the page reads the local device's own records beside the
// aggregate, and why the card has to as well.
test('the matcher sees the local accounts the aggregate collapsed away', () => {
  const local = provider('codex', { accountKey: 'sha256:local', status: 'unauthorized', windows: [] });
  const remote = provider('codex', { accountKey: 'sha256:remote', windows: [{ kind: 'session', remainingPercent: 60 }] });
  const stats = {
    devices: [
      { deviceId: 'this-mac', limits: { providers: [local] } },
      { deviceId: 'other-mac', limits: { providers: [remote] } }
    ],
    // What the aggregate holds: the stale local row is gone.
    limits: { providers: [remote] }
  };
  const [codex] = buildEdgeDockCells(stats, {
    localDeviceId: 'this-mac',
    items: [{ type: 'limit', provider: 'codex', showUsage: true }]
  });

  assert.deepEqual(
    codex.subscriptionAccounts.map((account) => account.accountKey),
    ['sha256:local', 'sha256:remote'],
    'both accounts reach the matcher, local first'
  );
  // The aggregate is still what the card draws: a collapsed account is not a row.
  assert.deepEqual(codex.accounts.map((account) => account.accountKey), ['sha256:remote']);
});

test('the same account in both lists is one candidate, not two', () => {
  const account = provider('codex', { accountKey: 'sha256:a', windows: [{ kind: 'session', remainingPercent: 60 }] });
  const stats = {
    devices: [{ deviceId: 'this-mac', limits: { providers: [account] } }],
    limits: { providers: [account] }
  };
  const [codex] = buildEdgeDockCells(stats, {
    localDeviceId: 'this-mac',
    items: [{ type: 'limit', provider: 'codex', showUsage: true }]
  });
  assert.deepEqual(codex.subscriptionAccounts.map((account) => account.accountKey), ['sha256:a']);
});

test('one account is one candidate however each copy of it reads', () => {
  // The two copies are two records: this device's own and the aggregate's. A key
  // that has rotated leaves the address behind, and the display name is not what
  // makes an account one — a candidate list that counted these twice is what the
  // matcher's sole-account fallback and its name rung are read against.
  const local = provider('codex', { accountKey: 'sha256:a', accountName: 'work', windows: [] });
  const aggregate = provider('codex', {
    accountKey: 'sha256:a',
    accountName: 'Work',
    windows: [{ kind: 'session', remainingPercent: 60 }]
  });
  const stats = {
    devices: [{ deviceId: 'this-mac', limits: { providers: [local] } }],
    limits: { providers: [aggregate] }
  };
  const [codex] = buildEdgeDockCells(stats, {
    localDeviceId: 'this-mac',
    items: [{ type: 'limit', provider: 'codex', showUsage: true }]
  });
  assert.deepEqual(codex.subscriptionAccounts.map((account) => account.accountName), ['work']);
  // The aggregate is still what the card draws.
  assert.deepEqual(codex.accounts.map((account) => account.accountName), ['Work']);

  // Two keys are two accounts even on one address, which is the shape the hub
  // keeps apart on purpose: one address holds several Codex workspaces, and
  // aggregateLimits pins that (limits.test.js). An address read as sameness
  // dropped the second workspace out of the matcher universe, so a subscription
  // bound to it resolved onto the first.
  const personal = provider('codex', {
    accountKey: 'sha256:personal',
    accountEmail: 'member@example.com',
    accountName: 'Personal',
    windows: [{ kind: 'session', remainingPercent: 60 }]
  });
  const team = provider('codex', {
    accountKey: 'sha256:team',
    accountEmail: 'member@example.com',
    accountName: 'Team',
    windows: [{ kind: 'session', remainingPercent: 60 }]
  });
  const [workspaces] = buildEdgeDockCells(
    {
      devices: [{ deviceId: 'this-mac', limits: { providers: [personal] } }],
      limits: { providers: [personal, team] }
    },
    { localDeviceId: 'this-mac', items: [{ type: 'limit', provider: 'codex', showUsage: true }] }
  );
  assert.deepEqual(
    workspaces.subscriptionAccounts.map((account) => account.accountName),
    ['Personal', 'Team'],
    'two workspaces on one address stay two candidates'
  );
});

test('an account nobody is signed into does not stand in for the ones that are', () => {
  // The collector reports a provider with no credential as a bare
  // `notConfigured` row (aggregateLimits emits the same shape), and the dock
  // reads this device's own records. That record names nothing, so it cannot be
  // an answer about an account that names something — letting it be one emptied
  // the matcher universe of the accounts the hub does have.
  const signedOut = { provider: 'codex', status: 'notConfigured', updatedAt: '2026-07-10T02:55:17.000Z', windows: [] };
  const a = provider('codex', {
    accountKey: 'sha256:a',
    accountEmail: 'a@example.com',
    windows: [{ kind: 'session', remainingPercent: 60 }]
  });
  const b = provider('codex', {
    accountKey: 'sha256:b',
    accountEmail: 'b@example.com',
    windows: [{ kind: 'session', remainingPercent: 60 }]
  });
  const [codex] = buildEdgeDockCells(
    {
      devices: [{ deviceId: 'this-mac', limits: { providers: [signedOut] } }],
      limits: { providers: [a, b] }
    },
    { localDeviceId: 'this-mac', items: [{ type: 'limit', provider: 'codex', showUsage: true }] }
  );
  assert.ok(
    codex.subscriptionAccounts.some((account) => account.accountKey === 'sha256:a'),
    'the signed-out row must not drop the accounts the hub reports'
  );
  assert.ok(codex.subscriptionAccounts.some((account) => account.accountKey === 'sha256:b'));
  // And a binding to one of them lands on that one, rather than on whatever the
  // universe happened to collapse to.
  const bound = matchProviderAccount({ id: 's', provider: 'codex', binding: { accountKey: 'sha256:b' } }, codex.subscriptionAccounts);
  assert.equal(bound?.accountKey, 'sha256:b');
});

test('a copy with no key is a copy, and never the account a binding lands on', () => {
  // One address holds two Codex workspaces, which aggregateLimits keeps apart by
  // key (limits.test.js). A device can also report that address with no key at
  // all — that is what mapCodexRateLimitsToProvider() emits when the payload
  // carries an email and no account key (limitCollector.codex.test.js), and what
  // an older record posts. Read pair by pair the copy is the same account as
  // *both* workspaces, so whichever order the two lists arrived in decided which
  // of them survived; the losing order kept only the copy, a binding to the
  // second workspace landed on it through the sole-account fallback, and the row
  // lookup then answered yes for either workspace — one record drawing on two.
  const workspaces = [
    provider('codex', {
      accountKey: 'sha256:personal',
      accountEmail: 'member@example.com',
      accountName: 'Personal',
      windows: [{ kind: 'session', remainingPercent: 60 }]
    }),
    provider('codex', {
      accountKey: 'sha256:team',
      accountEmail: 'member@example.com',
      accountName: 'Team',
      windows: [{ kind: 'session', remainingPercent: 60 }]
    })
  ];
  const copy = provider('codex', {
    accountEmail: 'member@example.com',
    windows: [{ kind: 'session', remainingPercent: 60 }]
  });
  const binding = { id: 's', provider: 'codex', binding: { accountKey: 'sha256:team' } };

  const orders = [
    ['the copy is this device\'s own record', [copy], workspaces],
    ['the copy is the aggregate\'s', [], [copy, ...workspaces]],
    ['the copy sits between them', [], [workspaces[0], copy, workspaces[1]]]
  ];
  for (const [label, local, aggregate] of orders) {
    const [codex] = buildEdgeDockCells(
      {
        devices: [{ deviceId: 'this-mac', limits: { providers: local } }],
        limits: { providers: aggregate }
      },
      { localDeviceId: 'this-mac', items: [{ type: 'limit', provider: 'codex', showUsage: true }] }
    );
    assert.deepEqual(
      codex.subscriptionAccounts.map((account) => account.accountKey).sort(),
      ['sha256:personal', 'sha256:team'],
      `${label}: both workspaces stay candidates`
    );
    const resolved = matchProviderAccount(binding, codex.subscriptionAccounts);
    assert.equal(resolved?.accountKey, 'sha256:team', `${label}: the binding lands on the workspace it names`);
    // What the rows are then drawn from: a subscription may only answer for the
    // account it resolved to.
    const drawnOn = codex.subscriptionAccounts
      .filter((account) => accountIdentity.sameAccount(resolved, account))
      .map((account) => account.accountKey);
    assert.deepEqual(drawnOn, ['sha256:team'], `${label}: the record draws on one workspace`);
  }

  // With one workspace on that address the copy is a second copy of it, and the
  // keyed record is the one that survives — it is the one a binding matches by key.
  const [single] = buildEdgeDockCells(
    {
      devices: [{ deviceId: 'this-mac', limits: { providers: [copy] } }],
      limits: { providers: [workspaces[0]] }
    },
    { localDeviceId: 'this-mac', items: [{ type: 'limit', provider: 'codex', showUsage: true }] }
  );
  assert.deepEqual(single.subscriptionAccounts.map((account) => account.accountKey), ['sha256:personal']);
});

test('one account keeps every key its copies were named by', () => {
  // One account, two copies that name it differently. This device holds an
  // opencode API key and no cookie, so its own row is keyed by the key's own
  // hash (providers/opencode/limits.js); the Hub's collapse of the same account
  // — merged from the machine that does hold the cookie — keeps the workspace id
  // as the canonical key and the key's hash beside it as an alias (limits/core.js,
  // and the comment where the producer publishes that alias). Deduping one
  // account down to one record must not be what decides which of the two keys
  // survives: a subscription bound on the cookie machine names the canonical id,
  // and a survivor left holding only this device's key stops resolving it.
  const keyOnly = provider('opencode', {
    accountKey: 'sha256:keyonly',
    accountName: 'Work',
    windows: [{ kind: 'session', remainingPercent: 60 }]
  });
  const collapsed = provider('opencode', {
    accountKey: 'sha256:workspace',
    webAccountKey: 'sha256:workspace',
    accountKeyAliases: ['sha256:keyonly'],
    accountName: 'Work',
    windows: [{ kind: 'session', remainingPercent: 60 }]
  });
  // A second account, so the matcher's sole-account fallback cannot be what
  // answers: the key rung has to be the one that lands.
  const other = provider('opencode', {
    accountKey: 'sha256:other',
    accountName: 'Personal',
    windows: [{ kind: 'session', remainingPercent: 60 }]
  });
  const binding = { id: 's', provider: 'opencode', binding: { accountKey: 'sha256:workspace' } };

  const [opencode] = buildEdgeDockCells(
    {
      devices: [{ deviceId: 'this-mac', limits: { providers: [keyOnly] } }],
      limits: { providers: [collapsed, other] }
    },
    { localDeviceId: 'this-mac', items: [{ type: 'limit', provider: 'opencode', showUsage: true }] }
  );
  // One record per account, this device's copy first.
  assert.deepEqual(
    opencode.subscriptionAccounts.map((account) => account.accountKey),
    ['sha256:keyonly', 'sha256:other']
  );
  const resolved = matchProviderAccount(binding, opencode.subscriptionAccounts);
  assert.equal(resolved?.accountKey, 'sha256:keyonly', 'the canonical key still resolves');
  // And it resolves to one account: the row lookup asks the pairwise rule about
  // whatever the binding landed on, so the survivor has to answer for both
  // copies of the account it stands for, and for no other account.
  const drawnOn = opencode.subscriptionAccounts
    .filter((account) => accountIdentity.sameAccount(resolved, account))
    .map((account) => account.accountKey);
  assert.deepEqual(drawnOn, ['sha256:keyonly']);
  assert.equal(accountIdentity.sameAccount(resolved, other), false);
});

test('two accounts that are only addresses stay two candidates', () => {
  // Neither carries a key or a name, so an identity built out of those two fields
  // read both as the same account: one of them never reached the matcher, and a
  // record bound to it resolved to the other one instead.
  const local = provider('codex', { accountKey: '', accountEmail: 'a@example.com', status: 'unauthorized', windows: [] });
  const remote = provider('codex', { accountKey: '', accountEmail: 'b@example.com' });
  const stats = {
    devices: [{ deviceId: 'this-mac', limits: { providers: [local] } }],
    limits: { providers: [remote] }
  };
  const [codex] = buildEdgeDockCells(stats, {
    localDeviceId: 'this-mac',
    items: [{ type: 'limit', provider: 'codex', showUsage: true }]
  });
  assert.deepEqual(codex.subscriptionAccounts.map((account) => account.accountEmail), [
    'a@example.com',
    'b@example.com'
  ]);
});

test('item settings normalize to null for automatic and drop unknown entries', () => {
  assert.equal(normalizeEdgeDockItems(null), null);
  assert.equal(normalizeEdgeDockItems('nope'), null);
  assert.deepEqual(normalizeEdgeDockItems([]), []);
  assert.deepEqual(normalizeEdgeDockItems([{ type: 'limit', provider: 'not-a-provider' }, { type: 'stat', metric: 'liveRate' }]), [
    { type: 'stat', metric: 'liveRate' }
  ]);
  // Legacy split metrics collapse into one period item.
  assert.deepEqual(normalizeEdgeDockItems([{ type: 'stat', metric: 'todayTokens' }, { type: 'stat', metric: 'todayCost' }]), [
    { type: 'stat', metric: 'today' }
  ]);
  assert.deepEqual(
    normalizeEdgeDockItems([{ type: 'limit', provider: 'CODEX', hiddenAccounts: ['k', 'k', 7, ''] }]),
    [{ type: 'limit', provider: 'codex', hiddenAccounts: ['k', '7'], showUsage: true, showSessions: true, accountMode: 'active' }]
  );
  assert.equal(normalizeEdgeDockItems([{ type: 'limit', provider: 'codex', accountMode: 'lowest' }])[0].accountMode, 'lowest');
  assert.equal(normalizeEdgeDockItems([{ type: 'limit', provider: 'claude', accountMode: 'active' }])[0].accountMode, 'lowest');
});

test('a dragged usage item keeps its place in the saved order', () => {
  const items = [
    { type: 'limit', provider: 'claude', hiddenAccounts: [], showUsage: true },
    { type: 'limit', provider: 'codex', hiddenAccounts: [], showUsage: true },
    { type: 'stat', metric: 'liveRate' }
  ];
  // Drive the real drag sort: it lower-cases ids, which once dropped the item.
  const rows = [{ id: 'limit:claude', top: 0, height: 34 }, { id: 'limit:codex', top: 40, height: 34 }, { id: 'stat:liveRate', top: 80, height: 26 }];
  const { order } = verticalDragSort.resolveVerticalDrag(verticalDragSort.createVerticalDragSnapshot(rows, 'stat:liveRate', 10), -95);
  assert.deepEqual(reorderEdgeDockItems(items, order).map((item) => item.metric || item.provider), ['liveRate', 'claude', 'codex']);
  assert.equal(reorderEdgeDockItems(items, []).length, 3);
});

test('derived periods read History totals and stay unknown until they arrive', () => {
  const items = [{ type: 'stat', metric: 'last7' }, { type: 'stat', metric: 'allTime' }];
  const stats = { periods: { allTime: { totalTokens: 5, costUsd: 1, clients: { codex: 5 } } } };
  const [pending, total] = buildEdgeDockCells(stats, { items });
  assert.equal(pending.available, false);
  assert.equal(pending.totalTokens, null);
  assert.equal(total.available, true);
  const [ready] = buildEdgeDockCells(stats, {
    items,
    derivedPeriods: { last7: { totalTokens: 70, costUsd: 7, clients: { claude: 70 }, clientCosts: { claude: 7 } } }
  });
  assert.equal(ready.totalTokens, 70);
  assert.deepEqual(ready.clients.map((client) => client.client), ['claude']);
});

// The card's quota rows are built by the Limits view's own builder, which reads
// the collector record. A projection here is what made the card a second,
// less-informed implementation of those rows — every field it forgot to copy
// was a row the card could not draw — so the record rides across untouched and
// the window-level decisions (ordering, Codex's additional-limit preference)
// stay in the one builder that makes them.
test('the card carries the collector record the shared Limits view renders from', () => {
  const windows = [
    { kind: 'session', label: 'Gemini 5-hour', remainingPercent: 90 },
    { kind: 'weekly', label: 'Gemini weekly', remainingPercent: 80 },
    { kind: 'session', label: 'Claude/GPT 5-hour', remainingPercent: 70 },
    { kind: 'weekly', label: 'Claude/GPT weekly', remainingPercent: 60 }
  ];
  const record = provider('antigravity', { windows });
  const [cell] = buildEdgeDockCells({ limits: { providers: [record] } }, {});
  assert.deepEqual(cell.accounts[0].record, record);

  const codexWindows = [
    { kind: 'session', label: 'Session', remainingPercent: 70 },
    { kind: 'daily', label: 'GPT-5.3-Codex-Spark', remainingPercent: 40, additional: true }
  ];
  const codexRecord = provider('codex', { windows: codexWindows });
  const [codex] = buildEdgeDockCells({ limits: { providers: [codexRecord] } }, {});
  assert.deepEqual(codex.accounts[0].record.windows, codexWindows);
});

test('live rate readout reports the selected mode and idle state', () => {
  const [speed] = buildEdgeDockCells({}, { items: [{ type: 'stat', metric: 'liveRate' }], liveRate: { speed: 42, burn: 2520, idle: false } });
  assert.equal(speed.rate, 42);
  assert.equal(speed.idle, false);
  const [burn] = buildEdgeDockCells({}, { items: [{ type: 'stat', metric: 'liveRate' }], liveRate: { speed: 42, burn: 2520, idle: true }, tokenRateMode: 'burn' });
  assert.equal(burn.rate, 2520);
  assert.equal(burn.idle, true);
  const [none] = buildEdgeDockCells({}, { items: [{ type: 'stat', metric: 'liveRate' }] });
  assert.equal(none.rate, null);
});

test('a provider cell headlines its tightest account and never invents 0% for missing data', () => {
  const stats = {
    limits: {
      providers: [
        provider('claude', { accountEmail: 'a@example.com' }),
        provider('claude', { accountEmail: 'b@example.com', windows: [{ kind: 'session', remainingPercent: 5 }] }),
        provider('codex', { status: 'error', windows: [{ kind: 'session', remainingPercent: null }] }),
        provider('grok', { status: 'unauthorized', windows: [] }),
        provider('zai', { status: 'notConfigured', windows: [] }),
        provider('cursor', { stale: true })
      ]
    }
  };
  const cells = buildEdgeDockCells(stats, {});
  // Rows that report nothing at all are not given a slot on the rail.
  assert.equal(edgeDockCellSignature(cells), 'claude,codex,cursor');
  const [claude, codex, cursor] = cells;
  assert.equal(claude.remainingPercent, 5);
  // Accounts keep the collector's order; only the rail headline picks the tightest.
  assert.deepEqual(claude.accounts.map((account) => account.accountEmail), ['a@example.com', 'b@example.com']);
  assert.equal(claude.accountCount, 2);
  assert.equal(codex.remainingPercent, null);
  assert.equal(codex.status, 'error');
  assert.equal(cursor.remainingPercent, null);
  assert.equal(cursor.status, 'stale');
});

test('credits windows headline money rather than a wire percentage', () => {
  const stats = {
    limits: {
      providers: [{
        provider: 'deepseek',
        status: 'ok',
        balance: { amount: 12.5, currency: 'CNY', monthSpend: 12.5 },
        windows: [{ kind: 'billing', metric: 'credits', remaining: 12.5, currency: 'CNY' }]
      }]
    }
  };
  const [cell] = buildEdgeDockCells(stats, {});
  assert.deepEqual(cell.credits, { amount: 12.5, currency: 'CNY' });
  assert.equal(cell.remainingPercent, 50);
});

test('display percent honours used mode while severity stays keyed on what is left', () => {
  assert.equal(displayPercent(30, false), 30);
  assert.equal(displayPercent(30, true), 70);
  assert.equal(displayPercent(null, true), null);
  assert.equal(remainingSeverity(30), 'ok');
  assert.equal(remainingSeverity(20), 'low');
  assert.equal(remainingSeverity(5), 'critical');
  assert.equal(remainingSeverity(null), 'unknown');
});

// The rail's entrance slides the whole surface, so it has to move the root - and a
// rule written as `.edge-dock-root *` does not match the element it hangs off. That
// left the one animation in this sheet that reduced motion would not have stopped,
// which is invisible until someone turns the setting on and watches the rail.
test('the rail entrance moves the whole surface and stops under reduced motion', () => {
  const css = readRendererFile(path.join('edgeDock', 'dock.css')).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const reveal = css.slice(css.indexOf('@keyframes edge-dock-rail-in'), css.indexOf('@keyframes edge-dock-card-in'));
  assert.ok(reveal, 'the rail entrance should be keyed');
  // A transform, so it runs on the compositor and carries the drawn silhouette
  // with the cells inside it rather than sliding them within a fixed frame.
  assert.match(reveal, /from \{ transform: translateX\(/);
  assert.match(reveal, /to \{ transform: none; \}/);
  assert.match(reveal, /\.edge-dock-root\.is-revealing \{ animation: edge-dock-rail-in /);
  // It starts from the side the edge is on: a left-edge dock sliding the right way
  // would read as leaving rather than arriving.
  assert.match(css, /\.edge-dock-root\[data-side="left"\] \{ --edge-dock-rail-shift: -14px; \}/);

  const blanket = css.slice(css.indexOf('html[data-reduce-motion="on"] .edge-dock-root,'));
  const selectors = blanket.slice(0, blanket.indexOf('{'));
  assert.match(selectors, /html\[data-reduce-motion="on"\] \.edge-dock-root,/);
  assert.match(selectors, /html\[data-reduce-motion="on"\] \.edge-dock-root \*,/);
  assert.match(selectors, /html\.edge-dock-reduced-motion \.edge-dock-root,/);
  assert.match(selectors, /html\.edge-dock-reduced-motion \.edge-dock-root \*[,\s]/);

  // And the page plays it on the transition alone, so the push that re-renders this
  // surface every few seconds does not replay the slide. The transition is the count
  // moving, not the rail being up: the retract takes the window away without a
  // payload, so a page keying on the state would never see the rail leave and would
  // read the next reveal as no change at all - one entrance per page load.
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  assert.match(dock, /if \(railReveal !== null && reveal !== railReveal\) playRailReveal\(\);/);
});

// The halo the running mark breathes is bounded on both sides, and both bounds are
// invisible in a diff because every number involved is deliberate. It fades out too
// early and it is already at zero where the glyph ends, showing only through the
// counters of the letterform; it reaches too far and it stops reading as light around
// the mark and becomes a second, larger circle behind the ring. The numbers were
// re-tuned once by eye against the real stylesheet; these bounds are what has to hold
// whatever they are re-tuned to.
test('the running halo lights the mark without becoming the ring', () => {
  const css = readRendererFile(path.join('edgeDock', 'dock.css')).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const ring = Number(css.match(/\n\.edge-dock-ring \{[^}]*?width: ([\d.]+)px/)[1]);
  const mark = Number(css.match(/\n\.edge-dock-mark \{[^}]*?width: ([\d.]+)px/)[1]);
  const arcWidth = Number(css.match(/\n\.edge-dock-ring-fill \{[^}]*?stroke-width: ([\d.]+)/)[1]);
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const arcRadius = Number(dock.match(/const RING_RADIUS = ([\d.]+);/)[1]);
  const glow = css.slice(css.indexOf('.edge-dock-ring-glow {'), css.indexOf('.edge-dock-cell[data-running="yes"]'));
  const size = Number(glow.match(/width: ([\d.]+)%/)[1]) / 100;
  // Both gradient forms are legal here: a held stop (`colour 30%, transparent 100%`) and
  // the plain falloff this uses (`colour, transparent 72%`), which holds nothing at all.
  const stops = glow.match(/(?:([\d.]+)%, )?transparent ([\d.]+)%/);
  assert.ok(stops, 'the halo should be a falloff this can read');
  const hold = Number(stops[1] ?? 0) / 100;
  const zero = Number(stops[2]) / 100;

  const radius = (size * ring) / 2;
  // It has to reach past the mark, or there is nothing beside the glyph to see.
  assert.ok(radius * zero > mark / 2, `the halo is spent at ${radius * zero}px, inside the mark's ${mark / 2}px`);
  // Anything that is held at full colour has to be held *under* the glyph, so what shows
  // beside the letterform is always falloff rather than the flat edge of a disc.
  assert.ok(hold * radius < mark / 2, `colour is held to ${hold * radius}px, past the mark's ${mark / 2}px`);
  // And it has to be spent inside the arc, or the halo laps under the ring and the
  // arc stops being the ring's outer edge - the arc is the quota reading, so a glow
  // that reaches it reads as a fatter, brighter version of the same circle. The bound
  // is the midpoint between the two landmarks this sits between: a halo that reaches
  // past it has crossed from light around the glyph into a disc behind the ring.
  const arcInner = arcRadius - arcWidth / 2;
  assert.ok(
    radius * zero < (mark / 2 + arcInner) / 2,
    `the halo reaches ${radius * zero}px, into the ring's half of the space at ${(mark / 2 + arcInner) / 2}px`
  );
});

// The breath is the dock's longest-running animation and the rail rebuilds every cell
// on every stats push, so the element it is declared on is new each time. A phase that
// lived on that element restarted at 0% with each push - and the pushes come closest
// together while a session is working, which is exactly when the mark is worth
// something, so it could stutter or never reach the top of the swing at all. It is
// anchored to the clock instead, which means the two numbers that anchor it have to
// agree: the modulo has to be the animation's own period.
test('the running halo resumes its phase rather than restarting on every repaint', () => {
  const css = readRendererFile(path.join('edgeDock', 'dock.css'));
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  const period = Number(css.match(/animation: edge-dock-mark-breathe (\d+)ms/)[1]);
  assert.equal(Number(dock.match(/const BREATH_MS = (\d+);/)[1]), period, 'the phase anchor has to be the animation\'s period');
  // A negative delay is what starts a fresh node partway through the cycle - the
  // point of the whole thing, since a delay of zero is the restart this avoids.
  assert.match(dock, /glow\.style\.animationDelay = `-\$\{Date\.now\(\) % BREATH_MS\}ms`;/);
  // And it is set where the glow is made, so no node can reach the document without it.
  const ring = dock.slice(dock.indexOf('function ringNode('), dock.indexOf('function providerCellNode('));
  assert.match(ring, /glow\.style\.animationDelay/);
});

// The handle's exit is a move now rather than a blink. The window's fade is the main
// process's and outlasts it, so the retreat leads the fade - shorter and front-loaded
// - or the glass dims past the movement before it has travelled, the same cancellation
// the rail's entrance is curved to avoid. The return keeps the window's own 150ms, so
// the retreat lives on the withdrawn state and one transition carries it both ways.
test('the handle retreats into the edge while the window can still show it', () => {
  const css = readRendererFile(path.join('edgeDock', 'dock.css')).replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.match(css, /\.edge-dock-root\[data-side="right"\] \{ --edge-dock-grip-retreat: 4px; \}/);
  assert.match(css, /\.edge-dock-root\[data-side="left"\] \{ --edge-dock-grip-retreat: -4px; \}/);
  assert.match(
    css,
    /\.is-handle-hidden \.edge-dock-grip \{\s*opacity: 0;\s*transform: translateX\(var\(--edge-dock-grip-retreat\)\) scaleY\(0\.2\);\s*transition: opacity 110ms ease-out, transform 110ms ease-out;/
  );
  assert.match(css, /transition: opacity 150ms ease, transform 150ms cubic-bezier\(0\.33, 1, 0\.68, 1\);/);

  // Held as a state rather than replayed, so it needs no animation-name bookkeeping
  // and a page that loads with the rail already open starts in the withdrawn pose.
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  assert.match(dock, /root\.classList\.toggle\('is-handle-hidden', payload\.peeking !== true\);/);
});
