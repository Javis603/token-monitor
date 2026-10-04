'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

// Read-only usage transport. Never starts model turns, logs in, or grants approvals.
const METHODS = new Set(['account/usage/read', 'thread/read', 'thread/list']);
const MAX_LINE_BYTES = 2 * 1024 * 1024;
function rpcError(code) {
  const error = new Error(code); error.code = code; return error;
}
class UsageRpc extends EventEmitter {
  constructor({ binary, env = process.env, timeoutMs = 20000, spawnImpl = spawn } = {}) {
    super();
    if (typeof binary !== 'string' || !binary || binary.includes('\0')) throw rpcError('INVALID_BINARY');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw rpcError('INVALID_TIMEOUT');
    this.timeoutMs = timeoutMs; this.pending = new Map(); this.nextId = 1;
    this.buffer = Buffer.alloc(0); this.closed = false; this.initialized = false; this.accountChanged = false; this.accountRevision = 0;
    this.child = spawnImpl(binary, ['app-server', '--listen', 'stdio://'], {
      shell: false, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.on('data', (chunk) => this.receive(chunk));
    this.child.stdout.on('error', () => this.fail('RPC_STREAM_ERROR'));
    this.child.stderr.resume(); // Discard stderr: it can contain auth errors or private paths.
    this.child.stderr.on('error', () => this.fail('RPC_STREAM_ERROR'));
    this.child.stdin.on('error', () => this.fail('RPC_WRITE_ERROR'));
    this.child.on('error', () => this.fail('RPC_START_FAILED'));
    this.child.on('close', () => this.fail('RPC_CLOSED'));
  }
  fail(code) {
    this.closed = true; this.buffer = Buffer.alloc(0);
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(rpcError(code)); }
    this.pending.clear();
  }
  receive(chunk) {
    if (this.closed) return;
    let start = 0;
    for (let at = 0; at <= chunk.length; at += 1) {
      if (at !== chunk.length && chunk[at] !== 10) continue;
      const part = chunk.subarray(start, at);
      if (this.buffer.length + part.length > MAX_LINE_BYTES) {
        this.fail('RPC_MESSAGE_TOO_LARGE'); this.child.kill('SIGTERM'); return;
      }
      this.buffer = Buffer.concat([this.buffer, part]);
      if (at !== chunk.length) {
        const line = this.buffer; this.buffer = Buffer.alloc(0);
        if (line.length) this.message(line);
        if (this.closed) return;
      }
      start = at + 1;
    }
  }
  message(line) {
    let msg;
    try { msg = JSON.parse(line.toString('utf8')); }
    catch (_) { this.fail('RPC_INVALID_JSON'); return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { this.fail('RPC_INVALID_MESSAGE'); return; }
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) {
        try { this.write({ id: msg.id, error: { code: -32601, message: 'Read-only usage client' } }); }
        catch (_) { this.fail('RPC_WRITE_ERROR'); }
      } else if (msg.method === 'account/updated') {
        this.accountRevision += 1;
        if (this.initialized) this.accountChanged = true;
      }
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(msg.id);
    if (msg.error) {
      const code = msg.error.code === -32601 ? 'RPC_METHOD_UNAVAILABLE' :
        msg.error.code === -32602 ? 'RPC_INVALID_PARAMS' : 'RPC_REQUEST_FAILED';
      pending.reject(rpcError(code));
    } else if (!Object.hasOwn(msg, 'result')) pending.reject(rpcError('RPC_MISSING_RESULT'));
    else pending.resolve(msg.result);
  }
  write(msg) {
    if (this.closed || !this.child.stdin.writable) throw rpcError('RPC_CLOSED');
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }
  send(method, params) {
    if (this.closed) return Promise.reject(rpcError('RPC_CLOSED'));
    if (this.pending.size >= 8) return Promise.reject(rpcError('RPC_TOO_MANY_REQUESTS'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(rpcError('RPC_TIMEOUT')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (_) { clearTimeout(timer); this.pending.delete(id); reject(rpcError('RPC_WRITE_ERROR')); }
    });
  }
  async initialize() {
    if (this.initialized) return;
    await this.send('initialize', {
      clientInfo: { name: 'token_monitor_usage_reader', title: 'Token Monitor usage reader', version: '1.0.0' },
      capabilities: { experimentalApi: true }
    });
    this.write({ method: 'initialized', params: {} }); this.initialized = true;
  }
  call(method, params = {}) {
    if (!METHODS.has(method)) return Promise.reject(rpcError('READ_ONLY_METHOD_DENIED'));
    if (!this.initialized) return Promise.reject(rpcError('RPC_NOT_INITIALIZED'));
    return this.send(method, params);
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) { this.fail('RPC_CLOSED'); resolve(); return; }
      let timer;
      const finish = () => { clearTimeout(timer); this.fail('RPC_CLOSED'); resolve(); };
      this.child.once('close', finish);
      timer = setTimeout(() => { this.child.kill('SIGKILL'); }, 1000);
      this.child.stdin.end(); this.child.kill('SIGTERM');
    });
    return this.closePromise;
  }
}
module.exports = { UsageRpc, rpcError, MAX_LINE_BYTES };
