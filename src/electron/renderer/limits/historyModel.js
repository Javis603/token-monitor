'use strict';

(function expose(root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('../../../shared/limits/windowLabels') : root.TokenMonitorLimitWindowLabels);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitsHistoryModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi(windowLabels) {
  function sameCycle(a, b, resetToleranceMs = 1000) {
    if (a.unit !== b.unit || a.balance !== b.balance) return false;
    if ((a.basis || '') !== (b.basis || '')) return false;
    if (a.reset !== b.reset && !(resetToleranceMs > 0 && Number.isFinite(a.reset) && Number.isFinite(b.reset)
      && Math.abs(a.reset - b.reset) <= resetToleranceMs)) return false;
    if (a.reset !== null && a.reset > a.at && a.reset <= b.at) return false;
    if (b.reset !== null && b.reset > a.at && b.reset <= b.at) return false;
    return b.balance ? b.value <= a.value : b.value >= a.value;
  }

  function historyReadings(window) {
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const credits = window.metric === 'credits';
    const spend = window.metric === 'spend';
    const basis = finite(window.limit) && window.limit > 0 ? String(window.limit) : '';
    const rawValue = credits ? window.remaining : spend ? window.used : null;
    const raw = (credits || spend) && finite(rawValue)
      ? { value: rawValue, unit: window.currency || 'credits', balance: credits, ...(basis ? { basis } : {}) } : null;
    let used = finite(window.usedPercent) ? window.usedPercent
      : finite(window.remainingPercent) ? 100 - window.remainingPercent : null;
    if (used === null && raw && basis) used = (credits ? 1 - raw.value / window.limit : raw.value / window.limit) * 100;
    if (used !== null && (!(credits || spend) || window.showMeter !== false)) {
      return { primary: { value: Math.max(0, Math.min(100, used)), unit: 'pp', balance: false, ...(basis ? { basis } : {}) }, raw };
    }
    return { primary: raw, raw: null };
  }

  function dayKey(at) {
    const date = new Date(at);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function bucketKey(at, grain) {
    if (grain === 'day') return dayKey(at);
    // Include the UTC offset so repeated DST hours remain separate buckets.
    const date = new Date(at);
    return `${dayKey(at)}T${String(date.getHours()).padStart(2, '0')}:${date.getTimezoneOffset()}`;
  }

  function trendBounds(window, now = Date.now(), provider = '') {
    const reset = Date.parse(window.resetsAt);
    // Daily/weekly kinds identify a fixed duration even if minutes are absent.
    // Session duration is provider-specific. Reuse the providers explicitly
    // named five-hour by the shared labels; Claude's five_hour mapper also
    // emits a session window without explicit minutes.
    const fiveHour = provider === 'claude' || windowLabels.FIVE_HOUR_WINDOW_PROVIDERS.has(provider);
    const knownMinutes = window.kind === 'weekly' ? 10080 : window.kind === 'daily' ? 1440
      : fiveHour && window.kind === 'session' ? 300 : 0;
    const duration = (window.windowMinutes > 0 ? window.windowMinutes : knownMinutes) * 60_000;
    if (Number.isFinite(reset) && duration > 0) return { start: reset - duration, end: reset, cycle: true };
    return { start: now - 14 * 86400_000, end: now, cycle: false };
  }

  // Compares the current remaining quota with the even-use guide. Returns the
  // signed gap in percentage points: positive means quota remains ahead of the
  // guide (slower consumption), negative means it is behind (faster). This is
  // the same direction as the charted remaining curve, so a line above the guide
  // can never disagree with the card's pace sign. Returns null outside the
  // advertised cycle or when the window has no percentage reading.
  function windowPace(window, now = Date.now(), provider = '') {
    const bounds = trendBounds(window, now, provider);
    if (!bounds.cycle || bounds.end <= bounds.start) return null;
    if (now < bounds.start || now > bounds.end) return null;
    const reading = historyReadings(window).primary;
    if (!reading || reading.unit !== 'pp') return null;
    const elapsed = Math.max(0, Math.min(bounds.end - bounds.start, now - bounds.start));
    const expectedUsed = (elapsed / (bounds.end - bounds.start)) * 100;
    const actualUsed = reading.value;
    const expectedRemaining = 100 - expectedUsed;
    const actualRemaining = 100 - actualUsed;
    return {
      expectedUsed,
      actualUsed,
      expectedRemaining,
      actualRemaining,
      delta: Math.round(actualRemaining - expectedRemaining)
    };
  }

  // Chooses the shared time bounds when overlaying multiple percentage windows on
  // one trend plot (e.g. 5-hour session + 7-day weekly). When `rangeMode === 'recent'`
  // or no window has a known cycle, returns the recent range (auto-fitted if all
  // observations are much newer than 14 days so newly collected streams are not
  // squashed into a 1px dot at the right edge).
  function combinedTrendBounds(entries, now = Date.now(), provider = '', { rangeMode = 'cycle', primaryEntry = null } = {}) {
    const list = Array.isArray(entries) && entries.length ? entries : (primaryEntry ? [primaryEntry] : []);
    if (rangeMode !== 'recent') {
      const cycleEntries = list
        .map(entry => ({ entry, bounds: trendBounds(entry.window, now, provider) }))
        .filter(item => item.bounds.cycle);
      if (cycleEntries.length > 0) {
        // Prefer the longest cycle among percentage windows (e.g. 7-day weekly over
        // 5-hour session) so short rolling sessions appear inside the full weekly cycle
        // just like Magpie's combined trend view.
        cycleEntries.sort((a, b) => (b.bounds.end - b.bounds.start) - (a.bounds.end - a.bounds.start));
        return { ...cycleEntries[0].bounds, guideEntry: cycleEntries[0].entry };
      }
    }
    const defaultStart = now - 14 * 86400_000;
    const allPoints = list.flatMap(entry => entry.recentPoints || entry.points || [])
      .filter(p => p.at >= defaultStart && p.at <= now);
    if (allPoints.length > 0 && rangeMode !== 'recent') {
      const earliest = Math.min(...allPoints.map(p => p.at));
      const span = Math.max(now - earliest, 6 * 3600_000);
      if (span < 3 * 86400_000) {
        const dayStart = new Date(earliest);
        dayStart.setHours(0, 0, 0, 0);
        return { start: Math.max(defaultStart, Math.min(dayStart.getTime(), now - 6 * 3600_000)), end: now, cycle: false, guideEntry: null };
      }
    }
    return { start: defaultStart, end: now, cycle: false, guideEntry: null };
  }

  function distribution(points, { grain = 'day', day = null, now = Date.now(), days = 14 } = {}) {
    const start = new Date(now);
    if (grain === 'hour' && day) {
      const [year, month, date] = day.split('-').map(Number);
      start.setFullYear(year, month - 1, date);
    } else start.setDate(start.getDate() - days + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + (grain === 'hour' ? 1 : days));
    const buckets = [];
    for (let cursor = new Date(start); cursor < end && cursor.getTime() <= now;) {
      const next = new Date(cursor);
      if (grain === 'hour') next.setTime(cursor.getTime() + 3600_000);
      else next.setDate(cursor.getDate() + 1);
      buckets.push({ key: bucketKey(cursor, grain), at: cursor.getTime(), end: Math.min(next.getTime(), now), value: null, observations: 0, uncertain: false });
      cursor = next;
    }
    const byKey = new Map(buckets.map(b => [b.key, b]));
    let unallocated = 0;
    let resets = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], previous = points[i - 1];
      if (p.at > now) continue;
      const bucket = byKey.get(bucketKey(p.at, grain));
      if (p.uncertainUntil !== null && p.uncertainUntil !== undefined) {
        buckets.filter(b => b.at <= p.uncertainUntil && b.end >= p.at).forEach(b => { b.uncertain = true; });
      }
      if (bucket) bucket.observations += p.coveredFrom !== undefined
        && bucketKey(p.coveredFrom, grain) !== bucketKey(p.at, grain) ? 1 : p.observations || 1;
      if (!previous) continue;
      const affected = buckets.filter(b => b.at <= p.at && b.end >= previous.at);
      if (!affected.length) continue;
      const allowanceRecovered = p.allowanceMissingBefore === true && sameCycle(previous, p);
      // An ordinary sampling gap still establishes a net change between
      // compatible endpoints. Only a confirmed interruption blocks attribution.
      const comparable = sameCycle(previous, p) && (previous.uncertainUntil == null || allowanceRecovered);
      if (allowanceRecovered) affected.forEach(b => { b.uncertain = true; });
      if (p.uncertainBefore && !comparable) {
        affected.forEach(b => { b.uncertain = true; });
        if (sameCycle(previous, p)) unallocated += Math.max(0, p.balance ? previous.value - p.value : p.value - previous.value);
        continue;
      }
      if ((previous.basis || '') !== (p.basis || '')) {
        affected.forEach(b => { b.uncertain = true; });
        continue;
      }
      if (!sameCycle(previous, p)) {
        resets += 1;
        affected.forEach(b => { b.uncertain = true; });
        continue;
      }
      const delta = Math.max(0, p.balance ? previous.value - p.value : p.value - previous.value);
      // Comparable endpoints establish net change inside one bucket even when
      // sampling was interrupted. Cross-bucket changes cannot be apportioned.
      const gap = p.breakBefore === true || !coveredInterval(previous, p)
        && p.at - previous.at > Math.max(previous.interval, p.interval) * 2.5;
      if (gap) affected.forEach(b => { b.uncertain = true; });
      if (gap && !comparable || bucketKey(previous.at, grain) !== bucketKey(p.at, grain)) {
        unallocated += delta;
        // A timely unchanged reading over a bucket boundary adds no unknown
        // quantity, but cannot establish a measured interval inside a bucket.
        if (gap || delta > 0) affected.forEach(b => { b.uncertain = true; });
      } else if (bucket) bucket.value = (bucket.value ?? 0) + delta;
    }
    return { buckets, unallocated, resets };
  }

  function segments(points) {
    const result = [];
    for (const point of points) {
      const segment = result.at(-1), previous = segment?.at(-1);
      // Failed attempts only mark breakBefore. A conflict or confirmed missing
      // quota also records uncertainUntil on the preceding observation.
      const confirmedBreak = point.breakBefore === true && previous?.uncertainUntil != null && !point.allowanceMissingBefore;
      // Drawing and accounting share the same one-second countdown rounding
      // tolerance, while either crossed reset deadline still separates cycles.
      if (!previous || !sameCycle(previous, point, 1000) || confirmedBreak) result.push([point]);
      else segment.push(point);
    }
    return result;
  }

  function hourStart(at) {
    const date = new Date(at);
    // Subtract from the actual instant to preserve repeated DST hours.
    return at - ((date.getMinutes() * 60 + date.getSeconds()) * 1000 + date.getMilliseconds());
  }

  function coveredInterval(a, b) {
    return b.coveredFrom === a.at && b.maxGap > 0
      && b.maxGap <= Math.max(a.interval, b.interval) * 2.5;
  }

  function observationPoints(runs) {
    const points = [];
    let interrupted = false;
    let allowanceMissing = false;
    for (const run of runs) {
      let first = true;
      for (const part of run.coverage) {
        const point = { at: part.at, value: run.value, reset: run.reset, interval: run.interval, ...(run.basis ? { basis: run.basis } : {}),
          unit: run.unit, balance: run.balance, ...(first && run.uncertainBefore ? { uncertainBefore: true } : {}),
          ...(interrupted ? { breakBefore: true } : {}), ...(allowanceMissing ? { allowanceMissingBefore: true } : {}) };
        points.push(point);
        if (part.until > part.at) points.push({ ...point, at: part.until, breakBefore: false,
          ...(point.uncertainBefore ? { uncertainBefore: false } : {}), ...(point.allowanceMissingBefore ? { allowanceMissingBefore: false } : {}),
          coveredFrom: part.at, maxGap: part.maxGap, observations: part.samples - 1 });
        interrupted = false;
        allowanceMissing = false;
        first = false;
      }
      // A date-range query can return only an earlier portion of a flat run.
      // Attach the conflict to its actual last observation, never that cutoff.
      if (run.uncertainUntil !== null && run.uncertainUntil !== undefined && points.at(-1)?.at === run.at) {
        points.at(-1).uncertainUntil = run.uncertainUntil;
      }
      interrupted = run.breakAfter === true;
      allowanceMissing = run.allowanceMissingAfter === true;
    }
    return points;
  }

  return { sameCycle, historyReadings, dayKey, trendBounds, combinedTrendBounds, windowPace, bucketKey, hourStart, observationPoints, distribution, segments };
});
