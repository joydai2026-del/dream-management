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
import { atomicWrite } from '../atomic-write.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mirror the auditor's archive-policy taxonomy. The sweep uses these to
// classify staged files; the auditor uses them for conservation; the
// classifier output's `kind` field is for sweep ordering.
const ARCHIVE_PREFIXES = ['archive/'];

function posix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function readBufIfExists(abs) {
  try { return await fs.readFile(abs); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function readIfExists(abs) {
  try { return await fs.readFile(abs, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
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

  for (const stagedRel of rels) {
    if (stagedRel.endsWith('.preimage-sha256')) {
      sidecars.push(stagedRel);
      continue;
    }
    if (stagedRel.endsWith('.tmp')) {
      const logicalRel = stagedRel.slice(0, -'.tmp'.length);
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
 * Pre-flight: for every archive .tmp, read its sidecar and verify the live
 * archive's current sha matches. Returns conflicts list — empty means
 * sweep is safe to proceed; non-empty means abort.
 */
export async function verifyAllSidecars({ memoryRoot, stagedRoot, archives }) {
  const conflicts = [];
  for (const a of archives) {
    if (!a.sidecarRel) {
      conflicts.push({
        path: a.logicalRel,
        reason: 'missing sidecar (sweep refuses to overwrite without preimage proof)',
      });
      continue;
    }
    const sidecarRaw = await readIfExists(path.join(stagedRoot, a.sidecarRel));
    if (sidecarRaw === null) {
      conflicts.push({
        path: a.logicalRel,
        reason: 'sidecar file missing at sweep time',
      });
      continue;
    }
    let sidecar;
    try { sidecar = JSON.parse(sidecarRaw); }
    catch (e) {
      conflicts.push({ path: a.logicalRel, reason: `sidecar parse error: ${e.message}` });
      continue;
    }
    const liveBuf = await readBufIfExists(path.join(memoryRoot, a.logicalRel));
    if (sidecar.sha256 === null) {
      // Stage said "no live archive at stage time". If one exists now, abort.
      if (liveBuf !== null) {
        conflicts.push({
          path: a.logicalRel,
          reason: 'sidecar declares absent at stage but live exists at sweep time',
        });
      }
      continue;
    }
    if (typeof sidecar.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sidecar.sha256)) {
      conflicts.push({
        path: a.logicalRel,
        reason: `sidecar sha256 malformed: ${JSON.stringify(sidecar.sha256)}`,
      });
      continue;
    }
    if (liveBuf === null) {
      conflicts.push({
        path: a.logicalRel,
        reason: 'sidecar declares sha but live archive missing at sweep time',
      });
      continue;
    }
    if (sha256(liveBuf) !== sidecar.sha256) {
      conflicts.push({
        path: a.logicalRel,
        reason: 'live archive sha drifted between stage and sweep (concurrent writer?)',
      });
    }
  }
  return conflicts;
}

/**
 * POSIX-atomic rename, with parent-mkdir.
 */
async function atomicRenameInto(stagedAbs, liveAbs) {
  await fs.mkdir(path.dirname(liveAbs), { recursive: true });
  await fs.rename(stagedAbs, liveAbs);
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

  if (dryRun) return result;

  // STEP 2: archives first (leaf-first per § 2.1).
  for (const a of classified.archives) {
    try {
      await atomicRenameInto(
        path.join(stagedRoot, a.stagedRel),
        path.join(memoryRoot, a.logicalRel),
      );
      result.swept.push(a.logicalRel);
    } catch (e) {
      result.errors.push({ phase: 'archives', path: a.logicalRel, error: e.message });
    }
  }

  // STEP 3: source rewrites.
  for (const s of classified.sources) {
    try {
      await atomicRenameInto(
        path.join(stagedRoot, s.stagedRel),
        path.join(memoryRoot, s.logicalRel),
      );
      result.swept.push(s.logicalRel);
    } catch (e) {
      result.errors.push({ phase: 'sources', path: s.logicalRel, error: e.message });
    }
  }

  // STEP 4: tombstones (delete live targets). After source renames so a
  // source-and-tombstone overlap (rare, would be a worker bug) commits the
  // source first; the tombstone then deletes a fresh file. Phase-3 + Phase-2
  // never produce that combination, but the ordering is defensive.
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
    }
  }

  // STEP 5: cleanup. Remove the sidecars + the staged tree. We don't
  // remove `staged/` itself; we remove its contents so the dir is left
  // behind for diagnostic continuity (matches archive-schema § 2.4 lifecycle).
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
  // line in place.
  const dlePath = path.join(dreamDir, 'dream-log-entry.md');
  const dle = await readIfExists(dlePath);
  if (dle !== null) {
    const updated = dle.replace(
      /^## (\d{4}-\d{2}-\d{2}) [A-Z-]+/m,
      `## $1 ${finalVerdict}`,
    );
    // Append a one-line auditor footer that captures the verdict + counts.
    const footer = [
      '',
      '---',
      `**Stage A**: ${stageA.verdict} (${(stageA.findings || []).length} findings)`,
      `**Stage B**: ${stageB.verdict} (${(stageB.findings || []).length} findings, model=${stageB.model || 'n/a'})`,
      sweep
        ? `**Sweep**: aborted=${sweep.aborted ? 'true' : 'false'} swept=${(sweep.swept || []).length} deleted=${(sweep.deleted || []).length} conflicts=${(sweep.conflicts || []).length}`
        : '**Sweep**: not run',
      '',
    ].join('\n');
    await atomicWrite(dlePath, updated + footer);
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
