# Hook reference — lite pack

Four active hooks. No shared modules. No stashes. No `.scope.json` tracking beyond Step 0.

| Event | Hook | Purpose |
|------|------|---------|
| `sessionStart` | `inject-doctrine.mjs` | Inject `doctrine.md` as session `additional_context`. |
| `preToolUse` | `step0-gate.mjs` | Deny Write-class edits when `.scope.json` `intent` is empty or `decomposition[]` is missing for multi-file work. |
| `beforeShellExecution` | `permission-gate.mjs` | Deny irreversible shell commands, including `git push --force`. |
| `stop` | `final-review.mjs` | Emit one review follow-up across eight axes when edits occurred. |

Kill switches:
- `HOOKS_ENFORCE=0` disables everything.
- Per-hook: `STEP0_GATE_ENFORCE=0`, `PERM_GATE_ENFORCE=0`, `FINAL_REVIEW_ENFORCE=0`.

State:
- Live state is only `~/.cursor/.hooks-pending/*` for the final-review brake.
- The only repo file is `.scope.json`.
