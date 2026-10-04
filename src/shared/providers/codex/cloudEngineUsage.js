'use strict';

// Opt-in live viewer attachment, not a history/backfill or billing reader.
const { setTimeout: delay } = require('node:timers/promises');
const { CloudTransport, MAX_BYTES } = require('./cloudTransport');
const { CloudLiveMeter } = require('./cloudLiveMeter');
const { identifier, error } = require('./cloudUsage');

class CloudEngineUsage extends CloudTransport {
  constructor(options = {}, deps = {}) {
    super(options, deps);
    this.target = null; this.meter = null; this.onSample = null; this.storageError = null;
    this.lifecycle = { attached: false, detachStatus: null, interruptedObservation: false };
  }
  onMessage(data) {
    if (!this.closed && this.meter) {
      const buffer = typeof data === 'string' ? Buffer.from(data) : data instanceof ArrayBuffer ? Buffer.from(data) : null;
      if (buffer && buffer.length <= MAX_BYTES) {
        let message;
        try { message = JSON.parse(buffer.toString('utf8')); } catch (_) {}
        if (message && message.method === 'thread/tokenUsage/updated' && message.id === undefined && message.params?.threadId === this.target) {
          // Verify ownership before persisting an event, not only when the
          // observation window ends. Never attribute a switched login's data.
          try { this.assertIdentity(); }
          catch (_) { this.fail('LOGIN_CHANGED'); return; }
          const sample = this.meter.observe(message);
          if (sample && this.onSample) {
            try { this.onSample(sample); } catch (_) { this.storageError = 'EVENT_PERSIST_FAILED'; this.fail(this.storageError); }
          }
        }
      }
    }
    super.onMessage(data);
  }
  async capture(threadId, { acknowledgeAttach = false, waitMs = 30000, onSample, signal } = {}) {
    if (!acknowledgeAttach) throw error('EXPLICIT_ATTACH_REQUIRED');
    identifier(threadId);
    if (this.target || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120000) throw error('INVALID_CAPTURE_OPTIONS');
    if (signal?.aborted) throw error('OBSERVATION_ABORTED');
    this.target = threadId; this.meter = new CloudLiveMeter(threadId); this.onSample = onSample;
    let response = null; let observationFailure = null;
    try {
      await this.initialize();
      if (signal?.aborted) throw error('OBSERVATION_ABORTED');
      // Viewer attachment may load environment/MCP state. It does not submit
      // input, change thread settings, or start a model turn. Cheap metadata
      // attachment intentionally stays distinct from unverified history replay.
      response = await this.send('thread/resume', { threadId, excludeTurns: true });
      if (response?.thread?.id !== threadId) throw error('ENGINE_THREAD_MISMATCH');
      this.lifecycle.attached = true;
      if (waitMs) {
        try { await delay(waitMs, undefined, { signal }); }
        catch (e) { if (e.name !== 'AbortError') throw e; this.lifecycle.interruptedObservation = true; }
      }
      this.assertIdentity();
      if (this.storageError) throw error(this.storageError);
    } catch (e) {
      observationFailure = /^[A-Z_]{1,60}$/.test(e.code || '') ? e.code : 'ENGINE_CAPTURE_FAILED';
    } finally {
      if (this.initialized && !this.closed && this.lifecycle.attached) {
        try {
          const result = await this.send('thread/unsubscribe', { threadId });
          this.lifecycle.detachStatus = ['unsubscribed', 'notSubscribed', 'notLoaded'].includes(result?.status) ? result.status : 'unknown';
        } catch (_) { this.lifecycle.detachStatus = 'disconnect-fallback'; }
      }
    }
    if (observationFailure) throw error(observationFailure);
    return { ...this.meter.report(),
      sessionId: typeof response?.thread?.sessionId === 'string' ? response.thread.sessionId : null,
      forkedFromId: typeof response?.thread?.forkedFromId === 'string' ? response.thread.forkedFromId : null,
      resumeKind: typeof response?.resumeKind === 'string' ? response.resumeKind : null,
      historyMode: response?.thread?.historyMode || null,
      lifecycle: this.lifecycle, transportAudit: { ...this.audit }, scopeFingerprint: this.scopeFingerprint };
  }
}
module.exports = { CloudEngineUsage };
