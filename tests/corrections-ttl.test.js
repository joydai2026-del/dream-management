import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCorrections, applyCorrectionsTTL, isStatusResolved } from '../lib/corrections-ttl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'corrections-sample.md');
const NOW = new Date('2026-05-08T12:00:00Z');

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-corr-'));
}

test('classifier: archives RESOLVED entries older than 30 days, keeps fresh + UNRESOLVED + undated', async () => {
  const content = await fs.readFile(FIXTURE, 'utf8');
  const { keep, archive } = classifyCorrections(content, { now: NOW });

  // Fixture: 2 should archive (2026-01-15 RESOLVED, 2026-02-10 RESOLVED structurally),
  // 3 should keep (2026-05-01 within window, 2025-12-01 UNRESOLVED, undated RESOLVED)
  assert.equal(archive.length, 2);
  assert.deepEqual(archive.map(a => a.monthKey).sort(), ['2026-01', '2026-02']);

  const keptItems = keep.filter(b => b.type === 'item');
  assert.equal(keptItems.length, 3);
});

test('classifier: never archives an item with no parseable date', async () => {
  const content = '### no date in heading or body, RESOLVED.\n- **Status**: RESOLVED.\n';
  const { archive, keep } = classifyCorrections(content, { now: NOW });
  assert.equal(archive.length, 0);
  assert.equal(keep.filter(b => b.type === 'item').length, 1);
});

test('isStatusResolved: plain RESOLVED → true', () => {
  assert.equal(isStatusResolved('- **Status**: RESOLVED.'), true);
});

test('isStatusResolved: RESOLVED structurally → true', () => {
  assert.equal(isStatusResolved('- **Status**: RESOLVED structurally.'), true);
});

test('isStatusResolved: plain UNRESOLVED → false', () => {
  assert.equal(isStatusResolved('- **Status**: UNRESOLVED.'), false);
});

test('isStatusResolved: mixed RESOLVED-and-UNRESOLVED on same line → false (conservative)', () => {
  // Live-vault edge case: an entry whose status mentions both states.
  const text = '- **Status**: RESOLVED — primary closed. Sub-issue is still UNRESOLVED (see Unresolved section).';
  assert.equal(isStatusResolved(text), false);
});

test('isStatusResolved: no Status line → false', () => {
  assert.equal(isStatusResolved('### some heading\nbody without status field'), false);
});

test('apply: dry-run reports counts without writing', async () => {
  const dir = await tmpDir();
  const source = path.join(dir, 'corrections.md');
  await fs.copyFile(FIXTURE, source);
  const archiveDir = path.join(dir, 'archive', 'corrections');
  await fs.mkdir(archiveDir, { recursive: true });

  const result = await applyCorrectionsTTL({ source, archiveDir, now: NOW, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.archived, 2);
  assert.equal(result.kept, 3);

  // Source should be unchanged
  const orig = await fs.readFile(FIXTURE, 'utf8');
  const after = await fs.readFile(source, 'utf8');
  assert.equal(after, orig);

  // Archive should be empty
  const archEntries = await fs.readdir(archiveDir);
  assert.equal(archEntries.length, 0);
});

test('apply: real write moves aged entries to month-bucketed archive files', async () => {
  const dir = await tmpDir();
  const source = path.join(dir, 'corrections.md');
  await fs.copyFile(FIXTURE, source);
  const archiveDir = path.join(dir, 'archive', 'corrections');
  await fs.mkdir(archiveDir, { recursive: true });

  const result = await applyCorrectionsTTL({ source, archiveDir, now: NOW });
  assert.equal(result.archived, 2);
  assert.deepEqual(result.byMonth.sort(), ['2026-01', '2026-02']);

  const jan = await fs.readFile(path.join(archiveDir, '2026-01.md'), 'utf8');
  const feb = await fs.readFile(path.join(archiveDir, '2026-02.md'), 'utf8');
  assert.match(jan, /Old resolved entry should archive/);
  assert.match(feb, /Older resolved entry, structurally/);

  // Source should no longer contain archived entries
  const newSource = await fs.readFile(source, 'utf8');
  assert.doesNotMatch(newSource, /Old resolved entry should archive/);
  assert.doesNotMatch(newSource, /Older resolved entry, structurally/);
  // But should still contain kept entries
  assert.match(newSource, /Recent resolved entry should keep/);
  assert.match(newSource, /Aged but UNRESOLVED — must keep/);
  assert.match(newSource, /Resolved with no date — must keep/);
});

test('apply: idempotent on repeat run (no re-archiving)', async () => {
  const dir = await tmpDir();
  const source = path.join(dir, 'corrections.md');
  await fs.copyFile(FIXTURE, source);
  const archiveDir = path.join(dir, 'archive', 'corrections');
  await fs.mkdir(archiveDir, { recursive: true });

  await applyCorrectionsTTL({ source, archiveDir, now: NOW });
  const result2 = await applyCorrectionsTTL({ source, archiveDir, now: NOW });
  assert.equal(result2.archived, 0);
});

test('apply: conservation invariant — line counts balance', async () => {
  const dir = await tmpDir();
  const source = path.join(dir, 'corrections.md');
  await fs.copyFile(FIXTURE, source);
  const archiveDir = path.join(dir, 'archive', 'corrections');
  await fs.mkdir(archiveDir, { recursive: true });

  const origContent = await fs.readFile(source, 'utf8');
  const origLines = origContent.split('\n').length;

  await applyCorrectionsTTL({ source, archiveDir, now: NOW });

  const newSource = await fs.readFile(source, 'utf8');
  const jan = await fs.readFile(path.join(archiveDir, '2026-01.md'), 'utf8');
  const feb = await fs.readFile(path.join(archiveDir, '2026-02.md'), 'utf8');

  const newLines = newSource.split('\n').length;
  const archLines = jan.split('\n').length + feb.split('\n').length;

  // Allow small drift from boundary newlines + the `\n` we add when appending to archive
  const drift = Math.abs(origLines - newLines - archLines);
  assert.ok(drift <= 5, `conservation drift too large: orig=${origLines} new=${newLines} arch=${archLines} drift=${drift}`);
});
