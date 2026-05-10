// Phase-3 PRUNE: produce a plan that consolidates the warm/hot tier and
// stages it under archive/dreams/<date>/staged/.
//
// Per ARCHITECTURE.md § 3.2 Phase 3, the worker:
//   - corrections.md      → archive RESOLVED entries older than `correctionsTtlDays`
//   - session-index.md    → keep the most-recent `sessionIndexKeepLastN`,
//                           archive the rest grouped by ISO month
//   - learning-journals/  → today's journal moves to archive/journals/<YYYY-MM>/
//   - patterns/active/    → demote any pattern with zero firings in
//                           `demotionLookbackDays` (firing-log read)
//
// Per docs/atomicity-contract.md § 2: staging only. No live mutation. The P5
// audit + sweep step is what actually moves the staged tree onto disk. Move-
// style mutations (journal archival, pattern demotion) emit a JSON tombstone
// in the staged tree so the sweep step knows which live files to delete.
//
// The classifier helpers (lib/corrections-ttl.js#classifyCorrections,
// lib/session-index-tier.js#classifySessionIndex) are pure-data and reused
// directly. The wrap-up versions of those modules write to live; we don't
// call those — we re-stage the same logical mutation into the dream tree.

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWrite } from '../atomic-write.js';
import { serializeBlocks } from '../parse-md-blocks.js';
import { classifyCorrections } from '../corrections-ttl.js';
import { classifySessionIndex } from '../session-index-tier.js';
import { demotionCandidates } from '../firing-log-read.js';
import { validateDemotionPhase } from './bootstrap-guard.js';
import { loadPatterns } from './load-patterns.js';

const DEFAULT_GATES = {
  correctionsTtlDays: 30,
  sessionIndexKeepLastN: 10,
  demotionLookbackDays: 60,
  // Grace period: a freshly-promoted pattern needs at least this many days of
  // existence before the demotion gate considers it. Default = lookback days
  // so a pattern is only demoted when it has had a full lookback window of
  // observable inactivity. Without this, a pattern promoted yesterday (0
  // firings yet) would be demoted on the next dream pass — undoing P4 #6
  // auto-promotion the day after it ships. (Code-reviewer R1 must-fix #2.)
  demotionGracePeriodDays: 60,
};

const TOMBSTONE_SCHEMA_VERSION = '1.0.0';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POSIX-form path: forward slashes only. Tombstones travel as JSON across
// machines and the sweep step compares paths textually; lock the form so a
// Windows-side path.join doesn't produce backslashes that fail the compare.
// Replace `\` regardless of `path.sep` so a value passed in from a Windows
// caller is normalized even when this module runs on POSIX.
function posix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FRONTMATTER_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

/**
 * Add or replace a single scalar field inside the frontmatter block. Same
 * shape as stage-route.js#bumpField but scoped to this module to avoid
 * cross-module coupling: the two helpers diverge subtly (this one has no
 * comment-preservation requirement because demotion fields are not
 * hand-curated).
 */
function setFrontmatterField(content, key, value) {
  const m = content.match(FRONTMATTER_RE);
  if (!m) {
    // No frontmatter — synthesize a minimal one. Conservative.
    const fm = `---\n${key}: ${value}\n---\n\n`;
    return fm + content;
  }
  const [whole, open, body, close] = m;
  const presentRe = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*:`, 'm');
  let newBody = body;
  if (presentRe.test(newBody)) {
    const replaceRe = new RegExp(
      `^([ \\t]*${escapeRegExp(key)}[ \\t]*:[ \\t]*)(\\S*)(.*)$`,
      'm',
    );
    newBody = newBody.replace(replaceRe, (_, lead, _v, rest) => `${lead}${value}${rest}`);
  } else {
    newBody = newBody.replace(/\s*$/, `\n${key}: ${value}`);
  }
  return content.replace(whole, `${open}${newBody}${close}`);
}

function stampDemotion(content, today, reason) {
  // ADR 008 STRUCTURAL ENFORCEMENT TODO: every NEW demotion must carry a
  // `demotion_phase: p3-<today>` tag so each cleanup is independently
  // auditable. The frozen marker `p3-2026-05-09` is forbidden on new writes.
  const phaseValue = `p3-${today}`;
  const phaseCheck = validateDemotionPhase(phaseValue, today);
  if (!phaseCheck.allowed) {
    throw new Error(`stampDemotion: ${phaseCheck.reason}`);
  }
  let out = content;
  out = setFrontmatterField(out, 'demoted_at', today);
  out = setFrontmatterField(out, 'demoted_by', 'dream-worker');
  out = setFrontmatterField(out, 'demotion_phase', phaseValue);
  // Reason may contain newlines / quotes; collapse to a single safe line.
  const safe = String(reason || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  out = setFrontmatterField(out, 'demoted_reason', safe);
  return out;
}

// Parse an ISO date out of frontmatter for the grace-period check. The
// scalar parser already coerces YYYY-MM-DD to a string (no auto-coerce to
// Date in YAML 1.1 mode), so we read it as a string here.
function patternFirstSeen(desc) {
  const fm = desc.frontmatter || {};
  // Prefer explicit fields. Skeleton uses `first_seen`; future Phase-2
  // promotion stamping may also set `promoted_at`. Either suffices.
  const candidates = [fm.first_seen, fm.promoted_at, fm.first_observed];
  for (const c of candidates) {
    if (typeof c === 'string' && ISO_DATE_RE.test(c)) return c;
  }
  return null;
}

function daysBetweenISO(aISO, bISO) {
  const a = Date.parse(aISO);
  const b = Date.parse(bISO);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(b - a) / 86_400_000;
}

async function readIfExists(fp) {
  try {
    return await fs.readFile(fp, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// ---- planning ---------------------------------------------------------

async function planCorrections({ memoryRoot, ttlDays, now }) {
  const sourceRel = 'corrections.md';
  const content = await readIfExists(path.join(memoryRoot, sourceRel));
  if (content === null) {
    return { found: false, sourceRel, keptBlocks: [], archive: [], byMonth: [] };
  }
  const result = classifyCorrections(content, { now, ttlDays });
  const byMonth = new Map();
  for (const { block, monthKey } of result.archive) {
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push(block);
  }
  return {
    found: true,
    sourceRel,
    keptBlocks: result.keep,
    archive: result.archive,
    byMonth: [...byMonth.entries()].map(([monthKey, blocks]) => ({ monthKey, blocks })),
  };
}

async function planSessionIndex({ memoryRoot, keepLastN }) {
  const sourceRel = 'session-index.md';
  const content = await readIfExists(path.join(memoryRoot, sourceRel));
  if (content === null) {
    return { found: false, sourceRel, keptBlocks: [], archive: [], byMonth: [], undatedKept: 0 };
  }
  const result = classifySessionIndex(content, { keepLastN });
  const byMonth = new Map();
  for (const { block, dateISO } of result.archive) {
    const monthKey = dateISO.slice(0, 7);
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push(block);
  }
  return {
    found: true,
    sourceRel,
    keptBlocks: result.keep,
    archive: result.archive,
    byMonth: [...byMonth.entries()].map(([monthKey, blocks]) => ({ monthKey, blocks })),
    undatedKept: result.undatedKept,
  };
}

async function planJournal({ memoryRoot, today }) {
  const sourceRel = posix(path.join('learning-journals', `${today}.md`));
  const content = await readIfExists(path.join(memoryRoot, sourceRel));
  if (content === null) return { found: false, sourceRel };
  const monthKey = today.slice(0, 7);
  const targetRel = posix(path.join('archive', 'journals', monthKey, `${today}.md`));

  // Same-day re-run idempotency: if the archive target already exists and
  // matches the source byte-for-byte, mark `alreadyArchived: true`. The
  // sweep step still removes the live source via the tombstone but doesn't
  // overwrite the archive copy. If contents differ → throw, surface to JJ.
  // (Code-reviewer R1 must-fix #3.)
  const liveTarget = path.join(memoryRoot, targetRel);
  let alreadyArchived = false;
  const archiveExisting = await readIfExists(liveTarget);
  if (archiveExisting !== null) {
    if (archiveExisting === content) {
      alreadyArchived = true;
    } else {
      throw new Error(
        `planJournal: archive collision at ${targetRel} — content differs from source. `
        + `Resolve manually before re-running the dream pass.`,
      );
    }
  }

  return { found: true, sourceRel, targetRel, monthKey, content, alreadyArchived };
}

async function planDemotions({ memoryRoot, firingEntries, days, gracePeriodDays, today, now }) {
  const active = await loadPatterns(memoryRoot, 'active');
  if (active.length === 0) return [];
  const activeNames = active.map(p => p.name);
  const stale = demotionCandidates(activeNames, firingEntries, {
    days,
    now: now.getTime(),
  });
  const out = [];
  for (const name of stale) {
    const desc = active.find(p => p.name === name);
    if (!desc) continue;

    // Grace period: skip patterns that have been in active/ for less than
    // gracePeriodDays. A pattern just promoted has 0 firings by definition;
    // demoting it before it has had a chance to accrue evidence undoes the
    // promotion gate's intent.
    const firstSeen = patternFirstSeen(desc);
    if (firstSeen) {
      const ageDays = daysBetweenISO(firstSeen, today);
      if (ageDays < gracePeriodDays) continue;
    }

    const content = await readIfExists(desc.path);
    if (content === null) continue;
    out.push({
      name,
      content,
      sourceRel: posix(path.join('patterns', 'active', `${name}.md`)),
      targetRel: posix(path.join('patterns', 'reference', `${name}.md`)),
      reason: `no firings in ${days} days (firing-log-read.demotionCandidates)`,
    });
  }
  return out;
}

/**
 * Build the Phase-3 prune plan.
 *
 * @param {object} opts
 * @param {string} opts.memoryRoot
 * @param {string} opts.today                     — YYYY-MM-DD
 * @param {Array<FiringLogEntry>} [opts.firingEntries]
 * @param {object} [opts.gates]                   — overrides for DEFAULT_GATES
 * @param {Date}   [opts.now]
 * @returns {Promise<{plan: PrunePlan, summary: object}>}
 */
export async function runPrune(opts) {
  const {
    memoryRoot,
    today,
    firingEntries = [],
    gates = {},
    now = new Date(),
  } = opts || {};
  if (!memoryRoot) throw new Error('runPrune: memoryRoot required');
  if (!today) throw new Error('runPrune: today required');
  if (!ISO_DATE_RE.test(today)) {
    throw new Error(`runPrune: today must match YYYY-MM-DD; got '${today}'`);
  }
  const merged = { ...DEFAULT_GATES, ...gates };

  const corrections = await planCorrections({
    memoryRoot, ttlDays: merged.correctionsTtlDays, now,
  });
  const sessionIndex = await planSessionIndex({
    memoryRoot, keepLastN: merged.sessionIndexKeepLastN,
  });
  const journal = await planJournal({ memoryRoot, today });
  const demotions = await planDemotions({
    memoryRoot,
    firingEntries,
    days: merged.demotionLookbackDays,
    gracePeriodDays: merged.demotionGracePeriodDays,
    today,
    now,
  });

  const plan = { today, corrections, sessionIndex, journal, demotions };
  const summary = {
    correctionsArchivedBlocks: corrections.archive.length,
    correctionsKeptBlocks: corrections.keptBlocks.filter(b => b.type === 'item').length,
    sessionIndexArchivedBlocks: sessionIndex.archive.length,
    sessionIndexKeptBlocks: sessionIndex.keptBlocks.filter(b => b.type === 'item').length,
    journalArchived: journal.found ? 1 : 0,
    demotedCount: demotions.length,
  };
  return { plan, summary };
}

// ---- staging ----------------------------------------------------------

function tombstone(removedRel, reason, today, consolidationTarget, opts = {}) {
  return JSON.stringify({
    schema_version: TOMBSTONE_SCHEMA_VERSION,
    removed_path: posix(removedRel),
    reason,
    consolidation_target: consolidationTarget ? posix(consolidationTarget) : null,
    promotion_run: `dream/pre/${today}`,
    timestamp: new Date().toISOString(),
    // Reality-checker R1 #6: schema parity with Phase-2 tombstone. Records
    // whether the live target exists at stage-time. The P5 sweep uses this
    // to distinguish "already swept by a prior run" from "lost between
    // plan-build and sweep" — the difference matters for honest dream-log.
    target_missing: Boolean(opts.targetMissing),
  }, null, 2) + '\n';
}

async function stageOne(stagedRoot, relPath, contents) {
  // Sweep step renames `<staged>/<rel>.tmp` → `<live>/<rel>` (drops .tmp).
  const stagedPath = path.join(stagedRoot, `${relPath}.tmp`);
  await fs.mkdir(path.dirname(stagedPath), { recursive: true });
  await atomicWrite(stagedPath, contents);
  return stagedPath;
}

async function stageTombstone(stagedRoot, relPath, content) {
  const tombPath = path.join(stagedRoot, `${relPath}.tombstone`);
  await fs.mkdir(path.dirname(tombPath), { recursive: true });
  await atomicWrite(tombPath, content);
  return tombPath;
}

/**
 * Write a `.preimage-sha256` sidecar next to a staged archive file. The
 * sidecar records the sha256 of the LIVE archive at the moment we read it,
 * so the P5 sweep step can detect concurrent appends (e.g., a wrap-up that
 * appended to the live archive between our read and the sweep) and fail-
 * safe rather than silently overwrite. Reviewer R1 must-fix #4.
 *
 * The sidecar lives at `<stagedPath>.preimage-sha256`. The sweep step
 * reads it, hashes the live target, compares; mismatch → conflict. P5
 * audit Stage A will surface this.
 */
async function stagePreimageSidecar(stagedPath, preimageContent) {
  const sidecarPath = `${stagedPath}.preimage-sha256`;
  const hash = preimageContent === null ? null : sha256(preimageContent);
  const payload = JSON.stringify({
    schema_version: TOMBSTONE_SCHEMA_VERSION,
    sha256: hash,
    captured_at: new Date().toISOString(),
    note:
      hash === null
        ? 'live archive did not exist at stage-time'
        : 'sweep MUST verify live target sha matches before overwrite',
  }, null, 2) + '\n';
  await atomicWrite(sidecarPath, payload);
  return sidecarPath;
}

/**
 * Write the prune plan into `archive/dreams/<date>/staged/`.
 * Live tree is NOT mutated. P5 sweep step honors the staged tree + tombstones.
 */
export async function stagePrunePlan(args) {
  const { plan, dreamDir, memoryRoot, today } = args || {};
  if (!plan) throw new Error('stagePrunePlan: plan required');
  if (!dreamDir) throw new Error('stagePrunePlan: dreamDir required');
  if (!memoryRoot) throw new Error('stagePrunePlan: memoryRoot required');
  if (!today) throw new Error('stagePrunePlan: today required');

  const stagedRoot = path.join(dreamDir, 'staged');
  const stagedFiles = [];

  // Helper: stage an archive append + record the live preimage sha256.
  async function stageArchiveAppend(archiveRel, blocks) {
    const liveAbs = path.join(memoryRoot, archiveRel);
    const existingRaw = await readIfExists(liveAbs);
    const existing = existingRaw || '';
    const append = blocks.map(b => b.lines.join('\n')).join('\n') + '\n';
    const stagedPath = await stageOne(stagedRoot, archiveRel, existing + append);
    stagedFiles.push(stagedPath);
    // Sidecar so the sweep step can detect concurrent appends and bail
    // rather than silently overwrite a wrap-up's interleaved write.
    stagedFiles.push(await stagePreimageSidecar(stagedPath, existingRaw));
  }

  // Corrections — stage trimmed source + per-month archive appends.
  if (plan.corrections?.found && plan.corrections.archive.length > 0) {
    const newSource = serializeBlocks(plan.corrections.keptBlocks);
    stagedFiles.push(await stageOne(stagedRoot, plan.corrections.sourceRel, newSource));

    for (const { monthKey, blocks } of plan.corrections.byMonth) {
      await stageArchiveAppend(posix(path.join('archive', 'corrections', `${monthKey}.md`)), blocks);
    }
  }

  // Session index — same pattern, different paths.
  if (plan.sessionIndex?.found && plan.sessionIndex.archive.length > 0) {
    const newSource = serializeBlocks(plan.sessionIndex.keptBlocks);
    stagedFiles.push(await stageOne(stagedRoot, plan.sessionIndex.sourceRel, newSource));

    for (const { monthKey, blocks } of plan.sessionIndex.byMonth) {
      await stageArchiveAppend(
        posix(path.join('archive', 'sessions', `session-index-${monthKey}.md`)),
        blocks,
      );
    }
  }

  // Journal — copy verbatim to archive/journals/<month>/<file>; tombstone source.
  if (plan.journal?.found) {
    if (!plan.journal.alreadyArchived) {
      stagedFiles.push(await stageOne(stagedRoot, plan.journal.targetRel, plan.journal.content));
    }
    // Tombstone always: the source must be removed even on idempotent re-run.
    const sourceAbs = path.join(memoryRoot, plan.journal.sourceRel);
    let sourceMissing = false;
    try { await fs.access(sourceAbs); } catch (e) {
      if (e.code === 'ENOENT') sourceMissing = true; else throw e;
    }
    stagedFiles.push(await stageTombstone(
      stagedRoot, plan.journal.sourceRel,
      tombstone(
        plan.journal.sourceRel,
        plan.journal.alreadyArchived
          ? 'already archived; removing live source only'
          : 'consolidated into archive/journals/',
        today,
        plan.journal.targetRel,
        { targetMissing: sourceMissing },
      ),
    ));
  }

  // Pattern demotions — stamp + stage to reference; tombstone the active twin.
  for (const demo of (plan.demotions || [])) {
    const stamped = stampDemotion(demo.content, today, demo.reason);
    stagedFiles.push(await stageOne(stagedRoot, demo.targetRel, stamped));
    const activeAbs = path.join(memoryRoot, demo.sourceRel);
    let sourceMissing = false;
    try { await fs.access(activeAbs); } catch (e) {
      if (e.code === 'ENOENT') sourceMissing = true; else throw e;
    }
    stagedFiles.push(await stageTombstone(
      stagedRoot, demo.sourceRel,
      tombstone(demo.sourceRel, demo.reason, today, demo.targetRel,
        { targetMissing: sourceMissing }),
    ));
  }

  return { stagedFiles };
}

export const _internals = {
  DEFAULT_GATES,
  setFrontmatterField,
  stampDemotion,
  tombstone,
  patternFirstSeen,
  daysBetweenISO,
  posix,
  sha256,
  TOMBSTONE_SCHEMA_VERSION,
};
