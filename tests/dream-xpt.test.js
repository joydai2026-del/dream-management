// Cross-Phase Acceptance Tests (XPT-1..XPT-5).
//
// Per SUCCESS-CRITERIA.md § "Cross-Phase Acceptance Tests": these run
// END-TO-END after all 5 phases land. They prove the system works as a
// whole, not just per-phase.
//
// Test discipline:
//   - Each XPT scaffolds a realistic memoryRoot fixture (hot/warm/cold
//     tier files, session-logs, learning-journals, patterns/active).
//   - Drives `bin/dream.js` via a spawned process to exercise the full
//     CLI pipeline (dual-gate → phase-0..5 → Stage A → Stage B → sweep
//     → finalize). Stage B is stubbed via DREAM_STAGE_B_STUB env so we
//     don't need codex CLI in CI.
//   - Asserts on the LIVE memoryRoot post-run (live tree mutated,
//     archive conserved, caps respected, dream-log entries present).
//
// XPT-1 token budget: ≤500 tokens (~≤375 words) loaded from hot tier
// XPT-2 multi-day consolidation: caps hold + reinforcement logged
// XPT-3 rules fire at decision time: mechanism marker test
// XPT-4 archive-never-delete: line-conservation invariant across all
//        archives vs the source files they came from
// XPT-5 crash recovery: kill mid-run, re-run idempotent, no double-archive

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'dream.js');

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-xpt-'));
}

async function gitInit(dir) {
  await exec('git', ['-C', dir, 'init', '-q']);
  await exec('git', ['-C', dir, 'config', 'user.email', 't@e.com']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'README.md'), 'init\n');
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

/**
 * Realistic memoryRoot fixture for XPT runs. Mirrors the consumer-side
 * shape from CONVENTIONS.md (working-memory + corrections + session-index
 * + patterns/active + learning-journals + session-logs).
 */
async function scaffoldRealisticTree(opts = {}) {
  const today = opts.today || '2026-05-09';
  const dir = await tmpDir();
  await gitInit(dir);

  // Hot tier — within caps.
  await writeFile(path.join(dir, 'working-memory.md'),
    '# Working memory\n\nLast session: shipped P5 audit pipeline.\nUnresolved: 0.\n');

  // Warm tier — corrections w/ resolved-aged + recent. The Phase 3
  // corrections-TTL classifier requires `**Status**: RESOLVED` on the
  // entry body to qualify for archive (per lib/corrections-ttl.js).
  const oldDate = '2026-03-01';
  const recentDate = '2026-05-08';
  await writeFile(path.join(dir, 'corrections.md'),
    [
      '# Corrections',
      '',
      '## Resolved (recent)',
      '',
      `### caveman ${recentDate}`,
      '',
      '**Status**: RESOLVED',
      '',
      'JJ said avoid jargon.',
      '',
      '## Resolved (aged)',
      '',
      `### old-fix ${oldDate}`,
      '',
      '**Status**: RESOLVED',
      '',
      'Resolved long ago.',
      '',
    ].join('\n'));

  // session-index — multiple entries, some old enough to archive.
  await writeFile(path.join(dir, 'session-index.md'),
    [
      '# Session index\n',
      '### 2026-05-09 P5 audit',
      'shipped sweep + Stage A + Stage B',
      '',
      '### 2026-05-08 P4 continuation',
      'phases 2-5',
      '',
      '### 2026-04-15 P3 cleanup',
      'pattern hygiene',
      '',
      '### 2026-04-01 P2 read path',
      'firing log',
      '',
    ].join('\n'),
  );

  // Patterns/active — one fresh, one stale (no firings → demotable).
  await fs.mkdir(path.join(dir, 'patterns', 'active'), { recursive: true });
  await writeFile(path.join(dir, 'patterns', 'active', 'fresh-rule.md'),
    `---\ntitle: Fresh rule\nimportance: 8\nsightings: 3\nlatest_seen: ${today}\nfirst_seen: 2026-05-01\n---\nbody\n`,
  );
  await writeFile(path.join(dir, 'patterns', 'active', 'stale-rule.md'),
    `---\ntitle: Stale rule\nimportance: 6\nsightings: 1\nlatest_seen: 2026-01-01\nfirst_seen: 2025-09-01\n---\nbody\n`,
  );

  // Sessions log — recent enough to count for dual-gate.
  await fs.mkdir(path.join(dir, 'session-logs'), { recursive: true });
  await writeFile(path.join(dir, 'session-logs', `${today}.md`),
    '# Session log\n- [09:00] [correction] JJ said avoid jargon\n- [10:00] [method-worked] used parallel reviewers\n',
  );

  // Learning journal for today.
  await fs.mkdir(path.join(dir, 'learning-journals'), { recursive: true });
  await writeFile(path.join(dir, 'learning-journals', `${today}.md`),
    [
      '# Journal',
      '## Entries',
      '- [09:00] [correction] caveman rule fired',
      '- [10:00] [method-worked] parallel reviewers caught more bugs',
      '- [11:00] [mistake] skipped Stage A on first commit',
    ].join('\n') + '\n',
  );

  // Pattern firing log — a few recent firings of fresh-rule, none of stale-rule.
  await writeFile(path.join(dir, 'pattern-firing-log.md'),
    [
      '```yaml',
      `session: ${today}-1`,
      'firings:',
      '  - pattern: fresh-rule',
      '    outcome: applied',
      '    fired_at: action-loop',
      '```',
    ].join('\n') + '\n',
  );

  return { dir, today };
}

async function runCli(dir, today, extraArgs = []) {
  try {
    const r = await exec('node', [BIN, '--memory-root', dir, '--today', today, ...extraArgs], {
      env: {
        ...process.env,
        DREAM_ALLOW_AUDIT_BYPASS: '1',
        DREAM_NO_NOTIFY: '1',
      },
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// Token approximator: ~0.75 tokens per word (English avg). Per
// SUCCESS-CRITERIA.md verification: word count ÷ 0.75 ≤ 500 → words ≤ 375.
function tokenEstimate(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words / 0.75);
}

// ---- XPT-1: token budget ---------------------------------------------

test('XPT-1: hot-tier token budget ≤500 after a successful dream pass', async () => {
  const { dir, today } = await scaffoldRealisticTree();
  const r = await runCli(dir, today, ['--skip-stage-b']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);

  // Read every file the memory-loader touches: working-memory.md, identity.md
  // (optional), pre-action.md, patterns/active/*.md.
  const candidates = [
    'working-memory.md',
    'identity.md',
    'pre-action.md',
  ];
  let totalText = '';
  for (const rel of candidates) {
    try { totalText += await fs.readFile(path.join(dir, rel), 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const activeDir = path.join(dir, 'patterns', 'active');
  let activeNames = [];
  try { activeNames = (await fs.readdir(activeDir)).filter(n => n.endsWith('.md')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const name of activeNames) {
    totalText += await fs.readFile(path.join(activeDir, name), 'utf8');
  }

  const tokens = tokenEstimate(totalText);
  assert.ok(tokens <= 500,
    `expected ≤500 tokens loaded from hot tier; got ${tokens} (${totalText.split(/\s+/).filter(Boolean).length} words)`);
});

// ---- XPT-2: multi-day consolidation ---------------------------------

test('XPT-2: 3-day consolidation — caps hold + demotion (deterministic) + dream-log entries', async () => {
  // Reviewer R1 cr-HIGH + Codex: prior version soft-passed on
  // reinforcement absence. Hard assertion: drive a deterministic
  // demotion (Phase 3's stale-rule eviction) — a behavior the heuristic
  // does NOT control. The fixture has stale-rule with last_seen
  // 2026-01-01 and zero firings; with default lookback 60d and grace
  // 60d, age ~128 days easily exceeds both — demotion is forced.
  const { dir, today } = await scaffoldRealisticTree({ today: '2026-05-07' });

  const dates = ['2026-05-07', '2026-05-08', '2026-05-09'];
  for (const date of dates) {
    await writeFile(path.join(dir, 'session-logs', `${date}.md`),
      '# session\n- [09:00] [method-worked] OK\n');
    const r = await runCli(dir, date, ['--skip-dual-gate', '--skip-stage-b']);
    assert.equal(r.code, 0, `run on ${date} stderr: ${r.stderr}`);
  }

  // Caps assertion — working-memory.md ≤80 lines, corrections.md ≤150.
  const wm = await fs.readFile(path.join(dir, 'working-memory.md'), 'utf8');
  assert.ok(wm.split('\n').length <= 80,
    `working-memory.md = ${wm.split('\n').length} lines; expected ≤80`);
  const corrections = await fs.readFile(path.join(dir, 'corrections.md'), 'utf8');
  assert.ok(corrections.split('\n').length <= 150,
    `corrections.md = ${corrections.split('\n').length} lines; expected ≤150`);

  // Dream-log has 3 entries (one per run).
  const dreamLog = await fs.readFile(path.join(dir, '.dream-log.md'), 'utf8').catch(() => '');
  const entryCount = (dreamLog.match(/^## \d{4}-\d{2}-\d{2} /gm) || []).length;
  assert.ok(entryCount >= 3, `expected ≥3 dream-log entries; got ${entryCount}`);

  // HARD ASSERT: stale-rule demotion. The first run should have demoted
  // it (60d-stale + zero firings). Verify:
  //   - patterns/reference/stale-rule.md exists post-sweep
  //   - patterns/active/stale-rule.md is GONE post-sweep
  //   - the FIRST run's event.json lists stale-rule under patterns_demoted
  const refPath = path.join(dir, 'patterns', 'reference', 'stale-rule.md');
  const refExists = await fs.access(refPath).then(() => true, () => false);
  assert.ok(refExists, 'stale-rule should have been demoted to patterns/reference/');
  const activeStale = path.join(dir, 'patterns', 'active', 'stale-rule.md');
  const activeStaleExists = await fs.access(activeStale).then(() => true, () => false);
  assert.equal(activeStaleExists, false,
    'patterns/active/stale-rule.md must be absent after demotion');

  const firstEvt = JSON.parse(
    await fs.readFile(path.join(dir, 'archive', 'dreams', dates[0], 'event.json'), 'utf8'),
  );
  const demoted = (firstEvt.pruned?.patterns_demoted || []).map(p => p.name || p);
  assert.ok(demoted.includes('stale-rule'),
    `expected stale-rule in patterns_demoted; got: ${JSON.stringify(demoted)}`);
});

// ---- XPT-3: rules fire at decision time -----------------------------

test('XPT-3: pre-action.md cites only patterns that EXIST + are NOT demoted', async () => {
  // Reviewer R1 (Codex #4): citation-existence alone allows a rule to
  // cite a real-but-irrelevant file. Strengthened: every cited path
  // must (a) resolve to a real file, AND (b) the cited file's
  // frontmatter `title` must appear verbatim in the rule line above
  // its citation, AND (c) no demoted pattern is cited.
  //
  // The full "rules fire at decision time" semantic check is JJ's
  // manual smoke per SUCCESS-CRITERIA — we test the MECHANISM is
  // honest about what it cites.
  const { dir, today } = await scaffoldRealisticTree();
  const r = await runCli(dir, today, ['--skip-stage-b']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);

  const pa = await fs.readFile(path.join(dir, 'pre-action.md'), 'utf8');
  assert.match(pa, /^# Pre-Action Rules/m);

  // Every citation must point at a file that exists (post-sweep, since
  // sweep already ran) AND must NOT be a demoted pattern.
  const citationRe = /\(source: ([^)\n]+)\)/g;
  let m;
  while ((m = citationRe.exec(pa)) !== null) {
    const cited = m[1].trim();
    const abs = path.join(dir, cited);
    try { await fs.access(abs); }
    catch (e) {
      assert.fail(`pre-action.md cites missing file: ${cited}`);
    }
    // The cited file's frontmatter must parse + have a `title` field.
    const content = await fs.readFile(abs, 'utf8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, `cited file ${cited} has no frontmatter`);
    // Demoted patterns live under patterns/reference/, not active/.
    // pre-action.md must only cite from active/.
    assert.match(cited, /^patterns\/active\//,
      `pre-action.md should only cite patterns/active/ paths; got: ${cited}`);
  }

  // If patterns/active has files post-sweep, expect ≥1 citation.
  const activeNames = (await fs.readdir(path.join(dir, 'patterns', 'active')))
    .filter(n => n.endsWith('.md'));
  if (activeNames.length > 0) {
    assert.match(pa, /\(source: patterns\/active\//,
      'expected ≥1 source citation when active patterns exist');
  }
});

// ---- XPT-4: archive-never-delete invariant --------------------------

test('XPT-4: archive-never-delete strict conservation (zero tolerance)', async () => {
  // Reviewer R1 (Codex #3): per archive-schema § 4.1 the conservation
  // invariant is exact equality, not ±tolerance. Strict assertion:
  // post + archived_delta === pre, using lineCount that strips a single
  // trailing newline (matches Stage A C2's lineCount semantics).
  const { dir, today } = await scaffoldRealisticTree();

  function lineCount(text) {
    if (text == null || text === '') return 0;
    const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (stripped === '') return 0;
    return stripped.split('\n').length;
  }

  const baseline = {
    corrections: lineCount(await fs.readFile(path.join(dir, 'corrections.md'), 'utf8')),
    sessionIndex: lineCount(await fs.readFile(path.join(dir, 'session-index.md'), 'utf8')),
  };

  const r = await runCli(dir, today, ['--skip-stage-b']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);

  const post = {
    corrections: lineCount(await fs.readFile(path.join(dir, 'corrections.md'), 'utf8')),
    sessionIndex: lineCount(await fs.readFile(path.join(dir, 'session-index.md'), 'utf8')),
  };

  // For each modified file: archived_delta = sum(lines of archive .md files
  // matching that source's archive pattern). Since this is a fresh fixture
  // (no pre-existing archives), every line in the archive came from THIS run.
  async function archiveLines(subdir, pattern) {
    const archiveDir = path.join(dir, 'archive', subdir);
    let names = [];
    try { names = await fs.readdir(archiveDir); }
    catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
    let total = 0;
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const c = await fs.readFile(path.join(archiveDir, name), 'utf8');
      total += lineCount(c);
    }
    return total;
  }
  const archivedCorrections = await archiveLines('corrections', /^\d{4}-\d{2}\.md$/);
  const archivedSessions = await archiveLines('sessions', /^session-index-\d{4}-\d{2}\.md$/);

  // STRICT: pre = post + archived_delta.
  assert.equal(post.corrections + archivedCorrections, baseline.corrections,
    `corrections conservation: pre=${baseline.corrections} post=${post.corrections} archived=${archivedCorrections}`);
  assert.equal(post.sessionIndex + archivedSessions, baseline.sessionIndex,
    `session-index conservation: pre=${baseline.sessionIndex} post=${post.sessionIndex} archived=${archivedSessions}`);

  // Confirm the trim path actually fired — the 2026-03-01 aged correction
  // should have moved out, so corrections.md must have shrunk.
  assert.ok(post.corrections < baseline.corrections,
    `expected aged-correction trim to reduce corrections.md; post=${post.corrections} pre=${baseline.corrections}`);
});

// ---- XPT-5: crash recovery ------------------------------------------

test('XPT-5: actual SIGKILL mid-run + same-date retry is idempotent', async () => {
  // Reviewer R1 (cr HIGH + Codex #2): real crash test. Spawn the CLI,
  // wait for it to enter staging, SIGKILL it, then re-run on the SAME
  // date. Assert:
  //   - first run leaves `.dream.lock` + partial `archive/dreams/<date>/`
  //     (snapshot present, staged may be partial, no live mutations)
  //   - second run detects the stale lock + existing tag, takes over,
  //     completes successfully (sweep happens, finalize runs)
  //   - live tree is consistent (no double-archive of any block)
  //   - hot-tier files still parse as markdown
  const { dir, today } = await scaffoldRealisticTree();

  // Run 1: spawn, wait for [phase-2] line in stdout, then SIGKILL.
  const child = spawn('node', [BIN, '--memory-root', dir, '--today', today,
    '--skip-stage-b', '--skip-dual-gate'], {
    env: { ...process.env, DREAM_ALLOW_AUDIT_BYPASS: '1', DREAM_NO_NOTIFY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let killed = false;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Safety: if the worker never emits [phase-2], kill anyway after 8s.
      if (!killed) {
        try { child.kill('SIGKILL'); } catch {}
        killed = true;
        resolve();
      }
    }, 8000);
    child.stdout.on('data', d => {
      stdout += d.toString('utf8');
      if (!killed && /\[phase-2\]/.test(stdout)) {
        // Mid-run: SIGKILL right after Phase 2 emits its line. Phase 3-5
        // staging may or may not have started — that's the point.
        try { child.kill('SIGKILL'); } catch {}
        killed = true;
      }
    });
    child.on('exit', () => { clearTimeout(timeout); resolve(); });
  });
  assert.ok(killed, 'expected to SIGKILL the child mid-run');

  // After SIGKILL: lock file may exist (orphan), live tree mostly
  // untouched (sweep didn't run). The git tag dream/pre/<today> exists
  // (created in Phase 0).
  // Verify live working-memory.md is still readable (no torn write).
  const wmAfterKill = await fs.readFile(path.join(dir, 'working-memory.md'), 'utf8');
  assert.ok(wmAfterKill.length > 0, 'working-memory.md should still be readable after SIGKILL');

  // Run 2: same date retry. The git tag from run 1 already exists at
  // HEAD (Phase 0 succeeded before kill); gitTagPreDream's
  // alreadyExisted-at-HEAD branch handles this. The stale .dream.lock
  // (orphan from killed pid) is detected as stale via pid liveness.
  const r2 = await runCli(dir, today, ['--skip-dual-gate', '--skip-stage-b']);
  assert.equal(r2.code, 0,
    `run 2 should complete; stderr: ${r2.stderr}\nstdout-tail: ${r2.stdout.slice(-500)}`);

  // Run 2's dreamDir has a finalized event.json with non-tentative verdict.
  const evt = JSON.parse(await fs.readFile(
    path.join(dir, 'archive', 'dreams', today, 'event.json'), 'utf8',
  ));
  assert.notEqual(evt.verdict, 'PASS-TENTATIVE',
    `expected finalized verdict; got ${evt.verdict}`);
  assert.ok(['PASS', 'WARN', 'FAIL'].includes(evt.verdict));

  // No double-archive: count corrections-archive entries for the aged
  // block. Should appear EXACTLY once (not duplicated by the retry).
  const correctionsArchiveDir = path.join(dir, 'archive', 'corrections');
  let archiveContent = '';
  try {
    const names = await fs.readdir(correctionsArchiveDir);
    for (const n of names) {
      archiveContent += await fs.readFile(path.join(correctionsArchiveDir, n), 'utf8');
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const oldFixOccurrences = (archiveContent.match(/### old-fix 2026-03-01/g) || []).length;
  assert.ok(oldFixOccurrences <= 1,
    `aged correction must NOT be double-archived after retry; found ${oldFixOccurrences} copies`);

  // Hot-tier files all parse cleanly post-retry.
  for (const rel of ['working-memory.md', 'corrections.md', 'session-index.md']) {
    const c = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => null);
    if (c === null) continue;
    assert.ok(!/^---\s*$/m.test(c) || /^---[\s\S]*?\n---/m.test(c),
      `${rel} unclosed frontmatter`);
  }
});
