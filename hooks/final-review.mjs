import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const FINAL_REVIEW_MD = join(HOOKS_DIR, 'final-review.md');

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function safeStr(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (max > 0 && trimmed.length > max) return trimmed.slice(0, max) + '…';
  return trimmed;
}

function buildFollowup(payload) {
  const status = typeof payload.status === 'string' ? payload.status : '';
  if (status !== 'completed' || process.env.FINAL_REVIEW_ENFORCE === '0') return null;

  const conversationId = safeStr(payload.conversation_id || 'global', 0);
  const promptText = safeStr(payload.prompt || payload.last_user_query || '', 1800);
  const cwd = safeStr(payload.cwd || '', 0);

  const marker = `--- FINAL REVIEW START ${conversationId} ---`;
  const lines = [
    marker,
    'Review this session change surface as a Ponytail code review.',
    '',
    promptText ? `Original request: ${promptText}` : 'Original request: not recoverable from this stop payload.',
    cwd ? `Repo root: ${cwd}` : 'Repo root: unknown.',
    '',
    'Axes:',
    '- intent trace: did the agent understand the problem before changing code?',
    '- correctness / regressions: does the change solve the stated problem without breaking adjacent behavior?',
    '- minimality / shortest working diff: is the change as small as possible while remaining correct?',
    '- no overengineering: did it add files, abstractions, or deps beyond what was asked?',
    '- bug-fix discipline: did it fix the root cause instead of patching one caller?',
    '- boring and reversible: is the approach as dull as possible and easy to revert?',
    '- wiring / public contract: did it change APIs or behavior without updating docs/tests?',
    '- ship discipline: tests, lint, type checks, and validation all green before completion?',
    '',
    'Ponytail verdict rules:',
    '- ACCEPT = intent trace is clear, smallest working diff is used, no overengineering, and quality gates are green.',
    '- REVISE = any FAIL on correctness, overengineering, or root-cause fix; output one-line diagnosis and the minimal next step.',
    '',
    'Finish with: **Verdict**: ACCEPT or REVISE. If REVISE, include the exact line that must change next.',
    marker
  ];

  return { followup_message: lines.join('\n') };
}

(async () => {
  const payload = await readInput();
  const followup = buildFollowup(payload);
  console.log(JSON.stringify(followup || {}, null, 2));
})();
