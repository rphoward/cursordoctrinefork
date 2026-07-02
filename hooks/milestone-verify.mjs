import {
  conversationId, readHookStdinJson, runHookMain, resolveProjectRoot,
  scopeRelativePath, getLastVerdict,
} from './hook-common.mjs';
import {
  readScope, scopePathFor, realFiles, setVerdict,
} from './contract-store.mjs';
import { throttle } from './session-state.mjs';

const DECOMPOSE_CAP_DEFAULT = 99999;

function allowVerdictUpgrade(recorded, stepNum, scrapedVerdict) {
  if (!recorded.has(stepNum)) return true;
  const rv = recorded.get(stepNum);
  if (rv.toUpperCase() === 'ACCEPT') return false;
  if (rv.toUpperCase() === String(scrapedVerdict).toUpperCase()) return false;
  return true;
}

function buildDecompNudge(nudgeCount, fileCount, files) {
  if (nudgeCount <= 1) {
    const sample = files.slice(0, 3).join(', ');
    return `DECOMPOSE: ${fileCount} file(s) touched (${sample}...) but decomposition[] is empty. Multi-file work requires it — declare now: each entry { step (int), subtask, expected_files[] }. Final review axis 7 FAILs without it.`;
  }
  return `DECOMPOSE (nudge ${nudgeCount}): still empty at ${fileCount} file(s). Declare decomposition[] in .scope.json now.`;
}

export function run(obj) {
  if (process.env.HOOKS_ENFORCE === '0' || process.env.MILESTONE_VERIFY_ENFORCE === '0') return {};
  if (!obj) return {};

  const root = resolveProjectRoot(obj);
  if (!root) return {};

  const scopePath = scopePathFor(root);
  const scope = readScope(scopePath);
  if (!scope) return {};

  const decomp = Array.isArray(scope.decomposition) ? scope.decomposition : [];

  if (decomp.length === 0) {
    const files = realFiles(scope.files ?? []);
    if (files.length >= 2) {
      const cid = conversationId(obj);
      const cap = parseDecomposeCap();
      const { shouldNudge, nudgeCount } = throttle(cid, 'decompose', files.length, cap);
      if (shouldNudge) {
        return { additional_context: buildDecompNudge(nudgeCount, files.length, files) };
      }
    }
    return {};
  }

  const files = (Array.isArray(scope.files) ? scope.files : [])
    .map((f) => scopeRelativePath(String(f), root))
    .filter(Boolean);
  if (files.length === 0) return {};

  const verifications = Array.isArray(scope.verifications) ? scope.verifications : [];
  const anyVerdict = new Set();
  const recordedVerdict = new Map();
  for (const v of verifications) {
    if (v && v.step !== undefined && v.verdict !== undefined) {
      const s = Number(v.step);
      anyVerdict.add(s);
      recordedVerdict.set(s, String(v.verdict));
    }
  }

  const decompSteps = new Set();
  for (const d of decomp) {
    if (d && d.step !== undefined) {
      const s = Number(d.step);
      if (Number.isFinite(s)) decompSteps.add(s);
    }
  }

  const scraped = getLastVerdict(obj);
  if (scraped && decompSteps.has(scraped.step) && allowVerdictUpgrade(recordedVerdict, scraped.step, scraped.verdict)) {
    const entry = { step: scraped.step, verdict: scraped.verdict, diagnosis: scraped.diagnosis };
    setVerdict(scopePath, entry);
    anyVerdict.add(scraped.step);
    recordedVerdict.set(scraped.step, scraped.verdict);
  }

  const filesSet = new Set(files.map((f) => f.toLowerCase()));

  for (const step of decomp) {
    if (!step || step.step === undefined) continue;
    const stepNum = Number(step.step);
    if (!Number.isFinite(stepNum)) continue;
    if (anyVerdict.has(stepNum)) continue;

    const expected = Array.isArray(step.expected_files) ? step.expected_files : [];
    const expectedRel = expected.map((e) => scopeRelativePath(String(e), root)).filter(Boolean);
    if (expectedRel.length === 0) continue;

    const allTouched = expectedRel.every((ef) => filesSet.has(ef.toLowerCase()));
    if (!allTouched) continue;

    const entry = { step: stepNum, verdict: 'PENDING', diagnosis: 'auto: all expected_files touched' };
    setVerdict(scopePath, entry);

    const subtask = typeof step.subtask === 'string' && step.subtask ? step.subtask : '(no subtask declared)';
    const total = decomp.length;
    const msg = `VERIFY MILESTONE step ${stepNum} of ${total}: ${subtask}\n  All ${expectedRel.length} expected_files touched (recorded PENDING). Emit 'ACCEPT step ${stepNum}' or 'REVISE step ${stepNum}: <one-line diagnosis>'.`;
    return { additional_context: msg };
  }

  return {};
}

function parseDecomposeCap() {
  const raw = process.env.DECOMPOSE_NUDGE_CAP;
  if (!raw) return DECOMPOSE_CAP_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DECOMPOSE_CAP_DEFAULT;
}

runHookMain(run, import.meta.url);
