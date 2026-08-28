'use strict';

// Pure threshold evaluation for session-limit alerts.
// No DOM, Electron APIs, or module-level state — designed to be unit-tested.

/**
 * Normalise a raw ntfy topic string into the canonical HTTPS URL that the push
 * endpoint expects, or return null when the value is not a valid ntfy.sh topic.
 *
 * Accepted input forms:
 *   ntfy.sh/<topic>            → https://ntfy.sh/<topic>
 *   https://ntfy.sh/<topic>    → https://ntfy.sh/<topic>   (already valid)
 *   http://ntfy.sh/<topic>     → https://ntfy.sh/<topic>
 *
 * Returns null for empty strings, topics missing the ntfy.sh/ prefix, or any
 * input that produces a URL without a non-empty topic segment.
 */
function normalizeNtfyUrl(rawTopic) {
  const stripped = String(rawTopic || '').trim().replace(/^https?:\/\//, '');
  if (!stripped.startsWith('ntfy.sh/')) return null;
  const topic = stripped.slice('ntfy.sh/'.length).trim();
  if (!topic) return null;
  return `https://ntfy.sh/${topic}`;
}

/**
 * Scan provider stats for session windows below the configured threshold.
 *
 * @param {object}  stats       - The current stats object (stats.limits.providers).
 * @param {object}  settings    - The current settings snapshot.
 * @param {Set}     alertedKeys - Mutable set that tracks already-notified keys.
 *                                Keys are cleared when the window recovers above
 *                                the threshold so the alert re-arms automatically.
 *
 * @returns {{
 *   triggered: Array<{provider:string, remaining:number, windows:Array}>,
 *   anyActive: boolean,
 *   clearVisual: boolean,
 *   ntfyUrl: string|null
 * }}
 *
 * `triggered`   – providers newly below threshold this call (fire notifications).
 * `anyActive`   – at least one provider is currently below threshold.
 * `clearVisual` – caller should remove the visual alert (all features off + had state).
 * `ntfyUrl`     – resolved ntfy endpoint URL, or null when ntfy is inactive.
 */
function evaluateSessionAlerts(stats, settings, alertedKeys) {
  const alertEnabled = Boolean(settings?.sessionAlertEnabled);
  const ntfyEnabled = Boolean(settings?.ntfyEnabled);
  const ntfyUrl = normalizeNtfyUrl(settings?.ntfyTopic);
  const ntfyActive = ntfyEnabled && ntfyUrl != null;

  // Nothing to do: clear any lingering visual state if we previously had keys.
  if (!alertEnabled && !ntfyActive) {
    const hadState = alertedKeys.size > 0;
    if (hadState) alertedKeys.clear();
    return { triggered: [], anyActive: false, clearVisual: hadState, ntfyUrl: null };
  }

  // Only expose the resolved URL when ntfy is actually active.
  const resolvedNtfyUrl = ntfyActive ? ntfyUrl : null;

  const threshold = Number(settings?.sessionAlertThreshold ?? 10);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { triggered: [], anyActive: false, clearVisual: false, ntfyUrl };
  }

  const providers = stats?.limits?.providers || [];
  const triggered = [];
  const activeAlerts = []; // rebuilt every call — all sessions currently below threshold
  let anyActive = false;

  for (const provider of providers) {
    const providerName = String(provider?.provider || '');
    const windows = Array.isArray(provider?.windows) ? provider.windows : [];

    // Snapshot all windows that have a readable percentage for the ntfy message.
    const allWindowInfo = windows
      .filter((w) => w?.remainingPercent != null && Number.isFinite(Number(w.remainingPercent)))
      .map((w) => ({
        kind: String(w.kind || ''),
        remainingPercent: Math.round(Number(w.remainingPercent)),
        resetsAt: w.resetsAt || null
      }));

    windows.forEach((win, i) => {
      if (String(win?.kind || '') !== 'session') return;
      // Guard null explicitly — Number(null) === 0 which is finite, so a
      // missing percentage would be misread as "fully exhausted".
      if (win?.remainingPercent == null) return;
      const remaining = Number(win.remainingPercent);
      if (!Number.isFinite(remaining)) return;
      const key = `${providerName}:${provider.accountKey || i}:session`;

      if (remaining < threshold) {
        anyActive = true;
        // Always track the current below-threshold state so the renderer can
        // update the pulse speed proportionally (activeAlerts is rebuilt every call).
        activeAlerts.push({ provider: providerName, remaining: Math.round(remaining) });
        if (!alertedKeys.has(key)) {
          // Newly crossed — record and queue for notification.
          alertedKeys.add(key);
          triggered.push({
            provider: providerName,
            remaining: Math.round(remaining),
            windows: allWindowInfo
          });
        }
      } else {
        // Session has reset — re-arm so the alert fires again next crossing.
        alertedKeys.delete(key);
      }
    });
  }

  return { triggered, anyActive, activeAlerts, clearVisual: false, ntfyUrl: resolvedNtfyUrl };
}

/**
 * Format the time remaining until a quota window resets as a short human-readable
 * string, e.g. "resets in 23m", "resets in 4h 12m", "resets in 2d 3h".
 * Returns an empty string when resetsAt is absent, unparseable, or already past.
 */
function formatResetsIn(resetsAt) {
  if (!resetsAt) return '';
  const msLeft = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(msLeft) || msLeft <= 0) return '';
  const totalMins = Math.ceil(msLeft / 60_000);
  if (totalMins < 60) return `resets in ${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours < 24) return mins > 0 ? `resets in ${hours}h ${mins}m` : `resets in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `resets in ${days}d ${remHours}h` : `resets in ${days}d`;
}

module.exports = { normalizeNtfyUrl, evaluateSessionAlerts, formatResetsIn };
