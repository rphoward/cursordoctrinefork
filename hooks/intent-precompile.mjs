import { existsSync } from 'node:fs';
import {
  conversationId, readHookStdinJson, runHookMain, isHookGeneratedQuery,
  isPlanModeEvent, isPlanOnlyPrompt, resolveProjectRoot, topicChanged,
} from './hook-common.mjs';
import {
  resetScope, continuationScope, readScope,
  writeScopeAtomic, updateScope, scopePathFor, intentNeedsStep0, acceptanceIsDefault,
} from './contract-store.mjs';
import { ensureSessionStartStamp, stash, clearStash } from './session-state.mjs';

const STEP0_NUDGE =
  'STEP 0 CONTRACT: .scope.json seeded. Fill agent-owned fields BEFORE your first edit:\n' +
  '  - intent: one-line restatement (NOT the verbatim prompt)\n' +
  '  - acceptance: this task\'s real done-check\n' +
  '  - decomposition[]: steps, if multi-file or multi-step';

export function run(obj) {
  if (process.env.HOOKS_ENFORCE === '0' || process.env.INTENT_PRECOMPILE_ENFORCE === '0') return {};

  const promptRaw = typeof obj?.prompt === 'string' ? obj.prompt : '';
  let prompt = promptRaw.trim();
  if (!prompt) return {};

  const newTaskMatch = prompt.match(/^\s*(\/new\b|new\s+task:)\s*(.*)$/);
  let forceNewTask = false;
  if (newTaskMatch) {
    prompt = newTaskMatch[2].trim();
    if (!prompt) return {};
    forceNewTask = true;
  }

  if (isHookGeneratedQuery(prompt)) return {};
  if (isPlanModeEvent(obj) || isPlanOnlyPrompt(prompt)) return {};

  const root = resolveProjectRoot(obj);
  if (!root) return {};

  const scopePath = scopePathFor(root);
  ensureSessionStartStamp(obj);
  const cid = conversationId(obj);

  const existing = readScope(scopePath);
  let scope;
  if (existing) {
    const oldPrompt = typeof existing.prompt === 'string' ? existing.prompt : '';
    if (forceNewTask || topicChanged(prompt, oldPrompt)) {
      scope = resetScope(prompt);
      if (cid) {
        clearStash(cid, 'intent-anchored');
        clearStash(cid, 'decompose');
      }
    } else {
      scope = continuationScope(existing, prompt);
    }
  } else {
    scope = resetScope(prompt);
  }

  if (existsSync(scopePath)) {
    updateScope(scopePath, () => scope);
  } else {
    writeScopeAtomic(scopePath, JSON.stringify(scope));
  }

  const needsStep0 = intentNeedsStep0(scope.intent) || acceptanceIsDefault(scope.acceptance);
  if (needsStep0 && cid) {
    clearStash(cid, 'intent-anchored');
    stash(cid, 'precompile', STEP0_NUDGE);
  }
  return {};
}

runHookMain(run, import.meta.url);
