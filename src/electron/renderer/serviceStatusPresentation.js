'use strict';

(function exposeServiceStatusPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorServiceStatusPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createServiceStatusPresentationApi() {
  // Flashduty's feed keeps Chinese and English together even when its page
  // locale changes. Select the published wording without translating free text.
  function deepseekText(value, language, component = false) {
    const text = String(value || '').trim();
    const match = text.match(/^(.*?)\s*[（(]([^（）]*)[）)]\s*$/u);
    if (!match || !/\p{Script=Han}/u.test(match[1]) || /\p{Script=Han}/u.test(match[2])) return text;
    if (language === 'zh-CN') return match[1].trim();
    const english = match[2].trim();
    if (!component) return english;
    // Model names precede the Chinese service label, e.g.
    // "DeepSeek V4 Pro API服务(API Service)". Keep that identity in English.
    const prefix = match[1].split(/\p{Script=Han}/u)[0].trim();
    const words = prefix.split(/\s+/);
    if (words.at(-1) === english.split(/\s+/)[0]) words.pop();
    return [...words, english].filter(Boolean).join(' ');
  }

  function localizeProvider(provider, language) {
    if (provider.id !== 'deepseek') return provider;
    const descriptions = {
      'All Systems Operational': '所有系统运行正常',
      'Partial Service Outage': '部分服务中断',
      'Degraded Performance': '服务性能下降',
      'Unable to check status': '无法查询状态'
    };
    return {
      ...provider,
      incidentTitle: deepseekText(provider.incidentTitle, language),
      description: language === 'zh-CN'
        ? (descriptions[provider.description] || provider.description)
        : provider.description,
      componentIssues: provider.componentIssues.map((issue) => ({
        ...issue, name: deepseekText(issue.name, language, true)
      }))
    };
  }

  // Split the affected component names into a short visible slice plus an
  // overflow count, so the meta line can show e.g. "Claude Code, API +2" while
  // the full list stays available (and the data is real text for a11y).
  function affectedComponentNames(componentIssues, limit = 2) {
    const names = (Array.isArray(componentIssues) ? componentIssues : [])
      .map((issue) => String(issue?.name || '').trim())
      .filter(Boolean);
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : names.length;
    return {
      all: names,
      visible: names.slice(0, max),
      overflow: Math.max(0, names.length - max)
    };
  }

  function affectedServicesLabel(provider, translate) {
    if (provider.id !== 'opencode') return '';
    const names = affectedComponentNames(provider.componentIssues);
    if (!names.all.length) return '';
    const visible = names.visible.join(translate('serviceStatus.listSeparator'));
    return translate('serviceStatus.services', { names: visible + (names.overflow ? ` +${names.overflow}` : '') });
  }

  // The card's second line leads with the active incident's name when there is
  // one — it's far more useful (and what the official page headlines) than the
  // generic "Partially Degraded Service", which the status pill already conveys.
  // Falls back to the overall status description when no incident is active.
  function statusHeadline(provider) {
    const incident = String(provider?.incidentTitle || '').trim();
    if (incident) return incident;
    return String(provider?.description || '').trim();
  }

  function agoBucket(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (total < 60) return { unit: 'seconds', value: total };
    if (total < 3600) return { unit: 'minutes', value: Math.floor(total / 60) };
    return { unit: 'hours', value: Math.floor(total / 3600) };
  }

  return { affectedComponentNames, affectedServicesLabel, agoBucket, statusHeadline, localizeProvider };
});
