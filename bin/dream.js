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

P4 starter + Phase-2 ROUTE — phase-0 (safety) + phase-1 (replay) + phase-2 (route).
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

    let firingEntries = [];
    try {
      firingEntries = await readAllEntries({
        logPath: path.join(memoryRoot, 'pattern-firing-log.md'),
        archiveDir: path.join(memoryRoot, 'archive', 'firing-logs'),
      });
    } catch {
      firingEntries = [];
    }

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

    if (dryRun) {
      process.stdout.write(`[phase-2] DRY-RUN skip stage\n`);
    } else if (plan.reinforce.length > 0 || plan.promote.length > 0) {
      const dreamDir = path.join(memoryRoot, 'archive', 'dreams', today);
      const stageResult = await stageRoutePlan({ plan, dreamDir, memoryRoot, today });
      process.stdout.write(`[phase-2] staged=${stageResult.stagedFiles.length}\n`);
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
