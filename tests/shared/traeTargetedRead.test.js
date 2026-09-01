'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createHmac, pbkdf2Sync, randomBytes } = require('node:crypto');

const {
  parseCreateTableColumns,
  parseRecord,
  readTraeTargetedRows
} = require('../../src/shared/traeTargetedRead');
const {
  buildTraeWalOverlay,
  collectTraeSnapshot,
  decryptTraeDb,
  readTraeRows
} = require('../../src/shared/traeUsage');
const { CredentialStore } = require('../../src/shared/credentialStore');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const PAGE = 4096;

function xorSalt(salt) {
  const out = Buffer.from(salt);
  for (let i = 0; i < out.length; i += 1) out[i] ^= 0x3a;
  return out;
}

function macKeyFor(key, salt) {
  return pbkdf2Sync(key, xorSalt(salt), 2, 32, 'sha512');
}

// Same page-1 HMAC layout the decrypt pipeline verifies.
function pageHmac(macKey, page, pgno) {
  const hmac = createHmac('sha512', macKey);
  hmac.update(page.subarray(16, 4032));
  const pageLe = Buffer.alloc(4);
  pageLe.writeUInt32LE(pgno, 0);
  hmac.update(pageLe);
  return hmac.digest();
}

function encryptPage(plainPage, pgno, key, salt) {
  const iv = randomBytes(16);
  const body = pgno === 1 ? plainPage.subarray(16, 4016) : plainPage.subarray(0, 4016);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  const page = Buffer.alloc(PAGE);
  if (pgno === 1) salt.copy(page, 0);
  ciphertext.copy(page, pgno === 1 ? 16 : 0);
  iv.copy(page, 4016);
  pageHmac(macKeyFor(key, salt), page, pgno).copy(page, 4032);
  return page;
}

// WAL frames authenticate a wider range than main-file pages: page 1 still
// skips its salt, but every other page's full ciphertext enters the HMAC.
function encryptWalPage(plainPage, pgno, key, salt) {
  const page = encryptPage(plainPage, pgno, key, salt);
  const macKey = macKeyFor(key, salt);
  const hmac = createHmac('sha512', macKey);
  hmac.update(page.subarray(pgno === 1 ? 16 : 0, 4032));
  const pageLe = Buffer.alloc(4);
  pageLe.writeUInt32LE(pgno, 0);
  hmac.update(pageLe);
  hmac.digest().copy(page, 4032);
  return page;
}

function writeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trae-targeted-'));
}

// ---- Hand-built plaintext fixture --------------------------------------
// The real Trae database is born with an 80-byte per-page reserve (usable
// page = 4016) — that geometry is what both the decrypt pipeline and the
// targeted reader assume. node:sqlite cannot create such a database (no
// reserved-bytes API; newer SQLite rejects a header patched after creation
// with SQLITE_NOTADB), so the plaintext pages are built by hand and then
// validated by real SQLite before being encrypted. The plaintext twin stays
// around as the readTraeRows oracle.

const USABLE = 4016;
const MAX_LOCAL = USABLE - 35;
const MIN_LOCAL = Math.floor(((USABLE - 12) * 32) / 255) - 23;
const OVERFLOW_CHUNK = USABLE - 4;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\x00', 'binary');

function encodeVarint(value) {
  assert.ok(Number.isInteger(value) && value >= 0, 'varint must be a non-negative integer');
  if (value < 0x80) return Buffer.from([value]);
  const groups = [];
  for (let v = value; v > 0; v = Math.floor(v / 128)) groups.unshift(v % 128);
  const out = Buffer.alloc(groups.length);
  groups.forEach((group, i) => { out[i] = i === groups.length - 1 ? group : (group | 0x80); });
  return out;
}

// Minimal integer serial encoding; the fixture holds no negatives.
function encodeIntColumn(value) {
  assert.ok(Number.isInteger(value) && value >= 0);
  if (value === 0) return { serial: 8, bytes: Buffer.alloc(0) };
  if (value === 1) return { serial: 9, bytes: Buffer.alloc(0) };
  for (const [serial, size] of [[1, 1], [2, 2], [3, 3], [4, 4]]) {
    if (value < 2 ** (8 * size - 1)) {
      const bytes = Buffer.alloc(size);
      bytes.writeUIntBE(value, 0, size);
      return { serial, bytes };
    }
  }
  const bytes = Buffer.alloc(6);
  bytes.writeUIntBE(value, 0, 6);
  return { serial: 5, bytes };
}

const textColumn = (value) => ({ type: 'text', value });
const intColumn = (value) => ({ type: 'int', value });
const nullColumn = { type: 'null' };

function encodeRecord(columns) {
  const serials = [];
  const bodies = [];
  for (const column of columns) {
    if (column.type === 'null') {
      serials.push(0);
      bodies.push(Buffer.alloc(0));
    } else if (column.type === 'int') {
      const encoded = encodeIntColumn(column.value);
      serials.push(encoded.serial);
      bodies.push(encoded.bytes);
    } else {
      serials.push(13 + 2 * Buffer.byteLength(column.value, 'utf8'));
      bodies.push(Buffer.from(column.value, 'utf8'));
    }
  }
  const serialBuffers = serials.map(encodeVarint);
  const headerSize = 1 + serialBuffers.reduce((total, buf) => total + buf.length, 0);
  return Buffer.concat([encodeVarint(headerSize), ...serialBuffers, ...bodies]);
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function localPayloadSize(payloadLength) {
  if (payloadLength <= MAX_LOCAL) return payloadLength;
  const k = MIN_LOCAL + ((payloadLength - MIN_LOCAL) % OVERFLOW_CHUNK);
  return k <= MAX_LOCAL ? k : MIN_LOCAL;
}

function makeLeafPage(cells, headerOffset = 0) {
  const page = Buffer.alloc(4096);
  let contentEnd = USABLE;
  const pointers = [];
  for (const cell of cells) {
    contentEnd -= cell.length;
    cell.copy(page, contentEnd);
    pointers.push(contentEnd);
  }
  page[headerOffset] = 13;
  page.writeUInt16BE(0, headerOffset + 1);
  page.writeUInt16BE(cells.length, headerOffset + 3);
  page.writeUInt16BE(contentEnd, headerOffset + 5);
  page[headerOffset + 7] = 0;
  pointers.forEach((offset, i) => page.writeUInt16BE(offset, headerOffset + 8 + 2 * i));
  return page;
}

function makeInteriorPage(children) {
  const page = Buffer.alloc(4096);
  const cells = children.slice(0, -1).map((child) => Buffer.concat([u32(child.pgno), encodeVarint(child.maxRowid)]));
  let contentEnd = USABLE;
  const pointers = [];
  for (const cell of cells) {
    contentEnd -= cell.length;
    cell.copy(page, contentEnd);
    pointers.push(contentEnd);
  }
  page[0] = 5;
  page.writeUInt16BE(0, 1);
  page.writeUInt16BE(cells.length, 3);
  page.writeUInt16BE(contentEnd, 5);
  page[7] = 0;
  page.writeUInt32BE(children[children.length - 1].pgno, 8);
  pointers.forEach((offset, i) => page.writeUInt16BE(offset, 12 + 2 * i));
  return page;
}

class FixtureBuilder {
  constructor() {
    // Index 0 (pgno 1) is the header page, filled in last.
    this.pages = [null];
  }

  alloc(page) {
    this.pages.push(page);
    return this.pages.length;
  }

  pushOverflowChain(data) {
    const first = this.pages.length + 1;
    for (let offset = 0; offset < data.length; offset += OVERFLOW_CHUNK) {
      const next = offset + OVERFLOW_CHUNK < data.length ? this.pages.length + 2 : 0;
      const page = Buffer.alloc(4096);
      page.writeUInt32BE(next, 0);
      data.subarray(offset, offset + OVERFLOW_CHUNK).copy(page, 4);
      this.pages.push(page);
    }
    return first;
  }

  buildCell(rowid, payload) {
    const head = Buffer.concat([encodeVarint(payload.length), encodeVarint(rowid)]);
    if (payload.length <= MAX_LOCAL) return Buffer.concat([head, payload]);
    const local = localPayloadSize(payload.length);
    const firstOverflow = this.pushOverflowChain(payload.subarray(local));
    return Buffer.concat([head, payload.subarray(0, local), u32(firstOverflow)]);
  }

  // rows: [{ rowid, payload }] in ascending rowid order. Returns the root
  // page number; a multi-leaf table gets one interior level.
  buildTable(rows) {
    const leaves = [];
    let cells = [];
    let maxRowid = 0;
    let usedBytes = 0;
    const flush = () => {
      if (cells.length === 0) return;
      leaves.push({ pgno: this.alloc(makeLeafPage(cells)), maxRowid });
      cells = [];
      maxRowid = 0;
      usedBytes = 0;
    };
    for (const row of rows) {
      const cell = this.buildCell(row.rowid, row.payload);
      const projected = 8 + 2 * (cells.length + 1) + usedBytes + cell.length;
      if (cells.length > 0 && projected > USABLE) flush();
      cells.push(cell);
      maxRowid = row.rowid;
      usedBytes += cell.length;
    }
    flush();
    assert.ok(leaves.length > 0, 'fixture table needs at least one row');
    if (leaves.length === 1) return leaves[0].pgno;
    return this.alloc(makeInteriorPage(leaves));
  }

  makeHeaderPage(masterCells) {
    const page = makeLeafPage(masterCells, 100);
    SQLITE_MAGIC.copy(page, 0);
    page.writeUInt16BE(4096, 16);
    page[18] = 1; page[19] = 1;
    page[20] = 80; // reserved bytes per page — the whole point of the builder
    page[21] = 64; page[22] = 32; page[23] = 32;
    page.writeUInt32BE(1, 24); // change counter
    page.writeUInt32BE(this.pages.length, 28); // size in pages
    page.writeUInt32BE(1, 40); // schema cookie
    page.writeUInt32BE(4, 44); // schema format
    page.writeUInt32BE(1, 56); // UTF-8
    page.writeUInt32BE(1, 92); // version-valid-for
    page.writeUInt32BE(3045000, 96);
    return page;
  }
}

function usageContext(tokens, model = 'glm-5.1') {
  return JSON.stringify({
    token_usage: { prompt_tokens: tokens, completion_tokens: Math.ceil(tokens / 10) },
    persist_user_message_context: { model_info: { config_name: model } }
  });
}

// ~200 varied turns (multi-leaf chat_turn), NULL context and NULL created_at
// rows, and one context large enough to spill into an overflow chain — all in
// mid-tree rowids, not just at the right edge.
function chatTurnRows() {
  const rows = [];
  let rowid = 0;
  const push = (sessionId, createdAt, context) => {
    rowid += 1;
    rows.push({
      rowid,
      payload: encodeRecord([
        nullColumn, // id is the rowid alias, stored as NULL
        sessionId === null ? nullColumn : textColumn(sessionId),
        createdAt === null ? nullColumn : intColumn(createdAt),
        context === null ? nullColumn : textColumn(context)
      ])
    });
  };
  for (let i = 1; i <= 200; i += 1) {
    push(
      i % 3 === 0 ? 's2' : 's1',
      1750000000 + i * 60,
      i % 25 === 0 ? 'broken json' : usageContext(100 + i, i % 7 === 0 ? 'kimi-k2.5' : 'glm-5.1')
    );
  }
  push('s1', 1750000000, null);
  push('s1', null, usageContext(7));
  push('s1', 1750009000, `{"token_usage":{"prompt_tokens":9999,"completion_tokens":99},"note":"${'x'.repeat(5000)}"}`);
  return rows;
}

function buildEncryptedFixture(dir) {
  const key = randomBytes(32);
  const salt = randomBytes(16);
  const plainPath = path.join(dir, 'plain.db');
  const dbPath = path.join(dir, 'database.db');

  const builder = new FixtureBuilder();
  const chatRows = chatTurnRows();
  const chatRoot = builder.buildTable(chatRows);
  const sessionProjectRoot = builder.buildTable([
    { rowid: 1, payload: encodeRecord([textColumn('s1'), textColumn('p1')]) },
    { rowid: 2, payload: encodeRecord([textColumn('s2'), textColumn('p2')]) },
    { rowid: 3, payload: encodeRecord([textColumn('orphan'), textColumn('p404')]) }
  ]);
  const projectRoot = builder.buildTable([
    { rowid: 1, payload: encodeRecord([textColumn('p1'), textColumn('C:\\work\\demo-project')]) },
    { rowid: 2, payload: encodeRecord([textColumn('p2'), textColumn('/home/u/other-repo')]) }
  ]);
  // A decoy table holding most of the file's bytes; the targeted reader must
  // never touch it.
  const decoyRoot = builder.buildTable([
    { rowid: 1, payload: encodeRecord([nullColumn, textColumn('y'.repeat(600_000))]) }
  ]);

  const masterRows = [
    ['chat_turn', 'CREATE TABLE chat_turn (id INTEGER PRIMARY KEY, session_id TEXT, created_at INTEGER, context TEXT)', chatRoot],
    ['session_project', 'CREATE TABLE session_project (session_id TEXT, project_id TEXT)', sessionProjectRoot],
    ['project', 'CREATE TABLE project (project_id TEXT, absolute_path TEXT)', projectRoot],
    ['big_other', 'CREATE TABLE big_other (id INTEGER PRIMARY KEY, payload TEXT)', decoyRoot]
  ];
  const masterCells = masterRows.map(([name, sql, root], index) =>
    builder.buildCell(index + 1, encodeRecord([textColumn('table'), textColumn(name), textColumn(name), intColumn(root), textColumn(sql)])));
  builder.pages[0] = builder.makeHeaderPage(masterCells);

  fs.writeFileSync(plainPath, Buffer.concat(builder.pages));
  const check = new sqlite.DatabaseSync(plainPath, { readOnly: true });
  try {
    const counted = check.prepare('SELECT count(*) AS n FROM chat_turn').get();
    assert.equal(counted.n, chatRows.length, 'the hand-built fixture must be readable by real SQLite');
  } finally {
    check.close();
  }

  const plain = fs.readFileSync(plainPath);
  assert.equal(plain.length % PAGE, 0, 'fixture must be page aligned');
  const encryptedPages = [];
  for (let offset = 0; offset < plain.length; offset += PAGE) {
    encryptedPages.push(encryptPage(plain.subarray(offset, offset + PAGE), offset / PAGE + 1, key, salt));
  }
  fs.writeFileSync(dbPath, Buffer.concat(encryptedPages));
  return { plainPath, dbPath, key, keyHex: key.toString('hex'), totalPages: encryptedPages.length };
}

(sqlite ? test : test.skip)('targeted read matches the full decrypt+SQL oracle row for row', () => {
  const dir = writeTempDir();
  try {
    const fixture = buildEncryptedFixture(dir);

    const oracle = readTraeRows(fixture.plainPath);
    const targeted = readTraeTargetedRows({ dbPath: fixture.dbPath, encKey: fixture.keyHex });

    assert.equal(targeted.maxId, oracle.maxId);
    assert.deepEqual(targeted.rows, oracle.rows);
    assert.ok(targeted.rows.length >= 150, `expected the bulk of turns, got ${targeted.rows.length}`);
    // The decoy table holds most of the file's bytes; selectivity is the point.
    assert.ok(targeted.pagesVisited <= fixture.totalPages / 2,
      `targeted visited ${targeted.pagesVisited}/${fixture.totalPages} pages`);
    assert.equal(targeted.bytesRead, targeted.pagesVisited * PAGE);

    const overflowRow = targeted.rows.find((row) => row.input === 9999);
    assert.ok(overflowRow, 'overflowing context row must survive');
    assert.equal(overflowRow.model, 'trae');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(sqlite ? test : test.skip)('targeted incremental read honors sinceId and the whole-table maxId', () => {
  const dir = writeTempDir();
  try {
    const fixture = buildEncryptedFixture(dir);

    // 1/57/120/203 all land at or below the 256-row backfill rewind, so they
    // read the whole table — the oracle must agree anyway. 400 cuts into the
    // table (lowerBound = 144) and exercises real pruning.
    for (const sinceId of [1, 57, 120, 203, 400]) {
      const oracle = readTraeRows(fixture.plainPath, { sinceId });
      const targeted = readTraeTargetedRows({ dbPath: fixture.dbPath, encKey: fixture.keyHex, sinceId });
      assert.deepEqual(targeted.rows, oracle.rows, `sinceId ${sinceId} rows must match the oracle`);
      assert.equal(targeted.maxId, oracle.maxId, `sinceId ${sinceId} maxId must match the oracle`);
    }
    // Beyond the table high-water mark: nothing new, cursor anchored.
    const beyond = readTraeTargetedRows({ dbPath: fixture.dbPath, encKey: fixture.keyHex, sinceId: 100000 });
    assert.equal(beyond.rows.length, 0);
    assert.equal(beyond.maxId, 203);

    // The pruned walk must touch fewer pages than the full one.
    const full = readTraeTargetedRows({ dbPath: fixture.dbPath, encKey: fixture.keyHex });
    const pruned = readTraeTargetedRows({ dbPath: fixture.dbPath, encKey: fixture.keyHex, sinceId: 400 });
    assert.ok(pruned.pagesVisited < full.pagesVisited,
      `pruned walk (${pruned.pagesVisited}) must beat full walk (${full.pagesVisited})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(sqlite ? test : test.skip)('collectTraeSnapshot prefers the targeted reader and falls back on demand', () => {
  const dir = writeTempDir();
  try {
    const fixture = buildEncryptedFixture(dir);
    const oracle = readTraeRows(fixture.plainPath);

    const targeted = collectTraeSnapshot({ dbPath: fixture.dbPath, encKey: fixture.keyHex, workDir: dir });
    assert.equal(targeted.targeted, true);
    assert.deepEqual(targeted.rows, oracle.rows);
    assert.equal(targeted.maxId, oracle.maxId);
    assert.equal(fs.existsSync(path.join(dir, 'trae-database-decrypted.db')), false,
      'the targeted path must not leave a plaintext copy behind');

    // Kill switch pins the legacy full-decrypt path.
    const legacy = collectTraeSnapshot({
      dbPath: fixture.dbPath,
      encKey: fixture.keyHex,
      workDir: dir,
      env: { TOKEN_MONITOR_TRAE_TARGETED_READ: '0' }
    });
    assert.equal(legacy.targeted, false);
    assert.deepEqual(legacy.rows, oracle.rows);

    // A failing targeted reader degrades to the full path, surfacing why.
    const stubbed = collectTraeSnapshot({
      dbPath: fixture.dbPath,
      encKey: fixture.keyHex,
      workDir: dir,
      targetedRead: () => { throw Object.assign(new Error('boom'), { code: 'TRAE_BTREE_CORRUPT' }); }
    });
    assert.equal(stubbed.targeted, false);
    assert.equal(stubbed.targetedFallback.code, 'TRAE_BTREE_CORRUPT');
    assert.deepEqual(stubbed.rows, oracle.rows);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(sqlite ? test : test.skip)('corrupted non-header pages fail loudly instead of producing wrong numbers', () => {
  const dir = writeTempDir();
  try {
    const fixture = buildEncryptedFixture(dir);
    const encrypted = fs.readFileSync(fixture.dbPath);
    // Corrupt every page after page 1: the targeted walk must reject the
    // garbage structurally, and the full fallback must not silently invent a
    // row set out of a mangled plaintext file either.
    for (let offset = PAGE; offset < encrypted.length; offset += 997) {
      encrypted[offset] ^= 0xff;
    }
    fs.writeFileSync(fixture.dbPath, encrypted);

    assert.throws(() => readTraeTargetedRows({ dbPath: fixture.dbPath, encKey: fixture.keyHex }));
    assert.throws(() => collectTraeSnapshot({ dbPath: fixture.dbPath, encKey: fixture.keyHex, workDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(sqlite ? test : test.skip)('an aborted signal aborts instead of degrading to a full decrypt', () => {
  const dir = writeTempDir();
  try {
    const fixture = buildEncryptedFixture(dir);
    const controller = new AbortController();
    controller.abort();
    assert.throws(
      () => collectTraeSnapshot({
        dbPath: fixture.dbPath,
        encKey: fixture.keyHex,
        workDir: dir,
        signal: controller.signal
      }),
      (error) => error.code === 'TRAE_ABORTED'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCreateTableColumns maps columns and the rowid alias', () => {
  const parsed = parseCreateTableColumns(
    'CREATE TABLE chat_turn (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, created_at INTEGER, context TEXT)'
  );
  assert.deepEqual(parsed.columns, ['id', 'session_id', 'created_at', 'context']);
  assert.equal(parsed.rowidAliasIndex, 0);

  // Quoted identifiers, comments of constraints, and a trailing WITHOUT ROWID
  // rejection.
  const quoted = parseCreateTableColumns(
    'CREATE TABLE t ("name" TEXT, [with space] INTEGER PRIMARY KEY, `tick` TEXT, parent_id INTEGER REFERENCES p(id) ON DELETE CASCADE, PRIMARY KEY ("name", "tick"))'
  );
  assert.deepEqual(quoted.columns, ['name', 'with space', 'tick', 'parent_id']);
  assert.equal(quoted.rowidAliasIndex, 1);
  assert.throws(
    () => parseCreateTableColumns('CREATE TABLE t (id INTEGER PRIMARY KEY) WITHOUT ROWID'),
    (error) => error.code === 'TRAE_SCHEMA_UNSUPPORTED'
  );
  assert.throws(
    () => parseCreateTableColumns('garbage'),
    (error) => error.code === 'TRAE_SCHEMA_UNSUPPORTED'
  );
});

test('parseRecord decodes serial types positionally', () => {
  // Values [null, 1, 'hi', -1, 0]: serial types 0 (NULL), 9 (constant 1),
  // 17 (2-char text), 1 (int8), 8 (constant 0); header size 6, then the body
  // 0x68 0x69 ('hi') and 0xFF (-1).
  const payload = Buffer.from([6, 0, 9, 17, 1, 8, 0x68, 0x69, 255]);
  assert.deepEqual(parseRecord(payload), [null, 1, 'hi', -1, 0]);
});

// --- WAL overlay ---
// Trae commits to the -wal and only reaches the main file on SQLite's
// checkpoint schedule, so the readers must overlay the WAL's committed
// frames or they show usage minutes stale. These fixtures hand-build WAL
// files with the same salt/HMAC rules the pipeline verifies.

const WAL_SALT = Buffer.from('0123456789abcdef', 'binary');

function walHeader({ salt = WAL_SALT, pageSize = PAGE } = {}) {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x377f0682, 0);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(pageSize, 8);
  header.writeUInt32BE(0, 12); // checkpoint sequence
  salt.subarray(0, 8).copy(header, 16);
  salt.subarray(8, 16).copy(header, 24);
  return header;
}

function walFrame(pgno, encryptedPage, { salt = WAL_SALT, commitPages = 0 } = {}) {
  const frame = Buffer.alloc(24 + encryptedPage.length);
  frame.writeUInt32BE(pgno, 0);
  frame.writeUInt32BE(commitPages, 4);
  salt.subarray(0, 8).copy(frame, 8);
  salt.subarray(8, 16).copy(frame, 16);
  encryptedPage.copy(frame, 24);
  return frame;
}

// Single-leaf chat_turn fixture (plus minimal attribution tables) whose page
// numbers and plaintext pages are known, so tests can rebuild pages and put
// them into a WAL.
function buildSmallFixture(dir, chatRows) {
  const key = randomBytes(32);
  const salt = randomBytes(16);
  const builder = new FixtureBuilder();
  const chatRoot = builder.buildTable(chatRows);
  const sessionProjectRoot = builder.buildTable([
    { rowid: 1, payload: encodeRecord([textColumn('s1'), textColumn('p1')]) }
  ]);
  const projectRoot = builder.buildTable([
    { rowid: 1, payload: encodeRecord([textColumn('p1'), textColumn('C:\\work\\demo')]) }
  ]);
  const masterRows = [
    ['chat_turn', 'CREATE TABLE chat_turn (id INTEGER PRIMARY KEY, session_id TEXT, created_at INTEGER, context TEXT)', chatRoot],
    ['session_project', 'CREATE TABLE session_project (session_id TEXT, project_id TEXT)', sessionProjectRoot],
    ['project', 'CREATE TABLE project (project_id TEXT, absolute_path TEXT)', projectRoot]
  ];
  const masterCells = masterRows.map(([name, sql, root], index) =>
    builder.buildCell(index + 1, encodeRecord([textColumn('table'), textColumn(name), textColumn(name), intColumn(root), textColumn(sql)])));
  builder.pages[0] = builder.makeHeaderPage(masterCells);
  const plain = Buffer.concat(builder.pages);
  const dbPath = path.join(dir, 'database.db');
  fs.writeFileSync(dbPath, Buffer.concat(builder.pages.map((page, i) => encryptPage(page, i + 1, key, salt))));
  return { dbPath, keyHex: key.toString('hex'), key, salt, chatRoot, plain };
}

// One chat_turn record (id is the rowid alias). usageContext maps `tokens`
// straight to input via prompt_tokens.
function turnRecord(rowid, tokens) {
  return encodeRecord([
    nullColumn,
    textColumn('s1'),
    intColumn(1750000000 + rowid * 60),
    textColumn(usageContext(tokens))
  ]);
}

function turnCell(rowid, tokens) {
  const payload = turnRecord(rowid, tokens);
  return Buffer.concat([encodeVarint(payload.length), encodeVarint(rowid), payload]);
}

const turnRow = (rowid, tokens) => ({ rowid, payload: turnRecord(rowid, tokens) });

test('targeted read sees committed WAL frames the main file has not absorbed', () => {
  const dir = writeTempDir();
  try {
    const fixture = buildSmallFixture(dir, [turnRow(1, 100), turnRow(2, 200), turnRow(3, 300)]);
    // Trae semantics: turn 2 is backfill-refreshed (200 -> 250) and turn 4
    // lands; both are still only in the WAL when this collect runs.
    const leaf = makeLeafPage([turnCell(1, 100), turnCell(2, 250), turnCell(3, 300), turnCell(4, 400)]);
    const walPath = path.join(dir, 'database.db-wal');
    const dbPages = fixture.plain.length / PAGE;
    fs.writeFileSync(walPath, Buffer.concat([
      walHeader(),
      walFrame(fixture.chatRoot, encryptWalPage(leaf, fixture.chatRoot, fixture.key, fixture.salt), { commitPages: dbPages })
    ]));

    const targeted = readTraeTargetedRows({ dbPath: fixture.dbPath, encKey: fixture.keyHex });
    assert.equal(targeted.walPages, 1);
    assert.equal(targeted.rows.length, 4, 'WAL rows must be readable before any checkpoint');
    assert.equal(targeted.rows.find((row) => row.messageId.endsWith(':1')).input, 100);
    assert.equal(targeted.rows.find((row) => row.messageId.endsWith(':2')).input, 250, 'the backfilled turn must refresh in place');
    assert.equal(targeted.rows.find((row) => row.messageId.endsWith(':4')).input, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('targeted read follows pages grown inside the WAL', () => {
  const dir = writeTempDir();
  try {
    const key = randomBytes(32);
    const salt = randomBytes(16);
    const builder = new FixtureBuilder();
    const leaf1 = builder.alloc(makeLeafPage([turnCell(1, 100), turnCell(2, 200)]));
    const leaf2 = builder.alloc(makeLeafPage([turnCell(3, 300), turnCell(4, 400)]));
    const root = builder.alloc(makeInteriorPage([
      { pgno: leaf1, maxRowid: 2 },
      { pgno: leaf2, maxRowid: 4 }
    ]));
    const sessionProjectRoot = builder.buildTable([
      { rowid: 1, payload: encodeRecord([textColumn('s1'), textColumn('p1')]) }
    ]);
    const projectRoot = builder.buildTable([
      { rowid: 1, payload: encodeRecord([textColumn('p1'), textColumn('C:\\work\\demo')]) }
    ]);
    const masterRows = [
      ['chat_turn', 'CREATE TABLE chat_turn (id INTEGER PRIMARY KEY, session_id TEXT, created_at INTEGER, context TEXT)', root],
      ['session_project', 'CREATE TABLE session_project (session_id TEXT, project_id TEXT)', sessionProjectRoot],
      ['project', 'CREATE TABLE project (project_id TEXT, absolute_path TEXT)', projectRoot]
    ];
    const masterCells = masterRows.map(([name, sql, rootPage], index) =>
      builder.buildCell(index + 1, encodeRecord([textColumn('table'), textColumn(name), textColumn(name), intColumn(rootPage), textColumn(sql)])));
    builder.pages[0] = builder.makeHeaderPage(masterCells);
    const dbPath = path.join(dir, 'database.db');
    fs.writeFileSync(dbPath, Buffer.concat(builder.pages.map((page, i) => encryptPage(page, i + 1, key, salt))));

    // The WAL appends a third leaf beyond the 6-page main file (pgno 7) and
    // points the interior root at it, all in one committed transaction.
    const newLeafPgno = 7;
    const newLeaf = encryptWalPage(makeLeafPage([turnCell(5, 500)]), newLeafPgno, key, salt);
    const newRoot = encryptWalPage(makeInteriorPage([
      { pgno: leaf1, maxRowid: 2 },
      { pgno: leaf2, maxRowid: 4 },
      { pgno: newLeafPgno, maxRowid: 5 }
    ]), root, key, salt);
    const walPath = path.join(dir, 'database.db-wal');
    fs.writeFileSync(walPath, Buffer.concat([
      walHeader(),
      walFrame(newLeafPgno, newLeaf, { commitPages: 0 }),
      walFrame(root, newRoot, { commitPages: newLeafPgno })
    ]));

    const targeted = readTraeTargetedRows({ dbPath, encKey: key.toString('hex') });
    assert.equal(targeted.rows.length, 5, 'the leaf grown inside the WAL must be reachable');
    assert.ok(targeted.walPages >= 2, `root and new leaf come from the overlay, got ${targeted.walPages}`);
    assert.equal(targeted.rows.find((row) => row.messageId.endsWith(':5')).input, 500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTraeWalOverlay ignores stale generations, open tails, and torn frames', () => {
  const dir = writeTempDir();
  try {
    const key = randomBytes(32);
    const salt = randomBytes(16);
    const pageA = encryptWalPage(makeLeafPage([]), 7, key, salt);
    const pageB = encryptWalPage(makeLeafPage([]), 8, key, salt);
    const walPath = path.join(dir, 'database.db-wal');

    // Committed frame for 7, then an open (uncommitted) frame for 8, then a
    // frame from an older WAL generation whose salt no longer matches.
    fs.writeFileSync(walPath, Buffer.concat([
      walHeader(),
      walFrame(7, pageA, { commitPages: 10 }),
      walFrame(8, pageB, { commitPages: 0 }),
      walFrame(9, encryptWalPage(makeLeafPage([]), 9, key, salt), { salt: Buffer.alloc(16, 0x77) })
    ]));
    let overlay = buildTraeWalOverlay(walPath, key, salt);
    assert.deepEqual([...overlay.pages.keys()], [7], 'only committed frames of the current generation apply');
    assert.equal(overlay.maxDbPages, 10);

    // A torn tail (bad page HMAC) must stop the frame walk, not apply garbage.
    const torn = Buffer.concat([
      walHeader(),
      walFrame(7, pageA, { commitPages: 10 }),
      walFrame(8, pageB, { commitPages: 11 })
    ]);
    // Corrupt the second frame's encrypted body inside the HMAC-covered range
    // (bytes [16, 4032) of the encrypted page).
    const frame2PageStart = 32 + (24 + PAGE) + 24;
    torn[frame2PageStart + 16] ^= 0xff;
    fs.writeFileSync(walPath, torn);
    overlay = buildTraeWalOverlay(walPath, key, salt);
    assert.deepEqual([...overlay.pages.keys()], [7], 'the corrupt frame and everything after must be dropped');

    // A WAL declaring a different page size is not for this database.
    fs.writeFileSync(walPath, Buffer.concat([walHeader({ pageSize: 2048 }), walFrame(7, pageA, { commitPages: 10 })]));
    overlay = buildTraeWalOverlay(walPath, key, salt);
    assert.equal(overlay.pages.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(sqlite ? test : test.skip)('full decrypt applies committed WAL frames too', () => {
  const dir = writeTempDir();
  try {
    const fixture = buildSmallFixture(dir, [turnRow(1, 100), turnRow(2, 200), turnRow(3, 300)]);
    const leaf = makeLeafPage([turnCell(1, 100), turnCell(2, 250), turnCell(3, 300), turnCell(4, 400)]);
    const dbPages = fixture.plain.length / PAGE;
    fs.writeFileSync(path.join(dir, 'database.db-wal'), Buffer.concat([
      walHeader(),
      walFrame(fixture.chatRoot, encryptWalPage(leaf, fixture.chatRoot, fixture.key, fixture.salt), { commitPages: dbPages })
    ]));

    const outputPath = path.join(dir, 'decrypted.db');
    const meta = decryptTraeDb({ dbPath: fixture.dbPath, encKey: fixture.keyHex, outputPath });
    assert.equal(meta.walPages, 1, 'the fallback decrypt must report applied WAL pages');
    const result = readTraeRows(outputPath);
    const rows = Array.isArray(result) ? result : result.rows;
    assert.equal(rows.length, 4);
    assert.equal(rows.find((row) => row.messageId.endsWith(':2')).input, 250);
    assert.equal(rows.find((row) => row.messageId.endsWith(':4')).input, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Real-database validation: runs only where a Trae CN database and a saved
// key actually exist (this development machine), and skips everywhere else.
// The key is loaded through the app's own CredentialStore and never printed.
const realDbPath = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Trae CN', 'ModularData', 'ai-agent', 'database.db')
  : '';
const realAppDataDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Token Monitor')
  : '';
const realTraeKey = (() => {
  try {
    const store = new CredentialStore(realAppDataDir);
    return String(store.settingsCredentials().traeDbKey || '').trim();
  } catch (_) {
    return '';
  }
})();
const realDbReady = Boolean(realDbPath && fs.existsSync(realDbPath) && realTraeKey);

(sqlite && realDbReady ? test : test.skip)('real Trae database: targeted read matches full decrypt', { timeout: 120_000 }, () => {
  const targeted = readTraeTargetedRows({ dbPath: realDbPath, encKey: realTraeKey });
  const dir = writeTempDir();
  try {
    const decryptedPath = path.join(dir, 'real-decrypted.db');
    decryptTraeDb({ dbPath: realDbPath, encKey: realTraeKey, outputPath: decryptedPath });
    const oracle = readTraeRows(decryptedPath);
    assert.equal(targeted.maxId, oracle.maxId, `maxId: targeted=${targeted.maxId} full=${oracle.maxId}`);
    assert.deepEqual(
      targeted.rows.map((row) => row.messageId),
      oracle.rows.map((row) => row.messageId)
    );
    assert.deepEqual(targeted.rows, oracle.rows);
    // Selectivity: a 400MB database must not be read page-by-page.
    const totalPages = Math.ceil(fs.statSync(realDbPath).size / PAGE);
    assert.ok(targeted.pagesVisited < totalPages / 2,
      `targeted visited ${targeted.pagesVisited}/${totalPages} pages`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the collect worker accepts function-valued args without cloning errors', async () => {
  const { runTraeCollectWorker } = require('../../src/shared/traeCollectHost');
  const dir = writeTempDir();
  try {
    const workerScript = path.join(dir, 'echo-worker.js');
    fs.writeFileSync(
      workerScript,
      "const { parentPort, workerData } = require('node:worker_threads');" +
      "parentPort.postMessage({ ok: true, result: Object.keys(workerData) });"
    );
    const keys = await runTraeCollectWorker(
      { dbPath: 'x', encKey: 'y', onProgress: () => {} },
      { workerPath: workerScript }
    );
    assert.ok(keys.includes('dbPath'));
    assert.ok(keys.includes('encKey'));
    assert.equal(keys.includes('onProgress'), false, 'callbacks must be stripped before the clone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
