'use strict';

// main.js's StepFun signer is where the two rules that are easy to get wrong
// meet: the browser session is keyed by a partition that depends on a user
// setting, and the cookie jar it reuses holds BOTH a signed-in and an anonymous
// Oasis-Token. Getting the second wrong does not fail loudly — it reads back the
// anonymous token, the quota call 401s, the re-login path asks for a session
// again, reads the same anonymous cookie, and the provider is stuck
// unauthorized with no window ever shown.
//
// So these run the real function body against fake Electron objects rather than
// matching its source: a source pattern can be satisfied by a branch that never
// executes, which is exactly the failure this guards.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const login = require('../../src/electron/providers/stepfun/login');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

// Pulls one function definition out of main.js by matching braces, skipping
// strings and comments. Cutting to "the next function declaration" does not work
// here: the gap between two of these is most of the file, and the slice then
// drags in module-level `app.*` calls that have nothing to do with the test.
function extractFunction(source, name) {
  const open = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(source);
  assert.ok(open, `${name} should exist`);
  const from = open.index + 1;
  // Skip the parameter list first: `deps = {}` has a brace in it, and
  // matching from the first `{` would close the "function" at a parameter
  // default and hand vm a fragment with no body at all.
  let i = source.indexOf('(', from);
  let parens = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') { parens -= 1; if (parens === 0) break; }
  }
  let depth = 0;
  let quote = null;
  for (i += 1; i < source.length; i += 1) {
    const ch = source[i];
    // Comments are checked BEFORE quotes. Checking quotes first reads the
    // apostrophe in a line like "a caller that supplies its own signer" as the
    // start of a string, and every brace after it stops counting — which ends
    // the function early and hands vm a truncated body.
    if (ch === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); continue; }
    if (ch === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i) + 1; continue; }
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new assert.AssertionError({ message: `${name} never closes` });
}

const HOUR = 3600;
const cookie = (name, value) => ({ name, value, expires: (Date.now() + HOUR) / 1000 });

// Builds the real electronStepfunSignIn with only its Electron edges replaced.
// `stepfunRememberLogin` comes along because the body calls it, and
// `appendStepFunDiagnostic` is the boundary marker rather than a dependency.
function loadSigner({ cookies = [], signedIn = false, settings = {}, windowResult = null } = {}) {
  const opened = [];
  const verifications = [];
  const partitions = [];
  const sessions = [];
  const context = {
    settings,
    BrowserWindow: { marker: 'BrowserWindow' },
    stepfunPartition: login.stepfunPartition,
    readOasisSession: login.readOasisSession,
    session: {
      fromPartition: (name) => {
        partitions.push(name);
        const created = { cookies: { get: async () => cookies }, name };
        sessions.push(created);
        return created;
      }
    },
    verifyStepfunSession: async (candidate) => {
      verifications.push(candidate);
      return signedIn;
    },
    electronLimitsFetch: () => async () => ({ status: signedIn ? 200 : 401 }),
    signInStepFunWithBrowser: async (options) => {
      opened.push(options);
      return windowResult || { token: 'minted', webid: 'web-minted' };
    }
  };
  const body = [
    extractFunction(main, 'stepfunRememberLogin'),
    extractFunction(main, 'electronStepfunSignIn')
  ].join('\n');
  const signIn = vm.runInNewContext(`${body}\nelectronStepfunSignIn`, context);
  return { signIn, opened, verifications, partitions, sessions };
}

test('a signed-in session is reused instead of opening a window', async () => {
  const { signIn, opened, verifications } = loadSigner({
    cookies: [cookie(login.OASIS_TOKEN, 'tok'), cookie(login.OASIS_WEBID, 'web')],
    signedIn: true
  });

  const result = await signIn({ username: 'me', password: 'pw' });

  assert.deepEqual(result, { token: 'tok', webid: 'web' });
  assert.equal(opened.length, 0, 'a live session must not interrupt the user');
  assert.equal(verifications.length, 1, 'reuse is decided by asking the site, not by the jar');
  assert.deepEqual(verifications[0], { token: 'tok', webid: 'web' });
});

test('an anonymous cookie is not reused, even though it is a valid cookie', async () => {
  // platform.stepfun.com hands out an anonymous Oasis-Token on page load, so
  // this state is the normal one right after a restart. Trusting it here is
  // what produced a provider stuck on "unavailable" with nothing on screen.
  const { signIn, opened } = loadSigner({
    cookies: [cookie(login.OASIS_TOKEN, 'anonymous'), cookie(login.OASIS_WEBID, 'web')],
    signedIn: false
  });

  const result = await signIn({ username: 'me', password: 'pw' });

  assert.deepEqual(result, { token: 'minted', webid: 'web-minted' });
  assert.equal(opened.length, 1, 'the window opens rather than reusing an anonymous token');
  assert.equal(opened[0].username, 'me');
});

test('an empty jar goes straight to the window without a pointless probe', async () => {
  const { signIn, opened, verifications } = loadSigner({ cookies: [] });

  await signIn({ username: 'me', password: 'pw' });

  assert.equal(opened.length, 1);
  assert.equal(verifications.length, 0, 'nothing to verify when the jar is empty');
});

test('the remembered-session setting decides whether the partition persists', async () => {
  // Without `persist:` the Oasis cookies live in memory only, so every launch
  // restarts from an empty jar and pops the window again.
  const kept = loadSigner({ cookies: [], settings: {} });
  await kept.signIn({});
  assert.deepEqual(kept.partitions, ['persist:stepfun-login']);
  assert.equal(kept.opened[0].partition, 'persist:stepfun-login');

  const explicitOn = loadSigner({ cookies: [], settings: { stepfunRememberLogin: '1' } });
  await explicitOn.signIn({});
  assert.deepEqual(explicitOn.partitions, ['persist:stepfun-login']);

  const forgotten = loadSigner({ cookies: [], settings: { stepfunRememberLogin: '0' } });
  await forgotten.signIn({});
  assert.deepEqual(forgotten.partitions, ['stepfun-login'],
    'opting out must actually give up the on-disk session');
  assert.equal(forgotten.opened[0].partition, 'stepfun-login');
});

test('the window and the cookie reader always share one partition', async () => {
  const { signIn, partitions, opened, sessions } = loadSigner({ cookies: [] });
  await signIn({});

  assert.equal(partitions.length, 1, 'the partition is resolved once, not re-derived per window');
  // A window on a different partition than the reader is how a sign-in
  // silently returns no token at all: the window signs in, the reader looks
  // somewhere else, and the probe reports no session rather than a wrong one.
  assert.equal(opened[0].partition, partitions[0]);
  assert.equal(opened[0].session, sessions[0], 'the window reads the very jar the cookie check read');
});

test('stepfunPartition yields the same partition for every caller that persists', () => {
  assert.equal(login.stepfunPartition(), 'persist:stepfun-login');
  assert.equal(login.stepfunPartition({ remember: true }), 'persist:stepfun-login');
  assert.equal(login.stepfunPartition({ remember: false }), 'stepfun-login');
  // A throwaway partition has to stay throwaway, or "forget on exit" is a label
  // on a session that is still on disk.
  assert.ok(!login.stepfunPartition({ remember: false }).startsWith('persist:'));
});

test('clearing the account also forgets the browser session', async () => {
  // The cookie jar IS the session. Wiping only the stored values leaves a
  // still-authenticated partition behind, so the next probe signs in again from
  // a session the user just told the app to remove.
  const disposed = [];
  const removed = [];
  const context = {
    settings: {},
    stepfunPartition: login.stepfunPartition,
    disposeStepFunWindow: (partition) => disposed.push(partition),
    COOKIE_URL: login.COOKIE_URL,
    OASIS_TOKEN: login.OASIS_TOKEN,
    OASIS_WEBID: login.OASIS_WEBID,
    session: { fromPartition: () => ({ cookies: { remove: async (...args) => removed.push(args) } }) }
  };
  const body = [
    extractFunction(main, 'stepfunRememberLogin'),
    extractFunction(main, 'clearStepfunLoginSession')
  ].join('\n');
  const clear = vm.runInNewContext(`${body}\nclearStepfunLoginSession`, context);

  await clear();

  assert.deepEqual(disposed, ['persist:stepfun-login'], 'the retained window goes with the session');
  assert.equal(removed.length, 1, 'the cookies go too, not just the settings');
  // Compared element-wise: these values crossed a vm realm boundary, where
  // deepEqual rejects reference-equal-looking arrays.
  assert.equal(removed[0][0], login.COOKIE_URL);
  assert.equal(removed[0][1].join(','), `${login.OASIS_TOKEN},${login.OASIS_WEBID}`);
});

test('a caller-supplied logger is still recorded, not swapped out', async () => {
  // The save-time probe is the one a user reaches by clicking Save, and it was
  // writing nothing to the log because the wrapper only applied when the caller
  // had left the logger out. Recording and forwarding are both required.
  const recorded = [];
  const forwarded = [];
  const context = {
    electronLimitsFetch: () => 'fetch',
    ensureMimoExchangeFetch: () => 'mimo',
    electronStepfunSignIn: 'signIn',
    stepfunErrorLogger: (logger) => (message) => {
      recorded.push(message);
      if (typeof logger === 'function') logger(message);
    },
    // The slice runs up to the next function declaration, so it carries the
    // module-level requires between the two. They only need to bind; nothing
    // here calls what they produce.
    require: () => new Proxy({}, { get: () => () => {} })
  };
  const body = extractFunction(main, 'electronProviderDeps');
  const build = vm.runInNewContext(`${body}\nelectronProviderDeps`, context);

  const deps = build({ logger: (message) => forwarded.push(message) });
  deps.logger('stepfun probe failed');

  assert.deepEqual(recorded, ['stepfun probe failed'], 'the disk trail is written even when a logger exists');
  assert.deepEqual(forwarded, ['stepfun probe failed'], "and the caller's own logger still sees it");
});