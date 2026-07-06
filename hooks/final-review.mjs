import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const FINAL_REVIEW_MD = join(HOOKS_DIR, 'final-review.md');

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
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

function loadTemplate() {
  try {
    return readFileSync(FINAL_REVIEW_MD, 'utf8').trim();
  } catch {
    return '';
  }
}

function buildFollowup(payload) {
  const status = typeof payload.status === 'string' ? payload.status : '';
  if (status !== 'completed' || process.env.FINAL_REVIEW_ENFORCE === '0') return null;

  const conversationId = safeStr(payload.conversation_id || 'global', 0);
  const promptText = safeStr(payload.prompt || payload.last_user_query || '', 1800);
  const cwd = safeStr(payload.cwd || '', 0);
  const template = loadTemplate();
  const marker = `--- FINAL REVIEW START ${conversationId} ---`;

  const lines = [
    marker,
    template || 'Review session changes. Output **Verdict**: ACCEPT or REVISE.',
    '',
    '## Session context',
    promptText ? `Original request: ${promptText}` : 'Original request: not recoverable from stop payload.',
    cwd ? `Repo root: ${cwd}` : 'Repo root: unknown.',
    marker,
  ];

  return { followup_message: lines.join('\n') };
}

(async () => {
  const payload = await readInput();
  const followup = buildFollowup(payload);
  console.log(JSON.stringify(followup || {}, null, 2));
})();
