// wrapup-lint — verifies hot- and warm-tier files against config caps.
//
// Returns an array of errors (empty array = PASS). Caller is responsible for exit code.
// Each error has shape: { file, kind, message, lines? }
//
// Caps come from dream.config.json:
//   - tiers.hot.max_lines_working_memory   (typical: 80)
//   - tiers.hot.max_lines_pre_action       (typical: 30)
//   - tiers.warm.max_lines_corrections     (typical: 150)
//   - tiers.warm.max_lines_session_index   (typical: 200)
//
// pre-action.md is optional — absent until P5 ships the generator. Other files are required.
//
// working-memory.md absence is a HARD FAIL — the criterion in SUCCESS-CRITERIA.md P1 #1 says
// the file MUST exist and be ≤80 lines. The first consumer's transition from context.md →
// working-memory.md is a P1-or-later cutover; until then, the linter reports missing as an error.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function lintMemory({ memoryRoot, config }) {
  const errors = [];

  const checks = [
    {
      relPath: config.tiers.hot.working_memory,
      cap: config.tiers.hot.max_lines_working_memory,
      label: 'working-memory.md',
      hint: 'Trim before wrap-up — see ARCHITECTURE.md § 2.2.',
      required: true,
    },
    {
      relPath: config.tiers.hot.pre_action,
      cap: config.tiers.hot.max_lines_pre_action,
      label: 'pre-action.md',
      hint: 'Regenerate via dream Phase 5 — see SUCCESS-CRITERIA.md P5 #6.',
      required: false,
    },
    {
      relPath: config.tiers.warm.corrections,
      cap: config.tiers.warm.max_lines_corrections,
      label: 'corrections.md',
      hint: 'Run lib/corrections-ttl.js to archive RESOLVED entries >30d old.',
      required: true,
    },
    {
      relPath: config.tiers.warm.session_index,
      cap: config.tiers.warm.max_lines_session_index,
      label: 'session-index.md',
      hint: 'Run lib/session-index-tier.js to archive entries past last-10.',
      required: true,
    },
  ];

  for (const check of checks) {
    const lines = await readLineCount(path.join(memoryRoot, check.relPath));
    if (lines === null) {
      if (check.required) {
        errors.push({
          file: check.relPath,
          kind: 'missing',
          message: `${check.label} not found at ${check.relPath} — required by ${check.label} contract.`,
        });
      }
      continue;
    }
    if (lines > check.cap) {
      errors.push({
        file: check.relPath,
        kind: 'over-cap',
        message: `${check.label} is ${lines} lines, cap ${check.cap}. ${check.hint}`,
        lines,
        cap: check.cap,
      });
    }
  }

  return errors;
}

async function readLineCount(absPath) {
  try {
    const content = await fs.readFile(absPath, 'utf8');
    return content.split('\n').length;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
