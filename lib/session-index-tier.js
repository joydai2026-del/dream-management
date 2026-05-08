// session-index.md tiering — keeps the most recent N session entries in the live file,
// archives older ones to archive/sessions/session-index-YYYY-MM.md (grouped by entry date).
//
// Per docs/atomicity-contract.md § 2.1: archive appends before source trim (leaf-first).
// Per docs/archive-schema.md § 4.1: every line moved out of session-index.md appears in
// the matching archive file. Post-write verification confirms every archived block's
// heading is present in its archive.
//
// Sorting: most-recent first by ISO date in entry heading. Items without a parseable date
// are kept (defensive — never archive an item we can't date).
//
// Note on header level: live session-index.md uses `### YYYY-MM-DD ...` for entries. The
// parser treats `### ` as item-start. SUCCESS-CRITERIA.md P1 #4 originally verified
// `^## 2026-` but this was a typo against the live format; updated alongside this module.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseBlocks, serializeBlocks, blockDateISO } from './parse-md-blocks.js';
import { atomicWrite, atomicAppend } from './atomic-write.js';

export const DEFAULT_KEEP_LAST_N = 10;

export function classifySessionIndex(content, opts = {}) {
  const { keepLastN = DEFAULT_KEEP_LAST_N } = opts;
  const blocks = parseBlocks(content);
  const items = blocks.filter(b => b.type === 'item');

  const datedItems = items.map(block => ({ block, dateISO: blockDateISO(block) }));
  const dated = datedItems.filter(x => x.dateISO !== null);
  const undated = datedItems.filter(x => x.dateISO === null);

  dated.sort((a, b) => b.dateISO.localeCompare(a.dateISO));

  const keptDated = dated.slice(0, keepLastN);
  const archivedDated = dated.slice(keepLastN);

  const keepItemSet = new Set([...keptDated, ...undated].map(x => x.block));
  const keep = blocks.filter(b => b.type !== 'item' || keepItemSet.has(b));

  return { blocks, keep, archive: archivedDated, undatedKept: undated.length };
}

export async function applySessionIndexTier(opts) {
  const {
    source,
    archiveDir,
    keepLastN = DEFAULT_KEEP_LAST_N,
    dryRun = false,
  } = opts;

  const original = await fs.readFile(source, 'utf8');
  const { keep, archive, undatedKept } = classifySessionIndex(original, { keepLastN });

  if (archive.length === 0) {
    return { archived: 0, kept: countItems(keep), byMonth: [], undatedKept, skipped: `≤${keepLastN} entries` };
  }

  const byMonth = new Map();
  for (const { block, dateISO } of archive) {
    const monthKey = dateISO.slice(0, 7);
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push(block);
  }

  const newSource = serializeBlocks(keep);

  const origLines = original.split('\n').length;
  const keptLines = newSource.split('\n').length;
  const archivedLines = archive.reduce((sum, { block }) => sum + block.lines.length, 0);
  const drift = origLines - keptLines - archivedLines;
  if (Math.abs(drift) > 1) {
    throw new Error(
      `session-index-tier: line-count drift = ${drift} (orig=${origLines}, kept=${keptLines}, archived=${archivedLines})`
    );
  }

  if (dryRun) {
    return {
      dryRun: true,
      archived: archive.length,
      kept: countItems(keep),
      byMonth: [...byMonth.keys()],
      undatedKept,
      lineCountDrift: drift,
    };
  }

  for (const [monthKey, monthBlocks] of byMonth) {
    const archivePath = path.join(archiveDir, `session-index-${monthKey}.md`);
    const appendContent = monthBlocks.map(b => b.lines.join('\n')).join('\n') + '\n';
    await atomicAppend(archivePath, appendContent);
  }

  // Strong conservation verification.
  for (const [monthKey, monthBlocks] of byMonth) {
    const archivePath = path.join(archiveDir, `session-index-${monthKey}.md`);
    const archiveContent = await fs.readFile(archivePath, 'utf8');
    for (const block of monthBlocks) {
      const heading = block.lines[0];
      if (!archiveContent.includes(heading)) {
        throw new Error(
          `session-index-tier: conservation FAIL — heading "${heading}" missing from ${archivePath}`
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
    undatedKept,
    lineCountDrift: drift,
  };
}

function countItems(blocks) {
  return blocks.filter(b => b.type === 'item').length;
}
