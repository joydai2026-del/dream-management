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
import path from 'node:path';
import { atomicWrite } from '../atomic-write.js';
import { serializeBlocks } from '../parse-md-blocks.js';
import { classifyCorrections } from '../corrections-ttl.js';
import { classifySessionIndex } from '../session-index-tier.js';
import { demotionCandidates } from '../firing-log-read.js';
import { loadPatterns } from './load-patterns.js';

const DEFAULT_GATES = {
  correctionsTtlDays: 30,
  sessionIndexKeepLastN: 10,
  demotionLookbackDays: 60,
};

const TOMBSTONE_SCHEMA_VERSION = '1.0.0';

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
  let out = content;
  out = setFrontmatterField(out, 'demoted_at', today);
  out = setFrontmatterField(out, 'demoted_by', 'dream-worker');
  // Reason may contain newlines / quotes; collapse to a single safe line.
  const safe = String(reason || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  out = setFrontmatterField(out, 'demoted_reason', safe);
  return out;
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
  const sourceRel = path.join('learning-journals', `${today}.md`);
  const content = await readIfExists(path.join(memoryRoot, sourceRel));
  if (content === null) return { found: false, sourceRel };
  const monthKey = today.slice(0, 7);
  const targetRel = path.join('archive', 'journals', monthKey, `${today}.md`);
  return { found: true, sourceRel, targetRel, monthKey, content };
}

async function planDemotions({ memoryRoot, firingEntries, days, now }) {
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
    const content = await readIfExists(desc.path);
    if (content === null) continue;
    out.push({
      name,
      content,
      sourceRel: path.join('patterns', 'active', `${name}.md`),
      targetRel: path.join('patterns', 'reference', `${name}.md`),
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
  const merged = { ...DEFAULT_GATES, ...gates };

  const corrections = await planCorrections({
    memoryRoot, ttlDays: merged.correctionsTtlDays, now,
  });
  const sessionIndex = await planSessionIndex({
    memoryRoot, keepLastN: merged.sessionIndexKeepLastN,
  });
  const journal = await planJournal({ memoryRoot, today });
  const demotions = await planDemotions({
    memoryRoot, firingEntries, days: merged.demotionLookbackDays, now,
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

function tombstone(removedRel, reason, today, consolidationTarget) {
  return JSON.stringify({
    schema_version: TOMBSTONE_SCHEMA_VERSION,
    removed_path: removedRel,
    reason,
    consolidation_target: consolidationTarget || null,
    promotion_run: `dream/pre/${today}`,
    timestamp: new Date().toISOString(),
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

  // Corrections — stage trimmed source + per-month archive appends.
  if (plan.corrections?.found && plan.corrections.archive.length > 0) {
    const newSource = serializeBlocks(plan.corrections.keptBlocks);
    stagedFiles.push(await stageOne(stagedRoot, plan.corrections.sourceRel, newSource));

    for (const { monthKey, blocks } of plan.corrections.byMonth) {
      const archiveRel = path.join('archive', 'corrections', `${monthKey}.md`);
      const existing = await readIfExists(path.join(memoryRoot, archiveRel)) || '';
      const append = blocks.map(b => b.lines.join('\n')).join('\n') + '\n';
      stagedFiles.push(await stageOne(stagedRoot, archiveRel, existing + append));
    }
  }

  // Session index — same pattern, different paths.
  if (plan.sessionIndex?.found && plan.sessionIndex.archive.length > 0) {
    const newSource = serializeBlocks(plan.sessionIndex.keptBlocks);
    stagedFiles.push(await stageOne(stagedRoot, plan.sessionIndex.sourceRel, newSource));

    for (const { monthKey, blocks } of plan.sessionIndex.byMonth) {
      const archiveRel = path.join('archive', 'sessions', `session-index-${monthKey}.md`);
      const existing = await readIfExists(path.join(memoryRoot, archiveRel)) || '';
      const append = blocks.map(b => b.lines.join('\n')).join('\n') + '\n';
      stagedFiles.push(await stageOne(stagedRoot, archiveRel, existing + append));
    }
  }

  // Journal — copy verbatim to archive/journals/<month>/<file>; tombstone source.
  if (plan.journal?.found) {
    stagedFiles.push(await stageOne(stagedRoot, plan.journal.targetRel, plan.journal.content));
    stagedFiles.push(await stageTombstone(
      stagedRoot, plan.journal.sourceRel,
      tombstone(plan.journal.sourceRel,
        'consolidated into archive/journals/',
        today, plan.journal.targetRel),
    ));
  }

  // Pattern demotions — stamp + stage to reference; tombstone the active twin.
  for (const demo of (plan.demotions || [])) {
    const stamped = stampDemotion(demo.content, today, demo.reason);
    stagedFiles.push(await stageOne(stagedRoot, demo.targetRel, stamped));
    stagedFiles.push(await stageTombstone(
      stagedRoot, demo.sourceRel,
      tombstone(demo.sourceRel, demo.reason, today, demo.targetRel),
    ));
  }

  return { stagedFiles };
}

export const _internals = {
  DEFAULT_GATES,
  setFrontmatterField,
  stampDemotion,
  tombstone,
  TOMBSTONE_SCHEMA_VERSION,
};
