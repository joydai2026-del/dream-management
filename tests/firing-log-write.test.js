import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeFiringLogEntry,
  verifyFiring,
  readEvidenceLine,
  readTriggerPhrases,
  VALID_OUTCOMES,
} from '../lib/firing-log-write.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-firelog-w-'));
}

// Build a fixture memory root with session-logs/ + patterns/active/ populated.
async function buildFixture() {
  const root = await tmpDir();
  await fs.mkdir(path.join(root, 'session-logs'));
  await fs.mkdir(path.join(root, 'patterns'));
  const patternsDir = path.join(root, 'patterns', 'active');
  await fs.mkdir(patternsDir);

  // Pattern A: identifier-only match (no trigger_phrases).
  await fs.writeFile(
    path.join(patternsDir, 'parallel-agents-for-audits.md'),
    `---
title: parallel-agents-for-audits
---
# Spawn parallel agents for audits.
`,
    'utf8'
  );

  // Pattern B: declares trigger_phrases (block form).
  await fs.writeFile(
    path.join(patternsDir, 'caveman-check-on-reports.md'),
    `---
title: caveman-check-on-reports
trigger_phrases:
  - caveman check
  - plain English
---
# Caveman check.
`,
    'utf8'
  );

  // Pattern C: inline trigger_phrases.
  await fs.writeFile(
    path.join(patternsDir, 'shoulders-of-giants-research-first.md'),
    `---
title: shoulders-of-giants-research-first
trigger_phrases: ["fork instead of build", "stand on shoulders"]
---
`,
    'utf8'
  );

  // Session log with line-numbered citations.
  // Lines 1-indexed. We design the lines to match cited evidence.
  const sessionLog = [
    'Line 1 — preamble',                                      // L1
    'Line 2 — discussing parallel-agents-for-audits batch',   // L2
    'Line 3 — random text',                                   // L3
    'Line 4 — applied caveman check on the morning report',   // L4
    'Line 5 — fork instead of build was the right call',      // L5
    'Line 6 — line that pretends to cite a rule but does not',// L6
  ].join('\n');
  await fs.writeFile(path.join(root, 'session-logs', '2026-05-09.md'), sessionLog, 'utf8');

  return { root, patternsDir };
}

test('readEvidenceLine: resolves relative path + line number', async () => {
  const { root } = await buildFixture();
  const line = await readEvidenceLine(root, 'session-logs/2026-05-09.md#L4');
  assert.match(line, /caveman check/);
});

test('readEvidenceLine: missing file returns null, not error', async () => {
  const { root } = await buildFixture();
  const line = await readEvidenceLine(root, 'session-logs/missing.md#L1');
  assert.equal(line, null);
});

test('readEvidenceLine: line beyond EOF returns null', async () => {
  const { root } = await buildFixture();
  const line = await readEvidenceLine(root, 'session-logs/2026-05-09.md#L9999');
  assert.equal(line, null);
});

test('readTriggerPhrases: block form', async () => {
  const { patternsDir } = await buildFixture();
  const phrases = await readTriggerPhrases(patternsDir, 'caveman-check-on-reports');
  assert.deepEqual(phrases, ['caveman check', 'plain English']);
});

test('readTriggerPhrases: inline list form', async () => {
  const { patternsDir } = await buildFixture();
  const phrases = await readTriggerPhrases(patternsDir, 'shoulders-of-giants-research-first');
  assert.deepEqual(phrases, ['fork instead of build', 'stand on shoulders']);
});

test('readTriggerPhrases: missing pattern file returns []', async () => {
  const { patternsDir } = await buildFixture();
  assert.deepEqual(await readTriggerPhrases(patternsDir, 'no-such-pattern'), []);
});

test('verifyFiring: accepts identifier substring match', async () => {
  const { root, patternsDir } = await buildFixture();
  const v = await verifyFiring(
    {
      pattern: 'parallel-agents-for-audits',
      outcome: 'applied',
      evidence: 'session-logs/2026-05-09.md#L2',
    },
    { memoryRoot: root, patternsDir }
  );
  assert.equal(v.ok, true);
});

test('verifyFiring: accepts trigger_phrase match (no identifier in line)', async () => {
  const { root, patternsDir } = await buildFixture();
  const v = await verifyFiring(
    {
      pattern: 'caveman-check-on-reports',
      outcome: 'applied',
      evidence: 'session-logs/2026-05-09.md#L4',
    },
    { memoryRoot: root, patternsDir }
  );
  assert.equal(v.ok, true);
});

test('verifyFiring: REJECTS when evidence line contains neither identifier nor trigger', async () => {
  const { root, patternsDir } = await buildFixture();
  const v = await verifyFiring(
    {
      pattern: 'parallel-agents-for-audits',
      outcome: 'applied',
      evidence: 'session-logs/2026-05-09.md#L6', // generic line, no rule mention
    },
    { memoryRoot: root, patternsDir }
  );
  assert.equal(v.ok, false);
  assert.match(v.reason, /does not contain rule id/);
});

test('verifyFiring: REJECTS unresolvable evidence line', async () => {
  const { root, patternsDir } = await buildFixture();
  const v = await verifyFiring(
    {
      pattern: 'parallel-agents-for-audits',
      outcome: 'applied',
      evidence: 'session-logs/2026-05-09.md#L9999',
    },
    { memoryRoot: root, patternsDir }
  );
  assert.equal(v.ok, false);
  assert.match(v.reason, /not resolvable/);
});

test('verifyFiring: REJECTS invalid outcome', async () => {
  const { root, patternsDir } = await buildFixture();
  const v = await verifyFiring(
    { pattern: 'parallel-agents-for-audits', outcome: 'maybe', evidence: 'x#L1' },
    { memoryRoot: root, patternsDir }
  );
  assert.equal(v.ok, false);
  assert.match(v.reason, /invalid outcome/);
});

test('verifyFiring: REJECTS not-referenced inside firings array (belongs in not_referenced)', async () => {
  const { root, patternsDir } = await buildFixture();
  const v = await verifyFiring(
    { pattern: 'anything', outcome: 'not-referenced' },
    { memoryRoot: root, patternsDir }
  );
  assert.equal(v.ok, false);
  assert.match(v.reason, /does not belong in firings/);
});

test('verifyFiring: word-boundary on rule id (substring-collision rule pair)', async () => {
  // Build a fixture pair where one rule id is a strict prefix of another, then
  // cite a line that mentions only the longer rule. The shorter rule MUST NOT
  // verify against that line (else the classifier could fabricate firings).
  const { root, patternsDir } = await buildFixture();
  await fs.writeFile(
    path.join(patternsDir, 'caveman-check.md'),
    `---\ntitle: caveman-check\n---\n# Just caveman-check, no -on-reports.`,
    'utf8'
  );
  // L4 reads "Line 4 — applied caveman check on the morning report" — contains
  // "caveman check" (with a space, not the rule id) — neither id form has a
  // word-boundary match against "caveman-check" with a hyphen.
  const v = await verifyFiring(
    {
      pattern: 'caveman-check',
      outcome: 'applied',
      evidence: 'session-logs/2026-05-09.md#L4',
    },
    { memoryRoot: root, patternsDir }
  );
  // The line says "caveman check" (space) NOT "caveman-check" (hyphen) → reject
  assert.equal(v.ok, false);
});

test('readEvidenceLine: REJECTS absolute path (path-escape defense)', async () => {
  const { root } = await buildFixture();
  const line = await readEvidenceLine(root, '/etc/passwd#L1');
  assert.equal(line, null);
});

test('readEvidenceLine: REJECTS path outside session-logs/', async () => {
  const { root } = await buildFixture();
  // Try to cite a pattern file as "evidence".
  const line = await readEvidenceLine(root, 'patterns/active/parallel-agents-for-audits.md#L1');
  assert.equal(line, null);
});

test('readEvidenceLine: REJECTS path-escape via ..', async () => {
  const { root } = await buildFixture();
  const line = await readEvidenceLine(root, 'session-logs/../../etc/passwd#L1');
  assert.equal(line, null);
});

test('writeFiringLogEntry: writes header on first call, appends YAML block', async () => {
  const { root, patternsDir } = await buildFixture();
  const logPath = path.join(root, 'pattern-firing-log.md');

  const result = await writeFiringLogEntry({
    logPath,
    memoryRoot: root,
    patternsDir,
    consumer: 'claude-code-m4-vault',
    today: '2026-05-09',
    entry: {
      session: '2026-05-09-test',
      session_log: 'session-logs/2026-05-09.md',
      project: 'dream-management',
      cwd: '/tmp/x',
      duration_min: 60,
      pre_action_loaded_rules: ['parallel-agents-for-audits', 'caveman-check-on-reports'],
      firings: [
        {
          pattern: 'parallel-agents-for-audits',
          outcome: 'applied',
          fired_at: 'spawning batch',
          evidence: 'session-logs/2026-05-09.md#L2',
        },
        {
          pattern: 'caveman-check-on-reports',
          outcome: 'applied',
          fired_at: 'morning report',
          evidence: 'session-logs/2026-05-09.md#L4',
        },
      ],
    },
  });
  assert.equal(result.written, true);
  assert.equal(result.keptFirings, 2);
  assert.equal(result.droppedFirings.length, 0);

  const content = await fs.readFile(logPath, 'utf8');
  assert.match(content, /title: Pattern Firing Log/);
  assert.match(content, /consumer: claude-code-m4-vault/);
  assert.match(content, /```yaml/);
  assert.match(content, /session: 2026-05-09-test/);
  assert.match(content, /pattern: parallel-agents-for-audits/);
});

test('writeFiringLogEntry: drops firings that fail § 5.4 grep, surfaces in result', async () => {
  const { root, patternsDir } = await buildFixture();
  const logPath = path.join(root, 'pattern-firing-log.md');

  const result = await writeFiringLogEntry({
    logPath,
    memoryRoot: root,
    patternsDir,
    consumer: 'test',
    today: '2026-05-09',
    entry: {
      session: '2026-05-09-bad-evidence',
      pre_action_loaded_rules: ['parallel-agents-for-audits'],
      firings: [
        {
          pattern: 'parallel-agents-for-audits',
          outcome: 'applied',
          evidence: 'session-logs/2026-05-09.md#L6', // bad: no identifier match
        },
      ],
    },
  });
  assert.equal(result.written, true);
  assert.equal(result.keptFirings, 0);
  assert.equal(result.droppedFirings.length, 1);
  assert.match(result.droppedFirings[0].reason, /does not contain rule id/);
  // The kept-out rule should appear in not_referenced.
  assert.deepEqual(result.notReferenced, ['parallel-agents-for-audits']);
});

test('writeFiringLogEntry: idempotent on duplicate session', async () => {
  const { root, patternsDir } = await buildFixture();
  const logPath = path.join(root, 'pattern-firing-log.md');
  const entryArgs = {
    logPath,
    memoryRoot: root,
    patternsDir,
    consumer: 'test',
    today: '2026-05-09',
    entry: {
      session: '2026-05-09-dup',
      pre_action_loaded_rules: ['parallel-agents-for-audits'],
      firings: [
        {
          pattern: 'parallel-agents-for-audits',
          outcome: 'applied',
          evidence: 'session-logs/2026-05-09.md#L2',
        },
      ],
    },
  };
  const r1 = await writeFiringLogEntry(entryArgs);
  assert.equal(r1.written, true);

  const r2 = await writeFiringLogEntry(entryArgs);
  assert.equal(r2.written, false);
  assert.equal(r2.reason, 'session-already-recorded');

  // Only one block in file.
  const content = await fs.readFile(logPath, 'utf8');
  const blockCount = (content.match(/```yaml/g) || []).length;
  assert.equal(blockCount, 1);
});

test('writeFiringLogEntry: rules not in any kept firing land in not_referenced', async () => {
  const { root, patternsDir } = await buildFixture();
  const logPath = path.join(root, 'pattern-firing-log.md');

  const result = await writeFiringLogEntry({
    logPath,
    memoryRoot: root,
    patternsDir,
    consumer: 'test',
    today: '2026-05-09',
    entry: {
      session: '2026-05-09-not-ref',
      pre_action_loaded_rules: [
        'parallel-agents-for-audits',
        'shoulders-of-giants-research-first',
        'rule-that-was-not-cited',
      ],
      firings: [
        {
          pattern: 'parallel-agents-for-audits',
          outcome: 'applied',
          evidence: 'session-logs/2026-05-09.md#L2',
        },
      ],
    },
  });
  assert.equal(result.written, true);
  assert.deepEqual(
    [...result.notReferenced].sort(),
    ['rule-that-was-not-cited', 'shoulders-of-giants-research-first']
  );
});

test('writeFiringLogEntry: VALID_OUTCOMES is exactly the four-outcome set', () => {
  assert.deepEqual(
    [...VALID_OUTCOMES].sort(),
    ['applied', 'not-referenced', 'referenced', 'violated']
  );
});

test('writeFiringLogEntry: drops firings whose pattern is NOT in pre_action_loaded_rules', async () => {
  const { root, patternsDir } = await buildFixture();
  const logPath = path.join(root, 'pattern-firing-log.md');

  const result = await writeFiringLogEntry({
    logPath,
    memoryRoot: root,
    patternsDir,
    consumer: 'test',
    today: '2026-05-09',
    entry: {
      session: '2026-05-09-not-loaded',
      pre_action_loaded_rules: ['parallel-agents-for-audits'], // only this one loaded
      firings: [
        {
          pattern: 'parallel-agents-for-audits',
          outcome: 'applied',
          evidence: 'session-logs/2026-05-09.md#L2',
        },
        {
          // Hallucinated rule: not in loaded list — must be dropped even if
          // the evidence line happens to match.
          pattern: 'fork instead of build',
          outcome: 'applied',
          evidence: 'session-logs/2026-05-09.md#L5',
        },
      ],
    },
  });
  assert.equal(result.written, true);
  assert.equal(result.keptFirings, 1);
  assert.equal(result.droppedFirings.length, 1);
  assert.match(result.droppedFirings[0].reason, /not in pre_action_loaded_rules/);
});

test('writeFiringLogEntry: drops not-referenced if it appears inside firings', async () => {
  const { root, patternsDir } = await buildFixture();
  const logPath = path.join(root, 'pattern-firing-log.md');

  const result = await writeFiringLogEntry({
    logPath,
    memoryRoot: root,
    patternsDir,
    consumer: 'test',
    today: '2026-05-09',
    entry: {
      session: '2026-05-09-misplaced-nr',
      pre_action_loaded_rules: ['parallel-agents-for-audits'],
      firings: [
        { pattern: 'parallel-agents-for-audits', outcome: 'not-referenced' },
      ],
    },
  });
  assert.equal(result.written, true);
  assert.equal(result.keptFirings, 0);
  assert.equal(result.droppedFirings.length, 1);
  // The rule lands in not_referenced as the safe default.
  assert.deepEqual(result.notReferenced, ['parallel-agents-for-audits']);
});

test('writeFiringLogEntry: concurrent same-session writes are serialized — only one block lands', async () => {
  const { root, patternsDir } = await buildFixture();
  const logPath = path.join(root, 'pattern-firing-log.md');
  const args = {
    logPath,
    memoryRoot: root,
    patternsDir,
    consumer: 'test',
    today: '2026-05-09',
    entry: {
      session: '2026-05-09-concurrent',
      pre_action_loaded_rules: ['parallel-agents-for-audits'],
      firings: [
        {
          pattern: 'parallel-agents-for-audits',
          outcome: 'applied',
          evidence: 'session-logs/2026-05-09.md#L2',
        },
      ],
    },
  };
  // Race two writers with identical session id.
  const [a, b] = await Promise.all([
    writeFiringLogEntry(args),
    writeFiringLogEntry(args),
  ]);
  const writes = [a, b].filter(r => r.written).length;
  assert.equal(writes, 1, `expected 1 write, got ${writes}`);

  const content = await fs.readFile(logPath, 'utf8');
  const blockCount = (content.match(/```yaml/g) || []).length;
  assert.equal(blockCount, 1, `expected 1 yaml block, got ${blockCount}`);
});

test('writeFiringLogEntry: 10 concurrent unique-session writes all land, no double-header', async () => {
  // Stronger concurrency proof: lots of distinct sessions racing through the
  // same lock should produce exactly N append-blocks + 1 header.
  const { root, patternsDir } = await buildFixture();
  const logPath = path.join(root, 'pattern-firing-log.md');
  const args = i => ({
    logPath,
    memoryRoot: root,
    patternsDir,
    consumer: 'test',
    today: '2026-05-09',
    entry: {
      session: `2026-05-09-c-${i}`,
      pre_action_loaded_rules: ['parallel-agents-for-audits'],
      firings: [
        {
          pattern: 'parallel-agents-for-audits',
          outcome: 'applied',
          evidence: 'session-logs/2026-05-09.md#L2',
        },
      ],
    },
  });
  const N = 10;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => writeFiringLogEntry(args(i)))
  );
  const writes = results.filter(r => r.written).length;
  assert.equal(writes, N, `expected ${N} writes, got ${writes}`);

  const content = await fs.readFile(logPath, 'utf8');
  const blockCount = (content.match(/```yaml/g) || []).length;
  assert.equal(blockCount, N, `expected ${N} yaml blocks, got ${blockCount}`);
  // Exactly one file header (consumer line should appear once).
  const headerCount = (content.match(/^consumer: test$/gm) || []).length;
  assert.equal(headerCount, 1, `expected 1 header, got ${headerCount}`);
});

test('readEvidenceLine: REJECTS path-escape via session-logs/.. into a sibling dir', async () => {
  const { root } = await buildFixture();
  // session-logs/../patterns/active/foo.md starts with session-logs/ but
  // resolves outside the prefix root.
  const v = await readEvidenceLine(
    root,
    'session-logs/../patterns/active/parallel-agents-for-audits.md#L1'
  );
  assert.equal(v, null);
});
