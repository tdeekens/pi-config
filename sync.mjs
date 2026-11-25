#!/usr/bin/env node
// Sync an allowlisted subset of ~/.pi/agent with this repo, using layered config.
//
//   ./sync.mjs pull   build ~/.pi/agent from the repo base plus overlays
//   ./sync.mjs push   copy allowlisted files from ~/.pi/agent back to the repo or siblings
//
// Requires Node 18.3+ (no dependencies).
//
// Layers, later wins:
//   1. repo base: this directory (committed, generic), e.g. settings.json, mcp.json
//      (none for LOCAL_ONLY files such as budget.json)
//   2. sibling override: <name>.local.json next to a MERGED file, e.g. settings.local.json,
//      mcp.local.json, budget.local.json. Gitignored.
//   3. overlays: PI_CONFIG_OVERLAYS, a colon-separated list of directories.
//      Default: ./.local (gitignored). Example for a work machine:
//        PI_CONFIG_OVERLAYS="$HOME/Development/pi-config/.local:$HOME/work/pi-overlay" ./sync.mjs pull
//
// Sibling *.local.json files and .local/ are gitignored. Keep credentials out of them
// and use ${ENV_VAR} references instead.
//
// Merge rules for MERGED files:
//   - objects merge recursively
//   - arrays of strings are unioned, keeping order (e.g. packages)
//   - any other array or value is replaced by the later layer
// Other files: the last layer that has the file wins (whole-file replace).
// push writes LOCAL_ONLY files back to their sibling <name>.local.json.
//
// Only the files in FILES are ever touched. Everything else in ~/.pi/agent
// (auth, sessions, caches, installed packages) stays out of git.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
const OVERLAYS = (process.env.PI_CONFIG_OVERLAYS || join(REPO_DIR, '.local'))
  .split(delimiter)
  .filter(Boolean);

const FILES = [
  'settings.json',
  'mcp.json',
  'budget.json',
  'pi-pretty.json',
  'web-search.json',
  'themes/kanagawa-wave.json',
  'themes/opencode-ayu.json',
  'themes/opencode-catppuccin.json',
  'themes/opencode-kanagawa.json',
  'themes/opencode-tokyonight.json',
  'themes/princess-nam-rom.json',
  'extensions/budget/index.ts',
  'extensions/budget/render.ts',
  'extensions/budget/test.ts',
  'extensions/context-meter/index.ts',
  'extensions/context-meter/breakdown.ts',
  'extensions/context-meter/meter.ts',
  'extensions/context-meter/test.ts',
  'extensions/footer-segments/index.ts',
  'extensions/footer-segments/render.ts',
  'extensions/footer-segments/test.ts',
  'extensions/answer.ts',
  'extensions/goal.ts',
  'extensions/session-breakdown.ts',
  'extensions/powerline-footer/theme.json',
  'vibes/pirate.txt',
];
const MERGED = new Set(['settings.json', 'mcp.json', 'budget.json']);
const LOCAL_ONLY = new Set(['budget.json']); // no repo base; comes from sibling and overlays

// Matches credential-looking lines. Matching lines are reported without their content.
const SECRET_RE =
  /"(apiKey|api_key|token|secret|password|authorization)"\s*:\s*"[^"]+"|(^|[^A-Za-z0-9])(sk-|gho_|ghp_)[A-Za-z0-9_-]{20,}/i;

const siblingOf = (file) => file.replace(/\.json$/, '.local.json');
const exists = (path) => existsSync(path);
const show = (path) => (path.startsWith(`${REPO_DIR}/`) ? relative(REPO_DIR, path) : path);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// Deep-merge `b` over `a` using the rules in the header.
function merge(a, b) {
  if (isPlainObject(a) && isPlainObject(b)) {
    const out = { ...a };
    for (const [key, value] of Object.entries(b)) {
      out[key] = Object.hasOwn(a, key) ? merge(a[key], value) : value;
    }
    return out;
  }
  if (isStringArray(a) && isStringArray(b)) return [...new Set([...a, ...b])];
  return b;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${show(path)}: ${error.message}`);
  }
}

async function writeAtomic(path, data) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function pull() {
  console.log(`Building ${AGENT_DIR} from base + overlays (${OVERLAYS.join(', ')}):`);
  for (const file of FILES) {
    const sources = [];
    if (!LOCAL_ONLY.has(file) && exists(join(REPO_DIR, file))) {
      sources.push(join(REPO_DIR, file));
    }
    if (MERGED.has(file) && exists(join(REPO_DIR, siblingOf(file)))) {
      sources.push(join(REPO_DIR, siblingOf(file)));
    }
    for (const overlay of OVERLAYS) {
      if (exists(join(overlay, file))) sources.push(join(overlay, file));
    }

    if (sources.length === 0) {
      console.log(`  ${file} (missing, skipped)`);
      continue;
    }

    const dst = join(AGENT_DIR, file);
    await mkdir(dirname(dst), { recursive: true });
    if (MERGED.has(file)) {
      let doc;
      for (const source of sources) {
        const value = await readJson(source);
        doc = doc === undefined ? value : merge(doc, value);
      }
      await writeAtomic(dst, `${JSON.stringify(doc, null, 2)}\n`);
      console.log(`  ${file} (merged: ${sources.length} layers)`);
    } else {
      const source = sources.at(-1);
      await copyFile(source, dst);
      console.log(`  ${file} (from ${show(source)})`);
    }
  }
}

async function checkSecrets(files) {
  const hits = [];
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (SECRET_RE.test(line)) hits.push(`  ${show(file)}:${index + 1}`);
    });
  }
  if (hits.length > 0) {
    throw new Error(`Refusing to continue: possible secret found:\n${hits.join('\n')}`);
  }
}

async function push() {
  console.log(`Pushing from ${AGENT_DIR}:`);
  const toCheck = [];
  for (const file of FILES) {
    if (!exists(join(AGENT_DIR, file))) {
      console.log(`  ${file} (missing, skipped)`);
    } else if (LOCAL_ONLY.has(file)) {
      console.log(`  ${file} (local only -> ${siblingOf(file)})`);
    } else if (MERGED.has(file)) {
      console.log(`  ${file} (composed file: edit the repo base or overlays, not ~/.pi/agent; skipped)`);
    } else {
      toCheck.push(join(AGENT_DIR, file));
    }
  }
  await checkSecrets(toCheck);

  for (const file of FILES) {
    const src = join(AGENT_DIR, file);
    if (!exists(src)) continue;
    let dst;
    if (LOCAL_ONLY.has(file)) {
      dst = join(REPO_DIR, siblingOf(file));
    } else if (MERGED.has(file)) {
      continue;
    } else {
      dst = join(REPO_DIR, file);
      console.log(`  ${file}`);
    }
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}

const USAGE = 'usage: sync.mjs <pull|push> [--help]';

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const [command] = parsed.positionals;
  if (parsed.values.help) {
    console.log(USAGE);
    return;
  }
  if (command !== 'pull' && command !== 'push') {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  try {
    if (command === 'pull') await pull();
    else await push();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

await main();
