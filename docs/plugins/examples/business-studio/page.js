/* global document */
'use strict';
// One query/subscription path for every surface. No polling or independent probes.
const $ = id => document.getElementById(id);
let saved, draftBase, dirty = false, query, cursor = null, stop, epoch = 0, request = 0;
let selectedPeriod, selectedSize, originalPeriod, initialized = false, browsing = false, updatesPending = false;
function message(error) { return error?.message || String(error); }
function settings(value, force = false) {
  if (saved && value.revision < saved.revision) return;
  saved = value;
  if (!dirty || force) {
    dirty = false; draftBase = value;
    $('period').value = value.values.period;
    $('pageSize').value = value.values.pageSize;
    $('settingsStatus').textContent = value.readOnly ? 'Newer schema: update the plugin before editing.' : 'Saved preferences loaded.';
  } else $('settingsStatus').textContent = 'Preferences changed elsewhere. Your draft is kept; reload before saving.';
  $('save').disabled = value.readOnly || !dirty;
  if (initialized && (selectedPeriod !== value.values.period || selectedSize !== value.values.pageSize)) start();
}
function render(value) {
  cursor = value.pageInfo?.nextCursor || null;
  $('next').disabled = !cursor;
  $('rows').replaceChildren();
  if (value.availability !== 'available') {
    $('summary').textContent = value.availability === 'rateLimited'
      ? 'Updates are busy. This subscription will retry automatically.'
      : `Data unavailable: ${value.availability}. Refresh to retry.`;
    return;
  }
  const coverage = value.aggregateCoverage;
  $('summary').textContent = `${value.rows.length} rows on this page / ${coverage.totalRows ?? 'unknown'} authorized rows · ${coverage.kind} · ${value.freshness?.state || 'unknown'} · snapshot ${value.snapshotRevision}${updatesPending ? ' · New data available. Refresh when ready.' : ''}`;
  for (const row of value.rows) {
    const node = document.createElement('article');
    const title = document.createElement('strong');
    title.textContent = row.title || row.planName || row.client || row.model || row.displayName || row.platform || 'Device';
    const detail = document.createElement('p');
    if (query.resource === 'devices') detail.textContent = `${row.osName || 'OS unknown'} · ${row.stale === true ? 'stale' : 'freshness: see snapshot'} · identity ${row.id}`;
    else if (query.resource === 'subscriptions') {
      const d = row.derived;
      const amount = row.kind === 'topup' ? d?.topUpTotalMinor : row.amountMinor;
      detail.textContent = `${row.kind === 'topup' ? 'Recorded top-ups' : 'Recorded charge'}: ${amount == null ? 'unknown' : (amount / 100).toFixed(2)} ${row.currency || ''}`;
      if (d?.asOfDate) {
        detail.textContent += ` · as of ${d.asOfDate} · ${d.active === true ? 'active' : d.active === false ? 'ended' : 'status unknown'}`;
        const renewal = document.createElement('p');
        renewal.textContent = `Next renewal: ${d.nextRenewalDate || 'none'} · paid to date: ${d.paidToDateMinor == null ? 'unknown' : (d.paidToDateMinor / 100).toFixed(2)} ${row.currency || ''}`;
        const monthly = document.createElement('p');
        monthly.textContent = `Monthly equivalent: ${d.monthlyAmountUsd == null ? 'unknown' : 'USD ' + d.monthlyAmountUsd.toFixed(2)}`;
        if (row.kind !== 'topup') node.append(renewal);
        node.append(monthly);
        if (row.kind === 'topup') {
          const forecast = document.createElement('p'), f = d.forecast;
          forecast.textContent = f?.status === 'available'
            ? `Balance: ${f.balanceAmount} ${f.currency} · estimated ${f.daysRemaining ?? 'unknown'} days remaining · balance read ${f.balanceUpdatedAt || 'at an unknown time'}`
            : `Balance estimate: ${f?.status || 'unavailable'}`;
          node.append(forecast);
        }
      } else detail.textContent += ' · derived values unavailable';
    } else {
      const cost = row.cost;
      detail.textContent = `${row.totalTokens == null ? 'Unknown' : row.totalTokens.toLocaleString()} tokens · known USD ${cost?.knownUsd == null ? 'unknown' : cost.knownUsd.toFixed(4)} · pricing ${cost?.completeness || 'unknown'}`;
      if (query.resource === 'sessions') {
        const relation = document.createElement('p');
        const parent = value.rows.find(candidate => candidate.id === row.parentId);
        relation.textContent = row.parentId
          ? `Parent: ${parent?.title || row.parentClient || 'linked session'}${parent ? '' : ' (not on this page)'}`
          : 'No parent relationship reported';
        node.append(relation);
      }
      if (row.models?.length) detail.textContent += ` · models: ${row.models.map(model => model.model).join(', ')}`;
    }
    node.prepend(title, detail); $('rows').append(node);
  }
}
async function read(next = false) {
  const generation = epoch, serial = ++request;
  const current = query;
  $('next').disabled = true;
  try {
    const value = await tm.data.query(next && cursor ? { ...current, page: { ...current.page, cursor } } : current);
    if (generation !== epoch || serial !== request) return;
    if (next && ['snapshotExpired', 'invalidCursor'].includes(value.availability)) {
      // Expiry/eviction (including a concurrent page-one refresh) restarts traversal.
      cursor = null;
      return read();
    }
    browsing = next;
    if (!next) updatesPending = false;
    render(value);
  } catch (error) {
    if (generation === epoch && serial === request) { cursor = null; $('summary').textContent = message(error); }
  }
}
function start() {
  stop?.(); ++epoch; ++request; cursor = null; browsing = false; updatesPending = false;
  selectedPeriod = saved.values.period; selectedSize = saved.values.pageSize;
  query = { version: 1, resource: $('resource').value, period: originalPeriod || selectedPeriod, sort: { field: 'id', direction: 'asc' }, page: { limit: selectedSize } };
  const generation = epoch;
  $('next').disabled = true; $('rows').replaceChildren(); $('summary').textContent = 'Loading snapshot…';
  // Subscribe delivers page one: do not duplicate it with an initial query.
  stop = tm.data.subscribe(query, event => {
    if (generation !== epoch) return;
    if (event.type === 'snapshot') { ++request; render(event.value); }
    else if (event.type === 'invalidate') {
      if (event.reset !== false || !browsing) {
        // Source/privacy changes cannot leave a prior snapshot on screen.
        cursor = null; $('rows').replaceChildren(); void read();
      } else if (!updatesPending) {
        updatesPending = true;
        $('summary').textContent += ' · New data available. Refresh when ready.';
      }
    }
    else if (event.type === 'error') $('summary').textContent = event.error;
  });
}
function context(value) {
  const theme = value.theme;
  for (const [key, color] of Object.entries(theme.colors)) document.documentElement.style.setProperty(`--${key}`, color);
  document.documentElement.dataset.reduced = String(theme.reducedMotion);
  document.body.style.fontFamily = theme.font;
  const target = value.snapshot?.target;
  $('restore').hidden = !target;
  if (target) {
    $('resource').value = { model: 'models', tool: 'tools', device: 'devices' }[target];
    $('resource').disabled = true;
  }
  const period = value.snapshot?.period;
  const changed = originalPeriod !== period;
  originalPeriod = period;
  if (initialized && changed) start();
}
$('restore').onclick = () => tm.restoreOriginal().catch(error => { $('summary').textContent = message(error); });
$('resource').onchange = () => { if (initialized) start(); };
$('refresh').onclick = () => { if (initialized) void read(); };
$('next').onclick = () => void read(true);
for (const id of ['period', 'pageSize']) $(id).oninput = () => { dirty = true; $('save').disabled = !saved || saved.readOnly; };
$('reload').onclick = async () => {
  try { settings(await tm.settings.get(), true); } catch (error) { $('settingsStatus').textContent = message(error); }
};
$('save').onclick = async () => {
  if (!$('pageSize').reportValidity()) return;
  $('save').disabled = true;
  for (const id of ['period', 'pageSize', 'reload']) $(id).disabled = true;
  try {
    const value = await tm.settings.update({ schemaVersion: draftBase.schemaVersion, expectedRevision: draftBase.revision, patch: { period: $('period').value, pageSize: Number($('pageSize').value) } });
    settings(value, true);
  } catch (error) {
    $('settingsStatus').textContent = `${message(error)}. Draft kept; reload saved preferences to resolve a conflict.`;
    $('save').disabled = saved.readOnly;
  } finally {
    for (const id of ['period', 'pageSize', 'reload']) $(id).disabled = false;
  }
};
const offContext = tm.onContext(context);
const offSettings = tm.settings.onChange(value => settings(value));
Promise.all([tm.context(), tm.settings.get()]).then(([value, preferences]) => {
  context(value); settings(preferences); initialized = true; start();
}).catch(error => { $('settingsStatus').textContent = message(error); });
window.addEventListener('pagehide', () => { ++epoch; stop?.(); offContext(); offSettings(); }, { once: true });
