// Atomic-write helpers per docs/atomicity-contract.md § 3.
//
// Three primitives:
//   atomicWrite(dest, contents, opts)  — write a file atomically via .tmp + rename
//   atomicAppend(dest, appendContents) — read-then-atomic-write under a per-dest lock
//   atomicMove(from, to)               — same-fs rename for move-style mutations
//
// Design:
//   - Tmp filenames are unique per-call (pid + counter), so two concurrent writers
//     never compete for the same .tmp inode. Eliminates the stat-then-open TOCTOU.
//   - The .tmp is opened with O_CREAT|O_EXCL ('wx'), refusing pre-existing files
//     and symlinks. Defends against symlink-truncate attacks on the tmp path.
//   - rename() is atomic on same-filesystem. A crash before rename leaves the dest
//     untouched. A crash after rename has already committed the new contents.
//   - atomicAppend wraps the read-modify-write in an exclusive per-dest lock file
//     (also acquired via 'wx'), so two concurrent appends to the same destination
//     don't both read the old contents and lose one's append. The contract is
//     "last writer wins on the lock, then their append is visible." Without the
//     lock, two appenders race and one's contribution disappears.
//
// P1 scope: this module is non-transactional across files. The dream worker (P4)
// builds the cross-file commit barrier on top by writing into archive/dreams/<date>/
// staged/ and sweeping renames at end of run, per atomicity-contract.md § 2.

import { promises as fs } from 'node:fs';
import path from 'node:path';

let _tmpCounter = 0;

function nextTmpPath(dest) {
  return `${dest}.${process.pid}.${++_tmpCounter}.tmp`;
}

export async function atomicWrite(dest, contents, opts = {}) {
  const { fsync = true } = opts;
  const parentDir = path.dirname(dest);

  try {
    await fs.access(parentDir);
  } catch {
    throw new Error(`atomicWrite: parent directory does not exist: ${parentDir}`);
  }

  const tmpPath = nextTmpPath(dest);

  let fh;
  try {
    fh = await fs.open(tmpPath, 'wx', 0o600);
    await fh.writeFile(contents);
    if (fsync) await fh.sync();
  } finally {
    if (fh) await fh.close().catch(() => {});
  }

  try {
    await fs.rename(tmpPath, dest);
  } catch (e) {
    await fs.unlink(tmpPath).catch(() => {});
    throw e;
  }
}

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_RETRIES = 200; // ~10s of spinning at 50ms

export async function atomicAppend(dest, appendContents) {
  const lockPath = `${dest}.lock`;
  let lockFh = null;

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      lockFh = await fs.open(lockPath, 'wx', 0o600);
      await lockFh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const stat = await fs.stat(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        // Lock disappeared between EEXIST and stat — retry immediately.
        continue;
      }
      await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY_MS));
    }
  }
  if (!lockFh) {
    throw new Error(`atomicAppend: could not acquire ${lockPath} after ${LOCK_MAX_RETRIES} attempts`);
  }

  try {
    let existing = '';
    try {
      existing = await fs.readFile(dest, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await atomicWrite(dest, existing + appendContents);
  } finally {
    await lockFh.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

export async function atomicMove(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') {
      // Cross-filesystem rename. Fall back to copy + unlink with fsync between.
      const data = await fs.readFile(from);
      const tmpPath = nextTmpPath(to);
      const fh = await fs.open(tmpPath, 'wx', 0o600);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close().catch(() => {});
      }
      await fs.rename(tmpPath, to);
      await fs.unlink(from);
      return;
    }
    throw e;
  }
}
