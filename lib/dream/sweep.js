// Sweep step — Phase 5 commit barrier.
//
// Per atomicity-contract.md § 2 (steps 8-11) + § 5 (audit-then-commit
// ordering). Runs ONLY after Stage A + Stage B both PASS. Renames every
// staged `.tmp` onto its live path (leaf-first), honors `.tombstone`
// sidecars by deleting the matching live file, and refuses to commit any
// archive append whose preimage sha no longer matches live (defense-in-
// depth — Stage A already verified, but a process pause + concurrent
// writer between audit and sweep is theoretically possible).
//
// Sweep ordering (atomicity-contract § 2.1):
//   1. PRE-FLIGHT: walk staged tree, classify, verify ALL preimage sidecars
//      vs live archive sha. ANY mismatch → abort sweep with conflicts list;
//      no rename has happened yet, live tree is untouched.
//   2. ARCHIVES FIRST (leaf-first): rename every staged
//      `archive/<…>/<file>.md.tmp` → live `archive/<…>/<file>.md`. A crash
//      here leaves duplicate content (still in source + now in archive) —
//      conservatively-valid per § 2.1.
//   3. SOURCES NEXT: rename every staged hot/warm-tier `.tmp` onto live.
//      Source rewrites have no sidecar by design — sources travel through
//      the staged tree because they're consumed by Phase-4 sweeps, not
//      appended-to.
//   4. TOMBSTONES: for each `<rel>.tombstone`, delete live `<rel>` (no-op
//      when target_missing was true at stage time, or when the file is
//      already gone). Tombstones run AFTER source renames so a tombstone
//      for a path that overlaps a staged source can't run before the source
//      is committed.
//   5. CLEANUP: remove `archive/dreams/<date>/staged/` after all renames
//      land. The dream-log success line is appended via runSweep's caller
//      (CLI / finalizeAuditVerdicts) so it can include the sweep's actual
//      counts.
//
// Idempotency: a partial sweep (crash between archives done + sources still
// staged) is safe to re-enter. POSIX rename consumes the .tmp; re-sweep
// skips already-renamed entries naturally because their .tmp is gone.
//
// Read-only on Stage A/B failure: when audits FAIL, runSweep is NOT called
// at all. The CLI inspects audit verdicts and calls a separate
// `finalizeAuditVerdicts` (also exported here) to update event.json with
// the FAIL verdict + findings + abort marker.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, atomicMove } from '../atomic-write.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mirror the auditor's archive-policy taxonomy. The sweep uses these to
// classify staged files; the auditor uses them for conservation; the
// classifier output's `kind` field is for sweep ordering.
const ARCHIVE_PREFIXES = ['archive/'];

function posix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function readBufIfExists(abs) {
  // Treat any "not a readable file" condition as null. A live path that's a
  // directory (EISDIR), a symlink loop (ELOOP), or otherwise unreadable for
  // the verifier doesn't crash the sweep; it surfaces via downstream
  // sidecar-comparison logic ("sidecar declares sha but live archive
  // missing"). EACCES bubbles up so a real permission misconfig is loud.
  try { return await fs.readFile(abs); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

async function readIfExists(abs) {
  try { return await fs.readFile(abs, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

async function fileExists(abs) {
  try { await fs.access(abs); return true; } catch { return false; }
}

async function walkRel(rootAbs) {
  const out = [];
  async function recurse(dir, prefix) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // sweep refuses symlinks (auditor surfaces)
      if (entry.isDirectory()) await recurse(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await recurse(rootAbs, '');
  return out.sort();
}

/**
 * Walk `<dreamDir>/staged/` and partition into archives, sources, and
 * tombstones. Sidecars (`.preimage-sha256`) live alongside archives and
 * are not promoted to live (they stay in staged/ and are deleted with the
 * staged tree at sweep cleanup time).
 *
 * @returns {{
 *   archives: Array<{ stagedRel, logicalRel, sidecarRel | null }>,
 *   sources:  Array<{ stagedRel, logicalRel }>,
 *   tombstones: Array<{ stagedRel, logicalRel }>,
 *   sidecars: string[],            // staged-relative sidecar paths
 *   sweepable: boolean,            // false if any structural error found
 *   issues: Array<{ severity, message, path? }>,
 * }}
 */
export async function classifyStaged(stagedRoot) {
  const archives = [];
  const sources = [];
  const tombstones = [];
  const sidecars = [];
  const issues = [];

  let rels;
  try { rels = await walkRel(stagedRoot); }
  catch (e) {
    issues.push({ severity: 'fail', message: `walk staged failed: ${e.message}` });
    return { archives, sources, tombstones, sidecars, sweepable: false, issues };
  }

  // BR-3: reject any logicalRel that contains `..` segments. walkRel itself
  // can't produce them (the prefix is built from `entry.name` which is a
  // single path component), but the logicalRel is what gets joined onto
  // memoryRoot at rename/unlink time, so a defense-in-depth check here
  // closes any future regression where a worker stages an exotic name.
  function isUnsafeLogical(rel) {
    return rel.split('/').some(s => s === '..' || s === '');
  }

  for (const stagedRel of rels) {
    if (stagedRel.endsWith('.preimage-sha256')) {
      sidecars.push(stagedRel);
      continue;
    }
    if (stagedRel.endsWith('.tmp')) {
      const logicalRel = stagedRel.slice(0, -'.tmp'.length);
      if (isUnsafeLogical(logicalRel)) {
        issues.push({
          severity: 'fail',
          message: `staged path contains '..' or empty segment: ${stagedRel}`,
          path: stagedRel,
        });
        continue;
      }
      const sidecarRel = `${stagedRel}.preimage-sha256`;
      const isArchive = ARCHIVE_PREFIXES.some(p => logicalRel.startsWith(p));
      if (isArchive) {
        archives.push({ stagedRel, logicalRel, sidecarRel });
      } else {
        sources.push({ stagedRel, logicalRel });
      }
      continue;
    }
    if (stagedRel.endsWith('.tombstone')) {
      const logicalRel = stagedRel.slice(0, -'.tombstone'.length);
      if (isUnsafeLogical(logicalRel)) {
        issues.push({
          severity: 'fail',
          message: `staged tombstone path contains '..' or empty segment: ${stagedRel}`,
          path: stagedRel,
        });
        continue;
      }
      // F3: tombstones MUST NOT target archive/* paths. Archives are
      // append-only per archive-schema.md § 4.4; deletion is a structural
      // contract violation. The Stage A C10 check rejects this upstream;
      // sweep enforces as the last line of defense.
      if (ARCHIVE_PREFIXES.some(p => logicalRel.startsWith(p))) {
        issues.push({
          severity: 'fail',
          message: `tombstone targets append-only archive path: ${logicalRel}`,
          path: stagedRel,
        });
        continue;
      }
      tombstones.push({ stagedRel, logicalRel });
      continue;
    }
    // Anything else under staged/ is unexpected (sweep wouldn't know what
    // to do with it). Flag but don't fail.
    issues.push({
      severity: 'warn',
      message: `unrecognized staged file (no .tmp/.tombstone/.preimage-sha256 suffix): ${stagedRel}`,
      path: stagedRel,
    });
  }

  // BR-5 (R2-revised): orphan preimage sidecars (no matching .tmp) are
  // SURFACED but as WARN. A FAIL here would block partial-sweep restart
  // because runSweep deletes sidecars per-rename now (R2 BR-5 fix in
  // runSweep) — but a crash AFTER rename and BEFORE sidecar unlink can
  // still leave one. Better: treat orphan sidecars as cleanup-needed
  // metadata. The sweep's STEP 5 cleanup pass removes them; if they
  // somehow persist past that, a future run should not block on them.
  //
  // Spoof defense: sweep refuses any archive without a matching sidecar
  // (verifyAllSidecars), so an attacker writing a fake sidecar without
  // a .tmp accomplishes nothing — there's no archive .tmp to overwrite.
  const archiveTmpSet = new Set(archives.map(a => a.stagedRel));
  for (const sc of sidecars) {
    const expectedTmp = sc.slice(0, -'.preimage-sha256'.length); // includes .tmp
    if (!archiveTmpSet.has(expectedTmp)) {
      issues.push({
        severity: 'warn',
        message: `orphan preimage sidecar (no matching .tmp; will be cleaned up): ${sc}`,
        path: sc,
      });
    }
  }

  return {
    archives,
    sources,
    tombstones,
    sidecars,
    sweepable: !issues.some(i => i.severity === 'fail'),
    issues,
  };
}

/**
 * Verify a single archive sidecar against live. Returns conflict object on
 * failure, null on success. Used by both verifyAllSidecars (pre-flight) and
 * the per-rename re-verify in runSweep (F1 TOCTOU shrink).
 */
export async function verifyOneSidecar({ memoryRoot, stagedRoot, archive }) {
  const a = archive;
  if (!a.sidecarRel) {
    return {
      path: a.logicalRel,
      reason: 'missing sidecar (sweep refuses to overwrite without preimage proof)',
    };
  }
  const sidecarRaw = await readIfExists(path.join(stagedRoot, a.sidecarRel));
  if (sidecarRaw === null) {
    return { path: a.logicalRel, reason: 'sidecar file missing at sweep time' };
  }
  let sidecar;
  try { sidecar = JSON.parse(sidecarRaw); }
  catch (e) {
    return { path: a.logicalRel, reason: `sidecar parse error: ${e.message}` };
  }
  const liveBuf = await readBufIfExists(path.join(memoryRoot, a.logicalRel));
  if (sidecar.sha256 === null) {
    if (liveBuf !== null) {
      return {
        path: a.logicalRel,
        reason: 'sidecar declares absent at stage but live exists at sweep time',
      };
    }
    return null;
  }
  if (typeof sidecar.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sidecar.sha256)) {
    return {
      path: a.logicalRel,
      reason: `sidecar sha256 malformed: ${JSON.stringify(sidecar.sha256)}`,
    };
  }
  if (liveBuf === null) {
    return {
      path: a.logicalRel,
      reason: 'sidecar declares sha but live archive missing at sweep time',
    };
  }
  if (sha256(liveBuf) !== sidecar.sha256) {
    return {
      path: a.logicalRel,
      reason: 'live archive sha drifted between stage and sweep (concurrent writer?)',
    };
  }
  return null;
}

/**
 * Pre-flight: for every archive .tmp, read its sidecar and verify the live
 * archive's current sha matches. Returns conflicts list — empty means
 * sweep is safe to proceed; non-empty means abort.
 */
export async function verifyAllSidecars({ memoryRoot, stagedRoot, archives }) {
  const conflicts = [];
  for (const a of archives) {
    const c = await verifyOneSidecar({ memoryRoot, stagedRoot, archive: a });
    if (c) conflicts.push(c);
  }
  return conflicts;
}

/**
 * Cross-fs-safe atomic rename with parent-mkdir. Uses atomicMove (lib/atomic-write.js)
 * which falls back to copy+fsync+unlink on EXDEV (rare: memoryRoot and
 * dreamDir on different mounts). BR-2 fix: prior implementation used raw
 * fs.rename which threw on EXDEV; runSweep then continued through later
 * phases and could delete sources via tombstones while archive .tmp's never
 * landed — violating the "duplicated, not lost" barrier per § 2.1.
 */
async function atomicRenameInto(stagedAbs, liveAbs) {
  await atomicMove(stagedAbs, liveAbs);
}

/**
 * Execute the sweep. Caller MUST verify Stage A + Stage B PASS before
 * invocation; this module does NOT re-run audits beyond the preimage
 * sidecar check.
 *
 * @param {object} opts
 * @param {string} opts.memoryRoot
 * @param {string} opts.dreamDir       archive/dreams/<date>/
 * @param {string} opts.today          YYYY-MM-DD
 * @param {boolean} [opts.dryRun=false] when true: classify + verify
 *                                       sidecars, but do not rename / delete
 * @returns {Promise<{
 *   swept: string[],          // logical rels renamed onto live
 *   deleted: string[],        // logical rels removed via tombstone
 *   conflicts: Array,         // sidecar mismatches (sweep aborted if non-empty)
 *   errors: Array,            // rename / unlink failures (post-pre-flight)
 *   aborted: boolean,
 *   dryRun: boolean,
 *   issues: Array,            // structural classification issues
 * }>}
 */
export async function runSweep(opts) {
  const { memoryRoot, dreamDir, today, dryRun = false } = opts || {};
  if (!memoryRoot) throw new Error('runSweep: memoryRoot required');
  if (!dreamDir) throw new Error('runSweep: dreamDir required');
  if (!today) throw new Error('runSweep: today required');
  if (!ISO_DATE_RE.test(today)) {
    throw new Error(`runSweep: today must match YYYY-MM-DD; got '${today}'`);
  }
  const stagedRoot = path.join(dreamDir, 'staged');
  const result = {
    swept: [], deleted: [], conflicts: [], errors: [],
    aborted: false, dryRun, issues: [],
  };

  if (!(await fileExists(stagedRoot))) {
    // Nothing to sweep. Treat as a no-op success (idempotent re-run after a
    // prior successful sweep that already cleaned staged/).
    return result;
  }

  const classified = await classifyStaged(stagedRoot);
  result.issues = classified.issues;
  if (!classified.sweepable) {
    result.aborted = true;
    return result;
  }

  // PRE-FLIGHT: sidecar verification across ALL archives at once. Any
  // conflict aborts the sweep before any rename happens.
  result.conflicts = await verifyAllSidecars({
    memoryRoot, stagedRoot, archives: classified.archives,
  });
  if (result.conflicts.length > 0) {
    result.aborted = true;
    return result;
  }

  // BR-7 (worker-bug guard): if a tombstone targets the same logicalRel as
  // a staged source rewrite, abort. The two are mutually exclusive per
  // Phase-2/3 contracts; an overlap would mean source→tombstone or
  // tombstone→source ordering becomes ambiguous, and either choice loses
  // information. Surface and abort rather than silently apply one ordering.
  const sourceLogicals = new Set(classified.sources.map(s => s.logicalRel));
  for (const t of classified.tombstones) {
    if (sourceLogicals.has(t.logicalRel)) {
      result.aborted = true;
      result.issues.push({
        severity: 'fail',
        message: `worker bug: tombstone overlaps source rewrite at ${t.logicalRel} (must be mutually exclusive)`,
        path: t.logicalRel,
      });
    }
  }
  if (result.aborted) return result;

  if (dryRun) return result;

  // STEP 2: archives first (leaf-first per § 2.1). BR-1 (R2-tightened):
  // TRUE break-on-first-error — abort the loop AND return immediately when
  // any archive rename fails. Prior R1 fix used a post-loop check, which
  // let later renames in the same phase commit even though earlier ones
  // failed. Phase B Codex R2 reproduced this with a tombstone phase
  // example.
  //
  // F1 (per-rename re-verify): re-verify the sidecar's preimage sha against
  // the live archive immediately before the rename, shrinking the TOCTOU
  // window from "all archives" (pre-flight) down to "one rename + the
  // brief read→rename gap." A truly atomic compare-and-swap requires the
  // dream-worker .dream.lock to exclude concurrent writers (wrap-up,
  // memory-loader). The lock contract from phase-0-safety.js IS the
  // outer guarantee; this re-verify is defense-in-depth, not the primary
  // mutex.
  //
  // BR-5 fix (R2): delete each archive's sidecar IMMEDIATELY after its
  // rename succeeds, not at end-of-sweep. Otherwise a partial-commit
  // crash leaves orphan sidecars that block the next sweep restart
  // (classifyStaged would flag them as fail).
  for (const a of classified.archives) {
    const conflict = await verifyOneSidecar({
      memoryRoot, stagedRoot, archive: a,
    });
    if (conflict) {
      result.conflicts.push(conflict);
      result.aborted = true;
      return result;
    }
    try {
      await atomicRenameInto(
        path.join(stagedRoot, a.stagedRel),
        path.join(memoryRoot, a.logicalRel),
      );
      result.swept.push(a.logicalRel);
      // Drop the sidecar now that its archive committed. Best-effort:
      // ENOENT is benign (e.g., it never existed), other errors don't
      // fail the sweep — they're cosmetic at this point.
      if (a.sidecarRel) {
        try { await fs.unlink(path.join(stagedRoot, a.sidecarRel)); }
        catch (e) { if (e.code !== 'ENOENT') {
          result.errors.push({ phase: 'archives-cleanup', path: a.sidecarRel, error: e.message });
        } }
      }
    } catch (e) {
      result.errors.push({ phase: 'archives', path: a.logicalRel, error: e.message });
      result.aborted = true;
      return result; // BR-1: TRUE break-on-first-error
    }
  }

  // STEP 3: source rewrites. Same break-on-first-error rule.
  for (const s of classified.sources) {
    try {
      await atomicRenameInto(
        path.join(stagedRoot, s.stagedRel),
        path.join(memoryRoot, s.logicalRel),
      );
      result.swept.push(s.logicalRel);
    } catch (e) {
      result.errors.push({ phase: 'sources', path: s.logicalRel, error: e.message });
      result.aborted = true;
      return result;
    }
  }

  // STEP 4: tombstones (delete live targets). After source renames so a
  // source-and-tombstone overlap (already aborted above) is impossible by
  // the time we reach here.
  for (const t of classified.tombstones) {
    try {
      const liveAbs = path.join(memoryRoot, t.logicalRel);
      try { await fs.unlink(liveAbs); }
      catch (e) {
        // ENOENT is fine — the sweep is idempotent. Anything else surfaces.
        if (e.code !== 'ENOENT') throw e;
      }
      result.deleted.push(t.logicalRel);
    } catch (e) {
      result.errors.push({ phase: 'tombstones', path: t.logicalRel, error: e.message });
      result.aborted = true;
      return result;
    }
  }

  // STEP 5: cleanup. Only on full success — preserve staged/ on any
  // failure so partial-commit recovery has the evidence it needs.
  for (const sc of classified.sidecars) {
    try { await fs.unlink(path.join(stagedRoot, sc)); }
    catch (e) {
      if (e.code !== 'ENOENT') {
        result.errors.push({ phase: 'cleanup', path: sc, error: e.message });
      }
    }
  }
  // Remove empty subdirs left under staged/. fs.rm with force ignores ENOENT.
  try {
    await fs.rm(stagedRoot, { recursive: true, force: true });
  } catch (e) {
    result.errors.push({ phase: 'cleanup', path: 'staged/', error: e.message });
  }

  return result;
}

/**
 * After Stage A + Stage B + sweep, update event.json's audit fields and
 * re-emit dream-log-entry.md so the verdict reflects the final outcome.
 *
 * Atomicity: writes go through atomicWrite. event.json is a single file; the
 * dream-log-entry.md sits in archive/dreams/<date>/ (cold-tier; not on the
 * sweep critical path). The CALLER is responsible for appending a final
 * line to live `.dream-log.md` — that file's content is staged by Phase 5
 * during the staged-tree write and gets renamed onto live by the sweep.
 *
 * @param {object} opts
 * @param {string} opts.dreamDir
 * @param {string} opts.finalVerdict       'PASS' | 'WARN' | 'FAIL'
 * @param {object} opts.stageA             { verdict, findings, summary }
 * @param {object} opts.stageB             { verdict, findings, summary, model }
 * @param {object} [opts.sweep]            runSweep result (counts swept etc.)
 * @returns {Promise<{eventJsonPath, dreamLogEntryPath}>}
 */
export async function finalizeAuditVerdicts(opts) {
  const { dreamDir, finalVerdict, stageA, stageB, sweep } = opts || {};
  if (!dreamDir) throw new Error('finalizeAuditVerdicts: dreamDir required');
  if (!finalVerdict) throw new Error('finalizeAuditVerdicts: finalVerdict required');
  if (!['PASS', 'WARN', 'FAIL'].includes(finalVerdict)) {
    throw new Error(`finalizeAuditVerdicts: finalVerdict must be PASS|WARN|FAIL; got ${finalVerdict}`);
  }
  if (!stageA) throw new Error('finalizeAuditVerdicts: stageA required');
  if (!stageB) throw new Error('finalizeAuditVerdicts: stageB required');

  const eventJsonPath = path.join(dreamDir, 'event.json');
  const eventRaw = await readIfExists(eventJsonPath);
  if (eventRaw === null) {
    throw new Error(`finalizeAuditVerdicts: event.json not found at ${eventJsonPath}`);
  }
  let event;
  try { event = JSON.parse(eventRaw); }
  catch (e) {
    throw new Error(`finalizeAuditVerdicts: event.json parse error: ${e.message}`);
  }

  event.verdict = finalVerdict;
  event.audit = event.audit || {};
  event.audit.stage_a = {
    verdict: stageA.verdict,
    findings: stageA.findings || [],
    summary: stageA.summary || null,
  };
  event.audit.stage_b = {
    verdict: stageB.verdict,
    findings: stageB.findings || [],
    summary: stageB.summary || null,
    model: stageB.model || null,
  };
  if (sweep) {
    event.audit.sweep = {
      swept_count: (sweep.swept || []).length,
      deleted_count: (sweep.deleted || []).length,
      conflicts: sweep.conflicts || [],
      errors: sweep.errors || [],
      aborted: Boolean(sweep.aborted),
    };
  }
  await atomicWrite(eventJsonPath, JSON.stringify(event, null, 2) + '\n');

  // Re-emit dream-log-entry.md with the final verdict header. The Phase-5
  // renderer wrote it with verdict=PASS-TENTATIVE; we rewrite the heading
  // line in place. BR-4: anchor the verdict token so we don't get the
  // `## 2026-05-09 Pass` → `## 2026-05-09 FAILass` corruption (partial
  // match left the suffix). Also THROW if the heading isn't matched —
  // silent no-op + footer-append produced an inconsistent file.
  const dlePath = path.join(dreamDir, 'dream-log-entry.md');
  const dle = await readIfExists(dlePath);
  if (dle !== null) {
    // Tolerate any whitespace between date and verdict, anchor the verdict
    // as the entire token (whole word), require end-of-line. Verdict tokens
    // observed in renderDreamLogEntry: PASS, WARN, FAIL, PASS-TENTATIVE.
    const headingRe = /^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]+([A-Z][A-Z-]*)[ \t]*$/m;
    const m = dle.match(headingRe);
    if (!m) {
      throw new Error(
        `finalizeAuditVerdicts: dream-log-entry.md heading did not match expected shape '## YYYY-MM-DD <VERDICT>'. Refusing silent no-op.`,
      );
    }
    const updated = dle.replace(headingRe, `## $1 ${finalVerdict}`);
    // F4 (R2-revised): idempotent footer with strict sentinel hygiene.
    //
    // Prior R1 fix anchored the regex to end-of-string ($), which broke
    // when a user appended manual notes AFTER the footer (footer got
    // duplicated). Drop the $ anchor, and validate sentinel count: 0 or
    // 1 pair is acceptable; anything else indicates hand-edit corruption
    // and we throw rather than silently mishandle.
    const FOOTER_START = '<!-- DREAM-AUDIT-FOOTER-START -->';
    const FOOTER_END = '<!-- DREAM-AUDIT-FOOTER-END -->';
    const startCount = (updated.match(new RegExp(escapeRegExp(FOOTER_START), 'g')) || []).length;
    const endCount = (updated.match(new RegExp(escapeRegExp(FOOTER_END), 'g')) || []).length;
    if (startCount !== endCount || startCount > 1) {
      throw new Error(
        `finalizeAuditVerdicts: dream-log-entry.md sentinel count mismatch (start=${startCount} end=${endCount}); refuse silent corruption — repair the file by hand`,
      );
    }
    const footer = [
      '',
      FOOTER_START,
      '',
      '---',
      `**Stage A**: ${stageA.verdict} (${(stageA.findings || []).length} findings)`,
      `**Stage B**: ${stageB.verdict} (${(stageB.findings || []).length} findings, model=${stageB.model || 'n/a'})`,
      sweep
        ? `**Sweep**: aborted=${sweep.aborted ? 'true' : 'false'} swept=${(sweep.swept || []).length} deleted=${(sweep.deleted || []).length} conflicts=${(sweep.conflicts || []).length}`
        : '**Sweep**: not run',
      '',
      FOOTER_END,
      '',
    ].join('\n');
    let trimmed;
    if (startCount === 1) {
      // Replace the existing footer block in place (no $ anchor — works
      // even when manual content follows). Captures any leading newlines
      // adjacent to the START sentinel.
      const sentinelRe = new RegExp(
        `\\n*${escapeRegExp(FOOTER_START)}[\\s\\S]*?${escapeRegExp(FOOTER_END)}\\n*`,
      );
      trimmed = updated.replace(sentinelRe, '\n');
    } else {
      // No prior footer; append after content (trim any trailing whitespace).
      trimmed = updated.replace(/\s*$/, '');
    }
    await atomicWrite(dlePath, trimmed + footer);
  }

  return { eventJsonPath, dreamLogEntryPath: dlePath };
}

export const _internals = {
  ARCHIVE_PREFIXES,
  posix,
  sha256,
  walkRel,
  atomicRenameInto,
};
