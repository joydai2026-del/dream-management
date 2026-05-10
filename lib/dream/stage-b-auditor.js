// Stage B — adversarial cross-model audit (GPT-5 / Codex CLI).
//
// Per atomicity-contract.md § 5 + ADR 003 (cross-model auditor) + ARCHITECTURE.md
// § 3.3. Stage B runs AFTER Stage A passes; it asks a different model family
// (GPT-5 via the Codex CLI) to attack the staged tree the same-model worker
// can't audit objectively.
//
// Verdict:
//   PASS  — auditor found nothing actionable; sweep proceeds
//   WARN  — non-fatal findings; sweep proceeds, mitigation logged
//   FAIL  — auditor found at least one structural / semantic break; sweep aborts
//
// Invocation contract (per JJ briefing 2026-05-10):
//   - Command MUST be invoked with `< /dev/null` to close stdin (codex hangs
//     forever waiting for input otherwise). The `commandRunner` shim
//     enforces this by spawning with stdin: 'ignore'.
//   - Default `commandLine` is `codex exec --skip-git-repo-check`; the
//     prompt is passed as the trailing positional argument or via stdin
//     redirect — but stdin is closed, so prompt goes via argv.
//   - Default timeout 600s (codex sometimes takes 3-5 min on a full audit).
//
// Output parsing (per templates/codex-audit-prompt.md):
//   The auditor MUST emit a leading `VERDICT: PASS|WARN|FAIL` line, then
//   `MODEL:`, `DURATION_S:`, then `FINDINGS:` blocks, then `NOTES:`.
//   Anything else in the response is treated as `notes`.
//
// Test injection:
//   `commandRunner` is the only side-effecting dependency. Tests pass a
//   stub that returns `{ stdout, stderr, exitCode }` without touching disk
//   or the network. Production wires `defaultCommandRunner` (spawn-based).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT_TEMPLATE = path.resolve(
  __dirname, '..', '..', 'templates', 'codex-audit-prompt.md',
);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_COMMAND = 'codex exec --skip-git-repo-check';

// ---- public API -------------------------------------------------------

/**
 * Run Stage B against a staged dream tree.
 *
 * @param {object} opts
 * @param {string} opts.memoryRoot
 * @param {string} opts.dreamDir
 * @param {string} opts.today                YYYY-MM-DD
 * @param {string} [opts.workerVerdict]      verdict the worker emitted (default 'PASS-TENTATIVE')
 * @param {string} [opts.commandLine]        executable + args (default 'codex exec --skip-git-repo-check')
 * @param {string} [opts.promptTemplatePath] path to prompt md (default templates/codex-audit-prompt.md)
 * @param {number} [opts.timeoutMs]          default 600s
 * @param {string} [opts.model]              label only — recorded into result.model
 * @param {function} [opts.commandRunner]    test injection: ({command, args, prompt, timeoutMs}) → {stdout,stderr,exitCode}
 * @returns {Promise<{
 *   verdict: 'PASS'|'WARN'|'FAIL',
 *   findings: Array<{severity, category, path, message}>,
 *   model: string,
 *   notes: string,
 *   summary: { invocation_seconds, parse_ok, raw_stdout_len, raw_stderr_len },
 *   raw: { command, args, exitCode, stdout, stderr },
 * }>}
 */
export async function runStageB(opts) {
  const start = Date.now();
  const {
    memoryRoot,
    dreamDir,
    today,
    workerVerdict = 'PASS-TENTATIVE',
    commandLine = DEFAULT_COMMAND,
    promptTemplatePath = DEFAULT_PROMPT_TEMPLATE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    model = 'gpt-5-codex',
    commandRunner = defaultCommandRunner,
  } = opts || {};
  if (!memoryRoot) throw new Error('runStageB: memoryRoot required');
  if (!dreamDir) throw new Error('runStageB: dreamDir required');
  if (!today) throw new Error('runStageB: today required');
  if (!ISO_DATE_RE.test(today)) {
    throw new Error(`runStageB: today must match YYYY-MM-DD; got '${today}'`);
  }

  const prompt = await buildPrompt({ promptTemplatePath, dreamDir, workerVerdict });
  const [command, ...args] = parseCommandLine(commandLine);

  let runResult;
  try {
    runResult = await commandRunner({ command, args, prompt, timeoutMs });
  } catch (e) {
    return {
      verdict: 'FAIL',
      findings: [{
        severity: 'fail',
        category: 'invocation_error',
        path: null,
        message: `stage-B command failed to invoke: ${e.message}`,
      }],
      model,
      notes: '',
      summary: {
        invocation_seconds: (Date.now() - start) / 1000,
        parse_ok: false,
        raw_stdout_len: 0,
        raw_stderr_len: 0,
      },
      raw: { command, args, exitCode: -1, stdout: '', stderr: e.message },
    };
  }

  const { stdout, stderr, exitCode } = runResult;
  const parsed = parseStageBOutput(stdout);
  const summary = {
    invocation_seconds: (Date.now() - start) / 1000,
    parse_ok: parsed.parseOk,
    raw_stdout_len: stdout.length,
    raw_stderr_len: stderr.length,
  };

  // Verdict resolution: if exit code non-zero AND stdout didn't carry a
  // VERDICT line, treat as FAIL with an invocation-error finding. Codex
  // CLI exits 0 on a successful PROMPT response even when the response is
  // FAIL — exit non-zero means the CLI itself crashed.
  if (exitCode !== 0 && !parsed.parseOk) {
    return {
      verdict: 'FAIL',
      findings: [{
        severity: 'fail',
        category: 'invocation_error',
        path: null,
        message: `stage-B command exited ${exitCode} with no parseable verdict (stderr: ${stderr.slice(0, 200)})`,
      }],
      model,
      notes: '',
      summary,
      raw: { command, args, exitCode, stdout, stderr },
    };
  }

  if (!parsed.parseOk) {
    // CLI exited 0 but no VERDICT line — treat as FAIL (fail-closed on
    // unparseable output, mirrors Stage A's stance).
    return {
      verdict: 'FAIL',
      findings: [{
        severity: 'fail',
        category: 'parse_error',
        path: null,
        message: `stage-B output did not contain a VERDICT line (first 200 chars: ${stdout.slice(0, 200).replace(/\s+/g, ' ')})`,
      }],
      model,
      notes: '',
      summary,
      raw: { command, args, exitCode, stdout, stderr },
    };
  }

  return {
    verdict: parsed.verdict,
    findings: parsed.findings,
    model,
    notes: parsed.notes,
    summary,
    raw: { command, args, exitCode, stdout, stderr },
  };
}

// ---- prompt building --------------------------------------------------

async function buildPrompt({ promptTemplatePath, dreamDir, workerVerdict }) {
  let template;
  try { template = await fs.readFile(promptTemplatePath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`runStageB: prompt template not found at ${promptTemplatePath}`);
    }
    throw e;
  }
  const stagedListing = await listStagedTree(path.join(dreamDir, 'staged'));
  return template
    .replace(/\{\{DREAM_DIR\}\}/g, dreamDir)
    .replace(/\{\{WORKER_VERDICT\}\}/g, workerVerdict)
    .replace(/\{\{STAGED_FILE_LIST\}\}/g, stagedListing);
}

async function listStagedTree(stagedRoot) {
  const lines = [];
  async function recurse(dir, prefix) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        lines.push(`  ${rel} (SYMLINK — refused by sweep)`);
        continue;
      }
      if (entry.isDirectory()) {
        await recurse(path.join(dir, entry.name), rel);
        continue;
      }
      if (entry.isFile()) {
        let stat;
        try { stat = await fs.stat(path.join(dir, entry.name)); }
        catch { continue; }
        lines.push(`  ${rel} (${stat.size} bytes)`);
      }
    }
  }
  await recurse(stagedRoot, '');
  if (lines.length === 0) return '  (staged tree is empty)';
  return lines.join('\n');
}

function parseCommandLine(line) {
  // Minimal POSIX-style splitter; quoted args supported. The default is
  // `codex exec --skip-git-repo-check`, which has no quotes; preserved
  // for completeness in case JJ swaps in a complex wrapper.
  const out = [];
  let buf = '';
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) { q = null; continue; }
      buf += c;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === ' ' || c === '\t') {
      if (buf) { out.push(buf); buf = ''; }
    } else {
      buf += c;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ---- output parser ----------------------------------------------------

const VERDICT_RE = /^VERDICT:\s*(PASS|WARN|FAIL)\s*$/m;
const MODEL_RE = /^MODEL:\s*(.+)$/m;
const FINDINGS_BLOCK_RE = /(?:^|\n)FINDINGS:\s*\n([\s\S]*?)(?=\n[A-Z_]+:\s*$|\n[A-Z_]+:\s*\n|$)/;
const NOTES_BLOCK_RE = /(?:^|\n)NOTES:\s*\n([\s\S]*?)$/;

export function parseStageBOutput(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { parseOk: false, verdict: null, findings: [], notes: '' };
  }
  const verdictMatch = text.match(VERDICT_RE);
  if (!verdictMatch) {
    return { parseOk: false, verdict: null, findings: [], notes: '' };
  }
  const verdict = verdictMatch[1];
  const findingsBlock = (text.match(FINDINGS_BLOCK_RE) || [])[1] || '';
  const findings = parseFindings(findingsBlock);
  const notesBlock = (text.match(NOTES_BLOCK_RE) || [])[1] || '';
  return {
    parseOk: true,
    verdict,
    findings,
    notes: notesBlock.trim(),
  };
}

function parseFindings(block) {
  // Each finding starts at `- severity:` and contains key:value lines until
  // the next `- severity:` or end of block.
  const out = [];
  const lines = block.split('\n');
  let cur = null;
  for (const line of lines) {
    const startMatch = line.match(/^-\s*severity:\s*(warn|fail)\s*$/);
    if (startMatch) {
      if (cur) out.push(finalizeFinding(cur));
      cur = { severity: startMatch[1], category: 'other', path: null, message: '' };
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s+([a-zA-Z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (key === 'severity') {
      // mid-block severity is allowed only as the start marker; treat as new.
      if (cur.message) {
        out.push(finalizeFinding(cur));
        cur = { severity: val, category: 'other', path: null, message: '' };
      } else {
        cur.severity = val;
      }
      continue;
    }
    if (key === 'category') cur.category = val.trim() || 'other';
    else if (key === 'path') cur.path = val.trim() === 'null' || val.trim() === '' ? null : val.trim();
    else if (key === 'message') cur.message = val.trim();
  }
  if (cur) out.push(finalizeFinding(cur));
  return out.filter(f => f && f.severity);
}

function finalizeFinding(f) {
  if (!f) return null;
  if (!['warn', 'fail'].includes(f.severity)) return null;
  return {
    severity: f.severity,
    category: f.category || 'other',
    path: f.path || null,
    message: f.message || '',
  };
}

// ---- default command runner ------------------------------------------

/**
 * Spawn-based command runner. stdin is closed (`ignore`) per JJ's invocation
 * rule; the prompt is passed via the FINAL positional argument to the codex
 * CLI. Captures stdout + stderr; enforces timeoutMs.
 */
function defaultCommandRunner({ command, args, prompt, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args, prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Hard kill after 5s if SIGTERM didn't take effect.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`stage-B command timed out after ${timeoutMs}ms (signal ${signal})`));
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

export const _internals = {
  DEFAULT_COMMAND,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_TIMEOUT_MS,
  parseCommandLine,
  parseFindings,
  buildPrompt,
  listStagedTree,
};
