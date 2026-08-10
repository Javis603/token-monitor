'use strict';

function safeLog(logger, message) {
  try { logger?.(message); } catch (_) {}
}

function createMacWidgetSnapshotController(options = {}) {
  const captureWork = options.captureWork;
  const resolveHistory = options.resolveHistory;
  const prepareSnapshot = options.prepareSnapshot;
  const commitSnapshot = options.commitSnapshot;
  const syncSnapshot = options.syncSnapshot;
  const discardSnapshot = options.discardSnapshot;
  const reloadSnapshot = options.reloadSnapshot;
  const logger = options.logger;
  const schedule = options.schedule || setImmediate;

  let producerEpoch = 1;
  let sourceEpoch = 1;
  let nextSequence = 0;
  let latestSequence = 0;
  let pendingWork = null;
  let running = false;
  let paused = options.startPaused === true;
  let stopped = false;
  let idleWaiters = [];

  function settleIdle() {
    if (running || pendingWork) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function producerIsCurrent(owner) {
    return !stopped && owner?.epoch === producerEpoch;
  }

  function ownerIsCurrent(owner) {
    return !stopped && owner?.epoch === sourceEpoch;
  }

  function workIsCurrent(work) {
    return ownerIsCurrent(work?.owner) && work.sequence === latestSequence;
  }

  async function discard(prepared) {
    if (!prepared) return;
    try {
      await discardSnapshot?.(prepared);
    } catch (error) {
      safeLog(logger, `[mac-widget] temporary snapshot cleanup failed: ${error?.message || error}`);
    }
  }

  async function processWork(work) {
    let prepared = null;
    try {
      if (!workIsCurrent(work)) return;
      const history = await resolveHistory(work);
      if (!workIsCurrent(work)) return;

      const result = await prepareSnapshot(work, history);
      prepared = result?.prepared || null;
      if (!result?.ok || result.changed === false) return;
      if (!workIsCurrent(work)) {
        await discard(prepared);
        prepared = null;
        return;
      }

      const committed = commitSnapshot(prepared, {
        isCurrent: () => workIsCurrent(work)
      });
      if (!committed?.ok) {
        await discard(prepared);
        prepared = null;
        return;
      }
      const committedPrepared = prepared;
      prepared = null;

      try {
        await syncSnapshot?.(work, committed, committedPrepared);
      } catch (error) {
        safeLog(logger, `[mac-widget] snapshot directory sync failed: ${error?.message || error}`);
      }
      if (ownerIsCurrent(work.owner) && committed.changed !== false) {
        reloadSnapshot?.(work, {
          isCurrent: () => ownerIsCurrent(work.owner)
        });
      }
    } catch (error) {
      await discard(prepared);
      safeLog(logger, `[mac-widget] update failed: ${error?.message || error}`);
    }
  }

  async function drain() {
    try {
      while (pendingWork) {
        const work = pendingWork;
        pendingWork = null;
        await processWork(work);
      }
    } finally {
      running = false;
      if (pendingWork && !stopped) startDrain();
      else settleIdle();
    }
  }

  function startDrain() {
    if (running || paused || stopped || !pendingWork) return;
    running = true;
    schedule(() => { void drain(); });
  }

  function resume() {
    if (stopped || !paused) return;
    paused = false;
    startDrain();
  }

  function captureProducerOwner() {
    if (stopped) return null;
    return Object.freeze({ epoch: producerEpoch });
  }

  function enqueue(input = {}) {
    if (!input.stats || !producerIsCurrent(input.producerOwner) || typeof captureWork !== 'function') return false;
    const sequence = ++nextSequence;
    const sourceOwner = Object.freeze({ epoch: sourceEpoch });
    let captured;
    try {
      captured = captureWork({
        stats: input.stats,
        owner: sourceOwner
      });
    } catch (error) {
      safeLog(logger, `[mac-widget] work capture failed: ${error?.message || error}`);
      return false;
    }
    if (!captured || !ownerIsCurrent(captured.owner)) return false;
    const work = Object.freeze({ ...captured, sequence });
    latestSequence = sequence;
    pendingWork = work;
    startDrain();
    return true;
  }

  function advanceSourceEpoch() {
    if (stopped) return sourceEpoch;
    sourceEpoch += 1;
    latestSequence = ++nextSequence;
    pendingWork = null;
    settleIdle();
    return sourceEpoch;
  }

  function advanceProducerAndSourceEpoch() {
    if (stopped) return sourceEpoch;
    producerEpoch += 1;
    return advanceSourceEpoch();
  }

  function stop() {
    if (stopped) return;
    producerEpoch += 1;
    sourceEpoch += 1;
    latestSequence = ++nextSequence;
    pendingWork = null;
    stopped = true;
    settleIdle();
  }

  function whenIdle() {
    if (!running && !pendingWork) return Promise.resolve();
    return new Promise((resolve) => { idleWaiters.push(resolve); });
  }

  return {
    advanceProducerAndSourceEpoch,
    advanceSourceEpoch,
    captureProducerOwner,
    enqueue,
    isCurrent: ownerIsCurrent,
    resume,
    stop,
    whenIdle
  };
}

module.exports = { createMacWidgetSnapshotController };
