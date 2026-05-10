#!/usr/bin/env node
// dream — P4 starter CLI. Runs phase-0 (lock + git-tag + snapshot) and
// phase-1 (replay: journal + session-log markers).
//
// Later phases (route, prune, contradictions, rebuild, two-stage audit) ship
// in continuation. The starter is enough to verify that the safety primitives
// hold and that replay extraction produces clean structural output for the
// later route phase to score.
//
// Exit codes:
//   0  success (live or dry-run)
//   1  usage error
//   2  lock held by another live run
//   3  git-tag conflict (existing tag points elsewhere)
//   4  internal error

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  acquireLock,
  gitTagPreDream,
  snapshot,
  detectRepoRoot,
  isInvokedAs,
  LockHeldError,
  GitTagExistsError,
} from '../lib/dream/phase-0-safety.js';
import { runReplay } from '../lib/dream/phase-1-replay.js';
import { collectInsights } from '../lib/dream/insights.js';
import { scoreAll, scoreHeuristic } from '../lib/dream/importance-score.js';
import { runRoute } from '../lib/dream/phase-2-route.js';
import { stageRoutePlan } from '../lib/dream/stage-route.js';
import { loadPatterns } from '../lib/dream/load-patterns.js';
import { readAllEntries } from '../lib/firing-log-read.js';
import { runPrune, stagePrunePlan } from '../lib/dream/phase-3-prune.js';
import {
  runDatesContradictions,
  stageDatesContradictionsPlan,
} from '../lib/dream/phase-4-dates-contradictions.js';
import {
  runRebuildIndexes,
  stageRebuildPlan,
} from '../lib/dream/phase-5-rebuild-indexes.js';

const VALUE_FLAGS = new Set(['--memory-root', '--since', '--repo-root', '--today', '--config']);
const BOOLEAN_FLAGS = new Set(['--dry-run']);
const HELP_FLAGS = new Set(['--help', '-h']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function camelKey(flag) {
  return flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
}

export function parseArgs(argv) {
  const out = { dryRun: false, _unknown: [] };
  const seen = new Set();

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    let flag = raw;
    let inlineValue = null;
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      if (eq > 2) {
        flag = raw.slice(0, eq);
        inlineValue = raw.slice(eq + 1);
      }
    }

    if (HELP_FLAGS.has(flag)) {
      if (inlineValue !== null) {
        out._error = `flag ${flag} does not take a value`;
        return out;
      }
      out.help = true;
      continue;
    }

    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== null) {
        out._error = `flag ${flag} does not take a value`;
        return out;
      }
      if (seen.has(flag)) {
        out._error = `duplicate flag ${flag}`;
        return out;
      }
      seen.add(flag);
      out[camelKey(flag)] = true;
      continue;
    }

    if (VALUE_FLAGS.has(flag)) {
      if (seen.has(flag)) {
        out._error = `duplicate flag ${flag}`;
        return out;
      }
      seen.add(flag);
      let value;
      if (inlineValue !== null) {
        if (inlineValue === '') {
          out._error = `flag ${flag} requires a non-empty value`;
          return out;
        }
        value = inlineValue;
      } else {
        value = argv[i + 1];
        if (
          value === undefined
          || value === ''
          || (typeof value === 'string' && value.startsWith('--'))
        ) {
          out._error = `flag ${flag} requires a non-empty value`;
          return out;
        }
        i += 1;
      }
      out[camelKey(flag)] = value;
      continue;
    }

    out._unknown.push(raw);
  }
  return out;
}

function usage() {
  return `Usage: dream --memory-root <path> [--dry-run] [--since YYYY-MM-DD]
                  [--repo-root <path>] [--today YYYY-MM-DD]

P4 worker — phase-0 (safety) + phase-1 (replay) + phase-2 (route) + phase-3 (prune) + phase-4 (dates) + phase-5 (rebuild).
  --memory-root  Required. The agent's memory directory.
  --dry-run      No mutation: skip git tag and snapshot; still scan replay.
  --since        Limit session-log scan to dates ≥ this ISO date.
  --repo-root    Override git repo root (default: detected via git rev-parse).
  --today        Override the run date (default: local-time today).
`;
}

function todayISO(d = new Date()) {
  // Local-time date — not UTC. The dream cadence is a wall-clock 3 AM event.
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args._error) {
    process.stderr.write(`error: ${args._error}\n${usage()}`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (!args.memoryRoot) {
    process.stderr.write(`error: --memory-root required\n${usage()}`);
    return 1;
  }
  if (args._unknown.length > 0) {
    process.stderr.write(`error: unknown args: ${args._unknown.join(' ')}\n`);
    return 1;
  }
  if (args.today && !ISO_DATE_RE.test(args.today)) {
    process.stderr.write(`error: --today must match YYYY-MM-DD; got '${args.today}'\n`);
    return 1;
  }
  if (args.since && !ISO_DATE_RE.test(args.since)) {
    process.stderr.write(`error: --since must match YYYY-MM-DD; got '${args.since}'\n`);
    return 1;
  }

  const memoryRoot = path.resolve(args.memoryRoot);
  const today = args.today || todayISO();
  const dryRun = args.dryRun;

  let repoRoot = args.repoRoot ? path.resolve(args.repoRoot) : null;
  if (!repoRoot) {
    repoRoot = await detectRepoRoot(memoryRoot);
    if (!repoRoot) {
      process.stderr.write(`error: --memory-root is not inside a git repo; pass --repo-root\n`);
      return 1;
    }
  }

  let lock = null;
  try {
    lock = await acquireLock(memoryRoot, {
      phase: 'phase-0-safety',
      gitTag: `dream/pre/${today}`,
    });
    process.stdout.write(`[phase-0] lock acquired pid=${process.pid} memoryRoot=${memoryRoot}\n`);

    const tagInfo = await gitTagPreDream({ repoRoot, date: today, dryRun });
    if (dryRun) {
      process.stdout.write(`[phase-0] DRY-RUN would tag ${tagInfo.tag} -> ${tagInfo.headSha}\n`);
    } else {
      const note = tagInfo.alreadyExisted ? ' (already existed at HEAD)' : '';
      process.stdout.write(`[phase-0] git tag ${tagInfo.tag} -> ${tagInfo.headSha}${note}\n`);
    }

    if (dryRun) {
      process.stdout.write(`[phase-0] DRY-RUN skip snapshot\n`);
    } else {
      await lock.update('phase-0-snapshot');
      const snap = await snapshot({
        memoryRoot,
        date: today,
        consumerName: path.basename(memoryRoot),
        gitTag: tagInfo.tag,
        gitHeadBefore: tagInfo.headSha,
      });
      process.stdout.write(
        `[phase-0] snapshot ${snap.snapshotDir} (${snap.manifest.files.length} files)\n`,
      );
    }

    await lock.update('phase-1-replay');
    const replay = await runReplay({
      memoryRoot,
      today,
      since: args.since || null,
    });
    process.stdout.write(
      `[phase-1] journal=${replay.journal.entries.length} `
      + `sessions=${replay.sessionLogs.scanned} `
      + `markers=${JSON.stringify(replay.summary.sessionMarkersByKind)}\n`,
    );

    // Phase 2 — ROUTE. Score insights and produce a routing plan. Promotion
    // candidate auto-extraction is deferred (Phase-1.5 / clustering scope);
    // the CLI passes an empty candidate list so only reinforcements fire here
    // until that pipeline is wired.
    await lock.update('phase-2-route');
    const insights = collectInsights(replay, { memoryRoot });
    const scored = await scoreAll(insights, scoreHeuristic);
    const activePatterns = await loadPatterns(memoryRoot, 'active');

    // Reviewer R1: bare catch hid corruption / permission errors and silently
    // disabled promotion. readAllEntries already returns [] for ENOENT, so the
    // outer catch only runs on real failures — surface them.
    const firingEntries = await readAllEntries({
      logPath: path.join(memoryRoot, 'pattern-firing-log.md'),
      archiveDir: path.join(memoryRoot, 'archive', 'firing-logs'),
    });

    const { plan, summary } = runRoute({
      today,
      scoredInsights: scored,
      activePatterns,
      promotionCandidates: [], // wired by future clustering pipeline
      firingEntries,
    });
    process.stdout.write(
      `[phase-2] insights=${insights.length} above-threshold=${summary.aboveThresholdCount} `
      + `reinforce=${plan.reinforce.length} promote=${plan.promote.length} `
      + `declined=${plan.declined.length}\n`,
    );

    const dreamDir = path.join(memoryRoot, 'archive', 'dreams', today);
    if (dryRun) {
      process.stdout.write(`[phase-2] DRY-RUN skip stage\n`);
    } else if (plan.reinforce.length > 0 || plan.promote.length > 0) {
      const stageResult = await stageRoutePlan({ plan, dreamDir, memoryRoot, today });
      process.stdout.write(`[phase-2] staged=${stageResult.stagedFiles.length}\n`);
    }

    // Phase 3 — PRUNE. Consolidate corrections, session-index, today's
    // journal, and stale active patterns. Live tree unaffected; everything
    // lands under archive/dreams/<date>/staged/ for the P5 sweep step.
    await lock.update('phase-3-prune');
    const pruneResult = await runPrune({
      memoryRoot,
      today,
      firingEntries,
    });
    const pruneSummary = pruneResult.summary;
    process.stdout.write(
      `[phase-3] corrections=${pruneSummary.correctionsArchivedBlocks} `
      + `sessions=${pruneSummary.sessionIndexArchivedBlocks} `
      + `journal=${pruneSummary.journalArchived} `
      + `demoted=${pruneSummary.demotedCount}\n`,
    );

    if (dryRun) {
      process.stdout.write(`[phase-3] DRY-RUN skip stage\n`);
    } else {
      const pruneStage = await stagePrunePlan({
        plan: pruneResult.plan, dreamDir, memoryRoot, today,
      });
      if (pruneStage.stagedFiles.length > 0) {
        process.stdout.write(`[phase-3] staged=${pruneStage.stagedFiles.length}\n`);
      }
    }

    // Phase 4 — CONTRADICTIONS + DATES. Sweep relative-date phrases in
    // hot-tier files to ISO YYYY-MM-DD. Contradiction detection is a stub
    // (P5 wires the real detector alongside the dream-log writer).
    //
    // Two collision guards (reviewer R1 BLOCKERS):
    //   - excludePaths: files Phase-3 is tombstoning (demoted patterns).
    //   - preStaged:    Phase-3 trimmed corrections / session-index content,
    //     so Phase-4 rewrites on top of the trim rather than overwriting
    //     it from the pre-trim live file.
    await lock.update('phase-4-dates-contradictions');
    const phase3DemotionPaths = (pruneResult.plan.demotions || [])
      .map(d => d.sourceRel);
    const preStaged = new Map();
    const corr = pruneResult.plan.corrections;
    if (corr?.found && corr.archive.length > 0) {
      const { serializeBlocks } = await import('../lib/parse-md-blocks.js');
      preStaged.set('corrections.md', serializeBlocks(corr.keptBlocks));
    }
    const sess = pruneResult.plan.sessionIndex;
    if (sess?.found && sess.archive.length > 0) {
      const { serializeBlocks } = await import('../lib/parse-md-blocks.js');
      preStaged.set('session-index.md', serializeBlocks(sess.keptBlocks));
    }
    const datesResult = await runDatesContradictions({
      memoryRoot,
      today,
      excludePaths: phase3DemotionPaths,
      preStaged,
    });
    const contradictionsLabel = datesResult.summary.contradictionsStub
      ? 'stub' : String(datesResult.summary.contradictionCount);
    process.stdout.write(
      `[phase-4] dates files=${datesResult.summary.filesWithReplacements} `
      + `replacements=${datesResult.summary.totalReplacements} `
      + `contradictions=${contradictionsLabel}\n`,
    );
    if (dryRun) {
      process.stdout.write(`[phase-4] DRY-RUN skip stage\n`);
    } else if (datesResult.plan.byFile.length > 0) {
      const datesStage = await stageDatesContradictionsPlan({
        plan: datesResult.plan, dreamDir, memoryRoot, today,
      });
      process.stdout.write(`[phase-4] staged=${datesStage.stagedFiles.length}\n`);
    }

    // Phase 5 — REBUILD INDEXES. Regenerate memory-index.md + pre-action.md,
    // append a human-readable run summary to .dream-log.md, and write the
    // canonical event.json + dream-log-entry.md per archive-schema § 2.5.
    // The audit verdict is "PASS-TENTATIVE" — Stage A + Stage B run on the
    // staged tree before the sweep step (P5+ scope) commits anything.
    await lock.update('phase-5-rebuild-indexes');
    const phase1Summary = replay.summary;
    const phase2Summary = summary; // from runRoute(...).summary
    const phase3Summary = pruneResult.summary;
    const phase4Summary = datesResult.summary;
    const rebuildResult = await runRebuildIndexes({
      memoryRoot,
      today,
      consumerName: path.basename(memoryRoot),
      gitTag: `dream/pre/${today}`,
      verdict: 'PASS-TENTATIVE',
      phase1Summary, phase2Summary, phase3Summary, phase4Summary,
      routePlan: plan, prunePlan: pruneResult.plan, datesPlan: datesResult.plan,
    });
    process.stdout.write(
      `[phase-5] memory-index=${rebuildResult.summary.memoryIndexLines}L `
      + `pre-action=${rebuildResult.summary.preActionLines}L `
      + `event-json=${rebuildResult.summary.eventJsonBytes}B\n`,
    );
    if (dryRun) {
      process.stdout.write(`[phase-5] DRY-RUN skip stage\n`);
    } else {
      const rebuildStage = await stageRebuildPlan({
        plan: rebuildResult.plan, dreamDir, today,
      });
      process.stdout.write(`[phase-5] staged=${rebuildStage.stagedFiles.length}\n`);
    }

    return 0;
  } catch (e) {
    if (e instanceof LockHeldError) {
      process.stderr.write(`lock held: ${e.message}\n`);
      return 2;
    }
    if (e instanceof GitTagExistsError) {
      process.stderr.write(`git tag conflict: ${e.message}\n`);
      return 3;
    }
    process.stderr.write(`error: ${e.stack || e.message}\n`);
    return 4;
  } finally {
    if (lock) await lock.release();
  }
}

// `isInvokedAs` (realpath both ends) is the only signal we trust for CLI vs
// library import. We previously kept a basename-suffix fallback for bundled
// binaries that virtualize argv[1], but the fallback false-matches any
// importer whose argv[1] basename happens to be `dream.js` or `dream`. JJ's
// deployment is npm-link / direct invocation / launchd, all of which pass
// realpathSync. If a bundled-binary use case appears later, gate the fallback
// behind a stricter check (e.g., env opt-in) rather than reintroducing the
// silent false-positive.
export function shouldRunAsCli(modulePath, argvPath) {
  return isInvokedAs(modulePath, argvPath);
}

if (shouldRunAsCli(fileURLToPath(import.meta.url), process.argv[1])) {
  main().then((code) => process.exit(code));
}
