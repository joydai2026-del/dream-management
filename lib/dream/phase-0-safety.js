// Phase-0 safety: lock + git-tag + snapshot + manifest.
//
// Per docs/atomicity-contract.md § 4 (lock contract) and docs/archive-schema.md
// § 2 (per-night snapshot). The dream worker must establish three guarantees
// before any mutation:
//
//   1. EXCLUSIVE — no concurrent run is mutating the same memory_root.
//      Lock JSON carries an owner_nonce. lock.update / lock.release run their
//      read-modify-write under the `.dream-recovery.lock` takeover mutex AND
//      check the on-disk nonce inside that critical section, so a stale-but-
//      live worker cannot interleave with a successor's takeover. The mutex
//      itself self-recovers from crashes via mtime + pid liveness checks, so
//      a SIGKILL during recovery does not cause permanent denial.
//   2. RECOVERABLE — git tag dream/pre/<date> at HEAD pre-mutation, so
//      `git reset --hard dream/pre/<date>` is the rollback path. The tag
//      comparison peels via ^{commit} to handle annotated tags. Tags pointing
//      to non-commit objects (rare: tag of tree/blob) surface as
//      GitTagExistsError, mapping to CLI exit code 3 — not the generic 4.
//   3. ARCHIVED — pre-mutation snapshot of hot+warm tier copied verbatim into
//      archive/dreams/<date>/snapshot/, with manifest.json recording sha256
//      per file. fs.readdir results are sorted for deterministic manifest
//      diffing across runs. Undeclared symlinks are NOT followed: they're
//      added to manifest.skipped[] so the auditor can flag them.
//
// P4 starter scope: synchronous flow with no liveness timer (lock.update is
// caller-driven, not background). The 30s background liveness pulse lands when
// the launchd scheduler ships in P5.

import { promises as fs } from 'node:fs';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWrite, atomicMove } from '../atomic-write.js';

const exec = promisify(execFile);

const SCHEMA_VERSION = '1.0.0';
const DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1000; // SUCCESS-CRITERIA P4 #8
const LOCK_FILENAME = '.dream.lock';
const RECOVERY_LOCK_FILENAME = '.dream-recovery.lock';
const RECOVERY_BACKOFF_MS = 50;
const MAX_LOCK_ATTEMPTS = 3;
// A recovery-lock holder runs only mkdir + atomicMove (sub-millisecond on a
// healthy fs); 30 s is generous and forgives a paused process. Past this age,
// the holder is presumed crashed and the lock is taken over.
const RECOVERY_LOCK_MAX_AGE_MS = 30_000;

export class LockHeldError extends Error {
  constructor(meta) {
    const id = meta && meta.pid != null ? `pid ${meta.pid}` : 'unknown pid';
    const host = meta && meta.hostname ? ` on ${meta.hostname}` : '';
    const since = meta && meta.started_at ? ` since ${meta.started_at}` : '';
    super(`dream lock held by ${id}${host}${since}`);
    this.code = 'LOCK_HELD';
    this.meta = meta;
  }
}

export class GitTagExistsError extends Error {
  constructor(tag, sha) {
    super(`git tag ${tag} already exists pointing at ${sha}`);
    this.code = 'GIT_TAG_EXISTS';
    this.tag = tag;
    this.sha = sha;
  }
}

function lockPathOf(memoryRoot) {
  return path.join(memoryRoot, LOCK_FILENAME);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

async function readLockMeta(lp) {
  try {
    return JSON.parse(await fs.readFile(lp, 'utf8'));
  } catch {
    return null;
  }
}

function lockIsStale(meta, maxRuntimeMs) {
  if (!meta) return true;
  if (meta.hostname && meta.hostname !== os.hostname()) {
    if (!meta.started_at) return true;
    return Date.now() - Date.parse(meta.started_at) > maxRuntimeMs;
  }
  if (!pidAlive(meta.pid)) return true;
  if (meta.started_at && Date.now() - Date.parse(meta.started_at) > maxRuntimeMs) return true;
  return false;
}

// Recovery-lock content is JSON (mirrors main lock's discipline) so we can
// owner-nonce-check release and hostname-check staleness without re-parsing
// pid+timestamp from a freeform text file.
async function readRecoveryLockMeta(rp) {
  try {
    return JSON.parse(await fs.readFile(rp, 'utf8'));
  } catch {
    return null;
  }
}

async function recoveryLockIsStale(rp, observedMeta, maxAgeMs) {
  // Re-read the meta to defend against a content-swap between the EEXIST
  // observation and the staleness decision. If the file vanished, treat as
  // stale (the holder released between calls).
  let stat;
  try {
    stat = await fs.stat(rp);
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    throw e;
  }
  const meta = await readRecoveryLockMeta(rp);
  if (!meta) {
    // File present per stat() but unreadable / vanished mid-read. Best-effort:
    // wait a beat and check again — if still there with garbage, treat as
    // stale (a wedged holder); if gone, also stale.
    return true;
  }
  // If the on-disk file replaced what we observed, abort the takeover —
  // someone else recovered and a fresh holder owns the mutex now.
  if (observedMeta && meta.owner_nonce && meta.owner_nonce !== observedMeta.owner_nonce) {
    return false;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > maxAgeMs) return true;
  // Cross-host: cannot probe pid liveness. Defer to age only.
  if (meta.hostname && meta.hostname !== os.hostname()) return false;
  if (meta.pid != null && !pidAlive(meta.pid)) return true;
  return false;
}

async function tryRecoveryLock(memoryRoot, opts = {}) {
  const { maxAgeMs = RECOVERY_LOCK_MAX_AGE_MS } = opts;
  const rp = path.join(memoryRoot, RECOVERY_LOCK_FILENAME);
  const ownerNonce = crypto.randomUUID();
  const meta = {
    schema_version: SCHEMA_VERSION,
    owner_nonce: ownerNonce,
    pid: process.pid,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    // Two-step atomic create: write JSON to a uniquely-named tmp file, then
    // fs.link(tmp, rp) which atomically creates rp if-and-only-if rp does not
    // already exist. This closes the open(wx)→writeFile window where a peer
    // could see an empty/partial JSON file and treat it as stale.
    const tmp = `${rp}.tmp.${process.pid}.${ownerNonce}`;
    try {
      await atomicWrite(tmp, JSON.stringify(meta));
    } catch (e) {
      // tmp write failed; nothing committed yet.
      throw e;
    }
    try {
      await fs.link(tmp, rp);
      // Reality-checker final #1: unlink tmp after successful link. The
      // inode survives (rp is the second hardlink); the tmp pathname is
      // disposable. Without this, every lock.update across a multi-phase
      // run leaks ~300 orphan .tmp files/month into the live tree.
      await fs.unlink(tmp).catch(() => {});
      return { path: rp, ownerNonce };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        await fs.unlink(tmp).catch(() => {});
        throw e;
      }
      // rp exists. Decide: stale-and-take-over OR back-off.
      const observed = await readRecoveryLockMeta(rp);
      if (!(await recoveryLockIsStale(rp, observed, maxAgeMs))) {
        await fs.unlink(tmp).catch(() => {});
        return null;
      }
      // Best-effort takeover via atomicMove. NOTE: POSIX rename is keyed on
      // pathname, not inode, so this is NOT a true compare-and-archive. A
      // fresh successor created between our staleness read and the rename
      // would have ITS file moved into the sidecar. The recovery mutex is
      // therefore best-effort, not a hard exclusion guarantee. The safety
      // net is the post-archive re-evaluation in acquireLock (re-reads
      // reMeta and only archives the main lock if it still looks stale
      // and matches the observed nonce). For P4 starter on a single-host
      // nightly cadence the residual race window is microseconds; full
      // elimination needs fcntl/renameat2 (deferred to P5).
      const sidecar = `${rp}.stale.${Date.now()}.${process.pid}.${crypto.randomUUID()}`;
      try {
        await atomicMove(rp, sidecar);
        await fs.unlink(sidecar).catch(() => {});
      } catch (mvErr) {
        if (mvErr.code !== 'ENOENT') {
          await fs.unlink(tmp).catch(() => {});
          throw mvErr;
        }
      }
      // Reuse our pre-written tmp on the retry.
      try {
        await fs.link(tmp, rp);
        // Same cleanup as the happy path — tmp is disposable post-link.
        await fs.unlink(tmp).catch(() => {});
        return { path: rp, ownerNonce };
      } catch (e2) {
        if (e2.code !== 'EEXIST') {
          await fs.unlink(tmp).catch(() => {});
          throw e2;
        }
        // Lost a race to another recovery thread; back off cleanly.
        await fs.unlink(tmp).catch(() => {});
        continue;
      }
    }
  }
  return null;
}

async function releaseRecoveryLock(handle) {
  if (!handle) return;
  // Ownership-checked release: refuse to unlink if the on-disk recovery lock
  // belongs to a successor (e.g., we were paused past staleness, taken over,
  // and are now resuming). The check is best-effort: a sub-microsecond TOCTOU
  // window between read and unlink can let us unlink a fresh successor's lock
  // if a takeover lands in that window. POSIX has no atomic compare-and-unlink
  // on pathnames; full elimination needs fcntl-level locks (deferred to P5).
  const onDisk = await readRecoveryLockMeta(handle.path);
  if (onDisk && onDisk.owner_nonce !== handle.ownerNonce) return;
  await fs.unlink(handle.path).catch(() => {});
}

async function archiveStaleLock(memoryRoot, lp, ts, startedAt) {
  const staleDir = path.join(
    memoryRoot, 'archive', 'dreams', isoDate(startedAt), 'stale-locks',
  );
  await fs.mkdir(staleDir, { recursive: true });
  try {
    await atomicMove(lp, path.join(staleDir, `${LOCK_FILENAME}.${ts}`));
  } catch (err) {
    // ENOENT means a peer (also under recovery? unlikely) cleared it first.
    if (err.code !== 'ENOENT') throw err;
  }
}

export async function acquireLock(memoryRoot, opts = {}) {
  const {
    phase = 'phase-0-safety',
    gitTag = null,
    maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
  } = opts;

  const lp = lockPathOf(memoryRoot);
  const ownerNonce = crypto.randomUUID();

  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    const startedAt = new Date();
    const expectedAt = new Date(startedAt.getTime() + maxRuntimeMs);
    let fh;
    try {
      fh = await fs.open(lp, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      const observed = await readLockMeta(lp);
      if (!lockIsStale(observed, maxRuntimeMs)) {
        throw new LockHeldError(observed);
      }

      // Serialize stale recovery via dedicated mutex so two racers can't
      // both archive the same file (and the second steal a fresh successor).
      const recoveryHandle = await tryRecoveryLock(memoryRoot);
      if (!recoveryHandle) {
        // Another process is recovering. Brief backoff and retry main lock.
        await new Promise(r => setTimeout(r, RECOVERY_BACKOFF_MS));
        continue;
      }
      try {
        const reMeta = await readLockMeta(lp);
        if (!reMeta) {
          // Already cleared by someone else; loop will retry open().
        } else if (!lockIsStale(reMeta, maxRuntimeMs)) {
          // Fresh lock now — next iteration will throw LockHeldError.
        } else if (
          reMeta.owner_nonce && observed && reMeta.owner_nonce !== observed.owner_nonce
        ) {
          // Different stale lock now (rapid succession). Loop and re-evaluate.
        } else {
          const ts = startedAt.toISOString().replace(/[:.]/g, '-');
          await archiveStaleLock(memoryRoot, lp, ts, startedAt);
        }
      } finally {
        await releaseRecoveryLock(recoveryHandle);
      }
      continue;
    }

    const meta = {
      schema_version: SCHEMA_VERSION,
      owner_nonce: ownerNonce,
      pid: process.pid,
      hostname: os.hostname(),
      started_at: startedAt.toISOString(),
      expected_completion_at: expectedAt.toISOString(),
      phase,
      git_tag: gitTag,
    };
    try {
      await fh.writeFile(JSON.stringify(meta, null, 2));
    } finally {
      await fh.close().catch(() => {});
    }
    return makeLockHandle(lp, meta, memoryRoot);
  }

  // Attempts exhausted. Must be a live winner — surface as LockHeldError so
  // the CLI can map to its documented exit code (2), not the generic 4.
  const final = await readLockMeta(lp);
  throw new LockHeldError(final);
}

function makeLockHandle(lp, meta, memoryRoot) {
  let released = false;

  async function ownsLock() {
    const onDisk = await readLockMeta(lp);
    return Boolean(onDisk) && onDisk.owner_nonce === meta.owner_nonce;
  }

  // Run a read-modify-write under the takeover mutex so a successor cannot
  // archive our lock between the ownership check and the mutation. This
  // closes the TOCTOU that the bare ownsLock() check could not.
  async function withOwnership(action, errorOnTakeover) {
    const recoveryHandle = await tryRecoveryLock(memoryRoot);
    if (!recoveryHandle) {
      throw new Error(errorOnTakeover);
    }
    try {
      if (!(await ownsLock())) {
        throw new Error('lock: ownership check failed (lock no longer ours)');
      }
      await action();
    } finally {
      await releaseRecoveryLock(recoveryHandle);
    }
  }

  return {
    path: lp,
    meta,
    async update(newPhase) {
      if (released) throw new Error('lock.update: already released');
      await withOwnership(async () => {
        meta.phase = newPhase;
        meta.updated_at = new Date().toISOString();
        await atomicWrite(lp, JSON.stringify(meta, null, 2));
      }, 'lock.update: takeover in progress, cannot update');
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await withOwnership(async () => {
          await fs.unlink(lp).catch(() => {});
        }, 'lock.release: takeover in progress');
      } catch {
        // Release is best-effort: a takeover in progress means a successor is
        // already archiving our lock; silently yield rather than throw from
        // the cleanup path.
      }
    },
  };
}

export async function detectRepoRoot(startDir) {
  try {
    const r = await exec(
      'git',
      ['-C', startDir, 'rev-parse', '--show-toplevel'],
      { env: GIT_C_LOCALE_ENV },
    );
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

// Force a C/POSIX locale for git so error-message regex matching (e.g., the
// peel narrow catch in gitTagPreDream) is locale-independent. JJ's stack is
// bilingual; without this, a zh_CN.UTF-8 invocation would emit localized
// error strings and the regex would miss.
const GIT_C_LOCALE_ENV = {
  ...process.env,
  LC_ALL: 'C',
  LANG: 'C',
};

async function gitTagExists(repoRoot, tag) {
  const r = await exec('git', ['-C', repoRoot, 'tag', '-l', tag], { env: GIT_C_LOCALE_ENV });
  return r.stdout.trim() === tag;
}

async function gitRevParse(repoRoot, ref) {
  const r = await exec('git', ['-C', repoRoot, 'rev-parse', ref], { env: GIT_C_LOCALE_ENV });
  return r.stdout.trim();
}

export async function gitTagPreDream({ repoRoot, date, dryRun = false }) {
  if (!repoRoot) throw new Error('gitTagPreDream: repoRoot required');
  if (!date) throw new Error('gitTagPreDream: date required');
  const tag = `dream/pre/${date}`;
  const headSha = await gitRevParse(repoRoot, 'HEAD');

  const exists = await gitTagExists(repoRoot, tag);
  if (exists) {
    // Peel via ^{commit} so annotated tags compare to commit SHA, not the
    // tag-object SHA. If the tag points at a non-commit object (tree/blob —
    // rare), the peel rejects; surface as a conflict (CLI exit 3) rather than
    // letting it fall through to the generic catch (exit 4). Other errors
    // (corrupted .git, EIO, permission flips) propagate so the CLI maps them
    // to the generic exit 4 with a stack trace, not a misleading conflict.
    let tagCommitSha;
    try {
      tagCommitSha = await gitRevParse(repoRoot, `${tag}^{commit}`);
    } catch (e) {
      const msg = `${e.stderr || ''}${e.message || ''}`;
      if (
        /not a valid object name/i.test(msg)
        || /not a commit object/i.test(msg)
        || /unknown revision/i.test(msg)
      ) {
        throw new GitTagExistsError(tag, '<non-commit>');
      }
      throw e;
    }
    if (tagCommitSha === headSha) {
      return { tag, headSha, alreadyExisted: true, dryRun };
    }
    throw new GitTagExistsError(tag, tagCommitSha);
  }
  if (!dryRun) {
    await exec('git', ['-C', repoRoot, 'tag', tag], { env: GIT_C_LOCALE_ENV });
  }
  return { tag, headSha, alreadyExisted: false, dryRun };
}

const DEFAULT_HOT_FILES = [
  'working-memory.md', 'identity.md', 'pre-action.md',
];
const DEFAULT_WARM_FILES = [
  'corrections.md', 'session-index.md', 'memory-index.md', 'pattern-firing-log.md',
];
const DEFAULT_PATTERN_DIRS = ['patterns/active', 'patterns/reference'];

export async function snapshot(opts) {
  const {
    memoryRoot,
    date,
    archiveRoot = null,
    consumerName = 'unnamed-consumer',
    gitTag = null,
    gitHeadBefore = null,
    tierFiles = { hot: DEFAULT_HOT_FILES, warm: DEFAULT_WARM_FILES },
    patternsDirs = DEFAULT_PATTERN_DIRS,
    symlinks = [],
    skipped = [],
  } = opts;

  if (!memoryRoot) throw new Error('snapshot: memoryRoot required');
  if (!date) throw new Error('snapshot: date required');

  const aroot = archiveRoot || path.join(memoryRoot, 'archive');
  const dreamDir = path.join(aroot, 'dreams', date);
  const snapshotDir = path.join(dreamDir, 'snapshot');
  await fs.mkdir(snapshotDir, { recursive: true });

  const fileEntries = [];
  const skippedEntries = [...skipped];
  const totals = {
    hot_tier_lines: 0,
    warm_tier_lines: 0,
    patterns_active_count: 0,
    patterns_reference_count: 0,
    patterns_by_dir: {},
  };

  // Plain tier files
  for (const tier of Object.keys(tierFiles)) {
    for (const rel of tierFiles[tier]) {
      const result = await snapshotOne(memoryRoot, snapshotDir, rel, tier);
      if (!result) continue;
      if (result.skipped) {
        skippedEntries.push({ path: rel, reason: result.reason });
        continue;
      }
      fileEntries.push(result.entry);
      if (tier === 'hot') totals.hot_tier_lines += result.entry.lines;
      if (tier === 'warm') totals.warm_tier_lines += result.entry.lines;
    }
  }

  // Pattern subdirectories
  for (const subdir of patternsDirs) {
    totals.patterns_by_dir[subdir] = 0;
    const abs = path.join(memoryRoot, subdir);
    let names;
    try {
      names = (await fs.readdir(abs)).sort();
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const rel = path.join(subdir, name);
      const result = await snapshotOne(memoryRoot, snapshotDir, rel, 'patterns');
      if (!result) continue;
      if (result.skipped) {
        skippedEntries.push({ path: rel, reason: result.reason });
        continue;
      }
      fileEntries.push(result.entry);
      totals.patterns_by_dir[subdir] += 1;
      if (subdir === 'patterns/active') totals.patterns_active_count += 1;
      if (subdir === 'patterns/reference') totals.patterns_reference_count += 1;
    }
  }

  // Stable file order across runs
  fileEntries.sort((a, b) => a.path.localeCompare(b.path));

  // Record (do not copy) declared symlinks. Snapshotter does NOT follow
  // undeclared symlinks; those land in skippedEntries above.
  for (const link of symlinks) {
    const linkPath = path.join(snapshotDir, link.path);
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    try {
      await fs.symlink(link.target, linkPath);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }

  const manifest = {
    schema_version: SCHEMA_VERSION,
    consumer_name: consumerName,
    snapshot_at: new Date().toISOString(),
    git_tag: gitTag,
    git_head_before: gitHeadBefore,
    memory_root: memoryRoot,
    files: fileEntries,
    symlinks,
    skipped: skippedEntries,
    totals,
  };
  await atomicWrite(
    path.join(dreamDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  return { dreamDir, snapshotDir, manifest };
}

async function snapshotOne(memoryRoot, snapshotDir, rel, tier) {
  const src = path.join(memoryRoot, rel);
  let lstat;
  try {
    lstat = await fs.lstat(src);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (lstat.isSymbolicLink()) {
    return { skipped: true, reason: 'undeclared symlink (use opts.symlinks to declare)' };
  }
  if (!lstat.isFile()) return null;
  const content = await fs.readFile(src);
  const dst = path.join(snapshotDir, rel);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await atomicWrite(dst, content);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const lines = content.toString('utf8').split('\n').length;
  return {
    entry: {
      path: rel,
      tier,
      lines,
      bytes: lstat.size,
      sha256,
      mtime: lstat.mtime.toISOString(),
    },
  };
}

// Test/CLI helper: realpath both ends so npm-symlinked bin/dream is detectable.
export function isInvokedAs(modulePath, argvPath) {
  if (!modulePath || !argvPath) return false;
  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    return false;
  }
}
