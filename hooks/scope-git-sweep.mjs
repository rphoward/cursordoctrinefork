import { join } from 'node:path';
import {
  readHookStdinJson, runHookMain, resolveProjectRoot, gitSync, gitRevParseOk,
} from './hook-common.mjs';
import { readScope, scopePathFor, mergeFiles, updateScope } from './contract-store.mjs';
import { getSessionStartUtc, pathModifiedSinceSession } from './session-state.mjs';

const EDIT_TOOLS = new Set([
  'Edit', 'Replace', 'Write', 'MultiEdit', 'editFile', 'file:edit',
  'ApplyPatch', 'insert', 'str_replace', 'write', 'edit',
]);
const SHELL_TOOLS = new Set([
  'Shell', 'Bash', 'Execute', 'shell', 'bash', 'RunCommand',
  'run', 'terminal', 'cmd', 'powershell', 'pwsh',
]);

export function run(obj) {
  if (process.env.HOOKS_ENFORCE === '0' || process.env.SCOPE_REFRESH_ENFORCE === '0') return {};
  if (!obj) return {};

  const toolName = String(obj.tool_name ?? obj.name ?? obj.toolName ?? obj.tool ?? '');
  if (EDIT_TOOLS.has(toolName)) return {};
  if (!SHELL_TOOLS.has(toolName)) return {};

  const root = resolveProjectRoot(obj);
  if (!root) return {};
  if (!getSessionStartUtc(obj)) return {};

  const scopePath = scopePathFor(root);
  const scope = readScope(scopePath);
  if (!scope) return {};
  if (!gitRevParseOk(root)) return {};

  const diffOut = gitSync(root, ['diff', '--name-only', 'HEAD']);
  const lsOut = gitSync(root, ['ls-files', '--others', '--exclude-standard']);
  const diffPaths = `${diffOut}\n${lsOut}`.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (diffPaths.length === 0) return {};

  const sessionPaths = diffPaths.filter((p) => pathModifiedSinceSession(join(root, p), obj));
  if (sessionPaths.length === 0) return {};

  const existing = Array.isArray(scope.files) ? scope.files : [];
  const merged = mergeFiles(existing, sessionPaths, root);
  if (!merged.appended) return {};

  updateScope(scopePath, (s) => { s.files = merged.files; return s; });
  return {};
}

runHookMain(run, import.meta.url);
