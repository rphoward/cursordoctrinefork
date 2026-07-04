#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

function resolveProjectRoot(cwd, workspaceRoots) {
  const tries = [
    cwd,
    ...(Array.isArray(workspaceRoots) ? workspaceRoots : Array.isArray(workspaceRoots) ? workspaceRoots : []).filter(Boolean),
    process.env.CURSOR_PROJECT_DIR || '',
    process.env.PWD || ''
  ];
  for (const candidate of tries) {
    if (!candidate) continue;
    const root = resolve(candidate);
    if (existsSync(join(root, '.git')) || existsSync(join(root, '.scope.json'))) return root;
  }
  return resolve(cwd || '.');
}

const EDIT_RE = /\b(Write|Edit|MultiEdit|Replace|StrReplace|ApplyPatch)\b/i;
function looksLikeWrite(input) {
  return typeof input === 'object' && EDIT_RE.test((input && input.tool_name) || '');
}

function extractTarget(input) {
  if (!input || typeof input !== 'object') return '';
  return [input.file_path, input.path, input.uri].find(Boolean) || '';
}

function relativeTarget(target, root) {
  if (!target || !root) return target;
  const norm = resolve(target);
  if (norm.length < root.length) return target;
  if (norm === root || norm.startsWith(`${root}/`) || norm.startsWith(`${root}\\`)) {
    const rel = norm.slice(root.length).replace(/^[/\\]+/, '');
    return rel ? rel.split(/[/\\]+/).map(encodeURIComponent).join('/') : '';
  }
  return target;
}

function loadScope(scopePath) {
  try {
    return JSON.parse(readFileSync(scopePath, 'utf8'));
  } catch {
    return null;
  }
}

function availableFields(intent, decomposition, files) {
  const missing = [];
  const hasIntent = typeof intent === 'string' && intent.trim().length > 0;
  const hasDecomposition = Array.isArray(decomposition) && decomposition.length > 0;
  const hasFiles = Array.isArray(files) && files.some(f => typeof f === 'string' && f.trim() !== '' && f !== '.scope.json');
  if (!hasIntent) missing.push('intent');
  if (!hasDecomposition && hasFiles) missing.push('decomposition');
  return missing;
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function main() {
  const payload = readInput();
  if (process.env.STEP0_GATE_ENFORCE === '0') {
    console.log(JSON.stringify({ permission: 'allow' }, null, 2));
    return;
  }

  const root = resolveProjectRoot(payload.cwd, payload.workspace_roots);
  const scopePath = join(root, '.scope.json');
  if (!existsSync(scopePath)) {
    console.log(JSON.stringify({ permission: 'allow' }, null, 2));
    return;
  }
  if (!looksLikeWrite(payload)) {
    console.log(JSON.stringify({ permission: 'allow' }, null, 2));
    return;
  }

  const target = relativeTarget(extractTarget(payload), root);
  if (!target || target === '.scope.json') {
    console.log(JSON.stringify({ permission: 'allow' }, null, 2));
    return;
  }

  const scope = loadScope(scopePath);
  if (!scope) {
    console.log(JSON.stringify({ permission: 'allow' }, null, 2));
    return;
  }

  const missing = availableFields(scope.intent, scope.decomposition, scope.files);
  if (missing.includes('intent')) {
    console.log(JSON.stringify({
      permission: 'deny',
      agent_message: 'Denied until Step 0 is complete: fill `.scope.json` `intent` before any code edit.',
      user_message: 'Step 0 missing: `.scope.json` has empty `intent`. Restate the task there, then continue.'
    }, null, 2));
    return;
  }
  if (missing.includes('decomposition')) {
    console.log(JSON.stringify({
      permission: 'deny',
      agent_message: 'Denied: this multi-file change needs a declared `decomposition[]` in `.scope.json`.',
      user_message: 'Add `decomposition[]` to `.scope.json` before editing a second file.'
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({ permission: 'allow' }, null, 2));
}

(async () => {
  await main();
})();
