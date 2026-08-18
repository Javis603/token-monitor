'use strict';

// Renderer for the Windows taskbar widget window. Fed by the same stats
// payloads as the main window (via the shared preload bridge): one-shot on
// load through `getStats`, plus a live subscription to `stats:push`.
// Clicking the overlay cycles today → this month → all time and persists the
// selected range through `updateSettings`.

(function () {
  const api = window.tokenMonitor;
  const periodApi = window.TokenMonitorTaskbarWidgetPeriod;
  const i18n = window.TokenMonitorI18n;

  let period = periodApi ? periodApi.normalizeTaskbarWidgetPeriod() : 'allTime';
  let lastStats = null;
  let locale = 'en';

  function formatNumber(value) {
    return Math.round(Number(value || 0)).toLocaleString('en-US');
  }

  function resolveLocale(settings) {
    if (!i18n || typeof i18n.resolveLocale !== 'function') return 'en';
    return i18n.resolveLocale(settings && settings.language, [navigator.language]);
  }

  function periodLabel(value) {
    const key = periodApi && periodApi.taskbarWidgetPeriodLabelKey
      ? periodApi.taskbarWidgetPeriodLabelKey(value)
      : 'trayComposer.period.allTime';
    if (!i18n || typeof i18n.translate !== 'function') return key;
    return i18n.translate(locale, key);
  }

  function applyTranslations() {
    if (!i18n || typeof i18n.applyTranslations !== 'function') return;
    i18n.applyTranslations(document, locale);
  }

  function render(raw) {
    const stats = raw && raw.data && raw.data.stats ? raw.data.stats : raw;
    if (stats && stats.periods) lastStats = stats;
    const source = (stats && stats.periods) ? stats : lastStats;
    if (!source || !source.periods) return;
    const tokens = periodApi
      ? periodApi.taskbarWidgetPeriodTokens(source, period)
      : Number(source.periods[period] && source.periods[period].totalTokens || 0);
    document.getElementById('total').textContent = formatNumber(tokens) + ' tokens';
    document.getElementById('period').textContent = periodLabel(period);
  }

  function paint() {
    applyTranslations();
    if (lastStats) render(lastStats);
    else document.getElementById('period').textContent = periodLabel(period);
  }

  function applySettings(settings) {
    if (!settings) return;
    locale = resolveLocale(settings);
    if (settings.taskbarWidgetPeriod !== undefined && periodApi) {
      period = periodApi.normalizeTaskbarWidgetPeriod(settings.taskbarWidgetPeriod);
    }
    paint();
  }

  function cyclePeriod() {
    if (!periodApi) return;
    period = periodApi.nextTaskbarWidgetPeriod(period);
    paint();
    if (api && typeof api.updateSettings === 'function') {
      api.updateSettings({ taskbarWidgetPeriod: period }).catch(() => {});
    }
  }

  const widget = document.getElementById('widget');
  if (widget) {
    // Cycle on pointerup instead of click or pointerdown. The overlay is a
    // layered window whose surface pixels outside the text/icon glyphs are
    // fully transparent, so Windows (and Chromium's own browser-side hit
    // test) routinely fail to deliver the press (no pointerdown, no click)
    // for those parts of the strip — exactly the "click does nothing" bug.
    // The release (pointerup) is delivered for every press on the window
    // regardless of the pixel alpha, so cycling on pointerup makes the whole
    // module switch today / this month / all time again. button 0 = primary.
    widget.addEventListener('pointerup', (event) => {
      if (event.button !== 0) return;
      cyclePeriod();
    });
  }

  if (api) {
    if (typeof api.getSettings === 'function') {
      api.getSettings().then(applySettings).catch(() => {});
    }
    if (typeof api.onSettingsPush === 'function') {
      api.onSettingsPush(applySettings);
    }
    if (typeof api.getStats === 'function') {
      api.getStats().then(render).catch(() => {});
    }
    if (typeof api.onStatsPush === 'function') {
      api.onStatsPush(render);
    }
  }
})();
