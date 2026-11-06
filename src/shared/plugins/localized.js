'use strict';

// Plugin-supplied display strings: either a plain string or a map of locale
// tags to strings. Lookups fall back from the exact tag to its language, then
// to English, then to whatever the author wrote first, so a plugin that ships
// only one language still reads in every app language.
(function exposePluginLocalized(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginLocalized = api;
})(typeof window !== 'undefined' ? window : null, function createPluginLocalizedApi() {
  const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
  const MAX_LOCALES = 16;

  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    // Control characters never render usefully and can hide text from review.
    return value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim().slice(0, max);
  }

  // Returns a frozen { tag: text } map, or null when nothing usable remains.
  function normalizeLocalized(value, max = 120) {
    if (typeof value === 'string') {
      const text = cleanText(value, max);
      return text ? Object.freeze({ '': text }) : null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out = {};
    let count = 0;
    for (const [tag, raw] of Object.entries(value)) {
      if (count >= MAX_LOCALES) break;
      if (!LOCALE_RE.test(tag)) continue;
      const text = cleanText(raw, max);
      if (!text) continue;
      out[tag] = text;
      count += 1;
    }
    return count ? Object.freeze(out) : null;
  }

  function localize(value, locale = 'en') {
    if (!value) return '';
    if (typeof value === 'string') return value;
    const tag = String(locale || 'en');
    const language = tag.split('-')[0];
    if (value[tag]) return value[tag];
    const sameLanguage = Object.keys(value).find((key) => key.split('-')[0] === language);
    if (sameLanguage) return value[sameLanguage];
    if (value.en) return value.en;
    if (value['']) return value[''];
    const first = Object.keys(value)[0];
    return first ? value[first] : '';
  }

  return { normalizeLocalized, localize, cleanText };
});
