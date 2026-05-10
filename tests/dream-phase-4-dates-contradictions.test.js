import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findRelativeDates,
  rewriteRelativeDates,
  runDatesContradictions,
  stageDatesContradictionsPlan,
  _internals,
} from '../lib/dream/phase-4-dates-contradictions.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-p4-'));
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

test('offsetISO: handles each declared offset deterministically', () => {
  assert.equal(_internals.offsetISO('2026-05-10', 0), '2026-05-10');
  assert.equal(_internals.offsetISO('2026-05-10', -1), '2026-05-09');
  assert.equal(_internals.offsetISO('2026-05-10', +1), '2026-05-11');
  assert.equal(_internals.offsetISO('2026-05-10', -7), '2026-05-03');
  assert.equal(_internals.offsetISO('2026-05-10', +7), '2026-05-17');
  assert.equal(_internals.offsetISO('2026-05-10', -30), '2026-04-10');
  assert.equal(_internals.offsetISO('2026-05-10', +30), '2026-06-09');
});

test('offsetISO: rejects malformed today', () => {
  assert.throws(() => _internals.offsetISO('20260510', 0), /YYYY-MM-DD/);
  assert.throws(() => _internals.offsetISO('not-a-date', 0), /YYYY-MM-DD/);
});

test('findRelativeDates: detects each declared phrase, case-insensitive', () => {
  const content = 'Today is fine. Yesterday broke. Last week we shipped. TOMORROW pending.';
  const matches = findRelativeDates(content, '2026-05-10');
  const phrases = matches.map(m => m.phrase.toLowerCase());
  assert.ok(phrases.includes('today'));
  assert.ok(phrases.includes('yesterday'));
  assert.ok(phrases.includes('last week'));
  assert.ok(phrases.includes('tomorrow'));
});

test('findRelativeDates: word-boundary respect (no match inside larger word)', () => {
  // "tomorrows" should NOT match `tomorrow`
  const matches = findRelativeDates('Many tomorrows ago', '2026-05-10');
  assert.equal(matches.length, 0);
});

test('findRelativeDates: skips matches inside fenced code blocks', () => {
  const content = [
    'Outside today.',
    '',
    '```',
    'Inside today should NOT match.',
    '```',
    '',
    'After yesterday.',
  ].join('\n');
  const matches = findRelativeDates(content, '2026-05-10');
  // Should find: outside today + after yesterday — NOT the inside
  assert.equal(matches.length, 2);
  assert.deepEqual(
    matches.map(m => m.phrase.toLowerCase()).sort(),
    ['today', 'yesterday'],
  );
});

test('findRelativeDates: skips matches inside inline backtick spans', () => {
  const content = 'Outside today; example shows `today` literal.';
  const matches = findRelativeDates(content, '2026-05-10');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].phrase.toLowerCase(), 'today');
});

test('findRelativeDates: returns line number, start, end, and suggestedISO', () => {
  const content = 'Line 1\nLine 2 says yesterday\nLine 3 normal';
  const matches = findRelativeDates(content, '2026-05-10');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].phrase.toLowerCase(), 'yesterday');
  assert.equal(matches[0].lineNumber, 2);
  assert.equal(matches[0].suggestedISO, '2026-05-09');
  assert.equal(content.slice(matches[0].start, matches[0].end).toLowerCase(), 'yesterday');
});

test('findRelativeDates: handles `last  week` with extra whitespace', () => {
  const content = 'We shipped last  week and again last\tweek';
  const matches = findRelativeDates(content, '2026-05-10');
  // Both `last  week` (double-space) and `last\tweek` (tab) match because the
  // regex uses `\s+` between the words.
  assert.equal(matches.length, 2);
  for (const m of matches) {
    assert.equal(m.suggestedISO, '2026-05-03');
  }
});

test('findRelativeDates: empty / non-string input → []', () => {
  assert.deepEqual(findRelativeDates('', '2026-05-10'), []);
  assert.deepEqual(findRelativeDates(null, '2026-05-10'), []);
});

test('rewriteRelativeDates: replaces every occurrence right-to-left, idempotent on rerun', () => {
  const content = 'Yesterday was today; tomorrow is next week.';
  const r1 = rewriteRelativeDates(content, '2026-05-10');
  assert.match(r1.content, /2026-05-09 was 2026-05-10; 2026-05-11 is 2026-05-17/i);
  assert.equal(r1.replacements.length, 4);
  // Second pass: ISO dates do NOT match the relative-date regex, so no further changes.
  const r2 = rewriteRelativeDates(r1.content, '2026-05-10');
  assert.equal(r2.content, r1.content);
  assert.equal(r2.replacements.length, 0);
});

test('rewriteRelativeDates: preserves code blocks verbatim', () => {
  const content = [
    'Pre yesterday',
    '```',
    'kept yesterday verbatim',
    '```',
    'Post tomorrow',
  ].join('\n');
  const out = rewriteRelativeDates(content, '2026-05-10');
  assert.match(out.content, /Pre 2026-05-09/);
  assert.match(out.content, /kept yesterday verbatim/);
  assert.match(out.content, /Post 2026-05-11/);
});

test('rewriteRelativeDates: empty replacement list → identity', () => {
  const content = 'No relatives here.';
  const out = rewriteRelativeDates(content, '2026-05-10');
  assert.equal(out.content, content);
  assert.deepEqual(out.replacements, []);
});

test('runDatesContradictions: scans hot files + patterns/active, builds plan', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'working-memory.md'), 'updated yesterday\n');
  await writeFile(path.join(dir, 'corrections.md'), 'no relatives\n');
  await writeFile(path.join(dir, 'session-index.md'), 'tomorrow we ship\n');
  await fs.mkdir(path.join(dir, 'patterns', 'active'), { recursive: true });
  await writeFile(path.join(dir, 'patterns', 'active', 'foo.md'), 'fired today\n');

  const { plan, summary } = await runDatesContradictions({
    memoryRoot: dir,
    today: '2026-05-10',
  });
  // Three files have replacements (corrections has none).
  assert.equal(plan.byFile.length, 3);
  assert.equal(summary.filesWithReplacements, 3);
  assert.equal(summary.totalReplacements, 3);

  const byPath = Object.fromEntries(plan.byFile.map(b => [b.sourceRel, b]));
  assert.match(byPath['working-memory.md'].newContent, /updated 2026-05-09/);
  assert.match(byPath['session-index.md'].newContent, /2026-05-11 we ship/);
  assert.match(byPath['patterns/active/foo.md'].newContent, /fired 2026-05-10/);

  // Contradiction stub returns []
  assert.deepEqual(plan.contradictions, []);
  assert.equal(summary.contradictionCount, 0);
});

test('runDatesContradictions: missing files are silently skipped, no crash', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'working-memory.md'), 'all clean\n');
  // No corrections.md / session-index.md / patterns dir
  const { plan, summary } = await runDatesContradictions({
    memoryRoot: dir,
    today: '2026-05-10',
  });
  assert.deepEqual(plan.byFile, []);
  assert.equal(summary.filesWithReplacements, 0);
});

test('runDatesContradictions: rejects bad today + missing memoryRoot', async () => {
  await assert.rejects(() => runDatesContradictions({}), /memoryRoot required/);
  await assert.rejects(
    () => runDatesContradictions({ memoryRoot: '/x' }),
    /today required/,
  );
  await assert.rejects(
    () => runDatesContradictions({ memoryRoot: '/x', today: 'yesterday' }),
    /YYYY-MM-DD/,
  );
});

test('stageDatesContradictionsPlan: writes each rewritten file under staged/ tree', async () => {
  const dir = await tmpDir();
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const plan = {
    today: '2026-05-10',
    byFile: [
      {
        sourceRel: 'working-memory.md',
        newContent: 'rewritten\n',
        replacements: [{ lineNumber: 1, phrase: 'today', suggestedISO: '2026-05-10' }],
      },
      {
        sourceRel: 'patterns/active/foo.md',
        newContent: 'rewritten foo\n',
        replacements: [{ lineNumber: 1, phrase: 'yesterday', suggestedISO: '2026-05-09' }],
      },
    ],
    contradictions: [],
  };
  const { stagedFiles } = await stageDatesContradictionsPlan({
    plan, dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  assert.equal(stagedFiles.length, 2);
  assert.ok(stagedFiles.some(p => p.endsWith('staged/working-memory.md.tmp')));
  assert.ok(stagedFiles.some(p => p.endsWith('staged/patterns/active/foo.md.tmp')));
  const c = await fs.readFile(stagedFiles[0], 'utf8');
  assert.match(c, /rewritten/);
});

test('stageDatesContradictionsPlan: empty plan produces no staged files', async () => {
  const dir = await tmpDir();
  const dreamDir = path.join(dir, 'archive', 'dreams', '2026-05-10');
  const out = await stageDatesContradictionsPlan({
    plan: { today: '2026-05-10', byFile: [], contradictions: [] },
    dreamDir, memoryRoot: dir, today: '2026-05-10',
  });
  assert.deepEqual(out.stagedFiles, []);
});

test('stageDatesContradictionsPlan: throws on missing required args', async () => {
  await assert.rejects(() => stageDatesContradictionsPlan({}), /plan required/);
});

test('buildSkipRanges: nested code-blocks + inline are both skipped', () => {
  const content = '```\nfenced today\n```\ninline `today` here, plus today out.';
  const ranges = _internals.buildSkipRanges(content);
  // At least 2 ranges: the fence + the inline span
  assert.ok(ranges.length >= 2);
  // Confirm `today` outside both is the only matchable instance
  const matches = findRelativeDates(content, '2026-05-10');
  assert.equal(matches.length, 1);
});
