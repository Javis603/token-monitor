'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readSessionDetail } = require('../../src/shared/sessionDetail');

function transcript(t, client = 'codex') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-stream-detail-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessionId = 'stream-test';
  const dir = client === 'codex'
    ? path.join(home, '.codex', 'sessions')
    : path.join(home, `.${client}`, 'projects', 'test');
  fs.mkdirSync(dir, { recursive: true });
  return { file: path.join(dir, `${sessionId}.jsonl`), args: { client, sessionId, home, env: {}, sessionCost: 1 } };
}

const codexTurn = JSON.stringify({ type: 'event_msg', payload: {
  type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } }
} });

function promptOf(client, text) {
  if (client === 'codex') return JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } });
  if (client === 'claude') return JSON.stringify({ type: 'user', message: { content: text } });
  return JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
}

function turnOf(client) {
  if (client === 'codex') return codexTurn;
  if (client === 'claude') return JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 10 } } });
  return JSON.stringify({ type: 'message', role: 'assistant', providerData: {
    messageId: 'response', rawUsage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, completion_tokens: 10 }
  } });
}

for (const client of ['codex', 'codebuddy', 'workbuddy']) {
  test(`${client} reads a transcript larger than the V8 string limit without losing the final usage`, (t) => {
    const { file, args } = transcript(t, client);
    const fd = fs.openSync(file, 'w');
    try {
      // Synthetic tool output keeps the fixture private and the parsed result small.
      const output = Buffer.from(JSON.stringify({ type: 'response_item', payload: {
        type: 'function_call_output', output: 'x'.repeat(1024 * 1024)
      } }) + '\n');
      for (let i = 0; i < 513; i += 1) fs.writeSync(fd, output);
      fs.writeSync(fd, turnOf(client));
    } finally {
      fs.closeSync(fd);
    }
    assert.ok(fs.statSync(file).size > require('node:buffer').constants.MAX_STRING_LENGTH);
    const detail = readSessionDetail(args);
    assert.equal(detail.found, true);
    assert.equal(detail.totals.totalTokens, 110);
    assert.equal(detail.totals.turnCount, 1);
    assert.equal(detail.totals.costUsd, 1);
  });
}

for (const client of ['codex', 'claude', 'codebuddy', 'workbuddy']) {
  test(`${client} preserves UTF-8 across chunks, CRLF and an unterminated final record`, (t) => {
    const { file, args } = transcript(t, client);
    const text = '繁體中文🙂';
    const prompt = promptOf(client, text);
    const turn = turnOf(client);
    const prefixBytes = Buffer.byteLength(prompt.slice(0, prompt.indexOf(text)));
    const padding = ' '.repeat(65535 - prefixBytes - 2) + '\r\n';
    fs.writeFileSync(file, `${padding}${prompt}\r\n{torn json\r\n${turn}`);
    const detail = readSessionDetail(args);
    assert.equal(detail.found, true);
    assert.equal(detail.exchanges[0].promptPreview, text);
    assert.equal(detail.totals.totalTokens, 110);
    assert.equal(detail.totals.turnCount, 1);
  });
}

for (const client of ['codex', 'codebuddy', 'workbuddy']) {
  test(`${client} rejects an oversized record without publishing partial usage`, (t) => {
    const { file, args } = transcript(t, client);
    fs.writeFileSync(file, turnOf(client) + '\n' + 'x'.repeat(16 * 1024 * 1024 + 1));
    const detail = readSessionDetail(args);
    assert.equal(detail.found, false);
    assert.equal(detail.error, 'line-too-large');
    assert.deepEqual(detail.exchanges, []);
  });
}

test('reports read failures separately from missing transcripts', (t) => {
  const { file, args } = transcript(t);
  fs.writeFileSync(file, codexTurn);
  t.mock.method(fs, 'readSync', () => { throw Object.assign(new Error('read failed'), { code: 'EIO' }); });
  const detail = readSessionDetail(args);
  assert.equal(detail.found, false);
  assert.equal(detail.error, 'read-failed');
  assert.deepEqual(detail.exchanges, []);
});

for (const client of ['codex', 'claude', 'codebuddy', 'workbuddy']) {
  test(`${client} returns the missing result when the transcript disappears before opening`, (t) => {
    const { file, args } = transcript(t, client);
    const expected = readSessionDetail(args);
    fs.writeFileSync(file, codexTurn);
    const openSync = fs.openSync;
    let removed = false;
    t.mock.method(fs, 'openSync', (filePath, ...options) => {
      if (filePath === file) {
        fs.unlinkSync(file);
        removed = true;
      }
      return openSync(filePath, ...options);
    });

    const detail = readSessionDetail(args);
    assert.equal(removed, true, 'the resolver found the file before it disappeared');
    assert.deepEqual(detail, expected);
    assert.equal(Object.hasOwn(detail, 'error'), false);
  });
}
