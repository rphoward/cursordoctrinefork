# Install

Fast path: Node 18+ on PATH.

```bash
npx cursordoctrine@latest install
npx cursordoctrine verify
```

Then restart Cursor.

What you get:
- `~/.agents/hooks/` with four hooks copied from `hooks/`
- `~/.cursor/hooks.json` wiring the canonical event set

Uninstall:
```bash
npx cursordoctrine uninstall
```
