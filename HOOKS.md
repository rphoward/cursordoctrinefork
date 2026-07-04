# Hook reference

Four active hooks. No shared modules. No stashes. No `.scope.json` tracking beyond Step 0.

| Event | Hook | Purpose |
|------|------|---------|
| `sessionStart` | `inject-doctrine.mjs` | Injects governing context at session start. |
| `preToolUse` | `step0-gate.mjs` | Hard gate requiring Step 0 before writes. |
| `beforeShellExecution` | `permission-gate.mjs` | Denies irreversible shell commands, including `git push --force`. |
| `stop` | `final-review.mjs` | Emits one review follow-up across the Ponytail axes when edits occurred. |

Supporting docs:
- `hooks/doctrine.md` — injected doctrine content
- `hooks/final-review.md` — the final-review prompt and verdict rules
