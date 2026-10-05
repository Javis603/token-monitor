(function () {
  'use strict';
  const button = document.getElementById('cloudUsageButton');
  if (!button || !window.tokenMonitor?.openCloudUsage) return;
  function translate(settings) {
    const locale = window.TokenMonitorI18n?.resolveLocale(settings?.locale || settings?.language, navigator.languages) || 'en';
    const chinese = locale.startsWith('zh');
    button.textContent = chinese ? '云端' : 'Cloud';
    button.title = chinese ? 'Codex 云端实时 Token（独立计数）' : 'Codex cloud live tokens (separate counters)';
    button.setAttribute('aria-label', button.title);
  }
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { await window.tokenMonitor.openCloudUsage(); }
    catch (_) { button.title = 'Cloud view unavailable — restart Token Monitor'; }
    finally { button.disabled = false; }
  });
  window.tokenMonitor.getSettings().then(translate).catch(() => translate({}));
  window.tokenMonitor.onSettingsPush?.(translate);
})();
