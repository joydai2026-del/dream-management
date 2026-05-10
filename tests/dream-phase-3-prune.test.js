import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPrune, stagePrunePlan, _internals } from '../lib/dream/phase-3-prune.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-p3-'));
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

// Build a corrections.md with two RESOLVED-and-aged + one fresh-UNRESOLVED.
function correctionsFixture() {
  return [
    '# Corrections Log',
    '',
    '## Recent',
    '',
    '### 2026-04-01 RESOLVED — fixed bug X',
    '',
    '**Status**: RESOLVED 2026-04-01',
    '',
    'Body.',
    '',
    '### 2026-04-05 RESOLVED — fixed bug Y',
    '',
    '**Status**: RESOLVED 2026-04-05',
    '',
    'Body.',
    '',
    '### 2026-05-08 UNRESOLVED — still pending',
    '',
    '**Status**: UNRESOLVED',
    '',
    'Body.',
    '',
  ].join('\n');
}

function sessionIndexFixture(n) {
  const lines = ['# Session Index', '', '## Recent', ''];
  for (let i = 0; i < n; i++) {
    const date = new Date(2026, 3, 1 + i).toISOString().slice(0, 10);
    lines.push(`### ${date} session ${i}`);
    lines.push('');
    lines.push(`Body for session ${i}.`);
    lines.push('');
  }
  return lines.join('\n');
}

test('runPrune: empty memoryRoot returns plan with no archived items', async () => {
  const dir = await tmpDir();
  const { plan, summary } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    now: new Date('2026-05-10T03:00:00Z'),
  });
  assert.equal(plan.corrections.found, false);
  assert.equal(plan.sessionIndex.found, false);
  assert.equal(plan.journal.found, false);
  assert.deepEqual(plan.demotions, []);
  assert.equal(summary.demotedCount, 0);
});

test('runPrune: corrections plan archives RESOLVED-and-aged entries by month', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'corrections.md'), correctionsFixture());
  const { plan, summary } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    now: new Date('2026-05-10T03:00:00Z'),
  });
  assert.equal(plan.corrections.found, true);
  assert.equal(plan.corrections.archive.length, 2); // both April RESOLVED entries
  assert.equal(plan.corrections.byMonth.length, 1);
  assert.equal(plan.corrections.byMonth[0].monthKey, '2026-04');
  assert.equal(summary.correctionsArchivedBlocks, 2);
});

test('runPrune: session-index plan keeps last-N, archives older grouped by ISO month', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'session-index.md'), sessionIndexFixture(15));
  const { plan, summary } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    gates: { sessionIndexKeepLastN: 10 },
  });
  assert.equal(plan.sessionIndex.found, true);
  assert.equal(plan.sessionIndex.archive.length, 5);
  assert.equal(summary.sessionIndexKeptBlocks, 10);
});

test('runPrune: journal plan locates today\'s file and stamps target path', async () => {
  const dir = await tmpDir();
  await writeFile(
    path.join(dir, 'learning-journals', '2026-05-10.md'),
    '# Today\n\n- [09:00] [mistake] x\n',
  );
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
  });
  assert.equal(plan.journal.found, true);
  assert.equal(plan.journal.sourceRel, path.join('learning-journals', '2026-05-10.md'));
  assert.equal(plan.journal.targetRel, path.join('archive', 'journals', '2026-05', '2026-05-10.md'));
  assert.equal(plan.journal.monthKey, '2026-05');
});

test('runPrune: demotion plan flags active patterns with zero firings in lookback', async () => {
  const dir = await tmpDir();
  const adir = path.join(dir, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'fresh.md'), `---
title: Fresh
sightings: 5
---
body
`);
  await fs.writeFile(path.join(adir, 'stale.md'), `---
title: Stale
sightings: 1
---
body
`);
  // Firing entries: only `fresh` fired in window. `stale` is a candidate.
  const firingEntries = [{
    session: '2026-05-09-x',
    firings: [{ pattern: 'fresh', outcome: 'applied' }],
  }];
  const { plan, summary } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    firingEntries,
    now: new Date('2026-05-10T03:00:00Z'),
  });
  assert.equal(plan.demotions.length, 1);
  assert.equal(plan.demotions[0].name, 'stale');
  assert.equal(summary.demotedCount, 1);
});

test('runPrune throws on missing required args', async () => {
  await assert.rejects(() => runPrune({ today: 'x' }), /memoryRoot required/);
  await assert.rejects(() => runPrune({ memoryRoot: '/x' }), /today required/);
});

test('stagePrunePlan: corrections — stages trimmed source + per-month archive append', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'corrections.md'), correctionsFixture());
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    now: new Date('2026-05-10T03:00:00Z'),
  });
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  // 1 trimmed source + 1 monthly archive + 1 preimage sidecar (R2)
  assert.equal(stagedFiles.length, 3);
  const trimmed = stagedFiles.find(p => p.endsWith('staged/corrections.md.tmp'));
  assert.ok(trimmed);
  const trimmedContent = await fs.readFile(trimmed, 'utf8');
  // Aged RESOLVED entries are gone, UNRESOLVED kept
  assert.equal(trimmedContent.includes('### 2026-04-01 RESOLVED'), false);
  assert.equal(trimmedContent.includes('### 2026-04-05 RESOLVED'), false);
  assert.match(trimmedContent, /UNRESOLVED — still pending/);

  const archive = stagedFiles.find(p => p.endsWith('staged/archive/corrections/2026-04.md.tmp'));
  assert.ok(archive);
  const archiveContent = await fs.readFile(archive, 'utf8');
  assert.match(archiveContent, /### 2026-04-01 RESOLVED/);
  assert.match(archiveContent, /### 2026-04-05 RESOLVED/);
});

test('stagePrunePlan: corrections — appends to existing live archive month-file', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'corrections.md'), correctionsFixture());
  // Live archive already has prior content
  await writeFile(
    path.join(dir, 'archive', 'corrections', '2026-04.md'),
    '### 2026-04-pre EXISTING\n\nprior body\n',
  );
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    now: new Date('2026-05-10T03:00:00Z'),
  });
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  const archive = stagedFiles.find(p => p.endsWith('archive/corrections/2026-04.md.tmp'));
  const c = await fs.readFile(archive, 'utf8');
  assert.match(c, /### 2026-04-pre EXISTING/);
  assert.match(c, /### 2026-04-01 RESOLVED/);
});

test('stagePrunePlan: session-index — stages trimmed + per-month archive appends', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'session-index.md'), sessionIndexFixture(15));
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    gates: { sessionIndexKeepLastN: 10 },
  });
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  const trimmed = stagedFiles.find(p => p.endsWith('staged/session-index.md.tmp'));
  assert.ok(trimmed);
  // Archive file path: `archive/sessions/session-index-<YYYY-MM>.md`
  const arch = stagedFiles.find(p => p.includes('archive/sessions/session-index-2026-04.md.tmp'));
  assert.ok(arch);
});

test('stagePrunePlan: journal — copies content + writes tombstone for source', async () => {
  const dir = await tmpDir();
  const journalContent = '# Journal — 2026-05-10\n\n- [09:00] [mistake] x\n';
  await writeFile(path.join(dir, 'learning-journals', '2026-05-10.md'), journalContent);
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
  });
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  const copy = stagedFiles.find(p => p.endsWith('archive/journals/2026-05/2026-05-10.md.tmp'));
  assert.ok(copy);
  assert.equal(await fs.readFile(copy, 'utf8'), journalContent);

  const tomb = stagedFiles.find(p => p.endsWith('learning-journals/2026-05-10.md.tombstone'));
  assert.ok(tomb);
  const tombJson = JSON.parse(await fs.readFile(tomb, 'utf8'));
  assert.equal(tombJson.removed_path, path.join('learning-journals', '2026-05-10.md'));
  assert.match(tombJson.consolidation_target, /archive\/journals\/2026-05\/2026-05-10\.md/);
  assert.equal(tombJson.promotion_run, 'dream/pre/2026-05-10');
});

test('stagePrunePlan: pattern demotion — stamps + stages to reference + tombstones active', async () => {
  const dir = await tmpDir();
  const adir = path.join(dir, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'stale.md'), `---
title: Stale
sightings: 1
---

# Stale

Body content.
`);
  // Empty firingEntries → stale qualifies for demotion
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    firingEntries: [],
    now: new Date('2026-05-10T03:00:00Z'),
  });
  assert.equal(plan.demotions.length, 1);

  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  const refStaged = stagedFiles.find(p => p.endsWith('staged/patterns/reference/stale.md.tmp'));
  assert.ok(refStaged);
  const refContent = await fs.readFile(refStaged, 'utf8');
  assert.match(refContent, /demoted_at: 2026-05-10/);
  assert.match(refContent, /demoted_by: dream-worker/);
  assert.match(refContent, /demoted_reason: no firings in 60 days/);
  assert.match(refContent, /Body content\./);

  const tomb = stagedFiles.find(p => p.endsWith('staged/patterns/active/stale.md.tombstone'));
  assert.ok(tomb);
  const tombJson = JSON.parse(await fs.readFile(tomb, 'utf8'));
  assert.match(tombJson.consolidation_target, /patterns\/reference\/stale\.md/);
});

test('stagePrunePlan: empty plan produces no staged files', async () => {
  const dir = await tmpDir();
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const plan = {
    today: '2026-05-10',
    corrections: { found: false, sourceRel: 'corrections.md', keptBlocks: [], archive: [], byMonth: [] },
    sessionIndex: { found: false, sourceRel: 'session-index.md', keptBlocks: [], archive: [], byMonth: [], undatedKept: 0 },
    journal: { found: false, sourceRel: 'learning-journals/x.md' },
    demotions: [],
  };
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  assert.deepEqual(stagedFiles, []);
});

test('stagePrunePlan throws on missing args', async () => {
  await assert.rejects(() => stagePrunePlan({}), /plan required/);
});

test('setFrontmatterField: replaces existing field, inserts new field', () => {
  const original = `---
title: T
existing: old
---
body`;
  const out1 = _internals.setFrontmatterField(original, 'existing', 'new');
  assert.match(out1, /existing: new/);
  const out2 = _internals.setFrontmatterField(original, 'fresh', 'value');
  assert.match(out2, /fresh: value/);
  assert.match(out2, /title: T/);
});

test('setFrontmatterField: synthesizes frontmatter when none exists', () => {
  const out = _internals.setFrontmatterField('# Just body\n', 'demoted_at', '2026-05-10');
  assert.ok(out.startsWith('---'));
  assert.match(out, /demoted_at: 2026-05-10/);
  assert.match(out, /# Just body/);
});

test('stampDemotion: collapses multiline reason to single line', () => {
  const out = _internals.stampDemotion(
    '---\ntitle: T\n---\nbody',
    '2026-05-10',
    'no firings\nin 60 days\nfiring-log-read',
  );
  assert.match(out, /demoted_reason: no firings in 60 days firing-log-read/);
  assert.equal(out.includes('demoted_reason: no firings\n'), false);
});

// --- R2 fixes ---

test('stampDemotion: does NOT stamp demotion_phase (ADR 008 reserves it for scoped cleanups)', () => {
  // Reality-checker R2: applying `demotion_phase: p3-<today>` to nightly
  // demotions clashes with the frozen historical marker on date 2026-05-09
  // and is over-extension of ADR 008's structural enforcement. Nightly
  // demotions satisfy criterion (a) via the firing-log gate; demotion_phase
  // is reserved for future scoped mass-cleanup tooling.
  const out = _internals.stampDemotion('---\ntitle: T\n---\nbody', '2026-05-10', 'reason');
  assert.match(out, /demoted_at: 2026-05-10/);
  assert.match(out, /demoted_by: dream-worker/);
  assert.match(out, /demoted_reason: reason/);
  assert.equal(out.includes('demotion_phase:'), false);
});

test('stampDemotion: nightly demotion on 2026-05-09 does NOT crash (no frozen-marker conflict)', () => {
  // Reality-checker R2 BLOCKER fix verification.
  const out = _internals.stampDemotion('---\ntitle: T\n---\nbody', '2026-05-09', 'reason');
  assert.match(out, /demoted_at: 2026-05-09/);
  assert.equal(out.includes('demotion_phase:'), false);
});

test('runPrune: demotion grace period skips freshly-promoted patterns', async () => {
  const dir = await tmpDir();
  const adir = path.join(dir, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  // first_seen = today - 5 days. With default 60-day grace, must NOT demote
  // even though firingEntries is empty.
  await fs.writeFile(path.join(adir, 'fresh-promo.md'), `---
title: Fresh
first_seen: 2026-05-05
sightings: 1
---
body
`);
  await fs.writeFile(path.join(adir, 'old-stale.md'), `---
title: Old Stale
first_seen: 2025-01-01
sightings: 1
---
body
`);
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    firingEntries: [],
    now: new Date('2026-05-10T03:00:00Z'),
  });
  // Only old-stale qualifies; fresh-promo gets the grace pass.
  assert.equal(plan.demotions.length, 1);
  assert.equal(plan.demotions[0].name, 'old-stale');
});

test('runPrune: grace period boundary uses <= so day=grace gets the full window', async () => {
  // Pattern is exactly 60 days old. With default grace=60, MUST be skipped
  // (reality-checker R2 finding 3: the boundary semantics — a pattern that
  // is exactly grace days old gets the protection).
  const dir = await tmpDir();
  const adir = path.join(dir, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'sixty-day.md'), `---
title: Sixty Day
first_seen: 2026-03-11
---
body
`);
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10', // exactly 60 days from 2026-03-11
    firingEntries: [],
    now: new Date('2026-05-10T03:00:00Z'),
  });
  assert.equal(plan.demotions.length, 0);
});

test('runPrune: grace period override via gates lets short windows demote', async () => {
  const dir = await tmpDir();
  const adir = path.join(dir, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'recent.md'), `---
title: Recent
first_seen: 2026-05-05
sightings: 1
---
body
`);
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    firingEntries: [],
    gates: { demotionGracePeriodDays: 1 }, // 1-day grace, recent is 5d → demote
    now: new Date('2026-05-10T03:00:00Z'),
  });
  assert.equal(plan.demotions.length, 1);
});

test('runPrune: enforces ISO date format on `today`', async () => {
  await assert.rejects(
    () => runPrune({ memoryRoot: '/tmp', today: 'yesterday' }),
    /YYYY-MM-DD/,
  );
});

test('runPrune: journal idempotency — byte-equal archive sets alreadyArchived', async () => {
  const dir = await tmpDir();
  const journalContent = '# Journal\n\n- [09:00] [mistake] x\n';
  await writeFile(path.join(dir, 'learning-journals', '2026-05-10.md'), journalContent);
  // Pre-existing archive with EXACTLY the same content (idempotent re-run)
  await writeFile(
    path.join(dir, 'archive', 'journals', '2026-05', '2026-05-10.md'),
    journalContent,
  );
  const { plan } = await runPrune({ memoryRoot: dir, today: '2026-05-10' });
  assert.equal(plan.journal.found, true);
  assert.equal(plan.journal.alreadyArchived, true);
});

test('runPrune: journal collision (diverging archive) records sentinel, does NOT throw', async () => {
  // Reality-checker R2: throwing nuked the whole prune plan. Now the
  // collision is a sentinel; corrections + session-index + demotions still
  // run, and the journal step's stage no-ops with archiveCollision flagged
  // for the dream-log.
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'learning-journals', '2026-05-10.md'), 'today version\n');
  await writeFile(
    path.join(dir, 'archive', 'journals', '2026-05', '2026-05-10.md'),
    'archive version that differs\n',
  );
  // Add some corrections so we can verify the OTHER tiers still plan.
  await writeFile(path.join(dir, 'corrections.md'), correctionsFixture());
  const { plan, summary } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    now: new Date('2026-05-10T03:00:00Z'),
  });
  assert.equal(plan.journal.archiveCollision, true);
  assert.equal(summary.journalArchiveCollision, true);
  assert.equal(summary.journalArchived, 0);
  // Corrections plan still built
  assert.equal(plan.corrections.found, true);
  assert.equal(plan.corrections.archive.length > 0, true);
});

test('stagePrunePlan: journal collision skips both copy and tombstone', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'learning-journals', '2026-05-10.md'), 'today\n');
  await writeFile(
    path.join(dir, 'archive', 'journals', '2026-05', '2026-05-10.md'),
    'differs\n',
  );
  const { plan } = await runPrune({ memoryRoot: dir, today: '2026-05-10' });
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  // No journal-related staged files at all
  assert.equal(
    stagedFiles.some(p => p.includes('learning-journals') || p.includes('archive/journals/2026-05')),
    false,
  );
});

test('stagePrunePlan: idempotent journal — alreadyArchived skips copy, still tombstones source', async () => {
  const dir = await tmpDir();
  const journalContent = '# Journal\n';
  await writeFile(path.join(dir, 'learning-journals', '2026-05-10.md'), journalContent);
  await writeFile(
    path.join(dir, 'archive', 'journals', '2026-05', '2026-05-10.md'),
    journalContent,
  );
  const { plan } = await runPrune({ memoryRoot: dir, today: '2026-05-10' });
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  // No copy of journal; only tombstone for source.
  const copies = stagedFiles.filter(p => p.endsWith('archive/journals/2026-05/2026-05-10.md.tmp'));
  assert.equal(copies.length, 0);
  const tomb = stagedFiles.find(p => p.endsWith('learning-journals/2026-05-10.md.tombstone'));
  assert.ok(tomb);
  const tombJson = JSON.parse(await fs.readFile(tomb, 'utf8'));
  assert.match(tombJson.reason, /already archived/);
});

test('stagePrunePlan: archive append writes preimage-sha256 sidecar with live archive hash', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'corrections.md'), correctionsFixture());
  // Live archive already has prior content (sha will be recorded)
  const priorArchive = '### 2026-04-pre EXISTING\n\nprior body\n';
  await writeFile(path.join(dir, 'archive', 'corrections', '2026-04.md'), priorArchive);
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    now: new Date('2026-05-10T03:00:00Z'),
  });
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  const sidecar = stagedFiles.find(p => p.endsWith('archive/corrections/2026-04.md.tmp.preimage-sha256'));
  assert.ok(sidecar, 'expected preimage sidecar');
  const json = JSON.parse(await fs.readFile(sidecar, 'utf8'));
  assert.equal(json.schema_version, '1.0.0');
  assert.equal(json.sha256, _internals.sha256(priorArchive));
});

test('stagePrunePlan: archive append sidecar records null sha when no live archive yet', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'corrections.md'), correctionsFixture());
  // No live archive file
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    now: new Date('2026-05-10T03:00:00Z'),
  });
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  const sidecar = stagedFiles.find(p => p.endsWith('preimage-sha256'));
  const json = JSON.parse(await fs.readFile(sidecar, 'utf8'));
  assert.equal(json.sha256, null);
  assert.match(json.note, /did not exist/);
});

test('stagePrunePlan: tombstones include target_missing field for sweep symmetry', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'learning-journals', '2026-05-10.md'), '# Journal\n');
  const { plan } = await runPrune({ memoryRoot: dir, today: '2026-05-10' });
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  const tomb = stagedFiles.find(p => p.endsWith('.tombstone'));
  const json = JSON.parse(await fs.readFile(tomb, 'utf8'));
  assert.equal(typeof json.target_missing, 'boolean');
  assert.equal(json.target_missing, false); // source exists
});

test('tombstone() emits POSIX paths even on backslash inputs', () => {
  const out = JSON.parse(_internals.tombstone(
    'patterns\\active\\foo.md',
    'r',
    '2026-05-10',
    'patterns\\reference\\foo.md',
  ));
  assert.equal(out.removed_path, 'patterns/active/foo.md');
  assert.equal(out.consolidation_target, 'patterns/reference/foo.md');
});

test('patternFirstSeen: returns frontmatter ISO date when present', () => {
  const desc = { frontmatter: { first_seen: '2026-04-01' } };
  assert.equal(_internals.patternFirstSeen(desc), '2026-04-01');
});

test('patternFirstSeen: returns null on missing or non-ISO field', () => {
  assert.equal(_internals.patternFirstSeen({ frontmatter: {} }), null);
  assert.equal(_internals.patternFirstSeen({ frontmatter: { first_seen: 'yesterday' } }), null);
  assert.equal(_internals.patternFirstSeen({}), null);
});

test('setFrontmatterField: replaces multi-word existing value atomically (Codex R2 bug)', () => {
  // Prior `(\\S*)(.*)$` capture preserved the tail "old text here", so
  // replacing "old text here" with "new" produced "new text here".
  const original = `---
title: T
demoted_reason: old text here
---
body
`;
  const out = _internals.setFrontmatterField(original, 'demoted_reason', 'new reason');
  assert.match(out, /demoted_reason: new reason/);
  assert.equal(out.includes('text here'), false);
});

test('setFrontmatterField: preserves inline comment on multi-word value swap', () => {
  const original = `---
title: T
sightings: 11   # bumped manually
---
body
`;
  const out = _internals.setFrontmatterField(original, 'sightings', '12');
  assert.match(out, /sightings: 12   # bumped manually/);
});

test('stagePrunePlan: sidecar is staged BEFORE archive .tmp (Codex R2 ordering)', async () => {
  // The sweep step relies on the sidecar being present whenever an archive
  // .tmp is present. Order: sidecar first; .tmp last. A crash in between
  // leaves a harmless orphan sidecar, never a guard-less .tmp.
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'corrections.md'), correctionsFixture());
  await writeFile(path.join(dir, 'archive', 'corrections', '2026-04.md'), 'prior\n');
  const { plan } = await runPrune({
    memoryRoot: dir,
    today: '2026-05-10',
    now: new Date('2026-05-10T03:00:00Z'),
  });
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const { stagedFiles } = await stagePrunePlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  // For a single archive month, the staged-files order should be:
  //   trimmed corrections.md.tmp,
  //   archive/corrections/2026-04.md.tmp.preimage-sha256,
  //   archive/corrections/2026-04.md.tmp
  const sidecarIdx = stagedFiles.findIndex(p => p.endsWith('preimage-sha256'));
  const tmpIdx = stagedFiles.findIndex(p => p.endsWith('archive/corrections/2026-04.md.tmp'));
  assert.ok(sidecarIdx >= 0, 'expected sidecar present');
  assert.ok(tmpIdx >= 0, 'expected archive .tmp present');
  assert.ok(sidecarIdx < tmpIdx, `sidecar (idx ${sidecarIdx}) must precede archive .tmp (idx ${tmpIdx})`);
});
