#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verify as runVerify } from './verify.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

const HOME = process.env.CURSORDOCTRINE_HOME || homedir();

const hooksSrc = join(pkgRoot, 'hooks');
const hooksJsonSrc = join(pkgRoot, 'hooks.json');
const hooksDst = join(HOME, '.agents', 'hooks');
const cursorDst = join(HOME, '.cursor');
const skillSrc = join(pkgRoot, 'skills', 'anti-slop');
const skillDst = join(cursorDst, 'skills', 'anti-slop');
const pendingDir = join(cursorDst, '.hooks-pending');
const hooksJsonDst = join(cursorDst, 'hooks.json');

const LEGACY_HOOK_FILES = [
  'intent-precompile.ps1', 'intent-precompile.sh',
  'step0-gate.ps1', 'step0-gate.sh',
  'scope-refresh.ps1', 'scope-refresh.sh',
  'scope-drain.ps1', 'scope-drain.sh',
  'scope-git-sweep.ps1', 'scope-git-sweep.sh',
  'milestone-verify.ps1', 'milestone-verify.sh',
  'intent-anchor.ps1', 'intent-anchor.sh',
  'permission-gate.ps1', 'permission-gate.sh',
  'final-review.ps1', 'final-review.sh',
  'inject-doctrine.ps1', 'inject-doctrine.sh',
  'hook-common.ps1', 'hook-common.sh',
  'anti-slop-audit.ps1', 'anti-slop-audit.sh',
  'post-tool-use.ps1', 'post-tool-use.sh',
  'scope-gate-audit.ps1', 'scope-gate-audit.sh',
  'self-review-trigger.ps1', 'self-review-trigger.sh',
  'semantic-density-audit.ps1', 'semantic-density-audit.sh',
  'subagent-stop-review.ps1', 'subagent-stop-review.sh',
  'biome-advisory.ps1', 'biome-advisory.sh',
  'semgrep-advisory.ps1', 'semgrep-advisory.sh',
  'anchor-set-nudge.ps1', 'anchor-set-nudge.sh',
  'minimal-edit-audit.ps1', 'minimal-edit-audit.sh',
  'cleanup-doctrine.md', 'self-review.md',
];

const LEGACY_CURSOR_FILES = [
  'inject-doctrine.ps1', 'inject-doctrine.sh',
  'doctrine.md', 'pre-compile.md', 'USER-RULES.md', 'declared-editing.md',
];

function ourKeys() {
  return readdirSync(hooksSrc).filter((f) => f.endsWith('.mjs'));
}

function commandReferencesOurPath(command, key) {
  if (typeof command !== 'string') return false;
  const c = command.replaceAll('\\', '/').toLowerCase();
  const k = key.toLowerCase();
  return c.includes(`~/.agents/hooks/${k}`) || c.includes(`/.agents/hooks/${k}`);
}

function isOurs(command, keys) {
  return typeof command === 'string' && keys.some((k) => commandReferencesOurPath(command, k));
}

function keyOf(command, keys) {
  if (typeof command !== 'string') return undefined;
  return keys.find((k) => commandReferencesOurPath(command, k));
}

const LEGACY_CMD_RE = /([\w.\-]+)\.(ps1|sh)\b/;
function isStaleOurs(command) {
  if (typeof command !== 'string') return false;
  const m = command.match(LEGACY_CMD_RE);
  if (m) {
    const fname = `${m[1]}.${m[2]}`;
    return LEGACY_HOOK_FILES.includes(fname) || LEGACY_CURSOR_FILES.includes(fname);
  }
  return false;
}

function rmBestEffort(path, opts = { force: true }) {
  if (existsSync(path)) rmSync(path, opts);
}

function mergeHooks(existing, incoming, keys) {
  const out = structuredClone(existing);
  if (out.version === undefined) out.version = incoming.version;
  if (!out.hooks || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) out.hooks = {};
  for (const [event, entries] of Object.entries(incoming.hooks || {})) {
    if (!Array.isArray(out.hooks[event])) out.hooks[event] = [];
    const cur = out.hooks[event];
    for (const entry of entries) {
      const k = keyOf(entry.command, keys);
      const i = cur.findIndex((x) => x && keyOf(x.command, keys) === k && k !== undefined);
      if (i >= 0) cur[i] = entry;
      else cur.push(entry);
    }
    const live = cur.filter((x) => x && !isStaleOurs(x.command));
    const foreign = live.filter((x) => x && !isOurs(x.command, keys));
    const reordered = [];
    const used = new Set();
    for (const entry of entries) {
      const k = keyOf(entry.command, keys);
      if (!k || !isOurs(entry.command, keys)) continue;
      const found = live.find((x) => x && keyOf(x.command, keys) === k);
      if (found) { reordered.push(found); used.add(k); }
    }
    for (const x of live) {
      const k = keyOf(x?.command, keys);
      if (isOurs(x?.command, keys) && k && !used.has(k)) reordered.push(x);
    }
    out.hooks[event] = [...reordered, ...foreign];
  }
  for (const event of Object.keys(out.hooks)) {
    if (!Array.isArray(out.hooks[event])) continue;
    out.hooks[event] = out.hooks[event].filter((x) => x && !isStaleOurs(x.command));
    if (out.hooks[event].length === 0) delete out.hooks[event];
  }
  let preserved = 0;
  for (const entries of Object.values(out.hooks)) {
    if (Array.isArray(entries)) preserved += entries.filter((x) => !isOurs(x?.command, keys)).length;
  }
  return { merged: out, preserved };
}

function removeOurPack() {
  const removed = [];
  const keys = ourKeys();
  const shipped = readdirSync(hooksSrc).filter((f) => !f.startsWith('__pycache__'));

  for (const f of shipped) {
    const p = join(hooksDst, f);
    if (existsSync(p)) { rmSync(p, { force: true }); removed.push(`~/.agents/hooks/${f}`); }
  }
  for (const f of LEGACY_HOOK_FILES) {
    const p = join(hooksDst, f);
    if (existsSync(p)) { rmSync(p, { force: true }); removed.push(`~/.agents/hooks/${f}`); }
  }
  for (const f of LEGACY_CURSOR_FILES) {
    const p = join(cursorDst, f);
    if (existsSync(p)) { rmSync(p, { force: true }); removed.push(`~/.cursor/${f}`); }
  }
  if (existsSync(skillDst)) {
    rmSync(skillDst, { recursive: true, force: true });
    removed.push('~/.cursor/skills/anti-slop/');
  }
  if (existsSync(pendingDir)) {
    rmSync(pendingDir, { recursive: true, force: true });
    removed.push('~/.cursor/.hooks-pending/');
  }

  if (existsSync(hooksJsonDst)) {
    try {
      const existing = JSON.parse(readFileSync(hooksJsonDst, 'utf8'));
      let foreign = 0;
      for (const [event, entries] of Object.entries(existing.hooks || {})) {
        if (!Array.isArray(entries)) continue;
        existing.hooks[event] = entries.filter(
          (x) => !x || (!isOurs(x.command, keys) && !isStaleOurs(x.command))
        );
        foreign += existing.hooks[event].length;
        if (existing.hooks[event].length === 0) delete existing.hooks[event];
      }
      if (foreign === 0) {
        rmSync(hooksJsonDst, { force: true });
        removed.push('~/.cursor/hooks.json');
      } else {
        writeFileSync(hooksJsonDst, JSON.stringify(existing, null, 2) + '\n');
        removed.push(`~/.cursor/hooks.json (ours stripped, ${foreign} foreign entr${foreign === 1 ? 'y' : 'ies'} kept)`);
      }
    } catch { /* unreadable: leave untouched */ }
  }

  return removed;
}

function install() {
  console.log(`cursordoctrine ${pkg.version} — installing the Node hook pack into ${HOME}`);
  const removedPrior = removeOurPack();
  if (removedPrior.length) console.log(`  removed prior install  ${removedPrior.length} item(s)`);

  mkdirSync(hooksDst, { recursive: true });
  mkdirSync(cursorDst, { recursive: true });

  cpSync(hooksSrc, hooksDst, {
    recursive: true,
    filter: (src) => !src.includes('__pycache__'),
  });

  const incoming = JSON.parse(readFileSync(hooksJsonSrc, 'utf8'));
  if (process.platform === 'win32') {
    const homeFwd = HOME.replaceAll('\\', '/');
    for (const entries of Object.values(incoming.hooks || {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry && typeof entry.command === 'string') {
          entry.command = entry.command.replace(/~\/agents\/hooks\//g, `${homeFwd}/.agents/hooks/`);
        }
      }
    }
  }
  const keys = ourKeys();

  let hooksJsonNote = 'written';
  let result = incoming;
  if (existsSync(hooksJsonDst)) {
    let existing = null;
    try {
      existing = JSON.parse(readFileSync(hooksJsonDst, 'utf8'));
    } catch {
      const bak = `${hooksJsonDst}.bak-${Date.now()}`;
      cpSync(hooksJsonDst, bak);
      hooksJsonNote = `existing file was invalid JSON — backed up to ${bak}, wrote fresh`;
    }
    if (existing) {
      const { merged, preserved } = mergeHooks(existing, incoming, keys);
      result = merged;
      hooksJsonNote = preserved > 0 ? `merged (${preserved} foreign entr${preserved === 1 ? 'y' : 'ies'} preserved)` : 'merged';
    }
  }
  writeFileSync(hooksJsonDst, JSON.stringify(result, null, 2) + '\n');

  rmSync(skillDst, { recursive: true, force: true });
  cpSync(skillSrc, skillDst, {
    recursive: true,
    filter: (src) => !src.includes('__pycache__'),
  });

  const hookFiles = readdirSync(hooksDst);
  console.log('');
  console.log(`  ~/.agents/hooks        ${hookFiles.length} files (Node engine + payloads)`);
  console.log(`  ~/.cursor/hooks.json   ${hooksJsonNote}`);
  console.log('  ~/.cursor/skills       anti-slop (SKILL.md + scanner)');
  console.log('');

  const missing = prereqProblems();
  for (const m of missing) console.log(`  warning: ${m}`);
  if (missing.length) console.log('');

  console.log('Done. Restart Cursor — hooks.json is read at startup.');
  console.log('Next: npx cursordoctrine verify');
}

function prereqProblems() {
  const problems = [];
  if (!canRun('node', ['--version'])) {
    problems.push('node not found on PATH — the hooks will not run until it is installed.');
  }
  if (!pythonCmd()) {
    problems.push('Python 3.9+ not found — the anti-slop scanner and minimality metric are unavailable.');
  }
  if (!canRun('git', ['--version'])) {
    problems.push('git not found on PATH — scope-git-sweep and final-review diff/numstat are unavailable.');
  }
  return problems;
}

function canRun(cmd, args) {
  const r = spawnSync(cmd, args, { timeout: 15000, windowsHide: true, stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function pythonCmd() {
  for (const c of process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']) {
    if (canRun(c, ['-c', ''])) return c;
  }
  return undefined;
}

function runHook(file, payloadObj) {
  const r = spawnSync('node', [file], {
    input: JSON.stringify(payloadObj),
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    env: { ...process.env, HOME, USERPROFILE: HOME },
  });
  if (r.error) return `spawn error: ${r.error.message}`;
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

function withScopeSandbox(name, scopeObj, fn) {
  const repoDir = join(HOME, name);
  const scopePath = join(repoDir, '.scope.json');
  try {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{}');
    writeFileSync(scopePath, JSON.stringify(scopeObj), 'utf8');
    return fn(repoDir, scopePath);
  } finally {
    rmBestEffort(repoDir, { recursive: true, force: true });
  }
}

function verify() {
  runVerify({
    HOME,
    pkg,
    hooksSrc,
    hooksDst,
    hooksJsonDst,
    hooksJsonSrc,
    pendingDir,
    cursorDst,
    pkgRoot,
    skillDst,
    runHook,
    withScopeSandbox,
    ourKeys,
    LEGACY_HOOK_FILES,
    rmBestEffort,
    mergeHooks,
    pythonCmd,
    keyOf,
  });
}

function sweep() {
  const root = resolve(process.argv[3] || '.');
  console.log(`cursordoctrine ${pkg.version} — anti-slop sweep (whole codebase)`);
  console.log(`  root   ${root}`);
  if (!existsSync(join(root, '.git'))) {
    console.log('  note: not a git root; --all scans tracked files, so results may be partial.');
  }
  console.log('');

  const scanner = join(skillDst, 'scripts', 'scan_slop.py');
  if (!existsSync(scanner)) {
    console.error('anti-slop skill not installed. Run: npx cursordoctrine install');
    process.exit(1);
  }
  const py = pythonCmd();
  if (!py) {
    console.error('Python 3.9+ not found — the scanner cannot run.');
    process.exit(1);
  }

  const r = spawnSync(py, [scanner, '--all', '--format', 'json', '--root', root], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    console.error(`scanner failed to run: ${r.error.message}`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(`${r.stdout || ''}`);
  } catch {
    console.error('scanner produced unparseable output.');
    if (r.stderr) console.error(r.stderr);
    process.exit(1);
  }

  const totals = data.totals || {};
  const dup = data.duplication || {};
  const nFiles = data.files_scanned || 0;
  const warnings = data.warnings || [];

  console.log(`scanned ${nFiles} file(s)   slop_found: ${data.slop_found ? 'YES' : 'no'}`);
  for (const w of warnings) console.log(`  note: ${w}`);
  console.log('');

  if (!data.slop_found) {
    console.log('No static slop signals across the codebase. Clean of the');
    console.log('deterministic inventory. (Semantic slop — cargo-cult, superficial');
    console.log('tests — still needs a model pass; invoke the anti-slop skill.)');
    return;
  }

  const categories = [
    ['swallowed_errors', 'SWALLOWED ERRORS', 'empty catch / broad except+pass'],
    ['abstractions', 'PREMATURE ABSTRACTIONS', 'Factory/Repository/CQRS with <2 call sites'],
    ['dependencies', 'NEW DEPENDENCIES', 'lib for something stdlib/existing dep covers'],
    ['type_escapes', 'TYPE ESCAPES', 'as any / as unknown / @ts-ignore / type:ignore'],
    ['tautological_tests', 'TAUTOLOGICAL TESTS', 'assertion that cannot fail (trivially true)'],
    ['async_wrappers', 'ASYNC WRAPPERS', 'await Promise.resolve / pointless async'],
    ['guard_chains', 'GUARD CHAINS', 'deepening optional-chaining guard shape'],
    ['boolean_traps', 'BOOLEAN TRAPS', 'flag-flip call sites: fn(x, true)'],
    ['select_star', 'SELECT *', 'SELECT * in .sql'],
    ['tailwind_slop', 'TAILWIND SLOP', 'class soup / magic px / z-[9999] / hardcoded hex'],
    ['reexport_slop', 'BARE RE-EXPORTS', 'export ... from lines that ship nothing of their own'],
    ['redundant_comments', 'REDUNDANT COMMENTS', 'restates the code // WHAT not WHY'],
    ['ai_residue', 'AI RESIDUE', 'placeholder phrases / banner comments / emoji'],
    ['semantic_density', 'SEMANTIC OPACITY', 'DataManager / process() / utils.ts / Pt'],
  ];

  const printFileList = (heading, count, files, maxShow = 8) => {
    console.log(`  ${heading}: ${count}`);
    const shown = files.slice(0, maxShow);
    for (const f of shown) console.log(`      ${f}`);
    if (files.length > maxShow) console.log(`      ... +${files.length - maxShow} more`);
  };

  for (const [key, label, desc] of categories) {
    if (!totals[key]) continue;
    const filesWith = [];
    for (const f of data.files || []) {
      if (f[key] && f[key].length) filesWith.push(`${f.file}  (${f[key].length})`);
    }
    console.log(`${label} — ${desc}`);
    printFileList('files', filesWith.length, filesWith);
    console.log('');
  }

  const dupCount = (dup.name_clones?.length || 0) + (dup.body_clones?.length || 0)
    + (dup.near_clones?.length || 0) + (dup.single_use?.length || 0)
    + (dup.type_clones?.length || 0);
  if (dupCount || (dup.fingerprints && Object.keys(dup.fingerprints).length)) {
    console.log('DUPLICATION (isRecord-class slop):');
    const dupRows = [
      ['name_clones', 'Clone proliferation', 'same name in >=2 files'],
      ['body_clones', 'Knowledge duplication', 'identical body (DRY -> ONE)'],
      ['near_clones', 'Semantic fragmentation', 'drifted clones (same shape)'],
      ['single_use', 'Single-use / dead helpers', 'inline then delete'],
      ['type_clones', 'Duplicate type/interface', 'consolidate across files'],
    ];
    for (const [k, label, desc] of dupRows) {
      const arr = dup[k] || [];
      if (!arr.length) continue;
      console.log(`  ${label} — ${desc}: ${arr.length}`);
      for (const c of arr.slice(0, 6)) {
        const names = (c.names || []).join('/');
        const fls = (c.files || []).slice(0, 3).join(', ');
        const more = (c.files || []).length > 3 ? `, +${c.files.length - 3}` : '';
        console.log(`      ${names || '(unnamed)'}  x${c.count || arr.length}  ${fls}${more}`);
      }
      if (arr.length > 6) console.log(`      ... +${arr.length - 6} more`);
    }
    if (dup.fingerprints && Object.keys(dup.fingerprints).length) {
      console.log(`  GENERATED FINGERPRINTS: ${Object.keys(dup.fingerprints).join(', ')}`);
    }
    if (dup.micro_count) {
      console.log(`  micro-abstraction load: ${dup.micro_count} tiny is*/assert*/safe* helper(s)`
        + ` of ${dup.total_defs || '?'} defs (Helper Hell risk)`);
    }
    console.log('');
  }

  const parts = [];
  for (const [k, label] of categories) if (totals[k]) parts.push(`${totals[k]} ${label.toLowerCase().replace(/ /g, '-')}`);
  console.log(`SUMMARY (audit): ${parts.join(', ') || 'no per-file slop signals'}`);
  console.log('');

  const doctrine = join(hooksDst, 'cleanup-doctrine.md');
  const doctrineExists = existsSync(doctrine);
  const scanAgain = `${py} ${scanner.replaceAll('\\', '/')} --all --root .`;
  console.log('NEXT — fix the signals above, in this order:');
  console.log('  1. Read the cleanup doctrine' + (doctrineExists ? ` at ${doctrine.replaceAll('\\', '/')}` : '') + '.');
  console.log('  2. Work category-by-category; after EACH, re-run the scan and confirm');
  console.log('     that category hit zero before moving on:');
  console.log(`     ${scanAgain}`);
  console.log('  3. Do NOT change observable behavior the project depends on. Prefer');
  console.log('     rename -> re-point imports -> delete-copy. Run typecheck/build/tests');
  console.log('     after each category; if something breaks, back it out and flag it.');
  console.log('  4. Target end state: `slop_found: false`, or a residual you justified');
  console.log('     as load-bearing. Do not weaken real code to chase a clean scan.');
}

function uninstall() {
  console.log(`cursordoctrine ${pkg.version} — removing the Node hook pack from ${HOME}`);
  const removed = removeOurPack();
  console.log('');
  for (const r of removed) console.log(`  removed  ${r}`);
  if (removed.length === 0) console.log('  nothing to remove.');
  console.log('');
  console.log('Done. Restart Cursor to unload the hooks.');
}

function help() {
  console.log(`cursordoctrine ${pkg.version} — hooks for Cursor: doctrine at start, scope re-injected per edit, gate on shell, review at stop

Usage
  npx cursordoctrine <command>

Commands
  install      Install the Node hook pack, doctrine, and anti-slop skill into $HOME.
               Removes any prior cursordoctrine install first, then writes fresh.
               Merges ~/.cursor/hooks.json — entries you added yourself are preserved.
  verify       Smoke-test every installed hook with fake payloads (no Cursor restart needed).
  sweep        Whole-codebase anti-slop audit: scan every file, print a category-by-
               category breakdown, hand off to the agent to fix pre-existing slop
               (the bounded session review does NOT touch pre-existing slop).
  uninstall    Remove installed files and strip our hooks.json entries.
  help         Show this help.

After install
  Restart Cursor — hooks.json is read at startup.

Examples
  npx cursordoctrine@latest install
  npx cursordoctrine verify
  npx cursordoctrine sweep
  npx cursordoctrine uninstall

Kill switches (environment variables, all hooks fail open)
  HOOKS_ENFORCE=0              everything advisory off
  PERM_GATE_ENFORCE=0          permission gate off
  INTENT_PRECOMPILE_ENFORCE=0  .scope.json auto-write on prompt off
  SCOPE_REFRESH_ENFORCE=0      per-edit re-injection + files[] recording off
  MILESTONE_VERIFY_ENFORCE=0   mid-session milestone verifier off (doctrine-ultra)
  INTENT_ANCHOR_ENFORCE=0      contract nudge off
  FINAL_REVIEW_ENFORCE=0       final review off

Docs  https://github.com/kleosr/cursordoctrine`);
}

const cmd = process.argv[2];
switch (cmd) {
  case 'install':
  case 'i':
    install();
    break;
  case 'verify':
  case 'check':
    verify();
    break;
  case 'sweep':
    sweep();
    break;
  case 'uninstall':
  case 'remove':
  case 'rm':
    uninstall();
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(pkg.version);
    break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    help();
    break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    help();
    process.exit(2);
}
