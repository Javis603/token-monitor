'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cleanSecret,
  errorWithStatus,
  numberOrNull,
  statusForHttp,
  toIso
} = require('../../src/shared/limits/providerHelpers');

// These helpers replaced per-provider copies, so the contracts below are what
// every limits provider now depends on rather than one provider's convenience.

test('cleanSecret strips surrounding whitespace and one layer of quotes', () => {
  assert.equal(cleanSecret('  sk-abc  '), 'sk-abc');
  assert.equal(cleanSecret('"sk-abc"'), 'sk-abc');
  assert.equal(cleanSecret("'sk-abc'"), 'sk-abc');
  assert.equal(cleanSecret('  " sk-abc "  '), 'sk-abc');
});

test('cleanSecret leaves unbalanced and nested quotes alone after one strip', () => {
  assert.equal(cleanSecret('"sk-abc'), '"sk-abc');
  assert.equal(cleanSecret('sk-abc"'), 'sk-abc"');
  assert.equal(cleanSecret('""sk-abc""'), '"sk-abc"');
  assert.equal(cleanSecret('"sk\'abc"'), "sk'abc");
});

test('cleanSecret reads a non-string as absent rather than coercing it', () => {
  for (const value of [undefined, null, 0, 1, NaN, true, false, {}, []]) {
    assert.equal(cleanSecret(value), '');
  }
});

test('numberOrNull accepts finite numbers and numeric strings, nothing else', () => {
  assert.equal(numberOrNull(12), 12);
  assert.equal(numberOrNull(0), 0);
  assert.equal(numberOrNull(-1.5), -1.5);
  assert.equal(numberOrNull(' 12 '), 12);
  for (const value of [undefined, null, '', '   ', 'abc', NaN, Infinity, {}, []]) {
    assert.equal(numberOrNull(value), null, `expected null for ${String(value)}`);
  }
});

test('numberOrNull returns null rather than zero for a missing quota', () => {
  // A provider that reports no quota must not render a real 0 remaining.
  assert.notEqual(numberOrNull(undefined), 0);
  assert.equal(numberOrNull(undefined), null);
});

test('toIso reads a small number as epoch seconds and a large one as milliseconds', () => {
  const seconds = 1_700_000_000;
  assert.equal(toIso(seconds), new Date(seconds * 1000).toISOString());
  const millis = 1_700_000_000_000;
  assert.equal(toIso(millis), new Date(millis).toISOString());
  // The cutoff itself: 20_000_000_000 is read as milliseconds.
  assert.equal(toIso(20_000_000_000), new Date(20_000_000_000).toISOString());
  assert.equal(toIso(19_999_999_999), new Date(19_999_999_999 * 1000).toISOString());
});

test('toIso passes through parseable strings and rejects the rest', () => {
  assert.equal(toIso('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z');
  for (const value of [null, undefined, '', 'not a date', NaN]) {
    assert.equal(toIso(value), null);
  }
});

test('errorWithStatus carries the status and falls back to it for the message', () => {
  const withMessage = errorWithStatus('unauthorized', 'token rejected');
  assert.equal(withMessage.status, 'unauthorized');
  assert.equal(withMessage.message, 'token rejected');
  assert.equal(errorWithStatus('unavailable').message, 'unavailable');
});

test('statusForHttp separates a credential problem from an outage', () => {
  assert.equal(statusForHttp(401), 'unauthorized');
  assert.equal(statusForHttp(403), 'unauthorized');
  assert.equal(statusForHttp(429), 'sourceRateLimited');
  assert.equal(statusForHttp(500), 'unavailable');
  assert.equal(statusForHttp(404), 'unavailable');
  assert.equal(statusForHttp(undefined), 'unavailable');
});
