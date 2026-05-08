// Block parser for memory markdown files (corrections.md, session-index.md).
//
// Splits a file into an ordered list of blocks. Two block types:
//   - 'item': starts with `### ` heading, body until next `###` or `##`
//   - 'sep' : everything else — preamble, H2 headings, trailing text
//
// Reconstruction invariant: blocks.map(b => b.lines.join('\n')).join('\n') === original
// Conservation: every line of the original file is consumed by exactly one block.
//
// Why both block types: corrections.md and session-index.md interleave H3 entries with
// optional H2 group headings ("## Resolved Corrections (recent)"). Treating H2 as a
// boundary prevents archive operations from orphaning an H2 inside another section's body.

export function parseBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  let cur = { type: 'sep', lines: [] };

  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (cur.lines.length > 0) blocks.push(cur);
      cur = { type: 'item', lines: [line] };
    } else if (line.startsWith('## ')) {
      if (cur.lines.length > 0) blocks.push(cur);
      cur = { type: 'sep', lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.length > 0) blocks.push(cur);

  return blocks;
}

export function serializeBlocks(blocks) {
  return blocks.map(b => b.lines.join('\n')).join('\n');
}

// Extract first ISO date (YYYY-MM-DD) from a block's text. Returns null if none.
export function blockDateISO(block) {
  const text = block.lines.join('\n');
  const m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
