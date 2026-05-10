// Tests for lib/dream/sweep.js — sweep step + finalizeAuditVerdicts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  classifyStaged,
  verifyAllSidecars,
  runSweep,
  finalizeAuditVerdicts,
  _internals,
} from '../lib/dream/sweep.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-sweep-'));
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function scaffoldDreamDir(memoryRoot, opts = {}) {
  const today = opts.today || '2026-05-09';
  const dreamDir = path.join(memoryRoot, 'archive', 'dreams', today);
  await fs.mkdir(path.join(dreamDir, 'staged'), { recursive: true });
  // Minimal event.json + dream-log-entry.md so finalize tests work.
  const evt = {
    schema_version: '1.0.0',
    run_id: today,
    consumer_name: 'test',
    git_tag: `dream/pre/${today}`,
    verdict: 'PASS-TENTATIVE',
    audit: { stage_a: { verdict: 'pending', findings: [] }, stage_b: { verdict: 'pending', findings: [] } },
  };
  await writeFile(path.join(dreamDir, 'event.json'), JSON.stringify(evt, null, 2) + '\n');
  await writeFile(path.join(dreamDir, 'dream-log-entry.md'),
    `## ${today} PASS-TENTATIVE\n\nbody.\n`);
  return { dreamDir, today };
}

// ---- classifyStaged --------------------------------------------------

test('classifyStaged: empty staged/ returns sweepable=true with no items', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  const out = await classifyStaged(path.join(dreamDir, 'staged'));
  assert.equal(out.sweepable, true);
  assert.deepEqual(out.archives, []);
  assert.deepEqual(out.sources, []);
  assert.deepEqual(out.tombstones, []);
});

test('classifyStaged: partitions .tmp / .tombstone / .preimage-sha256', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  await writeFile(path.join(stagedDir, 'corrections.md.tmp'), 'src\n');
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'), 'a\n');
  await writeFile(
    path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'),
    JSON.stringify({ sha256: null }) + '\n',
  );
  await writeFile(path.join(stagedDir, 'patterns', 'active', 'old.md.tombstone'),
    JSON.stringify({ removed_path: 'patterns/active/old.md' }) + '\n');
  const out = await classifyStaged(stagedDir);
  assert.equal(out.archives.length, 1);
  assert.equal(out.archives[0].logicalRel, 'archive/corrections/2026-04.md');
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].logicalRel, 'corrections.md');
  assert.equal(out.tombstones.length, 1);
  assert.equal(out.tombstones[0].logicalRel, 'patterns/active/old.md');
  assert.equal(out.sidecars.length, 1);
});

test('classifyStaged: warns on unrecognized files', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  await writeFile(path.join(dreamDir, 'staged', 'random.txt'), 'x');
  const out = await classifyStaged(path.join(dreamDir, 'staged'));
  assert.ok(out.issues.some(i => /unrecognized/.test(i.message)));
  assert.equal(out.sweepable, true); // warn, not fail
});

// ---- verifyAllSidecars ----------------------------------------------

test('verifyAllSidecars: sha-null sidecar with absent live → no conflict', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'), 'a\n');
  await writeFile(
    path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'),
    JSON.stringify({ sha256: null }) + '\n',
  );
  const cls = await classifyStaged(stagedDir);
  const conflicts = await verifyAllSidecars({ memoryRoot: dir, stagedRoot: stagedDir, archives: cls.archives });
  assert.deepEqual(conflicts, []);
});

test('verifyAllSidecars: sha-null sidecar but live exists → conflict', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'), 'a\n');
  await writeFile(
    path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'),
    JSON.stringify({ sha256: null }) + '\n',
  );
  // Concurrent writer landed a live archive.
  await writeFile(path.join(dir, 'archive', 'corrections', '2026-04.md'), 'race\n');
  const cls = await classifyStaged(stagedDir);
  const conflicts = await verifyAllSidecars({ memoryRoot: dir, stagedRoot: stagedDir, archives: cls.archives });
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].reason, /declares absent at stage but live exists/);
});

test('verifyAllSidecars: sha mismatch → conflict', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  const live = '# old\n';
  await writeFile(path.join(dir, 'archive', 'corrections', '2026-04.md'), live);
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'), 'a\n');
  await writeFile(
    path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'),
    JSON.stringify({ sha256: 'a'.repeat(64) }) + '\n',
  );
  const cls = await classifyStaged(stagedDir);
  const conflicts = await verifyAllSidecars({ memoryRoot: dir, stagedRoot: stagedDir, archives: cls.archives });
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].reason, /sha drifted between stage and sweep/);
});

test('verifyAllSidecars: sha match + live present → no conflict', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  const live = '# live\n';
  const sha = sha256(live);
  await writeFile(path.join(dir, 'archive', 'corrections', '2026-04.md'), live);
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'),
    `${live}\n### new\n`);
  await writeFile(
    path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'),
    JSON.stringify({ sha256: sha }) + '\n',
  );
  const cls = await classifyStaged(stagedDir);
  const conflicts = await verifyAllSidecars({ memoryRoot: dir, stagedRoot: stagedDir, archives: cls.archives });
  assert.deepEqual(conflicts, []);
});

test('verifyAllSidecars: missing sidecar file → conflict', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'), 'a\n');
  // No sidecar.
  const cls = await classifyStaged(stagedDir);
  const conflicts = await verifyAllSidecars({ memoryRoot: dir, stagedRoot: stagedDir, archives: cls.archives });
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].reason, /sidecar file missing/);
});

// ---- runSweep --------------------------------------------------------

test('runSweep: empty staged → no-op success (idempotent re-entry)', async () => {
  const dir = await tmpDir();
  // No staged dir at all.
  await fs.mkdir(path.join(dir, 'archive', 'dreams', '2026-05-09'), { recursive: true });
  const result = await runSweep({
    memoryRoot: dir,
    dreamDir: path.join(dir, 'archive', 'dreams', '2026-05-09'),
    today: '2026-05-09',
  });
  assert.equal(result.aborted, false);
  assert.deepEqual(result.swept, []);
});

test('runSweep dryRun: classifies + verifies but does not rename', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  await writeFile(path.join(stagedDir, 'corrections.md.tmp'), 'new\n');
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'), 'a\n');
  await writeFile(
    path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'),
    JSON.stringify({ sha256: null }) + '\n',
  );
  const result = await runSweep({ memoryRoot: dir, dreamDir, today, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.aborted, false);
  // Live files still don't exist.
  assert.equal(await fileOrNull(path.join(dir, 'corrections.md')), null);
  assert.equal(await fileOrNull(path.join(dir, 'archive', 'corrections', '2026-04.md')), null);
  // Staged files still present.
  assert.notEqual(await fileOrNull(path.join(stagedDir, 'corrections.md.tmp')), null);
});

test('runSweep happy: archives sweep before sources, tombstones last', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  // Pre-existing live file that should be tombstoned.
  await writeFile(path.join(dir, 'patterns', 'active', 'old.md'), 'old\n');
  // Staged: source rewrite + archive append + tombstone.
  await writeFile(path.join(stagedDir, 'corrections.md.tmp'), 'trimmed\n');
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'), '\n### A\nold body\n');
  await writeFile(
    path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'),
    JSON.stringify({ sha256: null }) + '\n',
  );
  await writeFile(path.join(stagedDir, 'patterns', 'active', 'old.md.tombstone'),
    JSON.stringify({ removed_path: 'patterns/active/old.md' }) + '\n');
  const result = await runSweep({ memoryRoot: dir, dreamDir, today });
  assert.equal(result.aborted, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.swept.sort(),
    ['archive/corrections/2026-04.md', 'corrections.md'].sort());
  assert.deepEqual(result.deleted, ['patterns/active/old.md']);
  // Live tree updated.
  assert.equal(await fs.readFile(path.join(dir, 'corrections.md'), 'utf8'), 'trimmed\n');
  assert.equal(await fs.readFile(path.join(dir, 'archive', 'corrections', '2026-04.md'), 'utf8'),
    '\n### A\nold body\n');
  assert.equal(await fileOrNull(path.join(dir, 'patterns', 'active', 'old.md')), null);
  // Staged tree cleaned up.
  assert.equal(await fileOrNull(stagedDir), null);
});

test('runSweep abort: sidecar conflict prevents any rename', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  // Live archive exists; sidecar declares wrong sha.
  await writeFile(path.join(dir, 'archive', 'corrections', '2026-04.md'), 'race\n');
  await writeFile(path.join(stagedDir, 'corrections.md.tmp'), 'trimmed\n');
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'), 'overwrite\n');
  await writeFile(
    path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'),
    JSON.stringify({ sha256: 'a'.repeat(64) }) + '\n',
  );
  const result = await runSweep({ memoryRoot: dir, dreamDir, today });
  assert.equal(result.aborted, true);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.swept, []);
  // Source NOT renamed (abort before any rename).
  assert.equal(await fileOrNull(path.join(dir, 'corrections.md')), null);
  // Live archive unchanged.
  assert.equal(await fs.readFile(path.join(dir, 'archive', 'corrections', '2026-04.md'), 'utf8'),
    'race\n');
});

test('runSweep idempotency: re-running after a partial completion (simulated) skips done items', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  // First sweep: stage two sources.
  await writeFile(path.join(stagedDir, 'corrections.md.tmp'), 'a\n');
  await writeFile(path.join(stagedDir, 'session-index.md.tmp'), 'b\n');
  await runSweep({ memoryRoot: dir, dreamDir, today });
  // Verify both swept.
  assert.equal(await fs.readFile(path.join(dir, 'corrections.md'), 'utf8'), 'a\n');
  // Second sweep on the same dreamDir is a no-op (staged/ removed).
  const result2 = await runSweep({ memoryRoot: dir, dreamDir, today });
  assert.deepEqual(result2.swept, []);
  assert.deepEqual(result2.errors, []);
});

test('runSweep: tombstone for nonexistent file is no-op (no error)', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDreamDir(dir);
  await writeFile(path.join(dreamDir, 'staged', 'patterns', 'active', 'ghost.md.tombstone'),
    JSON.stringify({ removed_path: 'patterns/active/ghost.md', target_missing: true }) + '\n');
  const result = await runSweep({ memoryRoot: dir, dreamDir, today });
  assert.equal(result.aborted, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.deleted, ['patterns/active/ghost.md']);
});

test('runSweep: rejects bad today', async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () => runSweep({ memoryRoot: dir, dreamDir: '/x', today: 'bad' }),
    /today must match YYYY-MM-DD/,
  );
});

test('runSweep: refuses symlinks in staged tree (skipped, not followed)', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDreamDir(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  await writeFile(path.join(dir, 'outside.md'), 'outside\n');
  await fs.symlink(path.join(dir, 'outside.md'),
    path.join(stagedDir, 'sneaky.md.tmp'));
  await writeFile(path.join(stagedDir, 'corrections.md.tmp'), 'real\n');
  const result = await runSweep({ memoryRoot: dir, dreamDir, today });
  // Symlink not in classified.sources because walkRel skips symlinks.
  assert.deepEqual(result.swept, ['corrections.md']);
  // Outside file was not consumed.
  assert.equal(await fs.readFile(path.join(dir, 'outside.md'), 'utf8'), 'outside\n');
});

// ---- finalizeAuditVerdicts ------------------------------------------

test('finalizeAuditVerdicts: PASS verdict updates event.json + dream-log-entry.md heading', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  const out = await finalizeAuditVerdicts({
    dreamDir,
    finalVerdict: 'PASS',
    stageA: { verdict: 'PASS', findings: [], summary: { checks_run: 10, failures: 0, warnings: 0 } },
    stageB: { verdict: 'PASS', findings: [], summary: {}, model: 'gpt-5-codex' },
    sweep: { swept: ['a', 'b'], deleted: [], conflicts: [], errors: [], aborted: false },
  });
  assert.ok(out.eventJsonPath);
  const evt = JSON.parse(await fs.readFile(out.eventJsonPath, 'utf8'));
  assert.equal(evt.verdict, 'PASS');
  assert.equal(evt.audit.stage_a.verdict, 'PASS');
  assert.equal(evt.audit.stage_b.verdict, 'PASS');
  assert.equal(evt.audit.stage_b.model, 'gpt-5-codex');
  assert.equal(evt.audit.sweep.swept_count, 2);
  const dle = await fs.readFile(out.dreamLogEntryPath, 'utf8');
  assert.match(dle, /## 2026-05-09 PASS$/m);
  assert.match(dle, /\*\*Stage A\*\*: PASS/);
  assert.match(dle, /\*\*Stage B\*\*: PASS/);
  assert.match(dle, /\*\*Sweep\*\*: aborted=false swept=2/);
});

test('finalizeAuditVerdicts: FAIL verdict captures aborted sweep', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  const out = await finalizeAuditVerdicts({
    dreamDir,
    finalVerdict: 'FAIL',
    stageA: { verdict: 'FAIL', findings: [{ check: 'conservation', severity: 'fail', message: 'broken' }] },
    stageB: { verdict: 'pending', findings: [], model: null },
    sweep: { swept: [], deleted: [], conflicts: [], errors: [], aborted: true },
  });
  const evt = JSON.parse(await fs.readFile(out.eventJsonPath, 'utf8'));
  assert.equal(evt.verdict, 'FAIL');
  assert.equal(evt.audit.sweep.aborted, true);
  const dle = await fs.readFile(out.dreamLogEntryPath, 'utf8');
  assert.match(dle, /## 2026-05-09 FAIL$/m);
  assert.match(dle, /\*\*Sweep\*\*: aborted=true/);
});

test('finalizeAuditVerdicts: rejects bad finalVerdict', async () => {
  const dir = await tmpDir();
  const { dreamDir } = await scaffoldDreamDir(dir);
  await assert.rejects(
    () => finalizeAuditVerdicts({
      dreamDir, finalVerdict: 'YOLO',
      stageA: { verdict: 'PASS', findings: [] },
      stageB: { verdict: 'PASS', findings: [] },
    }),
    /finalVerdict must be PASS\|WARN\|FAIL/,
  );
});

test('finalizeAuditVerdicts: missing event.json throws', async () => {
  const dir = await tmpDir();
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-09');
  await fs.mkdir(dreamDir, { recursive: true });
  await assert.rejects(
    () => finalizeAuditVerdicts({
      dreamDir, finalVerdict: 'PASS',
      stageA: { verdict: 'PASS', findings: [] },
      stageB: { verdict: 'PASS', findings: [] },
    }),
    /event\.json not found/,
  );
});

// ---- helpers --------------------------------------------------------

async function fileOrNull(p) {
  try { return await fs.readFile(p, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

test('walkRel internal helper: skips symlinks', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'a.md'), 'a');
  await fs.symlink(path.join(dir, 'a.md'), path.join(dir, 'link.md'));
  const out = await _internals.walkRel(dir);
  assert.deepEqual(out, ['a.md']);
});
