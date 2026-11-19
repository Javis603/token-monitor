'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hashKey } = require('../../src/shared/hashKey');

test('hashKey joins parts with NUL and prefixes sha256:', () => {
  // The split character is NUL ('\0'), not space or comma — guarantees
  // unambiguous joins even when parts contain whitespace or punctuation.
  const out = hashKey('a', 'b', 'c');
  assert.match(out, /^sha256:[a-f0-9]{64}$/);
  // Different inputs produce different digests.
  assert.notEqual(out, hashKey('a', 'b', 'd'));
});

test('hashKey is stable for the same input across calls', () => {
  assert.equal(hashKey('claude', 'creds.json'), hashKey('claude', 'creds.json'));
});

test('hashKey coerces non-string parts via String()', () => {
  // Limits providers pass things like accountKeySeed (number) or
  // workspaceId (string or undefined); both must stringify cleanly.
  const fromString = hashKey('opencode', 'wrk_123');
  const fromNumber = hashKey('opencode', 123);
  // Different forms produce different digests — there's no implicit
  // coercion magic; call sites are responsible for passing strings.
  assert.notEqual(fromString, fromNumber);
  // undefined / null / '' all collapse to empty string via the
  // `part || ''` guard, so they hash identically (deliberately —
  // a missing optional part must not break accountKey stability).
  assert.equal(hashKey('x', undefined), hashKey('x', null));
  assert.equal(hashKey('x', undefined), hashKey('x', ''));
});

test('hashKey requires a sha256 prefix that downstream code parses', () => {
  // the limits collector and the renderer both branch on the 'sha256:' prefix
  // to distinguish already-hashed accountKeys from raw seeds. If this
  // prefix ever changes, downstream code breaks silently.
  assert.ok(hashKey('seed').startsWith('sha256:'));
});
