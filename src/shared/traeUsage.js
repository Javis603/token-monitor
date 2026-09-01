'use strict';

// Trae CN local collection pipeline. The Trae CN AI-agent database
// (%APPDATA%/Trae CN/ModularData/ai-agent/database.db) is SQLCipher 4 encrypted
// (AES-256-CBC, HMAC-SHA512, page_size 4096, reserve 80); the key exists only in
// the running Trae CN.exe process memory (extracted by ./traeKeyScanner). This
// module owns everything after that: page-level decryption, chat_turn parsing,
// period/history aggregation, and the post-collector summary merge. It depends
// only on Node built-ins and the shared usage/history cores, so it stays
// unit-testable without Electron, koffi, or a real Trae install.

const { createDecipheriv, createHmac, pbkdf2Sync } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractUsageFromTokscale, mergePeriods } = require('./usage');
const { hasSummaryPeriod } = require('./archivePeriods');
const { mergeHistories, normalizeHistory, parseGraphResult } = require('./history');

const TRAE_CLIENT = 'trae';
// Collection sources sharing one SQLCipher layout (verified against a live
// TraeWork desktop install: same encryption parameters, same chat_turn schema,
// same token_usage shape). Everything source-specific — data directory,
// process image, session-key prefix, settings-key spelling — hangs off this
// descriptor so the two collection lanes are the same code with two configs.
const TRAE_SOURCES = {
  trae: {
    id: 'trae',
    client: 'trae',
    processImage: 'Trae CN.exe',
    dataDir: 'Trae CN',
    sessionPrefix: 'trae:cn',
    envDbPath: 'TOKEN_MONITOR_TRAE_CN_DB_PATH',
    enabledSetting: 'traeCollectionEnabled',
    dbKeySetting: 'traeDbKey'
  },
  traework: {
    id: 'traework',
    client: 'traework',
    processImage: 'TRAE SOLO CN.exe',
    dataDir: 'TRAE SOLO CN',
    sessionPrefix: 'trae:work',
    envDbPath: 'TOKEN_MONITOR_TRAE_WORK_DB_PATH',
    // The camelCase W keeps these distinct from the trae keys; both spellings
    // are saved user state, so neither can be derived from the id.
    enabledSetting: 'traeWorkCollectionEnabled',
    dbKeySetting: 'traeWorkDbKey'
  }
};

// Accepts a descriptor object, a source id, or null (legacy default = Trae CN).
function traeSource(source) {
  if (source && typeof source === 'object') return source;
  return TRAE_SOURCES[source] || TRAE_SOURCES.trae;
}
const TRAE_PAGE_SZ = 4096;
const TRAE_KEY_SZ = 32;
const TRAE_SALT_SZ = 16;
const TRAE_IV_SZ = 16;
const TRAE_HMAC_SZ = 64;
const TRAE_RESERVE_SZ = 80;
const TRAE_SQLITE_HEADER = Buffer.from('SQLite format 3\x00', 'binary');
const TRAE_MAX_ROWS = 500_000;

// Aggregate-only read: chat_turn.context is a small JSON envelope carrying
// token_usage plus the model info. Nothing message-shaped leaves the pipeline —
// the decrypted database file itself is deleted right after the read.
// `id` is the AUTOINCREMENT primary key (a rowid alias); the rowid pseudo-column
// is not reliably named in node:sqlite's result, so the explicit id is selected.
const TRAE_TURNS_SQL = 'SELECT id, session_id, created_at, context FROM chat_turn WHERE context IS NOT NULL';
const TRAE_TURNS_SINCE_SQL = `${TRAE_TURNS_SQL} AND id > ?`;
const TRAE_MAX_ROWID_SQL = 'SELECT MAX(id) AS max_id FROM chat_turn';
// chat_turn rows are inserted with a zeroed token_usage during streaming and
// UPDATE-backfilled when the turn completes. A bare `id > cursor` read would
// permanently miss a backfill whose row already sits below the cursor, so the
// incremental read rewinds by this overlap and re-reads recent rows; the
// messageId-keyed merge refreshes them. 256 covers any plausible number of
// concurrent in-flight turns while keeping the read at ~1ms.
const TRAE_INCREMENTAL_OVERLAP = 256;
// Pages per IO batch. The per-page loop was ~3 syscalls per page over 100k
// pages; batching to one read + one write per chunk removes that overhead,
// which dominated the decrypt cost (measured 1.9s for a 391MB database).
const TRAE_CHUNK_PAGES = 2048;
// SQLite WAL layout: a 32-byte header, then frames of (24-byte header + one
// encrypted page). Trae's writes land in the WAL first and reach the main
// database file only when SQLite next checkpoints — on Trae's schedule, which
// observation put minutes between a completed turn and the data becoming
// readable in the main file. Applying the WAL's committed frames over the
// main file is exactly the checkpoint the readers would otherwise wait for.
const TRAE_WAL_HEADER_SZ = 32;
const TRAE_WAL_FRAME_HEADER_SZ = 24;
const TRAE_WAL_MAGIC_LE = 0x377f0682;
const TRAE_WAL_MAGIC_BE = 0x377f0683;

function traeErrorCode(code, message, cause) {
  const error = new Error(message || code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

// Decrypted images of every page the WAL holds beyond the main database
// file: pgno → plain page. Only frames of the current WAL generation (salt
// match) up to the last commit frame apply; a per-frame page-HMAC check
// authenticates the content, and any surprise (short file, wrong page size,
// torn tail) degrades to an empty overlay rather than a failed collect.
function buildTraeWalOverlay(walPath, encKey, salt) {
  const pages = new Map();
  const empty = { pages, maxDbPages: 0 };
  let wal;
  try {
    wal = fs.readFileSync(walPath);
  } catch (_) {
    return empty; // no WAL yet — the main file is the committed state
  }
  try {
    if (wal.length < TRAE_WAL_HEADER_SZ) return empty;
    const magic = wal.readUInt32BE(0);
    if (magic !== TRAE_WAL_MAGIC_LE && magic !== TRAE_WAL_MAGIC_BE) return empty;
    if (wal.readUInt32BE(8) !== TRAE_PAGE_SZ) return empty;
    const saltPair = wal.subarray(16, 24);
    const frameSz = TRAE_WAL_FRAME_HEADER_SZ + TRAE_PAGE_SZ;
    const macKey = traeMacKey(encKey, salt);
    const frames = [];
    for (let offset = TRAE_WAL_HEADER_SZ; offset + frameSz <= wal.length; offset += frameSz) {
      const header = wal.subarray(offset, offset + TRAE_WAL_FRAME_HEADER_SZ);
      if (!header.subarray(8, 16).equals(saltPair)) break;
      const pgno = header.readUInt32BE(0);
      const commitPages = header.readUInt32BE(4);
      const pageData = wal.subarray(offset + TRAE_WAL_FRAME_HEADER_SZ, offset + frameSz);
      const storedHmac = pageData.subarray(TRAE_PAGE_SZ - TRAE_HMAC_SZ, TRAE_PAGE_SZ);
      if (!traeWalPageHmac(macKey, pageData, pgno).equals(storedHmac)) break;
      frames.push({ pgno, commitPages, pageData });
    }
    // Frames past the last commit frame are an unfinished transaction — a
    // reader must never see them.
    let applied = 0;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      if (frames[i].commitPages > 0) {
        applied = i + 1;
        break;
      }
    }
    let maxDbPages = 0;
    for (let i = 0; i < applied; i += 1) {
      const { pgno, commitPages, pageData } = frames[i];
      const plain = Buffer.alloc(TRAE_PAGE_SZ);
      decryptTraePageInto(encKey, pageData, pgno, plain, 0);
      pages.set(pgno, plain);
      if (commitPages > maxDbPages) maxDbPages = commitPages;
    }
    return { pages, maxDbPages };
  } catch (_) {
    return empty;
  }
}

function traeDataPaths(options = {}) {
  const source = traeSource(options.source);
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const appData = platform === 'win32'
    ? ((typeof env.APPDATA === 'string' && env.APPDATA.length > 0) ? env.APPDATA : path.join(home, 'AppData', 'Roaming'))
    : null;
  const explicitDb = String(env[source.envDbPath] || '').trim();
  return {
    dbPaths: explicitDb
      ? [path.resolve(explicitDb)]
      : (appData ? [path.join(appData, source.dataDir, 'ModularData', 'ai-agent', 'database.db')] : [])
  };
}

// SQLCipher key derivation: the MAC key is PBKDF2-HMAC-SHA512(key, salt^0x3a,
// 2 iterations), and page 1 stores the HMAC over (salt-stripped page + IV) plus
// the little-endian page number.
function traeMacKey(encKey, salt) {
  const macSalt = Buffer.from(salt);
  for (let i = 0; i < macSalt.length; i += 1) macSalt[i] ^= 0x3a;
  return pbkdf2Sync(encKey, macSalt, 2, TRAE_KEY_SZ, 'sha512');
}

function traePageHmac(macKey, pageData, pgno) {
  const hmac = createHmac('sha512', macKey);
  hmac.update(pageData.subarray(TRAE_SALT_SZ, TRAE_PAGE_SZ - TRAE_RESERVE_SZ + TRAE_IV_SZ));
  const pageLe = Buffer.alloc(4);
  pageLe.writeUInt32LE(pgno, 0);
  hmac.update(pageLe);
  return hmac.digest();
}

// WAL frames use a wider HMAC than main-file pages: page 1 still starts with
// the salt (skipped), but every other page's full ciphertext enters the HMAC
// — the main file's 16-byte skip is a legacy artifact that Wal frames do not
// carry. Verified against a live Trae CN database.
function traeWalPageHmac(macKey, pageData, pgno) {
  const hmac = createHmac('sha512', macKey);
  hmac.update(pageData.subarray(pgno === 1 ? TRAE_SALT_SZ : 0, TRAE_PAGE_SZ - TRAE_RESERVE_SZ + TRAE_IV_SZ));
  const pageLe = Buffer.alloc(4);
  pageLe.writeUInt32LE(pgno, 0);
  hmac.update(pageLe);
  return hmac.digest();
}

// Returns true when encKey decrypts (verifies via HMAC) the given page-1 bytes
// of the encrypted database. Accepts hex string or Buffer for the key.
function verifyTraeKey(encKey, dbPage1) {
  try {
    const key = typeof encKey === 'string' ? Buffer.from(encKey, 'hex') : Buffer.from(encKey);
    if (key.length !== TRAE_KEY_SZ || !dbPage1 || dbPage1.length < TRAE_PAGE_SZ) return false;
    const macKey = traeMacKey(key, dbPage1.subarray(0, TRAE_SALT_SZ));
    const stored = dbPage1.subarray(TRAE_PAGE_SZ - TRAE_HMAC_SZ, TRAE_PAGE_SZ);
    return traePageHmac(macKey, dbPage1, 1).equals(stored);
  } catch (_) {
    return false;
  }
}

// Decrypts one page into target[offset..offset+PAGE_SZ). The reserve area is
// explicitly zeroed: the batch caller reuses an allocUnsafe buffer, so leaving
// the trailing 80 bytes unwritten would persist garbage where the old
// per-page Buffer.alloc gave zeros.
function decryptTraePageInto(encKey, pageData, pgno, target, offset) {
  const iv = pageData.subarray(TRAE_PAGE_SZ - TRAE_RESERVE_SZ, TRAE_PAGE_SZ - TRAE_RESERVE_SZ + TRAE_IV_SZ);
  const cipher = createDecipheriv('aes-256-cbc', encKey, iv);
  cipher.setAutoPadding(false);
  if (pgno === 1) {
    TRAE_SQLITE_HEADER.copy(target, offset);
    const body = cipher.update(pageData.subarray(TRAE_SALT_SZ, TRAE_PAGE_SZ - TRAE_RESERVE_SZ));
    body.copy(target, offset + TRAE_SALT_SZ, 0, body.length);
    const tail = cipher.final();
    tail.copy(target, offset + TRAE_SALT_SZ + body.length, 0, tail.length);
    target.fill(0, offset + TRAE_PAGE_SZ - TRAE_RESERVE_SZ, offset + TRAE_PAGE_SZ);
    return;
  }
  const body = cipher.update(pageData.subarray(0, TRAE_PAGE_SZ - TRAE_RESERVE_SZ));
  body.copy(target, offset, 0, body.length);
  const tail = cipher.final();
  tail.copy(target, offset + body.length, 0, tail.length);
  target.fill(0, offset + TRAE_PAGE_SZ - TRAE_RESERVE_SZ, offset + TRAE_PAGE_SZ);
}

// Page-level decryption into outputPath. Throws TRAE_KEY_INVALID when the HMAC
// of page 1 does not verify, TRAE_DB_SHORT_READ when the file ends mid-page.
// The caller owns removing the output file afterwards.
function decryptTraeDb({ dbPath, encKey, outputPath, signal, onProgress } = {}) {
  if (!dbPath) throw traeErrorCode('TRAE_DB_NOT_FOUND', 'trae: database path is not set');
  if (!outputPath) throw traeErrorCode('TRAE_DB_OUTPUT_MISSING', 'trae: decrypt output path is not set');
  const key = typeof encKey === 'string' ? Buffer.from(String(encKey || ''), 'hex') : Buffer.from(encKey || []);
  if (key.length !== TRAE_KEY_SZ) throw traeErrorCode('TRAE_KEY_INVALID', 'trae: encryption key is missing or malformed');

  const stat = fs.statSync(dbPath);
  const totalPages = Math.floor(stat.size / TRAE_PAGE_SZ);
  if (totalPages < 1) throw traeErrorCode('TRAE_DB_SHORT_READ', 'trae: database file is too small');

  const fd = fs.openSync(dbPath, 'r');
  const tmpPath = `${outputPath}.tmp`;
  let outFd = null;
  let appliedWalPages = 0;
  try {
    const page1 = Buffer.alloc(TRAE_PAGE_SZ);
    const read1 = fs.readSync(fd, page1, 0, TRAE_PAGE_SZ, 0);
    if (read1 < TRAE_PAGE_SZ) throw traeErrorCode('TRAE_DB_SHORT_READ', 'trae: database file is too small');
    if (!verifyTraeKey(key, page1)) {
      throw traeErrorCode('TRAE_KEY_INVALID', 'trae: key does not match this database (HMAC verification failed)');
    }
    outFd = fs.openSync(tmpPath, 'w');
    const chunkPages = Math.max(1, Math.min(TRAE_CHUNK_PAGES, totalPages));
    const encrypted = Buffer.allocUnsafe(chunkPages * TRAE_PAGE_SZ);
    const decrypted = Buffer.allocUnsafe(chunkPages * TRAE_PAGE_SZ);
    for (let startPage = 1; startPage <= totalPages; startPage += chunkPages) {
      const pagesThisChunk = Math.min(chunkPages, totalPages - startPage + 1);
      const readLen = pagesThisChunk * TRAE_PAGE_SZ;
      const read = fs.readSync(fd, encrypted, 0, readLen, (startPage - 1) * TRAE_PAGE_SZ);
      if (read < readLen) {
        throw traeErrorCode('TRAE_DB_SHORT_READ', `trae: database ended mid-page at page ${startPage + Math.floor(read / TRAE_PAGE_SZ)}`);
      }
      for (let i = 0; i < pagesThisChunk; i += 1) {
        const page = encrypted.subarray(i * TRAE_PAGE_SZ, (i + 1) * TRAE_PAGE_SZ);
        decryptTraePageInto(key, page, startPage + i, decrypted, i * TRAE_PAGE_SZ);
      }
      fs.writeSync(outFd, decrypted, 0, pagesThisChunk * TRAE_PAGE_SZ);
      if (onProgress) onProgress({ page: startPage + pagesThisChunk - 1, totalPages });
      if (signal?.aborted) throw traeErrorCode('TRAE_ABORTED', 'trae: decrypt aborted');
    }
    try {
      const overlay = buildTraeWalOverlay(`${dbPath}-wal`, key, page1.subarray(0, TRAE_SALT_SZ));
      for (const [pgno, plain] of overlay.pages) {
        fs.writeSync(outFd, plain, 0, TRAE_PAGE_SZ, (pgno - 1) * TRAE_PAGE_SZ);
        appliedWalPages += 1;
      }
    } catch (_) {
      // main-file-only was the pre-WAL behavior; never fail the decrypt
    }
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw error;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    if (outFd !== null) { try { fs.closeSync(outFd); } catch (_) {} }
  }
  fs.renameSync(tmpPath, outputPath);
  return { pages: totalPages, bytes: totalPages * TRAE_PAGE_SZ, walPages: appliedWalPages };
}

function timestampMsFromSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number >= 1e12 ? number : number * 1000;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function traeModelFromContext(context) {
  const persist = context?.persist_user_message_context ?? context?.persistUserMessageContext;
  const modelInfo = persist?.model_info ?? persist?.modelInfo;
  const raw = String(modelInfo?.config_name ?? modelInfo?.configName ?? '').trim();
  return raw || 'trae';
}

// Turns one chat_turn row into a usage row shaped like the qodercn/proma rows.
// Trae reports OpenAI-style usage where prompt_tokens already includes the
// cached/created cache tokens, so the net input is prompt minus both.
// The source descriptor keys the session/message ids — the same session_id in
// two databases must never collapse into one session.
function normalizeTraeTurnRow(row, source = TRAE_SOURCES.trae) {
  const src = traeSource(source);
  let context;
  try {
    context = JSON.parse(String(row?.context ?? ''));
  } catch (_) {
    return null;
  }
  if (!context || typeof context !== 'object') return null;
  const usage = context?.token_usage ?? context?.tokenUsage;
  if (!usage || typeof usage !== 'object') return null;
  const prompt = nonNegativeInt(usage.prompt_tokens ?? usage.promptTokens);
  const completion = nonNegativeInt(usage.completion_tokens ?? usage.completionTokens);
  if (prompt + completion === 0) return null;
  const cacheRead = Math.min(prompt, nonNegativeInt(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens));
  const cacheWrite = Math.min(prompt - cacheRead, nonNegativeInt(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens));
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  const createdAt = timestampMsFromSeconds(row?.created_at ?? row?.createdAt);
  const sessionId = String(row?.session_id ?? row?.sessionId ?? '').trim() || 'unknown';
  const rowId = String(row?.rowid ?? row?.rowId ?? '').trim();
  const projectLabel = String(row?.project_label ?? row?.projectLabel ?? '').trim();
  return {
    sessionId: `${src.sessionPrefix}:${sessionId}`,
    messageId: `${src.sessionPrefix}:${sessionId}:${rowId || `${createdAt}`}`,
    model: traeModelFromContext(context),
    projectLabel,
    input,
    output: completion,
    cacheRead,
    cacheWrite,
    createdAt,
    messages: 1
  };
}

function traeProjectLabelsFromDb(database) {
  const tables = new Set(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name))
  );
  const sessionProject = new Map();
  const projectNames = new Map();
  if (tables.has('session_project')) {
    try {
      for (const row of database.prepare('SELECT session_id, project_id FROM session_project').all()) {
        if (row?.session_id != null && row?.project_id != null) {
          sessionProject.set(String(row.session_id), String(row.project_id));
        }
      }
    } catch (_) { /* older schema variant: sessions stay unattributed */ }
  }
  if (tables.has('project')) {
    try {
      for (const row of database.prepare('SELECT project_id, absolute_path FROM project').all()) {
        const projectId = row?.project_id != null ? String(row.project_id) : '';
        if (!projectId) continue;
        const raw = String(row?.absolute_path ?? '').trim();
        const base = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop();
        projectNames.set(projectId, base || projectId.slice(0, 12));
      }
    } catch (_) { /* keep raw project ids */ }
  }
  return { sessionProject, projectNames };
}

// Reads chat_turn usage rows from an already-decrypted database file. With
// sinceId it reads only rows with id > sinceId - overlap (the rewind covers
// streaming rows whose token_usage is UPDATE-backfilled after they were first
// inserted); maxId always reflects the whole table so a trailing row without
// usage cannot strand the cursor.
function readTraeRows(decryptedDbPath, options = {}) {
  const source = traeSource(options.source);
  const sinceId = Number.isFinite(options.sinceId) && options.sinceId > 0
    ? Math.max(0, Math.trunc(options.sinceId) - TRAE_INCREMENTAL_OVERLAP)
    : null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_) {
    DatabaseSync = null;
  }
  if (typeof DatabaseSync !== 'function') {
    throw traeErrorCode('TRAE_SQLITE_UNAVAILABLE', 'trae: node:sqlite is unavailable in this runtime');
  }
  const database = new DatabaseSync(decryptedDbPath, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 250');
    const { sessionProject, projectNames } = traeProjectLabelsFromDb(database);
    const maxIdRow = database.prepare(TRAE_MAX_ROWID_SQL).get();
    const maxId = Number.isFinite(Number(maxIdRow?.max_id)) ? Number(maxIdRow.max_id) : 0;
    const statement = sinceId !== null
      ? database.prepare(TRAE_TURNS_SINCE_SQL)
      : database.prepare(TRAE_TURNS_SQL);
    const rows = [];
    const iterator = sinceId !== null ? statement.iterate(sinceId) : statement.iterate();
    for (const row of iterator) {
      if (rows.length >= TRAE_MAX_ROWS) {
        throw traeErrorCode('TRAE_READ_BUDGET_EXCEEDED', `trae: chat_turn read budget exceeded (${TRAE_MAX_ROWS} rows)`);
      }
      const projectId = sessionProject.get(String(row?.session_id ?? ''));
      const normalized = normalizeTraeTurnRow({
        rowid: row?.id,
        session_id: row?.session_id,
        created_at: row?.created_at,
        context: row?.context,
        project_label: projectId ? (projectNames.get(projectId) || '') : ''
      }, source);
      if (normalized) rows.push(normalized);
    }
    return { rows, maxId };
  } finally {
    database.close();
  }
}

// Full snapshot: read the usage rows, decrypting as little as possible.
// sinceId enables an incremental read (rows near/after that id); the returned
// maxId is the whole-table high-water mark for the next cursor.
//
// Two readers behind one contract:
//  - targeted (default): decrypts only the B-tree pages the read needs, in
//    memory, via ./traeTargetedRead — no plaintext file ever touches disk.
//  - full (fallback): decrypt the whole database to workDir, SQL over the
//    plaintext copy, delete it. Runs when targeted is disabled via
//    TOKEN_MONITOR_TRAE_TARGETED_READ, or whenever the targeted walk hits
//    anything it cannot parse — a future schema, a page type it does not
//    know, corruption — so behavior degrades to the previous pipeline and
//    never to wrong numbers. Stub injectables (decryptDb/readRows) also pin
//    the full path, keeping existing call sites and tests deterministic.
// The result records which reader won (`targeted: true/false`) plus, on a
// fallback, `targetedFallback` with the reason for the log line.
function collectTraeSnapshot({
  dbPath, encKey, workDir, signal, onProgress, sinceId, source,
  decryptDb, readRows, targetedRead, env = process.env
} = {}) {
  if (!workDir) throw traeErrorCode('TRAE_WORKDIR_MISSING', 'trae: work directory is not set');
  fs.mkdirSync(workDir, { recursive: true });
  const outputPath = path.join(workDir, 'trae-database-decrypted.db');
  const legacyMode = Boolean(decryptDb || readRows);
  const targetedDisabled = ['0', 'false', 'no', 'off']
    .includes(String(env.TOKEN_MONITOR_TRAE_TARGETED_READ ?? '').trim().toLowerCase());
  let targetedFallback = null;

  if (!legacyMode && !targetedDisabled) {
    try {
      const readTargeted = targetedRead || require('./traeTargetedRead').readTraeTargetedRows;
      const targeted = readTargeted({ dbPath, encKey, sinceId, signal, source });
      return {
        rows: targeted.rows,
        maxId: targeted.maxId,
        pages: targeted.pagesVisited,
        bytes: targeted.bytesRead,
        walPages: targeted.walPages || 0,
        targeted: true
      };
    } catch (error) {
      // An explicit abort must abort, not degrade into a full decrypt.
      if (signal?.aborted) throw error;
      targetedFallback = {
        code: error?.code || 'TRAE_TARGETED_FAILED',
        message: error?.message
      };
    }
  }

  const decrypt = decryptDb || decryptTraeDb;
  const read = readRows || readTraeRows;
  let meta;
  try {
    meta = decrypt({ dbPath, encKey, outputPath, signal, onProgress });
    const result = read(outputPath, { sinceId, source });
    const rows = Array.isArray(result) ? result : result.rows;
    const maxId = Array.isArray(result) ? null : result.maxId;
    return {
      rows,
      maxId,
      pages: meta.pages,
      bytes: meta.bytes,
      walPages: meta.walPages || 0,
      targeted: false,
      ...(targetedFallback ? { targetedFallback } : {})
    };
  } finally {
    for (const target of [outputPath, `${outputPath}.tmp`]) {
      try { fs.unlinkSync(target); } catch (_) {}
    }
  }
}

// The qodercn/proma tokscale-JSON projection, minus pricing: Trae model names
// have no tokscale catalog entry and the CN plans bill credits, not USD.
function buildTraeTokscaleJson(startMs, rows, includeUndated = false, client = TRAE_CLIENT) {
  const grouped = new Map();
  for (const row of rows) {
    if (startMs && (row.createdAt ? row.createdAt < startMs : !includeUndated)) continue;
    const key = `${row.sessionId}\0${row.model}`;
    if (!grouped.has(key)) {
      grouped.set(key, { ...row, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, startedAt: 0, lastUsedAt: 0 });
    }
    const group = grouped.get(key);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += row.messages;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }
  const entries = [...grouped.values()].map((row) => ({
    client, mergedClients: null, sessionId: row.sessionId, model: row.model, provider: client,
    input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
    reasoning: 0, messageCount: row.messages, cost: 0,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '',
    projectLabel: row.projectLabel || '', performance: null
  }));
  const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
  return {
    groupBy: 'client,session,model', entries,
    totalInput: sum('input'), totalOutput: sum('output'), totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'), totalMessages: sum('messageCount'), totalCost: 0, processingTimeMs: 0
  };
}

function buildTraePeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const client = options.client || TRAE_CLIENT;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return {
    today: buildTraeTokscaleJson(todayStart, rows, false, client),
    month: buildTraeTokscaleJson(monthStart, rows, false, client),
    allTime: buildTraeTokscaleJson(options.allTimeSince ? new Date(options.allTimeSince).getTime() : 0, rows, true, client)
  };
}

// Normalized periods (usage.js shape) ready for the summary merge.
function buildTraePeriodsNormalized(options = {}) {
  const periods = buildTraePeriods(options);
  return {
    today: extractUsageFromTokscale(periods.today),
    month: extractUsageFromTokscale(periods.month),
    allTime: extractUsageFromTokscale(periods.allTime)
  };
}

function buildTraeHistoryGraph(options = {}) {
  const days = new Map();
  const client = options.client || TRAE_CLIENT;
  for (const row of options.rows || []) {
    if (!row.createdAt) continue;
    const date = new Date(row.createdAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (!days.has(key)) days.set(key, { date: key, clients: [] });
    const day = days.get(key);
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = { client, modelId: row.model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, messages: 0 };
      day.clients.push(model);
    }
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.messages += row.messages;
  }
  return { contributions: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localDayKeyOf(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localMonthKeyOf(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

// Post-collector merge: adds the collected Trae CN usage to a collector summary
// the same way the qodercn adapter merges inside the collector. mergePeriods
// (addPeriodInto) carries every component field — client/model cache reads,
// writes and outputs — whereas the archived-client path (clientUsageFromPeriod)
// drops them and rebuilds only single-model sessions from session data, which
// would flush Trae's multi-model sessions into "unclassified" and zero out the
// cache-hit split. Each collector tick produces a fresh summary, so merging the
// same snapshot into every tick is additive, not cumulative. Stale today/month
// buckets (snapshot captured before a local midnight that has not been
// re-collected yet) are skipped, mirroring the archived-usage gating.
function applyTraeCollectionUsage(summary, snapshot, options = {}) {
  const periods = snapshot?.periods;
  if (!summary || !periods) return summary;
  const now = options.now ? new Date(options.now) : new Date();
  const client = options.client || TRAE_CLIENT;
  const snapshotDay = snapshot.day || localDayKeyOf(snapshot.capturedAt);
  const snapshotMonth = snapshot.month || localMonthKeyOf(snapshot.capturedAt);
  const next = summary;
  for (const periodName of ['today', 'month', 'allTime']) {
    const period = periods[periodName];
    if (!period) continue;
    if (periodName === 'today' && snapshotDay !== localDayKeyOf(now)) continue;
    if (periodName === 'month' && snapshotMonth !== localMonthKeyOf(now)) continue;
    if (!hasSummaryPeriod(next, periodName)) continue;
    const hasUsage = Math.max(0, Number(period.totalTokens) || 0) > 0
      || Math.max(0, Number(period.clients?.[client]) || 0) > 0
      || Object.keys(period.sessions || {}).length > 0;
    if (!hasUsage) continue;
    const container = next.periods && typeof next.periods === 'object' ? next.periods : next;
    container[periodName] = mergePeriods(container[periodName], period);
  }
  return next;
}

// Merges the collected Trae daily graph into the summary history.
function applyTraeCollectionHistory(summary, graph, options = {}) {
  if (!summary || !graph || !Array.isArray(graph.contributions) || graph.contributions.length === 0) return summary;
  const traeHistory = normalizeHistory(parseGraphResult(graph), {
    capDays: options.capDays,
    todayKey: options.todayKey
  });
  summary.history = summary.history
    ? mergeHistories([summary.history, traeHistory], { todayKey: options.todayKey, capDays: options.capDays })
    : traeHistory;
  return summary;
}

// Deduped merge keyed by messageId (which carries the rowid), the same
// append-only assumption the qodercn adapter uses. Incoming rows win on
// collision so a re-read of a still-present row refreshes its values.
function mergeTraeRows(existing, incoming) {
  const unique = new Map();
  for (const row of existing || []) unique.set(row.messageId, row);
  for (const row of incoming || []) unique.set(row.messageId, row);
  return [...unique.values()];
}

// Content signature across the encrypted database and its WAL. WAL-mode writes
// land in `-wal` first, so the main file's own stat can stay unchanged for a
// long active session; ignoring the WAL would let P1 skip real updates.
function traeSourceSignature(dbPath, fsApi = fs) {
  if (!dbPath) return '';
  const parts = [];
  for (const target of [dbPath, `${dbPath}-wal`]) {
    try {
      const stat = fsApi.statSync(target);
      parts.push(`${Math.trunc(stat.size)}:${Math.trunc(stat.mtimeMs)}`);
    } catch (_) {
      parts.push('-');
    }
  }
  return parts.join('|');
}

module.exports = {
  TRAE_CLIENT,
  TRAE_INCREMENTAL_OVERLAP,
  TRAE_MAX_ROWS,
  TRAE_PAGE_SZ,
  TRAE_RESERVE_SZ,
  TRAE_SALT_SZ,
  TRAE_SOURCES,
  applyTraeCollectionHistory,
  applyTraeCollectionUsage,
  buildTraeHistoryGraph,
  buildTraePeriods,
  buildTraePeriodsNormalized,
  buildTraeWalOverlay,
  collectTraeSnapshot,
  decryptTraeDb,
  decryptTraePageInto,
  localDayKeyOf,
  localMonthKeyOf,
  mergeTraeRows,
  normalizeTraeTurnRow,
  readTraeRows,
  traeDataPaths,
  traeErrorCode,
  traeSource,
  traeSourceSignature,
  verifyTraeKey
};
