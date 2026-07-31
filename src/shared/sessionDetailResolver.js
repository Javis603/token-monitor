'use strict';

const os = require('node:os');

const { readSessionDetail } = require('./sessionDetail');
const { wslUsageHomes } = require('./wslUsage');

const WSL_JSONL_CLIENTS = new Set(['claude', 'codex']);

function readSessionDetailForPlatform(args = {}, deps = {}) {
  const readDetail = deps.readSessionDetail || readSessionDetail;
  const nativeHome = (deps.homedir || os.homedir)();
  const nativeDetail = readDetail({ ...args, home: nativeHome });
  const platform = deps.platform || process.platform;

  if (nativeDetail.found || platform !== 'win32' || !WSL_JSONL_CLIENTS.has(args.client)) {
    return nativeDetail;
  }

  let wslHomes;
  try {
    wslHomes = (deps.wslUsageHomes || wslUsageHomes)();
  } catch (_) {
    return nativeDetail;
  }

  const searched = new Set([nativeHome]);
  for (const home of wslHomes || []) {
    if (!home || searched.has(home)) continue;
    searched.add(home);
    const detail = readDetail({ ...args, home });
    if (detail.found) return detail;
  }
  return nativeDetail;
}

module.exports = { readSessionDetailForPlatform };
