import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bumpPatternFrontmatter, stageRoutePlan } from '../lib/dream/stage-route.js';

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
