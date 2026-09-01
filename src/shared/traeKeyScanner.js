'use strict';

// Extracts the Trae CN SQLCipher key from the running Trae CN.exe process
// memory (Windows only). Node port of trae-db-decrypt's scan_memory.py: find
// the process whose module list contains ai_agent.dll, enumerate committed
// readable memory regions through kernel32 (koffi), scan hex-string candidates,
// and HMAC-verify each against page 1 of the encrypted database. The key is
// generated on first Trae launch and stays stable, so this only ever runs when
// the user clicks "extract key" with Trae CN open.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { verifyTraeKey, traeDataPaths } = require('./traeUsage');

const TRAE_PROCESS_IMAGE = 'Trae CN.exe';
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_INFORMATION = 0x0400;
const MEM_COMMIT = 0x1000;
const READABLE_PROTECTS = new Set([0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]);
const MAX_REGION_BYTES = 500 * 1024 * 1024;
const READ_CHUNK_BYTES = 16 * 1024 * 1024;
const READ_OVERLAP_BYTES = 512; // patterns are ≤96 bytes wide; overlap keeps cross-chunk matches intact
const MAX_SCAN_ADDRESS = 0x7fffffffffffn;

function traeScanError(code, message, cause) {
  const error = new Error(message || code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

// latin1 keeps ASCII (pids, module names) byte-exact regardless of the console
// code page tasklist was localized with.
function tasklistText(result) {
  return Buffer.isBuffer(result) ? result.toString('latin1') : String(result ?? '');
}

function parsePidsFromTasklist(output) {
  const pids = [];
  for (const line of tasklistText(output).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('INFO:')) continue;
    const parts = trimmed.split('","').map((part) => part.replace(/^"|"$/g, ''));
    if (parts.length >= 2) {
      const pid = Number(parts[1]);
      const mem = Number(String(parts[4] || '').replace(/[^0-9]/g, ''));
      if (Number.isInteger(pid) && pid > 0) pids.push({ pid, mem: Number.isFinite(mem) ? mem : 0 });
    }
  }
  return pids.sort((a, b) => b.mem - a.mem);
}

function processHasAiAgentModule(pid, runTasklist) {
  try {
    const result = runTasklist(['tasklist', '/FI', `PID eq ${pid}`, '/M', '/FO', 'CSV', '/NH']);
    return tasklistText(result).toLowerCase().includes('ai_agent');
  } catch (_) {
    return false;
  }
}

// Returns the pid of the Trae CN process that hosts ai_agent.dll, or null.
function findTraeAgentPid(options = {}) {
  const runTasklist = options.runTasklist
    || ((args) => spawnSync(args[0], args.slice(1), { windowsHide: true, timeout: 5000 }).stdout);
  const image = options.imageName || TRAE_PROCESS_IMAGE;
  let pids;
  try {
    const result = runTasklist(['tasklist', '/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
    pids = parsePidsFromTasklist(result);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(options.candidatePids)) {
    for (const { pid } of pids) {
      if (processHasAiAgentModule(pid, runTasklist)) return pid;
    }
    return null;
  }
  // Test seam: an explicit candidate list skips the module probe (the fake
  // processes in tests have no real module list to query).
  return pids.length > 0 ? pids[0].pid : null;
}

// koffi struct/function names are process-global; the API must be built once
// per koffi instance or a second registration throws "Duplicate type name".
let cachedKernelApi = null;
let cachedKernelKoffi = null;

function loadKernelApi(koffi) {
  if (cachedKernelApi && cachedKernelKoffi === koffi) return cachedKernelApi;
  // Cache the partial object BEFORE registering anything: if a later step
  // throws, a retry must never re-register the process-global struct name.
  const api = { koffi };
  cachedKernelApi = api;
  cachedKernelKoffi = koffi;
  const kernel32 = koffi.load('kernel32.dll');
  api.MBI = koffi.struct('TOKEN_MONITOR_MEMORY_BASIC_INFORMATION', {
    BaseAddress: 'uintptr_t',
    AllocationBase: 'uintptr_t',
    AllocationProtect: 'uint32_t',
    RegionSize: 'uintptr_t',
    State: 'uint32_t',
    Protect: 'uint32_t',
    Type: 'uint32_t'
  });
  api.MBI_SIZE = koffi.sizeof(api.MBI);
  api.OpenProcess = kernel32.func('void *OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)');
  api.VirtualQueryEx = kernel32.func('size_t VirtualQueryEx(void *process, const void *address, _Out_ TOKEN_MONITOR_MEMORY_BASIC_INFORMATION *info, size_t length)');
  api.ReadProcessMemory = kernel32.func('int32_t ReadProcessMemory(void *process, const void *address, void *buffer, size_t size, size_t *read)');
  api.CloseHandle = kernel32.func('int32_t CloseHandle(void *handle)');
  return api;
}

// Enumerates committed, readable, size-capped regions of the process.
function enumerateReadableRegions(api, handle) {
  const regions = [];
  let address = 0;
  const info = { BaseAddress: 0, AllocationBase: 0, AllocationProtect: 0, RegionSize: 0, State: 0, Protect: 0, Type: 0 };
  while (BigInt(address) < MAX_SCAN_ADDRESS) {
    const written = api.VirtualQueryEx(handle, address, info, api.MBI_SIZE);
    if (!written || written < api.MBI_SIZE) break;
    const base = Number(info.BaseAddress);
    const size = Number(info.RegionSize);
    if (size <= 0 || base + size <= address) break;
    if (info.State === MEM_COMMIT && READABLE_PROTECTS.has(info.Protect) && size < MAX_REGION_BYTES) {
      regions.push({ base, size });
    }
    address = base + size;
  }
  return regions;
}

const HEX_CANDIDATE_PATTERNS = [
  /x'([0-9a-fA-F]{64,192})'/g,
  /'([0-9a-fA-F]{64})'/g,
  /([0-9a-fA-F]{64})/g
];

// Scans one buffer for key candidates. Returns the verified hex key or null.
// The buffer holds raw process memory, so it is decoded latin1 (byte-exact
// 1:1 mapping) — a utf8 decode could swallow ASCII hex bytes adjacent to
// non-ASCII continuation bytes.
function findTraeKeyInBuffer(data, { saltHex, dbPage1 }) {
  const text = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
  for (const pattern of HEX_CANDIDATE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const hex = match[1];
      if (hex.length < 64 || hex.length % 2 !== 0) continue;
      let encKeyHex = null;
      let matchedSalt = saltHex;
      if (hex.length === 64) {
        encKeyHex = hex;
      } else if (hex.length === 96) {
        encKeyHex = hex.slice(0, 64);
        matchedSalt = hex.slice(64);
      } else if (hex.length > 96) {
        encKeyHex = hex.slice(0, 64);
        matchedSalt = hex.slice(-32);
      }
      if (!encKeyHex || matchedSalt !== saltHex) continue;
      if (verifyTraeKey(encKeyHex, dbPage1)) return encKeyHex;
    }
  }
  return null;
}

// Reads a region chunk-by-chunk (bounded memory) and scans with overlap.
function scanRegion(api, handle, region, context) {
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let carry = Buffer.alloc(0);
  for (let offset = 0; offset < region.size; offset += READ_CHUNK_BYTES) {
    const size = Math.min(READ_CHUNK_BYTES, region.size - offset);
    if (!api.ReadProcessMemory(handle, region.base + offset, chunk, size, null)) continue;
    const data = Buffer.concat([carry, chunk.subarray(0, size)]);
    const key = findTraeKeyInBuffer(data, context);
    if (key) return { key, address: region.base + offset };
    carry = data.subarray(Math.max(0, data.length - READ_OVERLAP_BYTES));
    if (context.signal?.aborted) throw traeScanError('TRAE_ABORTED', 'trae: key scan aborted');
  }
  return null;
}

function readDatabasePage1(dbPath) {
  const page1 = Buffer.alloc(4096);
  const fd = fs.openSync(dbPath, 'r');
  try {
    const read = fs.readSync(fd, page1, 0, 4096, 0);
    if (read < 4096) throw traeScanError('TRAE_DB_SHORT_READ', 'trae: database file is too small');
  } finally {
    fs.closeSync(fd);
  }
  return page1;
}

// Extracts and HMAC-verifies the SQLCipher key from the running Trae CN
// process. Throws a coded error instead of returning null so the caller can
// surface the exact failure (not running / not openable / key absent).
function extractTraeKeyFromProcess(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') throw traeScanError('TRAE_NOT_WINDOWS', 'trae: key extraction requires Windows');
  const dbPath = options.dbPath || traeDataPaths(options).dbPaths[0];
  if (!dbPath || !fs.existsSync(dbPath)) throw traeScanError('TRAE_DB_NOT_FOUND', 'trae: encrypted database not found');
  const dbPage1 = readDatabasePage1(dbPath);
  const saltHex = dbPage1.subarray(0, 16).toString('hex');

  const pid = findTraeAgentPid(options);
  if (!pid) {
    const image = options.imageName || TRAE_PROCESS_IMAGE;
    throw traeScanError('TRAE_PROCESS_NOT_RUNNING', `trae: ${image} with ai_agent.dll is not running`);
  }

  const koffi = options.koffi || require('koffi');
  const api = loadKernelApi(koffi);
  const handle = api.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid);
  if (!handle) throw traeScanError('TRAE_PROCESS_OPEN_FAILED', `trae: cannot open Trae CN process (pid ${pid}); try running Token Monitor with administrator rights`);

  try {
    const regions = enumerateReadableRegions(api, handle);
    const context = { saltHex, dbPage1, signal: options.signal };
    let scanned = 0;
    let nextProgress = options.progressEveryBytes || 256 * 1024 * 1024;
    for (const region of regions) {
      const found = scanRegion(api, handle, region, context);
      if (found) return { encKey: found.key, dbPath, salt: saltHex, pid, address: found.address };
      scanned += region.size;
      if (scanned >= nextProgress) {
        nextProgress += options.progressEveryBytes || 256 * 1024 * 1024;
        try { options.onProgress?.({ scannedBytes: scanned, regions: regions.length }); } catch (_) {}
      }
    }
  } finally {
    try { api.CloseHandle(handle); } catch (_) {}
  }
  throw traeScanError('TRAE_KEY_NOT_FOUND', 'trae: no verified SQLCipher key found in process memory');
}

module.exports = {
  TRAE_PROCESS_IMAGE,
  extractTraeKeyFromProcess,
  findTraeAgentPid,
  findTraeKeyInBuffer,
  parsePidsFromTasklist
};
