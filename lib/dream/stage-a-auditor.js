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

// Hot-tier files we sweep relative-date phrases out of (Phase 4 scope).
// C7 enforces post-stage: these files in the staged tree must contain none.
const HOT_TIER_DATE_FILES = ['working-memory.md', 'corrections.md', 'session-index.md'];

// Files that are append-only per archive-schema § 4.4. The worker MUST NOT
// stage them for rewrite. C10 enforces.
const APPEND_ONLY_PATHS = new Set(['pattern-firing-log.md']);
const APPEND_ONLY_PREFIXES = ['decisions/'];

const FIRING_LOG_FRESHNESS_HOURS = 36;

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

async function walkRel(rootAbs) {
  // Recursive walk; returns POSIX-form paths relative to rootAbs.
  const out = [];
  async function recurse(dir, prefix) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await recurse(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await recurse(rootAbs, '');
  return out.sort();
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

// Count blank-line-stripped non-empty lines in serialized blocks. Used by C2.
function lineCount(text) {
  if (text == null || text === '') return 0;
  return text.split('\n').length;
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
  if (manifest.schema_version && manifest.schema_version.split('.')[0] !== SCHEMA_VERSION.split('.')[0]) {
    findings.push(makeFinding(
      'manifest_match', 'fail',
      `manifest schema_version=${manifest.schema_version} unsupported (expected ${SCHEMA_VERSION})`,
    ));
    return findings;
  }
  if (!Array.isArray(manifest.files)) {
    findings.push(makeFinding('manifest_match', 'fail', 'manifest.files[] missing or not an array'));
    return findings;
  }

  // Build set of paths declared in manifest
  const declared = new Map(); // rel → entry
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string') {
      findings.push(makeFinding('manifest_match', 'fail', `manifest.files[] entry missing path`));
      continue;
    }
    declared.set(posix(entry.path), entry);
  }

  // Walk snapshot/, hash each, compare
  const onDisk = await walkRel(snapshotDir);
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

async function checkConservation({ dreamDir, memoryRoot }) {
  const findings = [];
  const stagedRoot = path.join(dreamDir, 'staged');
  const snapshotDir = path.join(dreamDir, 'snapshot');

  // Files we audit conservation for: warm-tier sources Phase-3 trims +
  // archives. The contract: pre = post + archived. We compute pre from
  // snapshot, post from staged source .tmp, archived from staged archive
  // .tmp MINUS the archive's pre-existing live content (read from snapshot
  // if it was warm-tiered; otherwise the live archive at audit time).
  const warmSources = ['corrections.md', 'session-index.md'];

  for (const sourceRel of warmSources) {
    const stagedSource = path.join(stagedRoot, `${sourceRel}.tmp`);
    if (!(await fileExists(stagedSource))) continue; // Phase 3 didn't trim this

    const preBuf = await readIfExists(path.join(snapshotDir, sourceRel));
    if (preBuf === null) {
      findings.push(makeFinding(
        'conservation', 'fail',
        `staged ${sourceRel}.tmp present but snapshot missing the source — cannot prove conservation`,
        { path: sourceRel },
      ));
      continue;
    }
    const postBuf = await readIfExists(stagedSource);
    if (postBuf === null) continue;

    const preLines = lineCount(preBuf);
    const postLines = lineCount(postBuf);

    // Tally archived appends. Phase 3 stages an archive .tmp at
    // archive/<sub>/<monthKey>.md.tmp; the preimage sidecar tells us the live
    // archive content at stage-time. The archived contribution from THIS run
    // is: staged_archive_content - preimage_content.
    const archivePrefix = sourceRel === 'corrections.md'
      ? 'archive/corrections/'
      : 'archive/sessions/'; // session-index archive lives at session-index-<monthKey>
    const stagedRelFiles = await walkRel(stagedRoot);
    let archivedNewLines = 0;
    for (const stagedRel of stagedRelFiles) {
      if (!stagedRel.startsWith(archivePrefix)) continue;
      if (!stagedRel.endsWith('.tmp')) continue;
      const archiveLogicalRel = stagedRel.slice(0, -'.tmp'.length); // drop .tmp
      // For session-index archives, only count files matching the per-month
      // session-index pattern; corrections archives are flat YYYY-MM.md.
      if (sourceRel === 'session-index.md'
          && !/^archive\/sessions\/session-index-\d{4}-\d{2}\.md$/.test(archiveLogicalRel)) {
        continue;
      }
      if (sourceRel === 'corrections.md'
          && !/^archive\/corrections\/\d{4}-\d{2}\.md$/.test(archiveLogicalRel)) {
        continue;
      }

      const stagedArchive = await readIfExists(path.join(stagedRoot, stagedRel));
      if (stagedArchive === null) continue;

      // Read the preimage sidecar for the live-archive content at stage time.
      const sidecar = await readIfExists(path.join(stagedRoot, `${stagedRel}.preimage-sha256`));
      let preimageLines = 0;
      if (sidecar !== null) {
        try {
          const obj = JSON.parse(sidecar);
          if (obj.sha256) {
            // Read the live archive (post-stage, pre-sweep — should still match preimage).
            const liveArchive = await readIfExists(path.join(memoryRoot, archiveLogicalRel));
            if (liveArchive !== null) preimageLines = lineCount(liveArchive);
          }
        } catch {
          // Malformed sidecar — surface separately; here treat as zero.
        }
      }
      const stagedArchiveLines = lineCount(stagedArchive);
      const delta = stagedArchiveLines - preimageLines;
      if (delta < 0) {
        findings.push(makeFinding(
          'conservation', 'fail',
          `archive shrunk vs preimage for ${archiveLogicalRel}: staged=${stagedArchiveLines} preimage=${preimageLines}`,
          { path: archiveLogicalRel },
        ));
      } else {
        archivedNewLines += delta;
      }
    }

    // Conservation: pre lines must equal post + archived(new) lines, give or
    // take ±1 for the trailing newline reformat baked into atomicWrite. The
    // serializer joins blocks with '\n' which can change the trailing line
    // count by 1 vs the original; we accept tolerance ≤1 to absorb that.
    const reconstructed = postLines + archivedNewLines;
    const diff = preLines - reconstructed;
    if (Math.abs(diff) > 1) {
      findings.push(makeFinding(
        'conservation', 'fail',
        `${sourceRel} line conservation broken: pre=${preLines} post=${postLines} archived=${archivedNewLines} diff=${diff}`,
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
      // Resolve path: if the link is relative, it's relative to the FUTURE
      // live position of the source file (memoryRoot/memory-index.md or
      // memoryRoot/pre-action.md), not to the staged path. So resolve as
      // memoryRoot/<cleaned>.
      const norm = posix(cleaned);
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

const H3_HEADING_RE = /^### .+$/m;

async function checkArchiveBlockPresence({ dreamDir }) {
  const findings = [];
  const stagedRoot = path.join(dreamDir, 'staged');
  const snapshotDir = path.join(dreamDir, 'snapshot');

  // For corrections.md and session-index.md: blocks that disappeared from
  // post-trim source must appear in the archive .tmp. We compare H3
  // headings as a tractable proxy (each archived block is bounded by an H3
  // entry per parse-md-blocks.js convention).

  const sources = [
    {
      sourceRel: 'corrections.md',
      archivePattern: /^archive\/corrections\/\d{4}-\d{2}\.md$/,
    },
    {
      sourceRel: 'session-index.md',
      archivePattern: /^archive\/sessions\/session-index-\d{4}-\d{2}\.md$/,
    },
  ];

  const stagedRels = await walkRel(stagedRoot);

  for (const { sourceRel, archivePattern } of sources) {
    const staged = path.join(stagedRoot, `${sourceRel}.tmp`);
    if (!(await fileExists(staged))) continue;

    const pre = await readIfExists(path.join(snapshotDir, sourceRel));
    const post = await readIfExists(staged);
    if (pre === null || post === null) continue;

    const preHeadings = extractHeadings(pre);
    const postHeadings = new Set(extractHeadings(post));
    const missing = preHeadings.filter(h => !postHeadings.has(h));
    if (missing.length === 0) continue;

    // Aggregate text of archive .tmp files matching the pattern
    let archiveText = '';
    for (const stagedRel of stagedRels) {
      if (!stagedRel.endsWith('.tmp')) continue;
      const logical = stagedRel.slice(0, -'.tmp'.length);
      if (!archivePattern.test(logical)) continue;
      const c = await readIfExists(path.join(stagedRoot, stagedRel));
      if (c !== null) archiveText += '\n' + c;
    }
    const archiveSet = new Set(extractHeadings(archiveText));
    for (const heading of missing) {
      if (!archiveSet.has(heading)) {
        findings.push(makeFinding(
          'archive_block_present', 'fail',
          `${sourceRel}: archived block heading not found in archive: ${heading.slice(0, 80)}`,
          { path: sourceRel, heading },
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
    const cites = Array.isArray(insight.source_citations) ? insight.source_citations : [];
    for (const cite of cites) {
      // Form: <relative path>#L<line> — the line number is informational; we
      // verify the file exists at memoryRoot/<rel> OR is staged for sweep.
      const hashIdx = cite.lastIndexOf('#');
      const rel = (hashIdx === -1 ? cite : cite.slice(0, hashIdx)).trim();
      if (!rel) continue;
      if (checked.has(rel)) continue;
      checked.add(rel);
      const live = path.join(memoryRoot, rel);
      if (await fileExists(live)) continue;
      if (stagedRels.has(`${rel}.tmp`)) continue;
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
    if (fromDle === null) return; // entry doesn't surface this — non-fatal
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
  const stagedRels = await walkRel(stagedRoot);
  for (const stagedRel of stagedRels) {
    if (!stagedRel.endsWith('.tmp')) continue;
    const logical = stagedRel.slice(0, -'.tmp'.length);
    if (APPEND_ONLY_PATHS.has(logical)
        || APPEND_ONLY_PREFIXES.some(p => logical.startsWith(p))) {
      findings.push(makeFinding(
        'append_only_intact', 'fail',
        `append-only file staged for rewrite: ${logical}`,
        { path: logical },
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
      // verdict is FAIL (no silent pass).
      allFindings.push(makeFinding(
        'internal_error', 'fail',
        `check ${name} threw: ${e.message}`,
        { check: name },
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
  HOT_TIER_DATE_FILES,
  APPEND_ONLY_PATHS,
  APPEND_ONLY_PREFIXES,
  FIRING_LOG_FRESHNESS_HOURS,
  parseFrontmatter,
  walkRel,
  posix,
  sha256,
  extractHeadings,
};
