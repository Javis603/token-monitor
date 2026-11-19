'use strict';

const { archivedSessionCount } = require('./renderer/sessionRows');

const PERIOD_NAMES = ['today', 'month', 'allTime'];

// Settings counts this machine's archived sessions: the archive and its
// controls are local, and the local record already carries the replayed
// archive. Counting that record avoids completing the composed all-time list,
// which in sync modes re-aggregates every device. Activity patches replace the
// record but keep its period session maps, so an unchanged scan reuses the
// last count. After the archive is cleared, the record still holds the replayed
// sessions until the next scan replaces those maps, so the count reads zero.
/**
 * @param {() => any} currentRecord this machine's latest collected record
 */
function createLocalArchivedSessionCounter(currentRecord) {
  /** @type {{ maps: unknown[], count: number } | null} */
  let cached = null;
  /** @type {unknown[] | null} */
  let clearedMaps = null;
  const sameMaps = (a, b) => a.every((map, index) => map === b[index]);
  const mapsOf = (record) => {
    const periods = record.periods || record;
    return PERIOD_NAMES.map((name) => periods[name]?.sessions);
  };
  function localArchivedSessionCount() {
    const record = currentRecord();
    if (!record) return null;
    const maps = mapsOf(record);
    if (clearedMaps && sameMaps(clearedMaps, maps)) return 0;
    clearedMaps = null;
    if (cached && sameMaps(cached.maps, maps)) return cached.count;
    const count = archivedSessionCount(record);
    cached = { maps, count };
    return count;
  }
  localArchivedSessionCount.archiveCleared = () => {
    const record = currentRecord();
    clearedMaps = record ? mapsOf(record) : null;
  };
  return localArchivedSessionCount;
}

module.exports = { createLocalArchivedSessionCounter };
