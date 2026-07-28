'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { claudeCommandCandidates, claudeWebCookie, fetchClaudeLimits, mapClaudeCliUsageToProvider, mapClaudeUsageToProvider, normalizeClaudeWebCookieInput } = require('../../src/shared/limitCollector');

function fakeSpawnForClaudeUsage(expectedCommand = 'claude.cmd') {
  return (command, args) => {
    assert.equal(command, expectedCommand);
    assert.deepEqual(args, ['/usage']);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from([
        'Current session',
        '95% left',
        'Resets 6pm',
        'Current week',
        '80% left',
        'Resets Jun 18'
      ].join('\n')));
      child.emit('close', 0);
    });
    return child;
  };
}

const DEFAULT_CLAUDE_PROFILE = {
  account: {
    uuid: 'account-default',
    email: 'owner@example.com'
  },
  organization: {
    uuid: 'organization-default',
    name: 'Example Workspace'
  }
};

function fakeClaudeOauthFetch(usage, profile = DEFAULT_CLAUDE_PROFILE) {
  return async (url) => ({
    ok: true,
    json: async () => url.endsWith('/api/oauth/profile') ? profile : usage
  });
}

test('Claude Web accepts only a bare or canonical sk-ant sessionKey', () => {
  assert.equal(
    claudeWebCookie({}, { claudeWebCookie: 'sessionKey=sk-ant-sid01-example' }),
    'sessionKey=sk-ant-sid01-example'
  );
  assert.equal(
    claudeWebCookie({}, { claudeWebCookie: 'sk-ant-sid01-example' }),
    'sessionKey=sk-ant-sid01-example'
  );
  assert.equal(
    claudeWebCookie({ CLAUDE_WEB_COOKIE: 'sessionKey=sk-ant-from-env' }),
    'sessionKey=sk-ant-from-env'
  );
  assert.equal(
    claudeWebCookie(
      { CLAUDE_WEB_COOKIE: 'sessionKey=sk-ant-from-env' },
      { claudeWebCookie: '' }
    ),
    ''
  );
  assert.throws(
    () => normalizeClaudeWebCookieInput('Cookie: sessionKey=sk-ant-secret; other=value'),
    (error) => error?.code === 'INVALID_CLAUDE_WEB_SESSION_KEY'
  );
  assert.throws(
    () => normalizeClaudeWebCookieInput('anthropic-device-id=device; other=value'),
    (error) => error?.code === 'INVALID_CLAUDE_WEB_SESSION_KEY'
  );
  assert.throws(
    () => normalizeClaudeWebCookieInput('not-a-session-key'),
    (error) => error?.code === 'INVALID_CLAUDE_WEB_SESSION_KEY'
  );
  assert.equal(normalizeClaudeWebCookieInput(''), '');
});

test('Claude Web source takes precedence and carries stable account metadata', async () => {
  async function collect(cookie) {
    const requests = [];
    const provider = await fetchClaudeLimits({ claudeWebCookie: cookie }, {
      now: () => Date.parse('2026-07-25T00:00:00Z'),
      stat: async () => {
        throw new Error('OAuth credentials must not be read when Web is configured');
      },
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/api/organizations')) {
          return {
            ok: true,
            json: async () => [{ uuid: 'organization-web', name: 'Example Workspace' }]
          };
        }
        if (url.endsWith('/api/organizations/organization-web/usage')) {
          return {
            ok: true,
            json: async () => ({
              five_hour: {
                utilization: 21,
                resets_at: '2026-07-25T05:00:00Z'
              },
              seven_day: {
                utilization: 35,
                resets_at: '2026-08-01T00:00:00Z'
              }
            })
          };
        }
        if (url.endsWith('/prepaid/credits')) {
          // The common case: an account that never funded a prepaid pool.
          return { ok: true, json: async () => ({ amount: 0, currency: 'USD' }) };
        }
        assert.ok(url.endsWith('/api/account'));
        return {
          ok: true,
          json: async () => ({
            uuid: 'account-web',
            email_address: 'Owner@Example.com',
            memberships: [{
              organization: { uuid: 'organization-web', name: 'Example Workspace' },
              seat_tier: 'max',
              rate_limit_tier: 'default_claude_max_20x'
            }]
          })
        };
      }
    });
    return { provider, requests };
  }

  const first = await collect('sessionKey=sk-ant-first-cookie');
  const second = await collect('sessionKey=sk-ant-rotated-cookie');

  assert.equal(first.provider.source, 'web');
  assert.equal(first.provider.accountKey, second.provider.accountKey);
  assert.equal(first.provider.accountEmail, 'owner@example.com');
  assert.equal(first.provider.accountName, 'Example Workspace');
  assert.equal(first.provider.accountLabel, 'Max 20x');
  assert.deepEqual(first.provider.windows.map((window) => window.kind), ['session', 'weekly']);
  // The pool is asked for, comes back unfunded, and so contributes no row.
  assert.equal(first.provider.balance, null);
  assert.equal(first.requests.length, 4);
  assert.equal(first.requests[3].url.endsWith('/prepaid/credits'), true);
  assert.equal(first.requests[0].options.headers.cookie, 'sessionKey=sk-ant-first-cookie');
  // This collector runs on undici, so it carries the browser agent. Pinned
  // verbatim: Cloudflare challenges every non-browser user-agent on this host, so
  // swapping in the honest `token-monitor/<version>` agent would 403 the whole
  // provider on the headless agent.
  assert.deepEqual(first.requests[0].options.headers, {
    accept: 'application/json',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    cookie: 'sessionKey=sk-ant-first-cookie'
  });
  // Cloudflare challenges per request, so every hop needs the agent, not just the
  // first one that happens to be asserted above.
  assert.equal(
    first.requests.every(({ options }) => /Chrome\/[\d.]+ Safari/.test(options.headers['user-agent'] || '')),
    true,
    'every Claude Web request should carry the browser user-agent'
  );
  assert.equal(first.requests[0].url.endsWith('/api/organizations'), true);
  assert.equal(first.requests[1].url.endsWith('/api/organizations/organization-web/usage'), true);
  assert.equal(first.requests[2].url.endsWith('/api/account'), true);
});

test('Claude Web leaves the user-agent to Chromium when the widget supplies the transport', async () => {
  const requests = [];
  await fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-widget' }, {
    now: () => Date.parse('2026-07-25T00:00:00Z'),
    stat: async () => {
      throw new Error('OAuth credentials must not be read when Web is configured');
    },
    fetch: async () => {
      throw new Error('the widget transport must be used when one is supplied');
    },
    claudeWebFetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/api/organizations')) {
        return { ok: true, json: async () => [{ uuid: 'organization-web', name: 'Example Workspace' }] };
      }
      if (url.endsWith('/prepaid/credits')) {
        return { ok: true, json: async () => ({ amount: 0, currency: 'USD' }) };
      }
      if (url.endsWith('/api/account')) {
        return { ok: true, json: async () => ({ email_address: 'owner@example.com' }) };
      }
      return { ok: true, json: async () => ({ five_hour: { utilization: 10 } }) };
    }
  });

  // Electron's net.request already sends a browser agent that tracks the bundled
  // Chromium; setting one here would pin the widget to a stale version instead.
  assert.ok(requests.length > 0);
  for (const { url, options } of requests) {
    assert.equal(options.headers['user-agent'], undefined, `${url} should carry no user-agent`);
  }
  assert.equal(requests[0].options.headers.cookie, 'sessionKey=sk-ant-widget');
});

test('Claude Web follows a renewed sessionKey across sequential requests and reports it for persistence', async () => {
  const requests = [];
  const renewals = [];
  const provider = await fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-old' }, {
    providerRuntimeState: new Map(),
    onClaudeWebCookieRenewed: (renewal) => renewals.push(renewal),
    fetch: async (url, options) => {
      requests.push({ url, cookie: options.headers.cookie });
      if (url.endsWith('/api/organizations')) {
        return {
          ok: true,
          headers: {
            getSetCookie: () => ['sessionKey=sk-ant-renewed; Path=/; Secure; HttpOnly']
          },
          json: async () => [{ uuid: 'organization-web', name: 'Workspace' }]
        };
      }
      if (url.endsWith('/usage')) {
        return {
          ok: true,
          json: async () => ({
            five_hour: {
              utilization: 21,
              resets_at: '2026-07-25T05:00:00Z'
            }
          })
        };
      }
      if (url.endsWith('/prepaid/credits')) {
        return { ok: true, json: async () => ({ amount: 0, currency: 'USD' }) };
      }
      assert.ok(url.endsWith('/api/account'));
      return {
        ok: true,
        json: async () => ({
          uuid: 'account-web',
          email_address: 'owner@example.com'
        })
      };
    }
  });

  assert.equal(provider.status, 'ok');
  assert.deepEqual(requests.map((request) => request.cookie), [
    'sessionKey=sk-ant-old',
    'sessionKey=sk-ant-renewed',
    'sessionKey=sk-ant-renewed',
    'sessionKey=sk-ant-renewed'
  ]);
  assert.deepEqual(renewals, [{
    previousCookie: 'sessionKey=sk-ant-old',
    cookie: 'sessionKey=sk-ant-renewed'
  }]);
});

test('Claude Web reports a renewed sessionKey even when a later request fails', async () => {
  const renewals = [];
  await assert.rejects(
    fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-old' }, {
      providerRuntimeState: new Map(),
      onClaudeWebCookieRenewed: (renewal) => renewals.push(renewal),
      fetch: async (url) => {
        if (url.endsWith('/api/organizations')) {
          return {
            ok: true,
            headers: {
              getSetCookie: () => ['sessionKey=sk-ant-renewed; Path=/; Secure; HttpOnly']
            },
            json: async () => [{ uuid: 'organization-web', name: 'Workspace' }]
          };
        }
        if (url.endsWith('/usage')) {
          return {
            ok: true,
            json: async () => ({
              five_hour: {
                utilization: 21,
                resets_at: '2026-07-25T05:00:00Z'
              }
            })
          };
        }
        assert.ok(url.endsWith('/api/account'));
        return {
          ok: false,
          status: 503,
          headers: { get: () => '' },
          json: async () => ({})
        };
      }
    }),
    (error) => error?.code === 'CLAUDE_IDENTITY_UNAVAILABLE'
  );

  assert.deepEqual(renewals, [{
    previousCookie: 'sessionKey=sk-ant-old',
    cookie: 'sessionKey=sk-ant-renewed'
  }]);
});

test('Claude Web retries later rotation from the last persisted sessionKey after CAS rejection', async () => {
  const renewals = [];
  await fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-old' }, {
    providerRuntimeState: new Map(),
    onClaudeWebCookieRenewed: (renewal) => {
      renewals.push(renewal);
      return renewals.length > 1;
    },
    fetch: async (url, options) => {
      if (url.endsWith('/api/organizations')) {
        assert.equal(options.headers.cookie, 'sessionKey=sk-ant-old');
        return {
          ok: true,
          headers: {
            getSetCookie: () => ['sessionKey=sk-ant-first-renewal; Path=/; Secure; HttpOnly']
          },
          json: async () => [{ uuid: 'organization-web', name: 'Workspace' }]
        };
      }
      if (url.endsWith('/usage')) {
        assert.equal(options.headers.cookie, 'sessionKey=sk-ant-first-renewal');
        return {
          ok: true,
          headers: {
            getSetCookie: () => ['sessionKey=sk-ant-second-renewal; Path=/; Secure; HttpOnly']
          },
          json: async () => ({
            five_hour: {
              utilization: 21,
              resets_at: '2026-07-25T05:00:00Z'
            }
          })
        };
      }
      assert.ok(url.endsWith('/api/account'));
      assert.equal(options.headers.cookie, 'sessionKey=sk-ant-second-renewal');
      return {
        ok: true,
        json: async () => ({
          uuid: 'account-web',
          email_address: 'owner@example.com'
        })
      };
    }
  });

  assert.deepEqual(renewals, [
    {
      previousCookie: 'sessionKey=sk-ant-old',
      cookie: 'sessionKey=sk-ant-first-renewal'
    },
    {
      previousCookie: 'sessionKey=sk-ant-old',
      cookie: 'sessionKey=sk-ant-second-renewal'
    }
  ]);
});

test('Claude Web prefers chat-capable organizations, then non-API-only organizations', async () => {
  async function selectedUsageOrganization(organizations, cookie) {
    let usageOrganizationId = '';
    await fetchClaudeLimits({ claudeWebCookie: cookie }, {
      providerRuntimeState: new Map(),
      fetch: async (url) => {
        if (url.endsWith('/api/organizations')) {
          return { ok: true, json: async () => organizations };
        }
        if (url.endsWith('/api/account')) {
          return {
            ok: true,
            json: async () => ({
              uuid: 'account-web',
              email_address: 'owner@example.com'
            })
          };
        }
        const match = url.match(/\/api\/organizations\/([^/]+)\/usage$/);
        assert.ok(match);
        usageOrganizationId = decodeURIComponent(match[1]);
        return {
          ok: true,
          json: async () => ({
            five_hour: {
              utilization: 21,
              resets_at: '2026-07-25T05:00:00Z'
            }
          })
        };
      }
    });
    return usageOrganizationId;
  }

  assert.equal(
    await selectedUsageOrganization([
      { uuid: 'organization-api', capabilities: ['API'] },
      { uuid: 'organization-non-api', capabilities: ['files'] },
      { uuid: 'organization-chat', capabilities: ['CHAT', 'files'] }
    ], 'sessionKey=sk-ant-chat'),
    'organization-chat'
  );
  assert.equal(
    await selectedUsageOrganization([
      { uuid: 'organization-api', capabilities: ['api'] },
      { uuid: 'organization-non-api', capabilities: ['files'] }
    ], 'sessionKey=sk-ant-non-api'),
    'organization-non-api'
  );
  assert.equal(
    await selectedUsageOrganization([
      { uuid: 'organization-api-first', capabilities: ['api'] },
      { uuid: 'organization-api-second', capabilities: ['api'] }
    ], 'sessionKey=sk-ant-first'),
    'organization-api-first'
  );
});

test('Claude Web caches stable identity and reuses it when account lookup is transiently unavailable', async () => {
  const providerRuntimeState = new Map();
  let nowMs = Date.parse('2026-07-25T00:00:00Z');
  let accountAvailable = true;
  let utilization = 12;
  const requests = [];
  const deps = {
    now: () => nowMs,
    claudeIdentityCacheTtlMs: 1000,
    providerRuntimeState,
    fetch: async (url) => {
      requests.push(url);
      if (url.endsWith('/api/organizations')) {
        return { ok: true, json: async () => [{ uuid: 'organization-web', name: 'Workspace' }] };
      }
      if (url.endsWith('/api/account')) {
        return accountAvailable
          ? { ok: true, json: async () => ({ uuid: 'account-web', email: 'owner@example.com' }) }
          : { ok: false, status: 503 };
      }
      return {
        ok: true,
        json: async () => ({ five_hour: { utilization, resets_at: '2026-07-25T05:00:00Z' } })
      };
    }
  };

  const first = await fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-stable' }, deps);
  requests.length = 0;
  utilization = 23;
  const cached = await fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-stable' }, deps);
  assert.equal(cached.accountKey, first.accountKey);
  assert.equal(cached.windows[0].usedPercent, 23);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].endsWith('/usage'), true);

  requests.length = 0;
  nowMs += 2000;
  accountAvailable = false;
  utilization = 37;
  const second = await fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-stable' }, deps);

  assert.equal(second.accountKey, first.accountKey);
  assert.equal(second.windows[0].usedPercent, 37);
  assert.equal(requests.some((url) => url.endsWith('/api/account')), true);
  assert.equal(requests.some((url) => url.endsWith('/usage')), true);
});

test('Claude Web requires the account endpoint on a cold identity cache', async () => {
  await assert.rejects(
    fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-cold' }, {
      providerRuntimeState: new Map(),
      fetch: async (url) => {
        if (url.endsWith('/api/organizations')) {
          return { ok: true, json: async () => [{ uuid: 'organization-web' }] };
        }
        if (url.endsWith('/usage')) {
          return {
            ok: true,
            json: async () => ({
              five_hour: {
                utilization: 21,
                resets_at: '2026-07-25T05:00:00Z'
              }
            })
          };
        }
        return { ok: false, status: 403 };
      }
    }),
    (error) => (
      error?.status === 'unavailable'
      && error?.code === 'CLAUDE_IDENTITY_UNAVAILABLE'
      && error?.cause?.status === 'unauthorized'
    )
  );
});

test('Claude Web maps 403 to unauthorized without changing shared provider semantics', async () => {
  await assert.rejects(
    fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-expired' }, {
      fetch: async () => ({ ok: false, status: 403 })
    }),
    (error) => error?.status === 'unauthorized'
  );
});

test('Claude Web reports a Cloudflare challenge as unavailable instead of invalid credentials', async () => {
  await assert.rejects(
    fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-valid' }, {
      fetch: async () => ({
        ok: false,
        status: 403,
        headers: {
          get: (name) => String(name).toLowerCase() === 'cf-mitigated' ? 'challenge' : ''
        }
      })
    }),
    (error) => (
      error?.status === 'unavailable'
      && error?.code === 'CLAUDE_WEB_SOURCE_CHALLENGE'
    )
  );
});

test('Claude Web authentication failure does not silently fall back to another local account', async () => {
  let spawned = false;
  await assert.rejects(
    fetchClaudeLimits({ claudeWebCookie: 'sessionKey=sk-ant-expired' }, {
      fetch: async () => ({ ok: false, status: 401 }),
      spawn: () => {
        spawned = true;
        throw new Error('must not spawn');
      }
    }),
    (error) => error?.status === 'unauthorized'
  );
  assert.equal(spawned, false);
});

test('Claude limits fall back to direct CLI usage on Windows when OAuth usage is unavailable', async () => {
  const provider = await fetchClaudeLimits({}, {
    platform: 'win32',
    now: () => Date.parse('2026-06-11T00:00:00Z'),
    claudeCredentialPath: 'C:\\Users\\Javis\\.claude\\.credentials.json',
    stat: async () => ({ mtimeMs: 1 }),
    readFile: async () => JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.parse('2026-06-12T00:00:00Z')
      }
    }),
    fetch: async () => ({
      ok: false,
      status: 500
    }),
    existsSync: () => false,
    spawn: fakeSpawnForClaudeUsage()
  });

  assert.equal(provider.provider, 'claude');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'cli');
  assert.equal(provider.windows[0].kind, 'session');
  assert.equal(provider.windows[0].usedPercent, 5);
  assert.equal(provider.windows[1].kind, 'weekly');
  assert.equal(provider.windows[1].usedPercent, 20);
});

test('Claude limits fall back to CLI usage when OAuth credentials are not discoverable', async () => {
  let cliCalls = 0;
  const provider = await fetchClaudeLimits({}, {
    platform: 'darwin',
    now: () => Date.parse('2026-07-15T00:00:00Z'),
    claudeCredentialPath: '/tmp/missing-claude-credentials.json',
    stat: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    readMacKeychain: false,
    runClaudeUsageCli: async () => {
      cliCalls += 1;
      return [
        'Current session',
        '95% left',
        'Resets 6pm',
        'Current week',
        '80% left',
        'Resets Jul 22'
      ].join('\n');
    }
  });

  assert.equal(cliCalls, 1);
  assert.equal(provider.provider, 'claude');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'cli');
  assert.equal(provider.windows[0].usedPercent, 5);
  assert.equal(provider.windows[1].usedPercent, 20);
});

test('Claude limits read Windows Credential Manager credentials when credential files are absent', async () => {
  const provider = await fetchClaudeLimits({}, {
    platform: 'win32',
    now: () => Date.parse('2026-06-11T00:00:00Z'),
    claudeCredentialPath: 'C:\\Users\\Javis\\.claude\\.credentials.json',
    stat: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    readWindowsCredentialSecret: async (service, targets) => {
      assert.equal(service, 'Claude Code-credentials');
      assert.equal(targets.includes('Claude Code-credentials'), true);
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: 'credential-manager-token',
          refreshToken: 'credential-manager-refresh',
          expiresAt: Date.parse('2026-06-12T00:00:00Z'),
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_5x'
        }
      });
    },
    fetch: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer credential-manager-token');
      return {
        ok: true,
        json: async () => url.endsWith('/api/oauth/profile')
          ? DEFAULT_CLAUDE_PROFILE
          : {
              five_hour: {
                utilization: 12,
                resets_at: '2026-06-11T05:00:00Z'
              }
            }
      };
    }
  });

  assert.equal(provider.provider, 'claude');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'oauth');
  assert.equal(provider.accountLabel, 'Max 5x');
  assert.equal(provider.windows[0].usedPercent, 12);
});

test('Claude OAuth profile provides stable cross-device account identity and metadata', async () => {
  async function collect(credentialPath, accountUuid, organizationUuid) {
    return fetchClaudeLimits({}, {
      platform: 'linux',
      now: () => Date.parse('2026-07-25T00:00:00Z'),
      claudeCredentialPath: credentialPath,
      stat: async () => ({ mtimeMs: 1 }),
      readFile: async () => JSON.stringify({
        claudeAiOauth: {
          accessToken: `access-${credentialPath}`,
          refreshToken: `refresh-${credentialPath}`,
          expiresAt: Date.parse('2026-07-26T00:00:00Z'),
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_5x'
        }
      }),
      fetch: async (url) => ({
        ok: true,
        json: async () => url.endsWith('/api/oauth/profile')
          ? {
              account: {
                uuid: accountUuid,
                email: 'Owner@Example.com'
              },
              organization: {
                uuid: organizationUuid,
                name: 'Example Workspace'
              }
            }
          : {
              five_hour: {
                utilization: 12,
                resets_at: '2026-07-25T05:00:00Z'
              }
            }
      })
    });
  }

  const mac = await collect('/Users/test/.claude/.credentials.json', 'account-a', 'organization-a');
  const windows = await collect('C:\\Users\\test\\.claude\\.credentials.json', 'account-a', 'organization-changed');
  const other = await collect('/home/other/.claude/.credentials.json', 'account-b', 'organization-a');

  assert.equal(mac.accountKey, windows.accountKey);
  assert.notEqual(mac.accountKey, other.accountKey);
  assert.equal(mac.accountEmail, 'owner@example.com');
  assert.equal(mac.accountName, 'Example Workspace');
  assert.equal(mac.accountLabel, 'Max 5x');
});

test('Claude OAuth profile failures never derive account identity from rotating credentials', async () => {
  let cliCalls = 0;
  async function collect(refreshToken) {
    return fetchClaudeLimits({}, {
      platform: 'linux',
      now: () => Date.parse('2026-07-25T00:00:00Z'),
      claudeCredentialPath: '/same/path/.credentials.json',
      stat: async () => ({ mtimeMs: 1 }),
      readFile: async () => JSON.stringify({
        claudeAiOauth: {
          accessToken: `access-${refreshToken}`,
          refreshToken,
          expiresAt: Date.parse('2026-07-26T00:00:00Z'),
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_5x'
        }
      }),
      fetch: async (url) => ({
        ok: !url.endsWith('/api/oauth/profile'),
        status: url.endsWith('/api/oauth/profile') ? 503 : 200,
        json: async () => ({
          five_hour: {
            utilization: 12,
            resets_at: '2026-07-25T05:00:00Z'
          }
        })
      }),
      runClaudeUsageCli: async () => {
        cliCalls += 1;
        throw new Error('profile identity failures must retain the previous limits row');
      }
    });
  }

  for (const refreshToken of ['refresh-before-rotation', 'refresh-after-rotation']) {
    await assert.rejects(
      collect(refreshToken),
      (error) => error?.status === 'unavailable' && error?.code === 'CLAUDE_IDENTITY_UNAVAILABLE'
    );
  }
  assert.equal(cliCalls, 0);
});

test('Claude OAuth keeps fresh quota with cached identity when profile lookup is transiently unavailable', async () => {
  const providerRuntimeState = new Map();
  let nowMs = Date.parse('2026-07-25T00:00:00Z');
  let profileAvailable = true;
  let utilization = 12;
  const deps = {
    platform: 'linux',
    now: () => nowMs,
    claudeIdentityCacheTtlMs: 1000,
    providerRuntimeState,
    claudeCredentialPath: '/same/path/.credentials.json',
    stat: async () => ({ mtimeMs: 1 }),
    readFile: async () => JSON.stringify({
      claudeAiOauth: {
        accessToken: 'stable-access',
        refreshToken: 'stable-refresh',
        expiresAt: Date.parse('2026-07-26T00:00:00Z')
      }
    }),
    fetch: async (url) => {
      if (url.endsWith('/api/oauth/profile')) {
        return profileAvailable
          ? { ok: true, json: async () => DEFAULT_CLAUDE_PROFILE }
          : { ok: false, status: 503 };
      }
      return {
        ok: true,
        json: async () => ({ five_hour: { utilization, resets_at: '2026-07-25T05:00:00Z' } })
      };
    }
  };

  const first = await fetchClaudeLimits({}, deps);
  nowMs += 2000;
  profileAvailable = false;
  utilization = 44;
  const second = await fetchClaudeLimits({}, deps);

  assert.equal(second.accountKey, first.accountKey);
  assert.equal(second.windows[0].usedPercent, 44);
  assert.equal(second.source, 'oauth');
});

test('Claude OAuth usage mapping accepts camelCase response fields', async () => {
  const provider = await fetchClaudeLimits({}, {
    platform: 'linux',
    now: () => Date.parse('2026-06-11T00:00:00Z'),
    claudeCredentialPath: '/tmp/claude-credentials.json',
    stat: async () => ({ mtimeMs: 1 }),
    readFile: async () => JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-token',
        expiresAt: Date.parse('2026-06-12T00:00:00Z')
      }
    }),
    fetch: fakeClaudeOauthFetch({
      fiveHour: {
        utilization: 34,
        resetsAt: '2026-06-11T05:00:00Z'
      },
      sevenDay: {
        utilization: 56,
        resetsAt: '2026-06-18T00:00:00Z'
      }
    })
  });

  assert.equal(provider.windows[0].kind, 'session');
  assert.equal(provider.windows[0].usedPercent, 34);
  assert.equal(provider.windows[0].resetsAt, '2026-06-11T05:00:00.000Z');
  assert.equal(provider.windows[1].kind, 'weekly');
  assert.equal(provider.windows[1].usedPercent, 56);
  assert.equal(provider.windows[1].resetsAt, '2026-06-18T00:00:00.000Z');
});

test('Claude OAuth usage mapping preserves fractional percentage utilization values', async () => {
  let cliCalls = 0;
  const provider = await fetchClaudeLimits({}, {
    platform: 'darwin',
    now: () => Date.parse('2026-06-11T00:00:00Z'),
    claudeCredentialPath: '/tmp/claude-credentials.json',
    stat: async () => ({ mtimeMs: 1 }),
    readFile: async () => JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-token',
        expiresAt: Date.parse('2026-06-12T00:00:00Z')
      }
    }),
    fetch: fakeClaudeOauthFetch({
      fiveHour: {
        utilization: 0.99,
        resetsAt: '2026-06-11T08:00:00Z'
      },
      sevenDay: {
        utilization: 0,
        resetsAt: '2026-06-18T10:00:00Z'
      }
    }),
    runClaudeUsageCli: async () => {
      cliCalls += 1;
      return '';
    }
  });

  assert.equal(provider.source, 'oauth');
  assert.equal(provider.sourceDetail, '');
  assert.equal(provider.windows[0].usedPercent, 0.99);
  assert.equal(provider.windows[0].remainingPercent, 99.01);
  assert.equal(provider.windows[1].usedPercent, 0);
  assert.equal(provider.windows[1].remainingPercent, 100);
  assert.equal(cliCalls, 0);
});

test('Claude OAuth usage preserves a real idle five-hour window without a reset timestamp', () => {
  const provider = mapClaudeUsageToProvider({
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 12, resets_at: '2026-06-18T10:00:00Z' }
  });
  const session = provider.windows.find((window) => window.kind === 'session');

  assert.equal(session.usedPercent, 0);
  assert.equal(session.remainingPercent, 100);
  assert.equal(session.resetsAt, null);
});

test('Claude OAuth usage omits the five-hour window only when the API returns null', () => {
  const provider = mapClaudeUsageToProvider({
    five_hour: null,
    seven_day: { utilization: 12, resets_at: '2026-06-18T10:00:00Z' }
  });

  assert.equal(provider.windows.some((window) => window.kind === 'session'), false);
  assert.equal(provider.windows.some((window) => window.kind === 'weekly'), true);
});

test('Claude limits keep successful OAuth quota on macOS instead of replacing it with CLI', async () => {
  let cliCalls = 0;
  const provider = await fetchClaudeLimits({}, {
    platform: 'darwin',
    now: () => Date.parse('2026-06-11T00:00:00Z'),
    claudeCredentialPath: '/tmp/claude-credentials.json',
    stat: async () => ({ mtimeMs: 1 }),
    readFile: async () => JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-token',
        expiresAt: Date.parse('2026-06-12T00:00:00Z')
      }
    }),
    fetch: fakeClaudeOauthFetch({
      fiveHour: {
        utilization: 100,
        resetsAt: '2026-06-11T08:00:00Z'
      },
      sevenDay: {
        utilization: 0,
        resetsAt: '2026-06-18T10:00:00Z'
      }
    }),
    runClaudeUsageCli: async () => {
      cliCalls += 1;
      return [
        'Current session',
        '1% used',
        'Resets 3:59pm',
        'Current week',
        '0% used',
        'Resets Jun 19'
      ].join('\n');
    }
  });

  assert.equal(provider.source, 'oauth');
  assert.equal(provider.sourceDetail, '');
  assert.equal(provider.windows[0].usedPercent, 100);
  assert.equal(provider.windows[0].remainingPercent, 0);
  assert.equal(provider.windows[1].usedPercent, 0);
  assert.equal(provider.windows[1].remainingPercent, 100);
  assert.equal(cliCalls, 0);
});

test('Claude successful OAuth keeps plan label without probing CLI', async () => {
  let cliCalls = 0;
  const provider = await fetchClaudeLimits({}, {
    platform: 'darwin',
    now: () => Date.parse('2026-06-11T00:00:00Z'),
    claudeCredentialPath: '/tmp/claude-credentials.json',
    stat: async () => ({ mtimeMs: 1 }),
    readFile: async () => JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-token',
        expiresAt: Date.parse('2026-06-12T00:00:00Z'),
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x'
      }
    }),
    fetch: fakeClaudeOauthFetch({
      fiveHour: {
        utilization: 100,
        resetsAt: '2026-06-11T08:00:00Z'
      },
      sevenDay: {
        utilization: 0,
        resetsAt: '2026-06-18T10:00:00Z'
      }
    }),
    runClaudeUsageCli: async () => {
      cliCalls += 1;
      return [
        'Current session',
        '1% used',
        'Resets 3:59pm',
        'Current week',
        '0% used',
        'Resets Jun 19'
      ].join('\n');
    }
  });

  assert.equal(provider.source, 'oauth');
  assert.equal(provider.sourceDetail, '');
  assert.equal(provider.accountLabel, 'Max 5x');
  assert.equal(provider.windows[0].remainingPercent, 0);
  assert.equal(cliCalls, 0);
});

test('Claude CLI usage parses compact PTY reset lines', () => {
  const provider = mapClaudeCliUsageToProvider([
    'Current session',
    '1% used',
    'Resets4pm(Asia/Hong_Kong)',
    'Current week (all models)',
    '0% used',
    'ResetsJun19at6pm(Asia/Hong_Kong)'
  ].join('\n'), {
    now: new Date('2026-06-13T07:00:00Z'),
    updatedAt: '2026-06-13T07:00:00Z'
  });

  const session = provider.windows.find((window) => window.kind === 'session');
  const weekly = provider.windows.find((window) => window.kind === 'weekly');
  assert.equal(session.resetDescription, 'Resets 4pm');
  assert.equal(weekly.resetDescription, 'Resets Jun 19 at 6pm');
  assert.equal(typeof session.resetsAt, 'string');
  assert.equal(typeof weekly.resetsAt, 'string');
});

test('Claude CLI usage carries account email and organization into the provider identity', () => {
  const provider = mapClaudeCliUsageToProvider([
    'Current session',
    '95% left',
    'Resets 6pm',
    'Current week',
    '80% left',
    'Resets Jul 30',
    'Account: owner@example.com',
    'Organization: Example Team',
    'Plan: Max'
  ].join('\n'), {
    now: new Date('2026-07-25T00:00:00Z'),
    updatedAt: '2026-07-25T00:00:00Z'
  });

  assert.equal(provider.accountEmail, 'owner@example.com');
  assert.equal(provider.accountName, 'Example Team');
  assert.equal(provider.accountLabel, 'Max');
});

test('Claude CLI usage maps out-of-order PTY reset lines by window shape', () => {
  const provider = mapClaudeCliUsageToProvider([
    'Current session',
    '1% used',
    'Current week (all models)',
    '0% used',
    'Resets4pm(Asia/Hong_Kong)',
    'ResetsJun19at6pm(Asia/Hong_Kong)'
  ].join('\n'), {
    now: new Date('2026-06-13T07:00:00Z'),
    updatedAt: '2026-06-13T07:00:00Z'
  });

  const session = provider.windows.find((window) => window.kind === 'session');
  const weekly = provider.windows.find((window) => window.kind === 'weekly');
  assert.equal(session.resetDescription, 'Resets 4pm');
  assert.equal(weekly.resetDescription, 'Resets Jun 19 at 6pm');
  assert.equal(typeof session.resetsAt, 'string');
  assert.equal(typeof weekly.resetsAt, 'string');
});

test('Claude command candidates include common Windows CLI install paths before generic commands', () => {
  const localAppData = 'C:\\Users\\Javis\\AppData\\Local';
  const appData = 'C:\\Users\\Javis\\AppData\\Roaming';
  const userProfile = 'C:\\Users\\Javis';

  const candidates = claudeCommandCandidates({
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    USERPROFILE: userProfile
  }, 'win32');

  const localNpm = 'C:\\Users\\Javis\\AppData\\Local\\npm\\claude.cmd';
  const roamingNpm = 'C:\\Users\\Javis\\AppData\\Roaming\\npm\\claude.cmd';
  const volta = 'C:\\Users\\Javis\\AppData\\Local\\Volta\\tools\\image\\packages\\@anthropic-ai\\claude-code\\bin\\claude.cmd';
  const fnm = 'C:\\Users\\Javis\\AppData\\Local\\fnm_multishells\\claude.cmd';

  assert.equal(candidates.includes(localNpm), true);
  assert.equal(candidates.includes(roamingNpm), true);
  assert.equal(candidates.includes(volta), true);
  assert.equal(candidates.includes(fnm), true);
  assert.ok(candidates.indexOf(roamingNpm) < candidates.indexOf('claude.cmd'));
  assert.ok(candidates.indexOf('claude.cmd') < candidates.indexOf('claude'));
});

test('Claude OAuth usage adds a Fable-only weekly window from the limits array', () => {
  const provider = mapClaudeUsageToProvider({
    five_hour: { utilization: 96, resets_at: '2026-07-02T14:00:00Z' },
    seven_day: { utilization: 22, resets_at: '2026-07-03T10:00:00Z' },
    limits: [
      { kind: 'session', group: 'session', percent: 96, resets_at: '2026-07-02T14:00:00Z', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 22, resets_at: '2026-07-03T10:00:00Z', scope: null },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 1,
        resets_at: '2026-07-03T09:59:59Z',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null }
      }
    ]
  });

  const weeklies = provider.windows.filter((window) => window.kind === 'weekly');
  assert.equal(weeklies.length, 2);
  // The unscoped "All models" weekly stays first so windowForKind() still resolves it.
  assert.equal(weeklies[0].label, '');
  assert.equal(weeklies[0].usedPercent, 22);
  const fable = weeklies[1];
  assert.equal(fable.label, 'Fable');
  assert.equal(fable.usedPercent, 1);
  assert.equal(fable.resetsAt, '2026-07-03T09:59:59.000Z');
});

test('Claude OAuth usage omits the Fable window when no scoped model limit is present', () => {
  const provider = mapClaudeUsageToProvider({
    five_hour: { utilization: 40, resets_at: '2026-07-02T14:00:00Z' },
    seven_day: { utilization: 10, resets_at: '2026-07-03T10:00:00Z' },
    limits: [
      { kind: 'session', group: 'session', percent: 40, resets_at: '2026-07-02T14:00:00Z', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 10, resets_at: '2026-07-03T10:00:00Z', scope: null }
    ]
  });

  const weeklies = provider.windows.filter((window) => window.kind === 'weekly');
  assert.equal(weeklies.length, 1);
  assert.equal(weeklies[0].label, '');
});

test('Claude OAuth usage ignores non-Fable scoped weekly limits', () => {
  const provider = mapClaudeUsageToProvider({
    seven_day: { utilization: 10, resets_at: '2026-07-03T10:00:00Z' },
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 10, resets_at: '2026-07-03T10:00:00Z', scope: null },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 3,
        resets_at: '2026-07-03T10:00:00Z',
        scope: { model: { id: null, display_name: 'Opus' }, surface: null }
      }
    ]
  });

  const labels = provider.windows.filter((window) => window.kind === 'weekly').map((window) => window.label);
  assert.deepEqual(labels, ['']);
});

function claudeUsagePayload(overrides = {}) {
  return {
    five_hour: { utilization: 30, resets_at: '2026-07-27T10:50:00.800650+00:00' },
    seven_day: { utilization: 42, resets_at: '2026-07-31T10:00:00.800673+00:00' },
    ...overrides
  };
}

function creditsWindowOf(provider) {
  return provider.windows.find((window) => window.metric === 'spend') || null;
}

test('Claude credits-off accounts gain no usage-credits window', () => {
  const provider = mapClaudeUsageToProvider(claudeUsagePayload({
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
    spend: { enabled: false, used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0 }
  }));
  assert.equal(creditsWindowOf(provider), null);
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session', 'weekly']);
});

test('Claude usage credits with a monthly limit render a metered window', () => {
  const provider = mapClaudeUsageToProvider(claudeUsagePayload({
    extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 235, utilization: 11.75, currency: 'USD', decimal_places: 2 },
    spend: {
      enabled: true,
      used: { amount_minor: 235, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 2000, currency: 'USD', exponent: 2 },
      percent: 12
    }
  }));
  const window = creditsWindowOf(provider);
  assert.equal(window.kind, 'billing');
  assert.equal(window.used, 2.35);
  assert.equal(window.limit, 20);
  assert.equal(window.currency, 'USD');
  assert.equal(window.usedPercent, 11.75);
  assert.equal(window.showMeter, true);
});

test('Claude usage credits without a limit carry no percentage', () => {
  const provider = mapClaudeUsageToProvider(claudeUsagePayload({
    extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 235, utilization: null, currency: 'USD', decimal_places: 2 },
    // The live API reports percent 0 — not null — in this state.
    spend: { enabled: true, used: { amount_minor: 235, currency: 'USD', exponent: 2 }, limit: null, percent: 0 }
  }));
  const window = creditsWindowOf(provider);
  assert.equal(window.used, 2.35);
  assert.equal(window.limit, null);
  assert.equal(window.usedPercent, null, 'spend.percent must not leak in as a 0% meter');
  assert.equal(window.showMeter, false);
});

test('Claude usage credits fall back to extra_usage when spend is absent', () => {
  const provider = mapClaudeUsageToProvider(claudeUsagePayload({
    extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 235, currency: 'USD', decimal_places: 2 }
  }));
  const window = creditsWindowOf(provider);
  assert.equal(window.used, 2.35);
  assert.equal(window.limit, 20);
  assert.equal(window.usedPercent, 11.75);
});

test('Claude usage credits honour a non-cent decimal_places', () => {
  const provider = mapClaudeUsageToProvider(claudeUsagePayload({
    extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 235, currency: 'JPY', decimal_places: 0 }
  }));
  const window = creditsWindowOf(provider);
  assert.equal(window.used, 235);
  assert.equal(window.limit, 2000);
  assert.equal(window.currency, 'JPY');
});

const PREPAID_CREDITS = {
  amount: 11344,
  currency: 'USD',
  tranches: [],
  promo_tranches: [
    { remaining_amount_minor_units: 1343, granted_amount_minor_units: 2000, currency: 'USD', expires_at: '2026-08-09T00:00:00Z' },
    { remaining_amount_minor_units: 10000, granted_amount_minor_units: 10000, currency: 'USD', expires_at: '2026-09-19T00:00:00Z' }
  ],
  next_expires_at: '2026-08-09T00:00:00Z'
};

function fakeClaudeWebFetch(usage, { prepaid = PREPAID_CREDITS, prepaidStatus = 200 } = {}) {
  return async (url) => {
    const headers = { get: () => '', getSetCookie: () => [] };
    if (url.endsWith('/api/organizations')) {
      return { ok: true, status: 200, headers, json: async () => [{ uuid: 'org-1', name: 'Example' }] };
    }
    if (url.includes('/prepaid/credits')) {
      return { ok: prepaidStatus === 200, status: prepaidStatus, headers, json: async () => prepaid };
    }
    if (url.endsWith('/api/account')) {
      return { ok: true, status: 200, headers, json: async () => ({ email_address: 'owner@example.com' }) };
    }
    return { ok: true, status: 200, headers, json: async () => usage };
  };
}

const ENABLED_UNLIMITED = {
  five_hour: { utilization: 30, resets_at: '2026-07-27T10:50:00Z' },
  seven_day: { utilization: 42, resets_at: '2026-07-31T10:00:00Z' },
  extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 235, currency: 'USD', decimal_places: 2 },
  spend: { enabled: true, used: { amount_minor: 235, currency: 'USD', exponent: 2 }, limit: null, percent: 0 }
};

test('Claude Web reports the prepaid balance and its grant tranches', async () => {
  const provider = await fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-sid01-example' },
    { claudeWebFetch: fakeClaudeWebFetch(ENABLED_UNLIMITED), claudeIdentityCache: new Map() }
  );
  assert.equal(provider.status, 'ok');
  assert.equal(provider.balance.amount, 113.44);
  assert.equal(provider.balance.currency, 'USD');
  assert.deepEqual(provider.balance.tranches, [
    { amount: 13.43, currency: 'USD', expiresAt: '2026-08-09T00:00:00.000Z' },
    { amount: 100, currency: 'USD', expiresAt: '2026-09-19T00:00:00.000Z' }
  ]);
});

test('Claude prepaid balance emits an unmetered credits window', async () => {
  const provider = await fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-sid01-example' },
    { claudeWebFetch: fakeClaudeWebFetch(ENABLED_UNLIMITED), claudeIdentityCache: new Map() }
  );
  const credits = provider.windows.filter((window) => window.metric === 'credits');
  assert.equal(credits.length, 1, 'the normalization shim must not add a second credits window');
  assert.equal(credits[0].showMeter, false);
  assert.equal(credits[0].remaining, 113.44);
});

test('a failed prepaid fetch leaves the rest of the Claude row intact', async () => {
  const provider = await fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-sid01-example' },
    { claudeWebFetch: fakeClaudeWebFetch(ENABLED_UNLIMITED, { prepaidStatus: 403 }), claudeIdentityCache: new Map() }
  );
  assert.equal(provider.status, 'ok');
  assert.equal(provider.balance, null);
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session', 'weekly', 'billing']);
});


test('the prepaid balance is cached between refreshes and re-read after its TTL', async () => {
  const providerRuntimeState = new Map();
  let nowMs = Date.parse('2026-07-27T00:00:00Z');
  let amount = 11344;
  const requests = [];
  const deps = {
    now: () => nowMs,
    providerRuntimeState,
    claudePrepaidCacheTtlMs: 1000,
    claudeWebFetch: async (url) => {
      requests.push(url);
      const headers = { get: () => '', getSetCookie: () => [] };
      if (url.endsWith('/api/organizations')) {
        return { ok: true, status: 200, headers, json: async () => [{ uuid: 'org-1', name: 'Example' }] };
      }
      if (url.endsWith('/api/account')) {
        return { ok: true, status: 200, headers, json: async () => ({ uuid: 'account-1', email_address: 'owner@example.com' }) };
      }
      if (url.includes('/prepaid/credits')) {
        return { ok: true, status: 200, headers, json: async () => ({ amount, currency: 'USD', tranches: [], promo_tranches: [] }) };
      }
      return { ok: true, status: 200, headers, json: async () => ENABLED_UNLIMITED };
    }
  };
  const cookie = 'sessionKey=sk-ant-sid01-cached';

  const first = await fetchClaudeLimits({ claudeWebCookie: cookie }, deps);
  assert.equal(first.balance.amount, 113.44);

  // Within the TTL the steady-state refresh stays at the single /usage request.
  requests.length = 0;
  amount = 9999;
  const cached = await fetchClaudeLimits({ claudeWebCookie: cookie }, deps);
  assert.deepEqual(requests.filter((url) => url.includes('/prepaid/credits')), []);
  assert.equal(cached.balance.amount, 113.44, 'the cached pool is reused, not re-read');

  // Past the TTL it is re-read.
  requests.length = 0;
  nowMs += 2000;
  const refreshed = await fetchClaudeLimits({ claudeWebCookie: cookie }, deps);
  assert.equal(requests.filter((url) => url.includes('/prepaid/credits')).length, 1);
  assert.equal(refreshed.balance.amount, 99.99);
});

const CREDITS_OFF = {
  five_hour: { utilization: 30, resets_at: '2026-07-27T10:50:00Z' },
  seven_day: { utilization: 42, resets_at: '2026-07-31T10:00:00Z' },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
  spend: { enabled: false, used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0 }
};

test('a funded pool is still reported when usage credits are switched off', async () => {
  const provider = await fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-sid01-off' },
    { providerRuntimeState: new Map(), claudeWebFetch: fakeClaudeWebFetch(CREDITS_OFF) }
  );
  // Switching usage credits off is how you stop a balance you still hold from
  // being spent; the money and its expiry dates are what you keep watching.
  assert.equal(provider.balance.amount, 113.44);
  assert.equal(provider.balance.tranches.length, 2);
  const kinds = provider.windows.map((window) => window.kind);
  assert.deepEqual(kinds, ['session', 'weekly', 'billing'], 'no Usage credits window while off');
  assert.equal(provider.windows.at(-1).metric, 'credits');
});

test('an unfunded pool on a credits-off account reports no balance', async () => {
  const provider = await fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-sid01-never' },
    {
      providerRuntimeState: new Map(),
      claudeWebFetch: fakeClaudeWebFetch(CREDITS_OFF, {
        prepaid: { amount: 0, currency: 'USD', tranches: [], promo_tranches: [] }
      })
    }
  );
  assert.equal(provider.balance, null, 'a $0.00 row on an account that never bought credits is noise');
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session', 'weekly']);
});

test('an unfunded credits-off pool backs off well past the normal TTL', async () => {
  const providerRuntimeState = new Map();
  let nowMs = Date.parse('2026-07-27T00:00:00Z');
  const requests = [];
  const deps = {
    now: () => nowMs,
    providerRuntimeState,
    claudeWebFetch: async (url) => {
      requests.push(url);
      return fakeClaudeWebFetch(CREDITS_OFF, {
        prepaid: { amount: 0, currency: 'USD', tranches: [], promo_tranches: [] }
      })(url);
    }
  };
  const options = { claudeWebCookie: 'sessionKey=sk-ant-sid01-idle', limitsRefreshMs: 60_000 };

  await fetchClaudeLimits(options, deps);

  // Three intervals in — well past the 2x TTL a funded pool would use.
  requests.length = 0;
  nowMs += 180_000;
  await fetchClaudeLimits(options, deps);
  assert.deepEqual(requests.filter((url) => url.includes('/prepaid/credits')), []);

  // Just past the 12x TTL — an hour at the default refresh — it is re-read:
  // buying credits must still surface without restarting the widget.
  requests.length = 0;
  nowMs += 541_000;
  await fetchClaudeLimits(options, deps);
  assert.equal(requests.filter((url) => url.includes('/prepaid/credits')).length, 1);
});

test('enabling usage credits pulls an idle pool back to the normal cadence', async () => {
  const providerRuntimeState = new Map();
  let nowMs = Date.parse('2026-07-27T00:00:00Z');
  let usage = CREDITS_OFF;
  const requests = [];
  const deps = {
    now: () => nowMs,
    providerRuntimeState,
    claudeWebFetch: async (url) => {
      requests.push(url);
      return fakeClaudeWebFetch(usage, {
        prepaid: { amount: 0, currency: 'USD', tranches: [], promo_tranches: [] }
      })(url);
    }
  };
  const options = { claudeWebCookie: 'sessionKey=sk-ant-sid01-reenabled', limitsRefreshMs: 60_000 };

  await fetchClaudeLimits(options, deps);

  // The idle backoff is evaluated per read, not frozen into the cache entry.
  requests.length = 0;
  usage = ENABLED_UNLIMITED;
  nowMs += 121_000;
  const provider = await fetchClaudeLimits(options, deps);
  assert.equal(requests.filter((url) => url.includes('/prepaid/credits')).length, 1);
  assert.equal(provider.balance.amount, 0);
});

test('a transient prepaid failure keeps the balance and retries next refresh', async () => {
  const providerRuntimeState = new Map();
  let nowMs = Date.parse('2026-07-27T00:00:00Z');
  let prepaidOutcome = 'ok';
  const requests = [];
  const deps = {
    now: () => nowMs,
    providerRuntimeState,
    claudeWebFetch: async (url) => {
      requests.push(url);
      if (url.includes('/prepaid/credits')) {
        if (prepaidOutcome === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (prepaidOutcome !== 'ok') {
          return {
            ok: false,
            status: Number(prepaidOutcome),
            headers: { get: () => '', getSetCookie: () => [] },
            json: async () => ({})
          };
        }
      }
      return fakeClaudeWebFetch(CREDITS_OFF)(url);
    }
  };
  const options = { claudeWebCookie: 'sessionKey=sk-ant-sid01-flaky', limitsRefreshMs: 60_000 };

  const first = await fetchClaudeLimits(options, deps);
  assert.equal(first.balance.amount, 113.44);

  // Neither a 5xx, a 429 nor a timeout says anything about this account, so the
  // balance a working read produced must survive all three.
  for (const outcome of ['500', '429', 'timeout']) {
    prepaidOutcome = outcome;
    requests.length = 0;
    nowMs += 121_000;
    const during = await fetchClaudeLimits(options, deps);
    assert.equal(requests.filter((url) => url.includes('/prepaid/credits')).length, 1, `retried on ${outcome}`);
    assert.equal(during.balance.amount, 113.44, `balance survives ${outcome}`);
    assert.equal(during.balance.tranches.length, 2, `tranches survive ${outcome}`);
    assert.equal(during.windows.at(-1).remaining, 113.44);
  }

  prepaidOutcome = 'ok';
  nowMs += 121_000;
  const recovered = await fetchClaudeLimits(options, deps);
  assert.equal(recovered.balance.amount, 113.44);
});

test('a rotated sessionKey keeps the prepaid balance addressable', async () => {
  const providerRuntimeState = new Map();
  let nowMs = Date.parse('2026-07-27T00:00:00Z');
  let cookie = 'sessionKey=sk-ant-sid01-rotating';
  let rotate = true;
  let prepaidStatus = 200;
  const requests = [];
  const deps = {
    now: () => nowMs,
    providerRuntimeState,
    onClaudeWebCookieRenewed: ({ cookie: renewed }) => { cookie = renewed; },
    claudeWebFetch: async (url) => {
      requests.push(url);
      const headers = {
        get: () => '',
        getSetCookie: () => (rotate && url.endsWith('/api/organizations')
          ? ['sessionKey=sk-ant-sid01-rotated; Path=/; Secure; HttpOnly']
          : [])
      };
      if (url.endsWith('/api/organizations')) {
        return { ok: true, status: 200, headers, json: async () => [{ uuid: 'org-1', name: 'Example' }] };
      }
      if (url.endsWith('/api/account')) {
        return { ok: true, status: 200, headers, json: async () => ({ uuid: 'account-1', email_address: 'owner@example.com' }) };
      }
      if (url.includes('/prepaid/credits')) {
        if (prepaidStatus !== 200) return { ok: false, status: prepaidStatus, headers, json: async () => ({}) };
        return { ok: true, status: 200, headers, json: async () => PREPAID_CREDITS };
      }
      return { ok: true, status: 200, headers, json: async () => CREDITS_OFF };
    }
  };
  const options = () => ({ claudeWebCookie: cookie, limitsRefreshMs: 60_000 });

  const first = await fetchClaudeLimits(options(), deps);
  assert.equal(first.balance.amount, 113.44);
  assert.equal(cookie, 'sessionKey=sk-ant-sid01-rotated', 'the renewed sessionKey is persisted');

  // The cache is addressed by account, not by the cookie that happened to read
  // it, so the rotated session must not send the widget back to the endpoint.
  rotate = false;
  requests.length = 0;
  const cached = await fetchClaudeLimits(options(), deps);
  assert.deepEqual(requests.filter((url) => url.includes('/prepaid/credits')), []);
  assert.equal(cached.balance.amount, 113.44);

  // And past the TTL, a transient failure under the rotated cookie still finds
  // the balance the previous cookie read.
  requests.length = 0;
  nowMs += 121_000;
  prepaidStatus = 500;
  const during = await fetchClaudeLimits(options(), deps);
  assert.equal(requests.filter((url) => url.includes('/prepaid/credits')).length, 1);
  assert.equal(during.balance.amount, 113.44);
  assert.equal(during.balance.tranches.length, 2);
  assert.equal(during.windows.at(-1).remaining, 113.44);
});

test('a refused prepaid endpoint is not re-asked every refresh', async () => {
  const providerRuntimeState = new Map();
  const requests = [];
  const deps = {
    now: () => Date.parse('2026-07-27T00:00:00Z'),
    providerRuntimeState,
    claudeWebFetch: async (url) => {
      requests.push(url);
      return fakeClaudeWebFetch(ENABLED_UNLIMITED, { prepaidStatus: 403 })(url);
    }
  };
  const options = { claudeWebCookie: 'sessionKey=sk-ant-sid01-refused' };

  await fetchClaudeLimits(options, deps);
  assert.equal(requests.filter((url) => url.includes('/prepaid/credits')).length, 1);

  requests.length = 0;
  const second = await fetchClaudeLimits(options, deps);
  assert.deepEqual(requests.filter((url) => url.includes('/prepaid/credits')), []);
  assert.equal(second.balance, null);
});

test('switching the prepaid balance off skips the request entirely', async () => {
  const requests = [];
  const provider = await fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-sid01-opt-out', claudePrepaidBalanceEnabled: false },
    {
      providerRuntimeState: new Map(),
      claudeWebFetch: async (url) => {
        requests.push(url);
        return fakeClaudeWebFetch(ENABLED_UNLIMITED)(url);
      }
    }
  );
  assert.deepEqual(requests.filter((url) => url.includes('/prepaid/credits')), []);
  assert.equal(provider.balance, null);
  assert.equal(provider.windows.some((window) => window.metric === 'credits'), false);
});

test('an exhausted prepaid pool still reports a zero balance', async () => {
  const provider = await fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-sid01-empty' },
    {
      providerRuntimeState: new Map(),
      claudeWebFetch: fakeClaudeWebFetch(ENABLED_UNLIMITED, {
        prepaid: { amount: 0, currency: 'USD', tranches: [], promo_tranches: [] }
      })
    }
  );
  assert.equal(provider.balance.amount, 0, 'a spent-dry pool is exactly when the row matters');
  const credits = provider.windows.filter((window) => window.metric === 'credits');
  assert.equal(credits.length, 1);
  assert.equal(credits[0].remaining, 0);
  assert.equal(credits[0].showMeter, false);
});

function fakeClaudeWebIdentityFetch(organization, account) {
  return async (url) => {
    const headers = { get: () => '', getSetCookie: () => [] };
    if (url.endsWith('/api/organizations')) {
      return { ok: true, status: 200, headers, json: async () => [organization] };
    }
    if (url.endsWith('/api/account')) {
      return { ok: true, status: 200, headers, json: async () => account };
    }
    if (url.includes('/prepaid/credits')) {
      return { ok: true, status: 200, headers, json: async () => ({ amount: 0, currency: 'USD' }) };
    }
    return { ok: true, status: 200, headers, json: async () => CREDITS_OFF };
  };
}

// What claude.ai actually returns for a personal subscription: the plan is
// nowhere on the membership, only in the organization's capability list.
const PERSONAL_ACCOUNT = {
  uuid: 'account-personal',
  email_address: 'owner@example.com',
  memberships: [{
    role: 'admin',
    seat_tier: null,
    organization: { uuid: 'org-personal', name: 'Personal' }
  }]
};

async function personalPlanLabel(organization) {
  const provider = await fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-sid01-plan' },
    {
      providerRuntimeState: new Map(),
      claudeWebFetch: fakeClaudeWebIdentityFetch(organization, PERSONAL_ACCOUNT)
    }
  );
  return provider.accountLabel;
}

test('a personal Pro account takes its plan from the organization capabilities', async () => {
  assert.equal(await personalPlanLabel({
    uuid: 'org-personal',
    name: 'Personal',
    capabilities: ['chat', 'claude_pro'],
    rate_limit_tier: 'default_claude_ai'
  }), 'Pro');
});

test('a personal Max account keeps the rate limit tier refinement', async () => {
  assert.equal(await personalPlanLabel({
    uuid: 'org-personal',
    name: 'Personal',
    capabilities: ['chat', 'claude_max'],
    rate_limit_tier: 'default_claude_max_20x'
  }), 'Max 20x');
});

test('a membership from another organization never supplies the plan', async () => {
  const provider = await fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-sid01-multi' },
    {
      providerRuntimeState: new Map(),
      claudeWebFetch: fakeClaudeWebIdentityFetch(
        {
          uuid: 'org-selected',
          name: 'Selected Max Org',
          capabilities: ['chat', 'claude_max'],
          rate_limit_tier: 'default_claude_max_20x'
        },
        {
          uuid: 'account-multi',
          email_address: 'owner@example.com',
          // The account is a member of a different organization than the one
          // usage was resolved for, so nothing here may describe the plan.
          memberships: [{
            seat_tier: 'team',
            rate_limit_tier: 'default_claude_ai',
            organization: { uuid: 'org-other', name: 'Unrelated Org', capabilities: ['chat', 'raven'] }
          }]
        }
      )
    }
  );
  assert.equal(provider.accountLabel, 'Max 20x');
  assert.equal(provider.accountName, 'Selected Max Org');
});

test('the Max variant comes from the rate limit tier, not the capability', async () => {
  // There is no `claude_max_5x` capability: claude.ai reports plain `claude_max`
  // for both variants and separates them on `rate_limit_tier`.
  assert.equal(await personalPlanLabel({
    uuid: 'org-personal',
    name: 'Personal',
    capabilities: ['chat', 'claude_max'],
    rate_limit_tier: 'default_claude_max_5x'
  }), 'Max 5x');
});

async function planLabelFor(organization, seatTier) {
  const provider = await fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-sid01-seat' },
    {
      providerRuntimeState: new Map(),
      claudeWebFetch: fakeClaudeWebIdentityFetch(
        { uuid: 'org-1', name: 'Org', ...organization },
        {
          uuid: 'account-seat',
          email_address: 'owner@example.com',
          memberships: [{ seat_tier: seatTier, organization: { uuid: 'org-1', name: 'Org' } }]
        }
      )
    }
  );
  return provider.accountLabel;
}

const TEAM_ORG = { capabilities: ['chat', 'raven'], raven_type: 'team', rate_limit_tier: 'default_claude_ai' };

test('a team organization is recognized by its raven capability and type', async () => {
  // `raven` covers Team and Enterprise together, and `raven_type` separates
  // them. There is no team-specific rate limit tier, so this is the only signal.
  assert.equal(await planLabelFor(TEAM_ORG, null), 'Team');
  assert.equal(
    await planLabelFor({ capabilities: ['chat', 'raven'], raven_type: 'enterprise', rate_limit_tier: 'default_raven' }, null),
    'Enterprise'
  );
});

test('a seat level never outranks the plan its organization states', async () => {
  // A seat says which seat someone holds, not which plan the organization is on.
  assert.equal(await planLabelFor(TEAM_ORG, 'standard'), 'Team');
  // `unassigned` is what claude.ai substitutes for a member holding no seat.
  assert.equal(await planLabelFor(TEAM_ORG, 'unassigned'), 'Team');
  // And when the two disagree outright, the organization wins: claude.ai
  // resolves the plan from the organization alone and never from the seat.
  assert.equal(await planLabelFor(TEAM_ORG, 'enterprise_standard'), 'Team');
});

test('a seat tier reports its plan when the organization states none', async () => {
  // Anthropic documents seat tiers as fully qualified `<plan>_<seat level>`
  // identifiers, of which `enterprise_standard` and `enterprise_tier_1` are two.
  // OAuth reports a bare `enterprise` and renders "Enterprise"; keeping the seat
  // level here would render "Enterprise Standard" for the same account.
  const unnamed = { capabilities: ['chat', 'raven'], raven_type: null, rate_limit_tier: 'default_raven' };
  assert.equal(await planLabelFor(unnamed, 'enterprise_standard'), 'Enterprise');
  assert.equal(await planLabelFor(unnamed, 'enterprise_tier_1'), 'Enterprise');
});

test('nothing is claimed when no source names a plan', async () => {
  // A bare seat level, an organization whose raven type is missing, and the
  // `default_raven` tier itself all describe something other than the plan.
  const unnamed = { capabilities: ['chat', 'raven'], raven_type: null, rate_limit_tier: 'default_raven' };
  assert.equal(await planLabelFor(unnamed, 'standard'), '');
  assert.equal(await planLabelFor(unnamed, null), '');
  assert.equal(await planLabelFor({ capabilities: ['chat'], rate_limit_tier: 'default_claude_ai' }, 'bespoke_thing'), '');
});

test('a billing type is never mistaken for a plan', async () => {
  // `apple_subscription` is how the subscription is paid for, not what it is.
  assert.equal(await personalPlanLabel({
    uuid: 'org-personal',
    name: 'Personal',
    capabilities: ['chat'],
    rate_limit_tier: 'default_claude_ai',
    billing_type: 'apple_subscription'
  }), '');
});

test('the prepaid TTL follows the limits refresh interval at twice its length', async () => {
  const providerRuntimeState = new Map();
  let nowMs = Date.parse('2026-07-27T00:00:00Z');
  const requests = [];
  const deps = {
    now: () => nowMs,
    providerRuntimeState,
    claudeWebFetch: async (url) => {
      requests.push(url);
      return fakeClaudeWebFetch(ENABLED_UNLIMITED)(url);
    }
  };
  const options = { claudeWebCookie: 'sessionKey=sk-ant-sid01-ttl', limitsRefreshMs: 60_000 };

  await fetchClaudeLimits(options, deps);

  // One refresh interval later the cached pool is still fresh (TTL is 2x).
  requests.length = 0;
  nowMs += 60_000;
  await fetchClaudeLimits(options, deps);
  assert.deepEqual(requests.filter((url) => url.includes('/prepaid/credits')), []);

  // Two intervals in, it is re-read.
  requests.length = 0;
  nowMs += 61_000;
  await fetchClaudeLimits(options, deps);
  assert.equal(requests.filter((url) => url.includes('/prepaid/credits')).length, 1);
});
