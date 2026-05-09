import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseJournalEntries,
  distillEntries,
  consumeTodaysJournal,
  journalPathFor,
} from '../lib/journal-consume.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-journal-'));
}

test('parseJournalEntries: strips frontmatter, parses categories, buckets', () => {
  const content = `---
type: learning-journal
created: 2026-05-09
---

# Learning Journal — 2026-05-09

## Entries
- [09:30] [mistake] forgot to cut a branch before editing
- [09:45] [correction] JJ said cut a branch first
- [10:15] [worked] parallel agent batch finished in 3min
- [10:30] [didnt-work] tried sed regex, hit empty match
- [11:00] [insight] ttl conserves vs deletes
- [11:30] [JJ-input] focus on read-path first, defer wiring
`;
  const entries = parseJournalEntries(content);
  assert.equal(entries.length, 6);
  assert.equal(entries[0].time, '09:30');
  assert.equal(entries[0].category, 'mistake');
  assert.equal(entries[0].bucket, 'Mistakes');
  assert.equal(entries[1].bucket, 'Corrections / JJ inputs');
  assert.equal(entries[3].bucket, "Methods that didn't work");
  assert.equal(entries[5].bucket, 'Corrections / JJ inputs');
});

test('parseJournalEntries: returns empty for journal with no matching lines', () => {
  const content = `---
type: learning-journal
---

## Entries
(no entries yet)

Some prose that's not an entry.
`;
  assert.deepEqual(parseJournalEntries(content), []);
});

test('parseJournalEntries: unknown category falls into Other, not dropped', () => {
  const content = `## Entries
- [09:00] [random-tag] this still gets captured
- [10:00] [mistake] this is normal
`;
  const entries = parseJournalEntries(content);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].bucket, 'Other');
  assert.equal(entries[1].bucket, 'Mistakes');
});

test('parseJournalEntries: handles file with no frontmatter', () => {
  const content = `# Journal

## Entries
- [09:00] [mistake] x
`;
  const entries = parseJournalEntries(content);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].summary, 'x');
});

test('distillEntries: empty input → no entries note, ≤30 lines', () => {
  const out = distillEntries([], { date: '2026-05-09' });
  assert.match(out, /## Journal Distilled — 2026-05-09/);
  assert.match(out, /No journal entries/);
  assert.ok(out.split('\n').length <= 30);
});

test('distillEntries: adds entry count + per-bucket counts to header', () => {
  const entries = [
    { time: '09:30', category: 'mistake', bucket: 'Mistakes', summary: 'a' },
    { time: '09:31', category: 'correction', bucket: 'Corrections / JJ inputs', summary: 'b' },
    { time: '09:32', category: 'mistake', bucket: 'Mistakes', summary: 'c' },
  ];
  const out = distillEntries(entries, { date: '2026-05-09' });
  assert.match(out, /\*\*3 entries\*\*/);
  assert.match(out, /2 mistakes/);
  assert.match(out, /1 corrections/);
});

test('distillEntries: hard-caps to 30 lines on big inputs', () => {
  const entries = [];
  for (let i = 0; i < 60; i++) {
    entries.push({
      time: `09:${String(i % 60).padStart(2, '0')}`,
      category: 'mistake',
      bucket: 'Mistakes',
      summary: `entry number ${i}`,
    });
  }
  const out = distillEntries(entries, {
    date: '2026-05-09',
    journalPath: '/tmp/foo.md',
  });
  const lineCount = out.split('\n').length;
  assert.ok(lineCount <= 30, `expected ≤30 lines, got ${lineCount}`);
  assert.match(out, /truncated/);
});

test('distillEntries: emits buckets in stable order (mistakes before insights)', () => {
  const entries = [
    { time: '09:00', category: 'insight', bucket: 'Insights', summary: 'i' },
    { time: '09:30', category: 'mistake', bucket: 'Mistakes', summary: 'm' },
  ];
  const out = distillEntries(entries, { date: '2026-05-09' });
  const mistakeIdx = out.indexOf('**Mistakes**');
  const insightIdx = out.indexOf('**Insights**');
  assert.ok(mistakeIdx >= 0 && insightIdx >= 0);
  assert.ok(mistakeIdx < insightIdx, 'Mistakes should appear before Insights');
});

test('consumeTodaysJournal: missing file returns empty distilled block, not error', async () => {
  const dir = await tmpDir();
  const result = await consumeTodaysJournal({ memoryRoot: dir, date: '2026-05-09' });
  assert.equal(result.found, false);
  assert.equal(result.entries.length, 0);
  assert.match(result.distilled, /No journal entries/);
  assert.equal(result.path, journalPathFor(dir, '2026-05-09'));
});

test('consumeTodaysJournal: existing journal parses + distills', async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'learning-journals'));
  const jpath = path.join(dir, 'learning-journals', '2026-05-09.md');
  await fs.writeFile(
    jpath,
    `---
type: learning-journal
source_agent: claude-code-m4
---

## Entries
- [09:00] [mistake] X happened
- [09:15] [correction] JJ corrected to Y
- [10:00] [worked] approach Z
`,
    'utf8'
  );
  const result = await consumeTodaysJournal({ memoryRoot: dir, date: '2026-05-09' });
  assert.equal(result.found, true);
  assert.equal(result.entries.length, 3);
  assert.match(result.distilled, /## Journal Distilled — 2026-05-09/);
  assert.match(result.distilled, /\*\*Mistakes\*\*/);
  assert.match(result.distilled, /JJ corrected to Y/);
});

test('consumeTodaysJournal: requires journalPath OR (memoryRoot+date)', async () => {
  await assert.rejects(() => consumeTodaysJournal({}), /provide journalPath/);
});

test('consumeTodaysJournal: explicit journalPath overrides memoryRoot+date', async () => {
  const dir = await tmpDir();
  const explicit = path.join(dir, 'custom.md');
  await fs.writeFile(explicit, `## Entries\n- [09:00] [mistake] hi\n`, 'utf8');
  const result = await consumeTodaysJournal({ journalPath: explicit });
  assert.equal(result.found, true);
  assert.equal(result.entries.length, 1);
});
