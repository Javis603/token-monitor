'use strict';
// Shared finite reading formatter. Units in renderer descriptors are already localized.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginNumberFormat = api;
})(typeof window !== 'undefined' ? window : null, () => {
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const numberFormats = new Map();
function numberFormatter(locale, options) {
  const key = JSON.stringify([locale, options]);
  if (numberFormats.has(key)) return numberFormats.get(key);
  let formatter;
  try { formatter = new Intl.NumberFormat(locale || 'en', options); }
  catch { formatter = new Intl.NumberFormat('en', options); }
  if (numberFormats.size >= 64) numberFormats.delete(numberFormats.keys().next().value);
  numberFormats.set(key, formatter);
  return formatter;
}

function formatNumber(value, locale, digits = 1) {
  return numberFormatter(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatValue(value, binding = {}, locale = 'en') {
  if (value === null || value === undefined) return binding.fallback !== undefined ? String(binding.fallback) : '—';
  const unit = typeof binding.unit === 'string' ? binding.unit : '';
  const withUnit = (text) => (unit ? `${text} ${unit}` : text);
  const number = finite(value);
  switch (binding.fmt) {
    case 'percent':
      return number === null ? '—' : `${formatNumber(number, locale, binding.digits ?? 0)}%`;
    case 'bytes': {
      if (number === null) return '—';
      let scaled = Math.abs(number);
      let index = 0;
      while (scaled >= 1024 && index < BYTE_UNITS.length - 1) { scaled /= 1024; index += 1; }
      return `${number < 0 ? '-' : ''}${formatNumber(scaled, locale, binding.digits ?? (index ? 1 : 0))} ${BYTE_UNITS[index]}`;
    }
    case 'compact':
      return number === null ? '—' : withUnit(numberFormatter(locale, { notation: 'compact', maximumFractionDigits: binding.digits ?? 1 }).format(number));
    case 'rate':
      return number === null ? '—' : `${numberFormatter(locale, { notation: 'compact', maximumFractionDigits: binding.digits ?? 1 }).format(number)}/s`;
    case 'duration':
      return number === null ? '—' : formatDuration(number);
    case 'text':
      return withUnit(String(value).slice(0, 160));
    case 'number':
    default:
      if (number !== null) return withUnit(formatNumber(number, locale, binding.digits ?? 1));
      return withUnit(typeof value === 'string' ? value.slice(0, 160) : '—');
  }
}

return { finite, formatNumber, formatDuration, formatValue };
});
