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

// --- R2 fixes ---

test('findRelativeDates: ASCII-boundary regex blocks CJK-adjacent matches', () => {
  // Code-reviewer R1 M1: `\b` is ASCII-only so CJK-adjacent `今天today` was
  // previously matched. Explicit ASCII boundary rejects this case.
  assert.deepEqual(findRelativeDates('今天today明天', '2026-05-10'), []);
  assert.deepEqual(findRelativeDates('🚀today', '2026-05-10'), []);
  // But CJK-with-space-around-phrase still matches (boundary is space).
  const matches = findRelativeDates('今天 today 明天', '2026-05-10');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].phrase.toLowerCase(), 'today');
});

test('findRelativeDates: does NOT match across newline (last\\nweek)', () => {
  // Codex R1 #4: `\s+` previously matched `last\nweek`. Restricted to
  // horizontal whitespace `[ \t]+`.
  const out = findRelativeDates('We shipped last\nweek again', '2026-05-10');
  assert.equal(out.length, 0);
});

test('findRelativeDates: skips matches inside indent-style code blocks', () => {
  // Reality-checker R1 F2: 4-space-indent code blocks are valid CommonMark
  // and should NOT be rewritten.
  const content = [
    'Outside today.',
    '',
    '    def foo():',
    '        # check yesterday',
    '',
    'After tomorrow.',
  ].join('\n');
  const matches = findRelativeDates(content, '2026-05-10');
  // Only `today` (line 1) and `tomorrow` (line 6) match.
  assert.equal(matches.length, 2);
  const phrases = matches.map(m => m.phrase.toLowerCase()).sort();
  assert.deepEqual(phrases, ['today', 'tomorrow']);
});

test('findRelativeDates: skips matches inside double-backtick spans', () => {
  // Code-reviewer R1 M2: ``…`` inline spans must skip too.
  const content = 'Outside today; example: ``never use yesterday`` literally.';
  const matches = findRelativeDates(content, '2026-05-10');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].phrase.toLowerCase(), 'today');
});

test('findRelativeDates: skips matches inside double-quoted strings', () => {
  // Reality-checker R1 F1: a quoted historical reference should survive.
  const content = `JJ said "use yesterday's value" but today it shipped.`;
  const matches = findRelativeDates(content, '2026-05-10');
  // Only outside `today` matches; `yesterday` inside quotes is preserved.
  assert.equal(matches.length, 1);
  assert.equal(matches[0].phrase.toLowerCase(), 'today');
});

test('findRelativeDates: skips matches inside URLs and Markdown link targets', () => {
  // Reality-checker R1 F4.
  const content = [
    'See https://example.com/yesterday-news/ for context.',
    'Also [link](today.md) is relative.',
    'Real today reference.',
  ].join('\n');
  const matches = findRelativeDates(content, '2026-05-10');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].lineNumber, 3);
});

test('runDatesContradictions: working-memory overflow guard skips file w/o crash', async () => {
  // Code-reviewer R1 M3: a rewrite that pushes working-memory past 80
  // lines must NOT be staged. The file is dropped from byFile and the
  // overflow surfaces in the summary.
  const dir = await tmpDir();
  const lines = [];
  // 80 lines under cap; 81st pushes us over.
  for (let i = 0; i < 81; i++) {
    lines.push(`Line ${i} happened today`);
  }
  await writeFile(path.join(dir, 'working-memory.md'), lines.join('\n') + '\n');
  const { plan, summary } = await runDatesContradictions({
    memoryRoot: dir,
    today: '2026-05-10',
  });
  assert.equal(plan.byFile.length, 0);
  assert.equal(summary.workingMemoryOverflowSkipped, 1);
});

test('runDatesContradictions: excludePaths skips Phase-3 demotion targets', async () => {
  // Reality-checker R1 F7 BLOCKER fix: Phase-4 must skip files Phase-3
  // is about to tombstone, otherwise the dual stage collides at sweep.
  const dir = await tmpDir();
  const adir = path.join(dir, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'demoted.md'), 'fired today\n');
  await fs.writeFile(path.join(adir, 'kept.md'), 'fired yesterday\n');

  const { plan } = await runDatesContradictions({
    memoryRoot: dir,
    today: '2026-05-10',
    excludePaths: ['patterns/active/demoted.md'],
  });
  // `kept.md` rewrites; `demoted.md` is skipped.
  assert.equal(plan.byFile.length, 1);
  assert.equal(plan.byFile[0].sourceRel, 'patterns/active/kept.md');
});

test('runDatesContradictions: preStaged map overrides live file content', async () => {
  // Codex R1 #1 BLOCKER fix: Phase-3 trim feeds Phase-4 via preStaged.
  const dir = await tmpDir();
  // Live corrections.md has both old (would-be-archived) + recent content.
  await writeFile(path.join(dir, 'corrections.md'), [
    'old aged-RESOLVED entry that Phase-3 would archive',
    'recent UNRESOLVED yesterday stuck',
  ].join('\n'));
  // Simulate the trimmed Phase-3 staged content (only the recent line).
  const trimmed = 'recent UNRESOLVED yesterday stuck\n';
  const { plan } = await runDatesContradictions({
    memoryRoot: dir,
    today: '2026-05-10',
    preStaged: new Map([['corrections.md', trimmed]]),
  });
  assert.equal(plan.byFile.length, 1);
  // newContent is the rewrite of the TRIMMED content, not the live file.
  assert.equal(plan.byFile[0].newContent.includes('old aged-RESOLVED'), false);
  assert.match(plan.byFile[0].newContent, /2026-05-09 stuck/);
});

test('runDatesContradictions: contradictionsStub flag in summary', () => {
  // Reality-checker R1 F3 + Codex R1 #3: contradictions=0 misleads. Now
  // surfaced explicitly so the CLI can label it `stub` until P5.
  // (Behavior is async; just verify the field shape via a simple call.)
  return runDatesContradictions({ memoryRoot: '/nonexistent/path/should/early-fail-cleanly-or-empty', today: '2026-05-10' })
    .catch(() => null) // ENOENT on patterns dir is fine; we only inspect summary on success
    .then(async () => {
      const dir = await tmpDir();
      const r = await runDatesContradictions({ memoryRoot: dir, today: '2026-05-10' });
      assert.equal(r.summary.contradictionsStub, true);
      assert.equal(r.summary.contradictionCount, 0);
    });
});

test('offsetISO: handles month + year boundaries (test-automator R1)', () => {
  // Feb 28 + 1 day in non-leap year
  assert.equal(_internals.offsetISO('2026-02-28', 1), '2026-03-01');
  // Dec 31 + 30 days
  assert.equal(_internals.offsetISO('2026-12-31', 30), '2027-01-30');
  // Leap year: 2024-02-28 + 1
  assert.equal(_internals.offsetISO('2024-02-28', 1), '2024-02-29');
  // Year boundary going back
  assert.equal(_internals.offsetISO('2026-01-01', -1), '2025-12-31');
});
