import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bumpPatternFrontmatter,
  stageRoutePlan,
  clearFrontmatterFields,
  replaceOrAppendFooter,
} from '../lib/dream/stage-route.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-stage-route-'));
}

test('bumpPatternFrontmatter updates sightings + latest_seen, preserves body', () => {
  const original = `---
title: Caveman Check
sightings: 11
first_seen: 2026-04-22
latest_seen: 2026-05-08
---

# Caveman Check

Some body.
`;
  const out = bumpPatternFrontmatter(original, { sightings: 12, latestSeen: '2026-05-10' });
  assert.match(out, /sightings: 12/);
  assert.match(out, /latest_seen: 2026-05-10/);
  assert.match(out, /first_seen: 2026-04-22/); // preserved
  assert.match(out, /# Caveman Check/);        // body preserved
});

test('bumpPatternFrontmatter inserts missing fields without clobbering existing', () => {
  const original = `---
title: New Pattern
---

# New Pattern
`;
  const out = bumpPatternFrontmatter(original, { sightings: 1, latestSeen: '2026-05-10' });
  assert.match(out, /sightings: 1/);
  assert.match(out, /latest_seen: 2026-05-10/);
  assert.match(out, /title: New Pattern/);
});

test('bumpPatternFrontmatter synthesizes frontmatter when none exists', () => {
  const out = bumpPatternFrontmatter('# No frontmatter\n\nbody\n', {
    sightings: 1, latestSeen: '2026-05-10',
  });
  assert.ok(out.startsWith('---\n'));
  assert.match(out, /sightings: 1/);
  assert.match(out, /# No frontmatter/);
});

test('bumpPatternFrontmatter does not touch out-of-frontmatter sightings: text', () => {
  const original = `---
title: P
sightings: 5
---

Body says: sightings: 99 should stay.
`;
  const out = bumpPatternFrontmatter(original, { sightings: 6 });
  assert.match(out, /sightings: 6/);
  assert.match(out, /Body says: sightings: 99 should stay\./);
});

test('stageRoutePlan writes reinforcement to staged/patterns/active/<name>.md.tmp with bumped frontmatter', async () => {
  const root = await tmpDir();
  const dreamDir = path.join(root, 'archive', 'dreams', '2026-05-10');
  await fs.mkdir(path.join(root, 'patterns', 'active'), { recursive: true });
  await fs.writeFile(path.join(root, 'patterns', 'active', 'caveman-check.md'), `---
title: Caveman Check
sightings: 11
latest_seen: 2026-05-08
---

# Caveman Check
`);

  const plan = {
    today: '2026-05-10',
    reinforce: [{
      pattern: 'caveman-check',
      identifierStem: 'caveman-check',
      sightingsBefore: 11,
      sightingsAfter: 12,
      latestSeen: '2026-05-10',
      evidence: [
        { path: 'learning-journals/2026-05-10.md', lineNumber: 42, score: 9, rationale: 'fixture' },
      ],
    }],
    promote: [],
    declined: [],
  };
  const { stagedFiles } = await stageRoutePlan({
    plan, dreamDir, memoryRoot: root, today: '2026-05-10',
  });
  assert.equal(stagedFiles.length, 1);
  const stagedContent = await fs.readFile(stagedFiles[0], 'utf8');
  assert.match(stagedContent, /sightings: 12/);
  assert.match(stagedContent, /latest_seen: 2026-05-10/);
  assert.match(stagedContent, /dream reinforcement 2026-05-10: sightings 11 → 12/);
  assert.match(stagedContent, /evidence: learning-journals\/2026-05-10\.md#L42/);
  assert.ok(stagedFiles[0].endsWith('staged/patterns/active/caveman-check.md.tmp'));
});

test('stageRoutePlan skips reinforcement when live pattern file is gone', async () => {
  const root = await tmpDir();
  const dreamDir = path.join(root, 'archive', 'dreams', '2026-05-10');
  await fs.mkdir(path.join(root, 'patterns', 'active'), { recursive: true });
  // No file written for 'ghost-pattern'
  const plan = {
    today: '2026-05-10',
    reinforce: [{
      pattern: 'ghost-pattern',
      identifierStem: 'ghost-pattern',
      sightingsBefore: 0,
      sightingsAfter: 1,
      latestSeen: '2026-05-10',
      evidence: [],
    }],
    promote: [],
    declined: [],
  };
  const { stagedFiles } = await stageRoutePlan({
    plan, dreamDir, memoryRoot: root, today: '2026-05-10',
  });
  assert.deepEqual(stagedFiles, []);
});

test('stageRoutePlan writes promotion to staged/patterns/active/<slug>.md.tmp with template body', async () => {
  const root = await tmpDir();
  const dreamDir = path.join(root, 'archive', 'dreams', '2026-05-10');
  const plan = {
    today: '2026-05-10',
    reinforce: [],
    promote: [{
      slug: 'verify-live-claims-against-git',
      importance: 9,
      journalMentions: 4,
      firingHits: 2,
      weightedEvidence: 5,
      threshold: 3,
      evidence: [
        { path: 'learning-journals/2026-05-10.md', lineNumber: 42 },
        { path: 'session-logs/2026-05-09.md', lineNumber: 201 },
      ],
    }],
    declined: [],
  };
  const { stagedFiles } = await stageRoutePlan({
    plan, dreamDir, memoryRoot: root, today: '2026-05-10',
  });
  assert.equal(stagedFiles.length, 1);
  const content = await fs.readFile(stagedFiles[0], 'utf8');
  assert.match(content, /title: verify-live-claims-against-git/);
  assert.match(content, /sightings: 1/);
  assert.match(content, /first_seen: 2026-05-10/);
  assert.match(content, /promoted_from: dream/);
  assert.match(content, /Importance score: 9/);
  assert.match(content, /Journal mentions in lookback window: 4/);
  assert.match(content, /Firing-log hits in lookback window: 2/);
  assert.match(content, /- learning-journals\/2026-05-10\.md#L42/);
  assert.match(content, /- session-logs\/2026-05-09\.md#L201/);
  assert.ok(stagedFiles[0].endsWith('staged/patterns/active/verify-live-claims-against-git.md.tmp'));
});

test('stageRoutePlan creates staged dir tree under archive/dreams/<date>/staged/', async () => {
  const root = await tmpDir();
  const dreamDir = path.join(root, 'archive', 'dreams', '2026-05-10');
  const plan = {
    today: '2026-05-10', reinforce: [], promote: [{
      slug: 'x', importance: 7, journalMentions: 3, firingHits: 0,
      weightedEvidence: 3, threshold: 3, evidence: [{ path: 'p', lineNumber: 1 }],
    }], declined: [],
  };
  await stageRoutePlan({ plan, dreamDir, memoryRoot: root, today: '2026-05-10' });
  const stagedRoot = path.join(dreamDir, 'staged', 'patterns', 'active');
  const names = await fs.readdir(stagedRoot);
  assert.deepEqual(names, ['x.md.tmp']);
});

test('stageRoutePlan handles empty plan (no reinforce, no promote)', async () => {
  const root = await tmpDir();
  const dreamDir = path.join(root, 'archive', 'dreams', '2026-05-10');
  const out = await stageRoutePlan({
    plan: { today: '2026-05-10', reinforce: [], promote: [], declined: [] },
    dreamDir, memoryRoot: root, today: '2026-05-10',
  });
  assert.deepEqual(out.stagedFiles, []);
});

test('stageRoutePlan throws on missing required args', async () => {
  await assert.rejects(() => stageRoutePlan({}), /plan required/);
});

// --- R2 fixes ---

test('bumpPatternFrontmatter preserves trailing inline comment on bumped field', () => {
  const original = `---
title: Caveman Check
sightings: 11   # bumped manually 2026-05-08
latest_seen: 2026-05-08
---
body
`;
  const out = bumpPatternFrontmatter(original, { sightings: 12, latestSeen: '2026-05-10' });
  assert.match(out, /sightings: 12   # bumped manually 2026-05-08/);
  assert.match(out, /latest_seen: 2026-05-10/);
});

test('bumpPatternFrontmatter handles empty value field cleanly', () => {
  const original = `---
title: P
sightings:
latest_seen:
---
body
`;
  const out = bumpPatternFrontmatter(original, { sightings: 1, latestSeen: '2026-05-10' });
  assert.match(out, /sightings:\s*1/);
  assert.match(out, /latest_seen:\s*2026-05-10/);
  // Critical: did NOT cross newlines and consume the next line as value.
  assert.equal(out.includes('latest_seen: 2026-05-10\nlatest_seen'), false);
});

test('replaceOrAppendFooter appends when no markers present', () => {
  const out = replaceOrAppendFooter('# Title\n\nbody\n', ['<!-- a -->', '<!-- b -->']);
  assert.match(out, /# Title\n\nbody\n+<!-- DREAM-FOOTER-START -->\n<!-- a -->\n<!-- b -->\n<!-- DREAM-FOOTER-END -->\n$/);
});

test('replaceOrAppendFooter replaces existing block (no accumulation)', () => {
  const seeded = '# Title\n\nbody\n\n<!-- DREAM-FOOTER-START -->\n<!-- old-a -->\n<!-- old-b -->\n<!-- DREAM-FOOTER-END -->\n';
  const out = replaceOrAppendFooter(seeded, ['<!-- new -->']);
  // Old content gone
  assert.equal(out.includes('old-a'), false);
  assert.equal(out.includes('old-b'), false);
  // New content present
  assert.match(out, /<!-- new -->/);
  // Markers exactly once
  assert.equal((out.match(/DREAM-FOOTER-START/g) || []).length, 1);
  assert.equal((out.match(/DREAM-FOOTER-END/g) || []).length, 1);
});

test('replaceOrAppendFooter does NOT touch START/END markers embedded mid-file as prose', () => {
  // Reality-checker R2 N2: a pattern that documents the dream system might
  // legitimately contain `<!-- DREAM-FOOTER-START -->` in its body. The
  // replace path should only target the trailing footer block.
  const seeded = [
    '# Documentation pattern',
    '',
    'Example body containing the markers as prose:',
    '',
    '<!-- DREAM-FOOTER-START -->',
    'This is example prose, NOT a real footer.',
    '<!-- DREAM-FOOTER-END -->',
    '',
    'More body content after the prose example.',
    '',
  ].join('\n');
  const out = replaceOrAppendFooter(seeded, ['<!-- new -->']);
  // The prose markers survive
  assert.match(out, /This is example prose, NOT a real footer\./);
  assert.match(out, /More body content after the prose example\./);
  // A new footer block was appended at the end
  assert.match(out, /<!-- new -->\n<!-- DREAM-FOOTER-END -->\n$/);
  // Two pairs total: the prose pair + the appended trailing footer
  assert.equal((out.match(/DREAM-FOOTER-START/g) || []).length, 2);
});

test('replaceOrAppendFooter is idempotent across repeated reinforcements', () => {
  let s = '# Title\n\nbody\n';
  s = replaceOrAppendFooter(s, ['<!-- run 1 -->']);
  s = replaceOrAppendFooter(s, ['<!-- run 2 -->']);
  s = replaceOrAppendFooter(s, ['<!-- run 3 -->']);
  assert.equal((s.match(/DREAM-FOOTER-START/g) || []).length, 1);
  assert.match(s, /<!-- run 3 -->/);
  assert.equal(s.includes('run 1'), false);
  assert.equal(s.includes('run 2'), false);
});

test('clearFrontmatterFields removes named keys, leaves others', () => {
  const original = `---
title: T
bootstrap: true
demotion_phase: p3-2026-05-09
sightings: 0
---
body
`;
  const out = clearFrontmatterFields(original, ['bootstrap', 'demotion_phase']);
  assert.equal(out.includes('bootstrap'), false);
  assert.equal(out.includes('demotion_phase'), false);
  assert.match(out, /title: T/);
  assert.match(out, /sightings: 0/);
});

test('stageRoutePlan: fromReference re-promotion reads reference content with flags cleared', async () => {
  const root = await tmpDir();
  await fs.mkdir(path.join(root, 'patterns', 'reference'), { recursive: true });
  await fs.writeFile(path.join(root, 'patterns', 'reference', 'foo.md'), `---
title: Foo
bootstrap: true
demotion_phase: p3-2026-05-09
sightings: 0
---

# Foo

Curated evidence section we want to preserve on re-promotion.
`);
  const dreamDir = path.join(root, 'archive', 'dreams', '2026-05-10');
  const plan = {
    today: '2026-05-10',
    reinforce: [],
    promote: [{
      slug: 'foo',
      importance: 9,
      journalMentions: 4,
      firingHits: 0,
      weightedEvidence: 4,
      threshold: 3,
      flagsToClear: ['bootstrap', 'demotion_phase'],
      requiresFlagClear: true,
      fromReference: true,
      evidence: [{ path: 'p', lineNumber: 1 }],
    }],
    removeReference: [{ slug: 'foo', path: 'patterns/reference/foo.md' }],
    declined: [],
  };
  const { stagedFiles } = await stageRoutePlan({
    plan, dreamDir, memoryRoot: root, today: '2026-05-10',
  });
  // Active staged: 1 file (re-promoted with flags cleared)
  // + Tombstone for reference: 1
  assert.equal(stagedFiles.length, 2);
  const activePath = stagedFiles.find(p => p.includes('staged/patterns/active/foo.md.tmp'));
  assert.ok(activePath, 'expected staged active file');
  const activeContent = await fs.readFile(activePath, 'utf8');
  assert.match(activeContent, /title: Foo/);
  assert.match(activeContent, /Curated evidence section/);
  assert.equal(activeContent.includes('bootstrap'), false);
  assert.equal(activeContent.includes('demotion_phase'), false);
  assert.match(activeContent, /re-promoted from reference on 2026-05-10/);
});

test('stageRoutePlan: fromReference falls back to skeleton when reference file missing', async () => {
  const root = await tmpDir();
  // No reference file present
  const dreamDir = path.join(root, 'archive', 'dreams', '2026-05-10');
  const plan = {
    today: '2026-05-10',
    reinforce: [],
    promote: [{
      slug: 'ghost',
      importance: 9,
      journalMentions: 4,
      firingHits: 0,
      weightedEvidence: 4,
      threshold: 3,
      flagsToClear: ['bootstrap', 'demotion_phase'],
      requiresFlagClear: true,
      fromReference: true,
      evidence: [{ path: 'p', lineNumber: 1 }],
    }],
    removeReference: [{ slug: 'ghost', path: 'patterns/reference/ghost.md' }],
    declined: [],
  };
  const { stagedFiles } = await stageRoutePlan({
    plan, dreamDir, memoryRoot: root, today: '2026-05-10',
  });
  const activePath = stagedFiles.find(p => p.includes('ghost.md.tmp'));
  const c = await fs.readFile(activePath, 'utf8');
  assert.match(c, /title: ghost/);
  assert.match(c, /Promoted by dream worker/);
});

test('stageRoutePlan: removeReference produces a JSON tombstone in staged tree', async () => {
  const root = await tmpDir();
  // Provide a live reference file so target_missing is false
  await fs.mkdir(path.join(root, 'patterns', 'reference'), { recursive: true });
  await fs.writeFile(path.join(root, 'patterns', 'reference', 'foo.md'), 'body');
  const dreamDir = path.join(root, 'archive', 'dreams', '2026-05-10');
  const plan = {
    today: '2026-05-10',
    reinforce: [],
    promote: [],
    removeReference: [{ slug: 'foo', path: 'patterns/reference/foo.md', reason: 'unit test' }],
    declined: [],
  };
  const { stagedFiles } = await stageRoutePlan({
    plan, dreamDir, memoryRoot: root, today: '2026-05-10',
  });
  assert.equal(stagedFiles.length, 1);
  assert.ok(stagedFiles[0].endsWith('staged/patterns/reference/foo.md.tombstone'));
  const json = JSON.parse(await fs.readFile(stagedFiles[0], 'utf8'));
  assert.equal(json.schema_version, '1.0.0');
  assert.equal(json.removed_path, 'patterns/reference/foo.md');
  assert.equal(json.reason, 'unit test');
  assert.equal(json.promotion_run, 'dream/pre/2026-05-10');
  assert.equal(json.target_missing, false);
});

test('stageRoutePlan: tombstone records target_missing=true when ref file gone', async () => {
  // Reality-checker R2 N1: the candidate was built with referenceFrontmatter
  // but the file was deleted before staging — the tombstone honestly records
  // that the sweep step will no-op rather than silently implying a removal.
  const root = await tmpDir();
  // No live reference file exists
  const dreamDir = path.join(root, 'archive', 'dreams', '2026-05-10');
  const plan = {
    today: '2026-05-10',
    reinforce: [],
    promote: [],
    removeReference: [{ slug: 'gone', path: 'patterns/reference/gone.md' }],
    declined: [],
  };
  const { stagedFiles } = await stageRoutePlan({
    plan, dreamDir, memoryRoot: root, today: '2026-05-10',
  });
  const json = JSON.parse(await fs.readFile(stagedFiles[0], 'utf8'));
  assert.equal(json.target_missing, true);
});

test('stageRoutePlan: reinforcement footer replaces (does not accumulate) across runs', async () => {
  const root = await tmpDir();
  const adir = path.join(root, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'caveman-check.md'), `---
title: Caveman Check
sightings: 11
latest_seen: 2026-05-08
---
# Caveman Check
`);

  const dreamDir = path.join(root, 'archive', 'dreams', '2026-05-10');
  const plan1 = {
    today: '2026-05-10', reinforce: [{
      pattern: 'caveman-check', identifierStem: 'caveman-check',
      sightingsBefore: 11, sightingsAfter: 12, latestSeen: '2026-05-10',
      evidence: [{ path: 'a', lineNumber: 1, score: 9 }],
    }], promote: [], removeReference: [], declined: [],
  };
  const r1 = await stageRoutePlan({ plan: plan1, dreamDir, memoryRoot: root, today: '2026-05-10' });
  // Simulate sweep: copy staged active over the live one.
  await fs.copyFile(r1.stagedFiles[0], path.join(adir, 'caveman-check.md'));

  const plan2 = {
    today: '2026-05-11', reinforce: [{
      pattern: 'caveman-check', identifierStem: 'caveman-check',
      sightingsBefore: 12, sightingsAfter: 13, latestSeen: '2026-05-11',
      evidence: [{ path: 'b', lineNumber: 2, score: 8 }],
    }], promote: [], removeReference: [], declined: [],
  };
  const dreamDir2 = path.join(root, 'archive', 'dreams', '2026-05-11');
  const r2 = await stageRoutePlan({ plan: plan2, dreamDir: dreamDir2, memoryRoot: root, today: '2026-05-11' });
  const c2 = await fs.readFile(r2.stagedFiles[0], 'utf8');
  // Exactly one footer block — second run replaced first run's
  assert.equal((c2.match(/DREAM-FOOTER-START/g) || []).length, 1);
  assert.match(c2, /sightings 12 → 13/);
  assert.equal(c2.includes('sightings 11 → 12'), false);
  assert.equal(c2.includes('a#L1'), false);
  assert.match(c2, /b#L2/);
});
