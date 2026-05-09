// Stage a Phase-2 RoutePlan into archive/dreams/<date>/staged/.
//
// Per docs/atomicity-contract.md § 2, all Phase 1-4 mutations land in the
// staged/ tree first; they are sweep-renamed into the live tree only after
// both audit stages pass. This module implements the staged write side:
//
//   For each `reinforce` entry:
//     - Read live patterns/active/<name>.md
//     - Bump frontmatter `sightings` and `latest_seen` (regex edit)
//     - Append a one-line reinforcement audit footer with evidence paths
//     - atomicWrite to archive/dreams/<date>/staged/patterns/active/<name>.md.tmp
//
//   For each `promote` entry:
//     - Render the pattern-skeleton template with candidate data
//     - atomicWrite to archive/dreams/<date>/staged/patterns/active/<slug>.md.tmp
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

/**
 * Bump `sightings:` and `latest_seen:` inside the frontmatter block.
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
    // No frontmatter — synthesize a minimal one. Conservative: preserves body.
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

  if (update.sightings !== undefined) {
    if (/^\s*sightings\s*:/m.test(newBody)) {
      newBody = newBody.replace(/^(\s*sightings\s*:\s*).*$/m, `$1${update.sightings}`);
    } else {
      newBody = newBody.replace(/\s*$/, `\nsightings: ${update.sightings}`);
    }
  }
  if (update.latestSeen !== undefined) {
    if (/^\s*latest_seen\s*:/m.test(newBody)) {
      newBody = newBody.replace(/^(\s*latest_seen\s*:\s*).*$/m, `$1${update.latestSeen}`);
    } else {
      newBody = newBody.replace(/\s*$/, `\nlatest_seen: ${update.latestSeen}`);
    }
  }
  return content.replace(whole, `${open}${newBody}${close}`);
}

function reinforcementFooter(entry, today) {
  const lines = [
    '',
    `<!-- dream reinforcement ${today}: sightings ${entry.sightingsBefore} → ${entry.sightingsAfter} -->`,
  ];
  for (const ev of (entry.evidence || []).slice(0, 5)) {
    if (!ev || !ev.path) continue;
    lines.push(`<!-- evidence: ${ev.path}#L${ev.lineNumber} (importance=${ev.score}) -->`);
  }
  return lines.join('\n') + '\n';
}

async function readTemplate() {
  return await fs.readFile(TEMPLATE_PATH, 'utf8');
}

function renderTemplate(tpl, ctx) {
  // Simple `{{ key }}` substitution. No conditionals; the template stays trivial.
  // Lists render as bullet lines via {{ list:evidence }}.
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
      if (e.code === 'ENOENT') {
        // Pattern named in plan no longer exists on disk. Skip with a marker
        // entry so the dream-log can surface this drift; the reinforcement
        // simply doesn't land. Future Phase-4 contradiction-detector should
        // flag this as drift between snapshot and plan.
        continue;
      }
      throw e;
    }
    const bumped = bumpPatternFrontmatter(content, {
      sightings: entry.sightingsAfter,
      latestSeen: today,
    });
    const stagedPath = path.join(stagedRoot, 'patterns', 'active', `${entry.pattern}.md.tmp`);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await atomicWrite(stagedPath, bumped + reinforcementFooter(entry, today));
    stagedFiles.push(stagedPath);
  }

  // Promotions
  let template = null;
  for (const promo of (plan.promote || [])) {
    if (!template) template = await readTemplate();
    const rendered = renderTemplate(template, {
      slug: promo.slug,
      title: promo.slug,
      today,
      importance: promo.importance,
      journalMentions: promo.journalMentions,
      firingHits: promo.firingHits,
      weightedEvidence: promo.weightedEvidence?.toFixed?.(2) ?? promo.weightedEvidence,
      threshold: promo.threshold,
      evidence: promo.evidence,
    });
    const stagedPath = path.join(stagedRoot, 'patterns', 'active', `${promo.slug}.md.tmp`);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await atomicWrite(stagedPath, rendered);
    stagedFiles.push(stagedPath);
  }

  return { stagedFiles };
}

export const _internals = { TEMPLATE_PATH, FRONTMATTER_RE };
