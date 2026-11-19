'use strict';

function fixedPeriodHistoryMeta(options = {}) {
  const source = String(options.source || 'empty');
  return {
    source,
    // This only describes whether the History transport can be read. Range
    // completeness is deliberately decided later from every contributing device.
    historyTransportAvailable: source !== 'empty'
  };
}

module.exports = { fixedPeriodHistoryMeta };
