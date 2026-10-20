'use strict';

// WorkBuddy Credits spend for Today/Week/Month, read from the per-request
// billing ledger (`/billing/meter/get-user-request-usage`) rather than derived
// from a cumulative used total. Each row carries its own `requestTime` and
// `credit`, so a period is the sum of the rows whose timestamps fall inside it:
// the figures do not depend on how often this machine observed the account, and
// a cycle reset or a change of package set cannot move them.
//
// The endpoint is a paged read over an explicit window. The window is what
// bounds every period, so it must outgrow the widest one (Month), otherwise
// Week, Month and All time collapse onto the same rows — which is exactly what a
// week-sized window produced.
//
// The server refuses long windows outright: a window of 31 days still answers,
// 32 days and beyond answer an empty ledger. The request therefore spans the
// maximum the API accepts, and a month whose first day falls outside that span
// is reported as partial instead of silently short.
const WORKBUDDY_USAGE_WINDOW_DAYS = 31;

// The ledger is a bounded read: a generous page count still terminates, and a
// truncated scan reports itself instead of silently understating spend.
const WORKBUDDY_USAGE_PAGE_SIZE = 100;
const WORKBUDDY_USAGE_MAX_PAGES = 50;
// Unlike the quota actions, this read lives at the UNVERSIONED path: the server
// answers `/v2/billing/meter/get-user-request-usage` with 404 Route Not Found.
const WORKBUDDY_USAGE_PATH = '/billing/meter/get-user-request-usage';
const WORKBUDDY_WEEK_DAYS = 7;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

// The ledger accepts local wall-clock text, as the official client sends it.
function formatUsageDateTime(date) {
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  ].join(' ');
}

function localDayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// Rolling seven days including today: the Week figure every other provider
// reports means the same span.
function startOfLocalWeek(ms) {
  const date = new Date(startOfLocalDay(ms));
  date.setDate(date.getDate() - (WORKBUDDY_WEEK_DAYS - 1));
  return date.getTime();
}

function startOfLocalMonth(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date.getTime();
}

// Numeric strings and epoch seconds/milliseconds both appear in this API
// family; a seconds value is rescaled so a mixed response cannot place a row
// decades away from its day bucket.
function parseRecordTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
  }
  const parsed = Date.parse(String(value).trim().replace(/^(\d{4}-\d\d-\d\d)[ T]/, '$1T'));
  return Number.isFinite(parsed) ? parsed : null;
}

function usageRows(body) {
  const data = body?.data;
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.rows) ? data.rows : [];
  const total = Number(data?.total);
  return { rows, total: Number.isSafeInteger(total) && total >= 0 ? total : null };
}

function recordCredit(row) {
  const credit = Number(row?.credit ?? row?.Credit);
  if (!Number.isFinite(credit) || credit < 0) return null;
  return credit;
}

/**
 * Aggregate billing rows into the Spend periods.
 *
 * Rows without a parseable timestamp or credit are skipped rather than guessed
 * at; `truncated` reports a scan that hit its page bound, which is why callers
 * must not present the result as a complete total.
 */
function summarizeUsageRecords(rows, now) {
  const fromMonth = startOfLocalMonth(now);
  const fromWeek = startOfLocalWeek(now);
  const fromToday = startOfLocalDay(now);
  let todaySpend = 0;
  let weekSpend = 0;
  let monthSpend = 0;
  let allTimeSpend = 0;
  let count = 0;
  let todayCount = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = parseRecordTime(row?.requestTime ?? row?.RequestTime ?? row?.createdAt);
    const credit = recordCredit(row);
    if (at === null || credit === null) continue;
    allTimeSpend += credit;
    count += 1;
    if (at >= fromMonth) monthSpend += credit;
    if (at >= fromWeek) weekSpend += credit;
    if (at >= fromToday) {
      todaySpend += credit;
      todayCount += 1;
    }
  }
  return {
    todaySpend: round2(todaySpend),
    weekSpend: round2(weekSpend),
    monthSpend: round2(monthSpend),
    allTimeSpend: round2(allTimeSpend),
    count,
    todayCount
  };
}

function usageRequestBody(now) {
  const windowStart = new Date(now - WORKBUDDY_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    startTime: formatUsageDateTime(new Date(startOfLocalDay(windowStart.getTime()))),
    endTime: formatUsageDateTime(new Date(now)),
    pageNum: 1,
    pageSize: WORKBUDDY_USAGE_PAGE_SIZE
  };
}

/**
 * Read the paged ledger and sum it.
 *
 * @param post - `(body) => Promise<body>` bound to the account's billing
 *   transport, so this module never owns credentials, hosts or realms.
 * @param now - observation time in epoch milliseconds.
 * @returns the Spend periods plus `truncated` when the page bound was reached.
 */
async function fetchWorkbuddyUsageSpend(post, now) {
  const records = [];
  let truncated = false;
  let expected = null;
  for (let page = 1; page <= WORKBUDDY_USAGE_MAX_PAGES; page += 1) {
    const body = await post({ ...usageRequestBody(now), pageNum: page });
    const { rows, total } = usageRows(body);
    if (expected === null) expected = total;
    if (!rows.length) break;
    records.push(...rows);
    if (expected !== null && records.length >= expected) break;
    // A full page that is not the last allowed one means more rows may exist.
    if (rows.length >= WORKBUDDY_USAGE_PAGE_SIZE && page < WORKBUDDY_USAGE_MAX_PAGES) continue;
    truncated = rows.length >= WORKBUDDY_USAGE_PAGE_SIZE;
    break;
  }
  // The window covers 31 days, so a calendar month is complete only while its
  // first day is inside that window; near the start of a long month the Month
  // figure is a floor, not a total.
  const monthFullyCovered = startOfLocalMonth(now) >= startOfLocalDay(now - WORKBUDDY_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { ...summarizeUsageRecords(records, now), truncated, monthFullyCovered };
}

module.exports = {
  WORKBUDDY_USAGE_MAX_PAGES,
  WORKBUDDY_USAGE_PAGE_SIZE,
  WORKBUDDY_USAGE_PATH,
  WORKBUDDY_USAGE_WINDOW_DAYS,
  fetchWorkbuddyUsageSpend,
  formatUsageDateTime,
  localDayKey,
  parseRecordTime,
  startOfLocalDay,
  startOfLocalMonth,
  startOfLocalWeek,
  summarizeUsageRecords,
  usageRequestBody
};
