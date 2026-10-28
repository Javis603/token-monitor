'use strict';
(() => {
  const api = window.tokenMonitorPluginPage;
  const i18n = window.TokenMonitorI18n;
  const navigation = document.getElementById('pageNavigation');
  const content = document.getElementById('pageContent');
  const error = document.getElementById('pageError');
  let locale = 'en', current = '', navKey = '', appearance = {};
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduceMotion = () => window.TokenMonitorMotionPreference.shouldReduceMotion(appearance.reduceMotion, reduced.matches);
  const scroll = new Map();
  const t = (key, params) => i18n.translate(locale, key, params);
  const host = window.TokenMonitorPluginViews.createPluginViewHost({ document, window, t });
  function fail(reason) { error.hidden = false; error.textContent = window.TokenMonitorPluginViews.actionErrorMessage(reason, t); }
  function applyMotion() {
    document.documentElement.dataset.reduceMotion = reduceMotion() ? 'on' : 'off';
    host.refreshMotion();
  }
  reduced.addEventListener('change', applyMotion);
  function render(meta) {
    appearance = meta.appearance || {};
    const fonts = window.TokenMonitorFontSettings.resolveEffectiveFontSettings(appearance);
    document.documentElement.style.setProperty('--ui-font', fonts.interfaceFont);
    document.documentElement.style.setProperty('--display-font', fonts.displayFont);
    applyMotion();
    locale = meta.locale;
    document.documentElement.lang = locale;
    document.title = `${meta.name} — Token Monitor`;
    document.getElementById('pluginName').textContent = meta.name;
    document.getElementById('pluginDescription').textContent = meta.description;
    document.getElementById('pageStatus').textContent = t(`settings.plugins.status.${meta.status}`);
    navigation.setAttribute('aria-label', t('plugins.page.navigation'));
    for (const { name, value } of window.TokenMonitorThemePresets.themeCssVarEntries(meta.themeColors)) document.documentElement.style.setProperty(name, value);
    const nextKey = JSON.stringify([locale, meta.ref, meta.views]);
    if (navKey !== nextKey) {
      navKey = nextKey; navigation.replaceChildren();
      for (const view of meta.views) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = view.title;
        if (view.ref === meta.ref) button.setAttribute('aria-current', 'page');
        button.addEventListener('click', () => { error.hidden = true; void api.select(view.ref).then(render).catch(fail); });
        navigation.append(button);
      }
    }
    if (current !== meta.ref) {
      if (current) scroll.set(current, content.scrollTop);
      current = meta.ref; content.replaceChildren();
      const mount = document.createElement('div'); content.append(mount); host.mount(mount, current, 'page');
      content.scrollTop = scroll.get(current) || 0;
    }
  }
  api.onMeta(render); api.onViews(payload => {
    host.update(payload);
  });
  void api.metadata().then(render).catch(fail);
})();
