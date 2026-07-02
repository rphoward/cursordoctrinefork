import { drain } from './session-state.mjs';
import { conversationId, readHookStdinJson, runHookMain } from './hook-common.mjs';

export function run(obj) {
  if (process.env.HOOKS_ENFORCE === '0' || process.env.SCOPE_REFRESH_ENFORCE === '0') return {};
  const cid = conversationId(obj || null);

  const msgs = [];
  const precompile = drain(cid, 'precompile');
  if (precompile && precompile.trim()) msgs.push(precompile.trim());
  const scope = drain(cid, 'scope');
  if (scope && scope.trim()) msgs.push(scope.trim());

  if (msgs.length === 0) return {};
  return { additional_context: msgs.join('\n\n') };
}

runHookMain(run, import.meta.url);
