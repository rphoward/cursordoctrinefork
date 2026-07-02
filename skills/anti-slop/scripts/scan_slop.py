#!/usr/bin/env python3
"""scan_slop.py - static AI-slop signal scanner for the anti-slop skill.

Reports cheap, high-precision slop signals so the agent starts its de-slop sweep
from a deterministic inventory. Semantic slop (cargo-cult, superficial tests) is
deliberately NOT guessed - that stays the model's job. This seeds it.

Scopes:
  * DIFF (default): only what changed vs --base (git diff). Silent on a clean
    tree by design. Flags NEW deps, premature abstractions, redundant comments,
    AI residue (placeholder phrases / banner comments / emoji), type escapes
    (as any, as unknown as, @ts-ignore, Python type-ignore pragmas), swallowed
    errors (empty catch, broad except+pass), tautological asserts, pointless
    async wrappers (await Promise.resolve, async executors), deepening guard
    chains (the optional-chaining shape), boolean-pair call traps, SELECT *
    in .sql files, Tailwind class soup / magic-px values, and SEMANTIC OPACITY
    (low-density identifiers - DataManager, process(), utils.ts - scored via
    the shared low_density module). All per-file signals also run in AUDIT
    scope; only new-dependency detection is diff-only (every line of an
    existing manifest would otherwise read as "new").
  * AUDIT (--all, or explicit paths): the WHOLE codebase, with the duplication
    analysis that catches the isRecord()-class slop:
      - Clone Proliferation     : same function name in multiple files
      - Knowledge Duplication   : identical body under different names (DRY)
      - Semantic Fragmentation  : near-identical bodies (same shape, drifted
                                  names/values) - the diverged clones
      - Semantic Density Collapse: tiny helpers used 0-1 times (dead / inline)
        (--all only: reference counts over a partial file list are meaningless,
        so explicit-path scans suppress this analysis instead of guessing)
      - Generated Fingerprints  : isRecord/safeParse/sleep/retry/... repeated
      - Duplicate type/interface names across files
    Functions/methods are parsed for JS/TS, Python, Go, Rust, Ruby, PHP, and
    (best-effort) Java/Kotlin/C#/Scala.

Every duplication finding carries a confidence tier: exact (identical
normalized body) > structural (same shape, drifted names/values) > name-only
(same identifier). The report header states the scope; caps that were hit
(file list, per-file lines, per-body lines) are disclosed as notes.

Stdlib only; Python 3.9+. REPORTS only - never edits. Exits 0, except with
--gate: exit 1 when slop is found (the size-only "substantial change" note
never gates). The agent does the fixing.

Usage:
  python scripts/scan_slop.py --all --root .        # WHOLE-codebase audit (recommended)
  python scripts/scan_slop.py --root .              # diff vs HEAD (a change in progress)
  python scripts/scan_slop.py src/foo.ts src/bar.py # audit specific files
  python scripts/scan_slop.py --all --format json   # machine-readable
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from itertools import islice
from typing import Any

_SCRIPT_DIR = re.sub(r"[\\/][^\\/]+$", "", __file__) or "."
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from _language import (
    ID, lang_of, _strip_comments, _mask_strings,
)
from _duplication import (
    BODY_CAP, collect_defs, collect_types, analyze_duplication, dup_has_findings,
)

Finding = dict[str, Any]

MANIFEST = re.compile(
    r"^(package\.json|requirements[\w.\-]*\.txt|pyproject\.toml|Pipfile"
    r"|Cargo\.toml|composer\.json)$"
)
DEP = re.compile(
    r"""(?:^|[{,])\s*(?:"|')?(?P<name>[A-Za-z@][\w@\-./\[\]]*)(?:"|')?\s*"""
    r"""(?:[:=]\s*(?:"|')?[\^~><=*v]?\d|[><=~!]=\s*\d|@\s*\^?\d)"""
)
META_KEYS = frozenset({
    "version", "name", "node", "npm", "yarn", "pnpm", "packagemanager",
    "engines", "python", "private", "description",
})
ABSTRACTION = re.compile(
    r"\b(?:class|interface|struct|trait|protocol)\s+"
    r"([A-Z][A-Za-z0-9_]*(?:Factory|Repository|Mediator|Strategy|Singleton"
    r"|Facade|Builder|Visitor|Decorator|Wrapper|Orchestrator|Registry))\b"
)
VOCAB = re.compile(
    r"\b([C]QRS|Event[\s\-]?Sourc(?:e|ing)|Domain[\s\-]?Driven|Aggregate\s?Root"
    r"|Bounded\s?Context|Hexagonal\s+Architecture|Onion\s+Architecture)\b",
    re.I,
)
COMMENT = re.compile(
    r"^\s*(?://|#|/\*+|\*+)\s*(?:increment|decrement|loop (?:over|through)|iterate"
    r"|returns?(?: the)?(?: result| value)?\s*$|set\s+\w+\s+to\b|getter\b"
    r"|setter\b|constructor\b|initiali[sz]e\b|instantiate\b|create (?:a |an |the )"
    r"|declare\b|define\b|assign\b|end (?:of|for)\b|begin\b|start (?:of|the))",
    re.I,
)
_CMT_MARKER = re.compile(r"^\s*(?://+|#+|/\*+|\*+)\s*")
RESIDUE_PHRASE = re.compile(
    r"\bin\s+a\s+real\s+(?:app(?:lication)?|world|scenario)\b"
    r"|\bfor\s+production\s+use\b|\bthis\s+is\s+a\s+simplified\b"
    r"|\bTODO:?\s+implement\s+actual\b|\breplace\s+(?:this\s+)?with\s+your\b",
    re.I,
)
RESIDUE_BANNER = re.compile(r"^\s*(?://|#|/\*)\s*[=*#]{5,}")
RESIDUE_EMOJI = re.compile("[\u2600-\u27bf\U0001f300-\U0001faff]")
TS_SUPPRESS = re.compile(r"@ts-(?:ignore|nocheck)\b")
TS_ANY = re.compile(r"\bas\s+unknown\s+as\b|\bas\s+any\b|[,:<]\s*any\b|\bany\[\]")
PY_TYPE_ESCAPE = re.compile(r"#\s*type:\s*ignore\b")
_EXC_BROAD = r"^\s*except\b\s*(?:\(?\s*(?:Base)?Exception\s*\)?\s*(?:as\s+\w+\s*)?)?:"
PY_SWALLOW = re.compile(_EXC_BROAD + r"\s*pass\b")
PY_SWALLOW_HEAD = re.compile(_EXC_BROAD + r"\s*(?:#.*)?$")
PY_PASS = re.compile(r"^\s*pass\s*(?:#.*)?$")
JS_SWALLOW = re.compile(
    r"\bcatch\s*(?:\(\s*[^)]*\))?\s*\{\s*\}"
    r"|\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|null|undefined)\s*\)"
    r"|\.catch\(\s*function\s*\(\s*\w*\s*\)\s*\{\s*\}\s*\)"
)
JS_TAUTOLOGY = re.compile(
    r"\bexpect\(\s*(true|false|\d+|'[^']*'|\"[^\"]*\")\s*\)\s*\.\s*"
    r"(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)"
    r"|\bassert(?:True)?\(\s*true\s*\)"
)
PY_TAUTOLOGY = re.compile(r"^\s*assert\s+True\s*(?:$|[,#])|\bassertTrue\(\s*True\s*\)")
ASYNC_WRAPPER = re.compile(
    r"\bawait\s+Promise\s*\.\s*resolve\s*\(|\bnew\s+Promise\s*\(\s*async\b"
)
GUARD_RETURN = re.compile(
    r"^\s*if\s*\(\s*!\s*([\w$][\w$.]*)\s*\)\s*(?:return|continue|break)\b[^;{}]*;?\s*$"
)
BOOL_PAIR_JS = re.compile(
    r"[\w$]\s*\(\s*[^()\[\]{}]*\b(?:true|false)\s*,\s*(?:true|false)\b"
)
BOOL_PAIR_PY = re.compile(
    r"\w\s*\(\s*[^()\[\]{}]*\b(?:True|False)\s*,\s*(?:True|False)\b"
)
SELECT_STAR = re.compile(r"\bSELECT\s+\*", re.I)
TAILWIND_SOUP = re.compile(r"class(?:Name)?\s*=\s*[{]?\s*['\"`][^'\"`]{200,}")
TAILWIND_MAGIC_PX = re.compile(r"-\[\d{3,}(?:\.\d+)?px\]")
BARE_REEXPORT = re.compile(
    r"^\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['\"]"
)
SOURCE = re.compile(
    r"\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|rb"
    r"|php|swift|scala|m|mm|sh|ps1|lua|dart|ex|exs|vue|svelte|astro|html|sql)$"
)
CHECKLIST_LINES = 40
READ_CAP = 4000
FILE_CAP = 6000
SHOW_CAP = 10


def git(root: str, *args: str) -> str | None:
    try:
        p = subprocess.run(
            ["git", "-C", root, "-c", "core.quotepath=false", *args],
            capture_output=True, encoding="utf-8", errors="replace",
        )
    except OSError:
        return None
    return p.stdout if p.returncode == 0 else ""


def _unquote_path(p: str) -> str:
    """Undo git's C-style quoting of paths with quotes/specials (rare once
    core.quotepath=false handles non-ASCII)."""
    if len(p) >= 2 and p.startswith('"') and p.endswith('"'):
        return re.sub(
            r"\\(.)",
            lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)),
            p[1:-1],
        )
    return p


def parse_added_by_file(diff_text: str) -> dict[str, list[str]]:
    """Added lines per file from ONE `git diff` run (not one process per file)."""
    added: dict[str, list[str]] = {}
    cur: str | None = None
    for ln in diff_text.splitlines():
        if ln.startswith("+++ "):
            path = _unquote_path(ln[4:].strip())
            if path == "/dev/null":
                cur = None
            else:
                cur = path[2:] if path.startswith("b/") else path
        elif cur is not None and ln.startswith("+") and not ln.startswith("+++"):
            added.setdefault(cur, []).append(ln[1:])
    return added


def read_whole(root: str, rel: str) -> tuple[list[str] | None, bool]:
    """First READ_CAP lines and whether the file had more (truncated).
    None = unreadable (missing/permission); callers must surface it, because a
    silent skip turns a vanished file into a false 'no slop found'."""
    try:
        with open(os.path.join(root, rel), encoding="utf-8-sig", errors="ignore") as fh:
            lines = [ln.rstrip("\n") for ln in islice(fh, READ_CAP + 1)]
    except OSError:
        return None, False
    if len(lines) > READ_CAP:
        return lines[:READ_CAP], True
    return lines, False


def _read_for_scan(root: str, rel: str, unreadable: list[str]) -> tuple[list[str], bool]:
    lines, truncated = read_whole(root, rel)
    if lines is None:
        unreadable.append(rel)
        return [], False
    return lines, truncated


def _uniq(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        if it not in seen:
            seen.add(it)
            out.append(it)
    return out


def is_redundant_comment(line: str) -> bool:
    if not COMMENT.search(line):
        return False
    body = re.sub(r"\*/\s*$", "", _CMT_MARKER.sub("", line)).strip()
    return len(body.split()) <= 6


def _dep_line_hit(ln: str) -> bool:
    for m in DEP.finditer(ln):
        if m.start() == 0 and m.group("name").lower() in META_KEYS:
            continue
        return True
    return False


_SIGNALS = {
    "dependencies":       ("new dependency       ", "dep"),
    "abstractions":       ("premature abstraction", "abstraction"),
    "redundant_comments": ("redundant comment    ", "redundant-comment"),
    "ai_residue":         ("AI residue           ", "residue"),
    "type_escapes":       ("type escape          ", "type-escape"),
    "swallowed_errors":   ("swallowed error      ", "swallowed-error"),
    "tautological_tests": ("tautological test    ", "tautology"),
    "async_wrappers":     ("async wrapper        ", "async-wrapper"),
    "guard_chains":       ("guard chain (use ?.) ", "guard-chain"),
    "boolean_traps":      ("boolean trap         ", "boolean-trap"),
    "select_star":        ("SELECT *             ", "select-star"),
    "tailwind_slop":      ("tailwind smell       ", "tailwind"),
    "reexport_slop":      ("bare re-export       ", "reexport"),
    "semantic_density":   ("semantic opacity     ", "semantic-density"),
}
_SIGNAL_KEYS = tuple(_SIGNALS)


def _file_slop(r: Finding) -> bool:
    return any(r[k] for k in _SIGNAL_KEYS)


def scan_lines(rel: str, lines: list[str], audit: bool) -> Finding | None:
    if not lines:
        return None
    lang = lang_of(rel)
    ext = rel.rsplit(".", 1)[-1].lower() if "." in rel else ""
    is_source = bool(SOURCE.search(rel))
    found: dict[str, list[str]] = {k: [] for k in _SIGNAL_KEYS}
    check_deps = (not audit) and bool(MANIFEST.search(os.path.basename(rel)))
    for i, ln in enumerate(lines):
        if check_deps and _dep_line_hit(ln):
            found["dependencies"].append(ln.strip()[:100])
        masked = _mask_strings(ln, lang)
        if is_source:
            m = ABSTRACTION.search(masked)
            if m:
                found["abstractions"].append(m.group(1))
            else:
                v = VOCAB.search(masked)
                if v:
                    found["abstractions"].append(v.group(1))
            if is_redundant_comment(masked):
                found["redundant_comments"].append(ln.strip()[:100])
            if (RESIDUE_PHRASE.search(masked) or RESIDUE_BANNER.match(ln)
                    or RESIDUE_EMOJI.search(ln)):
                found["ai_residue"].append(ln.strip()[:100])
        if lang in ("js", "cstyle", "php"):
            code = _strip_comments(ln, lang, "L")
            if lang == "js" and (
                TS_SUPPRESS.search(masked)
                or (not _CMT_MARKER.match(ln) and TS_ANY.search(code))
            ):
                found["type_escapes"].append(ln.strip()[:100])
            if JS_SWALLOW.search(code):
                found["swallowed_errors"].append(ln.strip()[:100])
            if JS_TAUTOLOGY.search(ln):
                found["tautological_tests"].append(ln.strip()[:100])
            if BOOL_PAIR_JS.search(code):
                found["boolean_traps"].append(ln.strip()[:100])
            if lang == "js":
                if ASYNC_WRAPPER.search(code):
                    found["async_wrappers"].append(ln.strip()[:100])
                gm = GUARD_RETURN.match(ln)
                if gm and i + 1 < len(lines):
                    nxt = GUARD_RETURN.match(lines[i + 1])
                    if nxt and nxt.group(1).startswith(gm.group(1) + "."):
                        found["guard_chains"].append(ln.strip()[:100])
        elif lang == "py":
            if PY_TYPE_ESCAPE.search(masked):
                found["type_escapes"].append(ln.strip()[:100])
            if PY_SWALLOW.match(ln) or (
                PY_SWALLOW_HEAD.match(ln)
                and i + 1 < len(lines) and PY_PASS.match(lines[i + 1])
            ):
                found["swallowed_errors"].append(ln.strip()[:100])
            if PY_TAUTOLOGY.search(ln):
                found["tautological_tests"].append(ln.strip()[:100])
            if BOOL_PAIR_PY.search(masked):
                found["boolean_traps"].append(ln.strip()[:100])
        if ext == "sql" and not ln.lstrip().startswith("--") and SELECT_STAR.search(ln):
            found["select_star"].append(ln.strip()[:100])
        if (lang == "js" or ext == "html") and (
            TAILWIND_SOUP.search(ln) or TAILWIND_MAGIC_PX.search(ln)
        ):
            found["tailwind_slop"].append(ln.strip()[:100])
        if lang == "js" and BARE_REEXPORT.match(ln):
            found["reexport_slop"].append(ln.strip()[:100])
    if is_source:
        try:
            import low_density
            for item in low_density.format_for_report(
                    low_density.score_identifiers(lines, rel)):
                found["semantic_density"].append(item[:140])
        except Exception:
            pass
    found = {k: _uniq(v) for k, v in found.items()}
    added_count = sum(1 for ln in lines if ln.strip())
    substantial = (not audit) and is_source and added_count >= CHECKLIST_LINES
    if not (any(found.values()) or substantial):
        return None
    out: Finding = {"file": rel, "added_lines": added_count,
                    "substantial": substantial}
    out.update(found)
    return out


def target_files(root: str, base: str, paths: list[str], is_git: bool,
                 all_mode: bool) -> tuple[list[str], set[str], bool]:
    """(files to scan, untracked subset, hit-the-FILE_CAP flag)."""
    if paths:
        return [p.replace("\\", "/") for p in paths], set(), False
    if not is_git:
        return [], set(), False
    if all_mode:
        tracked = (git(root, "ls-files") or "").splitlines()
        srcs = [_unquote_path(f.strip()) for f in tracked
                if f.strip() and SOURCE.search(_unquote_path(f.strip()))]
        return srcs[:FILE_CAP], set(), len(srcs) > FILE_CAP
    names = (git(root, "diff", "--name-only", base) or "").splitlines()
    others = (git(root, "ls-files", "--others", "--exclude-standard") or "").splitlines()
    untracked = {_unquote_path(f.strip()) for f in others if f.strip()}
    seen: set[str] = set()
    out: list[str] = []
    for f in names + others:
        f = _unquote_path(f.strip())
        if f and f not in seen:
            seen.add(f)
            out.append(f)
    return out, untracked, False


def _print_capped(label: str, items: list[str]) -> None:
    for it in items[:SHOW_CAP]:
        print(f"  {label}: {it}")
    if len(items) > SHOW_CAP:
        print(f"  ... +{len(items) - SHOW_CAP} more {label.strip()}")


def _print_duplication(dup: Finding) -> bool:
    nc, bc, near, su = dup["name_clones"], dup["body_clones"], dup["near_clones"], dup["single_use"]
    tc, fp = dup["type_clones"], dup["fingerprints"]
    if not dup_has_findings(dup):
        return False
    print("DUPLICATION (whole-codebase - the isRecord-class slop):")
    if nc:
        print("  Clone proliferation - same function name in multiple files [confidence: name-only]:")
        for c in nc[:15]:
            print(f"    {c['name']:<22} x{c['count']:<3} {', '.join(c['files'][:6])}")
    if bc:
        print("  Knowledge duplication - identical body, consolidate to ONE (DRY) [confidence: exact]:")
        for c in bc[:15]:
            print(f"    [{'/'.join(c['names'][:4])}] x{c['count']} across {', '.join(c['files'][:5])}")
    if near:
        print("  Semantic fragmentation - near-identical bodies (drifted clones) [confidence: structural]:")
        for c in near[:12]:
            print(f"    [{'/'.join(c['names'][:4])}] x{c['count']} across {', '.join(c['files'][:5])}")
    if su:
        print("  Semantic density collapse - dead / single-use helpers:")
        for c in su[:15]:
            tag = "unused & not exported -> delete" if c["kind"] == "dead" else "used once -> inline"
            print(f"    {c['name']:<24} {tag:<32} {c['file']}")
    if tc:
        print("  Duplicate type/interface names [confidence: name-only]:")
        for c in tc[:10]:
            print(f"    {c['name']:<22} {', '.join(c['files'][:6])}")
    if fp:
        print("  Generated-code fingerprints present: "
              + ", ".join(f"{k}({v})" for k, v in list(fp.items())[:12]))
    if dup["micro_count"]:
        print(f"  Micro-abstraction load: {dup['micro_count']} tiny is*/assert*/safe* "
              f"helpers of {dup['total_defs']} defs (Helper Hell risk)")
    if dup.get("index_only_dirs"):
        print(f"  Index-only directories - barrel indirection candidates "
              f"({len(dup['index_only_dirs'])}):")
        for c in dup["index_only_dirs"][:15]:
            print(f"    {c['dir']}/{c['file']}")
    print("  -> Consolidate clones to one shared definition, inline single-use helpers,")
    print("     re-point imports, delete the rest. One source of truth per concept.\n")
    return True


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description="Static AI-slop signal scanner (reports only).")
    ap.add_argument("paths", nargs="*", help="specific files to audit (default: the git diff)")
    ap.add_argument("--root", default=".", help="repo root (default: cwd)")
    ap.add_argument("--base", default="HEAD", help="git ref to diff against in diff scope")
    ap.add_argument("--all", action="store_true", help="audit ALL tracked source files + duplication")
    ap.add_argument("--gate", action="store_true",
                    help="exit non-zero if slop is found, in any output format "
                         "(the size-only 'substantial' note never gates)")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    is_git = bool(git(root, "rev-parse", "--git-dir"))
    audit = args.all or bool(args.paths)
    full_scope = args.all and not args.paths
    files, untracked, files_capped = target_files(root, args.base, args.paths, is_git, args.all)

    warnings: list[str] = []
    if files_capped:
        warnings.append(f"file list capped at {FILE_CAP} tracked source files; scan is partial")
    if audit and not full_scope:
        warnings.append("partial scope (explicit paths): single-use/dead-helper analysis "
                        "suppressed - reference counts need the whole codebase (--all)")

    file_lines: dict[str, list[str]] = {}
    read_capped: list[str] = []
    unreadable: list[str] = []
    if audit:
        for f in files:
            lines, truncated = _read_for_scan(root, f, unreadable)
            file_lines[f] = lines
            if truncated:
                read_capped.append(f)
    else:
        diff_added = parse_added_by_file(
            git(root, "-c", "diff.noprefix=false", "-c", "diff.mnemonicprefix=false",
                "diff", args.base) or "") if is_git else {}
        for f in files:
            if f in untracked:
                lines, truncated = _read_for_scan(root, f, unreadable)
                file_lines[f] = lines
                if truncated:
                    read_capped.append(f)
            else:
                file_lines[f] = diff_added.get(f, [])
    if read_capped:
        shown = ", ".join(read_capped[:5]) + (" ..." if len(read_capped) > 5 else "")
        warnings.append(f"{len(read_capped)} file(s) hit the {READ_CAP}-line read cap "
                        f"(tail unscanned): {shown}")
    if unreadable:
        shown = ", ".join(unreadable[:5]) + (" ..." if len(unreadable) > 5 else "")
        warnings.append(f"{len(unreadable)} file(s) could NOT be read and were NOT "
                        f"scanned (missing or unreadable): {shown}")

    results = [r for r in (scan_lines(f, ls, audit) for f, ls in file_lines.items()) if r]

    dup: Finding | None = None
    if audit:
        idfreq: Counter[str] = Counter()
        defs: list[Finding] = []
        types: list[Finding] = []
        for f, ls in file_lines.items():
            for ln in ls:
                idfreq.update(ID.findall(ln))
            defs.extend(collect_defs(f, ls))
            types.extend(collect_types(f, ls))
        dup = analyze_duplication(defs, types, idfreq, full_scope, files)
        if dup["truncated_defs"]:
            warnings.append(f"{dup['truncated_defs']} function bodies hit the {BODY_CAP}-line "
                            "capture cap; excluded from exact-duplicate hashing")
    mode = "audit" if audit else "diff"
    scope = ("explicit paths" if args.paths
             else "whole codebase (--all)" if args.all
             else f"diff vs {args.base}")

    totals: dict[str, int] = {k: sum(len(r[k]) for r in results)
                              for k in _SIGNAL_KEYS}
    totals["files"] = len(results)

    slop_found = any(_file_slop(r) for r in results) or dup_has_findings(dup)
    exit_code = 1 if args.gate and slop_found else 0

    if args.format == "json":
        print(json.dumps({"mode": mode, "scope": scope, "base": args.base, "git": is_git,
                          "files_scanned": len(files), "totals": totals,
                          "slop_found": slop_found, "warnings": warnings,
                          "files": results, "duplication": dup}, indent=2))
        return exit_code

    if not is_git and not args.paths:
        print("anti-slop scan: not a git repo and no paths given.")
        print("Audit files: `scan_slop.py src/foo.ts`, or run inside a git repo with --all.")
        return 0

    print(f"anti-slop scan - scope: {scope}, {len(files)} file(s)\n")
    for w in warnings:
        print(f"  note: {w}")
    if warnings:
        print()

    has_dup = bool(dup and _print_duplication(dup))

    if results:
        print(f"{totals['files']} file(s) with per-file signals\n")
        for r in results:
            print(r["file"])
            for key, (label, _short) in _SIGNALS.items():
                _print_capped(label, r[key])
            if r["substantial"] and not _file_slop(r):
                print(f"  +{r['added_lines']} added lines (>= {CHECKLIST_LINES}: run the checklist)")
            print()

    if not results and not has_dup:
        if audit:
            print(f"No static slop patterns across {len(files)} file(s).")
            print("Clean of the deterministic signals. Semantic slop still needs a model pass:")
            print("invoke the anti-slop skill for edge cases / superficial tests / cargo-cult.")
        elif not files:
            print(f"Nothing changed vs {args.base} (clean working tree).")
            print("Diff scope only vets a change in progress. To review existing code:")
            print("  scan_slop.py --all          (whole codebase + duplication)")
            print("  scan_slop.py path/to/file   (specific files)")
        else:
            print(f"{len(files)} changed file(s) scanned - no static slop signals.")
            print("Semantic slop still needs a model pass; walk the SKILL.md taxonomy.")
        if args.gate:
            print("GATE: PASS (no slop)")
        return exit_code

    parts = [f"{totals[k]} {short}" for k, (_label, short) in _SIGNALS.items()
             if totals[k]]
    print(f"SUMMARY ({mode}): "
          + (", ".join(parts) if parts else "no per-file slop signals"), end="")
    if dup:
        print(f"; {len(dup['name_clones'])} name-clone, {len(dup['body_clones'])} exact-dup, "
              f"{len(dup['near_clones'])} near-dup, {len(dup['single_use'])} single-use", end="")
    print(".")
    if slop_found:
        print("Fix every signal above, then walk the full taxonomy in SKILL.md and re-scan (expect clean).")
    if args.gate:
        print("GATE: FAIL (slop found)" if slop_found else "GATE: PASS (no slop)")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
