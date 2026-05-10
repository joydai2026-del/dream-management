// Stage A — DETERMINISTIC INVARIANT AUDITOR.
//
// Per atomicity-contract.md § 5 + archive-schema.md § 4 + ARCHITECTURE.md § 3.3.
// Runs after Phases 1-5 stage their plans into `archive/dreams/<date>/staged/`
// and BEFORE the sweep step renames anything onto live. No LLM. Pure
// deterministic checks; output drives `event.json.audit.stage_a` and gates
// the Stage B run + the final sweep.
//
// Verdict semantics (per atomicity-contract.md § 5.1-5.2):
//   PASS  — all hard invariants hold; safe to commit
//   WARN  — non-fatal findings; sweep proceeds, mitigation logged in event.json
//   FAIL  — at least one hard invariant violated; abort run, preserve staged/
//           tree for inspection, surface in dream-log
//
// Read-only. The auditor MUST NOT mutate the staged tree, the snapshot, or
// the live tree. Side effects: none. The worker passes the result up to the
// CLI which writes the verdict into event.json before deciding sweep.
//
// Checks (severity in [fail, warn]):
//   C1  manifest_match           fail  — manifest.files[] ⇔ snapshot/ files (sha256 + path)
//   C2  conservation             fail  — kept_lines + archived_lines = pre_lines (warm files)
//   C3  frontmatter_valid        fail  — every staged .md.tmp parses cleanly
//   C4  anchor_links_resolve     warn  — links in pre-action.md / memory-index.md target a real file
//   C5  archive_block_present    fail  — archived H3 entries appear in their target archive .tmp
//   C6  firing_log_freshness     warn  — pattern-firing-log.md modified in last 36h OR has today entry
//   C7  no_relative_dates        fail  — staged hot-tier files contain no relative-date phrases
//   C8  source_citation_resolves fail  — event.json insight citations point at real files
//   C9  dream_log_event_agree    fail  — dream-log-entry.md ⇔ event.json on bottom-line counts
//   C10 append_only_intact       fail  — pattern-firing-log.md / decisions/* not staged for rewrite
//
// Failure modes that surface as findings (not exceptions):
//   - missing dream dir / snapshot / event.json
//   - malformed manifest / event.json
//   - corrupted frontmatter
//   - cross-tier teleportation (caught structurally by C5 "block-present in
//     EXACTLY ONE archive target")
//
// Anything that throws (e.g., disk read error, corrupt JSON) is captured as a
// `internal_error` finding and ALSO marks the verdict FAIL — never silently
// pass on infrastructure breakage.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findRelativeDates } from './phase-4-dates-contradictions.js';

const SCHEMA_VERSION = '1.0.0';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Strict semver (no prereleases) — F-J: split('.')[0] accepts "1", "1.x",
// "1.0.0-pre", which lets an incompatible manifest sneak past major-major
// equality. We require strict X.Y.Z and compare on X.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

// Hot-tier files we sweep relative-date phrases out of (Phase 4 scope).
// C7 enforces post-stage: these files in the staged tree must contain none.
const HOT_TIER_DATE_FILES = ['working-memory.md', 'corrections.md', 'session-index.md'];

// Files that are append-only per archive-schema § 4.4. The worker MUST NOT
// stage them for rewrite OR for delete. C10 enforces.
const APPEND_ONLY_PATHS = new Set(['pattern-firing-log.md']);
const APPEND_ONLY_PREFIXES = ['decisions/'];

// Delete-forbidden prefixes: tombstones targeting these paths violate
// the archive-immutability contract (per archive-schema § 4.4). Rewrites
// (.tmp) are still OK — they're how Phase 3 appends to month-archives.
// C10 enforces these in addition to APPEND_ONLY_PREFIXES.
const DELETE_FORBIDDEN_PREFIXES = ['archive/'];

const FIRING_LOG_FRESHNESS_HOURS = 36;

// Citation form: `<path>#L<line>`. The line number is mandatory. C8 (F-H)
// requires the terminal `#L<digits>`; anything else is malformed. The path
// is captured greedily so a file named `notes#hash.md` is permitted before
// the terminal `#L`.
const CITATION_RE = /^(.+?)#L(\d+)$/;

// ---- finding helpers --------------------------------------------------

function makeFinding(check, severity, message, extras = {}) {
  return { check, severity, message, ...extras };
}

function posix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function readIfExists(abs) {
  try { return await fs.readFile(abs, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function readBufIfExists(abs) {
  try { return await fs.readFile(abs); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function fileExists(abs) {
  try { await fs.access(abs); return true; } catch { return false; }
}

async function walkRel(rootAbs, opts = {}) {
  // Recursive walk; returns POSIX-form paths relative to rootAbs.
  // Symlinks are NOT followed — they're collected in `out.symlinks` so the
  // caller (C1, C10) can decide policy. F-L: prior code used `entry.isFile()`
  // which returns false for symlinks, so a symlink under snapshot/ silently
  // disappeared from manifest verification.
  const out = [];
  const symlinks = [];
  async function recurse(dir, prefix) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { symlinks.push(rel); continue; }
      if (entry.isDirectory()) await recurse(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await recurse(rootAbs, '');
  out.sort();
  if (opts.withSymlinks) return { files: out, symlinks: symlinks.sort() };
  return out;
}

// F-I: reject path traversal. A relative path that escapes memoryRoot via
// `..`, leading `/`, drive letters, or backslashes is structurally bad: the
// auditor must not silently accept `../../etc/passwd` because the file
// happens to exist. Returns { ok, normalized, reason }.
function safeRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') {
    return { ok: false, reason: 'empty path' };
  }
  // Reject backslashes (Windows-style on a POSIX worker is the auditor's lane,
  // but mid-path backslash is suspicious — workers normalize via posix() at
  // emit time). Reject absolute paths (POSIX leading / or Windows drive).
  if (/^[a-zA-Z]:[\\/]/.test(rel)) return { ok: false, reason: 'absolute Windows path' };
  if (rel.startsWith('/')) return { ok: false, reason: 'absolute POSIX path' };
  const normalized = posix(rel);
  // path.posix.normalize collapses '..' segments; if any remain at the start
  // OR a segment equals '..', reject.
  const segs = normalized.split('/').filter(Boolean);
  if (segs.some(s => s === '..')) return { ok: false, reason: 'path contains ..' };
  return { ok: true, normalized };
}

// Strip frontmatter; returns { ok: true, frontmatter, body } | { ok: false, reason }.
// We don't depend on a full YAML parser — same shallow shape as phase-3-prune
// + load-patterns: scan key:value lines until closing `---`.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
function parseFrontmatter(content) {
  if (typeof content !== 'string') return { ok: false, reason: 'not a string' };
  if (!content.startsWith('---')) return { ok: true, frontmatter: null, body: content };
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { ok: false, reason: 'opening --- without closing ---' };
  const body = content.slice(m[0].length);
  const fm = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine;
    if (!line.trim()) continue;
    if (line.startsWith('  ') || line.startsWith('-')) continue; // nested / list — skip shallow
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) return { ok: false, reason: `unparseable frontmatter line: ${line}` };
    fm[kv[1]] = kv[2];
  }
  return { ok: true, frontmatter: fm, body };
}

// Canonical line count for conservation checks. F-A: prior version used a
// raw `split('\n').length` which over-counts files with a trailing newline
// by 1 (e.g., 'a\n' → ['a',''] → 2). The serializer's trailing-newline
// behavior is opaque, so we strip exactly one trailing '\n' before splitting
// — both pre and post are normalized through the same lens, leaving exact
// arithmetic. Tolerance becomes ZERO (per archive-schema § 4.1).
function lineCount(text) {
  if (text == null || text === '') return 0;
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (stripped === '') return 0;
  return stripped.split('\n').length;
}

// ---- C1: manifest match ----------------------------------------------

async function checkManifestMatch({ dreamDir }) {
  const findings = [];
  const manifestPath = path.join(dreamDir, 'manifest.json');
  const snapshotDir = path.join(dreamDir, 'snapshot');
  const raw = await readIfExists(manifestPath);
  if (raw === null) {
    findings.push(makeFinding('manifest_match', 'fail', `manifest.json not found at ${manifestPath}`));
    return findings;
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (e) {
    findings.push(makeFinding('manifest_match', 'fail', `manifest.json parse error: ${e.message}`));
    return findings;
  }
  // F-J: strict semver and required. Missing or non-semver fails the check.
  const sv = manifest.schema_version;
  if (typeof sv !== 'string' || !SEMVER_RE.test(sv)) {
    findings.push(makeFinding(
      'manifest_match', 'fail',
      `manifest schema_version missing or not strict semver: ${JSON.stringify(sv)} (expected X.Y.Z, e.g. ${SCHEMA_VERSION})`,
    ));
    return findings;
  }
  if (sv.match(SEMVER_RE)[1] !== SCHEMA_VERSION.match(SEMVER_RE)[1]) {
    findings.push(makeFinding(
      'manifest_match', 'fail',
      `manifest schema_version=${sv} unsupported (expected major ${SCHEMA_VERSION.match(SEMVER_RE)[1]}.x.x)`,
    ));
    return findings;
  }
  if (!Array.isArray(manifest.files)) {
    findings.push(makeFinding('manifest_match', 'fail', 'manifest.files[] missing or not an array'));
    return findings;
  }

  // Build set of paths declared in manifest. R2-A: every entry MUST carry a
  // non-empty, lowercase-hex sha256 — empty/null/missing makes integrity
  // verification an unauthenticated trust statement.
  const declared = new Map(); // rel → entry
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string') {
      findings.push(makeFinding('manifest_match', 'fail', `manifest.files[] entry missing path`));
      continue;
    }
    const relPath = posix(entry.path);
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      findings.push(makeFinding(
        'manifest_match', 'fail',
        `manifest.files[] entry for ${relPath} has missing or malformed sha256: ${JSON.stringify(entry.sha256)}`,
        { path: relPath },
      ));
      continue;
    }
    declared.set(relPath, entry);
  }

  // F-L: walk snapshot/ with symlink detection — any symlink in snapshot/ is
  // an undeclared exit hatch (the snapshotter sets `manifest.symlinks[]` for
  // declared ones and skips others). A loose symlink under snapshot/ would
  // bypass sha verification AND link out of memory_root.
  const walked = await walkRel(snapshotDir, { withSymlinks: true });
  const declaredSymlinks = new Set(
    Array.isArray(manifest.symlinks)
      ? manifest.symlinks.map(s => posix(s && s.path || ''))
      : [],
  );
  for (const symRel of walked.symlinks) {
    if (declaredSymlinks.has(symRel)) continue;
    findings.push(makeFinding(
      'manifest_match', 'fail',
      `snapshot contains undeclared symlink: ${symRel}`,
      { path: symRel },
    ));
  }
  const onDisk = walked.files;
  for (const rel of onDisk) {
    const entry = declared.get(rel);
    if (!entry) {
      findings.push(makeFinding(
        'manifest_match', 'fail',
        `snapshot file not declared in manifest: ${rel}`,
        { path: rel },
      ));
      continue;
    }
    const buf = await readBufIfExists(path.join(snapshotDir, rel));
    if (buf === null) continue;
    const actualSha = sha256(buf);
    if (entry.sha256 && entry.sha256 !== actualSha) {
      findings.push(makeFinding(
        'manifest_match', 'fail',
        `snapshot sha256 mismatch for ${rel}: manifest=${entry.sha256.slice(0, 12)} actual=${actualSha.slice(0, 12)}`,
        { path: rel },
      ));
    }
  }

  const onDiskSet = new Set(onDisk);
  for (const rel of declared.keys()) {
    if (!onDiskSet.has(rel)) {
      findings.push(makeFinding(
        'manifest_match', 'fail',
        `manifest declares ${rel} but snapshot file missing`,
        { path: rel },
      ));
    }
  }

  return findings;
}

// ---- C2: line conservation -------------------------------------------

// Map of warm-tier source → archive-path predicate. Sources NOT in this
// map are still audited (F-C: working-memory.md), but with zero archive
// expected (pre==post hard).
const ARCHIVE_POLICY = new Map([
  ['corrections.md', {
    archivePrefix: 'archive/corrections/',
    matchRel: rel => /^archive\/corrections\/\d{4}-\d{2}\.md$/.test(rel),
  }],
  ['session-index.md', {
    archivePrefix: 'archive/sessions/',
    matchRel: rel => /^archive\/sessions\/session-index-\d{4}-\d{2}\.md$/.test(rel),
  }],
]);

// F-C: every staged source we audit. Includes hot-tier files that get
// rewritten by Phase 4 (working-memory.md, patterns/active/*) — those have
// no archive policy, so pre==post is the strict check.
const CONSERVATION_SOURCES = ['working-memory.md', 'corrections.md', 'session-index.md'];

async function checkConservation({ dreamDir, memoryRoot }) {
  const findings = [];
  const stagedRoot = path.join(dreamDir, 'staged');
  const snapshotDir = path.join(dreamDir, 'snapshot');

  // R2-D: surface staged-tree symlinks. They bypass any check that uses the
  // logical-path filter (C2, C5, C10). A `staged/decisions/foo.md.tombstone`
  // pointing to /etc/passwd via a symlink would slip C10's append-only guard.
  const stagedWalk = await walkRel(stagedRoot, { withSymlinks: true });
  for (const symRel of stagedWalk.symlinks) {
    findings.push(makeFinding(
      'conservation', 'fail',
      `staged tree contains symlink (forbidden — sweep would resolve it): ${symRel}`,
      { path: symRel },
    ));
  }

  // R2-B: every staged archive .tmp MUST have a preimage sidecar regardless of
  // whether its logical source .tmp is staged. The per-source loop below
  // checks sidecars when the source IS staged; this orphan pass covers the
  // dangerous case where Phase 3 stages an archive append but skipped the
  // source trim — the sweep would still overwrite the archive with no
  // conservation guard.
  for (const [sourceRel, policy] of ARCHIVE_POLICY.entries()) {
    const sourceStaged = await fileExists(path.join(stagedRoot, `${sourceRel}.tmp`));
    if (sourceStaged) continue; // covered by the per-source loop below
    for (const stagedRel of stagedWalk.files) {
      if (!stagedRel.startsWith(policy.archivePrefix)) continue;
      if (!stagedRel.endsWith('.tmp')) continue;
      const archiveLogicalRel = stagedRel.slice(0, -'.tmp'.length);
      if (!policy.matchRel(archiveLogicalRel)) continue;
      // Verify sidecar presence + sha vs live. Sidecar missing ⇒ fail; sha
      // mismatch ⇒ fail. Mirrors the per-source-loop logic so orphan archives
      // get the same gate.
      const sidecarRaw = await readIfExists(path.join(stagedRoot, `${stagedRel}.preimage-sha256`));
      if (sidecarRaw === null) {
        findings.push(makeFinding(
          'conservation', 'fail',
          `orphan archive append staged without preimage sidecar (no source trim): ${archiveLogicalRel}`,
          { path: archiveLogicalRel },
        ));
        continue;
      }
      let sidecar;
      try { sidecar = JSON.parse(sidecarRaw); }
      catch (e) {
        findings.push(makeFinding(
          'conservation', 'fail',
          `orphan archive sidecar parse error for ${archiveLogicalRel}: ${e.message}`,
          { path: archiveLogicalRel },
        ));
        continue;
      }
      const liveArchive = await readBufIfExists(path.join(memoryRoot, archiveLogicalRel));
      if (sidecar.sha256 === null) {
        if (liveArchive !== null) {
          findings.push(makeFinding(
            'conservation', 'fail',
            `orphan archive sidecar claims absent at stage-time but live exists now: ${archiveLogicalRel}`,
            { path: archiveLogicalRel },
          ));
        }
      } else if (typeof sidecar.sha256 === 'string') {
        if (liveArchive === null) {
          findings.push(makeFinding(
            'conservation', 'fail',
            `orphan archive sidecar declares sha but live archive missing: ${archiveLogicalRel}`,
            { path: archiveLogicalRel },
          ));
        } else if (sha256(liveArchive) !== sidecar.sha256) {
          findings.push(makeFinding(
            'conservation', 'fail',
            `orphan archive preimage sha mismatch for ${archiveLogicalRel}`,
            { path: archiveLogicalRel },
          ));
        }
      }
    }
  }

  for (const sourceRel of CONSERVATION_SOURCES) {
    const stagedSource = path.join(stagedRoot, `${sourceRel}.tmp`);
    if (!(await fileExists(stagedSource))) continue; // not staged this run

    const preBuf = await readIfExists(path.join(snapshotDir, sourceRel));
    if (preBuf === null) {
      // Snapshot missing for a staged source: conservation cannot be proven
      // here, but C1 (manifest_match) is responsible for catching missing
      // snapshot files. Continue silently to avoid double-reporting.
      continue;
    }
    const postBuf = await readIfExists(stagedSource);
    if (postBuf === null) continue;

    const preLines = lineCount(preBuf);
    const postLines = lineCount(postBuf);
    const policy = ARCHIVE_POLICY.get(sourceRel);

    if (!policy) {
      // F-C: hot-tier rewrite (Phase 4 dates) — no lines should disappear.
      // Zero tolerance, F-A.
      if (preLines !== postLines) {
        findings.push(makeFinding(
          'conservation', 'fail',
          `${sourceRel} rewrite changed line count without archive: pre=${preLines} post=${postLines}`,
          { path: sourceRel },
        ));
      }
      continue;
    }

    // F-B: every staged archive .tmp under this source's archive prefix MUST
    // have a preimage-sha256 sidecar; the sidecar's recorded sha MUST match
    // the live archive at audit time. If sidecar missing OR sha mismatch,
    // that's a conservation FAIL — we cannot bound `archivedNewLines`
    // honestly without that anchor.
    const stagedRelFiles = await walkRel(stagedRoot);
    let archivedNewLines = 0;
    let sawArchiveFault = false;
    for (const stagedRel of stagedRelFiles) {
      if (!stagedRel.startsWith(policy.archivePrefix)) continue;
      if (!stagedRel.endsWith('.tmp')) continue;
      const archiveLogicalRel = stagedRel.slice(0, -'.tmp'.length);
      if (!policy.matchRel(archiveLogicalRel)) continue;

      const stagedArchive = await readIfExists(path.join(stagedRoot, stagedRel));
      if (stagedArchive === null) continue;

      const sidecarPath = path.join(stagedRoot, `${stagedRel}.preimage-sha256`);
      const sidecarRaw = await readIfExists(sidecarPath);
      if (sidecarRaw === null) {
        findings.push(makeFinding(
          'conservation', 'fail',
          `archive append staged without preimage sidecar: ${archiveLogicalRel}`,
          { path: archiveLogicalRel },
        ));
        sawArchiveFault = true;
        continue;
      }
      let sidecar;
      try { sidecar = JSON.parse(sidecarRaw); }
      catch (e) {
        findings.push(makeFinding(
          'conservation', 'fail',
          `archive sidecar parse error for ${archiveLogicalRel}: ${e.message}`,
          { path: archiveLogicalRel },
        ));
        sawArchiveFault = true;
        continue;
      }

      const liveArchive = await readBufIfExists(path.join(memoryRoot, archiveLogicalRel));
      let preimageLines = 0;
      if (sidecar.sha256 === null) {
        // Sidecar declares "live archive did not exist at stage-time".
        // F-B: verify the live archive is STILL absent. If it appeared
        // between stage and audit, refuse — conservation no longer holds
        // against the recorded preimage.
        if (liveArchive !== null) {
          findings.push(makeFinding(
            'conservation', 'fail',
            `archive sidecar claims absent at stage-time but live exists now: ${archiveLogicalRel}`,
            { path: archiveLogicalRel },
          ));
          sawArchiveFault = true;
          continue;
        }
        preimageLines = 0;
      } else {
        if (liveArchive === null) {
          findings.push(makeFinding(
            'conservation', 'fail',
            `archive sidecar declares sha but live archive missing: ${archiveLogicalRel}`,
            { path: archiveLogicalRel },
          ));
          sawArchiveFault = true;
          continue;
        }
        const liveSha = sha256(liveArchive);
        if (liveSha !== sidecar.sha256) {
          findings.push(makeFinding(
            'conservation', 'fail',
            `archive preimage sha mismatch for ${archiveLogicalRel}: sidecar=${String(sidecar.sha256).slice(0, 12)} live=${liveSha.slice(0, 12)}`,
            { path: archiveLogicalRel },
          ));
          sawArchiveFault = true;
          continue;
        }
        preimageLines = lineCount(liveArchive.toString('utf8'));
      }

      const stagedArchiveLines = lineCount(stagedArchive);
      const delta = stagedArchiveLines - preimageLines;
      if (delta < 0) {
        findings.push(makeFinding(
          'conservation', 'fail',
          `archive shrunk vs preimage for ${archiveLogicalRel}: staged=${stagedArchiveLines} preimage=${preimageLines}`,
          { path: archiveLogicalRel },
        ));
        sawArchiveFault = true;
      } else {
        archivedNewLines += delta;
      }
    }

    if (sawArchiveFault) continue; // skip arithmetic on broken archive set

    // F-A: zero tolerance. pre = post + archived (strict).
    const reconstructed = postLines + archivedNewLines;
    if (preLines !== reconstructed) {
      findings.push(makeFinding(
        'conservation', 'fail',
        `${sourceRel} line conservation broken: pre=${preLines} post=${postLines} archived=${archivedNewLines} expected_post+archived=${preLines}`,
        { path: sourceRel },
      ));
    }
  }

  return findings;
}

// ---- C3: frontmatter valid -------------------------------------------

async function checkFrontmatter({ dreamDir }) {
  const findings = [];
  const stagedRoot = path.join(dreamDir, 'staged');
  const stagedRels = await walkRel(stagedRoot);
  for (const rel of stagedRels) {
    if (!rel.endsWith('.md.tmp')) continue;
    const content = await readIfExists(path.join(stagedRoot, rel));
    if (content === null) continue;
    if (!content.startsWith('---')) continue; // no frontmatter — fine
    const result = parseFrontmatter(content);
    if (!result.ok) {
      findings.push(makeFinding(
        'frontmatter_valid', 'fail',
        `staged ${rel} frontmatter parse failed: ${result.reason}`,
        { path: rel },
      ));
    }
  }
  return findings;
}

// ---- C4: anchor link resolution --------------------------------------

const MD_LINK_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;

async function checkAnchorLinks({ dreamDir, memoryRoot }) {
  const findings = [];
  const stagedRoot = path.join(dreamDir, 'staged');
  const sourcesToCheck = ['memory-index.md.tmp', 'pre-action.md.tmp'];
  const stagedSet = new Set(await walkRel(stagedRoot));
  for (const sourceRel of sourcesToCheck) {
    const content = await readIfExists(path.join(stagedRoot, sourceRel));
    if (content === null) continue;
    let m;
    const re = new RegExp(MD_LINK_RE.source, MD_LINK_RE.flags);
    while ((m = re.exec(content)) !== null) {
      const target = m[2].trim();
      if (target.startsWith('http://') || target.startsWith('https://')) continue;
      if (target.startsWith('#')) continue; // intra-doc anchor; skip for now
      // Strip in-document anchors and trailing fragments
      const cleanedRaw = target.split('#')[0];
      const cleaned = cleanedRaw.split('?')[0];
      if (!cleaned) continue;
      // F-I: reject path-traversal links (`..`, absolute paths). A regenerated
      // index citing `../../etc/passwd` is structurally invalid even if the
      // file happens to exist on disk.
      const safe = safeRelPath(cleaned);
      if (!safe.ok) {
        findings.push(makeFinding(
          'anchor_links_resolve', 'fail',
          `${sourceRel}: link target rejected (${safe.reason}): ${target}`,
          { path: sourceRel, target },
        ));
        continue;
      }
      const norm = safe.normalized;
      // Accept either: file lives in live tree, OR will exist after sweep
      // (staged tree has a .tmp for it).
      const liveAbs = path.join(memoryRoot, norm);
      const stagedRel = `${norm}.tmp`;
      if (await fileExists(liveAbs)) continue;
      if (stagedSet.has(stagedRel)) continue;
      findings.push(makeFinding(
        'anchor_links_resolve', 'warn',
        `${sourceRel}: link target does not resolve: ${target}`,
        { path: sourceRel, target },
      ));
    }
  }
  return findings;
}

// ---- C5: archive-block presence --------------------------------------
//
// For each block (H3 entry) that disappeared from the post-trim source, we
// derive its expected archive month (via the first ISO date inside the block
// — same logic as parse-md-blocks.blockDateISO) and assert two things:
//   1. The block's heading appears in EXACTLY ONE archive month, and that's
//      the expected one. (F-E: no cross-month teleportation.)
//   2. The full block body appears verbatim in that archive .tmp. (F-F:
//      heading match alone allows a wrong-body archive to pass.)

async function checkArchiveBlockPresence({ dreamDir }) {
  const findings = [];
  const stagedRoot = path.join(dreamDir, 'staged');
  const snapshotDir = path.join(dreamDir, 'snapshot');

  const sources = [
    {
      sourceRel: 'corrections.md',
      archivePattern: /^archive\/corrections\/(\d{4}-\d{2})\.md$/,
    },
    {
      sourceRel: 'session-index.md',
      archivePattern: /^archive\/sessions\/session-index-(\d{4}-\d{2})\.md$/,
    },
  ];

  const stagedRels = await walkRel(stagedRoot);

  for (const { sourceRel, archivePattern } of sources) {
    const staged = path.join(stagedRoot, `${sourceRel}.tmp`);
    if (!(await fileExists(staged))) continue;

    const pre = await readIfExists(path.join(snapshotDir, sourceRel));
    const post = await readIfExists(staged);
    if (pre === null || post === null) continue;

    const preBlocks = extractH3Blocks(pre);
    if (preBlocks.length === 0) continue;
    // R2-C: multiset semantics for duplicate H3 headings. The prior `Set`
    // lookup would say "heading present" if even one copy survived, masking
    // a wrong-month or body-divergent archive of the duplicate. Track per-
    // heading counts and treat each removed occurrence as its own missing
    // block — preserving order from preBlocks so subsequent F-E/F-F checks
    // examine each archived copy independently.
    const postHeadingCounts = new Map();
    for (const h of extractHeadings(post)) {
      postHeadingCounts.set(h, (postHeadingCounts.get(h) || 0) + 1);
    }
    const missing = [];
    for (const block of preBlocks) {
      const remaining = postHeadingCounts.get(block.heading) || 0;
      if (remaining > 0) {
        postHeadingCounts.set(block.heading, remaining - 1);
        continue; // this occurrence of the heading stayed
      }
      missing.push(block);
    }
    if (missing.length === 0) continue;

    // Index every matching archive .tmp by its month key.
    const archivesByMonth = new Map(); // monthKey -> { headings: Set, content: string }
    for (const stagedRel of stagedRels) {
      if (!stagedRel.endsWith('.tmp')) continue;
      const logical = stagedRel.slice(0, -'.tmp'.length);
      const m = logical.match(archivePattern);
      if (!m) continue;
      const monthKey = m[1];
      const c = await readIfExists(path.join(stagedRoot, stagedRel));
      if (c === null) continue;
      archivesByMonth.set(monthKey, {
        headings: new Set(extractHeadings(c)),
        content: c,
      });
    }

    for (const block of missing) {
      const expectedMonth = block.dateISO ? block.dateISO.slice(0, 7) : null;

      // Detect any archive month carrying this heading (used for F-E
      // wrong-month detection AND F-F content match).
      const carriers = [];
      for (const [monthKey, info] of archivesByMonth.entries()) {
        if (info.headings.has(block.heading)) carriers.push({ monthKey, info });
      }
      if (carriers.length === 0) {
        findings.push(makeFinding(
          'archive_block_present', 'fail',
          `${sourceRel}: archived block heading not found in archive: ${block.heading.slice(0, 80)}`,
          { path: sourceRel, heading: block.heading },
        ));
        continue;
      }
      if (carriers.length > 1) {
        // Same heading in multiple archives → ambiguous routing, treat as fail.
        findings.push(makeFinding(
          'archive_block_present', 'fail',
          `${sourceRel}: archived block heading appears in multiple archive months (${carriers.map(c => c.monthKey).join(', ')}): ${block.heading.slice(0, 80)}`,
          { path: sourceRel, heading: block.heading, months: carriers.map(c => c.monthKey) },
        ));
        continue;
      }
      const [carrier] = carriers;
      // F-E: enforce expected month match if we could derive one from the
      // block body. Blocks without an ISO date are routed by Phase-3's
      // classifier; we accept any single archive month for those.
      if (expectedMonth && carrier.monthKey !== expectedMonth) {
        findings.push(makeFinding(
          'archive_block_present', 'fail',
          `${sourceRel}: archived block routed to wrong month (expected ${expectedMonth}, found ${carrier.monthKey}): ${block.heading.slice(0, 80)}`,
          { path: sourceRel, heading: block.heading, expected: expectedMonth, actual: carrier.monthKey },
        ));
        continue;
      }
      // F-F: full block body must appear verbatim in the archive .tmp.
      // Compare on the raw block text (heading + body lines) less trailing
      // whitespace so a single \n drift doesn't false-fail.
      const blockText = block.text.replace(/\s+$/, '');
      if (!carrier.info.content.replace(/\s+$/, '').includes(blockText)) {
        findings.push(makeFinding(
          'archive_block_present', 'fail',
          `${sourceRel}: archived block heading present but body content differs in archive ${carrier.monthKey}: ${block.heading.slice(0, 80)}`,
          { path: sourceRel, heading: block.heading, archive_month: carrier.monthKey },
        ));
      }
    }
  }
  return findings;
}

function extractHeadings(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('### ')) out.push(line);
  }
  return out;
}

// Extract H3 entries with their text + first-ISO-date. Same boundary rule as
// parse-md-blocks: a block starts at `### ` and ends before the next `### `
// or `## ` heading.
function extractH3Blocks(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (cur) out.push(finalizeBlock(cur));
      cur = { heading: line, body: [] };
    } else if (line.startsWith('## ')) {
      if (cur) { out.push(finalizeBlock(cur)); cur = null; }
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) out.push(finalizeBlock(cur));
  return out;
}

function finalizeBlock(b) {
  const text = [b.heading, ...b.body].join('\n');
  const m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return { heading: b.heading, text, dateISO: m ? `${m[1]}-${m[2]}-${m[3]}` : null };
}

// ---- C6: firing-log freshness ----------------------------------------

async function checkFiringLogFreshness({ memoryRoot, today }) {
  const findings = [];
  const logPath = path.join(memoryRoot, 'pattern-firing-log.md');
  let stat;
  try { stat = await fs.stat(logPath); }
  catch (e) {
    if (e.code === 'ENOENT') {
      findings.push(makeFinding(
        'firing_log_freshness', 'warn',
        'pattern-firing-log.md does not exist; firing-driven demotion gate inert',
      ));
      return findings;
    }
    throw e;
  }
  const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
  if (ageHours > FIRING_LOG_FRESHNESS_HOURS) {
    findings.push(makeFinding(
      'firing_log_freshness', 'warn',
      `pattern-firing-log.md not modified in ${ageHours.toFixed(1)}h (threshold ${FIRING_LOG_FRESHNESS_HOURS}h)`,
    ));
    return findings;
  }
  // Optional content check: today's session id appears
  const content = await readIfExists(logPath);
  if (content && !content.includes(today)) {
    findings.push(makeFinding(
      'firing_log_freshness', 'warn',
      `pattern-firing-log.md has no entry mentioning ${today}`,
    ));
  }
  return findings;
}

// ---- C7: no relative dates remain ------------------------------------

async function checkNoRelativeDates({ dreamDir, today }) {
  const findings = [];
  const stagedRoot = path.join(dreamDir, 'staged');
  for (const rel of HOT_TIER_DATE_FILES) {
    const stagedAbs = path.join(stagedRoot, `${rel}.tmp`);
    const content = await readIfExists(stagedAbs);
    if (content === null) continue;
    const matches = findRelativeDates(content, today);
    if (matches.length > 0) {
      findings.push(makeFinding(
        'no_relative_dates', 'fail',
        `${rel} still contains ${matches.length} relative-date phrase(s); first at line ${matches[0].lineNumber}: "${matches[0].phrase}"`,
        { path: rel, count: matches.length },
      ));
    }
  }
  return findings;
}

// ---- C8: source-citation resolves ------------------------------------

async function checkSourceCitations({ dreamDir, memoryRoot }) {
  const findings = [];
  const eventPath = path.join(dreamDir, 'event.json');
  const raw = await readIfExists(eventPath);
  if (raw === null) {
    findings.push(makeFinding('source_citation_resolves', 'fail', `event.json missing at ${eventPath}`));
    return findings;
  }
  let event;
  try { event = JSON.parse(raw); }
  catch (e) {
    findings.push(makeFinding('source_citation_resolves', 'fail', `event.json parse error: ${e.message}`));
    return findings;
  }
  const insights = Array.isArray(event.insights) ? event.insights : [];
  const stagedRoot = path.join(dreamDir, 'staged');
  const stagedRels = new Set(await walkRel(stagedRoot));
  const checked = new Set();
  for (const insight of insights) {
    if (!Array.isArray(insight.source_citations)) {
      // F-H: a citations field that isn't an array (string, object, missing)
      // is a structural error. Surface it instead of silently treating it
      // as zero citations.
      if (insight.source_citations !== undefined) {
        findings.push(makeFinding(
          'source_citation_resolves', 'fail',
          `insight.source_citations not an array: ${typeof insight.source_citations}`,
          { insight_id: insight.id },
        ));
      }
      continue;
    }
    for (const cite of insight.source_citations) {
      // F-H: required form is `<path>#L<digits>`. Anything else (no anchor,
      // anchor without `L`, multiple `#L` segments) is malformed.
      if (typeof cite !== 'string') {
        findings.push(makeFinding(
          'source_citation_resolves', 'fail',
          `insight citation not a string: ${JSON.stringify(cite)}`,
          { insight_id: insight.id },
        ));
        continue;
      }
      const m = cite.match(CITATION_RE);
      if (!m) {
        findings.push(makeFinding(
          'source_citation_resolves', 'fail',
          `insight citation does not match <path>#L<digits>: ${cite}`,
          { citation: cite, insight_id: insight.id },
        ));
        continue;
      }
      const rel = m[1].trim();
      if (!rel) continue;
      // F-I: reject path traversal.
      const safe = safeRelPath(rel);
      if (!safe.ok) {
        findings.push(makeFinding(
          'source_citation_resolves', 'fail',
          `insight citation path rejected (${safe.reason}): ${cite}`,
          { citation: cite, insight_id: insight.id },
        ));
        continue;
      }
      const norm = safe.normalized;
      if (checked.has(norm)) continue;
      checked.add(norm);
      const live = path.join(memoryRoot, norm);
      if (await fileExists(live)) continue;
      if (stagedRels.has(`${norm}.tmp`)) continue;
      findings.push(makeFinding(
        'source_citation_resolves', 'fail',
        `event.json insight cites missing file: ${cite}`,
        { citation: cite, insight_id: insight.id },
      ));
    }
  }
  return findings;
}

// ---- C9: dream-log-entry.md ⇔ event.json agreement -------------------

async function checkDreamLogEventAgree({ dreamDir }) {
  const findings = [];
  const dlePath = path.join(dreamDir, 'dream-log-entry.md');
  const evtPath = path.join(dreamDir, 'event.json');
  const dle = await readIfExists(dlePath);
  const evt = await readIfExists(evtPath);
  if (dle === null) {
    findings.push(makeFinding('dream_log_event_agree', 'fail', `dream-log-entry.md missing at ${dlePath}`));
    return findings;
  }
  if (evt === null) {
    findings.push(makeFinding('dream_log_event_agree', 'fail', `event.json missing at ${evtPath}`));
    return findings;
  }
  let event;
  try { event = JSON.parse(evt); }
  catch (e) {
    findings.push(makeFinding('dream_log_event_agree', 'fail', `event.json parse error: ${e.message}`));
    return findings;
  }

  // Extract claims from dream-log-entry.md via stable-shape regexes.
  // The entry's renderer is renderDreamLogEntry() in phase-5-rebuild-indexes.js;
  // we mirror those exact patterns so a renderer change must update both.
  const reinforcedRe = /reinforced patterns:\s*(\d+)/;
  const promotedDeclinedRe = /promotions:\s*(\d+),\s*declined:\s*(\d+)/;
  const correctionsRe = /corrections archived:\s*(\d+) blocks/;
  const sessionsRe = /session-index archived:\s*(\d+) blocks/;
  const journalRe = /journal archived:\s*(\d+)/;
  const demotedRe = /patterns demoted:\s*(\d+)/;
  const datesRe = /relative-date rewrites:\s*(\d+) across (\d+) files/;

  function pick(re) { const m = dle.match(re); return m ? Number(m[1]) : null; }
  function pickPair(re) { const m = dle.match(re); return m ? [Number(m[1]), Number(m[2])] : [null, null]; }

  const dleReinforce = pick(reinforcedRe);
  const [dlePromote, dleDecline] = pickPair(promotedDeclinedRe);
  const dleCorrections = pick(correctionsRe);
  const dleSessions = pick(sessionsRe);
  const dleJournal = pick(journalRe);
  const dleDemoted = pick(demotedRe);
  const [dleDates, dleDateFiles] = pickPair(datesRe);

  function expect(name, fromDle, fromEvent) {
    if (fromDle === null) {
      // F-G: fail-on-null when the event side claims a non-zero value. If
      // event says "5 reinforced" but the renderer's phrasing changed and
      // our regex missed it, we MUST fail loudly — not silently skip.
      // Renderer-and-parser drift is the bug we're protecting against.
      if (typeof fromEvent === 'number' && fromEvent > 0) {
        findings.push(makeFinding(
          'dream_log_event_agree', 'fail',
          `${name}: dream-log entry did not surface this field (regex missed?), but event.json=${fromEvent} — possible renderer/parser drift`,
          { field: name, event_value: fromEvent },
        ));
      }
      return;
    }
    if (fromEvent !== fromDle) {
      findings.push(makeFinding(
        'dream_log_event_agree', 'fail',
        `${name} mismatch: dream-log=${fromDle} event.json=${fromEvent}`,
        { field: name },
      ));
    }
  }

  const routed = event.routed || {};
  const pruned = event.pruned || {};
  expect('reinforced', dleReinforce, Array.isArray(routed.patterns_reinforced) ? routed.patterns_reinforced.length : 0);
  expect('promoted', dlePromote, Array.isArray(routed.patterns_promoted) ? routed.patterns_promoted.length : 0);
  expect('declined', dleDecline, Array.isArray(routed.patterns_promotion_declined) ? routed.patterns_promotion_declined.length : 0);
  // Corrections / sessions: dream-log shows BLOCKS archived; event.json
  // tracks lines (different unit). We only assert that "archived blocks > 0
  // ⇔ archive_path or lines_archived > 0" — direction agreement, not equality.
  if (dleCorrections !== null) {
    const linesArchived = pruned.corrections_lines_archived ?? 0;
    if ((dleCorrections > 0) !== (linesArchived > 0)) {
      findings.push(makeFinding(
        'dream_log_event_agree', 'fail',
        `corrections direction mismatch: dream-log blocks=${dleCorrections} event.lines=${linesArchived}`,
        { field: 'corrections' },
      ));
    }
  }
  if (dleSessions !== null) {
    const linesBefore = pruned.session_index_lines_before ?? 0;
    const linesAfter = pruned.session_index_lines_after ?? 0;
    const archivedDir = linesBefore - linesAfter;
    if ((dleSessions > 0) !== (archivedDir > 0)) {
      findings.push(makeFinding(
        'dream_log_event_agree', 'fail',
        `session-index direction mismatch: dream-log blocks=${dleSessions} event.delta=${archivedDir}`,
        { field: 'session_index' },
      ));
    }
  }
  expect('journal', dleJournal, pruned.journals_archived_count ?? 0);
  expect('demoted', dleDemoted, Array.isArray(pruned.patterns_demoted) ? pruned.patterns_demoted.length : 0);
  expect('relative_date_replacements', dleDates, pruned.relative_dates_total_replacements ?? 0);
  expect('relative_date_files', dleDateFiles, pruned.relative_dates_files_rewritten ?? 0);

  return findings;
}

// ---- C10: append-only invariant --------------------------------------

async function checkAppendOnly({ dreamDir }) {
  const findings = [];
  const stagedRoot = path.join(dreamDir, 'staged');
  // R2-D: include symlinks in the walk. A symlink at a logical
  // append-only path bypasses .tmp/.tombstone detection entirely — surface
  // it as a separate finding even before classifying logical paths.
  const walked = await walkRel(stagedRoot, { withSymlinks: true });
  for (const symRel of walked.symlinks) {
    findings.push(makeFinding(
      'append_only_intact', 'fail',
      `staged tree contains symlink under append-only scan: ${symRel}`,
      { path: symRel, mode: 'symlink' },
    ));
  }
  // F-K: cover both .tmp (rewrite) AND .tombstone (delete) staging modes.
  for (const stagedRel of walked.files) {
    let logical = null;
    let mode = null;
    if (stagedRel.endsWith('.tmp')) { logical = stagedRel.slice(0, -'.tmp'.length); mode = 'rewrite'; }
    else if (stagedRel.endsWith('.tombstone')) { logical = stagedRel.slice(0, -'.tombstone'.length); mode = 'delete'; }
    if (!logical) continue;
    // Append-only checks fire on EITHER mode (rewrite OR delete) — these
    // files must never be touched by the dream worker.
    if (APPEND_ONLY_PATHS.has(logical)
        || APPEND_ONLY_PREFIXES.some(p => logical.startsWith(p))) {
      findings.push(makeFinding(
        'append_only_intact', 'fail',
        `append-only file staged for ${mode}: ${logical}`,
        { path: logical, mode },
      ));
      continue;
    }
    // Delete-forbidden checks fire only on TOMBSTONES targeting archive/
    // paths. Phase 3's archive appends (rewrite + sidecar) are legitimate;
    // a tombstone is structurally wrong (can't delete an archived file).
    if (mode === 'delete' && DELETE_FORBIDDEN_PREFIXES.some(p => logical.startsWith(p))) {
      findings.push(makeFinding(
        'append_only_intact', 'fail',
        `archive path staged for delete (immutability violation): ${logical}`,
        { path: logical, mode },
      ));
    }
  }
  return findings;
}

// ---- top-level runStageA --------------------------------------------

/**
 * Run all Stage A invariant checks against a staged dream tree.
 *
 * @param {object} opts
 * @param {string} opts.memoryRoot   live memory root
 * @param {string} opts.dreamDir     archive/dreams/<date>/
 * @param {string} opts.today        YYYY-MM-DD
 * @param {string[]} [opts.skipChecks]  test/CLI override; skip named checks
 * @returns {Promise<{verdict, findings, summary}>}
 */
export async function runStageA(opts) {
  const start = Date.now();
  const { memoryRoot, dreamDir, today, skipChecks = [] } = opts || {};
  if (!memoryRoot) throw new Error('runStageA: memoryRoot required');
  if (!dreamDir) throw new Error('runStageA: dreamDir required');
  if (!today) throw new Error('runStageA: today required');
  if (!ISO_DATE_RE.test(today)) {
    throw new Error(`runStageA: today must match YYYY-MM-DD; got '${today}'`);
  }

  const skip = new Set(skipChecks);
  const allFindings = [];

  const checks = [
    ['manifest_match', () => checkManifestMatch({ dreamDir })],
    ['conservation', () => checkConservation({ dreamDir, memoryRoot })],
    ['frontmatter_valid', () => checkFrontmatter({ dreamDir })],
    ['anchor_links_resolve', () => checkAnchorLinks({ dreamDir, memoryRoot })],
    ['archive_block_present', () => checkArchiveBlockPresence({ dreamDir })],
    ['firing_log_freshness', () => checkFiringLogFreshness({ memoryRoot, today })],
    ['no_relative_dates', () => checkNoRelativeDates({ dreamDir, today })],
    ['source_citation_resolves', () => checkSourceCitations({ dreamDir, memoryRoot })],
    ['dream_log_event_agree', () => checkDreamLogEventAgree({ dreamDir })],
    ['append_only_intact', () => checkAppendOnly({ dreamDir })],
  ];

  let checksRun = 0;
  for (const [name, fn] of checks) {
    if (skip.has(name)) continue;
    checksRun += 1;
    try {
      const out = await fn();
      for (const f of out) allFindings.push(f);
    } catch (e) {
      // Infrastructure error inside a check — surface as fail finding so
      // verdict is FAIL (no silent pass). F-D: the extras key MUST NOT be
      // `check` (object spread overrode the makeFinding label, leaking the
      // origin check name into f.check and breaking per-check filters).
      allFindings.push(makeFinding(
        'internal_error', 'fail',
        `check ${name} threw: ${e.message}`,
        { failed_check: name },
      ));
    }
  }

  const failures = allFindings.filter(f => f.severity === 'fail').length;
  const warnings = allFindings.filter(f => f.severity === 'warn').length;
  const verdict = failures > 0 ? 'FAIL' : (warnings > 0 ? 'WARN' : 'PASS');

  return {
    verdict,
    findings: allFindings,
    summary: {
      checks_run: checksRun,
      failures,
      warnings,
      duration_ms: Date.now() - start,
    },
  };
}

export const _internals = {
  SCHEMA_VERSION,
  SEMVER_RE,
  HOT_TIER_DATE_FILES,
  APPEND_ONLY_PATHS,
  APPEND_ONLY_PREFIXES,
  FIRING_LOG_FRESHNESS_HOURS,
  CITATION_RE,
  ARCHIVE_POLICY,
  CONSERVATION_SOURCES,
  parseFrontmatter,
  walkRel,
  posix,
  sha256,
  safeRelPath,
  lineCount,
  extractHeadings,
  extractH3Blocks,
};
