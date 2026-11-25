// @ts-check
'use strict';

const { randomUUID } = require('node:crypto');
const { FIXED_RANGE_PAGE_BYTES, MAX_FIXED_RANGE_PAGES, encodeFixedRangeSnapshot, decodeFixedRangePeriod } = require('./fixedRangeSync');

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
 * Upload only after the corresponding device record has been admitted.
 * Legacy servers can ignore the optional endpoint without rejecting usage.
 * @param {RangeFetch} fetch
 * @param {string} hubUrl
 * @param {JsonRecord} record
 * @param {HeadersInit} headers
 * @param {{ syncSessionTitles?: boolean, sessionTitleSyncGeneration?: number }} options
 */
async function uploadFixedRanges(fetch, hubUrl, record, headers, options = {}) {
  const url = fixedRangeUrl(hubUrl, record.deviceId).href;
  for (const page of fixedRangeUploadPages(record, options)) {
    const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(page) });
    if (!response.ok) {
      await response.arrayBuffer();
      if (response.status === 404 || response.status === 405 || response.status === 409) return false;
      throw new Error(`Fixed range upload failed (${response.status})`);
    }
    const result = await response.json();
    if (result.complete === true) return true;
  }
  return false;
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

module.exports = { fixedRangeUploadPages, uploadFixedRanges, fetchFixedRange };
