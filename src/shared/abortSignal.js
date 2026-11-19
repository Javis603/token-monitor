'use strict';

function abortReason(signal, fallback = 'operation aborted') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(String(signal?.reason || fallback));
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal, fallback) {
  if (signal?.aborted) throw abortReason(signal, fallback);
}

module.exports = {
  abortReason,
  throwIfAborted
};
