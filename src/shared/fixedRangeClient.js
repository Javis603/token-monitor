// @ts-check
'use strict';

const { randomUUID } = require('node:crypto');
const { FIXED_RANGE_PAGE_BYTES, MAX_FIXED_RANGE_PAGES, encodeFixedRangeSnapshot, decodeFixedRangePeriod, fixedRangeRowKey } = require('./fixedRangeSync');

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
  if (Object.keys(ranges).length === 0 || pages.length > MAX_FIXED_RANGE_PAGES) return;
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
 * @param {RangeFetch} fetch
 * @param {string} hubUrl
 * @param {JsonRecord} record
 * @param {HeadersInit} headers
 * @param {{ syncSessionTitles?: boolean, sessionTitleSyncGeneration?: number }} options
 * @param {JsonRecord[]} previous
 */
async function uploadFixedRangeVersion(fetch, hubUrl, record, headers, options, previous = []) {
  const url = fixedRangeUrl(hubUrl, record.deviceId).href;
  /** @param {JsonRecord[]} pages */
  async function send(pages) {
    for (const page of pages) {
      const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(page) });
      if (!response.ok) {
        await response.arrayBuffer();
        if ([400, 404, 405, 409, 413].includes(response.status)) return response.status;
        throw new Error(`Fixed range upload failed (${response.status})`);
      }
      if ((await response.json()).complete === true) return 200;
    }
    return 0;
  }

  let full = [...fixedRangeUploadPages(record, options)];
  const pages = fixedRangeDeltaPages(previous, full);
  const status = await send(pages);
  if (status === 200) return full;
  if (![400, 409, 413].includes(status) || !pages.some(page => page.delta)) return null;
  // A new revision abandons any pages staged before the baseline was rejected.
  const revision = randomUUID();
  full = full.map(page => ({ ...page, revision }));
  return await send(full) === 200 ? full : null;
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
  const response = await fetch(url.href, { headers });
  if (!response.ok) { await response.arrayBuffer(); return null; }
  const index = await response.json();
  const range = index.ranges?.[name];
  if ((expectedRevision && index.revision !== expectedRevision) || range?.start !== window.start || range.end !== window.end
    || !Number.isInteger(range.firstPage) || range.firstPage < 0
    || !Number.isInteger(range.pageCount) || range.pageCount < 0 || range.pageCount > MAX_FIXED_RANGE_PAGES) return null;
  url.searchParams.set('revision', index.revision);
  const pages = [];
  for (let i = 0; i < range.pageCount; i++) {
    url.searchParams.set('page', String(range.firstPage + i));
    const result = await fetch(url.href, { headers });
    if (!result.ok) { await result.arrayBuffer(); return null; }
    const { rows } = await result.json();
    if (!Array.isArray(rows)) return null;
    pages.push(rows);
  }
  return decodeFixedRangePeriod(index.ranges, pages, name);
}

module.exports = { fixedRangeUploadPages, fixedRangeDeltaPages, uploadFixedRangeVersion, uploadFixedRanges, fetchFixedRange };
