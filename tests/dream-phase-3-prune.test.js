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
  // 1 trimmed source + 1 monthly archive
  assert.equal(stagedFiles.length, 2);
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
