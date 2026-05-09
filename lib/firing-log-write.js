// Wrap-up's library for writing per-session entries to pattern-firing-log.md.
// Spec: docs/pattern-firing-log-spec.md.
//
// Validates each entry against:
//   - § 4 four-outcome vocabulary  (applied | referenced | violated | not-referenced)
//   - § 5.2 identifier-or-trigger-phrase rule on every applied/referenced/violated
//   - § 5.4 evidence-line grep test (drops firings whose cited line does NOT contain
//     the rule identifier or a registered trigger phrase — the loophole the
//     2026-05-08 NotebookLM Agent OS audit flagged)
//
// Drops are returned as warnings (not thrown) so wrap-up can surface them in the
// session log alongside the kept firings. The dropped-firings list is the
// observability path for hallucinated classifier output.
//
// Idempotency: re-writing the same `session:` is a no-op. Caller is wrap-up,
// which may run twice on the same session in rare retry paths.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicAppend, atomicWrite } from './atomic-write.js';

export const VALID_OUTCOMES = new Set([
  'applied',
  'referenced',
  'violated',
  'not-referenced',
]);
const FIRING_OUTCOMES = new Set(['applied', 'referenced', 'violated']);

const FILE_HEADER = (consumer, today) =>
  `---
title: Pattern Firing Log
consumer: ${consumer}
schema_version: 1.0.0
created: ${today}
rotation: monthly-or-5000-lines
---

# Pattern Firing Log

Append-only. One YAML block per session. Read by \`/dream\` at 03:00 daily.
Schema: docs/pattern-firing-log-spec.md.

`;

// Read trigger_phrases from a pattern file's frontmatter. Empty array if absent
// or unreadable. Supports both block and inline list forms.
export async function readTriggerPhrases(patternsDir, ruleId) {
  const filePath = path.join(patternsDir, `${ruleId}.md`);
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n');
  if (lines[0] !== '---') return [];
  const fmEnd = lines.indexOf('---', 1);
  if (fmEnd === -1) return [];
  const fm = lines.slice(1, fmEnd);

  let inTriggers = false;
  const phrases = [];
  for (const l of fm) {
    if (/^trigger_phrases\s*:/.test(l)) {
      const inlineM = l.match(/^trigger_phrases\s*:\s*\[(.*)\]\s*$/);
      if (inlineM) {
        return inlineM[1]
          .split(',')
          .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
      }
      inTriggers = true;
      continue;
    }
    if (inTriggers) {
      const m = l.match(/^\s+-\s*(.+?)\s*$/);
      if (m) {
        phrases.push(m[1].replace(/^['"]|['"]$/g, ''));
        continue;
      }
      if (l.trim() !== '' && !l.startsWith(' ')) {
        // next top-level key — list ended
        inTriggers = false;
      }
    }
  }
  return phrases;
}

// Default allowed prefix for evidence paths. The spec's worked example only ever
// cites under session-logs/, and broadening that opens a hole where the
// classifier could "cite" any file in the repo to dodge the grep test.
const DEFAULT_EVIDENCE_PREFIX = 'session-logs/';

// Resolve evidence reference like "session-logs/2026-05-09.md#L142" relative to
// memoryRoot. Rejects absolute paths and any path that escapes memoryRoot via
// `..` so a hostile classifier cannot smuggle a citation pointing outside the
// session-log surface area. Returns null on any rejection or unresolved line.
export async function readEvidenceLine(memoryRoot, evidence, opts = {}) {
  const { evidencePrefix = DEFAULT_EVIDENCE_PREFIX } = opts;
  if (typeof evidence !== 'string') return null;
  const m = evidence.match(/^(.+?)#L(\d+)$/);
  if (!m) return null;
  const [, relPath, lineStr] = m;
  const lineNum = parseInt(lineStr, 10);
  if (!Number.isInteger(lineNum) || lineNum < 1) return null;

  if (path.isAbsolute(relPath)) return null;
  if (evidencePrefix && !relPath.startsWith(evidencePrefix)) return null;

  // Path-escape defense: resolve and verify the citation falls inside the
  // (memoryRoot + evidencePrefix) boundary, not just inside memoryRoot. The
  // string `session-logs/../patterns/active/rule-a.md` passes the prefix
  // startsWith check and resolves inside memoryRoot, but escapes session-logs/.
  const resolved = path.resolve(memoryRoot, relPath);
  const prefixRoot = evidencePrefix
    ? path.resolve(memoryRoot, evidencePrefix)
    : path.resolve(memoryRoot);
  if (!resolved.startsWith(prefixRoot + path.sep) && resolved !== prefixRoot) {
    return null;
  }

  let text;
  try {
    text = await fs.readFile(resolved, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  if (lineNum > lines.length) return null;
  return lines[lineNum - 1];
}

// Word-boundary check on the rule id within the evidence line. Substring match
// is too lax: with `caveman-check` ⊂ `caveman-check-on-reports`, the classifier
// could fabricate a firing for the shorter rule citing a line about the longer
// rule. We require id-token boundaries — neighbors must be non-[a-z0-9-] or
// the start/end of the line.
function ruleIdAppears(line, ruleId) {
  // Escape regex metacharacters in ruleId (kebab-case ids contain `-`, which
  // is also a regex literal, but inside a character class only at edges; the
  // RE2-like construction we use is safer to escape regardless).
  const escaped = ruleId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:[^a-z0-9-]|$)`, 'i').test(line);
}

// Verify a single firing per § 5.2 + § 5.4. Returns { ok, reason }.
export async function verifyFiring(firing, opts) {
  const { memoryRoot, patternsDir, evidencePrefix } = opts;

  if (!firing || typeof firing !== 'object') {
    return { ok: false, reason: 'invalid firing object' };
  }
  if (!VALID_OUTCOMES.has(firing.outcome)) {
    return { ok: false, reason: `invalid outcome: ${firing.outcome}` };
  }
  if (firing.outcome === 'not-referenced') {
    // not-referenced belongs in the entry's not_referenced array, not firings.
    return { ok: false, reason: 'not-referenced does not belong in firings array' };
  }
  if (!FIRING_OUTCOMES.has(firing.outcome)) {
    return { ok: false, reason: `unknown outcome: ${firing.outcome}` };
  }
  if (typeof firing.pattern !== 'string' || !firing.pattern) {
    return { ok: false, reason: 'pattern field missing' };
  }
  if (typeof firing.evidence !== 'string' || !firing.evidence) {
    return { ok: false, reason: 'evidence required for applied/referenced/violated' };
  }

  const evidenceLine = await readEvidenceLine(memoryRoot, firing.evidence, { evidencePrefix });
  if (evidenceLine === null) {
    return { ok: false, reason: `evidence line not resolvable: ${firing.evidence}` };
  }

  const ruleId = firing.pattern;
  if (ruleIdAppears(evidenceLine, ruleId)) return { ok: true };

  // Trigger phrases are author-declared, not classifier-fabricated, so a plain
  // substring match is safe enough — and matches the spec wording (§ 5.2).
  const triggers = await readTriggerPhrases(patternsDir, ruleId);
  for (const t of triggers) {
    if (t && evidenceLine.includes(t)) return { ok: true };
  }
  return {
    ok: false,
    reason: `evidence line does not contain rule id "${ruleId}" (word-boundary) or any trigger phrase`,
  };
}

// Minimal YAML scalar serializer: quotes strings that would parse ambiguously.
// We control the schema, so we only need correctness on the small alphabet of
// values that show up here (kebab IDs, paths, sentences, ints, bools).
function yamlScalar(s) {
  if (s === null || s === undefined) return '';
  if (typeof s === 'boolean' || typeof s === 'number') return String(s);
  const str = String(s);
  if (str === '') return '""';
  // Quote anything that could collide with YAML syntax. Includes:
  //   - flow / collection markers: [ ] { } ,
  //   - reserved indicators: ! & * ? - > | ' " %
  //   - whitespace at the boundary
  //   - newlines and colons / hashes anywhere
  if (/[:#\n[\]{},>|'"]|^[!&*?\-%@`>|]|^\s|\s$/.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

function renderEntry(entry) {
  const out = ['```yaml', '---'];
  out.push(`session: ${yamlScalar(entry.session)}`);
  if (entry.session_log) out.push(`session_log: ${yamlScalar(entry.session_log)}`);
  if (entry.project) out.push(`project: ${yamlScalar(entry.project)}`);
  if (entry.cwd) out.push(`cwd: ${yamlScalar(entry.cwd)}`);
  if (typeof entry.duration_min === 'number') {
    out.push(`duration_min: ${entry.duration_min}`);
  }

  out.push('pre_action_loaded_rules:');
  for (const r of entry.pre_action_loaded_rules || []) {
    out.push(`  - ${yamlScalar(r)}`);
  }

  out.push('firings:');
  for (const f of entry.firings || []) {
    out.push(`  - pattern: ${yamlScalar(f.pattern)}`);
    out.push(`    outcome: ${yamlScalar(f.outcome)}`);
    if (f.fired_at) out.push(`    fired_at: ${yamlScalar(f.fired_at)}`);
    if (f.evidence) out.push(`    evidence: ${yamlScalar(f.evidence)}`);
    if (f.detail) out.push(`    detail: ${yamlScalar(f.detail)}`);
    if (f.correction_filed !== undefined) {
      out.push(`    correction_filed: ${yamlScalar(f.correction_filed)}`);
    }
  }

  out.push('not_referenced:');
  for (const r of entry.not_referenced || []) {
    out.push(`  - ${yamlScalar(r)}`);
  }
  if (entry.note) out.push(`note: ${yamlScalar(entry.note)}`);

  out.push('---', '```', '');
  return out.join('\n');
}

// Acquire an exclusive lock for the entire write op (header init + dedup +
// append). Each acquisition writes a unique token; release only unlinks if the
// token in the file still matches ours, so a writer cannot accidentally clear
// someone else's lock after their own was reaped as stale.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_RETRIES = 200;

async function acquireWriteLock(logPath) {
  const lockPath = `${logPath}.write.lock`;
  const token = `${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`;

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    let fh = null;
    try {
      fh = await fs.open(lockPath, 'wx', 0o600);
      try {
        await fh.writeFile(`${token}\n`);
        await fh.close();
        return { token, lockPath };
      } catch (writeErr) {
        // Open succeeded but writeFile/close failed — clean up so we don't
        // leak the lock until the stale window elapses.
        await fh.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
        throw writeErr;
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale-lock detection: unlink only if (a) age > stale threshold AND
      // (b) we re-stat after a tiny pause and the mtime is unchanged. The
      // token-on-release check is the primary defense; this is the secondary.
      try {
        const stat1 = await fs.stat(lockPath);
        const age = Date.now() - stat1.mtimeMs;
        if (age > LOCK_STALE_MS) {
          await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY_MS));
          const stat2 = await fs.stat(lockPath).catch(() => null);
          if (stat2 && stat2.mtimeMs === stat1.mtimeMs) {
            await fs.unlink(lockPath).catch(() => {});
            continue;
          }
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue;
      }
      await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY_MS));
    }
  }
  throw new Error(`writeFiringLogEntry: could not acquire ${lockPath} after ${LOCK_MAX_RETRIES} attempts`);
}

async function releaseWriteLock(lock) {
  // Verify ownership before unlinking so a stale-reaped lock doesn't get
  // double-reaped. If our token isn't there, we no longer own it — leave the
  // file for the current owner.
  let owned = false;
  try {
    const content = await fs.readFile(lock.lockPath, 'utf8');
    owned = content.startsWith(lock.token);
  } catch {
    return; // already gone; nothing to release
  }
  if (owned) await fs.unlink(lock.lockPath).catch(() => {});
}

export async function writeFiringLogEntry(opts) {
  const {
    logPath,
    memoryRoot,
    patternsDir,
    consumer = 'unknown',
    today = new Date().toISOString().slice(0, 10),
    entry,
    evidencePrefix,
  } = opts;

  if (!logPath) throw new Error('writeFiringLogEntry: logPath required');
  if (!memoryRoot) throw new Error('writeFiringLogEntry: memoryRoot required');
  if (!entry || typeof entry !== 'object') {
    throw new Error('writeFiringLogEntry: entry object required');
  }
  if (!entry.session) throw new Error('writeFiringLogEntry: entry.session required');

  const declaredRules = new Set(entry.pre_action_loaded_rules || []);
  const droppedFirings = [];
  const keptFirings = [];
  const seen = new Set();

  for (const f of entry.firings || []) {
    // Reject firings whose pattern wasn't loaded in pre_action_loaded_rules:
    // a hallucinated rule that happens to grep against the session log can
    // still corrupt demotion / promotion / violation queries downstream.
    if (f && typeof f === 'object' && !declaredRules.has(f.pattern)) {
      droppedFirings.push({ firing: f, reason: 'pattern not in pre_action_loaded_rules' });
      continue;
    }
    const v = await verifyFiring(f, { memoryRoot, patternsDir, evidencePrefix });
    if (!v.ok) {
      droppedFirings.push({ firing: f, reason: v.reason });
      continue;
    }
    if (seen.has(f.pattern)) {
      // Multiple firings for the same pattern in a single session — keep the first
      // (most-severe outcome should be sequenced first by the classifier per spec).
      droppedFirings.push({ firing: f, reason: 'duplicate pattern in entry' });
      continue;
    }
    seen.add(f.pattern);
    keptFirings.push(f);
  }

  // Recompute not_referenced as declared rules minus rules that ended up with a
  // kept firing. The classifier's not_referenced array is treated as advisory.
  const computedNotRef = [];
  for (const r of declaredRules) {
    if (!seen.has(r)) computedNotRef.push(r);
  }

  const finalEntry = {
    ...entry,
    firings: keptFirings,
    not_referenced: computedNotRef,
  };

  // Acquire exclusive lock around header init + dedup + append.
  const lock = await acquireWriteLock(logPath);
  try {
    let exists = true;
    try {
      await fs.access(logPath);
    } catch {
      exists = false;
    }
    if (!exists) {
      await atomicWrite(logPath, FILE_HEADER(consumer, today));
    }

    // Idempotency: detect prior write of the same session and skip.
    const current = await fs.readFile(logPath, 'utf8');
    const sessionLine = `session: ${yamlScalar(entry.session)}`;
    if (current.includes(`\n${sessionLine}\n`)) {
      return {
        written: false,
        reason: 'session-already-recorded',
        session: entry.session,
        keptFirings: keptFirings.length,
        droppedFirings,
      };
    }

    // Append directly via atomic-write of the union — under our exclusive lock,
    // we don't need atomicAppend's own per-dest lock.
    await atomicWrite(logPath, current + renderEntry(finalEntry));

    return {
      written: true,
      session: entry.session,
      keptFirings: keptFirings.length,
      droppedFirings,
      notReferenced: computedNotRef,
    };
  } finally {
    await releaseWriteLock(lock);
  }
}
