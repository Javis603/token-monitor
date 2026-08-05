'use strict';

// A progressive collection preview omits periods it has not scanned yet. Archive
// restoration must preserve that absence: materializing one would make the
// preview look complete and stop DeviceState from carrying attribution forward.
function hasSummaryPeriod(summary, periodName) {
  const container = summary.periods && typeof summary.periods === 'object'
    ? summary.periods
    : summary;
  return Object.prototype.hasOwnProperty.call(container, periodName);
}

module.exports = { hasSummaryPeriod };
