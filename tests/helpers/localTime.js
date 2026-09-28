'use strict';

// Fixtures that exercise day or month bucketing have to state their instants in
// the same clock the product code buckets by, and that clock is local: usage
// periods are cut at local midnight (`src/shared/providers/qodercn/usage.js`, the archive
// modules, the widget trend), because a desktop widget belongs to the calendar
// the person reading it lives in.
//
// A `Z` literal only lands on the calendar day it names at some offsets. Written
// as `2026-07-17T08:30:00.000Z` it is the 17th at UTC+00 and the 16th at UTC-10,
// so an assertion built on it is green at some offsets and red at others — and
// every GitHub-hosted runner sits at UTC+00, so the OS × Node matrix samples
// exactly the one offset where the mismatch is invisible.
//
// Building the instant from local calendar parts states the day the fixture
// means. The assertion then holds at every offset, and a regression that cut the
// day at UTC midnight fails everywhere except UTC instead of passing everywhere
// except a few offsets.
//
// `month` is 1-based so a call transcribes the ISO literal it replaces
// (`2026-07-17` → `2026, 7, 17`), not `Date`'s 0-based monthIndex.
const localDate = (year, month, day, hour = 0, minute = 0, second = 0, ms = 0) =>
  new Date(year, month - 1, day, hour, minute, second, ms);

const localMs = (...parts) => localDate(...parts).getTime();

const localIso = (...parts) => localDate(...parts).toISOString();

module.exports = { localDate, localMs, localIso };
