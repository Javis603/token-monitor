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
//
// `cookiesByUrl` is the default shape of the world: the login page's cookies
// live on account.stepfun.com while platform.stepfun.com keeps the anonymous
// token its own page load issued. Handing one flat list to both origins is the
// simplification that hid the bug this file exists to catch.
function loadSigner({
  cookies = [],
  cookiesByUrl = null,
  signedIn = false,
  acceptToken = null,
  settings = {},
  windowResult = null
} = {}) {
  const opened = [];
  const verifications = [];
  const partitions = [];
  const sessions = [];
  const context = {
    settings,
    BrowserWindow: { marker: 'BrowserWindow' },
    stepfunPartition: login.stepfunPartition,
    readOasisSessions: (target) => login.readOasisSessions(target),
    session: {
      fromPartition: (name) => {
        partitions.push(name);
        const created = {
          cookies: {
            get: async (filter) => (cookiesByUrl ? (cookiesByUrl[filter.url] || []) : cookies)
          },
          name
        };
        sessions.push(created);
        return created;
      }
    },
    // `acceptToken` lets one candidate be accepted and another refused, which is
    // the whole point of putting more than one origin in front of the site.
    verifyStepfunSession: async (candidate) => {
      verifications.push(candidate);
      const ok = acceptToken ? acceptToken.includes(candidate.token) : signedIn;
      return { ok, body: ok ? { status: 1, subscription: { name: 'Step Pro' } } : null };
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

  // The PLAN_URL body that proved the session rides along, so the quota probe can
  // skip asking the same endpoint again a moment later. Compared field by field:
  // these crossed a vm realm boundary, where deepEqual rejects reference-equal
  // looking objects.
  assert.equal(result.token, 'tok');
  assert.equal(result.webid, 'web');
  assert.equal(result.plan?.subscription?.name, 'Step Pro');
  assert.equal(opened.length, 0, 'a live session must not interrupt the user');
  assert.equal(verifications.length, 1, 'reuse is decided by asking the site, not by the jar');
  assert.equal(verifications[0].token, 'tok');
  assert.equal(verifications[0].webid, 'web');
});

test('the live session is found on the account origin, not just the platform one', async () => {
  // The reason the origin list exists. After a real sign-in the signed-in pair
  // lives on account.stepfun.com (host-only) while platform.stepfun.com keeps
  // the anonymous token. A reader scoped to platform alone sees only the
  // anonymous one and reports a live session as dead, popping the window on
  // every single probe.
  const { signIn, opened, verifications } = loadSigner({
    cookiesByUrl: {
      [login.ACCOUNT_COOKIE_URL]: [cookie(login.OASIS_TOKEN, 'tok-live'), cookie(login.OASIS_WEBID, 'web-live')],
      [login.COOKIE_URL]: [cookie(login.OASIS_TOKEN, 'tok-anon'), cookie(login.OASIS_WEBID, 'web-anon')]
    },
    acceptToken: ['tok-live']
  });

  const result = await signIn({ username: 'me', password: 'pw' });

  assert.equal(result.token, 'tok-live');
  assert.equal(opened.length, 0, 'no window: the account origin held the live session');
  assert.deepEqual(verifications.map((entry) => entry.token), ['tok-live'],
    'the account origin is tried first and is accepted, so the anonymous one is never asked about');
});

test('a refused candidate does not stop the next origin being tried', async () => {
  const { signIn, opened } = loadSigner({
    cookiesByUrl: {
      [login.ACCOUNT_COOKIE_URL]: [cookie(login.OASIS_TOKEN, 'tok-stale'), cookie(login.OASIS_WEBID, 'web-a')],
      [login.COOKIE_URL]: [cookie(login.OASIS_TOKEN, 'tok-live'), cookie(login.OASIS_WEBID, 'web-b')]
    },
    acceptToken: ['tok-live']
  });

  const result = await signIn({});

  assert.equal(result.token, 'tok-live');
  assert.equal(result.webid, 'web-b', 'the device id travels with its own token, not the other one');
  assert.equal(opened.length, 0);
});

test('the window is handed the same site verdict the reuse check uses', async () => {
  // Otherwise the flow falls back to comparing cookie strings inside the window
  // — which is the thing that reported a successful sign-in as a failure.
  const { signIn, opened } = loadSigner({ cookies: [cookie(login.OASIS_TOKEN, 'tok')] });

  await signIn({ username: 'me', password: 'pw' });

  assert.equal(typeof opened[0].verifySession, 'function',
    'the window flow has to be able to ask the site too');
  // The whole verdict crosses, not just its boolean: the body behind a 200 is
  // a PLAN_URL response, and the login round would otherwise fetch that same
  // endpoint again moments later for the account label.
  const verdict = await opened[0].verifySession({ token: 'tok', webid: 'web' });
  assert.equal(verdict.ok, false,
    'and it answers with that candidate\'s own verdict');
  assert.equal(verdict.body, null);
});

test('the verdict handed to the window carries the plan body on acceptance', async () => {
  // The whole verdict crosses, not just its boolean: the 200 behind an
  // acceptance is a PLAN_URL response the login round already paid for, and
  // handing only `.ok` on would make the probe fetch that same endpoint again
  // moments later for the account label.
  const { signIn, opened } = loadSigner({ cookies: [], signedIn: true });

  await signIn({ username: 'me', password: 'pw' });

  const verdict = await opened[0].verifySession({ token: 'tok', webid: 'web' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.body?.subscription?.name, 'Step Pro',
    'the plan body the session check produced rides along with the verdict');
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

test('the partition is scoped to the account being signed in', async () => {
  // One jar per account: a shared partition means the newest password login
  // evicts the previous account's session, and only the most recent account
  // could ever be renewed — every other StepFun row was stuck on a manual
  // paste. A token-only setup has no username and keeps the shared name.
  const scoped = loadSigner({ cookies: [], settings: {} });
  await scoped.signIn({ username: 'me@example.com', password: 'pw' });
  const accountPartition = login.stepfunPartition({ account: 'me@example.com' });
  assert.deepEqual(scoped.partitions, [accountPartition]);
  assert.equal(scoped.opened[0].partition, accountPartition,
    'the window and the cookie reader share the account-scoped jar');
  assert.ok(accountPartition.startsWith('persist:stepfun-login-'),
    'an account partition is its own on-disk jar, still persisted');

  const other = loadSigner({ cookies: [], settings: {} });
  await other.signIn({ username: 'other@example.com', password: 'pw' });
  assert.notEqual(other.partitions[0], accountPartition,
    'a second account must not sign in over the first account\'s jar');
});

test('only an explicit opt-out turns off the persisted session', async () => {
  // The form stores '1'/'0' because the framework has no checkbox, but the same
  // key can arrive as a number or a boolean from a hand-edited settings file.
  // The old `!== '0'` test read `false` as "remember", so a user who had turned
  // the option off by hand still got a session written to disk, with no symptom
  // that explained why.
  const read = (value) => {
    const context = {
      settings: value === undefined ? {} : { stepfunRememberLogin: value }
    };
    const body = extractFunction(main, 'stepfunRememberLogin');
    return vm.runInNewContext(`${body}\nstepfunRememberLogin`, context)();
  };

  for (const off of ['0', 0, false, 'false', 'OFF', ' off ', 'no']) {
    assert.equal(read(off), false, `${JSON.stringify(off)} must opt out`);
  }
  // Absent, empty and unrecognised values keep the default: a fresh install, or
  // a settings file written by a future version, must not silently wipe the
  // login the user already has.
  for (const on of ['1', 1, true, 'true', '', undefined, null, 'whatever']) {
    assert.equal(read(on), true, `${JSON.stringify(on)} must persist`);
  }
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

test('stepfunPartition scopes the jar to one account', () => {
  const scoped = login.stepfunPartition({ account: 'Me@Example.com' });
  assert.equal(login.stepfunPartition({ account: 'me@example.com' }), scoped,
    'the identity is lowercased, exactly like the account key');
  assert.ok(scoped.startsWith('persist:stepfun-login-'),
    'an account partition is a distinct on-disk jar');
  assert.notEqual(scoped, login.stepfunPartition({ account: 'other@example.com' }),
    'two accounts are two jars, so neither login can evict the other');
  assert.ok(!scoped.includes('example.com'),
    'the username itself must not land in a directory name');
  assert.equal(login.stepfunPartition({ account: '  ' }), 'persist:stepfun-login',
    'a blank account is no account at all');
  assert.ok(!login.stepfunPartition({ account: 'me', remember: false }).startsWith('persist:'),
    'and opting out still gives up the on-disk session');
});

test('clearing the account also forgets the browser session', async () => {
  // The cookie jar IS the session. Wiping only the stored values leaves a
  // still-authenticated partition behind, so the next probe signs in again from
  // a session the user just told the app to remove.
  const disposed = [];
  const removed = [];
  const failures = [];
  const context = {
    settings: { stepfunUsername: 'me@example.com' },
    stepfunPartition: login.stepfunPartition,
    disposeStepFunWindow: (partition) => disposed.push(partition),
    ACCOUNT_COOKIE_URL: login.ACCOUNT_COOKIE_URL,
    COOKIE_URL: login.COOKIE_URL,
    OASIS_TOKEN: login.OASIS_TOKEN,
    OASIS_WEBID: login.OASIS_WEBID,
    appendStepFunDiagnostic: (line) => failures.push(line),
    session: {
      fromPartition: (name) => ({
        cookies: {
          // Shaped to the real Electron 43.4 signature on purpose. Measured:
          // cookies.remove(url, filter) takes ONE string there — a string array,
          // a { name } object and a Cookie object all throw "conversion failure
          // from". The old call passed an array, so it threw every time, the
          // try/catch swallowed it, and Clear reported success while removing
          // nothing. A mock that accepts whatever it is handed agrees with all
          // of that, which is why this one refuses the shapes Electron refuses.
          remove: async (url, filter) => {
            if (typeof filter !== 'string') {
              throw new TypeError(`Error processing argument at index 1, conversion failure from ${typeof filter}`);
            }
            removed.push([name, url, filter]);
          }
        }
      })
    }
  };
  const body = [
    extractFunction(main, 'stepfunRememberLogin'),
    extractFunction(main, 'clearStepfunLoginSession')
  ].join('\n');
  const clear = vm.runInNewContext(`${body}\nclearStepfunLoginSession`, context);

  await clear();

  // BOTH partitions of BOTH kinds. Switching "remember this login" off leaves
  // the persisted cookies on disk by design — but Clear says "forget this
  // login", and a user who cleared while the option was off would otherwise
  // find the old session still sitting there, one toggle away from returning.
  // The account's own partition comes along too: it is where a sign-in lands
  // now, so wiping only the shared name would leave the very session being
  // cleared alive under persist:stepfun-login-<hash>.
  const accountPersist = login.stepfunPartition({ remember: true, account: 'me@example.com' });
  const accountThrowaway = login.stepfunPartition({ remember: false, account: 'me@example.com' });
  assert.deepEqual(disposed, ['persist:stepfun-login', accountPersist, 'stepfun-login', accountThrowaway],
    'every partition that can hold a session releases its retained window, not just the active one');
  assert.deepEqual([...new Set(removed.map((entry) => entry[0]))],
    ['persist:stepfun-login', accountPersist, 'stepfun-login', accountThrowaway],
    'the account-scoped partition is wiped alongside the shared ones');
  assert.equal(removed.length, 16, 'four partitions × two origins × two cookie names');
  // Both origins: the signed-in pair is host-only on account.stepfun.com, so
  // removing only the platform-scoped entry leaves a working session behind.
  assert.deepEqual([...new Set(removed.map((entry) => entry[1]))], [login.ACCOUNT_COOKIE_URL, login.COOKIE_URL]);
  assert.deepEqual([...new Set(removed.map((entry) => entry[2]))], [login.OASIS_TOKEN, login.OASIS_WEBID],
    'one cookie name per call — the array form is rejected by the real API');
  assert.deepEqual(failures, [],
    'nothing threw: a swallowed failure here is exactly how Clear came to remove nothing');
});

test('saving a pasted cookie keeps BOTH halves of it', () => {
  // This one is worth stating as its own test rather than trusting the generic
  // wiring suite: that suite computes the expected value BY CALLING the same
  // normalizer the code uses, so it agrees with whatever the normalizer does —
  // including the bug this guards.
  //
  // The registry derives a write-time normalizer from a field's `resolve` when
  // the field declares none (registry.js: `normalize || resolverNormalize`), and
  // `stepfunToken` is the function that squeezes a pasted cookie string down to
  // its token field. So saving a paste used to store only the token and drop
  // Oasis-Webid — the device id the endpoint answers 401 "oasis-token is
  // embezzled" without. The manual lane broke on the act of saving it.
  const { normalizeAccountField } = require('../../src/electron/limits/accountSettings');
  const paste = '  Oasis-Token=eyJabc; Oasis-Webid=dev-9; INGRESSCOOKIE=ing  ';
  const stored = normalizeAccountField('stepfunToken', paste);

  assert.equal(typeof stored, 'string', 'a credential slot must hold a string, not the parsed pair');
  assert.match(stored, /Oasis-Token=eyJabc/, 'the token half survives');
  assert.match(stored, /Oasis-Webid=dev-9/,
    'the device id survives the save — it is the half the endpoint cannot do without');
  assert.equal(stored, stored.trim(), 'and the surrounding whitespace is trimmed');
});

test('a refused candidate is reported with the origin it came from', async () => {
  // The site check answers a bare status code, and the two origins hold
  // different things: account.stepfun.com is where the login page issues its
  // pair, platform.stepfun.com is where the quota page's own anonymous token
  // lives. Which one the site just refused is the first thing needed when this
  // stops working, and "401" alone cannot answer it.
  const lines = [];
  const { signIn } = loadSigner({
    cookiesByUrl: {
      [login.ACCOUNT_COOKIE_URL]: [cookie(login.OASIS_TOKEN, 'tok-stale'), cookie(login.OASIS_WEBID, 'web-a')],
      [login.COOKIE_URL]: [cookie(login.OASIS_TOKEN, 'tok-live'), cookie(login.OASIS_WEBID, 'web-b')]
    },
    acceptToken: ['tok-live']
  });

  await signIn({ logger: (line) => lines.push(line) });

  assert.ok(
    lines.some((line) => /refused the cookie held on account\.stepfun\.com/.test(line)),
    `the refused origin has to be named, got: ${JSON.stringify(lines)}`
  );
  assert.ok(!lines.some((line) => /held on platform\.stepfun\.com/.test(line)),
    'and the origin that was accepted must not be reported as refused');
});

test('a probe with nothing to refuse writes no refusal line', async () => {
  // This log is capped at a few hundred lines and every probe appends to it, so
  // a diagnostic that fires on the healthy path is a diagnostic that crowds out
  // the one you actually wanted.
  const lines = [];
  const { signIn, opened } = loadSigner({
    cookies: [cookie(login.OASIS_TOKEN, 'tok'), cookie(login.OASIS_WEBID, 'web')],
    signedIn: true
  });

  await signIn({ logger: (line) => lines.push(line) });

  assert.equal(opened.length, 0);
  assert.deepEqual(lines.filter((line) => /refused/.test(line)), []);
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