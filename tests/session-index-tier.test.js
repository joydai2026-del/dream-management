import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifySessionIndex,
  applySessionIndexTier,
} from '../lib/session-index-tier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'session-index-sample.md');

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-sess-'));
}

test('classifier: keeps top-N most-recent items, archives the rest', async () => {
  const content = await fs.readFile(FIXTURE, 'utf8');
  const { keep, archive } = classifySessionIndex(content, { keepLastN: 10 });

  // Fixture has 13 entries. Keep top 10 by date desc, archive the older 3.
  const keptItems = keep.filter(b => b.type === 'item');
  assert.equal(keptItems.length, 10);
  assert.equal(archive.length, 3);

  const archiveDates = archive.map(a => a.dateISO).sort();
  assert.deepEqual(archiveDates, ['2026-03-15', '2026-04-27', '2026-04-28']);
});

test('classifier: keeps undated items unconditionally', async () => {
  const content = [
    '### Undated entry',
    'no date here',
    '### Dated 2026-05-08',
    'body',
    '### Dated 2026-05-07',
    'body',
    '### Dated 2026-05-06',
    'body',
  ].join('\n');
  const { keep, archive, undatedKept } = classifySessionIndex(content, { keepLastN: 2 });
  // Top 2 dated are 2026-05-08 and 2026-05-07; 2026-05-06 archives; undated kept.
  assert.equal(undatedKept, 1);
  assert.equal(archive.length, 1);
  assert.equal(archive[0].dateISO, '2026-05-06');
  assert.equal(keep.filter(b => b.type === 'item').length, 3);
});

test('classifier: when item count <= keepLastN, archive is empty', async () => {
  const content = '### 2026-05-08 only\nbody\n';
  const { archive } = classifySessionIndex(content, { keepLastN: 10 });
  assert.equal(archive.length, 0);
});

test('apply: real write moves older entries to monthly archive files', async () => {
  const dir = await tmpDir();
  const source = path.join(dir, 'session-index.md');
  await fs.copyFile(FIXTURE, source);
  const archiveDir = path.join(dir, 'archive', 'sessions');
  await fs.mkdir(archiveDir, { recursive: true });

  const result = await applySessionIndexTier({ source, archiveDir, keepLastN: 10 });
  assert.equal(result.archived, 3);
  assert.deepEqual(result.byMonth.sort(), ['2026-03', '2026-04']);

  const apr = await fs.readFile(path.join(archiveDir, 'session-index-2026-04.md'), 'utf8');
  const mar = await fs.readFile(path.join(archiveDir, 'session-index-2026-03.md'), 'utf8');
  assert.match(apr, /2026-04-28/);
  assert.match(apr, /2026-04-27/);
  assert.match(mar, /2026-03-15/);

  const newSource = await fs.readFile(source, 'utf8');
  assert.doesNotMatch(newSource, /2026-04-28/);
  assert.doesNotMatch(newSource, /2026-03-15/);
  assert.match(newSource, /2026-05-08/); // most-recent kept
});

test('apply: dry-run never writes', async () => {
  const dir = await tmpDir();
  const source = path.join(dir, 'session-index.md');
  await fs.copyFile(FIXTURE, source);
  const archiveDir = path.join(dir, 'archive', 'sessions');
  await fs.mkdir(archiveDir, { recursive: true });

  const orig = await fs.readFile(source, 'utf8');
  const result = await applySessionIndexTier({ source, archiveDir, keepLastN: 10, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.archived, 3);
  assert.equal(await fs.readFile(source, 'utf8'), orig);
  assert.deepEqual(await fs.readdir(archiveDir), []);
});

test('apply: idempotent on repeat run', async () => {
  const dir = await tmpDir();
  const source = path.join(dir, 'session-index.md');
  await fs.copyFile(FIXTURE, source);
  const archiveDir = path.join(dir, 'archive', 'sessions');
  await fs.mkdir(archiveDir, { recursive: true });

  await applySessionIndexTier({ source, archiveDir, keepLastN: 10 });
  const r2 = await applySessionIndexTier({ source, archiveDir, keepLastN: 10 });
  assert.equal(r2.archived, 0);
});
