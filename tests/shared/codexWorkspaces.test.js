'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CODEX_WORKSPACES_URL,
  authWithSelectedCodexWorkspace,
  codexOAuthCredentials,
  listCodexWorkspaces,
  normalizeCodexWorkspaces
} = require('../../src/shared/codexWorkspaces');

test('codexOAuthCredentials reads snake and camel case token fields', () => {
  assert.deepEqual(codexOAuthCredentials({
    tokens: {
      access_token: ' access ',
      account_id: ' WORKSPACE-ONE '
    }
  }), {
    accessToken: 'access',
    accountId: 'workspace-one'
  });
  assert.deepEqual(codexOAuthCredentials({
    tokens: {
      accessToken: 'camel',
      accountId: 'Workspace-Two'
    }
  }), {
    accessToken: 'camel',
    accountId: 'workspace-two'
  });
  assert.equal(codexOAuthCredentials({ tokens: {} }), null);
});

test('normalizeCodexWorkspaces dedupes ids and labels unnamed personal workspaces', () => {
  assert.deepEqual(normalizeCodexWorkspaces({
    items: [
      { id: ' Workspace-One ', name: ' Team One ' },
      { id: 'workspace-one', name: 'duplicate' },
      { id: 'personal', name: '' },
      { id: '', name: 'invalid' }
    ]
  }), [
    { id: 'workspace-one', label: 'Team One', workspaceKind: '' },
    { id: 'personal', label: '', workspaceKind: 'personal' }
  ]);
});

test('listCodexWorkspaces uses the selected account header without exposing credentials', async () => {
  let request = null;
  const workspaces = await listCodexWorkspaces({
    tokens: {
      access_token: 'secret-access-token',
      account_id: 'workspace-current'
    }
  }, {
    signal: new AbortController().signal,
    fetch: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          items: [
            { id: 'workspace-current', name: 'Current Team' },
            { id: 'workspace-other', name: 'Other Team' }
          ]
        })
      };
    }
  });

  assert.equal(request.url, CODEX_WORKSPACES_URL);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-access-token');
  assert.equal(request.options.headers['ChatGPT-Account-Id'], 'workspace-current');
  assert.equal(request.options.headers['User-Agent'], 'codex-cli');
  assert.deepEqual(workspaces, [
    { id: 'workspace-current', label: 'Current Team', workspaceKind: '' },
    { id: 'workspace-other', label: 'Other Team', workspaceKind: '' }
  ]);
});

test('listCodexWorkspaces warns diagnostically when a successful response has no usable accounts', async () => {
  const warnings = [];
  const workspaces = await listCodexWorkspaces({
    tokens: { access_token: 'secret-access-token' }
  }, {
    logger: { warn: (message) => warnings.push(message) },
    fetch: async () => ({
      ok: true,
      json: async () => ({ accounts: [], request_id: 'private-value' })
    })
  });

  assert.deepEqual(workspaces, []);
  assert.deepEqual(warnings, [
    '[codex] Workspace lookup returned no usable accounts; top-level keys: accounts, request_id'
  ]);
  assert.doesNotMatch(warnings[0], /secret-access-token|private-value/);
});

test('listCodexWorkspaces accepts a legitimate empty account list without warning', async () => {
  const warnings = [];
  const workspaces = await listCodexWorkspaces({
    tokens: { access_token: 'secret-access-token' }
  }, {
    logger: { warn: (message) => warnings.push(message) },
    fetch: async () => ({
      ok: true,
      json: async () => ({ items: [] })
    })
  });

  assert.deepEqual(workspaces, []);
  assert.deepEqual(warnings, []);
});

test('listCodexWorkspaces composes caller cancellation with its timeout', async () => {
  const caller = new AbortController();
  let requestSignal = null;
  const pending = listCodexWorkspaces({
    tokens: { access_token: 'access' }
  }, {
    signal: caller.signal,
    timeoutMs: 10_000,
    fetch: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
  });

  assert.notEqual(requestSignal, caller.signal);
  caller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('listCodexWorkspaces still times out when a caller signal is supplied', async () => {
  // AbortSignal.timeout() intentionally uses an unref'ed timer in Node 22.
  // Keep this test alive long enough to observe that timeout deterministically.
  const keepAlive = setTimeout(() => {}, 100);
  const pending = listCodexWorkspaces({
    tokens: { access_token: 'access' }
  }, {
    signal: new AbortController().signal,
    timeoutMs: 5,
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    })
  });

  try {
    await assert.rejects(pending, { name: 'TimeoutError' });
  } finally {
    clearTimeout(keepAlive);
  }
});

test('listCodexWorkspaces returns no workspaces without OAuth credentials', async () => {
  let called = false;
  const result = await listCodexWorkspaces({ OPENAI_API_KEY: 'sk-test' }, {
    fetch: async () => {
      called = true;
      throw new Error('should not fetch');
    }
  });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test('authWithSelectedCodexWorkspace preserves auth material and writes canonical account_id', () => {
  const auth = {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'access',
      refresh_token: 'refresh',
      accountId: 'old'
    }
  };
  const selected = authWithSelectedCodexWorkspace(auth, ' WORKSPACE-TEAM ');
  assert.equal(selected.auth_mode, 'chatgpt');
  assert.equal(selected.tokens.access_token, 'access');
  assert.equal(selected.tokens.refresh_token, 'refresh');
  assert.equal(selected.tokens.account_id, 'workspace-team');
  assert.equal(Object.hasOwn(selected.tokens, 'accountId'), false);
  assert.equal(auth.tokens.accountId, 'old');
});
