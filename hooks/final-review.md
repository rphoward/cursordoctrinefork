Re-read the diff first; scope to this session's changes. Run axes in order.
Untraceable/hallucinated work reverts; everything else gets fixed in place.
Clean axis = one line — don't manufacture work.

## Report format (MANDATORY — emit this block EXACTLY, then stop)

One line per axis, no prose between lines. Trivial diffs (1 file, <10 lines,
typo/literal): collapse to axes 0+1 only, mark 2–6 N/A and 7 SKIP.

    - **0 Intent trace**: PASS | FAIL — <one line>
    - **1 Correctness**: PASS | FAIL — <one line>
    - **2 Reliability**: PASS | FAIL | N/A — <one line>
    - **3 Coverage**: PASS | FAIL | N/A — <one line>
    - **4 Anti-slop**: PASS | FAIL — <one line>
    - **5 Wiring**: PASS | FAIL | N/A — <one line>
    - **6 Mechanics**: PASS | FAIL | N/A — <one line>
    - **7 Role-trace**: PASS | FAIL | SKIP — <one line>

    **Verdict**: ACCEPT | REVISE

Rules: PASS = clean. FAIL = real issue — fix it NOW, then the line becomes
`PASS — fixed: <what>`. N/A = axis doesn't apply. SKIP = axis 7 only, trivial
one-liner (<=1 file). ACCEPT = all axes PASS/N/A/SKIP — stop immediately after
the report. REVISE = unresolved FAILs remain (the harness re-reviews the new
diff automatically). No summary paragraph, no explanation unless an axis FAILs.

## 0. Intent trace (run FIRST — outranks all other axes)
"Clean code, wrong feature" is the worst failure; no later axis catches it.
- [ ] Every hunk traces to a sentence in ORIGINAL REQUEST. None → hallucinated → revert.
- [ ] Prior-turn hunks (in working tree at turn start) → prior accepted work → leave.
- [ ] Non-doctrine fallback only: touched but not in git diff/untracked → scope creep IF added this turn → revert.
- [ ] Unsure if a hunk is yours-this-turn → ASK, never auto-revert.
- [ ] No ORIGINAL REQUEST (sandboxed run) → skip this axis.
- [ ] `.scope.json` `intent` non-empty AND reflects THIS turn's task — YOUR restatement, not a prompt copy. Empty/[DRAFT] → write it now; FAIL until written.

## 1. Correctness
- [ ] Logic does what the task requires (re-read the request, not the diff).
- [ ] Edge cases: null / empty / zero / negative / boundary / very-large.
- [ ] Language traps: `==` vs `===`, mutable default args, `await` in `forEach`,
  floating promises, `== null`, `NaN`, int/float, tz/encoding.
- [ ] Security: no hardcoded secret, no `eval`/`exec`, no SQL-string-concat on
  input, no unsafe HTML with untrusted data.

## 2. Reliability
- [ ] No empty `catch`, no swallowed error, no silent fallback that hides a bug.
- [ ] External calls (net/fs/db/subprocess) have error handling + timeouts/retries.
- [ ] Resources released on every path (files, handles, sockets, locks, listeners, timers).
- [ ] No new races; shared mutable state guarded; idempotent ops stay idempotent.
- [ ] Inputs validated at the boundary (auth, parsing, untrusted sources).

## 3. Coverage
- [ ] Behaviour-bearing changes have tests asserting real OUTCOMES (not "it runs",
  not an impl mirror, not a test that can't fail).
- [ ] RUN the suite if present; make it pass. Add missing; delete tautological.
- [ ] Linters at max, zero new findings: Biome `--error-on-warnings`, Semgrep
  `--config auto --error`, Ruff `--select ALL`, ESLint `--max-warnings=0`.
- [ ] `.scope.json` declared acceptance → that's the bar.

## 4. Anti-slop
- [ ] Apply the anchors in `~/.agents/hooks/anti-slop.md` to every hunk (source of truth).
- [ ] If scanner available: `python ~/.cursor/skills/anti-slop/scripts/scan_slop.py <files>`.
  NEVER `--all` at review time — audits pre-existing code; whole-codebase audit is `cursordoctrine sweep`.
- [ ] MINIMALITY: read the injected MINIMALITY line. DISPROPORTIONATE → justify
  every file/line or trim. A bug fix is surgical — added nesting, branching,
  validation, renames, helpers, or restructuring beyond the fix is over-editing
  (Added Cognitive Complexity ~0 for a fix). Functionally correct is not enough.

## 5. Wiring completeness
- [ ] Every user-visible change traces click → handler → call → store → render → REAL EFFECT.
- [ ] No dead ends: handler that doesn't persist, endpoint no caller invokes,
  DB write nothing reads, component never mounted, hook declared never consumed.
- [ ] No placeholders standing in for effect: `TODO` / empty body / `console.log`.
  Wire it now OR remove the dead half. Later-stubs: `TODO(wire):` naming what's missing.

## 6. Mechanics & stack integrity
Fix by name — delete and write the correct pattern.
- [ ] State: inline `Date.now()` / `Math.random()` / `process.env` in logic → inject. In-place mutation of shared state → new structures.
- [ ] Side effects not covered by anti-slop: zombie listeners, God components, index-as-key, Tailwind soup, N+1 loops, non-idempotent retries.

## 7. Role-trace (FAIL if decomposition is empty on a multi-file task)
- [ ] Each declared step has a recorded verdict (else unfinished — verify or remove the step).
- [ ] Every verdict is ACCEPT (open REVISE → fix, then re-emit `ACCEPT step N`; never edit verifications[] by hand).
- [ ] No files touched this session outside any step's `expected_files` (else cross-step leakage — justify or revert).
- [ ] Multi-file task (footprint >= 2) with empty decomposition → FAIL. Declare `decomposition[]` now: `{ step, subtask, expected_files }` each. SKIP only for a genuine <=1-file one-liner.
