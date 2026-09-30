'use strict';

// The Hub's stats event is a single `data:` line of more than a megabyte, and it
// arrives over a hundred reads or more. Appending every read to one string and
// searching it for the blank line from the start rescans (and flattens)
// everything received so far on every read: quadratic in the event's size, on
// the main thread. The reader keeps the unfinished event as pieces and searches
// only the text that just arrived, so each character is scanned once.
function createSseBlockReader() {
  const pieces = [];

  function take(last) {
    pieces.push(last);
    const block = pieces.join('');
    pieces.length = 0;
    return block;
  }

  return {
    // Returns the blocks the text completes, without their trailing blank line.
    push(text) {
      const blocks = [];
      let start = 0;
      // The blank line can straddle two reads: one ends with '\n' and the next
      // starts with it.
      if (pieces.length > 0 && pieces[pieces.length - 1].endsWith('\n') && text.startsWith('\n')) {
        blocks.push(take('').slice(0, -1));
        start = 1;
      }
      let index;
      while ((index = text.indexOf('\n\n', start)) !== -1) {
        blocks.push(take(text.slice(start, index)));
        start = index + 2;
      }
      if (start < text.length) pieces.push(text.slice(start));
      return blocks;
    }
  };
}

function parseSseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try { return { event, data: JSON.parse(dataLines.join('\n')) }; } catch (_) { return null; }
}

module.exports = { createSseBlockReader, parseSseBlock };
