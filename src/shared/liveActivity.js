'use strict';

const DATE_REFERENCE_SECONDS = 978307200;
const VALID_CURRENCIES = new Set(['USD', 'TWD', 'HKD', 'CNY']);
const VALID_LANGUAGES = new Set(['auto', 'en', 'zh-TW', 'zh-CN', 'ja', 'ko']);
const VALID_FIELDS = new Set([
  'primary',
  'secondary',
  'provider',
  'tokens',
  'cost',
  'limit',
  'progress',
  'updated',
  'none'
]);
const VALID_METRICS = new Set(['tokens', 'cost', 'limit']);
const VALID_PERIODS = new Set(['today', 'month', 'allTime']);
const CURRENCY_RATES_FROM_USD = {
  USD: 1,
  TWD: 31.5,
  HKD: 7.8,
  CNY: 6.8
};
const CURRENCY_SYMBOLS = {
  USD: '$',
  TWD: 'NT$',
  HKD: 'HK$',
  CNY: '¥'
};
const PROVIDER_NAMES = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  mimo: 'MiMo',
  grok: 'Grok',
  copilot: 'GitHub Copilot',
  kiro: 'Kiro',
  zai: 'Z.ai',
  zaiteam: 'Z.ai Team',
  volcengine: 'Volcengine',
  qoder: 'Qoder',
  kimi: 'Kimi',
  ollama: 'Ollama',
  thirdparty: 'Custom Provider'
};

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[%,$]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizedString(value, maxLength = 128) {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function normalizedProvider(value) {
  const provider = normalizedString(value, 64).toLowerCase();
  return provider || null;
}

function normalizedField(value, fallback) {
  const field = normalizedString(value, 32);
  return VALID_FIELDS.has(field) ? field : fallback;
}

function languageLocale(languageCode, locale) {
  if (languageCode === 'en') return 'en';
  if (languageCode === 'zh-TW') return 'zh-Hant';
  if (languageCode === 'zh-CN') return 'zh-Hans';
  if (languageCode === 'ja') return 'ja';
  if (languageCode === 'ko') return 'ko';
  return normalizedString(locale, 64) || 'en';
}

function normalizeLiveActivityRegistration(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('invalid_live_activity_registration');
  }
  const activityID = normalizedString(input.activityID, 128);
  const token = normalizedString(input.token, 4096).toLowerCase();
  if (!activityID || !/^[0-9a-f]{32,4096}$/.test(token)) {
    throw new Error('invalid_live_activity_registration');
  }

  const raw = input.preferences && typeof input.preferences === 'object'
    ? input.preferences
    : {};
  const languageCode = VALID_LANGUAGES.has(raw.languageCode)
    ? raw.languageCode
    : 'auto';
  const currencyCode = VALID_CURRENCIES.has(raw.currencyCode)
    ? raw.currencyCode
    : 'USD';

  return {
    activityID,
    token,
    locale: languageLocale(languageCode, input.locale),
    registeredAt: new Date().toISOString(),
    preferences: {
      liveActivityEnabled: raw.liveActivityEnabled !== false,
      livePrimaryMetric: VALID_METRICS.has(raw.livePrimaryMetric)
        ? raw.livePrimaryMetric
        : 'tokens',
      livePeriod: VALID_PERIODS.has(raw.livePeriod)
        ? raw.livePeriod
        : 'today',
      liveProviderID: normalizedProvider(raw.liveProviderID),
      liveShowsSecondaryMetric: raw.liveShowsSecondaryMetric !== false,
      liveShowsProgress: raw.liveShowsProgress !== false,
      liveIconProviderID: normalizedProvider(raw.liveIconProviderID),
      liveCompactTrailingField: normalizedField(raw.liveCompactTrailingField, 'primary'),
      liveExpandedLeadingField: normalizedField(raw.liveExpandedLeadingField, 'provider'),
      liveExpandedCenterField: normalizedField(raw.liveExpandedCenterField, 'primary'),
      liveExpandedTrailingField: normalizedField(raw.liveExpandedTrailingField, 'secondary'),
      liveExpandedBottomField: normalizedField(raw.liveExpandedBottomField, 'progress'),
      liveLockScreenPrimaryField: normalizedField(raw.liveLockScreenPrimaryField, 'primary'),
      liveLockScreenSecondaryField: normalizedField(raw.liveLockScreenSecondaryField, 'secondary'),
      liveLockScreenBottomField: normalizedField(raw.liveLockScreenBottomField, 'progress'),
      currencyCode,
      languageCode
    }
  };
}

function localeFor(registration) {
  return registration.locale || languageLocale(
    registration.preferences?.languageCode,
    undefined
  );
}

function formatNumber(value, locale, options = {}) {
  const number = Number.isFinite(value) ? value : 0;
  try {
    return new Intl.NumberFormat(locale, options).format(number);
  } catch (_) {
    return new Intl.NumberFormat('en', options).format(number);
  }
}

function formatTokens(value, locale) {
  return formatNumber(value, locale, {
    notation: 'compact',
    maximumFractionDigits: 1
  });
}

function formatCurrencyFromUSD(value, currencyCode, locale) {
  const code = VALID_CURRENCIES.has(currencyCode) ? currencyCode : 'USD';
  const converted = (Number.isFinite(value) ? value : 0) * CURRENCY_RATES_FROM_USD[code];
  return CURRENCY_SYMBOLS[code] + formatNumber(converted, locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function languageFamily(locale) {
  const identifier = String(locale || '').toLowerCase();
  if (identifier.startsWith('zh-hant') || identifier.startsWith('zh-tw') || identifier.startsWith('zh-hk')) {
    return 'zh-Hant';
  }
  if (identifier.startsWith('zh')) return 'zh-Hans';
  if (identifier.startsWith('ja')) return 'ja';
  if (identifier.startsWith('ko')) return 'ko';
  return 'en';
}

function formatRemaining(value, locale) {
  const percentage = formatNumber(clamp(Number(value) || 0, 0, 100) / 100, locale, {
    style: 'percent',
    maximumFractionDigits: 0
  });
  switch (languageFamily(locale)) {
    case 'zh-Hant': return `${percentage} 剩餘`;
    case 'zh-Hans': return `${percentage} 剩余`;
    case 'ja': return `残り ${percentage}`;
    case 'ko': return `${percentage} 남음`;
    default: return `${percentage} left`;
  }
}

function providerName(providerID) {
  const normalized = normalizedProvider(providerID);
  if (!normalized) return 'Provider';
  return PROVIDER_NAMES[normalized]
    || normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
}

function modelVendor(modelID) {
  const model = String(modelID || '').toLowerCase();
  if (model === 'auto' || model === 'cursor-auto') return 'cursor';
  if (/claude|anthropic|sonnet|opus|haiku/.test(model)) return 'claude';
  if (/gpt|openai|codex|chatgpt|^o[134](?:-|$)/.test(model)) return 'codex';
  if (/gemini|gemma|google/.test(model)) return 'gemini';
  if (/grok|xai/.test(model)) return 'grok';
  if (/deepseek/.test(model)) return 'deepseek';
  if (/llama|meta/.test(model)) return 'meta';
  if (/mistral|mixtral|codestral/.test(model)) return 'mistral';
  if (/qwen|qwq|qvq/.test(model)) return 'qwen';
  if (/kimi|moonshot/.test(model)) return 'kimi';
  if (/chatglm|glm-|z\.ai|zhipu/.test(model)) return 'zai';
  if (/cohere|command-r/.test(model)) return 'cohere';
  if (/mimo|xiaomi/.test(model)) return 'xiaomi';
  if (/minimax|abab/.test(model)) return 'minimax';
  if (/doubao|^seed-/.test(model)) return 'doubao';
  if (model === 'big-pickle') return 'opencode';
  return null;
}

function providerWindowRemaining(provider, window) {
  const explicit = asNumber(window?.remainingPercent);
  if (explicit !== null) return clamp(explicit, 0, 100);
  const usedPercent = asNumber(window?.usedPercent);
  if (usedPercent !== null) return clamp(100 - usedPercent, 0, 100);
  if (window?.metric !== 'credits') return null;
  const amount = asNumber(window?.remaining ?? provider?.balance?.amount);
  if (amount === null) return null;
  const spend = Math.max(0, asNumber(provider?.balance?.monthSpend) || 0);
  const funds = Math.max(0, amount);
  if (funds === 0) return 0;
  return clamp(funds / (funds + spend) * 100, 0, 100);
}

function displayWindows(provider) {
  return (Array.isArray(provider?.windows) ? provider.windows : []).filter((window) => (
    window?.metric === 'credits'
      || providerWindowRemaining(provider, window) !== null
      || asNumber(window?.remaining) !== null
      || asNumber(window?.used) !== null
      || String(window?.detail || '').trim() !== ''
  ));
}

function preferredLimit(stats, providerID) {
  const providers = Array.isArray(stats?.limits?.providers)
    ? stats.limits.providers
    : [];
  if (providerID) {
    const selected = providers.find((provider) => (
      normalizedProvider(provider?.provider) === providerID
    ));
    if (selected) return selected;
  }
  return providers.reduce((best, provider) => {
    if (!best) return provider;
    const left = Math.min(...displayWindows(provider)
      .map((window) => providerWindowRemaining(provider, window))
      .filter((value) => value !== null));
    const right = Math.min(...displayWindows(best)
      .map((window) => providerWindowRemaining(best, window))
      .filter((value) => value !== null));
    if (!Number.isFinite(left)) return best;
    if (!Number.isFinite(right) || left < right) return provider;
    return best;
  }, null) || providers[0] || null;
}

function activityUpdatedAt(stats, nowMs) {
  const parsed = Date.parse(String(stats?.updatedAt || ''));
  const milliseconds = Number.isNaN(parsed) ? nowMs : parsed;
  return Math.floor(milliseconds / 1000) - DATE_REFERENCE_SECONDS;
}

function buildLiveActivityContentState(stats, registration, nowMs = Date.now()) {
  const preferences = registration?.preferences || {};
  const locale = localeFor(registration || {});
  const period = stats?.periods?.[preferences.livePeriod] || {};
  const tokensValue = formatTokens(asNumber(period.totalTokens) || 0, locale);
  const costValue = formatCurrencyFromUSD(
    asNumber(period.costUsd) || 0,
    preferences.currencyCode,
    locale
  );
  const selectedLimit = preferredLimit(stats, preferences.liveProviderID);
  const selectedProviderID = normalizedProvider(selectedLimit?.provider);
  const selectedWindow = displayWindows(selectedLimit)[0] || null;
  const remaining = selectedWindow
    ? providerWindowRemaining(selectedLimit, selectedWindow)
    : null;
  const limitValue = remaining === null ? null : formatRemaining(remaining, locale);
  const modelIDs = Object.keys(period.models || {});
  const dataProviderID = selectedProviderID
    || preferences.liveProviderID
    || modelVendor(modelIDs[0]);
  const iconProviderID = preferences.liveIconProviderID
    || dataProviderID
    || modelVendor(modelIDs[0]);
  const dataProviderName = providerName(dataProviderID);

  let primaryLabel = 'Tokens';
  let primaryValue = tokensValue;
  let primaryProgress = null;
  if (preferences.livePrimaryMetric === 'cost') {
    primaryLabel = 'Cost';
    primaryValue = costValue;
  } else if (preferences.livePrimaryMetric === 'limit' && remaining !== null) {
    primaryLabel = dataProviderName;
    primaryValue = limitValue;
    primaryProgress = remaining / 100;
  }

  const configuredFields = [
    preferences.liveCompactTrailingField,
    preferences.liveExpandedLeadingField,
    preferences.liveExpandedCenterField,
    preferences.liveExpandedTrailingField,
    preferences.liveExpandedBottomField,
    preferences.liveLockScreenPrimaryField,
    preferences.liveLockScreenSecondaryField,
    preferences.liveLockScreenBottomField
  ];
  const showSecondary = preferences.liveShowsSecondaryMetric
    || configuredFields.includes('secondary');
  const showProgress = preferences.liveShowsProgress
    || configuredFields.includes('progress');
  let secondaryLabel = null;
  let secondaryValue = null;
  if (showSecondary && preferences.livePrimaryMetric === 'limit') {
    secondaryLabel = 'Cost';
    secondaryValue = costValue;
  } else if (showSecondary && remaining !== null) {
    secondaryLabel = dataProviderName;
    secondaryValue = limitValue;
  }

  return {
    primaryLabel,
    primaryValue,
    secondaryLabel,
    secondaryValue,
    progress: showProgress ? primaryProgress : null,
    updatedAt: activityUpdatedAt(stats, nowMs),
    providerID: dataProviderID || null,
    providerName: dataProviderID ? dataProviderName : null,
    iconProviderID: iconProviderID || null,
    tokensValue,
    costValue,
    limitValue,
    compactTrailingField: preferences.liveCompactTrailingField,
    expandedLeadingField: preferences.liveExpandedLeadingField,
    expandedCenterField: preferences.liveExpandedCenterField,
    expandedTrailingField: preferences.liveExpandedTrailingField,
    expandedBottomField: preferences.liveExpandedBottomField,
    lockScreenPrimaryField: preferences.liveLockScreenPrimaryField,
    lockScreenSecondaryField: preferences.liveLockScreenSecondaryField,
    lockScreenBottomField: preferences.liveLockScreenBottomField
  };
}

module.exports = {
  buildLiveActivityContentState,
  normalizeLiveActivityRegistration
};
