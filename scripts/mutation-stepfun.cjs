'use strict';

// Mutation harness: revert one fix at a time and confirm the new assertions
// actually go red. A test that passes both before and after the change is not
// testing the change — and this branch has shipped bugs that looked like that.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS = [
  'tests/electron/stepfunBrowserLogin.test.js',
  'tests/electron/stepfunMainSignIn.test.js',
  'tests/shared/stepfunLogin.test.js',
  'tests/electron/limitAccountPanels.test.js',
  'tests/electron/limitProviderWiring.test.js'
];

const MUTANTS = [
  {
    name: 'M5  restore the useId tab trigger ahead of the label match',
    file: 'src/electron/providers/stepfun/login.js',
    from: `const tab = [...document.querySelectorAll('[role="tab"]')].find((el) =>`,
    to: `const byId = document.querySelector('#radix-\\xABR3nndl9b\\xBB-trigger-password');
    const tab = byId || [...document.querySelectorAll('[role="tab"]')].find((el) =>`
  },
  {
    name: 'M6  clear only the partition the setting selects',
    file: 'src/electron/main.js',
    from: 'for (const remember of [true, false]) {',
    to: 'for (const remember of [stepfunRememberLogin()]) {'
  },
  {
    name: 'M7  partition switch back to a bare !== "0"',
    file: 'src/electron/main.js',
    from: `  const value = settings?.stepfunRememberLogin;
  if (value === null || value === undefined || value === '') return true;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());`,
    to: `  return settings?.stepfunRememberLogin !== '0';`
  },
  {
    name: 'M8  account key gated on a complete credential pair again',
    file: 'src/shared/providers/stepfun/limits.js',
    from: `const accountIdentity = stepfunAccount(env, options).toLowerCase();
const accountKey = accountIdentity`,
    to: `const accountIdentity = credentials ? credentials.username.toLowerCase() : '';
const accountKey = accountIdentity`
  },
  {
    name: 'M9  let the registry re-derive stepfunToken\'s normalizer',
    file: 'src/shared/providers/stepfun/account.js',
    from: `      // normalizeOasisCookie to take apart at probe time.
      normalize: 'trim',`,
    to: `      // normalizeOasisCookie to take apart at probe time.`
  },
  {
    name: 'M10 session check trusts any non-throwing response',
    file: 'src/shared/providers/stepfun/limits.js',
    from: `    if (response.status !== 200) return { ok: false, body: null };`,
    to: `    if (response.status === 200) return { ok: true, body: null };`
  },
  {
    name: 'M11 forget which pairs the site already refused',
    file: 'src/electron/providers/stepfun/login.js',
    from: `            if (!candidate.token || rejected.has(candidate.token)) continue;`,
    to: `            if (!candidate.token) continue;`
  },
  {
    name: 'M12 the window flow stops asking the site altogether',
    file: 'src/electron/providers/stepfun/login.js',
    from: `            if (typeof verifySession === 'function') {`,
    to: `            if (false) {`
  },
  {
    name: 'M13 the plan body from the session check is discarded',
    file: 'src/shared/providers/stepfun/limits.js',
    from: `      const plan = planFromSignIn ?? await runWithProbeDeadline(`,
    to: `      const plan = await runWithProbeDeadline(`
  },
  {
    name: 'M14 the remembered-session switch treats an absent value as opt-out',
    file: 'src/electron/main.js',
    from: `  if (value === null || value === undefined || value === '') return true;`,
    to: `  if (!value) return false;`
  },
  {
    name: 'M15 one origin is read, the other is never consulted',
    file: 'src/electron/providers/stepfun/login.js',
    from: `const SESSION_COOKIE_URLS = [ACCOUNT_COOKIE_URL, COOKIE_URL];`,
    to: `const SESSION_COOKIE_URLS = [COOKIE_URL];`
  },
  {
    // The real bug the Electron probe found: 43.4 rejects the array form, the
    // try/catch swallowed the throw, and Clear had never removed anything.
    name: 'M16 clear goes back to passing the names as an array',
    file: 'src/electron/main.js',
    from: `      for (const name of [OASIS_TOKEN, OASIS_WEBID]) {
        try {
          await session.fromPartition(partition).cookies.remove(url, name);
        } catch (error) {
          appendStepFunDiagnostic(\`stepfun clear failed on \${partition} \${url} \${name}: \${error.message}\`);
        }
      }`,
    to: `      try {
        await session.fromPartition(partition).cookies.remove(url, [OASIS_TOKEN, OASIS_WEBID]);
      } catch (error) {
        appendStepFunDiagnostic(\`stepfun clear failed on \${partition} \${url}: \${error.message}\`);
      }`
  }
];

const run = () => {
  const result = spawnSync(process.execPath, ['--test', ...TESTS], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  const pass = /^ℹ pass (\d+)$/m.exec(out);
  const fail = /^ℹ fail (\d+)$/m.exec(out);
  return { pass: pass ? pass[1] : '?', fail: fail ? fail[1] : '?' };
};

const write = (file, text) =>
  fs.writeFileSync(path.join(ROOT, file), text, 'utf8');

console.log(`baseline: ${JSON.stringify(run())}`);

let missed = 0;
for (const mutant of MUTANTS) {
  const full = path.join(ROOT, mutant.file);
  const original = fs.readFileSync(full, 'utf8');
  if (!original.includes(mutant.from)) {
    console.log(`${mutant.name}\n  PATCH TARGET MISS`);
    missed += 1;
    continue;
  }
  // The restore has to be unconditional. This script edits source files in
  // place, so a test run that dies — a timeout, a crash, Ctrl-C — would
  // otherwise leave the mutation committed and the next person to run the
  // suite debugging a bug that is not in the tree they are looking at.
  try {
    write(mutant.file, original.replace(mutant.from, mutant.to));
    const result = run();
    const killed = Number(result.fail) > 0;
    if (!killed) missed += 1;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${mutant.name} -> ${JSON.stringify(result)}`);
  } finally {
    write(mutant.file, original);
  }
}
console.log(missed === 0 ? 'every mutant was caught' : `${missed} mutant(s) not caught or not applied`);