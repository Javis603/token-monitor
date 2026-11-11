'use strict';
function amount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('invalid-credit-response');
  return value;
}
function parseBalance(body, now = Date.now()) {
  if (body?.object !== 'credit_summary' || !Array.isArray(body.grants?.data)) throw Error('invalid-credit-response');
  const balance = { available: amount(body.total_available), granted: amount(body.total_granted), used: amount(body.total_used),
    paidAvailable: Object.hasOwn(body, 'total_paid_available') ? amount(body.total_paid_available) : null,
    currency: 'USD', expiresAt: null, meterTotal: null, usableGrants: [] };
  const expiry = [], usableGrants = [];
  let activeTotal = 0, activeRemaining = 0, consistent = true;
  for (const grant of body.grants.data) {
    const remaining = amount(grant.grant_amount) - amount(grant.used_amount);
    if (remaining < 0) consistent = false;
    for (const field of ['effective_at', 'expires_at']) if (grant[field] !== null && (typeof grant[field] !== 'number' || !Number.isFinite(grant[field]) || grant[field] < 0)) throw Error('invalid-credit-response');
    const active = grant.is_scheduled !== true && grant.is_held_for_prepaid_transition !== true
      && (grant.effective_at === null || grant.effective_at * 1000 <= now)
      && (grant.expires_at === null || grant.expires_at * 1000 > now);
    // A depleted grant is no longer part of the usable credit pool, even
    // when it has no expiry. Keep lifetime totals separate from this meter.
    if (active && remaining > 0) {
      activeTotal += grant.grant_amount; activeRemaining += remaining;
      usableGrants.push({ remaining, expiresAt: grant.expires_at === null ? null : new Date(grant.expires_at * 1000).toISOString() });
      if (remaining > 0 && grant.expires_at !== null) expiry.push(grant.expires_at);
    }
  }
  if (expiry.length) balance.expiresAt = new Date(Math.min(...expiry) * 1000).toISOString();
  // This is the currently usable grant pool, never total_granted (lifetime).
  // Keep the authoritative amount even when grants cannot explain its scope.
  if (consistent && balance.paidAvailable === 0 && Number.isFinite(activeTotal) && activeTotal > 0
    && Math.abs(activeRemaining - balance.available) <= 0.000001 && balance.available <= activeTotal) {
    balance.meterTotal = activeTotal;
    balance.usableGrants = usableGrants.sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999'));
  }
  return balance;
}
module.exports = { parseBalance };
