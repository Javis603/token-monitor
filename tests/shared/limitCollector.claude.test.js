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
  assert.equal(first.requests.length, 3);
  assert.equal(first.requests[0].options.headers.cookie, 'sessionKey=sk-ant-first-cookie');
  assert.deepEqual(first.requests[0].options.headers, {
    accept: 'application/json',
    cookie: 'sessionKey=sk-ant-first-cookie'
  });
  assert.equal(first.requests[0].url.endsWith('/api/organizations'), true);
  assert.equal(first.requests[1].url.endsWith('/api/organizations/organization-web/usage'), true);
  assert.equal(first.requests[2].url.endsWith('/api/account'), true);
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
