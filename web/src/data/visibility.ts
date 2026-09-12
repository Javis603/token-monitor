import type { LimitProvider } from './types';

const STORAGE_KEY = 'token-monitor-hidden-limits-v1';
const validKey = (key: unknown): key is string => typeof key === 'string' && /^lv1-[0-9a-f]{16}$/.test(key);

// A display fingerprint, not an authentication identifier. Never persist raw
// account labels/keys. Anonymous same-provider rows share a preference because
// their array position, status and quota values cannot identify an account.
export function limitVisibilityKey(row: LimitProvider): string {
  if (validKey(row.visibilityKey)) return row.visibilityKey;
  const identity = JSON.stringify([row.provider?.trim() || 'unknown', row.webAccountKey || row.accountKey || row.accountEmail || row.accountName || row.accountLabel || '']);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < identity.length; index++) {
    first = Math.imul(first ^ identity.charCodeAt(index), 0x01000193);
    second = Math.imul(second ^ identity.charCodeAt(index), 0x85ebca6b);
  }
  return `lv1-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function readHiddenLimits(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? [...new Set(value.filter(validKey))] : [];
  } catch { return []; }
}

export function saveHiddenLimits(keys: string[]): boolean {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys)); return true; }
  catch { return false; }
}
