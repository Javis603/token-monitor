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
  assert.equal(info.kind, 'ide');
});

test('parseProcessLine tags the IDE language server as kind=ide', () => {
  const line = '53602 /Applications/Antigravity.app/Contents/Resources/bin/language_server --override_ide_name antigravity --csrf_token abc --app_data_dir antigravity';
  assert.equal(probe._parseProcessLine(line).kind, 'ide');
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

test('detectProcessInfo (posix) returns the first matching antigravity LS', async () => {
  const stdout = [
    '111 /bin/bash --login',
    '53602 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --override_ide_name antigravity --csrf_token abc-123 --app_data_dir antigravity'
  ].join('\n');
  const info = await probe.detectProcessInfo({ platform: 'darwin', spawn: fakeSpawn(stdout) });
  assert.equal(info.pid, 53602);
  assert.equal(info.csrfToken, 'abc-123');
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
  let callCount = 0;
  const result = await probe.probe({
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'csrf', extensionPort: null }),
    listeningPorts: async () => [54733],
    callLs: async ({ method }) => {
      callCount += 1;
      if (method === 'GetUserStatus') return { code: 7 };
      return {
        clientModelConfigs: [
          { label: 'Claude Sonnet', modelOrAlias: { model: 'MX' }, quotaInfo: { remainingFraction: 0.3, resetTime: '2026-06-03T05:00:00Z' } }
        ]
      };
    }
  });
  assert.equal(callCount, 2);
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
