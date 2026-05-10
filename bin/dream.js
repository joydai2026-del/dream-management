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
import { spawn } from 'node:child_process';
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
import { runStageA } from '../lib/dream/stage-a-auditor.js';
import { runStageB } from '../lib/dream/stage-b-auditor.js';
import { runSweep, finalizeAuditVerdicts } from '../lib/dream/sweep.js';
import { checkDualGate, renderSkipLogLine } from '../lib/dream/dual-gate.js';
import { detectContradictions } from '../lib/dream/contradiction-detector.js';
import { generateWeeklyDigest } from '../lib/dream/weekly-digest.js';
import { atomicAppend } from '../lib/atomic-write.js';

const VALUE_FLAGS = new Set([
  '--memory-root', '--since', '--repo-root', '--today', '--config',
  '--stage-b-command',
]);
const BOOLEAN_FLAGS = new Set([
  '--dry-run', '--skip-dual-gate', '--skip-stage-b', '--skip-audit',
  '--no-notify', '--no-telegram', '--test-notify',
]);
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
                  [--skip-dual-gate] [--skip-stage-b] [--stage-b-command <cmd>]

P5 worker — full pipeline: dual-gate → phase-0..5 stage → Stage A → Stage B
→ sweep → finalize.
  --memory-root        Required. The agent's memory directory.
  --dry-run            No mutation: stage but never sweep onto live.
  --since              Limit session-log scan to dates ≥ this ISO date.
  --repo-root          Override git repo root (default: detected via git rev-parse).
  --today              Override the run date (default: local-time today).
  --skip-dual-gate     Run regardless of cadence-gate (manual debug).
  --skip-stage-b       Skip Stage B codex audit (use when codex CLI unavailable).
  --skip-audit         Skip Stage A + Stage B + sweep entirely (test-only).
  --no-notify          Suppress ALL notifications (macOS + Telegram) at end of run.
  --no-telegram        Suppress just Telegram (keep macOS bubble).
  --test-notify        Fire one test notification + exit 0 (no vault access).
                       Use to verify TELEGRAM_* env vars after install.
  --stage-b-command    Override Stage B command (default: 'codex exec --skip-git-repo-check').

Notification env vars (read by the worker):
  TELEGRAM_BOT_TOKEN      Bot token from @BotFather (Telegram channel)
  TELEGRAM_CHAT_ID        Chat or group ID to message (e.g. -1003411410603)
  TELEGRAM_THREAD_ID      Optional topic/forum-thread ID for supergroups
  DREAM_NO_NOTIFY=1       Same as --no-notify (umbrella suppress)
  DREAM_NO_TELEGRAM=1     Same as --no-telegram

Exit codes:
  0  success (PASS, WARN, or SKIP)
  1  usage error
  2  lock held by another live run
  3  git-tag conflict
  4  internal error
  5  audit FAIL or sweep aborted (live tree intact, staged tree preserved)
`;
}

function todayISO(d = new Date()) {
  // Local-time date — not UTC. The dream cadence is a wall-clock 3 AM event.
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

/**
 * Best-effort macOS notification. Failure (no osascript, headless run,
 * notification permission denied, non-Darwin) NEVER fails the worker.
 * Skips entirely on non-darwin platforms or when --no-notify is set.
 *
 * Detached + unref so the worker's exit doesn't block on the AppleScript
 * helper. The user sees the bubble + accumulating Notification Center
 * entry.
 */
function notifyMacOS({ title, message, suppress }) {
  if (suppress) return;
  if (process.platform !== 'darwin') return;
  try {
    const escapeAS = s => String(s == null ? '' : s)
      .replace(/[\\"]/g, '\\$&')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 240); // AppleScript dialog body limit; keep skim-friendly
    const cmd = `display notification "${escapeAS(message)}" with title "${escapeAS(title)}"`;
    const child = spawn('osascript', ['-e', cmd], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {}); // swallow ENOENT etc.
    child.unref();
  } catch {
    // Pure best-effort. Never throw.
  }
}

/**
 * Best-effort Telegram bot notification. Skips silently when
 * TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars are absent.
 *
 * Bot setup (one-time):
 *   1. Talk to @BotFather on Telegram → /newbot → save the token
 *   2. Send the bot any message → visit
 *      https://api.telegram.org/bot<TOKEN>/getUpdates → copy chat.id
 *   3. Configure via launchd plist EnvironmentVariables, OR export
 *      TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID before running bin/dream.js
 *
 * The dream worker uses Telegram's HTTPS API directly — no SDK, no
 * dependency. Markdown formatting supported.
 *
 * Failure (network down, bad token, rate-limited, --no-telegram) NEVER
 * fails the worker. Suppressed by --no-notify (umbrella) or --no-telegram.
 */
async function notifyTelegram({ token, chatId, threadId, title, message, suppress, verbose = false }) {
  if (suppress) return { skipped: true, reason: 'suppressed' };
  if (!token || !chatId) return { skipped: true, reason: 'not configured (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID unset)' };
  try {
    const text = `*${title}*\n\`\`\`\n${String(message).slice(0, 3500)}\n\`\`\``;
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_notification: false,
    };
    // Topic / forum-thread support: posts INTO a topic of a supergroup.
    // Required when the chat is a forum-enabled supergroup. Telegram
    // ignores the field for non-forum chats.
    if (threadId) body.message_thread_id = Number(threadId);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (verbose) {
        const respBody = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(respBody); } catch {}
        return {
          ok: res.ok && parsed?.ok === true,
          status: res.status,
          response: parsed || respBody.slice(0, 500),
        };
      }
      return { ok: res.ok };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Fan-out notification dispatch. Each channel is independent + fire-and-
 * forget: macOS bubble, Telegram message. Add new channels here.
 */
async function notifyAll({ title, message, suppress, suppressTelegram }) {
  notifyMacOS({ title, message, suppress });
  await notifyTelegram({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    threadId: process.env.TELEGRAM_THREAD_ID,
    title,
    message,
    suppress: suppress || suppressTelegram,
  });
}

function isSunday(isoDate) {
  // Local-time check: a YYYY-MM-DD parsed via Date treats it as UTC midnight,
  // which is Sunday-shifted in some zones. Reconstruct as local-time noon to
  // sidestep DST + UTC drift; the only thing we need is the day-of-week.
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getDay() === 0;
}

// Resolve final verdict from Stage A + Stage B outputs. FAIL beats WARN
// beats PASS. 'skipped' (Stage B not run because Stage A failed or
// --skip-stage-b) is treated as not contributing to the verdict.
export function resolveFinalVerdict(stageA, stageB) {
  const a = stageA?.verdict;
  const b = stageB?.verdict;
  if (a === 'FAIL' || b === 'FAIL') return 'FAIL';
  if (a === 'WARN' || b === 'WARN') return 'WARN';
  if (a === 'PASS' || b === 'PASS') return 'PASS';
  // Defensive: unknown verdict labels fail-closed.
  return 'FAIL';
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

  // --test-notify: fire one notification through the full notify path
  // (macOS bubble + Telegram if configured) and exit. Useful for verifying
  // that TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / TELEGRAM_THREAD_ID env
  // wiring is correct after install. No vault access; --memory-root is
  // optional in this mode. Checked BEFORE --memory-root validation so
  // operators can run it without scaffolding a fake vault.
  if (args.testNotify) {
    const today = args.today || todayISO();
    const message =
      `TEST — notification path is wired. `
      + `If you see this in Telegram + macOS Notification Center, you're set.`;
    process.stdout.write(`[test-notify] firing notification\n`);
    process.stdout.write(`  TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '<set>' : '<unset>'}\n`);
    process.stdout.write(`  TELEGRAM_CHAT_ID:   ${process.env.TELEGRAM_CHAT_ID || '<unset>'}\n`);
    process.stdout.write(`  TELEGRAM_THREAD_ID: ${process.env.TELEGRAM_THREAD_ID || '<unset>'}\n`);

    const title = `dream-mgmt ${today} (test)`;

    // macOS bubble — fire-and-forget.
    notifyMacOS({ title, message, suppress: false });

    // Telegram — fire with verbose:true so we can surface the API response
    // for debugging. Token redaction: notifyTelegram doesn't log the token;
    // the response is the API's reply body which Telegram does NOT echo
    // tokens into. Safe to print.
    const tgResult = await notifyTelegram({
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      threadId: process.env.TELEGRAM_THREAD_ID,
      title,
      message,
      suppress: false,
      verbose: true,
    });
    if (tgResult.skipped) {
      process.stdout.write(`[test-notify] Telegram: SKIPPED — ${tgResult.reason}\n`);
    } else if (tgResult.ok) {
      process.stdout.write(`[test-notify] Telegram: OK (HTTP ${tgResult.status})\n`);
      const r = tgResult.response;
      if (r && r.result) {
        process.stdout.write(
          `  message_id=${r.result.message_id} `
          + `chat=${r.result.chat?.id} `
          + `thread=${r.result.message_thread_id ?? 'none'}\n`,
        );
      }
    } else {
      process.stdout.write(`[test-notify] Telegram: FAILED (HTTP ${tgResult.status ?? '?'})\n`);
      if (tgResult.error) {
        process.stdout.write(`  error: ${tgResult.error}\n`);
      }
      if (tgResult.response) {
        const r = tgResult.response;
        const desc = r?.description ?? JSON.stringify(r).slice(0, 300);
        process.stdout.write(`  response: ${desc}\n`);
      }
    }
    process.stdout.write(`[test-notify] check macOS Notification Center for the bubble\n`);
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
  const skipDualGate = args.skipDualGate;
  const skipStageB = args.skipStageB;
  const skipAudit = args.skipAudit;
  const noNotify = args.noNotify || process.env.DREAM_NO_NOTIFY === '1';
  const noTelegram = args.noTelegram || process.env.DREAM_NO_TELEGRAM === '1';
  const stageBCommandLine = args.stageBCommand || null;
  const notifyTitle = `dream-mgmt ${today}`;
  const notifyOpts = { suppress: noNotify, suppressTelegram: noTelegram };

  // Production audit-bypass guard. --skip-audit and --skip-stage-b weaken
  // the integrity guarantees of the run; in test/dev they're necessary
  // (no codex CLI in CI), but in production they're foot-guns. Require
  // DREAM_ALLOW_AUDIT_BYPASS=1 to use either flag outside dry-run mode.
  // Without the env var, surface a usage error and exit 1.
  if ((skipAudit || skipStageB) && !dryRun
      && process.env.DREAM_ALLOW_AUDIT_BYPASS !== '1') {
    process.stderr.write(
      `error: --skip-audit and --skip-stage-b weaken integrity; set `
      + `DREAM_ALLOW_AUDIT_BYPASS=1 to enable, or pass --dry-run.\n`,
    );
    return 1;
  }

  let repoRoot = args.repoRoot ? path.resolve(args.repoRoot) : null;
  if (!repoRoot) {
    repoRoot = await detectRepoRoot(memoryRoot);
    if (!repoRoot) {
      process.stderr.write(`error: --memory-root is not inside a git repo; pass --repo-root\n`);
      return 1;
    }
  }

  // Dual-gate check (skipped on dry-run AND on --skip-dual-gate). Per
  // ARCHITECTURE.md § 3.1, the launchd plist fires every day at 3am; this
  // check decides whether to do real work or write a SKIP line + exit 0.
  if (!dryRun && !skipDualGate) {
    const gate = await checkDualGate({ memoryRoot });
    if (!gate.shouldRun) {
      const skipLine = renderSkipLogLine({ today, gateResult: gate });
      try {
        await atomicAppend(path.join(memoryRoot, '.dream-log.md'), skipLine);
      } catch (e) {
        process.stderr.write(`warn: dual-gate SKIP couldn't append to .dream-log.md: ${e.message}\n`);
      }
      process.stdout.write(`[dual-gate] SKIP — ${gate.reason}\n`);
      await notifyAll({
        title: notifyTitle,
        message: `SKIP — ${gate.reason}`,
        ...notifyOpts,
      });
      return 0;
    }
    process.stdout.write(`[dual-gate] PROCEED — ${gate.reason}\n`);
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
    // Phase D wire-up: detectContradictions reads firingLog and surfaces
    // recurrent rule violations as contradictions. Splice into the Phase 4
    // plan so Phase 5 emits them through event.json.contradictions_surfaced
    // and dream-log-entry.md. Replaces the Phase 4 stub.
    const contradictionResult = detectContradictions({ firingEntries });
    datesResult.plan.contradictions = contradictionResult.contradictions;
    datesResult.summary.contradictionCount = contradictionResult.contradictions.length;
    datesResult.summary.contradictionsStub = false;
    process.stdout.write(
      `[phase-4] dates files=${datesResult.summary.filesWithReplacements} `
      + `replacements=${datesResult.summary.totalReplacements} `
      + `contradictions=${datesResult.summary.contradictionCount}\n`,
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
      return 0;
    }
    const rebuildStage = await stageRebuildPlan({
      plan: rebuildResult.plan, dreamDir, today,
    });
    process.stdout.write(`[phase-5] staged=${rebuildStage.stagedFiles.length}\n`);

    if (skipAudit) {
      process.stdout.write(`[audit] SKIPPED (--skip-audit) — staged tree preserved, no sweep\n`);
      return 0;
    }

    // ---- AUDIT GATE (Phase 5+) -----------------------------------
    // Stage A first (deterministic invariants); on FAIL, skip Stage B
    // and abort sweep. Stage B runs only on Stage A PASS or WARN. Sweep
    // runs only if both stages produce non-FAIL verdicts.

    await lock.update('stage-a');
    const stageAResult = await runStageA({ memoryRoot, dreamDir, today });
    process.stdout.write(
      `[stage-a] verdict=${stageAResult.verdict} `
      + `findings=${stageAResult.findings.length} `
      + `failures=${stageAResult.summary.failures} `
      + `warnings=${stageAResult.summary.warnings}\n`,
    );

    let stageBResult = {
      verdict: 'skipped', findings: [], model: null, summary: null,
    };
    if (stageAResult.verdict !== 'FAIL' && !skipStageB) {
      await lock.update('stage-b');
      stageBResult = await runStageB({
        memoryRoot, dreamDir, today,
        commandLine: stageBCommandLine,
      });
      process.stdout.write(
        `[stage-b] verdict=${stageBResult.verdict} `
        + `findings=${stageBResult.findings.length}\n`,
      );
    } else if (skipStageB) {
      process.stdout.write(`[stage-b] SKIPPED (--skip-stage-b)\n`);
      stageBResult = { verdict: 'skipped', findings: [], model: null, summary: { skipped: true } };
    } else {
      process.stdout.write(`[stage-b] SKIPPED (Stage A FAIL)\n`);
    }

    // Final verdict resolution: FAIL > WARN > PASS. SKIPPED stage-b is
    // treated as PASS (the upstream Stage A FAIL already settled verdict).
    const finalVerdict = resolveFinalVerdict(stageAResult, stageBResult);
    let sweepResult = null;
    if (finalVerdict === 'FAIL') {
      process.stdout.write(`[sweep] SKIPPED (final verdict=FAIL — staged tree preserved)\n`);
    } else {
      await lock.update('sweep');
      sweepResult = await runSweep({ memoryRoot, dreamDir, today });
      process.stdout.write(
        `[sweep] aborted=${sweepResult.aborted} `
        + `swept=${sweepResult.swept.length} `
        + `deleted=${sweepResult.deleted.length} `
        + `conflicts=${sweepResult.conflicts.length} `
        + `errors=${sweepResult.errors.length}\n`,
      );
      if (sweepResult.aborted) {
        // Sweep aborted post-finalize: surface as FAIL even though audits passed.
        await finalizeAuditVerdicts({
          dreamDir,
          finalVerdict: 'FAIL',
          stageA: stageAResult,
          stageB: stageBResult,
          sweep: sweepResult,
        });
        await notifyAll({
          title: notifyTitle,
          message:
            `FAIL (sweep aborted) — conflicts=${sweepResult.conflicts.length} `
            + `errors=${sweepResult.errors.length}. Inspect archive/dreams/${today}/staged/`,
          ...notifyOpts,
        });
        return 5;
      }
    }

    await lock.update('finalize');
    await finalizeAuditVerdicts({
      dreamDir,
      finalVerdict,
      stageA: stageAResult,
      stageB: stageBResult,
      sweep: sweepResult,
    });
    process.stdout.write(`[finalize] verdict=${finalVerdict}\n`);

    // Weekly digest: refresh dream-log-weekly.md on Sundays (or whenever
    // the worker fires on a Sunday by local-time). Best-effort — failure
    // here doesn't fail the run; observability is non-critical.
    if (isSunday(today)) {
      try {
        const digest = await generateWeeklyDigest({ memoryRoot, today });
        process.stdout.write(`[digest] wrote ${digest.path} (${digest.summary.runs} runs)\n`);
      } catch (e) {
        process.stderr.write(`warn: weekly digest skipped: ${e.message}\n`);
      }
    }

    // Surface the morning summary. Reads as JJ skims Notification Center:
    //   - PASS verdict + sweep counts (the happy path)
    //   - WARN verdict + finding count (Stage A or B flagged something)
    //   - FAIL verdict + first-finding hint + path-to-evidence
    const swept = sweepResult ? sweepResult.swept.length : 0;
    const deleted = sweepResult ? sweepResult.deleted.length : 0;
    const aFindings = (stageAResult.findings || []).length;
    const bFindings = (stageBResult.findings || []).length;
    let notifyMessage;
    if (finalVerdict === 'PASS') {
      notifyMessage = `PASS — swept ${swept}, deleted ${deleted}`;
    } else if (finalVerdict === 'WARN') {
      notifyMessage = `WARN — Stage A ${aFindings} findings, Stage B ${bFindings}, swept ${swept}`;
    } else {
      const first = (stageAResult.findings || stageBResult.findings || [])[0];
      const hint = first ? first.message.slice(0, 80) : 'audit failed';
      notifyMessage = `FAIL — ${hint}; see archive/dreams/${today}/`;
    }
    await notifyAll({
      title: notifyTitle,
      message: notifyMessage,
      ...notifyOpts,
    });

    return finalVerdict === 'FAIL' ? 5 : 0;
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
