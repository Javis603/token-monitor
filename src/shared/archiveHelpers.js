'use strict';

const { normalizePeriod } = require('./usage');

// Primitives shared by the two usage archives (`clientUsageArchive.js` and
// `sessionUsageArchive.js`). They lived in both files in identical copies, which
// is the kind of duplication that silently diverges: the pair below that decides
// which day/month bucket an entry belongs to is compared against a freshly
// computed one on every restore, so one copy drifting by a timezone would make
// archived usage disappear rather than fail loudly.
//
// Deliberately not in `usage.js`, even though that is where period shapes live.
// `usage.js` answers the same question in UTC — `utcDayKey`/`utcMonthKey` — because
// the hub aggregates devices across timezones and needs a key that does not depend
// on which one, while an archive is device-local and cuts on the user's own midnight.
// One home for both would mean four near-identically named functions with opposite
// timezone behaviour in one file. Its `asNumber` and `validDate` are not `numberValue`
// and `toDate` either: one parses currency strings, and the two disagree on what an
// unusable value becomes. Growing `usage.js` also moves the Hub build marker.

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

// Local calendar components on purpose, not `toISOString()`. These strings are
// the archive's bucket keys, and they are compared against the same functions
// applied to `now` at restore time, so they have to name the day the user is
// having rather than the one UTC is having.
function localDay(dateValue) {
  const date = toDate(dateValue);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localMonth(dateValue) {
  const date = toDate(dateValue);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

// A JSON round-trip, so callers get a detached copy with the archive's own wire
// shape: undefined keys and non-plain values are dropped rather than aliased.
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function periodFor(record, periodName) {
  return normalizePeriod(record?.periods?.[periodName] || record?.[periodName]);
}

function targetPeriod(summary, periodName) {
  if (summary.periods && typeof summary.periods === 'object') {
    summary.periods[periodName] = normalizePeriod(summary.periods[periodName]);
    return summary.periods[periodName];
  }
  summary[periodName] = normalizePeriod(summary[periodName]);
  return summary[periodName];
}

// A progressive collection preview omits periods it has not scanned yet. Archive
// restoration must preserve that absence: materializing one would make the
// preview look complete and stop DeviceState from carrying attribution forward.
function hasSummaryPeriod(summary, periodName) {
  const container = summary.periods && typeof summary.periods === 'object'
    ? summary.periods
    : summary;
  return Object.prototype.hasOwnProperty.call(container, periodName);
}

module.exports = {
  cloneJson,
  hasSummaryPeriod,
  localDay,
  localMonth,
  numberValue,
  periodFor,
  targetPeriod,
  toDate
};
