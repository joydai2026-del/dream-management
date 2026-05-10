// Load pattern descriptors from patterns/active/ and patterns/reference/.
//
// Phase-2 ROUTE needs each active pattern's identifier stem (kebab-case
// filename) plus optional trigger_phrases and current sightings count. Phase-3
// PRUNE will additionally need bootstrap / demotion_phase fields from
// reference/ files for the bootstrap-guard re-promotion check.
//
// Frontmatter parsing is intentionally narrow: we extract a handful of known
// fields via line-anchored regex rather than a full YAML round-trip. This
// keeps us tolerant of hand-written quirks (alignment, comments, varied
// quoting) while reading exactly the fields the worker reasons about.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function extractFrontmatterBody(content) {
  const m = content.match(FRONTMATTER_RE);
  return m ? m[1] : null;
}

// Parse `key: value` scalar lines from a frontmatter body. Quotes are stripped.
// Blocks like `key:\n  - x\n  - y` and `key: [a, b]` get a list; anything else
// stays a string. This is enough for the four fields we need; richer YAML
// constructs (anchors, multiline scalars) are not supported.
function parseScalars(body) {
  const out = {};
  if (!body) return out;
  const lines = body.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const inline = m[2];

    if (inline === '') {
      // Possible indented list under this key.
      const list = [];
      let j = i + 1;
      while (j < lines.length) {
        const cur = lines[j];
        if (cur.trim() === '') { j++; continue; }
        const dash = cur.match(/^\s+-\s+(.*)$/);
        if (!dash) break;
        list.push(stripQuotes(stripInlineComment(dash[1]).trim()));
        j++;
      }
      if (list.length > 0) {
        out[key] = list;
        i = j - 1;
        continue;
      }
      out[key] = '';
      continue;
    }

    // Inline list `[a, b]` or scalar.
    if (inline.startsWith('[') && inline.endsWith(']')) {
      const inside = inline.slice(1, -1).trim();
      out[key] = inside === ''
        ? []
        : inside.split(',').map(s => stripQuotes(stripInlineComment(s).trim()));
      continue;
    }
    out[key] = coerce(stripQuotes(stripInlineComment(inline).trim()));
  }
  return out;
}

function stripQuotes(s) {
  if (typeof s !== 'string') return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// Strip a YAML inline comment from an unquoted scalar value: ` # …` to EOL.
// Preserves `#` inside single/double quoted strings (the quoted form is
// stripped first by stripQuotes; this runs on the unquoted residual).
// Without this, `sightings: 11  # bumped manually` parses as the string
// "11  # bumped manually", coerce() falls through, Number.isFinite is false,
// and the worker silently treats sightings as 0 — corrupting the next bump.
function stripInlineComment(s) {
  if (typeof s !== 'string') return s;
  // Quoted forms keep `#` literally; only strip on unquoted values.
  const t = s.trim();
  if (t.startsWith('"') || t.startsWith("'")) return s;
  const idx = s.indexOf(' #');
  if (idx < 0) return s;
  return s.slice(0, idx);
}

function coerce(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function nameFromFilename(filename) {
  // strip trailing `.md`
  return filename.replace(/\.md$/i, '');
}

async function loadOne(filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const body = extractFrontmatterBody(content);
  const fm = parseScalars(body);
  const name = nameFromFilename(path.basename(filePath));
  return {
    name,
    path: filePath,
    identifierStem: name,
    triggerPhrases: Array.isArray(fm.trigger_phrases) ? fm.trigger_phrases : [],
    sightings: Number.isFinite(fm.sightings) ? fm.sightings : 0,
    frontmatter: fm,
  };
}

/**
 * Load every `*.md` under `<memoryRoot>/patterns/<which>/`. Missing dir → [].
 *
 * @param {string} memoryRoot
 * @param {'active'|'reference'} which
 * @returns {Promise<Array<PatternDescriptor>>}
 */
export async function loadPatterns(memoryRoot, which) {
  if (which !== 'active' && which !== 'reference') {
    throw new Error(`loadPatterns: which must be 'active' or 'reference', got '${which}'`);
  }
  const dir = path.join(memoryRoot, 'patterns', which);
  let names;
  try {
    names = (await fs.readdir(dir)).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const desc = await loadOne(path.join(dir, n));
    if (desc) out.push(desc);
  }
  return out;
}

/**
 * Look up a single reference/ pattern by slug. Returns null if absent.
 * Used by promotion gating (canRePromote needs the reference frontmatter).
 */
export async function findReferenceFrontmatter(memoryRoot, slug) {
  const fp = path.join(memoryRoot, 'patterns', 'reference', `${slug}.md`);
  const desc = await loadOne(fp);
  return desc ? desc.frontmatter : null;
}

export const _internals = { parseScalars, stripInlineComment, FRONTMATTER_RE };
