'use strict';

// Selective in-memory reader for the SQLCipher-encrypted Trae CN database.
// Instead of decrypting the whole file to a temp plaintext copy (391MB of IO
// per collect), decrypts only the B-tree pages of the tables the pipeline
// actually reads — sqlite_master, chat_turn, session_project, project — and
// parses SQLite's page/record format directly. Every SQLCipher page carries
// its own random IV in the reserve area, so any page decrypts independently
// and the visited-page row set is identical to decrypt-then-SQL.
//
// The contract with collectTraeSnapshot is fail-safe: any structural surprise
// (unexpected page type, cycle, truncated overflow, unsupported schema) throws
// a TRAE_* code and the caller falls back to the full-decrypt path, so a
// malformed or future-schema database degrades to today's behavior, never to
// wrong numbers. Mirrors readTraeRows semantics exactly: lower-bound pruning
// for sinceId, whole-table MAX(id), the 256-row backfill rewind, the
// `context IS NOT NULL` filter, and tolerant project attribution.

const fs = require('node:fs');
const {
  TRAE_INCREMENTAL_OVERLAP,
  TRAE_MAX_ROWS,
  TRAE_PAGE_SZ,
  TRAE_RESERVE_SZ,
  TRAE_SALT_SZ,
  buildTraeWalOverlay,
  decryptTraePageInto,
  normalizeTraeTurnRow,
  traeErrorCode,
  verifyTraeKey
} = require('./traeUsage');

// SQLite b-tree page types (file format docs, b-tree header byte 0).
const PAGE_INTERIOR_TABLE = 5;
const PAGE_LEAF_TABLE = 13;
// sqlite_master column positions: type, name, tbl_name, rootpage, sql.
const MASTER_TYPE = 0;
const MASTER_NAME = 1;
const MASTER_ROOTPAGE = 3;
const MASTER_SQL = 4;
// SQLite payload-spill constants for table leaves, derived from the usable
// page size (page minus the SQLCipher reserve): X = U-35, M = ((U-12)*32/255)-23.
const USABLE_SZ = TRAE_PAGE_SZ - TRAE_RESERVE_SZ;
const MAX_LOCAL_PAYLOAD = USABLE_SZ - 35;
const MIN_LOCAL_PAYLOAD = Math.floor(((USABLE_SZ - 12) * 32) / 255) - 23;
// A text encoding other than UTF-8 would mis-decode TEXT values; bail to the
// full-decrypt fallback instead of mis-parsing (header offset 56, schema
// format 4 has carried UTF-8 as encoding 1 since forever).
const TEXT_ENCODING_UTF8 = 1;

// Tables whose pages the targeted reader walks. chat_turn is the payload;
// the other two feed project attribution; sqlite_master is discovered via
// page 1. Anything else in the database is never touched.
const TABLE_CHAT_TURN = 'chat_turn';
const TABLE_SESSION_PROJECT = 'session_project';
const TABLE_PROJECT = 'project';

function corrupt(code, message) {
  return traeErrorCode(code, `trae targeted: ${message}`);
}

// SQLite varint: 1-9 bytes, big-endian 7-bit groups, the 9th byte contributing
// a full 8 bits. Values beyond Number.MAX_SAFE_INTEGER cannot occur in
// realistic rowids or payload sizes; rejecting them falls back cleanly.
function readVarint(buf, offset) {
  let value = 0;
  for (let i = 0; i < 8; i += 1) {
    const byte = buf[offset + i];
    if (byte === undefined) throw corrupt('TRAE_RECORD_INVALID', 'varint runs past end of page');
    value = value * 128 + (byte & 0x7f);
    if (byte < 0x80) return { value, next: offset + i + 1 };
  }
  const ninth = buf[offset + 8];
  if (ninth === undefined) throw corrupt('TRAE_RECORD_INVALID', 'varint runs past end of page');
  value = value * 256 + ninth;
  if (!Number.isSafeInteger(value)) throw corrupt('TRAE_VARINT_OVERFLOW', 'varint exceeds safe integer range');
  return { value, next: offset + 9 };
}

// Decodes one record body value by serial type (file format docs, record
// format). Returns [value, nextOffset].
function readSerialValue(buf, offset, serialType) {
  if (serialType === 0) return [null, offset];
  if (serialType >= 1 && serialType <= 6) {
    const sizes = [null, 1, 2, 3, 4, 6, 8];
    const size = sizes[serialType];
    if (offset + size > buf.length) throw corrupt('TRAE_RECORD_INVALID', 'integer value runs past payload');
    if (size === 8) {
      const big = buf.readBigInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw corrupt('TRAE_VARINT_OVERFLOW', '64-bit integer exceeds safe integer range');
      }
      return [Number(big), offset + size];
    }
    return [buf.readIntBE(offset, size), offset + size];
  }
  if (serialType === 7) {
    if (offset + 8 > buf.length) throw corrupt('TRAE_RECORD_INVALID', 'float value runs past payload');
    return [buf.readDoubleBE(offset), offset + 8];
  }
  if (serialType === 8) return [0, offset];
  if (serialType === 9) return [1, offset];
  if (serialType === 10 || serialType === 11) throw corrupt('TRAE_RECORD_INVALID', `reserved serial type ${serialType}`);
  const size = (serialType - 12) >> 1;
  if (offset + size > buf.length) throw corrupt('TRAE_RECORD_INVALID', 'blob/text value runs past payload');
  const raw = buf.subarray(offset, offset + size);
  // Even = BLOB (kept as Buffer), odd = TEXT (decoded UTF-8).
  return [(serialType & 1) === 1 ? raw.toString('utf8') : Buffer.from(raw), offset + size];
}

// Parses a full record payload: header of serial types, then the values.
function parseRecord(payload) {
  const headerSize = readVarint(payload, 0);
  if (headerSize.value < 1 || headerSize.value > payload.length) {
    throw corrupt('TRAE_RECORD_INVALID', 'record header size out of range');
  }
  const serialTypes = [];
  let cursor = headerSize.next;
  while (cursor < headerSize.value) {
    const type = readVarint(payload, cursor);
    serialTypes.push(type.value);
    cursor = type.next;
  }
  if (cursor !== headerSize.value) throw corrupt('TRAE_RECORD_INVALID', 'record header misaligned');
  const values = [];
  let body = headerSize.value;
  for (const serialType of serialTypes) {
    const [value, next] = readSerialValue(payload, body, serialType);
    values.push(value);
    body = next;
  }
  return values;
}

// Splits a CREATE TABLE body on top-level commas, respecting parens and the
// four SQLite quote styles (doubled-quote escapes included).
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      const isEscape = ch === quote && body[i + 1] === quote;
      if (isEscape) { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '[') { quote = ']'; continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')') { depth -= 1; continue; }
    if (ch === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts;
}

const IDENTIFIER_RE = /^\s*(?:"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]|'((?:[^']|'')*)'|([A-Za-z_][A-Za-z0-9_$]*))/;
const CONSTRAINT_KEYWORDS = new Set(['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT']);

// Doubled-quote unescaping applies to the three quote styles; brackets have
// no escape form.
function unquoteIdentifier(match) {
  const quote = match[0].trim()[0];
  if (quote === '[') return match[3];
  const raw = match[1] ?? match[2] ?? match[4] ?? '';
  return raw.split(`${quote}${quote}`).join(quote);
}

// Maps a CREATE TABLE statement to ordered column names plus the rowid-alias
// index (INTEGER PRIMARY KEY). Best effort by design: anything it cannot parse
// throws TRAE_SCHEMA_UNSUPPORTED and the caller falls back to full decrypt.
function parseCreateTableColumns(sql) {
  if (/\bWITHOUT\s+ROWID\s*;?\s*$/i.test(sql.trim())) {
    throw traeErrorCode('TRAE_SCHEMA_UNSUPPORTED', 'trae targeted: WITHOUT ROWID tables are not supported');
  }
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close <= open) throw traeErrorCode('TRAE_SCHEMA_UNSUPPORTED', 'trae targeted: unrecognizable CREATE TABLE');
  const columns = [];
  let rowidAliasIndex = null;
  for (const def of splitTopLevel(sql.slice(open + 1, close))) {
    const trimmed = def.trim();
    if (!trimmed) continue;
    const match = trimmed.match(IDENTIFIER_RE);
    if (!match) continue;
    const rest = trimmed.slice(match[0].length);
    if (match[5] !== undefined && CONSTRAINT_KEYWORDS.has(match[5].toUpperCase())) continue;
    // `INTEGER PRIMARY KEY` (type exactly INTEGER, other constraints allowed)
    // makes the column a rowid alias. A missed detection self-corrects later:
    // alias columns are stored as NULL, and the reader falls back to the
    // cell's rowid for a NULL id.
    if (/^\s*INTEGER\b/i.test(rest) && /\bPRIMARY\s+KEY\b/i.test(rest)) rowidAliasIndex = columns.length;
    columns.push(match[5] !== undefined ? match[5] : unquoteIdentifier(match));
  }
  if (columns.length === 0) throw traeErrorCode('TRAE_SCHEMA_UNSUPPORTED', 'trae targeted: no columns parsed');
  return { columns, rowidAliasIndex };
}

class PageSource {
  constructor(dbPath, key, signal) {
    this.key = key;
    this.signal = signal;
    this.visited = new Set();
    this.walPages = new Map();
    this.walHits = 0;
    const stat = fs.statSync(dbPath);
    this.totalPages = Math.floor(stat.size / TRAE_PAGE_SZ);
    if (this.totalPages < 1) throw traeErrorCode('TRAE_DB_SHORT_READ', 'trae targeted: database file is too small');
    this.fd = fs.openSync(dbPath, 'r');
    try {
      const page1 = this.readPage(1);
      if (!verifyTraeKey(key, page1.raw)) {
        throw traeErrorCode('TRAE_KEY_INVALID', 'trae targeted: key does not match this database (HMAC verification failed)');
      }
      const plain = page1.plain;
      if (plain.readUInt16BE(16) !== TRAE_PAGE_SZ) {
        throw traeErrorCode('TRAE_SCHEMA_UNSUPPORTED', 'trae targeted: page size differs from the expected 4096');
      }
      if (plain.readUInt32BE(56) !== TEXT_ENCODING_UTF8) {
        throw traeErrorCode('TRAE_SCHEMA_UNSUPPORTED', 'trae targeted: database text encoding is not UTF-8');
      }
      // Overlay the WAL's committed pages so the walk sees Trae's latest
      // writes, not whatever SQLite had last checkpointed into the main file.
      // Best effort by construction (the builder degrades to an empty map);
      // the main-file read below stays the floor.
      const overlay = buildTraeWalOverlay(`${dbPath}-wal`, key, page1.raw.subarray(0, TRAE_SALT_SZ));
      if (overlay.pages.size > 0) {
        this.walPages = overlay.pages;
        if (overlay.maxDbPages > this.totalPages) this.totalPages = overlay.maxDbPages;
      }
    } catch (error) {
      // Never leak the descriptor: on Windows an open handle blocks the
      // caller's temp-dir cleanup with EPERM.
      this.close();
      throw error;
    }
  }

  close() {
    try { fs.closeSync(this.fd); } catch (_) { /* best effort */ }
  }

  visit(pgno) {
    if (this.visited.has(pgno)) throw corrupt('TRAE_BTREE_CORRUPT', `page ${pgno} visited twice (cycle or bad pointer)`);
    if (this.visited.size >= this.totalPages) {
      throw corrupt('TRAE_BTREE_CORRUPT', 'visited page count exceeds database size');
    }
    this.visited.add(pgno);
  }

  // Returns { raw, plain } for one page. `plain` is the standard SQLite page
  // image (content in [0, usable), zeroed reserve), decryptable standalone.
  // A page carried by a committed WAL frame is served from the overlay —
  // `raw` is null there since no file bytes were read.
  readPage(pgno) {
    if (!Number.isInteger(pgno) || pgno < 1 || pgno > this.totalPages) {
      throw corrupt('TRAE_BTREE_CORRUPT', `page ${pgno} out of range`);
    }
    if (this.signal?.aborted) throw traeErrorCode('TRAE_ABORTED', 'trae targeted: aborted');
    const walPlain = this.walPages.get(pgno);
    if (walPlain) {
      this.walHits += 1;
      return { raw: null, plain: walPlain };
    }
    const raw = Buffer.alloc(TRAE_PAGE_SZ);
    const read = fs.readSync(this.fd, raw, 0, TRAE_PAGE_SZ, (pgno - 1) * TRAE_PAGE_SZ);
    if (read < TRAE_PAGE_SZ) {
      throw traeErrorCode('TRAE_DB_SHORT_READ', `trae targeted: database ended mid-page at page ${pgno}`);
    }
    const plain = Buffer.allocUnsafe(TRAE_PAGE_SZ);
    decryptTraePageInto(this.key, raw, pgno, plain, 0);
    return { raw, plain };
  }

  get bytesRead() {
    return this.visited.size * TRAE_PAGE_SZ;
  }
}

function parsePageHeader(plain, pgno) {
  const headerOffset = pgno === 1 ? 100 : 0;
  const type = plain[headerOffset];
  if (type !== PAGE_INTERIOR_TABLE && type !== PAGE_LEAF_TABLE) {
    throw corrupt('TRAE_BTREE_CORRUPT', `page ${pgno}: unexpected b-tree page type ${type}`);
  }
  const cellCount = plain.readUInt16BE(headerOffset + 3);
  const pointerArray = headerOffset + (type === PAGE_INTERIOR_TABLE ? 12 : 8);
  const cells = [];
  for (let i = 0; i < cellCount; i += 1) {
    const offset = plain.readUInt16BE(pointerArray + 2 * i);
    if (offset < 1 || offset >= USABLE_SZ) {
      throw corrupt('TRAE_BTREE_CORRUPT', `page ${pgno}: cell pointer ${offset} out of usable range`);
    }
    cells.push(offset);
  }
  return {
    leaf: type === PAGE_LEAF_TABLE,
    cells,
    rightmost: type === PAGE_INTERIOR_TABLE ? plain.readUInt32BE(headerOffset + 8) : 0
  };
}

function localPayloadSize(payloadLength) {
  if (payloadLength <= MAX_LOCAL_PAYLOAD) return payloadLength;
  const k = MIN_LOCAL_PAYLOAD + ((payloadLength - MIN_LOCAL_PAYLOAD) % (USABLE_SZ - 4));
  return k <= MAX_LOCAL_PAYLOAD ? k : MIN_LOCAL_PAYLOAD;
}

// Reads one table-leaf cell: payload length varint, rowid varint, local
// payload, and — when the payload spills — the overflow chain via readPage.
function readLeafCell(source, plain, pgno, offset) {
  const payloadLength = readVarint(plain, offset);
  const rowid = readVarint(plain, payloadLength.next);
  const local = localPayloadSize(payloadLength.value);
  const cellBody = rowid.next;
  if (cellBody + local > USABLE_SZ) {
    throw corrupt('TRAE_BTREE_CORRUPT', `page ${pgno}: cell payload runs past usable area`);
  }
  if (local === payloadLength.value) {
    return { rowid: rowid.value, payload: Buffer.from(plain.subarray(cellBody, cellBody + local)) };
  }
  if (cellBody + local + 4 > USABLE_SZ) {
    throw corrupt('TRAE_BTREE_CORRUPT', `page ${pgno}: overflow pointer runs past usable area`);
  }
  let next = plain.readUInt32BE(cellBody + local);
  const chunks = [Buffer.from(plain.subarray(cellBody, cellBody + local))];
  let remaining = payloadLength.value - local;
  const maxChainPages = Math.ceil(payloadLength.value / (USABLE_SZ - 4)) + 2;
  let chainPages = 0;
  while (remaining > 0) {
    if (!next) throw corrupt('TRAE_OVERFLOW_TRUNCATED', `page ${pgno}: overflow chain ends early`);
    if (chainPages >= maxChainPages) throw corrupt('TRAE_OVERFLOW_CYCLE', `page ${pgno}: overflow chain too long`);
    chainPages += 1;
    source.visit(next);
    const overflowPage = source.readPage(next).plain;
    const take = Math.min(remaining, USABLE_SZ - 4);
    chunks.push(Buffer.from(overflowPage.subarray(4, 4 + take)));
    remaining -= take;
    next = overflowPage.readUInt32BE(0);
  }
  return { rowid: rowid.value, payload: Buffer.concat(chunks) };
}

// Yields { rowid, payload } for a table b-tree in ascending rowid order.
// lowerBound prunes whole subtrees whose rows are all ≤ it (interior keys are
// each child's max rowid), which is what makes the incremental read touch only
// the right edge of a large chat_turn tree.
function* walkTable(source, rootPage, lowerBound) {
  source.visit(rootPage);
  const { plain } = source.readPage(rootPage);
  const header = parsePageHeader(plain, rootPage);
  if (header.leaf) {
    for (const cellOffset of header.cells) {
      const cell = readLeafCell(source, plain, rootPage, cellOffset);
      if (lowerBound !== null && cell.rowid <= lowerBound) continue;
      yield cell;
    }
    return;
  }
  for (const cellOffset of header.cells) {
    const childPage = plain.readUInt32BE(cellOffset);
    const key = readVarint(plain, cellOffset + 4).value;
    if (lowerBound === null || key > lowerBound) {
      yield* walkTable(source, childPage, lowerBound);
    }
  }
  yield* walkTable(source, header.rightmost, lowerBound);
}

// Whole-table MAX(rowid) via a rightmost descent only — O(tree depth) pages.
function maxRowid(source, rootPage) {
  let pgno = rootPage;
  for (let depth = 0; depth <= source.totalPages; depth += 1) {
    const { plain } = source.readPage(pgno);
    const header = parsePageHeader(plain, pgno);
    if (header.leaf) {
      if (header.cells.length === 0) return 0;
      const last = header.cells[header.cells.length - 1];
      return readVarint(plain, readVarint(plain, last).next).value;
    }
    pgno = header.rightmost;
  }
  throw corrupt('TRAE_BTREE_CORRUPT', 'rightmost descent exceeded page count');
}

// Walks sqlite_master (table b-tree rooted at page 1) and returns
// { name: { rootPage, sql } } for the requested tables. The page-1 b-tree
// header sits after the 100-byte database header.
function readSchemaTables(source, wantedNames) {
  const wanted = new Set(wantedNames);
  const found = new Map();
  for (const cell of walkTable(source, 1, null)) {
    const values = parseRecord(cell.payload);
    const tableName = values[MASTER_NAME];
    if (values[MASTER_TYPE] !== 'table' || typeof tableName !== 'string' || !wanted.has(tableName)) continue;
    const rootPage = values[MASTER_ROOTPAGE];
    if (!Number.isInteger(rootPage) || rootPage < 2 || rootPage > source.totalPages) {
      throw corrupt('TRAE_BTREE_CORRUPT', `sqlite_master: bad root page ${rootPage} for ${tableName}`);
    }
    found.set(tableName, { rootPage, sql: typeof values[MASTER_SQL] === 'string' ? values[MASTER_SQL] : '' });
  }
  return found;
}

function requireColumn(columns, name, table) {
  const index = columns.indexOf(name);
  if (index < 0) {
    throw traeErrorCode('TRAE_SCHEMA_UNSUPPORTED', `trae targeted: ${table} has no ${name} column`);
  }
  return index;
}

// Reads one small table fully into rows of raw column values. Used for the
// two attribution tables; a missing or unparseable table yields no rows,
// mirroring the SQL path's tolerant attribution for older schemas.
function readTableRows(source, schemas, table) {
  const schema = schemas.get(table);
  if (!schema) return [];
  let parsed;
  try {
    parsed = parseCreateTableColumns(schema.sql || '');
  } catch (_) {
    return [];
  }
  const { columns, rowidAliasIndex } = parsed;
  const rows = [];
  for (const cell of walkTable(source, schema.rootPage, null)) {
    const values = parseRecord(cell.payload);
    if (values.length > columns.length) {
      throw corrupt('TRAE_RECORD_INVALID', `${table}: record has more values than columns`);
    }
    const row = {};
    for (let i = 0; i < columns.length; i += 1) {
      row[columns[i]] = i === rowidAliasIndex ? cell.rowid : (i < values.length ? values[i] : null);
    }
    rows.push(row);
  }
  return rows;
}

// Mirrors traeProjectLabelsFromDb's tolerant attribution: missing tables keep
// sessions unattributed, unusable rows are skipped per-table.
function buildProjectAttribution(source, schemas) {
  const sessionProject = new Map();
  const projectNames = new Map();
  for (const row of readTableRows(source, schemas, TABLE_SESSION_PROJECT)) {
    if (row.session_id != null && row.project_id != null) {
      sessionProject.set(String(row.session_id), String(row.project_id));
    }
  }
  for (const row of readTableRows(source, schemas, TABLE_PROJECT)) {
    const projectId = row.project_id != null ? String(row.project_id) : '';
    if (!projectId) continue;
    const raw = String(row.absolute_path ?? '').trim();
    const base = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop();
    projectNames.set(projectId, base || projectId.slice(0, 12));
  }
  return { sessionProject, projectNames };
}

// Selective equivalent of decryptTraeDb + readTraeRows. Returns the same
// { rows, maxId } shape plus visited-page stats for logging.
function readTraeTargetedRows({ dbPath, encKey, sinceId, signal, source: traeSource, maxRows = TRAE_MAX_ROWS } = {}) {
  if (!dbPath) throw traeErrorCode('TRAE_DB_NOT_FOUND', 'trae targeted: database path is not set');
  const key = typeof encKey === 'string' ? Buffer.from(String(encKey || ''), 'hex') : Buffer.from(encKey || []);
  if (key.length !== 32) throw traeErrorCode('TRAE_KEY_INVALID', 'trae targeted: encryption key is missing or malformed');

  const source = new PageSource(dbPath, key, signal);
  try {
    const schemas = readSchemaTables(source, [TABLE_CHAT_TURN, TABLE_SESSION_PROJECT, TABLE_PROJECT]);
    const chatTurn = schemas.get(TABLE_CHAT_TURN);
    if (!chatTurn) throw traeErrorCode('TRAE_SCHEMA_UNSUPPORTED', 'trae targeted: chat_turn table is missing');
    const chatColumns = parseCreateTableColumns(chatTurn.sql || '');
    const idIdx = requireColumn(chatColumns.columns, 'id', TABLE_CHAT_TURN);
    const sessionIdIdx = requireColumn(chatColumns.columns, 'session_id', TABLE_CHAT_TURN);
    const createdAtIdx = requireColumn(chatColumns.columns, 'created_at', TABLE_CHAT_TURN);
    const contextIdx = requireColumn(chatColumns.columns, 'context', TABLE_CHAT_TURN);

    const lowerBound = Number.isFinite(sinceId) && sinceId > 0
      ? Math.max(0, Math.trunc(sinceId) - TRAE_INCREMENTAL_OVERLAP)
      : null;
    const attribution = buildProjectAttribution(source, schemas);

    const rows = [];
    let maxId = 0;
    for (const cell of walkTable(source, chatTurn.rootPage, lowerBound)) {
      maxId = Math.max(maxId, cell.rowid);
      if (lowerBound !== null && cell.rowid <= lowerBound) continue;
      const values = parseRecord(cell.payload);
      if (values.length > chatColumns.columns.length) {
        throw corrupt('TRAE_RECORD_INVALID', 'chat_turn: record has more values than columns');
      }
      const id = chatColumns.rowidAliasIndex === idIdx ? cell.rowid : (values[idIdx] ?? cell.rowid);
      const context = contextIdx < values.length ? values[contextIdx] : null;
      if (context === null || context === undefined) continue; // WHERE context IS NOT NULL
      const sessionId = sessionIdIdx < values.length ? values[sessionIdIdx] : null;
      const createdAt = createdAtIdx < values.length ? values[createdAtIdx] : null;
      const projectId = attribution.sessionProject.get(String(sessionId ?? ''));
      const normalized = normalizeTraeTurnRow({
        rowid: id,
        session_id: sessionId,
        created_at: createdAt,
        context,
        project_label: projectId ? (attribution.projectNames.get(projectId) || '') : ''
      }, traeSource);
      if (normalized) {
        rows.push(normalized);
        if (rows.length >= maxRows) {
          throw traeErrorCode('TRAE_READ_BUDGET_EXCEEDED', `trae targeted: chat_turn read budget exceeded (${maxRows} rows)`);
        }
      }
    }
    // maxId must reflect the whole table even when the pruned walk skipped
    // older leaves — take it from a rightmost descent.
    if (lowerBound !== null) maxId = maxRowid(source, chatTurn.rootPage);
    return { rows, maxId, pagesVisited: source.visited.size, bytesRead: source.bytesRead, walPages: source.walHits };
  } finally {
    source.close();
  }
}

module.exports = {
  readTraeTargetedRows,
  // Exposed for tests: pure helpers without database access.
  parseCreateTableColumns,
  parseRecord
};
