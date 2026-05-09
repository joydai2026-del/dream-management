import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rotateNextSessionPrompts } from '../lib/next-session-rotate.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-rotate-'));
}

async function listMdAtRoot(dir) {
  const names = await fs.readdir(dir);
  return names.filter(n => n.endsWith('.md')).sort();
}

test('rotateNextSessionPrompts: empty memoryRoot → no-op', async () => {
  const dir = await tmpDir();
  const result = await rotateNextSessionPrompts({ memoryRoot: dir });
  assert.equal(result.rotated, 0);
  assert.equal(result.archived, 0);
  assert.equal(result.latest, null);
});

test('rotateNextSessionPrompts: collapses multiple prompts to next-session.md, archives rest', async () => {
  const dir = await tmpDir();
  const files = [
    'next-session-prompt-2026-05-07-foo.md',
    'next-session-prompt-2026-05-08-bar.md',
    'next-session-prompt-2026-05-09-dream-mgmt-p2.md',
  ];
  for (const f of files) {
    await fs.writeFile(path.join(dir, f), `# ${f}\nbody`, 'utf8');
  }

  const result = await rotateNextSessionPrompts({ memoryRoot: dir });
  assert.equal(result.rotated, 1);
  assert.equal(result.archived, 3); // 2 older + 1 latest moved-to-archive after copy

  // Root must contain only next-session.md (no prompt files).
  const rootMd = await listMdAtRoot(dir);
  assert.deepEqual(rootMd, ['next-session.md']);

  // Archive must contain all 3 originals.
  const archive = await fs.readdir(path.join(dir, 'archive', 'next-session-prompts'));
  assert.equal(archive.length, 3);
  assert.ok(archive.includes('next-session-prompt-2026-05-09-dream-mgmt-p2.md'));

  // next-session.md content matches the latest source.
  const nsContent = await fs.readFile(path.join(dir, 'next-session.md'), 'utf8');
  assert.match(nsContent, /next-session-prompt-2026-05-09-dream-mgmt-p2/);
});

test('rotateNextSessionPrompts: idempotent on repeat run (no double-archive)', async () => {
  const dir = await tmpDir();
  await fs.writeFile(
    path.join(dir, 'next-session-prompt-2026-05-09-x.md'),
    '# x',
    'utf8'
  );
  const r1 = await rotateNextSessionPrompts({ memoryRoot: dir });
  assert.equal(r1.rotated, 1);

  const r2 = await rotateNextSessionPrompts({ memoryRoot: dir });
  assert.equal(r2.rotated, 0); // nothing left to rotate

  const archive = await fs.readdir(path.join(dir, 'archive', 'next-session-prompts'));
  assert.equal(archive.length, 1);
});

test('rotateNextSessionPrompts: overwrites existing next-session.md (not append)', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'next-session.md'), 'OLD CONTENT', 'utf8');
  await fs.writeFile(
    path.join(dir, 'next-session-prompt-2026-05-09-x.md'),
    'NEW CONTENT',
    'utf8'
  );

  await rotateNextSessionPrompts({ memoryRoot: dir });
  const after = await fs.readFile(path.join(dir, 'next-session.md'), 'utf8');
  assert.equal(after, 'NEW CONTENT');
});

test('rotateNextSessionPrompts: latest is selected by date suffix, not mtime', async () => {
  const dir = await tmpDir();
  // Write older-dated file LAST so its mtime is newer.
  const earlier = path.join(dir, 'next-session-prompt-2026-05-09-newer.md');
  const later = path.join(dir, 'next-session-prompt-2026-05-08-older.md');
  await fs.writeFile(earlier, 'WIN', 'utf8');
  await new Promise(r => setTimeout(r, 20));
  await fs.writeFile(later, 'LOSE', 'utf8');

  await rotateNextSessionPrompts({ memoryRoot: dir });
  const ns = await fs.readFile(path.join(dir, 'next-session.md'), 'utf8');
  assert.equal(ns, 'WIN');
});

test('rotateNextSessionPrompts: also rotates legacy next-session-prompts/ directory', async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'next-session-prompts'));
  await fs.writeFile(
    path.join(dir, 'next-session-prompts', 'next-session-prompt-2026-05-08-legacy.md'),
    'legacy body',
    'utf8'
  );
  await fs.writeFile(
    path.join(dir, 'next-session-prompt-2026-05-09-current.md'),
    'current body',
    'utf8'
  );

  const result = await rotateNextSessionPrompts({ memoryRoot: dir });
  assert.equal(result.rotated, 1);
  // 1 legacy archived + 1 source archived after canonical write
  assert.ok(result.archived >= 2);

  const ns = await fs.readFile(path.join(dir, 'next-session.md'), 'utf8');
  assert.equal(ns, 'current body');

  const archive = await fs.readdir(path.join(dir, 'archive', 'next-session-prompts'));
  assert.ok(archive.some(n => n.includes('legacy')));
  assert.ok(archive.some(n => n.includes('current')));
});

test('rotateNextSessionPrompts: archive move uses no-overwrite primitive (TOCTOU-safe vs intermediate target)', async () => {
  // Simulate: between our pickArchiveCandidate and the move, another writer
  // has already populated `<name>.dup1` with content we must not clobber.
  // Easiest reproducible variant: place a colliding `.dup1` BEFORE rotation,
  // and verify the rotation doesn't overwrite it (lands on `.dup2`).
  const dir = await tmpDir();
  await fs.writeFile(
    path.join(dir, 'next-session-prompt-2026-05-08-x.md'),
    'ROOT_VERSION',
    'utf8'
  );
  await fs.mkdir(path.join(dir, 'archive', 'next-session-prompts'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'archive', 'next-session-prompts', 'next-session-prompt-2026-05-08-x.md'),
    'PRE_EXISTING',
    'utf8'
  );
  await fs.writeFile(
    path.join(dir, 'archive', 'next-session-prompts', 'next-session-prompt-2026-05-08-x.dup1.md'),
    'PRE_EXISTING_DUP1',
    'utf8'
  );
  // Force this -x file to NOT be the latest by adding a newer date.
  await fs.writeFile(
    path.join(dir, 'next-session-prompt-2026-05-09-newer.md'),
    'NEWEST',
    'utf8'
  );

  await rotateNextSessionPrompts({ memoryRoot: dir });

  const archive = await fs.readdir(path.join(dir, 'archive', 'next-session-prompts'));
  assert.ok(archive.includes('next-session-prompt-2026-05-08-x.md'));
  assert.ok(archive.includes('next-session-prompt-2026-05-08-x.dup1.md'));
  // Must have landed at .dup2 to not overwrite either prior copy.
  assert.ok(archive.some(n => n.includes('-x.dup2')), `expected .dup2 file, got: ${archive.join(',')}`);

  const original = await fs.readFile(
    path.join(dir, 'archive', 'next-session-prompts', 'next-session-prompt-2026-05-08-x.md'),
    'utf8'
  );
  assert.equal(original, 'PRE_EXISTING');
  const dup1 = await fs.readFile(
    path.join(dir, 'archive', 'next-session-prompts', 'next-session-prompt-2026-05-08-x.dup1.md'),
    'utf8'
  );
  assert.equal(dup1, 'PRE_EXISTING_DUP1');
});

test('rotateNextSessionPrompts: archive collision preserves prior copy (archive-never-delete)', async () => {
  const dir = await tmpDir();
  // Same filename in BOTH root and legacy dir, with DIFFERENT contents.
  const dupName = 'next-session-prompt-2026-05-08-collide.md';
  await fs.writeFile(path.join(dir, dupName), 'ROOT_VERSION', 'utf8');
  await fs.mkdir(path.join(dir, 'next-session-prompts'));
  await fs.writeFile(
    path.join(dir, 'next-session-prompts', dupName),
    'LEGACY_VERSION',
    'utf8'
  );
  // Plus a newer file so neither colliding file is "latest".
  await fs.writeFile(
    path.join(dir, 'next-session-prompt-2026-05-09-x.md'),
    'NEWEST',
    'utf8'
  );

  await rotateNextSessionPrompts({ memoryRoot: dir });

  const archive = await fs.readdir(path.join(dir, 'archive', 'next-session-prompts'));
  // Both colliding copies must exist (one collision-suffixed).
  const collisions = archive.filter(n => n.includes('collide'));
  assert.equal(collisions.length, 2, `expected 2 collide files in archive, got: ${collisions.join(',')}`);

  // Verify both contents survived.
  const contents = await Promise.all(
    collisions.map(n => fs.readFile(path.join(dir, 'archive', 'next-session-prompts', n), 'utf8'))
  );
  assert.ok(contents.includes('ROOT_VERSION'), 'ROOT_VERSION must survive');
  assert.ok(contents.includes('LEGACY_VERSION'), 'LEGACY_VERSION must survive');
});

test('rotateNextSessionPrompts: dryRun preview, no fs mutation', async () => {
  const dir = await tmpDir();
  await fs.writeFile(
    path.join(dir, 'next-session-prompt-2026-05-09-x.md'),
    'x',
    'utf8'
  );
  const result = await rotateNextSessionPrompts({ memoryRoot: dir, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.rotated, 1);

  const rootMd = await listMdAtRoot(dir);
  assert.deepEqual(rootMd, ['next-session-prompt-2026-05-09-x.md']); // untouched
  await assert.rejects(
    () => fs.access(path.join(dir, 'archive')),
    /ENOENT|no such file/
  );
});
