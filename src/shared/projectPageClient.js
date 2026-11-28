// @ts-check
'use strict';

const { createHash } = require('node:crypto');
const { FIXED_RANGE_PAGE_BYTES } = require('./fixedRangeSync');
const { MAX_PROJECT_PAGES, validProjectRevision } = require('./projectPages');

/** @typedef {[string, unknown]} ProjectRow */
/** @typedef {{ revision: string, rows: ProjectRow[] }} ProjectUpload */
/** @typedef {(url: string, options?: RequestInit) => Promise<Response>} ProjectFetch */

/** @param {Record<string, any>} [summary] */
function projectPageUpload(summary) {
  const projects = summary?.allTime?.projects;
  if (summary?.projectsEnabled === false || !projects) return null;
  const rows = Object.entries(projects).sort(([a], [b]) => a < b ? -1 : Number(a !== b));
  if (!rows.length) return null;
  const revision = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return { revision, rows };
}

/** @param {string} base @param {string} deviceId */
function projectPagesUrl(base, deviceId) {
  const url = new URL(base.replace(/\/$/, '') + '/api/all-time-projects');
  url.searchParams.set('deviceId', deviceId);
  return url;
}

/** @param {ProjectUpload} upload */
function projectUploadPages(upload) {
  const pages = [];
  /** @type {ProjectRow[]} */
  let page = [];
  let bytes = 2;
  for (const row of upload.rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row));
    if (rowBytes + 2 > FIXED_RANGE_PAGE_BYTES) throw new RangeError('project row exceeds page budget');
    if (bytes + rowBytes + Number(page.length > 0) > FIXED_RANGE_PAGE_BYTES) {
      pages.push(page);
      page = [];
      bytes = 2;
    }
    bytes += rowBytes + Number(page.length > 0);
    page.push(row);
  }
  pages.push(page);
  if (pages.length > MAX_PROJECT_PAGES) throw new RangeError('project snapshot exceeds page budget');
  return pages.map((rows, page) => ({ revision: upload.revision, page, pageCount: pages.length, rows }));
}

/**
 * @param {ProjectFetch} fetch
 * @param {string} base
 * @param {string} deviceId
 * @param {ProjectUpload} upload
 * @param {HeadersInit} headers
 * @param {ProjectUpload | null} [previous]
 */
async function sendProjectPages(fetch, base, deviceId, upload, headers, previous) {
  const url = projectPagesUrl(base, deviceId).href;
  const requestHeaders = new Headers(headers);
  requestHeaders.set('content-type', 'application/json');
  const pages = projectUploadPages(upload);
  const oldPages = previous ? projectUploadPages(previous) : [];
  /** @param {boolean} useDelta */
  const send = async (useDelta) => {
    for (const page of pages) {
      let body = JSON.stringify(page);
      const old = oldPages[page.page]?.rows;
      if (useDelta && old?.length === page.rows.length && old.every(([key], index) => key === page.rows[index][0])) {
        const changes = page.rows.filter((row, index) => JSON.stringify(row[1]) !== JSON.stringify(old[index][1]));
        const delta = JSON.stringify({ revision: page.revision, page: page.page, pageCount: page.pageCount,
          baseRevision: previous?.revision, changes });
        if (Buffer.byteLength(delta) < Buffer.byteLength(body)) body = delta;
      }
      const response = await fetch(url, { method: 'PUT', headers: requestHeaders, body });
      if (!response.ok) {
        await response.arrayBuffer();
        if (useDelta && response.status === 409) return false;
        throw new Error(`Hub returned ${response.status}`);
      }
      if ((await response.json()).complete) return true;
    }
    throw new Error('Hub did not publish the project snapshot');
  };
  if (!await send(Boolean(previous))) await send(false);
}

/**
 * @param {ProjectFetch} fetch
 * @param {string} base
 * @param {string} deviceId
 * @param {string} revision
 * @param {HeadersInit} headers
 */
async function fetchProjectPages(fetch, base, deviceId, revision, headers) {
  if (!validProjectRevision(revision)) return null;
  const url = projectPagesUrl(base, deviceId);
  const response = await fetch(url.href, { headers });
  if (!response.ok) { await response.arrayBuffer(); return null; }
  const index = await response.json();
  if (index.revision !== revision || !Number.isInteger(index.pageCount)
    || index.pageCount < 1 || index.pageCount > MAX_PROJECT_PAGES) return null;
  url.searchParams.set('revision', revision);
  const rows = [];
  for (let page = 0; page < index.pageCount; page++) {
    url.searchParams.set('page', String(page));
    const response = await fetch(url.href, { headers });
    if (!response.ok) { await response.arrayBuffer(); return null; }
    const body = await response.json();
    if (!Array.isArray(body.rows)) return null;
    for (const row of body.rows) rows.push(row);
  }
  if (createHash('sha256').update(JSON.stringify(rows)).digest('hex') !== revision) return null;
  return Object.fromEntries(rows);
}

module.exports = { projectPageUpload, projectUploadPages, sendProjectPages, fetchProjectPages };
