'use strict';

// Record classification for CodeBuddy Code transcripts, shared by the session
// metadata scanner and the Session Detail parser.
//
// Two facts about the format drive everything here.
//
// One model response is one `providerData.messageId`, persisted as either a
// `function_call` (the response asked for a tool) or a plain assistant
// `message` (the response was text). Token usage is recorded on exactly one
// record of that response — the `function_call` when it called a tool, the
// assistant message when it did not — so the majority of usage rides on
// `function_call` records: on one real machine, 12158 of the 12950 usage-bearing
// records are calls, against 792 assistant messages. A reader that only looked
// at assistant messages would see usage for a fifth of the turns.
//
// The `user` role is also shared with client plumbing. Slash commands, local
// command echo, compaction digests and teammate input all arrive as `role:
// 'user'` records, and treating one as a prompt cuts an exchange in the wrong
// place while making a finished session read as still working.

const TITLE_MAX_CODE_POINTS = 96;

// `status` is the response's own account of whether it finished. `incomplete`
// is a dropped or superseded stream, so it is evidence of an open turn rather
// than of a finished one.
const ASSISTANT_STATUSES = Object.freeze(['completed', 'incomplete']);

// Flags the client sets on user records that carry no prompt. `skipRun` covers
// the bulk of it (1382 of 2535 user records on one real machine) — the
// slash-command invocations and the local command output echoed back into the
// transcript. The rest are compaction and sub-agent bookkeeping.
const NON_PROMPT_FLAGS = Object.freeze([
  'skipRun',
  'isMeta',
  'isCompactInternal',
  'isSummary',
  'isCompacted',
  'isSubAgent'
]);

// The same traffic, when it arrives with no flag at all, is recognisable only
// by the envelope the client opens it with: `<command-name>…`, `<system-reminder
// …>`, `<local-command-stdout>…`, `<teammate-message …>`, and the two compaction
// digests. A real prompt does not begin with a harness tag, and the marker list
// is deliberately closed — a client that starts emitting a new envelope would
// show it as one extra prompt row rather than break the timeline.
const SYNTHETIC_PROMPT_PREFIX = /^<\/?(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr|system-reminder|task-notification|teammate-message|conversation_history_summary|cb_summary)\b/;

function cleanTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= TITLE_MAX_CODE_POINTS
    ? text
    : `${chars.slice(0, TITLE_MAX_CODE_POINTS - 1).join('')}…`;
}

// User and assistant content blocks are Responses-API items: `input_text` for
// what the user typed, `output_text` for what the model said. A plain string is
// also legal and appears in a handful of records.
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') text += part;
    else if (part && part.type === 'input_text' && typeof part.text === 'string') text += part.text;
  }
  return text;
}

function isSyntheticPromptText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  return SYNTHETIC_PROMPT_PREFIX.test(trimmed);
}

// WorkBuddy wraps a conversation-opening user record in a
// `<system-reminder data-role="user-context">` envelope — workspace info, the
// same shape CodeBuddy emits as standalone reminder records — and puts the
// prompt itself in a `<user_query>` tag after it. Reading the envelope text
// alone would classify the record as one of the synthetic injections below and
// drop every prompt in the store, so the tag is extracted wherever it is
// present and the whole text is kept when it is not.
const USER_QUERY_TAG = /<user_query>([\s\S]*?)<\/user_query>/;

function userPromptText(entry) {
  const text = contentText(entry.content);
  const query = USER_QUERY_TAG.exec(text);
  return (query ? query[1] : text).replace(/\s+/g, ' ').trim();
}

// Whether a `user` record is something the user actually asked.
function isUserPromptRecord(entry) {
  if (entry?.type !== 'message' || entry?.role !== 'user') return false;
  const providerData = entry.providerData;
  if (providerData && typeof providerData === 'object') {
    for (const flag of NON_PROMPT_FLAGS) {
      if (providerData[flag] === true) return false;
    }
  }
  return !isSyntheticPromptText(userPromptText(entry));
}

// The response's completion state, or '' for a record that states none.
function assistantStatus(entry) {
  if (entry?.type !== 'message' || entry?.role !== 'assistant') return '';
  const status = entry.status;
  return ASSISTANT_STATUSES.includes(status) ? status : '';
}

// The response a tool call or an assistant message belongs to. Undefined on
// records the client writes without one, which cannot be a turn.
function messageIdOf(entry) {
  const id = entry?.providerData?.messageId;
  return typeof id === 'string' && id ? id : '';
}

// Mirror BuddyUsage::to_breakdown() in the pinned Tokscale Tencent Buddy
// parser. Select one usage object; merging the raw and friendly representations
// changes field precedence and loses explicit zero values.
function firstOption(values) {
  return values.find((value) => Number.isInteger(value));
}

function firstPresent(values) {
  return Math.max(0, firstOption(values) ?? 0);
}

function firstPositive(values) {
  return Math.max(0, values.find((value) => Number.isInteger(value) && value > 0) ?? firstOption(values) ?? 0);
}

function usageTokens(entry) {
  if (entry?.status != null && entry.status !== 'completed') return null;
  const usage = [entry?.message?.usage, entry?.providerData?.usage, entry?.providerData?.rawUsage]
    .find((value) => value && typeof value === 'object' && !Array.isArray(value));
  if (!usage) return null;

  const cacheRead = firstPositive([
    usage.cache_read_input_tokens, usage.cacheReadInputTokens, usage.cacheTokens,
    usage.prompt_cache_hit_tokens, usage.cached_tokens
  ]);
  const output = firstPresent([usage.output_tokens, usage.outputTokens, usage.completion_tokens]);
  const cacheWrite = firstPositive([
    usage.cache_creation_input_tokens, usage.cacheCreationInputTokens,
    usage.cachedWriteTokens, usage.prompt_cache_write_tokens
  ]);
  const reasoning = firstPresent([
    usage.completion_thinking_tokens, usage.completionThinkingTokens, usage.reasoningTokens
  ]);
  const miss = firstOption([usage.cachedMissTokens, usage.cacheMissTokens]);
  let input = miss == null ? firstPresent([usage.input_tokens, usage.inputTokens, usage.prompt_tokens]) : Math.max(0, miss);
  const reportedTotal = firstOption([usage.total_tokens, usage.totalTokens]);
  // Cache-miss fields already exclude cache. Otherwise only an inclusive total
  // proves cache reads are part of input; ambiguous input must stay intact.
  if (miss == null && reportedTotal != null && cacheRead > 0 && Math.max(0, reportedTotal) === input + output) {
    input -= cacheRead;
  }
  // Tencent Buddy reasoning is additive in Tokscale, unlike the informational
  // reasoning field of the generic Session Detail token helper.
  const total = input + output + cacheRead + cacheWrite + reasoning;
  return total > 0 ? { input, output, cacheRead, cacheWrite, reasoning, total } : null;
}

module.exports = {
  TITLE_MAX_CODE_POINTS,
  cleanTitle,
  contentText,
  isSyntheticPromptText,
  isUserPromptRecord,
  userPromptText,
  assistantStatus,
  messageIdOf,
  usageTokens
};
