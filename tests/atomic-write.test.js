import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, atomicAppend, atomicMove } from '../lib/atomic-write.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-atomic-'));
}

test('atomicWrite creates the file', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'foo.md');
  await atomicWrite(dest, 'hello');
  assert.equal(await fs.readFile(dest, 'utf8'), 'hello');
});

test('atomicWrite leaves no .tmp files after success', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'foo.md');
  await atomicWrite(dest, 'hello');
  const entries = await fs.readdir(dir);
  const tmps = entries.filter(e => e.includes('.tmp'));
  assert.deepEqual(tmps, []);
});

test('atomicWrite overwrites existing file atomically', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'bar.md');
  await fs.writeFile(dest, 'old');
  await atomicWrite(dest, 'new');
  assert.equal(await fs.readFile(dest, 'utf8'), 'new');
});

test('atomicWrite throws if parent directory missing', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'no-such-subdir', 'file.md');
  await assert.rejects(() => atomicWrite(dest, 'x'), /parent directory does not exist/);
});

test('atomicWrite is robust to a pre-existing .tmp at the destination path (unique names)', async () => {
  // With unique tmp names, an attacker-or-stale .tmp at ${dest}.tmp does not interfere —
  // we never use that exact path. Verify by planting a .tmp file ourselves.
  const dir = await tmpDir();
  const dest = path.join(dir, 'qux.md');
  await fs.writeFile(`${dest}.tmp`, 'someone elses tmp');
  await atomicWrite(dest, 'mine');
  assert.equal(await fs.readFile(dest, 'utf8'), 'mine');
  // the planted .tmp may still exist; that's fine — it's not in our way
});

test('atomicAppend creates new file when missing', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'append.md');
  await atomicAppend(dest, 'first\n');
  assert.equal(await fs.readFile(dest, 'utf8'), 'first\n');
});

test('atomicAppend appends to existing file', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'append.md');
  await fs.writeFile(dest, 'one\n');
  await atomicAppend(dest, 'two\n');
  assert.equal(await fs.readFile(dest, 'utf8'), 'one\ntwo\n');
});

test('atomicAppend serializes concurrent calls (no lost append)', async () => {
  // Two concurrent appends to the same destination must both land. Without the per-dest
  // lock, both readers see "" and one overwrites the other's result.
  const dir = await tmpDir();
  const dest = path.join(dir, 'concurrent.md');
  await Promise.all([
    atomicAppend(dest, 'A\n'),
    atomicAppend(dest, 'B\n'),
  ]);
  const content = await fs.readFile(dest, 'utf8');
  assert.ok(content.includes('A\n'), `missing A: ${content}`);
  assert.ok(content.includes('B\n'), `missing B: ${content}`);
  assert.equal(content.split('\n').length, 3); // "A\nB\n" or "B\nA\n" → 3 lines on split
});

test('atomicAppend cleans up its lock file on success', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'lock-clean.md');
  await atomicAppend(dest, 'x\n');
  const entries = await fs.readdir(dir);
  const locks = entries.filter(e => e.includes('.lock'));
  assert.deepEqual(locks, []);
});

test('atomicMove moves a file', async () => {
  const dir = await tmpDir();
  const from = path.join(dir, 'src.md');
  const to = path.join(dir, 'a', 'b', 'dest.md');
  await fs.writeFile(from, 'payload');
  await atomicMove(from, to);
  assert.equal(await fs.readFile(to, 'utf8'), 'payload');
  await assert.rejects(() => fs.access(from));
});
