// @ts-check
'use strict';

const { randomUUID } = require('node:crypto');
const { statsPatch } = require('./hubDelta');
const { MAX_UPLOAD_BYTES } = require('./uploadDelta');
const { mergePeriods } = require('./usage');
const { FIXED_RANGE_PAGE_BYTES, MAX_DAILY_RANGE_PAGES, MAX_FIXED_RANGE_PAGES, dailyRangeKeys, encodeFixedRangeSnapshot, decodeFixedRangePeriod, fixedRangeRowKey } = require('./fixedRangeSync');

/** @typedef {Record<string, any>} JsonRecord */
/** @typedef {(url: string, options?: RequestInit) => Promise<Response>} RangeFetch */

/**
 * @param {string} hubUrl
 * @param {string} deviceId
 */
function fixedRangeUrl(hubUrl, deviceId) {
  const url = new URL(hubUrl.replace(/\/$/, '') + '/api/fixed-ranges');
  url.searchParams.set('deviceId', deviceId);
  return url;
}

/**
 * @param {JsonRecord} record
 * @param {{ syncSessionTitles?: boolean, sessionTitleSyncGeneration?: number }} options
 */
function* fixedRangeUploadPages(record, options = {}) {
  const { ranges, pages } = encodeFixedRangeSnapshot(record, {
    maxPageBytes: FIXED_RANGE_PAGE_BYTES, preserveSessionTitles: options.syncSessionTitles === true
  });
  const maxPages = record.dailySessionPeriods ? MAX_DAILY_RANGE_PAGES : MAX_FIXED_RANGE_PAGES;
  if (Object.keys(ranges).length === 0 || pages.length > maxPages) return;
  const revision = randomUUID();
  const totalPages = pages.length;
  for (const [page, rows] of (totalPages ? pages : [[]]).entries()) {
    yield {
      observedAt: record.updatedAt, revision, page, rows,
      sessionTitleSyncGeneration: options.syncSessionTitles ? options.sessionTitleSyncGeneration : undefined,
      ...(page === 0 ? { ranges, totalPages } : {})
    };
  }
}

/**
 * @param {JsonRecord[]} previous
 * @param {JsonRecord[]} next
 * @returns {JsonRecord[]}
 */
function fixedRangeDeltaPages(previous, next) {
  const base = previous[0];
  const index = next[0];
  if (!base || !index || base.sessionTitleSyncGeneration !== index.sessionTitleSyncGeneration) return next;
  return next.map(page => {
    if (!page.rows.length) return page;
    const name = page.rows[0][0];
    const old = base.ranges[name];
    const offset = page.page - index.ranges[name].firstPage;
    if (!old || offset >= old.pageCount) return page;
    const basePage = old.firstPage + offset;
    const baseRows = /** @type {import('./fixedRangeSync').DetailRow[]} */ (previous[basePage].rows);
    const oldRows = new Map(baseRows.map(row => [fixedRangeRowKey(row), JSON.stringify(row)]));
    const upsert = [];
    for (const row of page.rows) {
      const key = fixedRangeRowKey(row);
      if (oldRows.get(key) !== JSON.stringify(row)) upsert.push(row);
      oldRows.delete(key);
    }
    const { rows: _rows, ...fields } = page;
    const delta = { ...fields, delta: { baseRevision: base.revision, basePage, upsert, remove: [...oldRows.keys()] } };
    return Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(page)) ? delta : page;
  });
}

/**
 * @param {JsonRecord[]} pages
 * @param {JsonRecord[]} previous
 * @returns {JsonRecord[]}
 */
function withFixedRangeIndexDelta(pages, previous) {
  const base = previous[0];
  const first = pages[0];
  if (!base || !first || base.sessionTitleSyncGeneration !== first.sessionTitleSyncGeneration) return pages;
  const { ranges, ...fields } = first;
  const patch = statsPatch(base.ranges, ranges);
  const candidate = { ...fields, indexDelta: { baseRevision: base.revision, patch } };
  return patch.length <= 20000 && Buffer.byteLength(JSON.stringify(candidate)) < Buffer.byteLength(JSON.stringify(first))
    ? [candidate, ...pages.slice(1)] : pages;
}

/**
 * @param {JsonRecord[]} pages
 * @param {number} maxBytes
 */
function* fixedRangeRequestBodies(pages, maxBytes = MAX_UPLOAD_BYTES) {
  const prefix = '{"pages":[';
  const suffix = ']}';
  let batch = [];
  let bytes = prefix.length + suffix.length;
  for (const page of pages) {
    const body = JSON.stringify(page);
    const size = Buffer.byteLength(body);
    if (batch.length && bytes + 1 + size > maxBytes) {
      yield batch.length === 1 ? batch[0] : prefix + batch.join(',') + suffix;
      batch = [];
      bytes = prefix.length + suffix.length;
    }
    bytes += size + (batch.length ? 1 : 0);
    batch.push(body);
  }
  if (batch.length) yield batch.length === 1 ? batch[0] : prefix + batch.join(',') + suffix;
}

/** @param {JsonRecord[]} pages */
function* dailyRangeRequestBodies(pages) {
  if (!pages.length) return;
  const { revision, observedAt, sessionTitleSyncGeneration } = pages[0];
  const baseRevision = pages.find(page => page.delta)?.delta.baseRevision;
  const suffix = ']}';
  let first = 0;
  let bodies = [];
  const prefix = () => JSON.stringify({ revision, observedAt, sessionTitleSyncGeneration,
    firstPage: first, baseRevision }).slice(0, -1) + ',"pages":[';
  let length = Buffer.byteLength(prefix()) + suffix.length;
  for (const { page, revision: _revision, observedAt: _observation, sessionTitleSyncGeneration: _title, ...entry } of pages) {
    const delta = entry.delta;
    const unchanged = !entry.ranges && !entry.indexDelta && delta && delta.baseRevision === baseRevision
      && !delta.upsert.length && !delta.remove.length;
    const body = JSON.stringify(unchanged ? delta.basePage : entry);
    const size = Buffer.byteLength(body);
    if (bodies.length && length + 1 + size > MAX_UPLOAD_BYTES) {
      yield prefix() + bodies.join(',') + suffix;
      first = page;
      bodies = [];
      length = Buffer.byteLength(prefix()) + suffix.length;
    }
    length += size + Number(bodies.length > 0);
    bodies.push(body);
  }
  if (bodies.length) yield prefix() + bodies.join(',') + suffix;
}

/**
 * @param {RangeFetch} fetch
 * @param {string} hubUrl
 * @param {JsonRecord} record
 * @param {HeadersInit} headers
 * @param {{ syncSessionTitles?: boolean, sessionTitleSyncGeneration?: number }} options
 * @param {JsonRecord[]} previous
 * @param {boolean} batchSupported
 * @param {boolean} indexDeltaSupported
 */
async function uploadFixedRangeVersion(fetch, hubUrl, record, headers, options, previous = [], batchSupported = false, indexDeltaSupported = false) {
  const url = fixedRangeUrl(hubUrl, record.deviceId).href;
  /** @param {Iterable<string>} bodies */
  async function send(bodies) {
    for (const body of bodies) {
      const response = await fetch(url, { method: 'PUT', headers, body });
      if (!response.ok) {
        await response.arrayBuffer();
        if ([400, 404, 405, 409, 413].includes(response.status)) return response.status;
        throw new Error(`Fixed range upload failed (${response.status})`);
      }
      if ((await response.json()).complete === true) return 200;
    }
    return 0;
  }

  let full;
  try { full = [...fixedRangeUploadPages(record, options)]; }
  catch (error) {
    if (record.dailySessionPeriods && error instanceof RangeError) return null;
    throw error;
  }
  const rowPages = fixedRangeDeltaPages(previous, full);
  const pages = indexDeltaSupported ? withFixedRangeIndexDelta(rowPages, previous) : rowPages;
  const hasDelta = pages.some(page => page.delta || page.indexDelta);
  const bodies = batchSupported && record.dailySessionPeriods ? dailyRangeRequestBodies(pages)
    : batchSupported && hasDelta ? fixedRangeRequestBodies(pages) : pages.map(page => JSON.stringify(page));
  const status = await send(bodies);
  if (status === 200) return full;
  if (![400, 409, 413].includes(status) || !hasDelta) return null;
  // A new revision abandons any pages staged before the baseline was rejected.
  const revision = randomUUID();
  full = full.map(page => ({ ...page, revision }));
  return await send(full.map(page => JSON.stringify(page))) === 200 ? full : null;
}

/**
 * @param {RangeFetch} fetch
 * @param {string} hubUrl
 * @param {JsonRecord} record
 * @param {HeadersInit} headers
 * @param {{ syncSessionTitles?: boolean, sessionTitleSyncGeneration?: number }} options
 */
async function uploadFixedRanges(fetch, hubUrl, record, headers, options = {}) {
  return Boolean(await uploadFixedRangeVersion(fetch, hubUrl, record, headers, options));
}

/**
 * @param {RangeFetch} fetch
 * @param {string} hubUrl
 * @param {string} deviceId
 * @param {string} name
 * @param {{ start: string, end: string }} window
 * @param {HeadersInit} headers
 * @param {string} [expectedRevision]
 */
async function fetchFixedRange(fetch, hubUrl, deviceId, name, window, headers, expectedRevision) {
  const url = fixedRangeUrl(hubUrl, deviceId);
  url.searchParams.set('daily', '1');
  const response = await fetch(url.href, { headers });
  if (!response.ok) { await response.arrayBuffer(); return null; }
  const index = await response.json();
  if (expectedRevision && index.revision !== expectedRevision) return null;
  const daily = !Object.hasOwn(index.ranges || {}, name);
  const names = daily ? dailyRangeKeys(window) : [name];
  if (!names.length || names.some(key => {
    const range = index.ranges?.[key];
    return range?.start !== (daily ? key : window.start) || range.end !== (daily ? key : window.end)
      || !Number.isInteger(range.firstPage) || range.firstPage < 0
      || !Number.isInteger(range.pageCount) || range.pageCount < 0
      || range.firstPage + range.pageCount > (daily ? MAX_DAILY_RANGE_PAGES : MAX_FIXED_RANGE_PAGES);
  })) return null;
  url.searchParams.set('revision', index.revision);
  const pageNumbers = names.flatMap(key => {
    const { firstPage, pageCount } = index.ranges[key];
    return Array.from({ length: pageCount }, (_, i) => firstPage + i);
  });
  const pages = new Map();
  for (let offset = 0; offset < pageNumbers.length; offset += 6) {
    const batch = await Promise.all(pageNumbers.slice(offset, offset + 6).map(async page => {
      const pageUrl = new URL(url);
      pageUrl.searchParams.set('page', String(page));
      const result = await fetch(pageUrl.href, { headers });
      if (!result.ok) { await result.arrayBuffer(); return null; }
      const { rows } = await result.json();
      return Array.isArray(rows) ? { page, rows } : null;
    }));
    for (const entry of batch) {
      if (!entry) return null;
      pages.set(entry.page, entry.rows);
    }
  }
  const periods = [];
  for (const key of names) {
    const { firstPage, pageCount } = index.ranges[key];
    const period = decodeFixedRangePeriod(index.ranges,
      Array.from({ length: pageCount }, (_, i) => pages.get(firstPage + i)), key);
    if (!period) return null;
    periods.push(period);
  }
  return daily ? mergePeriods(...periods) : periods[0];
}

module.exports = { fixedRangeUploadPages, fixedRangeDeltaPages, withFixedRangeIndexDelta, fixedRangeRequestBodies, uploadFixedRangeVersion, uploadFixedRanges, fetchFixedRange };
