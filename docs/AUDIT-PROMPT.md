# Agent prompt: full cursordoctrine audit (Cursor hooks spec)

> Paste everything below the `---` line into a Cursor agent chat **in this repo**.
> This is a **read-only audit** unless the user explicitly asks you to fix findings.
> Official spec: https://cursor.com/docs/agent/hooks (fetched 2026-06-22).

---

You are auditing the **cursordoctrine** npm package — a user-level Cursor hook pack
installed to `~/.agents/hooks/` + `~/.cursor/` via `npx cursordoctrine install`.
Your job is to verify every file against the **Cursor hooks specification** and
hook-pack best practices **without recommending changes that would break the
designed hook chain or fail-open safety model**.

## Ground rules (non-negotiable)

1. **Read-only by default.** Report findings in a structured table. Do not edit
   files unless the user says "fix the audit findings."
2. **Preserve the hook chain.** These events form one pipeline — do not suggest
   collapsing, reordering, or removing steps without proving Cursor supports it:
   - `beforeSubmitPrompt` → `intent-precompile` (writes `.scope.json`)
   - `sessionStart` → `inject-doctrine` (governing text)
   - `preToolUse` → `step0-gate` (deny Write/StrReplace/ApplyPatch without a contract)
   - `afterFileEdit` → `scope-refresh` (record + stash; fires on ALL edits)
   - `postToolUse` → `scope-drain` + `scope-git-sweep` + `milestone-verify` + `intent-anchor` (deliver stash as `additional_context`)
   - `beforeShellExecution` → `permission-gate` (deny list)
   - `stop` → `final-review` (`followup_message` + one-shot brake)
3. **Preserve fail-open semantics.** Script internal errors must exit `0` and
   allow the session to continue. Only `permission-gate` may emit
   `"permission":"deny"` for matched dangerous commands. Do **not** recommend
   `failClosed: true` on `beforeShellExecution` unless the user explicitly
   wants deny-on-timeout over availability (current design: `failClosed: false`).
4. **Preserve the stash-and-drain pattern.** Cursor does **not** consume
   `afterFileEdit` stdout for context injection. `scope-refresh` → file stash →
   `scope-drain` on `postToolUse` is intentional. Do not suggest replacing it
   with direct `afterFileEdit` output.
5. **hooks.json spec-clean.** Only documented keys per Cursor docs:
   `command`, `timeout`, `loop_limit`, `failClosed`, `matcher`, `type`.
   No invented fields.
6. **Single Node engine.** One `hooks/` tree, one `.mjs` per hook, three shared
   modules (`hook-common.mjs`, `contract-store.mjs`, `session-state.mjs`). There
   is no platform split to keep in parity — Windows and Linux run the same
   `node ~/.agents/hooks/<name>.mjs` command. Flag any re-introduction of
   `.ps1`/`.sh` duplicates or parity checks as scope creep.
7. **Verify after any fix:** `node bin/cli.mjs verify` (or `npx cursordoctrine verify`
   from an install). All checks must pass.

---

## Cursor hooks spec checklist (apply to every hook)

Source: https://cursor.com/docs/agent/hooks

| Rule | What to check |
|------|----------------|
| **version** | `hooks.json` has `"version": 1` |
| **stdin JSON** | Every command hook reads stdin; never blocks on unread stdin |
| **stdout JSON** | Valid JSON on stdout when emitting; `{}` when no-op |
| **exit codes** | `0` = success; `2` = block (only if intentionally used); other non-zero = fail-open unless `failClosed: true` |
| **Event output fields** | Only fields documented for that event (see table below) |
| **Matchers** | JavaScript-style regex, not POSIX (`^Write$` or omitted in JSON) |
| **timeout** | Set and reasonable (this pack: 5s except `stop` 30s) |
| **loop_limit** | Only on `stop` / `subagentStop`; this pack uses `3` on `stop` |
| **failClosed** | Explicit where set; matches script fail-open/fail-closed intent |
| **User hook paths** | Commands reference `node ~/.agents/hooks/<name>.mjs`; Cursor expands `~/` to the profile path at runtime |
| **Runtime** | `node` 18+ on PATH; no `chmod` needed (`.mjs` is not an executable script type) |

### Event → allowed output (must match implementation)

| Event | Script | Allowed output fields | This pack emits |
|-------|--------|----------------------|-----------------|
| `beforeSubmitPrompt` | intent-precompile | May block/rewrite prompt (spec); this pack **never blocks** | *(none — side-effect only)* |
| `sessionStart` | inject-doctrine | `additional_context` | `additional_context` |
| `preToolUse` | step0-gate | `permission`, `user_message`, `agent_message` | allow/deny JSON |
| `afterFileEdit` | scope-refresh | *(spec: edit control; stdout not used for context here)* | *(none — stash file)* |
| `postToolUse` | scope-drain (+ sweep, milestone-verify, intent-anchor) | `additional_context` | `additional_context` |
| `beforeShellExecution` | permission-gate | `permission`, `user_message`, `agent_message` | allow/deny JSON |
| `stop` | final-review | `followup_message` (only when `status === "completed"`) | `{}` or `followup_message` |

---

## File inventory — audit each path

Read every file below. For each, produce: **Status** (PASS / WARN / FAIL),
**Spec alignment**, **Notes**.

### A. Hook wiring

| File | Audit focus |
|------|-------------|
| `hooks.json` | All 7 events wired; timeouts; matcher `Write\|StrReplace\|ApplyPatch\|Edit\|MultiEdit\|Replace` on `preToolUse`; no matcher on `afterFileEdit` (fires on ALL edits); `failClosed: false` on `beforeShellExecution`; `loop_limit: 3` on `stop`; every command is `node ~/.agents/hooks/<name>.mjs` |

### B. Shared modules (one engine, three owners)

| File | Audit focus |
|------|-------------|
| `hooks/hook-common.mjs` | stdin/stdout (BOM strip, ASCII-safe JSON), `resolveProjectRoot` (cwd → workspace_roots → CURSOR_PROJECT_DIR → PWD project-marker guard, never bare `$HOME`), `conversationId` transcript fallback, `extractLastUserQuery` skips hook-generated turns + redacts secrets, `scopeRelativePath` (Windows drive case-insensitive, backslash normalize, parent-traversal guard), `getLastVerdict` transcript scrape, `runMinimality`, `runHookMain`/`isMainModule` via `import.meta.url` |
| `hooks/contract-store.mjs` | Owns the `.scope.json` shape: `resetScope`/`continuationScope`/`readScope`/`writeScopeAtomic`/`updateScope`/`recordFiles`/`mergeFiles`/`setVerdict`/`intentNeedsStep0`/`acceptanceIsDefault`/`realFiles`/`contractSignature`; atomic write + lock; no shape re-declaration elsewhere |
| `hooks/session-state.mjs` | Owns `~/.cursor/.hooks-pending/`: `stash`/`drain`/`readStash`/`clearStash`, `writeSessionStartStamp`/`ensureSessionStartStamp`/`getSessionStartUtc`/`pathModifiedSinceSession`, `readNudge`/`writeNudge`/`throttle`, `touchReviewedFlag`/`readReviewedFlag`/`clearReviewedFlag`/`handleReviewedFlag`, 7-day stale sweep |

### C. Hook scripts (one `.mjs` per hook)

| Hook | File | Audit focus |
|------|------|-------------|
| **intent-precompile** | `intent-precompile.mjs` | Kill switches `HOOKS_ENFORCE`, `INTENT_PRECOMPILE_ENFORCE`; reads `prompt` from stdin; skips hook-generated prefixes; no repo root → silent exit; writes `prompt` (hook-owned), seeds `intent = ""` on new/fresh; Jaccard topic change resets scope; stashes `STEP 0 CONTRACT` to `precompile-<cid>.txt` when contract incomplete; preserves agent fields on continuation; never blocks |
| **inject-doctrine** | `inject-doctrine.mjs` | No kill switch; drains stdin; prefers `~/.cursor/doctrine.md` override else `HOOKS_DIR/doctrine.md`; emits `additional_context`; stamps `sessionStart`; fail-open `{}` |
| **step0-gate** | `step0-gate.mjs` | Kill switch `STEP0_GATE_ENFORCE`; always allows `.scope.json`; denies edits when `intent` empty/`[DRAFT]`; denies a second distinct file when `files[]` has >=1 real entry and `decomposition[]` empty; fail-open when no `.scope.json`/no root/unparseable target |
| **scope-refresh** | `scope-refresh.mjs` | Kill switches `HOOKS_ENFORCE`, `SCOPE_REFRESH_ENFORCE`; requires `.scope.json`; records edited path into `files[]` (dedup, never `.scope.json`, prunes placeholders); early-returns for `.cursor/plans/**`; stashes reminder to `scope-<cid>.txt`; signature-gated (full text only when contract changed); silent without contract |
| **scope-drain** | `scope-drain.mjs` | One-shot: drain `precompile-<cid>.txt` and/or `scope-<cid>.txt`, delete on read, emit combined `additional_context`; silent when no stash; shares kill switch with scope-refresh |
| **scope-git-sweep** | `scope-git-sweep.mjs` | Kill switches `HOOKS_ENFORCE`, `SCOPE_REFRESH_ENFORCE`; only after Shell/Bash tools (not Edit tools); unions git-changed paths modified after `session-start-<cid>.txt` into `files[]`; ignores `.cursor/plans/**`; never emits context |
| **milestone-verify** | `milestone-verify.mjs` | Kill switches `HOOKS_ENFORCE`, `MILESTONE_VERIFY_ENFORCE`; emits `VERIFY MILESTONE step N` when step's `expected_files` all touched and no verdict; scrapes `ACCEPT/REVISE step N` (incl. loosened phrasings) from transcript into `verifications[]`; auto-writes `PENDING`; `DECOMPOSE` nudge on >=2 files with empty decomposition (throttled, cap `DECOMPOSE_NUDGE_CAP`); silent on empty decomposition with <2 files |
| **intent-anchor** | `intent-anchor.mjs` | Kill switches `HOOKS_ENFORCE`, `INTENT_ANCHOR_ENFORCE`; re-fires when contract incomplete AND (never nudged OR new files edited); per-cid flag stores `filesCount:nudgeCount`; cap `INTENT_ANCHOR_NUDGE_CAP` (default 99999); silent permanently once both fields filled |
| **permission-gate** | `permission-gate.mjs` | Kill switch `PERM_GATE_ENFORCE`; deny list (rm -rf absolute, fork bomb, curl\|sh, wget\|sh, git push --force, reset --hard, clean -f, dd/mkfs to devices, chmod/chown -R on /, npm/pnpm/yarn publish, recursive forced delete of drive/Users/Windows root); anchored patterns avoid false positives (`git rm`, echo); reads raw stdin command; internal error → allow; exit 0 always |
| **final-review** | `final-review.mjs` | Kill switches `HOOKS_ENFORCE`, `FINAL_REVIEW_ENFORCE`; only `status === completed`; `reviewed-<cid>.flag` verify-revise brake (SHA256 content-hash signature of diff scoped to `files[]`; re-reviews if changed, ends if same); 7-day stale sweep; git diff HEAD + untracked (falls back to `.scope.json` `files[]` for non-git projects); `.scope.json` declared vs touched diff; role-trace from `decomposition[]`; intent from scope then transcript; arms flag before emit; `loop_limit: 3`; `final-review.md` resolved next to the engine (REQUIRED); minimality metric via `minimality.py` (fail-open without Python) |

### D. Prompt bodies (payload files shipped in `hooks/`)

| File | Audit focus |
|------|-------------|
| `hooks/final-review.md` | Eight axes (0-7); structured bullet report with ACCEPT/REVISE verdict; intent trace rules; `[DRAFT]` detection; prior-turn work guard; `.scope.json` declared scope; scanner scoped not `--all` |
| `hooks/doctrine.md` | ~80 lines; `.scope.json` contract matches intent-precompile + scope-refresh behavior; no contradiction with HOOKS.md |
| `hooks/minimality.py` | Stdlib-only; emits SUMMARY block with `worstRatio`/`worstFile`; consumed by `final-review.mjs` via `runMinimality`; fail-open when absent |

### E. CLI installer

| File | Audit focus |
|------|-------------|
| `bin/cli.mjs` | `install` copies `hooks/` (`.mjs` + `.md` + `.py`, excluding `__pycache__`) to `~/.agents/hooks/`; copies `skills/anti-slop/`; merges (not overwrites) `~/.cursor/hooks.json`; reaps legacy `windows/`/`linux/` (`.ps1`/`.sh`) packs + retired keys via `LEGACY_HOOK_FILES`/`LEGACY_CURSOR_FILES`; `isOurs`/`keyOf`/`isStaleOurs` keyed on `node ~/.agents/hooks/<name>.mjs`; `runHook` spawns `node`; prereq checks for node/python/git; `verify` runs the registry; `sweep`/`uninstall` intact; Node >= 18, zero deps |
| `bin/verify.mjs` | Thin runner: loads `bin/checks/index.mjs`, applies `--only`/`--filter`, prints grouped report; must stay <700 lines |
| `bin/fixture.mjs` | `withRepo`/`withScope`/`withGitRepo`/`runHook`/`writeTranscript`/`stampSession` helpers; isolated temp dirs; env-sandboxed |
| `bin/checks/*.mjs` | One module per hook + `install`/`sweep`/`c6`; each exports `checks(ctx)`; registry aggregates via `allChecks` |
| `package.json` | `files` ships `hooks/` + `hooks.json` + `bin/` + `skills/anti-slop/`; `scripts.test` = `install && verify`; `scripts.verify` = `verify`; version matches changelog intent |

### F. Documentation

| File | Audit focus |
|------|-------------|
| `HOOKS.md` | Matches actual events (7 events); kill switches complete; stash-drain explained; state paths under `~/.cursor/.hooks-pending/`; no `.ps1`/`.sh` references |
| `README.md` | Install path, prerequisites (node 18+, git, optional python), verify command, session vs sweep; layout shows the unified `hooks/` tree; **flag** if "fail closed" wording contradicts permission-gate fail-open |
| `INSTALL.md` | Manual steps match cli.mjs behavior (copy `hooks/`, merge `hooks.json`, `node ~/.agents/hooks/<name>.mjs` verify payloads); no windows/linux split |

### G. Anti-slop skill

| File | Audit focus |
|------|-------------|
| `skills/anti-slop/SKILL.md` | Describes on-demand sweep; does not claim to replace hooks; references `final-review.mjs` (not `.ps1`/`.sh`) |
| `skills/anti-slop/scripts/scan_slop.py` | Runnable; used by `sweep`; no false coupling to session review `--all`; imports `low_density` at runtime to avoid a module-load cycle |
| `skills/anti-slop/scripts/low_density.py` | Shared scorer for `scan_slop.py` `semantic_density` bucket; imports shared leaf from `_language.py` |
| `skills/anti-slop/scripts/_language.py` | Shared leaf extracted to break the `scan_slop` ↔ `low_density` circular import; no scanner logic duplicated |

---

## Hook-chain integrity tests (conceptual — confirm code matches)

Answer each yes/no with evidence (file:line or verify output):

1. **intent-precompile** does NOT overwrite `files[]` on a new user prompt when contract exists.
2. **intent-precompile** does NOT treat `FINAL REVIEW...` or `SCOPE REMINDER` as user intent.
3. **scope-refresh** writing `.scope.json` via shell does NOT re-trigger infinite `afterFileEdit` loop.
4. **scope-drain** deletes stash before emit so a crash cannot replay forever.
5. **final-review** second consecutive `stop` returns `{}` (brake cleared).
6. **final-review** on clean repo (no diff) returns `{}`.
7. **permission-gate** allows `git status`, denies `git push --force`.
8. **resolveProjectRoot** never falls back to bare `$HOME` (ghost `.scope.json` guard).
9. **inject-doctrine** missing file → `{}`, session still starts.
10. **Hook skip lists** (intent-precompile case prefixes vs `extractLastUserQuery` HOOK_HDR regex vs `scan_slop.py` patterns) are in sync.
11. **`isMainModule`** receives the entry module's `import.meta.url` (not the shared module's) so `runHookMain` actually fires.
12. **`matchAll`** regexes in `getLastVerdictFromText` carry the global `g` flag.

Run: `node bin/cli.mjs verify` and attach pass/fail summary.

---

## Best-practice rubric (Cursor hooks + production node)

Score each category PASS/WARN/FAIL:

| Category | Criteria |
|----------|----------|
| **Determinism** | Permission decisions and scope recording do not depend on LLM; prompt hooks not used where command hooks suffice |
| **Idempotency** | `install` re-runnable; merge preserves foreign hooks; stale hook reaper safe |
| **Observability** | Failures fail silently to user session (by design) — document where to debug (Hooks output channel, `FINAL_REVIEW_DEBUG=1`) |
| **Security** | Deny list covers irreversible ops; secrets redacted in intent trace; no secrets in repo |
| **Portability** | One Node engine on Windows + Linux; git required for final-review; python optional for sweep/minimality |
| **Encoding** | JSON stdout ASCII-safe via `JSON.stringify(..., null)` + redaction; no console code-page dependence |
| **State hygiene** | State only under `~/.cursor/.hooks-pending/`; 7-day reap; never commit pending files |
| **Doc truth** | README/HOOKS/INSTALL agree on event count, kill switches, fail-open vs fail-closed |
| **Modularity** | `.scope.json` shape owned by `contract-store.mjs`; pending files owned by `session-state.mjs`; no re-declaration across hooks |
| **YAGNI** | No extra hooks, no prompt-hook overkill, no duplicate state machines, no `.ps1`/`.sh` parity to maintain |

---

## Explicit DO NOT RECOMMEND list

Flag as **process violation** if your audit would suggest any of these:

- Remove `scope-drain` and use `afterFileEdit` output for context injection
- Make `intent-precompile` block prompts or return `beforeSubmitPrompt` deny JSON
- Set global `failClosed: true` on `beforeShellExecution` without user opt-in
- Add undocumented `hooks.json` keys
- Move hooks to project `.cursor/hooks.json` (this pack is **user-level** by design)
- Replace git-based change detection in `final-review` with per-edit marker files
- Make hooks exit non-zero on parse errors (breaks fail-open guarantee)
- Add `preToolUse`/`subagentStop` hooks without a concrete gap (scope creep)
- Use POSIX regex in `hooks.json` matchers (`[[:space:]]`, etc.)
- Re-introduce a `.ps1`/`.sh` platform split or parity checks (the single Node engine is intentional)

---

## Output format (your response)

### 1. Executive summary
3–5 bullets: overall health, highest-risk finding, doc drift, modularity gaps.

### 2. Spec compliance matrix
Table: Event | hooks.json | hook .mjs | Cursor spec | Status

### 3. Findings table
| ID | Severity | File | Finding | Recommendation | Breaks chain? |
|----|----------|------|---------|----------------|---------------|
Use severity: **critical** (wrong spec / data loss / session break), **high** (wrong deny / brake logic), **medium** (doc drift), **low** (style).

### 4. Documentation drift
List contradictions between README, HOOKS.md, INSTALL.md, and code.

### 5. verify output
Paste `node bin/cli.mjs verify` results (run it).

### 6. Fix plan (optional)
Only if user asked to fix: minimal diffs, one commit per logical change, re-run verify.

---

## Quick reference — installed layout after `npx cursordoctrine install`

```
~/.cursor/hooks.json          merged wiring (node ~/.agents/hooks/<name>.mjs)
~/.agents/hooks/*.mjs         the single Node engine + shared modules
~/.agents/hooks/*.md, *.py    payload files (doctrine.md, final-review.md, minimality.py)
~/.cursor/skills/anti-slop/   sweep skill (SKILL.md + scripts/)
~/.cursor/.hooks-pending/     scope-*.txt, reviewed-*.flag, *.flag (runtime, not in repo)
```

Repo source of truth: `hooks/` + `hooks.json` + `bin/` + `skills/`.

Begin the audit now. Read all files in the inventory before writing findings.
