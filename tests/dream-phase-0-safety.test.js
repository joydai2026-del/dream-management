import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  acquireLock,
  gitTagPreDream,
  snapshot,
  detectRepoRoot,
  isInvokedAs,
  LockHeldError,
  GitTagExistsError,
} from '../lib/dream/phase-0-safety.js';

const exec = promisify(execFile);

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-p0-'));
}

async function gitInit(dir) {
  await exec('git', ['-C', dir, 'init', '-q']);
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'README.md'), 'init\n');
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

test('acquireLock writes a JSON lock and release deletes it', async () => {
  const dir = await tmpDir();
  const lock = await acquireLock(dir);
  const content = JSON.parse(await fs.readFile(path.join(dir, '.dream.lock'), 'utf8'));
  assert.equal(content.pid, process.pid);
  assert.equal(content.hostname, os.hostname());
  assert.equal(content.phase, 'phase-0-safety');
  await lock.release();
  await assert.rejects(() => fs.access(path.join(dir, '.dream.lock')));
});

test('acquireLock refuses when a fresh lock from a live pid exists', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, '.dream.lock'), JSON.stringify({
    pid: process.pid, // alive
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  }));
  await assert.rejects(() => acquireLock(dir), LockHeldError);
});

test('acquireLock takes over when prior lock is stale (dead pid)', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, '.dream.lock'), JSON.stringify({
    pid: 9_999_999, // unlikely to exist
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  }));
  const lock = await acquireLock(dir);
  // Stale lock archived under archive/dreams/<date>/stale-locks/
  const dreamRoots = await fs.readdir(path.join(dir, 'archive', 'dreams'));
  assert.equal(dreamRoots.length, 1);
  const archived = await fs.readdir(path.join(dir, 'archive', 'dreams', dreamRoots[0], 'stale-locks'));
  assert.ok(archived.length === 1, `expected 1 stale lock, got ${archived.length}`);
  await lock.release();
});

test('acquireLock takes over when prior lock has expired', async () => {
  const dir = await tmpDir();
  const oldStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await fs.writeFile(path.join(dir, '.dream.lock'), JSON.stringify({
    pid: process.pid, // alive but expired
    hostname: os.hostname(),
    started_at: oldStart,
  }));
  const lock = await acquireLock(dir, { maxRuntimeMs: 10 * 60 * 1000 });
  assert.equal(lock.meta.pid, process.pid);
  await lock.release();
});

test('acquireLock treats foreign hostname as live within its runtime window', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, '.dream.lock'), JSON.stringify({
    pid: 1, // can't ping a foreign host's pid
    hostname: 'some-other-host',
    started_at: new Date().toISOString(), // fresh
  }));
  await assert.rejects(() => acquireLock(dir), LockHeldError);
});

test('lock.update rewrites the lock with a new phase + updated_at', async () => {
  const dir = await tmpDir();
  const lock = await acquireLock(dir, { phase: 'phase-0-safety' });
  await lock.update('phase-1-replay');
  const c = JSON.parse(await fs.readFile(path.join(dir, '.dream.lock'), 'utf8'));
  assert.equal(c.phase, 'phase-1-replay');
  assert.ok(c.updated_at);
  await lock.release();
});

test('lock.release is idempotent', async () => {
  const dir = await tmpDir();
  const lock = await acquireLock(dir);
  await lock.release();
  await lock.release(); // should not throw
});

test('detectRepoRoot returns toplevel for a memoryRoot inside a repo', async () => {
  const dir = await tmpDir();
  await gitInit(dir);
  const sub = path.join(dir, 'sub');
  await fs.mkdir(sub);
  const got = await detectRepoRoot(sub);
  assert.ok(got);
  // realpath both sides — macOS tmp dirs resolve via /private/var symlink
  assert.equal(await fs.realpath(got), await fs.realpath(dir));
});

test('detectRepoRoot returns null when not in a git repo', async () => {
  const dir = await tmpDir();
  const got = await detectRepoRoot(dir);
  assert.equal(got, null);
});

test('gitTagPreDream creates dream/pre/<date>', async () => {
  const dir = await tmpDir();
  await gitInit(dir);
  const r = await gitTagPreDream({ repoRoot: dir, date: '2026-05-09' });
  assert.equal(r.tag, 'dream/pre/2026-05-09');
  assert.equal(r.alreadyExisted, false);
  const tags = (await exec('git', ['-C', dir, 'tag', '-l', 'dream/pre/2026-05-09'])).stdout.trim();
  assert.equal(tags, 'dream/pre/2026-05-09');
});

test('gitTagPreDream is idempotent when tag already points at HEAD', async () => {
  const dir = await tmpDir();
  await gitInit(dir);
  await gitTagPreDream({ repoRoot: dir, date: '2026-05-09' });
  const r = await gitTagPreDream({ repoRoot: dir, date: '2026-05-09' });
  assert.equal(r.alreadyExisted, true);
});

test('gitTagPreDream throws when tag exists pointing elsewhere', async () => {
  const dir = await tmpDir();
  await gitInit(dir);
  await exec('git', ['-C', dir, 'tag', 'dream/pre/2026-05-09']);
  await fs.writeFile(path.join(dir, 'b.txt'), 'b');
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'b']);
  await assert.rejects(
    () => gitTagPreDream({ repoRoot: dir, date: '2026-05-09' }),
    GitTagExistsError,
  );
});

test('gitTagPreDream --dry-run returns sha but does not create tag', async () => {
  const dir = await tmpDir();
  await gitInit(dir);
  const r = await gitTagPreDream({ repoRoot: dir, date: '2026-05-09', dryRun: true });
  assert.equal(r.dryRun, true);
  const tags = (await exec('git', ['-C', dir, 'tag', '-l'])).stdout.trim();
  assert.equal(tags, '');
});

test('snapshot copies tier files into archive/dreams/<date>/snapshot/ and writes manifest', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'working-memory.md'), '# wm\nline2\n');
  await fs.writeFile(path.join(dir, 'corrections.md'), '## a\n## b\n## c\n');
  await fs.mkdir(path.join(dir, 'patterns', 'active'), { recursive: true });
  await fs.writeFile(path.join(dir, 'patterns', 'active', 'p1.md'), '---\nx: 1\n---\n');
  await fs.mkdir(path.join(dir, 'patterns', 'reference'), { recursive: true });
  await fs.writeFile(path.join(dir, 'patterns', 'reference', 'p2.md'), '---\nx: 2\n---\n');

  const snap = await snapshot({
    memoryRoot: dir,
    date: '2026-05-09',
    consumerName: 'test',
    gitTag: 'dream/pre/2026-05-09',
    gitHeadBefore: 'deadbeef',
    tierFiles: { hot: ['working-memory.md'], warm: ['corrections.md'] },
    patternsDirs: ['patterns/active', 'patterns/reference'],
  });

  assert.equal(
    await fs.readFile(path.join(snap.snapshotDir, 'working-memory.md'), 'utf8'),
    '# wm\nline2\n',
  );
  assert.equal(
    await fs.readFile(path.join(snap.snapshotDir, 'patterns/active/p1.md'), 'utf8'),
    '---\nx: 1\n---\n',
  );

  const m = snap.manifest;
  assert.equal(m.consumer_name, 'test');
  assert.equal(m.git_tag, 'dream/pre/2026-05-09');
  assert.equal(m.git_head_before, 'deadbeef');
  assert.equal(m.totals.patterns_active_count, 1);
  assert.equal(m.totals.patterns_reference_count, 1);
  const wm = m.files.find(f => f.path === 'working-memory.md');
  assert.ok(wm);
  assert.equal(wm.sha256.length, 64);
  assert.ok(wm.lines >= 2);

  // Manifest landed at dreamDir root (not in snapshot/)
  await fs.access(path.join(snap.dreamDir, 'manifest.json'));
});

test('snapshot skips missing tier files silently', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'working-memory.md'), 'wm\n');
  const snap = await snapshot({
    memoryRoot: dir,
    date: '2026-05-09',
    tierFiles: {
      hot: ['working-memory.md', 'pre-action.md'],
      warm: ['corrections.md'],
    },
    patternsDirs: [],
  });
  assert.equal(snap.manifest.files.length, 1);
  assert.equal(snap.manifest.files[0].path, 'working-memory.md');
});

test('snapshot records declared symlinks without copying targets', async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'decisions'));
  await fs.writeFile(path.join(dir, 'decisions', 'd1.md'), 'decision');
  const snap = await snapshot({
    memoryRoot: dir,
    date: '2026-05-09',
    tierFiles: { hot: [], warm: [] },
    patternsDirs: [],
    symlinks: [{ path: 'decisions', target: '../../../decisions' }],
  });
  const linkPath = path.join(snap.snapshotDir, 'decisions');
  const stat = await fs.lstat(linkPath);
  assert.ok(stat.isSymbolicLink());
  assert.deepEqual(snap.manifest.symlinks, [{ path: 'decisions', target: '../../../decisions' }]);
});

test('snapshot does NOT follow undeclared symlinks; records them in skipped[]', async () => {
  const dir = await tmpDir();
  // Create a real file then a symlink pointing at it; the symlink is the
  // declared tier file. snapshot should refuse to dereference and copy.
  await fs.writeFile(path.join(dir, 'real.md'), 'real content');
  await fs.symlink('real.md', path.join(dir, 'working-memory.md'));
  const snap = await snapshot({
    memoryRoot: dir,
    date: '2026-05-09',
    tierFiles: { hot: ['working-memory.md'], warm: [] },
    patternsDirs: [],
  });
  // Not in files[]
  assert.equal(snap.manifest.files.find(f => f.path === 'working-memory.md'), undefined);
  // In skipped[] with reason
  const sk = snap.manifest.skipped.find(s => s.path === 'working-memory.md');
  assert.ok(sk, 'expected skipped entry');
  assert.match(sk.reason, /undeclared symlink/);
});

test('snapshot fileEntries are sorted alphabetically for deterministic manifest diffs', async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'patterns', 'active'), { recursive: true });
  await fs.writeFile(path.join(dir, 'patterns', 'active', 'zebra.md'), 'z');
  await fs.writeFile(path.join(dir, 'patterns', 'active', 'alpha.md'), 'a');
  await fs.writeFile(path.join(dir, 'patterns', 'active', 'mango.md'), 'm');
  await fs.writeFile(path.join(dir, 'working-memory.md'), 'wm');
  const snap = await snapshot({
    memoryRoot: dir,
    date: '2026-05-09',
    tierFiles: { hot: ['working-memory.md'], warm: [] },
    patternsDirs: ['patterns/active'],
  });
  const paths = snap.manifest.files.map(f => f.path);
  // Sort invariant: paths should equal their own sorted copy
  assert.deepEqual(paths, [...paths].sort());
});

test('snapshot manifest has all required keys per archive-schema.md § 2.2 + 2.3', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'working-memory.md'), 'wm\n');
  const snap = await snapshot({
    memoryRoot: dir,
    date: '2026-05-09',
    consumerName: 'schema-test',
    gitTag: 'dream/pre/2026-05-09',
    gitHeadBefore: 'cafebabe',
    tierFiles: { hot: ['working-memory.md'], warm: [] },
    patternsDirs: [],
  });
  const REQUIRED = [
    ['schema_version', 'string'],
    ['consumer_name', 'string'],
    ['snapshot_at', 'string'],
    ['git_tag', 'string'],
    ['git_head_before', 'string'],
    ['memory_root', 'string'],
    ['files', 'array'],
    ['totals', 'object'],
    ['symlinks', 'array'],
    ['skipped', 'array'],
  ];
  for (const [key, kind] of REQUIRED) {
    assert.ok(key in snap.manifest, `manifest missing required key '${key}'`);
    const v = snap.manifest[key];
    const actual = Array.isArray(v) ? 'array' : typeof v;
    assert.equal(actual, kind, `manifest.${key} expected ${kind}, got ${actual}`);
  }
  // files[] entries shape
  for (const f of snap.manifest.files) {
    for (const k of ['path', 'tier', 'lines', 'bytes', 'sha256', 'mtime']) {
      assert.ok(k in f, `file entry missing '${k}'`);
    }
  }
});

test('snapshot custom patternsDirs records counts in patterns_by_dir', async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'custom', 'set'), { recursive: true });
  await fs.writeFile(path.join(dir, 'custom', 'set', 'p1.md'), '1');
  await fs.writeFile(path.join(dir, 'custom', 'set', 'p2.md'), '2');
  const snap = await snapshot({
    memoryRoot: dir,
    date: '2026-05-09',
    tierFiles: { hot: [], warm: [] },
    patternsDirs: ['custom/set'],
  });
  // Named active/reference counters stay zero on custom dirs
  assert.equal(snap.manifest.totals.patterns_active_count, 0);
  assert.equal(snap.manifest.totals.patterns_reference_count, 0);
  // patterns_by_dir captures the actual count
  assert.equal(snap.manifest.totals.patterns_by_dir['custom/set'], 2);
});

test('acquireLock writes an owner_nonce into the lock JSON', async () => {
  const dir = await tmpDir();
  const lock = await acquireLock(dir);
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, '.dream.lock'), 'utf8'));
  assert.ok(onDisk.owner_nonce, 'lock should carry an owner_nonce');
  assert.equal(onDisk.owner_nonce, lock.meta.owner_nonce);
  await lock.release();
});

test('lock.update rejects when called after release', async () => {
  const dir = await tmpDir();
  const lock = await acquireLock(dir);
  await lock.release();
  await assert.rejects(() => lock.update('phase-x'), /already released/);
});

test('lock.update rejects when on-disk owner_nonce changes (ownership check)', async () => {
  const dir = await tmpDir();
  const lock = await acquireLock(dir);
  // Simulate a successor lock by clobbering the on-disk nonce.
  const lp = path.join(dir, '.dream.lock');
  const meta = JSON.parse(await fs.readFile(lp, 'utf8'));
  meta.owner_nonce = 'someone-else';
  await fs.writeFile(lp, JSON.stringify(meta));
  await assert.rejects(() => lock.update('phase-x'), /ownership check failed/);
});

test('lock.release refuses to delete a successor lock (ownership check)', async () => {
  const dir = await tmpDir();
  const lock = await acquireLock(dir);
  const lp = path.join(dir, '.dream.lock');
  const meta = JSON.parse(await fs.readFile(lp, 'utf8'));
  meta.owner_nonce = 'someone-else';
  await fs.writeFile(lp, JSON.stringify(meta));
  await lock.release(); // should NOT throw, but also should NOT unlink
  // The successor's lock is still on disk
  const after = JSON.parse(await fs.readFile(lp, 'utf8'));
  assert.equal(after.owner_nonce, 'someone-else');
});

test('acquireLock takes over a stale foreign-host lock (cross-host expired branch)', async () => {
  const dir = await tmpDir();
  const oldStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await fs.writeFile(path.join(dir, '.dream.lock'), JSON.stringify({
    pid: 1,
    hostname: 'some-other-host',
    started_at: oldStart, // older than maxRuntimeMs
  }));
  const lock = await acquireLock(dir, { maxRuntimeMs: 10 * 60 * 1000 });
  assert.equal(lock.meta.hostname, os.hostname());
  await lock.release();
});

test('gitTagPreDream is idempotent on annotated tag at HEAD (peels via ^{commit})', async () => {
  const dir = await tmpDir();
  await gitInit(dir);
  // Annotated tag — git rev-parse <tag> returns tag-object SHA, not commit SHA.
  await exec('git', ['-C', dir, 'tag', '-a', '-m', 'annotated', 'dream/pre/2026-05-09']);
  const r = await gitTagPreDream({ repoRoot: dir, date: '2026-05-09' });
  assert.equal(r.alreadyExisted, true, 'annotated tag at HEAD must be detected as idempotent');
});

test('gitTagPreDream throws GitTagExistsError on annotated tag at non-HEAD (peel error path)', async () => {
  const dir = await tmpDir();
  await gitInit(dir);
  // Annotated tag at the first commit, then move HEAD forward.
  await exec('git', ['-C', dir, 'tag', '-a', '-m', 'old', 'dream/pre/2026-05-09']);
  await fs.writeFile(path.join(dir, 'b.txt'), 'b');
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'b']);
  await assert.rejects(
    () => gitTagPreDream({ repoRoot: dir, date: '2026-05-09' }),
    GitTagExistsError,
  );
});

test('gitTagPreDream surfaces non-commit tag (tag of tree) as GitTagExistsError, not exit-4', async () => {
  const dir = await tmpDir();
  await gitInit(dir);
  // Tag a tree object — pathological but legal in git.
  const treeSha = (await exec('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'])).stdout.trim();
  await exec('git', ['-C', dir, 'tag', 'dream/pre/2026-05-09', treeSha]);
  await assert.rejects(
    () => gitTagPreDream({ repoRoot: dir, date: '2026-05-09' }),
    (e) => e instanceof GitTagExistsError && e.sha === '<non-commit>',
  );
});

test('acquireLock takes over a stale recovery lock (mtime expired)', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, '.dream.lock'), JSON.stringify({
    pid: 9_999_999,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  }));
  // Plant a recovery lock with an ancient mtime so it appears crashed.
  const rp = path.join(dir, '.dream-recovery.lock');
  await fs.writeFile(rp, JSON.stringify({
    schema_version: '1.0.0',
    owner_nonce: 'planted-stale-mtime',
    pid: process.pid,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  }));
  const ancient = new Date(Date.now() - 60 * 60 * 1000); // 1 h old
  await fs.utimes(rp, ancient, ancient);

  const lock = await acquireLock(dir, { maxRuntimeMs: 10 * 60 * 1000 });
  assert.equal(lock.meta.pid, process.pid);
  await lock.release();
});

test('acquireLock takes over a recovery lock whose holder pid is dead', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, '.dream.lock'), JSON.stringify({
    pid: 9_999_999,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  }));
  // Recovery lock claims a dead pid on THIS host; mtime is fresh.
  await fs.writeFile(
    path.join(dir, '.dream-recovery.lock'),
    JSON.stringify({
      schema_version: '1.0.0',
      owner_nonce: 'planted-dead-pid',
      pid: 9_999_998,
      hostname: os.hostname(),
      started_at: new Date().toISOString(),
    }),
  );
  const lock = await acquireLock(dir);
  await lock.release();
});

test('acquireLock throws LockHeldError when MAX_LOCK_ATTEMPTS exhausted', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, '.dream.lock'), JSON.stringify({
    pid: 9_999_999,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  }));
  // Fresh, fully-live recovery lock owned by THIS process — pid alive, fresh mtime.
  await fs.writeFile(
    path.join(dir, '.dream-recovery.lock'),
    JSON.stringify({
      schema_version: '1.0.0',
      owner_nonce: 'live-recovery-holder',
      pid: process.pid,
      hostname: os.hostname(),
      started_at: new Date().toISOString(),
    }),
  );
  await assert.rejects(() => acquireLock(dir), LockHeldError);
});

test('lock.update throws when a recovery (takeover) is in progress', async () => {
  const dir = await tmpDir();
  const lock = await acquireLock(dir);
  // Simulate a successor holding the recovery mutex (live pid, fresh mtime).
  await fs.writeFile(
    path.join(dir, '.dream-recovery.lock'),
    JSON.stringify({
      schema_version: '1.0.0',
      owner_nonce: 'successor-recovery-holder',
      pid: process.pid,
      hostname: os.hostname(),
      started_at: new Date().toISOString(),
    }),
  );
  await assert.rejects(() => lock.update('phase-x'), /takeover in progress/);
  await fs.unlink(path.join(dir, '.dream-recovery.lock')).catch(() => {});
  await lock.release();
});

test('releaseRecoveryLock refuses to delete a successor recovery lock (ownership)', async () => {
  // Drive the recovery lock through acquireLock's stale-takeover path: plant a
  // stale main lock with a stale recovery lock; acquireLock takes over both.
  // After acquireLock returns, plant a successor recovery lock owned by a
  // different nonce. Calling lock.update would attempt a recovery-take; if the
  // ownership check is broken, it would unlink the successor's lock; if it
  // works, lock.update throws "takeover in progress" and the successor lock
  // is preserved.
  const dir = await tmpDir();
  const lock = await acquireLock(dir);
  const successor = JSON.stringify({
    schema_version: '1.0.0',
    owner_nonce: 'someone-else-nonce',
    pid: process.pid,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  });
  await fs.writeFile(path.join(dir, '.dream-recovery.lock'), successor);
  await assert.rejects(() => lock.update('phase-x'), /takeover in progress/);
  // Successor's recovery lock survives untouched.
  const after = await fs.readFile(path.join(dir, '.dream-recovery.lock'), 'utf8');
  assert.equal(JSON.parse(after).owner_nonce, 'someone-else-nonce');
  await fs.unlink(path.join(dir, '.dream-recovery.lock')).catch(() => {});
  await lock.release();
});

test('shouldRunAsCli is realpath-only: true for same file (incl symlink), false otherwise', async () => {
  // The R4 simplification removed the basename-suffix fallback so an unrelated
  // importer whose argv[1] happens to be named `dream.js` cannot trigger
  // main(). The only true signal is "realpath of module == realpath of argv[1]".
  const { shouldRunAsCli } = await import('../bin/dream.js');
  const dir = await tmpDir();
  const real = path.join(dir, 'real.js');
  await fs.writeFile(real, '');
  const link = path.join(dir, 'link.js');
  await fs.symlink(real, link);
  // Same physical file (direct + via symlink) → true
  assert.equal(shouldRunAsCli(real, real), true);
  assert.equal(shouldRunAsCli(real, link), true);
  assert.equal(shouldRunAsCli(link, real), true);
  // Different files → false
  const other = path.join(dir, 'other.js');
  await fs.writeFile(other, '');
  assert.equal(shouldRunAsCli(real, other), false);
  // Non-existent paths (realpath throws) → false
  assert.equal(shouldRunAsCli(real, path.join(dir, 'does-not-exist.js')), false);
  // Empty / null argv → false
  assert.equal(shouldRunAsCli(real, ''), false);
  assert.equal(shouldRunAsCli(real, null), false);
});

test('isInvokedAs returns true through a symlink to the module', async () => {
  const dir = await tmpDir();
  const real = path.join(dir, 'real.js');
  await fs.writeFile(real, 'export {}\n');
  const link = path.join(dir, 'link.js');
  await fs.symlink(real, link);
  // Same realpath both ways.
  assert.equal(isInvokedAs(real, link), true);
  assert.equal(isInvokedAs(link, real), true);
  assert.equal(isInvokedAs(real, real), true);
});

test('isInvokedAs returns false on unrelated paths', async () => {
  const dir = await tmpDir();
  const a = path.join(dir, 'a.js');
  const b = path.join(dir, 'b.js');
  await fs.writeFile(a, '');
  await fs.writeFile(b, '');
  assert.equal(isInvokedAs(a, b), false);
});

test('isInvokedAs returns false when either path is missing', async () => {
  const dir = await tmpDir();
  const a = path.join(dir, 'a.js');
  await fs.writeFile(a, '');
  assert.equal(isInvokedAs(a, path.join(dir, 'does-not-exist.js')), false);
  assert.equal(isInvokedAs('', a), false);
  assert.equal(isInvokedAs(a, ''), false);
});
