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

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

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

// Whether a `user` record is something the user actually asked.
function isUserPromptRecord(entry) {
  if (entry?.type !== 'message' || entry?.role !== 'user') return false;
  const providerData = entry.providerData;
  if (providerData && typeof providerData === 'object') {
    for (const flag of NON_PROMPT_FLAGS) {
      if (providerData[flag] === true) return false;
    }
  }
  return !isSyntheticPromptText(contentText(entry.content));
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

// Cache reads are reported three ways across client versions, and the field
// that is present is not stable: `prompt_cache_hit_tokens` is the common one,
// a session written by a newer build leaves it absent while filling
// `prompt_tokens_details.cached_tokens`, and the `usage` mirror repeats the same
// number under `inputTokensDetails`. Summing the wrong one under-reports cache
// reads and inflates input by the same amount, which is exactly how a session
// came out with 9.1M input / 0 cache against tokscale's 1.2M / 7.9M.
function cachedTokens(rawUsage, usage) {
  const hit = num(rawUsage.prompt_cache_hit_tokens);
  if (hit) return hit;
  let total = 0;
  const details = rawUsage.prompt_tokens_details;
  if (Array.isArray(details)) {
    for (const part of details) total += num(part?.cached_tokens);
  } else {
    total += num(details?.cached_tokens);
  }
  if (total) return total;
  for (const part of Array.isArray(usage.inputTokensDetails) ? usage.inputTokensDetails : []) {
    total += num(part?.cached_tokens);
  }
  return total;
}

function reasoningTokens(rawUsage, usage) {
  const thinking = num(rawUsage.completion_thinking_tokens);
  if (thinking) return thinking;
  // Same instability as the cache count above: a build that leaves the friendly
  // field empty fills `completion_tokens_details` instead, so the raw field is
  // read before the `usage` mirror.
  const details = num(rawUsage.completion_tokens_details?.reasoning_tokens);
  if (details) return details;
  let total = 0;
  for (const part of Array.isArray(usage.outputTokensDetails) ? usage.outputTokensDetails : []) {
    total += num(part?.reasoning_tokens);
  }
  return total;
}

// The token split of one model response, or null when the record states none.
// `prompt_tokens` counts cached input, so the cached part is subtracted out and
// reported as `cacheRead` — the same convention as Codex, and the reason its
// parser subtracts there too. `reasoning` stays a subset of `output` rather
// than a fourth bucket, so `input + output + cacheRead` is the whole total.
function usageTokens(entry) {
  const providerData = entry?.providerData;
  if (!providerData || typeof providerData !== 'object') return null;
  const rawUsage = providerData.rawUsage && typeof providerData.rawUsage === 'object' ? providerData.rawUsage : {};
  const usage = providerData.usage && typeof providerData.usage === 'object' ? providerData.usage : {};
  const prompt = num(rawUsage.prompt_tokens) || num(usage.inputTokens);
  const output = num(rawUsage.completion_tokens) || num(usage.outputTokens);
  if (!prompt && !output) return null;
  const cacheRead = cachedTokens(rawUsage, usage);
  return {
    input: Math.max(0, prompt - cacheRead),
    output,
    cacheRead,
    cacheWrite: 0,
    reasoning: reasoningTokens(rawUsage, usage)
  };
}

module.exports = {
  TITLE_MAX_CODE_POINTS,
  cleanTitle,
  contentText,
  isSyntheticPromptText,
  isUserPromptRecord,
  assistantStatus,
  messageIdOf,
  usageTokens
};
