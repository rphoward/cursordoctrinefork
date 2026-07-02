import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOOKS_DIR, conversationId, readHookStdinJson, runHookMain, resolveProjectRoot,
  scopeRelativePath, isPlanArtifactPath, convertToFwdPath, isHookGeneratedQuery,
  getLastRawUserQueryText, getLastUserQuery, expandAgentPaths, gitSync, gitRevParseOk,
  runMinimality,
} from './hook-common.mjs';
import { readScope, scopePathFor, realFiles } from './contract-store.mjs';
import {
  sweep, reviewedFlagPath, writeFinalReviewDebug, readStash, clearStash, stash,
} from './session-state.mjs';

const MAX_FILE_BYTES = 1048576;
const LOOP_LIMIT_DEFAULT = 3;

function emitNone(reason) {
  if (reason) writeFinalReviewDebug(reason);
  return {};
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readSmallFile(full) {
  try {
    if (!existsSync(full)) return null;
    const st = statSync(full);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return readFileSync(full, 'utf8');
  } catch { return null; }
}

function collectScopeFiles(scope, root) {
  const files = Array.isArray(scope?.files) ? scope.files : [];
  const out = [];
  for (const f of files) {
    const s = String(f);
    if (!s || /^\s*</.test(s) || s.trim() === '') continue;
    const rp = scopeRelativePath(s, root);
    if (rp && rp.toLowerCase() !== '.scope.json' && !isPlanArtifactPath(rp) && !out.includes(rp)) out.push(rp);
  }
  return out;
}

function gitDirtyRelSet(root) {
  const set = new Set();
  const diffOut = gitSync(root, ['diff', '--name-only', 'HEAD']);
  const lsOut = gitSync(root, ['ls-files', '--others', '--exclude-standard']);
  for (const p of `${diffOut}\n${lsOut}`.split(/\r?\n/)) {
    const rp = scopeRelativePath(p, root);
    if (rp && !isPlanArtifactPath(rp)) set.add(rp.toLowerCase());
  }
  return set;
}

function diffSignature(root, scopePath) {
  const sb = [];
  const hasScope = existsSync(scopePath);
  const hasGit = gitRevParseOk(root);

  if (hasGit && hasScope) {
    const scope = readScope(scopePath);
    const files = scope ? collectScopeFiles(scope, root).map((f) => f.replace(/\\/g, '/').replace(/^\//, '')) : [];
    if (files.length > 0) {
      const diff = gitSync(root, ['diff', 'HEAD', '--', ...files]);
      if (diff) sb.push(diff);
      const tracked = new Set();
      for (const t of gitSync(root, ['ls-files', '--', ...files]).split(/\r?\n/)) {
        if (t) tracked.add(t.replace(/\\/g, '/').replace(/^\//, ''));
      }
      for (const f of files) {
        if (tracked.has(f)) continue;
        const body = readSmallFile(join(root, f));
        if (body !== null) sb.push(`\n==U:${f}==\n${body}`);
      }
    }
  } else if (hasGit) {
    const dirty = [];
    const seen = new Set();
    const diffOut = gitSync(root, ['diff', 'HEAD', '--name-only']);
    const lsOut = gitSync(root, ['ls-files', '--others', '--exclude-standard']);
    for (const p of `${diffOut}\n${lsOut}`.split(/\r?\n/)) {
      const rp = scopeRelativePath(p, root);
      if (rp && !isPlanArtifactPath(rp) && !seen.has(rp)) { seen.add(rp); dirty.push(rp); }
    }
    if (dirty.length > 0) {
      const diff = gitSync(root, ['diff', 'HEAD', '--', ...dirty]);
      if (diff) sb.push(diff);
    }
    for (const u of dirty) {
      const body = readSmallFile(join(root, u));
      if (body !== null) sb.push(`\n==U:${u}==\n${body}`);
    }
  } else if (hasScope) {
    const scope = readScope(scopePath);
    for (const f of collectScopeFiles(scope, root)) {
      const body = readSmallFile(join(root, f));
      if (body !== null) sb.push(`\n==F:${f}==\n${body}`);
    }
  }

  if (hasScope) {
    try {
      const raw = readFileSync(scopePath, 'utf8');
      if (raw) sb.push(`\n==SCOPE-JSON==\n${raw}`);
    } catch { /* best-effort */ }
  }

  const raw = sb.join('');
  if (!raw) return 'empty';
  return sha256Hex(raw);
}

function truncate(s, max) {
  return s && s.length > max ? s.slice(0, max) + '...' : s;
}

function buildDeclaredNote(scope, root, rel) {
  const declaredRaw = (Array.isArray(scope?.files) ? scope.files : [])
    .filter((f) => { const s = String(f); return s && s.trim() && !/^\s*</.test(s) && !isPlanArtifactPath(s); })
    .map((f) => scopeRelativePath(String(f), root))
    .filter((f) => f && !isPlanArtifactPath(f));
  const declared = [...new Set(declaredRaw)];
  if (declared.length === 0) return '';

  const touchedSet = new Set(rel.filter((f) => f.toLowerCase() !== '.scope.json').map((f) => f.toLowerCase()));
  const declaredSet = new Set(declared.map((f) => f.toLowerCase()));
  const missed = declared.filter((f) => !touchedSet.has(f.toLowerCase()));
  const extra = rel.filter((f) => f.toLowerCase() !== '.scope.json' && !declaredSet.has(f.toLowerCase()));

  const lines = [`Declared scope: ${declared.length} file(s); git sees ${rel.length} touched.`];
  if (missed.length > 0) lines.push(`  Declared but NOT touched (${missed.length}): ${missed.slice(0, 8).join(', ')}`);
  if (extra.length > 0) lines.push(`  Touched but NOT declared (${extra.length}): ${extra.slice(0, 8).join(', ')}`);
  if (missed.length === 0 && extra.length === 0) lines.push('  (matches declared scope)');
  return lines.join('\n') + '\n\n';
}

function buildRoleTrace(scope, root, rel) {
  const decomp = Array.isArray(scope?.decomposition) ? scope.decomposition : [];
  if (decomp.length === 0) {
    if (rel.length >= 2) {
      return (
        'Decomposition: EMPTY for a ' + rel.length + '-file task. The doctrine requires a decomposition[] for any multi-step / multi-file change.\n' +
        '  Declare it now: each entry { step (int), subtask (one-line), expected_files (array of paths) }.\n' +
        '  Axis 7 (role-trace) will FAIL until decomposition is declared. Trivial one-liners (<=1 file) are the only SKIP.\n\n'
      );
    }
    return '';
  }

  const verifs = Array.isArray(scope?.verifications) ? scope.verifications : [];
  const verdictByStep = new Map();
  const diagnosisByStep = new Map();
  for (const v of verifs) {
    if (v && v.step !== undefined) {
      const sn = Number(v.step);
      if (Number.isFinite(sn)) {
        verdictByStep.set(sn, String(v.verdict ?? ''));
        if (typeof v.diagnosis === 'string' && v.diagnosis.trim()) {
          const d = v.diagnosis.trim();
          diagnosisByStep.set(sn, d.length > 120 ? d.slice(0, 120) + '...' : d);
        }
      }
    }
  }

  const touchedSetRt = new Set(rel.filter((f) => f.toLowerCase() !== '.scope.json').map((f) => f.toLowerCase()));
  const allExpected = new Set();
  for (const step of decomp) {
    if (step && Array.isArray(step.expected_files)) {
      for (const ef of step.expected_files) {
        const rp = scopeRelativePath(String(ef), root);
        if (rp) allExpected.add(rp.toLowerCase());
      }
    }
  }
  const leakage = rel.filter((f) => f.toLowerCase() !== '.scope.json' && !allExpected.has(f.toLowerCase()));

  const rtLines = [`Decomposition: ${decomp.length} step(s); verdicts recorded: ${verdictByStep.size}.`];
  let malformed = 0;
  for (const step of decomp) {
    if (!step || typeof step !== 'object') {
      malformed++;
      const preview = step ? String(step).slice(0, 50) : '(empty/null)';
      rtLines.push(`  step ? [MALFORMED - not an object; needs {step(int), subtask, expected_files}] - ${preview}`);
      continue;
    }
    if (step.step === undefined) {
      malformed++;
      rtLines.push('  step ? [MALFORMED - missing step field] - (no step)');
      continue;
    }
    const sn = Number(step.step);
    if (!Number.isFinite(sn)) {
      malformed++;
      rtLines.push(`  step ? [MALFORMED - step not an int] - ${String(step.step)}`);
      continue;
    }
    if (!Array.isArray(step.expected_files) || step.expected_files.length === 0) {
      malformed++;
      const subtaskBad = typeof step.subtask === 'string' && step.subtask ? step.subtask : '(no subtask)';
      rtLines.push(`  step ${sn} [MALFORMED - missing expected_files] - ${subtaskBad}`);
      continue;
    }
    const subtask = typeof step.subtask === 'string' && step.subtask ? step.subtask : '(no subtask)';
    const expected = step.expected_files.map((e) => scopeRelativePath(String(e), root)).filter(Boolean);
    const missing = expected.filter((e) => !touchedSetRt.has(e.toLowerCase()));
    const verdict = verdictByStep.has(sn) ? verdictByStep.get(sn) : '(no verdict)';
    let status;
    if (missing.length > 0) status = `missing ${missing.length} expected`;
    else if (verdict === 'ACCEPT') status = 'ACCEPTED';
    else if (verdict === 'REVISE') status = 'REVISE open';
    else status = 'touched, awaiting verdict';
    rtLines.push(`  step ${sn} [${status}] - ${subtask}`);
    if (diagnosisByStep.has(sn)) rtLines.push(`      evidence: ${diagnosisByStep.get(sn)}`);
  }
  if (malformed > 0) {
    rtLines.push(`  CONTRACT GAP: ${malformed} malformed decomposition entry/entries. Each entry MUST be an object { step (int), subtask (one-line), expected_files (array of paths) }. Axis 7 FAILs until fixed.`);
  }
  if (leakage.length > 0) {
    rtLines.push(`  Touched but NOT in any step's expected_files (${leakage.length}): ${leakage.slice(0, 8).join(', ')}`);
  }
  return rtLines.join('\n') + '\n\n';
}

function classifyTaskKind(intentText) {
  const t = intentText.toLowerCase();
  if (/fix|bug|typo|off-by-one|off by one|wrong|incorrect|broken|hotfix|patch|crash|regression|null pointer|exception/.test(t)) return 'surgical';
  if (/add|implement|create|build|new feature|migrate|refactor|rewrite|introduce|scaffold|generate|support|enable/.test(t)) return 'constructive';
  return 'neutral';
}

function computeChurn(root, rel) {
  let added = 0, deleted = 0;
  if (rel.length === 0) return { added, deleted };
  const out = gitSync(root, ['diff', '--numstat', 'HEAD', '--', ...rel]);
  for (const ln of out.split(/\r?\n/)) {
    const m = ln.match(/^\s*(\d+|-)\s+(\d+|-)\s/);
    if (!m) continue;
    if (m[1] !== '-') added += Number(m[1]) || 0;
    if (m[2] !== '-') deleted += Number(m[2]) || 0;
  }
  return { added, deleted };
}

function buildMinimalityFlag(taskKind, uniqueFiles, churn, min) {
  const worstRatio = min ? min.worstRatio : -1;
  const worstFile = min ? min.worstFile : '';
  const structDelta = min ? min.structDelta : 0;
  const ratioText = worstRatio >= 0 ? worstRatio.toFixed(2) : 'n/a';
  const deltaText = structDelta >= 0 ? `+${structDelta}` : `${structDelta}`;
  const reasons = [];
  let minFlag = false, minWhy = '';

  if (taskKind === 'surgical') {
    if (uniqueFiles > 3 || churn > 30) reasons.push(`${uniqueFiles} file(s) / ${churn} line(s) churn`);
    if (worstRatio > 0.15) reasons.push(`rewrite-ratio ${ratioText} on ${worstFile}`);
    if (structDelta > 2) reasons.push(`structural delta ${deltaText} the fix did not require`);
    if (reasons.length > 0) { minFlag = true; minWhy = 'bug/fix task but ' + reasons.join('; '); }
  } else if (taskKind === 'constructive') {
    if (uniqueFiles > 10 || churn > 400) reasons.push(`large blast radius: ${uniqueFiles} file(s) / ${churn} line(s)`);
    if (worstRatio > 0.6) reasons.push(`rewrote most of existing ${worstFile} (rewrite-ratio ${ratioText})`);
    if (reasons.length > 0) { minFlag = true; minWhy = reasons.join('; '); }
  } else {
    if (uniqueFiles > 5 || churn > 150) reasons.push(`${uniqueFiles} file(s) / ${churn} line(s)`);
    if (worstRatio > 0.35 || structDelta > 8) reasons.push(`rewrite-ratio ${ratioText} / structural delta ${deltaText}`);
    if (reasons.length > 0) { minFlag = true; minWhy = reasons.join('; ') + ' - justify each or trim'; }
  }
  return { minFlag, minWhy, ratioText, worstFile, deltaText, worstRatio, structDelta };
}

function buildIntentBlock(scopeIntent, scopePrompt, obj) {
  let userQuery = scopeIntent;
  if (!userQuery || !userQuery.trim()) userQuery = scopePrompt;
  if (!userQuery || !userQuery.trim()) userQuery = getLastUserQuery(obj);
  userQuery = truncate(userQuery, 600);
  let intentBlock = '';
  if (userQuery) {
    intentBlock = `ORIGINAL REQUEST (intent trace):\n---\n${userQuery}\n---\n`;
    if (scopeIntent && scopePrompt) intentBlock += `User prompt (source): ${truncate(scopePrompt, 300)}\n\n`;
    else intentBlock += '\n';
  }
  if (!scopeIntent || scopeIntent.trim() === '' || /^\[DRAFT\]/.test(scopeIntent)) {
    const intentGap =
      'CONTRACT GAP: .scope.json intent is empty/[DRAFT] - the agent never wrote its Step 0 restatement. Axis 0 (intent trace) will FAIL until you write a one-line restatement of THIS task in your own words (clearer/better than the verbatim prompt, NOT a copy).\n\n';
    intentBlock = intentGap + intentBlock;
  }
  return intentBlock;
}

function parseLoopLimit() {
  const raw = process.env.FINAL_REVIEW_LOOP_LIMIT;
  if (!raw) return LOOP_LIMIT_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : LOOP_LIMIT_DEFAULT;
}

function handleReviewedFlag(obj, root, scopePath, loopCount, loopLimit) {
  const flagPath = reviewedFlagPath(obj);
  if (!existsSync(flagPath)) return { brakeReReview: false };
  let brakeReReview = false;
  const lastRaw = getLastRawUserQueryText(obj);
  if ((lastRaw && isHookGeneratedQuery(lastRaw)) || loopCount > 0) {
    const prevSig = readStash(conversationId(obj), 'reviewed').trim();
    const curSig = diffSignature(root, scopePath);
    if (curSig !== prevSig && loopCount < loopLimit) {
      brakeReReview = true;
      const prevShort = prevSig ? prevSig.slice(0, 8) : '(none)';
      writeFinalReviewDebug(`re_review (prev=${prevShort} cur=${curSig.slice(0, 8)} loop=${loopCount})`);
      clearStash(conversationId(obj), 'reviewed');
    } else {
      clearStash(conversationId(obj), 'reviewed');
      return { brakeReReview: false, earlyExit: emitNone('post_review_cleanup') };
    }
  }
  clearStash(conversationId(obj), 'reviewed');
  writeFinalReviewDebug('stale_flag_cleared');
  return { brakeReReview };
}

function collectTouchedFiles(root, scopePath, brakeReReview) {
  const rel = [];
  let diffStat = '';
  let isGitRepo = false;

  if (existsSync(scopePath)) {
    const scope = readScope(scopePath);
    for (const rp of collectScopeFiles(scope, root)) {
      if (!rel.includes(rp)) rel.push(rp);
    }
    if (rel.length > 0 && gitRevParseOk(root)) {
      isGitRepo = true;
      if (!brakeReReview) {
        const dirtySet = gitDirtyRelSet(root);
        for (let i = rel.length - 1; i >= 0; i--) {
          if (!dirtySet.has(rel[i].toLowerCase())) rel.splice(i, 1);
        }
        if (rel.length === 0) return { rel: [], diffStat, isGitRepo, earlyExit: emitNone('no_diff') };
      }
      diffStat = gitSync(root, ['diff', 'HEAD', '--stat', '--', ...rel]);
    }
  } else if (gitRevParseOk(root)) {
    isGitRepo = true;
    const diffOut = gitSync(root, ['diff', 'HEAD', '--name-only']);
    const lsOut = gitSync(root, ['ls-files', '--others', '--exclude-standard']);
    const rootFwd = convertToFwdPath(root).replace(/\/+$/, '');
    for (const p of `${diffOut}\n${lsOut}`.split(/\r?\n/)) {
      if (!p) continue;
      let rp = convertToFwdPath(p);
      if (rp.toLowerCase().startsWith(rootFwd.toLowerCase() + '/')) rp = rp.slice(rootFwd.length + 1);
      rp = rp.replace(/^\//, '');
      if (rp && !isPlanArtifactPath(rp) && !rel.includes(rp)) rel.push(rp);
    }
    if (rel.length > 0) diffStat = gitSync(root, ['diff', 'HEAD', '--stat', '--', ...rel]);
  }
  return { rel, diffStat, isGitRepo };
}

export function run(obj) {
  if (process.env.HOOKS_ENFORCE === '0' || process.env.FINAL_REVIEW_ENFORCE === '0') return emitNone('kill_switch');
  if (!obj) return emitNone('no_input');

  const status = typeof obj.status === 'string' ? obj.status : '';
  const cid = conversationId(obj);
  const loopCount = Number(obj.loop_count) || 0;
  const loopLimit = parseLoopLimit();

  if (status && status !== 'completed') return emitNone('no_status');

  const root = resolveProjectRoot(obj);
  if (!root) return emitNone('no_root');

  sweep();

  const scopePath = scopePathFor(root);
  const flagResult = handleReviewedFlag(obj, root, scopePath, loopCount, loopLimit);
  if (flagResult.earlyExit) return flagResult.earlyExit;
  const brakeReReview = flagResult.brakeReReview;

  if (loopCount >= loopLimit) return emitNone('loop_limit');

  const touched = collectTouchedFiles(root, scopePath, brakeReReview);
  if (touched.earlyExit) return touched.earlyExit;
  const { rel, diffStat, isGitRepo } = touched;

  if (rel.length === 0 && !brakeReReview) return emitNone('no_diff');

  const isReReview = brakeReReview || loopCount > 0;
  let body = '';
  if (!isReReview) {
    const promptFile = join(HOOKS_DIR, 'final-review.md');
    if (!existsSync(promptFile)) {
      const msg = 'FINAL REVIEW: The review template (~/.agents/hooks/final-review.md) is missing. Your cursordoctrine install is incomplete. Run: npx cursordoctrine install';
      stash(cid, 'reviewed', diffSignature(root, scopePath));
      return { followup_message: msg };
    }
    body = readFileSync(promptFile, 'utf8');
    if (!body) return emitNone('empty_prompt');
    body = expandAgentPaths(body);
  }

  const scope = readScope(scopePath);
  const scopePrompt = typeof scope?.prompt === 'string' ? scope.prompt : '';
  const scopeIntent = typeof scope?.intent === 'string' ? scope.intent : '';
  let scopeBlock = '';
  if (scope && typeof scope.acceptance === 'string' && scope.acceptance) {
    scopeBlock = `Declared acceptance: ${scope.acceptance}\n\n`;
  }
  const declaredNote = scope ? buildDeclaredNote(scope, root, rel) : '';
  const roleTraceBlock = scope ? buildRoleTrace(scope, root, rel) : '';
  const intentBlock = buildIntentBlock(scopeIntent, scopePrompt, obj);

  const fileListLines = rel.slice(0, 15).join('\n  ');
  let fileList = fileListLines;
  if (rel.length > 15) fileList += `\n  ...+${rel.length - 15} more (see .scope.json files[])`;
  const uniqueFiles = new Set(rel).size;

  const { added, deleted } = computeChurn(root, rel);
  const churn = added + deleted;
  const taskKind = classifyTaskKind(`${scopeIntent} ${scopePrompt}`);
  const minMetrics = isGitRepo && rel.length > 0 ? runMinimality(root, rel) : null;
  const minFlag = buildMinimalityFlag(taskKind, uniqueFiles, churn, minMetrics);

  let metricsLine = '';
  if (minMetrics && (minMetrics.worstRatio >= 0 || minMetrics.structDelta !== 0)) {
    const worstNote = minMetrics.worstFile ? ` (${minMetrics.worstFile})` : '';
    metricsLine = `Minimal-edit metrics: worst rewrite-ratio ${minFlag.ratioText}${worstNote}; structural delta ${minFlag.deltaText} (branches/bools/try added vs HEAD). A faithful fix keeps rewrite-ratio near 0.00 and delta ~0.\n`;
  }

  let surfaceBlock = `Session footprint: ${uniqueFiles} file(s) touched, +${added}/-${deleted} (${churn} churn). Task kind: ${taskKind}.\n`;
  if (metricsLine) surfaceBlock += metricsLine;
  if (brakeReReview) {
    surfaceBlock += 'RE-REVIEW (verify-revise): the contract (.scope.json) changed since the last review. Re-verify the role-trace below against the session work; the diff stat may be empty when the only change was the contract (source edits already committed).\n';
  }
  if (minFlag.minFlag) {
    surfaceBlock += `MINIMALITY FLAG: DISPROPORTIONATE - ${minFlag.minWhy}. Axis 4 (minimality): justify every file/line or trim to the faithful minimal edit.\n`;
  } else {
    surfaceBlock += 'MINIMALITY: proportionate to intent scope.\n';
  }
  if (diffStat) {
    const statTrimmed = diffStat.split(/\r?\n/).filter(Boolean).pop()?.trim() || '';
    surfaceBlock += `Diff: ${statTrimmed}\n`;
  }
  surfaceBlock += '\n';

  const header = isReReview
    ? 'FINAL REVIEW (re-review): the diff changed after the last review. Re-run the SAME 8-axis audit (template earlier in this conversation) on the NEW diff. Fix FAILs, then emit the mandatory report block (axes 0-7, one line each; **Verdict**: ACCEPT | REVISE).\n\n'
    : 'FINAL REVIEW (end of implementation). Emit a structured bullet report (one line per axis), then fix anything that fails. See the report template below.\n\n';

  let msg = `${header}${surfaceBlock}${scopeBlock}${declaredNote}${roleTraceBlock}${intentBlock}Files you changed this session:\n  ${fileList}`;
  if (body) msg += `\n\n${body}`;

  stash(cid, 'reviewed', diffSignature(root, scopePath));
  writeFinalReviewDebug('emitted');
  return { followup_message: msg };
}

runHookMain(run, import.meta.url);
