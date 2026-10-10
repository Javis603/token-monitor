'use strict';

// WorkBuddy 桌面客户端把自身凭据封存后，本进程永远读不到明文；但客户端在
// 运行时暴露 WBIPC 命名管道（`~/.workbuddy/wbipc/endpoint.json` 提供
// endpoint + ticket），其 `wb.request/http.fetch` 方法允许已授权方以**宿主
// 自己的身份**代理 HTTP 请求——path 必须是相对路径，目标 host 与身份由宿主
// 裁决。计费端点在这张白名单里（subscription-gate/auth.md 同源协议）。
//
// 线协议：换行分帧 JSON + HMAC-SHA256 双向证明（v1），与
// workbuddy-server/src/wbipc/、subscription-gate/dist/gate.mjs、
// workbuddy_ipc/__init__.py 三方同构。零 runtime 依赖。
//
// 每次调用新建一条连接：本地管道握手 <10ms，而 daemon 重启会换管道名并作废
// 旧连接，常驻连接的收益抵不过失效处理的复杂度。

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 20000;
const REQUEST_PIPE = 'wb.request';
const FETCH_METHOD = 'http.fetch';

function readDiscovery(deps = {}) {
    const configDir = (deps.env || process.env).WORKBUDDY_CONFIG_DIR?.trim()
        || path.join(deps.homeDir || os.homedir(), '.workbuddy');
    const file = path.join(configDir, 'wbipc', 'endpoint.json');
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (_) {
        return null; // 宿主没跑或没暴露通道
    }
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.endpoint === 'string' && parsed.endpoint
            && typeof parsed.ticket === 'string' && parsed.ticket) {
            return { endpoint: parsed.endpoint, ticket: parsed.ticket };
        }
    } catch (_) { /* malformed → 视为无通道 */ }
    return null;
}

// ─── 线协议原语 ───

function encodeTranscript(role, { protocol, endpoint, clientNonce, serverNonce }) {
    const domain = role === 'server' ? 'wbipc-s' : 'wbipc-c';
    const chunks = [];
    for (const part of [domain, String(protocol), endpoint, clientNonce, serverNonce]) {
        const buf = Buffer.from(part, 'utf8');
        const len = Buffer.alloc(4);
        len.writeUInt32BE(buf.length, 0);
        chunks.push(len, buf);
    }
    return Buffer.concat(chunks);
}

function computeProof(ticket, role, transcript) {
    return crypto.createHmac('sha256', Buffer.from(ticket, 'utf8'))
        .update(encodeTranscript(role, transcript))
        .digest('base64url');
}

function ticketIdOf(ticket) {
    return crypto.createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16);
}

// ─── 连接 ───

/**
 * 握手并返回 { call(method, params, mode, timeoutMs), close() }。
 * 服务端先自证：拿不出 server_proof 的对端视为被抢占，硬失败。
 */
function connectWbipc(endpoint, ticket, deps = {}) {
    const handshakeTimeoutMs = deps.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        const socket = net.connect({ path: endpoint });
        let buffer = Buffer.alloc(0);
        let settled = false;
        let handleFrame = () => undefined;
        let handleFailure = (error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(error);
        };
        socket.on('data', (chunk) => {
            buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
            for (;;) {
                const nl = buffer.indexOf(0x0a);
                if (nl < 0) {
                    if (buffer.length > MAX_FRAME_BYTES) handleFailure(new Error('wbipc frame exceeds limit'));
                    return;
                }
                if (nl > MAX_FRAME_BYTES) {
                    handleFailure(new Error('wbipc frame exceeds limit'));
                    return;
                }
                const line = buffer.subarray(0, nl);
                buffer = buffer.subarray(nl + 1);
                if (line.length === 0) continue;
                let parsed;
                try {
                    parsed = JSON.parse(line.toString('utf8'));
                } catch (_) {
                    handleFailure(new Error('wbipc malformed frame'));
                    return;
                }
                handleFrame(parsed);
            }
        });
        socket.on('error', (error) => handleFailure(error));
        const send = (frame) => socket.write(JSON.stringify(frame) + '\n');
        const clientNonce = crypto.randomBytes(16).toString('base64url');
        const handshakeTimer = setTimeout(() => handleFailure(new Error('wbipc handshake timeout')), handshakeTimeoutMs);
        socket.once('connect', () => {
            send({
                type: 'session_hello',
                protocol_min: PROTOCOL_VERSION,
                protocol_max: PROTOCOL_VERSION,
                client_nonce: clientNonce,
                ticket_id: ticketIdOf(ticket),
                client: { kind: 'plugin', id: 'token-monitor' },
            });
        });
        handleFrame = (frame) => {
            if (frame.type === 'session_hello_error') {
                handleFailure(new Error('wbipc handshake rejected: ' + String(frame.code ?? '?')));
                return;
            }
            if (frame.type === 'session_challenge') {
                const serverNonce = typeof frame.server_nonce === 'string' ? frame.server_nonce : '';
                const transcript = { protocol: PROTOCOL_VERSION, endpoint, clientNonce, serverNonce };
                if (!serverNonce || computeProof(ticket, 'server', transcript) !== frame.server_proof) {
                    handleFailure(new Error('wbipc endpoint failed to prove ticket possession'));
                    return;
                }
                send({ type: 'session_prove', client_proof: computeProof(ticket, 'client', transcript) });
                return;
            }
            if (frame.type === 'session_hello_ack') {
                clearTimeout(handshakeTimer);
                const pending = new Map();
                let nextId = 1;
                handleFrame = (rpcFrame) => {
                    const entry = pending.get(rpcFrame.id);
                    if (!entry) return; // pipe_revoked 等通知帧
                    pending.delete(rpcFrame.id);
                    clearTimeout(entry.timer);
                    if (rpcFrame.error) {
                        const error = new Error(String(rpcFrame.error.message ?? 'wbipc request failed'));
                        error.code = rpcFrame.error.code;
                        entry.reject(error);
                        return;
                    }
                    entry.resolve(rpcFrame.result);
                };
                handleFailure = (error) => {
                    for (const entry of pending.values()) {
                        clearTimeout(entry.timer);
                        entry.reject(error);
                    }
                    pending.clear();
                    socket.destroy();
                };
                settled = true;
                resolve({
                    call: (method, params, callMode, timeoutMs = CALL_TIMEOUT_MS) => new Promise((res, rej) => {
                        const id = nextId++;
                        const timer = setTimeout(() => {
                            if (pending.delete(id)) rej(new Error('wbipc call timeout: ' + method));
                        }, timeoutMs);
                        pending.set(id, { resolve: res, reject: rej, timer });
                        send({ jsonrpc: '2.0', id, method, params, ...(callMode ? { mode: callMode } : {}) });
                    }),
                    close: () => socket.destroy(),
                });
                return;
            }
            handleFailure(new Error('wbipc unexpected handshake frame: ' + String(frame.type)));
        };
    });
}

/**
 * 经宿主代理一次 HTTP 请求，返回 fetch 兼容的最小响应：
 * { ok, status, json() }。宿主裁决目标 host 与身份；调用方只给相对 path。
 * 宿主不可达/未授权时抛带 `code` 的错误（E_NOT_WORKBUDDY / E_CONSENT_REQUIRED /
 * E_TICKET_INVALID…），由调用方决定降级语义。
 */
async function wbipcProxyFetch(url, init = {}, deps = {}) {
    const discovery = readDiscovery(deps);
    if (!discovery) {
        const error = new Error('wbipc endpoint not available');
        error.code = 'E_NOT_WORKBUDDY';
        throw error;
    }
    const target = new URL(String(url));
    const bodyText = typeof init.body === 'string' ? init.body : '';
    const client = await connectWbipc(discovery.endpoint, discovery.ticket, deps);
    try {
        const pipe = await client.call('broker/GetPipe', { pipe: REQUEST_PIPE }, null, deps.callTimeoutMs);
        const channel = typeof pipe?.channel === 'string' ? pipe.channel : '';
        if (!channel) throw new Error('wbipc pipe unavailable: ' + REQUEST_PIPE);
        const result = await client.call(`${channel}/${FETCH_METHOD}`, {
            method: String(init.method || 'GET').toUpperCase(),
            path: target.pathname,
            ...(bodyText ? { body_b64: Buffer.from(bodyText, 'utf8').toString('base64') } : {}),
        }, 'call', deps.callTimeoutMs);
        const status = Number(result?.status || 0);
        let body = null;
        if (result?.body_b64) {
            try { body = JSON.parse(Buffer.from(result.body_b64, 'base64').toString('utf8')); } catch (_) { body = null; }
        }
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
        };
    } finally {
        client.close();
    }
}

module.exports = {
    computeProof,
    connectWbipc,
    encodeTranscript,
    readDiscovery,
    ticketIdOf,
    wbipcProxyFetch
};
