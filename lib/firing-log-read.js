// Dream-side reader for pattern-firing-log.md (and rotated archives).
// Three queries the dream worker runs against the log:
//   demotionCandidates  — patterns absent from firings for N days  (§ 6.1)
//   promotionEvidence   — weighted firing evidence for a candidate (§ 6.2)
//   recurrentViolations — same (pattern, violated) ≥minCount window (§ 6.4)
//
// The log uses fenced ```yaml blocks (per spec § 3.1). We control the writer
// (firing-log-write.js), so a small purpose-built parser handles the closed
// schema deterministically without pulling in a YAML dep.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ENTRY_OPEN_RE = /^```yaml\s*$/;
const ENTRY_CLOSE_RE = /^```\s*$/;
const YAML_DOC_SEP = '---';

const FIRED_OUTCOMES = new Set(['applied', 'referenced', 'violated']);
const PROMOTION_OUTCOMES = new Set(['applied', 'violated']); // § 6.2: referenced too soft

function unquote(raw) {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  if (t === '') return '';
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  return t;
}

// Inline list: `key: []` or `key: [a, b, "c, d"]`. Returns array of unquoted
// scalars, or null if the input doesn't look like an inline list.
function parseInlineList(s) {
  const t = s.trim();
  if (t === '[]') return [];
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inside = t.slice(1, -1).trim();
  if (inside === '') return [];
  const out = [];
  let depth = 0, q = null, buf = '';
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i];
    if (q) {
      buf += c;
      if (c === q && inside[i - 1] !== '\\') q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; buf += c; continue; }
    if (c === '[' || c === '{') { depth++; buf += c; continue; }
    if (c === ']' || c === '}') { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) {
      out.push(unquote(buf));
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim() !== '') out.push(unquote(buf));
  return out;
}

// Parse one YAML-doc body (between --- markers) as written by firing-log-write.
// Strict-schema: top-level scalars (incl. inline lists) or `key:` followed by
// `  - …` indented list. List items may be plain scalars OR nested objects of
// `    key: value` lines. Throws on structural malformation; parseLogContent
// catches and surfaces via `onError`.
export function parseEntryYaml(text) {
  const lines = text.split('\n');
  const obj = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === YAML_DOC_SEP || line.trim() === '') { i++; continue; }
    const kvm = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!kvm) { i++; continue; }
    const key = kvm[1];
    const inline = kvm[2];

    if (inline !== '') {
      const inlineList = parseInlineList(inline);
      obj[key] = inlineList !== null ? inlineList : unquote(inline);
      i++;
      continue;
    }

    // Indented list of items follows. Skip blank lines inside the list body
    // so a hand-edit inserting a blank line doesn't truncate the parsed list.
    const list = [];
    i++;
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.trim() === '') { i++; continue; }
      const dashM = cur.match(/^\s\s-\s+(.*)$/);
      if (!dashM) {
        // Empty bullet "  - " (no value) — push '' and continue.
        if (/^\s\s-\s*$/.test(cur)) { list.push(''); i++; continue; }
        break;
      }

      const sub = dashM[1];
      const nestedKV = sub.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (!nestedKV) {
        list.push(unquote(sub));
        i++;
        continue;
      }

      const item = { [nestedKV[1]]: unquote(nestedKV[2]) };
      i++;
      while (i < lines.length) {
        const c2 = lines[i];
        if (c2.trim() === '') { i++; continue; }
        if (c2.startsWith('  -') || !c2.startsWith('    ')) break;
        const subKV = c2.match(/^\s{4}([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
        if (!subKV) {
          throw new Error(`malformed YAML continuation at line: ${c2}`);
        }
        item[subKV[1]] = unquote(subKV[2]);
        i++;
      }
      list.push(item);
    }
    obj[key] = list;
  }
  return obj;
}

export function parseLogContent(content, opts = {}) {
  const { onError = null } = opts;
  const lines = content.split('\n');
  const entries = [];
  let i = 0;

  while (i < lines.length) {
    if (!ENTRY_OPEN_RE.test(lines[i])) { i++; continue; }
    const blockStart = i;
    i++;
    const buf = [];
    while (i < lines.length && !ENTRY_CLOSE_RE.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    i++; // skip closing fence
    try {
      const entry = parseEntryYaml(buf.join('\n'));
      if (entry && entry.session) entries.push(entry);
    } catch (e) {
      // Malformed entry. Surface to caller so corruption is observable; default
      // is to drop the block from the result (queries see a clean view) but
      // an integrator (Stage A auditor) can wire an onError to FAIL the run.
      if (onError) onError({ blockStart, error: e.message });
    }
  }
  return entries;
}

// Read primary log and (optionally) rotated archives. Returned entries are
// unsorted; callers that care can sort by session-derived date.
// `onError`, if supplied, is called once per malformed YAML block so the
// auditor can surface corruption rather than have it silently disappear.
export async function readAllEntries(opts) {
  const { logPath, archiveDir = null, onError = null } = opts;
  const out = [];
  const parseOpts = { onError };

  try {
    const c = await fs.readFile(logPath, 'utf8');
    out.push(...parseLogContent(c, parseOpts));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (archiveDir) {
    let names = [];
    try {
      names = await fs.readdir(archiveDir);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const c = await fs.readFile(path.join(archiveDir, name), 'utf8');
      out.push(...parseLogContent(c, parseOpts));
    }
  }
  return out;
}

function entryDateMs(entry) {
  const m = String(entry.session || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? Date.parse(m[1]) : null;
}

function isWithin(entry, days, nowMs) {
  const d = entryDateMs(entry);
  if (d === null) return false;
  const ageMs = nowMs - d;
  return ageMs >= 0 && ageMs <= days * 86_400_000;
}

export function demotionCandidates(activePatterns, entries, opts = {}) {
  const { days = 60, now = Date.now() } = opts;
  const fired = new Set();
  for (const e of entries) {
    if (!isWithin(e, days, now)) continue;
    for (const f of e.firings || []) {
      if (FIRED_OUTCOMES.has(f.outcome)) fired.add(f.pattern);
    }
  }
  return activePatterns.filter(p => !fired.has(p));
}

export function promotionEvidence(candidate, entries, opts = {}) {
  const {
    days = 30,
    journalMentions = 0,
    firingLogWeight = 0.5,
    threshold = 3.0,
    now = Date.now(),
  } = opts;

  let firingHits = 0;
  for (const e of entries) {
    if (!isWithin(e, days, now)) continue;
    for (const f of e.firings || []) {
      if (!PROMOTION_OUTCOMES.has(f.outcome)) continue;
      if (f.pattern === candidate) { firingHits++; continue; }
      // § 6.2: also count the candidate concept appearing in fired_at / detail.
      const haystack = `${f.fired_at || ''} ${f.detail || ''}`;
      if (candidate && haystack.includes(candidate)) firingHits++;
    }
  }

  const weighted = journalMentions * 1.0 + firingHits * firingLogWeight;
  return {
    candidate,
    journalMentions,
    firingHits,
    firingLogWeight,
    weightedEvidence: weighted,
    threshold,
    passes: weighted >= threshold,
  };
}

export function recurrentViolations(entries, opts = {}) {
  const { days = 14, minCount = 2, now = Date.now() } = opts;
  const counts = new Map();
  const sources = new Map();

  for (const e of entries) {
    if (!isWithin(e, days, now)) continue;
    for (const f of e.firings || []) {
      if (f.outcome !== 'violated') continue;
      counts.set(f.pattern, (counts.get(f.pattern) || 0) + 1);
      if (!sources.has(f.pattern)) sources.set(f.pattern, []);
      sources.get(f.pattern).push({ session: e.session, evidence: f.evidence });
    }
  }

  const out = [];
  for (const [pattern, count] of counts) {
    if (count >= minCount) {
      out.push({ pattern, count, sources: sources.get(pattern) });
    }
  }
  return out;
}
