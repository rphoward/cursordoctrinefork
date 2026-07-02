import {
  readHookStdinJson, runHookMain, resolveProjectRoot, scopeRelativeAnyRoot,
} from './hook-common.mjs';
import { readScope, scopePathFor, intentNeedsStep0, realFiles } from './contract-store.mjs';

const EDIT_TOOLS = new Set(['Write', 'StrReplace', 'ApplyPatch', 'Edit', 'MultiEdit', 'Replace']);
const PATH_KEYS = ['path', 'file_path', 'filename', 'absolute_path', 'abs_path', 'target_file'];

function allow() {
  return { permission: 'allow' };
}

function deny(reason) {
  const userMsg =
    `BLOCKED by step0-gate: ${reason}\n\n` +
    'Write intent (+ decomposition[] for multi-file tasks) to .scope.json first, then retry.';
  return {
    permission: 'deny',
    user_message: userMsg,
    agent_message: `${userMsg} Do not skip Step 0 — persist the contract to .scope.json, not chat prose.`,
  };
}

function countDecomposition(scope) {
  const decomp = Array.isArray(scope?.decomposition) ? scope.decomposition : [];
  let count = 0;
  for (const d of decomp) {
    if (!d) continue;
    const sub = typeof d === 'string' ? d : (d?.subtask ?? '');
    if (typeof sub === 'string' && sub.trim() !== '' && !/^\s*<TODO/.test(sub)) count++;
  }
  return count;
}

function filesLowerMap(scope) {
  const map = new Set();
  for (const f of realFiles(scope?.files ?? [])) {
    map.add(f.replace(/\\/g, '/').replace(/^\//, '').toLowerCase());
  }
  return map;
}

function extractTargetPaths(toolInput) {
  const out = [];
  if (!toolInput || typeof toolInput !== 'object') return out;
  for (const k of PATH_KEYS) {
    if (toolInput[k]) out.push(String(toolInput[k]));
  }
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') continue;
    for (const k of PATH_KEYS) {
      if (edit[k]) { out.push(String(edit[k])); break; }
    }
  }
  return out;
}

export function run(obj) {
  if (process.env.HOOKS_ENFORCE === '0' || process.env.STEP0_GATE_ENFORCE === '0') return allow();

  if (!obj) return allow();

  const toolName = typeof obj.tool_name === 'string' ? obj.tool_name : '';
  if (toolName && !EDIT_TOOLS.has(toolName)) return allow();

  const root = resolveProjectRoot(obj);
  if (!root) return allow();

  const scopePath = scopePathFor(root);
  const scope = readScope(scopePath);
  if (!scope) return allow();

  const intentEmpty = intentNeedsStep0(scope.intent);
  const realCount = realFiles(scope.files ?? []).length;
  const filesLower = filesLowerMap(scope);
  const decompCount = countDecomposition(scope);

  const rawTi = obj.tool_input;
  let ti = rawTi;
  if (typeof rawTi === 'string') {
    try { ti = JSON.parse(rawTi); } catch { ti = null; }
  }
  const targetPaths = extractTargetPaths(ti);

  if (targetPaths.length === 0) {
    if (intentEmpty) return deny('edit tool target path could not be parsed and intent is empty — fill .scope.json before editing.');
    if (realCount >= 1 && decompCount === 0) return deny('edit tool target path could not be parsed and decomposition[] is empty after prior file edits.');
    return allow();
  }

  for (const targetPath of targetPaths) {
    const rel = scopeRelativeAnyRoot(targetPath, obj);
    if (!rel) return deny('edit target is outside all workspace roots or could not be normalized.');
    if (rel.toLowerCase() === '.scope.json') continue;
    if (intentEmpty) return deny('intent is empty — write your one-line Step 0 restatement to .scope.json before editing code.');
    const alreadyRecorded = filesLower.has(rel.toLowerCase());
    if (!alreadyRecorded && realCount >= 1 && decompCount === 0) {
      return deny('about to edit a second distinct file and decomposition[] is empty — declare steps in .scope.json before editing another file.');
    }
  }

  return allow();
}

runHookMain(run, import.meta.url);
