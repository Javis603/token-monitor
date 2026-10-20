'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { findSubagentSessionFile } = require('../../src/shared/providers/codebuddy/subagents');
const { codebuddyProjectsRoot } = require('../../src/shared/providers/codebuddy/paths');

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-subagents-'));
  tmpDirs.push(dir);
  return dir;
}

function writeTree(home, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(home, '.codebuddy', 'projects', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return codebuddyProjectsRoot({ homeDir: home });
}

// An ordinary sub-agent record: the top-level sessionId is the sub-agent's own
// session id, while `_meta.baggage` on the same record carries the PARENT
// session id. Matching on the latter would resolve to the parent's transcript.
function subRecord(sessionId, parentSessionId, text = 'collect competitor pricing') {
  return JSON.stringify({
    type: 'message',
    role: 'user',
    timestamp: 1789971546087,
    content: [{ type: 'input_text', text }],
    sessionId,
    _meta: {
      baggage: `codebuddy.session_id=${parentSessionId},codebuddy.conversation_request_id=01a13465def87184842bdafa15c4b386`
    }
  });
}

// A `session-meta` record states the agent id in sessionId — not a session id.
function metaRecord(agentId) {
  return JSON.stringify({
    type: 'session-meta',
    id: '01a13484-45c9-7dfe-0000-000000000000',
    sessionId: agentId,
    timestamp: 1789971546087,
    meta: {}
  });
}

const PARENT = '01a13463-cb53-72a7-afee-0164d5bdde33';
const SUB = '01a13466-8201-7275-95ad-04d2f3520e7e';
const AGENT_FILE = `${PARENT}/subagents/agent-9077a5ed-6f2d-4464-8416-d182d9fd84d5.jsonl`;

test('finds a sub-agent transcript by the session id its records state', () => {
  const root = writeTree(tmpHome(), {
    [`c-Users-11451/${AGENT_FILE}`]: subRecord(SUB, PARENT)
  });

  assert.equal(
    findSubagentSessionFile(root, SUB),
    path.join(root, 'c-Users-11451', AGENT_FILE)
  );
});

test('does not match the parent session id the baggage carries', () => {
  const root = writeTree(tmpHome(), {
    [`c-Users-11451/${AGENT_FILE}`]: subRecord(SUB, PARENT)
  });

  assert.equal(findSubagentSessionFile(root, PARENT), '');
});

test('reads past a torn or empty first line', () => {
  const torn = writeTree(tmpHome(), {
    [`c-Users-11451/${PARENT}/subagents/agent-a.jsonl`]: `{"id":"01a13484-45c9-7dfe-0000\n${subRecord(SUB, PARENT)}`
  });
  assert.equal(findSubagentSessionFile(torn, SUB), path.join(torn, `c-Users-11451/${PARENT}/subagents/agent-a.jsonl`));

  const empty = writeTree(tmpHome(), {
    [`c-Users-11451/${PARENT}/subagents/agent-b.jsonl`]: `\n${subRecord(SUB, PARENT)}`
  });
  assert.equal(findSubagentSessionFile(empty, SUB), path.join(empty, `c-Users-11451/${PARENT}/subagents/agent-b.jsonl`));
});

test('skips a session-meta record, whose sessionId is the agent id', () => {
  const root = writeTree(tmpHome(), {
    [`c-Users-11451/${AGENT_FILE}`]: [metaRecord('agent-9077a5ed-6f2d-4464-8416-d182d9fd84d5'), subRecord(SUB, PARENT)].join('\n')
  });

  assert.equal(findSubagentSessionFile(root, SUB), path.join(root, 'c-Users-11451', AGENT_FILE));
  assert.equal(findSubagentSessionFile(root, 'agent-9077a5ed-6f2d-4464-8416-d182d9fd84d5'), '');
});

test('resolves a nested sub-agent transcript', () => {
  // The client nests sub-agents up to a fixed depth; the walk is
  // depth-agnostic rather than tied to the observed one-level layout.
  const nested = `${PARENT}/subagents/agent-a-1111/subagents/agent-b-2222.jsonl`;
  const root = writeTree(tmpHome(), {
    [`c-Users-11451/${nested}`]: subRecord('01a0c29e-3fa4-7d33-9f09-9a16b5b6916b', PARENT)
  });

  assert.equal(findSubagentSessionFile(root, '01a0c29e-3fa4-7d33-9f09-9a16b5b6916b'), path.join(root, 'c-Users-11451', nested));
});

test('reports no match for an unknown session id', () => {
  const root = writeTree(tmpHome(), {
    [`c-Users-11451/${AGENT_FILE}`]: subRecord(SUB, PARENT)
  });

  assert.equal(findSubagentSessionFile(root, '01a0c29e-0000-0000-0000-000000000000'), '');
});

test('rejects a session id that is not a single path segment', () => {
  const root = writeTree(tmpHome(), {
    [`c-Users-11451/${AGENT_FILE}`]: subRecord(SUB, PARENT)
  });

  for (const id of ['../x', 'a/b', '', '.', '..']) {
    assert.equal(findSubagentSessionFile(root, id), '');
  }
});
