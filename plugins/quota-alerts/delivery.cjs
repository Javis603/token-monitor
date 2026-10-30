'use strict';
// Window-summary formatting adapted from matheusrosendo, PR #538. See NOTICE.md.

async function message(alert, now, locale = 'en') {
  const { t, resolveLocale } = await import('./i18n.mjs');
  locale = resolveLocale(locale);
  const visibleWindows = alert.event === 'low' ? alert.windows : alert.windows.filter(w => w.kind === 'session');
  const percent = value => new Intl.NumberFormat(locale, { maximumFractionDigits: 2, roundingMode: 'floor' }).format(value);
  const windows = visibleWindows.map(w => {
    const resetTime = Date.parse(w.resetsAt);
    const reset = Number.isFinite(resetTime) && resetTime > now ? t(locale, 'resets', {
      time: new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(resetTime)
    }) : '';
    return `${w.displayLabel}: ${t(locale, 'remaining', { percent: percent(w.remainingPercent) })}${reset ? ` (${reset})` : ''}`;
  }).join('\n');
  return { title: t(locale, { low: 'notifyTitle', restored: 'restoredTitle', full: 'fullTitle' }[alert.event], { provider: alert.providerLabel }),
    body: windows || t(locale, 'remaining', { percent: percent(alert.remaining) }) };
}

async function deliver(alert, settings, options) {
  const enabled = alert.event === 'low' ? settings.lowQuota : settings.recovery;
  if (!enabled) return [];
  return deliverPayload(await message(alert, options.now ?? Date.now(), options.locale), options);
}
async function deliverPayload(payload, { host, signal }) {
  if (signal.aborted) return [];
  try {
    await host.call('notify', payload);
    return [{ channel: 'os', status: 'submitted' }];
  } catch (_) {
    return [{ channel: 'os', status: signal.aborted ? 'cancelled' : 'failed' }];
  }
}
async function deliverTest(options) {
  const { t } = await import('./i18n.mjs');
  const payload = { title: t(options.locale, 'testTitle'), body: t(options.locale, 'testBody') };
  // The explicit test action is independent of automatic alert preferences.
  // It does not read quota data or touch the crossing ledger.
  return deliverPayload(payload, options);
}
module.exports = { deliver, message, deliverTest };
