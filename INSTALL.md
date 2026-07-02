# Agent prompt: install the cursordoctrine hooks

> Fast path: if Node 18+ is on the machine, `npx cursordoctrine@latest install`
> does step 2 (including the hooks.json merge), and `npx cursordoctrine verify`
> does step 3. Then restart Cursor and continue from step 4. The prompt below
> is the manual path for machines without Node. Run `npx cursordoctrine sweep`
> on demand for a whole-codebase anti-slop cleanup.

> Paste everything below this line into a Cursor agent chat on the target machine.

---

Install the cursordoctrine hook package for Cursor on this machine, then verify it works. This package is for Cursor only — do not wire it into any other tool, project, or editor config.

If `node --version` shows Node 18 or newer, prefer the npm installer: run `npx cursordoctrine@latest install`, then `npx cursordoctrine verify`, then skip to step 4. Otherwise continue with the manual steps.

## 1. Confirm prerequisites

The hooks run on Node — one engine, every platform. Before touching anything, confirm:

- `node --version` shows Node 18 or newer. If not, install it (https://nodejs.org/ or `winget install OpenJS.NodeJS` / your distro's `nodejs` package). The unified engine will not run without it.
- `git` on PATH (used by `scope-git-sweep` and `final-review` change detection).
- Python 3.9+ (optional) — only for the anti-slop scanner (`cursordoctrine sweep`) and the minimality metric in `final-review`. Both fail open when Python is absent.

## 2. Copy the files

From the repo root — same commands on Windows and Linux (PowerShell or bash):

```powershell
New-Item -ItemType Directory -Force "$HOME\.agents\hooks", "$HOME\.cursor", "$HOME\.cursor\skills" | Out-Null
Copy-Item hooks\* "$HOME\.agents\hooks\" -Recurse -Force
# hooks.json ships with ~/ placeholders that Cursor expands; copy as-is:
Copy-Item hooks.json "$HOME\.cursor\hooks.json" -Force
Copy-Item skills\anti-slop "$HOME\.cursor\skills\" -Recurse -Force
```

```bash
mkdir -p ~/.agents/hooks ~/.cursor/skills
cp -r hooks/* ~/.agents/hooks/
cp hooks.json ~/.cursor/hooks.json
cp -r skills/anti-slop ~/.cursor/skills/
```

If `~/.cursor/hooks.json` already exists, merge the hook entries instead of overwriting — preserve anything the user already has. (The npm installer does this merge for you; by hand, paste the seven event blocks from the shipped `hooks.json` into the existing file, keeping foreign entries.)

## 3. Verify before restarting Cursor

Run each hook by hand with a fake payload and confirm the output. Every hook must exit 0; none of them may hang.

```bash
echo '{"command":"git push --force"}' | node ~/.agents/hooks/permission-gate.mjs   # expect "permission":"deny"
echo '{"command":"git status"}'       | node ~/.agents/hooks/permission-gate.mjs   # expect {"permission":"allow"}
# final-review needs a git repo to find changes. Seed a tiny one and modify a file:
mkdir -p /tmp/cd-verify && cd /tmp/cd-verify && git init -q && echo a > f.txt && git add . && git commit -q -m init && echo b > f.txt
echo '{"conversation_id":"t1","status":"completed","cwd":"/tmp/cd-verify"}' | node ~/.agents/hooks/final-review.mjs   # expect {"followup_message": ...}
echo '{"conversation_id":"t1","status":"completed","cwd":"/tmp/cd-verify"}' | node ~/.agents/hooks/final-review.mjs   # expect {} (brake armed)
echo '{}' | node ~/.agents/hooks/inject-doctrine.mjs                                # expect {"additional_context": ...}
python ~/.cursor/skills/anti-slop/scripts/scan_slop.py --help                       # expect usage text (optional)
rm -rf /tmp/cd-verify
```

On Windows use `python` instead of `python3` and adjust the temp path (`C:\tmp\cd-verify`). The hook commands are identical — `node ~/.agents/hooks/<name>.mjs` works on both platforms.

Also validate the config: `~/.cursor/hooks.json` must parse as JSON, and every `command` must start with `node ~/.agents/hooks/`.

## 4. Verify inside Cursor

1. Restart Cursor (hooks.json is read at startup).
2. Open any project and start a new agent chat. The doctrine should be in context — ask the agent "what does your doctrine say about diffs?" and it should answer from §1 and §3.
3. Ask the agent to run `git push --force` (in a throwaway repo). The permission gate must block it.
4. Finish a small implementation in a git repo and stop. A single `FINAL REVIEW` follow-up should fire — exactly once. The follow-up lists the files git sees as changed (tracked diff + untracked new files), prepends your last user message for intent trace, and asks the model to audit across eight axes. Non-git projects use `.scope.json` `files[]` as the change surface.
5. Type `/anti-slop` in a chat (or say "remove the AI slop") — the anti-slop skill should load and run the scanner as its first step.
6. (Optional) Run `npx cursordoctrine sweep` for a whole-codebase anti-slop audit with a category-by-category breakdown and a cleanup handoff.

## 5. Report

Tell the user what was installed, which checks passed, and anything that failed with the exact error. Do not silently work around a failing check.

Kill switches if something misbehaves: `HOOKS_ENFORCE=0` (everything off), `PERM_GATE_ENFORCE=0`, `FINAL_REVIEW_ENFORCE=0`.

## FINAL REVIEW didn't fire?

The `stop` hook only auto-submits a review when all of these are true:

1. **Git sees changes** — `git diff HEAD` plus untracked files must be non-empty. If the agent committed everything before stopping, there is nothing to review.
2. **`status` is `completed`** — aborted or errored stops skip review.
3. **Project root resolves** — the hook needs `cwd`, `workspace_roots`, or a git repo as the process working directory.
4. **No orphaned brake** — stale `~/.cursor/.hooks-pending/reviewed-<cid>.flag` files from a crashed session are cleared automatically; if review still never fires, delete any `reviewed-*.flag` files and retry.

**Debug trace:** set `FINAL_REVIEW_DEBUG=1` in your environment, restart Cursor, finish an implementation, then read `~/.cursor/.hooks-pending/last-final-review.log`. The last line records why the hook emitted or stayed quiet (`emitted`, `no_diff`, `loop_limit`, `stale_flag_cleared`, etc.).

**After install:** restart Cursor so `~/.cursor/hooks.json` is reloaded. Re-run `npx cursordoctrine verify` to confirm the hook pack is healthy.
