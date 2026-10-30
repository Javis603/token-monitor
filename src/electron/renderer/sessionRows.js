'use strict';

(function exposeSessionRows(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSessionRows = api;
})(typeof window !== 'undefined' ? window : null, function createSessionRowsApi(root) {
  const reasonixSessionGuard = typeof module === 'object' && module.exports
    ? require('../../shared/providers/reasonix/sessionGuard')
    : root?.TokenMonitorReasonixSessionGuard;
  const isReasonixSyntheticSession = reasonixSessionGuard?.isReasonixSyntheticSession || (() => false);
  // Running/archived and the context pair are shared with the Edge Dock's
  // session rows: both render the same session record, so the predicate cannot
  // live in only one of the two renderers.
  const sessionLive = typeof module === 'object' && module.exports
    ? require('../../shared/sessionLive')
    : root?.TokenMonitorSessionLive;
  const sessionActivityState = sessionLive.sessionActivityState;
  const sessionContextForRow = sessionLive.sessionContextForRow;
  const isGrokBotSession = sessionLive.isGrokBotSession;
  const fallbackColors = ['#6ab4f0', '#cc7c5e', '#a57df0', '#49a3b0', '#f0d66a', '#f06a7b'];

  function setSessionTooltip(node, context, promptCache, translate, view) {
    const entries = [];
    if (context?.contextTokens > 0 && context?.contextWindow > 0) {
      const compact = (value) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
      entries.push({ full: `${compact(context.contextTokens)} / ${compact(context.contextWindow)}` });
    }
    if (promptCache) entries.push({ full: translate('session.cacheEstimateTooltip', { minutes: promptCache.minutes }) });
    view.setDetailTooltip(node, entries);
  }

  function sessionReasoningEffortForRow(row) {
    const main = row?.groupRows?.[0] || row;
    return sessionLive.isSessionReasoningEffortClient(main?.client) ? sessionLive.normalizeReasoningEffort(main.reasoningEffort) : null;
  }

  function sessionModelMetadataLabel(row) {
    return [row?.modelLabel ?? sessionModelLabel(row), sessionReasoningEffortForRow(row)].filter(Boolean).join(' · ');
  }

  // Shared by full session rows and compact Home/Dock/Notch rows. Settings
  // remain visible after live metrics expire, including archived sessions.
  function sessionModelMetadataNode(document, row, { translate, view, ...options }) {
    const node = document.createElement('span');
    node.className = 'session-model-metadata';
    const modelLabel = row?.modelLabel ?? sessionModelLabel(row);
    const entries = row?.modelTooltipEntries ?? sessionModelTooltipEntries(row, options);
    if (modelLabel) {
      const model = document.createElement('span');
      model.className = 'session-models';
      model.textContent = modelLabel;
      if (entries.length > 1) view.setDetailTooltip(model, entries);
      node.append(model);
    }
    const effort = sessionReasoningEffortForRow(row);
    if (effort) {
      if (modelLabel) node.append(document.createTextNode(' · '));
      const setting = document.createElement('span');
      setting.className = 'session-reasoning-effort';
      setting.textContent = effort;
      const label = translate('session.reasoningEffortLabel', { effort });
      setting.setAttribute('aria-label', label);
      node.append(setting);
    }
    return node;
  }

  // The compact status every glanceable session row shows (Home list, Edge Dock
  // card, Notch Panel): a context gauge while the session is live, otherwise the
  // prompt-cache estimate. The cache badge's tooltip still names the context
  // size when the transcript reported one. Surfaces differ only in class names.
  function sessionStatusNode(document, row, { prefix, translate, view, showUsed = true, now = Date.now() }) {
    const statusRow = row?.groupRows?.[0] || row;
    if (!statusRow) return null;
    const context = sessionActivityState(statusRow, now) !== 'idle'
      ? statusRow.context || sessionContextForRow(statusRow, now) || null : null;
    const promptCache = sessionLive.sessionPromptCacheForRow(statusRow, now);
    if (!context && !promptCache) return null;
    const span = (className, text) => {
      const node = document.createElement('span');
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    if (!context) {
      const badge = span(`${prefix}-cache`, translate('session.cacheEstimate', { minutes: promptCache.minutes }));
      setSessionTooltip(badge, statusRow, promptCache, translate, view);
      return badge;
    }
    const percent = showUsed ? context.percentUsed : context.percentLeft;
    const node = span(`${prefix}-context`);
    node.dataset.tone = String(context.tone || '');
    node.setAttribute('role', 'meter');
    node.setAttribute('aria-valuemin', '0');
    node.setAttribute('aria-valuemax', '100');
    node.setAttribute('aria-valuenow', String(percent));
    node.setAttribute('aria-label', translate(showUsed ? 'session.contextUsed' : 'session.contextLeft', { percent }));
    const meter = span(`${prefix}-context-meter`);
    meter.setAttribute('aria-hidden', 'true');
    const fill = span(`${prefix}-context-fill`);
    fill.style.setProperty('--bar-scale', String(percent / 100));
    meter.append(fill);
    node.append(meter, span(`${prefix}-context-value`, `${percent}%`));
    setSessionTooltip(node, context, promptCache, translate, view);
    return node;
  }

  function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function formatNumber(value) {
    return Math.round(finiteNumber(value)).toLocaleString('en-US');
  }

  function stableColor(value, colors = fallbackColors) {
    let hash = 0;
    for (const char of String(value || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return colors[Math.abs(hash) % colors.length] || fallbackColors[0];
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function validDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  function sameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  function compactSessionTime(value, now = new Date()) {
    const date = validDate(value);
    if (!date) return '';
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    return sameLocalDay(date, now)
      ? time
      : `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${time}`;
  }

  function sessionIds(id) {
    const raw = String(id || '').trim();
    if (!raw) return [];
    const reasonixPrefix = raw.match(/^reasonix:/i);
    const reasonixLabel = reasonixPrefix ? raw.slice(reasonixPrefix[0].length) : raw;
    if (reasonixLabel.toLowerCase().startsWith('reasonix-stats:')) return [];
    if (reasonixPrefix) return [reasonixLabel];
    if (raw.toLowerCase().startsWith('reasonix-stats:')) return [];
    const uuids = raw.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) || [];
    // Rollout filenames can contain multiple UUIDs. These are display labels,
    // not proof that each UUID is a conversation identity.
    if (uuids.length > 1) return uuids;
    const rollout = raw.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}-(.+)$/);
    if (rollout) return [uuids[0] || rollout[1]];
    if (/^\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}/.test(raw)) return [];
    return [raw];
  }

  function sessionIdLabel(id) {
    return sessionIds(id).join(' · ');
  }

  function sessionDetailIdLabel(client, id, detail) {
    if (client !== 'codex') return sessionIdLabel(id);
    const canonical = detail?.found === true ? detail.canonicalSessionId : '';
    if (typeof canonical === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(canonical)) return canonical;
    const candidates = sessionIds(id);
    return candidates.length === 1 ? candidates[0] : '';
  }

  function sessionModelLabel(session) {
    const models = Object.entries(session?.models || {})
      .filter(([, value]) => finiteNumber(value) > 0)
      .map(([model]) => model)
      .sort();
    if (models.length === 0) return '';
    if (models.length === 1) return models[0];
    return `${models.length} models`;
  }

  // The rows a "N models" label opens on hover: every model behind the count,
  // heaviest first, with its tokens and share of the session. A session can
  // hold tokens no model claimed (a log written before the model field
  // existed, say), so the remainder is reported as one last row rather than
  // letting the shares sum under the label's promise.
  function sessionModelTooltipEntries(session, options = {}) {
    const entries = Object.entries(session?.models || {})
      .map(([model, tokens]) => ({ model: String(model || ''), tokens: finiteNumber(tokens) }))
      .filter((entry) => entry.tokens > 0);
    if (entries.length < 2) return [];
    entries.sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
    const total = finiteNumber(session?.totalTokens);
    const attributed = entries.reduce((sum, entry) => sum + entry.tokens, 0);
    const denominator = Math.max(total, attributed);
    const formatTokens = typeof options.formatTokens === 'function' ? options.formatTokens : formatNumber;
    // The same share label the tool-detail accordion prints for model rows: a
    // real sliver reads "<1%" rather than rounding to a misleading 0.
    const percentLabel = (percent) => (
      percent > 0 && percent < 1 ? '<1%' : `${Math.round(Math.min(100, percent))}%`
    );
    const named = entries.filter((entry) => entry.model);
    const rows = named.map((entry) => [
      entry.model,
      formatTokens(entry.tokens),
      percentLabel(denominator > 0 ? entry.tokens / denominator * 100 : 0)
    ]);
    const unlabeled = attributed - named.reduce((sum, entry) => sum + entry.tokens, 0);
    const unattributed = unlabeled + Math.max(0, total - attributed);
    if (unattributed > 0) {
      rows.push([
        textValue(options.unattributedLabel) || 'Unclassified',
        formatTokens(unattributed),
        percentLabel(unattributed / denominator * 100)
      ]);
    }
    return rows;
  }

  function sessionTimestampValue(session) {
    const date = validDate(session?.lastUsedAt || session?.startedAt);
    return date ? date.getTime() : 0;
  }

  function sessionActivityLabel(session, now) {
    return compactSessionTime(session?.lastUsedAt || session?.startedAt, now);
  }

  function textValue(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function sessionTitleForDisplay(session) {
    const title = textValue(session?.title);
    // OMP persists its title card as <icon> <CODE>: <title>, including /rename
    // titles. Hide only a private-use icon in that prefix; retain the code,
    // body and original record for archives/sync, and leave other clients alone.
    return session?.client === 'omp'
      ? title.replace(/^[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}] (?=[A-Z0-9]{1,6}: \S)/u, '')
      : title;
  }

  function clearButtonSemantics(element) {
    for (const attribute of ['tabindex', 'role', 'aria-expanded', 'aria-label']) {
      element.removeAttribute(attribute);
    }
  }

  function applyBreakdownRowSemantics(row, rowHead, options = {}) {
    clearButtonSemantics(row);
    clearButtonSemantics(rowHead);
    if (options.hasAccordion === true) {
      rowHead.setAttribute('tabindex', '0');
      rowHead.setAttribute('role', 'button');
      rowHead.setAttribute('aria-expanded', String(options.expanded === true));
      rowHead.setAttribute('aria-label', textValue(options.ariaLabel));
      return;
    }
    if (options.interactive !== true) return;
    row.setAttribute('tabindex', '0');
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', textValue(options.ariaLabel));
  }

  function handleBreakdownRowKeydown(event) {
    if (event?.key !== 'Enter' && event?.key !== ' ') return false;
    const row = event.target?.closest?.('.row[role="button"]');
    if (!row) return false;
    event.preventDefault();
    row.click();
    return true;
  }

  function sessionTitleParts(session, labels, fallbackLabel = 'Session', explicitModel = '') {
    const client = textValue(session?.client);
    const clientLabel = labels[client] || client || fallbackLabel;
    const modelLabel = textValue(explicitModel) || sessionModelLabel(session);
    return {
      client,
      clientLabel,
      modelLabel,
      titleParts: [clientLabel, modelLabel, sessionReasoningEffortForRow(session)].filter(Boolean)
    };
  }

  function messageLabel(session) {
    const count = finiteNumber(session?.messageCount);
    if (count <= 0) return '';
    // A session's "message count" is tokscale's count of usage-bearing replies,
    // not conversation messages: Claude writes one API response as several
    // content-block lines de-duplicated by message id, and Codex counts
    // token_count events. `calls` is what the number actually is (a request
    // count) and keeps this row a spending readout rather than a transcript
    // readout; Session Detail resolves the same records into "turns" and
    // Reply #N instead, because it has the boundaries to group them by.
    // Deliberately NOT localized: this is a billing unit, and a translated
    // counter reads as a different measure in each locale (the Chinese candidates read as
    // something closer to "invocations" than to billable calls).
    return `${formatNumber(count)} ${count === 1 ? 'call' : 'calls'}`;
  }

  // Preserve raw counters on presentation rows so a family divides only after
  // summing its disjoint accounting members. Clamp timed output per member:
  // untimed or malformed output must not borrow another member's duration.
  function sessionUsageMetrics(session) {
    const positive = field => Math.max(0, finiteNumber(session?.[field]));
    const timedDurationMs = positive('timedDurationMs');
    return {
      messageCount: positive('messageCount'),
      inputTokens: positive('inputTokens'),
      cacheReadTokens: positive('cacheReadTokens'),
      cacheWriteTokens: positive('cacheWriteTokens'),
      outputTokens: positive('outputTokens'),
      timedOutputTokens: timedDurationMs > 0
        ? Math.min(positive('outputTokens'), positive('timedOutputTokens')) : 0,
      timedDurationMs,
      cacheReported: session?.cacheReported === true
    };
  }

  // The session's own generation speed: the footer's tok/s ratio over just
  // this session's timed entries. A client that reports no durations leaves
  // both counters at 0 and the row without a reading.
  function sessionTokenRate(session) {
    const durationMs = finiteNumber(session?.timedDurationMs);
    const output = Math.min(
      Math.max(0, finiteNumber(session?.outputTokens)),
      Math.max(0, finiteNumber(session?.timedOutputTokens))
    );
    return durationMs > 0 && output > 0 ? output * 1000 / durationMs : 0;
  }

  // Not localized, like the footer's rate and `calls`: tok/s is a unit.
  function tokenRateLabel(session) {
    const rate = Math.round(sessionTokenRate(session));
    return rate > 0 ? `${formatNumber(rate)} tok/s` : '';
  }

  // Share of the session's input the provider served from cache - the same
  // split the Tool detail prints as "Input (Cache Hit)". A session with no
  // cache traffic either way says nothing about caching (several clients never
  // report it), so it gets no reading rather than a 0% that reads as a miss.
  function sessionCacheHitPercent(session) {
    const cacheRead = Math.max(0, finiteNumber(session?.cacheReadTokens));
    const cacheWrite = Math.max(0, finiteNumber(session?.cacheWriteTokens));
    if (cacheRead <= 0 && cacheWrite <= 0 && session?.cacheReported !== true) return null;
    const input = Math.max(0, finiteNumber(session?.inputTokens)) + cacheRead + cacheWrite;
    return input > 0 ? cacheRead / input * 100 : null;
  }

  // A bare percentage: the line has no room for a label in a narrow window, and
  // an icon would either look like a clock beside the time or borrow the
  // footer's ⚡, which already means speed.
  function cacheHitLabel(session) {
    const percent = sessionCacheHitPercent(session);
    if (percent === null) return '';
    return percent > 0 && percent < 1 ? '<1%' : `${Math.round(Math.min(100, percent))}%`;
  }

  function isBackgroundReviewSession(session) {
    return textValue(session?.sessionKind) === 'background-review';
  }

  const botIdentityCache = new WeakMap();
  const botIdSets = new WeakMap();

  // Accounting maps use client:sessionId keys. Only inspect the visible
  // candidates' historical rows: enumerating history would make a DAY repaint
  // scale with the lifetime session count. Snapshot maps are immutable.
  function grokBotSessionIdsForMaps(visibleMaps, historyMaps = []) {
    const maps = visibleMaps.filter(map => map && typeof map === 'object');
    const history = historyMaps.filter(map => map && typeof map === 'object');
    if (maps.length === 0) return [];
    const cached = botIdentityCache.get(maps[0]);
    const sameMaps = (a, b) => a.length === b.length && a.every((map, index) => map === b[index]);
    if (cached && sameMaps(cached.maps, maps) && sameMaps(cached.history, history)) return cached.ids;
    const candidates = new Set();
    const bots = new Set();
    for (const map of maps) {
      for (const [key, session] of Object.entries(map)) {
        if (session?.client !== 'cursor') continue;
        const id = textValue(session.sessionId) || key.replace(/^cursor:/, '');
        candidates.add(id);
        if (isGrokBotSession(session, key)) bots.add(id);
      }
    }
    for (const id of candidates) {
      if (bots.has(id)) continue;
      const key = `cursor:${id}`;
      if (history.some(map => isGrokBotSession(map[key], key))) bots.add(id);
    }
    const ids = [...bots];
    botIdentityCache.set(maps[0], { maps, history, ids });
    return ids;
  }

  function grokBotIdsForPeriod(period, options) {
    // A pushed compact list is authoritative, including an empty one. Never
    // revive identity from a stale TOTAL list attached by the renderer loader.
    const ids = Array.isArray(options.grokBotSessionIds) ? options.grokBotSessionIds
      : grokBotSessionIdsForMaps([period?.sessions],
        Object.values(options.sourcePeriods || {}).map(value => value?.sessions));
    let result = botIdSets.get(ids);
    if (!result) {
      result = new Set(ids);
      botIdSets.set(ids, result);
    }
    return result;
  }

  function sessionRowDetailAvailable(row) {
    return ['claude', 'codebuddy', 'codex', 'opencode', 'dsh', 'workbuddy', 'pi', 'omp', 'senpi'].includes(row?.client)
      || (row?.client === 'reasonix' && row?.sessionDetailAvailable === true);
  }

  function nativeSessionRow(session, key, options, now) {
    const periodTokenDataUnavailable = session?.periodTokenDataUnavailable === true;
    // Native telemetry is cumulative for a resumed Branch, but it remains a
    // trusted conversation total. Only an actually missing native total is
    // unavailable; periodTokenDataUnavailable is reserved for aggregation so
    // the same lifetime value is never counted as today's project usage.
    const tokenDataUnavailable = session?.tokenDataUnavailable === true;
    const value = tokenDataUnavailable ? 0 : finiteNumber(session?.totalTokens);
    if (value <= 0 && !tokenDataUnavailable) return null;
    const labels = options.clientLabels || {};
    const colors = options.clientColors || {};
    const stable = typeof options.stableColor === 'function' ? options.stableColor : stableColor;
    const palette = options.fallbackColors || fallbackColors;
    const client = textValue(session?.client) || 'reasonix';
    const { clientLabel, titleParts, modelLabel } = sessionTitleParts(
      { ...session, client },
      labels,
      client === 'codex' ? 'Codex' : client === 'claude' ? 'Claude Code' : 'Reasonix',
      session?.model
    );
    // Native Reasonix prompt totals include cache hits; explicit misses win,
    // matching the detail reader's split without counting those hits twice.
    const cacheRead = Math.max(0, finiteNumber(session?.cacheHitTokens));
    const cacheInput = session?.cacheMissTokens ?? Math.max(0, finiteNumber(session?.promptTokens) - cacheRead);
    // Positive explicit misses prove a cold-cache reading; prompt-only or
    // all-zero counters do not prove that cache telemetry is available.
    const cacheLabel = cacheHitLabel({
      inputTokens: cacheInput,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: session?.cacheWriteTokens
    }) || (finiteNumber(session?.cacheMissTokens) > 0 ? '0%' : '');
    const usageMetrics = sessionUsageMetrics({
      ...session,
      ...(tokenDataUnavailable ? { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        outputTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 } : client === 'reasonix' ? {
        inputTokens: cacheInput, cacheReadTokens: cacheRead,
        cacheReported: finiteNumber(session?.cacheMissTokens) > 0
      } : {})
    });
    const activityTime = sessionActivityLabel(session, now);
    const subtitleParts = [
      activityTime,
      messageLabel(session),
      tokenDataUnavailable ? '' : cacheLabel,
      tokenRateLabel(session)
    ].filter(Boolean);
    // One derivation, not two: the boolean is a projection of the three-state
    // value, so a row can never be marked running by one reading and idle by the
    // other. `isRunningSession` itself delegates to `sessionActivityState` for the
    // same reason.
    const activityState = sessionActivityState(session, now);
    const running = activityState === 'running';
    const parentClient = textValue(session?.parentClient) || client;
    const parentSessionId = textValue(session?.parentSessionId);
    const subagent = Boolean(parentSessionId) && (parentClient !== client || parentSessionId !== session.sessionId)
      && !isBackgroundReviewSession(session);
    return {
      key: `session:${key}`,
      kind: 'session',
      name: titleParts.join(' · '),
      modelLabel,
      modelTooltipEntries: sessionModelTooltipEntries(session, {
        unattributedLabel: options.unattributedLabel
      }),
      subtitle: subtitleParts.join(' · '),
      activitySummary: subtitleParts.join(' · '),
      activityTime,
      usageMetrics,
      running: running || undefined,
      activityState,
      // Decided by the shared gate, not by `running`: it follows the recency
      // window so the reading survives the turn ending, and the dock's card
      // calls the same function so the two cannot disagree.
      context: sessionContextForRow(session, now),
      reasoningEffort: session.reasoningEffort,
      detail: sessionIdLabel(session?.sessionId || key),
      value,
      tokenDataUnavailable,
      periodTokenDataUnavailable,
      // A reported session cost is the same trusted conversation-level value
      // as the cumulative token total. Do not hide it merely because the
      // period cannot be split exactly.
      cost: tokenDataUnavailable ? 0 : finiteNumber(session?.reportedCostUsd),
      sessionDetailAvailable: session?.sessionDetailAvailable === true,
      color: colors[client] || stable(key, palette),
      stale: false,
      client,
      clientLabel,
      nativeSessionId: textValue(session?.nativeSessionId),
      t3ThreadId: textValue(session?.t3ThreadId),
      modelTokens: session?.models || (session?.model ? { [session.model]: value } : {}),
      parentKey: subagent ? `session:${parentClient}:${parentSessionId}` : undefined,
      subagent: subagent || undefined,
      subagentLabel: subagent ? options.subagentLabel || 'Subagent' : undefined,
      backgroundReview: isBackgroundReviewSession(session) || undefined,
      sortTime: sessionTimestampValue(session),
      title: `${clientLabel} session ${sessionIdLabel(session?.sessionId || key)}`
    };
  }

  function sessionRowsForPeriod(period, options = {}) {
    const labels = options.clientLabels || {};
    const colors = options.clientColors || {};
    const colorForModel = typeof options.modelColor === 'function' ? options.modelColor : null;
    const stable = typeof options.stableColor === 'function' ? options.stableColor : stableColor;
    const palette = options.fallbackColors || fallbackColors;
    const archivedLabel = options.archivedLabel || 'Archived';
    const subagentLabel = options.subagentLabel || 'Subagent';
    const now = options.now || new Date();
    // A day may contain only Claude usage from a bot conversation that used a
    // grok-bot model earlier. Join evidence by conversation id, never by model.
    const botIds = grokBotIdsForPeriod(period, options);
    const rows = Object.entries(period?.sessions || {})
      .map(([key, session]) => {
        session = sessionLive.sessionWithActivity(period, key, session);
        const grokBot = isGrokBotSession(session, key) || (session?.client === 'cursor'
          && botIds.has(textValue(session.sessionId) || key.replace(/^cursor:/, '')));
        if (grokBot && session.grokBotSession !== true) session = { ...session, grokBotSession: true };
        const native = options.nativeSessions?.[key];
        // A resumed source can be active before accounting replaces its archive.
        // Join only presentation activity; the retained token/cost values stay put.
        if (sessionLive.isArchivedSession(session) && native?.client === session.client
          && native.sessionId === session.sessionId && ['running', 'waiting'].includes(sessionActivityState(native, now))) {
          session = { ...session, archived: false, deleted: false, sourceDeleted: false,
            lastUsedAt: native.lastUsedAt, liveActivity: native.liveActivity,
            turnEnded: native.turnEnded, waitingForInput: native.waitingForInput,
            ...(sessionLive.isSessionReasoningEffortClient(session.client) ? { reasoningEffort: native.reasoningEffort ?? null } : {}) };
        }
        if (isReasonixSyntheticSession(session, key)) return null;
        const value = finiteNumber(session?.totalTokens);
        if (value <= 0) return null;
        const { client, titleParts, clientLabel, modelLabel } = sessionTitleParts(session, labels);
        const sessionId = session?.sessionId || key;
        const archived = session?.archived === true || session?.deleted === true || session?.sourceDeleted === true;
        const sessionTitle = sessionTitleForDisplay(session);
        // One derivation, as above. An archived session is idle whatever its
        // timestamp says: the source it was read from is gone, so nothing can
        // still be appending, which is what `sessionActivityState` already
        // enforces through `isArchivedSession`.
        const activityState = sessionActivityState(session, now);
        const running = activityState === 'running';
        const backgroundReview = isBackgroundReviewSession(session);
        const parentSessionId = textValue(session?.parentSessionId);
        const parentClient = textValue(session?.parentClient) || client;
        const subagent = Boolean(parentSessionId) && (parentClient !== client || parentSessionId !== sessionId) && !backgroundReview;
        const activityTime = sessionActivityLabel(session, now);
        const activityParts = [
          archived ? archivedLabel : '',
          activityTime,
          messageLabel(session),
          cacheHitLabel(session),
          tokenRateLabel(session)
        ].filter(Boolean);
        const activitySummary = activityParts.join(' · ');
        if (subagent) activityParts.splice(archived ? 1 : 0, 0, subagentLabel);
        return {
          key: `session:${key}`,
          kind: 'session',
          name: sessionTitle || titleParts.join(' · '),
          modelLabel,
          modelTooltipEntries: sessionModelTooltipEntries(session, {
            unattributedLabel: options.unattributedLabel
          }),
          subtitle: (sessionTitle ? titleParts : activityParts).join(' · '),
          activity: sessionTitle ? activityParts.join(' · ') : undefined,
          // Group members show their role beside the tool/model, separately
          // from the activity line. Keep archive status with the activity.
          activitySummary,
          activityTime,
          archivedLabel: archived ? archivedLabel : '',
          usageMetrics: sessionUsageMetrics(session),
          detail: sessionIdLabel(sessionId),
          value,
          cost: finiteNumber(session?.costUsd),
          ...(session?.unpricedTokens > 0 ? { unpricedTokens: finiteNumber(session.unpricedTokens) } : {}),
          color: colors[client] || (modelLabel && colorForModel ? colorForModel(modelLabel) : stable(key, palette)),
          stale: false,
          archived: archived || undefined,
          running: running || undefined,
          activityState,
          context: sessionContextForRow(session, now),
          reasoningEffort: session.reasoningEffort,
          contextSnapshot: !archived ? sessionLive.sessionContextRow(session) : undefined,
          promptCache: sessionLive.sessionPromptCacheForRow(session, now),
          client,
          clientLabel,
          nativeSessionId: textValue(session?.nativeSessionId),
          t3ThreadId: textValue(session?.t3ThreadId),
          titled: Boolean(sessionTitle) || undefined,
          // Raw per-model tokens, so a group row can rebuild its model label and
          // tooltip from every member rather than from one of them.
          modelTokens: session?.models,
          backgroundReview: backgroundReview || undefined,
          subagent: subagent || undefined,
          subagentLabel: subagent ? subagentLabel : undefined,
          parentKey: subagent ? `session:${parentClient}:${parentSessionId}` : undefined,
          grokBot: grokBot || undefined,
          sortTime: sessionTimestampValue(session),
          title: `${clientLabel} session${sessionIdLabel(sessionId) ? ` ${sessionIdLabel(sessionId)}` : ''}`
        };
      })
      .filter(Boolean);
    const usageKeys = new Set(rows.map((row) => row.key));
    for (const [key, session] of Object.entries(options.nativeSessions || {})) {
      if (usageKeys.has(`session:${key}`)) continue;
      const row = nativeSessionRow(session, key, options, now);
      if (row) rows.push(row);
    }
    return rows.sort((a, b) => b.sortTime - a.sortTime || b.value - a.value || b.cost - a.cost || a.name.localeCompare(b.name));
  }

  function groupBackgroundReviewRows(rows, options = {}) {
    const primary = [];
    const reviews = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      (row?.backgroundReview === true ? reviews : primary).push(row);
    }
    if (reviews.length === 0) return primary;
    return [...primary, sessionSummaryRow(reviews, {
      ...options, id: 'codex-auto-review', client: 'codex',
      label: options.label || 'Codex Auto Review'
    })];
  }

  // A subagent session folds under the session that started it while that
  // parent is visible in the same list. Background reviews keep their own
  // global group and Grok Bot runs theirs, so neither side of a link may be one.
  // A child whose parent is outside the period stays a row of its own.
  function groupSubagentRows(rows, options = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const eligible = row => row?.kind === 'session' && row.backgroundReview !== true && row.grokBot !== true;
    // Independent conversations need neither alias resolution nor parent walks.
    // Keep the full algorithm for repeated native/app identities and any link,
    // including missing or cross-client parents.
    const identities = new Set();
    let needsGrouping = false;
    for (const row of list) {
      if (!eligible(row)) continue;
      const id = sessionConversationIdentity(row);
      if (row.parentKey || identities.has(id)) { needsGrouping = true; break; }
      identities.add(id);
    }
    if (!needsGrouping) return list;
    const byKey = new Map(list.filter(eligible).map(row => [row.key, row]));
    // A verified native conversation can have several independent accounting
    // rollouts. Resolve links through any visible alias, without changing those
    // keys or pretending a continuation is a delegated child.
    const identity = sessionConversationIdentity;
    const aliases = new Map();
    for (const row of byKey.values()) {
      const id = identity(row);
      const previous = aliases.get(id);
      if (!previous || row.key.localeCompare(previous.key) < 0) aliases.set(id, row);
    }
    const parentLinks = new Map();
    const conflicts = new Set();
    for (const row of byKey.values()) {
      if (!row.parentKey) continue;
      const id = identity(row);
      const parent = byKey.get(row.parentKey);
      const link = parent ? identity(parent) : row.parentKey;
      if (link === id) continue;
      if (parentLinks.has(id) && parentLinks.get(id).link !== link) conflicts.add(id);
      else parentLinks.set(id, { link, parentKey: row.parentKey, subagentLabel: row.subagentLabel });
    }
    // Contradictory relationship facts never justify collapsing identities.
    const canonical = row => conflicts.has(identity(row)) ? row : aliases.get(identity(row));
    const rootOf = (row) => {
      const seen = new Set();
      let current = canonical(row);
      while (!seen.has(current.key)) {
        const parentKey = conflicts.has(identity(current)) ? current.parentKey
          : parentLinks.get(identity(current))?.parentKey;
        if (!parentKey) break;
        seen.add(current.key);
        const parent = byKey.get(parentKey);
        if (!parent) break;
        const next = canonical(parent);
        if (seen.has(next.key)) return canonical(row);
        current = next;
      }
      return current;
    };
    const children = new Map();
    const grouped = new Set();
    for (const row of byKey.values()) {
      const root = rootOf(row);
      if (root.key === row.key) continue;
      if (!children.has(root.key)) children.set(root.key, []);
      children.get(root.key).push(row);
      grouped.add(row.key);
    }
    if (grouped.size === 0) return list;
    return list
      .filter(row => !grouped.has(row?.key))
      .map(row => children.has(row?.key) ? subagentGroupRow(row, children.get(row.key), options,
        conflicts.has(identity(row)), conflicts.has(identity(row)) ? undefined : parentLinks.get(identity(row))?.subagentLabel) : row);
  }

  // The group row is the parent's own row with the group's totals: members are
  // disjoint sessions, so their sum is the whole group and nothing is counted
  // twice. Its id moves to the group page, where the parent is listed first.
  function sessionConversationIdentity(row) {
    if (row.t3ThreadId) return `t3:${row.t3ThreadId}`;
    return row.client === 'codex' && row.nativeSessionId ? `codex:${row.nativeSessionId}` : row.key;
  }

  function subagentGroupRow(parent, members, options, splitIdentity = false, rootSubagentLabel) {
    const sameConversation = row => sessionConversationIdentity(row) === sessionConversationIdentity(parent);
    const all = [parent, ...members];
    const main = all.filter(sameConversation).sort((a, b) => finiteNumber(b.sortTime) - finiteNumber(a.sortTime));
    const ordered = all.filter(row => !sameConversation(row)).sort((a, b) => finiteNumber(b.sortTime) - finiteNumber(a.sortTime));
    const groupRows = [...main, ...ordered].map(row => ({ ...row, groupRole: sameConversation(row) ? 'main' : 'subagent' }));
    const subagentCount = new Set(ordered.map(sessionConversationIdentity)).size;
    const value = groupRows.reduce((sum, row) => sum + finiteNumber(row.value), 0);
    const cost = groupRows.reduce((sum, row) => sum + finiteNumber(row.cost), 0);
    const unpricedTokens = groupRows.reduce((sum, row) => sum + finiteNumber(row.unpricedTokens), 0);
    const activityState = ['running', 'waiting'].find(state => groupRows.some(row => row.activityState === state))
      || parent.activityState;
    const countLabel = subagentCount === 0 ? '' : (typeof options.countLabel === 'function'
      ? options.countLabel(subagentCount) : `${subagentCount} subagents`);
    const id = `subagents:${sessionConversationIdentity(parent).replace(/^session:/, '')}${splitIdentity ? `:root:${encodeURIComponent(parent.key)}` : ''}`;
    // The model label and its tooltip describe the tokens the row shows, which
    // are the whole group's, so they are rebuilt from every member's models.
    const models = {};
    for (const row of groupRows) {
      for (const [model, tokens] of Object.entries(row.modelTokens || {})) {
        models[model] = (models[model] || 0) + finiteNumber(tokens);
      }
    }
    const group = { client: parent.client, models, totalTokens: value };
    const modelLabel = sessionModelLabel(group);
    const display = main[0];
    const titleParts = [display.clientLabel || display.client, modelLabel, sessionReasoningEffortForRow(display)].filter(Boolean).join(' · ');
    const usageMetrics = sessionUsageMetrics();
    for (const row of groupRows) {
      const metrics = row.usageMetrics;
      if (!metrics) continue;
      for (const field of Object.keys(usageMetrics)) {
        if (field === 'cacheReported') usageMetrics.cacheReported ||= metrics.cacheReported === true;
        else usageMetrics[field] += finiteNumber(metrics[field]);
      }
    }
    const latest = groupRows.reduce((a, b) => finiteNumber(b.sortTime) > finiteNumber(a.sortTime) ? b : a);
    const activityTime = latest.activityTime || '';
    const archivedLabel = groupRows.every(row => row.archived === true) ? display.archivedLabel : '';
    const activityParts = [
      archivedLabel,
      activityTime,
      messageLabel(usageMetrics),
      cacheHitLabel(usageMetrics),
      tokenRateLabel(usageMetrics)
    ].filter(Boolean);
    const activitySummary = activityParts.join(' · ');
    // Role follows the root conversation's non-conflicting external link, even
    // when its display/canonical continuation has no parent of its own.
    if (rootSubagentLabel) activityParts.splice(archivedLabel ? 1 : 0, 0, rootSubagentLabel);
    const activity = activityParts.join(' · ');
    const base = { ...main[0] };
    delete base.unpricedTokens;
    return {
      ...base,
      key: `session-group:${id}`,
      kind: 'summary',
      // An untitled row is named by client and model, so its name follows the
      // group's models too.
      name: display.titled ? display.name : titleParts,
      modelLabel,
      modelTooltipEntries: options.includeModelTooltip === false ? []
        : sessionModelTooltipEntries(group, { unattributedLabel: options.unattributedLabel }),
      modelTokens: models,
      // Keep the tool/model reading order; the renderer reserves space for the
      // count while the preceding text can shrink in a narrow window.
      subtitle: [display.titled ? titleParts : activity, countLabel].filter(Boolean).join(' · '),
      subtitleIdentity: display.titled ? titleParts : activity,
      activity: display.titled ? activity : undefined,
      subagentLabel: rootSubagentLabel || undefined,
      activitySummary,
      activityTime,
      usageMetrics,
      subagentCountLabel: countLabel,
      subagentCount,
      detail: display.activity ? '' : display.detail,
      groupDetail: countLabel,
      value,
      cost,
      tokenDataUnavailable: groupRows.every(row => row.tokenDataUnavailable === true),
      ...(unpricedTokens > 0 ? { unpricedTokens } : {}),
      barValue: value,
      running: groupRows.some(row => row.running === true) || undefined,
      activityState,
      sortTime: Math.max(...groupRows.map(row => finiteNumber(row.sortTime))),
      sessionGroup: id,
      subagentGroup: true,
      groupRows
    };
  }

  function sessionSummaryRow(rows, options) {
    const value = rows.reduce((sum, row) => sum + finiteNumber(row.value), 0);
    const cost = rows.reduce((sum, row) => sum + finiteNumber(row.cost), 0);
    const unpricedTokens = rows.reduce((sum, row) => sum + finiteNumber(row.unpricedTokens), 0);
    const ordered = [...rows].sort((a, b) => finiteNumber(b.sortTime) - finiteNumber(a.sortTime));
    const latest = ordered[0];
    const sortTime = finiteNumber(latest?.sortTime);
    const countLabel = typeof options.countLabel === 'function'
      ? options.countLabel(rows.length) : `${rows.length} sessions`;
    return {
      key: `session-group:${options.id}`,
      kind: 'summary',
      name: options.label,
      subtitle: typeof options.summaryLabel === 'function'
        ? options.summaryLabel({
          count: rows.length, countLabel,
          latestTime: compactSessionTime(sortTime, options.now || new Date()),
          latestValue: finiteNumber(latest?.value)
        }) : '',
      detail: countLabel,
      value,
      cost,
      ...(unpricedTokens > 0 ? { unpricedTokens } : {}),
      barValue: value,
      color: rows[0]?.color || fallbackColors[0],
      stale: false,
      client: options.client,
      sortTime,
      sessionGroup: options.id,
      groupRows: ordered
    };
  }

  function groupSessionRows(rows, options = {}) {
    const primary = [];
    const bots = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      (row?.grokBot === true ? bots : primary).push(row);
    }
    const grouped = groupBackgroundReviewRows(groupSubagentRows(primary, options.subagents), options.backgroundReviews);
    if (bots.length > 0) grouped.push(sessionSummaryRow(bots, {
      // These source ids include internal subagents, not just user chat rooms.
      countLabel: (count) => `${count} activity records`,
      ...options.grokBot, id: 'cursor-grok-bot', client: 'cursor',
      label: options.grokBot?.label || 'Grok Bot'
    }));
    return grouped.sort((a, b) => finiteNumber(b.sortTime) - finiteNumber(a.sortTime)
      || finiteNumber(b.value) - finiteNumber(a.value) || finiteNumber(b.cost) - finiteNumber(a.cost)
      || a.name.localeCompare(b.name));
  }

  function sessionBreakdownIncomplete(stats, periodName) {
    const omitted = stats?.sessionDetailsOmitted || {};
    if (periodName === 'today') return finiteNumber(omitted.today) > 0;
    if (periodName === 'month') return finiteNumber(omitted.month) > 0;
    return false;
  }

  function archivedSessionCount(stats) {
    const periods = stats?.periods && typeof stats.periods === 'object' ? stats.periods : stats;
    const archivedKeys = new Set();
    for (const periodName of ['today', 'month', 'allTime']) {
      for (const [key, session] of Object.entries(periods?.[periodName]?.sessions || {})) {
        if (isReasonixSyntheticSession(session, key)) continue;
        if (session?.archived !== true && session?.deleted !== true && session?.sourceDeleted !== true) continue;
        archivedKeys.add(`${session?.client || ''}:${session?.sessionId || key}`);
      }
    }
    return archivedKeys.size;
  }

  return {
    setSessionTooltip,
    sessionStatusNode,
    sessionReasoningEffortForRow,
    sessionModelMetadataLabel,
    sessionModelMetadataNode,
    applyBreakdownRowSemantics,
    archivedSessionCount,
    compactSessionTime,
    groupBackgroundReviewRows,
    groupSessionRows,
    groupSubagentRows,
    grokBotSessionIdsForMaps,
    isGrokBotSession,
    sessionRowDetailAvailable,
    handleBreakdownRowKeydown,
    sessionBreakdownIncomplete,
    sessionCacheHitPercent,
    sessionIdLabel,
    sessionDetailIdLabel,
    sessionTitleForDisplay,
    // Exported for the edge dock's session rows: a card that shows the top
    // model reads a different name than the list's "N models" for the same
    // session, so both surfaces compose the label from this one helper.
    sessionModelLabel,
    sessionModelTooltipEntries,
    sessionRowsForPeriod,
    sessionTokenRate
  };
});
