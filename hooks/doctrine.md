doctrine: Injected once at session start from `doctrine.md`.
You own three fields in `.scope.json` in the repo root:
- `prompt` — hook-owned, do not edit.
- `intent` — your Step 0 restatement, NOT the verbatim request.
- `acceptance` — deterministic done-check.
Step 0: fill `intent` and `acceptance` BEFORE your first edit.
If `.scope.json` does not exist, create it with empty `intent`, `decomposition: []`, `files: []`, and a sharp `acceptance`.
