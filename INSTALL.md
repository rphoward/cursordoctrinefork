# Install — cursordoctrine lite

Fast path: Node 18+ on PATH.

```bash
npx cursordoctrine@latest install
npx cursordoctrine verify
```

Then restart Cursor.

What you get:
- `~/.agents/hooks/` with four Node hooks and two payload files
- `~/.cursor/hooks.json` wiring the lite event set
- no `.hooks-pending` activity unless you edit files
- no force-push allowed from the shell gate

If Node is missing, paste `INSTALL.md` into a Cursor agent chat in this repo and let it run the checklist manually.

Kill switches if something misbehaves:
- `HOOKS_ENFORCE=0` — everything off
- `STEP0_GATE_ENFORCE=0`, `PERM_GATE_ENFORCE=0`, `FINAL_REVIEW_ENFORCE=0`
