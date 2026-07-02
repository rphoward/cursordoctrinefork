import {
  conversationId, readHookStdinJson, runHookMain, resolveProjectRoot,
} from './hook-common.mjs';
import {
  readScope, scopePathFor, acceptanceIsDefault,
} from './contract-store.mjs';
import { readNudge, writeNudge } from './session-state.mjs';

const NUDGE_CAP_DEFAULT = 99999;

export function run(obj) {
  if (process.env.HOOKS_ENFORCE === '0' || process.env.INTENT_ANCHOR_ENFORCE === '0') return {};
  if (!obj) return {};

  const cid = conversationId(obj);
  const root = resolveProjectRoot(obj);
  if (!root) return {};

  const scopePath = scopePathFor(root);
  const scope = readScope(scopePath);
  if (!scope) return {};

  const filesCount = Array.isArray(scope.files) ? scope.files.length : 0;
  const { lastCount, nudgeCount } = readNudge(cid, 'intent-anchored');

  const intent = typeof scope.intent === 'string' ? scope.intent : '';
  const intentEmpty = intent.trim() === '';
  const intentDraft = /^\[DRAFT\]/.test(intent);
  const acceptanceDefault = acceptanceIsDefault(scope.acceptance);

  if (!(intentEmpty || intentDraft || acceptanceDefault)) {
    writeNudge(cid, 'intent-anchored', filesCount, 0);
    return {};
  }

  if (lastCount >= 0 && filesCount <= lastCount) return {};

  const nudgeCap = parseNudgeCap();
  if (nudgeCount >= nudgeCap) return {};

  const nextNudgeCount = nudgeCount + 1;
  writeNudge(cid, 'intent-anchored', filesCount, nextNudgeCount);

  const gaps = [];
  if (intentEmpty) gaps.push('intent: empty — write a one-line Step 0 restatement (NOT the verbatim prompt)');
  else if (intentDraft) gaps.push('intent: still [DRAFT] — rewrite in your own words, drop the prefix');
  if (acceptanceDefault) gaps.push('acceptance: default seed — sharpen to this task\'s real done-check');

  let msg;
  if (nextNudgeCount <= 1) {
    msg = `INTENT ANCHOR: .scope.json contract incomplete. Fill agent-owned fields now:\n  - ${gaps.join('\n  - ')}\nRe-fires on each new file edit until filled.`;
  } else {
    const short = gaps.map((g) => g.split(' — ')[0]).join('; ');
    msg = `INTENT ANCHOR (nudge ${nextNudgeCount}): still missing — ${short}. Fill .scope.json now.`;
  }

  return { additional_context: msg };
}

function parseNudgeCap() {
  const raw = process.env.INTENT_ANCHOR_NUDGE_CAP;
  if (!raw) return NUDGE_CAP_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NUDGE_CAP_DEFAULT;
}

runHookMain(run, import.meta.url);
