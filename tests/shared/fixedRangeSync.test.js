'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { encodeFixedRangeSnapshot, decodeFixedRangePeriod } = require('../../src/shared/fixedRangeSync');

function scan(projectsEnabled = true) {
  const sessions = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
    `claude:s${index}`, {
      sessionId: `s${index}`, client: 'claude', totalTokens: 10,
      title: '測試會話', preview: 'private preview', projectId: 'workspace', projectLabel: '工作區'
    }
  ]));
  return {
    projectsEnabled,
    nativeRangeWindows: { last7: { start: '2026-11-19', end: '2026-11-25' } },
    nativeRanges: { last7: { totalTokens: 80, sessions, clients: { claude: 80 } } }
  };
}

test('fixed range totals and details round-trip beyond a single upload page', () => {
  const { ranges, pages } = encodeFixedRangeSnapshot(scan(), { maxPageBytes: 1600 });
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => Buffer.byteLength(JSON.stringify(page)) <= 1600));
  assert.equal(ranges.last7.totals.totalTokens, 80);
  assert.equal(ranges.last7.sessions, 8);
  assert.equal(ranges.last7.projects, 1);
  assert.equal(ranges.last7.totals.sessions, undefined);
  const period = decodeFixedRangePeriod(ranges, pages, 'last7');
  assert.equal(period.totalTokens, 80);
  assert.equal(period.sessions['claude:s0'].title, '');
  assert.equal(period.sessions['claude:s0'].preview, undefined);
  assert.equal(Object.values(period.projects)[0].tokens, 80);
  assert.equal(decodeFixedRangePeriod(ranges, pages.slice(1), 'last7'), null);
  assert.equal(decodeFixedRangePeriod(ranges, [...pages, pages[0]], 'last7'), null);
});

test('fixed range detail honors title and project settings', () => {
  const { ranges, pages } = encodeFixedRangeSnapshot(scan(false), {
    maxPageBytes: 1600, preserveSessionTitles: true
  });
  const period = decodeFixedRangePeriod(ranges, pages, 'last7');
  assert.equal(period.sessions['claude:s0'].title, '測試會話');
  assert.equal(period.sessions['claude:s0'].projectLabel, '');
  assert.deepEqual(period.projects, {});
});

test('a reader can fetch only the selected range pages', () => {
  const record = scan();
  record.nativeRangeWindows.last30 = { start: '2026-10-27', end: '2026-11-25' };
  record.nativeRanges.last30 = record.nativeRanges.last7;
  const { ranges, pages } = encodeFixedRangeSnapshot(record, { maxPageBytes: 1600 });
  const { firstPage, pageCount } = ranges.last30;
  assert.equal(firstPage, ranges.last7.pageCount);
  const selected = pages.slice(firstPage, firstPage + pageCount);
  assert.equal(decodeFixedRangePeriod(ranges, selected, 'last30').totalTokens, 80);
  assert.equal(decodeFixedRangePeriod(ranges, selected, 'last7'), null);
});
