'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const nativeBinary = process.env.TOKEN_MONITOR_TOKSCALE_CLAUDE_WSL_CLI;
const id = '11111111-2222-4333-8444-555555555555';

test('native Agent once preserves mirror selection across deletion, without writing anchors', {
  skip: !nativeBinary && 'set TOKEN_MONITOR_TOKSCALE_CLAUDE_WSL_CLI to the candidate binary',
  timeout: 90000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-once-mirrors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, 'shared');
  const selection = path.join(shared, 'claude-remote-mirrors.json');
  const projects = path.join(root, '.claude', 'projects');
  const mirror = path.join(projects, `ssh-${id}`);
  for (const [folder, session, tokens] of [[mirror, id, 100], [path.join(projects, 'local'), 'local', 20]]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${session}.jsonl`), JSON.stringify({
      type: 'assistant', sessionId: session, timestamp: new Date().toISOString(), requestId: `r_${session}`,
      message: { id: `m_${session}`, model: 'claude-sonnet-4-6', usage: { input_tokens: tokens, output_tokens: 0 } }
    }) + '\n');
  }
  // Redirect only bundled-package resolution in the child. Agent, collector,
  // native scanner, SQLite archive and HTTP delivery are all production code.
  const pkg = path.join(root, 'candidate');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '4.20.0' }));
  fs.copyFileSync(nativeBinary, path.join(pkg, 'bin', process.platform === 'win32' ? 'tokscale.exe' : 'tokscale'), fs.constants.COPYFILE_FICLONE);
  const preload = path.join(root, 'candidate.cjs');
  fs.writeFileSync(preload, `const Module = require('node:module');
const original = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  if (request.startsWith('@tokscale/cli-') && request.endsWith('/package.json')) return ${JSON.stringify(path.join(pkg, 'package.json'))};
  return original.call(this, request, ...args);
};\n`);
  const payloads = [];
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    requests += 1;
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.url === '/api/ingest') {
      payloads.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TOKEN_MONITOR_|TOKSCALE_|CLAUDE_|NODE_OPTIONS$)/.test(key)));
  Object.assign(env, {
    HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_CONFIG_HOME: path.join(root, 'xdg'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
    CLAUDE_CONFIG_DIR: path.join(root, '.claude'), TOKSCALE_CONFIG_DIR: path.join(root, 'tokscale'), TOKSCALE_PRICING_CACHE_ONLY: '1',
    TOKEN_MONITOR_SHARED_DIR: shared, TOKEN_MONITOR_DEVICE_ID: 'fixture', TOKEN_MONITOR_SECRET: 'fixture'
  });
  const args = ['--require', preload, path.resolve(__dirname, '../../src/agent/agent.js'), '--once',
    '--hub', `http://127.0.0.1:${server.address().port}`, '--clients=claude', '--limits=false', '--watch=0',
    '--history=false', '--projects=false', '--wslScan=false', '--since=2020-01-01'];
  const run = (exclude, dry = false) => runFile(process.execPath,
    [...args, `--exclude-claude-remote-mirrors=${exclude}`, ...(dry ? ['--dry-run'] : [])],
    { cwd: root, env, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const totals = value => ['today', 'month', 'allTime'].map(period => value[period].totalTokens);
  await run(false);
  assert.deepEqual(totals(payloads.at(-1)), [120, 120, 120]);
  assert.ok(fs.existsSync(path.join(shared, 'session-usage-archive.sqlite')));
  const archiveBeforeDry = fs.readFileSync(path.join(shared, 'session-usage-archive.sqlite'));
  const requestsBeforeDry = requests;
  assert.deepEqual(totals(JSON.parse((await run(true, true)).stdout)), [20, 20, 20]);
  assert.equal(requests, requestsBeforeDry, 'dry-run makes no Hub requests');
  assert.equal(fs.existsSync(selection), false, 'dry-run cannot create the selection');
  assert.deepEqual(fs.readFileSync(path.join(shared, 'session-usage-archive.sqlite')), archiveBeforeDry);
  // An actual atomic-write failure must abort the scan, not publish an
  // exclusion that will be forgotten on the next invocation.
  fs.mkdirSync(`${selection}.tmp`);
  await assert.rejects(run(true), error => /EISDIR|EACCES|EPERM/.test(error.stderr));
  assert.equal(payloads.length, 1, 'failed persistence cannot upload usage');
  assert.deepEqual(fs.readFileSync(path.join(shared, 'session-usage-archive.sqlite')), archiveBeforeDry);
  fs.rmdirSync(`${selection}.tmp`);
  await run(true);
  assert.deepEqual(totals(payloads.at(-1)), [20, 20, 20]);
  fs.rmSync(mirror, { recursive: true });
  await run(true);
  assert.deepEqual(payloads.map(totals), [[120, 120, 120], [20, 20, 20], [20, 20, 20]]);
  assert.ok(fs.readFileSync(selection, 'utf8').includes(`ssh-${id}`));
  assert.equal(fs.existsSync(path.join(shared, 'collector-anchor.json')), false);
  assert.ok(payloads.every(value => value.excludedSessionKeys === undefined));
  // Corrupt-state preview must neither repair the file nor create a backup.
  const saved = fs.readFileSync(selection);
  fs.writeFileSync(selection, '{broken');
  const count = requests;
  assert.deepEqual(totals(JSON.parse((await run(true, true)).stdout)), [20, 20, 20]);
  assert.equal(requests, count);
  assert.equal(fs.readFileSync(selection, 'utf8'), '{broken');
  assert.equal(fs.readdirSync(shared).some(name => name.endsWith('.corrupt')), false);
  fs.writeFileSync(selection, saved);
  await run(false);
  assert.deepEqual(totals(payloads.at(-1)), [120, 120, 120], 'exclusion never deleted the archived observation');
});
