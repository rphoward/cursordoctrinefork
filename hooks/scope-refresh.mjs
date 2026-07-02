import {
  conversationId, readHookStdinJson, runHookMain, resolveProjectRoot,
  scopeRelativePath, isPlanArtifactPath,
} from './hook-common.mjs';
import {
  readScope, scopePathFor, recordFiles, contractSignature,
} from './contract-store.mjs';
import { stash, readStash } from './session-state.mjs';

const EDIT_PATH_KEYS = ['file_path', 'path', 'filename', 'absolute_path', 'abs_path'];

export function run(obj) {
  if (process.env.HOOKS_ENFORCE === '0' || process.env.SCOPE_REFRESH_ENFORCE === '0') return {};

  if (!obj) return {};

  const cid = conversationId(obj);
  const root = resolveProjectRoot(obj);
  if (!root) return {};

  const scopePath = scopePathFor(root);
  let scope = readScope(scopePath);
  if (!scope) return {};

  let latestRel = '';
  let editedFile = '';
  for (const k of EDIT_PATH_KEYS) {
    if (obj[k]) { editedFile = String(obj[k]); break; }
  }
  if (editedFile) {
    const rel = scopeRelativePath(editedFile, root);
    if (!rel || isPlanArtifactPath(rel) || rel.toLowerCase() === '.scope.json') return {};
    latestRel = rel;
    recordFiles(scopePath, [rel], root);
    scope = readScope(scopePath) ?? scope;
  }

  const intent = typeof scope.intent === 'string' ? scope.intent : '';
  const acceptance = typeof scope.acceptance === 'string' ? scope.acceptance : '';
  const filesCount = Array.isArray(scope.files) ? scope.files.length : 0;
  const latest = latestRel ? ` (+${latestRel})` : '';

  const sig = contractSignature(scope);
  const prevSig = readStash(cid, 'scope-sig');

  let msg;
  if (sig === prevSig) {
    msg = `SCOPE: ${filesCount} file(s)${latest} in files[]; contract unchanged. Edit must advance intent.`;
  } else {
    const intentLine = intent ? intent : '(empty — write it now)';
    msg = `SCOPE (edit recorded to files[]):\n  intent: ${intentLine}\n  files: ${filesCount}${latest}`;
    if (acceptance) msg += `\n  acceptance: ${acceptance}`;
    msg += '\nEdit must advance intent.';
    stash(cid, 'scope-sig', sig);
  }

  stash(cid, 'scope', msg);
  return {};
}

runHookMain(run, import.meta.url);
