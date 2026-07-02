"""low_density.py - semantic-density scorer (the anti semantic-opacity layer).

Shared source of truth for the semantic-density signal. scan_slop.py imports
`score_identifiers()` to add a thirteenth signal bucket (semantic_density) to
its audit-of-record. One denylist, one execution point, zero drift.

THE INVARIANT
  If you cannot predict what a function/class/file does from its name alone,
  there is semantic debt. DataManager, process(), utils.ts, CoreEngine -
  names that exist but communicate no intent. High-density names
  (InvoiceEmailSender, PostgresUserRepository, GenerateMonthlyReport) pass.

SCORING MODEL (three tiers, deliberately conservative on FAIL)
  FAIL  - the name IS a low-density token, or a generic-suffix class with no
          domain noun before it (DataManager, CoreEngine, process, utils).
          These almost never have a defensible reading.
  WARN  - the name carries a low-density token but has a domain noun, OR is
          an anemic verb alone, OR a 1-2 char id, OR a placeholder
          (UserManager, handle(), fn, x1, tempFix). Suspicious but defensible
          in context; the model judges.
  OK    - none of the above.

The Repository/Service/Provider DDD cases are the false-positive risk. They
land as WARN (not FAIL) when a domain noun precedes them
(PostgresUserRepository -> WARN, kept), and FAIL only when naked
(Repository -> FAIL). Calibrated against real DDD code before shipping.

Stdlib only; Python 3.9+. REPORTS only - never edits.
"""
from __future__ import annotations

import re
import sys
from typing import Any

_SCRIPT_DIR = re.sub(r"[\\/][^\\/]+$", "", __file__) or "."
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from _language import (
    ID, TYPE_DECL, FUNC_PATTERNS, METHOD_JS, METHOD_CSTYLE, NOT_METHOD,
    lang_of, _strip_comments,
)

LOW_DENSITY_TOKENS = frozenset({
    "manager", "mgr", "handler", "processor", "controller", "provider",
    "service", "svc", "engine", "framework", "system", "base", "core",
    "common", "shared", "generic", "universal", "global",
    "data", "info", "thing", "things", "stuff", "object", "item", "entity",
    "business", "misc", "util", "utils", "utility", "helper", "helpers",
    "tool", "tools",
    "temp", "tmp", "new", "old", "current", "local", "main", "simple",
})

LOW_DENSITY_FILENAMES = frozenset({
    "utils", "helpers", "helper", "common", "shared", "manager", "service",
    "provider", "handler", "processor", "engine", "base", "core", "misc",
    "stuff", "things", "temp", "tmp", "generic", "util", "utility",
    "controller", "framework", "system", "business", "global",
})

ANEMIC_VERBS = frozenset({
    "do", "run", "execute", "process", "handle", "manage", "perform",
    "apply", "compute", "calculate", "make", "build", "update",
    "delete", "remove", "add",
})

GENERIC_SUFFIXES = re.compile(
    r"(Manager|Handler|Processor|Controller|Provider|Service|Engine"
    r"|Framework|System|Factory|Builder|Wrapper|Adapter|Resolver"
    r"|Strategy|Mediator|Orchestrator|Registry|Repository)$"
)

PLACEHOLDER = re.compile(
    r"^(temp|tmp|new|old|final|test|fix|copy|backup|draft|wip)"
    r"[A-Z0-9_]"
    r"|^(final){2,}"
    r"|^[a-z]{0,2}\d+$"
    r"|^[a-z]{1,2}$"
    r"|^(foo|bar|baz|qux|tmp|asdf|qwerty)$",
    re.I,
)

def _tokens_of(name: str) -> list[str]:
    """Split a PascalCase / camelCase / snake_case name into lowercased word
    stems. UserEmailSender -> [user, email, sender]. process_data ->
    [process, data]. Single-word names return [self.lower()]."""
    s = re.sub(r"[^A-Za-z0-9]+", " ", name)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    s = re.sub(r"(\d+)$", r" \1", s)
    return [w.lower() for w in s.split() if w]


def _has_domain_noun(tokens: list[str]) -> bool:
    """True if at least one token is neither low-density filler nor an anemic
    verb. DataManager -> tokens [data, manager] -> no domain noun -> False.
    InvoiceEmailSender -> [invoice, email, sender] -> 'invoice' is a noun ->
    True."""
    for t in tokens:
        if t in LOW_DENSITY_TOKENS:
            continue
        if t in ANEMIC_VERBS:
            continue
        return True
    return False


ENTRYPOINT_NAMES = frozenset({"main", "run", "cli", "app"})


Finding = dict[str, Any]


def score_density(name: str) -> tuple[str, list[str]]:
    """Return (severity, reasons) for one identifier name.

    severity in {"ok", "warn", "fail"}. reasons is a list of short human
    strings explaining each contributing rule. Empty reasons + "ok" = clean.

    The function is pure and side-effect free; scan_slop.py relies on that.
    """
    if not name or not name.strip():
        return "ok", []
    name = name.strip()
    lower = name.lower()
    tokens = _tokens_of(name)

    if lower in ENTRYPOINT_NAMES:
        return "ok", []

    if PLACEHOLDER.search(name):
        if re.match(r"^(final){2,}", name, re.I):
            return "fail", ["placeholder name (finalFinal / repeated 'final')"]
        if re.match(r"^[a-z]{0,2}\d+$", name, re.I):
            return "fail", [f"cryptic short id '{name}' - predict nothing"]
        if re.match(r"^[a-z]{1,2}$", name, re.I):
            return "fail", [f"cryptic 1-2 char id '{name}' - predict nothing"]
        return "fail", [f"placeholder name '{name}' - temp/test marker leaked to prod"]

    if len(tokens) == 1 and lower in LOW_DENSITY_TOKENS:
        return "fail", [f"bare low-density token '{name}' - names a category, not a thing"]

    if GENERIC_SUFFIXES.search(name) and not _has_domain_noun(tokens):
        suffix = GENERIC_SUFFIXES.search(name).group(1)
        return "fail", [
            f"{suffix} with no domain noun - predict nothing from the name",
            "fix: replace with verb+noun naming the concrete responsibility",
            "     (e.g. DataManager -> InvoiceRepository or PersistUserSessions)",
        ]

    if GENERIC_SUFFIXES.search(name) and _has_domain_noun(tokens):
        suffix = GENERIC_SUFFIXES.search(name).group(1)
        return "warn", [f"{suffix} suffix (has domain noun -> defensible, still generic)"]

    if len(tokens) == 1 and lower in ANEMIC_VERBS:
        return "warn", [f"anemic verb '{name}()' - names an action without its object"]

    low_hits = [t for t in tokens if t in LOW_DENSITY_TOKENS]
    if low_hits:
        joined = ", ".join(sorted(set(low_hits)))
        if _has_domain_noun(tokens):
            return "warn", [f"low-density token(s) [{joined}] but has domain noun -> defensible"]
        return "fail", [f"low-density token(s) [{joined}] and no domain noun -> opaque"]

    if len(tokens) >= 2 and tokens[0] in ANEMIC_VERBS:
        rest_low = all(t in LOW_DENSITY_TOKENS for t in tokens[1:])
        if rest_low:
            return "fail", [f"anemic verb + filler [{lower}] - action with no real object"]

    return "ok", []


def score_filename(base: str) -> tuple[str, list[str]]:
    """Score a file basename (no extension). utils.ts -> FAIL.
    invoice_totals.ts -> OK. Mirrors score_density for the file-name case."""
    if not base:
        return "ok", []
    stem = re.sub(r"\.[A-Za-z0-9]+$", "", base).lower()
    if stem in LOW_DENSITY_FILENAMES:
        return "fail", [f"file named '{base}' - basename is a generic category, not a module"]
    if stem in {"index", "mod", "main", "app", "server", "test", "tests",
                "conftest", "__init__", "setup"}:
        return "ok", []
    parts = re.split(r"[^a-z0-9]+", stem)
    parts = [p for p in parts if p]
    low_hits = [p for p in parts if p in LOW_DENSITY_FILENAMES]
    if low_hits and not any(p not in LOW_DENSITY_FILENAMES for p in parts):
        return "fail", [f"file '{base}' - all name parts are generic ({', '.join(low_hits)})"]
    if low_hits:
        return "warn", [f"file '{base}' contains generic part(s) ({', '.join(low_hits)}) but has a specific part"]
    return "ok", []


def _def_names_from_patterns(line: str, lang: str) -> list[tuple[str, str]]:
    """Return [(kind, name), ...] for definitions declared on `line`, or [] if
    the line declares nothing. kind in {func, class, type, method}. Uses the
    same FUNC_PATTERNS as scan_slop so definitions parse identically."""
    out: list[tuple[str, str]] = []
    m = TYPE_DECL.search(line)
    if m:
        out.append(("type", m.group(1)))
    cm = re.search(
        r"\b(?:class|struct|trait|protocol|interface|enum)\s+([A-Z][A-Za-z0-9_]*)\b",
        line,
    )
    if cm:
        out.append(("class", cm.group(1)))
    patterns = FUNC_PATTERNS.get(lang, [])
    seen: set[str] = set()
    for rx in patterns:
        fm = rx.search(line)
        if fm:
            cand = fm.group(1)
            if rx in (METHOD_JS, METHOD_CSTYLE) and cand in NOT_METHOD:
                continue
            if cand not in seen:
                seen.add(cand)
                kind = "method" if rx in (METHOD_JS, METHOD_CSTYLE) else "func"
                out.append((kind, cand))
                break
    return out


def extract_identifiers(added_lines: list[str], rel: str) -> list[Finding]:
    """Walk `added_lines` and return identifier findings worth scoring:
    newly DECLARED function/class/type/method names plus the filename itself.

    Only declarations count, not references. We are judging what the agent
    chose to NAME, not every token it touched. A call to `processData(x)` is
    not interesting unless the agent also declared `function processData`.

    Comment lines are skipped: a comment that happens to say "// the Manager"
    is documentation, not a naming decision.
    """
    lang = lang_of(rel)
    if lang == "other":
        base = rel.rsplit("/", 1)[-1]
        sevs, reasons = score_filename(base)
        if sevs != "ok":
            return [{"name": base, "line": 0, "kind": "file",
                     "severity": sevs, "reasons": reasons}]
        return []

    findings: list[Finding] = []
    seen_names: set[str] = set()

    for i, raw in enumerate(added_lines, start=1):
        if not raw.strip():
            continue
        stripped = _strip_comments(raw, lang, "L").strip()
        if not stripped:
            continue
        for kind, name in _def_names_from_patterns(raw, lang):
            if name in seen_names:
                continue
            seen_names.add(name)
            sevs, reasons = score_density(name)
            if sevs != "ok":
                findings.append({"name": name, "line": i, "kind": kind,
                                 "severity": sevs, "reasons": reasons})

    base = rel.rsplit("/", 1)[-1]
    if base and base not in seen_names:
        sevs, reasons = score_filename(base)
        if sevs != "ok":
            findings.append({"name": base, "line": 0, "kind": "file",
                             "severity": sevs, "reasons": reasons})

    return findings


def score_identifiers(added_lines: list[str], rel: str) -> list[Finding]:
    """Convenience wrapper: extract + filter to warn/fail only. This is what
    scan_slop.py's signal bucket calls."""
    return [f for f in extract_identifiers(added_lines, rel) if f["severity"] != "ok"]


def format_for_report(findings: list[Finding]) -> list[str]:
    """Flatten findings into the short strings scan_slop prints per finding."""
    out: list[str] = []
    for f in findings:
        tag = f["severity"].upper()
        kind = f["kind"]
        name = f["name"]
        reason = "; ".join(f["reasons"]) if f["reasons"] else "low semantic density"
        loc = f"line {f['line']}" if f["line"] else "file name"
        out.append(f"[{tag}] {kind} '{name}' ({loc}): {reason}")
    return out


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        cases = [
            ("DataManager", "fail"), ("CoreEngine", "fail"), ("process", "warn"),
            ("InvoiceEmailSender", "ok"), ("PostgresUserRepository", "warn"),
            ("GenerateMonthlyReport", "ok"), ("Helper", "fail"), ("Utils", "fail"),
            ("UserManager", "warn"), ("handle", "warn"), ("doStuff", "fail"),
            ("processData", "fail"), ("x1", "fail"), ("finalFinal", "fail"),
            ("tempFix", "fail"), ("SystemProvider", "fail"),
            ("StripePaymentProvider", "warn"), ("utils.ts", "fail"),
            ("invoice_totals.ts", "ok"), ("SendInvoiceEmail", "ok"),
            ("DiscordWebhookClient", "ok"), ("fn", "fail"), ("Helper", "fail"),
            ("BaseService", "fail"), ("framework", "fail"), ("BusinessProcessor", "fail"),
        ]
        fails = 0
        for name, want in cases:
            sevs, _ = score_density(name) if "." not in name else score_filename(name)
            mark = "OK " if sevs == want else "BAD"
            if sevs != want:
                fails += 1
            print(f"  {mark} {name:<32} got={sevs:<5} want={want}")
        print(f"\n{'PASS' if not fails else f'{fails} FAILURES'}")
        sys.exit(1 if fails else 0)
    for n in sys.argv[1:]:
        sevs, reasons = score_density(n)
        print(f"{n}: {sevs} ({'; '.join(reasons)})")
