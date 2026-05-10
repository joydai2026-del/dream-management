// Stage a Phase-2 RoutePlan into archive/dreams/<date>/staged/.
//
// Per docs/atomicity-contract.md § 2, all Phase 1-4 mutations land in the
// staged/ tree first; they are sweep-renamed into the live tree only after
// both audit stages pass. This module implements the staged write side:
//
//   For each `reinforce` entry:
//     - Read live patterns/active/<name>.md
//     - Bump frontmatter `sightings` and `latest_seen` (regex edit, preserving
//       any inline `# comment` already on those lines)
//     - Replace-or-append a delimited footer block (DREAM-FOOTER-START..END)
//       so reinforcements don't accumulate one comment block per dream-pass
//     - atomicWrite to archive/dreams/<date>/staged/patterns/active/<name>.md.tmp
//
//   For each `promote` entry:
//     - If `fromReference`, read the live reference twin, strip
//       `flagsToClear` (bootstrap, demotion_phase) from its frontmatter, and
//       use that as the staged active body — preserves the human-curated
//       evidence section that the skeleton template would otherwise lose.
//     - Otherwise render the pattern-skeleton template with candidate data.
//     - atomicWrite to staged/patterns/active/<slug>.md.tmp
//
//   For each `removeReference` entry:
//     - Stage a `.tombstone` JSON sidecar at
//       staged/patterns/reference/<slug>.md.tombstone.
//     - The P5 sweep step honors tombstones by deleting the matching live
//       reference file (so the pattern moves cleanly active ↔ reference,
//       per archive-schema.md § 4.3 single-tier invariant). Until P5 ships,
//       the tombstone is forward-safe: it lives only inside the staged tree.
//
// Frontmatter mutation is regex-based, NOT round-trip parse/serialize. Pattern
// files are hand-curated with comments, alignment, and ordering that round-tripping
// would clobber. Single-field bumps preserve the file's character.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../atomic-write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(__dirname, '..', '..', 'templates', 'pattern-skeleton.md');

const FRONTMATTER_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

const FOOTER_START = '<!-- DREAM-FOOTER-START -->';
const FOOTER_END = '<!-- DREAM-FOOTER-END -->';
// Match the trailing footer block ONLY: leading-newline run + START marker +
// inner content + END marker + trailing whitespace, anchored to end of file.
// Without `/m`, `$` anchors to the string end, so a START/END pair embedded
// in body prose (e.g., a future pattern documenting the dream system itself)
// is not accidentally overwritten on every reinforcement. Reality-checker R2
// N2: this is the defensive shape.
const FOOTER_BLOCK_RE = new RegExp(
  `\\n*${FOOTER_START}[\\s\\S]*?${FOOTER_END}\\s*$`,
);

const TOMBSTONE_SCHEMA_VERSION = '1.0.0';

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bump `sightings:` and `latest_seen:` inside the frontmatter block.
 *
 * Preserves any trailing inline `# comment` on the field's line — the bumped
 * VALUE replaces the prior value, but `  # comment` survives. Without this,
 * a hand-curated annotation gets silently stripped on every nightly bump.
 *
 * If the field does not exist, insert it just before the closing `---`. Out-of-
 * frontmatter occurrences (e.g., a `sightings:` mentioned in prose body) are
 * untouched.
 *
 * @param {string} content     — original pattern file contents
 * @param {object} update      — { sightings, latestSeen }
 * @returns {string}           — new contents
 */
export function bumpPatternFrontmatter(content, update) {
  const m = content.match(FRONTMATTER_RE);
  if (!m) {
    const fm = [
      '---',
      `sightings: ${update.sightings ?? 1}`,
      `latest_seen: ${update.latestSeen}`,
      '---',
      '',
    ].join('\n');
    return fm + content;
  }
  const [whole, open, body, close] = m;
  let newBody = body;

  newBody = bumpField(newBody, 'sightings', update.sightings);
  newBody = bumpField(newBody, 'latest_seen', update.latestSeen);

  return content.replace(whole, `${open}${newBody}${close}`);
}

function bumpField(body, key, value) {
  if (value === undefined) return body;
  // Use `[ \t]*` (horizontal whitespace only) for the gap around the colon,
  // so `\s*` doesn't greedily swallow `\n` and absorb the next line as the
  // captured value when the field is empty (e.g. `sightings:\nlatest_seen:`).
  const presentRe = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*:`, 'm');
  if (presentRe.test(body)) {
    // Capture: [1] indent + key + colon + leading space, [2] value (non-space),
    // [3] trailing rest (whitespace + optional comment up to EOL).
    // `\\S*` allows empty values (e.g., `sightings:` with no value).
    const replaceRe = new RegExp(
      `^([ \\t]*${escapeRegExp(key)}[ \\t]*:[ \\t]*)(\\S*)(.*)$`,
      'm',
    );
    return body.replace(replaceRe, (_, lead, _val, rest) => `${lead}${value}${rest}`);
  }
  return body.replace(/\s*$/, `\n${key}: ${value}`);
}

function buildReinforcementFooterLines(entry, today) {
  const lines = [
    `<!-- dream reinforcement ${today}: sightings ${entry.sightingsBefore} → ${entry.sightingsAfter} -->`,
  ];
  for (const ev of (entry.evidence || []).slice(0, 5)) {
    if (!ev || !ev.path) continue;
    const ln = Number.isFinite(ev.lineNumber) ? ev.lineNumber : '?';
    const score = Number.isFinite(ev.score) ? ev.score : '?';
    lines.push(`<!-- evidence: ${ev.path}#L${ln} (importance=${score}) -->`);
  }
  return lines;
}

/**
 * Replace-or-append a delimited footer block. If the markers are present,
 * the block between them is overwritten with `footerLines`; otherwise the
 * block is appended after a single blank-line separator. Either way, the
 * output ends with exactly one trailing newline.
 */
export function replaceOrAppendFooter(content, footerLines) {
  const block = `\n\n${FOOTER_START}\n${footerLines.join('\n')}\n${FOOTER_END}\n`;
  if (FOOTER_BLOCK_RE.test(content)) {
    return content.replace(FOOTER_BLOCK_RE, block);
  }
  // Trim trailing whitespace on the body so we control the separator exactly.
  const trimmed = content.replace(/\s*$/, '');
  return trimmed + block;
}

async function readTemplate() {
  return await fs.readFile(TEMPLATE_PATH, 'utf8');
}

function renderTemplate(tpl, ctx) {
  let out = tpl;
  out = out.replace(/\{\{\s*list:evidence\s*\}\}/g, () =>
    (ctx.evidence || []).map(e => `- ${e.path}#L${e.lineNumber}`).join('\n')
      || '- (no evidence captured)',
  );
  out = out.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_, k) => {
    const v = ctx[k];
    return v === undefined || v === null ? '' : String(v);
  });
  return out;
}

/**
 * Strip the named frontmatter fields. Used for bootstrap re-promotion: when
 * a `bootstrap: true` reference twin is promoted back to active, ADR 008
 * requires both `bootstrap:` and `demotion_phase:` to be cleared on the new
 * active file.
 */
export function clearFrontmatterFields(content, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return content;
  const m = content.match(FRONTMATTER_RE);
  if (!m) return content;
  const [whole, open, body, close] = m;
  let newBody = body;
  for (const f of fields) {
    const re = new RegExp(`^\\s*${escapeRegExp(f)}\\s*:.*\\r?\\n?`, 'm');
    newBody = newBody.replace(re, '');
  }
  return content.replace(whole, `${open}${newBody}${close}`);
}

async function readReferenceContent(memoryRoot, slug) {
  const fp = path.join(memoryRoot, 'patterns', 'reference', `${slug}.md`);
  try {
    return await fs.readFile(fp, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Stage a RoutePlan.
 *
 * @param {object} args
 * @param {object} args.plan         — output of runRoute(...).plan
 * @param {string} args.dreamDir     — archive/dreams/<date>/  (from snapshot())
 * @param {string} args.memoryRoot
 * @param {string} args.today        — YYYY-MM-DD
 * @returns {Promise<{stagedFiles: string[]}>}
 */
export async function stageRoutePlan(args) {
  const { plan, dreamDir, memoryRoot, today } = args || {};
  if (!plan) throw new Error('stageRoutePlan: plan required');
  if (!dreamDir) throw new Error('stageRoutePlan: dreamDir required');
  if (!memoryRoot) throw new Error('stageRoutePlan: memoryRoot required');
  if (!today) throw new Error('stageRoutePlan: today required');

  const stagedRoot = path.join(dreamDir, 'staged');
  const stagedFiles = [];

  // Reinforcements
  for (const entry of (plan.reinforce || [])) {
    const livePath = path.join(memoryRoot, 'patterns', 'active', `${entry.pattern}.md`);
    let content;
    try {
      content = await fs.readFile(livePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    const bumped = bumpPatternFrontmatter(content, {
      sightings: entry.sightingsAfter,
      latestSeen: today,
    });
    const footerLines = buildReinforcementFooterLines(entry, today);
    const final = replaceOrAppendFooter(bumped, footerLines);
    const stagedPath = path.join(stagedRoot, 'patterns', 'active', `${entry.pattern}.md.tmp`);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await atomicWrite(stagedPath, final);
    stagedFiles.push(stagedPath);
  }

  // Promotions
  let template = null;
  for (const promo of (plan.promote || [])) {
    let body;
    if (promo.fromReference) {
      // Move the reference content with flags cleared. Preserves human-curated
      // evidence sections; falls back to the skeleton if the reference file
      // vanished between candidate construction and staging (rare but
      // observable; the dream-log will show a missing-twin note).
      const refContent = await readReferenceContent(memoryRoot, promo.slug);
      if (refContent) {
        const flagsCleared = clearFrontmatterFields(
          refContent,
          Array.isArray(promo.flagsToClear) ? promo.flagsToClear : [],
        );
        // Stamp the promotion run inside the file so the dream-log entry can
        // cross-reference the active file's first re-promotion.
        const stamp = `\n\n<!-- re-promoted from reference on ${today} via dream/pre/${today} -->\n`;
        body = flagsCleared.replace(/\s*$/, '') + stamp;
      } else {
        if (!template) template = await readTemplate();
        body = renderTemplate(template, promoTemplateCtx(promo, today));
      }
    } else {
      if (!template) template = await readTemplate();
      body = renderTemplate(template, promoTemplateCtx(promo, today));
    }
    const stagedPath = path.join(stagedRoot, 'patterns', 'active', `${promo.slug}.md.tmp`);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await atomicWrite(stagedPath, body);
    stagedFiles.push(stagedPath);
  }

  // Reference-twin removals (tombstones for the P5 sweep step)
  for (const remove of (plan.removeReference || [])) {
    if (!remove || !remove.slug) continue;
    // Reality-checker R2 N1: re-check that the live reference file still
    // exists. If it vanished between candidate construction and staging
    // (rare race), record `target_missing: true` in the tombstone so the
    // dream-log doesn't mis-attribute a removal that no-ops.
    const livePath = path.join(memoryRoot, remove.path || `patterns/reference/${remove.slug}.md`);
    let targetMissing = false;
    try {
      await fs.access(livePath);
    } catch (e) {
      if (e.code === 'ENOENT') targetMissing = true; else throw e;
    }
    const tombstonePath = path.join(
      stagedRoot, 'patterns', 'reference', `${remove.slug}.md.tombstone`,
    );
    const tombstone = JSON.stringify({
      schema_version: TOMBSTONE_SCHEMA_VERSION,
      removed_path: remove.path || `patterns/reference/${remove.slug}.md`,
      reason: remove.reason || 'promoted to patterns/active/',
      promotion_run: `dream/pre/${today}`,
      timestamp: new Date().toISOString(),
      target_missing: targetMissing,
    }, null, 2);
    await fs.mkdir(path.dirname(tombstonePath), { recursive: true });
    await atomicWrite(tombstonePath, tombstone + '\n');
    stagedFiles.push(tombstonePath);
  }

  return { stagedFiles };
}

function promoTemplateCtx(promo, today) {
  return {
    slug: promo.slug,
    title: promo.slug,
    today,
    importance: promo.importance,
    journalMentions: promo.journalMentions,
    firingHits: promo.firingHits,
    weightedEvidence: promo.weightedEvidence?.toFixed?.(2) ?? promo.weightedEvidence,
    threshold: promo.threshold,
    evidence: promo.evidence,
  };
}

export const _internals = {
  TEMPLATE_PATH,
  FRONTMATTER_RE,
  FOOTER_START,
  FOOTER_END,
  FOOTER_BLOCK_RE,
};
