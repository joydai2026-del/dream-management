#!/usr/bin/env node
// CLI entry for the wrap-up linter.
//
// Usage:
//   wrapup-lint --config <path-to-dream.config.json> [--memory-root <override>]
//
// Exit codes:
//   0 — PASS (no errors)
//   1 — FAIL (errors printed to stderr)
//   2 — invocation error (bad args, config not found)

import { promises as fs } from 'node:fs';
import { lintMemory } from '../lib/wrapup-lint.js';

async function main() {
  const args = process.argv.slice(2);
  let configPath = null;
  let memoryRootOverride = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') configPath = args[++i];
    else if (args[i] === '--memory-root') memoryRootOverride = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`wrapup-lint: unknown arg: ${args[i]}`);
      printHelp();
      process.exit(2);
    }
  }

  if (!configPath) {
    console.error('wrapup-lint: --config <path> is required');
    printHelp();
    process.exit(2);
  }

  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (e) {
    console.error(`wrapup-lint: failed to read config at ${configPath}: ${e.message}`);
    process.exit(2);
  }

  const memoryRoot = memoryRootOverride ?? config.memory_root;
  if (!memoryRoot) {
    console.error('wrapup-lint: memory_root not set in config and --memory-root not provided');
    process.exit(2);
  }

  const errors = await lintMemory({ memoryRoot, config });

  if (errors.length === 0) {
    console.log(`wrapup-lint PASS (${memoryRoot})`);
    process.exit(0);
  }

  console.error(`wrapup-lint FAIL (${memoryRoot}):`);
  for (const err of errors) {
    console.error(`  [${err.kind}] ${err.file}: ${err.message}`);
  }
  process.exit(1);
}

function printHelp() {
  console.error(`
wrapup-lint — verify memory tier file caps before wrap-up commits

Usage:
  wrapup-lint --config <path> [--memory-root <override>]

Args:
  --config       path to dream.config.json
  --memory-root  override config's memory_root (useful for fixture tests)
`.trim());
}

main().catch(e => {
  console.error(`wrapup-lint: unexpected error: ${e.stack ?? e.message}`);
  process.exit(2);
});
