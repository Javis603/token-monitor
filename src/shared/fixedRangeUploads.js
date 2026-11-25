// @ts-check
'use strict';

const { admitFixedRangeIndex, admitFixedRangePage, decodeFixedRangePeriod, rangesMatchDeviceDay } = require('./fixedRangeSync');

/** @typedef {Record<string, any>} JsonRecord */
const MAX_STAGED_UPLOADS = 4;
const STAGE_IDLE_MS = 5 * 60_000;
const MAX_REPLACEMENTS_PER_OBSERVATION = 32;

// Deleting titled pages must retire their revision as well. Keep only the
// compact replay guard, tied to the usage observation that created it.
/** @param {JsonRecord} snapshot */
function retireFixedRangeSnapshot(snapshot) {
  return {
    observedAt: snapshot.observedAt,
    revision: null,
    pageCount: 0,
    pages: [],
    retiredRevisions: [...(snapshot.retiredRevisions || []), snapshot.revision]
  };
}

// Older ingest callers can overwrite the ordinary record. Carry the newest
// accepted usage clock through that overwrite so its range cannot reappear.
/** @param {JsonRecord} record @param {JsonRecord | undefined} previous */
function rememberFixedRangeObservation(record, previous) {
  const latest = previous?.fixedRangeObservedAt ?? previous?.updatedAt;
  const latestTime = Date.parse(latest);
  const incomingTime = Date.parse(record.updatedAt);
  if (Number.isFinite(latestTime) && (!Number.isFinite(incomingTime) || latestTime > incomingTime)) {
    record.fixedRangeObservedAt = latest;
  }
}

/** @param {JsonRecord | undefined} device */
function hasCurrentFixedRangeObservation(device) {
  return Boolean(device && !device.fixedRangeObservedAt);
}

/** @param {JsonRecord} device */
function withoutFixedRangeObservation(device) {
  if (!device.fixedRangeObservedAt) return device;
  const { fixedRangeObservedAt: _observedAt, ...visible } = device;
  return visible;
}

/**
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/**
 * Keep the currently published upload visible while receiving its replacement.
 * Each stage belongs to one device and one usage revision.
 */
function createFixedRangeUploads() {
  /** @type {Map<string, JsonRecord>} */
  const stages = new Map();

  /**
   * @param {string} deviceId
   * @param {JsonRecord} payload
   * @param {JsonRecord | undefined} device
   * @param {boolean} preserveSessionTitles
   * @param {JsonRecord} [published] metadata and rows for a replayed page
   */
  function accept(deviceId, payload, device, preserveSessionTitles = false, published) {
    if (typeof payload?.revision !== 'string' || !/^[a-f0-9-]{16,64}$/.test(payload.revision)
      || !Number.isInteger(payload.page) || payload.page < 0) return { status: 400 };
    if (!device || !hasCurrentFixedRangeObservation(device) || !device.periodWindows?.today || device.updatedAt !== payload.observedAt) {
      return { status: 409 };
    }
    const { observedAt, revision } = payload;
    const observationTime = Date.parse(observedAt);
    const publishedTime = Date.parse(published?.observedAt);
    if (!Number.isFinite(observationTime)) return { status: 400 };
    if (publishedTime > observationTime) return { status: 409 };
    const titleGeneration = preserveSessionTitles ? payload.sessionTitleSyncGeneration : null;
    const admitPage = (/** @type {number} */ totalPages) => {
      if (totalPages === 0) return Array.isArray(payload.rows) && payload.rows.length === 0 ? [] : null;
      return admitFixedRangePage(payload.rows, { projectsEnabled: device.projectsEnabled !== false, preserveSessionTitles });
    };
    const indexMatches = (/** @type {JsonRecord} */ ranges, /** @type {number} */ totalPages) => (
      payload.page !== 0 || (payload.totalPages === totalPages
        && sameJson(admitFixedRangeIndex(payload.ranges, payload.totalPages), ranges))
    );
    if (published?.revision === revision) {
      const page = admitPage(published.pageCount);
      if (published.observedAt !== observedAt || published.titleGeneration !== titleGeneration
        || !indexMatches(published.ranges, published.pageCount) || !page || !sameJson(page, published.rows)) return { status: 409 };
      return { status: 200, complete: true };
    }
    const retiredRevisions = published && publishedTime === observationTime
      ? [...(published.retiredRevisions || []), ...(published.revision ? [published.revision] : [])]
      : [];
    if (retiredRevisions.includes(revision) || retiredRevisions.length > MAX_REPLACEMENTS_PER_OBSERVATION) {
      return { status: 409 };
    }
    const now = Date.now();
    for (const [id, staged] of stages) {
      if (staged.expiresAt <= now) stages.delete(id);
    }
    let stage = stages.get(deviceId);
    if (payload.page === 0 && stage?.revision !== revision) {
      const ranges = admitFixedRangeIndex(payload.ranges, payload.totalPages);
      if (!ranges || !rangesMatchDeviceDay(ranges, device.periodWindows.today.key)) return { status: 400 };
      if (!stage && stages.size >= MAX_STAGED_UPLOADS) return { status: 429 };
      stage = { observedAt, revision, ranges, totalPages: payload.totalPages, pages: [],
        titleGeneration };
    }
    if (!stage || stage.revision !== revision || stage.observedAt !== observedAt
      || payload.page > stage.pages.length
      || stage.titleGeneration !== titleGeneration) {
      return { status: 409 };
    }
    const page = admitPage(stage.totalPages);
    if (payload.page < stage.pages.length) {
      if (!indexMatches(stage.ranges, stage.totalPages) || !page || !sameJson(page, stage.pages[payload.page])) {
        return { status: 409 };
      }
      return { status: 200, complete: false };
    }
    if (!page) return { status: 400 };
    const pages = stage.totalPages === 0 ? [] : [...stage.pages, page];
    if (pages.length !== stage.totalPages) {
      stages.set(deviceId, { ...stage, pages, expiresAt: now + STAGE_IDLE_MS });
      return { status: 200, complete: false };
    }
    for (const [name, entry] of Object.entries(stage.ranges)) {
      const rangePages = pages.slice(entry.firstPage, entry.firstPage + entry.pageCount);
      if (!decodeFixedRangePeriod(stage.ranges, rangePages, name)) return { status: 400 };
    }
    stages.delete(deviceId);
    return { status: 200, complete: true, snapshot: {
      observedAt, revision, ranges: stage.ranges, pages, titleGeneration: stage.titleGeneration, retiredRevisions
    } };
  }

  return { accept, discard: (/** @type {string} */ id) => stages.delete(id) };
}

module.exports = {
  createFixedRangeUploads, retireFixedRangeSnapshot, rememberFixedRangeObservation,
  hasCurrentFixedRangeObservation, withoutFixedRangeObservation
};
