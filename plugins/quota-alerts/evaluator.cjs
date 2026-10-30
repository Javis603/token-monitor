'use strict';
const MAX_AGE_MS = 15 * 60_000;
const percentage = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

function formatResetsIn(resetsAt, now = Date.now()) {
  if (!resetsAt) return '';
  const msLeft = Date.parse(resetsAt) - now;
  if (!Number.isFinite(msLeft) || msLeft <= 0) return '';
  const totalMins = Math.ceil(msLeft / 60_000);
  if (totalMins < 60) return `resets in ${totalMins}m`;
  const hours = Math.floor(totalMins / 60), mins = totalMins % 60;
  if (hours < 24) return mins > 0 ? `resets in ${hours}h ${mins}m` : `resets in ${hours}h`;
  const days = Math.floor(hours / 24), remHours = hours % 24;
  return remHours > 0 ? `resets in ${days}d ${remHours}h` : `resets in ${days}d`;
}

function freshRow(row, now) {
  const time = Date.parse(row.updatedAt);
  return row.status === 'ok' && Number.isFinite(time) && time <= now + 60_000 && now - time <= MAX_AGE_MS;
}

// Aggregate duplicates before evaluating; all session readings must confirm
// recovery. Complete observations form a silent baseline on first sight.
function evaluate(rows, threshold, alerted, now, observations) {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 99) throw Error('Invalid threshold');
  const groups = new Map();
  let skipped = 0;
  for (const row of rows) {
    if (!row.identityAvailable || !row.accountId || !row.provider) { skipped++; continue; }
    const key = JSON.stringify([row.provider, row.accountId]);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, provider: row.provider, providerLabel: row.providerLabel, accountId: row.accountId,
      windows: [], sessionKeys: [], values: [], times: [], latestLowAt: null, complete: true });
    const sessions = row.windows.filter(w => w.kind === 'session');
    // Keep multiplicity when the DTO cannot distinguish equal-name pools.
    // Metrics distinguish quota units; source and reset times do not identify pools.
    for (const w of sessions) group.sessionKeys.push(JSON.stringify([w.metric ?? null, w.displayLabel, w.windowMinutes ?? null]));
    if (!freshRow(row, now) || !sessions.length) { group.complete = false; skipped++; continue; }
    group.times.push(Date.parse(row.updatedAt));
    for (const w of sessions) {
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : null;
      if (!percentage(w.remainingPercent) || (reset !== null && (!Number.isFinite(reset) || reset <= now))) {
        group.complete = false; skipped++; continue;
      }
      group.values.push(w.remainingPercent);
      if (w.remainingPercent < threshold) group.latestLowAt = Math.max(group.latestLowAt ?? 0, Date.parse(row.updatedAt));
    }
    group.windows.push(...row.windows.filter(w => percentage(w.remainingPercent)).map(w => ({
      kind: w.kind, displayLabel: w.displayLabel, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt
    })));
  }
  const active = [], triggered = [];
  for (const group of groups.values()) {
    if (!group.values.length) continue;
    const remaining = Math.min(...group.values), observedAt = Math.min(...group.times);
    const previous = observations.get(group.key);
    const alert = { key: group.key, provider: group.provider, providerLabel: group.providerLabel, accountId: group.accountId, remaining,
      windows: [...new Map(group.windows.map(w => [JSON.stringify(w), w])).values()] };
    if (remaining < threshold) active.push({ ...alert, event: 'low' });
    const latestAt = remaining < threshold ? group.latestLowAt : observedAt;
    if (previous && latestAt <= previous.latestAt) continue;
    if (remaining < threshold) {
      if (!alerted.has(group.key)) {
        alerted.add(group.key); triggered.push({ ...alert, event: 'low' });
      }
    } else if (group.complete && (!previous?.windows || previous.windows === JSON.stringify([...group.sessionKeys].sort()))) {
      alerted.delete(group.key);
    }
    if (!group.complete) {
      // A known low can warn without establishing a complete recovery baseline.
      // Fence older highs and replay using the low reading's own timestamp.
      if (remaining < threshold) observations.set(group.key, { ...previous, latestAt });
      continue;
    }
    const windows = JSON.stringify([...group.sessionKeys].sort());
    // A changed pool set is a new baseline, not proof the removed pool recovered.
    // Reset times are deliberately excluded so normal replenishment still alerts.
    if (previous?.remaining !== undefined && previous.windows === windows) {
      if (remaining === 100 && previous.remaining < 100) triggered.push({ ...alert, event: 'full' });
      else if (remaining >= threshold && previous.remaining < threshold) triggered.push({ ...alert, event: 'restored' });
    }
    observations.set(group.key, { remaining, observedAt, latestAt, windows });
  }
  return { active, triggered, skipped };
}

module.exports = { evaluate, formatResetsIn, MAX_AGE_MS };
