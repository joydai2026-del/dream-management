import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseEntryYaml,
  parseLogContent,
  readAllEntries,
  demotionCandidates,
  promotionEvidence,
  recurrentViolations,
} from '../lib/firing-log-read.js';
import { writeFiringLogEntry } from '../lib/firing-log-write.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-firelog-r-'));
}

// Mirror of firing-log-write fixture so the round-trip test can verify both halves.
async function buildFixture() {
  const root = await tmpDir();
  await fs.mkdir(path.join(root, 'session-logs'));
  await fs.mkdir(path.join(root, 'patterns', 'active'), { recursive: true });
  const patternsDir = path.join(root, 'patterns', 'active');
  await fs.writeFile(
    path.join(patternsDir, 'rule-a.md'),
    `---\ntitle: rule-a\n---\n# A\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(patternsDir, 'rule-b.md'),
    `---\ntitle: rule-b\n---\n# B\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'session-logs', '2026-05-09.md'),
    'L1 rule-a applied\nL2 rule-b applied\nL3 rule-a violated\n',
    'utf8'
  );
  return { root, patternsDir };
}

test('parseEntryYaml: scalar fields and nested list of objects', () => {
  const text = `session: 2026-05-09-x
project: dream-management
duration_min: 60
pre_action_loaded_rules:
  - rule-a
  - rule-b
firings:
  - pattern: rule-a
    outcome: applied
    fired_at: doing X
    evidence: session-logs/2026-05-09.md#L1
  - pattern: rule-b
    outcome: violated
    detail: contradicted Y
not_referenced:
  - rule-c`;
  const parsed = parseEntryYaml(text);
  assert.equal(parsed.session, '2026-05-09-x');
  assert.equal(parsed.duration_min, 60);
  assert.deepEqual(parsed.pre_action_loaded_rules, ['rule-a', 'rule-b']);
  assert.equal(parsed.firings.length, 2);
  assert.equal(parsed.firings[0].pattern, 'rule-a');
  assert.equal(parsed.firings[0].outcome, 'applied');
  assert.equal(parsed.firings[0].evidence, 'session-logs/2026-05-09.md#L1');
  assert.equal(parsed.firings[1].outcome, 'violated');
  assert.deepEqual(parsed.not_referenced, ['rule-c']);
});

test('parseLogContent: extracts entries from fenced ```yaml blocks', () => {
  const log = `---
title: Pattern Firing Log
---

# Header

\`\`\`yaml
---
session: 2026-05-09-a
firings:
  - pattern: rule-a
    outcome: applied
    evidence: x#L1
not_referenced:
  - rule-b
---
\`\`\`

\`\`\`yaml
---
session: 2026-05-08-b
firings:
  - pattern: rule-b
    outcome: violated
    evidence: y#L1
not_referenced: []
---
\`\`\`
`;
  const entries = parseLogContent(log);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].session, '2026-05-09-a');
  assert.equal(entries[1].session, '2026-05-08-b');
});

test('readAllEntries + write: round-trip preserves session + firings', async () => {
  const { root, patternsDir } = await buildFixture();
  const logPath = path.join(root, 'pattern-firing-log.md');

  await writeFiringLogEntry({
    logPath,
    memoryRoot: root,
    patternsDir,
    consumer: 'test',
    today: '2026-05-09',
    entry: {
      session: '2026-05-09-roundtrip',
      session_log: 'session-logs/2026-05-09.md',
      pre_action_loaded_rules: ['rule-a', 'rule-b'],
      firings: [
        {
          pattern: 'rule-a',
          outcome: 'applied',
          fired_at: 'doing X',
          evidence: 'session-logs/2026-05-09.md#L1',
        },
        {
          pattern: 'rule-b',
          outcome: 'violated',
          detail: 'contradicted',
          evidence: 'session-logs/2026-05-09.md#L2',
        },
      ],
    },
  });

  const entries = await readAllEntries({ logPath });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session, '2026-05-09-roundtrip');
  assert.equal(entries[0].firings.length, 2);
  assert.equal(entries[0].firings[0].pattern, 'rule-a');
  assert.equal(entries[0].firings[0].outcome, 'applied');
  assert.equal(entries[0].firings[1].outcome, 'violated');
});

test('readAllEntries: also reads rotated archive files', async () => {
  const { root, patternsDir } = await buildFixture();
  const logPath = path.join(root, 'pattern-firing-log.md');
  const archiveDir = path.join(root, 'archive', 'firing-logs');
  await fs.mkdir(archiveDir, { recursive: true });

  await writeFiringLogEntry({
    logPath,
    memoryRoot: root,
    patternsDir,
    consumer: 'test',
    today: '2026-05-09',
    entry: {
      session: '2026-05-09-live',
      pre_action_loaded_rules: ['rule-a'],
      firings: [
        { pattern: 'rule-a', outcome: 'applied', evidence: 'session-logs/2026-05-09.md#L1' },
      ],
    },
  });

  // Simulate a rotated archive entry.
  await fs.writeFile(
    path.join(archiveDir, '2026-04.md'),
    '```yaml\n---\nsession: 2026-04-15-archived\nfirings:\n  - pattern: rule-old\n    outcome: applied\n    evidence: x#L1\nnot_referenced: []\n---\n```\n',
    'utf8'
  );

  const entries = await readAllEntries({ logPath, archiveDir });
  assert.equal(entries.length, 2);
  const sessions = entries.map(e => e.session).sort();
  assert.deepEqual(sessions, ['2026-04-15-archived', '2026-05-09-live']);
});

test('demotionCandidates: returns active patterns absent from window', () => {
  const now = Date.parse('2026-05-09');
  const entries = [
    {
      session: '2026-05-08-x',
      firings: [{ pattern: 'rule-a', outcome: 'applied' }],
    },
    {
      session: '2026-04-01-y',
      firings: [{ pattern: 'rule-b', outcome: 'applied' }],
    },
  ];
  // 30-day window: only rule-a fired (2026-04-01 is 38 days ago).
  const result = demotionCandidates(['rule-a', 'rule-b', 'rule-c'], entries, {
    days: 30,
    now,
  });
  assert.deepEqual(result.sort(), ['rule-b', 'rule-c']);
});

test('demotionCandidates: only applied/referenced/violated count as fired', () => {
  const now = Date.parse('2026-05-09');
  const entries = [
    {
      session: '2026-05-08-x',
      firings: [
        { pattern: 'rule-a', outcome: 'referenced' },
        { pattern: 'rule-b', outcome: 'violated' },
      ],
    },
  ];
  const result = demotionCandidates(['rule-a', 'rule-b', 'rule-c'], entries, { days: 60, now });
  assert.deepEqual(result, ['rule-c']);
});

test('promotionEvidence: weighted formula = journal_mentions + 0.5 * firing_hits', () => {
  const now = Date.parse('2026-05-09');
  const entries = [
    {
      session: '2026-05-08-a',
      firings: [
        { pattern: 'candidate-x', outcome: 'applied' },
        { pattern: 'candidate-x', outcome: 'applied' },
      ],
    },
  ];
  // 2 firing hits × 0.5 = 1.0 + 2 journal mentions = 3.0 → passes
  const r = promotionEvidence('candidate-x', entries, {
    days: 30,
    journalMentions: 2,
    now,
  });
  assert.equal(r.firingHits, 2);
  assert.equal(r.weightedEvidence, 3.0);
  assert.equal(r.passes, true);

  const r2 = promotionEvidence('candidate-x', entries, {
    days: 30,
    journalMentions: 1,
    now,
  });
  assert.equal(r2.weightedEvidence, 2.0);
  assert.equal(r2.passes, false);
});

test('promotionEvidence: applied/violated count, referenced does NOT (per § 6.2)', () => {
  const now = Date.parse('2026-05-09');
  const entries = [
    {
      session: '2026-05-08-a',
      firings: [
        { pattern: 'candidate-x', outcome: 'referenced' },
        { pattern: 'candidate-x', outcome: 'referenced' },
        { pattern: 'candidate-x', outcome: 'referenced' },
      ],
    },
  ];
  const r = promotionEvidence('candidate-x', entries, {
    days: 30,
    journalMentions: 0,
    now,
  });
  assert.equal(r.firingHits, 0); // referenced excluded
});

test('promotionEvidence: matches concept appearance in fired_at/detail (§ 6.2)', () => {
  const now = Date.parse('2026-05-09');
  const entries = [
    {
      session: '2026-05-08-a',
      firings: [
        {
          pattern: 'unrelated-rule',
          outcome: 'applied',
          fired_at: 'when shoulders-of-giants came up',
        },
      ],
    },
  ];
  const r = promotionEvidence('shoulders-of-giants', entries, {
    days: 30,
    journalMentions: 0,
    now,
  });
  assert.equal(r.firingHits, 1);
});

test('recurrentViolations: detects same pattern violated ≥minCount in window', () => {
  const now = Date.parse('2026-05-09');
  const entries = [
    {
      session: '2026-05-08-a',
      firings: [{ pattern: 'caveman-check', outcome: 'violated', evidence: 'x#L1' }],
    },
    {
      session: '2026-05-07-b',
      firings: [{ pattern: 'caveman-check', outcome: 'violated', evidence: 'y#L2' }],
    },
    {
      session: '2026-05-06-c',
      firings: [{ pattern: 'lonely-rule', outcome: 'violated', evidence: 'z#L3' }],
    },
  ];
  const r = recurrentViolations(entries, { days: 14, minCount: 2, now });
  assert.equal(r.length, 1);
  assert.equal(r[0].pattern, 'caveman-check');
  assert.equal(r[0].count, 2);
  assert.equal(r[0].sources.length, 2);
});

test('recurrentViolations: ignores entries outside window', () => {
  const now = Date.parse('2026-05-09');
  const entries = [
    {
      session: '2026-04-01-old',
      firings: [{ pattern: 'old-rule', outcome: 'violated', evidence: 'x#L1' }],
    },
    {
      session: '2026-04-02-old',
      firings: [{ pattern: 'old-rule', outcome: 'violated', evidence: 'y#L2' }],
    },
  ];
  const r = recurrentViolations(entries, { days: 14, minCount: 2, now });
  assert.equal(r.length, 0);
});

test('readAllEntries: missing file returns []', async () => {
  const dir = await tmpDir();
  const entries = await readAllEntries({ logPath: path.join(dir, 'no-such.md') });
  assert.deepEqual(entries, []);
});

test('parseEntryYaml: inline empty list `key: []` returns [], not "[]" string', () => {
  const text = `session: 2026-05-09-x\nnot_referenced: []`;
  const parsed = parseEntryYaml(text);
  assert.deepEqual(parsed.not_referenced, []);
});

test('parseEntryYaml: inline non-empty list `key: [a, b]`', () => {
  const text = `session: x\nnot_referenced: [rule-a, "rule-b", rule-c]`;
  const parsed = parseEntryYaml(text);
  assert.deepEqual(parsed.not_referenced, ['rule-a', 'rule-b', 'rule-c']);
});

test('parseEntryYaml: blank line inside indented list is skipped, not treated as terminator', () => {
  const text = `session: x\nfirings:\n  - pattern: rule-a\n    outcome: applied\n\n  - pattern: rule-b\n    outcome: violated`;
  const parsed = parseEntryYaml(text);
  assert.equal(parsed.firings.length, 2);
  assert.equal(parsed.firings[0].pattern, 'rule-a');
  assert.equal(parsed.firings[1].pattern, 'rule-b');
});

test('parseEntryYaml: malformed continuation throws', () => {
  // 4-space-indented line that's not `key: value` is structurally malformed.
  const text = `session: x\nfirings:\n  - pattern: rule-a\n    invalid-key without-colon-or-value`;
  assert.throws(() => parseEntryYaml(text), /malformed YAML continuation/);
});

test('parseLogContent: surfaces malformed entries via onError, drops them from result', () => {
  const log = `\`\`\`yaml
---
session: 2026-05-09-good
firings: []
not_referenced: []
---
\`\`\`

\`\`\`yaml
---
session: 2026-05-08-bad
firings:
  - pattern: rule-a
    invalid-without-colon
---
\`\`\`
`;
  const errors = [];
  const entries = parseLogContent(log, { onError: e => errors.push(e) });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session, '2026-05-09-good');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /malformed/);
});
