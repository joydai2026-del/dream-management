// Collapses next-session-prompt-*.md files into a single overwriting next-session.md
// and archives older prompts. After rotation the agent root has exactly one
// next-session.md (the latest), and archive/next-session-prompts/ holds every
// prompt file that ever existed (originals retained per archive-never-delete).
//
// "Latest" is selected by the YYYY-MM-DD date suffix in the filename. Ties break
// on mtime so a same-day rerun picks the most recent edit. Files with no
// parseable date fall back to mtime entirely — they still get rotated.
//
// Sources scanned:
//   - <memoryRoot>/next-session-prompt-*.md         (current convention)
//   - <memoryRoot>/next-session-prompts/*.md         (legacy folder, if present)
//
// Both feed the same rotation. The legacy folder isn't deleted afterward — it's
// just emptied of prompt files; an old empty directory is harmless.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite, atomicMove } from './atomic-write.js';

// No-overwrite move: tries fs.link (hardlink at the target, fails on EEXIST)
// then unlinks the source. Falls back to copy+wx-open+unlink for cross-fs
// cases. This closes the TOCTOU between the existence-check and rename in
// the older atomicMove path: a target that materializes between check and
// move now causes an EEXIST that triggers a fresh name selection.
async function safeArchiveMove(from, to) {
  try {
    await fs.link(from, to);
    try {
      await fs.unlink(from);
    } catch (unlinkErr) {
      // Round 3 nit: another process may have already removed the source
      // between link and unlink. The archive destination is in place — that's
      // the conservation guarantee — so treat ENOENT as a success.
      if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
    }
    return;
  } catch (e) {
    if (e.code === 'EEXIST') throw e;
    if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'ENOTSUP') {
      throw e;
    }
  }
  // Cross-fs or fs without hardlink support: copy via wx-open then unlink.
  // If the copy itself fails after the destination was created, unlink the
  // partial archive so the candidate name doesn't poison the directory.
  const data = await fs.readFile(from);
  let copyFailed = false;
  const fh = await fs.open(to, 'wx', 0o600);
  try {
    try {
      await fh.writeFile(data);
      await fh.sync();
    } catch (writeErr) {
      copyFailed = true;
      throw writeErr;
    }
  } finally {
    await fh.close().catch(() => {});
    if (copyFailed) await fs.unlink(to).catch(() => {});
  }
  await fs.unlink(from);
}

const PROMPT_RE = /^next-session-prompt-(\d{4}-\d{2}-\d{2})(?:[-.].*)?\.md$/;

async function listPromptFiles(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    const m = name.match(PROMPT_RE);
    if (!m) continue;
    const fullPath = path.join(dir, name);
    let mtimeMs = 0;
    try {
      const st = await fs.stat(fullPath);
      mtimeMs = st.mtimeMs;
    } catch {
      // file disappeared mid-scan; skip
      continue;
    }
    out.push({ name, path: fullPath, dateKey: m[1], mtimeMs });
  }
  return out;
}

// Pick a candidate archive name. Round 2 review: pure check-then-move is TOCTOU
// against concurrent rotations or intermediate creates, so we pair this with
// safeArchiveMove (no-overwrite) and a retry loop that re-picks on EEXIST.
async function pickArchiveCandidate(archiveDir, name, startingN = 1) {
  const fullPath = path.join(archiveDir, name);
  try {
    await fs.access(fullPath);
  } catch {
    return { dest: fullPath, n: 0 };
  }
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = startingN; n < 1000; n++) {
    const candidate = path.join(archiveDir, `${stem}.dup${n}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return { dest: candidate, n };
    }
  }
  return {
    dest: path.join(archiveDir, `${stem}.dup-${Date.now()}${ext}`),
    n: -1,
  };
}

// Move with archive-never-delete guarantee: keep retrying with fresh candidate
// names if an EEXIST appears between our access-check and our move. Caps at 50
// retries so a malicious / pathologically-busy archive directory still
// terminates with a timestamped fallback.
async function archiveMoveWithCollisionRetry(from, archiveDir, name) {
  let startingN = 1;
  for (let attempt = 0; attempt < 50; attempt++) {
    const { dest, n } = await pickArchiveCandidate(archiveDir, name, startingN);
    try {
      await safeArchiveMove(from, dest);
      return dest;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Some other writer claimed our candidate between check + move. Re-pick.
      startingN = (n > 0 ? n + 1 : 1);
    }
  }
  // Last-resort: timestamped destination, expected to be unique.
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const fallback = path.join(archiveDir, `${stem}.dup-${Date.now()}${ext}`);
  await safeArchiveMove(from, fallback);
  return fallback;
}

function pickLatest(files) {
  if (files.length === 0) return null;
  return [...files].sort((a, b) => {
    if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? 1 : -1;
    return b.mtimeMs - a.mtimeMs;
  })[0];
}

export async function rotateNextSessionPrompts(opts) {
  const {
    memoryRoot,
    archiveSubdir = path.join('archive', 'next-session-prompts'),
    targetName = 'next-session.md',
    dryRun = false,
  } = opts;

  if (!memoryRoot) {
    throw new Error('rotateNextSessionPrompts: memoryRoot required');
  }

  const legacyDir = path.join(memoryRoot, 'next-session-prompts');
  const targetPath = path.join(memoryRoot, targetName);
  const archiveDir = path.join(memoryRoot, archiveSubdir);

  const rootFiles = await listPromptFiles(memoryRoot);
  const legacyFiles = await listPromptFiles(legacyDir);
  const allFiles = [...rootFiles, ...legacyFiles];

  if (allFiles.length === 0) {
    return { rotated: 0, archived: 0, latest: null, target: targetPath };
  }

  const latest = pickLatest(allFiles);
  const toArchive = allFiles.filter(f => f.path !== latest.path);

  if (dryRun) {
    return {
      dryRun: true,
      rotated: 1,
      archived: toArchive.length,
      latest: latest.path,
      target: targetPath,
    };
  }

  // Leaf-first sweep: archive originals before mutating the canonical target.
  // A crash between archiveMove and the canonical write leaves an extra archive
  // copy (recoverable). A crash after the canonical write but before the source
  // archive-move leaves the source file present; the next rotation re-runs and
  // finishes the job idempotently.
  await fs.mkdir(archiveDir, { recursive: true });

  for (const f of toArchive) {
    await archiveMoveWithCollisionRetry(f.path, archiveDir, f.name);
  }

  // Copy latest into next-session.md (overwriting any prior canonical), then
  // archive the original file so the agent root only ever has next-session.md.
  const latestContent = await fs.readFile(latest.path, 'utf8');
  await atomicWrite(targetPath, latestContent);

  let archivedSourceCount = 0;
  if (latest.path !== targetPath) {
    try {
      await archiveMoveWithCollisionRetry(latest.path, archiveDir, latest.name);
      archivedSourceCount = 1;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  return {
    rotated: 1,
    archived: toArchive.length + archivedSourceCount,
    latest: latest.path,
    target: targetPath,
  };
}
