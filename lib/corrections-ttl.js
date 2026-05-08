// corrections.md TTL — moves RESOLVED entries older than 30 days to archive/corrections/YYYY-MM.md.
//
// Per docs/atomicity-contract.md § 2.1 (leaf-first sweep): archive append happens BEFORE source
// trim, so a crash mid-sweep leaves duplicated content (recoverable), never lost content.
//
// Per docs/archive-schema.md § 4.1 (conservation invariant): every line removed from corrections.md
// must appear in archive/corrections/YYYY-MM.md. We enforce this two ways:
//   (1) classifier emits keep + archive lists; serialization uses only keep
//   (2) post-write verification reads each archive and confirms every archived block's heading
//       is present, surfacing any silent loss
//
// Status detection: an entry is RESOLVED if its `**Status**:` line says RESOLVED *and* does not
// also say UNRESOLVED on the same line. Entries that mix the two (e.g., "RESOLVED primary;
// UNRESOLVED secondary") are conservatively kept, not archived — the caller's intent is unclear.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseBlocks, serializeBlocks, blockDateISO } from './parse-md-blocks.js';
import { atomicWrite, atomicAppend } from './atomic-write.js';

export const DEFAULT_TTL_DAYS = 30;
const STATUS_LINE_RE = /\*\*Status\*\*:\s*(.+)$/im;

export function isStatusResolved(text) {
  const m = text.match(STATUS_LINE_RE);
  if (!m) return false;
  const value = m[1];
  if (/\bUNRESOLVED\b/i.test(value)) return false;
  return /\bRESOLVED\b/i.test(value);
}

export function classifyCorrections(content, opts = {}) {
  const { now = new Date(), ttlDays = DEFAULT_TTL_DAYS } = opts;
  const cutoffMs = now.getTime() - ttlDays * 86_400_000;
  const blocks = parseBlocks(content);
  const keep = [];
  const archive = [];

  for (const block of blocks) {
    if (block.type !== 'item') {
      keep.push(block);
      continue;
    }
    const text = block.lines.join('\n');
    const isResolved = isStatusResolved(text);
    const dateISO = blockDateISO(block);
    const isAged = dateISO !== null && Date.parse(dateISO) < cutoffMs;
    if (isResolved && isAged) {
      archive.push({ block, monthKey: dateISO.slice(0, 7) });
    } else {
      keep.push(block);
    }
  }

  return { blocks, keep, archive };
}

export async function applyCorrectionsTTL(opts) {
  const {
    source,
    archiveDir,
    now = new Date(),
    ttlDays = DEFAULT_TTL_DAYS,
    dryRun = false,
  } = opts;

  const original = await fs.readFile(source, 'utf8');
  const { keep, archive } = classifyCorrections(original, { now, ttlDays });

  if (archive.length === 0) {
    return { archived: 0, kept: countItems(keep), byMonth: [], skipped: 'no aged-resolved entries' };
  }

  const byMonth = new Map();
  for (const { block, monthKey } of archive) {
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push(block);
  }

  const newSource = serializeBlocks(keep);

  // Pre-write line-count cross-check (cheap structural sanity).
  const origLines = original.split('\n').length;
  const keptLines = newSource.split('\n').length;
  const archivedLines = archive.reduce((sum, { block }) => sum + block.lines.length, 0);
  const drift = origLines - keptLines - archivedLines;
  if (Math.abs(drift) > 1) {
    throw new Error(
      `corrections-ttl: line-count drift = ${drift} (orig=${origLines}, kept=${keptLines}, archived=${archivedLines})`
    );
  }

  if (dryRun) {
    return {
      dryRun: true,
      archived: archive.length,
      kept: countItems(keep),
      byMonth: [...byMonth.keys()],
      lineCountDrift: drift,
    };
  }

  // Leaf-first: archive appends before source trim.
  for (const [monthKey, monthBlocks] of byMonth) {
    const archivePath = path.join(archiveDir, `${monthKey}.md`);
    const appendContent = monthBlocks.map(b => b.lines.join('\n')).join('\n') + '\n';
    await atomicAppend(archivePath, appendContent);
  }

  // Strong conservation verification: every archived block's heading must appear in the
  // matching archive file. Catches silent loss before we trim the source.
  for (const [monthKey, monthBlocks] of byMonth) {
    const archivePath = path.join(archiveDir, `${monthKey}.md`);
    const archiveContent = await fs.readFile(archivePath, 'utf8');
    for (const block of monthBlocks) {
      const heading = block.lines[0];
      if (!archiveContent.includes(heading)) {
        throw new Error(
          `corrections-ttl: conservation FAIL — heading "${heading}" missing from ${archivePath}`
        );
      }
    }
  }

  await atomicWrite(source, newSource);

  return {
    dryRun: false,
    archived: archive.length,
    kept: countItems(keep),
    byMonth: [...byMonth.keys()],
    lineCountDrift: drift,
  };
}

function countItems(blocks) {
  return blocks.filter(b => b.type === 'item').length;
}
