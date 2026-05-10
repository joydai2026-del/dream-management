// Tests for lib/dream/stage-a-auditor.js — one happy + one negative per check.
//
// Test discipline: fixtures live in tmp directories the test scaffolds. Each
// test scaffolds the minimum staged tree it needs (manifest, snapshot, staged,
// event.json, dream-log-entry.md), then calls runStageA and asserts on
// findings + verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runStageA, _internals } from '../lib/dream/stage-a-auditor.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-stagea-'));
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Build a minimal valid staged dream tree at <dir>/archive/dreams/<today>/.
// Returns { dreamDir, today }.
async function scaffoldMinimalTree(dir, opts = {}) {
  const today = opts.today || '2026-05-09';
  const dreamDir = path.join(dir, 'archive', 'dreams', today);
  const snapshotDir = path.join(dreamDir, 'snapshot');
  const stagedDir = path.join(dreamDir, 'staged');
  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.mkdir(stagedDir, { recursive: true });

  // Snapshot a minimal warm-tier file.
  const correctionsContent = '# Corrections\n\n## Resolved\n\n### entry-A 2026-04-01\n\nold one\n';
  await writeFile(path.join(snapshotDir, 'corrections.md'), correctionsContent);

  // Manifest mirrors the snapshot.
  const manifest = {
    schema_version: '1.0.0',
    consumer_name: 'test',
    snapshot_at: new Date().toISOString(),
    git_tag: `dream/pre/${today}`,
    git_head_before: 'abc123',
    memory_root: dir,
    files: [{
      path: 'corrections.md',
      tier: 'warm',
      lines: correctionsContent.split('\n').length,
      bytes: Buffer.byteLength(correctionsContent),
      sha256: sha256(correctionsContent),
      mtime: new Date().toISOString(),
    }],
    symlinks: [],
    skipped: [],
    totals: { hot_tier_lines: 0, warm_tier_lines: correctionsContent.split('\n').length, patterns_active_count: 0, patterns_reference_count: 0, patterns_by_dir: {} },
  };
  await writeFile(path.join(dreamDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Empty event.json + dream-log-entry.md so C8/C9 don't trip on missing files.
  const event = {
    schema_version: '1.0.0',
    run_id: today,
    consumer_name: 'test',
    git_tag: `dream/pre/${today}`,
    verdict: 'PASS-TENTATIVE',
    source_signal: { sessions_in_24h: 0, journal_entries_consumed: 0, corrections_received: 0, quarantined_entries: 0 },
    insights: [],
    routed: { patterns_reinforced: [], patterns_promoted: [], patterns_promotion_declined: [], reference_removals: [], corrections_appended: 0, decisions_logged: [] },
    pruned: { corrections_lines_archived: 0, corrections_archive_path: null, session_index_lines_before: 0, session_index_lines_after: 0, journals_archived_count: 0, journal_archive_collision: false, next_session_prompts_rotated: 0, patterns_demoted: [], relative_dates_files_rewritten: 0, relative_dates_total_replacements: 0, working_memory_overflow_skipped: 0 },
    contradictions_surfaced: [],
    contradictions_stub: true,
    audit: { stage_a: { verdict: 'pending', findings: [] }, stage_b: { verdict: 'pending', findings: [], model: null } },
    token_cost: { worker_input_tokens: 0, worker_output_tokens: 0, auditor_input_tokens: 0, auditor_output_tokens: 0, usd_estimate: 0 },
    duration_seconds: 0,
  };
  await writeFile(path.join(dreamDir, 'event.json'), JSON.stringify(event, null, 2) + '\n');
  const dle = `## ${today} PASS-TENTATIVE\n\n**Source signal**: journal=0, sessionMarkers=0.\n\n**Insights / route**:\n- scored=0 above-threshold=0\n- reinforced patterns: 0\n- promotions: 0, declined: 0\n\n**Pruned**:\n- corrections archived: 0 blocks (kept 0)\n- session-index archived: 0 blocks (kept 0)\n- journal archived: 0\n- patterns demoted: 0\n\n**Dates + contradictions**:\n- relative-date rewrites: 0 across 0 files\n- contradictions: STUB (detector deferred)\n\n**Auditor**: pending.\n`;
  await writeFile(path.join(dreamDir, 'dream-log-entry.md'), dle);

  return { dreamDir, today };
}

// ---- C1: manifest_match ----------------------------------------------

test('C1 happy: manifest matches snapshot', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c1 = result.findings.filter(f => f.check === 'manifest_match');
  assert.equal(c1.length, 0, JSON.stringify(c1, null, 2));
});

test('C1 fail: snapshot file not in manifest', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dreamDir, 'snapshot', 'extra.md'), 'extra\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c1 = result.findings.filter(f => f.check === 'manifest_match');
  assert.ok(c1.some(f => f.message.includes('extra.md')), 'extra file should be flagged');
  assert.equal(result.verdict, 'FAIL');
});

test('C1 fail: sha256 mismatch', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  // Replace snapshot content WITHOUT updating manifest hash.
  await writeFile(path.join(dreamDir, 'snapshot', 'corrections.md'), 'tampered\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c1 = result.findings.filter(f => f.check === 'manifest_match');
  assert.ok(c1.some(f => f.message.includes('sha256 mismatch')));
});

test('C1 fail: manifest declares missing file', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await fs.unlink(path.join(dreamDir, 'snapshot', 'corrections.md'));
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c1 = result.findings.filter(f => f.check === 'manifest_match');
  assert.ok(c1.some(f => f.message.includes('snapshot file missing')));
});

test('C1 fail: missing manifest', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await fs.unlink(path.join(dreamDir, 'manifest.json'));
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  assert.ok(result.findings.some(f => f.check === 'manifest_match' && /not found/.test(f.message)));
});

// ---- C2: conservation ------------------------------------------------

test('C2 happy: trim + archive conserves lines', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  // pre snapshot has '### entry-A 2026-04-01' block; we trim it out and append to archive.
  // pre lines = 6, post (trimmed) lines = 3, archive_new lines = 3 → 3+3=6 ✓
  const trimmed = '# Corrections\n\n## Resolved\n';
  await writeFile(path.join(stagedDir, 'corrections.md.tmp'), trimmed);
  // Live archive doesn't exist; sidecar shows null sha → preimageLines=0
  // Stage archive content with ONLY the new block (3 lines)
  const archived = '\n### entry-A 2026-04-01\n\nold one\n';
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'), archived);
  await writeFile(
    path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'),
    JSON.stringify({ schema_version: '1.0.0', sha256: null, captured_at: new Date().toISOString() }) + '\n',
  );
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c2 = result.findings.filter(f => f.check === 'conservation');
  assert.equal(c2.length, 0, JSON.stringify(c2, null, 2));
});

test('C2 fail: post + archive < pre (lost lines)', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  // Trim away ~3 lines but archive nothing — clear conservation break.
  const trimmed = '# Corrections\n';
  await writeFile(path.join(stagedDir, 'corrections.md.tmp'), trimmed);
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c2 = result.findings.filter(f => f.check === 'conservation');
  assert.ok(c2.some(f => /conservation broken/.test(f.message)));
  assert.equal(result.verdict, 'FAIL');
});

// ---- C3: frontmatter_valid -------------------------------------------

test('C3 happy: clean frontmatter', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dreamDir, 'staged', 'patterns', 'active', 'foo.md.tmp'),
    '---\ntitle: foo\nimportance: 7\n---\nbody\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c3 = result.findings.filter(f => f.check === 'frontmatter_valid');
  assert.equal(c3.length, 0);
});

test('C3 fail: opening --- without closing ---', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dreamDir, 'staged', 'broken.md.tmp'), '---\ntitle: foo\nbody but no close fence\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c3 = result.findings.filter(f => f.check === 'frontmatter_valid');
  assert.equal(c3.length, 1);
  assert.match(c3[0].message, /opening --- without closing/);
});

// ---- C4: anchor_links_resolve ----------------------------------------

test('C4 happy: links resolve to live or staged file', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dir, 'patterns', 'active', 'foo.md'), 'live foo\n');
  const idx = '[foo](patterns/active/foo.md)\n[bar](memory-index.md)\n';
  await writeFile(path.join(dreamDir, 'staged', 'memory-index.md.tmp'), idx);
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c4 = result.findings.filter(f => f.check === 'anchor_links_resolve');
  assert.equal(c4.length, 0, JSON.stringify(c4, null, 2));
});

test('C4 warn: link to nonexistent file', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const idx = '[ghost](patterns/active/ghost.md)\n';
  await writeFile(path.join(dreamDir, 'staged', 'memory-index.md.tmp'), idx);
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c4 = result.findings.filter(f => f.check === 'anchor_links_resolve');
  assert.equal(c4.length, 1);
  assert.equal(c4[0].severity, 'warn');
});

// ---- C5: archive_block_present ---------------------------------------

test('C5 happy: archived block heading appears in archive .tmp', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  await writeFile(path.join(stagedDir, 'corrections.md.tmp'), '# Corrections\n');
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'),
    '\n### entry-A 2026-04-01\nold one\n');
  await writeFile(
    path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'),
    JSON.stringify({ schema_version: '1.0.0', sha256: null }) + '\n',
  );
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c5 = result.findings.filter(f => f.check === 'archive_block_present');
  assert.equal(c5.length, 0, JSON.stringify(c5, null, 2));
});

test('C5 fail: archived block heading missing from archive', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const stagedDir = path.join(dreamDir, 'staged');
  await writeFile(path.join(stagedDir, 'corrections.md.tmp'), '# Corrections\n');
  await writeFile(path.join(stagedDir, 'archive', 'corrections', '2026-04.md.tmp'),
    '# wrong content with no matching heading\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c5 = result.findings.filter(f => f.check === 'archive_block_present');
  assert.ok(c5.length >= 1);
});

// ---- C6: firing_log_freshness ----------------------------------------

test('C6 warn: pattern-firing-log.md missing', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c6 = result.findings.filter(f => f.check === 'firing_log_freshness');
  assert.equal(c6.length, 1);
  assert.equal(c6[0].severity, 'warn');
});

test('C6 happy: fresh firing log mentioning today', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dir, 'pattern-firing-log.md'), `\`\`\`yaml\nsession: ${today}-01\n\`\`\`\n`);
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c6 = result.findings.filter(f => f.check === 'firing_log_freshness');
  assert.equal(c6.length, 0);
});

// ---- C7: no_relative_dates -------------------------------------------

test('C7 happy: hot-tier files have no relative-date phrases', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dreamDir, 'staged', 'working-memory.md.tmp'),
    'sprint goal: ship feature on 2026-05-15.\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c7 = result.findings.filter(f => f.check === 'no_relative_dates');
  assert.equal(c7.length, 0);
});

test('C7 fail: hot-tier file has "yesterday"', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dreamDir, 'staged', 'working-memory.md.tmp'),
    'JJ said yesterday: ship today.\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c7 = result.findings.filter(f => f.check === 'no_relative_dates');
  assert.ok(c7.length >= 1);
  assert.equal(result.verdict, 'FAIL');
});

// ---- C8: source_citation_resolves ------------------------------------

test('C8 happy: insight citations resolve to live files', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dir, 'learning-journals', `${today}.md`), 'journal\n');
  const evt = JSON.parse(await fs.readFile(path.join(dreamDir, 'event.json'), 'utf8'));
  evt.insights = [{
    id: 'insight-1', importance: 8, summary: 'test',
    source_citations: [`learning-journals/${today}.md#L1`],
    routed_to: 'patterns/active/x.md',
  }];
  await writeFile(path.join(dreamDir, 'event.json'), JSON.stringify(evt, null, 2) + '\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c8 = result.findings.filter(f => f.check === 'source_citation_resolves');
  assert.equal(c8.length, 0, JSON.stringify(c8, null, 2));
});

test('C8 fail: insight cites missing file', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const evt = JSON.parse(await fs.readFile(path.join(dreamDir, 'event.json'), 'utf8'));
  evt.insights = [{
    id: 'insight-1', importance: 8, summary: 'test',
    source_citations: ['ghost-file.md#L42'],
    routed_to: 'patterns/active/x.md',
  }];
  await writeFile(path.join(dreamDir, 'event.json'), JSON.stringify(evt, null, 2) + '\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c8 = result.findings.filter(f => f.check === 'source_citation_resolves');
  assert.equal(c8.length, 1);
  assert.equal(result.verdict, 'FAIL');
});

// ---- C9: dream_log_event_agree ---------------------------------------

test('C9 happy: dream-log + event.json agree', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  // Already aligned by scaffold (all zeros).
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c9 = result.findings.filter(f => f.check === 'dream_log_event_agree');
  assert.equal(c9.length, 0, JSON.stringify(c9, null, 2));
});

test('C9 fail: dream-log claims 3 reinforcements but event.json has 0', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const dle = await fs.readFile(path.join(dreamDir, 'dream-log-entry.md'), 'utf8');
  const tampered = dle.replace('reinforced patterns: 0', 'reinforced patterns: 3');
  await writeFile(path.join(dreamDir, 'dream-log-entry.md'), tampered);
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c9 = result.findings.filter(f => f.check === 'dream_log_event_agree');
  assert.equal(c9.length, 1);
  assert.match(c9[0].message, /reinforced mismatch/);
});

// ---- C10: append_only_intact -----------------------------------------

test('C10 happy: no append-only files staged for rewrite', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c10 = result.findings.filter(f => f.check === 'append_only_intact');
  assert.equal(c10.length, 0);
});

test('C10 fail: pattern-firing-log.md staged', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dreamDir, 'staged', 'pattern-firing-log.md.tmp'), 'tampered\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c10 = result.findings.filter(f => f.check === 'append_only_intact');
  assert.equal(c10.length, 1);
  assert.equal(result.verdict, 'FAIL');
});

test('C10 fail: decisions/<file> staged', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dreamDir, 'staged', 'decisions', '2026-05-09-x.md.tmp'), 'tampered\n');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const c10 = result.findings.filter(f => f.check === 'append_only_intact');
  assert.equal(c10.length, 1);
});

// ---- top-level verdict + summary -------------------------------------

test('verdict PASS on clean tree', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dir, 'pattern-firing-log.md'), `\`\`\`yaml\nsession: ${today}-01\n\`\`\`\n`);
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.summary.checks_run, 10);
  assert.equal(result.summary.failures, 0);
});

test('verdict WARN on warn-only findings', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  // pattern-firing-log missing → warn only; no other failures.
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  assert.equal(result.verdict, 'WARN');
  assert.ok(result.summary.warnings >= 1);
  assert.equal(result.summary.failures, 0);
});

test('runStageA: rejects bad today', async () => {
  await assert.rejects(
    () => runStageA({ memoryRoot: '/x', dreamDir: '/y', today: 'bad' }),
    /today must match YYYY-MM-DD/,
  );
});

test('runStageA: skipChecks omits named checks', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  const result = await runStageA({
    memoryRoot: dir, dreamDir, today,
    skipChecks: ['firing_log_freshness'],
  });
  // firing_log_freshness was the only warn source; verdict is now PASS.
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.summary.checks_run, 9);
});

test('internal_error: a check that throws becomes a fail finding', async () => {
  // Hard-corrupt manifest.json to non-JSON; check should produce a fail.
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldMinimalTree(dir);
  await writeFile(path.join(dreamDir, 'manifest.json'), '{ not json');
  const result = await runStageA({ memoryRoot: dir, dreamDir, today });
  const errs = result.findings.filter(f => f.severity === 'fail');
  assert.ok(errs.length >= 1);
  assert.equal(result.verdict, 'FAIL');
});

test('parseFrontmatter helper: opening without close → not ok', () => {
  const r = _internals.parseFrontmatter('---\nfoo: bar\nbody\n');
  assert.equal(r.ok, false);
});

test('parseFrontmatter helper: well-formed', () => {
  const r = _internals.parseFrontmatter('---\nfoo: bar\nimportance: 9\n---\nbody\n');
  assert.equal(r.ok, true);
  assert.equal(r.frontmatter.foo, 'bar');
  assert.equal(r.frontmatter.importance, '9');
  assert.match(r.body, /body/);
});

test('walkRel: returns POSIX-form relative paths', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'a.md'), 'a');
  await writeFile(path.join(dir, 'sub', 'b.md'), 'b');
  const out = await _internals.walkRel(dir);
  assert.deepEqual(out, ['a.md', 'sub/b.md']);
});
