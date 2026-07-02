"""_duplication.py - whole-codebase duplication analysis for scan_slop.

Extracted from scan_slop.py to keep that file under the repo 700-line limit.
Owns function/type definition collection, body capture + normalization, and the
clone / single-use / fingerprint / type-clone / index-only-dir analysis. Imports
only from the `_language` leaf (no scan_slop import), so the dependency graph
stays acyclic: scan_slop -> _duplication -> _language; scan_slop -> low_density.
"""
from __future__ import annotations

import hashlib
import re
import sys
from collections import Counter, defaultdict
from typing import Any

_SCRIPT_DIR = re.sub(r"[\\/][^\\/]+$", "", __file__) or "."
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from _language import (
    ID, TYPE_DECL, FUNC_PATTERNS, METHOD_JS, METHOD_CSTYLE, NOT_METHOD,
    lang_of, _strip_comments,
)

Finding = dict[str, Any]

BODY_CAP = 80
INDEX_FILE = re.compile(r"^index\.(ts|tsx|js|jsx|mjs|cjs)$", re.I)

MICRO_PREFIX = re.compile(
    r"^(?:is|has|can|should|assert|ensure|safe|to|from|get|set|make|create"
    r"|parse|format|with|map|build|validate)[A-Z0-9]"
)
KEYWORDS = frozenset({
    "if", "else", "elif", "for", "while", "do", "switch", "case", "default",
    "break", "continue", "return", "function", "func", "fn", "def", "class",
    "struct", "interface", "type", "trait", "impl", "enum", "const", "let",
    "var", "new", "delete", "typeof", "instanceof", "in", "of", "is",
    "as", "not", "and", "or", "null", "nil", "none", "None", "true", "false",
    "True", "False", "undefined", "void", "this", "self", "super", "yield",
    "await", "async", "try", "catch", "except", "finally", "throw", "raise",
    "with", "public", "private", "protected", "static", "import",
    "from", "export", "package", "lambda", "pass", "end",
})
COMMON_NAMES = {
    "render", "main", "default", "index", "setup", "run", "start", "stop",
    "init", "handler", "handle", "callback", "loader", "action", "middleware",
    "reducer", "app", "page", "layout", "constructor", "tostring", "tojson",
    "valueof", "equals", "dispose", "close", "open", "connect", "get", "set",
    "update", "create", "delete", "list", "find", "save", "load", "execute",
    "process", "build", "test", "describe", "it", "expect", "beforeeach",
    "aftereach", "beforeall", "afterall", "getstaticprops", "getserversideprops",
    "getstaticpaths", "generatemetadata", "usestate", "useeffect", "wrapper",
    "new", "string", "tostr", "clone", "copy", "value", "data", "result",
    "componentdidmount", "componentwillunmount", "componentdidupdate",
    "componentdidcatch", "getderivedstatefromerror", "getderivedstatefromprops",
    "shouldcomponentupdate", "getsnapshotbeforeupdate", "ngoninit", "ngondestroy",
    "connectedcallback", "disconnectedcallback",
}
COMMON_TYPES = frozenset({
    "props", "state", "options", "option", "params", "parameters", "result",
    "config", "configuration", "context", "ctx", "data", "item", "items",
    "response", "request", "error", "react", "window", "ref", "children",
    "theme", "style", "styles", "value", "values", "model", "entity", "dto",
    "payload", "meta", "args", "arg", "input", "output", "node", "element",
    "key", "id", "type", "types", "field", "fields", "row", "column", "event",
    "handler", "callback", "fn", "cb",
})
FINGERPRINTS = {
    "isrecord", "isobject", "isplainobject", "isdictionary", "isstring",
    "isnumber", "isboolean", "isarraylike", "isnil", "isempty", "isdefined",
    "ensurearray", "assertarray", "safeparse", "safeparsejson", "safejsonparse",
    "sleep", "delay", "retry", "assertnever", "deepclone", "deepequal", "noop",
    "clamp", "uniq", "unique", "capitalize", "classnames", "cn", "tryparse",
}
EXPORT_KEYWORD = re.compile(r"\b(?:export|public|pub)\b")


def _indent(s: str) -> int:
    return len(s) - len(s.lstrip())


def capture_body(lines: list[str], start_idx: int, lang: str) -> tuple[str, bool]:
    """Body text and whether capture hit the BODY_CAP window (truncated)."""
    if lang in ("py", "ruby"):
        base = _indent(lines[start_idx])
        window = lines[start_idx + 1:start_idx + 1 + BODY_CAP]
        out: list[str] = []
        for ln in window:
            if lang == "py" and ln.strip() and _indent(ln) <= base:
                break
            if lang == "ruby" and ln.strip() == "end" and _indent(ln) <= base:
                break
            out.append(ln)
        else:
            return "\n".join(out), len(lines) > start_idx + 1 + BODY_CAP
        return "\n".join(out), False
    sig = lines[start_idx]
    arrow = sig.find("=>")
    if arrow >= 0 and sig.find("{", arrow) < 0:
        return sig[arrow + 2:].split(";")[0], False
    brace_line = -1
    for k in range(start_idx, min(start_idx + 6, len(lines))):
        if "{" in lines[k]:
            brace_line = k
            break
        if ";" in lines[k] and "=>" not in lines[k]:
            return "", False
    if brace_line < 0:
        return "", False
    depth, started = 0, False
    out_chars: list[str] = []
    for ln in lines[brace_line:brace_line + 1 + BODY_CAP]:
        for ch in ln:
            if ch == "{":
                depth += 1
                if depth == 1:
                    started = True
                    continue
            elif ch == "}":
                depth -= 1
                if depth == 0 and started:
                    return "".join(out_chars), False
            if started:
                out_chars.append(ch)
        if started:
            out_chars.append("\n")
    return "".join(out_chars), True


def normalize_body(text: str, lang: str) -> str:
    """Whitespace/comment-insensitive but literal-sensitive text, for the
    exact-duplicate hash. Strings survive verbatim (URLs differ => bodies differ)."""
    text = _strip_comments(text, lang, string_repl=None)
    return re.sub(r"\s+", " ", text).strip()


def structural_body(text: str, lang: str) -> str:
    """Mask identifiers + literals; keep keywords/operators. Two bodies with the
    same control-flow shape but drifted names/values hash equal => near-duplicate."""
    text = _strip_comments(text, lang, string_repl="L")
    text = re.sub(r"\b\d[\w.]*\b", "N", text)
    text = ID.sub(lambda m: m.group(0) if m.group(0) in KEYWORDS else "I", text)
    return re.sub(r"\s+", "", text)


def _digest(s: str) -> str:
    return hashlib.blake2b(s.encode("utf-8"), digest_size=16).hexdigest()


def _is_exported(name: str, line: str, lang: str) -> bool:
    if lang == "py":
        return not name.startswith("_")
    if lang == "go":
        return name[:1].isupper()
    return (bool(EXPORT_KEYWORD.search(line))
            or "module.exports" in line or "exports." in line)


def collect_defs(rel: str, lines: list[str]) -> list[Finding]:
    lang = lang_of(rel)
    decls = FUNC_PATTERNS.get(lang)
    if not decls:
        return []
    defs: list[Finding] = []
    for i, ln in enumerate(lines):
        name = None
        for rx in decls:
            m = rx.search(ln)
            if m:
                cand = m.group(1)
                if rx in (METHOD_JS, METHOD_CSTYLE) and cand in NOT_METHOD:
                    continue
                name = cand
                break
        if not name:
            continue
        raw, truncated = capture_body(lines, i, lang)
        nb = normalize_body(raw, lang)
        sb = structural_body(raw, lang)
        body_lines = sum(1 for s in raw.splitlines() if s.strip()) or 1
        hash_exact = (not truncated and len(nb) >= 12)
        defs.append({
            "name": name, "file": rel, "line": i + 1,
            "exported": _is_exported(name, ln, lang),
            "exact": _digest(nb) if hash_exact else None,
            "struct": _digest(sb) if len(sb) >= 20 else None,
            "body_lines": body_lines,
            "truncated": truncated,
        })
    return defs


def collect_types(rel: str, lines: list[str]) -> list[Finding]:
    if lang_of(rel) != "js":
        return []
    out: list[Finding] = []
    for ln in lines:
        m = TYPE_DECL.search(ln)
        if m:
            out.append({"name": m.group(1), "file": rel})
    return out


def _index_only_dirs(files: list[str]) -> list[Finding]:
    """Directories whose only scanned source file is an `index.*` module.

    The barrel-indirection smell a per-file scan cannot see: a single-file dir
    whose only occupant is `index.ts` (or .tsx/.js/...) is almost always re-
    export scaffolding rather than a real module. Only meaningful in --all (the
    full file list); a partial scan would flag dirs whose siblings simply were
    not in the path list.
    """
    by_dir: dict[str, set[str]] = defaultdict(set)
    for f in files:
        parts = f.rsplit("/", 1)
        if len(parts) != 2:
            continue
        d, name = parts
        by_dir[d].add(name)
    out: list[Finding] = []
    for d, names in by_dir.items():
        if len(names) != 1:
            continue
        only = next(iter(names))
        if INDEX_FILE.match(only):
            out.append({"dir": d, "file": only, "confidence": "structural"})
    out.sort(key=lambda x: x["dir"])
    return out


def analyze_duplication(defs: list[Finding], types: list[Finding],
                        idfreq: Counter[str], full_scope: bool,
                        all_files: list[str] | None = None) -> Finding:
    by_name: dict[str, list[Finding]] = defaultdict(list)
    by_exact: dict[str, list[Finding]] = defaultdict(list)
    by_struct: dict[str, list[Finding]] = defaultdict(list)
    name_def_counts: Counter[str] = Counter()
    for d in defs:
        by_name[d["name"]].append(d)
        name_def_counts[d["name"]] += 1
        if d["exact"]:
            by_exact[d["exact"]].append(d)
        if d["struct"]:
            by_struct[d["struct"]].append(d)

    name_clones = []
    for name, ds in by_name.items():
        files = sorted({d["file"] for d in ds})
        if len(files) >= 2 and name.lower() not in COMMON_NAMES:
            name_clones.append({"name": name, "count": len(ds), "files": files,
                                "confidence": "name-only"})
    name_clones.sort(key=lambda x: -x["count"])

    body_clones = []
    for ds in by_exact.values():
        names = sorted({d["name"] for d in ds})
        files = sorted({d["file"] for d in ds})
        if len(ds) >= 2 and (len(files) >= 2 or len(names) >= 2):
            body_clones.append({"names": names, "files": files, "count": len(ds),
                                "confidence": "exact"})
    body_clones.sort(key=lambda x: -x["count"])

    near_clones = []
    for ds in by_struct.values():
        exacts = {d["exact"] for d in ds if d["exact"]}
        if len(ds) >= 2 and len(exacts) >= 2:
            names = sorted({d["name"] for d in ds})
            files = sorted({d["file"] for d in ds})
            near_clones.append({"names": names, "files": files, "count": len(ds),
                                "confidence": "structural"})
    near_clones.sort(key=lambda x: -x["count"])

    single_use: list[Finding] = []
    if full_scope:
        seen_su: set[str] = set()
        for d in defs:
            name = d["name"]
            if name in seen_su or name.lower() in COMMON_NAMES:
                continue
            small = d["body_lines"] <= 3
            util_ish = bool(MICRO_PREFIX.search(name)) or name.lower() in FINGERPRINTS
            if not (small or util_ish):
                continue
            if d.get("exported"):
                continue
            refs = idfreq.get(name, 0) - name_def_counts[name]
            if refs == 0:
                seen_su.add(name)
                single_use.append({"name": name, "file": d["file"], "kind": "dead"})
            elif refs == 1 and util_ish:
                seen_su.add(name)
                single_use.append({"name": name, "file": d["file"], "kind": "inline"})

    fp: dict[str, int] = defaultdict(int)
    for d in defs:
        if d["name"].lower() in FINGERPRINTS:
            fp[d["name"]] += 1
    micro = sum(1 for d in defs if MICRO_PREFIX.search(d["name"]) and d["body_lines"] <= 3)

    type_files: dict[str, set[str]] = defaultdict(set)
    for t in types:
        type_files[t["name"]].add(t["file"])
    type_clones = [{"name": n, "files": sorted(fs), "confidence": "name-only"}
                   for n, fs in type_files.items()
                   if len(fs) >= 2 and n.lower() not in COMMON_TYPES]

    return {"name_clones": name_clones, "body_clones": body_clones,
            "near_clones": near_clones, "single_use": single_use,
            "type_clones": type_clones, "fingerprints": dict(sorted(fp.items(), key=lambda x: -x[1])),
            "micro_count": micro, "total_defs": len(defs),
            "truncated_defs": sum(1 for d in defs if d["truncated"]),
            "index_only_dirs": (_index_only_dirs(all_files) if full_scope and all_files else [])}


def dup_has_findings(dup: Finding | None) -> bool:
    if not dup:
        return False
    return bool(dup["name_clones"] or dup["body_clones"] or dup["near_clones"]
                or dup["single_use"] or dup["type_clones"] or dup["fingerprints"]
                or dup["micro_count"] or dup.get("index_only_dirs"))
