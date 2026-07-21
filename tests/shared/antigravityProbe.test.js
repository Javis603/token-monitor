'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const probe = require('../../src/shared/antigravityProbe');
const rootPackage = require('../../package.json');

test('parseProcessLine extracts pid + csrf + extension port from a darwin ps line', () => {
  const line = '53602 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --override_ide_name antigravity --csrf_token ea1dbb2a-65a8-4766-a155-8e70f032f4ac --app_data_dir antigravity --extension_server_port 12345 --extension_server_csrf_token deadbeef';
  const info = probe._parseProcessLine(line);
  assert.equal(info.pid, 53602);
  assert.equal(info.csrfToken, 'ea1dbb2a-65a8-4766-a155-8e70f032f4ac');
  assert.equal(info.extensionPort, 12345);
  assert.equal(info.extensionCsrfToken, 'deadbeef');
});

test('parseProcessLine returns null for non-antigravity lines', () => {
  assert.equal(probe._parseProcessLine('123 /bin/bash --login'), null);
  assert.equal(probe._parseProcessLine('456 /Applications/Cursor.app/Contents/MacOS/Cursor'), null);
});

test('parseProcessLine returns null when --csrf_token is missing', () => {
  assert.equal(
    probe._parseProcessLine('789 /Applications/Antigravity.app/.../language_server --app_data_dir antigravity'),
    null
  );
});

test('parseProcessLine matches language_server.exe on win32 cmdlines', () => {
  const line = '7777 C:\\Program Files\\Antigravity\\language_server.exe --app_data_dir antigravity --csrf_token abc-123';
  const info = probe._parseProcessLine(line);
  assert.equal(info.pid, 7777);
  assert.equal(info.csrfToken, 'abc-123');
  assert.equal(info.kind, 'app');
});

test('parseProcessLine tags the Antigravity app language server as kind=app', () => {
  const line = '53602 /Applications/Antigravity.app/Contents/Resources/bin/language_server --override_ide_name antigravity --csrf_token abc --app_data_dir antigravity';
  assert.equal(probe._parseProcessLine(line).kind, 'app');
});

test('parseProcessLine distinguishes the Antigravity IDE language server', () => {
  const appBundle = '53603 /Applications/Antigravity IDE.app/Contents/Resources/bin/language_server --csrf_token ide-a --app_data_dir antigravity-ide';
  const extension = '53604 /Users/example/.vscode/extensions/antigravity/bin/language_server --csrf_token ide-b --app_data_dir antigravity';
  assert.equal(probe._parseProcessLine(appBundle).kind, 'ide');
  assert.equal(probe._parseProcessLine(extension).kind, 'ide');
});

test('parseProcessLine matches the agy CLI without a csrf token (kind=cli)', () => {
  const line = '60123 /Users/example/.antigravity/bin/agy language-server --stdio';
  const info = probe._parseProcessLine(line);
  assert.equal(info.pid, 60123);
  assert.equal(info.kind, 'cli');
  assert.equal(info.csrfToken, '');
});

test('parseProcessLine matches the antigravity-cli language server path (kind=cli)', () => {
  const line = '60124 /opt/antigravity-cli/resources/language_server_macos --standalone';
  const info = probe._parseProcessLine(line);
  assert.equal(info.kind, 'cli');
  assert.equal(info.csrfToken, '');
});

test('parseProcessLine matches agy.exe on win32 cmdlines', () => {
  const info = probe._parseProcessLine('9001 C:\\Users\\j\\.antigravity\\agy.exe language-server');
  assert.equal(info.pid, 9001);
  assert.equal(info.kind, 'cli');
});

test('parseProcessLine does not match agy embedded in an unrelated path', () => {
  assert.equal(probe._parseProcessLine('700 /opt/imagytool/bin/run --serve'), null);
  assert.equal(probe._parseProcessLine('701 /usr/local/bin/legacy-agent start'), null);
});

function fakeSpawn(stdout, { exitCode = 0, stderr = '' } = {}) {
  const { EventEmitter } = require('node:events');
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
    return child;
  };
}

test('detectProcessInfo (posix) returns the highest-priority Antigravity source', async () => {
  const stdout = [
    '111 /bin/bash --login',
    '60123 /Users/example/.antigravity/bin/agy language-server --stdio',
    '53602 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --override_ide_name antigravity --csrf_token abc-123 --app_data_dir antigravity'
  ].join('\n');
  const info = await probe.detectProcessInfo({ platform: 'darwin', spawn: fakeSpawn(stdout) });
  assert.equal(info.pid, 53602);
  assert.equal(info.csrfToken, 'abc-123');
});

test('detectProcessInfos orders app, CLI, then IDE independent of ps order', async () => {
  const stdout = [
    '70003 /Applications/Antigravity IDE.app/Contents/Resources/bin/language_server --csrf_token ide --app_data_dir antigravity-ide',
    '70001 /Users/example/.antigravity/bin/agy language-server --stdio',
    '70002 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token app-b --app_data_dir antigravity',
    '70000 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token app-a --app_data_dir antigravity'
  ].join('\n');
  const infos = await probe.detectProcessInfos({ platform: 'darwin', spawn: fakeSpawn(stdout) });
  assert.deepEqual(infos.map((info) => [info.kind, info.pid]), [
    ['app', 70000],
    ['app', 70002],
    ['cli', 70001],
    ['ide', 70003]
  ]);
});

test('detectProcessInfo (posix) throws notConfigured when no LS is present', async () => {
  const err = await probe.detectProcessInfo({ platform: 'linux', spawn: fakeSpawn('111 /bin/bash --login\n') })
    .catch((e) => e);
  assert.equal(err.status, 'notConfigured');
});

test('detectProcessInfo (posix) throws unavailable when LS present but no csrf', async () => {
  const stdout = '53602 /Applications/Antigravity.app/.../language_server --app_data_dir antigravity\n';
  const err = await probe.detectProcessInfo({ platform: 'darwin', spawn: fakeSpawn(stdout) })
    .catch((e) => e);
  assert.equal(err.status, 'unavailable');
});

test('detectProcessInfo (posix) returns the agy CLI language server with an empty token', async () => {
  const stdout = [
    '111 /bin/bash --login',
    '60123 /Users/example/.antigravity/bin/agy language-server --stdio'
  ].join('\n');
  const info = await probe.detectProcessInfo({ platform: 'darwin', spawn: fakeSpawn(stdout) });
  assert.equal(info.pid, 60123);
  assert.equal(info.kind, 'cli');
  assert.equal(info.csrfToken, '');
});

test('detectProcessInfo (win32) parses PowerShell output', async () => {
  const stdout = '7777 C:\\Program Files\\Antigravity\\language_server.exe --app_data_dir antigravity --csrf_token win-token\n';
  const info = await probe.detectProcessInfo({ platform: 'win32', spawn: fakeSpawn(stdout) });
  assert.equal(info.pid, 7777);
  assert.equal(info.csrfToken, 'win-token');
});

test('detectProcessInfo (win32) includes hyphenated language-server names in the PowerShell filter', async () => {
  const stdout = '7778 C:\\Program Files\\Antigravity\\language-server.exe --app_data_dir antigravity --csrf_token win-token\n';
  let script = '';
  const spawn = (cmd, args) => {
    assert.equal(cmd, 'powershell');
    script = args.at(-1);
    return fakeSpawn(stdout)();
  };
  const info = await probe.detectProcessInfo({ platform: 'win32', spawn });
  assert.match(script, /\$_\.Name -like 'language-server\*'/);
  assert.equal(info.pid, 7778);
  assert.equal(info.kind, 'app');
});

test('detectProcessInfo (win32) finds the agy.exe CLI when no IDE LS is running', async () => {
  const stdout = '9001 C:\\Users\\j\\.antigravity\\agy.exe language-server\n';
  const info = await probe.detectProcessInfo({ platform: 'win32', spawn: fakeSpawn(stdout) });
  assert.equal(info.pid, 9001);
  assert.equal(info.kind, 'cli');
  assert.equal(info.csrfToken, '');
});

test('listeningPorts (posix) extracts ports from lsof output', async () => {
  const stdout = [
    'COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'language_ 53602 javis    6u  IPv4 0x62d7cac36931a256      0t0  TCP 127.0.0.1:54733 (LISTEN)',
    'language_ 53602 javis    7u  IPv4 0x398b24e66540846a      0t0  TCP 127.0.0.1:54734 (LISTEN)'
  ].join('\n');
  const ports = await probe.listeningPorts(53602, { platform: 'darwin', spawn: fakeSpawn(stdout) });
  assert.deepEqual(ports, [54733, 54734]);
});

test('listeningPorts (posix) throws unavailable when nothing is listening', async () => {
  const err = await probe.listeningPorts(53602, { platform: 'linux', spawn: fakeSpawn('') }).catch((e) => e);
  assert.equal(err.status, 'unavailable');
});

test('listeningPorts (win32) parses Get-NetTCPConnection output', async () => {
  const stdout = '54733\n54734\n';
  const ports = await probe.listeningPorts(7777, { platform: 'win32', spawn: fakeSpawn(stdout) });
  assert.deepEqual(ports, [54733, 54734]);
});

const realHttp = require('node:http');

function startStubHttpServer(handler) {
  return new Promise((resolve) => {
    const server = realHttp.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, server, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('callLs posts JSON, returns parsed body on 200', async () => {
  const { port, close } = await startStubHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      assert.equal(req.headers['x-codeium-csrf-token'], 'tok');
      assert.equal(req.headers['content-type'], 'application/json');
      assert.equal(req.headers['user-agent'], `token-monitor/${rootPackage.version} (+https://github.com/Javis603/token-monitor)`);
      assert.equal(JSON.parse(body).metadata.ideName, 'antigravity');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const data = await probe.callLs({
      scheme: 'http', port, csrfToken: 'tok', method: 'GetUserStatus',
      body: { metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: 'unknown', locale: 'en' } }
    });
    assert.deepEqual(data, { ok: true });
  } finally {
    await close();
  }
});

test('callLs throws unauthorized on 401', async () => {
  const { port, close } = await startStubHttpServer((req, res) => {
    res.writeHead(401);
    res.end('nope');
  });
  try {
    const err = await probe.callLs({ scheme: 'http', port, csrfToken: 'tok', method: 'GetUserStatus', body: {} }).catch((e) => e);
    assert.equal(err.status, 'unauthorized');
  } finally {
    await close();
  }
});

test('callLs throws sourceRateLimited on 429', async () => {
  const { port, close } = await startStubHttpServer((req, res) => { res.writeHead(429); res.end(); });
  try {
    const err = await probe.callLs({ scheme: 'http', port, csrfToken: 'tok', method: 'GetUserStatus', body: {} }).catch((e) => e);
    assert.equal(err.status, 'sourceRateLimited');
  } finally {
    await close();
  }
});

test('callLs throws unavailable on 500', async () => {
  const { port, close } = await startStubHttpServer((req, res) => { res.writeHead(500); res.end(); });
  try {
    const err = await probe.callLs({ scheme: 'http', port, csrfToken: 'tok', method: 'GetUserStatus', body: {} }).catch((e) => e);
    assert.equal(err.status, 'unavailable');
  } finally {
    await close();
  }
});

test('_modelsFromConfigs filters blacklist and entries without quotaInfo', () => {
  const configs = [
    { label: 'Gemini 3 Pro (High)',  modelOrAlias: { model: 'MODEL_GEMINI_3_PRO_HIGH' },  quotaInfo: { remainingFraction: 0.7, resetTime: '2026-06-03T03:00:00Z' } },
    { label: 'Blacklisted',          modelOrAlias: { model: 'MODEL_PLACEHOLDER_M9' },     quotaInfo: { remainingFraction: 1.0, resetTime: '2026-06-03T03:00:00Z' } },
    { label: 'Missing quota',        modelOrAlias: { model: 'MODEL_NO_QUOTA' } },
    { label: 'GPT-OSS 120B (Medium)', modelOrAlias: { model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM' }, quotaInfo: { remainingFraction: 0.9, resetTime: null } }
  ];
  const out = probe._modelsFromConfigs(configs);
  assert.equal(out.length, 2);
  assert.equal(out[0].modelId, 'MODEL_GEMINI_3_PRO_HIGH');
  assert.equal(out[1].modelId, 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
});

test('_collapsePools maps Gemini Pro / Gemini Flash / Claude pools by lowest remainingFraction', () => {
  const models = [
    { label: 'Gemini 3 Pro (High)',   modelId: 'X', remainingFraction: 0.8, resetTime: '2026-06-03T03:00:00Z' },
    { label: 'Gemini 3 Pro (Medium)', modelId: 'X', remainingFraction: 0.4, resetTime: '2026-06-03T02:00:00Z' },
    { label: 'Gemini 3 Flash',        modelId: 'X', remainingFraction: 0.9, resetTime: '2026-06-03T01:00:00Z' },
    { label: 'Claude Opus',           modelId: 'X', remainingFraction: 0.7, resetTime: '2026-06-03T04:00:00Z' },
    { label: 'GPT-OSS 120B',          modelId: 'X', remainingFraction: 0.6, resetTime: '2026-06-03T05:00:00Z' }
  ];
  const pools = probe._collapsePools(models);
  assert.deepEqual(pools.map((p) => p.name), ['Gemini Pro', 'Gemini Flash', 'Claude']);
  assert.equal(pools[0].remainingFraction, 0.4);
  assert.equal(pools[0].resetTime, '2026-06-03T02:00:00Z');
  assert.equal(pools[1].remainingFraction, 0.9);
  assert.equal(pools[2].remainingFraction, 0.6);
});

test('_collapsePools omits pools that have no model in the response', () => {
  const models = [{ label: 'Claude Opus', modelId: 'X', remainingFraction: 0.5, resetTime: null }];
  const pools = probe._collapsePools(models);
  assert.deepEqual(pools.map((p) => p.name), ['Claude']);
});

test('_quotaSummaryWindows maps two model groups to session and weekly windows', () => {
  const windows = probe._quotaSummaryWindows({
    response: {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-weekly', displayName: 'Weekly Limit', remaining: { remainingFraction: 0.64 }, resetTime: '2026-06-20T00:39:54Z' },
            { bucketId: '3p-5h', displayName: 'Five Hour Limit', remaining: { remainingFraction: 0.73 }, resetTime: '2026-06-15T12:52:10Z' }
          ]
        },
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit', remaining: { case: 'remainingFraction', value: 0.82 } },
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', remainingFraction: 0.91, description: 'Refreshes in four hours.' }
          ]
        }
      ]
    }
  });

  assert.deepEqual(windows.map((window) => [window.name, window.kind, window.remainingFraction]), [
    ['Gemini 5-hour', 'session', 0.91],
    ['Gemini weekly', 'weekly', 0.82],
    ['Claude/GPT 5-hour', 'session', 0.73],
    ['Claude/GPT weekly', 'weekly', 0.64]
  ]);
  assert.equal(windows[0].resetDescription, 'Refreshes in four hours.');
  assert.equal(windows[2].resetTime, '2026-06-15T12:52:10.000Z');
});

test('_quotaSummaryWindows recognizes cadence aliases and marks disabled buckets unknown', () => {
  const windows = probe._quotaSummaryWindows({
    groups: [{
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini_session', displayName: 'Session', remaining: { remainingFraction: 0.75 } },
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit', remainingFraction: 0.5, disabled: true },
        { bucketId: 'gemini-session-history', displayName: 'Session History', remainingFraction: 0.25 }
      ]
    }]
  });

  assert.deepEqual(windows.map((window) => window.name), ['Gemini 5-hour', 'Gemini weekly']);
  assert.equal(windows[0].showMeter, true);
  assert.equal(windows[1].remainingFraction, null);
  assert.equal(windows[1].showMeter, false);
});

test('probe prefers quota summary and merges identity from GetUserStatus', async () => {
  const methods = [];
  const result = await probe.probe({
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'csrf', extensionPort: null }),
    listeningPorts: async () => [54733],
    callLs: async ({ method, body }) => {
      methods.push(method);
      if (method === 'RetrieveUserQuotaSummary') {
        assert.deepEqual(body, { forceRefresh: true });
        return {
          response: {
            groups: [{
              displayName: 'Gemini Models',
              buckets: [
                { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', remaining: { remainingFraction: 0.8 } },
                { bucketId: 'gemini-weekly', displayName: 'Weekly Limit', remaining: { remainingFraction: 0.6 } }
              ]
            }]
          }
        };
      }
      return { userStatus: { email: 'a@b.com', userTier: { name: 'Google AI Pro' } } };
    }
  });

  assert.deepEqual(methods, ['GetUnleashData', 'RetrieveUserQuotaSummary', 'GetUserStatus']);
  assert.equal(result.accountEmail, 'a@b.com');
  assert.equal(result.accountPlan, 'Google AI Pro');
  assert.deepEqual(result.windows.map((window) => window.name), ['Gemini 5-hour', 'Gemini weekly']);
});

test('probe checks every endpoint for grouped quota before accepting a legacy response', async () => {
  const calls = [];
  const result = await probe.probe({
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'csrf', extensionPort: null }),
    listeningPorts: async () => [54733],
    callLs: async ({ scheme, method }) => {
      calls.push(`${scheme}:${method}`);
      if (scheme === 'https' && method === 'RetrieveUserQuotaSummary') return { code: 7 };
      if (scheme === 'http' && method === 'RetrieveUserQuotaSummary') {
        return {
          groups: [{
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'gemini-weekly', displayName: 'Weekly Limit', remainingFraction: 0.4 }]
          }]
        };
      }
      if (scheme === 'http' && method === 'GetUserStatus') {
        return { userStatus: { email: 'rich@example.com', planStatus: { planInfo: { planName: 'Pro' } } } };
      }
      return {
        userStatus: {
          cascadeModelConfigData: {
            clientModelConfigs: [
              { label: 'Gemini 3 Pro', modelOrAlias: { model: 'MA' }, quotaInfo: { remainingFraction: 0.9 } }
            ]
          }
        }
      };
    }
  });

  assert.deepEqual(calls, [
    'https:GetUnleashData',
    'https:RetrieveUserQuotaSummary',
    'http:RetrieveUserQuotaSummary',
    'http:GetUserStatus'
  ]);
  assert.equal(result.accountEmail, 'rich@example.com');
  assert.deepEqual(result.windows.map((window) => window.name), ['Gemini weekly']);
  assert.equal(result.pools, undefined);
});

test('probe follows app, CLI, then IDE source priority and stops after success', async () => {
  const calls = [];
  const result = await probe.probe({
    detectProcessInfos: async () => [
      { pid: 30, kind: 'ide', csrfToken: 'ide' },
      { pid: 20, kind: 'cli', csrfToken: '' },
      { pid: 10, kind: 'app', csrfToken: 'app' }
    ],
    listeningPorts: async (pid) => [pid],
    callLs: async ({ port, method }) => {
      calls.push(`${port}:${method}`);
      if (port === 10) throw probe._errorWithStatus('unavailable', 'app unavailable');
      if (port === 20 && method === 'RetrieveUserQuotaSummary') {
        return {
          groups: [{
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'gemini-weekly', remainingFraction: 0.7 }]
          }]
        };
      }
      return { userStatus: { email: 'cli@example.com' } };
    }
  });

  assert.equal(result.sourceDetail, 'cli');
  assert.equal(result.accountEmail, 'cli@example.com');
  assert.ok(calls.some((call) => call.startsWith('10:')));
  assert.ok(calls.some((call) => call.startsWith('20:')));
  assert.ok(calls.every((call) => !call.startsWith('30:')));
});

test('probe accepts a valid app legacy response before lower-priority grouped sources', async () => {
  const calledPorts = [];
  const result = await probe.probe({
    detectProcessInfos: async () => [
      { pid: 20, kind: 'cli', csrfToken: '' },
      { pid: 10, kind: 'app', csrfToken: 'app' }
    ],
    listeningPorts: async (pid) => [pid],
    callLs: async ({ port, method }) => {
      calledPorts.push(port);
      if (port === 10 && method === 'RetrieveUserQuotaSummary') return { groups: [] };
      if (port === 10 && method === 'GetUserStatus') {
        return {
          userStatus: {
            email: 'app@example.com',
            cascadeModelConfigData: {
              clientModelConfigs: [
                { label: 'Gemini 3 Pro', modelOrAlias: { model: 'APP' }, quotaInfo: { remainingFraction: 0.5 } }
              ]
            }
          }
        };
      }
      throw new Error('lower-priority CLI should not be called');
    }
  });

  assert.equal(result.sourceDetail, 'app');
  assert.equal(result.accountEmail, 'app@example.com');
  assert.deepEqual(result.pools.map((pool) => pool.name), ['Gemini Pro']);
  assert.ok(calledPorts.every((port) => port === 10));
});

test('probe exhausts grouped quota across same-source processes before legacy fallback', async () => {
  const calls = [];
  const result = await probe.probe({
    detectProcessInfos: async () => [
      { pid: 11, kind: 'app', csrfToken: 'first' },
      { pid: 12, kind: 'app', csrfToken: 'second' }
    ],
    listeningPorts: async (pid) => [pid],
    callLs: async ({ port, scheme, method }) => {
      calls.push(`${port}:${scheme}:${method}`);
      if (port === 11 && method === 'RetrieveUserQuotaSummary') return { groups: [] };
      if (port === 12 && scheme === 'https' && method === 'RetrieveUserQuotaSummary') {
        return {
          groups: [{
            displayName: 'Future Models',
            buckets: [{ bucketId: 'future-weekly', remainingFraction: 0.4 }]
          }]
        };
      }
      if (port === 12 && method === 'GetUserStatus') return { userStatus: { email: 'second@example.com' } };
      throw new Error('legacy endpoint should not be reached');
    }
  });

  assert.equal(result.sourceDetail, 'app');
  assert.equal(result.accountEmail, 'second@example.com');
  assert.deepEqual(result.windows.map((window) => window.name), ['Future Models weekly']);
  assert.ok(calls.some((call) => call.startsWith('11:')));
  assert.ok(calls.some((call) => call.startsWith('12:')));
  assert.ok(calls.every((call) => !call.includes('GetCommandModelConfigs')));
});

test('probe resolves same-source process endpoints concurrently', async () => {
  const waiting = new Map();
  const result = await probe.probe({
    probeTimeoutMs: 500,
    detectProcessInfos: async () => [
      { pid: 11, kind: 'app', csrfToken: 'first' },
      { pid: 12, kind: 'app', csrfToken: 'second' }
    ],
    listeningPorts: async (pid) => [pid],
    callLs: async ({ port, method }) => {
      if (method === 'GetUnleashData') {
        return new Promise((resolve) => {
          waiting.set(port, resolve);
          if (waiting.size === 2) {
            for (const release of waiting.values()) release({ ok: true });
          }
        });
      }
      if (port === 11 && method === 'RetrieveUserQuotaSummary') {
        return {
          groups: [{
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'gemini-weekly', remainingFraction: 0.75 }]
          }]
        };
      }
      return { userStatus: { email: 'parallel@example.com' } };
    }
  });

  assert.equal(waiting.size, 2);
  assert.equal(result.accountEmail, 'parallel@example.com');
  assert.equal(result.sourceDetail, 'app');
});

test('probe enforces one provider-wide deadline and abort signal', async () => {
  let sawAbort = false;
  const startedAt = Date.now();
  const err = await probe.probe({
    probeTimeoutMs: 40,
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'csrf', extensionPort: null }),
    listeningPorts: async () => [54733, 54734],
    callLs: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(probe._errorWithStatus('unavailable', 'aborted'));
      }, { once: true });
    })
  }).catch((error) => error);

  assert.equal(err.status, 'unavailable');
  assert.equal(sawAbort, true);
  assert.ok(Date.now() - startedAt < 250);
});

test('probe selects a reachable endpoint before requesting quota', async () => {
  const quotaTargets = [];
  const result = await probe.probe({
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'csrf', extensionPort: null }),
    listeningPorts: async () => [100, 200],
    callLs: async ({ scheme, port, method }) => {
      if (method === 'GetUnleashData') {
        if (port === 200 && scheme === 'https') return { ok: true };
        throw probe._errorWithStatus('unavailable', 'not reachable');
      }
      if (method === 'RetrieveUserQuotaSummary') {
        quotaTargets.push(`${scheme}:${port}`);
        return {
          groups: [{
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'gemini-weekly', remainingFraction: 0.8 }]
          }]
        };
      }
      return { userStatus: { email: 'resolved@example.com' } };
    }
  });

  assert.deepEqual(quotaTargets, ['https:200']);
  assert.equal(result.accountEmail, 'resolved@example.com');
});

test('probe returns plan + 3 pools when GetUserStatus succeeds', async () => {
  const result = await probe.probe({
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'csrf', extensionPort: null }),
    listeningPorts: async () => [54733],
    callLs: async ({ method }) => {
      assert.equal(method, 'GetUserStatus');
      return {
        userStatus: {
          planStatus: { planInfo: { planName: 'Pro' } },
          cascadeModelConfigData: {
            clientModelConfigs: [
              { label: 'Gemini 3 Pro (High)',   modelOrAlias: { model: 'MA' }, quotaInfo: { remainingFraction: 0.5, resetTime: '2026-06-03T02:00:00Z' } },
              { label: 'Gemini 3 Flash',        modelOrAlias: { model: 'MB' }, quotaInfo: { remainingFraction: 0.9, resetTime: '2026-06-03T01:00:00Z' } },
              { label: 'Claude Opus',           modelOrAlias: { model: 'MC' }, quotaInfo: { remainingFraction: 0.7, resetTime: '2026-06-03T04:00:00Z' } }
            ]
          }
        }
      };
    }
  });
  assert.equal(result.accountPlan, 'Pro');
  assert.deepEqual(result.pools.map((p) => p.name), ['Gemini Pro', 'Gemini Flash', 'Claude']);
});

test('probe prefers userTier name and richer planInfo display fields', async () => {
  const withUserTier = await probe.probe({
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'csrf', extensionPort: null }),
    listeningPorts: async () => [54733],
    callLs: async () => ({
      userStatus: {
        userTier: { name: 'Google AI Ultra' },
        planStatus: { planInfo: { planDisplayName: 'Google AI Pro', planName: 'Pro' } },
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 3 Pro', modelOrAlias: { model: 'MA' }, quotaInfo: { remainingFraction: 0.5, resetTime: null } }
          ]
        }
      }
    })
  });
  assert.equal(withUserTier.accountPlan, 'Google AI Ultra');

  const withPlanInfoDisplay = await probe.probe({
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'csrf', extensionPort: null }),
    listeningPorts: async () => [54733],
    callLs: async () => ({
      userStatus: {
        planStatus: { planInfo: { planDisplayName: 'Google AI Pro', planName: 'Pro' } },
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 3 Pro', modelOrAlias: { model: 'MA' }, quotaInfo: { remainingFraction: 0.5, resetTime: null } }
          ]
        }
      }
    })
  });
  assert.equal(withPlanInfoDisplay.accountPlan, 'Google AI Pro');
});

test('probe falls back to GetCommandModelConfigs when GetUserStatus has no userStatus', async () => {
  const methods = [];
  const result = await probe.probe({
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'csrf', extensionPort: null }),
    listeningPorts: async () => [54733],
    callLs: async ({ method }) => {
      methods.push(method);
      if (method === 'GetUserStatus') return { code: 7 };
      if (method === 'GetUnleashData') return { ok: true };
      return {
        clientModelConfigs: [
          { label: 'Claude Sonnet', modelOrAlias: { model: 'MX' }, quotaInfo: { remainingFraction: 0.3, resetTime: '2026-06-03T05:00:00Z' } }
        ]
      };
    }
  });
  assert.deepEqual(methods, [
    'GetUnleashData',
    'RetrieveUserQuotaSummary',
    'RetrieveUserQuotaSummary',
    'GetUserStatus',
    'GetUserStatus',
    'GetCommandModelConfigs'
  ]);
  assert.equal(result.accountPlan, null);
  assert.deepEqual(result.pools.map((p) => p.name), ['Claude']);
});

test('probe rethrows the last error when every endpoint fails', async () => {
  const err = await probe.probe({
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'csrf', extensionPort: null }),
    listeningPorts: async () => [54733],
    callLs: async () => { throw probe._errorWithStatus('unauthorized', '401'); }
  }).catch((e) => e);
  assert.equal(err.status, 'unauthorized');
});

test('probe surfaces notConfigured from detectProcessInfo', async () => {
  const err = await probe.probe({
    detectProcessInfo: async () => { throw probe._errorWithStatus('notConfigured', 'not running'); }
  }).catch((e) => e);
  assert.equal(err.status, 'notConfigured');
});
